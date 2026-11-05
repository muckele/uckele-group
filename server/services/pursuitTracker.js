// The Pursued deals tracker's pure fold (spec 2026-11-04 §5): a pursuit bundle in, the stage,
// the reply attention and the Gmail link out. No I/O, no clock, nothing sent.
import { PURSUIT_CIM_DOCUMENT_TYPES, PURSUIT_GENESIS, PURSUIT_STAGES } from '../storage/pursuitTrackerStorageContract.js';

/** Owner-facing labels, in stage order. Code keeps the CIM names; the UI says "SIM". */
export const STAGE_LABELS = Object.freeze({
  'cim-requested': 'SIM requested',
  'broker-replied': 'Broker replied',
  'nda-sent': 'NDA',
  'cim-received': 'SIM received',
  'financial-review': 'Reviewing',
  'loi-candidate': 'LOI candidate',
  passed: 'Passed',
});

const PASSED = 'passed';
const GMAIL_THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

// CRM `diligence.stage` -> tracker stage (§5.2); `not-started` and anything unknown map to nothing.
const DILIGENCE_STAGE = Object.freeze({
  'cim-requested': 'cim-requested',
  'nda-sent': 'nda-sent',
  'cim-received': 'cim-received',
  'financial-review': 'financial-review',
  'lender-review': 'financial-review',
  'loi-candidate': 'loi-candidate',
  passed: 'passed',
});
// CRM `pipelineStage` -> tracker stage (§5.2); `new-fit` and anything unknown map to nothing.
const PIPELINE_STAGE = Object.freeze({
  'cim-requested': 'cim-requested',
  'broker-replied': 'broker-replied',
  'docs-received': 'cim-received',
  diligence: 'financial-review',
  'loi-candidate': 'loi-candidate',
  passed: 'passed',
});

const stageIndex = (stage) => PURSUIT_STAGES.indexOf(stage);
const maxStage = (a, b) => (stageIndex(b) > stageIndex(a) ? b : a);
const time = (instant) => (instant ? Date.parse(instant) : Number.NaN);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The stage after an owner `reply-type` event (§5.2): `not-available` passes the deal; the
 * others only move the stage forward. An unknown type leaves the stage alone.
 */
export function stageAfterReplyType(current, replyType) {
  switch (replyType) {
    case 'not-available': return PASSED;
    case 'nda-requested': return maxStage(current, 'nda-sent');
    case 'sim-received': return maxStage(current, 'cim-received');
    case 'question':
    case 'other': return maxStage(current, 'broker-replied');
    default: return current;
  }
}

/** The owner's Gmail link for a thread (§7.4), or null for a bad thread id or an empty address. */
export function buildGmailThreadUrl({ threadId, address } = {}) {
  if (typeof threadId !== 'string' || !GMAIL_THREAD_ID.test(threadId)) return null;
  if (typeof address !== 'string' || address.trim() === '') return null;
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#all/${threadId}`;
}

function latestEventIdOf(events) {
  let latest = null;
  for (const event of events) {
    if (!latest || time(event.createdAt) > time(latest.createdAt)
      || (time(event.createdAt) === time(latest.createdAt) && compareText(event.id, latest.id) > 0)) {
      latest = event;
    }
  }
  return latest ? latest.id : PURSUIT_GENESIS;
}

// (processedAt, gmailMessageId) ordering for attention and acknowledgement.
function compareReplyPoints(aAt, aId, bAt, bId) {
  return (time(aAt) - time(bAt)) || compareText(aId, bId);
}

function notMember(latestEventId) {
  return { member: false, passedInDealHunter: false, stage: null, stageSince: null, stageSource: null,
    needsAction: null, lastReplyAt: null, latestEventId, replyCount: 0 };
}

/**
 * Folds one pursuit bundle into its projection (§5.1-§5.3). Membership follows the latest
 * owner decision; the fold starts at the latest `pursue`.
 */
export function foldPursuitStage(bundle) {
  const events = bundle.events ?? [];
  const latestEventId = latestEventIdOf(events);
  const decisions = bundle.decisions ?? [];
  const latest = decisions[decisions.length - 1];
  if (!latest || (latest.action !== 'pursue' && latest.action !== 'pass')) return notMember(latestEventId);
  const pursue = decisions.findLast((decision) => decision.action === 'pursue');
  if (!pursue) return notMember(latestEventId);
  const passedInDealHunter = latest.action === 'pass';
  const startAt = time(pursue.createdAt);

  // Items from before the pursue belong to an earlier generation and are dropped. Documents and
  // CRM stages are the exception: they are applied at the pursue instant.
  const items = [];
  for (const row of bundle.replies ?? []) {
    if (Number.isNaN(time(row.processedAt)) || time(row.processedAt) < startAt) continue;
    if (row.classification === 'reply' || row.classification === 'stop') {
      items.push({ at: time(row.processedAt), instant: row.processedAt, owner: 0, id: row.gmailMessageId,
        apply: (state) => forward(state, 'broker-replied', row.processedAt) });
    }
  }
  for (const doc of bundle.documents ?? []) {
    if (!PURSUIT_CIM_DOCUMENT_TYPES.includes(doc.documentType)) continue;
    const at = Math.max(time(doc.createdAt) || startAt, startAt);
    items.push({ at, instant: new Date(at).toISOString(), owner: 0, id: doc.id,
      apply: (state, instant) => forward(state, 'cim-received', instant) });
  }
  const crm = bundle.crm;
  for (const [id, stage, updatedAt] of crm ? [
    ['crm-diligence', DILIGENCE_STAGE[crm.diligenceStage], crm.diligenceUpdatedAt],
    ['crm-pipeline', PIPELINE_STAGE[crm.pipelineStage], crm.pipelineUpdatedAt],
  ] : []) {
    if (!stage) continue;
    const at = Math.max(time(updatedAt) || startAt, startAt);
    items.push({ at, instant: new Date(at).toISOString(), owner: 0, id,
      apply: (state, instant) => forward(state, stage, instant) });
  }
  const ownerEvents = events.filter((event) => time(event.createdAt) >= startAt);
  for (const event of ownerEvents) {
    items.push({ at: time(event.createdAt), instant: event.createdAt, owner: 1, id: event.id,
      apply: (state, instant) => applyOwnerEvent(state, event, instant) });
  }
  items.sort((a, b) => (a.at - b.at) || (a.owner - b.owner) || compareText(a.id, b.id));

  const state = { stage: 'cim-requested', stageSince: pursue.createdAt, stageSource: 'evidence' };
  for (const item of items) item.apply(state, item.instant);

  let ackAt = null;
  let ackId = null;
  for (const event of ownerEvents) {
    if (event.acknowledgedReplyId === null || event.acknowledgedProcessedAt === null) continue;
    if (ackAt === null || compareReplyPoints(event.acknowledgedProcessedAt, event.acknowledgedReplyId, ackAt, ackId) > 0) {
      ackAt = event.acknowledgedProcessedAt;
      ackId = event.acknowledgedReplyId;
    }
  }

  const campaign = bundle.campaign;
  const bouncesCount = campaign?.state === 'action-required' && campaign?.reasonCode === 'recipient_bounced';
  let needsAction = null;
  let lastReplyAt = null;
  let replyCount = 0;
  for (const row of bundle.replies ?? []) {
    if (Number.isNaN(time(row.processedAt)) || time(row.processedAt) < startAt) continue;
    const isReply = row.classification === 'reply' || row.classification === 'stop';
    if (isReply) {
      replyCount += 1;
      const shown = row.messageAt ?? row.processedAt;
      if (lastReplyAt === null || time(shown) > time(lastReplyAt)) lastReplyAt = shown;
    }
    if (!isReply && !(row.classification === 'bounce' && bouncesCount)) continue;
    if (ackAt !== null && compareReplyPoints(row.processedAt, row.gmailMessageId, ackAt, ackId) <= 0) continue;
    if (needsAction === null
      || compareReplyPoints(row.processedAt, row.gmailMessageId, needsAction.at, needsAction.replyId) < 0) {
      needsAction = { reason: isReply ? 'reply' : 'bounce', at: row.processedAt, replyId: row.gmailMessageId,
        classification: row.classification };
    }
  }

  if (passedInDealHunter) {
    return { member: true, passedInDealHunter: true, stage: PASSED, stageSince: latest.createdAt,
      stageSource: 'evidence', needsAction: null, lastReplyAt, latestEventId, replyCount };
  }
  return { member: true, passedInDealHunter: false, stage: state.stage, stageSince: state.stageSince,
    stageSource: state.stageSource, needsAction, lastReplyAt, latestEventId, replyCount };
}

// System evidence moves the stage forward only, and never out of `passed`.
function forward(state, stage, instant) {
  if (state.stage === PASSED || stageIndex(stage) <= stageIndex(state.stage)) return;
  Object.assign(state, { stage, stageSince: instant, stageSource: 'evidence' });
}

function setOwnerStage(state, stage, instant) {
  if (stage === state.stage) return;
  Object.assign(state, { stage, stageSince: instant, stageSource: 'owner' });
}

function applyOwnerEvent(state, event, instant) {
  switch (event.kind) {
    case 'stage-move': return setOwnerStage(state, event.stage, instant);
    case 'reply-type': return setOwnerStage(state, stageAfterReplyType(state.stage, event.replyType), instant);
    case 'sim-intake': return setOwnerStage(state, maxStage(state.stage, 'cim-received'), instant);
    default: return undefined; // acknowledge: the stage is unchanged
  }
}
