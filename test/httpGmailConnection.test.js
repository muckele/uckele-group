import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REFRESH_TOKEN = '1//http-refresh-token-secret';
const ACCESS_TOKEN = 'ya29.http-access-token-secret';
const CLIENT_SECRET = 'http-google-client-secret';
const TOKEN_KEY = randomBytes(32).toString('base64');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-gmail-connection-'));
process.env.ADMIN_SESSION_SECRET = 'http-gmail-connection-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-gmail-connection-document-secret';
process.env.ADMIN_VIEWER_USERNAME = 'gmail-viewer';
process.env.ADMIN_VIEWER_PASSWORD = 'gmail-viewer-password';
process.env.SQLITE_PATH = path.join(tempDir, 'gmail-connection.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.PUBLIC_SITE_URL;
process.env.GOOGLE_OAUTH_CLIENT_ID = 'http-client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
process.env.DEAL_HUNTER_GMAIL_SENDER_ADDRESS = 'owner@uckele.test';
process.env.DEAL_HUNTER_GMAIL_TOKEN_KEY = TOKEN_KEY;

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');

const base = '/api/admin/deal-hunter/gmail';
const operations = '/admin/deal-hunter?view=operations';
const secrets = [REFRESH_TOKEN, ACCESS_TOKEN, CLIENT_SECRET, TOKEN_KEY];

// Every console line from the app is captured so the leak test can read it.
const logLines = [];
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[method];
  console[method] = (...args) => {
    logLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
  };
  test.after(() => { console[method] = original; });
}

// Responses seen by the tests, for the leak check.
const seen = [];
async function record(response) {
  const body = await response.text();
  seen.push({ status: response.status, headers: [...response.headers.entries()], body });
  return { status: response.status, location: response.headers.get('location'), body };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let googleMode = 'ok';
async function gmailFetcher(url, init = {}) {
  const target = String(url);
  if (googleMode === 'profile-throws' && target.endsWith('/users/me/profile')) {
    throw new Error(`profile lookup failed for Bearer ${ACCESS_TOKEN} (${REFRESH_TOKEN})`);
  }
  if (target === 'https://oauth2.googleapis.com/token') {
    return json(200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer' });
  }
  if (target === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
    return json(200, { emailAddress: 'owner@uckele.test', historyId: '5150' });
  }
  if (target === 'https://oauth2.googleapis.com/revoke') {
    assert.equal(new URLSearchParams(String(init.body)).get('token'), REFRESH_TOKEN);
    return json(500, { error: `server error for ${REFRESH_TOKEN}` });
  }
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
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${80 + loginSequence}` },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  cookies.set(username, cookie);
  return cookie;
}

const get = async (origin, pathname, cookie) => record(await fetch(`${origin}${pathname}`,
  { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }));
const post = async (origin, pathname, cookie) => record(await fetch(`${origin}${pathname}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: '{}',
}));

test.after(() => {
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('viewer cannot connect or disconnect (403)', async () => {
  await withServer(async (origin) => {
    const viewer = await login(origin, 'gmail-viewer', 'gmail-viewer-password');
    for (const cookie of [viewer, null]) {
      assert.equal((await get(origin, `${base}/connect`, cookie)).status, 403);
      assert.equal((await get(origin, `${base}/callback?code=c&state=s`, cookie)).status, 403);
      assert.equal((await post(origin, `${base}/disconnect`, cookie)).status, 403);
    }
    assert.equal(await getStorage().getGmailConnection(), null);
  });
});

test('no response body, header, or captured log line contains the refresh token, access token, or client secret', async () => {
  await withServer(async (origin) => {
    const admin = await login(origin, 'admin', 'change-me-now');

    const connect = await get(origin, `${base}/connect`, admin);
    assert.equal(connect.status, 302);
    const google = new URL(connect.location);
    assert.equal(google.origin, 'https://accounts.google.com');
    assert.equal(google.searchParams.get('redirect_uri'), `http://localhost:5173${base}/callback`);
    const state = google.searchParams.get('state');

    const callback = await get(origin, `${base}/callback?code=auth-code&state=${encodeURIComponent(state)}`, admin);
    assert.equal(callback.status, 302);
    assert.equal(callback.location, `${operations}&gmail=connected`);
    const row = await getStorage().getGmailConnection();
    assert.equal(row.email_address, 'owner@uckele.test');
    assert.equal(row.history_checkpoint, '5150');

    const reused = await get(origin, `${base}/callback?code=auth-code&state=${encodeURIComponent(state)}`, admin);
    assert.equal(reused.location, `${operations}&gmail=gmail_state_invalid`);

    googleMode = 'profile-throws';
    const nextState = new URL((await get(origin, `${base}/connect`, admin)).location).searchParams.get('state');
    const failed = await get(origin, `${base}/callback?code=auth-code&state=${encodeURIComponent(nextState)}`, admin);
    assert.equal(failed.location, `${operations}&gmail=gmail_connect_failed`);
    googleMode = 'ok';

    const denied = await get(origin, `${base}/callback?error=access_denied`, admin);
    assert.equal(denied.location, `${operations}&gmail=gmail_state_invalid`);

    const disconnect = await post(origin, `${base}/disconnect`, admin);
    assert.equal(disconnect.status, 200);
    const payload = JSON.parse(disconnect.body);
    assert.equal(payload.success, true);
    assert.match(payload.revokedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await getStorage().getGmailConnection(), null);
  });

  assert.ok(seen.length >= 7);
  assert.ok(logLines.some((line) => line.includes('gmail connect failed')), 'the log spy saw the failure line');
  for (const secret of secrets) {
    for (const response of seen) {
      assert.ok(!response.body.includes(secret), `body leaked a secret (${response.status})`);
      assert.ok(!JSON.stringify(response.headers).includes(secret), `header leaked a secret (${response.status})`);
    }
    for (const line of logLines) assert.ok(!line.includes(secret), 'a log line leaked a secret');
  }
});
