import { stableCanonicalJson } from '../utils/security.js';

const DEFAULT_LIMIT = 25;
const MAXIMUM_LIMIT = 100;
const CLAIM_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const FOLLOW_UP_KINDS = new Set([
  'follow-up-1', 'follow-up-2', 'follow-up-3', 'weekday-follow-up',
]);

function summary({ selected = 0, scheduled = 0, duplicateCount = 0,
  attempted = 0, cancelled = false, outcomes = [] } = {}) {
  return { selected, scheduled, duplicateCount, attempted, cancelled, outcomes };
}

function canonicalInstant(value) {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) throw new Error('Valid FL04C due-work instant is required');
  return new Date(parsed).toISOString();
}

function validateCandidate(candidate, at) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || typeof candidate.touch_id !== 'string' || !candidate.touch_id
    || candidate.touch_id.length > 240
    || !FOLLOW_UP_KINDS.has(candidate.kind)
    || !['scheduled', 'claimed'].includes(candidate.state)) {
    throw new Error('Invalid FL04C follow-up due work');
  }
  const dueAt = canonicalInstant(candidate.due_at);
  if (Date.parse(dueAt) > Date.parse(at)) {
    throw new Error('FL04C selector returned work that is not due');
  }
  return { candidate, dueAt, canonical: stableCanonicalJson(candidate) };
}

function deterministicPlan(selected, at, limit) {
  if (!Array.isArray(selected) || selected.length > limit) {
    throw new Error('Malformed FL04C due-work selection');
  }
  const byTouch = new Map();
  let duplicateCount = 0;
  for (const item of selected) {
    const normalized = validateCandidate(item, at);
    const existing = byTouch.get(item.touch_id);
    if (existing) {
      if (existing.canonical !== normalized.canonical) {
        throw new Error('Divergent duplicate FL04C due work');
      }
      duplicateCount += 1;
      continue;
    }
    byTouch.set(item.touch_id, normalized);
  }
  const work = [...byTouch.values()].sort((left, right) =>
    left.dueAt.localeCompare(right.dueAt)
      || left.candidate.touch_id.localeCompare(right.candidate.touch_id));
  return { work, duplicateCount };
}

function normalizedOutcome(touchId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.prepared !== 'boolean') {
    throw new Error('Malformed FL04C preparation outcome');
  }
  return {
    touchId,
    prepared: value.prepared,
    existing: value.existing === true,
    capacityDeferred: value.capacityDeferred === true,
    payloadConflict: value.payloadConflict === true,
    terminal: value.terminal === true,
    blockedReason: value.blockedReason ?? null,
    transmissionId: value.transmission?.id ?? null,
    reservationId: value.reservation?.id ?? null,
  };
}

export async function runDueCimFollowUpOrchestration({
  listDueWork,
  prepareFollowUp,
  createClaimTokenDigest,
  preparation = {},
  now = new Date(),
  limit = DEFAULT_LIMIT,
  actor = 'pursue-cim-follow-up-orchestrator',
  signal,
} = {}) {
  if (typeof listDueWork !== 'function' || typeof prepareFollowUp !== 'function'
    || typeof createClaimTokenDigest !== 'function') {
    throw new Error('FL04C orchestration dependencies are unavailable');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) {
    throw new Error('Invalid FL04C due-work limit');
  }
  if (signal?.aborted) return summary({ cancelled: true });

  const at = canonicalInstant(now instanceof Date ? now.toISOString() : now);
  const selected = await listDueWork({ now: at, limit, signal });
  const { work, duplicateCount } = deterministicPlan(selected, at, limit);
  const planned = [];
  const tokenDigests = new Set();
  for (let index = 0; index < work.length; index += 1) {
    const item = work[index].candidate;
    const claimTokenDigest = await createClaimTokenDigest({ candidate: item, index, now: at });
    if (!CLAIM_TOKEN_PATTERN.test(claimTokenDigest || '')
      || tokenDigests.has(claimTokenDigest)) {
      throw new Error('Invalid or duplicate FL04C claim token authority');
    }
    tokenDigests.add(claimTokenDigest);
    planned.push({ candidate: item, claimTokenDigest });
  }

  const outcomes = [];
  for (const item of planned) {
    if (signal?.aborted) break;
    const value = await prepareFollowUp({ ...preparation,
      candidate: item.candidate, claimTokenDigest: item.claimTokenDigest,
      now: at, actor });
    outcomes.push(normalizedOutcome(item.candidate.touch_id, value));
  }
  return summary({ selected: selected.length, scheduled: planned.length,
    duplicateCount, attempted: outcomes.length, cancelled: signal?.aborted === true,
    outcomes });
}
