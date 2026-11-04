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
    documents: (raw.documents ?? []).map((row) => ({ id: row.id, documentType: row.document_type,
      originalName: row.original_name, sizeBytes: Number(row.size_bytes),
      createdAt: optionalInstant(row.created_at) })),
    crm: crm && {
      diligenceStage: optionalString(crm.diligence_stage),
      diligenceUpdatedAt: lenientInstant(crm.diligence_updated_at),
      pipelineStage: optionalString(crm.pipeline_stage),
      pipelineUpdatedAt: lenientInstant(crm.pipeline_updated_at),
    },
    events: (raw.events ?? []).map(normalizePursuitStageEventRow),
  };
}
