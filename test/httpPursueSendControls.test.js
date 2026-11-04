import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REFRESH_TOKEN = '1//send-controls-refresh-token-secret';
const ACCESS_TOKEN = 'ya29.send-controls-access-token-secret';
const CLIENT_SECRET = 'send-controls-google-client-secret';
const TOKEN_KEY = randomBytes(32).toString('base64');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-send-controls-'));
process.env.ADMIN_SESSION_SECRET = 'http-send-controls-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-send-controls-document-secret';
process.env.ADMIN_VIEWER_USERNAME = 'send-viewer';
process.env.ADMIN_VIEWER_PASSWORD = 'send-viewer-password';
process.env.SQLITE_PATH = path.join(tempDir, 'send-controls.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.PUBLIC_SITE_URL;
process.env.GOOGLE_OAUTH_CLIENT_ID = 'send-controls-client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
process.env.DEAL_HUNTER_GMAIL_SENDER_ADDRESS = 'owner@uckele.test';
process.env.DEAL_HUNTER_GMAIL_TOKEN_KEY = TOKEN_KEY;
process.env.DEAL_HUNTER_SENDER_NAME = 'Mathew Uckele';
process.env.DEAL_HUNTER_SENDER_TITLE = 'Owner';
process.env.DEAL_HUNTER_SENDER_PHONE = '555-0100';
process.env.DEAL_HUNTER_CIM_AUTOMATION_PHYSICAL_POSTAL_ADDRESS = '1 Main St, Springfield';

const { createApp } = await import('../server/app.js');
const { getConfig } = await import('../server/config.js');
const { getStorage } = await import('../server/storage/index.js');
const { pursueCimWordingDigest } = await import('../server/services/pursueCimTemplates.js');
const { CONTACT_POLICY_VERSION } = await import('../server/services/pursueCimContactPolicy.js');

const statusPath = '/api/admin/deal-hunter/email-sending';
const controlsPath = '/api/admin/deal-hunter/email-sending/controls';
const gmailBase = '/api/admin/deal-hunter/gmail';
const secrets = [REFRESH_TOKEN, ACCESS_TOKEN, CLIENT_SECRET, TOKEN_KEY];

const logLines = [];
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[method];
  console[method] = (...args) => {
    logLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
  };
  test.after(() => { console[method] = original; });
}

const seen = [];
async function record(response) {
  const body = await response.text();
  seen.push({ status: response.status, headers: [...response.headers.entries()], body });
  let json = null;
  try { json = JSON.parse(body); } catch { /* redirects and HTML have no JSON body */ }
  return { status: response.status, location: response.headers.get('location'), body, json };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function gmailFetcher(url) {
  const target = String(url);
  if (target === 'https://oauth2.googleapis.com/token') {
    return json(200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer' });
  }
  if (target === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
    return json(200, { emailAddress: 'owner@uckele.test', historyId: '7100' });
  }
  if (target === 'https://oauth2.googleapis.com/revoke') return json(200, {});
  throw new Error(`unexpected fetch ${target}`);
}

async function withServer(run) {
  const server = createApp({ gmailFetcher }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const cookies = new Map();
let loginSequence = 0;
async function login(origin, username, password) {
  if (cookies.has(username)) return cookies.get(username);
  loginSequence += 1;
  const response = await fetch(`${origin}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${120 + loginSequence}` },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  cookies.set(username, cookie);
  return cookie;
}

const get = async (origin, pathname, cookie) => record(await fetch(`${origin}${pathname}`,
  { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }));
const post = async (origin, pathname, cookie, body = {}) => record(await fetch(`${origin}${pathname}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
}));

async function connectGmail(origin, admin) {
  const connect = await get(origin, `${gmailBase}/connect`, admin);
  const state = new URL(connect.location).searchParams.get('state');
  const callback = await get(origin, `${gmailBase}/callback?code=auth-code&state=${encodeURIComponent(state)}`, admin);
  assert.match(callback.location, /gmail=connected$/);
}

const admin = (origin) => login(origin, 'admin', 'change-me-now');
const viewer = (origin) => login(origin, 'send-viewer', 'send-viewer-password');

test.after(() => {
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('viewer gets status without preview and cannot change controls', async () => {
  await withServer(async (origin) => {
    assert.equal((await get(origin, statusPath)).status, 401);
    assert.equal((await post(origin, controlsPath, null, { controlKey: 'live_sending', enabled: true,
      expectedRevision: 0 })).status, 401);

    const viewerCookie = await viewer(origin);
    const status = await get(origin, statusPath, viewerCookie);
    assert.equal(status.status, 200);
    assert.equal(status.json.success, true);
    const { emailSending } = status.json;
    assert.equal(emailSending.gmail.connected, false);
    assert.equal(emailSending.wording.currentDigest, pursueCimWordingDigest(getConfig().dealHunter.sender));
    assert.equal(emailSending.wording.approvedDigest, null);
    assert.equal(Object.hasOwn(emailSending.wording, 'preview'), false);
    assert.equal(emailSending.readiness.ready, false);
    // This server has no Gmail CIM provider profile configured, so the card says so too, and
    // neither the sender nor reply checking is switched on, and outreach has never been unpaused.
    assert.deepEqual(emailSending.readiness.reasons,
      ['gmail_not_connected', 'wording_not_approved', 'contact_rule_off', 'live_sending_off', 'provider_not_gmail',
        'sender_off', 'reply_poller_off', 'central_pause']);
    assert.equal(emailSending.liveSending.capabilitiesInSync, true);
    assert.equal(emailSending.liveSending.providerProfile, 'production-gmail-v1');
    assert.equal(emailSending.liveSending.enabled, false);
    assert.equal(emailSending.contactRule.enabled, false);
    assert.deepEqual(emailSending.lastRuns, { sender: null, replyPoller: null });

    for (const controlKey of ['live_sending', 'contact_rule', 'wording_approval']) {
      const refused = await post(origin, controlsPath, viewerCookie, { controlKey, enabled: true,
        expectedRevision: 0, reason: 'viewer attempt' });
      assert.equal(refused.status, 403);
    }
    const controls = await getStorage().getPursueSendControls();
    assert.equal(controls.liveSending.revision, 0);
    assert.equal(controls.contactRule.revision, 0);
    assert.equal(controls.wordingApproval.revision, 0);

    const adminStatus = await get(origin, statusPath, await admin(origin));
    const preview = adminStatus.json.emailSending.wording.preview;
    assert.equal(preview.length, 6);
    assert.ok(preview.every((item) => item.subject && item.text.includes('Mathew Uckele')));
  });
});

test('approve wording stores the server-computed digest', async () => {
  await withServer(async (origin) => {
    const cookie = await admin(origin);
    const forged = 'f'.repeat(64);
    const approved = await post(origin, controlsPath, cookie, { controlKey: 'wording_approval',
      enabled: true, expectedRevision: 0, valueDigest: forged, reason: 'Wording reviewed' });
    assert.equal(approved.status, 200);
    const expected = pursueCimWordingDigest(getConfig().dealHunter.sender);
    const { wordingApproval } = await getStorage().getPursueSendControls();
    assert.equal(wordingApproval.enabled, true);
    assert.equal(wordingApproval.valueDigest, expected);
    assert.equal(wordingApproval.changedBy, 'admin');

    const status = (await get(origin, statusPath, cookie)).json.emailSending;
    assert.equal(status.wording.approvedDigest, expected);
    assert.equal(status.wording.approvedBy, 'admin');
    assert.match(status.wording.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!status.readiness.reasons.includes('wording_not_approved'));

    const unknown = await post(origin, controlsPath, cookie, { controlKey: 'everything', enabled: true,
      expectedRevision: 0 });
    assert.equal(unknown.status, 400);
    const notBoolean = await post(origin, controlsPath, cookie, { controlKey: 'contact_rule', enabled: 'yes',
      expectedRevision: 0 });
    assert.equal(notBoolean.status, 400);
  });
});

test('stale revision returns 409', async () => {
  await withServer(async (origin) => {
    const cookie = await admin(origin);
    const { contactRule } = await getStorage().getPursueSendControls();
    const on = await post(origin, controlsPath, cookie, { controlKey: 'contact_rule', enabled: true,
      expectedRevision: contactRule.revision, reason: 'Listing broker inquiries' });
    assert.equal(on.status, 200);
    const stored = (await getStorage().getPursueSendControls()).contactRule;
    assert.equal(stored.enabled, true);
    assert.equal(stored.policyVersion, CONTACT_POLICY_VERSION);

    const stale = await post(origin, controlsPath, cookie, { controlKey: 'contact_rule', enabled: false,
      expectedRevision: contactRule.revision });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.success, false);
    assert.equal(stale.json.code, 'send_control_conflict');
    assert.equal((await getStorage().getPursueSendControls()).contactRule.enabled, true);

    const status = (await get(origin, statusPath, cookie)).json.emailSending;
    assert.equal(status.contactRule.enabled, true);
    assert.equal(status.contactRule.policyVersion, CONTACT_POLICY_VERSION);
    assert.ok(!status.readiness.reasons.includes('contact_rule_off'));
  });
});

test('Live sending on records the Gmail capability chain and off withdraws it', async () => {
  await withServer(async (origin) => {
    const cookie = await admin(origin);
    const storage = getStorage();
    const current = async () => (await storage.listCurrentCimCapabilityActivations())
      .filter((row) => row.provider_profile === 'production-gmail-v1').map((row) => row.capability).sort();

    const { liveSending } = await storage.getPursueSendControls();
    const on = await post(origin, controlsPath, cookie, { controlKey: 'live_sending', enabled: true,
      expectedRevision: liveSending.revision, reason: 'Go live' });
    assert.equal(on.status, 200);
    assert.equal((await storage.getPursueSendControls()).liveSending.enabled, true);
    assert.deepEqual(await current(), ['fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup']);
    const status = (await get(origin, statusPath, cookie)).json.emailSending;
    assert.equal(status.liveSending.enabled, true);
    assert.equal(status.liveSending.changedBy, 'admin');
    assert.ok(!status.readiness.reasons.includes('live_sending_off'));

    const off = await post(origin, controlsPath, cookie, { controlKey: 'live_sending', enabled: false,
      expectedRevision: liveSending.revision + 1, reason: 'Pause' });
    assert.equal(off.status, 200);
    assert.equal((await storage.getPursueSendControls()).liveSending.enabled, false);
    assert.deepEqual(await current(), []);
  });
});

test('last runs show the latest sender and reply-poller Job history rows', async () => {
  const storage = getStorage();
  const addRun = async (jobName, slot, metadataPatch, status = 'completed') => {
    const jobKey = `${jobName}:${slot}`;
    const claimToken = randomBytes(16).toString('hex');
    await storage.claimScheduledJob({ jobKey, jobName, triggeredBy: 'scheduler', claimToken,
      nowIso: slot, staleBefore: '2026-11-01T00:00:00.000Z', metadata: { slot, trigger: 'scheduler' } });
    await storage.transitionScheduledJob({ jobKey, claimToken, expectedStatuses: ['pending'],
      status, nowIso: slot, ...(status === 'failed' ? { lastError: 'pursue_sender_failed' } : { completedAt: slot }),
      metadataPatch });
  };
  await addRun('pursue-cim-sender', '2026-11-03T15:00:00.000Z', { ok: true, sentInitial: 1, sentFollowUps: 0,
    expired: 0 });
  await addRun('pursue-cim-sender', '2026-11-03T15:15:00.000Z', { ok: true, sentInitial: 2, sentFollowUps: 3,
    expired: 1, stoppedFor: 'not_ready', notReadyReasons: ['live_sending_off'] });
  await addRun('pursue-cim-reply-poller', '2026-11-03T15:10:00.000Z', { ok: true, processed: 4, responded: 1,
    stopped: 1 });
  await addRun('unrelated-maintenance-job', '2026-11-03T15:20:00.000Z', { ok: true });

  await withServer(async (origin) => {
    const { lastRuns } = (await get(origin, statusPath, await viewer(origin))).json.emailSending;
    assert.equal(lastRuns.sender.status, 'completed');
    assert.equal(lastRuns.sender.updatedAt, '2026-11-03T15:15:00.000Z');
    assert.equal(lastRuns.sender.counts.sentInitial, 2);
    assert.equal(lastRuns.sender.counts.sentFollowUps, 3);
    assert.equal(lastRuns.sender.stoppedFor, 'not_ready');
    assert.deepEqual(lastRuns.sender.notReadyReasons, ['live_sending_off']);
    assert.equal(lastRuns.replyPoller.status, 'completed');
    assert.equal(lastRuns.replyPoller.counts.processed, 4);
    assert.equal(lastRuns.replyPoller.counts.responded, 1);
    assert.equal(Object.hasOwn(lastRuns.sender, 'job_key'), false);
  });
});

test('response never contains token material', async () => {
  await withServer(async (origin) => {
    const cookie = await admin(origin);
    await connectGmail(origin, cookie);
    const ciphertext = (await getStorage().getGmailConnection()).refresh_token_ciphertext;
    assert.ok(ciphertext);

    const adminStatus = await get(origin, statusPath, cookie);
    const { gmail } = adminStatus.json.emailSending;
    assert.deepEqual(Object.keys(gmail).sort(), ['connected', 'emailAddress', 'lastErrorCode', 'lastTokenOkAt']);
    assert.equal(gmail.connected, true);
    assert.equal(gmail.emailAddress, 'owner@uckele.test');
    assert.match(gmail.lastTokenOkAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!adminStatus.json.emailSending.readiness.reasons.includes('gmail_not_connected'));
    await get(origin, statusPath, await viewer(origin));
    const { wordingApproval } = await getStorage().getPursueSendControls();
    await post(origin, controlsPath, cookie, { controlKey: 'wording_approval', enabled: true,
      expectedRevision: wordingApproval.revision, reason: 'Wording reviewed' });

    for (const response of seen) {
      for (const secret of [...secrets, ciphertext]) {
        assert.ok(!response.body.includes(secret), `body leaked a secret (${response.status})`);
        assert.ok(!JSON.stringify(response.headers).includes(secret), `header leaked a secret (${response.status})`);
      }
      assert.ok(!/refresh_token|access_token|ciphertext/i.test(response.body), 'body names token material');
    }
    for (const line of logLines) {
      for (const secret of [...secrets, ciphertext]) {
        assert.ok(!line.includes(secret), 'a log line leaked a secret');
      }
    }
  });
});

test('a failed Live sending sync keeps the control written and repeating the change repairs it', async () => {
  const { changeEmailSendingControl } = await import('../server/services/pursueEmailSending.js');
  const real = getStorage();
  let failSync = true;
  const storage = new Proxy(real, { get: (target, name) => {
    if (name === 'recordCimCapabilityActivation' && failSync) {
      return async () => { throw new Error('database unavailable'); };
    }
    const value = Reflect.get(target, name);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const config = getConfig();
  const { liveSending } = await real.getPursueSendControls();
  const failed = await changeEmailSendingControl({ storage, config, actor: 'admin',
    command: { controlKey: 'live_sending', enabled: true, expectedRevision: liveSending.revision, reason: '' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500);
  assert.equal(failed.code, 'live_sending_sync_failed');
  assert.equal(failed.control.enabled, true);
  assert.equal(failed.control.revision, liveSending.revision + 1);

  failSync = false;
  const repaired = await changeEmailSendingControl({ storage, config, actor: 'admin',
    command: { controlKey: 'live_sending', enabled: true, expectedRevision: failed.control.revision, reason: '' } });
  assert.equal(repaired.ok, true);
  const chain = (await real.listCurrentCimCapabilityActivations())
    .filter((row) => row.provider_profile === 'production-gmail-v1');
  assert.equal(chain.length, 4);

  const off = await changeEmailSendingControl({ storage, config, actor: 'admin',
    command: { controlKey: 'live_sending', enabled: false, expectedRevision: repaired.control.revision, reason: '' } });
  assert.equal(off.ok, true);
});

test('approving wording is refused while the signature is incomplete', async () => {
  const { changeEmailSendingControl } = await import('../server/services/pursueEmailSending.js');
  const config = getConfig();
  const incomplete = { ...config, dealHunter: { ...config.dealHunter,
    sender: { ...config.dealHunter.sender, phone: '' } } };
  const before = (await getStorage().getPursueSendControls()).wordingApproval;
  const result = await changeEmailSendingControl({ storage: getStorage(), config: incomplete, actor: 'admin',
    command: { controlKey: 'wording_approval', enabled: true, expectedRevision: before.revision, reason: '' } });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'signature_incomplete');
  assert.equal((await getStorage().getPursueSendControls()).wordingApproval.revision, before.revision);
});

test('status reports a Live sending control out of sync with its capability chain, in both directions', async () => {
  const storage = getStorage();
  await withServer(async (origin) => {
    const cookie = await admin(origin);
    const read = async () => (await get(origin, statusPath, cookie)).json.emailSending;
    const { liveSending } = await storage.getPursueSendControls();
    assert.equal(liveSending.enabled, false);

    // Off, but a chain link is still current (an off whose withdraw failed).
    const { syncPursueGmailCapabilities } = await import('../server/services/pursueGmailCapabilities.js');
    await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'admin', now: new Date().toISOString() });
    let status = await read();
    assert.equal(status.liveSending.enabled, false);
    assert.equal(status.liveSending.capabilitiesInSync, false);
    assert.ok(status.readiness.reasons.includes('live_sending_not_applied'));
    assert.equal(status.readiness.ready, false);

    // Re-applying the current control (same state, current revision) repairs it.
    const reapply = await post(origin, controlsPath, cookie, { controlKey: 'live_sending', enabled: false,
      expectedRevision: liveSending.revision });
    assert.equal(reapply.status, 200);
    assert.equal(reapply.json.control.capabilitiesInSync, true);
    status = await read();
    assert.equal(status.liveSending.capabilitiesInSync, true);
    assert.ok(!status.readiness.reasons.includes('live_sending_not_applied'));

    // On, but the chain is broken (an on whose capability sync failed part way).
    const on = await post(origin, controlsPath, cookie, { controlKey: 'live_sending', enabled: true,
      expectedRevision: liveSending.revision + 1 });
    assert.equal(on.json.control.capabilitiesInSync, true);
    const initial = (await storage.listCurrentCimCapabilityActivations())
      .find((row) => row.capability === 'fl04b-initial');
    await storage.withdrawCimCapabilityActivation({ id: initial.id, actor: 'admin', reason: 'test',
      now: new Date().toISOString() });
    status = await read();
    assert.equal(status.liveSending.enabled, true);
    assert.equal(status.liveSending.capabilitiesInSync, false);
    assert.ok(status.readiness.reasons.includes('live_sending_not_applied'));
    const repaired = await post(origin, controlsPath, cookie, { controlKey: 'live_sending', enabled: true,
      expectedRevision: liveSending.revision + 2 });
    assert.equal(repaired.json.control.capabilitiesInSync, true);
    assert.equal((await read()).liveSending.capabilitiesInSync, true);
    await post(origin, controlsPath, cookie, { controlKey: 'live_sending', enabled: false,
      expectedRevision: liveSending.revision + 3 });
  });
});
