// The Operations "Email sending" card's readiness (spec 2026-11-03 §9, Ruling U): "Ready to send."
// only when nothing would hold a send, including the sender and reply poller switches, a reply
// poller that has not run recently, and the central CIM outreach pause. Real SQLite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setCimOutreachPaused } from '../server/services/cimOpportunityIdentity.js';
import { getEmailSendingStatus } from '../server/services/pursueEmailSending.js';
import { syncPursueGmailCapabilities } from '../server/services/pursueGmailCapabilities.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { SENDER, enableSendControls, gmailConfig } from './fixtures/pursueCimGmailGateFixture.js';
import { MINUTE, recordReplyPollerRun } from './fixtures/pursueCimSenderFixture.js';

const NOW = '2030-10-28T16:00:00.000Z';
const CIPHERTEXT = 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'];

function withSwitches({ sender = true, poller = true } = {}) {
  const base = gmailConfig();
  return { ...base, dealHunter: { ...base.dealHunter,
    pursueSender: { enabled: sender, intervalMinutes: 15 },
    replyPoller: { enabled: poller, intervalMinutes: 5 } } };
}

async function readyWorld(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-email-sending-status-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'status.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await storage.saveGmailConnection({ emailAddress: SENDER, refreshTokenCiphertext: CIPHERTEXT,
    grantedScopes: SCOPES, historyCheckpoint: '1', connectedBy: 'owner', now: NOW });
  await storage.recordGmailTokenCheck({ ok: true, now: NOW });
  await enableSendControls(storage, { now: NOW });
  await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner', now: NOW });
  await setCimOutreachPaused({ paused: false, actor: 'owner', reason: 'status test', storage });
  await recordReplyPollerRun(storage, Date.parse(NOW) - 5 * MINUTE);
  return storage;
}

// The mailbox's token was checked just now, so readiness reads no Google endpoint.
async function readiness(storage, config = withSwitches(), now = NOW) {
  await storage.recordGmailTokenCheck({ ok: true, now });
  return (await getEmailSendingStatus({ storage, config, now: new Date(now) })).readiness;
}

test('ready to send only when the sender and reply checking are on, checking is recent, and outreach is not paused', async (t) => {
  const storage = await readyWorld(t);
  assert.deepEqual(await readiness(storage), { ready: true, reasons: [] });

  assert.deepEqual(await readiness(storage, withSwitches({ sender: false })),
    { ready: false, reasons: ['sender_off'] });
  assert.deepEqual(await readiness(storage, withSwitches({ poller: false })),
    { ready: false, reasons: ['reply_poller_off'] });
  assert.deepEqual(await readiness(storage, withSwitches({ sender: false, poller: false })),
    { ready: false, reasons: ['sender_off', 'reply_poller_off'] });
  // The last completed reply check is now more than 30 minutes old.
  assert.deepEqual(await readiness(storage, withSwitches(), '2030-10-28T16:26:00.000Z'),
    { ready: false, reasons: ['reply_poller_stale'] });

  await setCimOutreachPaused({ paused: true, actor: 'owner', reason: 'status test', storage });
  assert.deepEqual(await readiness(storage), { ready: false, reasons: ['central_pause'] });
});

test('a failed reply poller run does not count as a recent reply check', async (t) => {
  const storage = await readyWorld(t);
  const later = '2030-10-28T16:40:00.000Z';
  await recordReplyPollerRun(storage, Date.parse(later) - MINUTE, { status: 'failed' });
  assert.deepEqual(await readiness(storage, withSwitches(), later),
    { ready: false, reasons: ['reply_poller_stale'] });
  await recordReplyPollerRun(storage, Date.parse(later) - 30 * 1000);
  assert.deepEqual(await readiness(storage, withSwitches(), later), { ready: true, reasons: [] });
});
