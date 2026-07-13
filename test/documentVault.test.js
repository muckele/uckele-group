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

const { createSecureUploadRequest, getSecureDocumentDownload, uploadSecureDocuments } = await import('../server/services/documentVault.js');
const { createManualSubmission, deleteDashboardSubmission, reconcileSecureDocumentCleanupJobs } = await import('../server/services/submissions.js');
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

test('secure document download resolves stored file metadata', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('download-test@example.com');
  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.42'),
    documents: [
      {
        name: 'download-financials.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Downloadable diligence file').toString('base64'),
      },
    ],
  });
  const documents = await storage.listSecureDocumentsByRequest(request.id);
  const download = await getSecureDocumentDownload(documents[0].id);

  assert.equal(result.ok, true);
  assert.equal(download.ok, true);
  assert.equal(download.document.id, documents[0].id);
  assert.equal(download.sizeBytes, Buffer.byteLength('Downloadable diligence file'));
  assert.equal(fs.existsSync(download.filePath), true);
});

test('secure document download rejects paths outside the document vault', async () => {
  const download = await getSecureDocumentDownload('outside-path-document', {
    async getSecureDocument(id) {
      return {
        id,
        file_name: 'outside.txt',
        mime_type: 'text/plain',
        original_name: 'outside.txt',
        storage_path: path.join(tempDir, 'outside.txt'),
      };
    },
  });

  assert.equal(download.ok, false);
  assert.equal(download.status, 500);
  assert.match(download.error, /file path is invalid/i);
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

  const deleteResult = await deleteDashboardSubmission(submission.id);
  const deleted = deleteResult.submission;

  assert.equal(deleteResult.ok, true);
  assert.equal(deleted.id, submission.id);
  assert.equal(await storage.getSubmission(submission.id), null);
  assert.equal(await storage.getSecureUploadRequest(request.id), null);
  assert.deepEqual(await storage.listSecureDocumentsByRequest(request.id), []);
  assert.deepEqual(await storage.listEmailEvents({ submissionId: submission.id }), []);
  assert.equal(fs.existsSync(documents[0].storage_path), false);
});

test('dashboard submission delete keeps CRM record when secure file staging fails', async () => {
  let deleteCalled = false;
  const result = await deleteDashboardSubmission('cleanup-failure-submission', {
    storage: {
      async getSubmission(id) {
        return { id };
      },
      async listSecureDocumentsForSubmission() {
        return [{ storage_path: path.join(process.env.SECURE_DOCUMENTS_STORAGE_DIR, 'secure-document-that-cannot-be-removed.pdf') }];
      },
      async deleteSubmission() {
        deleteCalled = true;
        return true;
      },
    },
    async renameFile() {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /cleanup could not be prepared/i);
  assert.equal(deleteCalled, false);
});

test('dashboard submission delete restores staged files when database deletion fails', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const documentPath = path.join(storageDir, 'database-failure-document.txt');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(documentPath, 'recoverable diligence document');

  const result = await deleteDashboardSubmission('database-failure-submission', {
    storage: {
      async getSubmission(id) {
        return { id };
      },
      async listSecureDocumentsForSubmission() {
        return [{ storage_path: documentPath }];
      },
      async deleteSubmission() {
        throw new Error('database unavailable');
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /restored/i);
  assert.equal(fs.existsSync(documentPath), true);
  assert.equal(fs.readFileSync(documentPath, 'utf8'), 'recoverable diligence document');
});

test('dashboard submission delete rejects secure document paths outside the vault', async () => {
  let deleteCalled = false;
  let unlinkCalled = false;
  const result = await deleteDashboardSubmission('outside-vault-submission', {
    storage: {
      async getSubmission(id) {
        return { id };
      },
      async listSecureDocumentsForSubmission() {
        return [{ storage_path: path.join(tempDir, 'outside-vault.pdf') }];
      },
      async deleteSubmission() {
        deleteCalled = true;
        return true;
      },
    },
    async unlinkFile() {
      unlinkCalled = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.cleanupFailures[0].message, /outside/i);
  assert.equal(unlinkCalled, false);
  assert.equal(deleteCalled, false);
});

test('failed post-delete purges are persisted and reconciled later', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const documentPath = path.join(storageDir, 'queued-cleanup-document.txt');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(documentPath, 'confidential cleanup payload');
  let submission = { id: 'queued-cleanup-submission' };
  let cleanupJob = null;
  const storage = {
    async getSubmission() {
      return submission;
    },
    async listSecureDocumentsForSubmission() {
      return [{ storage_path: documentPath }];
    },
    async deleteSubmission() {
      const deleted = submission;
      submission = null;
      return deleted;
    },
    async insertSecureDocumentCleanupJob(job) {
      cleanupJob = { ...job };
      return cleanupJob;
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      cleanupJob = { ...cleanupJob, ...values };
      return cleanupJob;
    },
    async listPendingSecureDocumentCleanupJobs() {
      return ['completed', 'restored'].includes(cleanupJob?.status) ? [] : [cleanupJob];
    },
  };
  const result = await deleteDashboardSubmission('queued-cleanup-submission', {
    storage,
    async unlinkFile() {
      const error = new Error('temporary filesystem failure');
      error.code = 'EIO';
      throw error;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.cleanupPending, true);
  assert.equal(cleanupJob.status, 'cleanup-failed');
  assert.equal(fs.existsSync(documentPath), false);
  assert.equal(fs.existsSync(cleanupJob.files[0].stagedPath), true);

  const reconciliation = await reconcileSecureDocumentCleanupJobs({ storage });
  assert.deepEqual(reconciliation, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.equal(cleanupJob.status, 'completed');
  assert.equal(fs.existsSync(cleanupJob.files[0].stagedPath), false);
  assert.equal(fs.existsSync(cleanupJob.trash_directory), false);
});

test('a missing secure file does not prevent later files from being staged and purged', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const existingPath = path.join(storageDir, 'second-delete-document.txt');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(existingPath, 'second confidential document');
  const result = await deleteDashboardSubmission('missing-first-file-submission', {
    storage: {
      async getSubmission(id) {
        return { id };
      },
      async listSecureDocumentsForSubmission() {
        return [
          { storage_path: path.join(storageDir, 'already-missing-document.txt') },
          { storage_path: existingPath },
        ];
      },
      async deleteSubmission(id) {
        return { id };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(existingPath), false);
});

test('falsey database deletion reports a restore failure instead of a 404', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const documentPath = path.join(storageDir, 'falsey-delete-document.txt');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(documentPath, 'must be restored');
  let renameCount = 0;
  let cleanupJob = null;
  const result = await deleteDashboardSubmission('falsey-delete-submission', {
    storage: {
      async getSubmission(id) {
        return { id };
      },
      async listSecureDocumentsForSubmission() {
        return [{ storage_path: documentPath }];
      },
      async insertSecureDocumentCleanupJob(job) {
        cleanupJob = { ...job };
        return cleanupJob;
      },
      async updateSecureDocumentCleanupJob(_id, values) {
        cleanupJob = { ...cleanupJob, ...values };
        return cleanupJob;
      },
      async deleteSubmission() {
        return null;
      },
    },
    async renameFile(from, to) {
      renameCount += 1;
      if (renameCount > 1) {
        const error = new Error('restore denied');
        error.code = 'EACCES';
        throw error;
      }
      await fs.promises.rename(from, to);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /could not be fully restored/i);
  assert.equal(cleanupJob.status, 'restore-failed');
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
