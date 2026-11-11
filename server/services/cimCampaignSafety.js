import { getSourceHealth } from './acquisitionCommandCenter.js';
import { sourceSafetyRunId } from './cimSafetyIdentity.js';

const ACTIVE_CAMPAIGN_STATES = new Set([
  'queued', 'waiting-on-eligibility', 'initial-pending', 'active-follow-up',
  'action-required', 'provider-ambiguous',
]);
const TERMINAL_STATUSES = new Set(['stopped', 'review-required', 'no-op']);

function requiredText(value, name) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 240) {
    throw new Error(`${name} must be a bounded, unpadded identity.`);
  }
  return value;
}

function accounting(safetyRunId, events) {
  const result = { safetyRunId, safetyEventsEmitted: events.length,
    stopped: 0, reviewRequired: 0, noOp: 0, pending: 0 };
  for (const event of events) {
    if (event.status === 'stopped') result.stopped += 1;
    else if (event.status === 'review-required') result.reviewRequired += 1;
    else if (event.status === 'no-op') result.noOp += 1;
    else if (event.status === 'pending') result.pending += 1;
    else throw new Error('Unknown CIM safety event status.');
  }
  return result;
}

function plannedOutcome(event, campaign) {
  if (!ACTIVE_CAMPAIGN_STATES.has(campaign?.state)) return 'no-op';
  const type = (event.event_type || event.eventType || '').split('#')[0];
  if (type === 'source-record-removed') return 'stopped';
  if (type === 'source-record-changed' || type === 'identity-exception') return 'review-required';
  if (type === 'source-record-unchanged' || type === 'source-record-superseded') return 'no-op';
  return null;
}

/** Evaluate a durable import outbox run. Shadow performs reads only. */
export async function runCimCampaignSafety({ storage, safetyRunId, mode = 'shadow',
  now = new Date().toISOString(), actor = 'cim-safety-consumer', limit = 1000 } = {}) {
  const runId = requiredText(safetyRunId, 'safetyRunId');
  if (!['shadow', 'active'].includes(mode)) throw new Error('Invalid CIM safety mode.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid CIM safety batch limit.');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid CIM safety evaluation time.');
  if (typeof storage?.listCimSafetyEvents !== 'function'
    || typeof storage?.readPursueCimProjection !== 'function'
    || typeof storage?.listDealHunterSourceFreshnessStates !== 'function'
    || (mode === 'active' && typeof storage?.consumeCimSafetyEvents !== 'function')) {
    throw new Error('CIM safety storage authority is unavailable.');
  }
  const events = await storage.listCimSafetyEvents({ safetyRunId: runId });
  if (!Array.isArray(events) || events.length > 10000) throw new Error('CIM safety run is incomplete or unbounded.');
  const sourceStates = await storage.listDealHunterSourceFreshnessStates();
  if (!Array.isArray(sourceStates)) throw new Error('CIM safety source state is unavailable.');
  const sourceProjectionPending = sourceStates.some((state) => state.accepted_run_id
    && sourceSafetyRunId(state.source_id, state.accepted_run_id) === runId
    && state.projection_state === 'deferred');
  const summarize = (rows) => {
    const result = accounting(runId, rows);
    return { ...result, sourceProjectionPending,
      complete: result.pending === 0 && !sourceProjectionPending };
  };
  const proposed = { stopped: 0, reviewRequired: 0, noOp: 0 };
  const outcomes = {};
  for (const event of events) {
    if (event.status !== 'pending') {
      if (!TERMINAL_STATUSES.has(event.status)) throw new Error('Unknown CIM safety event status.');
      continue;
    }
    const opportunityId = requiredText(event.opportunity_id || event.opportunityId, 'opportunityId');
    const projection = await storage.readPursueCimProjection({ opportunityId });
    const outcome = plannedOutcome(event, projection?.campaign);
    if (!outcome) continue;
    outcomes[event.id] = outcome;
    if (outcome === 'review-required') proposed.reviewRequired += 1;
    else if (outcome === 'stopped') proposed.stopped += 1;
    else proposed.noOp += 1;
  }
  if (mode === 'shadow') return { ...summarize(events), proposed };
  await storage.consumeCimSafetyEvents({ safetyRunId: runId, limit, actor: requiredText(actor, 'actor'),
    now, outcomes });
  const after = await storage.listCimSafetyEvents({ safetyRunId: runId });
  if (!Array.isArray(after) || after.length !== events.length) {
    throw new Error('CIM safety run changed during accounting; retry the read.');
  }
  return summarize(after);
}

/**
 * Whether the campaign's source truth changed after the campaign was created.
 *
 * Ruling (2026-11-11): the gate reads source truth directly so consumer lag cannot authorize a
 * send (plan 2026-09-25, Package 2), and it blocks when the source *changed* after creation.
 * An unchanged daily refresh is not a change: it rewrites every row's `accepted_at` and the
 * source state's `accepted_at`, so those are not read here. Instead:
 * - a row with accepted evidence is dated by that evidence's `accepted_at`, which an unchanged
 *   record keeps from the run that last changed it;
 * - a row without accepted evidence is dated by its own `accepted_at`, and a row with neither
 *   is unproven (the stricter of the two choices: an unprovable row blocks);
 * - a removed source record is an admitted `source-record-removed` safety event for this
 *   opportunity accepted after creation. The admitted import writes those whatever their
 *   consumption status, so they are import truth; consumer outcomes are never read. Only
 *   this opportunity's removals after creation are read: another deal's change or removal
 *   never blocks this campaign.
 * Deal OS is treated as additive: Deal OS emits no removal events, so a later Deal OS export
 * that drops a listing does not block (owner decision parked, 2026-11-11 review M2).
 * Unreadable evidence is unproven, never unchanged.
 */
async function campaignSourceChange({ storage, opportunityId, sourceRows, campaignCreatedAt }) {
  if (typeof storage?.readCimCampaignSourceChangeEvidence !== 'function') {
    return { unproven: true, changed: sourceRows.some((row) =>
      Date.parse(row.accepted_at || '') > campaignCreatedAt) };
  }
  const evidenceIds = [...new Set(sourceRows.map((row) => row.accepted_evidence_id)
    .filter((value) => typeof value === 'string' && value))];
  let read;
  try {
    read = await storage.readCimCampaignSourceChangeEvidence({ opportunityId, evidenceIds,
      removedAfter: new Date(campaignCreatedAt).toISOString() });
  } catch {
    read = null;
  }
  if (!Array.isArray(read?.evidence) || !Array.isArray(read?.removals)) {
    return { unproven: true, changed: false };
  }
  const evidenceAcceptedAt = new Map(read.evidence.map((item) => [item.id,
    Date.parse(item.accepted_at || '')]));
  let unproven = false;
  let changed = false;
  for (const row of sourceRows) {
    const at = row.accepted_evidence_id
      ? evidenceAcceptedAt.get(row.accepted_evidence_id) : Date.parse(row.accepted_at || '');
    if (!Number.isFinite(at)) unproven = true;
    else if (at > campaignCreatedAt) changed = true;
  }
  for (const removal of read.removals) {
    const at = Date.parse(removal.created_at || '');
    if (!Number.isFinite(at)) unproven = true;
    else if (at > campaignCreatedAt) changed = true;
  }
  return { unproven, changed };
}

/** Current source and identity truth for the later final gate; no safety-consumer state is consulted. */
export async function readCimCurrentAuthority({ storage, opportunityId,
  readSourceHealth = getSourceHealth } = {}) {
  const id = requiredText(opportunityId, 'opportunityId');
  for (const method of ['getCurrentDealHunterOpportunity',
    'listDealHunterOpportunitySourceObservations', 'listDealHunterIdentityExceptions',
    'listDealHunterSourceFreshnessStates', 'readPursueCimProjection']) {
    if (typeof storage?.[method] !== 'function') throw new Error('CIM current authority is unavailable.');
  }
  const [opportunity, sourceRows, allExceptions, sourceStates, campaignProjection, sourceHealth] = await Promise.all([
    storage.getCurrentDealHunterOpportunity(id),
    storage.listDealHunterOpportunitySourceObservations(id, { limit: 500 }),
    storage.listDealHunterIdentityExceptions({ statuses: ['open'], limit: 5001 }),
    storage.listDealHunterSourceFreshnessStates(),
    storage.readPursueCimProjection({ opportunityId: id }),
    readSourceHealth(storage, { persistSnapshot: false, refresh: false }),
  ]);
  if (!Array.isArray(sourceRows) || !Array.isArray(allExceptions)
    || !Array.isArray(sourceStates)) throw new Error('Malformed CIM current authority.');
  const exceptions = allExceptions.filter((item) => {
    const candidates = item.candidate_opportunity_ids || [];
    return !Array.isArray(candidates) || candidates.length === 0 || candidates.includes(id);
  });
  const blockers = [];
  if (!opportunity || opportunity.status !== 'active') blockers.push('canonical-opportunity-not-current');
  if (allExceptions.length >= 5001 || exceptions.length > 0) blockers.push('identity-exception-open');
  if (sourceRows.length === 0 || sourceRows.length >= 500) blockers.push('current-source-unavailable');
  if (sourceStates.some((state) => ['pending', 'deferred', 'superseded'].includes(state.projection_state))) {
    blockers.push('source-projection-deferred');
  }
  const campaign = campaignProjection?.campaign || null;
  if (ACTIVE_CAMPAIGN_STATES.has(campaign?.state)) {
    if (Number(campaign.material_revision) !== Number(opportunity?.material_revision)) {
      blockers.push('campaign-material-authority-changed');
    }
    if (Number(campaign.discovery_revision) !== Number(opportunity?.discovery_revision)) {
      blockers.push('campaign-discovery-authority-changed');
    }
    const campaignCreatedAt = Date.parse(campaign.created_at || '');
    const acceptedAt = [...sourceRows.map((row) => row.accepted_at),
      ...sourceStates.map((state) => state.accepted_at)]
      .map((value) => Date.parse(value || ''))
      .filter(Number.isFinite);
    if (!Number.isFinite(campaignCreatedAt) || acceptedAt.length === 0) {
      blockers.push('campaign-source-authority-unproven');
    } else {
      const change = await campaignSourceChange({ storage, opportunityId: id, sourceRows,
        campaignCreatedAt });
      if (change.unproven) blockers.push('campaign-source-authority-unproven');
      if (change.changed) blockers.push('campaign-source-authority-changed');
    }
  }
  if (sourceHealth?.healthy !== true) blockers.push('source-health-unavailable');
  return { opportunityId: id, opportunity, sourceRows, identityExceptions: exceptions,
    sourceStates, sourceHealth, campaign, blocked: blockers.length > 0, blockers };
}
