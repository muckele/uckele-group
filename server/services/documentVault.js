import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp, getRequestOrigin } from '../utils/http.js';
import { hashIp, sha256, signPayload, verifySignedPayload } from '../utils/security.js';
import { sendDocumentUploadNotificationEmail, sendSecureUploadInviteEmail } from './delivery.js';
import { buildCrmActivityEvent, commitCrmActivityMutation } from './activity.js';
import {
  persistSecureDocumentCleanupJob,
  registerSecureDocumentCleanupIntent,
  secureDocumentCleanupSettlementMs,
  unregisterSecureDocumentCleanupIntent,
  updateSecureDocumentCleanupJobState,
} from './secureDocumentCleanupState.js';

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
  'application/x-zip-compressed',
]);
const maxDocumentsPerUpload = 5;
const maxDocumentsPerRequest = 25;
const staleUploadingRequestMs = 15 * 60 * 1000;
const secureUploadRateLimitEvents = new Map();
const base64ExpansionRatio = 4 / 3;
const jsonUploadEnvelopeBytes = 1024 * 1024;

const mimeTypesByExtension = new Map([
  ['.pdf', 'application/pdf'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.csv', 'text/csv'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.doc', 'application/msword'],
  ['.txt', 'text/plain'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.zip', 'application/zip'],
]);

function sanitizeFileName(fileName) {
  const cleaned = String(fileName || 'document')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned || 'document';
}

export function resolveSecureStoragePath(filePath, storageDir) {
  const resolvedRoot = path.resolve(storageDir);
  const resolvedPath = path.resolve(String(filePath || ''));

  if (!resolvedPath || (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`))) {
    return '';
  }

  return resolvedPath;
}

function buildAccessToken(payload) {
  const config = getConfig();
  return signPayload(payload, config.secureDocuments.tokenSecret);
}

function verifyAccessToken(token) {
  const config = getConfig();
  return verifySignedPayload(token, config.secureDocuments.tokenSecret);
}

function normalizeDocumentType(value) {
  const normalized = String(value || 'other').trim().toLowerCase();
  const aliases = {
    'tax-returns': 'tax_returns',
    'customer-summary': 'customer_concentration',
    'p&l': 'p_and_l',
  };
  const canonical = aliases[normalized] || normalized.replace(/-/g, '_');
  const allowed = [
    'teaser', 'cim', 'nda', 'financials', 'p_and_l', 'tax_returns', 'balance_sheet',
    'customer_concentration', 'payroll', 'lease', 'contracts', 'equipment', 'owner_role',
    'management_depth', 'sba_fit', 'other',
  ];
  return allowed.includes(canonical) ? canonical : 'other';
}

function documentTypeLabel(value) {
  return normalizeDocumentType(value).split('_').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}

function normalizeRequestedDocuments(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      const category = normalizeDocumentType(typeof item === 'string' ? item : item?.category || item?.id);
      return { category, label: String(item?.label || documentTypeLabel(category)).trim().slice(0, 120), required: item?.required !== false };
    })
    .filter((item) => item.category !== 'other' && !seen.has(item.category) && seen.add(item.category))
    .slice(0, 20);
}

function buildRequestedDocumentChecklist(requestRecord, documents = []) {
  const counts = documents.reduce((result, document) => {
    const category = normalizeDocumentType(document.document_type);
    result[category] = (result[category] || 0) + 1;
    return result;
  }, {});
  return normalizeRequestedDocuments(requestRecord.requested_documents).map((item) => ({
    ...item,
    received: Boolean(counts[item.category]),
    receivedCount: counts[item.category] || 0,
  }));
}

function inferMimeType(document = {}) {
  const supplied = String(document.mimeType || '').trim().toLowerCase();

  if (supplied && supplied !== 'application/octet-stream') {
    return supplied;
  }

  return mimeTypesByExtension.get(path.extname(String(document.name || '')).toLowerCase()) || '';
}

function normalizeBase64(value = '') {
  return String(value || '')
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');
}

export function getSecureUploadJsonLimitBytes(config = getConfig()) {
  return Math.ceil(
    Math.min(
      config.secureDocuments.maxUploadBytes * maxDocumentsPerUpload,
      config.secureDocuments.maxTotalUploadBytes,
    ) * base64ExpansionRatio
      + jsonUploadEnvelopeBytes,
  );
}

function estimateBase64DecodedBytes(value = '') {
  const normalized = normalizeBase64(value);

  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }

  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function startsWithBytes(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function hasZipSignature(buffer) {
  return (
    startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08])
  );
}

function hasOleSignature(buffer) {
  return startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function hasTextSignature(buffer) {
  return buffer.length > 0 && !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function bufferMatchesMimeType(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }

  if (mimeType === 'image/png') {
    return startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  if (mimeType === 'image/jpeg') {
    return startsWithBytes(buffer, [0xff, 0xd8, 0xff]);
  }

  if (mimeType === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  if (
    [
      'application/zip',
      'application/x-zip-compressed',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(mimeType)
  ) {
    return hasZipSignature(buffer);
  }

  if (['application/vnd.ms-excel', 'application/msword'].includes(mimeType)) {
    return hasOleSignature(buffer);
  }

  if (['text/csv', 'text/plain'].includes(mimeType)) {
    return hasTextSignature(buffer);
  }

  return false;
}

function prepareDocumentPayload(document = {}, config) {
  document = document || {};
  const errors = [];
  const decodedBytes = estimateBase64DecodedBytes(document.contentBase64);
  const mimeType = inferMimeType(document);
  let buffer = null;

  if (!document.name || !document.contentBase64) {
    errors.push('Each uploaded file must include a name and file content.');
  }

  if (decodedBytes === null) {
    errors.push(`${document.name || 'A file'} has invalid file content.`);
  } else if (decodedBytes > config.secureDocuments.maxUploadBytes) {
    errors.push(
      `${document.name || 'A file'} exceeds the maximum upload size of ${Math.round(
        config.secureDocuments.maxUploadBytes / (1024 * 1024),
      )} MB.`,
    );
  }

  if (!mimeType) {
    errors.push(`${document.name || 'A file'} must include a file type.`);
  } else if (!allowedMimeTypes.has(mimeType)) {
    errors.push(`${document.name || 'A file'} uses a file type that is not allowed.`);
  }

  if (errors.length === 0) {
    buffer = Buffer.from(normalizeBase64(document.contentBase64), 'base64');

    if (!bufferMatchesMimeType(buffer, mimeType)) {
      errors.push(`${document.name || 'A file'} does not match the selected file type.`);
    }
  }

  return {
    document,
    mimeType,
    buffer,
    errors,
  };
}

function sumSecureDocumentBytes(documents = []) {
  return documents.reduce((sum, document) => sum + Number(document.size_bytes || 0), 0);
}

async function commitWithSingleRetry(commit, { retryAmbiguousResponse = false } = {}) {
  try {
    return { mutation: await commit(), errors: [], ambiguous: false };
  } catch (firstError) {
    if (!retryAmbiguousResponse) {
      return { mutation: null, errors: [firstError], ambiguous: false };
    }

    try {
      return { mutation: await commit(), errors: [firstError], ambiguous: true };
    } catch (retryError) {
      return { mutation: null, errors: [firstError, retryError], ambiguous: true };
    }
  }
}

function storageCanLoseCommitResponses(storage) {
  return storage.provider === 'supabase' || storage.ambiguousCommitResponses === true;
}

async function inspectUploadFinalization(storage, requestId, documents, expectedBatchCount) {
  try {
    const [requestRecord, storedDocuments] = await Promise.all([
      storage.getSecureUploadRequest(requestId),
      Promise.all(documents.map((document) => storage.getSecureDocument(document.id))),
    ]);
    const allStored = storedDocuments.length > 0 && storedDocuments.every((document) => Boolean(document));
    const noneStored = storedDocuments.every((document) => !document);
    const batchCommitted = Number(requestRecord?.upload_batch_count || 0) >= Number(expectedBatchCount || 0);

    if (requestRecord && allStored && batchCommitted) {
      return { known: true, committed: true, request: requestRecord, documents: storedDocuments };
    }

    if (requestRecord && noneStored && !batchCommitted) {
      return { known: true, committed: false, request: requestRecord, documents: storedDocuments };
    }

    return { known: false, committed: false, request: requestRecord, documents: storedDocuments };
  } catch (error) {
    return { known: false, committed: false, request: null, documents: [], error };
  }
}

async function preserveAmbiguousUploadFiles({ storage, cleanupJob, error }) {
  const files = cleanupJob.files.map((file) => ({ ...file }));
  const stagingErrors = [];

  try {
    await fs.mkdir(cleanupJob.trash_directory, { recursive: true, mode: 0o700 });
  } catch (mkdirError) {
    stagingErrors.push(mkdirError.message);
  }

  for (const file of files) {
    if (stagingErrors.length === 0) {
      try {
        await fs.rename(file.originalPath, file.stagedPath);
        file.staged = true;
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') {
          stagingErrors.push(renameError.message);
        }
      }
    }

  }

  const now = new Date().toISOString();
  const values = {
    updated_at: now,
    status: 'reconciliation-pending',
    files,
    last_error: String(error?.message || error || 'Secure upload finalization response was ambiguous.').slice(0, 2000),
    metadata: {
      ...cleanupJob.metadata,
      stagingErrors,
    },
  };

  try {
    await updateSecureDocumentCleanupJobState(storage, cleanupJob, values);
  } catch (persistenceError) {
    persistenceError.preserveSecureFiles = true;
    throw persistenceError;
  }

  return { ...cleanupJob, ...values };
}

async function cleanupPartialUploadAttempt({ storage, requestId, savedDocuments, writtenFilePaths, resetStatus = 'open' }) {
  const failures = [];
  for (const document of savedDocuments) {
    if (!storage.deleteSecureDocument) {
      continue;
    }

    try {
      await storage.deleteSecureDocument(document.id);
    } catch (error) {
      console.warn(`[secure-documents] failed to remove partial document record ${document.id}: ${error.message}`);
      failures.push(error);
    }
  }

  for (const filePath of writtenFilePaths) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[secure-documents] failed to remove partial upload file ${filePath}: ${error.message}`);
        failures.push(error);
      }
    }
  }

  const resetRequest = storage.resetSecureUploadRequestIfUploading || storage.updateSecureUploadRequest;
  await resetRequest.call(storage, requestId, {
    updated_at: new Date().toISOString(),
    status: resetStatus,
  }).catch((error) => {
    console.warn(`[secure-documents] failed to reset partial upload request ${requestId}: ${error.message}`);
    failures.push(error);
  });

  return failures;
}

function isStaleUploadingRequest(requestRecord) {
  if (requestRecord?.status !== 'uploading') {
    return false;
  }

  const updatedAt = Date.parse(requestRecord.updated_at || requestRecord.created_at || '');
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > staleUploadingRequestMs;
}

async function recoverStaleUploadRequest(storage, requestRecord) {
  if (!isStaleUploadingRequest(requestRecord)) {
    return requestRecord;
  }

  const resetRequest = storage.resetSecureUploadRequestIfUploading || storage.updateSecureUploadRequest;
  const recovered = await resetRequest.call(storage, requestRecord.id, {
    updated_at: new Date().toISOString(),
    status: 'open',
  });

  return recovered || storage.getSecureUploadRequest(requestRecord.id);
}

function enforceInMemoryRateLimit(buckets, windowMs, maxAttempts) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const snapshots = buckets.map((bucket) => ({
    bucket,
    timestamps: (secureUploadRateLimitEvents.get(bucket) || []).filter((timestamp) => timestamp >= cutoff),
  }));

  if (snapshots.some((snapshot) => snapshot.timestamps.length >= maxAttempts)) {
    return { blocked: true };
  }

  for (const snapshot of snapshots) {
    secureUploadRateLimitEvents.set(snapshot.bucket, [...snapshot.timestamps, now]);
  }

  return { blocked: false };
}

async function enforceSecureUploadRateLimit({ buckets, maxAttempts, requestLabel }) {
  const config = getConfig();
  const storage = getStorage();
  const windowMs = config.protection.rateLimitWindowMs;
  const blocked = {
    ok: false,
    status: 429,
    error: 'Too many secure upload attempts. Please wait a few minutes and try again.',
  };

  try {
    const windowStartIso = new Date(Date.now() - windowMs).toISOString();
    const counts = await Promise.all(buckets.map((bucket) => storage.countRateLimitEvents(bucket, windowStartIso)));

    if (counts.some((count) => count >= maxAttempts)) {
      return blocked;
    }

    const nowIso = new Date().toISOString();
    await Promise.all(buckets.map((bucket) => storage.addRateLimitEvent(bucket, nowIso)));
    return { ok: true };
  } catch (error) {
    console.warn(`[secure-documents] ${requestLabel} rate limit storage failed: ${error.message}`);
    return enforceInMemoryRateLimit(buckets, windowMs, maxAttempts).blocked ? blocked : { ok: true };
  }
}

function secureUploadIpBucket(request, prefix) {
  return `${prefix}:ip:${hashIp(getClientIp(request))}`;
}

export async function enforceSecureUploadBodyRateLimit(request) {
  const config = getConfig();

  return enforceSecureUploadRateLimit({
    buckets: [secureUploadIpBucket(request, 'secure-documents-upload-body')],
    maxAttempts: Math.max(1, config.protection.rateLimitMax),
    requestLabel: 'body',
  });
}

async function enforceSecureUploadAttemptRateLimit({ token, request }) {
  const config = getConfig();
  const normalizedToken = String(token || '').trim() || 'empty';

  return enforceSecureUploadRateLimit({
    buckets: [
      secureUploadIpBucket(request, 'secure-documents-upload'),
      `secure-documents-upload:token:${sha256(normalizedToken).slice(0, 24)}`,
    ],
    maxAttempts: Math.max(1, config.protection.rateLimitMax),
    requestLabel: 'attempt',
  });
}

export async function createSecureUploadRequest({ submissionId, requestedBy, note = '', requestedDocuments = [], sendEmail = true, request }) {
  const config = getConfig();
  const storage = getStorage();
  const submission = await storage.getSubmission(submissionId);

  if (!submission) {
    return { ok: false, error: 'Submission not found.' };
  }

  if (!submission.email) {
    return { ok: false, error: 'This submission does not include an email address.' };
  }

  const now = new Date().toISOString();
  const requestRecord = {
    id: randomUUID(),
    submission_id: submission.id,
    created_at: now,
    updated_at: now,
    email: submission.email,
    contact_name: submission.name,
    requested_by: requestedBy || config.workflow.defaultAssignee,
    status: 'open',
    expires_at: new Date(Date.now() + config.secureDocuments.requestTtlMs).toISOString(),
    nda_required: true,
    nda_accepted_at: null,
    last_uploaded_at: null,
    note,
    requested_documents: normalizeRequestedDocuments(requestedDocuments),
    revoked_at: null,
    closed_at: null,
    upload_batch_count: 0,
  };

  await commitCrmActivityMutation({
    storage,
    operation: 'insert_secure_upload_request',
    payload: { request: requestRecord },
    activity: {
      submissionId: submission.id,
      eventType: 'documents.requested',
      summary: 'Secure document upload request created.',
      actor: requestRecord.requested_by,
      role: 'admin',
      metadata: { requestId: requestRecord.id, expiresAt: requestRecord.expires_at, emailRequested: sendEmail },
    },
  });

  const accessToken = buildAccessToken({
    type: 'secure-upload',
    requestId: requestRecord.id,
    submissionId: submission.id,
    exp: Date.now() + config.secureDocuments.requestTtlMs,
  });

  const publicOrigin = getRequestOrigin(request, config.server.origin);
  const uploadUrl = `${publicOrigin}/secure-documents?token=${encodeURIComponent(accessToken)}`;
  let emailResult = { status: 'skipped', error: '' };

  if (sendEmail) {
    emailResult = await sendSecureUploadInviteEmail({
      to: submission.email,
      contactName: submission.name,
      uploadUrl,
      expiresAt: requestRecord.expires_at,
      submission,
      note,
    });
  }

  return {
    ok: true,
    emailResult,
    request: requestRecord,
    uploadUrl,
  };
}

export async function getSecureUploadContext(token, { recoverStale = false } = {}) {
  const storage = getStorage();
  const payload = verifyAccessToken(token);

  if (!payload || payload.type !== 'secure-upload') {
    return { ok: false, error: 'This secure document link is invalid or has expired.' };
  }

  let requestRecord = await storage.getSecureUploadRequest(payload.requestId);

  if (!requestRecord) {
    return { ok: false, error: 'This secure document request could not be found.' };
  }

  if (new Date(requestRecord.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'This secure document request has expired.' };
  }

  if (requestRecord.revoked_at || requestRecord.status === 'revoked') {
    return { ok: false, error: 'This secure document link has been revoked. Please contact Uckele Group if you need a new request.' };
  }

  if (recoverStale) {
    requestRecord = await recoverStaleUploadRequest(storage, requestRecord);
  }

  if (!requestRecord || requestRecord.revoked_at || requestRecord.status === 'revoked') {
    return { ok: false, error: 'This secure document link has been revoked. Please contact Uckele Group if you need a new request.' };
  }

  const submission = await storage.getSubmission(requestRecord.submission_id);
  const documents = await storage.listSecureDocumentsByRequest(requestRecord.id);
  requestRecord.requested_checklist = buildRequestedDocumentChecklist(requestRecord, documents);

  return {
    ok: true,
    request: requestRecord,
    submission,
    documents,
  };
}

export async function getSecureDocumentDownload(documentId, storage = getStorage()) {
  const config = getConfig();
  const id = String(documentId || '').trim();

  if (!id || !storage.getSecureDocument) {
    return {
      ok: false,
      status: 404,
      error: 'Secure document was not found.',
    };
  }

  const document = await storage.getSecureDocument(id);

  if (!document) {
    return {
      ok: false,
      status: 404,
      error: 'Secure document was not found.',
    };
  }

  const filePath = resolveSecureStoragePath(document.storage_path, config.secureDocuments.storageDir);

  if (!filePath) {
    console.warn(`[secure-documents] blocked download outside storage directory for document ${id}`);
    return {
      ok: false,
      status: 500,
      error: 'Secure document file path is invalid.',
    };
  }

  try {
    const stat = await fs.stat(filePath);

    if (!stat.isFile()) {
      return {
        ok: false,
        status: 404,
        error: 'Secure document file is unavailable.',
      };
    }

    return {
      ok: true,
      document,
      filePath,
      sizeBytes: stat.size,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[secure-documents] failed to access document file ${id}: ${error.message}`);
    }

    return {
      ok: false,
      status: 404,
      error: 'Secure document file is unavailable.',
    };
  }
}

export async function uploadSecureDocuments({ token, ndaAccepted, note = '', documents, completeRequest = false, request }) {
  const config = getConfig();
  const storage = getStorage();
  const rateLimitResult = await enforceSecureUploadAttemptRateLimit({ token, request });

  if (!rateLimitResult.ok) {
    return rateLimitResult;
  }

  const context = await getSecureUploadContext(token);

  if (!context.ok) {
    return context;
  }

  context.request = await recoverStaleUploadRequest(storage, context.request);

  if (!['awaiting-documents', 'open', 'partially-received'].includes(context.request.status)) {
    return {
      ok: false,
      error: context.request.status === 'uploading'
        ? 'Documents are already being uploaded for this request. Please wait a few minutes before trying again.'
        : 'This secure document request is closed. Please ask for a new upload link before sending more files.',
    };
  }

  if (!ndaAccepted) {
    return { ok: false, error: 'Please confirm the confidentiality acknowledgement before uploading.' };
  }

  if (!Array.isArray(documents) || documents.length === 0) {
    return { ok: false, error: 'Please choose at least one file to upload.' };
  }

  if (documents.length > maxDocumentsPerUpload) {
    return { ok: false, error: `Please upload no more than ${maxDocumentsPerUpload} files at a time.` };
  }

  const preparedDocuments = documents.map((document) => prepareDocumentPayload(document, config));
  const validationErrors = preparedDocuments.flatMap((document) => document.errors);

  if (validationErrors.length > 0) {
    return { ok: false, error: validationErrors[0] };
  }

  const existingDocumentCount = context.documents.length;
  const incomingDocumentCount = documents.length;

  if (existingDocumentCount + incomingDocumentCount > maxDocumentsPerRequest) {
    return {
      ok: false,
      error: `This request can receive no more than ${maxDocumentsPerRequest} total files. Contact Uckele Group if the request needs to be expanded.`,
    };
  }

  const incomingBytes = preparedDocuments.reduce((sum, document) => sum + document.buffer.byteLength, 0);
  const maxTotalBytes = Math.min(
    config.secureDocuments.maxUploadBytes * maxDocumentsPerRequest,
    config.secureDocuments.maxTotalUploadBytes,
  );

  if (sumSecureDocumentBytes(context.documents) + incomingBytes > maxTotalBytes) {
    return {
      ok: false,
      error: `This request can receive no more than ${Math.round(maxTotalBytes / (1024 * 1024))} MB total. Please ask for a new secure upload link before sending more files.`,
    };
  }

  const uploadStartedAt = new Date().toISOString();
  const claimedRequest = storage.claimSecureUploadRequest
    ? await storage.claimSecureUploadRequest(context.request.id, {
        updated_at: uploadStartedAt,
        status: 'uploading',
        nda_accepted_at: context.request.nda_accepted_at || uploadStartedAt,
      }, {
        staleBefore: new Date(Date.now() - staleUploadingRequestMs).toISOString(),
      })
    : await storage.updateSecureUploadRequest(context.request.id, {
        updated_at: uploadStartedAt,
        status: 'uploading',
        nda_accepted_at: context.request.nda_accepted_at || uploadStartedAt,
      });

  if (!claimedRequest) {
    return {
      ok: false,
      error: 'Documents are already being uploaded for this request. Please refresh before trying again.',
    };
  }

  const savedDocuments = [];
  const writtenFilePaths = [];
  let updatedRequest;
  let cleanupJob = null;
  let cleanupIntentPersisted = false;
  let cleanupIntentActive = false;

  try {
    const requestDirectory = path.join(config.secureDocuments.storageDir, context.request.id);
    await fs.mkdir(requestDirectory, { recursive: true });

    for (const preparedDocument of preparedDocuments) {
      const { document, buffer, mimeType } = preparedDocument;
      const documentId = randomUUID();
      const safeOriginalName = sanitizeFileName(document.name);
      const safeStoredName = `${documentId}-${safeOriginalName}`;
      const storagePath = path.join(requestDirectory, safeStoredName);

      const record = {
        id: documentId,
        request_id: context.request.id,
        submission_id: context.submission.id,
        created_at: new Date().toISOString(),
        document_type: normalizeDocumentType(document.documentType),
        file_name: safeStoredName,
        original_name: safeOriginalName,
        mime_type: mimeType,
        size_bytes: buffer.byteLength,
        storage_path: storagePath,
        uploaded_by_email: claimedRequest.email,
        note: String(note || '').trim(),
        nda_accepted_at: new Date().toISOString(),
      };

      savedDocuments.push(record);
    }

    const cleanupId = randomUUID();
    const cleanupCreatedAt = new Date().toISOString();
    const cleanupTrashDirectory = path.join(config.secureDocuments.storageDir, '.trash', cleanupId);
    cleanupJob = {
      id: cleanupId,
      submission_id: context.submission.id,
      created_at: cleanupCreatedAt,
      updated_at: cleanupCreatedAt,
      completed_at: null,
      status: 'staging',
      trash_directory: cleanupTrashDirectory,
      files: savedDocuments.map((document, index) => ({
        documentId: document.id,
        originalPath: document.storage_path,
        stagedPath: path.join(cleanupTrashDirectory, `${index}-${path.basename(document.storage_path)}`),
        staged: false,
        purgeOriginalIfStagedMissing: true,
      })),
      attempt_count: 0,
      last_error: null,
      metadata: {
        reason: 'ambiguous-secure-upload-finalization',
        requestId: context.request.id,
        documentIds: savedDocuments.map((document) => document.id),
        resetStatus: context.documents.length > 0 ? 'partially-received' : 'open',
        reconcileAfter: new Date(Date.parse(cleanupCreatedAt) + secureDocumentCleanupSettlementMs).toISOString(),
        writeAheadIntent: true,
      },
    };
    await persistSecureDocumentCleanupJob(storage, cleanupJob);
    cleanupIntentPersisted = true;
    registerSecureDocumentCleanupIntent(cleanupJob.id);
    cleanupIntentActive = true;

    for (const [index, preparedDocument] of preparedDocuments.entries()) {
      await fs.writeFile(savedDocuments[index].storage_path, preparedDocument.buffer);
      writtenFilePaths.push(savedDocuments[index].storage_path);
    }

    const finalizedAt = new Date().toISOString();
    const expectedBatchCount = Number(context.request.upload_batch_count || 0) + 1;
    const finalizationPayload = {
      requestId: context.request.id,
      documents: savedDocuments,
      values: {
        updated_at: finalizedAt,
        status: completeRequest ? 'completed' : 'partially-received',
        nda_accepted_at: claimedRequest.nda_accepted_at || finalizedAt,
        last_uploaded_at: finalizedAt,
        closed_at: completeRequest ? finalizedAt : null,
        upload_batch_count: expectedBatchCount,
      },
    };
    const activity = buildCrmActivityEvent({
      submissionId: context.submission.id,
      eventType: 'documents.uploaded',
      summary: `${savedDocuments.length} secure document${savedDocuments.length === 1 ? '' : 's'} uploaded.`,
      actor: claimedRequest.email,
      role: 'contact',
      metadata: {
        requestId: context.request.id,
        documents: savedDocuments.map((document) => ({
          id: document.id,
          name: document.original_name,
          category: document.document_type,
          sizeBytes: document.size_bytes,
        })),
      },
    });
    const commitFinalization = () => commitCrmActivityMutation({
      storage,
      operation: 'finalize_secure_document_upload',
      payload: finalizationPayload,
      activity,
    });
    const resolution = await commitWithSingleRetry(commitFinalization, {
      retryAmbiguousResponse: storageCanLoseCommitResponses(storage),
    });
    const mutation = resolution.mutation;

    if (mutation?.applied && mutation.record) {
      updatedRequest = mutation.record;
    } else if (!mutation && !resolution.ambiguous) {
      throw resolution.errors.at(-1);
    } else if (resolution.errors.length > 0 || mutation) {
      const durableState = await inspectUploadFinalization(
        storage,
        context.request.id,
        savedDocuments,
        expectedBatchCount,
      );

      if (durableState.committed) {
        updatedRequest = durableState.request;
      } else if (resolution.ambiguous || (!durableState.known && resolution.errors.length > 0)) {
        const lastError = resolution.errors.at(-1) || durableState.error;
        await preserveAmbiguousUploadFiles({
          storage,
          cleanupJob,
          error: lastError,
        });
        const error = new Error('Secure upload finalization could not be confirmed. Files were retained for automatic reconciliation.');
        error.code = 'SECURE_UPLOAD_FINALIZATION_AMBIGUOUS';
        error.preserveSecureFiles = true;
        throw error;
      }
    }

    if (!updatedRequest) {
      const error = new Error('Secure upload request changed while the files were being processed. No files were accepted.');
      error.code = 'SECURE_UPLOAD_NOT_FINALIZED';
      throw error;
    }
  } catch (error) {
    if (!error.preserveSecureFiles) {
      const cleanupFailures = await cleanupPartialUploadAttempt({
        storage,
        requestId: context.request.id,
        savedDocuments,
        writtenFilePaths,
        resetStatus: context.documents.length > 0 ? 'partially-received' : 'open',
      });
      if (cleanupIntentPersisted && cleanupJob) {
        const completedAt = new Date().toISOString();
        const cleanupState = await updateSecureDocumentCleanupJobState(storage, cleanupJob, {
          updated_at: new Date().toISOString(),
          completed_at: cleanupFailures.length === 0 ? completedAt : null,
          status: cleanupFailures.length === 0 ? 'completed' : 'cleanup-pending',
          attempt_count: 1,
          last_error: cleanupFailures.length === 0
            ? null
            : cleanupFailures.map((failure) => failure.message || String(failure)).join('; ').slice(0, 2000),
        }).catch((persistenceError) => {
          console.error(`[secure-documents] upload cleanup intent ${cleanupJob.id} could not be updated: ${persistenceError.message}`);
          return null;
        });
        if (cleanupFailures.length === 0 && cleanupState && !cleanupState.persistenceError) {
          await fs.rm(cleanupJob.trash_directory, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    if (cleanupIntentActive && cleanupJob) {
      unregisterSecureDocumentCleanupIntent(cleanupJob.id);
      cleanupIntentActive = false;
    }

    throw error;
  }

  if (cleanupIntentActive && cleanupJob) {
    unregisterSecureDocumentCleanupIntent(cleanupJob.id);
    cleanupIntentActive = false;
  }

  if (cleanupJob) {
    const completedAt = new Date().toISOString();
    try {
      const completion = await updateSecureDocumentCleanupJobState(storage, cleanupJob, {
        updated_at: completedAt,
        completed_at: completedAt,
        status: 'completed',
        attempt_count: 1,
        last_error: null,
      });
      if (!completion.persistenceError) {
        await fs.rm(cleanupJob.trash_directory, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(`[secure-documents] completed upload cleanup intent ${cleanupJob.id} remains queued: ${error.message}`);
    }
  }

  await sendDocumentUploadNotificationEmail({
    submission: context.submission,
    request: updatedRequest,
    documents: savedDocuments,
  }).catch((error) => {
    console.warn(`[secure-documents] upload notification failed after documents were committed: ${error.message}`);
  });

  let allDocuments;

  try {
    allDocuments = await storage.listSecureDocumentsByRequest(context.request.id);
  } catch (error) {
    console.warn(`[secure-documents] document list refresh failed after upload commit: ${error.message}`);
    allDocuments = [...context.documents, ...savedDocuments];
  }
  updatedRequest.requested_checklist = buildRequestedDocumentChecklist(updatedRequest, allDocuments);

  return {
    ok: true,
    request: updatedRequest,
    submission: context.submission,
    documents: allDocuments,
  };
}

export async function revokeSecureUploadRequest({ requestId, revokedBy = 'admin', storage = getStorage() } = {}) {
  const requestRecord = await storage.getSecureUploadRequest(String(requestId || '').trim());
  if (!requestRecord) return { ok: false, status: 404, error: 'Secure upload request was not found.' };
  if (requestRecord.status === 'revoked') return { ok: true, request: requestRecord };
  const now = new Date().toISOString();
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'update_secure_upload_request',
    payload: {
      id: requestRecord.id,
      values: { updated_at: now, status: 'revoked', revoked_at: now, closed_at: now },
      expectedStatuses: [requestRecord.status],
    },
    activity: {
      submissionId: requestRecord.submission_id,
      eventType: 'documents.link-revoked',
      summary: 'Secure document upload link revoked.',
      actor: revokedBy,
      role: 'admin',
      metadata: { requestId: requestRecord.id },
    },
  });
  if (!mutation.applied && (mutation.record?.status === 'revoked' || mutation.record?.revoked_at)) {
    return { ok: true, request: mutation.record };
  }
  return mutation.applied
    ? { ok: true, request: mutation.record }
    : { ok: false, status: 409, error: 'Secure upload request changed before it could be revoked.' };
}

export async function deleteSecureDocument({ documentId, deletedBy = 'admin', storage = getStorage() } = {}) {
  const config = getConfig();
  const document = await storage.getSecureDocument(String(documentId || '').trim());
  if (!document) return { ok: false, status: 404, error: 'Secure document was not found.' };
  const sourcePath = resolveSecureStoragePath(document.storage_path, config.secureDocuments.storageDir);
  if (!sourcePath) return { ok: false, status: 500, error: 'Secure document path is invalid.' };
  const operationId = randomUUID();
  const trashDirectory = path.join(config.secureDocuments.storageDir, '.trash', operationId);
  const stagedPath = path.join(trashDirectory, path.basename(sourcePath));
  const intentCreatedAt = new Date().toISOString();
  let cleanupJob = {
    id: operationId,
    submission_id: document.submission_id,
    created_at: intentCreatedAt,
    updated_at: intentCreatedAt,
    completed_at: null,
    status: 'staging',
    trash_directory: trashDirectory,
    files: [{ documentId: document.id, originalPath: sourcePath, stagedPath, staged: false }],
    attempt_count: 0,
    last_error: null,
    metadata: {
      reason: 'individual-document-deletion',
      documentId: document.id,
      ambiguousCommit: false,
      reconcileAfter: new Date(Date.parse(intentCreatedAt) + secureDocumentCleanupSettlementMs).toISOString(),
      writeAheadIntent: true,
    },
  };
  await persistSecureDocumentCleanupJob(storage, cleanupJob);
  registerSecureDocumentCleanupIntent(cleanupJob.id);

  const updateCleanupState = async (values) => {
    const result = await updateSecureDocumentCleanupJobState(storage, cleanupJob, values);
    cleanupJob = { ...cleanupJob, ...values };
    return result;
  };
  let fileWasStaged = false;
  try {
    await fs.mkdir(trashDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    unregisterSecureDocumentCleanupIntent(cleanupJob.id);
    throw error;
  }

  try {
    await fs.rename(sourcePath, stagedPath);
    fileWasStaged = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await fs.rm(trashDirectory, { recursive: true, force: true }).catch(() => {});
      await updateCleanupState({
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        status: 'restored',
        attempt_count: 1,
        last_error: null,
      }).catch(() => {});
      unregisterSecureDocumentCleanupIntent(cleanupJob.id);
      throw error;
    }
  }
  cleanupJob.files = cleanupJob.files.map((file) => ({ ...file, staged: fileWasStaged }));

  const activity = buildCrmActivityEvent({
    submissionId: document.submission_id,
    eventType: 'documents.deleted',
    summary: `Secure document deleted: ${document.original_name}.`,
    actor: deletedBy,
    role: 'admin',
    metadata: { documentId: document.id, category: document.document_type },
  });
  const commitDeletion = () => commitCrmActivityMutation({
    storage,
    operation: 'delete_secure_document',
    payload: { id: document.id },
    activity,
  });
  const resolution = await commitWithSingleRetry(commitDeletion, {
    retryAmbiguousResponse: storageCanLoseCommitResponses(storage),
  });
  unregisterSecureDocumentCleanupIntent(cleanupJob.id);
  let deletionCommitted = Boolean(resolution.mutation?.applied);

  if (!deletionCommitted) {
    let currentDocument;

    try {
      currentDocument = await storage.getSecureDocument(document.id);
    } catch (inspectionError) {
      const now = new Date().toISOString();
      await updateCleanupState({
        updated_at: now,
        status: 'reconciliation-pending',
        files: cleanupJob.files,
        last_error: String(inspectionError.message || inspectionError).slice(0, 2000),
        metadata: { ...cleanupJob.metadata, ambiguousCommit: true },
      });
      const error = new Error('Secure document deletion could not be confirmed. The file was retained for automatic reconciliation.');
      error.code = 'SECURE_DOCUMENT_DELETION_AMBIGUOUS';
      throw error;
    }

    deletionCommitted = !currentDocument;

    if (!deletionCommitted) {
      if (resolution.ambiguous) {
        const now = new Date().toISOString();
        await updateCleanupState({
          updated_at: now,
          status: 'reconciliation-pending',
          files: cleanupJob.files,
          last_error: String(resolution.errors.at(-1)?.message || 'Secure document deletion response was ambiguous.').slice(0, 2000),
          metadata: { ...cleanupJob.metadata, ambiguousCommit: true },
        });
        const error = new Error('Secure document deletion could not be confirmed. The file was retained for automatic reconciliation.');
        error.code = 'SECURE_DOCUMENT_DELETION_AMBIGUOUS';
        throw error;
      }

      const restoreError = fileWasStaged
        ? await fs.rename(stagedPath, sourcePath).catch((error) => error)
        : Object.assign(new Error('The secure document file was missing before deletion.'), { code: 'ENOENT' });

      if (restoreError) {
        const now = new Date().toISOString();
        await updateCleanupState({
          updated_at: now,
          status: 'restore-failed',
          files: cleanupJob.files,
          attempt_count: 1,
          last_error: String(restoreError.message || restoreError).slice(0, 2000),
          metadata: { ...cleanupJob.metadata, ambiguousCommit: false, writeAheadIntent: false },
        });
      } else {
        await fs.rm(trashDirectory, { recursive: true, force: true }).catch(() => {});
        const completedAt = new Date().toISOString();
        await updateCleanupState({
          updated_at: completedAt,
          completed_at: completedAt,
          status: 'restored',
          files: cleanupJob.files,
          attempt_count: 1,
          last_error: null,
        }).catch(() => {});
      }

      throw resolution.errors.at(-1) || new Error('Secure document changed before it could be deleted.');
    }
  }

  if (!deletionCommitted) {
    throw new Error('Secure document deletion could not be confirmed.');
  }

  try {
    await fs.rm(trashDirectory, { recursive: true, force: true });
  } catch (error) {
    const now = new Date().toISOString();
    await updateCleanupState({
      updated_at: now,
      status: 'cleanup-failed',
      files: cleanupJob.files,
      attempt_count: 1,
      last_error: error.message,
      metadata: { ...cleanupJob.metadata, ambiguousCommit: false, writeAheadIntent: false },
    });
    return { ok: true, document };
  }

  const completedAt = new Date().toISOString();
  await updateCleanupState({
    updated_at: completedAt,
    completed_at: completedAt,
    status: 'completed',
    files: cleanupJob.files,
    attempt_count: 1,
    last_error: null,
    metadata: { ...cleanupJob.metadata, ambiguousCommit: false, writeAheadIntent: false },
  }).catch((error) => {
    console.error(`[secure-documents] completed deletion intent ${cleanupJob.id} remains queued: ${error.message}`);
  });

  return { ok: true, document };
}
