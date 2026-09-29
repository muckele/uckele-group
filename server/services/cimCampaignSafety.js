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
    } else if (acceptedAt.some((value) => value > campaignCreatedAt)) {
      blockers.push('campaign-source-authority-changed');
    }
  }
  if (sourceHealth?.healthy !== true) blockers.push('source-health-unavailable');
  return { opportunityId: id, opportunity, sourceRows, identityExceptions: exceptions,
    sourceStates, sourceHealth, campaign, blocked: blockers.length > 0, blockers };
}
