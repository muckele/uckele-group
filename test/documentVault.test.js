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
const { createManualSubmission, deleteDashboardSubmission } = await import('../server/services/submissions.js');
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

test('secure upload rejects files without a recognizable type', async () => {
  const { token } = await createUploadToken('mime-test@example.com');
  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.20'),
    documents: [
      {
        name: 'financials.unknown',
        contentBase64: Buffer.from('Plain text financials').toString('base64'),
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /file type/i);
});

test('secure upload infers allowed MIME type when browsers send octet-stream', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('octet-stream-test@example.com');
  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.40'),
    documents: [
      {
        name: 'financials.csv',
        mimeType: 'application/octet-stream',
        contentBase64: Buffer.from('year,revenue,profit\n2025,1800000,450000\n').toString('base64'),
      },
    ],
  });
  const documents = await storage.listSecureDocumentsByRequest(request.id);

  assert.equal(result.ok, true);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].mime_type, 'text/csv');
});

test('deleting a CRM record removes secure upload data, email events, and stored files', async () => {
  const storage = getStorage();
  const { request, submission, token } = await createUploadToken('delete-cleanup-test@example.com');
  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.45'),
    documents: [
      {
        name: 'financials.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Plain text financials').toString('base64'),
      },
    ],
  });
  const documents = await storage.listSecureDocumentsByRequest(request.id);

  assert.equal(result.ok, true);
  assert.equal(documents.length, 1);
  assert.equal(fs.existsSync(documents[0].storage_path), true);

  await storage.insertEmailEvent({
    id: 'delete-cleanup-email-event',
    created_at: new Date().toISOString(),
    provider: 'test',
    event_type: 'delivered',
    message_id: 'delete-cleanup-message',
    provider_event_id: 'delete-cleanup-provider-event',
    event_key: 'delete-cleanup-event-key',
    recipient_email: 'delete-cleanup-test@example.com',
    subject: 'Delete cleanup test',
    submission_id: submission.id,
    source: 'test',
    metadata: {},
  });

  const deleted = await deleteDashboardSubmission(submission.id);

  assert.equal(deleted.id, submission.id);
  assert.equal(await storage.getSubmission(submission.id), null);
  assert.equal(await storage.getSecureUploadRequest(request.id), null);
  assert.deepEqual(await storage.listSecureDocumentsByRequest(request.id), []);
  assert.deepEqual(await storage.listEmailEvents({ submissionId: submission.id }), []);
  assert.equal(fs.existsSync(documents[0].storage_path), false);
});

test('secure upload recovers stale uploading requests before accepting files', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('stale-upload-test@example.com');
  const staleTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  await storage.updateSecureUploadRequest(request.id, {
    updated_at: staleTimestamp,
    status: 'uploading',
  });

  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.50'),
    documents: [
      {
        name: 'financials.txt',
        mimeType: '',
        contentBase64: Buffer.from('Plain text financials').toString('base64'),
      },
    ],
  });
  const updatedRequest = await storage.getSecureUploadRequest(request.id);

  assert.equal(result.ok, true);
  assert.equal(updatedRequest.status, 'documents-received');
});

test('secure upload cleans up partial files and records after a mid-upload failure', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('partial-failure-test@example.com');
  const originalInsertSecureDocument = storage.insertSecureDocument.bind(storage);
  let insertCount = 0;

  storage.insertSecureDocument = async (document) => {
    insertCount += 1;

    if (insertCount === 2) {
      throw new Error('forced secure document insert failure');
    }

    return originalInsertSecureDocument(document);
  };

  try {
    await assert.rejects(
      () =>
        uploadSecureDocuments({
          token,
          ndaAccepted: true,
          request: requestFromIp('192.0.2.60'),
          documents: [
            {
              name: 'financials-1.txt',
              mimeType: 'text/plain',
              contentBase64: Buffer.from('Plain text financials one').toString('base64'),
            },
            {
              name: 'financials-2.txt',
              mimeType: 'text/plain',
              contentBase64: Buffer.from('Plain text financials two').toString('base64'),
            },
          ],
        }),
      /forced secure document insert failure/,
    );
  } finally {
    storage.insertSecureDocument = originalInsertSecureDocument;
  }

  const documents = await storage.listSecureDocumentsByRequest(request.id);
  const updatedRequest = await storage.getSecureUploadRequest(request.id);
  const requestDirectory = path.join(process.env.SECURE_DOCUMENTS_STORAGE_DIR, request.id);
  const remainingFiles = fs.existsSync(requestDirectory) ? fs.readdirSync(requestDirectory) : [];

  assert.equal(documents.length, 0);
  assert.equal(updatedRequest.status, 'awaiting-documents');
  assert.deepEqual(remainingFiles, []);
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
