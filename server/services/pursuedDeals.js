// The Pursued deals tracker's read side (spec 2026-11-04 §6.1): every pursued deal folded to a
// stage, filtered, sorted and capped, each row carrying the campaign's release status. Reads
// only; nothing here sends or writes.
import { randomUUID } from 'node:crypto';
import { PURSUIT_REPLY_TYPES, PURSUIT_STAGES, pursuitStageRequestDigest } from '../storage/pursuitTrackerStorageContract.js';
import { getPursueCimReleaseReport } from './pursueCimRelease.js';
import { buildGmailThreadUrl, foldPursuitStage, STAGE_LABELS, stageAfterReplyType } from './pursuitTracker.js';

export const PURSUED_DEALS_ROW_CAP = 200;
/** Postgres release reports are several reads each, so they run this many at a time. */
export const RELEASE_REPORT_CONCURRENCY = 8;

const NEEDS_ACTION = 'needs-action';
const STAGE_FILTERS = Object.freeze(['all', NEEDS_ACTION, ...PURSUIT_STAGES]);
const stageIndex = (stage) => PURSUIT_STAGES.indexOf(stage);
const time = (instant) => Date.parse(instant);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `fn` over `items`, at most `limit` at a time; results keep the order of `items`. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The three inputs the stop route needs, from a release report.
function releaseOf(report) {
  return {
    status: report.status,
    canStop: report.actions.canStop,
    campaign: report.campaign ? { id: report.campaign.id, state: report.campaign.state,
      rowVersion: report.campaign.rowVersion, terminalRevision: report.campaign.terminalRevision } : null,
  };
}

/**
 * One tracker row. `release` is `{ status, canStop, campaign }`, or null when its report could
 * not be read. Only an admin gets `gmailThreadUrl` and `needsAction.replyId`.
 */
export function buildPursuedDealRow({ bundle, projection, release, role, gmailAddress }) {
  const isAdmin = role === 'admin';
  const { needsAction } = projection;
  const row = {
    opportunityId: bundle.opportunityId,
    name: bundle.name,
    crmSubmissionId: bundle.campaign?.crmSubmissionId ?? null,
    stage: projection.stage,
    stageLabel: STAGE_LABELS[projection.stage],
    stageSince: projection.stageSince,
    stageSource: projection.stageSource,
    lastReplyAt: projection.lastReplyAt,
    needsAction: needsAction && {
      reason: needsAction.reason,
      at: needsAction.at,
      classification: needsAction.classification,
      ...(isAdmin ? { replyId: needsAction.replyId } : {}),
    },
    simDocuments: [...bundle.documents]
      .sort((a, b) => (time(b.createdAt) - time(a.createdAt)) || compareText(a.id, b.id))
      .map((document) => ({ id: document.id, name: document.originalName, sizeBytes: document.sizeBytes,
        uploadedAt: document.createdAt })),
    latestEventId: projection.latestEventId,
    release,
    passedInDealHunter: projection.passedInDealHunter,
    opportunityActive: bundle.opportunityStatus === 'active',
  };
  if (release === null) row.releaseUnavailable = true;
  if (isAdmin) {
    row.gmailThreadUrl = buildGmailThreadUrl({ threadId: bundle.campaign?.gmailThreadId, address: gmailAddress });
  }
  return row;
}

// Needs-action rows first, oldest first; the rest by stage order, then newest stage change first.
function compareMembers(a, b) {
  const aAttention = a.projection.needsAction;
  const bAttention = b.projection.needsAction;
  if (aAttention && bAttention) {
    const order = (time(aAttention.at) - time(bAttention.at)) || compareText(aAttention.replyId, bAttention.replyId);
    if (order) return order;
  } else if (aAttention || bAttention) {
    return aAttention ? -1 : 1;
  }
  return (stageIndex(a.projection.stage) - stageIndex(b.projection.stage))
    || (time(b.projection.stageSince) - time(a.projection.stageSince))
    || compareText(a.bundle.opportunityId, b.bundle.opportunityId);
}

// The owner's mailbox for Gmail links: the active connection, else the configured sender (§7.4).
async function gmailAddressFor({ storage, config }) {
  const connection = await storage.getGmailConnection();
  return connection?.email_address || config?.dealHunter?.gmail?.senderAddress || '';
}

async function releaseFor({ storage, opportunityId, now }) {
  try {
    return releaseOf(await getPursueCimReleaseReport({ storage, opportunityId, now }));
  } catch (error) {
    // Ids and an error name only: a report can hold addresses and copy.
    console.warn('[pursued-deals] release status unavailable', { opportunityId,
      cause: String(error?.code || error?.name || 'Error').slice(0, 100) });
    return null;
  }
}

/**
 * The tracker page: `stage` is `all`, `needs-action` or a stage id. Counts cover every member,
 * whatever the filter; at most 200 rows come back, and `truncated` says more matched.
 */
export async function listPursuedDeals({ storage, config, stage = 'all', role, now = new Date() } = {}) {
  if (!STAGE_FILTERS.includes(stage)) return { ok: false, status: 400, code: 'invalid_stage' };
  const asOf = new Date(now).toISOString();
  const members = (await storage.listPursuitBundles())
    .map((bundle) => ({ bundle, projection: foldPursuitStage(bundle) }))
    .filter((member) => member.projection.member);

  const byStage = Object.fromEntries(PURSUIT_STAGES.map((id) => [id, 0]));
  let needsAction = 0;
  for (const { projection } of members) {
    byStage[projection.stage] += 1;
    if (projection.needsAction) needsAction += 1;
  }

  const matching = members
    .filter(({ projection }) => stage === 'all' || (stage === NEEDS_ACTION ? projection.needsAction !== null
      : projection.stage === stage))
    .sort(compareMembers);
  const page = matching.slice(0, PURSUED_DEALS_ROW_CAP);
  const gmailAddress = await gmailAddressFor({ storage, config });
  const rows = await mapWithConcurrency(page, RELEASE_REPORT_CONCURRENCY, async ({ bundle, projection }) =>
    buildPursuedDealRow({ bundle, projection, role, gmailAddress,
      release: await releaseFor({ storage, opportunityId: bundle.opportunityId, now: asOf }) }));
  return { ok: true, status: 200, asOf, counts: { needsAction, byStage }, rows,
    truncated: matching.length > PURSUED_DEALS_ROW_CAP };
}

/** One opportunity's row, or null when it is not a tracker member. */
export async function getPursuedDealRow({ storage, config, opportunityId, role, now = new Date() } = {}) {
  const [bundle] = await storage.listPursuitBundles({ opportunityIds: [opportunityId] });
  if (!bundle) return null;
  const projection = foldPursuitStage(bundle);
  if (!projection.member) return null;
  return buildPursuedDealRow({ bundle, projection, role,
    gmailAddress: await gmailAddressFor({ storage, config }),
    release: await releaseFor({ storage, opportunityId, now: new Date(now).toISOString() }) });
}

const OWNER_EVENT_KINDS = Object.freeze({ 'reply-type': 'reply-type', 'stage-move': 'stage-move', acknowledge: 'acknowledge' });
// The client idempotency key format of dealHunterTriage.js (owner decisions).
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Opportunity, event and Gmail message ids: the storage contract's id shape.
const ID_SHAPE = /^[A-Za-z0-9_-]{1,240}$/;
const isId = (value) => typeof value === 'string' && ID_SHAPE.test(value);

const REFUSALS = Object.freeze({
  not_pursued: [404, 'This deal is not in your pursued deals.'],
  unknown_reply: [422, 'That reply does not belong to this deal\'s conversation.'],
  pursuit_stage_changed: [409, 'This deal changed since you loaded it. Refresh and try again.'],
  idempotency_conflict: [409, 'That request key was already used for a different change.'],
  opportunity_not_active: [409, 'This deal is no longer active, so its stage cannot be changed.'],
});
const refusal = (code) => {
  const [status, error] = REFUSALS[code] ?? [409, 'The change could not be recorded.'];
  return { ok: false, status, code, error };
};
const badRequest = (code, error) => ({ ok: false, status: 400, code, error });

// Checks the body for `kind`; returns `{ fields }` or the 400.
function validateOwnerEventInput(kind, input) {
  const body = input && typeof input === 'object' ? input : {};
  const { idempotencyKey, expectedLatestEventId, replyType, stage, acknowledgedReplyId } = body;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return badRequest('invalid_idempotency_key', 'A valid client idempotency key is required.');
  }
  if (kind === 'reply-type' && !PURSUIT_REPLY_TYPES.includes(replyType)) {
    return badRequest('invalid_reply_type', 'Choose one of the reply types.');
  }
  if (kind === 'stage-move' && !PURSUIT_STAGES.includes(stage)) {
    return badRequest('invalid_stage', 'Choose one of the stages.');
  }
  // `genesis` is a valid id too: it names the empty chain.
  if (kind !== 'acknowledge' && !isId(expectedLatestEventId)) {
    return badRequest('invalid_expected_latest_event_id', 'The deal\'s latest event id is required.');
  }
  const hasReply = acknowledgedReplyId !== undefined && acknowledgedReplyId !== null;
  if ((kind === 'acknowledge' || hasReply) && !isId(acknowledgedReplyId)) {
    return badRequest('invalid_acknowledged_reply_id', 'A valid reply id is required.');
  }
  return { fields: { idempotencyKey, replyType: kind === 'reply-type' ? replyType : null,
    requestedStage: kind === 'stage-move' ? stage : null,
    // An acknowledgement waits for no one: it appends after whatever the chain tip is.
    expectedPreviousEventId: kind === 'acknowledge' ? null : expectedLatestEventId,
    acknowledgedReplyId: hasReply ? acknowledgedReplyId : null } };
}

/**
 * One owner write on a pursued deal (spec 2026-11-04 §6.2): `kind` is `reply-type`,
 * `stage-move` or `acknowledge`. Tracker only: it appends an owner event and never touches a
 * campaign, a CRM record or an owner decision (§6.3). The deal's current stage is folded fresh at
 * request time; the response row is read back the same role-safe way as the list (also on replay).
 */
export async function recordPursuitOwnerEvent({ storage, config, opportunityId, kind, input, actor, role,
  now = new Date() } = {}) {
  if (!OWNER_EVENT_KINDS[kind]) throw new TypeError('Invalid kind');
  const checked = validateOwnerEventInput(kind, input);
  if (!checked.fields) return checked;
  const { idempotencyKey, replyType, requestedStage, expectedPreviousEventId, acknowledgedReplyId } = checked.fields;

  if (!isId(opportunityId)) return refusal('not_pursued');
  const [bundle] = await storage.listPursuitBundles({ opportunityIds: [opportunityId] });
  const current = bundle ? foldPursuitStage(bundle) : null;
  // A deal passed in Deal Hunter is read-only here (§5.1): refuse before writing anything.
  if (!current?.member || current.passedInDealHunter) return refusal('not_pursued');

  const fromStage = current.stage;
  const stage = kind === 'stage-move' ? requestedStage
    : kind === 'reply-type' ? stageAfterReplyType(fromStage, replyType) : fromStage;
  const at = new Date(now).toISOString();
  const command = { id: randomUUID(), idempotencyKey, opportunityId, expectedPreviousEventId, kind, replyType,
    fromStage, stage, acknowledgedReplyId, actor, now: at };
  // The digest binds what the owner asked for. The stage of a reply-type click or an
  // acknowledgement is derived from the fold, which evidence can move between a request and its
  // retry, so it stays out of the digest: a retry must replay, not conflict.
  const requestDigest = pursuitStageRequestDigest({ ...command, stage: kind === 'stage-move' ? stage : null });
  const result = await storage.recordPursuitStageEvent({ ...command, requestDigest });
  if (!result.applied && !result.replay) return refusal(result.conflict);

  const row = await getPursuedDealRow({ storage, config, opportunityId, role, now: at });
  if (!row) return refusal('not_pursued');
  return { ok: true, status: 200, row, replay: result.replay };
}
