// The owner's SIM upload on a pursued deal (spec 2026-11-04 §8): a raw PDF body streamed into the
// secure document vault, never buffered whole, then recorded with the deal's SIM intake (§8.4).
// A write-ahead cleanup job covers the file from before its first byte until the intake settles.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PURSUIT_SIM_REQUESTED_DOCUMENTS, pursuitStageRequestDigest } from '../storage/pursuitTrackerStorageContract.js';
import { buildCrmActivityEvent } from './activity.js';
import { assertCrmSubmissionWritable, CrmSubmissionSupersededError } from './crmSubmissionSupersession.js';
import { bufferMatchesMimeType, sanitizeFileName } from './documentVault.js';
import { getPursuedDealRow } from './pursuedDeals.js';
import { stageAfterReplyType } from './pursuitTracker.js';
import {
  persistSecureDocumentCleanupJob,
  registerSecureDocumentCleanupIntent,
  secureDocumentCleanupSettlementMs,
  unregisterSecureDocumentCleanupIntent,
  updateSecureDocumentCleanupJobState,
} from './secureDocumentCleanupState.js';

export const SIM_MAX_BYTES = 25 * 1024 * 1024;
/** After the upload the volume keeps at least this much free, or twice the SQLite file if larger (§8.2). */
const MIN_FREE_BYTES_AFTER_UPLOAD = 2 ** 30;
const PDF_MIME_TYPE = 'application/pdf';
const PDF_MAGIC_LENGTH = 5;
// The client idempotency key and id shapes of the tracker's other writes (pursuedDeals.js).
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,240}$/;
const isId = (value) => typeof value === 'string' && ID_SHAPE.test(value);
const TOO_LARGE = 'SIM_UPLOAD_TOO_LARGE';
const CLIENT_GONE_CODES = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE']);
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

// Owner-facing copy is spec §7.5 where it has a line; the other codes keep a plain sentence.
const REFUSALS = Object.freeze({
  pdf_only: [415, 'Only PDF files can be uploaded as a SIM.'],
  length_required: [411, 'The upload must state its exact size.'],
  file_too_large: [413, 'This file is larger than 25 MB.'],
  invalid_idempotency_key: [400, 'A valid client idempotency key is required.'],
  invalid_file_name: [400, 'The file name couldn\'t be read. Rename it and try again.'],
  invalid_acknowledged_reply_id: [400, 'A valid reply id is required.'],
  not_a_pdf: [422, 'That file isn\'t a valid PDF.'],
  upload_capacity: [503, 'Uploads are busy. Try again in 30 seconds.'],
  storage_full: [507, 'The server is low on storage space. Tell your engineer before uploading more.'],
  no_crm_record: [409, 'This deal has no CRM record yet, so a SIM can\'t be stored.'],
  crm_superseded: [409, 'This CRM record is historical and cannot be changed.'],
  not_pursued: [404, 'This deal is not in your pursued deals.'],
  opportunity_not_active: [409, 'This deal is no longer active, so a SIM cannot be stored.'],
  idempotency_conflict: [409, 'That request key was already used for a different change.'],
  unknown_reply: [422, 'That reply does not belong to this deal\'s conversation.'],
  pursuit_stage_changed: [409, 'This deal changed since you loaded it. Refresh and try again.'],
  upload_interrupted: [400, 'The upload was interrupted. Try again.'],
});

/** The `{ status, body }` refusal for `code`. */
export function simUploadRefusal(code) {
  const [status, error] = REFUSALS[code] ?? [409, 'The SIM could not be stored.'];
  return { status, body: { success: false, code, error } };
}

// The stored name: the decoded header's basename through the vault's sanitizer, ending in `.pdf`,
// at most 180 characters. Null when the header does not decode.
function simFileName(header) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(header ?? ''));
  } catch {
    return null;
  }
  const sanitized = sanitizeFileName(path.basename(decoded));
  return /\.pdf$/i.test(sanitized) ? sanitized : sanitizeFileName(`${sanitized}.pdf`);
}

/**
 * The upload's header checks, in spec §8.1 step 3 order: 415 `pdf_only`, 411 `length_required`,
 * 413 `file_too_large`, 400 `invalid_idempotency_key`, 400 `invalid_file_name`, then the optional
 * `X-Acknowledged-Reply-Id`. Reads headers only, never the body.
 */
export function checkSimUploadHeaders(headers = {}) {
  const refuse = (code) => {
    const { status, body } = simUploadRefusal(code);
    return { ok: false, status, code, error: body.error };
  };
  if (String(headers['content-type'] ?? '').trim().toLowerCase() !== PDF_MIME_TYPE) return refuse('pdf_only');
  const rawLength = String(headers['content-length'] ?? '').trim();
  if (!/^\d{1,16}$/.test(rawLength)) return refuse('length_required');
  const contentLength = Number(rawLength);
  if (contentLength > SIM_MAX_BYTES) return refuse('file_too_large');
  const idempotencyKey = headers['x-idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return refuse('invalid_idempotency_key');
  }
  const fileName = simFileName(headers['x-file-name']);
  if (fileName === null) return refuse('invalid_file_name');
  const acknowledgedReplyId = headers['x-acknowledged-reply-id'] ?? null;
  if (acknowledgedReplyId !== null && !isId(acknowledgedReplyId)) return refuse('invalid_acknowledged_reply_id');
  return { ok: true, idempotencyKey, fileName, contentLength, acknowledgedReplyId };
}

// Counts the bytes (an error past `contentLength` or 25 MiB), hashes them, and checks the PDF magic
// bytes. A body that is not a PDF is still read to its declared end, unwritten, so the client gets
// its 422 instead of a reset connection.
function createSimCheck(contentLength) {
  const limit = Math.min(contentLength, SIM_MAX_BYTES);
  const hash = createHash('sha256');
  const state = { bytes: 0, refusal: null, sha256: null };
  let head = Buffer.alloc(0);
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      state.bytes += chunk.length;
      if (state.bytes > limit) {
        callback(Object.assign(new Error('The SIM upload ran past its length.'), { code: TOO_LARGE }));
        return;
      }
      if (state.refusal) {
        callback();
        return;
      }
      if (head.length < PDF_MAGIC_LENGTH) {
        head = Buffer.concat([head, chunk.subarray(0, PDF_MAGIC_LENGTH - head.length)]);
        if (head.length === PDF_MAGIC_LENGTH && !bufferMatchesMimeType(head, PDF_MIME_TYPE)) {
          state.refusal = 'not_a_pdf';
          callback();
          return;
        }
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (!state.refusal && head.length < PDF_MAGIC_LENGTH) state.refusal = 'not_a_pdf';
      state.sha256 = hash.digest('hex');
      callback();
    },
  });
  return { stream, state };
}

// max(1 GiB, 2 × the SQLite file); no file (Supabase) counts as empty.
function diskReserveBytes(config) {
  let databaseBytes = 0;
  try {
    databaseBytes = fs.statSync(config.storage.sqlitePath).size;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return Math.max(MIN_FREE_BYTES_AFTER_UPLOAD, 2 * databaseBytes);
}

// The synthetic request's address: the CRM record's, else the owner's mailbox.
async function requestEmailFor({ storage, config, submissionId }) {
  const submission = await storage.getSubmission(submissionId);
  if (submission?.email) return String(submission.email);
  const connection = await storage.getGmailConnection();
  return connection?.email_address || config?.dealHunter?.gmail?.senderAddress || '';
}

// Settles the cleanup job as the vault does: completed once nothing is left to clean.
async function settleCleanupJob(storage, job, lastError = null) {
  const at = new Date().toISOString();
  await updateSecureDocumentCleanupJobState(storage, job, { updated_at: at, completed_at: lastError ? null : at,
    status: lastError ? 'cleanup-pending' : 'completed', attempt_count: 1, last_error: lastError,
  }).catch((error) => {
    console.error(`[pursued-deals] SIM upload cleanup job ${job.id} could not be settled: ${error.message}`);
  });
}

// Removes an upload that will not be committed, then settles its job.
async function discardUpload({ storage, job, finalPath, requestDirectory }) {
  let lastError = null;
  try {
    await fsp.unlink(finalPath);
  } catch (error) {
    if (error.code !== 'ENOENT') lastError = String(error.message).slice(0, 2000);
  }
  await fsp.rmdir(requestDirectory).catch(() => {});
  unregisterSecureDocumentCleanupIntent(job.id);
  await settleCleanupJob(storage, job, lastError);
}

/**
 * Streams one owner SIM upload into the vault and records it (spec §8.1 steps 4-6, §8.3, §8.4).
 * `headers` is the `checkSimUploadHeaders` result. Returns `{ status, body }`; `discardBody` is
 * set when the body was deliberately left unread, so the caller closes the request after
 * responding. A request stream that broke mid-body may already be gone; its result is not sent.
 */
export async function receivePursuitSimUpload({ storage, config, request, opportunityId, headers, actor, role,
  diskStats = (directory) => fsp.statfs(directory), now } = {}) {
  const { idempotencyKey, fileName, contentLength, acknowledgedReplyId } = headers;
  const instant = () => (now ? new Date(now) : new Date());
  if (!isId(opportunityId)) return simUploadRefusal('not_pursued');

  // A retry of an upload that already committed replays without reading the body.
  const prior = await storage.getPursuitStageEventByIdempotencyKey(idempotencyKey);
  if (prior) {
    if (prior.kind !== 'sim-intake' || prior.opportunityId !== opportunityId || prior.actor !== actor) {
      return simUploadRefusal('idempotency_conflict');
    }
    const row = await getPursuedDealRow({ storage, config, opportunityId, role, now: instant() });
    if (!row) return simUploadRefusal('not_pursued');
    return { status: 200, body: { success: true, replay: true, row }, discardBody: true };
  }

  // The row before the upload: its stage, its CRM record, and whether follow-ups were stoppable.
  const before = await getPursuedDealRow({ storage, config, opportunityId, role, now: instant() });
  if (!before || before.passedInDealHunter) return simUploadRefusal('not_pursued');
  if (!before.opportunityActive) return simUploadRefusal('opportunity_not_active');
  const submissionId = before.crmSubmissionId;
  if (!submissionId) return simUploadRefusal('no_crm_record');
  try {
    await assertCrmSubmissionWritable({ storage, submissionId });
  } catch (error) {
    if (error instanceof CrmSubmissionSupersededError) return simUploadRefusal('crm_superseded');
    throw error;
  }
  const email = await requestEmailFor({ storage, config, submissionId });

  const storageDir = path.resolve(config.secureDocuments.storageDir);
  await fsp.mkdir(storageDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(storageDir, 0o700);
  const disk = await diskStats(storageDir);
  if (Number(disk.bavail) * Number(disk.bsize) - contentLength < diskReserveBytes(config)) {
    return simUploadRefusal('storage_full');
  }

  // The write-ahead cleanup job, before the first byte. No requestId: the synthetic request
  // commits with its document, so the reconciler must never reset it.
  const requestId = randomUUID();
  const documentId = randomUUID();
  const requestDirectory = path.join(storageDir, requestId);
  const storedName = `${documentId}-${fileName}`;
  const finalPath = path.join(requestDirectory, storedName);
  const jobId = randomUUID();
  const trashDirectory = path.join(storageDir, '.trash', jobId);
  const jobCreatedAt = instant().toISOString();
  const job = {
    id: jobId,
    submission_id: submissionId,
    created_at: jobCreatedAt,
    updated_at: jobCreatedAt,
    completed_at: null,
    status: 'staging',
    trash_directory: trashDirectory,
    files: [{ documentId, originalPath: finalPath, stagedPath: path.join(trashDirectory, `0-${storedName}`),
      staged: false, purgeOriginalIfStagedMissing: true }],
    attempt_count: 0,
    last_error: null,
    metadata: {
      reason: 'ambiguous-secure-upload-finalization',
      documentIds: [documentId],
      reconcileAfter: new Date(Date.parse(jobCreatedAt) + secureDocumentCleanupSettlementMs).toISOString(),
      writeAheadIntent: true,
    },
  };
  await persistSecureDocumentCleanupJob(storage, job);
  registerSecureDocumentCleanupIntent(job.id);
  const discard = () => discardUpload({ storage, job, finalPath, requestDirectory });

  const check = createSimCheck(contentLength);
  let refusal = null;
  try {
    await fsp.mkdir(requestDirectory, { mode: 0o700 });
    await fsp.chmod(requestDirectory, 0o700);
    await pipeline(request, check.stream, fs.createWriteStream(finalPath, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (error.code === TOO_LARGE) refusal = 'file_too_large';
    else if (DISK_FULL_CODES.has(error.code)) refusal = 'storage_full';
    else if (request.aborted || CLIENT_GONE_CODES.has(error.code)) refusal = 'upload_interrupted';
    else {
      await discard();
      throw error;
    }
  }
  refusal ??= check.state.refusal ?? (check.state.bytes === contentLength ? null : 'length_required');
  if (refusal) {
    await discard();
    return simUploadRefusal(refusal);
  }

  const at = instant().toISOString();
  const event = { id: randomUUID(), idempotencyKey, opportunityId, expectedPreviousEventId: null, kind: 'sim-intake',
    replyType: null, fromStage: before.stage, stage: stageAfterReplyType(before.stage, 'sim-received'),
    acknowledgedReplyId, secureDocumentId: documentId, actor, now: at };
  // The digest binds the file and what the owner sent; the stage is derived, so a retry replays.
  event.requestDigest = pursuitStageRequestDigest({ ...event, stage: null, fileBytes: check.state.bytes,
    fileSha256: check.state.sha256 });
  const command = {
    event,
    request: { id: requestId, submission_id: submissionId, created_at: at, updated_at: at, email,
      contact_name: null, requested_by: actor, status: 'completed', expires_at: at, nda_required: false,
      nda_accepted_at: null, last_uploaded_at: at, note: null,
      requested_documents: PURSUIT_SIM_REQUESTED_DOCUMENTS.map((item) => ({ ...item })), revoked_at: null,
      closed_at: at, upload_batch_count: 1 },
    document: { id: documentId, request_id: requestId, submission_id: submissionId, created_at: at,
      document_type: 'cim', file_name: storedName, original_name: fileName, mime_type: PDF_MIME_TYPE,
      size_bytes: check.state.bytes, storage_path: finalPath, uploaded_by_email: null, note: null,
      nda_accepted_at: null },
    activity: buildCrmActivityEvent({ submissionId, opportunityId, eventType: 'documents.uploaded',
      summary: 'SIM uploaded by the owner.', actor, role: 'admin', createdAt: at,
      metadata: { requestId, documents: [{ id: documentId, name: fileName, category: 'cim',
        sizeBytes: check.state.bytes }] } }),
  };

  let result;
  try {
    result = await storage.recordPursuitSimIntake(command);
  } catch (error) {
    // Whether the intake committed is unknown: the job stays, and the reconciler keeps the file
    // if the document row exists and purges it if not.
    unregisterSecureDocumentCleanupIntent(job.id);
    throw error;
  }
  if (!result.applied) {
    await discard();
    if (!result.replay) return simUploadRefusal(result.conflict);
    const row = await getPursuedDealRow({ storage, config, opportunityId, role, now: instant() });
    return row ? { status: 200, body: { success: true, replay: true, row } } : simUploadRefusal('not_pursued');
  }
  unregisterSecureDocumentCleanupIntent(job.id);
  await settleCleanupJob(storage, job);

  const row = await getPursuedDealRow({ storage, config, opportunityId, role, now: instant() });
  const { document } = result;
  return {
    status: 201,
    body: {
      success: true,
      document: { id: document.id, name: document.originalName, sizeBytes: document.sizeBytes,
        uploadedAt: document.createdAt },
      row,
      stoppedFollowUps: before.release?.canStop === true,
    },
  };
}
