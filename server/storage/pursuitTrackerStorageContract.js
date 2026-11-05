// Input validation, the request digest and row shapes shared by the SQLite and Supabase
// adapters for the Pursued deals tracker's owner events (spec 2026-11-04 §4.3). The event
// table has no free-text column: every field here is an id, a fixed value or an instant.
import { sha256, stableCanonicalJson } from '../utils/security.js';

/** Stage ids, in stage order. Code keeps the CIM names; the UI says "SIM". */
export const PURSUIT_STAGES = Object.freeze(['cim-requested', 'broker-replied', 'nda-sent', 'cim-received',
  'financial-review', 'loi-candidate', 'passed']);
export const PURSUIT_EVENT_KINDS = Object.freeze(['reply-type', 'stage-move', 'sim-intake', 'acknowledge']);
export const PURSUIT_REPLY_TYPES = Object.freeze(['nda-requested', 'sim-received', 'not-available', 'question',
  'other']);
export const PURSUIT_TRACKER_POLICY_VERSION = 'pursuit-tracker-v1';
/** The predecessor of an opportunity's first event. */
export const PURSUIT_GENESIS = 'genesis';
export const PURSUIT_STAGE_REQUEST_DIGEST_PREFIX = 'pursuit-stage-request:v1';
/** The `conflict` values of `recordPursuitStageEvent`; null when the event was applied or replayed. */
export const PURSUIT_STAGE_EVENT_CONFLICTS = Object.freeze([null, 'idempotency_conflict', 'pursuit_stage_changed',
  'not_pursued', 'opportunity_not_active', 'unknown_reply']);

/** The `conflict` values of `recordPursuitSimIntake`: the event's, plus the campaign submission's. */
export const PURSUIT_SIM_INTAKE_CONFLICTS = Object.freeze([...PURSUIT_STAGE_EVENT_CONFLICTS, 'no_crm_record',
  'crm_superseded']);
/** What the synthetic upload request of a SIM intake asked for. */
export const PURSUIT_SIM_REQUESTED_DOCUMENTS = Object.freeze([Object.freeze({ category: 'cim', label: 'CIM',
  required: true })]);

/** The most opportunities one `listPursuitBundles` call may name. */
export const PURSUIT_BUNDLE_MAX_IDS = 200;
/**
 * The `secure_documents.document_type` values that count as a CIM (the set of
 * server/services/acquisitionMaterials.js; a test pins them equal). The Postgres RPC spells
 * the same list.
 */
export const PURSUIT_CIM_DOCUMENT_TYPES = Object.freeze(['cim', 'teaser', 'prospectus', 'offering_memorandum',
  'offering_materials', 'data_room', 'broker_materials']);

const idPattern = /^[A-Za-z0-9_-]{1,240}$/;
// The client idempotency key format of dealHunterTriage.js (owner decisions).
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;

function invalid(name) {
  return new TypeError(`Invalid ${name}`);
}

function uuid(value, name) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid(name);
  return value;
}

function id(value, name) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw invalid(name);
  return value;
}

function optionalId(value, name) {
  return value === null || value === undefined ? null : id(value, name);
}

function oneOf(value, values, name) {
  if (!values.includes(value)) throw invalid(name);
  return value;
}

function optionalInstant(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

// CRM metadata is free-form JSON: an instant that does not parse is not an instant.
function lenientInstant(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * The request digest an idempotency key is bound to: sha256 over the prefix and the fields in
 * this order. An upload also binds the file's byte length and sha256.
 */
export function pursuitStageRequestDigest({ opportunityId, kind, replyType, stage, expectedPreviousEventId,
  acknowledgedReplyId, actor, idempotencyKey, fileBytes = null, fileSha256 = null }) {
  return sha256(stableCanonicalJson([PURSUIT_STAGE_REQUEST_DIGEST_PREFIX, opportunityId, kind,
    replyType ?? null, stage ?? null, expectedPreviousEventId ?? null, acknowledgedReplyId ?? null, actor,
    idempotencyKey, fileBytes, fileSha256]));
}

/** A normalized copy of an owner event command, or a TypeError naming the bad field. */
export function validatePursuitStageEventCommand(command = {}) {
  if (!command || typeof command !== 'object') throw invalid('command');
  const kind = oneOf(command.kind, PURSUIT_EVENT_KINDS, 'kind');
  const replyType = command.replyType ?? null;
  if (kind === 'reply-type' ? !PURSUIT_REPLY_TYPES.includes(replyType) : replyType !== null) {
    throw invalid('replyType');
  }
  const fromStage = oneOf(command.fromStage, PURSUIT_STAGES, 'fromStage');
  const stage = oneOf(command.stage, PURSUIT_STAGES, 'stage');
  if (kind === 'acknowledge' && stage !== fromStage) throw invalid('stage');
  const acknowledgedReplyId = optionalId(command.acknowledgedReplyId, 'acknowledgedReplyId');
  if (kind === 'acknowledge' && acknowledgedReplyId === null) throw invalid('acknowledgedReplyId');
  const secureDocumentId = optionalId(command.secureDocumentId, 'secureDocumentId');
  if ((kind === 'sim-intake') !== (secureDocumentId !== null)) throw invalid('secureDocumentId');
  const { requestDigest, actor, now } = command;
  if (typeof requestDigest !== 'string' || !digestPattern.test(requestDigest)) throw invalid('requestDigest');
  if (typeof actor !== 'string' || actor.length < 1 || actor.length > 200 || actor.trim() !== actor) {
    throw invalid('actor');
  }
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw invalid('now');
  return {
    id: uuid(command.id, 'id'),
    idempotencyKey: uuid(command.idempotencyKey, 'idempotencyKey'),
    requestDigest,
    opportunityId: id(command.opportunityId, 'opportunityId'),
    expectedPreviousEventId: optionalId(command.expectedPreviousEventId, 'expectedPreviousEventId'),
    kind,
    replyType,
    fromStage,
    stage,
    acknowledgedReplyId,
    secureDocumentId,
    actor,
    now: new Date(now).toISOString(),
  };
}

function text(value, name, max = 1000) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw invalid(name);
  return value;
}

function optionalText(value, name, max = 1000) {
  return value === null || value === undefined ? null : text(value, name, max);
}

/**
 * A normalized copy of a SIM intake command `{ event, request, document, activity }` (spec
 * 2026-11-04 §8.4), or a TypeError naming the bad field. `event` is a sim-intake owner event that
 * appends after the latest event and names the document. `request` is the synthetic completed
 * `secure_upload_requests` row, closed at the event instant; `document` is the `cim`
 * `secure_documents` row on that request; `activity` is the admin `documents.uploaded` CRM event on
 * the same submission. Rows come back with every column, so both adapters insert the same values.
 */
export function validatePursuitSimIntakeCommand(command = {}) {
  if (!command || typeof command !== 'object') throw invalid('command');
  const event = validatePursuitStageEventCommand(command.event);
  if (event.kind !== 'sim-intake') throw invalid('kind');
  if (event.expectedPreviousEventId !== null) throw invalid('expectedPreviousEventId');
  const { request: rawRequest, document: rawDocument, activity: rawActivity } = command;
  if (!rawRequest || typeof rawRequest !== 'object') throw invalid('request');
  if (!rawDocument || typeof rawDocument !== 'object') throw invalid('document');
  if (!rawActivity || typeof rawActivity !== 'object') throw invalid('activity');
  const instant = (value, name) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid(name);
    return new Date(value).toISOString();
  };
  const at = (value, name) => {
    if (instant(value, name) !== event.now) throw invalid(name);
    return event.now;
  };
  const submissionId = id(rawRequest.submission_id, 'request.submission_id');
  const request = {
    id: uuid(rawRequest.id, 'request.id'),
    submission_id: submissionId,
    created_at: instant(rawRequest.created_at, 'request.created_at'),
    updated_at: instant(rawRequest.updated_at, 'request.updated_at'),
    email: text(rawRequest.email, 'request.email', 320),
    contact_name: optionalText(rawRequest.contact_name, 'request.contact_name'),
    requested_by: optionalText(rawRequest.requested_by, 'request.requested_by'),
    status: oneOf(rawRequest.status, ['completed'], 'request.status'),
    expires_at: at(rawRequest.expires_at, 'request.expires_at'),
    nda_required: oneOf(rawRequest.nda_required, [false], 'request.nda_required'),
    nda_accepted_at: null,
    last_uploaded_at: at(rawRequest.last_uploaded_at, 'request.last_uploaded_at'),
    note: optionalText(rawRequest.note, 'request.note'),
    requested_documents: PURSUIT_SIM_REQUESTED_DOCUMENTS.map((item) => ({ ...item })),
    revoked_at: null,
    closed_at: at(rawRequest.closed_at, 'request.closed_at'),
    upload_batch_count: oneOf(rawRequest.upload_batch_count, [1], 'request.upload_batch_count'),
  };
  if (rawRequest.nda_accepted_at !== null && rawRequest.nda_accepted_at !== undefined) {
    throw invalid('request.nda_accepted_at');
  }
  if (rawRequest.revoked_at !== null && rawRequest.revoked_at !== undefined) throw invalid('request.revoked_at');
  const requested = rawRequest.requested_documents;
  if (!Array.isArray(requested) || requested.length !== 1 || !requested[0] || typeof requested[0] !== 'object'
    || Object.keys(requested[0]).length !== 3 || requested[0].category !== 'cim' || requested[0].label !== 'CIM'
    || requested[0].required !== true) {
    throw invalid('request.requested_documents');
  }
  const sizeBytes = rawDocument.size_bytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw invalid('document.size_bytes');
  const document = {
    id: uuid(rawDocument.id, 'document.id'),
    request_id: oneOf(rawDocument.request_id, [request.id], 'document.request_id'),
    submission_id: oneOf(rawDocument.submission_id, [submissionId], 'document.submission_id'),
    created_at: instant(rawDocument.created_at, 'document.created_at'),
    document_type: oneOf(rawDocument.document_type, ['cim'], 'document.document_type'),
    file_name: text(rawDocument.file_name, 'document.file_name', 300),
    original_name: text(rawDocument.original_name, 'document.original_name', 300),
    mime_type: text(rawDocument.mime_type, 'document.mime_type', 200),
    size_bytes: sizeBytes,
    storage_path: text(rawDocument.storage_path, 'document.storage_path', 4096),
    uploaded_by_email: optionalText(rawDocument.uploaded_by_email, 'document.uploaded_by_email', 320),
    note: optionalText(rawDocument.note, 'document.note'),
    nda_accepted_at: rawDocument.nda_accepted_at === null || rawDocument.nda_accepted_at === undefined ? null
      : instant(rawDocument.nda_accepted_at, 'document.nda_accepted_at'),
  };
  if (event.secureDocumentId !== document.id) throw invalid('secureDocumentId');
  const metadata = rawActivity.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid('activity.metadata');
  const activity = {
    id: uuid(rawActivity.id, 'activity.id'),
    submission_id: oneOf(rawActivity.submission_id, [submissionId], 'activity.submission_id'),
    opportunity_id: oneOf(rawActivity.opportunity_id ?? null, [null, event.opportunityId],
      'activity.opportunity_id'),
    created_at: instant(rawActivity.created_at, 'activity.created_at'),
    actor: text(rawActivity.actor, 'activity.actor', 200),
    role: oneOf(rawActivity.role, ['admin'], 'activity.role'),
    event_type: oneOf(rawActivity.event_type, ['documents.uploaded'], 'activity.event_type'),
    summary: text(rawActivity.summary, 'activity.summary'),
    metadata,
  };
  return { event, request, document, activity };
}

/** One `deal_hunter_pursuit_stage_events` row from either adapter; null stays null. */
export function normalizePursuitStageEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    opportunityId: row.opportunity_id,
    previousEventId: row.previous_event_id,
    kind: row.kind,
    replyType: row.reply_type ?? null,
    fromStage: row.from_stage,
    stage: row.stage,
    acknowledgedReplyId: row.acknowledged_reply_id ?? null,
    acknowledgedProcessedAt: optionalInstant(row.acknowledged_processed_at),
    secureDocumentId: row.secure_document_id ?? null,
    actor: row.actor,
    policyVersion: row.policy_version,
    createdAt: optionalInstant(row.created_at),
  };
}

/** A CIM-type `secure_documents` row as the tracker shows it, from either adapter; null stays null. */
export function normalizePursuitDocumentRow(row) {
  if (!row) return null;
  return { id: row.id, documentType: row.document_type, originalName: row.original_name,
    sizeBytes: Number(row.size_bytes), createdAt: optionalInstant(row.created_at) };
}

/**
 * The normalized `listPursuitBundles` command: `opportunityIds` is absent (every pursued deal) or
 * at most 200 distinct opportunity ids.
 */
export function validatePursuitBundleListCommand(command = {}) {
  if (!command || typeof command !== 'object') throw invalid('command');
  if (command.opportunityIds === undefined || command.opportunityIds === null) return { opportunityIds: null };
  const { opportunityIds } = command;
  if (!Array.isArray(opportunityIds) || opportunityIds.length > PURSUIT_BUNDLE_MAX_IDS) {
    throw invalid('opportunityIds');
  }
  return { opportunityIds: [...new Set(opportunityIds.map((value) => id(value, 'opportunityIds')))] };
}

/**
 * One pursued deal's evidence from either adapter (spec 2026-11-04 §4.4). The raw shape is
 * snake_case rows: `{ opportunity_id, name, opportunity_status, decisions, campaign, replies,
 * documents, crm, events }`; `events` are `deal_hunter_pursuit_stage_events` rows.
 */
export function normalizePursuitBundle(raw) {
  const campaign = raw.campaign ?? null;
  const crm = raw.crm ?? null;
  return {
    opportunityId: raw.opportunity_id,
    name: raw.name,
    opportunityStatus: raw.opportunity_status,
    decisions: (raw.decisions ?? []).map((row) => ({ id: row.id, action: row.action,
      createdAt: optionalInstant(row.created_at) })),
    campaign: campaign && {
      id: campaign.id,
      state: campaign.state,
      reasonCode: campaign.reason_code ?? null,
      crmSubmissionId: campaign.crm_submission_id ?? null,
      conversationId: campaign.conversation_id,
      gmailThreadId: campaign.gmail_thread_id ?? null,
    },
    replies: (raw.replies ?? []).map((row) => ({ gmailMessageId: row.gmail_message_id,
      classification: row.classification, processedAt: optionalInstant(row.processed_at),
      messageAt: optionalInstant(row.message_at) })),
    documents: (raw.documents ?? []).map(normalizePursuitDocumentRow),
    crm: crm && {
      diligenceStage: optionalString(crm.diligence_stage),
      diligenceUpdatedAt: lenientInstant(crm.diligence_updated_at),
      pipelineStage: optionalString(crm.pipeline_stage),
      pipelineUpdatedAt: lenientInstant(crm.pipeline_updated_at),
    },
    events: (raw.events ?? []).map(normalizePursuitStageEventRow),
  };
}
