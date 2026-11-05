// Client for the Pursued deals tracker routes (spec 2026-11-04 §6). Every call resolves to the
// response JSON, or throws a PursuedDealsApiError for an answer the server gave. A network failure
// is left as the fetch error so a caller can tell "the server said no" from "we never heard back".

const BASE = '/api/admin/deal-hunter';
const SIM_PDF_MIME = 'application/pdf';

export const REFRESH_COPY = 'This deal changed in another tab. We refreshed it — check the stage and try again.';
export const SAVE_FAILED_COPY = 'That change couldn\'t be saved. Try again.';
export const UPLOAD_INTERRUPTED_COPY = 'The upload was interrupted. Try again.';
export const NOT_A_PDF_NAME_COPY = 'Only PDF files can be uploaded as a SIM.';

// Spec §7.5: the owner-facing text for each upload refusal, keyed by the server's error code.
const UPLOAD_ERROR_COPY = Object.freeze({
  pdf_only: NOT_A_PDF_NAME_COPY,
  file_too_large: 'This file is larger than 25 MB.',
  not_a_pdf: 'That file isn\'t a valid PDF.',
  invalid_file_name: 'The file name couldn\'t be read. Rename it and try again.',
  upload_capacity: 'Uploads are busy. Try again in 30 seconds.',
  storage_full: 'The server is low on storage space. Tell your engineer before uploading more.',
  no_crm_record: 'This deal has no CRM record yet, so a SIM can\'t be stored.',
});

export class PursuedDealsApiError extends Error {
  constructor({ status = 0, code = null, message = SAVE_FAILED_COPY } = {}) {
    super(message);
    this.name = 'PursuedDealsApiError';
    this.status = status;
    this.code = code;
  }
}

/** The §7.5 sentence for an upload failure; a code without a line keeps the server's own sentence. */
export function uploadErrorCopy(error) {
  return UPLOAD_ERROR_COPY[error?.code] || error?.message || SAVE_FAILED_COPY;
}

async function send(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let body = null;
  try {
    body = await response.json();
  } catch { /* An unreadable body is reported by status below. */ }
  if (!response.ok || !body || body.success === false) {
    throw new PursuedDealsApiError({ status: response.status, code: body?.code ?? null,
      message: body?.error || SAVE_FAILED_COPY });
  }
  return body;
}

const postJson = (url, body) => send(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const pursuingUrl = (opportunityId, action) => `${BASE}/pursuing/${encodeURIComponent(opportunityId)}/${action}`;

/** `stage` is `all`, `needs-action` or a stage id; `all` and nothing both send no stage at all. */
export function loadPursuedDeals(stage) {
  const query = stage && stage !== 'all' ? `?stage=${encodeURIComponent(stage)}` : '';
  return send(`${BASE}/pursuing${query}`, { method: 'GET' });
}

export function recordReplyType({ opportunityId, replyType, expectedLatestEventId, acknowledgedReplyId, idempotencyKey }) {
  return postJson(pursuingUrl(opportunityId, 'reply-type'),
    { replyType, idempotencyKey, expectedLatestEventId, acknowledgedReplyId });
}

export function moveStage({ opportunityId, stage, expectedLatestEventId, acknowledgedReplyId, idempotencyKey }) {
  return postJson(pursuingUrl(opportunityId, 'stage'), { stage, idempotencyKey, expectedLatestEventId, acknowledgedReplyId });
}

export function acknowledgeReply({ opportunityId, acknowledgedReplyId, idempotencyKey }) {
  return postJson(pursuingUrl(opportunityId, 'acknowledge'), { acknowledgedReplyId, idempotencyKey });
}

/** Stops the deal's SIM follow-ups through the existing release route, with the authority the row carried. */
export function stopSimRequests({ opportunityId, campaign, idempotencyKey }) {
  return postJson(`${BASE}/triage/${encodeURIComponent(opportunityId)}/cim-release/stop`, {
    campaignId: campaign.id,
    expectedRowVersion: campaign.rowVersion,
    expectedTerminalRevision: campaign.terminalRevision,
    idempotencyKey,
    reason: 'Owner stopped SIM requests from Pursued deals.',
  });
}

const looksLikePdf = (file) => /\.pdf$/i.test(file?.name || '') || file?.type === SIM_PDF_MIME;

/**
 * The owner's SIM upload: the raw file as the body, always declared application/pdf. A name that
 * does not end in .pdf and a type that is not application/pdf is refused here, before any request.
 */
export async function uploadPursuedSim({ opportunityId, file, idempotencyKey, acknowledgedReplyId }) {
  if (!looksLikePdf(file)) {
    throw new PursuedDealsApiError({ status: 0, code: 'pdf_only', message: NOT_A_PDF_NAME_COPY });
  }
  const headers = {
    'Content-Type': SIM_PDF_MIME,
    'X-File-Name': encodeURIComponent(file.name),
    'X-Idempotency-Key': idempotencyKey,
  };
  if (acknowledgedReplyId) headers['X-Acknowledged-Reply-Id'] = acknowledgedReplyId;
  return send(pursuingUrl(opportunityId, 'sim'), { method: 'POST', headers, body: file });
}

/**
 * Idempotency keys for a component to keep in a ref, as AcquisitionInbox does for its decisions:
 * one key per (deal, signature of what is being asked). A retry of the same request reuses its key,
 * so the server replays it; a different request gets a fresh one.
 */
export function createIdempotencyKeys() {
  const keys = new Map();
  const slot = (opportunityId, signature) => `${opportunityId}:${signature}`;
  return {
    has: (opportunityId, signature) => keys.has(slot(opportunityId, signature)),
    keyFor(opportunityId, signature) {
      const id = slot(opportunityId, signature);
      if (!keys.has(id)) keys.set(id, globalThis.crypto.randomUUID());
      return keys.get(id);
    },
    forget: (opportunityId, signature) => { keys.delete(slot(opportunityId, signature)); },
  };
}
