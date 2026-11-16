import { createHash } from 'node:crypto';
import { importOutreachDelta, sourceSafetyRunId } from './cimSafetyIdentity.js';
import {
  getOpportunitySourceObservationRecordId,
  normalizeDealHunterSourceSnapshotSteps,
  normalizeOpportunitySourceObservationSnapshot,
  normalizeSourceFreshnessEvidence,
} from './dealHunterOpportunityFacts.js';
import { createEventLoopSlicer, runSteps, runStepsInSlices } from '../utils/eventLoopSlices.js';

// A source-wide replacement can delete every current observation for one
// source. Issuance is intentionally private to this collector-owned module:
// callers may consume an opaque admission through storage, but no general API
// can turn an arbitrary normalized `{ source_id, records }` payload into one.
// A database cannot independently prove a remote Sheet fetch was complete
// without a durable ingestion ledger or provider-owned fetch, neither of
// which belongs in this Phase 1 boundary.
const completeGoogleSheetSourceSnapshotPolicy = 'complete-google-sheet-source-snapshot-v1';
const completeGoogleSheetSourceSnapshotAdmissions = new WeakMap();

// The functions below that end in `Steps` are step generators (see utils/eventLoopSlices.js):
// a full Sheet is thousands of records, so the collector runs them in event-loop slices.
// Each has a synchronous form with the same result for callers that need one.

export function normalizeCompleteGoogleSheetFreshnessSnapshot(snapshot = {}) {
  return runSteps(normalizeCompleteGoogleSheetFreshnessSnapshotSteps(snapshot));
}

function* normalizeCompleteGoogleSheetFreshnessSnapshotSteps(snapshot = {}) {
  const unresolved = Array.isArray(snapshot.unresolved) ? snapshot.unresolved.map((item) => {
    const source_record_id = String(item?.source_record_id || '').trim();
    const identity_exception_id = String(item?.identity_exception_id || '').trim();
    if (!source_record_id || source_record_id.length > 200
      || !identity_exception_id || identity_exception_id.length > 240) {
      throw new Error('Deferred Sheet record needs a bounded source record and identity exception.');
    }
    return { source_record_id, identity_exception_id,
      freshness_evidence: normalizeSourceFreshnessEvidence(item.freshness_evidence) };
  }) : [];
  if (unresolved.length === 0) {
    return { ...(yield* normalizeDealHunterSourceSnapshotSteps(snapshot)), unresolved };
  }
  const source_id = String(snapshot.source_id || '').trim();
  const source_name = String(snapshot.source_name || '').trim();
  const records = [];
  for (const record of Array.isArray(snapshot.records) ? snapshot.records : []) {
    records.push(normalizeOpportunitySourceObservationSnapshot(record));
    yield;
  }
  if (!source_id || source_id.length > 160 || !source_name || source_name.length > 220
    || records.length + unresolved.length > 10_000
    || records.some((record) => record.source_id !== source_id || record.source_name !== source_name)) {
    throw new Error('Deferred Sheet scope is malformed.');
  }
  const ids = [...records.map((record) => record.source_record_id), ...unresolved.map((item) => item.source_record_id)];
  if (new Set(ids).size !== ids.length) throw new Error('Deferred Sheet scope has duplicate source records.');
  return { source_id, source_name, records, unresolved };
}

function completeGoogleSheetSourceSlot(sourceId) {
  const match = /^sheet-(0|[1-9][0-9]*)$/.exec(String(sourceId || ''));
  if (!match) throw new Error('Complete Google Sheet source snapshot admission requires a deterministic Sheet source slot.');
  const sourceSlot = Number(match[1]);
  if (!Number.isSafeInteger(sourceSlot) || sourceSlot > 9999) {
    throw new Error('Complete Google Sheet source snapshot admission requires a configured Sheet source slot.');
  }
  return sourceSlot;
}

function sourceSnapshotAdmissionText(value) {
  // PostgreSQL's base64 encoder inserts RFC 2045 line breaks for long values;
  // hexadecimal is delimiter-safe and byte-for-byte identical across Node and
  // PostgreSQL without a line-wrapping normalization step.
  return Buffer.from(String(value), 'utf8').toString('hex');
}

// PostgreSQL's core `md5` lets the SECURITY DEFINER RPC recompute this exact
// canonical token without relying on an optional extension. It is a
// consistency checksum, not the authorization secret: the unforgeable,
// one-shot in-process capability is the authorization layer.
//
// The token is `parts.join('|')`; at production scale it is tens of megabytes. It is hashed as it
// is built, one record at a time, which feeds MD5 exactly the bytes of the joined string (every
// part is ASCII), so the digest is unchanged.
function* completeGoogleSheetSourceSnapshotDigestSteps(snapshot) {
  const sourceSlot = completeGoogleSheetSourceSlot(snapshot.source_id);
  const observationCount = snapshot.records.reduce((count, record) => count + record.observations.length, 0);
  const hash = createHash('md5');
  let started = false;
  const append = (parts) => {
    hash.update(`${started ? '|' : ''}${parts.join('|')}`);
    started = true;
  };
  append([
    completeGoogleSheetSourceSnapshotPolicy,
    sourceSnapshotAdmissionText(snapshot.source_id),
    sourceSnapshotAdmissionText(snapshot.source_name),
    String(sourceSlot),
    String(snapshot.records.length),
    String(observationCount),
  ]);
  for (const record of snapshot.records) {
    const parts = [
      'r',
      sourceSnapshotAdmissionText(record.opportunity_id),
      sourceSnapshotAdmissionText(record.source_id),
      sourceSnapshotAdmissionText(record.source_name),
      sourceSnapshotAdmissionText(record.source_record_id),
      String(record.observations.length),
    ];
    for (const observation of record.observations) {
      parts.push(
        'o',
        sourceSnapshotAdmissionText(observation.id),
        sourceSnapshotAdmissionText(observation.opportunity_id),
        sourceSnapshotAdmissionText(observation.source_id),
        sourceSnapshotAdmissionText(observation.source_name),
        sourceSnapshotAdmissionText(observation.source_record_id),
        sourceSnapshotAdmissionText(observation.field),
        sourceSnapshotAdmissionText(observation.value),
        sourceSnapshotAdmissionText(observation.observed_at),
        sourceSnapshotAdmissionText(observation.created_at),
        sourceSnapshotAdmissionText(observation.updated_at),
      );
    }
    append(parts);
    yield;
  }
  for (const item of snapshot.unresolved || []) {
    append(['u', sourceSnapshotAdmissionText(item.source_record_id),
      sourceSnapshotAdmissionText(item.identity_exception_id),
      sourceSnapshotAdmissionText(JSON.stringify(item.freshness_evidence))]);
  }
  return hash.digest('hex');
}

// MD5 of `JSON.stringify(value)` where value is an array or `{ records, unresolved }`, fed one
// record at a time. JSON.stringify of an array is '[' + its elements' JSON joined by ',' + ']',
// so the hashed bytes, and the digest, are exactly those of the single call.
function* jsonMd5Steps(value) {
  const hash = createHash('md5');
  const records = Array.isArray(value) ? value : value.records;
  if (!Array.isArray(value)) hash.update('{"records":');
  hash.update('[');
  for (const [index, record] of records.entries()) {
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(record) ?? 'null');
    yield;
  }
  hash.update(']');
  if (!Array.isArray(value)) hash.update(`,"unresolved":${JSON.stringify(value.unresolved)}}`);
  return hash.digest('hex');
}

function* completeGoogleSheetSourceSnapshotAdmissionMetadataSteps(snapshot) {
  const source_record_ids = [
    ...snapshot.records.map((record) => record.source_record_id),
    ...(snapshot.unresolved || []).map((item) => item.source_record_id),
  ].sort();
  const run = snapshot.run || null;
  if (run && (run.sourceId !== snapshot.source_id || typeof run.runId !== 'string'
    || !run.runId || run.runId.length > 200 || !Number.isSafeInteger(run.generation)
    || run.generation < 1)) {
    throw new Error('Complete Sheet freshness run is not an allocated bounded source run.');
  }
  const freshnessPayloadHash = run
    ? yield* jsonMd5Steps(snapshot.unresolved?.length
      ? { records: snapshot.records, unresolved: snapshot.unresolved } : snapshot.records)
    : null;
  // Evaluated in the order the single object literal evaluated them, so a bad slot still
  // throws before the fingerprint is built.
  const source_slot = completeGoogleSheetSourceSlot(snapshot.source_id);
  const record_count = snapshot.records.length + (snapshot.unresolved?.length || 0);
  const observation_count = snapshot.records.reduce((count, record) => count + record.observations.length, 0);
  const snapshotDigest = yield* completeGoogleSheetSourceSnapshotDigestSteps(snapshot);
  return Object.freeze({
    policy: completeGoogleSheetSourceSnapshotPolicy,
    source_id: snapshot.source_id,
    source_name: snapshot.source_name,
    source_slot,
    record_count,
    ...(run ? {
      resolved_count: snapshot.records.length,
      deferred_count: snapshot.unresolved?.length || 0,
    } : {}),
    observation_count,
    source_record_ids: Object.freeze(source_record_ids),
    snapshot_digest: snapshotDigest,
    ...(run ? {
      run: Object.freeze({ sourceId: run.sourceId, runId: run.runId, generation: run.generation }),
      freshness_digest: freshnessPayloadHash + createHash('md5')
        .update(`${freshnessPayloadHash}${run.runId}${run.generation}`).digest('hex'),
    } : {}),
  });
}

function* mintCompleteGoogleSheetSourceSnapshotAdmissionSteps(snapshot) {
  const admission = yield* completeGoogleSheetSourceSnapshotAdmissionMetadataSteps(snapshot);
  completeGoogleSheetSourceSnapshotAdmissions.set(admission, admission);
  return admission;
}

function* verifiedCompleteGoogleSheetSourceSnapshotSteps({ reviewMode, sourceResult, records, unresolved = [], run } = {}) {
  if (reviewMode !== 'full-backfill') return null;
  if (!run) return null;
  const source = sourceResult?.source || {};
  if (source.required !== true && source.sourceRole !== 'required-primary') return null;
  const sourceId = String(source.id || '').trim();
  if (!sourceId) return null;
  try {
    completeGoogleSheetSourceSlot(sourceId);
  } catch {
    return null;
  }

  const collectedDeals = Array.isArray(sourceResult?.deals) ? sourceResult.deals : [];
  const sourceRowCount = Number(source.sourceRowCount);
  const rowCount = Number(source.rowCount);
  if (
    !source.fetched
    || source.error
    || source.listingUrlSourceUnavailable
    || source.coverageLimitReached
    || !Number.isInteger(sourceRowCount)
    || !Number.isInteger(rowCount)
    || sourceRowCount <= 0
    || sourceRowCount !== rowCount
    || collectedDeals.length !== sourceRowCount
  ) {
    return null;
  }

  const expectedRecordIds = new Set();
  let sourceName = '';
  for (const deal of collectedDeals) {
    if (String(deal?.sourceId || '').trim() !== sourceId) return null;
    let sourceRecordId = '';
    try {
      sourceRecordId = getOpportunitySourceObservationRecordId(deal);
    } catch {
      return null;
    }
    const dealSourceName = String(deal?.sourceName || '').trim();
    if (!sourceRecordId || !dealSourceName || expectedRecordIds.has(sourceRecordId)) return null;
    if (sourceName && sourceName !== dealSourceName) return null;
    sourceName = dealSourceName;
    expectedRecordIds.add(sourceRecordId);
    yield;
  }
  if (expectedRecordIds.size !== sourceRowCount) return null;

  let snapshot;
  try {
    snapshot = yield* normalizeCompleteGoogleSheetFreshnessSnapshotSteps({
      source_id: sourceId,
      source_name: sourceName,
      records,
      unresolved,
    });
  } catch {
    return null;
  }
  if (
    snapshot.records.length + snapshot.unresolved.length !== expectedRecordIds.size
    || snapshot.source_id !== sourceId
    || snapshot.source_name !== sourceName
  ) {
    return null;
  }
  const representedRecordIds = new Set([
    ...snapshot.records.map((record) => record.source_record_id),
    ...snapshot.unresolved.map((item) => item.source_record_id),
  ]);
  if (
    representedRecordIds.size !== expectedRecordIds.size
    || [...expectedRecordIds].some((sourceRecordId) => !representedRecordIds.has(sourceRecordId))
  ) {
    return null;
  }
  return { ...snapshot, ...(run ? { run } : {}) };
}

/**
 * The sole source-wide entry point for the collector. It reconstructs the
 * complete authoritative raw Sheet identity set and compares it to the exact
 * already-resolved canonical records before privately minting and immediately
 * consuming a one-use storage admission. It never returns the admission.
 */
export async function reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
  storage,
  reviewMode,
  sourceResult,
  records,
  unresolved = [],
  run,
} = {}) {
  if (typeof storage?.replaceAdmittedCompleteGoogleSheetSourceSnapshot !== 'function') {
    return { reconciled: false };
  }
  const slicer = createEventLoopSlicer();
  const snapshot = await runStepsInSlices(
    verifiedCompleteGoogleSheetSourceSnapshotSteps({ reviewMode, sourceResult, records, unresolved, run }),
    slicer,
  );
  if (!snapshot) return { reconciled: false };

  const admission = await runStepsInSlices(mintCompleteGoogleSheetSourceSnapshotAdmissionSteps(snapshot), slicer);
  // Outreach created between these two reads is reported as this import's; it is a diagnostic.
  // The replacement checks its admission in event-loop slices and may wait for running storage
  // calls before it takes the connection, and `after` may wait behind another section, so
  // outreach other flows create in those gaps can be counted too. Calls queued behind this
  // replacement do not run before `after` is read.
  const before = typeof storage.readCimOutreachCounters === 'function'
    ? await storage.readCimOutreachCounters() : null;
  await storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot({ ...snapshot, admission });
  const after = before ? await storage.readCimOutreachCounters() : null;
  const safetyRunId = run ? sourceSafetyRunId(run.sourceId, run.runId) : null;
  const events = safetyRunId && typeof storage.listCimSafetyEvents === 'function'
    ? await storage.listCimSafetyEvents({ safetyRunId }) : null;
  const states = safetyRunId && typeof storage.listDealHunterSourceFreshnessStates === 'function'
    ? await storage.listDealHunterSourceFreshnessStates() : [];
  const sourceState = states.find((state) => state.source_id === snapshot.source_id);
  return { reconciled: true, identityExceptionsPending: snapshot.unresolved.length,
    ...(safetyRunId ? { safetyRunId, safetyAsOf: sourceState?.accepted_at || null,
      safetyEventsEmitted: events?.length ?? null } : {}),
    ...importOutreachDelta(before, after),
  };
}

/**
 * Storage adapters consume a collector-issued admission exactly once before
 * opening a SQLite transaction or invoking a Supabase RPC. The private mint
 * path above is the only supported way to create this opaque capability.
 */
export function consumeCompleteGoogleSheetSourceSnapshotAdmission({ admission, snapshot } = {}) {
  return runSteps(consumeCompleteGoogleSheetSourceSnapshotAdmissionSteps({ admission, snapshot })).admission;
}

/**
 * The same consumption in event-loop slices. Resolves with the consumed admission and the
 * normalized snapshot it was checked against, which is exactly
 * `normalizeCompleteGoogleSheetFreshnessSnapshot(snapshot)`, so the adapter can write the very
 * copy that was verified. The admission is spent before the first slice ends.
 */
export function consumeCompleteGoogleSheetSourceSnapshotAdmissionInSlices({ admission, snapshot } = {}, slicer = undefined) {
  return runStepsInSlices(consumeCompleteGoogleSheetSourceSnapshotAdmissionSteps({ admission, snapshot }), slicer);
}

function* consumeCompleteGoogleSheetSourceSnapshotAdmissionSteps({ admission, snapshot } = {}) {
  const issued = admission && typeof admission === 'object'
    ? completeGoogleSheetSourceSnapshotAdmissions.get(admission)
    : null;
  if (!issued) throw new Error('Complete Google Sheet source snapshot admission is required.');

  // A recognized capability is single-attempt as well as single-success. If a
  // caller presents it with a tampered payload, fail closed rather than leave
  // it reusable for a later source-wide mutation attempt.
  completeGoogleSheetSourceSnapshotAdmissions.delete(admission);

  const normalizedSnapshot = yield* normalizeCompleteGoogleSheetFreshnessSnapshotSteps(snapshot);
  const actual = yield* completeGoogleSheetSourceSnapshotAdmissionMetadataSteps({ ...normalizedSnapshot, run: snapshot.run });
  const matches = (
    actual.policy === issued.policy
    && actual.source_id === issued.source_id
    && actual.source_name === issued.source_name
    && actual.source_slot === issued.source_slot
    && actual.record_count === issued.record_count
    && actual.resolved_count === issued.resolved_count
    && actual.deferred_count === issued.deferred_count
    && actual.observation_count === issued.observation_count
    && actual.snapshot_digest === issued.snapshot_digest
    && actual.freshness_digest === issued.freshness_digest
    && actual.source_record_ids.length === issued.source_record_ids.length
    && actual.source_record_ids.every((sourceRecordId, index) => sourceRecordId === issued.source_record_ids[index])
  );
  if (!matches) throw new Error('Complete Google Sheet source snapshot admission does not match the normalized source payload.');

  return {
    admission: {
      policy: issued.policy,
      source_id: issued.source_id,
      source_name: issued.source_name,
      source_slot: issued.source_slot,
      record_count: issued.record_count,
      ...(issued.run ? { resolved_count: issued.resolved_count, deferred_count: issued.deferred_count } : {}),
      observation_count: issued.observation_count,
      source_record_ids: [...issued.source_record_ids],
      snapshot_digest: issued.snapshot_digest,
      ...(issued.run ? { run: issued.run, freshness_digest: issued.freshness_digest } : {}),
    },
    normalizedSnapshot,
  };
}
