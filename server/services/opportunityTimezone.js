import { createHash } from 'node:crypto';

export const TIMEZONE_RESOLVER_VERSION = 'location-resolver-disabled-v1';
export const TIMEZONE_DATASET_DIGEST = '0'.repeat(64);
export const EXPLICIT_TIMEZONE_VERSION = 'explicit-v1';
export const STRUCTURED_SOURCE_TIMEZONE_VERSION = 'structured-source-v1';

export function validateIanaTimezone(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 120
    || (value !== 'UTC'
      && !/^[A-Za-z][A-Za-z_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function resolveLocationTimezone() {
  return { eligible: false, reasonCode: 'timezone_ambiguous',
    resolverVersion: TIMEZONE_RESOLVER_VERSION, datasetDigest: TIMEZONE_DATASET_DIGEST };
}

function authority(fact, evidenceType, opportunityId) {
  if (!fact) return null;
  if (typeof opportunityId !== 'string' || !opportunityId
    || fact.opportunityId !== opportunityId) return null;
  const zone = validateIanaTimezone(fact.ianaTimezone);
  if (!zone || typeof fact.evidenceId !== 'string' || !fact.evidenceId.trim()
    || !/^[0-9a-f]{64}$/.test(fact.evidenceDigest || '')) return null;
  if (evidenceType === 'structured-source'
    && ![fact.sourceSystem, fact.sourceRecordId, fact.sourceVersion]
      .every((value) => typeof value === 'string' && value.length > 0 && value === value.trim())) {
    return null;
  }
  return { eligible: true, ianaTimezone: zone, evidenceType, evidenceId: fact.evidenceId,
    evidenceDigest: fact.evidenceDigest,
    resolverVersion: evidenceType === 'structured-source'
      ? STRUCTURED_SOURCE_TIMEZONE_VERSION : EXPLICIT_TIMEZONE_VERSION,
    datasetDigest: fact.datasetDigest || TIMEZONE_DATASET_DIGEST,
    revision: fact.revision ?? null,
    ...(evidenceType === 'structured-source' ? { sourceSystem: fact.sourceSystem,
      sourceRecordId: fact.sourceRecordId, sourceVersion: fact.sourceVersion } : {}) };
}

export function resolveOpportunityTimezone({ opportunityId, operator, source, location } = {}) {
  if (operator?.verified === true && operator.opportunityId === opportunityId) {
    const selected = authority(operator, 'operator-verified', opportunityId);
    return selected || { eligible: false, reasonCode: 'timezone_ambiguous' };
  }
  if (source?.opportunityId === opportunityId) {
    const selected = authority(source, 'structured-source', opportunityId);
    return selected || { eligible: false, reasonCode: 'timezone_ambiguous' };
  }
  if (location) {
    if (!Object.values(location).some((value) => typeof value === 'string' && value.trim())) {
      return { eligible: false, reasonCode: 'timezone_missing' };
    }
    return resolveLocationTimezone(location);
  }
  return { eligible: false, reasonCode: 'timezone_missing' };
}

export function selectCampaignTimezoneAuthority(authorityResult) {
  if (!authorityResult?.eligible || !Number.isSafeInteger(authorityResult.revision)
    || authorityResult.revision < 1) {
    return { eligible: false, reasonCode: authorityResult?.reasonCode || 'timezone_missing' };
  }
  return { eligible: true, ianaTimezone: authorityResult.ianaTimezone,
    timezoneRevision: authorityResult.revision, evidenceType: authorityResult.evidenceType,
    evidenceId: authorityResult.evidenceId, evidenceDigest: authorityResult.evidenceDigest,
    resolverVersion: authorityResult.resolverVersion,
    datasetDigest: authorityResult.datasetDigest };
}

export function evaluateCampaignTimezoneChange({ selectedRevision, currentRevision,
  initialAcceptedAt } = {}) {
  if (!Number.isSafeInteger(selectedRevision) || !Number.isSafeInteger(currentRevision)
    || selectedRevision < 1 || currentRevision < 1) {
    return { eligible: false, action: 'review', reasonCode: 'timezone_missing' };
  }
  if (selectedRevision === currentRevision) return { eligible: true, action: 'keep' };
  if (initialAcceptedAt) return { eligible: false, action: 'review', reasonCode: 'timezone_changed' };
  return { eligible: true, action: 'recompute', timezoneRevision: currentRevision };
}

export function timezoneEvidenceDigest({ opportunityId, ianaTimezone, evidenceType,
  evidenceId, note = '' }) {
  return createHash('sha256').update(JSON.stringify([
    'timezone-evidence:v1', opportunityId, ianaTimezone, evidenceType, evidenceId, note,
  ])).digest('hex');
}
