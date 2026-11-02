// Automatic Pursue runner (spec 2026-11-02 best-first deal list, section 6).
//
// The runner records the existing owner `pursue` command on the owner's standing
// instruction for `auto`-group deals. It never crosses the provider boundary: the
// only write it makes toward outreach is recordAcquisitionOwnerCommand, the same
// path an owner click uses, so enrollment, campaign creation, cadence, and every
// final gate apply unchanged. Every uncertainty resolves toward not acting.
import { createHash, randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { genericMailboxNames } from './cimAutomation.js';
import { DEAL_CRITERIA_PROFILE_VERSION } from './dealCriteriaProfile.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import { ownerBusinessDate } from './dealHunterFreshInboxPolicy.js';
import { recordAcquisitionOwnerCommand } from './dealHunterTriage.js';

export const AUTO_PURSUE_ACTOR = 'automation-auto-pursue';
export const AUTO_PURSUE_POLICY_VERSION = 'auto-pursue-v1';
export const OWNER_DECISION_POLICY_VERSION = 'owner-decision-v1';
export const AUTO_PURSUE_MODES = Object.freeze(['off', 'shadow', 'canary', 'active']);
export const AUTO_PURSUE_CONFIRMATIONS = Object.freeze({
  off: 'SET AUTO PURSUE OFF',
  shadow: 'ACTIVATE AUTO PURSUE SHADOW',
  canary: 'ACTIVATE AUTO PURSUE CANARY',
  active: 'ACTIVATE AUTO PURSUE ACTIVE',
});
export const AUTO_PURSUE_WARMUP_THRESHOLDS = Object.freeze({
  minimumDecisions: 25,
  minimumAutoDecisions: 10,
  minimumAutoUnchangedRate: 0.95,
});
export const AUTO_PURSUE_CANARY_CAP = 1;
export const AUTO_PURSUE_MAXIMUM_CAP = 10;

const autoFitFloor = 90;
const candidateAreas = Object.freeze(['auto-pursue', 'your-review']);
const inboxPageLimit = 100;
const inboxMaximumPages = 200;
const inboxAttempts = 3;
const identityExceptionLimit = 5001;
const commandModes = new Set(['canary', 'active']);

function clampCap(value, fallback) {
  const parsed = Math.trunc(Number(value));
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(base, AUTO_PURSUE_MAXIMUM_CAP));
}

function configuredActiveCap(config = getConfig()) {
  return clampCap(config?.dealHunter?.autoPursue?.activeDailyCap, 3);
}

/** Cap for one mode: zero records nothing, canary is always one, active is 1-10. */
function effectiveDailyCap(mode, storedCap) {
  if (mode === 'canary') return AUTO_PURSUE_CANARY_CAP;
  if (mode === 'active') return clampCap(storedCap, configuredActiveCap());
  return 0;
}

function addCalendarDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The first instant (UTC) whose owner business date is `date`. */
function businessDateStart(date) {
  const [year, month, day] = date.split('-').map(Number);
  // Pacific midnight is 07:00 or 08:00 UTC; take the earliest candidate on the date.
  for (const offsetHours of [7, 8]) {
    const candidate = Date.UTC(year, month - 1, day, offsetHours);
    if (ownerBusinessDate(candidate) === date && ownerBusinessDate(candidate - 1) !== date) {
      return new Date(candidate).toISOString();
    }
  }
  throw new Error(`Could not resolve the owner business day for ${date}.`);
}

export function ownerBusinessDateBounds(date) {
  return { since: businessDateStart(date), until: businessDateStart(addCalendarDays(date, 1)) };
}

/** Deterministic version-8 UUID for one opportunity on one owner business date. */
export function autoPursueIdempotencyKey(businessDate, opportunityId) {
  const hex = createHash('sha256').update(`auto-pursue:${businessDate}:${opportunityId}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Warm-up from owner-decision-v1 evidence. Each opportunity counts once, by its latest
 * evidence row, so a retried Pursue cannot inflate the thresholds.
 */
export function summarizeAutoPursueWarmup(rows = []) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.opportunity_id || '');
    if (!id) continue;
    const prior = latest.get(id);
    const at = Date.parse(row.created_at);
    const key = [Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY, String(row.decision_event_id || '')];
    if (!prior || key[0] > prior.key[0] || (key[0] === prior.key[0] && key[1] > prior.key[1])) {
      latest.set(id, { key, row });
    }
  }
  const decisions = [...latest.values()].map((item) => item.row);
  const auto = decisions.filter((row) => row.criteria_group === 'auto');
  const unchanged = auto.filter((row) => row.action === 'pursue' && Number(row.recipient_unchanged) === 1);
  const autoUnchangedRate = auto.length > 0 ? unchanged.length / auto.length : 0;
  return {
    totalDecisions: decisions.length,
    autoDecisions: auto.length,
    autoUnchangedRate,
    ready: decisions.length >= AUTO_PURSUE_WARMUP_THRESHOLDS.minimumDecisions
      && auto.length >= AUTO_PURSUE_WARMUP_THRESHOLDS.minimumAutoDecisions
      && autoUnchangedRate >= AUTO_PURSUE_WARMUP_THRESHOLDS.minimumAutoUnchangedRate,
  };
}

export async function getAutoPursueWarmup({ storage = getStorage() } = {}) {
  if (typeof storage?.listAutoPursueDecisionEvidence !== 'function') {
    throw new Error('Warm-up evidence is unavailable.');
  }
  const rows = await storage.listAutoPursueDecisionEvidence({ policyVersion: OWNER_DECISION_POLICY_VERSION });
  if (!Array.isArray(rows)) throw new Error('Warm-up evidence is unavailable.');
  return summarizeAutoPursueWarmup(rows);
}

function publicActivation(activation) {
  if (!activation) return null;
  return {
    id: activation.id, mode: activation.mode, dailyCap: Number(activation.daily_cap),
    actor: activation.actor, reason: activation.reason || '', status: activation.status,
    createdAt: activation.created_at,
  };
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id, runKey: run.run_key, businessDate: run.business_date, mode: run.mode,
    status: run.status, triggeredBy: run.triggered_by || '', commands: Number(run.commands || 0),
    reason: run.reason || null, items: Array.isArray(run.items) ? run.items : [],
    createdAt: run.created_at, completedAt: run.completed_at || null,
  };
}

/** The current mode; a missing activation record means the shipped default, off. */
async function readActivation(storage) {
  if (typeof storage?.getCurrentAutoPursueActivation !== 'function') {
    throw new Error('Automatic Pursue activation storage is unavailable.');
  }
  const activation = await storage.getCurrentAutoPursueActivation();
  if (!activation) return { activation: null, mode: 'off', dailyCap: 0 };
  if (!AUTO_PURSUE_MODES.includes(activation.mode)) {
    throw new Error('Automatic Pursue activation record is malformed.');
  }
  return { activation, mode: activation.mode, dailyCap: effectiveDailyCap(activation.mode, activation.daily_cap) };
}

async function countTodayCommands(storage, businessDate) {
  if (typeof storage?.countOwnerDecisionsByPolicy !== 'function') {
    throw new Error('Owner decision counts are unavailable.');
  }
  const count = Number(await storage.countOwnerDecisionsByPolicy({
    policyVersion: AUTO_PURSUE_POLICY_VERSION, ...ownerBusinessDateBounds(businessDate),
  }));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Owner decision count is malformed.');
  return count;
}

export async function getAutoPursueStatus({ storage = getStorage(), now = new Date() } = {}) {
  const businessDate = ownerBusinessDate(now);
  const { mode, dailyCap } = await readActivation(storage);
  const [todayCommands, warmup, runs] = await Promise.all([
    countTodayCommands(storage, businessDate),
    getAutoPursueWarmup({ storage }),
    storage.listAutoPursueRuns({ limit: 1 }),
  ]);
  return { mode, dailyCap, todayCommands, warmup, latestRun: publicRun(runs?.[0] || null), businessDate };
}

export async function setAutoPursueMode({
  mode, dailyCap, reason = '', confirmation, actor, storage = getStorage(), now = new Date(),
} = {}) {
  if (!AUTO_PURSUE_MODES.includes(mode)) {
    return { ok: false, status: 400, error: 'Mode must be off, shadow, canary, or active.' };
  }
  if (typeof confirmation !== 'string' || confirmation !== AUTO_PURSUE_CONFIRMATIONS[mode]) {
    return { ok: false, status: 400, error: `Type ${AUTO_PURSUE_CONFIRMATIONS[mode]} to confirm.` };
  }
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 160) {
    return { ok: false, status: 400, error: 'An authenticated actor is required.' };
  }
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
    return { ok: false, status: 400, error: 'Reason must be a bounded string.' };
  }
  if (typeof storage?.createAutoPursueActivation !== 'function') {
    return { ok: false, status: 503, error: 'Automatic Pursue activation storage is unavailable.' };
  }
  if (commandModes.has(mode)) {
    let warmup;
    try {
      warmup = await getAutoPursueWarmup({ storage });
    } catch {
      return { ok: false, status: 503, error: 'Warm-up evidence is unavailable.' };
    }
    if (!warmup.ready) {
      return { ok: false, status: 409, code: 'warmup_not_ready', warmup,
        error: 'Automatic Pursue cannot record commands until warm-up is complete.' };
    }
  }
  const activation = await storage.createAutoPursueActivation({
    id: randomUUID(), mode,
    daily_cap: mode === 'active' ? clampCap(dailyCap, configuredActiveCap()) : effectiveDailyCap(mode),
    actor: actor.trim(), reason: (reason || '').trim(), confirmation,
    created_at: new Date(now).toISOString(),
  });
  return { ok: true, status: 200, activation: publicActivation(activation) };
}

async function listCandidateRows(storage, asOf) {
  if (typeof storage?.listDealHunterFreshInbox !== 'function') {
    throw new Error('Acquisition inbox storage is unavailable.');
  }
  let lastError;
  for (let attempt = 0; attempt < inboxAttempts; attempt += 1) {
    try {
      const rows = [];
      for (const area of candidateAreas) {
        let cursor = null;
        for (let page = 0; ; page += 1) {
          if (page >= inboxMaximumPages) throw new Error('Acquisition inbox paging did not terminate.');
          const result = await storage.listDealHunterFreshInbox({ area, cursor, limit: inboxPageLimit, asOf });
          const section = (result?.areas || []).find((item) => item.id === area);
          if (!section || !Array.isArray(section.rows)) throw new Error('Acquisition inbox area is malformed.');
          rows.push(...section.rows);
          cursor = section.nextCursor || null;
          if (!cursor) break;
        }
      }
      const seen = new Set();
      return rows.filter((row) => {
        const id = String(row?.opportunity_id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return row.criteria_group === 'auto' && row.criteria_profile_version === DEAL_CRITERIA_PROFILE_VERSION;
      });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'DEAL_HUNTER_STALE_PAGE') break;
    }
  }
  throw lastError;
}

function openIdentityExceptionFor(exceptions, opportunityId) {
  if (exceptions.length >= identityExceptionLimit) return true;
  return exceptions.some((item) => {
    const candidates = item?.candidate_opportunity_ids;
    return !Array.isArray(candidates) || candidates.length === 0 || candidates.includes(opportunityId);
  });
}

function isGenericMailbox(address) {
  const mailbox = String(address || '').toLowerCase().split('@')[0] || '';
  const firstSegment = mailbox.split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
  return genericMailboxNames.has(mailbox) || genericMailboxNames.has(firstSegment);
}

/**
 * The section 6.3 blocker for one current auto row, or '' when it may be Pursued.
 * Any read failure is reported as authority_unavailable: never automatic.
 */
async function evaluateBlocker({ storage, row, identityExceptions, now }) {
  const opportunityId = String(row.opportunity_id);
  if (row.criteria_profile_version !== DEAL_CRITERIA_PROFILE_VERSION || row.criteria_group !== 'auto'
    || !(Number(row.fit_score) >= autoFitFloor)) {
    return { blocker: 'criteria_out_of_date' };
  }
  try {
    const projection = await storage.readPursueCimProjection({ opportunityId });
    if (!projection || typeof projection !== 'object') return { blocker: 'authority_unavailable' };
    if (projection.decision) return { blocker: 'owner_decision_exists' };
    if (openIdentityExceptionFor(identityExceptions, opportunityId)) return { blocker: 'identity_unresolved' };
    const authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now });
    const codes = new Set((authority?.preparationBlockers || []).map((item) => item.code));
    if (!authority || codes.has('broker_materials_authority_unavailable')
      || codes.has('canonical_authority_unavailable') || codes.has('required_source_authority_unavailable')
      || authority.materialsAuthorityAvailable === false || authority.communicationsAuthorityAvailable === false
      || authority.eventAuthorityAvailable === false || authority.suppressionAuthorityAvailable === false) {
      return { blocker: 'authority_unavailable' };
    }
    const options = Array.isArray(authority.recipientOptions) ? authority.recipientOptions : [];
    if (options.length !== 1 || !options[0]?.recipientContactRef || !options[0]?.email) {
      return { blocker: 'recipient_not_single' };
    }
    const [recipient] = options;
    const address = String(recipient.email).toLowerCase();
    if (isGenericMailbox(address)) return { blocker: 'generic_mailbox' };
    if ((Array.isArray(authority.requests) && authority.requests.length > 0) || authority.existingRequest
      || authority.opportunityClaim || projection.enrollment || projection.campaign
      || Number(projection.legacySummary?.count || 0) > 0) {
      return { blocker: 'prior_outreach' };
    }
    const [recipientRequests, recipientClaim, recipientConversation] = await Promise.all([
      storage.listDealHunterCimRequests({ recipientEmails: [address], limit: 1 }),
      storage.getDealHunterCimRecipientClaim(address),
      storage.hasPursueCimConversationForRecipient(address),
    ]);
    if (!Array.isArray(recipientRequests)) return { blocker: 'authority_unavailable' };
    if (recipientRequests.length > 0 || recipientClaim || recipientConversation) return { blocker: 'prior_outreach' };
    if (authority.suppression || await storage.getActiveEmailSuppression(address)) return { blocker: 'suppressed' };
    return { blocker: '', recipient };
  } catch {
    return { blocker: 'authority_unavailable' };
  }
}

function blockedEarlierToday(priorRuns) {
  const blocked = new Set();
  for (const run of priorRuns) {
    for (const item of Array.isArray(run?.items) ? run.items : []) {
      if (item?.outcome === 'blocked' && item.opportunityId) blocked.add(String(item.opportunityId));
    }
  }
  return blocked;
}

async function recordAutomaticPursue({ storage, row, recipient, businessDate }) {
  const opportunityId = String(row.opportunity_id);
  const idempotencyKey = autoPursueIdempotencyKey(businessDate, opportunityId);
  // Re-check immediately before recording: an owner decision made while earlier deals were
  // processed must win. (A Pursue on an action-required enrollment counts as a retry, so
  // recording over an owner decision would supersede it rather than conflict.)
  const before = await storage.readPursueCimProjection({ opportunityId });
  if (!before || typeof before !== 'object') return { outcome: 'error', reason: 'authority_unavailable' };
  if (before.decision) return { outcome: 'skipped', reason: 'owner_decision_exists' };
  const result = await recordAcquisitionOwnerCommand({
    opportunityId, action: 'pursue', idempotencyKey,
    expectedDiscoveryRevision: Number(row.discovery_revision),
    expectedMaterialRevision: Number(row.material_revision),
    recipientContactRef: recipient.recipientContactRef,
    actor: AUTO_PURSUE_ACTOR, decisionPolicyVersion: AUTO_PURSUE_POLICY_VERSION, storage,
  });
  if (!result?.ok) {
    if (result?.status === 409) {
      return { outcome: 'skipped', reason: result.code === 'stale_freshness_review'
        ? 'stale_revision' : 'owner_decision_exists' };
    }
    return { outcome: 'error', reason: `command_rejected_${Number(result?.status) || 'unknown'}` };
  }
  // An owner Pursue recorded first is returned as a successful no-op; only a decision
  // carrying this runner's idempotency key is ours.
  const projection = await storage.readPursueCimProjection({ opportunityId });
  if (projection?.decision?.idempotency_key !== idempotencyKey) {
    return { outcome: 'skipped', reason: 'owner_decision_exists' };
  }
  if (result.replay) return { outcome: 'skipped', reason: 'already_recorded' };
  return { outcome: 'pursued', enrollmentState: result.enrollment?.state || null };
}

export async function runAutoPursue({ storage = getStorage(), now = new Date(), triggeredBy = 'cron' } = {}) {
  const at = new Date(now);
  const asOf = at.toISOString();
  const businessDate = ownerBusinessDate(at);
  const base = { businessDate, commands: 0, skipped: [], wouldPursue: [], duplicateInvocation: false };
  let mode = 'off';
  let dailyCap = 0;
  let activationId = null;
  let priorRuns;
  try {
    let activation;
    ({ activation, mode, dailyCap } = await readActivation(storage));
    activationId = activation?.id || null;
    priorRuns = await storage.listAutoPursueRuns({ businessDate, limit: 1000 });
    if (!Array.isArray(priorRuns)) throw new Error('Automatic Pursue run history is malformed.');
  } catch {
    return { ok: false, status: 503, mode, ...base, reason: 'runner_storage_unavailable' };
  }
  const sequence = priorRuns.filter((run) => run.completed_at).length;
  const runKey = `auto-pursue:${businessDate}:${mode}:${sequence}`;
  let claim;
  try {
    claim = await storage.claimAutoPursueRun({ id: randomUUID(), run_key: runKey, business_date: businessDate,
      mode, triggered_by: String(triggeredBy || '').slice(0, 120), created_at: new Date().toISOString() });
  } catch {
    return { ok: false, status: 503, mode, ...base, reason: 'runner_storage_unavailable' };
  }
  if (!claim?.claimed) {
    return { ok: true, status: 200, mode, ...base, runKey, duplicateInvocation: true,
      reason: claim?.run?.completed_at ? 'run_already_completed' : 'run_in_progress' };
  }

  const items = [];
  const skipped = [];
  const wouldPursue = [];
  let commands = 0;
  let reason = null;
  let status = 'completed';
  const skip = (opportunityId, why, outcome = 'skipped') => {
    skipped.push({ opportunityId, reason: why });
    items.push({ opportunityId, outcome, reason: why });
  };
  try {
    let candidates;
    let identityExceptions;
    try {
      candidates = await listCandidateRows(storage, asOf);
      identityExceptions = await storage.listDealHunterIdentityExceptions({
        statuses: ['open'], limit: identityExceptionLimit });
      if (!Array.isArray(identityExceptions)) throw new Error('Identity exceptions are malformed.');
    } catch {
      status = 'failed'; reason = 'inbox_unavailable';
      return { ok: false, status: 503, mode, ...base, runKey, reason };
    }

    const evaluated = [];
    for (const row of candidates) {
      const { blocker, recipient } = await evaluateBlocker({ storage, row, identityExceptions, now: at });
      evaluated.push({ row, blocker, recipient });
    }
    const changed = evaluated.filter(({ row, blocker }) => (row.auto_pursue_blocker || '') !== blocker)
      .map(({ row, blocker }) => ({ opportunityId: String(row.opportunity_id), blocker: blocker || null,
        checkedAt: asOf }));
    if (changed.length > 0) {
      try {
        await storage.setDealHunterAutoPursueBlockers(changed);
      } catch {
        status = 'failed'; reason = 'blocker_write_failed';
        return { ok: false, status: 503, mode, ...base, runKey, reason };
      }
    }

    const earlierBlocked = blockedEarlierToday(priorRuns);
    const eligible = [];
    for (const entry of evaluated) {
      const opportunityId = String(entry.row.opportunity_id);
      if (entry.blocker) skip(opportunityId, entry.blocker, 'blocked');
      else if (earlierBlocked.has(opportunityId)) skip(opportunityId, 'blocked_earlier_today');
      else eligible.push(entry);
    }

    if (!commandModes.has(mode)) {
      for (const { row } of eligible) {
        wouldPursue.push(String(row.opportunity_id));
        items.push({ opportunityId: String(row.opportunity_id), outcome: 'would-pursue', reason: `mode_${mode}` });
      }
      return { ok: true, status: 200, mode, ...base, runKey, skipped, wouldPursue };
    }

    let warmup;
    try {
      warmup = await getAutoPursueWarmup({ storage });
    } catch {
      reason = 'warmup_unavailable';
    }
    if (!reason && !warmup.ready) reason = 'warmup_not_ready';
    if (reason) {
      for (const { row } of eligible) skip(String(row.opportunity_id), reason);
      return { ok: true, status: 200, mode, ...base, runKey, skipped, reason };
    }

    for (let index = 0; index < eligible.length; index += 1) {
      const { row, recipient } = eligible[index];
      const opportunityId = String(row.opportunity_id);
      let already;
      try {
        already = await countTodayCommands(storage, businessDate);
      } catch {
        reason = 'decision_count_unavailable';
      }
      if (!reason && already >= dailyCap) reason = 'daily_cap_reached';
      if (!reason) {
        try {
          // The owner may stop or change the capability mid-run; stop at the next deal.
          const current = await readActivation(storage);
          if (current.activation?.id !== activationId || !commandModes.has(current.mode)) reason = 'mode_changed';
        } catch {
          reason = 'runner_storage_unavailable';
        }
      }
      if (reason) {
        for (const remaining of eligible.slice(index)) skip(String(remaining.row.opportunity_id), reason);
        break;
      }
      let outcome;
      try {
        outcome = await recordAutomaticPursue({ storage, row, recipient, businessDate });
      } catch {
        outcome = { outcome: 'error', reason: 'command_error' };
      }
      if (outcome.outcome === 'pursued') {
        commands += 1;
        items.push({ opportunityId, outcome: 'pursued', enrollmentState: outcome.enrollmentState });
        continue;
      }
      skip(opportunityId, outcome.reason, outcome.outcome === 'error' ? 'error' : 'skipped');
      if (outcome.outcome === 'error') {
        // Storage or authority trouble: stop rather than keep acting this run.
        reason = outcome.reason;
        for (const remaining of eligible.slice(index + 1)) skip(String(remaining.row.opportunity_id), 'run_stopped');
        break;
      }
    }
    return { ok: true, status: 200, mode, ...base, runKey, commands, skipped, ...(reason ? { reason } : {}) };
  } catch (error) {
    status = 'failed'; reason = 'runner_error';
    console.warn(`[auto-pursue] run ${runKey} failed: ${error?.message || error}`);
    return { ok: false, status: 500, mode, ...base, runKey, commands, skipped, reason };
  } finally {
    try {
      await storage.completeAutoPursueRun({ id: claim.run.id, status, commands, items, reason,
        completedAt: new Date().toISOString() });
    } catch (error) {
      console.warn(`[auto-pursue] could not complete run ${runKey}: ${error?.message || error}`);
    }
  }
}
