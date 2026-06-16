import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-document-vault-'));

process.env.ADMIN_SESSION_SECRET = 'document-vault-session-secret';
process.env.DELIVERY_PROVIDER = 'console';
process.env.RATE_LIMIT_MAX = '2';
process.env.RATE_LIMIT_WINDOW_MS = '600000';
process.env.SECURE_DOCUMENTS_MAX_UPLOAD_BYTES = '1024';
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.SQLITE_PATH = path.join(tempDir, 'document-vault.sqlite');

const { createSecureUploadRequest, uploadSecureDocuments } = await import('../server/services/documentVault.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { getStorage } = await import('../server/storage/index.js');

after(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

function requestFromIp(ip) {
  return {
    headers: {
      host: 'localhost',
    },
    ip,
    socket: {},
  };
}

async function createUploadToken(email = 'broker@example.com') {
  const submissionResult = await createManualSubmission(
    {
      company: 'Commercial HVAC Maintenance Co',
      broker_name: 'Test Broker',
      broker_email: email,
      listing_url: 'https://example.com/listing',
    },
    'admin-test',
  );

  assert.equal(submissionResult.ok, true);

  const uploadRequest = await createSecureUploadRequest({
    submissionId: submissionResult.submission.id,
    requestedBy: 'admin-test',
    sendEmail: false,
    request: requestFromIp('192.0.2.10'),
  });

  assert.equal(uploadRequest.ok, true);

  return {
    request: uploadRequest.request,
    submission: submissionResult.submission,
    token: new URL(uploadRequest.uploadUrl).searchParams.get('token'),
  };
}

test('secure upload request claims are atomic', async () => {
  const storage = getStorage();
  const { request } = await createUploadToken('claim-test@example.com');
  const claimed = await storage.claimSecureUploadRequest(request.id, {
    updated_at: '2026-06-16T12:00:00.000Z',
    status: 'uploading',
    nda_accepted_at: '2026-06-16T12:00:00.000Z',
  });
  const secondClaim = await storage.claimSecureUploadRequest(request.id, {
    updated_at: '2026-06-16T12:01:00.000Z',
    status: 'uploading',
    nda_accepted_at: '2026-06-16T12:01:00.000Z',
  });

  assert.equal(claimed?.status, 'uploading');
  assert.equal(secondClaim, null);
});

test('secure upload requires verified file type metadata', async () => {
  const { token } = await createUploadToken('mime-test@example.com');
  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.20'),
    documents: [
      {
        name: 'financials.txt',
        contentBase64: Buffer.from('Plain text financials').toString('base64'),
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /file type/i);
});

test('secure upload attempts are rate limited by token and source', async () => {
  const request = requestFromIp('192.0.2.30');
  const body = {
    token: 'not-a-real-token',
    ndaAccepted: true,
    request,
    documents: [
      {
        name: 'financials.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Plain text financials').toString('base64'),
      },
    ],
  };

  assert.equal((await uploadSecureDocuments(body)).ok, false);
  assert.equal((await uploadSecureDocuments(body)).ok, false);

  const blocked = await uploadSecureDocuments(body);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
});
