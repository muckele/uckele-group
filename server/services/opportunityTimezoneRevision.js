import { createHash } from 'node:crypto';
import {
  EXPLICIT_TIMEZONE_VERSION,
  STRUCTURED_SOURCE_TIMEZONE_VERSION,
  TIMEZONE_DATASET_DIGEST,
  resolveLocationTimezone,
  resolveOpportunityTimezone,
  timezoneEvidenceDigest,
  validateIanaTimezone,
} from './opportunityTimezone.js';

const allowedFields = new Set([
  'ianaTimezone', 'evidenceType', 'evidenceId', 'note',
  'expectedPriorRevision', 'idempotencyKey',
]);
const evidenceTypes = new Set(['operator-verified']);

function bounded(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value === value.trim();
}

function publicRevision(row) {
  return { revision: row.revision, state: row.state,
    ianaTimezone: row.iana_timezone ?? row.ianaTimezone };
}

/** Protected caller supplies the authenticated actor; only explicit evidence is accepted here. */
export async function appendExplicitOpportunityTimezoneRevision({ storage, opportunityId,
  input, actor, now } = {}) {
  if (!storage || typeof storage.appendOpportunityTimezoneRevision !== 'function') {
    throw new Error('Timezone revision storage is unavailable.');
  }
  if (!bounded(opportunityId, 200) || !bounded(actor, 200)
    || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((field) => !allowedFields.has(field))) {
    return { ok: false, status: 400, reasonCode: 'timezone_invalid' };
  }
  const ianaTimezone = validateIanaTimezone(input.ianaTimezone);
  const evidenceType = input.evidenceType || 'operator-verified';
  const note = input.note ?? '';
  if (!ianaTimezone || !evidenceTypes.has(evidenceType) || !bounded(input.evidenceId, 240)
    || typeof note !== 'string' || note.length > 1000
    || !Number.isSafeInteger(input.expectedPriorRevision) || input.expectedPriorRevision < 0
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey || '')
    || typeof now !== 'string' || !Number.isFinite(Date.parse(now))) {
    return { ok: false, status: 400, reasonCode: 'timezone_invalid' };
  }
  if (typeof storage.getDealHunterOpportunity === 'function'
    && !await storage.getDealHunterOpportunity(opportunityId)) {
    return { ok: false, status: 404, reasonCode: 'opportunity_not_found' };
  }
  const result = await storage.appendOpportunityTimezoneRevision({
    opportunityId, expectedPriorRevision: input.expectedPriorRevision,
    idempotencyKey: input.idempotencyKey, state: 'verified', ianaTimezone,
    evidenceType, evidenceId: input.evidenceId,
    evidenceDigest: timezoneEvidenceDigest({ opportunityId, ianaTimezone, evidenceType,
      evidenceId: input.evidenceId, note }),
    resolverVersion: EXPLICIT_TIMEZONE_VERSION, datasetDigest: TIMEZONE_DATASET_DIGEST,
    actor, now,
  });
  if (result.staleRevision) return { ok: false, status: 409,
    reasonCode: 'stale_timezone_revision',
    currentRevision: result.timezoneRevision?.revision ?? 0 };
  if (!result.applied && !result.replay) throw new Error('Timezone revision result is incomplete.');
  if (!result.timezoneRevision) throw new Error('Timezone revision row is missing.');
  return { ok: true, status: 200, applied: result.applied, replay: result.replay,
    timezone: publicRevision(result.timezoneRevision) };
}

/** Server-only source writer. No client route accepts this evidence class. */
export async function appendStructuredSourceTimezoneRevision({ storage, opportunityId,
  source, expectedPriorRevision, now } = {}) {
  if (typeof storage?.appendOpportunityTimezoneRevision !== 'function') {
    throw new Error('Timezone revision storage is unavailable.');
  }
  if (!Number.isSafeInteger(expectedPriorRevision) || expectedPriorRevision < 0) {
    throw new Error('Expected prior timezone revision is required.');
  }
  const authority = resolveOpportunityTimezone({ opportunityId, source });
  if (!authority.eligible || authority.evidenceType !== 'structured-source') {
    return { ok: false, status: 400, reasonCode: authority.reasonCode || 'timezone_ambiguous' };
  }
  const evidenceDigest = createHash('sha256').update(JSON.stringify([
    'structured-source-timezone:v1', opportunityId, authority.ianaTimezone,
    authority.evidenceId, authority.evidenceDigest, authority.sourceSystem,
    authority.sourceRecordId, authority.sourceVersion,
  ])).digest('hex');
  const idempotencyKey = createHash('sha256').update(JSON.stringify([
    'structured-source-timezone-command:v1', opportunityId, expectedPriorRevision,
    evidenceDigest,
  ])).digest('hex');
  const result = await storage.appendOpportunityTimezoneRevision({
    opportunityId, expectedPriorRevision, idempotencyKey, state: 'verified',
    ianaTimezone: authority.ianaTimezone, evidenceType: 'structured-source',
    evidenceId: authority.evidenceId, evidenceDigest,
    resolverVersion: STRUCTURED_SOURCE_TIMEZONE_VERSION,
    datasetDigest: TIMEZONE_DATASET_DIGEST, actor: 'structured-source-timezone', now,
  });
  if (result.staleRevision) return { ok: false, status: 409,
    reasonCode: 'stale_timezone_revision', currentRevision: result.timezoneRevision?.revision ?? 0 };
  if (!result.timezoneRevision || (!result.applied && !result.replay)) {
    throw new Error('Structured source timezone revision result is incomplete.');
  }
  return { ok: true, status: 200, applied: result.applied, replay: result.replay,
    timezone: publicRevision(result.timezoneRevision) };
}

const DERIVED_EVIDENCE_TYPE = 'target-state';
const DERIVED_ACTOR = 'system-timezone-resolver';
const sendable = (revision) => ['verified', 'derived'].includes(revision?.state);

/**
 * Server-only writer: appends a derived zone from the deal's target state when nothing sendable
 * exists yet. It never writes over a verified or derived revision, so an owner's choice and an
 * earlier derivation always stand. A failed or skipped derivation is not an error.
 */
export async function appendDerivedOpportunityTimezoneRevision({ storage, opportunityId,
  state, location, now } = {}) {
  if (typeof storage?.appendOpportunityTimezoneRevision !== 'function'
    || typeof storage.readPursuitEnrollmentAuthority !== 'function') {
    throw new Error('Timezone revision storage is unavailable.');
  }
  if (!bounded(opportunityId, 200) || typeof now !== 'string' || !Number.isFinite(Date.parse(now))) {
    throw new Error('A derived timezone needs an opportunity id and an instant.');
  }
  const resolved = resolveLocationTimezone({ state, location });
  if (!resolved.eligible) return { written: false, reason: resolved.reasonCode };
  const readLatest = async () =>
    (await storage.readPursuitEnrollmentAuthority({ opportunityId, now }))?.timezone ?? null;
  const evidenceId = `target-state:${resolved.state}`;
  const evidenceDigest = timezoneEvidenceDigest({ opportunityId,
    ianaTimezone: resolved.ianaTimezone, evidenceType: DERIVED_EVIDENCE_TYPE, evidenceId });
  const latest = await readLatest();
  if (sendable(latest)) return { written: false, reason: 'timezone_already_set' };
  if (latest?.evidence_digest === evidenceDigest) return { written: false, reason: 'same_evidence' };
  const expectedPriorRevision = Number(latest?.revision ?? 0);
  const idempotencyKey = createHash('sha256').update(JSON.stringify([
    'derived-timezone-command:v1', opportunityId, expectedPriorRevision, evidenceDigest,
  ])).digest('hex');
  const result = await storage.appendOpportunityTimezoneRevision({
    opportunityId, expectedPriorRevision, idempotencyKey, state: 'derived',
    ianaTimezone: resolved.ianaTimezone, evidenceType: DERIVED_EVIDENCE_TYPE, evidenceId,
    evidenceDigest, resolverVersion: resolved.resolverVersion,
    datasetDigest: TIMEZONE_DATASET_DIGEST, actor: DERIVED_ACTOR, now,
  });
  if (result.staleRevision) {
    // Someone else wrote first. Look once more so an owner's revision is respected, then stop.
    return { written: false, reason: sendable(await readLatest())
      ? 'timezone_already_set' : 'stale_timezone_revision' };
  }
  if (result.applied) return { written: true, reason: 'written' };
  if (result.replay) return { written: false, reason: 'replay' };
  throw new Error('Derived timezone revision result is incomplete.');
}
