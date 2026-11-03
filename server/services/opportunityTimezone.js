import { createHash } from 'node:crypto';
import { targetStatesIn } from './targetStates.js';

export const TIMEZONE_RESOLVER_VERSION = 'target-state-v1';
// Every target state sits wholly in one zone except the exception places below, which the
// resolver refuses instead of guessing.
export const TARGET_STATE_TIMEZONES = Object.freeze({
  NY: 'America/New_York',
  NJ: 'America/New_York',
  CT: 'America/New_York',
  CA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  AZ: 'America/Phoenix',
});
export const TIMEZONE_EXCEPTIONS = Object.freeze({
  NV: Object.freeze(['west wendover', 'jackpot']),
  AZ: Object.freeze(['navajo', 'window rock', 'tuba city', 'kayenta', 'chinle']),
});
export const TIMEZONE_DATASET_DIGEST = createHash('sha256').update(JSON.stringify({
  zones: TARGET_STATE_TIMEZONES, exceptions: TIMEZONE_EXCEPTIONS })).digest('hex');
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

const collapse = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const targetStateCodes = Object.freeze(Object.keys(TARGET_STATE_TIMEZONES));

/**
 * Derives a zone from the deal's state and location text. Exactly one target state must be
 * named across both inputs and no exception place may appear; anything else is refused.
 */
export function resolveLocationTimezone({ state, location } = {}) {
  const stateText = collapse(state);
  const locationText = collapse(location);
  const refuse = (reasonCode) => ({ eligible: false, reasonCode,
    resolverVersion: TIMEZONE_RESOLVER_VERSION });
  const found = new Set([...targetStatesIn(stateText, targetStateCodes),
    ...targetStatesIn(locationText, targetStateCodes)]);
  // A state field that names no target state still disagrees with a target state found in the text.
  const outsideState = stateText !== '' && targetStatesIn(stateText, targetStateCodes).length === 0;
  if (found.size === 0) return refuse('timezone_missing');
  if (found.size > 1 || outsideState) return refuse('timezone_ambiguous');
  const [code] = found;
  const lowered = locationText.toLowerCase();
  if (Object.values(TIMEZONE_EXCEPTIONS).flat().some((place) => lowered.includes(place))) {
    return refuse('timezone_ambiguous');
  }
  return { eligible: true, ianaTimezone: TARGET_STATE_TIMEZONES[code], state: code,
    resolverVersion: TIMEZONE_RESOLVER_VERSION };
}

/**
 * Evidence digest for a derived (target-state) revision. It covers the normalized inputs the
 * resolver read, not its result, so changed inputs that derive the same zone are new evidence:
 * the state field's target-state code(s), the collapsed lower-case location text, and the
 * resolver version.
 */
export function derivedTimezoneEvidenceDigest({ opportunityId, state, location } = {}) {
  const stateCodes = [...targetStatesIn(collapse(state), targetStateCodes)].sort();
  const locationText = collapse(location).toLowerCase();
  return createHash('sha256').update(JSON.stringify([
    'target-state-timezone-evidence:v1', opportunityId, TIMEZONE_RESOLVER_VERSION, stateCodes, locationText,
  ])).digest('hex');
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
