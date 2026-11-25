import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFakeCimProvider } from '../server/services/fakeCimProvider.js';
import { normalizeCimProviderReadiness } from '../server/services/pursueCimFinalGate.js';
import {
  PURSUE_CIM_READINESS_REASONS,
  readPursueCimProviderReadiness,
} from '../server/services/pursueCimReadiness.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  GMAIL_PROFILE,
  SENDER,
  SENDER_SETTINGS,
  enableSendControls,
  gmailConfig,
  seedSignature,
  setSendControl,
} from './fixtures/pursueCimGmailGateFixture.js';

const now = '2026-11-03T16:00:00.000Z';

function sqliteStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-readiness-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'storage.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  return storage;
}

async function readyStorage(t) {
  const storage = sqliteStorage(t);
  await enableSendControls(storage);
  return storage;
}

function read(storage, { mailProvider = createFakeCimProvider({ now, senderAddress: SENDER }),
  config = gmailConfig() } = {}) {
  return readPursueCimProviderReadiness({ storage, providerProfile: GMAIL_PROFILE, now,
    mailProvider, config });
}

test('readiness is ready when all hold', async (t) => {
  const storage = await readyStorage(t);
  const readiness = await read(storage);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.reasons, []);
  assert.equal(readiness.provider, 'gmail');
  assert.equal(readiness.providerProfile, GMAIL_PROFILE);
  assert.equal(readiness.signatureComplete, true);
  assert.match(readiness.evidenceRevision, /^[0-9a-f]{64}$/);
  assert.equal(readiness.generatedAt, now);
  assert.ok(Date.parse(readiness.expiresAt) > Date.parse(now));
  const normalized = normalizeCimProviderReadiness(readiness, { providerProfile: GMAIL_PROFILE,
    now });
  assert.equal(normalized.ready, true);
  assert.deepEqual(normalized.blockers, []);
  assert.match(normalized.authorityDigest, /^[0-9a-f]{64}$/);
});

for (const reason of ['gmail_not_connected', 'gmail_token_invalid', 'gmail_token_refresh_failed',
  'gmail_address_mismatch']) {
  test(`readiness reports ${reason} from the mailbox`, async (t) => {
    const storage = await readyStorage(t);
    const mailProvider = createFakeCimProvider({ now, senderAddress: SENDER });
    mailProvider.setReadinessReasons([reason]);
    const readiness = await read(storage, { mailProvider });
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.reasons, [reason]);
    const normalized = normalizeCimProviderReadiness(readiness, { providerProfile: GMAIL_PROFILE,
      now });
    assert.equal(normalized.ready, false);
    assert.deepEqual(normalized.blockers, [reason]);
  });
}

test('readiness reports wording_not_approved when the approved digest is stale or missing', async (t) => {
  const storage = await readyStorage(t);
  const renamed = gmailConfig({ sender: { ...SENDER_SETTINGS, name: 'Mathew J. Uckele' } });
  assert.deepEqual((await read(storage, { config: renamed })).reasons, ['wording_not_approved']);
  await setSendControl(storage, 'wording_approval', false);
  assert.deepEqual((await read(storage)).reasons, ['wording_not_approved']);
});

test('a changed Gmail signature makes the approved wording stale until it changes back', async (t) => {
  const storage = await readyStorage(t);
  assert.deepEqual((await read(storage)).reasons, []);
  await seedSignature(storage, { html: '<div><b>Mathew Uckele</b><br>New title</div>', now });
  assert.deepEqual((await read(storage)).reasons, ['wording_not_approved']);
  await seedSignature(storage, { now });
  assert.deepEqual((await read(storage)).reasons, []);
});

test('title, phone and postal address no longer matter to readiness', async (t) => {
  const storage = await readyStorage(t);
  const config = gmailConfig({ sender: { ...SENDER_SETTINGS, title: '', phone: '', postalAddress: '' } });
  const readiness = await read(storage, { config });
  assert.deepEqual(readiness.reasons, []);
  assert.equal(readiness.signatureComplete, true);
});

test('readiness reports contact_rule_off when the rule is off or under another policy version', async (t) => {
  const storage = await readyStorage(t);
  await setSendControl(storage, 'contact_rule', true, { policyVersion: 'listing-broker-inquiry-v2' });
  assert.deepEqual((await read(storage)).reasons, ['contact_rule_off']);
  await setSendControl(storage, 'contact_rule', false);
  assert.deepEqual((await read(storage)).reasons, ['contact_rule_off']);
});

test('readiness reports live_sending_off', async (t) => {
  const storage = await readyStorage(t);
  await setSendControl(storage, 'live_sending', false);
  assert.deepEqual((await read(storage)).reasons, ['live_sending_off']);
});

test('readiness reports signature_incomplete without a signature snapshot', async (t) => {
  const storage = sqliteStorage(t);
  // A failed refresh records only its code: still no snapshot.
  await storage.recordGmailSignatureRefresh({ ok: false, errorCode: 'gmail_timeout', now });
  await enableSendControls(storage);
  const readiness = await read(storage);
  assert.deepEqual(readiness.reasons, ['signature_incomplete']);
  assert.equal(readiness.signatureComplete, false);
});

test('readiness reports signature_incomplete when the signature is empty after sanitizing', async (t) => {
  for (const html of ['', '<script>alert(1)</script>', '<div><br></div>&nbsp;']) {
    const storage = sqliteStorage(t);
    await seedSignature(storage, { html });
    await enableSendControls(storage);
    const readiness = await read(storage);
    assert.deepEqual(readiness.reasons, ['signature_incomplete'], html);
    assert.equal(readiness.signatureComplete, false);
  }
});

test('readiness reports signature_incomplete for a snapshot read for another address', async (t) => {
  const storage = sqliteStorage(t);
  await seedSignature(storage, { sendAsEmail: 'someone-else@uckele.example.test' });
  await enableSendControls(storage);
  assert.deepEqual((await read(storage)).reasons, ['signature_incomplete']);
});

test('readiness reports signature_incomplete when the sender name is blank', async (t) => {
  const sender = { ...SENDER_SETTINGS, name: '  ' };
  const storage = sqliteStorage(t);
  await enableSendControls(storage, { sender });
  const readiness = await read(storage, { config: gmailConfig({ sender }) });
  assert.deepEqual(readiness.reasons, ['signature_incomplete']);
  assert.equal(readiness.signatureComplete, false);
});

test('readiness lists every failing reason in spec order', async (t) => {
  const storage = sqliteStorage(t);
  const mailProvider = createFakeCimProvider({ now, senderAddress: SENDER });
  mailProvider.setReadinessReasons(['gmail_address_mismatch', 'gmail_token_invalid']);
  const readiness = await read(storage, { mailProvider,
    config: gmailConfig({ sender: { ...SENDER_SETTINGS, name: '' } }) });
  assert.deepEqual(readiness.reasons, ['gmail_token_invalid', 'gmail_address_mismatch',
    'wording_not_approved', 'contact_rule_off', 'live_sending_off', 'signature_incomplete']);
  assert.deepEqual(PURSUE_CIM_READINESS_REASONS, ['gmail_not_connected', 'gmail_token_invalid',
    'gmail_token_refresh_failed', 'gmail_address_mismatch', 'wording_not_approved',
    'contact_rule_off', 'live_sending_off', 'signature_incomplete']);
});

test('a mailbox readiness failure counts as not connected and never leaks its error', async (t) => {
  const storage = await readyStorage(t);
  const mailProvider = createFakeCimProvider({ now, senderAddress: SENDER });
  mailProvider.readiness = async () => { throw new Error('refresh-token-SECRET-value'); };
  const readiness = await read(storage, { mailProvider });
  assert.deepEqual(readiness.reasons, ['gmail_not_connected']);
  assert.equal(JSON.stringify(readiness).includes('SECRET'), false);
});

test('the real Gmail provider: a stored address in Google casing still matches the sender', async (t) => {
  const storage = await readyStorage(t);
  await storage.saveGmailConnection({ emailAddress: 'Owner@Uckele.Example.Test',
    refreshTokenCiphertext: 'v1.aXY=.dGFn.Y2lwaGVy', grantedScopes: [], connectedBy: 'owner',
    historyCheckpoint: null, now });
  await storage.recordGmailTokenCheck({ ok: true, now });
  const readiness = await readPursueCimProviderReadiness({ storage, providerProfile: GMAIL_PROFILE,
    now, config: gmailConfig() });
  assert.deepEqual(readiness.reasons, []);
  assert.equal(readiness.ready, true);
});

test('the real Gmail provider: a revoked refresh token reports gmail_token_invalid', async (t) => {
  const storage = await readyStorage(t);
  const key = Buffer.alloc(32, 7).toString('base64');
  const { encryptRefreshToken } = await import('../server/services/gmailTokenCrypto.js');
  await storage.saveGmailConnection({ emailAddress: SENDER,
    refreshTokenCiphertext: encryptRefreshToken('refresh-token-value', key), grantedScopes: [],
    connectedBy: 'owner', historyCheckpoint: null, now });
  const config = gmailConfig();
  config.dealHunter.gmail.tokenKey = key;
  const readiness = await readPursueCimProviderReadiness({ storage, providerProfile: GMAIL_PROFILE,
    now, config, mailProvider: (await import('../server/services/gmailCimProvider.js'))
      .createGmailCimProvider({ storage, config, now,
        fetcher: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) }) });
  assert.deepEqual(readiness.reasons, ['gmail_token_invalid']);
  assert.equal(JSON.stringify(readiness).includes('refresh-token-value'), false);
});

test('normalized Gmail readiness keeps the Resend branch unchanged', () => {
  const resend = normalizeCimProviderReadiness({ provider: 'resend', providerProfile: 'p',
    outboundConfigured: true, senderConfigured: true, senderAuthenticationAttested: true,
    webhookConfigured: true, requestReplyRoutingVerified: true, replyTrackingVerified: true,
    suppressionOperational: true, reconciliationOperational: true, evidenceRevision: 'r1',
    generatedAt: now, expiresAt: '2026-11-03T16:05:00.000Z' }, { providerProfile: 'p', now });
  assert.equal(resend.ready, true);
  assert.equal(Object.hasOwn(resend, 'reasons'), false);
  const expired = normalizeCimProviderReadiness({ provider: 'gmail', ready: true, reasons: [],
    signatureComplete: true, evidenceRevision: 'r', generatedAt: now, expiresAt: now },
  { providerProfile: GMAIL_PROFILE, now });
  assert.deepEqual(expired.blockers, ['readiness_evidence_expired']);
  const unproven = normalizeCimProviderReadiness({ provider: 'gmail', reasons: [],
    signatureComplete: true, evidenceRevision: 'r', generatedAt: now,
    expiresAt: '2026-11-03T16:05:00.000Z' }, { providerProfile: GMAIL_PROFILE, now });
  assert.deepEqual(unproven.blockers, ['provider_unavailable']);
});
