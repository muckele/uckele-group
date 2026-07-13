import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-app-'));
process.env.ADMIN_SESSION_SECRET = 'http-app-session-secret-for-tests';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-app-document-secret-for-tests';
process.env.SQLITE_PATH = path.join(tempDir, 'http-app.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');

const { createApp } = await import('../server/app.js');
const { createSecureUploadRequest } = await import('../server/services/documentVault.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { getStorage } = await import('../server/storage/index.js');

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('protected APIs reject cross-site mutations and disable caching', async () => {
  await withServer(async (origin) => {
    const sessionResponse = await fetch(`${origin}/api/admin/session`);
    assert.equal(sessionResponse.status, 200);
    assert.match(sessionResponse.headers.get('cache-control') || '', /no-store/);

    const crossSiteResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(crossSiteResponse.status, 403);
    assert.deepEqual(await crossSiteResponse.json(), {
      success: false,
      error: 'Cross-site request rejected.',
    });
  });
});

test('readiness checks storage and the document vault', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      checks: {
        configuration: 'ok',
        storage: 'ok',
        documentVault: 'ok',
      },
    });
  });
});

test('secure upload token is rejected before parsing the JSON payload', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/secure-documents/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Secure-Upload-Token': 'invalid-token',
      },
      body: '{this is intentionally invalid JSON',
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.match(result.error, /invalid or has expired/i);
  });
});

test('completed secure upload requests are rejected before parsing the JSON payload', async () => {
  const created = await createManualSubmission({
    company: 'Completed Upload Test',
    seller_name: 'Completed Seller',
    seller_email: 'completed-upload@example.com',
    lead_type: 'seller',
  }, 'test');
  const upload = await createSecureUploadRequest({
    submissionId: created.submission.id,
    requestedBy: 'test',
    sendEmail: false,
    request: { headers: { host: 'localhost' }, ip: '192.0.2.88', socket: {} },
  });
  await getStorage().updateSecureUploadRequest(upload.request.id, {
    updated_at: new Date().toISOString(),
    status: 'documents-received',
  });
  const token = new URL(upload.uploadUrl).searchParams.get('token');

  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/secure-documents/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Secure-Upload-Token': token,
      },
      body: '{this body must not be parsed',
    });
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.match(result.error, /already been received/i);
  });
});

test('admin mutations create a durable started audit event and a completion event', async () => {
  const requestId = 'phase15-audit-test';
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  });

  let events = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    events = await getStorage().listAdminAuditEvents({ requestId });
    if (events.length >= 2) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(events.map((event) => event.metadata.state).sort(), ['completed', 'started']);
  assert.equal(events.find((event) => event.metadata.state === 'completed').status_code, 401);

  const successRequestId = 'phase15-audit-success-test';
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': successRequestId },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    assert.equal(response.status, 200);
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    events = await getStorage().listAdminAuditEvents({ requestId: successRequestId });
    if (events.length >= 2) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const completion = events.find((event) => event.metadata.state === 'completed');
  assert.equal(completion.status_code, 200);
  assert.equal(completion.actor, 'admin');
});

test('admin mutations fail closed when the durable audit prewrite is unavailable', async () => {
  const storage = getStorage();
  const originalInsert = storage.insertAdminAuditEvent;
  storage.insertAdminAuditEvent = async () => {
    throw new Error('audit database unavailable');
  };

  try {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
      });
      const result = await response.json();
      assert.equal(response.status, 503);
      assert.match(result.error, /audit storage is unavailable/i);
      assert.equal(response.headers.get('set-cookie'), null);
    });
  } finally {
    storage.insertAdminAuditEvent = originalInsert;
  }
});

test('CRM updates reject stale admin drafts with a conflict', async () => {
  await withServer(async (origin) => {
    const loginResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const createResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        company: 'Concurrency Test Services',
        seller_name: 'Concurrency Seller',
        seller_email: 'concurrency@example.com',
        lead_type: 'seller',
        message: 'Record used to verify stale admin update protection.',
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).submission;

    const firstUpdate = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        expected_updated_at: created.updated_at,
        notes: 'First editor update',
      }),
    });
    assert.equal(firstUpdate.status, 200);

    const staleUpdate = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        expected_updated_at: created.updated_at,
        notes: 'Stale editor update',
      }),
    });
    const staleResult = await staleUpdate.json();
    assert.equal(staleUpdate.status, 409);
    assert.match(staleResult.error, /changed after you opened it/i);
    assert.equal(staleResult.submission.notes, 'First editor update');
  });
});

test('CRM updates require an expected record version', async () => {
  await withServer(async (origin) => {
    const loginResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const createResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        company: 'Required Version Services',
        seller_name: 'Version Seller',
        seller_email: 'required-version@example.com',
        lead_type: 'seller',
      }),
    });
    const created = (await createResponse.json()).submission;
    const response = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ notes: 'missing expected version' }),
    });
    assert.equal(response.status, 409);
  });
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
