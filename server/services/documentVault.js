import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getRequestOrigin } from '../utils/http.js';
import { signPayload, verifySignedPayload } from '../utils/security.js';
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
  const allowed = [
    'website-assets',
    'brand-assets',
    'domain-dns',
    'cms-access',
    'analytics',
    'marketing-materials',
    'contracts',
    'other',
  ];
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

function validateDocumentPayload(document = {}, config) {
  document = document || {};
  const errors = [];
  const decodedBytes = estimateBase64DecodedBytes(document.contentBase64);

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

  if (document.mimeType && !allowedMimeTypes.has(document.mimeType)) {
    errors.push(`${document.name || 'A file'} uses a file type that is not allowed.`);
  }

  return errors;
}

function isPathInsideDirectory(filePath, directoryPath) {
  const relativePath = path.relative(directoryPath, filePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

export async function getSecureDocumentDownload(documentId) {
  const config = getConfig();
  const storage = getStorage();

  if (!storage.getSecureDocument) {
    return { ok: false, status: 500, error: 'Secure document lookup is not available.' };
  }

  const document = await storage.getSecureDocument(documentId);

  if (!document) {
    return { ok: false, status: 404, error: 'Secure document not found.' };
  }

  const storageRoot = path.resolve(config.secureDocuments.storageDir);
  const filePath = path.resolve(document.storage_path || '');

  if (!isPathInsideDirectory(filePath, storageRoot)) {
    return { ok: false, status: 400, error: 'Secure document path is invalid.' };
  }

  try {
    const stat = await fs.stat(filePath);

    if (!stat.isFile()) {
      return { ok: false, status: 404, error: 'Secure document file is not available.' };
    }
  } catch {
    return { ok: false, status: 404, error: 'Secure document file is not available.' };
  }

  return {
    ok: true,
    document,
    filePath,
  };
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

export async function uploadSecureDocuments({ token, ndaAccepted, note = '', documents }) {
  const config = getConfig();
  const storage = getStorage();
  const context = await getSecureUploadContext(token);

  if (!context.ok) {
    return context;
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

  const validationErrors = documents.flatMap((document) => validateDocumentPayload(document, config));

  if (validationErrors.length > 0) {
    return { ok: false, error: validationErrors[0] };
  }

  const requestDirectory = path.join(config.secureDocuments.storageDir, context.request.id);
  await fs.mkdir(requestDirectory, { recursive: true });

  const savedDocuments = [];

  for (const document of documents) {
    const buffer = Buffer.from(normalizeBase64(document.contentBase64), 'base64');

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
      mime_type: String(document.mimeType || 'application/octet-stream'),
      size_bytes: buffer.byteLength,
      storage_path: storagePath,
      uploaded_by_email: context.request.email,
      note: String(note || '').trim(),
      nda_accepted_at: new Date().toISOString(),
    };

    await storage.insertSecureDocument(record);
    savedDocuments.push(record);
  }

  const updatedRequest = await storage.updateSecureUploadRequest(context.request.id, {
    updated_at: new Date().toISOString(),
    status: 'documents-received',
    nda_accepted_at: context.request.nda_accepted_at || new Date().toISOString(),
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
