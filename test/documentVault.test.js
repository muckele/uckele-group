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

const {
  createSecureUploadRequest,
  deleteSecureDocument,
  getSecureDocumentDownload,
  getSecureUploadContext,
  revokeSecureUploadRequest,
  uploadSecureDocuments,
} = await import('../server/services/documentVault.js');
const { createManualSubmission, deleteDashboardSubmission, reconcileSecureDocumentCleanupJobs } = await import('../server/services/submissions.js');
const { listCrmActivity } = await import('../server/services/activity.js');
const {
  secureDocumentCleanupSettlementMs,
  writeSecureDocumentCleanupSidecar,
} = await import('../server/services/secureDocumentCleanupState.js');
const { getStorage } = await import('../server/storage/index.js');
const { signPayload } = await import('../server/utils/security.js');

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

function readCleanupSidecars() {
  const trashRoot = path.join(process.env.SECURE_DOCUMENTS_STORAGE_DIR, '.trash');
  if (!fs.existsSync(trashRoot)) return [];

  return fs.readdirSync(trashRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sidecarPath = path.join(trashRoot, entry.name, '.reconciliation.json');
      if (!fs.existsSync(sidecarPath)) return [];
      return [{ path: sidecarPath, job: JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) }];
    });
}

function afterCleanupSettlement(options = {}) {
  return {
    ...options,
    now: new Date(Date.now() + secureDocumentCleanupSettlementMs + 1000).toISOString(),
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

test('secure upload bounds metadata and stores confidential artifacts with private permissions', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('private-file-test@example.com');
  const result = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    note: 'n'.repeat(5000),
    request: requestFromIp('192.0.2.41'),
    documents: [
      {
        name: `${'a'.repeat(400)}.txt`,
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Private diligence file').toString('base64'),
      },
    ],
  });
  const [document] = await storage.listSecureDocumentsByRequest(request.id);
  const requestDirectory = path.dirname(document.storage_path);

  assert.equal(result.ok, true);
  assert.equal(document.note.length, 2000);
  assert.ok(document.original_name.length <= 180);
  assert.match(document.original_name, /\.txt$/);
  assert.equal(fs.statSync(document.storage_path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(process.env.SECURE_DOCUMENTS_STORAGE_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(requestDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(process.env.SQLITE_PATH).mode & 0o777, 0o600);
});

test('secure upload tokens are bound to both the request and its submission', async () => {
  const { request } = await createUploadToken('token-binding-test@example.com');
  const mismatchedToken = signPayload(
    {
      type: 'secure-upload',
      requestId: request.id,
      submissionId: 'different-submission',
      exp: Date.now() + 60_000,
    },
    process.env.ADMIN_SESSION_SECRET,
  );
  const result = await getSecureUploadContext(mismatchedToken);

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid or has expired/i);
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
  let cleanupJob = null;
  const result = await deleteDashboardSubmission('cleanup-failure-submission', {
    storage: {
      async getSubmission(id) {
        return { id };
      },
      async listSecureDocumentsForSubmission() {
        return [{ storage_path: path.join(process.env.SECURE_DOCUMENTS_STORAGE_DIR, 'secure-document-that-cannot-be-removed.pdf') }];
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
  let cleanupJob = null;
  const storage = {
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
    async listPendingSecureDocumentCleanupJobs() {
      return ['completed', 'restored'].includes(cleanupJob?.status) ? [] : [cleanupJob];
    },
    async deleteSubmission() {
      throw new Error('database unavailable');
    },
  };

  const result = await deleteDashboardSubmission('database-failure-submission', { storage });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(cleanupJob.status, 'reconciliation-pending');
  assert.equal(fs.existsSync(documentPath), false);
  assert.equal(fs.existsSync(cleanupJob.files[0].stagedPath), true);

  const reconciliation = await reconcileSecureDocumentCleanupJobs(afterCleanupSettlement({ storage }));

  assert.deepEqual(reconciliation, { reviewed: 1, completed: 0, restored: 1, failed: 0 });
  assert.equal(cleanupJob.status, 'restored');
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
  let cleanupJob = null;
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
      async insertSecureDocumentCleanupJob(job) {
        cleanupJob = { ...job };
        return cleanupJob;
      },
      async updateSecureDocumentCleanupJob(_id, values) {
        cleanupJob = { ...cleanupJob, ...values };
        return cleanupJob;
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
  assert.equal(updatedRequest.status, 'partially-received');
});

test('secure upload cleans up partial files and records after a mid-upload failure', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('partial-failure-test@example.com');
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);

  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'finalize_secure_document_upload') {
      throw new Error('forced secure document transaction failure');
    }

    return originalMutation(mutation);
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
      /forced secure document transaction failure/,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
  }

  const documents = await storage.listSecureDocumentsByRequest(request.id);
  const updatedRequest = await storage.getSecureUploadRequest(request.id);
  const requestDirectory = path.join(process.env.SECURE_DOCUMENTS_STORAGE_DIR, request.id);
  const remainingFiles = fs.existsSync(requestDirectory) ? fs.readdirSync(requestDirectory) : [];

  assert.equal(documents.length, 0);
  assert.equal(updatedRequest.status, 'open');
  assert.deepEqual(remainingFiles, []);
});

test('secure upload persists a write-ahead cleanup intent before writing the first file', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('upload-write-ahead@example.com');
  const originalWriteFile = fs.promises.writeFile;
  let observedWriteAheadIntent = false;
  fs.promises.writeFile = async (filePath, ...args) => {
    if (String(filePath).includes(`${path.sep}${request.id}${path.sep}`)) {
      const pendingJobs = await storage.listPendingSecureDocumentCleanupJobs(100);
      const intent = pendingJobs.find((job) => job.metadata?.requestId === request.id);
      assert.ok(intent, 'a durable cleanup intent must exist before the first secure file write');
      assert.equal(intent.status, 'staging');
      assert.equal(intent.metadata.writeAheadIntent, true);
      observedWriteAheadIntent = true;
    }
    return originalWriteFile(filePath, ...args);
  };

  try {
    const result = await uploadSecureDocuments({
      token,
      ndaAccepted: true,
      request: requestFromIp('192.0.2.61'),
      documents: [{
        name: 'write-ahead-financials.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Write-ahead protected upload').toString('base64'),
      }],
    });
    assert.equal(result.ok, true);
  } finally {
    fs.promises.writeFile = originalWriteFile;
  }

  assert.equal(observedWriteAheadIntent, true);
});

test('secure upload recovers when finalization commits before its response is lost', async () => {
  const storage = getStorage();
  const { request, submission, token } = await createUploadToken('upload-commit-response-loss@example.com');
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  const originalAmbiguousCapability = storage.ambiguousCommitResponses;
  let droppedResponse = false;
  storage.ambiguousCommitResponses = true;

  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'finalize_secure_document_upload' && !droppedResponse) {
      droppedResponse = true;
      await originalMutation(mutation);
      throw new Error('simulated response loss after upload commit');
    }

    return originalMutation(mutation);
  };

  let result;
  try {
    result = await uploadSecureDocuments({
      token,
      ndaAccepted: true,
      request: requestFromIp('192.0.2.63'),
      documents: [{
        name: 'committed-financials.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Committed upload must survive response loss').toString('base64'),
      }],
    });
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.ambiguousCommitResponses = originalAmbiguousCapability;
  }

  const storedDocuments = await storage.listSecureDocumentsByRequest(request.id);
  const activity = await listCrmActivity({ submissionId: submission.id, storage });

  assert.equal(result.ok, true);
  assert.equal(result.request.status, 'partially-received');
  assert.equal(storedDocuments.length, 1);
  assert.equal(fs.existsSync(storedDocuments[0].storage_path), true);
  assert.equal(activity.filter((event) => event.event_type === 'documents.uploaded').length, 1);
});

test('ambiguous upload finalization preserves files for durable reconciliation', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('upload-ambiguous-response@example.com');
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  const originalGetRequest = storage.getSecureUploadRequest.bind(storage);
  const originalAmbiguousCapability = storage.ambiguousCommitResponses;
  let finalizationAttempted = false;
  storage.ambiguousCommitResponses = true;

  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'finalize_secure_document_upload') {
      finalizationAttempted = true;
      throw new Error('simulated unavailable RPC response');
    }
    return originalMutation(mutation);
  };
  storage.getSecureUploadRequest = async (id) => {
    if (finalizationAttempted) {
      throw new Error('simulated unavailable reconciliation read');
    }
    return originalGetRequest(id);
  };

  try {
    await assert.rejects(
      () => uploadSecureDocuments({
        token,
        ndaAccepted: true,
        request: requestFromIp('192.0.2.64'),
        documents: [{
          name: 'ambiguous-financials.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('Retain this file until the database can be checked').toString('base64'),
        }],
      }),
      /retained for automatic reconciliation/i,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.getSecureUploadRequest = originalGetRequest;
    storage.ambiguousCommitResponses = originalAmbiguousCapability;
  }

  const pendingJobs = await storage.listPendingSecureDocumentCleanupJobs(100);
  const job = pendingJobs.find((candidate) => candidate.metadata?.requestId === request.id);

  assert.ok(job);
  assert.equal(job.status, 'reconciliation-pending');
  assert.equal(job.metadata.reason, 'ambiguous-secure-upload-finalization');
  assert.equal(fs.existsSync(job.files[0].stagedPath), true);
  assert.equal(fs.existsSync(job.files[0].originalPath), false);

  const reconciliation = await reconcileSecureDocumentCleanupJobs(afterCleanupSettlement({ storage }));
  const reconciledJob = await storage.getSecureDocumentCleanupJob(job.id);
  const reconciledRequest = await storage.getSecureUploadRequest(request.id);

  assert.equal(reconciliation.completed, 1);
  assert.equal(reconciledJob.status, 'completed');
  assert.equal(reconciledRequest.status, 'open');
  assert.equal(fs.existsSync(job.files[0].stagedPath), false);
  assert.equal(fs.existsSync(job.trash_directory), false);
});

test('ambiguous upload writes a private recovery sidecar when cleanup storage is unavailable', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('upload-sidecar-fallback@example.com');
  const originalMutation = storage.mutateWithCrmActivity;
  const originalGetRequest = storage.getSecureUploadRequest;
  const originalInsertCleanupJob = storage.insertSecureDocumentCleanupJob;
  const originalAmbiguousCapability = storage.ambiguousCommitResponses;
  let finalizationAttempted = false;
  storage.ambiguousCommitResponses = true;
  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'finalize_secure_document_upload') {
      finalizationAttempted = true;
      throw new Error('simulated unavailable upload mutation');
    }
    return originalMutation.call(storage, mutation);
  };
  storage.getSecureUploadRequest = async (id) => {
    if (finalizationAttempted) throw new Error('simulated unavailable upload inspection');
    return originalGetRequest.call(storage, id);
  };
  storage.insertSecureDocumentCleanupJob = async () => {
    throw new Error('simulated unavailable cleanup database');
  };

  try {
    await assert.rejects(
      () => uploadSecureDocuments({
        token,
        ndaAccepted: true,
        request: requestFromIp('192.0.2.65'),
        documents: [{
          name: 'sidecar-financials.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('Retain this upload through a cleanup database outage').toString('base64'),
        }],
      }),
      /retained for automatic reconciliation/i,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.getSecureUploadRequest = originalGetRequest;
    storage.insertSecureDocumentCleanupJob = originalInsertCleanupJob;
    storage.ambiguousCommitResponses = originalAmbiguousCapability;
  }

  const sidecar = readCleanupSidecars().find((entry) => entry.job.metadata?.requestId === request.id);
  assert.ok(sidecar, 'the local sidecar must retain cleanup state when the database insert fails');
  assert.equal(fs.statSync(sidecar.path).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(sidecar.job.files[0].stagedPath), true);
  assert.equal(fs.existsSync(sidecar.job.files[0].originalPath), false);

  let lostImportResponse = false;
  storage.insertSecureDocumentCleanupJob = async (job) => {
    if (!lostImportResponse) {
      lostImportResponse = true;
      await originalInsertCleanupJob.call(storage, job);
      throw new Error('simulated cleanup import response loss after commit');
    }
    return originalInsertCleanupJob.call(storage, job);
  };
  let reconciliation;
  try {
    reconciliation = await reconcileSecureDocumentCleanupJobs(afterCleanupSettlement({ storage }));
  } finally {
    storage.insertSecureDocumentCleanupJob = originalInsertCleanupJob;
  }
  const reconciledJob = await storage.getSecureDocumentCleanupJob(sidecar.job.id);
  const reconciledRequest = await storage.getSecureUploadRequest(request.id);

  assert.deepEqual(reconciliation, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.equal(reconciledJob.status, 'completed');
  assert.equal(reconciledRequest.status, 'open');
  assert.equal(lostImportResponse, true);
  assert.equal(fs.existsSync(sidecar.path), false);
  assert.equal(fs.existsSync(sidecar.job.files[0].stagedPath), false);
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

test('secure request accepts multiple categorized batches and tracks requested documents', async () => {
  const storage = getStorage();
  const created = await createManualSubmission({ company: 'Batch Test Co', seller_name: 'Batch Seller', seller_email: 'batch@example.com' }, 'admin-test');
  const uploadRequest = await createSecureUploadRequest({
    submissionId: created.submission.id,
    requestedBy: 'admin-test',
    requestedDocuments: [{ category: 'cim', label: 'CIM' }, { category: 'tax_returns', label: 'Tax returns' }],
    sendEmail: false,
    request: requestFromIp('192.0.2.70'),
  });
  const token = new URL(uploadRequest.uploadUrl).searchParams.get('token');

  const first = await uploadSecureDocuments({
    token, ndaAccepted: true, request: requestFromIp('192.0.2.71'),
    documents: [{ name: 'cim.txt', mimeType: 'text/plain', documentType: 'cim', contentBase64: Buffer.from('cim').toString('base64') }],
  });
  const second = await uploadSecureDocuments({
    token, ndaAccepted: true, completeRequest: true, request: requestFromIp('192.0.2.72'),
    documents: [{ name: 'taxes.txt', mimeType: 'text/plain', documentType: 'tax_returns', contentBase64: Buffer.from('taxes').toString('base64') }],
  });

  assert.equal(first.ok, true);
  assert.equal(first.request.status, 'partially-received');
  assert.equal(second.ok, true);
  assert.equal(second.request.status, 'completed');
  assert.equal(second.request.upload_batch_count, 2);
  assert.equal(second.documents.length, 2);
  assert.ok(second.request.requested_checklist.every((item) => item.received));
  assert.deepEqual(
    (await storage.listSecureDocumentsByRequest(uploadRequest.request.id))
      .map((document) => document.document_type)
      .sort(),
    ['cim', 'tax_returns'],
  );
});

test('admin can revoke an upload link and delete one secure document', async () => {
  const storage = getStorage();
  const { request, token } = await createUploadToken('revoke-delete@example.com');
  const uploaded = await uploadSecureDocuments({
    token, ndaAccepted: true, request: requestFromIp('192.0.2.80'),
    documents: [{ name: 'delete-me.txt', mimeType: 'text/plain', contentBase64: Buffer.from('delete me').toString('base64') }],
  });
  const document = uploaded.documents[0];
  const deleted = await deleteSecureDocument({ documentId: document.id, deletedBy: 'admin-test', storage });
  const revoked = await revokeSecureUploadRequest({ requestId: request.id, revokedBy: 'admin-test', storage });

  assert.equal(deleted.ok, true);
  assert.equal(await storage.getSecureDocument(document.id), null);
  assert.equal(fs.existsSync(document.storage_path), false);
  assert.equal(revoked.ok, true);
  assert.equal(revoked.request.status, 'revoked');
  assert.equal((await getSecureUploadContext(token)).ok, false);
});

test('individual deletion persists a write-ahead cleanup intent before staging the file', async () => {
  const storage = getStorage();
  const { token } = await createUploadToken('delete-write-ahead@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.86'),
    documents: [{
      name: 'delete-write-ahead.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Write-ahead protected deletion').toString('base64'),
    }],
  });
  const document = uploaded.documents[0];
  const originalRename = fs.promises.rename;
  let observedWriteAheadIntent = false;
  fs.promises.rename = async (from, to) => {
    if (path.resolve(from) === path.resolve(document.storage_path)) {
      const pendingJobs = await storage.listPendingSecureDocumentCleanupJobs(100);
      const intent = pendingJobs.find((job) => job.metadata?.documentId === document.id);
      assert.ok(intent, 'a durable cleanup intent must exist before the secure file is staged');
      assert.equal(intent.status, 'staging');
      assert.equal(intent.metadata.writeAheadIntent, true);
      assert.equal(path.resolve(intent.files[0].stagedPath), path.resolve(to));
      observedWriteAheadIntent = true;
    }
    return originalRename(from, to);
  };

  try {
    const result = await deleteSecureDocument({ documentId: document.id, deletedBy: 'write-ahead-test', storage });
    assert.equal(result.ok, true);
  } finally {
    fs.promises.rename = originalRename;
  }

  assert.equal(observedWriteAheadIntent, true);
});

test('individual document deletion recovers when its commit response is lost', async () => {
  const storage = getStorage();
  const { submission, token } = await createUploadToken('delete-commit-response-loss@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.81'),
    documents: [{
      name: 'delete-after-response-loss.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Delete once despite response loss').toString('base64'),
    }],
  });
  const document = uploaded.documents[0];
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  const originalAmbiguousCapability = storage.ambiguousCommitResponses;
  let droppedResponse = false;
  storage.ambiguousCommitResponses = true;

  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'delete_secure_document' && !droppedResponse) {
      droppedResponse = true;
      await originalMutation(mutation);
      throw new Error('simulated response loss after document deletion');
    }
    return originalMutation(mutation);
  };

  let result;
  try {
    result = await deleteSecureDocument({ documentId: document.id, deletedBy: 'response-loss-test', storage });
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.ambiguousCommitResponses = originalAmbiguousCapability;
  }

  const activity = await listCrmActivity({ submissionId: submission.id, storage });

  assert.equal(result.ok, true);
  assert.equal(await storage.getSecureDocument(document.id), null);
  assert.equal(fs.existsSync(document.storage_path), false);
  assert.equal(activity.filter((event) => event.event_type === 'documents.deleted').length, 1);
});

test('ambiguous deletion keeps the file staged when the row still exists and reconciles a later commit', async () => {
  const storage = getStorage();
  const { submission, token } = await createUploadToken('delete-ambiguous-row-present@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.82'),
    documents: [{
      name: 'delete-after-late-commit.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Keep staged until the late commit is known').toString('base64'),
    }],
  });
  const document = uploaded.documents[0];
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  const originalAmbiguousCapability = storage.ambiguousCommitResponses;
  let capturedMutation = null;
  storage.ambiguousCommitResponses = true;
  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'delete_secure_document') {
      capturedMutation ||= mutation;
      throw new Error('simulated timeout while deletion may still be running');
    }
    return originalMutation(mutation);
  };

  try {
    await assert.rejects(
      () => deleteSecureDocument({ documentId: document.id, deletedBy: 'late-commit-test', storage }),
      /retained for automatic reconciliation/i,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.ambiguousCommitResponses = originalAmbiguousCapability;
  }

  const pendingJobs = await storage.listPendingSecureDocumentCleanupJobs(100);
  const job = pendingJobs.find((candidate) => candidate.metadata?.documentId === document.id);

  assert.ok(job);
  assert.equal(job.status, 'reconciliation-pending');
  assert.ok(await storage.getSecureDocument(document.id));
  assert.equal(fs.existsSync(document.storage_path), false);
  assert.equal(fs.existsSync(job.files[0].stagedPath), true);

  await originalMutation(capturedMutation);
  const reconciliation = await reconcileSecureDocumentCleanupJobs(afterCleanupSettlement({ storage }));
  const reconciledJob = await storage.getSecureDocumentCleanupJob(job.id);
  const activity = await listCrmActivity({ submissionId: submission.id, storage });

  assert.equal(reconciliation.completed, 1);
  assert.equal(reconciledJob.status, 'completed');
  assert.equal(await storage.getSecureDocument(document.id), null);
  assert.equal(fs.existsSync(job.files[0].stagedPath), false);
  assert.equal(fs.existsSync(document.storage_path), false);
  assert.equal(activity.filter((event) => event.event_type === 'documents.deleted').length, 1);
});

test('ambiguous deletion writes a recovery sidecar when cleanup storage is unavailable', async () => {
  const storage = getStorage();
  const { token } = await createUploadToken('delete-sidecar-fallback@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.83'),
    documents: [{
      name: 'delete-sidecar.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Restore this file after ambiguous deletion').toString('base64'),
    }],
  });
  const document = uploaded.documents[0];
  const originalMutation = storage.mutateWithCrmActivity;
  const originalInsertCleanupJob = storage.insertSecureDocumentCleanupJob;
  const originalAmbiguousCapability = storage.ambiguousCommitResponses;
  storage.ambiguousCommitResponses = true;
  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'delete_secure_document') {
      throw new Error('simulated ambiguous document deletion');
    }
    return originalMutation.call(storage, mutation);
  };
  storage.insertSecureDocumentCleanupJob = async () => {
    throw new Error('simulated unavailable cleanup database');
  };

  try {
    await assert.rejects(
      () => deleteSecureDocument({ documentId: document.id, deletedBy: 'sidecar-test', storage }),
      /retained for automatic reconciliation/i,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.insertSecureDocumentCleanupJob = originalInsertCleanupJob;
    storage.ambiguousCommitResponses = originalAmbiguousCapability;
  }

  const sidecar = readCleanupSidecars().find((entry) => entry.job.metadata?.documentId === document.id);
  assert.ok(sidecar);
  assert.equal(fs.existsSync(document.storage_path), false);
  assert.equal(fs.existsSync(sidecar.job.files[0].stagedPath), true);

  const reconciliation = await reconcileSecureDocumentCleanupJobs(afterCleanupSettlement({ storage }));
  const reconciledJob = await storage.getSecureDocumentCleanupJob(sidecar.job.id);

  assert.deepEqual(reconciliation, { reviewed: 1, completed: 0, restored: 1, failed: 0 });
  assert.equal(reconciledJob.status, 'restored');
  assert.equal(fs.readFileSync(document.storage_path, 'utf8'), 'Restore this file after ambiguous deletion');
  assert.equal(fs.existsSync(sidecar.path), false);
});

test('failed deletion restore writes a recovery sidecar when cleanup storage is unavailable', async () => {
  const storage = getStorage();
  const { token } = await createUploadToken('delete-restore-sidecar@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.84'),
    documents: [{
      name: 'restore-sidecar.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Recover this file after a failed restore').toString('base64'),
    }],
  });
  const document = uploaded.documents[0];
  const originalMutation = storage.mutateWithCrmActivity;
  const originalInsertCleanupJob = storage.insertSecureDocumentCleanupJob;
  const originalRename = fs.promises.rename;
  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'delete_secure_document') {
      throw new Error('simulated rejected document deletion');
    }
    return originalMutation.call(storage, mutation);
  };
  storage.insertSecureDocumentCleanupJob = async () => {
    throw new Error('simulated unavailable cleanup database');
  };
  fs.promises.rename = async (from, to) => {
    if (String(from).includes(`${path.sep}.trash${path.sep}`) && path.resolve(to) === path.resolve(document.storage_path)) {
      const error = new Error('simulated restore permission failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(from, to);
  };

  try {
    await assert.rejects(
      () => deleteSecureDocument({ documentId: document.id, deletedBy: 'restore-sidecar-test', storage }),
      /simulated rejected document deletion/i,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
    storage.insertSecureDocumentCleanupJob = originalInsertCleanupJob;
    fs.promises.rename = originalRename;
  }

  const sidecar = readCleanupSidecars().find((entry) => entry.job.metadata?.documentId === document.id);
  assert.ok(sidecar);
  assert.equal(sidecar.job.status, 'restore-failed');
  assert.equal(fs.existsSync(sidecar.job.files[0].stagedPath), true);

  const reconciliation = await reconcileSecureDocumentCleanupJobs({ storage });
  const reconciledJob = await storage.getSecureDocumentCleanupJob(sidecar.job.id);

  assert.deepEqual(reconciliation, { reviewed: 1, completed: 0, restored: 1, failed: 0 });
  assert.equal(reconciledJob.status, 'restored');
  assert.equal(fs.readFileSync(document.storage_path, 'utf8'), 'Recover this file after a failed restore');
  assert.equal(fs.existsSync(sidecar.path), false);
});

test('post-delete purge failure writes a recovery sidecar when cleanup storage is unavailable', async () => {
  const storage = getStorage();
  const { token } = await createUploadToken('delete-purge-sidecar@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.85'),
    documents: [{
      name: 'purge-sidecar.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('Purge this retained confidential copy').toString('base64'),
    }],
  });
  const document = uploaded.documents[0];
  const originalInsertCleanupJob = storage.insertSecureDocumentCleanupJob;
  const originalRm = fs.promises.rm;
  storage.insertSecureDocumentCleanupJob = async () => {
    throw new Error('simulated unavailable cleanup database');
  };
  fs.promises.rm = async (target, options) => {
    if (options?.recursive && String(target).includes(`${path.sep}.trash${path.sep}`)) {
      const error = new Error('simulated trash purge failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRm(target, options);
  };

  let result;
  try {
    result = await deleteSecureDocument({ documentId: document.id, deletedBy: 'purge-sidecar-test', storage });
  } finally {
    storage.insertSecureDocumentCleanupJob = originalInsertCleanupJob;
    fs.promises.rm = originalRm;
  }

  assert.equal(result.ok, true);
  assert.equal(await storage.getSecureDocument(document.id), null);
  const sidecar = readCleanupSidecars().find((entry) => entry.job.metadata?.documentId === document.id);
  assert.ok(sidecar);
  assert.equal(sidecar.job.status, 'cleanup-failed');
  assert.equal(fs.existsSync(sidecar.job.files[0].stagedPath), true);

  const reconciliation = await reconcileSecureDocumentCleanupJobs({ storage });
  const reconciledJob = await storage.getSecureDocumentCleanupJob(sidecar.job.id);

  assert.deepEqual(reconciliation, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.equal(reconciledJob.status, 'completed');
  assert.equal(fs.existsSync(sidecar.path), false);
  assert.equal(fs.existsSync(sidecar.job.files[0].stagedPath), false);
});

test('individual cleanup reconciliation checks the document row instead of its parent submission', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const deletedTrash = path.join(storageDir, '.trash', 'individual-deleted-job');
  const retainedTrash = path.join(storageDir, '.trash', 'individual-retained-job');
  const deletedOriginal = path.join(storageDir, 'individual-deleted.txt');
  const retainedOriginal = path.join(storageDir, 'individual-retained.txt');
  const deletedStaged = path.join(deletedTrash, 'individual-deleted.txt');
  const retainedStaged = path.join(retainedTrash, 'individual-retained.txt');
  fs.mkdirSync(deletedTrash, { recursive: true });
  fs.mkdirSync(retainedTrash, { recursive: true });
  fs.writeFileSync(deletedStaged, 'purge because the row is gone');
  fs.writeFileSync(retainedStaged, 'restore because the row still exists');
  const jobs = [
    {
      id: 'individual-deleted-job', submission_id: 'parent-still-exists', status: 'cleanup-failed', attempt_count: 0,
      trash_directory: deletedTrash,
      files: [{ documentId: 'deleted-document', originalPath: deletedOriginal, stagedPath: deletedStaged }],
      metadata: { reason: 'individual-document-deletion', documentId: 'deleted-document' },
    },
    {
      id: 'individual-retained-job', submission_id: 'parent-still-exists', status: 'reconciliation-pending', attempt_count: 0,
      trash_directory: retainedTrash,
      files: [{ documentId: 'retained-document', originalPath: retainedOriginal, stagedPath: retainedStaged }],
      metadata: { reason: 'individual-document-deletion', documentId: 'retained-document' },
    },
  ];
  const updates = new Map();
  const storage = {
    async listPendingSecureDocumentCleanupJobs() {
      return jobs;
    },
    async updateSecureDocumentCleanupJob(id, values) {
      updates.set(id, values);
      return values;
    },
    async getSubmission() {
      return { id: 'parent-still-exists' };
    },
    async getSecureDocument(id) {
      return id === 'retained-document' ? { id, storage_path: retainedOriginal } : null;
    },
  };

  const result = await reconcileSecureDocumentCleanupJobs({ storage });

  assert.deepEqual(result, { reviewed: 2, completed: 1, restored: 1, failed: 0 });
  assert.equal(updates.get('individual-deleted-job').status, 'completed');
  assert.equal(updates.get('individual-retained-job').status, 'restored');
  assert.equal(fs.existsSync(deletedStaged), false);
  assert.equal(fs.existsSync(deletedOriginal), false);
  assert.equal(fs.existsSync(retainedStaged), false);
  assert.equal(fs.readFileSync(retainedOriginal, 'utf8'), 'restore because the row still exists');
});

test('cleanup reconciliation recovers a synced temporary write-ahead intent after abrupt exit', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'temporary-intent-job';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPath = path.join(storageDir, 'temporary-intent-document.txt');
  const stagedPath = path.join(trashDirectory, 'temporary-intent-document.txt');
  const temporarySidecar = path.join(trashDirectory, '.reconciliation-crash.tmp');
  const now = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const job = {
    id: jobId,
    submission_id: 'temporary-intent-submission',
    created_at: now,
    updated_at: now,
    completed_at: null,
    status: 'staging',
    trash_directory: trashDirectory,
    files: [{ originalPath, stagedPath }],
    attempt_count: 0,
    last_error: 'process exited after syncing the intent',
    metadata: { writeAheadIntent: true },
  };
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.writeFileSync(stagedPath, 'recover this staged confidential file');
  fs.writeFileSync(temporarySidecar, `${JSON.stringify(job)}\n`, { mode: 0o600 });

  let storedJob = null;
  const storage = {
    async getSecureDocumentCleanupJob() {
      return storedJob;
    },
    async insertSecureDocumentCleanupJob(record) {
      storedJob = { ...record };
      return storedJob;
    },
    async listPendingSecureDocumentCleanupJobs() {
      return storedJob && !['completed', 'restored'].includes(storedJob.status) ? [storedJob] : [];
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      storedJob = { ...storedJob, ...values };
      return storedJob;
    },
    async getSubmission() {
      return null;
    },
  };

  const result = await reconcileSecureDocumentCleanupJobs({ storage, storageDir });

  assert.deepEqual(result, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.equal(storedJob.status, 'completed');
  assert.equal(fs.existsSync(temporarySidecar), false);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.existsSync(trashDirectory), false);
});

test('cleanup state rejects paths belonging to another operation or the trash root', async () => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const firstId = 'path-bound-job';
  const firstTrash = path.join(storageDir, '.trash', firstId);
  const secondTrash = path.join(storageDir, '.trash', 'different-job');
  const originalPath = path.join(storageDir, 'path-bound-document.txt');
  const now = new Date().toISOString();

  await assert.rejects(
    () => writeSecureDocumentCleanupSidecar({
      id: firstId,
      submission_id: 'path-bound-submission',
      created_at: now,
      updated_at: now,
      completed_at: null,
      status: 'cleanup-failed',
      trash_directory: firstTrash,
      files: [{ originalPath, stagedPath: path.join(secondTrash, 'stolen.txt') }],
      attempt_count: 0,
      last_error: 'malformed path test',
      metadata: {},
    }, { storageDir }),
    /outside its operation directory/i,
  );

  let updatedJob = null;
  const malformedJob = {
    id: firstId,
    submission_id: 'path-bound-submission',
    created_at: now,
    updated_at: now,
    completed_at: null,
    status: 'cleanup-failed',
    trash_directory: firstTrash,
    files: [{ originalPath, stagedPath: path.join(storageDir, '.trash') }],
    attempt_count: 0,
    last_error: 'malformed path test',
    metadata: {},
  };
  const storage = {
    async listPendingSecureDocumentCleanupJobs() {
      return [malformedJob];
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      updatedJob = values;
      return values;
    },
    async getSubmission() {
      return null;
    },
  };

  const result = await reconcileSecureDocumentCleanupJobs({ storage, storageDir });

  assert.deepEqual(result, { reviewed: 1, completed: 0, restored: 0, failed: 1 });
  assert.equal(updatedJob.status, 'cleanup-failed');
  assert.match(updatedJob.last_error, /exact operation directory/i);
  assert.equal(fs.existsSync(path.join(storageDir, '.trash')), true);
});

test('cleanup reconciliation retains staged files when strict submission lookup is unavailable', async (t) => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'strict-lookup-outage-job';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPath = path.join(storageDir, 'strict-lookup-outage.txt');
  const stagedPath = path.join(trashDirectory, path.basename(originalPath));
  const createdAt = new Date(Date.now() - secureDocumentCleanupSettlementMs - 1000).toISOString();
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.writeFileSync(stagedPath, 'retain this confidential file during the database outage');
  t.after(() => fs.rmSync(trashDirectory, { recursive: true, force: true }));

  let job = {
    id: jobId,
    submission_id: 'strict-lookup-outage-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: 'cleanup-failed',
    trash_directory: trashDirectory,
    files: [{ originalPath, stagedPath }],
    attempt_count: 0,
    last_error: null,
    metadata: {},
  };
  let permissiveLookupCalled = false;
  const storage = {
    provider: 'supabase',
    async listPendingSecureDocumentCleanupJobs() {
      return [job];
    },
    async claimSecureDocumentCleanupJob(_id, { claimedAt, leaseExpiresAt, leaseToken }) {
      job = { ...job, lease_claimed_at: claimedAt, lease_expires_at: leaseExpiresAt, lease_token: leaseToken };
      return job;
    },
    async renewSecureDocumentCleanupJobLease(_id, leaseToken, durationMs) {
      if (job.lease_token !== leaseToken) return null;
      job = { ...job, lease_expires_at: new Date(Date.now() + durationMs).toISOString() };
      return job;
    },
    async updateSecureDocumentCleanupJobIfLeased(_id, leaseToken, values) {
      if (job.lease_token !== leaseToken) return null;
      job = { ...job, ...values };
      return job;
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      job = { ...job, ...values };
      return job;
    },
    async getSubmission() {
      permissiveLookupCalled = true;
      return null;
    },
    async getSubmissionStrict() {
      throw new Error('simulated transient Supabase lookup outage');
    },
  };

  const result = await reconcileSecureDocumentCleanupJobs({ storage, storageDir });

  assert.deepEqual(result, { reviewed: 1, completed: 0, restored: 0, failed: 1 });
  assert.equal(permissiveLookupCalled, false);
  assert.equal(job.status, 'cleanup-failed');
  assert.match(job.last_error, /lookup outage/i);
  assert.equal(fs.existsSync(stagedPath), true);
  assert.equal(fs.existsSync(originalPath), false);
});

test('a reclaimed cleanup lease fences the stale worker before its filesystem mutation', async (t) => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'stale-worker-fenced-job';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPath = path.join(storageDir, 'stale-worker-fenced.txt');
  const stagedPath = path.join(trashDirectory, path.basename(originalPath));
  const createdAt = new Date(Date.now() - secureDocumentCleanupSettlementMs - 1000).toISOString();
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.writeFileSync(stagedPath, 'the stale worker must not purge this file');
  t.after(() => fs.rmSync(trashDirectory, { recursive: true, force: true }));

  let job = {
    id: jobId,
    submission_id: 'stale-worker-fenced-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: 'cleanup-failed',
    trash_directory: trashDirectory,
    files: [{ originalPath, stagedPath }],
    attempt_count: 0,
    last_error: null,
    metadata: {},
    lease_claimed_at: null,
    lease_expires_at: null,
    lease_token: null,
  };
  let currentLeaseToken = null;
  let unlinkCalled = false;
  const reclaimedToken = 'reclaimed_cleanup_worker_0002';
  const storage = {
    async listPendingSecureDocumentCleanupJobs() {
      return [job];
    },
    async claimSecureDocumentCleanupJob(_id, { claimedAt, leaseExpiresAt, leaseToken }) {
      currentLeaseToken = leaseToken;
      job = {
        ...job,
        updated_at: claimedAt,
        lease_claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        lease_token: leaseToken,
      };
      return job;
    },
    async updateSecureDocumentCleanupJobIfLeased(_id, leaseToken, values) {
      if (leaseToken !== currentLeaseToken) return null;
      job = { ...job, ...values };
      return job;
    },
    async renewSecureDocumentCleanupJobLease(_id, leaseToken, durationMs) {
      if (leaseToken !== currentLeaseToken) return null;
      job = { ...job, lease_expires_at: new Date(Date.now() + durationMs).toISOString() };
      return job;
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      job = { ...job, ...values };
      return job;
    },
    async getSubmissionStrict() {
      // Simulate another worker reclaiming the expired lease while this
      // worker is completing its database disposition lookup.
      currentLeaseToken = reclaimedToken;
      job = { ...job, lease_token: reclaimedToken };
      return null;
    },
  };

  const result = await reconcileSecureDocumentCleanupJobs({
    storage,
    storageDir,
    async unlinkFile() {
      unlinkCalled = true;
    },
  });

  assert.deepEqual(result, { reviewed: 1, completed: 0, restored: 0, failed: 0 });
  assert.equal(unlinkCalled, false);
  assert.equal(job.lease_token, reclaimedToken);
  assert.equal(fs.existsSync(stagedPath), true);
  assert.equal(fs.existsSync(originalPath), false);
});

test('cleanup reconciliation renews between files and stops when another worker reclaims', async (t) => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'multi-file-lease-renewal-job';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPaths = [
    path.join(storageDir, 'multi-file-renewal-a.txt'),
    path.join(storageDir, 'multi-file-renewal-b.txt'),
  ];
  const stagedPaths = originalPaths.map((originalPath, index) => (
    path.join(trashDirectory, `${index}-${path.basename(originalPath)}`)
  ));
  const createdAt = new Date(Date.now() - secureDocumentCleanupSettlementMs - 1000).toISOString();
  fs.mkdirSync(trashDirectory, { recursive: true });
  stagedPaths.forEach((stagedPath, index) => fs.writeFileSync(stagedPath, `staged-${index}`));
  t.after(() => fs.rmSync(trashDirectory, { recursive: true, force: true }));

  let currentLeaseToken = null;
  const reclaimedToken = 'multi_file_reclaimed_worker_0002';
  let renewCount = 0;
  let unlinkCount = 0;
  let job = {
    id: jobId,
    submission_id: 'multi-file-lease-renewal-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: 'cleanup-failed',
    trash_directory: trashDirectory,
    files: stagedPaths.map((stagedPath, index) => ({ originalPath: originalPaths[index], stagedPath })),
    attempt_count: 0,
    last_error: null,
    metadata: {},
    lease_claimed_at: null,
    lease_expires_at: null,
    lease_token: null,
  };
  const storage = {
    async listPendingSecureDocumentCleanupJobs() {
      return [job];
    },
    async claimSecureDocumentCleanupJob(_id, { claimedAt, leaseExpiresAt, leaseToken }) {
      currentLeaseToken = leaseToken;
      job = {
        ...job,
        lease_claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        lease_token: leaseToken,
      };
      return job;
    },
    async renewSecureDocumentCleanupJobLease(_id, leaseToken, durationMs) {
      renewCount += 1;
      if (leaseToken !== currentLeaseToken) return null;
      job = { ...job, lease_expires_at: new Date(Date.now() + durationMs).toISOString() };
      return job;
    },
    async updateSecureDocumentCleanupJobIfLeased(_id, leaseToken, values) {
      if (leaseToken !== currentLeaseToken) return null;
      job = { ...job, ...values };
      return job;
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      job = { ...job, ...values };
      return job;
    },
    async getSubmissionStrict() {
      return null;
    },
  };

  const result = await reconcileSecureDocumentCleanupJobs({
    storage,
    storageDir,
    async unlinkFile(filePath) {
      unlinkCount += 1;
      await fs.promises.unlink(filePath);
      currentLeaseToken = reclaimedToken;
      job = { ...job, lease_token: reclaimedToken };
    },
  });

  assert.deepEqual(result, { reviewed: 1, completed: 0, restored: 0, failed: 0 });
  assert.equal(renewCount, 3);
  assert.equal(unlinkCount, 1);
  assert.equal(fs.existsSync(stagedPaths[0]), false);
  assert.equal(fs.existsSync(stagedPaths[1]), true);
  assert.equal(job.lease_token, reclaimedToken);
});

test('write-ahead reconciliation waits for late commits, then restores the committed document under a lease', async (t) => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'late-commit-settlement-job';
  const documentId = 'late-commit-settlement-document';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPath = path.join(storageDir, 'late-commit-settlement.txt');
  const stagedPath = path.join(trashDirectory, `0-${path.basename(originalPath)}`);
  const createdAt = new Date().toISOString();
  const reconcileAfter = new Date(Date.parse(createdAt) + secureDocumentCleanupSettlementMs).toISOString();
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.writeFileSync(stagedPath, 'restore after the late database commit settles');
  t.after(() => {
    fs.rmSync(trashDirectory, { recursive: true, force: true });
    fs.rmSync(originalPath, { force: true });
  });

  let job = {
    id: jobId,
    submission_id: 'late-commit-settlement-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: 'reconciliation-pending',
    trash_directory: trashDirectory,
    files: [{ documentId, originalPath, stagedPath, staged: true, purgeOriginalIfStagedMissing: true }],
    attempt_count: 0,
    last_error: 'database response is still ambiguous',
    metadata: {
      reason: 'ambiguous-secure-upload-finalization',
      requestId: 'late-commit-settlement-request',
      documentIds: [documentId],
      reconcileAfter,
      writeAheadIntent: true,
    },
  };
  let committedDocument = null;
  let claimCount = 0;
  let documentLookupCount = 0;
  const storage = {
    async listPendingSecureDocumentCleanupJobs() {
      return ['completed', 'restored'].includes(job.status) ? [] : [job];
    },
    async claimSecureDocumentCleanupJob(_id, { claimedAt, leaseExpiresAt, leaseToken }) {
      claimCount += 1;
      job = {
        ...job,
        updated_at: claimedAt,
        lease_claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        lease_token: leaseToken,
      };
      return job;
    },
    async renewSecureDocumentCleanupJobLease(_id, leaseToken, durationMs) {
      if (job.lease_token !== leaseToken) return null;
      job = { ...job, lease_expires_at: new Date(Date.now() + durationMs).toISOString() };
      return job;
    },
    async updateSecureDocumentCleanupJobIfLeased(_id, leaseToken, values) {
      if (job.lease_token !== leaseToken) return null;
      job = { ...job, ...values };
      return job;
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      job = { ...job, ...values };
      return job;
    },
    async getSecureDocument() {
      documentLookupCount += 1;
      return committedDocument;
    },
  };

  const settlingResult = await reconcileSecureDocumentCleanupJobs({ storage, storageDir, now: createdAt });

  assert.deepEqual(settlingResult, { reviewed: 1, completed: 0, restored: 0, failed: 0 });
  assert.equal(claimCount, 0);
  assert.equal(documentLookupCount, 0);
  assert.equal(fs.existsSync(stagedPath), true);
  assert.equal(fs.existsSync(originalPath), false);

  committedDocument = { id: documentId, storage_path: originalPath };
  const settledResult = await reconcileSecureDocumentCleanupJobs({
    storage,
    storageDir,
    now: new Date(Date.parse(reconcileAfter) + 1000).toISOString(),
  });

  assert.deepEqual(settledResult, { reviewed: 1, completed: 0, restored: 1, failed: 0 });
  assert.equal(claimCount, 1);
  assert.equal(documentLookupCount, 1);
  assert.equal(job.status, 'restored');
  assert.equal(job.lease_expires_at, null);
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'restore after the late database commit settles');
  assert.equal(fs.existsSync(stagedPath), false);
});

test('legacy write-ahead jobs settle from immutable creation time after a lease refresh', async (t) => {
  const storage = getStorage();
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'legacy-write-ahead-settlement-job';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPath = path.join(storageDir, 'legacy-write-ahead-settlement.txt');
  const stagedPath = path.join(trashDirectory, path.basename(originalPath));
  const createdAt = new Date(Date.now() - secureDocumentCleanupSettlementMs - 1000).toISOString();
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.writeFileSync(stagedPath, 'purge this legacy staged file once');
  t.after(() => fs.rmSync(trashDirectory, { recursive: true, force: true }));

  await storage.insertSecureDocumentCleanupJob({
    id: jobId,
    submission_id: 'legacy-write-ahead-missing-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: 'staging',
    trash_directory: trashDirectory,
    files: [{ originalPath, stagedPath }],
    attempt_count: 0,
    last_error: null,
    metadata: { writeAheadIntent: true },
  });

  const result = await reconcileSecureDocumentCleanupJobs({ storage, storageDir });
  const reconciledJob = await storage.getSecureDocumentCleanupJob(jobId);

  assert.deepEqual(result, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.equal(reconciledJob.status, 'completed');
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.existsSync(trashDirectory), false);
});

test('overlapping local cleanup runs share one leased filesystem operation', async (t) => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const jobId = 'overlapping-cleanup-job';
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const originalPath = path.join(storageDir, 'overlapping-cleanup.txt');
  const stagedPath = path.join(trashDirectory, path.basename(originalPath));
  const createdAt = new Date(Date.now() - secureDocumentCleanupSettlementMs - 1000).toISOString();
  fs.mkdirSync(trashDirectory, { recursive: true });
  fs.writeFileSync(stagedPath, 'purge exactly once');
  t.after(() => fs.rmSync(trashDirectory, { recursive: true, force: true }));

  let job = {
    id: jobId,
    submission_id: 'overlapping-cleanup-submission',
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: 'cleanup-failed',
    trash_directory: trashDirectory,
    files: [{ originalPath, stagedPath }],
    attempt_count: 0,
    last_error: null,
    metadata: {},
  };
  let listCount = 0;
  let claimCount = 0;
  let unlinkCount = 0;
  let releaseUnlink;
  let signalUnlinkStarted;
  const unlinkStarted = new Promise((resolve) => { signalUnlinkStarted = resolve; });
  const unlinkReleased = new Promise((resolve) => { releaseUnlink = resolve; });
  const storage = {
    async listPendingSecureDocumentCleanupJobs() {
      listCount += 1;
      return ['completed', 'restored'].includes(job.status) ? [] : [job];
    },
    async claimSecureDocumentCleanupJob(_id, { claimedAt, leaseExpiresAt, leaseToken }) {
      claimCount += 1;
      job = {
        ...job,
        updated_at: claimedAt,
        lease_claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        lease_token: leaseToken,
      };
      return job;
    },
    async renewSecureDocumentCleanupJobLease(_id, leaseToken, durationMs) {
      if (job.lease_token !== leaseToken) return null;
      job = { ...job, lease_expires_at: new Date(Date.now() + durationMs).toISOString() };
      return job;
    },
    async updateSecureDocumentCleanupJobIfLeased(_id, leaseToken, values) {
      if (job.lease_token !== leaseToken) return null;
      job = { ...job, ...values };
      return job;
    },
    async updateSecureDocumentCleanupJob(_id, values) {
      job = { ...job, ...values };
      return job;
    },
    async getSubmissionStrict() {
      return null;
    },
  };
  const options = {
    storage,
    storageDir,
    async unlinkFile(filePath) {
      unlinkCount += 1;
      signalUnlinkStarted();
      await unlinkReleased;
      await fs.promises.unlink(filePath);
    },
  };

  const firstRun = reconcileSecureDocumentCleanupJobs(options);
  await unlinkStarted;
  const overlappingRun = reconcileSecureDocumentCleanupJobs(options);
  releaseUnlink();
  const [firstResult, overlappingResult] = await Promise.all([firstRun, overlappingRun]);

  assert.deepEqual(firstResult, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.deepEqual(overlappingResult, firstResult);
  assert.equal(listCount, 1);
  assert.equal(claimCount, 1);
  assert.equal(unlinkCount, 1);
  assert.equal(job.status, 'completed');
  assert.equal(fs.existsSync(stagedPath), false);
});

test('dashboard deletion keeps files staged until a late delete commit settles', async () => {
  const storage = getStorage();
  const { submission, token } = await createUploadToken('bulk-delete-response-loss@example.com');
  const uploaded = await uploadSecureDocuments({
    token,
    ndaAccepted: true,
    request: requestFromIp('192.0.2.91'),
    documents: [{
      name: 'bulk-delete-response-loss.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('purge after the strict read confirms the commit').toString('base64'),
    }],
  });
  const document = uploaded.documents.find((candidate) => candidate.original_name === 'bulk-delete-response-loss.txt');
  const originalDeleteSubmission = storage.deleteSubmission;
  storage.deleteSubmission = async () => {
    throw new Error('simulated timed-out delete that may still commit');
  };

  let result;
  try {
    result = await deleteDashboardSubmission(submission.id, { storage });
  } finally {
    storage.deleteSubmission = originalDeleteSubmission;
  }

  let jobs = await storage.listSecureDocumentCleanupJobs({ limit: 100 });
  let cleanupJob = jobs.find((candidate) => (
    candidate.submission_id === submission.id && candidate.metadata?.ambiguousDelete
  ));
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.ok(cleanupJob);
  assert.equal(cleanupJob.status, 'reconciliation-pending');
  assert.ok(await storage.getSubmissionStrict(submission.id));
  assert.ok(await storage.getSecureDocument(document.id));
  assert.equal(fs.existsSync(document.storage_path), false);
  assert.equal(fs.existsSync(cleanupJob.files[0].stagedPath), true);

  const lateCommit = await originalDeleteSubmission.call(storage, submission.id);
  assert.ok(lateCommit);
  const reconciliation = await reconcileSecureDocumentCleanupJobs(afterCleanupSettlement({ storage }));
  jobs = await storage.listSecureDocumentCleanupJobs({ limit: 100 });
  cleanupJob = jobs.find((candidate) => candidate.id === cleanupJob.id);

  assert.deepEqual(reconciliation, { reviewed: 1, completed: 1, restored: 0, failed: 0 });
  assert.equal(cleanupJob.status, 'completed');
  assert.equal(await storage.getSubmissionStrict(submission.id), null);
  assert.equal(await storage.getSecureDocument(document.id), null);
  assert.equal(fs.existsSync(cleanupJob.files[0].stagedPath), false);
  assert.equal(fs.existsSync(cleanupJob.trash_directory), false);
});

test('dashboard deletion retains staged files whenever its commit response is ambiguous', async (t) => {
  const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  const submissionId = 'bulk-delete-inspection-outage';
  const documentPath = path.join(storageDir, 'bulk-delete-inspection-outage.txt');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(documentPath, 'retain while the deletion outcome is unknown');
  let cleanupJob = null;
  const storage = {
    provider: 'supabase',
    async getSubmissionStrict() {
      return { id: submissionId };
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
      throw new Error('simulated ambiguous deletion response');
    },
  };

  const result = await deleteDashboardSubmission(submissionId, { storage });
  t.after(() => fs.rmSync(cleanupJob?.trash_directory, { recursive: true, force: true }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.cleanupPending, true);
  assert.equal(cleanupJob.status, 'reconciliation-pending');
  assert.equal(cleanupJob.metadata.writeAheadIntent, true);
  assert.equal(fs.existsSync(documentPath), false);
  assert.equal(fs.existsSync(cleanupJob.files[0].stagedPath), true);
});

test('revocation wins an in-flight upload before atomic finalization', async () => {
  const storage = getStorage();
  const { request, submission, token } = await createUploadToken('revoke-race-test@example.com');
  const originalMutation = storage.mutateWithCrmActivity.bind(storage);
  let revokedDuringFinalization = false;

  storage.mutateWithCrmActivity = async (mutation) => {
    if (mutation.operation === 'finalize_secure_document_upload' && !revokedDuringFinalization) {
      revokedDuringFinalization = true;
      const revocation = await revokeSecureUploadRequest({
        requestId: request.id,
        revokedBy: 'race-test-admin',
        storage,
      });
      assert.equal(revocation.ok, true);
    }

    return originalMutation(mutation);
  };

  try {
    await assert.rejects(
      () => uploadSecureDocuments({
        token,
        ndaAccepted: true,
        request: requestFromIp('192.0.2.62'),
        documents: [{
          name: 'race-financials.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('Financials that must not survive revocation').toString('base64'),
        }],
      }),
      /changed while the files were being processed/i,
    );
  } finally {
    storage.mutateWithCrmActivity = originalMutation;
  }

  const updatedRequest = await storage.getSecureUploadRequest(request.id);
  const documents = await storage.listSecureDocumentsByRequest(request.id);
  const requestDirectory = path.join(process.env.SECURE_DOCUMENTS_STORAGE_DIR, request.id);
  const remainingFiles = fs.existsSync(requestDirectory) ? fs.readdirSync(requestDirectory) : [];
  const activity = await listCrmActivity({ submissionId: submission.id, storage });

  assert.equal(updatedRequest.status, 'revoked');
  assert.ok(updatedRequest.revoked_at);
  assert.deepEqual(documents, []);
  assert.deepEqual(remainingFiles, []);
  assert.equal(activity.filter((event) => event.event_type === 'documents.link-revoked').length, 1);
  assert.equal(activity.filter((event) => event.event_type === 'documents.uploaded').length, 0);
});
