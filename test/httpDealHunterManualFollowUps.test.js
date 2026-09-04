import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-manual-follow-ups-'));
process.env.ADMIN_SESSION_SECRET = 'http-manual-follow-ups-secret';
process.env.ADMIN_VIEWER_USERNAME = 'manual-follow-up-viewer';
process.env.ADMIN_VIEWER_PASSWORD = 'manual-follow-up-viewer-password';
process.env.SQLITE_PATH = path.join(tempDirectory, 'manual-follow-ups.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDirectory, 'secure-documents');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');

let loginSequence = 0;
const cookies = new Map();

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
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
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${40 + loginSequence}` },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  cookies.set(username, cookie);
  return cookie;
}

function routes(origin, opportunityId = 'missing-opportunity', requestId = 'missing-request') {
  const base = `${origin}/api/admin/deal-hunter/triage/${opportunityId}/broker-materials/follow-ups/${requestId}`;
  return { start: `${base}/start`, stop: `${base}/stop`, prepare: `${base}/prepare`, approve: `${base}/approve`, status: `${base}/status` };
}

function post(url, body, cookie = '') {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test.after(() => {
  getStorage().close?.();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('manual follow-up routes require authenticated administrator mutation authority', async () => {
  await withServer(async (origin) => {
    const target = routes(origin);
    for (const url of [target.start, target.stop, target.prepare, target.approve]) {
      const response = await post(url, {});
      assert.equal(response.status, 401);
    }
    const viewerCookie = await login(origin, 'manual-follow-up-viewer', 'manual-follow-up-viewer-password');
    for (const url of [target.start, target.stop, target.approve]) {
      const response = await post(url, {}, viewerCookie);
      assert.equal(response.status, 401);
    }
    const preview = await post(target.prepare, {}, viewerCookie);
    assert.notEqual(preview.status, 401, 'an authenticated viewer may request only a bounded preview');
    const previewBody = await preview.json();
    assert.equal(Object.hasOwn(previewBody, 'preparationToken'), false);
    assert.equal(Object.hasOwn(previewBody, 'proposalDigest'), false);
  });
});

test('manual follow-up routes bind canonical opportunity and request instead of trusting path ids', async () => {
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    for (const url of Object.values(routes(origin, 'wrong-opportunity', 'wrong-request')).slice(0, 4)) {
      const response = await post(url, {}, adminCookie);
      assert.notEqual(response.status, 200);
      assert.notEqual(response.status, 201);
    }
  });
});

test('manual follow-up Start body accepts no keys Stop accepts only reason Prepare only greeting and Approve only token and digest', async () => {
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const target = routes(origin);
    const invalid = [
      [target.start, { requestId: 'browser-owned' }],
      [target.stop, { reason: 'bounded', restart: true }],
      [target.prepare, { greeting: 'Hello,', subject: 'Browser subject' }],
      [target.approve, { preparationToken: 'x.y', approvedProposalDigest: 'a'.repeat(64), recipient: 'attacker@example.test' }],
    ];
    for (const [url, body] of invalid) {
      const response = await post(url, body, adminCookie);
      assert.equal(response.status, 400, `${url} accepted ${JSON.stringify(body)}`);
    }
  });
});

test('manual follow-up Approve route is the only route that verifies a signed proposal', async () => {
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const target = routes(origin);
    const authority = { preparationToken: 'not.a.valid.token', approvedProposalDigest: 'a'.repeat(64) };
    const approved = await post(target.approve, authority, adminCookie);
    assert.equal(approved.status, 400);
    assert.equal((await approved.json()).code, 'invalid_preparation');
    for (const url of [target.start, target.stop, target.prepare]) {
      const response = await post(url, authority, adminCookie);
      assert.equal(response.status, 400, `${url} must reject approval artifacts as unknown input`);
    }
  });
});

test('manual follow-up status uses opportunity detail GET and adds no status mutation', async () => {
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const target = routes(origin);
    const mutation = await post(target.status, {}, adminCookie);
    assert.equal(mutation.status, 404);
    const detail = await fetch(`${origin}/api/admin/deal-hunter/triage/missing-opportunity`, { headers: { Cookie: adminCookie } });
    assert.notEqual(detail.status, 401);
  });
});

test('operations Run Follow-Ups rejects approval artifacts and cannot route them to manual approval', async () => {
  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const response = await post(`${origin}/api/admin/deal-hunter/cim-follow-ups/run`, {
      limit: 1,
      preparationToken: 'not.a.valid.token',
      approvedProposalDigest: 'a'.repeat(64),
    }, adminCookie);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /unknown|approval artifact/i);
  });
});
