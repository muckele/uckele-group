import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getClientIp, getRequestOrigin } from '../utils/http.js';
import { hashIp, sha256, signPayload, verifySignedPayload } from '../utils/security.js';
import { sendDocumentUploadNotificationEmail, sendSecureUploadInviteEmail } from './delivery.js';

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
const maxDocumentsPerRequest = maxDocumentsPerUpload;
const secureUploadRateLimitEvents = new Map();

function sanitizeFileName(fileName) {
  const cleaned = String(fileName || 'document')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned || 'document';
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
  const allowed = ['teaser', 'cim', 'financials', 'tax-returns', 'contracts', 'customer-summary', 'other'];
  return allowed.includes(normalized) ? normalized : 'other';
}

function normalizeBase64(value = '') {
  return String(value || '')
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');
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
  const mimeType = String(document.mimeType || '').trim().toLowerCase();
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

export async function createSecureUploadRequest({ submissionId, requestedBy, note = '', sendEmail = true, request }) {
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
    status: 'awaiting-documents',
    expires_at: new Date(Date.now() + config.secureDocuments.requestTtlMs).toISOString(),
    nda_required: true,
    nda_accepted_at: null,
    last_uploaded_at: null,
    note,
  };

  await storage.insertSecureUploadRequest(requestRecord);

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

export async function getSecureUploadContext(token) {
  const storage = getStorage();
  const payload = verifyAccessToken(token);

  if (!payload || payload.type !== 'secure-upload') {
    return { ok: false, error: 'This secure document link is invalid or has expired.' };
  }

  const requestRecord = await storage.getSecureUploadRequest(payload.requestId);

  if (!requestRecord) {
    return { ok: false, error: 'This secure document request could not be found.' };
  }

  if (new Date(requestRecord.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'This secure document request has expired.' };
  }

  const submission = await storage.getSubmission(requestRecord.submission_id);
  const documents = await storage.listSecureDocumentsByRequest(requestRecord.id);

  return {
    ok: true,
    request: requestRecord,
    submission,
    documents,
  };
}

export async function uploadSecureDocuments({ token, ndaAccepted, note = '', documents, request }) {
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

  if (context.request.status !== 'awaiting-documents') {
    return {
      ok: false,
      error: 'Documents have already been received for this request. Please ask for a new secure upload link before sending more files.',
    };
  }

  if (!ndaAccepted) {
    return { ok: false, error: 'Please confirm the NDA and confidentiality acknowledgement before uploading.' };
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
      error: `This request can receive no more than ${maxDocumentsPerRequest} total files. Please ask for a new secure upload link before sending more files.`,
    };
  }

  const incomingBytes = preparedDocuments.reduce((sum, document) => sum + document.buffer.byteLength, 0);
  const maxTotalBytes = config.secureDocuments.maxUploadBytes * maxDocumentsPerRequest;

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

  const requestDirectory = path.join(config.secureDocuments.storageDir, context.request.id);
  await fs.mkdir(requestDirectory, { recursive: true });

  const savedDocuments = [];

  for (const preparedDocument of preparedDocuments) {
    const { document, buffer, mimeType } = preparedDocument;
    const documentId = randomUUID();
    const safeOriginalName = sanitizeFileName(document.name);
    const safeStoredName = `${documentId}-${safeOriginalName}`;
    const storagePath = path.join(requestDirectory, safeStoredName);
    await fs.writeFile(storagePath, buffer);

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

    await storage.insertSecureDocument(record);
    savedDocuments.push(record);
  }

  const updatedRequest = await storage.updateSecureUploadRequest(context.request.id, {
    updated_at: new Date().toISOString(),
    status: 'documents-received',
    nda_accepted_at: claimedRequest.nda_accepted_at || new Date().toISOString(),
    last_uploaded_at: new Date().toISOString(),
  });

  await sendDocumentUploadNotificationEmail({
    submission: context.submission,
    request: updatedRequest,
    documents: savedDocuments,
  });

  const allDocuments = await storage.listSecureDocumentsByRequest(context.request.id);

  return {
    ok: true,
    request: updatedRequest,
    submission: context.submission,
    documents: allDocuments,
  };
}
