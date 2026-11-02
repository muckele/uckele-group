import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-auto-pursue-'));
process.env.ADMIN_SESSION_SECRET = 'http-auto-pursue-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-auto-pursue-document-secret';
process.env.ADMIN_VIEWER_USERNAME = 'auto-pursue-viewer';
process.env.ADMIN_VIEWER_PASSWORD = 'auto-pursue-viewer-password';
process.env.DEAL_HUNTER_CRON_SECRET = 'http-auto-pursue-cron-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'auto-pursue.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');
const { AUTO_PURSUE_CONFIRMATIONS } = await import('../server/services/autoPursue.js');

const cronPath = '/api/deal-hunter/auto-pursue/run';
const statusPath = '/api/admin/deal-hunter/auto-pursue';
const modePath = '/api/admin/deal-hunter/auto-pursue/mode';
const cronHeaders = { 'Content-Type': 'application/json', 'X-Deal-Hunter-Secret': 'http-auto-pursue-cron-secret' };
const cookies = new Map();
let loginSequence = 0;

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function login(origin, username, password) {
  if (cookies.has(username)) return cookies.get(username);
  loginSequence += 1;
  const response = await fetch(`${origin}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${60 + loginSequence}` },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  cookies.set(username, cookie);
  return cookie;
}

const adminLogin = (origin) => login(origin, 'admin', 'change-me-now');
const viewerLogin = (origin) => login(origin, 'auto-pursue-viewer', 'auto-pursue-viewer-password');

function postMode(origin, cookie, body) {
  return fetch(`${origin}${modePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function seedWarmup(count = 30) {
  const storage = getStorage();
  for (let index = 1; index <= count; index += 1) {
    await storage.insertAutoPursueDecisionEvidence({
      decision_event_id: `http-warmup-event-${index}`, opportunity_id: `http-warmup-opp-${index}`, action: 'pursue',
      policy_version: 'owner-decision-v1', criteria_group: 'auto', criteria_profile_version: 'uckele-criteria-v1',
      recipient_unchanged: true, created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    });
  }
}

test.after(() => {
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('cron run requires the cron secret', async () => {
  await withServer(async (origin) => {
    const missing = await fetch(`${origin}${cronPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${origin}${cronPath}`, {
      method: 'POST', headers: { ...cronHeaders, 'X-Deal-Hunter-Secret': 'not-the-secret' }, body: '{}',
    });
    assert.equal(wrong.status, 401);
    const adminCookie = await adminLogin(origin);
    const sessionOnly = await fetch(`${origin}${cronPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: '{}',
    });
    assert.equal(sessionOnly.status, 401, 'an admin session is not the cron credential');
  });
});

test('cron run accepts no mode, cap, or clock from the request', async () => {
  await withServer(async (origin) => {
    for (const body of [{ mode: 'active' }, { dailyCap: 10 }, { now: '2030-01-01T00:00:00.000Z' }, { triggeredBy: 'x' }]) {
      const response = await fetch(`${origin}${cronPath}`, { method: 'POST', headers: cronHeaders, body: JSON.stringify(body) });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    const status = await (await fetch(`${origin}${statusPath}`, { headers: { Cookie: await adminLogin(origin) } })).json();
    assert.equal(status.latestRun, null, 'a rejected request must not start a run');
  });
});

test('cron run reports the runner result and records its trigger', async () => {
  await withServer(async (origin) => {
    const adminCookie = await adminLogin(origin);
    const response = await fetch(`${origin}${cronPath}`, { method: 'POST', headers: cronHeaders, body: '{}' });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.mode, 'off');
    assert.equal(payload.commands, 0);
    assert.deepEqual(payload.skipped, []);
    assert.equal(payload.duplicateInvocation, false);
    assert.match(payload.businessDate, /^\d{4}-\d{2}-\d{2}$/);

    const status = await (await fetch(`${origin}${statusPath}`, { headers: { Cookie: adminCookie } })).json();
    assert.equal(status.latestRun.triggeredBy, 'external-auto-pursue-cron');
  });
});

test('admin status is readable and mode change requires a writable admin', async () => {
  await withServer(async (origin) => {
    assert.equal((await fetch(`${origin}${statusPath}`)).status, 401);
    const viewerCookie = await viewerLogin(origin);
    const viewerStatus = await fetch(`${origin}${statusPath}`, { headers: { Cookie: viewerCookie } });
    assert.equal(viewerStatus.status, 200);
    const viewerPayload = await viewerStatus.json();
    assert.equal(viewerPayload.success, true);
    assert.equal(viewerPayload.mode, 'off');
    assert.ok(viewerPayload.warmup);

    const body = { mode: 'shadow', confirmation: AUTO_PURSUE_CONFIRMATIONS.shadow, reason: 'viewer attempt' };
    assert.equal((await postMode(origin, null, body)).status, 401);
    const viewerAttempt = await postMode(origin, viewerCookie, body);
    assert.equal(viewerAttempt.status, 403);
    const after = await (await fetch(`${origin}${statusPath}`, { headers: { Cookie: viewerCookie } })).json();
    assert.equal(after.mode, 'off', 'a rejected viewer request must not change the mode');
  });
});

test('mode change passes confirmation through', async () => {
  await withServer(async (origin) => {
    const adminCookie = await adminLogin(origin);
    const wrong = await postMode(origin, adminCookie, { mode: 'shadow', confirmation: 'yes please', reason: 'bad phrase' });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).success, false);
    const badMode = await postMode(origin, adminCookie, { mode: 'turbo', confirmation: 'anything' });
    assert.equal(badMode.status, 400);
    const badCap = await postMode(origin, adminCookie, {
      mode: 'shadow', confirmation: AUTO_PURSUE_CONFIRMATIONS.shadow, dailyCap: 'lots' });
    assert.equal(badCap.status, 400);

    const right = await postMode(origin, adminCookie, {
      mode: 'shadow', confirmation: AUTO_PURSUE_CONFIRMATIONS.shadow, reason: 'begin shadow runs' });
    assert.equal(right.status, 200);
    const payload = await right.json();
    assert.equal(payload.success, true);
    assert.equal(payload.activation.mode, 'shadow');
    assert.equal(payload.activation.actor, 'admin', 'the actor comes from the session, not the body');

    const status = await (await fetch(`${origin}${statusPath}`, { headers: { Cookie: adminCookie } })).json();
    assert.equal(status.mode, 'shadow');
  });
});

test('mode change cannot be spoofed with a body actor and command modes need warm-up', async () => {
  await withServer(async (origin) => {
    const adminCookie = await adminLogin(origin);
    const spoofed = await postMode(origin, adminCookie, {
      mode: 'shadow', confirmation: AUTO_PURSUE_CONFIRMATIONS.shadow, actor: 'someone-else' });
    assert.equal(spoofed.status, 200);
    assert.equal((await spoofed.json()).activation.actor, 'admin');

    const notReady = await postMode(origin, adminCookie, {
      mode: 'canary', confirmation: AUTO_PURSUE_CONFIRMATIONS.canary, reason: 'too early' });
    assert.equal(notReady.status, 409);
    assert.equal((await notReady.json()).success, false);

    await seedWarmup();
    const ready = await postMode(origin, adminCookie, {
      mode: 'canary', confirmation: AUTO_PURSUE_CONFIRMATIONS.canary, reason: 'warm-up complete' });
    assert.equal(ready.status, 200);
    const status = await (await fetch(`${origin}${statusPath}`, { headers: { Cookie: adminCookie } })).json();
    assert.equal(status.mode, 'canary');
    assert.equal(status.warmup.ready, true);
  });
});
