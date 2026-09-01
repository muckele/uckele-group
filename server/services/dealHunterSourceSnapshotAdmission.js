import { createHash } from 'node:crypto';
import {
  getOpportunitySourceObservationRecordId,
  normalizeDealHunterSourceSnapshot,
} from './dealHunterOpportunityFacts.js';

// A source-wide replacement can delete every current observation for one
// source. Issuance is intentionally private to this collector-owned module:
// callers may consume an opaque admission through storage, but no general API
// can turn an arbitrary normalized `{ source_id, records }` payload into one.
// A database cannot independently prove a remote Sheet fetch was complete
// without a durable ingestion ledger or provider-owned fetch, neither of
// which belongs in this Phase 1 boundary.
const completeGoogleSheetSourceSnapshotPolicy = 'complete-google-sheet-source-snapshot-v1';
const completeGoogleSheetSourceSnapshotAdmissions = new WeakMap();

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
function completeGoogleSheetSourceSnapshotFingerprint(snapshot) {
  const sourceSlot = completeGoogleSheetSourceSlot(snapshot.source_id);
  const observationCount = snapshot.records.reduce((count, record) => count + record.observations.length, 0);
  const parts = [
    completeGoogleSheetSourceSnapshotPolicy,
    sourceSnapshotAdmissionText(snapshot.source_id),
    sourceSnapshotAdmissionText(snapshot.source_name),
    String(sourceSlot),
    String(snapshot.records.length),
    String(observationCount),
  ];
  for (const record of snapshot.records) {
    parts.push(
      'r',
      sourceSnapshotAdmissionText(record.opportunity_id),
      sourceSnapshotAdmissionText(record.source_id),
      sourceSnapshotAdmissionText(record.source_name),
      sourceSnapshotAdmissionText(record.source_record_id),
      String(record.observations.length),
    );
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
  }
  return parts.join('|');
}

function completeGoogleSheetSourceSnapshotAdmissionMetadata(snapshot) {
  const source_record_ids = snapshot.records.map((record) => record.source_record_id).sort();
  return Object.freeze({
    policy: completeGoogleSheetSourceSnapshotPolicy,
    source_id: snapshot.source_id,
    source_name: snapshot.source_name,
    source_slot: completeGoogleSheetSourceSlot(snapshot.source_id),
    record_count: snapshot.records.length,
    observation_count: snapshot.records.reduce((count, record) => count + record.observations.length, 0),
    source_record_ids: Object.freeze(source_record_ids),
    snapshot_digest: createHash('md5').update(completeGoogleSheetSourceSnapshotFingerprint(snapshot)).digest('hex'),
  });
}

function mintCompleteGoogleSheetSourceSnapshotAdmission(snapshot) {
  const admission = completeGoogleSheetSourceSnapshotAdmissionMetadata(snapshot);
  completeGoogleSheetSourceSnapshotAdmissions.set(admission, admission);
  return admission;
}

function verifiedCompleteGoogleSheetSourceSnapshot({ reviewMode, sourceResult, records } = {}) {
  if (reviewMode !== 'full-backfill') return null;
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
  }
  if (expectedRecordIds.size !== sourceRowCount) return null;

  let snapshot;
  try {
    snapshot = normalizeDealHunterSourceSnapshot({
      source_id: sourceId,
      source_name: sourceName,
      records,
    });
  } catch {
    return null;
  }
  if (
    snapshot.records.length !== expectedRecordIds.size
    || snapshot.source_id !== sourceId
    || snapshot.source_name !== sourceName
  ) {
    return null;
  }
  const representedRecordIds = new Set(snapshot.records.map((record) => record.source_record_id));
  if (
    representedRecordIds.size !== expectedRecordIds.size
    || [...expectedRecordIds].some((sourceRecordId) => !representedRecordIds.has(sourceRecordId))
  ) {
    return null;
  }
  return snapshot;
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
} = {}) {
  if (typeof storage?.replaceAdmittedCompleteGoogleSheetSourceSnapshot !== 'function') {
    return { reconciled: false };
  }
  const snapshot = verifiedCompleteGoogleSheetSourceSnapshot({ reviewMode, sourceResult, records });
  if (!snapshot) return { reconciled: false };

  const admission = mintCompleteGoogleSheetSourceSnapshotAdmission(snapshot);
  await storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot({ ...snapshot, admission });
  return { reconciled: true };
}

/**
 * Storage adapters consume a collector-issued admission exactly once before
 * opening a SQLite transaction or invoking a Supabase RPC. The private mint
 * path above is the only supported way to create this opaque capability.
 */
export function consumeCompleteGoogleSheetSourceSnapshotAdmission({ admission, snapshot } = {}) {
  const issued = admission && typeof admission === 'object'
    ? completeGoogleSheetSourceSnapshotAdmissions.get(admission)
    : null;
  if (!issued) throw new Error('Complete Google Sheet source snapshot admission is required.');

  // A recognized capability is single-attempt as well as single-success. If a
  // caller presents it with a tampered payload, fail closed rather than leave
  // it reusable for a later source-wide mutation attempt.
  completeGoogleSheetSourceSnapshotAdmissions.delete(admission);

  const normalizedSnapshot = normalizeDealHunterSourceSnapshot(snapshot);
  const actual = completeGoogleSheetSourceSnapshotAdmissionMetadata(normalizedSnapshot);
  const matches = (
    actual.policy === issued.policy
    && actual.source_id === issued.source_id
    && actual.source_name === issued.source_name
    && actual.source_slot === issued.source_slot
    && actual.record_count === issued.record_count
    && actual.observation_count === issued.observation_count
    && actual.snapshot_digest === issued.snapshot_digest
    && actual.source_record_ids.length === issued.source_record_ids.length
    && actual.source_record_ids.every((sourceRecordId, index) => sourceRecordId === issued.source_record_ids[index])
  );
  if (!matches) throw new Error('Complete Google Sheet source snapshot admission does not match the normalized source payload.');

  return {
    policy: issued.policy,
    source_id: issued.source_id,
    source_name: issued.source_name,
    source_slot: issued.source_slot,
    record_count: issued.record_count,
    observation_count: issued.observation_count,
    source_record_ids: [...issued.source_record_ids],
    snapshot_digest: issued.snapshot_digest,
  };
}
