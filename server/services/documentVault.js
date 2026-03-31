import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
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

function validateDocumentPayload(document) {
  const errors = [];

  if (!document.name || !document.contentBase64) {
    errors.push('Each uploaded file must include a name and file content.');
  }

  if (document.mimeType && !allowedMimeTypes.has(document.mimeType)) {
    errors.push(`${document.name || 'A file'} uses a file type that is not allowed.`);
  }

  return errors;
}

export async function createSecureUploadRequest({ submissionId, requestedBy, note = '', sendEmail = true }) {
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
    nda_required: 1,
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

  const uploadUrl = `${config.server.origin}/secure-documents?token=${encodeURIComponent(accessToken)}`;
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

  const validationErrors = documents.flatMap(validateDocumentPayload);

  if (validationErrors.length > 0) {
    return { ok: false, error: validationErrors[0] };
  }

  const requestDirectory = path.join(config.secureDocuments.storageDir, context.request.id);
  await fs.mkdir(requestDirectory, { recursive: true });

  const savedDocuments = [];

  for (const document of documents) {
    const buffer = Buffer.from(String(document.contentBase64 || ''), 'base64');

    if (buffer.byteLength > config.secureDocuments.maxUploadBytes) {
      return {
        ok: false,
        error: `${document.name} exceeds the maximum upload size of ${Math.round(
          config.secureDocuments.maxUploadBytes / (1024 * 1024),
        )} MB.`,
      };
    }

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
