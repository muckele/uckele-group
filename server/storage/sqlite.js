import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  normalizeDealHunterSourceSnapshot,
  normalizeSourceFreshnessEvidence,
  normalizeOperatorOpportunityFactRecord,
  normalizeOpportunitySourceObservation,
  normalizeOpportunitySourceObservationSnapshot,
} from '../services/dealHunterOpportunityFacts.js';
import {
  firstStrictDetailAuthorityTimestamp,
  strictDetailAuthorityTimestampSortKey,
} from '../services/detailAuthorityTimestamp.js';
import {
  normalizeCanonicalCimRequestId,
  requireCanonicalCimRequestId,
} from '../services/cimRequestIdPolicy.js';
import {
  buildManualFollowUpCommunicationId,
  buildManualFollowUpMarker,
  MANUAL_FOLLOW_UP_CADENCE,
  MANUAL_FOLLOW_UP_MAXIMUM,
  MANUAL_FOLLOW_UP_MODE,
  MANUAL_FOLLOW_UP_VERSION,
  nextManualFollowUpAt,
} from '../services/dealHunterManualFollowUpPolicy.js';
import { consumeCompleteGoogleSheetSourceSnapshotAdmission, normalizeCompleteGoogleSheetFreshnessSnapshot } from '../services/dealHunterSourceSnapshotAdmission.js';
import { normalizeDealHunterListingIdentity } from '../services/dealHunterListingIdentity.js';
import { CrmSubmissionSupersededError } from '../services/crmSubmissionSupersession.js';
import { buildFreshInboxAreas, classifyFreshInboxCandidate } from '../services/dealHunterFreshInboxPolicy.js';

function acceptedPublicationClaim(claim, acceptedAt) {
  if (!claim || claim.meaning !== 'listing_publication') {
    return { state: 'unknown', date: null, instant: null };
  }
  const raw = String(claim.rawValue || '').trim();
  const acceptedDate = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(acceptedAt)).map((part) => [part.type, part.value]));
  const today = `${acceptedDate.year}-${acceptedDate.month}-${acceptedDate.day}`;
  if (claim.precision === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw) {
      return { state: raw > today ? 'future' : 'valid', date: raw, instant: null };
    }
  }
  if (claim.precision === 'datetime' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const instant = new Date(raw);
    if (!Number.isNaN(instant.getTime())) {
      return { state: instant.getTime() > Date.parse(acceptedAt) ? 'future' : 'valid',
        date: null, instant: instant.toISOString() };
    }
  }
  return { state: 'invalid', date: null, instant: null };
}

function freshnessReviewExpectedPair(input = {}) {
  const hasDiscovery = input.expectedDiscoveryRevision !== undefined;
  const hasMaterial = input.expectedMaterialRevision !== undefined;
  if (hasDiscovery !== hasMaterial) throw new Error('Freshness review requires both expected revisions.');
  if (!hasDiscovery) return null;
  const discovery = Number(input.expectedDiscoveryRevision);
  const material = Number(input.expectedMaterialRevision);
  if (!Number.isSafeInteger(discovery) || discovery < 0
    || !Number.isSafeInteger(material) || material < 0) {
    throw new Error('Freshness review revisions must be nonnegative integers.');
  }
  return { discovery, material };
}

function assertFreshnessReviewCurrent(opportunity, expected) {
  if (!expected) return;
  if (opportunity.discovery_revision === expected.discovery
    && opportunity.material_revision === expected.material) return;
  const error = new Error('Freshness changed since this opportunity was shown. Reload before acting.');
  error.code = 'DEAL_HUNTER_FRESHNESS_STALE';
  error.status = 409;
  throw error;
}
import {
  buildCanonicalOpportunityMergePlan,
  canonicalOpportunityMergeManifestId,
  CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
  CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA,
  CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY,
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE,
  canonicalOpportunityMergeRelationshipSchemaPresenceByTable,
  getCanonicalOpportunityMergeApproval,
  isCanonicalOpportunityMergeRelationshipColumn,
  stableCanonicalJson,
  validateCanonicalOpportunityMergeReplayManifest,
} from '../repairs/canonicalOpportunityMerge.js';
import {
  buildCrmDuplicateConsolidationPlan,
  buildCrmDuplicateConsolidationRuntimeSafetyAuthority,
  canonicalJsonSha256,
  classifyCrmDuplicateConsolidationTextReference,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR,
  CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
  crmDuplicateConsolidationFinancialEvidenceMatches,
  crmDuplicateConsolidationManifestId,
  crmDuplicateConsolidationRawStringMatchesSha256,
  crmDuplicateConsolidationRelationId,
  findCrmDuplicateConsolidationUnclassifiedSchema,
  inspectCrmDuplicateConsolidationMarketplaceIdentity,
  assertCrmDuplicateConsolidationRuntimeSafetyAuthorityMatches,
  selectCrmDuplicateConsolidationConfigAuthority,
  stableCanonicalJson as stableCrmDuplicateConsolidationJson,
  validateCrmDuplicateConsolidationReceipt,
} from '../repairs/crmDuplicateConsolidation.js';
import { normalizeLeadType, normalizeSbaEligibility } from '../services/workflow.js';

function parseJsonColumn(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const scheduledJobStatuses = new Set(['pending', 'transmitting', 'failed', 'ambiguous', 'completed']);
const scheduledJobClaimReasons = new Set([
  'claimed', 'active', 'retry-not-due', 'not-owner', 'wrong-state', 'completed', 'missing',
]);
const scheduledJobImmutableMetadataFields = [
  'preparedEnvelope',
  'payloadDigest',
  'firstPreparedAt',
  'preparedAt',
  'businessDate',
  'pacificDate',
  'dateKey',
  'timezone',
  'notificationType',
];
const scheduledJobTransitions = new Map([
  ['pending', new Set(['pending', 'transmitting', 'failed', 'ambiguous', 'completed'])],
  ['transmitting', new Set(['failed', 'ambiguous', 'completed'])],
  ['failed', new Set()],
  ['ambiguous', new Set(['completed'])],
  ['completed', new Set()],
]);
const scheduledJobClaimTokenPattern = /^[A-Za-z0-9_-]{16,200}$/;
const scheduledJobRetryDelayMs = 30 * 60 * 1000;
const scheduledJobMetadataMaxBytes = 512 * 1024;

function normalizeScheduledJobText(value, fieldName, maxLength, { required = true } = {}) {
  if (typeof value !== 'string' || value.trim() !== value || (required && value.length === 0) || value.length > maxLength) {
    throw new Error(`${fieldName} must be ${required ? 'a non-empty' : 'an'} unpadded string of at most ${maxLength} characters.`);
  }
  return value;
}

function normalizeScheduledJobToken(value, { generate = false } = {}) {
  const token = value || (generate ? randomUUID() : '');
  if (!scheduledJobClaimTokenPattern.test(token)) {
    throw new Error('Scheduled-job claim token must be a 16-200 character URL-safe opaque value.');
  }
  return token;
}

function normalizeScheduledJobMetadata(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (value === undefined || value === null) return {};
    throw new Error(`${fieldName} must be a JSON object.`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${fieldName} must be JSON serializable.`);
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > scheduledJobMetadataMaxBytes) {
    throw new Error(`${fieldName} exceeds the scheduled-job metadata limit.`);
  }
  return JSON.parse(serialized);
}

function scheduledJobMetadataFits(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= scheduledJobMetadataMaxBytes;
}

function mergeScheduledJobMetadata(existing, incoming) {
  const current = normalizeScheduledJobMetadata(existing, 'Existing scheduled-job metadata');
  const patch = normalizeScheduledJobMetadata(incoming, 'Scheduled-job metadata');
  const merged = { ...current, ...patch };
  for (const field of scheduledJobImmutableMetadataFields) {
    if (Object.hasOwn(current, field)) merged[field] = current[field];
  }
  return merged;
}

function normalizeScheduledJobRow(row) {
  if (!row) return null;
  return {
    ...row,
    attempt_count: Number(row.attempt_count || 0),
    metadata: parseJsonColumn(row.metadata, {}),
  };
}

function scheduledJobResult(applied, reason, row) {
  const normalizedReason = scheduledJobClaimReasons.has(reason) ? reason : 'wrong-state';
  return {
    applied: Boolean(applied),
    claimed: Boolean(applied),
    reason: normalizedReason,
    run: normalizeScheduledJobRow(row),
  };
}

function scheduledJobClaimDenialReason(row, { staleBefore, retryDueAt, legacy }) {
  if (!row) return 'missing';
  if (row.status === 'completed') return 'completed';
  if (row.status === 'transmitting' || row.status === 'ambiguous') return 'wrong-state';
  if (row.status === 'pending') {
    return staleBefore && row.updated_at <= staleBefore ? 'claimed' : 'active';
  }
  if (row.status === 'failed') {
    const metadata = parseJsonColumn(row.metadata, {});
    const nextRetryAt = typeof metadata.nextRetryAt === 'string' ? metadata.nextRetryAt : '';
    if (!nextRetryAt) return legacy ? 'claimed' : 'retry-not-due';
    return retryDueAt && nextRetryAt <= retryDueAt ? 'claimed' : 'retry-not-due';
  }
  return 'wrong-state';
}

function normalizeSubmissionRow(row) {
  return {
    ...row,
    lead_type: normalizeLeadType(row.lead_type, 'seller'),
    sba_eligible: normalizeSbaEligibility(row.sba_eligible, 'unknown'),
    spam_reasons: parseJsonColumn(row.spam_reasons, []),
    metadata: parseJsonColumn(row.metadata, {}),
    tags: parseJsonColumn(row.tags, []),
  };
}

const dealHunterCrmMatchAuthorityVersion = 'deal-hunter-crm-match-authority-v2';
const dealHunterCrmMatchAuthorityMaximumRows = 5000;

function dealHunterCrmMatchAuthorityError({ candidateIds = [] } = {}) {
  const error = new Error('CRM match authority changed before canonical linkage. Refresh and review before retrying.');
  error.code = 'CRM_MATCH_AUTHORITY_STALE';
  error.status = 409;
  error.candidateIds = [...new Set(candidateIds.filter(Boolean).map(String))].sort().slice(0, 25);
  error.evidenceCategories = ['authority-stale'];
  return error;
}

function dealHunterCrmMatchAuthoritySnapshot(database, {
  limit = dealHunterCrmMatchAuthorityMaximumRows,
  supersessionLimit = crmSubmissionSupersessionMaximumRows,
} = {}) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedLimit), dealHunterCrmMatchAuthorityMaximumRows))
    : dealHunterCrmMatchAuthorityMaximumRows;
  const parsedSupersessionLimit = Number(supersessionLimit);
  const safeSupersessionLimit = Number.isFinite(parsedSupersessionLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedSupersessionLimit), crmSubmissionSupersessionMaximumRows))
    : crmSubmissionSupersessionMaximumRows;
  const rawRows = database.prepare(`
    SELECT * FROM contact_submissions
    ORDER BY id ASC
    LIMIT ?
  `).all(safeLimit + 1);
  const rawSupersessions = database.prepare(`
    SELECT * FROM crm_submission_supersessions
    WHERE status = 'active'
    ORDER BY id ASC
    LIMIT ?
  `).all(safeSupersessionLimit + 1);
  if (rawRows.length > safeLimit || rawSupersessions.length > safeSupersessionLimit) {
    return {
      rows: [],
      rawRows: [],
      supersessions: [],
      rawSupersessions: [],
      count: null,
      submissionCount: null,
      supersessionCount: null,
      complete: false,
      revision: null,
      revisionVersion: dealHunterCrmMatchAuthorityVersion,
    };
  }
  const submissionColumns = database.pragma('table_info(contact_submissions)')
    .map((column) => String(column.name))
    .sort();
  const supersessionColumns = database.pragma('table_info(crm_submission_supersessions)')
    .map((column) => String(column.name))
    .sort();
  const revisionPayload = JSON.stringify({
    version: dealHunterCrmMatchAuthorityVersion,
    submissions: {
      columns: submissionColumns,
      rows: rawRows.map((row) => submissionColumns.map((column) => row[column])),
    },
    activeSupersessions: {
      columns: supersessionColumns,
      rows: rawSupersessions.map((row) => supersessionColumns.map((column) => row[column])),
    },
  });
  return {
    rows: rawRows.map(normalizeSubmissionRow),
    rawRows,
    supersessions: rawSupersessions.map(normalizeCrmSubmissionSupersessionRow),
    rawSupersessions,
    count: rawRows.length,
    submissionCount: rawRows.length,
    supersessionCount: rawSupersessions.length,
    complete: true,
    revision: createHash('sha256').update(revisionPayload).digest('hex'),
    revisionVersion: dealHunterCrmMatchAuthorityVersion,
  };
}

function rawDealHunterCrmMetadataOwner(row, candidateIds = []) {
  let metadata;
  try {
    metadata = row?.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    throw dealHunterCrmMatchAuthorityError({ candidateIds });
  }
  const owner = metadata?.dealHunter?.opportunityId;
  return typeof owner === 'string' ? owner.trim() : '';
}

function normalizeUploadRequestRow(row) {
  return row
    ? {
        ...row,
        nda_required: Boolean(row.nda_required),
        requested_documents: parseJsonColumn(row.requested_documents, []),
        upload_batch_count: Number(row.upload_batch_count || 0),
      }
    : null;
}

function normalizeEmailEventRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeCrmActivityEventRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeCrmCommunicationRow(row) {
  return row
    ? {
        ...row,
        to_addresses: parseJsonColumn(row.to_addresses, []),
        cc_addresses: parseJsonColumn(row.cc_addresses, []),
        bcc_addresses: parseJsonColumn(row.bcc_addresses, []),
        references_json: parseJsonColumn(row.references_json, []),
        headers_json: parseJsonColumn(row.headers_json, {}),
        attachment_metadata: parseJsonColumn(row.attachment_metadata, []),
        metadata: parseJsonColumn(row.metadata, {}),
        content_attempt_count: Number(row.content_attempt_count || 0),
        legacy_content_unavailable: Boolean(row.legacy_content_unavailable),
      }
    : null;
}

function normalizeCrmEmailOutboxRow(row) {
  return row
    ? {
        ...row,
        attempt_count: Number(row.attempt_count || 0),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeCrmFollowUpRecommendationRow(row) {
  return row
    ? {
        ...row,
        priority_score: Number(row.priority_score || 0),
        confidence: Number(row.confidence || 0),
        evidence_json: parseJsonColumn(row.evidence_json, []),
        signals_json: parseJsonColumn(row.signals_json, []),
        commitments_json: parseJsonColumn(row.commitments_json, []),
        questions_json: parseJsonColumn(row.questions_json, []),
        blockers_json: parseJsonColumn(row.blockers_json, []),
        safety_flags_json: parseJsonColumn(row.safety_flags_json, []),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeEmailSuppressionRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeAdminOnboardingProgressRow(row) {
  return row
    ? {
        ...row,
        tour_version: Number(row.tour_version),
        last_completed_step_id: row.last_completed_step_id || null,
        completed_at: row.completed_at || null,
        skipped_at: row.skipped_at || null,
      }
    : null;
}

function normalizeDealHunterDispositionRow(row) {
  return row
    ? {
        ...row,
        status: row.disposition,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeSecureDocumentCleanupJobRow(row) {
  return row
    ? {
        ...row,
        files: parseJsonColumn(row.files, []),
        metadata: parseJsonColumn(row.metadata, {}),
        attempt_count: Number(row.attempt_count || 0),
        lease_claimed_at: row.lease_claimed_at || null,
        lease_expires_at: row.lease_expires_at || null,
        lease_token: row.lease_token || null,
      }
    : null;
}

const cleanupLeaseTokenPattern = /^[A-Za-z0-9_-]{16,200}$/;
const canonicalUtcIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maxCleanupJobLeaseMs = 24 * 60 * 60 * 1000;
const cleanupJobUpdateFields = new Set([
  'updated_at',
  'completed_at',
  'status',
  'trash_directory',
  'files',
  'attempt_count',
  'last_error',
  'metadata',
  'lease_claimed_at',
  'lease_expires_at',
  'lease_token',
]);

function normalizeCleanupLeaseToken(value) {
  if (typeof value !== 'string' || value.trim() !== value || !cleanupLeaseTokenPattern.test(value)) {
    throw new Error('Cleanup-job lease token must be a 16-200 character URL-safe opaque value.');
  }
  return value;
}

function normalizeCleanupLeaseDuration(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maxCleanupJobLeaseMs) {
    throw new Error('Cleanup-job lease duration must be an integer between 1 millisecond and 24 hours.');
  }
  return value;
}

function normalizeCanonicalUtcIso(value, fieldName) {
  if (
    typeof value !== 'string' ||
    !canonicalUtcIsoPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${fieldName} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function normalizeSecureDocumentCleanupLease({ claimedAt, leaseExpiresAt, leaseToken } = {}) {
  const normalizedClaimedAt = normalizeCanonicalUtcIso(claimedAt, 'Cleanup-job lease claim time');
  const normalizedLeaseExpiresAt = normalizeCanonicalUtcIso(leaseExpiresAt, 'Cleanup-job lease expiry');
  const claimedAtMs = Date.parse(normalizedClaimedAt);
  const leaseExpiresAtMs = Date.parse(normalizedLeaseExpiresAt);

  if (leaseExpiresAtMs <= claimedAtMs) {
    throw new Error('Cleanup-job lease expiry must be later than its claim time.');
  }

  const durationMs = leaseExpiresAtMs - claimedAtMs;
  normalizeCleanupLeaseDuration(durationMs);

  return {
    claimedAt: normalizedClaimedAt,
    leaseExpiresAt: normalizedLeaseExpiresAt,
    leaseToken: normalizeCleanupLeaseToken(leaseToken),
    durationMs,
  };
}

function normalizeSecureDocumentCleanupJobUpdate(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('Cleanup-job lease update values must be an object.');
  }

  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new Error('Cleanup-job lease update must include at least one field.');
  }

  for (const [field, value] of entries) {
    if (!cleanupJobUpdateFields.has(field)) {
      throw new Error(`Unsupported cleanup-job lease update field: ${field}`);
    }

    if (['updated_at', 'completed_at', 'lease_claimed_at', 'lease_expires_at'].includes(field) && value !== null) {
      normalizeCanonicalUtcIso(value, `Cleanup-job ${field}`);
    }
  }

  if (Object.hasOwn(values, 'lease_token') && values.lease_token !== null) {
    throw new Error('A cleanup-job lease update may only clear its lease token.');
  }

  const normalized = { ...values };
  if (Object.hasOwn(normalized, 'lease_token')) {
    normalized.lease_token = null;
    normalized.lease_claimed_at = null;
    normalized.lease_expires_at = null;
  }
  if (Object.hasOwn(normalized, 'files')) {
    if (!Array.isArray(normalized.files)) throw new Error('Cleanup-job files must be an array.');
    normalized.files = JSON.stringify(normalized.files);
  }
  if (Object.hasOwn(normalized, 'metadata')) {
    if (!normalized.metadata || typeof normalized.metadata !== 'object' || Array.isArray(normalized.metadata)) {
      throw new Error('Cleanup-job metadata must be an object.');
    }
    normalized.metadata = JSON.stringify(normalized.metadata);
  }
  if (Object.hasOwn(normalized, 'attempt_count')) {
    if (!Number.isSafeInteger(normalized.attempt_count) || normalized.attempt_count < 0) {
      throw new Error('Cleanup-job attempt count must be a non-negative integer.');
    }
  }

  return normalized;
}

function normalizeDealHunterSeenDealRow(row) {
  return row
    ? {
        ...row,
        should_remove: Boolean(row.should_remove),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterDealOsImportRow(row) {
  return row
    ? {
        ...row,
        coverage_limit_reached: Boolean(row.coverage_limit_reached),
        records: parseJsonColumn(row.records, []),
        row_accounting: parseJsonColumn(row.row_accounting, []),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterCimRequestRow(row) {
  return row
    ? {
        ...row,
        follow_up_count: Number(row.follow_up_count || 0),
        attempt_count: Number(row.attempt_count || 0),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedManualFollowUpText(value, maximum = 500) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function manualFollowUpMarker(request) {
  return objectRecord(objectRecord(objectRecord(request).metadata).manualFollowUp);
}

const initialManualFollowUpMarkerKeys = [
  'cadencePolicy',
  'enrolledAt',
  'enrolledBy',
  'maximumFollowUps',
  'mode',
  'version',
];

function hasStrictManualFollowUpCore(marker) {
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    && marker.version === MANUAL_FOLLOW_UP_VERSION
    && marker.mode === MANUAL_FOLLOW_UP_MODE
    && marker.maximumFollowUps === MANUAL_FOLLOW_UP_MAXIMUM
    && marker.cadencePolicy === MANUAL_FOLLOW_UP_CADENCE
    && typeof marker.enrolledAt === 'string'
    && Number.isFinite(Date.parse(marker.enrolledAt))
    && typeof marker.enrolledBy === 'string'
    && Boolean(boundedManualFollowUpText(marker.enrolledBy, 300));
}

function canonicalInitialManualFollowUpMarker(marker) {
  if (!hasStrictManualFollowUpCore(marker)
    || Object.keys(marker).sort().join('\n') !== initialManualFollowUpMarkerKeys.join('\n')) {
    return null;
  }
  try {
    return buildManualFollowUpMarker({ enrolledAt: marker.enrolledAt, enrolledBy: marker.enrolledBy });
  } catch {
    return null;
  }
}

function isMarkedManualFollowUpRequest(request) {
  return manualFollowUpMarker(request).mode === MANUAL_FOLLOW_UP_MODE;
}

function isManualFollowUpTerminal(request, submission) {
  const marker = manualFollowUpMarker(request);
  return submission?.status === 'archived'
    || Boolean(request?.responded_at)
    || request?.request_state === 'responded'
    || request?.status === 'responded'
    || request?.status === 'delivery_issue'
    || ['stopped', 'completed'].includes(request?.follow_up_state)
    || Boolean(marker.stoppedAt || marker.stopped_at);
}

function manualFollowUpResult({ applied = false, reason = '', request = null, activity = null, alreadyFinalized = false } = {}) {
  return {
    applied: Boolean(applied),
    reason: String(reason || ''),
    request: request || null,
    activity: activity || null,
    alreadyFinalized: Boolean(alreadyFinalized),
  };
}

function normalizeDealHunterCrmImportRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterCrmReconciliationRunRow(row) {
  return row
    ? {
        ...row,
        counts: parseJsonColumn(row.counts, {}),
        plan: parseJsonColumn(row.plan, {}),
        results: parseJsonColumn(row.results, {}),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterCrmReconciliationItemRow(row) {
  return row
    ? {
        ...row,
        source_row_numbers: parseJsonColumn(row.source_row_numbers, []),
        planned_changes: parseJsonColumn(row.planned_changes, {}),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterOpportunityRow(row) {
  return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
}

// Operator-owned columns on deal_hunter_opportunity_scores. Machine score writes
// reject any payload carrying one of these, so ownership cannot be crossed by a
// caller that forgets the convention.
export const dealHunterOperatorOwnedScoreFields = Object.freeze([
  'operator_priority',
  'operator_note',
  'reviewed_at',
  'reviewed_by',
  'reviewed_fingerprint',
  'reviewed_semantic_digest',
  'operator_updated_at',
]);

// Current-triage eligibility is owned by complete-set reconciliation. Neither
// a machine score payload nor an operator decision may elect a row into the
// current queue.
export const dealHunterEligibilityOwnedScoreFields = Object.freeze([
  'current_triage_eligible',
]);

function normalizeDealHunterOpportunityScoreRow(row) {
  return row
    ? {
        ...row,
        should_remove: Boolean(row.should_remove),
        high_fit: Boolean(row.high_fit),
        current_triage_eligible: Boolean(row.current_triage_eligible),
        dimensions: parseJsonColumn(row.dimensions, []),
        gates: parseJsonColumn(row.gates, []),
        applied_caps: parseJsonColumn(row.applied_caps, []),
        missing_evidence: parseJsonColumn(row.missing_evidence, []),
        confidence_reasons: parseJsonColumn(row.confidence_reasons, []),
        summary: parseJsonColumn(row.summary, {}),
        // A review is stale only when the score's *conclusions* moved. Rows
        // reviewed before semantic digests existed fall back to comparing the
        // input fingerprint, which is the previous, coarser behaviour.
        changed_since_review: Boolean(row.reviewed_at) && (
          row.reviewed_semantic_digest
            ? row.reviewed_semantic_digest !== row.semantic_digest
            : Boolean(row.reviewed_fingerprint) && row.reviewed_fingerprint !== row.score_fingerprint
        ),
        reviewed: Boolean(row.reviewed_at),
      }
    : null;
}

function normalizeDealHunterScoreEvidenceRow(row) {
  return row ? { ...row, terms: parseJsonColumn(row.terms, []) } : null;
}

function normalizeDealHunterOpportunityFactRow(row) {
  return row ? { ...row, verified: Boolean(row.verified) } : null;
}

function normalizeDealHunterOpportunitySourceObservationRow(row) {
  if (!row) return null;
  const freshnessColumns = new Set([
    'accepted_at', 'accepted_run_id', 'accepted_evidence_id', 'publication_raw_header',
    'publication_raw_value', 'publication_precision', 'publication_offset', 'publication_meaning',
  ]);
  return Object.fromEntries(Object.entries(row).filter(([column, value]) => !freshnessColumns.has(column) || value !== null));
}

function normalizeDealHunterOpportunityAliasRow(row) {
  return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
}

function normalizeDealHunterIdentityExceptionRow(row) {
  return row
    ? {
        ...row,
        candidate_opportunity_ids: parseJsonColumn(row.candidate_opportunity_ids, []),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterCimSafetySettingsRow(row) {
  return row
    ? { ...row, outreach_paused: Boolean(row.outreach_paused), metadata: parseJsonColumn(row.metadata, {}) }
    : null;
}

function normalizeDealHunterRepairManifestRow(row) {
  return row
    ? { ...row, manifest: parseJsonColumn(row.manifest, {}), metadata: parseJsonColumn(row.metadata, {}) }
    : null;
}

const crmSubmissionSupersessionMaximumRows = 5000;
const crmSubmissionReversalManifestSchema = 'crm-duplicate-consolidation-reversal-manifest-v1';
const crmSubmissionReversalTriggerSql = `
  CREATE TRIGGER trg_crm_submission_supersessions_reverse_only
  BEFORE UPDATE ON crm_submission_supersessions
  WHEN (
    NEW.updated_at IS NOT OLD.updated_at
    OR NEW.status IS NOT OLD.status
    OR NEW.reversed_at IS NOT OLD.reversed_at
    OR NEW.reversed_by IS NOT OLD.reversed_by
    OR NEW.reversal_reason IS NOT OLD.reversal_reason
    OR NEW.reversal_manifest_id IS NOT OLD.reversal_manifest_id
  ) AND NOT (
    OLD.status = 'active'
    AND NEW.status = 'reversed'
    AND NEW.reversed_at IS NOT NULL AND TRIM(NEW.reversed_at) <> ''
    AND NEW.reversed_by IS NOT NULL AND TRIM(NEW.reversed_by) <> ''
    AND NEW.reversal_reason IS NOT NULL AND TRIM(NEW.reversal_reason) <> ''
    AND NEW.reversal_manifest_id IS NOT NULL AND TRIM(NEW.reversal_manifest_id) <> ''
    AND NEW.reversal_manifest_id <> NEW.repair_manifest_id
    AND EXISTS (
      SELECT 1 FROM deal_hunter_cim_repair_manifests
      WHERE id = NEW.reversal_manifest_id
        AND mode = 'crm-duplicate-consolidation'
        AND status = 'applied'
        AND json_extract(manifest, '$.schema') = '${crmSubmissionReversalManifestSchema}'
        AND json_extract(manifest, '$.operation') = 'reverse'
        AND json_extract(manifest, '$.relationId') = NEW.id
        AND json_extract(manifest, '$.applyManifestId') = NEW.repair_manifest_id
        AND json_extract(manifest, '$.repairDigest') = NEW.repair_digest
        AND json_extract(manifest, '$.survivorSubmissionId') = NEW.survivor_submission_id
        AND json_extract(manifest, '$.supersededSubmissionId') = NEW.superseded_submission_id
        AND json_extract(manifest, '$.opportunityId') = NEW.opportunity_id
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'CRM supersession permits only reviewed active to reversed transition');
  END;
`;

function normalizeCrmSubmissionSupersessionRow(row) {
  return row
    ? {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        survivorSubmissionId: row.survivor_submission_id,
        supersededSubmissionId: row.superseded_submission_id,
        opportunityId: row.opportunity_id,
        reasonCode: row.reason_code,
        reasonText: row.reason_text,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
        actor: row.actor,
        repairVersion: row.repair_version,
        repairManifestId: row.repair_manifest_id,
        repairDigest: row.repair_digest,
        reversedAt: row.reversed_at || null,
        reversedBy: row.reversed_by || null,
        reversalReason: row.reversal_reason || null,
        reversalManifestId: row.reversal_manifest_id || null,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function selectActiveCrmSubmissionSupersessions(database, {
  submissionIds = [],
  opportunityIds = [],
  limit = crmSubmissionSupersessionMaximumRows,
} = {}) {
  const safeSubmissionIds = normalizeList(submissionIds, crmSubmissionSupersessionMaximumRows);
  const safeOpportunityIds = normalizeList(opportunityIds, crmSubmissionSupersessionMaximumRows);
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedLimit), crmSubmissionSupersessionMaximumRows))
    : crmSubmissionSupersessionMaximumRows;
  const clauses = ["status = 'active'"];
  const parameters = [];
  if (safeSubmissionIds.length > 0) {
    const placeholders = safeSubmissionIds.map(() => '?').join(', ');
    clauses.push(`(survivor_submission_id IN (${placeholders}) OR superseded_submission_id IN (${placeholders}))`);
    parameters.push(...safeSubmissionIds, ...safeSubmissionIds);
  }
  if (safeOpportunityIds.length > 0) {
    clauses.push(`opportunity_id IN (${safeOpportunityIds.map(() => '?').join(', ')})`);
    parameters.push(...safeOpportunityIds);
  }
  return database.prepare(`
    SELECT * FROM crm_submission_supersessions
    WHERE ${clauses.join(' AND ')}
    ORDER BY opportunity_id ASC, survivor_submission_id ASC,
      superseded_submission_id ASC, id ASC
    LIMIT ?
  `).all(...parameters, safeLimit).map(normalizeCrmSubmissionSupersessionRow);
}

function crmSubmissionMetadataOwner(submission) {
  const owner = submission?.metadata?.dealHunter?.opportunityId;
  return typeof owner === 'string' ? owner.trim() : '';
}

function crmSubmissionReversalReceiptMatches(relation, receipt) {
  const manifest = parseJsonColumn(receipt?.manifest, {});
  return Boolean(
    receipt
    && relation.reversalManifestId
    && relation.reversalManifestId !== relation.repairManifestId
    && receipt.id === relation.reversalManifestId
    && receipt.mode === 'crm-duplicate-consolidation'
    && receipt.status === 'applied'
    && manifest.schema === crmSubmissionReversalManifestSchema
    && manifest.operation === 'reverse'
    && manifest.relationId === relation.id
    && manifest.applyManifestId === relation.repairManifestId
    && manifest.repairDigest === relation.repairDigest
    && manifest.survivorSubmissionId === relation.survivorSubmissionId
    && manifest.supersededSubmissionId === relation.supersededSubmissionId
    && manifest.opportunityId === relation.opportunityId
  );
}

function migrateCrmSubmissionReversalTrigger(database) {
  database.transaction(() => {
    database.exec('DROP TRIGGER IF EXISTS trg_crm_submission_supersessions_reverse_only');
    database.exec(crmSubmissionReversalTriggerSql);
  }).immediate();
}

function normalizeCimStage2ActivationRow(row) {
  return row
    ? {
        ...row,
        weekdays_only: Boolean(row.weekdays_only),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeCimStage2RunRow(row) {
  return row
    ? {
        ...row,
        blocked_counts: parseJsonColumn(row.blocked_counts, {}),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeCimStage2DecisionRow(row) {
  return row
    ? {
        ...row,
        reasons: parseJsonColumn(row.reasons, []),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function serializeSubmission(submission) {
  return {
    ...submission,
    deal_hunter_opportunity_id: submission.deal_hunter_opportunity_id || null,
    spam_reasons: JSON.stringify(submission.spam_reasons || []),
    metadata: JSON.stringify(submission.metadata || {}),
    tags: JSON.stringify(submission.tags || []),
  };
}

function serializeUploadRequest(request) {
  return {
    ...request,
    nda_required: request.nda_required ? 1 : 0,
    requested_documents: JSON.stringify(request.requested_documents || []),
  };
}

function serializeUploadRequestValues(values) {
  return Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => [
      key,
      key === 'nda_required' ? (value ? 1 : 0) : key === 'requested_documents' ? JSON.stringify(value || []) : value,
    ]),
  );
}

function serializeEmailEvent(event) {
  return {
    ...event,
    communication_id: event.communication_id || null,
    opportunity_id: event.opportunity_id || null,
    metadata: JSON.stringify(event.metadata || {}),
  };
}

function serializeCrmCommunication(communication) {
  return {
    ...communication,
    submission_id: communication.submission_id || null,
    opportunity_id: communication.opportunity_id || null,
    deal_key: communication.deal_key || null,
    cim_request_id: communication.cim_request_id || null,
    kind: communication.kind || null,
    provider: communication.provider || null,
    provider_message_id: communication.provider_message_id || null,
    source_event_id: communication.source_event_id || null,
    idempotency_key: communication.idempotency_key || null,
    message_id: communication.message_id || null,
    in_reply_to: communication.in_reply_to || null,
    references_json: JSON.stringify(Array.isArray(communication.references_json) ? communication.references_json : []),
    parent_communication_id: communication.parent_communication_id || null,
    thread_key: communication.thread_key || null,
    legacy_content_unavailable: communication.legacy_content_unavailable ? 1 : 0,
    content_redaction_state: communication.content_redaction_state || 'none',
    recommendation_id: communication.recommendation_id || null,
    outbox_id: communication.outbox_id || null,
    headers_json: JSON.stringify(
      communication.headers_json && typeof communication.headers_json === 'object' && !Array.isArray(communication.headers_json)
        ? communication.headers_json
        : {},
    ),
    reply_to_address: communication.reply_to_address || null,
    from_address: communication.from_address || null,
    to_addresses: JSON.stringify(Array.isArray(communication.to_addresses) ? communication.to_addresses : []),
    cc_addresses: JSON.stringify(Array.isArray(communication.cc_addresses) ? communication.cc_addresses : []),
    bcc_addresses: JSON.stringify(Array.isArray(communication.bcc_addresses) ? communication.bcc_addresses : []),
    subject: communication.subject || null,
    body_text: communication.body_text || '',
    body_html_sanitized: communication.body_html_sanitized || '',
    delivery_state_at: communication.delivery_state_at || null,
    content_attempt_count: Math.max(0, Number(communication.content_attempt_count || 0)),
    content_last_error: communication.content_last_error || null,
    content_next_attempt_at: communication.content_next_attempt_at || null,
    attachment_metadata: JSON.stringify(Array.isArray(communication.attachment_metadata) ? communication.attachment_metadata : []),
    assigned_at: communication.assigned_at || null,
    assigned_by: communication.assigned_by || null,
    created_by: communication.created_by || 'system',
    updated_by: communication.updated_by || 'system',
    metadata: JSON.stringify(communication.metadata || {}),
  };
}

function serializeCrmCommunicationValues(values = {}) {
  const jsonFields = new Set([
    'to_addresses', 'cc_addresses', 'bcc_addresses', 'references_json', 'headers_json',
    'attachment_metadata', 'metadata',
  ]);
  const objectFields = new Set(['headers_json', 'metadata']);
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      key === 'legacy_content_unavailable'
        ? (value ? 1 : 0)
        : jsonFields.has(key)
          ? JSON.stringify(value ?? (objectFields.has(key) ? {} : []))
          : value,
    ]),
  );
}

function serializeCrmEmailOutbox(outbox = {}) {
  return {
    ...outbox,
    cim_request_id: outbox.cim_request_id || null,
    provider: outbox.provider || null,
    provider_message_id: outbox.provider_message_id || null,
    next_attempt_at: outbox.next_attempt_at || null,
    claim_token: outbox.claim_token || null,
    claimed_at: outbox.claimed_at || null,
    claim_expires_at: outbox.claim_expires_at || null,
    accepted_at: outbox.accepted_at || null,
    failed_at: outbox.failed_at || null,
    ambiguous_at: outbox.ambiguous_at || null,
    last_error_category: outbox.last_error_category || null,
    last_error_message: outbox.last_error_message || null,
    intended_follow_up_state: outbox.intended_follow_up_state || null,
    intended_next_action_at: outbox.intended_next_action_at || null,
    attempt_count: Math.max(0, Number(outbox.attempt_count || 0)),
    metadata: JSON.stringify(outbox.metadata || {}),
  };
}

function serializeCrmFollowUpRecommendation(recommendation = {}) {
  const jsonArray = (value) => JSON.stringify(Array.isArray(value) ? value : []);
  return {
    ...recommendation,
    cim_request_id: recommendation.cim_request_id || null,
    triggering_communication_id: recommendation.triggering_communication_id || null,
    model_provider: recommendation.model_provider || null,
    model_id: recommendation.model_id || null,
    recommended_next_action_at: recommendation.recommended_next_action_at || null,
    thread_parent_communication_id: recommendation.thread_parent_communication_id || null,
    priority_score: Math.max(0, Math.min(100, Number(recommendation.priority_score || 0))),
    confidence: Math.max(0, Math.min(1, Number(recommendation.confidence || 0))),
    evidence_json: jsonArray(recommendation.evidence_json),
    signals_json: jsonArray(recommendation.signals_json),
    commitments_json: jsonArray(recommendation.commitments_json),
    questions_json: jsonArray(recommendation.questions_json),
    blockers_json: jsonArray(recommendation.blockers_json),
    safety_flags_json: jsonArray(recommendation.safety_flags_json),
    expires_at: recommendation.expires_at || null,
    acted_on_at: recommendation.acted_on_at || null,
    superseded_at: recommendation.superseded_at || null,
    acted_on_by: recommendation.acted_on_by || null,
    outcome: recommendation.outcome || null,
    metadata: JSON.stringify(recommendation.metadata || {}),
  };
}

function serializeEmailSuppression(suppression = {}) {
  return {
    ...suppression,
    normalized_email: String(suppression.normalized_email || '').trim().toLowerCase(),
    source_event_id: suppression.source_event_id || null,
    source_communication_id: suppression.source_communication_id || null,
    lifted_at: suppression.lifted_at || null,
    lifted_by: suppression.lifted_by || null,
    lift_reason: suppression.lift_reason || null,
    metadata: JSON.stringify(suppression.metadata || {}),
  };
}

function serializeCrmActivityEvent(event) {
  return {
    ...event,
    opportunity_id: event.opportunity_id || null,
    metadata: JSON.stringify(event.metadata || {}),
  };
}

function serializeDealHunterSeenDeal(deal) {
  return {
    ...deal,
    should_remove: deal.should_remove ? 1 : 0,
    metadata: JSON.stringify(deal.metadata || {}),
  };
}

function serializeDealHunterDealOsImport(record) {
  return {
    ...record,
    expected_row_count: record.expected_row_count ?? null,
    coverage_limit_reached: record.coverage_limit_reached ? 1 : 0,
    records: JSON.stringify(Array.isArray(record.records) ? record.records : []),
    row_accounting: JSON.stringify(Array.isArray(record.row_accounting) ? record.row_accounting : []),
    metadata: JSON.stringify(record.metadata || {}),
  };
}

function serializeDealHunterCimRequest(request) {
  const now = new Date().toISOString();
  const status = String(request.status || 'pending').trim() || 'pending';
  const metadata = request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
    ? request.metadata
    : {};
  const createdAt = request.created_at || now;
  const updatedAt = request.updated_at || createdAt;
  const inferredRequestState = status === 'pending'
    ? 'pending'
    : status === 'responded'
      ? 'responded'
      : status === 'delivery_issue'
        ? 'stopped'
        : status === 'failed'
          ? 'ready'
          : ['sent', 'logged', 'follow_up_pending', 'follow_up_failed'].includes(status)
            ? 'provider_accepted'
            : null;
  const inferredDeliveryState = status === 'logged'
    ? 'development-only'
    : status === 'failed'
      ? 'failed'
      : status === 'delivery_issue'
        ? String(metadata.deliveryIssueType || 'failed').replaceAll('_', '-')
        : ['sent', 'responded', 'follow_up_pending', 'follow_up_failed'].includes(status)
          ? 'accepted'
          : 'not-attempted';

  return {
    id: requireCanonicalCimRequestId(request.id),
    created_at: createdAt,
    updated_at: updatedAt,
    deal_key: String(request.deal_key || '').trim(),
    recipient_email: String(request.recipient_email || '').trim().toLowerCase(),
    requested_by: request.requested_by || null,
    status,
    delivery_error: request.delivery_error || null,
    provider_message_id: request.provider_message_id || null,
    subject: request.subject || null,
    deal_name: request.deal_name || null,
    source_name: request.source_name || null,
    listing_url: request.listing_url || null,
    score: Number.isFinite(Number(request.score)) && request.score !== '' && request.score !== null
      ? Number(request.score)
      : null,
    follow_up_count: Number(request.follow_up_count || 0),
    last_follow_up_at: request.last_follow_up_at || null,
    next_follow_up_at: request.next_follow_up_at || null,
    responded_at: request.responded_at || null,
    submission_id: request.submission_id || null,
    opportunity_id: request.opportunity_id || null,
    request_state: request.request_state || inferredRequestState,
    delivery_state: request.delivery_state || inferredDeliveryState,
    delivery_state_at: request.delivery_state_at || null,
    follow_up_state: request.follow_up_state || (request.responded_at
      ? 'completed'
      : request.next_follow_up_at
        ? 'scheduled'
        : ['failed', 'delivery_issue'].includes(status)
          ? 'stopped'
          : 'not-scheduled'),
    first_requested_at: request.first_requested_at || createdAt,
    first_provider_accepted_at: request.first_provider_accepted_at || null,
    delivered_at: request.delivered_at || null,
    last_attempt_at: request.last_attempt_at || null,
    last_delivery_event_at: request.last_delivery_event_at || null,
    reply_to_address: String(request.reply_to_address || metadata.replyToAddress || '').trim().toLowerCase() || null,
    retry_of_request_id: request.retry_of_request_id || null,
    attempt_count: Object.hasOwn(request, 'attempt_count') ? Math.max(0, Number(request.attempt_count || 0)) : null,
    last_activity_at: request.last_activity_at || updatedAt,
    metadata: JSON.stringify(metadata),
  };
}

function serializeDealHunterDisposition(record = {}) {
  const disposition = String(record.disposition || record.status || 'dismissed').trim().toLowerCase();
  return {
    id: String(record.id || '').trim(),
    deal_key: String(record.deal_key || record.dealKey || '').trim(),
    submission_id: String(record.submission_id || record.submissionId || '').trim() || null,
    communication_id: String(record.communication_id || record.communicationId || '').trim() || null,
    listing_url: String(record.listing_url || record.listingUrl || '').trim() || null,
    deal_name: String(record.deal_name || record.dealName || '').trim() || null,
    created_at: record.created_at || record.createdAt || new Date().toISOString(),
    updated_at: record.updated_at || record.updatedAt || new Date().toISOString(),
    disposition,
    reason: String(record.reason || '').trim() || null,
    note: String(record.note || '').trim() || null,
    dismissed_at: record.dismissed_at || record.dismissedAt || (disposition === 'dismissed' ? record.updated_at || record.updatedAt || new Date().toISOString() : null),
    dismissed_by: String(record.dismissed_by || record.dismissedBy || (disposition === 'dismissed' ? record.updated_by || record.updatedBy || record.created_by || record.createdBy : '') || record.actor || '').trim() || null,
    restored_at: record.restored_at || record.restoredAt || (disposition === 'restored' ? record.updated_at || record.updatedAt || new Date().toISOString() : null),
    restored_by: String(record.restored_by || record.restoredBy || (disposition === 'restored' ? record.updated_by || record.updatedBy : '') || '').trim() || null,
    created_by: String(record.created_by || record.createdBy || record.actor || '').trim() || 'system',
    updated_by: String(record.updated_by || record.updatedBy || record.actor || '').trim() || 'system',
    metadata: JSON.stringify(record.metadata || {}),
  };
}

function serializeDealHunterCrmImport(record) {
  return {
    ...record,
    opportunity_id: record.opportunity_id || null,
    metadata: JSON.stringify(record.metadata || {}),
  };
}

function normalizeList(values, maxLength = 5000) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, maxLength);
}

function normalizePage(value, maxPage = 10000) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? Math.min(maxPage, Math.max(1, Math.trunc(numericValue)))
    : 1;
}

const activeCrmProjectionAliases = new Set(['submission', 'submissions']);

function activeCrmSubmissionPredicate(alias) {
  if (!activeCrmProjectionAliases.has(alias)) {
    throw new Error('Unsupported internal CRM projection alias.');
  }

  return `NOT EXISTS (
    SELECT 1
    FROM crm_submission_supersessions AS active_supersession
    WHERE active_supersession.superseded_submission_id = ${alias}.id
      AND active_supersession.status = 'active'
  )`;
}

const sharedWebsiteDomains = [
  'facebook.com',
  'instagram.com',
  'yelp.com',
  'yellowpages.com',
  'angi.com',
  'homeadvisor.com',
  'thumbtack.com',
  'nextdoor.com',
  'linktr.ee',
  'business.site',
  'sites.google.com',
  'square.site',
  'wixsite.com',
];

function isSharedWebsiteDomain(hostname = '') {
  return sharedWebsiteDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function canonicalWebsiteIdentity(value = '') {
  const rawValue = String(value || '').trim().toLowerCase();

  if (!rawValue) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, '');
    return isSharedWebsiteDomain(hostname) && pathname ? `${hostname}${pathname}` : hostname;
  } catch {
    return rawValue
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, '');
  }
}

function canonicalListingIdentity(value = '') {
  const rawValue = String(value || '').trim().toLowerCase();

  if (!rawValue) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    const params = Array.from(url.searchParams.entries())
      .filter(([key]) => !/^utm_/i.test(key) && !['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));
    const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
    return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}${query}`;
  } catch {
    return rawValue.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/[?&]utm_[^&]*/gi, '');
  }
}

function migrateLegacyAdminMagicLinksTable(database) {
  const existingTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_magic_links'")
    .get();

  if (!existingTable) return;

  const columns = database.prepare('PRAGMA table_info(admin_magic_links)').all().map((column) => column.name);
  if (columns.includes('token_hash')) return;

  let version = 1;
  let legacyTableName = `admin_magic_links_legacy_v${version}`;
  while (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(legacyTableName)) {
    version += 1;
    legacyTableName = `admin_magic_links_legacy_v${version}`;
  }

  database.transaction(() => {
    database.exec('DROP INDEX IF EXISTS idx_admin_magic_links_expires_at');
    database.exec(`ALTER TABLE admin_magic_links RENAME TO ${legacyTableName}`);
  })();
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function canonicalAliasOwnershipError(code, message, opportunityIds = []) {
  const error = new Error(message);
  error.code = code;
  error.opportunityIds = [...opportunityIds];
  return error;
}

function completeCanonicalAliasOwners(database, aliasKeys = []) {
  const keys = normalizeList(aliasKeys, Number.MAX_SAFE_INTEGER);
  if (keys.length === 0) return [];
  const ownerIds = new Set();
  for (let offset = 0; offset < keys.length; offset += 500) {
    const chunk = keys.slice(offset, offset + 500);
    const rows = database.prepare(`
      SELECT DISTINCT opportunity_id
      FROM deal_hunter_opportunity_aliases
      WHERE alias_key IN (${placeholders(chunk.length)})
      ORDER BY opportunity_id
    `).all(...chunk);
    for (const row of rows) {
      if (!row.opportunity_id) {
        throw canonicalAliasOwnershipError(
          'DEAL_HUNTER_OPPORTUNITY_ALIAS_INTEGRITY',
          'Deal Hunter opportunity alias ownership is missing its canonical owner identifier.',
        );
      }
      ownerIds.add(row.opportunity_id);
    }
  }
  const orderedOwnerIds = [...ownerIds].sort();
  if (orderedOwnerIds.length === 0) return [];
  const ownersById = new Map();
  for (let offset = 0; offset < orderedOwnerIds.length; offset += 500) {
    const chunk = orderedOwnerIds.slice(offset, offset + 500);
    const rows = database.prepare(`
      SELECT *
      FROM deal_hunter_opportunities
      WHERE opportunity_id IN (${placeholders(chunk.length)})
      ORDER BY opportunity_id
    `).all(...chunk);
    for (const row of rows) ownersById.set(row.opportunity_id, normalizeDealHunterOpportunityRow(row));
  }
  const missingOwnerIds = orderedOwnerIds.filter((opportunityId) => !ownersById.has(opportunityId));
  if (missingOwnerIds.length > 0) {
    throw canonicalAliasOwnershipError(
      'DEAL_HUNTER_OPPORTUNITY_ALIAS_INTEGRITY',
      'Deal Hunter opportunity alias references a missing canonical opportunity.',
      missingOwnerIds,
    );
  }
  return orderedOwnerIds.map((opportunityId) => ownersById.get(opportunityId));
}

function uniqueCanonicalMergeValues(values = []) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value) !== '')
    .map((value) => String(value)))].sort();
}

async function sha256CanonicalMergeFile(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

function selectCanonicalMergeRows(database, table, filters = []) {
  const tableExists = database.prepare(`
    SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table);
  if (!tableExists) return [];
  const clauses = [];
  const params = [];
  for (const filter of filters) {
    const values = uniqueCanonicalMergeValues(filter.values);
    if (values.length === 0) continue;
    if (filter.contains) {
      clauses.push(`(${values.map(() => `instr(COALESCE(${filter.column}, ''), ?) > 0`).join(' OR ')})`);
    } else {
      clauses.push(`${filter.column} IN (${placeholders(values.length)})`);
    }
    params.push(...values);
  }
  if (clauses.length === 0) return [];
  return database.prepare(`SELECT * FROM ${table} WHERE ${clauses.join(' OR ')}`).all(...params);
}

function canonicalMergeRecordIds(table, rows = [], idColumn = 'id') {
  return uniqueCanonicalMergeValues(rows.map((row) => `${table}:${row[idColumn]}`));
}

function canonicalMergeRowsDigest(rows = []) {
  const canonicalRows = rows
    .map((row) => stableCanonicalJson(row))
    .sort();
  return createHash('sha256').update(stableCanonicalJson(canonicalRows)).digest('hex');
}

function inspectCanonicalMergePreservedIncidentState({
  approval,
  opportunityScores,
  scoreEvidence,
  sourceObservations,
  historicalIdentityEvidence,
}) {
  if (!approval.expectedPreservedState) return null;
  const ownerState = (rows) => {
    const supersededRows = rows.filter((row) => row.opportunity_id === approval.supersededId);
    const survivorRows = rows.filter((row) => row.opportunity_id === approval.survivorId);
    return {
      superseded: {
        opportunityId: approval.supersededId,
        count: supersededRows.length,
        digest: canonicalMergeRowsDigest(supersededRows),
      },
      survivor: {
        opportunityId: approval.survivorId,
        count: survivorRows.length,
        digest: canonicalMergeRowsDigest(survivorRows),
      },
    };
  };
  const sourceObservationState = ownerState(sourceObservations);
  const supersededKeys = new Set(sourceObservations
    .filter((row) => row.opportunity_id === approval.supersededId)
    .map((row) => `${row.source_id}\u0000${row.source_record_id}\u0000${row.field}`));
  const survivorKeys = new Set(sourceObservations
    .filter((row) => row.opportunity_id === approval.survivorId)
    .map((row) => `${row.source_id}\u0000${row.source_record_id}\u0000${row.field}`));
  return {
    sourceObservations: {
      ...sourceObservationState,
      collisionCount: [...supersededKeys].filter((key) => survivorKeys.has(key)).length,
    },
    opportunityScores: ownerState(opportunityScores),
    scoreEvidence: ownerState(scoreEvidence),
    historicalIdentityEvidence: {
      count: historicalIdentityEvidence.length,
      records: [...historicalIdentityEvidence]
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map((row) => ({
          id: row.id,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        })),
      digest: canonicalMergeRowsDigest(historicalIdentityEvidence),
    },
  };
}

function canonicalMergeApprovedListingUrls(approval) {
  const dealKeys = approval.expectedAliases
    .filter((item) => item.aliasType === 'deal-key')
    .map((item) => item.aliasValue);
  return uniqueCanonicalMergeValues([
    ...approval.expectedAliases
      .filter((item) => item.aliasType === 'listing-url')
      .map((item) => item.aliasValue),
    ...approval.sourceObservations.map((item) => item.listingUrl),
    ...dealKeys.filter((item) => item.startsWith('url:')).map((item) => item.slice(4)),
  ]);
}

const canonicalMergeLegacyCandidateRecordLimit = 50;

export function inspectCanonicalMergeLegacyDealHunterCandidates(database, approval) {
  const tableExists = database.prepare(`
    SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get('deal_hunter_candidates');
  if (!tableExists) return { count: 0, records: [] };

  const approvedListingIdentities = new Set(
    canonicalMergeApprovedListingUrls(approval)
      .map((value) => canonicalListingIdentity(value))
      .filter(Boolean),
  );
  let count = 0;
  const records = [];
  const candidates = database.prepare(`
    SELECT id, source_url
    FROM deal_hunter_candidates
    WHERE NULLIF(TRIM(source_url), '') IS NOT NULL
    ORDER BY id
  `).iterate();
  for (const candidate of candidates) {
    if (!approvedListingIdentities.has(canonicalListingIdentity(candidate.source_url))) continue;
    count += 1;
    if (records.length < canonicalMergeLegacyCandidateRecordLimit) {
      records.push(`deal_hunter_candidates:${candidate.id}`);
    }
  }
  return { count, records };
}

export function inspectCanonicalMergeDependentState(database, approval) {
  const opportunityIds = [approval.survivorId, approval.supersededId];
  const aliasValues = approval.expectedAliases.map((item) => item.aliasValue);
  const aliasKeys = approval.expectedAliases.map((item) => item.aliasKey);
  const dealKeys = approval.expectedAliases
    .filter((item) => item.aliasType === 'deal-key')
    .map((item) => item.aliasValue);
  const listingUrls = canonicalMergeApprovedListingUrls(approval);
  const listingIdentities = uniqueCanonicalMergeValues([
    ...approval.expectedAliases
      .filter((item) => ['listing-id', 'source-identity'].includes(item.aliasType))
      .map((item) => item.aliasValue),
    ...aliasValues,
    ...aliasKeys,
  ]);
  const referenceValues = uniqueCanonicalMergeValues([...opportunityIds, ...aliasValues, ...aliasKeys]);
  const metadataFilter = { column: 'metadata', values: referenceValues, contains: true };
  const legacyDealHunterCandidates = inspectCanonicalMergeLegacyDealHunterCandidates(database, approval);
  const crmSubmissionSupersessions = database.prepare(`
    SELECT * FROM crm_submission_supersessions
    WHERE opportunity_id IN (${placeholders(opportunityIds.length)})
    ORDER BY opportunity_id ASC, survivor_submission_id ASC,
      superseded_submission_id ASC, id ASC
  `).all(...opportunityIds);

  const opportunityScores = selectCanonicalMergeRows(database, 'deal_hunter_opportunity_scores', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    { column: 'listing_url', values: listingUrls },
  ]);
  const scoreEvidence = selectCanonicalMergeRows(database, 'deal_hunter_score_evidence', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'listing_url', values: listingUrls },
  ]);
  const operatorFacts = selectCanonicalMergeRows(database, 'deal_hunter_opportunity_facts', [
    { column: 'opportunity_id', values: opportunityIds },
  ]);
  const sourceObservations = selectCanonicalMergeRows(database, 'deal_hunter_opportunity_source_observations', [
    { column: 'opportunity_id', values: opportunityIds },
  ]);
  const directFreshnessEvidence = selectCanonicalMergeRows(database, 'deal_hunter_freshness_evidence', [
    { column: 'original_canonical_id', values: opportunityIds },
    { column: 'current_canonical_id', values: opportunityIds },
    { column: 'identity_exception_id', values: [approval.exceptionId] },
    { column: 'binding_audit_id', values: [approval.exceptionId] },
    { column: 'source_record_id', values: listingIdentities },
  ]);
  const referencedFreshnessEvidence = selectCanonicalMergeRows(database, 'deal_hunter_freshness_evidence', [
    { column: 'before_evidence_id', values: directFreshnessEvidence.map((row) => row.id) },
    { column: 'after_evidence_id', values: directFreshnessEvidence.map((row) => row.id) },
  ]);
  const freshnessEvidence = [...new Map([...directFreshnessEvidence, ...referencedFreshnessEvidence]
    .map((row) => [row.id, row])).values()];
  const contactSubmissions = selectCanonicalMergeRows(database, 'contact_submissions', [
    { column: 'deal_hunter_opportunity_id', values: opportunityIds },
    { column: 'listing_url', values: listingUrls },
    metadataFilter,
  ]);
  const crmImports = selectCanonicalMergeRows(database, 'deal_hunter_crm_imports', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    { column: 'listing_identity', values: listingIdentities },
    { column: 'listing_url', values: listingUrls },
    metadataFilter,
  ]);
  const crmReconciliationItems = selectCanonicalMergeRows(database, 'deal_hunter_crm_reconciliation_items', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    { column: 'planned_changes', values: referenceValues, contains: true },
    metadataFilter,
  ]);
  const crmReconciliationRuns = selectCanonicalMergeRows(database, 'deal_hunter_crm_reconciliation_runs', [
    { column: 'id', values: crmReconciliationItems.map((row) => row.run_id) },
    { column: 'plan', values: referenceValues, contains: true },
    { column: 'results', values: referenceValues, contains: true },
    metadataFilter,
  ]);
  const cimRequests = selectCanonicalMergeRows(database, 'deal_hunter_cim_requests', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    { column: 'listing_url', values: listingUrls },
    metadataFilter,
  ]);
  const cimReviews = selectCanonicalMergeRows(database, 'deal_hunter_cim_reviews', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    metadataFilter,
  ]);
  const opportunityClaims = selectCanonicalMergeRows(database, 'deal_hunter_cim_opportunity_claims', [
    { column: 'opportunity_id', values: opportunityIds },
    metadataFilter,
  ]);
  const recipientClaims = selectCanonicalMergeRows(database, 'deal_hunter_cim_recipient_claims', [
    { column: 'opportunity_id', values: opportunityIds },
    metadataFilter,
  ]);
  const recipientOverrides = selectCanonicalMergeRows(database, 'deal_hunter_cim_recipient_overrides', [
    { column: 'opportunity_id', values: opportunityIds },
    metadataFilter,
  ]);
  const stage2Decisions = selectCanonicalMergeRows(database, 'deal_hunter_cim_stage2_decisions', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    metadataFilter,
  ]);
  const historicalIdentityEvidence = selectCanonicalMergeRows(database, 'deal_hunter_seen_deals', [
    { column: 'id', values: [...dealKeys, ...aliasKeys, ...aliasValues] },
    { column: 'external_id', values: listingIdentities },
    { column: 'listing_url', values: listingUrls },
    metadataFilter,
  ]);
  const sourceImportPayloads = selectCanonicalMergeRows(database, 'deal_hunter_deal_os_imports', [
    { column: 'row_accounting', values: referenceValues, contains: true },
    { column: 'records', values: referenceValues, contains: true },
    metadataFilter,
  ]);
  const otherIdentityExceptions = selectCanonicalMergeRows(database, 'deal_hunter_identity_exceptions', [
    { column: 'observed_deal_key', values: dealKeys },
    { column: 'candidate_opportunity_ids', values: opportunityIds, contains: true },
    metadataFilter,
  ]).filter((row) => row.id !== approval.exceptionId);

  const submissionIds = uniqueCanonicalMergeValues([
    ...contactSubmissions.map((row) => row.id),
    ...crmImports.map((row) => row.submission_id),
    ...crmReconciliationItems.map((row) => row.submission_id),
    ...cimRequests.map((row) => row.submission_id),
  ]);
  const cimRequestIds = uniqueCanonicalMergeValues([
    ...cimRequests.map((row) => row.id),
    ...opportunityClaims.map((row) => row.request_id),
    ...recipientClaims.map((row) => row.request_id),
    ...stage2Decisions.map((row) => row.cim_request_id),
  ]);
  const communications = selectCanonicalMergeRows(database, 'crm_communications', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    { column: 'submission_id', values: submissionIds },
    { column: 'cim_request_id', values: cimRequestIds },
    metadataFilter,
  ]);
  const communicationIds = uniqueCanonicalMergeValues([
    ...communications.map((row) => row.id),
    ...stage2Decisions.map((row) => row.communication_id),
  ]);
  const providerMessageIds = uniqueCanonicalMergeValues(communications.map((row) => row.provider_message_id));
  const emailEvents = selectCanonicalMergeRows(database, 'email_events', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'submission_id', values: submissionIds },
    { column: 'communication_id', values: communicationIds },
    { column: 'message_id', values: providerMessageIds },
    metadataFilter,
  ]);
  const activityEvents = selectCanonicalMergeRows(database, 'crm_activity_events', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'submission_id', values: submissionIds },
    metadataFilter,
  ]);
  const followUpRecommendations = selectCanonicalMergeRows(database, 'crm_follow_up_recommendations', [
    { column: 'submission_id', values: submissionIds },
    { column: 'cim_request_id', values: cimRequestIds },
    { column: 'triggering_communication_id', values: communicationIds },
    metadataFilter,
  ]);
  const emailOutbox = selectCanonicalMergeRows(database, 'crm_email_outbox', [
    { column: 'submission_id', values: submissionIds },
    { column: 'cim_request_id', values: cimRequestIds },
    { column: 'communication_id', values: communicationIds },
    metadataFilter,
  ]);
  const dispositions = selectCanonicalMergeRows(database, 'deal_hunter_dispositions', [
    { column: 'deal_key', values: dealKeys },
    { column: 'listing_url', values: listingUrls },
    { column: 'submission_id', values: submissionIds },
    { column: 'communication_id', values: communicationIds },
    metadataFilter,
  ]);
  const stage2Runs = selectCanonicalMergeRows(database, 'deal_hunter_cim_stage2_runs', [
    { column: 'id', values: stage2Decisions.map((row) => row.run_id) },
    metadataFilter,
  ]);
  const scheduledJobs = selectCanonicalMergeRows(database, 'scheduled_job_runs', [metadataFilter]);
  const secureUploadRequests = selectCanonicalMergeRows(database, 'secure_upload_requests', [
    { column: 'submission_id', values: submissionIds },
  ]);
  const secureDocuments = selectCanonicalMergeRows(database, 'secure_documents', [
    { column: 'submission_id', values: submissionIds },
    { column: 'request_id', values: secureUploadRequests.map((row) => row.id) },
  ]);
  const secureCleanupJobs = selectCanonicalMergeRows(database, 'secure_document_cleanup_jobs', [
    { column: 'submission_id', values: submissionIds },
    metadataFilter,
  ]);
  const prospectDiscoveries = selectCanonicalMergeRows(database, 'prospect_discoveries', [
    { column: 'submission_id', values: submissionIds },
  ]);

  const manifestId = canonicalOpportunityMergeManifestId(approval);
  const otherRepairManifests = selectCanonicalMergeRows(database, 'deal_hunter_cim_repair_manifests', [
    { column: 'manifest', values: referenceValues, contains: true },
    metadataFilter,
  ]).filter((row) => row.id !== manifestId);
  const linkedCrmState = [
    ...secureUploadRequests.map((row) => `secure_upload_requests:${row.id}`),
    ...secureDocuments.map((row) => `secure_documents:${row.id}`),
    ...secureCleanupJobs.map((row) => `secure_document_cleanup_jobs:${row.id}`),
    ...prospectDiscoveries.map((row) => `prospect_discoveries:${row.id}`),
  ];

  const records = {
    crmSubmissionSupersessions,
    opportunityScores: canonicalMergeRecordIds('deal_hunter_opportunity_scores', opportunityScores, 'opportunity_id'),
    scoreEvidence: canonicalMergeRecordIds('deal_hunter_score_evidence', scoreEvidence),
    operatorFacts: canonicalMergeRecordIds('deal_hunter_opportunity_facts', operatorFacts),
    sourceObservations: canonicalMergeRecordIds('deal_hunter_opportunity_source_observations', sourceObservations),
    freshnessEvidence: canonicalMergeRecordIds('deal_hunter_freshness_evidence', freshnessEvidence),
    contactSubmissions: canonicalMergeRecordIds('contact_submissions', contactSubmissions),
    crmImports: canonicalMergeRecordIds('deal_hunter_crm_imports', crmImports),
    crmReconciliationItems: canonicalMergeRecordIds('deal_hunter_crm_reconciliation_items', crmReconciliationItems),
    crmReconciliationRuns: canonicalMergeRecordIds('deal_hunter_crm_reconciliation_runs', crmReconciliationRuns),
    cimRequests: canonicalMergeRecordIds('deal_hunter_cim_requests', cimRequests),
    cimReviews: canonicalMergeRecordIds('deal_hunter_cim_reviews', cimReviews),
    communications: canonicalMergeRecordIds('crm_communications', communications),
    emailEvents: canonicalMergeRecordIds('email_events', emailEvents),
    activityEvents: canonicalMergeRecordIds('crm_activity_events', activityEvents),
    opportunityClaims: canonicalMergeRecordIds('deal_hunter_cim_opportunity_claims', opportunityClaims, 'opportunity_id'),
    recipientClaims: canonicalMergeRecordIds('deal_hunter_cim_recipient_claims', recipientClaims, 'recipient_email'),
    recipientOverrides: canonicalMergeRecordIds('deal_hunter_cim_recipient_overrides', recipientOverrides),
    stage2Decisions: canonicalMergeRecordIds('deal_hunter_cim_stage2_decisions', stage2Decisions),
    followUpState: uniqueCanonicalMergeValues([
      ...followUpRecommendations.map((row) => `crm_follow_up_recommendations:${row.id}`),
      ...emailOutbox.map((row) => `crm_email_outbox:${row.id}`),
    ]),
    dispositions: canonicalMergeRecordIds('deal_hunter_dispositions', dispositions),
    historicalIdentityEvidence: canonicalMergeRecordIds('deal_hunter_seen_deals', historicalIdentityEvidence),
    legacyDealHunterCandidates: legacyDealHunterCandidates.records,
    sourceImportPayloads: canonicalMergeRecordIds('deal_hunter_deal_os_imports', sourceImportPayloads),
    otherIdentityExceptions: canonicalMergeRecordIds('deal_hunter_identity_exceptions', otherIdentityExceptions),
    stage2Runs: canonicalMergeRecordIds('deal_hunter_cim_stage2_runs', stage2Runs),
    scheduledJobs: canonicalMergeRecordIds('scheduled_job_runs', scheduledJobs, 'job_key'),
    linkedCrmState: uniqueCanonicalMergeValues(linkedCrmState),
    otherRepairManifests: canonicalMergeRecordIds('deal_hunter_cim_repair_manifests', otherRepairManifests),
  };
  const counts = Object.fromEntries(Object.entries(records).map(([category, ids]) => [category, ids.length]));
  counts.legacyDealHunterCandidates = legacyDealHunterCandidates.count;
  const preservedIncidentState = inspectCanonicalMergePreservedIncidentState({
    approval,
    opportunityScores,
    scoreEvidence,
    sourceObservations,
    historicalIdentityEvidence,
  });
  return {
    counts,
    records,
    ...(preservedIncidentState ? { preservedIncidentState } : {}),
  };
}

function inspectCanonicalMergeOperationalState(database, approval) {
  const opportunityIds = [approval.survivorId, approval.supersededId];
  const recipients = uniqueCanonicalMergeValues(database.prepare(`
    SELECT LOWER(TRIM(canonical_recipient)) AS recipient
    FROM deal_hunter_opportunities
    WHERE opportunity_id IN (${placeholders(opportunityIds.length)})
      AND NULLIF(TRIM(canonical_recipient), '') IS NOT NULL
    ORDER BY recipient
  `).all(...opportunityIds).map((row) => row.recipient));
  const deterministicRecipient = recipients.length === 1 ? recipients[0] : '';
  const suppressionCounts = deterministicRecipient
    ? database.prepare(`
        SELECT
          COUNT(*) AS total_count,
          COUNT(DISTINCT normalized_email) AS matched_recipient_count,
          SUM(CASE WHEN lifted_at IS NULL THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN lifted_at IS NOT NULL THEN 1 ELSE 0 END) AS lifted_count
        FROM email_suppressions
        WHERE normalized_email = ?
      `).get(deterministicRecipient)
    : {
        total_count: 0,
        matched_recipient_count: 0,
        active_count: 0,
        lifted_count: 0,
      };
  const stage2ActivationCounts = database.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'current' THEN 1 ELSE 0 END) AS active_count
    FROM deal_hunter_cim_stage2_activations
  `).get();
  return {
    preservedOperationalState: {
      emailSuppressions: {
        recipientResolution: deterministicRecipient
          ? 'deterministic-approved-pair'
          : 'indeterminate-approved-pair',
        matchedRecipientCount: Number(suppressionCounts.matched_recipient_count || 0),
        totalCount: Number(suppressionCounts.total_count || 0),
        activeCount: Number(suppressionCounts.active_count || 0),
        liftedCount: Number(suppressionCounts.lifted_count || 0),
        authorityEffect: 'restrictive',
      },
    },
    authorityGrantingOperationalState: {
      stage2Activations: {
        totalCount: Number(stage2ActivationCounts.total_count || 0),
        activeCount: Number(stage2ActivationCounts.active_count || 0),
        authorityEffect: 'granting',
      },
    },
  };
}

function inspectCanonicalOpportunityMergeState(database, approval) {
  const opportunityIds = [approval.survivorId, approval.supersededId];
  const opportunities = database.prepare(`
    SELECT * FROM deal_hunter_opportunities
    WHERE opportunity_id IN (${placeholders(opportunityIds.length)})
    ORDER BY opportunity_id
  `).all(...opportunityIds).map(normalizeDealHunterOpportunityRow);
  const identityException = normalizeDealHunterIdentityExceptionRow(database.prepare(`
    SELECT * FROM deal_hunter_identity_exceptions WHERE id = ? LIMIT 1
  `).get(approval.exceptionId));
  const aliases = database.prepare(`
    SELECT * FROM deal_hunter_opportunity_aliases
    WHERE opportunity_id IN (${placeholders(opportunityIds.length)})
    ORDER BY alias_type, alias_value, opportunity_id, alias_key
  `).all(...opportunityIds).map(normalizeDealHunterOpportunityAliasRow);
  const findGlobalOwners = database.prepare(`
    SELECT * FROM deal_hunter_opportunity_aliases
    WHERE alias_type = ? AND alias_value = ?
    ORDER BY opportunity_id, alias_key
  `);
  const globalAliasOwnership = approval.expectedAliases.flatMap((item) => (
    findGlobalOwners.all(item.aliasType, item.aliasValue).map(normalizeDealHunterOpportunityAliasRow)
  ));
  const manifestId = canonicalOpportunityMergeManifestId(approval);
  const manifestAtId = normalizeDealHunterRepairManifestRow(database.prepare(`
    SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ? LIMIT 1
  `).get(manifestId));
  const typedManifests = database.prepare(`
    SELECT * FROM deal_hunter_cim_repair_manifests
    WHERE mode = ?
    ORDER BY id
  `).all(CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE)
    .map(normalizeDealHunterRepairManifestRow)
    .filter((manifest) => canonicalMergeManifestClaimsTuple(manifest, approval));
  const operationalState = inspectCanonicalMergeOperationalState(database, approval);
  const dependentState = inspectCanonicalMergeDependentState(database, approval);
  return {
    opportunities,
    identityException,
    aliases,
    globalAliasOwnership,
    manifestAtId,
    typedManifests,
    dependentState,
    ...(dependentState.preservedIncidentState
      ? { preservedIncidentState: dependentState.preservedIncidentState }
      : {}),
    ...operationalState,
  };
}

function checkedCanonicalOpportunityMergeApproval(approval = {}) {
  return getCanonicalOpportunityMergeApproval(approval.incident
    ? { incident: approval.incident }
    : {
      exceptionId: approval.exceptionId,
      survivorId: approval.survivorId,
      supersededId: approval.supersededId,
    });
}

const canonicalOpportunityMergeRequiredSchema = Object.freeze({
  crm_submission_supersessions: [
    'id',
    'created_at',
    'updated_at',
    'status',
    'survivor_submission_id',
    'superseded_submission_id',
    'opportunity_id',
    'reason_code',
    'reason_text',
    'approved_by',
    'approved_at',
    'actor',
    'repair_version',
    'repair_manifest_id',
    'repair_digest',
    'reversed_at',
    'reversed_by',
    'reversal_reason',
    'reversal_manifest_id',
    'metadata',
  ],
  contact_submissions: ['id', 'deal_hunter_opportunity_id', 'listing_url', 'metadata'],
  secure_upload_requests: ['id', 'submission_id'],
  secure_documents: ['id', 'request_id', 'submission_id'],
  email_events: ['id', 'message_id', 'submission_id', 'communication_id', 'opportunity_id', 'metadata'],
  crm_activity_events: ['id', 'submission_id', 'opportunity_id', 'metadata'],
  crm_communications: [
    'id',
    'submission_id',
    'deal_key',
    'cim_request_id',
    'provider_message_id',
    'opportunity_id',
    'metadata',
  ],
  crm_email_outbox: ['id', 'communication_id', 'submission_id', 'cim_request_id', 'metadata'],
  crm_follow_up_recommendations: [
    'id',
    'submission_id',
    'cim_request_id',
    'triggering_communication_id',
    'metadata',
  ],
  deal_hunter_seen_deals: ['id', 'listing_url', 'metadata'],
  deal_hunter_deal_os_imports: ['id', 'row_accounting', 'records', 'metadata'],
  deal_hunter_cim_requests: [
    'id',
    'deal_key',
    'listing_url',
    'submission_id',
    'opportunity_id',
    'metadata',
  ],
  deal_hunter_crm_reconciliation_runs: ['id', 'plan', 'results', 'metadata'],
  deal_hunter_crm_reconciliation_items: [
    'id',
    'run_id',
    'opportunity_id',
    'deal_key',
    'submission_id',
    'planned_changes',
    'metadata',
  ],
  deal_hunter_opportunity_scores: ['opportunity_id', 'deal_key', 'listing_url'],
  deal_hunter_score_evidence: ['id', 'opportunity_id', 'listing_url'],
  deal_hunter_opportunity_facts: ['id', 'opportunity_id'],
  deal_hunter_opportunity_source_observations: ['id', 'opportunity_id', 'source_id', 'source_record_id'],
  deal_hunter_cim_reviews: ['id', 'deal_key', 'opportunity_id', 'metadata'],
  deal_hunter_crm_imports: [
    'id',
    'deal_key',
    'listing_identity',
    'listing_url',
    'submission_id',
    'opportunity_id',
    'metadata',
  ],
  deal_hunter_opportunities: [
    'opportunity_id',
    'created_at',
    'updated_at',
    'canonical_name',
    'canonical_recipient',
    'canonical_location',
    'primary_submission_id',
    'identity_version',
    'status',
    'metadata',
  ],
  deal_hunter_opportunity_aliases: [
    'id',
    'opportunity_id',
    'alias_type',
    'alias_value',
    'alias_key',
    'source',
    'first_observed_at',
    'last_observed_at',
    'evidence_version',
    'resolution_method',
    'confidence_state',
    'resolved_by',
    'metadata',
  ],
  deal_hunter_identity_exceptions: [
    'id',
    'created_at',
    'updated_at',
    'status',
    'observed_deal_key',
    'candidate_opportunity_ids',
    'reason',
    'evidence_version',
    'resolved_at',
    'resolved_by',
    'resolution_reason',
    'metadata',
  ],
  deal_hunter_cim_opportunity_claims: ['opportunity_id', 'request_id', 'metadata'],
  deal_hunter_cim_recipient_overrides: ['id', 'opportunity_id', 'metadata'],
  deal_hunter_cim_recipient_claims: ['recipient_email', 'request_id', 'opportunity_id', 'metadata'],
  deal_hunter_cim_safety_settings: ['id', 'updated_at', 'outreach_paused'],
  deal_hunter_cim_repair_manifests: [
    'id',
    'created_at',
    'updated_at',
    'mode',
    'status',
    'actor',
    'backup_reference',
    'checksum',
    'manifest',
    'metadata',
  ],
  deal_hunter_cim_stage2_runs: ['id', 'metadata'],
  deal_hunter_cim_stage2_decisions: [
    'id',
    'run_id',
    'opportunity_id',
    'deal_key',
    'cim_request_id',
    'communication_id',
    'metadata',
  ],
  deal_hunter_dispositions: [
    'id',
    'deal_key',
    'submission_id',
    'communication_id',
    'listing_url',
    'metadata',
  ],
  scheduled_job_runs: ['job_key', 'metadata'],
  secure_document_cleanup_jobs: ['id', 'submission_id', 'metadata'],
});

function assertCanonicalOpportunityMergeSqliteSchema(database) {
  const missing = [];
  const actualColumnsByTable = new Map(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => [
    name,
    // Include ordinary, virtual-table implementation, and generated columns in the same fail-closed classifier.
    new Set(database.prepare('SELECT name FROM pragma_table_xinfo(?)').all(name).map((row) => row.name)),
  ]));
  for (const [table, requiredColumns] of Object.entries(canonicalOpportunityMergeRequiredSchema)) {
    const presentColumns = actualColumnsByTable.get(table);
    if (!presentColumns) {
      missing.push(`${table} (table)`);
      continue;
    }
    for (const column of requiredColumns) {
      if (!presentColumns.has(column)) missing.push(`${table}.${column}`);
    }
  }
  const inventoryKeys = new Set(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries
    .map((entry) => `${entry.table}.${entry.column}`));
  const inventoryPresenceByTable = canonicalOpportunityMergeRelationshipSchemaPresenceByTable();
  for (const entry of CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries) {
    const columns = actualColumnsByTable.get(entry.table);
    if (!columns) {
      if (
        inventoryPresenceByTable.get(entry.table)
        !== CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.OPTIONAL_LEGACY
      ) {
        missing.push(`${entry.table} (relationship inventory table)`);
      }
    } else if (!columns.has(entry.column)) {
      missing.push(`${entry.table}.${entry.column}`);
    }
  }
  const unclassified = [];
  for (const [table, columns] of actualColumnsByTable) {
    for (const column of columns) {
      if (
        isCanonicalOpportunityMergeRelationshipColumn(column)
        && !inventoryKeys.has(`${table}.${column}`)
      ) {
        unclassified.push(`${table}.${column}`);
      }
    }
  }
  if (missing.length > 0 || unclassified.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing required repair schema: ${[...new Set(missing)].sort().join(', ')}`);
    if (unclassified.length > 0) details.push(`unclassified relationship schema: ${unclassified.sort().join(', ')}`);
    throw new Error(
      `Canonical opportunity merge refused unsupported SQLite schema; ${details.join('; ')}.`,
    );
  }
}

function canonicalMergeFileFingerprint(filePath, { optional = false } = {}) {
  let before;
  try {
    before = fs.statSync(filePath, { bigint: true });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile()) throw new Error(`Canonical opportunity merge source is not a regular file: ${filePath}.`);
  const descriptor = fs.openSync(filePath, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.statSync(filePath, { bigint: true });
  const stable = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    .every((field) => before[field] === after[field]);
  if (!stable) throw new Error(`Canonical opportunity merge source changed while hashing ${filePath}.`);
  return {
    dev: String(after.dev),
    ino: String(after.ino),
    size: String(after.size),
    mtimeNs: String(after.mtimeNs),
    ctimeNs: String(after.ctimeNs),
    sha256: digest.digest('hex'),
  };
}

function captureCanonicalMergeSourceFiles(sourcePath) {
  return {
    database: canonicalMergeFileFingerprint(sourcePath),
    wal: canonicalMergeFileFingerprint(`${sourcePath}-wal`, { optional: true }),
    journal: canonicalMergeFileFingerprint(`${sourcePath}-journal`, { optional: true }),
  };
}

function removeCanonicalMergeSnapshotFiles(snapshotPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${snapshotPath}${suffix}`, { force: true });
  }
}

function createStableCanonicalMergeSqliteSnapshot(sqlitePath) {
  const sourcePath = fs.realpathSync(path.resolve(sqlitePath));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-canonical-merge-readonly-'));
  const snapshotPath = path.join(temporaryDirectory, 'snapshot.sqlite');
  let lastError = null;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      removeCanonicalMergeSnapshotFiles(snapshotPath);
      try {
        const before = captureCanonicalMergeSourceFiles(sourcePath);
        if (before.journal) {
          throw new Error('Canonical opportunity merge refused a SQLite source with an active rollback journal.');
        }
        fs.copyFileSync(sourcePath, snapshotPath);
        if (before.wal) fs.copyFileSync(`${sourcePath}-wal`, `${snapshotPath}-wal`);
        const after = captureCanonicalMergeSourceFiles(sourcePath);
        const copied = captureCanonicalMergeSourceFiles(snapshotPath);
        if (
          after.journal
          || JSON.stringify(before) !== JSON.stringify(after)
          || copied.database.sha256 !== after.database.sha256
          || copied.wal?.sha256 !== after.wal?.sha256
        ) {
          throw new Error('Canonical opportunity merge source changed while creating its read-only snapshot.');
        }
        const header = Buffer.alloc(20);
        const descriptor = fs.openSync(snapshotPath, 'r');
        try {
          if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
            throw new Error('Canonical opportunity merge source has an invalid SQLite header.');
          }
        } finally {
          fs.closeSync(descriptor);
        }
        if (header.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
          throw new Error('Canonical opportunity merge source is not a SQLite 3 database.');
        }
        if (header[18] !== 2 || header[19] !== 2) {
          throw new Error('Canonical opportunity merge read-only inspection requires a stable SQLite WAL-mode source.');
        }
        return { databasePath: snapshotPath, temporaryDirectory };
      } catch (error) {
        lastError = error;
      }
    }
  } catch (error) {
    lastError = error;
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  throw new Error(`Canonical opportunity merge could not create a stable read-only SQLite snapshot: ${lastError?.message || 'unknown error'}`);
}

function inspectCanonicalOpportunityMerge(database, { approval, actor = '', reason = '' } = {}) {
  assertCanonicalOpportunityMergeSqliteSchema(database);
  const checkedApproval = checkedCanonicalOpportunityMergeApproval(approval);
  const inspection = inspectCanonicalOpportunityMergeState(database, checkedApproval);
  if (inspection.manifestAtId) {
    const replay = validateCanonicalOpportunityMergeReplayManifest({
      approval: checkedApproval,
      manifest: inspection.manifestAtId,
      actor,
      reason,
      expectedPlanChecksum: inspection.manifestAtId.checksum,
    });
    const finalState = validateCanonicalMergeFinalState(database, {
      approval: checkedApproval,
      actor: replay.actor,
      reason: replay.reason,
      planChecksum: replay.planChecksum,
      manifestId: replay.manifestId,
    });
    return {
      alreadyApplied: true,
      planChecksum: replay.planChecksum,
      manifestId: replay.manifestId,
      plan: replay.plan,
      manifest: finalState.manifest,
      finalState,
    };
  }
  return buildCanonicalOpportunityMergePlan({ approval: checkedApproval, inspection, actor, reason });
}

function canonicalMergeManifestClaimsTuple(manifest, approval) {
  const expected = [approval.exceptionId, approval.survivorId, approval.supersededId];
  const tuples = [
    manifest?.manifest?.approvalTuple,
    manifest?.manifest?.plan?.approvalTuple,
    manifest?.metadata && {
      exceptionId: manifest.metadata.exceptionId,
      survivorId: manifest.metadata.survivorId,
      supersededId: manifest.metadata.supersededId,
    },
  ];
  return tuples.some((tuple) => (
    tuple?.exceptionId === expected[0]
    && tuple?.survivorId === expected[1]
    && tuple?.supersededId === expected[2]
  ));
}

function assertCanonicalMergeAliasPostconditions(database, approval) {
  const canonicalIds = [approval.survivorId, approval.supersededId];
  const ownedAliases = database.prepare(`
    SELECT id, alias_key, alias_type, alias_value, opportunity_id
    FROM deal_hunter_opportunity_aliases
    WHERE opportunity_id IN (${placeholders(canonicalIds.length)})
    ORDER BY alias_key, opportunity_id
  `).all(...canonicalIds);
  const expectedOwnedAliases = approval.expectedAliases
    .map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      alias_key: item.aliasKey,
      alias_type: item.aliasType,
      alias_value: item.aliasValue,
      opportunity_id: approval.survivorId,
    }))
    .sort((left, right) => left.alias_key.localeCompare(right.alias_key));
  if (
    ownedAliases.length !== expectedOwnedAliases.length
    || ownedAliases.some((row, index) => (
      row.alias_key !== expectedOwnedAliases[index].alias_key
      || (expectedOwnedAliases[index].id && row.id !== expectedOwnedAliases[index].id)
      || row.alias_type !== expectedOwnedAliases[index].alias_type
      || row.alias_value !== expectedOwnedAliases[index].alias_value
      || row.opportunity_id !== expectedOwnedAliases[index].opportunity_id
    ))
  ) {
    throw new Error('Canonical opportunity merge approved alias ownership set failed its final-state postcondition.');
  }
  const findOwners = database.prepare(`
    SELECT * FROM deal_hunter_opportunity_aliases
    WHERE alias_type = ? AND alias_value = ?
    ORDER BY opportunity_id, alias_key
  `);
  const aliases = [];
  for (const expected of approval.expectedAliases) {
    const rows = findOwners.all(expected.aliasType, expected.aliasValue);
    if (
      rows.length !== 1
      || (expected.id && rows[0].id !== expected.id)
      || rows[0].opportunity_id !== approval.survivorId
      || rows[0].alias_key !== expected.aliasKey
    ) {
      throw new Error(`Canonical opportunity merge alias postcondition failed for ${expected.aliasKey}.`);
    }
    aliases.push(normalizeDealHunterOpportunityAliasRow(rows[0]));
  }
  const losingAliasCount = database.prepare(`
    SELECT COUNT(*) AS count FROM deal_hunter_opportunity_aliases WHERE opportunity_id = ?
  `).get(approval.supersededId).count;
  if (Number(losingAliasCount) !== 0) {
    throw new Error('Canonical opportunity merge left aliases on the superseded opportunity.');
  }
  for (const observation of approval.sourceObservations) {
    if (!Array.isArray(observation.durableAliasKeys) || observation.durableAliasKeys.length === 0) {
      throw new Error(`Approved source observation ${observation.sourceRecordId} has no durable identity postcondition.`);
    }
    const rows = database.prepare(`
      SELECT alias_key, opportunity_id
      FROM deal_hunter_opportunity_aliases
      WHERE alias_key IN (${placeholders(observation.durableAliasKeys.length)})
      ORDER BY alias_key
    `).all(...observation.durableAliasKeys);
    if (
      rows.length !== observation.durableAliasKeys.length
      || rows.some((row) => row.opportunity_id !== approval.survivorId)
    ) {
      throw new Error(`Approved source observation ${observation.sourceRecordId} can still resolve outside the survivor.`);
    }
  }
  return aliases.sort((left, right) => left.alias_key.localeCompare(right.alias_key));
}

function validateCanonicalMergeFinalState(database, {
  approval,
  actor,
  reason,
  planChecksum,
  manifestId,
} = {}) {
  const manifest = normalizeDealHunterRepairManifestRow(database.prepare(`
    SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ? LIMIT 1
  `).get(manifestId));
  const appliedAt = manifest?.manifest?.appliedAt;
  const aliases = assertCanonicalMergeAliasPostconditions(database, approval);
  const survivor = normalizeDealHunterOpportunityRow(database.prepare(`
    SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
  `).get(approval.survivorId));
  const superseded = normalizeDealHunterOpportunityRow(database.prepare(`
    SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
  `).get(approval.supersededId));
  if (survivor?.status !== 'active') throw new Error('Canonical opportunity merge survivor is not active after apply.');
  if (superseded?.status !== 'superseded') throw new Error('Canonical opportunity merge loser was not superseded.');
  const mergeMetadata = superseded.metadata?.canonicalOpportunityMerge;
  if (
    mergeMetadata?.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || mergeMetadata?.schemaVersion !== 1
    || mergeMetadata?.mergedInto !== approval.survivorId
    || mergeMetadata?.supersededOpportunityId !== approval.supersededId
    || mergeMetadata?.exceptionId !== approval.exceptionId
    || mergeMetadata?.actor !== actor
    || mergeMetadata?.reason !== reason
    || mergeMetadata?.planChecksum !== planChecksum
    || mergeMetadata?.supersededAt !== appliedAt
    || superseded.updated_at !== appliedAt
  ) {
    throw new Error('Canonical opportunity merge supersession metadata failed final validation.');
  }
  const identityException = normalizeDealHunterIdentityExceptionRow(database.prepare(`
    SELECT * FROM deal_hunter_identity_exceptions WHERE id = ? LIMIT 1
  `).get(approval.exceptionId));
  const exceptionMerge = identityException?.metadata?.canonicalOpportunityMerge;
  const candidateIds = uniqueCanonicalMergeValues(identityException?.candidate_opportunity_ids);
  const expectedCandidateIds = uniqueCanonicalMergeValues(
    approval.expectedExceptionCandidateOpportunityIds
      ?? [approval.survivorId, approval.supersededId],
  );
  if (
    identityException?.status !== 'resolved'
    || identityException?.updated_at !== appliedAt
    || identityException?.resolved_at !== appliedAt
    || identityException?.resolved_by !== actor
    || identityException?.resolution_reason !== reason
    || identityException?.reason !== approval.expectedExceptionReason
    || identityException?.evidence_version !== approval.expectedEvidenceVersion
    || candidateIds.length !== expectedCandidateIds.length
    || candidateIds.some((id, index) => id !== expectedCandidateIds[index])
    || exceptionMerge?.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || exceptionMerge?.schemaVersion !== 1
    || exceptionMerge?.decision !== 'merge'
    || exceptionMerge?.survivorId !== approval.survivorId
    || exceptionMerge?.supersededId !== approval.supersededId
    || exceptionMerge?.planChecksum !== planChecksum
  ) {
    throw new Error('Canonical opportunity merge exception resolution failed final validation.');
  }
  const typedManifests = database.prepare(`
    SELECT * FROM deal_hunter_cim_repair_manifests WHERE mode = ? ORDER BY id
  `).all(CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE)
    .map(normalizeDealHunterRepairManifestRow)
    .filter((row) => canonicalMergeManifestClaimsTuple(row, approval));
  validateCanonicalOpportunityMergeReplayManifest({
    approval,
    manifest,
    actor,
    reason,
    expectedPlanChecksum: planChecksum,
  });
  if (
    !manifest
    || typedManifests.length !== 1
    || typedManifests[0].id !== manifestId
    || manifest.mode !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || manifest.status !== 'applied'
    || manifest.checksum !== planChecksum
    || manifest.manifest?.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || manifest.manifest?.manifestSchema !== CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA
    || manifest.metadata?.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
  ) {
    throw new Error('Canonical opportunity merge manifest failed typed final validation.');
  }
  const dependentState = inspectCanonicalMergeDependentState(database, approval);
  if (!Array.isArray(dependentState?.records?.crmSubmissionSupersessions)) {
    throw new Error('Canonical opportunity merge final state could not inspect CRM submission supersession history completely.');
  }
  const unexpected = Object.entries(dependentState.counts).filter(([name, count]) => (
    count !== Number(approval.expectedDependentCounts?.[name] || 0)
  ));
  if (dependentState.records.crmSubmissionSupersessions.length !== 0) {
    throw new Error('Canonical opportunity merge final state acquired unexpected dependents: crmSubmissionSupersessions.');
  }
  if (unexpected.length > 0) {
    throw new Error(`Canonical opportunity merge final state acquired unexpected dependents: ${unexpected.map(([name]) => name).join(', ')}.`);
  }
  if (
    approval.expectedPreservedState
    && stableCanonicalJson(dependentState.preservedIncidentState)
      !== stableCanonicalJson(manifest.manifest?.plan?.preservedIncidentState)
  ) {
    throw new Error('Canonical opportunity merge final state changed approved preserved incident rows.');
  }
  return { survivor, superseded, identityException, aliases, manifest, dependentState };
}

const crmDuplicateConsolidationMaximumRows = 250000;

const crmDuplicateConsolidationRequiredSchemaObjects = Object.freeze([
  ['index', 'idx_crm_submission_supersessions_survivor'],
  ['index', 'idx_crm_submission_supersessions_opportunity'],
  ['index', 'uq_crm_submission_supersessions_active_loser'],
  ['trigger', 'trg_crm_duplicate_consolidation_receipt_no_update'],
  ['trigger', 'trg_crm_duplicate_consolidation_receipt_no_delete'],
  ['trigger', 'trg_crm_submission_supersessions_validate_insert'],
  ['trigger', 'trg_crm_submission_supersessions_no_active_chain_insert'],
  ['trigger', 'trg_crm_submission_supersessions_no_active_chain_update'],
  ['trigger', 'trg_crm_submission_supersessions_immutable_update'],
  ['trigger', 'trg_crm_submission_supersessions_reverse_only'],
  ['trigger', 'trg_crm_submission_supersessions_no_delete'],
  ['trigger', 'trg_crm_submission_supersessions_guard_contact_owner_update'],
  ['trigger', 'trg_crm_submission_supersessions_guard_opportunity_update'],
  ['trigger', 'trg_deal_hunter_opportunities_reject_superseded_primary_insert'],
  ['trigger', 'trg_deal_hunter_opportunities_reject_superseded_primary_update'],
  ['trigger', 'trg_crm_submission_supersessions_guard_contact_delete'],
  ['trigger', 'trg_crm_submission_supersessions_guard_opportunity_delete'],
]);

function quoteCrmDuplicateConsolidationIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function compareCrmDuplicateConsolidationText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function crmDuplicateConsolidationSchema(database) {
  return database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((table) => ({
    name: table.name,
    sqlDigest: createHash('sha256').update(String(table.sql || '')).digest('hex'),
    columns: database.pragma(`table_info(${JSON.stringify(table.name)})`).map((column) => ({
      cid: Number(column.cid),
      name: column.name,
      type: column.type,
      notNull: Boolean(column.notnull),
      defaultValue: column.dflt_value,
      primaryKey: Number(column.pk),
    })),
  }));
}

function crmDuplicateConsolidationRequiredObjects(database) {
  return crmDuplicateConsolidationRequiredSchemaObjects.map(([type, name]) => {
    const row = database.prepare(`
      SELECT type, name, sql FROM sqlite_schema
      WHERE type = ? AND name = ? LIMIT 1
    `).get(type, name);
    return row ? {
      type,
      name,
      sqlDigest: createHash('sha256').update(String(row.sql || '')).digest('hex'),
    } : { type, name, missing: true };
  }).sort((left, right) => compareCrmDuplicateConsolidationText(left.name, right.name));
}

function assertCrmDuplicateConsolidationRequiredObjects(database, expected, phase) {
  const actual = crmDuplicateConsolidationRequiredObjects(database);
  if (actual.some((entry) => entry.missing)
    || stableCrmDuplicateConsolidationJson(actual) !== stableCrmDuplicateConsolidationJson(expected)) {
    throw new Error(`CRM duplicate consolidation ${phase} required schema object drift.`);
  }
  return actual;
}

function crmDuplicateConsolidationDatabaseState(database) {
  const schema = crmDuplicateConsolidationSchema(database);
  const requiredObjects = crmDuplicateConsolidationRequiredObjects(database);
  const schemaNames = new Set(schema.map((table) => table.name));
  for (const name of CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES) {
    if (!schemaNames.has(name)) {
      throw new Error(`CRM duplicate consolidation required schema table missing: ${name}.`);
    }
  }
  const authoritativeTables = schema.filter((table) => (
    !CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(table.name)
  ));
  let authorityTotalRows = 0;
  const rowsByAuthoritativeTable = {};
  const authorityTableDigests = {};
  for (const table of authoritativeTables) {
    const quotedTable = quoteCrmDuplicateConsolidationIdentifier(table.name);
    const count = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quotedTable}`).get()?.count || 0);
    authorityTotalRows += count;
    if (authorityTotalRows > crmDuplicateConsolidationMaximumRows) {
      throw new Error('CRM duplicate consolidation inspection row bound exceeded.');
    }
    const rows = database.prepare(`SELECT * FROM ${quotedTable}`).all()
      .sort((left, right) => compareCrmDuplicateConsolidationText(
        stableCrmDuplicateConsolidationJson(left),
        stableCrmDuplicateConsolidationJson(right),
      ));
    rowsByAuthoritativeTable[table.name] = rows;
    authorityTableDigests[table.name] = {
      rowCount: rows.length,
      digest: canonicalJsonSha256(rows),
    };
  }
  return {
    schema,
    requiredObjects,
    schemaDigest: canonicalJsonSha256({ tables: schema, requiredObjects }),
    rowsByAuthoritativeTable,
    authorityTableDigests,
    authorityLogicalDigest: canonicalJsonSha256(rowsByAuthoritativeTable),
    authorityTotalRows,
  };
}

function parseCrmDuplicateConsolidationMetadata(value) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function crmDuplicateConsolidationRawDigest(row) {
  return canonicalJsonSha256(row || null);
}

function crmDuplicateConsolidationUnchangedMutationDigests(database) {
  const exclusions = {
    crm_submission_supersessions: new Set(
      CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map(crmDuplicateConsolidationRelationId),
    ),
    deal_hunter_crm_imports: new Set([CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id]),
    deal_hunter_cim_repair_manifests: new Set([crmDuplicateConsolidationManifestId()]),
  };
  return Object.fromEntries(Object.entries(exclusions).map(([table, excludedIds]) => {
    const rows = database.prepare(`SELECT * FROM ${quoteCrmDuplicateConsolidationIdentifier(table)}`).all()
      .filter((row) => !excludedIds.has(row.id))
      .sort((left, right) => compareCrmDuplicateConsolidationText(
        stableCrmDuplicateConsolidationJson(left),
        stableCrmDuplicateConsolidationJson(right),
      ));
    return [table, { rowCount: rows.length, digest: canonicalJsonSha256(rows) }];
  }));
}

function crmDuplicateConsolidationUnchangedBerlinColumns(row) {
  return Object.fromEntries(Object.entries(row || {}).filter(([column]) => (
    !['submission_id', 'updated_at', 'metadata'].includes(column)
  )));
}

function crmDuplicateConsolidationListingMatches(row, pair, { allowMissing = false } = {}) {
  const metadata = parseCrmDuplicateConsolidationMetadata(row?.metadata);
  const dealHunter = metadata?.dealHunter || {};
  return inspectCrmDuplicateConsolidationMarketplaceIdentity({
    listingUrl: row?.listing_url,
    listingAliases: Object.hasOwn(dealHunter, 'listingAliases')
      ? dealHunter.listingAliases
      : undefined,
    identityAliases: Object.hasOwn(dealHunter, 'identityAliases')
      ? dealHunter.identityAliases
      : undefined,
    expectedIdentity: pair.listingIdentity,
    allowAllAbsent: allowMissing,
  });
}

function crmDuplicateConsolidationFinancialMatches(row, pair) {
  return crmDuplicateConsolidationFinancialEvidenceMatches(row, pair);
}

const crmDuplicateConsolidationApprovedReferenceIdentifiers = Object.freeze([
  ...CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.flatMap((pair) => [
    pair.opportunityId,
    pair.survivorSubmissionId,
    pair.supersededSubmissionId,
    pair.listingIdentity,
  ]),
  'b272125b030c6d097808fa82126b6afa0799fda456fc3465be51a0f0cea7a52e',
  'aba23259c8a36685199482500aff468493221c0ff844966c2f6b9c148d72ad01',
  '49e8541d-3463-44e9-b032-02563b47317f',
  'a169ba9c-6b96-41f1-a18b-5c8521ebdc54',
  'cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31',
  'fa231f927904b40a3ef6fd762f37b7830e9aab92c013d39ed740f51e3c84bfd0',
  '42fefa5e5de8bba6676bf97ccb49a2c5364a469dc6da57b4af6ff9087141bede',
  '4e2075ca935de95f09a80bdcdc51ac513c9ab5864f384d20f7ad123f139357ad',
  CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id,
]);

function collectCrmDuplicateConsolidationEvidenceTokens(value, key = '', output = []) {
  if (output.length >= 512 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectCrmDuplicateConsolidationEvidenceTokens(item, key, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      collectCrmDuplicateConsolidationEvidenceTokens(nestedValue, nestedKey, output);
    }
    return output;
  }
  if (typeof value === 'string'
    && /(?:alias|evidence|listingIdentity|dealKey)/i.test(key)
    && value.length >= 4
    && value.length <= 500) {
    output.push(value);
  }
  return output;
}

function crmDuplicateConsolidationReferenceTokens(state) {
  const dynamic = [];
  const scopedSubmissionIds = new Set(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.flatMap((pair) => [
    pair.survivorSubmissionId,
    pair.supersededSubmissionId,
  ]));
  for (const row of state.rowsByAuthoritativeTable.contact_submissions || []) {
    if (!scopedSubmissionIds.has(row.id)) continue;
    collectCrmDuplicateConsolidationEvidenceTokens(
      parseCrmDuplicateConsolidationMetadata(row.metadata)?.dealHunter,
      'dealHunter',
      dynamic,
    );
  }
  const scopedOpportunityIds = new Set(
    CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.opportunityId),
  );
  for (const row of state.rowsByAuthoritativeTable.deal_hunter_opportunity_aliases || []) {
    if (!scopedOpportunityIds.has(row.opportunity_id)) continue;
    for (const [column, value] of Object.entries(row)) {
      if (/(?:alias|evidence|listing|deal_key)/i.test(column)
        && typeof value === 'string' && value.length >= 4 && value.length <= 500) {
        dynamic.push(value);
      }
    }
  }
  const approved = [...new Set(crmDuplicateConsolidationApprovedReferenceIdentifiers)].sort(
    compareCrmDuplicateConsolidationText,
  );
  const tokens = [...new Set([...approved, ...dynamic])]
    .filter((token) => typeof token === 'string' && token.length >= 4 && token.length <= 500)
    .sort(compareCrmDuplicateConsolidationText);
  if (tokens.length > 512) throw new Error('CRM duplicate consolidation reference-token bound exceeded.');
  return { approved, tokens };
}

function crmDuplicateConsolidationReferencePolicies(table, matchedRows, classification) {
  if (classification === 'unclassified-positive-reference') return ['blocked-unclassified-reference'];
  if (table === 'deal_hunter_cim_repair_manifests') return ['retained-historical-receipt'];
  if (table === 'crm_submission_supersessions') return ['mutated-approved-relation'];
  if (table === 'deal_hunter_crm_imports') {
    const policies = [];
    if (matchedRows.some((row) => row.id === CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id)) {
      policies.push('mutated-berlin-import-only');
    }
    if (matchedRows.some((row) => row.id !== CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id)) {
      policies.push('retained-preserved-import');
    }
    return policies;
  }
  return matchedRows.length ? ['retained-with-provenance'] : ['scanned-no-incident-reference'];
}

function crmDuplicateConsolidationReferenceInventory(state) {
  const { approved, tokens } = crmDuplicateConsolidationReferenceTokens(state);
  const references = [];
  for (const table of state.schema) {
    if (CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(table.name)) continue;
    const rows = state.rowsByAuthoritativeTable[table.name];
    for (const column of table.columns) {
      if (!/TEXT/i.test(String(column.type))) continue;
      const configuredClassification = classifyCrmDuplicateConsolidationTextReference({
        table: table.name,
        column: column.name,
      });
      const matchedRows = [];
      const matchedIdentifiers = new Set();
      for (const row of rows) {
        const value = row[column.name];
        if (value === null || value === undefined) continue;
        const serialized = String(value);
        const rowMatches = tokens.filter((token) => serialized.includes(token));
        if (rowMatches.length === 0) continue;
        matchedRows.push(row);
        for (const token of rowMatches) matchedIdentifiers.add(token);
      }
      const classification = configuredClassification
        || (matchedRows.length ? 'unclassified-positive-reference' : 'scanned-no-incident-reference');
      references.push({
        table: table.name,
        column: column.name,
        classification,
        policies: crmDuplicateConsolidationReferencePolicies(table.name, matchedRows, classification),
        matchedRowCount: matchedRows.length,
        matchedRowsDigest: canonicalJsonSha256(matchedRows),
        matchedIdentifierCount: matchedIdentifiers.size,
        matchedIdentifiersDigest: canonicalJsonSha256([...matchedIdentifiers].sort(
          compareCrmDuplicateConsolidationText,
        )),
      });
    }
  }
  return {
    entries: references.sort((left, right) => (
      compareCrmDuplicateConsolidationText(left.table, right.table)
        || compareCrmDuplicateConsolidationText(left.column, right.column)
    )),
    identifiers: {
      approvedCount: approved.length,
      totalCount: tokens.length,
      digest: canonicalJsonSha256(tokens),
    },
    blockers: references.filter((entry) => (
      entry.matchedRowCount > 0 && entry.classification === 'unclassified-positive-reference'
    )).map((entry) => `unclassified positive incident reference: ${entry.table}.${entry.column}`),
  };
}

function crmDuplicateConsolidationRowsForIds(database, table, column, ids) {
  const quotedTable = quoteCrmDuplicateConsolidationIdentifier(table);
  const quotedColumn = quoteCrmDuplicateConsolidationIdentifier(column);
  return database.prepare(`
    SELECT * FROM ${quotedTable}
    WHERE ${quotedColumn} IN (${placeholders(ids.length)})
    ORDER BY ${quotedColumn}
  `).all(...ids);
}

function crmDuplicateConsolidationBerlinIdentityBlockers(database, {
  survivor,
  superseded,
  opportunity,
} = {}) {
  const blockers = [];
  const pair = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.find((item) => item.key === 'berlin');
  const survivorMetadata = parseCrmDuplicateConsolidationMetadata(survivor?.metadata);
  const supersededMetadata = parseCrmDuplicateConsolidationMetadata(superseded?.metadata);
  const survivorDealHunter = survivorMetadata?.dealHunter;
  const supersededDealHunter = supersededMetadata?.dealHunter;

  if (!opportunity
    || opportunity.status !== 'active'
    || opportunity.primary_submission_id !== pair.survivorSubmissionId
    || opportunity.identity_version !== 'cim-opportunity-v1') {
    blockers.push('berlin-canonical-opportunity-authority-drift');
  }
  if (!survivor
    || (survivor.deal_hunter_opportunity_id !== null
      && survivor.deal_hunter_opportunity_id !== pair.opportunityId)
    || survivorDealHunter?.opportunityId !== pair.opportunityId) {
    blockers.push('berlin-survivor-owner-drift');
  }
  const supersededPrimaryCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM deal_hunter_opportunities
    WHERE primary_submission_id = ?
  `).get(pair.supersededSubmissionId)?.count || 0);
  if (!superseded
    || superseded.deal_hunter_opportunity_id !== null
    || Object.hasOwn(supersededDealHunter || {}, 'opportunityId')
    || supersededPrimaryCount !== 0) {
    blockers.push('berlin-superseded-owner-or-primary-drift');
  }
  if (superseded?.listing_url !== ''
    || ['listingAliases', 'identityAliases', 'dealKeyAliases', 'sourceRecords']
      .some((key) => Object.hasOwn(supersededDealHunter || {}, key))) {
    blockers.push('berlin-superseded-missing-evidence-shape-drift');
  }
  if (!crmDuplicateConsolidationRawStringMatchesSha256(
    supersededDealHunter?.dealKey,
    pair.supersededDealKeySha256,
  )) {
    blockers.push('berlin-superseded-deal-key-digest-drift');
  }
  if (supersededDealHunter?.sourceId !== pair.supersededSource.sourceId
    || supersededDealHunter?.sourceMode !== pair.supersededSource.sourceMode
    || supersededDealHunter?.externalId !== pair.supersededSource.externalId) {
    blockers.push('berlin-superseded-source-pointer-drift');
  }
  const survivorAliases = survivorDealHunter?.dealKeyAliases;
  if (!Array.isArray(survivorAliases)
    || survivorAliases.some((value) => typeof value !== 'string' || !value)
    || survivorAliases.filter((value) => crmDuplicateConsolidationRawStringMatchesSha256(
      value,
      pair.supersededDealKeySha256,
    )).length !== 1) {
    blockers.push('berlin-survivor-deal-key-corroboration-drift');
  }

  const legacy = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1
  `).get(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id);
  const legacyMetadata = parseCrmDuplicateConsolidationMetadata(legacy?.metadata);
  if (!legacy
    || legacy.submission_id !== pair.supersededSubmissionId
    || legacy.opportunity_id !== null
    || !crmDuplicateConsolidationRawStringMatchesSha256(
      legacy.deal_key,
      pair.supersededDealKeySha256,
    )
    || legacy.listing_url !== ''
    || legacy.listing_identity !== ''
    || legacyMetadata?.sourceId !== CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.sourceId
    || legacyMetadata?.sourceMode !== CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.sourceMode
    || Object.hasOwn(legacyMetadata || {}, 'opportunityId')) {
    blockers.push('berlin-legacy-import-identity-drift');
  }

  const canonical = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1
  `).get(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinCanonicalImport.id);
  const canonicalMetadata = parseCrmDuplicateConsolidationMetadata(canonical?.metadata);
  const survivorListing = crmDuplicateConsolidationListingMatches(survivor, pair);
  const canonicalListingIdentity = normalizeDealHunterListingIdentity(survivor?.listing_url);
  if (!canonical
    || canonical.submission_id !== pair.survivorSubmissionId
    || canonical.opportunity_id !== pair.opportunityId
    || typeof survivorDealHunter?.dealKey !== 'string'
    || !survivorDealHunter.dealKey
    || canonical.deal_key !== survivorDealHunter.dealKey
    || canonical.listing_url !== survivor.listing_url
    || !canonicalListingIdentity
    || canonical.listing_identity !== canonicalListingIdentity
    || canonicalMetadata?.sourceId !== pair.supersededSource.sourceId
    || canonicalMetadata?.sourceMode !== pair.supersededSource.sourceMode
    || Object.hasOwn(canonicalMetadata || {}, 'opportunityId')
    || !survivorListing.valid) {
    blockers.push('berlin-canonical-import-identity-drift');
  }
  return blockers;
}

function crmDuplicateConsolidationRuntimeSafety(database, configAuthority) {
  const cimSafetyRow = database.prepare(`
    SELECT * FROM deal_hunter_cim_safety_settings WHERE id = 'global' LIMIT 1
  `).get();
  const automationRow = database.prepare(`
    SELECT * FROM deal_hunter_automation_settings
    WHERE id = 'cim-initial-outreach' LIMIT 1
  `).get();
  return buildCrmDuplicateConsolidationRuntimeSafetyAuthority({
    configAuthority,
    cimSafetyRow,
    automationRow,
  });
}

function crmDuplicateConsolidationSafety(database, blockers, configAuthority) {
  const loserIds = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.supersededSubmissionId);
  const survivorIds = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.survivorSubmissionId);
  const tableExists = (name) => Boolean(database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1
  `).get(name));
  const count = (sql, ...values) => Number(database.prepare(sql).get(...values)?.count || 0);
  const safety = {};
  const automation = tableExists('deal_hunter_automation_settings')
    ? database.prepare(`
      SELECT * FROM deal_hunter_automation_settings
      WHERE id = 'cim-initial-outreach' LIMIT 1
    `).get()
    : null;
  safety.activeWriterCount = !automation || Number(automation.paused) !== 1 ? 1 : 0;
  if (safety.activeWriterCount) blockers.push('active-writer-or-scheduler-not-disabled');

  const outbound = tableExists('deal_hunter_cim_safety_settings')
    ? database.prepare("SELECT * FROM deal_hunter_cim_safety_settings WHERE id = 'global' LIMIT 1").get()
    : null;
  safety.outboundSafe = Boolean(outbound)
    && Number(outbound.outreach_paused) === 1;
  if (!safety.outboundSafe) blockers.push('unsafe-outbound-control');

  let runtimeSafetyAuthority = null;
  try {
    runtimeSafetyAuthority = crmDuplicateConsolidationRuntimeSafety(database, configAuthority);
  } catch (error) {
    blockers.push(`runtime-safety-authority-invalid:${error.message}`);
  }

  const loserPlaceholders = placeholders(loserIds.length);
  const survivorPlaceholders = placeholders(survivorIds.length);
  safety.nonterminalLoserCommunications = count(`
    SELECT COUNT(*) AS count FROM crm_communications
    WHERE submission_id IN (${loserPlaceholders})
      AND COALESCE(delivery_state, '') NOT IN ('accepted', 'delivered', 'failed', 'rejected', 'bounced', 'complained')
  `, ...loserIds);
  if (safety.nonterminalLoserCommunications) blockers.push('nonterminal-loser-communication');
  safety.nonterminalLoserOutbox = count(`
    SELECT COUNT(*) AS count FROM crm_email_outbox
    WHERE submission_id IN (${loserPlaceholders})
      AND state NOT IN ('accepted', 'permanent_failed', 'cancelled')
  `, ...loserIds);
  if (safety.nonterminalLoserOutbox) blockers.push('nonterminal-loser-outbox');
  safety.loserCimRequests = count(`
    SELECT COUNT(*) AS count FROM deal_hunter_cim_requests
    WHERE submission_id IN (${loserPlaceholders})
  `, ...loserIds);
  if (safety.loserCimRequests) blockers.push('loser-cim-request');
  safety.nonterminalSurvivorCimRequests = count(`
    SELECT COUNT(*) AS count FROM deal_hunter_cim_requests
    WHERE submission_id IN (${survivorPlaceholders})
      AND NOT (
        status = 'sent'
        AND request_state IN ('provider_accepted', 'responded', 'stopped')
        AND delivery_state IN ('accepted', 'delivered')
        AND follow_up_state IN ('completed', 'stopped')
        AND next_follow_up_at IS NULL
      )
  `, ...survivorIds);
  if (safety.nonterminalSurvivorCimRequests) blockers.push('nonterminal-survivor-cim-request');
  safety.actionableLoserRecommendations = count(`
    SELECT COUNT(*) AS count FROM crm_follow_up_recommendations
    WHERE submission_id IN (${loserPlaceholders}) AND status IN ('current', 'pending')
  `, ...loserIds);
  if (safety.actionableLoserRecommendations) blockers.push('nonterminal-loser-recommendation');
  safety.activeLoserUploads = count(`
    SELECT COUNT(*) AS count FROM secure_upload_requests
    WHERE submission_id IN (${loserPlaceholders})
      AND status NOT IN ('closed', 'revoked', 'expired', 'completed')
  `, ...loserIds);
  if (safety.activeLoserUploads) blockers.push('nonterminal-loser-upload');
  safety.nonterminalLoserReconciliationItems = count(`
    SELECT COUNT(*) AS count FROM deal_hunter_crm_reconciliation_items
    WHERE submission_id IN (${loserPlaceholders})
      AND status NOT IN ('completed', 'skipped', 'failed')
  `, ...loserIds);
  if (safety.nonterminalLoserReconciliationItems) blockers.push('nonterminal-loser-reconciliation');
  safety.activeLoserCleanupJobs = count(`
    SELECT COUNT(*) AS count FROM secure_document_cleanup_jobs
    WHERE submission_id IN (${loserPlaceholders})
      AND status NOT IN ('completed', 'restored')
  `, ...loserIds);
  if (safety.activeLoserCleanupJobs) blockers.push('nonterminal-loser-cleanup');
  safety.activeStage2Activations = count(`
    SELECT COUNT(*) AS count FROM deal_hunter_cim_stage2_activations
    WHERE status = 'current'
  `);
  if (safety.activeStage2Activations) blockers.push('active-stage2-activation');
  return { safety, runtimeSafetyAuthority };
}

function inspectCrmDuplicateConsolidationState(database, { connection, configAuthority } = {}) {
  const state = crmDuplicateConsolidationDatabaseState(database);
  const blockers = findCrmDuplicateConsolidationUnclassifiedSchema(state.schema);
  for (const entry of state.requiredObjects.filter((object) => object.missing)) {
    blockers.push(`required-${entry.type}-schema-object-missing:${entry.name}`);
  }
  const submissions = new Map(crmDuplicateConsolidationRowsForIds(
    database,
    'contact_submissions',
    'id',
    CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.flatMap((pair) => [
      pair.survivorSubmissionId,
      pair.supersededSubmissionId,
    ]),
  ).map((row) => [row.id, row]));
  const opportunities = new Map(crmDuplicateConsolidationRowsForIds(
    database,
    'deal_hunter_opportunities',
    'opportunity_id',
    CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.opportunityId),
  ).map((row) => [row.opportunity_id, row]));

  const safePairs = [];
  for (const pair of CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs) {
    const survivor = submissions.get(pair.survivorSubmissionId);
    const loser = submissions.get(pair.supersededSubmissionId);
    const opportunity = opportunities.get(pair.opportunityId);
    if (!survivor || !loser) blockers.push(`tuple-${pair.key}-submission-missing`);
    if (!opportunity || opportunity.status !== 'active'
      || opportunity.primary_submission_id !== pair.survivorSubmissionId) {
      blockers.push(`primary-${pair.key}-authority-drift`);
    }
    const survivorOwner = parseCrmDuplicateConsolidationMetadata(survivor?.metadata)?.dealHunter?.opportunityId;
    const loserOwner = parseCrmDuplicateConsolidationMetadata(loser?.metadata)?.dealHunter?.opportunityId;
    if (survivorOwner !== pair.opportunityId
      || (loserOwner && loserOwner !== pair.opportunityId)
      || (survivor?.deal_hunter_opportunity_id && survivor.deal_hunter_opportunity_id !== pair.opportunityId)
      || (loser?.deal_hunter_opportunity_id && loser.deal_hunter_opportunity_id !== pair.opportunityId)) {
      blockers.push(`owner-${pair.key}-drift`);
    }
    const survivorListing = crmDuplicateConsolidationListingMatches(survivor, pair);
    const loserListing = crmDuplicateConsolidationListingMatches(loser, pair, {
        allowMissing: pair.key === 'berlin',
      });
    if (!survivorListing.valid || !loserListing.valid) {
      blockers.push(`listing-${pair.key}-drift`);
      blockers.push(...survivorListing.blockers.map((blocker) => `listing-${pair.key}-survivor:${blocker}`));
      blockers.push(...loserListing.blockers.map((blocker) => `listing-${pair.key}-superseded:${blocker}`));
    }
    const survivorFinancial = crmDuplicateConsolidationFinancialMatches(survivor, pair);
    const loserFinancial = crmDuplicateConsolidationFinancialMatches(loser, pair);
    if (!survivorFinancial.valid || !loserFinancial.valid) {
      const financialBlocker = [survivorFinancial.blocker, loserFinancial.blocker]
        .find((blocker) => blocker === 'financial-label-or-source-value-drift');
      blockers.push(financialBlocker
        ? `financial-label-${pair.key}-drift`
        : `financial-value-${pair.key}-drift`);
    }
    safePairs.push({
      key: pair.key,
      opportunityId: pair.opportunityId,
      survivorSubmissionId: pair.survivorSubmissionId,
      supersededSubmissionId: pair.supersededSubmissionId,
      listingIdentity: pair.listingIdentity,
      opportunityStatus: opportunity?.status || null,
      primarySubmissionId: opportunity?.primary_submission_id || null,
      survivorStatus: survivor?.status || null,
      supersededStatus: loser?.status || null,
    });
  }

  const berlinPair = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.find((pair) => pair.key === 'berlin');
  blockers.push(...crmDuplicateConsolidationBerlinIdentityBlockers(database, {
    survivor: submissions.get(berlinPair.survivorSubmissionId),
    superseded: submissions.get(berlinPair.supersededSubmissionId),
    opportunity: opportunities.get(berlinPair.opportunityId),
  }));

  const berlinImport = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1
  `).get(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id);
  if (!berlinImport
    || berlinImport.submission_id !== CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.beforeSubmissionId
    || berlinImport.opportunity_id !== null) {
    blockers.push('Berlin import tuple drift');
  }
  const existingRelations = database.prepare(`
    SELECT * FROM crm_submission_supersessions
    WHERE survivor_submission_id IN (${placeholders(2)})
       OR superseded_submission_id IN (${placeholders(2)})
       OR opportunity_id IN (${placeholders(2)})
    ORDER BY id
  `).all(
    ...CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.survivorSubmissionId),
    ...CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.supersededSubmissionId),
    ...CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => pair.opportunityId),
  );
  if (existingRelations.length) blockers.push('partial-or-independently-satisfied-supersession-state');
  const { safety, runtimeSafetyAuthority } = crmDuplicateConsolidationSafety(
    database,
    blockers,
    configAuthority,
  );
  const targetRows = [
    ...submissions.values(),
    ...opportunities.values(),
    berlinImport,
    database.prepare("SELECT * FROM deal_hunter_cim_safety_settings WHERE id = 'global'").get(),
    database.prepare(`
      SELECT * FROM deal_hunter_automation_settings
      WHERE id = 'cim-initial-outreach'
    `).get(),
  ].filter(Boolean);
  const rawRows = targetRows.map((row) => ({
    table: row.opportunity_id && Object.hasOwn(row, 'primary_submission_id')
      ? 'deal_hunter_opportunities'
      : row.id === CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id
        ? 'deal_hunter_crm_imports'
        : row.id === 'global' && Object.hasOwn(row, 'outreach_paused')
          ? 'deal_hunter_cim_safety_settings'
          : row.id === 'cim-initial-outreach' && Object.hasOwn(row, 'paused')
            ? 'deal_hunter_automation_settings'
            : 'contact_submissions',
    id: row.id || row.opportunity_id,
    digest: crmDuplicateConsolidationRawDigest(row),
  })).sort((left, right) => (
    compareCrmDuplicateConsolidationText(left.table, right.table)
      || compareCrmDuplicateConsolidationText(left.id, right.id)
  ));
  const referenceInventory = crmDuplicateConsolidationReferenceInventory(state);
  blockers.push(...referenceInventory.blockers);
  return {
    provider: 'sqlite',
    connection: connection || {
      readonly: Boolean(database.readonly),
      fileMustExist: true,
      queryOnly: Number(database.pragma('query_only', { simple: true })) === 1,
      consistentReadTransaction: Boolean(database.inTransaction),
    },
    blockers: [...new Set(blockers)].sort(),
    database: {
      authorityLogicalDigest: state.authorityLogicalDigest,
      authorityTotalRows: state.authorityTotalRows,
      quickCheck: String(database.pragma('quick_check', { simple: true }) || ''),
      foreignKeyViolationCount: database.pragma('foreign_key_check').length,
    },
    schema: {
      digest: state.schemaDigest,
      tables: state.schema.map((table) => ({
        name: table.name,
        sqlDigest: table.sqlDigest,
        columns: table.columns.map((column) => column.name),
      })),
      requiredObjects: state.requiredObjects,
    },
    relationshipInventory: referenceInventory.entries,
    referenceIdentifiers: referenceInventory.identifiers,
    authorityTableDigests: state.authorityTableDigests,
    rawRows,
    safety,
    runtimeSafetyAuthority,
    currentState: {
      pairs: safePairs,
      berlinImport: berlinImport ? {
        id: berlinImport.id,
        submissionId: berlinImport.submission_id,
        opportunityId: berlinImport.opportunity_id,
        updatedAt: berlinImport.updated_at,
        metadataDigest: canonicalJsonSha256(berlinImport.metadata || '{}'),
        metadataObjectDigest: canonicalJsonSha256(parseCrmDuplicateConsolidationMetadata(berlinImport.metadata)),
        unchangedColumnsDigest: canonicalJsonSha256(
          crmDuplicateConsolidationUnchangedBerlinColumns(berlinImport),
        ),
        rawDigest: crmDuplicateConsolidationRawDigest(berlinImport),
      } : null,
      existingRelationCount: existingRelations.length,
      unchangedMutationTableDigests: crmDuplicateConsolidationUnchangedMutationDigests(database),
    },
  };
}

function inspectCrmDuplicateConsolidation(database, connection = null, configAuthority = null) {
  const read = database.transaction(() => inspectCrmDuplicateConsolidationState(database, {
    connection: connection || {
      readonly: Boolean(database.readonly),
      fileMustExist: true,
      queryOnly: Number(database.pragma('query_only', { simple: true })) === 1,
      consistentReadTransaction: true,
    },
    configAuthority,
  }));
  return read.deferred();
}

function inspectCrmDuplicateConsolidationRuntimeSafety(database, {
  connection,
  configAuthority,
} = {}) {
  const read = database.transaction(() => {
    const blockers = [];
    let runtimeSafetyAuthority = null;
    try {
      runtimeSafetyAuthority = crmDuplicateConsolidationRuntimeSafety(database, configAuthority);
    } catch (error) {
      blockers.push(`runtime-safety-authority-invalid:${error.message}`);
    }
    return {
      provider: 'sqlite',
      connection: connection || {
        readonly: Boolean(database.readonly),
        fileMustExist: true,
        queryOnly: Number(database.pragma('query_only', { simple: true })) === 1,
        consistentReadTransaction: true,
      },
      blockers,
      runtimeSafetyAuthority,
    };
  });
  return read.deferred();
}

function crmDuplicateConsolidationFinalState(database, { artifact, actor, reason, backup }) {
  const currentSchema = crmDuplicateConsolidationSchema(database);
  const currentRequiredObjects = assertCrmDuplicateConsolidationRequiredObjects(
    database,
    artifact.plan.schema.requiredObjects,
    'final-state',
  );
  if (canonicalJsonSha256({ tables: currentSchema, requiredObjects: currentRequiredObjects })
    !== artifact.plan.schema.digest) {
    throw new Error('CRM duplicate consolidation final-state complete schema drift.');
  }
  const relations = database.prepare(`
    SELECT * FROM crm_submission_supersessions
    WHERE repair_manifest_id = ? ORDER BY id
  `).all(artifact.manifestId);
  const berlinImport = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1
  `).get(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id);
  const rawReceipt = database.prepare(`
    SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ? LIMIT 1
  `).get(artifact.manifestId);
  const receipt = normalizeDealHunterRepairManifestRow(rawReceipt);
  const expectedRelations = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.map((pair) => ({
    id: crmDuplicateConsolidationRelationId(pair),
    created_at: receipt?.created_at,
    updated_at: receipt?.created_at,
    status: 'active',
    survivor_submission_id: pair.survivorSubmissionId,
    superseded_submission_id: pair.supersededSubmissionId,
    opportunity_id: pair.opportunityId,
    reason_code: 'confirmed-duplicate',
    reason_text: reason,
    approved_by: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.approvedBy,
    approved_at: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.approvedAt,
    actor,
    repair_version: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
    repair_manifest_id: artifact.manifestId,
    repair_digest: artifact.planChecksum,
    reversed_at: null,
    reversed_by: null,
    reversal_reason: null,
    reversal_manifest_id: null,
    metadata: stableCrmDuplicateConsolidationJson({
      schema: 'crm-submission-supersession-metadata-v1',
      pairKey: pair.key,
      listingIdentity: pair.listingIdentity,
      manifestId: artifact.manifestId,
    }),
  })).sort((left, right) => compareCrmDuplicateConsolidationText(left.id, right.id));
  const validRelations = stableCrmDuplicateConsolidationJson(relations)
    === stableCrmDuplicateConsolidationJson(expectedRelations);
  const berlinMetadata = parseCrmDuplicateConsolidationMetadata(berlinImport?.metadata);
  const { crmDuplicateConsolidation: berlinProvenance, ...berlinPriorMetadata } = berlinMetadata;
  const expectedBerlinProvenance = {
    schema: 'crm-duplicate-consolidation-import-provenance-v1',
    manifestId: artifact.manifestId,
    planChecksum: artifact.planChecksum,
    priorSubmissionId: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.beforeSubmissionId,
    priorUpdatedAt: artifact.plan.currentState.berlinImport.updatedAt,
    priorMetadataDigest: artifact.plan.currentState.berlinImport.metadataDigest,
  };
  const validImport = berlinImport?.submission_id
      === CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.afterSubmissionId
    && berlinImport?.opportunity_id === null
    && berlinImport?.updated_at === receipt?.created_at
    && canonicalJsonSha256(crmDuplicateConsolidationUnchangedBerlinColumns(berlinImport))
      === artifact.plan.currentState.berlinImport.unchangedColumnsDigest
    && canonicalJsonSha256(berlinPriorMetadata)
      === artifact.plan.currentState.berlinImport.metadataObjectDigest
    && stableCrmDuplicateConsolidationJson(berlinProvenance)
      === stableCrmDuplicateConsolidationJson(expectedBerlinProvenance);
  const validUnchangedMutationTables = stableCrmDuplicateConsolidationJson(
    crmDuplicateConsolidationUnchangedMutationDigests(database),
  ) === stableCrmDuplicateConsolidationJson(
    artifact.plan.currentState.unchangedMutationTableDigests,
  );
  const appliedState = { valid: validRelations && validImport && validUnchangedMutationTables };
  validateCrmDuplicateConsolidationReceipt({
    row: receipt,
    rawRow: rawReceipt,
    artifact,
    actor,
    reason,
    backup,
    appliedState,
  });
  if (!appliedState.valid) throw new Error('CRM duplicate consolidation final state is partial or conflicting.');
  const quickCheck = String(database.pragma('quick_check', { simple: true }) || '');
  const foreignKeyViolations = database.pragma('foreign_key_check');
  if (quickCheck !== 'ok' || foreignKeyViolations.length) {
    throw new Error('CRM duplicate consolidation postcondition integrity check failed.');
  }
  return { relations, berlinImport, receipt, quickCheck, foreignKeyViolationCount: 0, valid: true };
}

function assertCrmDuplicateConsolidationProtectedTables(database, authorityTableDigests, phase) {
  for (const [table, expected] of Object.entries(authorityTableDigests)) {
    if (['crm_submission_supersessions', 'deal_hunter_crm_imports', 'deal_hunter_cim_repair_manifests'].includes(table)) continue;
    const rows = database.prepare(`SELECT * FROM ${quoteCrmDuplicateConsolidationIdentifier(table)}`).all()
      .sort((left, right) => compareCrmDuplicateConsolidationText(
        stableCrmDuplicateConsolidationJson(left),
        stableCrmDuplicateConsolidationJson(right),
      ));
    if (rows.length !== expected.rowCount || canonicalJsonSha256(rows) !== expected.digest) {
      throw new Error(`CRM duplicate consolidation ${phase}: ${table}.`);
    }
  }
}

export function createSqliteCrmDuplicateConsolidationReadOnlyStorage(config, {
  environment = process.env,
} = {}) {
  if (config?.storage?.provider && config.storage.provider !== 'sqlite') {
    throw new Error('CRM duplicate consolidation is SQLite-only.');
  }
  const sqlitePath = String(config?.storage?.sqlitePath || '').trim();
  if (!sqlitePath) throw new Error('CRM duplicate consolidation requires an existing SQLite database path.');
  const configAuthority = selectCrmDuplicateConsolidationConfigAuthority({ config, environment });
  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  database.pragma('query_only = ON');
  if (!database.readonly || Number(database.pragma('query_only', { simple: true })) !== 1) {
    database.close();
    throw new Error('CRM duplicate consolidation could not enforce read-only query-only preview.');
  }
  let closed = false;
  return {
    provider: 'sqlite',
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
    async inspectCrmDuplicateConsolidation() {
      return inspectCrmDuplicateConsolidation(database, {
        readonly: true,
        fileMustExist: true,
        queryOnly: true,
        consistentReadTransaction: true,
      }, configAuthority);
    },
    async inspectCrmDuplicateConsolidationRuntimeSafety() {
      return inspectCrmDuplicateConsolidationRuntimeSafety(database, {
        configAuthority,
        connection: {
          readonly: true,
          fileMustExist: true,
          queryOnly: true,
          consistentReadTransaction: true,
        },
      });
    },
    getCrmDuplicateConsolidationConfigAuthority() {
      return configAuthority;
    },
  };
}

export function createSqliteCanonicalOpportunityMergeReadOnlyStorage(config) {
  if (config?.storage?.provider !== 'sqlite') {
    throw new Error('Canonical opportunity merge repair is SQLite-only and refused the active storage provider.');
  }
  const sqlitePath = String(config.storage.sqlitePath || '').trim();
  if (!sqlitePath) throw new Error('Canonical opportunity merge repair requires an existing SQLite database path.');

  const snapshot = createStableCanonicalMergeSqliteSnapshot(sqlitePath);
  let database;
  let closed = false;
  try {
    database = new Database(snapshot.databasePath, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    if (Number(database.pragma('query_only', { simple: true })) !== 1) {
      throw new Error('Canonical opportunity merge could not enforce SQLite query-only mode.');
    }
    const quickCheck = String(database.pragma('quick_check', { simple: true }) || '');
    if (quickCheck !== 'ok') {
      throw new Error(`Canonical opportunity merge SQLite snapshot quick_check returned ${quickCheck || 'no result'}.`);
    }
    assertCanonicalOpportunityMergeSqliteSchema(database);
  } catch (error) {
    database?.close();
    fs.rmSync(snapshot.temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    provider: 'sqlite',

    close() {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        fs.rmSync(snapshot.temporaryDirectory, { recursive: true, force: true });
      }
    },

    async inspectDealHunterCanonicalOpportunityMerge(input = {}) {
      return inspectCanonicalOpportunityMerge(database, input);
    },
  };
}

export function createSqliteStorage(config, options = {}) {
  const directory = path.dirname(config.storage.sqlitePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const database = new Database(config.storage.sqlitePath);
  const crmDuplicateConsolidationBackupVerifications = new WeakMap();
  const crmDuplicateConsolidationConfigAuthority = Object.hasOwn(
    options,
    'crmDuplicateConsolidationEnvironment',
  ) ? selectCrmDuplicateConsolidationConfigAuthority({
      config,
      environment: options.crmDuplicateConsolidationEnvironment,
    }) : null;
  database.function('deal_hunter_cim_authority_sort_key', { deterministic: true }, (updatedAt, createdAt) => {
    const authorityAt = firstStrictDetailAuthorityTimestamp(
      { updated_at: updatedAt, created_at: createdAt },
      [['updated_at'], ['created_at']],
    );
    return strictDetailAuthorityTimestampSortKey(authorityAt);
  });
  database.function('deal_hunter_cim_record_id_sort_key', { deterministic: true }, (recordId) => (
    normalizeCanonicalCimRequestId(recordId) || null
  ));
  fs.chmodSync(config.storage.sqlitePath, 0o600);
  database.pragma('journal_mode = WAL');
  for (const suffix of ['-wal', '-shm']) {
    const auxiliaryPath = `${config.storage.sqlitePath}${suffix}`;
    if (fs.existsSync(auxiliaryPath)) {
      fs.chmodSync(auxiliaryPath, 0o600);
    }
  }
  migrateLegacyAdminMagicLinksTable(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS contact_submissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      spam_score INTEGER NOT NULL DEFAULT 0,
      spam_reasons TEXT NOT NULL DEFAULT '[]',
      delivery_provider TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      delivery_error TEXT,
      crm_status TEXT NOT NULL,
      crm_error TEXT,
      source TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      user_agent TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      company TEXT,
      role TEXT,
      message TEXT NOT NULL,
      status_updated_at TEXT,
      listing_url TEXT,
      business_website TEXT,
      prospectus_url TEXT,
      asking_price TEXT,
      ttm_revenue TEXT,
      ttm_ebitda TEXT,
      ebitda_multiple TEXT,
      net_margin TEXT,
      business_age TEXT,
      sba_eligible TEXT NOT NULL DEFAULT 'unknown',
      broker_name TEXT,
      broker_email TEXT,
      broker_phone TEXT,
      seller_name TEXT,
      seller_email TEXT,
      seller_phone TEXT,
      archived_at TEXT,
      archived_by TEXT,
      archive_reason TEXT,
      archive_note TEXT,
      archive_communication_id TEXT,
      restored_at TEXT,
      restored_by TEXT,
      deal_hunter_opportunity_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS contact_rate_limit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path TEXT NOT NULL,
      referrer_host TEXT NOT NULL DEFAULT '',
      utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '',
      placement TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS secure_upload_requests (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      email TEXT NOT NULL,
      contact_name TEXT,
      requested_by TEXT,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      nda_required INTEGER NOT NULL DEFAULT 1,
      nda_accepted_at TEXT,
      last_uploaded_at TEXT,
      note TEXT,
      requested_documents TEXT NOT NULL DEFAULT '[]',
      revoked_at TEXT,
      closed_at TEXT,
      upload_batch_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS secure_documents (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      uploaded_by_email TEXT,
      note TEXT,
      nda_accepted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS email_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message_id TEXT,
      provider_event_id TEXT,
      event_key TEXT,
      recipient_email TEXT,
      subject TEXT,
      submission_id TEXT,
      communication_id TEXT,
      source TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crm_activity_events (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crm_communications (
      id TEXT PRIMARY KEY,
      submission_id TEXT,
      deal_key TEXT,
      cim_request_id TEXT,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT,
      provider TEXT,
      provider_message_id TEXT,
      source_event_id TEXT,
      idempotency_key TEXT,
      message_id TEXT,
      in_reply_to TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      parent_communication_id TEXT,
      thread_key TEXT,
      legacy_content_unavailable INTEGER NOT NULL DEFAULT 0,
      content_redaction_state TEXT NOT NULL DEFAULT 'none',
      recommendation_id TEXT,
      outbox_id TEXT,
      headers_json TEXT NOT NULL DEFAULT '{}',
      reply_to_address TEXT,
      from_address TEXT,
      to_addresses TEXT NOT NULL DEFAULT '[]',
      cc_addresses TEXT NOT NULL DEFAULT '[]',
      bcc_addresses TEXT NOT NULL DEFAULT '[]',
      subject TEXT,
      body_text TEXT NOT NULL DEFAULT '',
      body_html_sanitized TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'not-attempted',
      delivery_state_at TEXT,
      content_state TEXT NOT NULL DEFAULT 'not-applicable',
      content_attempt_count INTEGER NOT NULL DEFAULT 0,
      content_last_error TEXT,
      content_next_attempt_at TEXT,
      attachment_metadata TEXT NOT NULL DEFAULT '[]',
      assigned_at TEXT,
      assigned_by TEXT,
      created_by TEXT NOT NULL DEFAULT 'system',
      updated_by TEXT NOT NULL DEFAULT 'system',
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crm_email_outbox (
      id TEXT PRIMARY KEY,
      communication_id TEXT NOT NULL UNIQUE,
      submission_id TEXT NOT NULL,
      cim_request_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      client_request_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      provider TEXT,
      provider_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      claim_token TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      accepted_at TEXT,
      failed_at TEXT,
      ambiguous_at TEXT,
      last_error_category TEXT,
      last_error_message TEXT,
      expected_submission_version TEXT NOT NULL,
      actor TEXT NOT NULL,
      intended_follow_up_state TEXT,
      intended_next_action_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS crm_follow_up_recommendations (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      cim_request_id TEXT,
      triggering_communication_id TEXT,
      input_fingerprint TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      status TEXT NOT NULL,
      conversation_state TEXT NOT NULL,
      intent TEXT NOT NULL,
      action_type TEXT NOT NULL,
      priority_score INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      recommended_next_action_at TEXT,
      thread_parent_communication_id TEXT,
      rationale TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      signals_json TEXT NOT NULL DEFAULT '[]',
      commitments_json TEXT NOT NULL DEFAULT '[]',
      questions_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      safety_flags_json TEXT NOT NULL DEFAULT '[]',
      draft_subject TEXT NOT NULL DEFAULT '',
      draft_body_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      acted_on_at TEXT,
      superseded_at TEXT,
      acted_on_by TEXT,
      outcome TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS email_suppressions (
      id TEXT PRIMARY KEY,
      normalized_email TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      source_event_id TEXT,
      source_communication_id TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      lifted_at TEXT,
      lifted_by TEXT,
      lift_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS deal_hunter_seen_deals (
      id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT,
      source_mode TEXT,
      external_id TEXT,
      listing_url TEXT,
      name TEXT NOT NULL,
      industry TEXT,
      location TEXT,
      annual_profit REAL,
      annual_revenue REAL,
      asking_price REAL,
      score INTEGER,
      should_remove INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS deal_hunter_deal_os_imports (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      exported_at TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_sha256 TEXT NOT NULL,
      scope TEXT NOT NULL,
      coverage_label TEXT NOT NULL,
      expected_row_count INTEGER,
      row_count INTEGER NOT NULL,
      source_row_count INTEGER NOT NULL DEFAULT 0,
      accepted_row_count INTEGER NOT NULL DEFAULT 0,
      rejected_row_count INTEGER NOT NULL DEFAULT 0,
      canonical_record_count INTEGER NOT NULL DEFAULT 0,
      parser_version TEXT NOT NULL DEFAULT 'deal-os-export-v1',
      row_accounting TEXT NOT NULL DEFAULT '[]',
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      stable_id_count INTEGER NOT NULL DEFAULT 0,
      listing_url_count INTEGER NOT NULL DEFAULT 0,
      coverage_limit_reached INTEGER NOT NULL DEFAULT 0,
      records TEXT NOT NULL DEFAULT '[]',
      freshness_generation INTEGER CHECK(freshness_generation IS NULL OR freshness_generation > 0),
      freshness_projection_state TEXT CHECK(freshness_projection_state IS NULL OR freshness_projection_state IN ('pending', 'accepted', 'deferred', 'superseded')),
      metadata TEXT NOT NULL DEFAULT '{}'
    );

	    CREATE TABLE IF NOT EXISTS deal_hunter_cim_requests (
	      id TEXT PRIMARY KEY,
	      created_at TEXT NOT NULL,
	      updated_at TEXT NOT NULL,
      deal_key TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      requested_by TEXT,
      status TEXT NOT NULL,
      delivery_error TEXT,
      provider_message_id TEXT,
      subject TEXT,
      deal_name TEXT,
      source_name TEXT,
      listing_url TEXT,
      score INTEGER,
      follow_up_count INTEGER NOT NULL DEFAULT 0,
      last_follow_up_at TEXT,
      next_follow_up_at TEXT,
	      responded_at TEXT,
	      submission_id TEXT,
	      request_state TEXT,
	      delivery_state TEXT,
	      delivery_state_at TEXT,
	      follow_up_state TEXT,
	      first_requested_at TEXT,
	      first_provider_accepted_at TEXT,
	      delivered_at TEXT,
	      last_attempt_at TEXT,
	      last_delivery_event_at TEXT,
	      reply_to_address TEXT,
	      retry_of_request_id TEXT,
	      attempt_count INTEGER,
	      last_activity_at TEXT,
		      metadata TEXT NOT NULL DEFAULT '{}'
		    );

      CREATE TABLE IF NOT EXISTS deal_hunter_crm_reconciliation_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        import_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        requested_by TEXT,
        counts TEXT NOT NULL DEFAULT '{}',
        plan TEXT NOT NULL DEFAULT '{}',
        results TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_crm_reconciliation_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        deal_key TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        submission_id TEXT,
        source_row_numbers TEXT NOT NULL DEFAULT '[]',
        planned_changes TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, opportunity_id),
        FOREIGN KEY(run_id) REFERENCES deal_hunter_crm_reconciliation_runs(id) ON DELETE CASCADE
      );

      -- Deal Hunter opportunity scoring. Machine-computed columns and
      -- operator-owned columns share a row so the triage queue can derive
      -- "changed since reviewed" without a join, but they are never written by
      -- the same method: see writeDealHunterOpportunityScore and
      -- setDealHunterOpportunityOperatorDecision.
      CREATE TABLE IF NOT EXISTS deal_hunter_opportunity_scores (
        opportunity_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        -- machine-owned
        scored_at TEXT NOT NULL,
        deal_key TEXT,
        name TEXT,
        state TEXT,
        listing_url TEXT,
        fit_score INTEGER NOT NULL DEFAULT 0,
        score_status TEXT NOT NULL DEFAULT 'provisional',
        confidence TEXT NOT NULL DEFAULT 'low',
        completeness_score INTEGER NOT NULL DEFAULT 0,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        missing_evidence_count INTEGER NOT NULL DEFAULT 0,
        should_remove INTEGER NOT NULL DEFAULT 0,
        high_fit INTEGER NOT NULL DEFAULT 0,
        gate_count INTEGER NOT NULL DEFAULT 0,
        score_fingerprint TEXT NOT NULL,
        semantic_digest TEXT,
        engine_version TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        profile_version TEXT NOT NULL,
        completeness_policy_version TEXT NOT NULL,
        dimensions TEXT NOT NULL DEFAULT '[]',
        gates TEXT NOT NULL DEFAULT '[]',
        applied_caps TEXT NOT NULL DEFAULT '[]',
        missing_evidence TEXT NOT NULL DEFAULT '[]',
        confidence_reasons TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '{}',
        -- complete-set reconciliation-owned
        current_triage_eligible INTEGER NOT NULL DEFAULT 0,
        -- operator-owned
        operator_priority TEXT NOT NULL DEFAULT 'normal',
        operator_note TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        reviewed_fingerprint TEXT,
        reviewed_semantic_digest TEXT,
        reviewed_discovery_revision INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_discovery_revision >= 0),
        reviewed_material_revision INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_material_revision >= 0),
        operator_updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_score_evidence (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        score_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dimension TEXT,
        rule_id TEXT NOT NULL,
        rule_label TEXT NOT NULL,
        evidence_class TEXT NOT NULL,
        field TEXT,
        value TEXT,
        observed_value TEXT,
        terms TEXT NOT NULL DEFAULT '[]',
        source_id TEXT,
        source_name TEXT,
        source_record_id TEXT,
        listing_url TEXT,
        observed_at TEXT,
        FOREIGN KEY(opportunity_id) REFERENCES deal_hunter_opportunity_scores(opportunity_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_reviews (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        deal_key TEXT NOT NULL,
        decision TEXT NOT NULL,
        pass_reason TEXT,
        original_recipient_email TEXT,
        final_recipient_email TEXT,
        recipient_edited INTEGER NOT NULL DEFAULT 0,
        score INTEGER,
        actor TEXT,
        automation_stage INTEGER NOT NULL DEFAULT 1,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_automation_settings (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

		    CREATE TABLE IF NOT EXISTS deal_hunter_crm_imports (
	      id TEXT PRIMARY KEY,
	      created_at TEXT NOT NULL,
	      updated_at TEXT NOT NULL,
	      deal_key TEXT NOT NULL,
	      listing_identity TEXT,
	      listing_url TEXT,
	      submission_id TEXT,
	      status TEXT NOT NULL,
	      source_name TEXT,
		      metadata TEXT NOT NULL DEFAULT '{}'
		    );

      CREATE TABLE IF NOT EXISTS deal_hunter_opportunities (
        opportunity_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        canonical_recipient TEXT,
        canonical_location TEXT,
        primary_submission_id TEXT,
        identity_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        first_accepted_at TEXT,
        first_discovery_evidence_id TEXT,
        discovery_state TEXT NOT NULL DEFAULT 'untracked_legacy' CHECK(discovery_state IN ('untracked_legacy', 'pending', 'known_prospective', 'known_recovered')),
        discovery_revision INTEGER NOT NULL DEFAULT 0 CHECK(discovery_revision >= 0),
        material_revision INTEGER NOT NULL DEFAULT 0 CHECK(material_revision >= 0),
        last_material_change_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(first_discovery_evidence_id) REFERENCES deal_hunter_freshness_evidence(id) ON DELETE RESTRICT
      );

      -- Operator corrections create a new immutable revision ID so history
      -- retains the values an operator previously recorded; a same-ID retry
      -- may update only the mutable revision fields. Source
      -- observations use a bounded source-record identity and are refreshed in
      -- place; neither projection stores raw source payloads.
      CREATE TABLE IF NOT EXISTS deal_hunter_opportunity_facts (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'operator',
        verified INTEGER NOT NULL DEFAULT 0,
        actor TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          id = trim(id) AND length(id) BETWEEN 1 AND 240
          AND opportunity_id = trim(opportunity_id) AND length(opportunity_id) BETWEEN 1 AND 200
          AND field IN ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
          AND value = trim(value) AND length(value) BETWEEN 1 AND 4000
          AND source = 'operator'
          AND verified IN (0, 1)
          AND actor = trim(actor) AND length(actor) BETWEEN 1 AND 200
          AND (note IS NULL OR (note = trim(note) AND length(note) BETWEEN 1 AND 4000))
          AND created_at = trim(created_at) AND length(created_at) BETWEEN 1 AND 80 AND julianday(created_at) IS NOT NULL
          AND updated_at = trim(updated_at) AND length(updated_at) BETWEEN 1 AND 80 AND julianday(updated_at) IS NOT NULL
        ),
        FOREIGN KEY(opportunity_id) REFERENCES deal_hunter_opportunities(opportunity_id) ON DELETE CASCADE
      );

      CREATE TRIGGER IF NOT EXISTS deal_hunter_opportunity_facts_operator_boundary_insert
      BEFORE INSERT ON deal_hunter_opportunity_facts
      BEGIN
        SELECT CASE WHEN NOT (
          NEW.id = trim(NEW.id) AND length(NEW.id) BETWEEN 1 AND 240
          AND NEW.opportunity_id = trim(NEW.opportunity_id) AND length(NEW.opportunity_id) BETWEEN 1 AND 200
          AND NEW.field IN ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
          AND NEW.value = trim(NEW.value) AND length(NEW.value) BETWEEN 1 AND 4000
          AND NEW.source = 'operator'
          AND NEW.verified IN (0, 1)
          AND NEW.actor = trim(NEW.actor) AND length(NEW.actor) BETWEEN 1 AND 200
          AND (NEW.note IS NULL OR (NEW.note = trim(NEW.note) AND length(NEW.note) BETWEEN 1 AND 4000))
          AND NEW.created_at = trim(NEW.created_at) AND length(NEW.created_at) BETWEEN 1 AND 80 AND julianday(NEW.created_at) IS NOT NULL
          AND NEW.updated_at = trim(NEW.updated_at) AND length(NEW.updated_at) BETWEEN 1 AND 80 AND julianday(NEW.updated_at) IS NOT NULL
        ) THEN RAISE(ABORT, 'invalid operator opportunity fact') END;
      END;

      CREATE TRIGGER IF NOT EXISTS deal_hunter_opportunity_facts_operator_boundary_update
      BEFORE UPDATE ON deal_hunter_opportunity_facts
      BEGIN
        SELECT CASE WHEN NOT (
          NEW.id = trim(NEW.id) AND length(NEW.id) BETWEEN 1 AND 240
          AND NEW.opportunity_id = trim(NEW.opportunity_id) AND length(NEW.opportunity_id) BETWEEN 1 AND 200
          AND NEW.field IN ('seller_name', 'seller_email', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes')
          AND NEW.value = trim(NEW.value) AND length(NEW.value) BETWEEN 1 AND 4000
          AND NEW.source = 'operator'
          AND NEW.verified IN (0, 1)
          AND NEW.actor = trim(NEW.actor) AND length(NEW.actor) BETWEEN 1 AND 200
          AND (NEW.note IS NULL OR (NEW.note = trim(NEW.note) AND length(NEW.note) BETWEEN 1 AND 4000))
          AND NEW.created_at = trim(NEW.created_at) AND length(NEW.created_at) BETWEEN 1 AND 80 AND julianday(NEW.created_at) IS NOT NULL
          AND NEW.updated_at = trim(NEW.updated_at) AND length(NEW.updated_at) BETWEEN 1 AND 80 AND julianday(NEW.updated_at) IS NOT NULL
        ) THEN RAISE(ABORT, 'invalid operator opportunity fact') END;
      END;

      CREATE TABLE IF NOT EXISTS deal_hunter_opportunity_source_observations (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        accepted_at TEXT,
        accepted_run_id TEXT CHECK(accepted_run_id IS NULL OR length(accepted_run_id) BETWEEN 1 AND 200),
        accepted_evidence_id TEXT CHECK(accepted_evidence_id IS NULL OR length(accepted_evidence_id) BETWEEN 1 AND 240),
        publication_raw_header TEXT CHECK(publication_raw_header IS NULL OR length(publication_raw_header) <= 100),
        publication_raw_value TEXT CHECK(publication_raw_value IS NULL OR length(publication_raw_value) <= 200),
        publication_precision TEXT CHECK(publication_precision IS NULL OR publication_precision IN ('unknown', 'date', 'instant')),
        publication_offset TEXT CHECK(publication_offset IS NULL OR length(publication_offset) <= 16),
        publication_meaning TEXT CHECK(publication_meaning IS NULL OR publication_meaning IN ('unknown', 'listing_publication')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(opportunity_id, source_id, source_record_id, field),
        CHECK(
          length(trim(id)) BETWEEN 1 AND 240 AND id = trim(id)
          AND length(trim(opportunity_id)) BETWEEN 1 AND 200 AND opportunity_id = trim(opportunity_id)
          AND length(trim(source_id)) BETWEEN 1 AND 160 AND source_id = trim(source_id)
          AND length(trim(source_name)) BETWEEN 1 AND 220 AND source_name = trim(source_name)
          AND length(trim(source_record_id)) BETWEEN 1 AND 200 AND source_record_id = trim(source_record_id)
          AND field IN (
            'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
            'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
            'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name', 'broker_company', 'broker_contact', 'broker_email',
            'broker_phone', 'company', 'role', 'seller_name', 'seller_email', 'seller_phone', 'reason_for_sale', 'real_estate_included',
            'seller_financing', 'management_structure', 'customer_concentration', 'operator_contact_notes', 'listing_url',
            'listing_source', 'listing_id', 'deal_key', 'source_identity', 'date_added', 'last_updated',
            'business_website', 'prospectus_url', 'ttm_revenue', 'ttm_ebitda', 'ebitda_multiple', 'business_age',
            'sba_eligible', 'lead_type'
          )
          AND length(trim(value)) BETWEEN 1 AND 5000 AND value = trim(value)
        ),
        FOREIGN KEY(opportunity_id) REFERENCES deal_hunter_opportunities(opportunity_id) ON DELETE CASCADE,
        FOREIGN KEY(accepted_evidence_id) REFERENCES deal_hunter_freshness_evidence(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_source_freshness_state (
        source_id TEXT PRIMARY KEY CHECK(source_id = trim(source_id) AND length(source_id) BETWEEN 1 AND 160),
        next_generation INTEGER NOT NULL DEFAULT 0 CHECK(next_generation >= 0),
        accepted_generation INTEGER NOT NULL DEFAULT 0 CHECK(accepted_generation >= 0),
        accepted_run_id TEXT CHECK(accepted_run_id IS NULL OR (accepted_run_id = trim(accepted_run_id) AND length(accepted_run_id) BETWEEN 1 AND 200)),
        accepted_digest TEXT CHECK(accepted_digest IS NULL OR (length(accepted_digest) = 64 AND accepted_digest NOT GLOB '*[^0-9a-f]*')),
        accepted_at TEXT,
        projection_state TEXT NOT NULL DEFAULT 'idle' CHECK(projection_state IN ('idle', 'pending', 'accepted', 'deferred', 'superseded')),
        CHECK(accepted_generation <= next_generation),
        CHECK((accepted_generation = 0 AND accepted_run_id IS NULL AND accepted_digest IS NULL AND accepted_at IS NULL)
          OR (accepted_generation > 0 AND accepted_run_id IS NOT NULL AND accepted_digest IS NOT NULL AND accepted_at IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_freshness_evidence (
        id TEXT PRIMARY KEY CHECK(id = trim(id) AND length(id) BETWEEN 1 AND 240),
        source_id TEXT NOT NULL CHECK(source_id = trim(source_id) AND length(source_id) BETWEEN 1 AND 160),
        source_name TEXT NOT NULL CHECK(source_name = trim(source_name) AND length(source_name) BETWEEN 1 AND 220),
        source_record_id TEXT NOT NULL CHECK(source_record_id = trim(source_record_id) AND length(source_record_id) BETWEEN 1 AND 200),
        run_id TEXT NOT NULL CHECK(run_id = trim(run_id) AND length(run_id) BETWEEN 1 AND 200),
        record_digest TEXT CHECK(record_digest IS NULL OR (length(record_digest) = 64 AND record_digest NOT GLOB '*[^0-9a-f]*')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        event_type TEXT NOT NULL CHECK(event_type IN ('accepted_source_record', 'publication_evidence', 'material_change', 'evidence_state_change')),
        field_key TEXT NOT NULL DEFAULT '' CHECK(field_key = trim(field_key) AND length(field_key) <= 80),
        event_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(event_ordinal BETWEEN 0 AND 10000),
        accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        original_canonical_id TEXT CHECK(original_canonical_id IS NULL OR length(original_canonical_id) BETWEEN 1 AND 200),
        current_canonical_id TEXT CHECK(current_canonical_id IS NULL OR length(current_canonical_id) BETWEEN 1 AND 200),
        identity_exception_id TEXT CHECK(identity_exception_id IS NULL OR length(identity_exception_id) BETWEEN 1 AND 240),
        binding_audit_id TEXT CHECK(binding_audit_id IS NULL OR length(binding_audit_id) BETWEEN 1 AND 240),
        provenance_version TEXT NOT NULL DEFAULT 'fl-01-v1' CHECK(provenance_version = trim(provenance_version) AND length(provenance_version) BETWEEN 1 AND 80),
        raw_header TEXT CHECK(raw_header IS NULL OR length(raw_header) <= 100),
        raw_value TEXT CHECK(raw_value IS NULL OR length(raw_value) <= 200),
        publication_meaning TEXT NOT NULL DEFAULT 'unknown' CHECK(publication_meaning IN ('unknown', 'listing_publication')),
        publication_date TEXT,
        publication_instant TEXT,
        publication_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(publication_precision IN ('unknown', 'date', 'instant')),
        publication_offset TEXT CHECK(publication_offset IS NULL OR length(publication_offset) <= 16),
        publication_state TEXT NOT NULL DEFAULT 'unknown' CHECK(publication_state IN ('unknown', 'valid', 'invalid', 'future', 'conflict')),
        before_value REAL,
        after_value REAL,
        before_evidence_id TEXT CHECK(before_evidence_id IS NULL OR length(before_evidence_id) BETWEEN 1 AND 240),
        after_evidence_id TEXT CHECK(after_evidence_id IS NULL OR length(after_evidence_id) BETWEEN 1 AND 240),
        metric TEXT NOT NULL DEFAULT 'unknown' CHECK(metric = trim(metric) AND length(metric) BETWEEN 1 AND 80),
        currency TEXT NOT NULL DEFAULT 'unknown' CHECK(currency = trim(currency) AND length(currency) BETWEEN 1 AND 16),
        period TEXT NOT NULL DEFAULT 'unknown' CHECK(period = trim(period) AND length(period) BETWEEN 1 AND 80),
        classification TEXT CHECK(classification IS NULL OR classification IN ('new_evidence', 'conflict', 'selected_source_swap', 'disappearance', 'comparable_change')),
        material_revision INTEGER CHECK(material_revision IS NULL OR material_revision >= 0),
        UNIQUE(run_id, source_id, source_record_id, event_type, field_key, event_ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_deal_hunter_freshness_evidence_canonical_time
        ON deal_hunter_freshness_evidence(current_canonical_id, accepted_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_deal_hunter_freshness_evidence_source_record_time
        ON deal_hunter_freshness_evidence(source_id, source_record_id, accepted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deal_hunter_freshness_evidence_run_source_record
        ON deal_hunter_freshness_evidence(run_id, source_id, source_record_id);
      CREATE TRIGGER IF NOT EXISTS deal_hunter_freshness_evidence_no_payload_update
      BEFORE UPDATE OF id, source_id, source_name, source_record_id, run_id, generation,
        record_digest,
        event_type, field_key, event_ordinal, accepted_at, original_canonical_id,
        identity_exception_id, provenance_version, raw_header, raw_value,
        publication_meaning, publication_date, publication_instant, publication_precision,
        publication_offset, publication_state, before_value, after_value,
        before_evidence_id, after_evidence_id, metric, currency, period,
        classification, material_revision
      ON deal_hunter_freshness_evidence
      BEGIN
        SELECT RAISE(ABORT, 'freshness evidence payload is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS deal_hunter_freshness_evidence_guard_binding
      BEFORE UPDATE OF current_canonical_id, binding_audit_id ON deal_hunter_freshness_evidence
      WHEN NEW.current_canonical_id IS OLD.current_canonical_id
        OR NEW.binding_audit_id IS NULL
        OR NEW.binding_audit_id IS OLD.binding_audit_id
      BEGIN
        SELECT RAISE(ABORT, 'freshness binding requires a new audit reference');
      END;
      CREATE TRIGGER IF NOT EXISTS deal_hunter_freshness_evidence_no_delete
      BEFORE DELETE ON deal_hunter_freshness_evidence
      BEGIN
        SELECT RAISE(ABORT, 'freshness evidence is retained');
      END;

      CREATE TABLE IF NOT EXISTS deal_hunter_opportunity_aliases (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        alias_value TEXT NOT NULL,
        alias_key TEXT NOT NULL UNIQUE,
        source TEXT,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        resolution_method TEXT NOT NULL,
        confidence_state TEXT NOT NULL,
        resolved_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_identity_exceptions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_deal_key TEXT,
        observed_name TEXT,
        observed_recipient TEXT,
        candidate_opportunity_ids TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_reason TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_opportunity_claims (
        opportunity_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        recipient_email TEXT NOT NULL,
        state TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_recipient_overrides (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_recipient_claims (
        recipient_email TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_safety_settings (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        outreach_paused INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_repair_manifests (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        backup_reference TEXT,
        checksum TEXT NOT NULL,
        manifest TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS crm_submission_supersessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
        survivor_submission_id TEXT NOT NULL,
        superseded_submission_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK (reason_code = 'confirmed-duplicate'),
        reason_text TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        repair_version TEXT NOT NULL,
        repair_manifest_id TEXT NOT NULL,
        repair_digest TEXT NOT NULL,
        reversed_at TEXT,
        reversed_by TEXT,
        reversal_reason TEXT,
        reversal_manifest_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        CHECK (survivor_submission_id <> superseded_submission_id),
        CHECK (
          (status = 'active' AND reversed_at IS NULL AND reversed_by IS NULL AND reversal_manifest_id IS NULL)
          OR
          (status = 'reversed' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_manifest_id IS NOT NULL)
        ),
        FOREIGN KEY (survivor_submission_id) REFERENCES contact_submissions(id) ON DELETE RESTRICT,
        FOREIGN KEY (superseded_submission_id) REFERENCES contact_submissions(id) ON DELETE RESTRICT,
        FOREIGN KEY (opportunity_id) REFERENCES deal_hunter_opportunities(opportunity_id) ON DELETE RESTRICT,
        FOREIGN KEY (repair_manifest_id) REFERENCES deal_hunter_cim_repair_manifests(id) ON DELETE RESTRICT,
        FOREIGN KEY (reversal_manifest_id) REFERENCES deal_hunter_cim_repair_manifests(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_crm_submission_supersessions_survivor
        ON crm_submission_supersessions(survivor_submission_id, status);
      CREATE INDEX IF NOT EXISTS idx_crm_submission_supersessions_opportunity
        ON crm_submission_supersessions(opportunity_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_submission_supersessions_active_loser
        ON crm_submission_supersessions(superseded_submission_id)
        WHERE status = 'active';

      CREATE TRIGGER IF NOT EXISTS trg_crm_duplicate_consolidation_receipt_no_update
      BEFORE UPDATE ON deal_hunter_cim_repair_manifests
      WHEN OLD.mode = 'crm-duplicate-consolidation'
      BEGIN
        SELECT RAISE(ABORT, 'CRM duplicate consolidation receipt is append-only and immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_duplicate_consolidation_receipt_no_delete
      BEFORE DELETE ON deal_hunter_cim_repair_manifests
      WHEN OLD.mode = 'crm-duplicate-consolidation'
      BEGIN
        SELECT RAISE(ABORT, 'CRM duplicate consolidation receipt is append-only and immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_validate_insert
      BEFORE INSERT ON crm_submission_supersessions
      BEGIN
        SELECT CASE WHEN NEW.survivor_submission_id = NEW.superseded_submission_id
          THEN RAISE(ABORT, 'CRM supersession survivor and loser cannot be the same') END;
        SELECT CASE WHEN NEW.status <> 'active'
          THEN RAISE(ABORT, 'CRM supersession must begin active') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM contact_submissions WHERE id = NEW.survivor_submission_id
        ) THEN RAISE(ABORT, 'CRM supersession survivor is missing') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM contact_submissions WHERE id = NEW.superseded_submission_id
        ) THEN RAISE(ABORT, 'CRM supersession superseded loser is missing') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM deal_hunter_opportunities
          WHERE opportunity_id = NEW.opportunity_id AND status = 'active'
        ) THEN RAISE(ABORT, 'CRM supersession requires an active opportunity') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM deal_hunter_opportunities
          WHERE opportunity_id = NEW.opportunity_id
            AND primary_submission_id = NEW.survivor_submission_id
        ) THEN RAISE(ABORT, 'CRM supersession opportunity primary must be the survivor') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM contact_submissions AS submission
          WHERE submission.id = NEW.survivor_submission_id
            AND COALESCE(NULLIF(TRIM(submission.deal_hunter_opportunity_id), ''), '') IN ('', NEW.opportunity_id)
            AND COALESCE(NULLIF(TRIM(json_extract(submission.metadata, '$.dealHunter.opportunityId')), ''), '') IN ('', NEW.opportunity_id)
            AND (
              NULLIF(TRIM(submission.deal_hunter_opportunity_id), '') = NEW.opportunity_id
              OR NULLIF(TRIM(json_extract(submission.metadata, '$.dealHunter.opportunityId')), '') = NEW.opportunity_id
            )
        ) THEN RAISE(ABORT, 'CRM supersession survivor owner is incompatible') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM contact_submissions AS submission
          WHERE submission.id = NEW.superseded_submission_id
            AND COALESCE(NULLIF(TRIM(submission.deal_hunter_opportunity_id), ''), '') IN ('', NEW.opportunity_id)
            AND COALESCE(NULLIF(TRIM(json_extract(submission.metadata, '$.dealHunter.opportunityId')), ''), '') IN ('', NEW.opportunity_id)
        ) THEN RAISE(ABORT, 'CRM supersession superseded owner is incompatible') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM deal_hunter_opportunities
          WHERE primary_submission_id = NEW.superseded_submission_id
        ) THEN RAISE(ABORT, 'CRM supersession loser cannot be an opportunity primary') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM deal_hunter_cim_repair_manifests
          WHERE id = NEW.repair_manifest_id
            AND mode = 'crm-duplicate-consolidation'
            AND status = 'applied'
            AND checksum = NEW.repair_digest
        ) THEN RAISE(ABORT, 'CRM supersession receipt or digest is invalid') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_no_active_chain_insert
      BEFORE INSERT ON crm_submission_supersessions
      WHEN NEW.status = 'active'
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM crm_submission_supersessions
          WHERE status = 'active'
            AND (
              superseded_submission_id = NEW.survivor_submission_id
              OR survivor_submission_id = NEW.superseded_submission_id
            )
        ) THEN RAISE(ABORT, 'CRM supersession active role would create a chain') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_no_active_chain_update
      BEFORE UPDATE ON crm_submission_supersessions
      WHEN NEW.status = 'active'
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM crm_submission_supersessions
          WHERE status = 'active' AND id <> OLD.id
            AND (
              superseded_submission_id = NEW.survivor_submission_id
              OR survivor_submission_id = NEW.superseded_submission_id
            )
        ) THEN RAISE(ABORT, 'CRM supersession active role would create a chain') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_immutable_update
      BEFORE UPDATE ON crm_submission_supersessions
      WHEN NEW.id IS NOT OLD.id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.survivor_submission_id IS NOT OLD.survivor_submission_id
        OR NEW.superseded_submission_id IS NOT OLD.superseded_submission_id
        OR NEW.opportunity_id IS NOT OLD.opportunity_id
        OR NEW.reason_code IS NOT OLD.reason_code
        OR NEW.reason_text IS NOT OLD.reason_text
        OR NEW.approved_by IS NOT OLD.approved_by
        OR NEW.approved_at IS NOT OLD.approved_at
        OR NEW.actor IS NOT OLD.actor
        OR NEW.repair_version IS NOT OLD.repair_version
        OR NEW.repair_manifest_id IS NOT OLD.repair_manifest_id
        OR NEW.repair_digest IS NOT OLD.repair_digest
        OR NEW.metadata IS NOT OLD.metadata
      BEGIN
        SELECT RAISE(ABORT, 'CRM supersession core fields are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_no_delete
      BEFORE DELETE ON crm_submission_supersessions
      BEGIN
        SELECT RAISE(ABORT, 'CRM supersession physical delete is forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_guard_contact_owner_update
      BEFORE UPDATE OF id, deal_hunter_opportunity_id, metadata ON contact_submissions
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM crm_submission_supersessions AS relation
          WHERE relation.status = 'active'
            AND relation.survivor_submission_id = OLD.id
            AND (
              NEW.id <> OLD.id
              OR COALESCE(NULLIF(TRIM(NEW.deal_hunter_opportunity_id), ''), '') NOT IN ('', relation.opportunity_id)
              OR COALESCE(NULLIF(TRIM(json_extract(NEW.metadata, '$.dealHunter.opportunityId')), ''), '') NOT IN ('', relation.opportunity_id)
              OR (
                COALESCE(NULLIF(TRIM(NEW.deal_hunter_opportunity_id), ''), '') <> relation.opportunity_id
                AND COALESCE(NULLIF(TRIM(json_extract(NEW.metadata, '$.dealHunter.opportunityId')), ''), '') <> relation.opportunity_id
              )
            )
        ) THEN RAISE(ABORT, 'CRM supersession survivor owner cannot be invalidated') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM crm_submission_supersessions AS relation
          WHERE relation.status = 'active'
            AND relation.superseded_submission_id = OLD.id
            AND (
              NEW.id <> OLD.id
              OR COALESCE(NULLIF(TRIM(NEW.deal_hunter_opportunity_id), ''), '') NOT IN ('', relation.opportunity_id)
              OR COALESCE(NULLIF(TRIM(json_extract(NEW.metadata, '$.dealHunter.opportunityId')), ''), '') NOT IN ('', relation.opportunity_id)
            )
        ) THEN RAISE(ABORT, 'CRM supersession superseded owner cannot be invalidated') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_guard_opportunity_update
      BEFORE UPDATE OF opportunity_id, status, primary_submission_id ON deal_hunter_opportunities
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM crm_submission_supersessions AS relation
          WHERE relation.status = 'active'
            AND relation.opportunity_id = OLD.opportunity_id
            AND (
              NEW.opportunity_id <> OLD.opportunity_id
              OR NEW.status <> 'active'
              OR NEW.primary_submission_id IS NOT relation.survivor_submission_id
            )
        ) THEN RAISE(ABORT, 'CRM supersession opportunity authority cannot be invalidated') END;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_deal_hunter_opportunities_reject_superseded_primary_insert
      BEFORE INSERT ON deal_hunter_opportunities
      WHEN NEW.primary_submission_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM crm_submission_supersessions
          WHERE status = 'active' AND superseded_submission_id = NEW.primary_submission_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'CRM superseded primary is forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_deal_hunter_opportunities_reject_superseded_primary_update
      BEFORE UPDATE OF primary_submission_id ON deal_hunter_opportunities
      WHEN NEW.primary_submission_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM crm_submission_supersessions
          WHERE status = 'active' AND superseded_submission_id = NEW.primary_submission_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'CRM superseded primary is forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_guard_contact_delete
      BEFORE DELETE ON contact_submissions
      WHEN EXISTS (
        SELECT 1 FROM crm_submission_supersessions
        WHERE survivor_submission_id = OLD.id OR superseded_submission_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'CRM supersession referenced contact delete is forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_crm_submission_supersessions_guard_opportunity_delete
      BEFORE DELETE ON deal_hunter_opportunities
      WHEN EXISTS (
        SELECT 1 FROM crm_submission_supersessions WHERE opportunity_id = OLD.opportunity_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'CRM supersession referenced opportunity delete is forbidden');
      END;

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_stage2_activations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        confirmation_phrase TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        source_policy_version TEXT NOT NULL,
        source_policy_hash TEXT NOT NULL,
        evidence_checksum TEXT NOT NULL,
        evidence_generated_at TEXT NOT NULL,
        backup_reference TEXT NOT NULL,
        backup_checksum TEXT NOT NULL,
        identity_audit_reference TEXT NOT NULL,
        identity_audit_checksum TEXT NOT NULL,
        compliance_reference TEXT NOT NULL,
        sender_auth_reference TEXT NOT NULL,
        timezone TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        weekdays_only INTEGER NOT NULL DEFAULT 1,
        canary_daily_cap INTEGER NOT NULL,
        active_daily_cap INTEGER NOT NULL,
        recipient_cap_24_hours INTEGER NOT NULL,
        recipient_cap_30_days INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        superseded_at TEXT,
        superseded_by TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_stage2_runs (
        id TEXT PRIMARY KEY,
        run_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        pacific_business_date TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        source_policy_hash TEXT NOT NULL,
        activation_id TEXT,
        considered_count INTEGER NOT NULL DEFAULT 0,
        eligible_count INTEGER NOT NULL DEFAULT 0,
        would_send_count INTEGER NOT NULL DEFAULT 0,
        attempted_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        ambiguous_count INTEGER NOT NULL DEFAULT 0,
        deferred_count INTEGER NOT NULL DEFAULT 0,
        blocked_counts TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_cim_stage2_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        deal_key TEXT NOT NULL,
        decision_state TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        source_policy_hash TEXT NOT NULL,
        activation_id TEXT,
        snapshot_digest TEXT NOT NULL,
        recipient_hash TEXT NOT NULL,
        source_snapshot_digest TEXT NOT NULL,
        reasons TEXT NOT NULL DEFAULT '[]',
        claim_token TEXT,
        claimed_at TEXT,
        consumed_at TEXT,
        cim_request_id TEXT,
        communication_id TEXT,
        provider_state TEXT,
        last_error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, opportunity_id, policy_hash)
      );

      CREATE TABLE IF NOT EXISTS deal_hunter_dispositions (
        id TEXT PRIMARY KEY,
        deal_key TEXT NOT NULL UNIQUE,
        submission_id TEXT,
        communication_id TEXT,
        listing_url TEXT,
        deal_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disposition TEXT NOT NULL,
        reason TEXT,
        note TEXT,
        dismissed_at TEXT,
        dismissed_by TEXT,
        restored_at TEXT,
        restored_by TEXT,
        created_by TEXT NOT NULL DEFAULT 'system',
        updated_by TEXT NOT NULL DEFAULT 'system',
        metadata TEXT NOT NULL DEFAULT '{}'
      );

    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      job_key TEXT PRIMARY KEY,
      job_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      triggered_by TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      provider_message_id TEXT,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      request_id TEXT,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS secure_document_cleanup_jobs (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      trash_directory TEXT,
      files TEXT NOT NULL DEFAULT '[]',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      lease_claimed_at TEXT,
      lease_expires_at TEXT,
      lease_token TEXT
    );

    CREATE TABLE IF NOT EXISTS source_health_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      healthy INTEGER NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      issue_count INTEGER NOT NULL DEFAULT 0,
      snapshot TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS admin_magic_links (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      requested_ip_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      username TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_ip_hash TEXT,
      user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS admin_onboarding_progress (
      principal_id TEXT NOT NULL,
      tour_key TEXT NOT NULL,
      tour_version INTEGER NOT NULL CHECK (tour_version > 0),
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'skipped')),
      last_completed_step_id TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      skipped_at TEXT,
      PRIMARY KEY (principal_id, tour_key, tour_version),
      CHECK (
        (status = 'in_progress' AND completed_at IS NULL AND skipped_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL AND skipped_at IS NULL)
        OR (status = 'skipped' AND completed_at IS NULL AND skipped_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at ON contact_submissions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_status ON contact_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_email ON contact_submissions(email);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_ip_hash ON contact_submissions(ip_hash);
    CREATE INDEX IF NOT EXISTS idx_contact_rate_limit_events_bucket ON contact_rate_limit_events(bucket, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created ON analytics_events(event_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_path_created ON analytics_events(path, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_upload_requests_submission_id ON secure_upload_requests(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_documents_submission_id ON secure_documents(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_documents_request_id ON secure_documents(request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_submission_id ON email_events(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_recipient_email ON email_events(recipient_email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_message_id ON email_events(message_id);
    CREATE INDEX IF NOT EXISTS idx_email_events_event_type ON email_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_activity_submission_created ON crm_activity_events(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_activity_type_created ON crm_activity_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_communications_submission_occurred ON crm_communications(submission_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_communications_cim_occurred ON crm_communications(cim_request_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_communications_deal_occurred ON crm_communications(deal_key, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_communications_unassigned ON crm_communications(occurred_at DESC, id DESC) WHERE submission_id IS NULL AND direction = 'inbound';
    CREATE INDEX IF NOT EXISTS idx_crm_communications_content_retry ON crm_communications(content_state, content_next_attempt_at) WHERE content_state IN ('pending', 'failed');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_communications_provider_message ON crm_communications(provider, provider_message_id, direction) WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL AND provider_message_id <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_communications_source_event ON crm_communications(provider, source_event_id) WHERE provider IS NOT NULL AND source_event_id IS NOT NULL AND source_event_id <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_communications_idempotency ON crm_communications(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
    CREATE INDEX IF NOT EXISTS idx_crm_email_outbox_submission_created ON crm_email_outbox(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_email_outbox_claimable ON crm_email_outbox(state, next_attempt_at, claim_expires_at);
    CREATE INDEX IF NOT EXISTS idx_crm_email_outbox_provider_message ON crm_email_outbox(provider_message_id);
    CREATE INDEX IF NOT EXISTS idx_crm_follow_up_recommendations_submission_created ON crm_follow_up_recommendations(submission_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_follow_up_recommendations_cache ON crm_follow_up_recommendations(submission_id, input_fingerprint, engine_version);
    UPDATE crm_follow_up_recommendations
    SET status = 'superseded', superseded_at = COALESCE(superseded_at, created_at)
    WHERE status = 'current'
      AND EXISTS (
        SELECT 1 FROM crm_follow_up_recommendations AS newer
        WHERE newer.submission_id = crm_follow_up_recommendations.submission_id
          AND newer.status = 'current'
          AND (newer.created_at > crm_follow_up_recommendations.created_at
            OR (newer.created_at = crm_follow_up_recommendations.created_at AND newer.id > crm_follow_up_recommendations.id))
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_follow_up_recommendations_one_current
      ON crm_follow_up_recommendations(submission_id) WHERE status = 'current';
    CREATE INDEX IF NOT EXISTS idx_email_suppressions_active ON email_suppressions(normalized_email) WHERE lifted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_last_seen_at ON deal_hunter_seen_deals(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_source_id ON deal_hunter_seen_deals(source_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_deal_os_imports_created_at ON deal_hunter_deal_os_imports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_deal_os_imports_exported_at ON deal_hunter_deal_os_imports(exported_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_deal_recipient ON deal_hunter_cim_requests(deal_key, recipient_email);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_deal_key ON deal_hunter_cim_requests(deal_key, updated_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_reviews_created ON deal_hunter_cim_reviews(created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_reviews_deal ON deal_hunter_cim_reviews(deal_key, created_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_deal_key ON deal_hunter_crm_imports(deal_key);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_listing_identity ON deal_hunter_crm_imports(listing_identity) WHERE listing_identity IS NOT NULL AND listing_identity <> '';
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_submission_id ON deal_hunter_crm_imports(submission_id);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_opportunities_updated ON deal_hunter_opportunities(updated_at DESC, opportunity_id);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_opportunities_recipient ON deal_hunter_opportunities(canonical_recipient, updated_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_opportunity_facts_history ON deal_hunter_opportunity_facts(opportunity_id, created_at DESC, id DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_source_observations_history ON deal_hunter_opportunity_source_observations(opportunity_id, observed_at DESC, id ASC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_opportunity_aliases_opportunity ON deal_hunter_opportunity_aliases(opportunity_id, alias_type);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_identity_exceptions_status ON deal_hunter_identity_exceptions(status, updated_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_overrides_lookup ON deal_hunter_cim_recipient_overrides(opportunity_id, recipient_email, expires_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_repair_manifests_created ON deal_hunter_cim_repair_manifests(created_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_cim_stage2_one_current_activation ON deal_hunter_cim_stage2_activations(status) WHERE status = 'current';
	    CREATE INDEX IF NOT EXISTS idx_cim_stage2_activations_created ON deal_hunter_cim_stage2_activations(created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_cim_stage2_runs_date_mode ON deal_hunter_cim_stage2_runs(pacific_business_date DESC, mode, status);
	    CREATE INDEX IF NOT EXISTS idx_cim_stage2_runs_policy ON deal_hunter_cim_stage2_runs(policy_hash, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_cim_stage2_decisions_run ON deal_hunter_cim_stage2_decisions(run_id, decision_state);
	    CREATE INDEX IF NOT EXISTS idx_cim_stage2_decisions_opportunity ON deal_hunter_cim_stage2_decisions(opportunity_id, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_cim_stage2_decisions_evidence ON deal_hunter_cim_stage2_decisions(policy_hash, source_policy_hash, decision_state);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_cim_stage2_active_opportunity_claim ON deal_hunter_cim_stage2_decisions(opportunity_id)
	      WHERE decision_state IN ('claimed', 'attempting', 'ambiguous');
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_dispositions_updated ON deal_hunter_dispositions(updated_at DESC, id DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_dispositions_submission ON deal_hunter_dispositions(submission_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_name_updated_at ON scheduled_job_runs(job_name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created_at ON admin_audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_document_cleanup_jobs_status ON secure_document_cleanup_jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_source_health_snapshots_created_at ON source_health_snapshots(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_magic_links_expires_at ON admin_magic_links(expires_at);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_username ON admin_sessions(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
		CREATE INDEX IF NOT EXISTS idx_admin_onboarding_progress_principal_updated
		  ON admin_onboarding_progress(principal_id, updated_at DESC);
	  `);

  migrateCrmSubmissionReversalTrigger(database);

  ensureColumn(database, 'contact_submissions', 'lead_type', "TEXT NOT NULL DEFAULT 'owner'");
  ensureColumn(database, 'contact_submissions', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(database, 'contact_submissions', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'contact_submissions', 'assigned_to', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'notes', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'follow_up_state', "TEXT NOT NULL DEFAULT 'needs-response'");
  ensureColumn(database, 'contact_submissions', 'next_action_at', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'last_contacted_at', 'TEXT');
  ensureColumn(database, 'secure_upload_requests', 'requested_documents', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'secure_upload_requests', 'revoked_at', 'TEXT');
  ensureColumn(database, 'secure_upload_requests', 'closed_at', 'TEXT');
  ensureColumn(database, 'secure_upload_requests', 'upload_batch_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'secure_document_cleanup_jobs', 'lease_claimed_at', 'TEXT');
  ensureColumn(database, 'secure_document_cleanup_jobs', 'lease_expires_at', 'TEXT');
  ensureColumn(database, 'secure_document_cleanup_jobs', 'lease_token', 'TEXT');
  database.exec('CREATE INDEX IF NOT EXISTS idx_secure_document_cleanup_jobs_lease ON secure_document_cleanup_jobs(status, lease_expires_at)');
  ensureColumn(database, 'crm_communications', 'message_id', 'TEXT');
  ensureColumn(database, 'crm_communications', 'references_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'crm_communications', 'parent_communication_id', 'TEXT');
  ensureColumn(database, 'crm_communications', 'thread_key', 'TEXT');
  ensureColumn(database, 'crm_communications', 'legacy_content_unavailable', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'crm_communications', 'content_redaction_state', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(database, 'crm_communications', 'recommendation_id', 'TEXT');
  ensureColumn(database, 'crm_communications', 'outbox_id', 'TEXT');
  ensureColumn(database, 'crm_communications', 'headers_json', "TEXT NOT NULL DEFAULT '{}'");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_communications_message_id ON crm_communications(message_id) WHERE message_id IS NOT NULL AND message_id <> '';
    CREATE INDEX IF NOT EXISTS idx_crm_communications_parent ON crm_communications(parent_communication_id);
    CREATE INDEX IF NOT EXISTS idx_crm_communications_thread_occurred ON crm_communications(thread_key, occurred_at DESC, id DESC);
  `);
  ensureColumn(database, 'contact_submissions', 'status_updated_at', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'listing_url', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'business_website', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'prospectus_url', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'asking_price', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'ttm_revenue', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'ttm_ebitda', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'ebitda_multiple', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'net_margin', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'business_age', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'sba_eligible', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(database, 'contact_submissions', 'broker_name', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'broker_email', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'broker_phone', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'seller_name', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'seller_email', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'seller_phone', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'archived_at', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'archived_by', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'archive_reason', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'archive_note', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'archive_communication_id', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'restored_at', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'restored_by', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'deal_hunter_opportunity_id', 'TEXT');
  ensureColumn(database, 'email_events', 'provider_event_id', 'TEXT');
  ensureColumn(database, 'email_events', 'event_key', 'TEXT');
  ensureColumn(database, 'email_events', 'communication_id', 'TEXT');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_event_key ON email_events(event_key)');
  ensureColumn(database, 'admin_sessions', 'principal_id', 'TEXT');
  database.exec(`
    UPDATE admin_sessions
    SET principal_id = CASE
      WHEN role = 'admin' THEN 'admin:primary'
      ELSE 'viewer:identity:' || lower(trim(username))
    END
    WHERE principal_id IS NULL OR trim(principal_id) = '';

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_principal
      ON admin_sessions(principal_id, created_at DESC);
  `);
  ensureColumn(database, 'deal_hunter_cim_requests', 'follow_up_count', 'INTEGER NOT NULL DEFAULT 0');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'last_follow_up_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'next_follow_up_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'responded_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'submission_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'request_state', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'delivery_state', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'delivery_state_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'follow_up_state', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'first_requested_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'first_provider_accepted_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'delivered_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'last_attempt_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'last_delivery_event_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'reply_to_address', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'retry_of_request_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'attempt_count', 'INTEGER');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'last_activity_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'opportunity_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'opportunity_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'snapshot_digest', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'evidence_version', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'rule_version', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'source_policy_version', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'source_policy_hash', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'source_ids', "TEXT NOT NULL DEFAULT '[]'");
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'actor_role', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_reviews', 'decision_at', 'TEXT');
	  database.exec(`
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_reviews_opportunity ON deal_hunter_cim_reviews(opportunity_id, decision_at DESC, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_reviews_policy ON deal_hunter_cim_reviews(rule_version, source_policy_hash, created_at DESC);
	  `);
	  ensureColumn(database, 'deal_hunter_crm_imports', 'listing_identity', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'listing_url', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'submission_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'source_name', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'opportunity_id', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunity_scores', 'semantic_digest', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunity_scores', 'reviewed_semantic_digest', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunity_scores', 'reviewed_discovery_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_discovery_revision >= 0)');
  ensureColumn(database, 'deal_hunter_opportunity_scores', 'reviewed_material_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_material_revision >= 0)');
  ensureColumn(database, 'deal_hunter_opportunities', 'first_accepted_at', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunities', 'first_discovery_evidence_id', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunities', 'discovery_state', "TEXT NOT NULL DEFAULT 'untracked_legacy' CHECK(discovery_state IN ('untracked_legacy', 'pending', 'known_prospective', 'known_recovered'))");
  ensureColumn(database, 'deal_hunter_opportunities', 'discovery_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK(discovery_revision >= 0)');
  ensureColumn(database, 'deal_hunter_opportunities', 'material_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK(material_revision >= 0)');
  ensureColumn(database, 'deal_hunter_opportunities', 'last_material_change_at', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'accepted_at', 'TEXT');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'accepted_run_id', 'TEXT CHECK(accepted_run_id IS NULL OR length(accepted_run_id) BETWEEN 1 AND 200)');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'accepted_evidence_id', 'TEXT CHECK(accepted_evidence_id IS NULL OR length(accepted_evidence_id) BETWEEN 1 AND 240)');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'publication_raw_header', 'TEXT CHECK(publication_raw_header IS NULL OR length(publication_raw_header) <= 100)');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'publication_raw_value', 'TEXT CHECK(publication_raw_value IS NULL OR length(publication_raw_value) <= 200)');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'publication_precision', "TEXT CHECK(publication_precision IS NULL OR publication_precision IN ('unknown', 'date', 'instant'))");
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'publication_offset', 'TEXT CHECK(publication_offset IS NULL OR length(publication_offset) <= 16)');
  ensureColumn(database, 'deal_hunter_opportunity_source_observations', 'publication_meaning', "TEXT CHECK(publication_meaning IS NULL OR publication_meaning IN ('unknown', 'listing_publication'))");
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'freshness_generation', 'INTEGER CHECK(freshness_generation IS NULL OR freshness_generation > 0)');
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'freshness_projection_state', "TEXT CHECK(freshness_projection_state IS NULL OR freshness_projection_state IN ('pending', 'accepted', 'deferred', 'superseded'))");
  // Older SQLite files cannot acquire an ALTER TABLE foreign key. These
  // triggers enforce the same reference check for upgraded installations.
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS deal_hunter_first_discovery_evidence_insert_fk
    BEFORE INSERT ON deal_hunter_opportunities
    WHEN NEW.first_discovery_evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM deal_hunter_freshness_evidence WHERE id = NEW.first_discovery_evidence_id
    ) BEGIN SELECT RAISE(ABORT, 'unknown first discovery evidence'); END;
    CREATE TRIGGER IF NOT EXISTS deal_hunter_first_discovery_evidence_update_fk
    BEFORE UPDATE OF first_discovery_evidence_id ON deal_hunter_opportunities
    WHEN NEW.first_discovery_evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM deal_hunter_freshness_evidence WHERE id = NEW.first_discovery_evidence_id
    ) BEGIN SELECT RAISE(ABORT, 'unknown first discovery evidence'); END;
    CREATE TRIGGER IF NOT EXISTS deal_hunter_current_observation_evidence_insert_fk
    BEFORE INSERT ON deal_hunter_opportunity_source_observations
    WHEN NEW.accepted_evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM deal_hunter_freshness_evidence WHERE id = NEW.accepted_evidence_id
    ) BEGIN SELECT RAISE(ABORT, 'unknown current observation evidence'); END;
    CREATE TRIGGER IF NOT EXISTS deal_hunter_current_observation_evidence_update_fk
    BEFORE UPDATE OF accepted_evidence_id ON deal_hunter_opportunity_source_observations
    WHEN NEW.accepted_evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM deal_hunter_freshness_evidence WHERE id = NEW.accepted_evidence_id
    ) BEGIN SELECT RAISE(ABORT, 'unknown current observation evidence'); END;
  `);
  // Existing installations retain their last-good visible queue. Fresh tables
  // already declare DEFAULT 0 above, and score INSERTs explicitly use 0.
  ensureColumn(database, 'deal_hunter_opportunity_scores', 'current_triage_eligible', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'source_row_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'accepted_row_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'rejected_row_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'canonical_record_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'parser_version', "TEXT NOT NULL DEFAULT 'deal-os-export-v1'");
  ensureColumn(database, 'deal_hunter_deal_os_imports', 'row_accounting', "TEXT NOT NULL DEFAULT '[]'");
	  ensureColumn(database, 'crm_communications', 'opportunity_id', 'TEXT');
	  ensureColumn(database, 'email_events', 'opportunity_id', 'TEXT');
	  ensureColumn(database, 'crm_activity_events', 'opportunity_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'communication_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'listing_url', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'deal_name', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'dismissed_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'dismissed_by', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'restored_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'restored_by', 'TEXT');
	  ensureColumn(database, 'deal_hunter_dispositions', 'created_by', "TEXT NOT NULL DEFAULT 'system'");
	  ensureColumn(database, 'deal_hunter_dispositions', 'updated_by', "TEXT NOT NULL DEFAULT 'system'");

  database.exec(`
    UPDATE deal_hunter_cim_requests
    SET
      first_requested_at = COALESCE(NULLIF(first_requested_at, ''), created_at),
      request_state = COALESCE(NULLIF(request_state, ''), CASE
        WHEN status = 'pending' THEN 'pending'
        WHEN status = 'responded' THEN 'responded'
        WHEN status = 'delivery_issue' THEN 'stopped'
        WHEN status = 'failed' THEN 'ready'
        ELSE 'provider_accepted'
      END),
	      delivery_state = COALESCE(NULLIF(delivery_state, ''), CASE
        WHEN status = 'logged' THEN 'development-only'
        WHEN status = 'failed' THEN 'failed'
        WHEN status = 'delivery_issue' THEN COALESCE(NULLIF(json_extract(metadata, '$.deliveryIssueType'), ''), 'failed')
        WHEN status = 'pending' THEN 'not-attempted'
	        ELSE 'accepted'
	      END),
	      follow_up_state = COALESCE(NULLIF(follow_up_state, ''), CASE
	        WHEN responded_at IS NOT NULL OR status = 'responded' THEN 'completed'
	        WHEN next_follow_up_at IS NOT NULL THEN 'scheduled'
	        WHEN status IN ('failed', 'delivery_issue') THEN 'stopped'
	        WHEN follow_up_count > 0 THEN 'completed'
	        ELSE 'not-scheduled'
	      END),
      reply_to_address = COALESCE(NULLIF(reply_to_address, ''), NULLIF(json_extract(metadata, '$.replyToAddress'), '')),
      attempt_count = COALESCE(attempt_count, CASE WHEN status = 'pending' THEN 0 ELSE 1 END),
      last_activity_at = COALESCE(NULLIF(last_activity_at, ''), updated_at, created_at)
    WHERE json_valid(metadata);
    CREATE INDEX IF NOT EXISTS idx_email_events_communication_id ON email_events(communication_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_broker_email_lower ON contact_submissions(LOWER(broker_email));
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_seller_email_lower ON contact_submissions(LOWER(seller_email));
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_follow_up_queue ON contact_submissions(status, follow_up_state, next_action_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_submission ON deal_hunter_cim_requests(submission_id, last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_opportunity ON deal_hunter_cim_requests(opportunity_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_opportunity ON deal_hunter_crm_imports(opportunity_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_submissions_deal_hunter_opportunity
      ON contact_submissions(deal_hunter_opportunity_id)
      WHERE deal_hunter_opportunity_id IS NOT NULL AND deal_hunter_opportunity_id <> '';
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_crm_reconciliation_runs_import
      ON deal_hunter_crm_reconciliation_runs(import_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_crm_reconciliation_items_run
      ON deal_hunter_crm_reconciliation_items(run_id, status, opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_scores_queue
      ON deal_hunter_opportunity_scores(should_remove, fit_score DESC, confidence, opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_scores_current_queue
      ON deal_hunter_opportunity_scores(current_triage_eligible, should_remove, fit_score DESC, opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_scores_priority
      ON deal_hunter_opportunity_scores(operator_priority, fit_score DESC, opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_scores_acquisition_priority
      ON deal_hunter_opportunity_scores(
        current_triage_eligible, should_remove, operator_priority, high_fit,
        fit_score DESC, confidence, scored_at DESC, opportunity_id
      );
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_source_observations_queue_projection
      ON deal_hunter_opportunity_source_observations(opportunity_id, field, observed_at DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_scores_fingerprint
      ON deal_hunter_opportunity_scores(score_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_score_evidence_opportunity
      ON deal_hunter_score_evidence(opportunity_id, dimension, evidence_class);
    CREATE INDEX IF NOT EXISTS idx_crm_communications_opportunity ON crm_communications(opportunity_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_opportunity ON email_events(opportunity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_activity_opportunity ON crm_activity_events(opportunity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_request_state ON deal_hunter_cim_requests(request_state, first_requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_delivery_state ON deal_hunter_cim_requests(delivery_state, last_delivery_event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_follow_up_state ON deal_hunter_cim_requests(follow_up_state, next_follow_up_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_reply_to ON deal_hunter_cim_requests(LOWER(reply_to_address)) WHERE reply_to_address IS NOT NULL AND reply_to_address <> '';
  `);

  const crmImportOpportunityCollisions = database.prepare(`
    SELECT opportunity_id, COUNT(*) AS record_count
    FROM deal_hunter_crm_imports
    WHERE opportunity_id IS NOT NULL AND opportunity_id <> ''
    GROUP BY opportunity_id
    HAVING COUNT(*) > 1
  `).all();
  if (crmImportOpportunityCollisions.length === 0) {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_unique_opportunity
      ON deal_hunter_crm_imports(opportunity_id)
      WHERE opportunity_id IS NOT NULL AND opportunity_id <> '';
    `);
  }
  const canonicalCrmOwnershipHealthy = crmImportOpportunityCollisions.length === 0;

  const legacyCimRequests = database.prepare(`
    SELECT id, deal_key, listing_url
    FROM deal_hunter_cim_requests
    WHERE submission_id IS NULL
  `).all();
  if (legacyCimRequests.length > 0) {
    const submissions = database.prepare('SELECT id, listing_url, metadata FROM contact_submissions').all();
    const submissionIds = new Set(submissions.map((submission) => submission.id));
    const submissionIdsByListingIdentity = new Map();
    const submissionIdsByDealKey = new Map();
    for (const submission of submissions) {
      const listingIdentity = canonicalListingIdentity(submission.listing_url);
      if (listingIdentity) {
        const ids = submissionIdsByListingIdentity.get(listingIdentity) || new Set();
        ids.add(submission.id);
        submissionIdsByListingIdentity.set(listingIdentity, ids);
      }
      const metadata = parseJsonColumn(submission.metadata, {});
      const dealKey = String(metadata?.dealHunter?.dealKey || '').trim();
      if (dealKey) {
        const ids = submissionIdsByDealKey.get(dealKey) || new Set();
        ids.add(submission.id);
        submissionIdsByDealKey.set(dealKey, ids);
      }
    }
    const importRows = database.prepare(`
      SELECT deal_key, submission_id
      FROM deal_hunter_crm_imports
      WHERE submission_id IS NOT NULL AND TRIM(submission_id) <> ''
    `).all();
    const importIdsByDealKey = new Map();
    for (const row of importRows) {
      if (!submissionIds.has(row.submission_id)) continue;
      const ids = importIdsByDealKey.get(row.deal_key) || new Set();
      ids.add(row.submission_id);
      importIdsByDealKey.set(row.deal_key, ids);
    }
    const updateLegacyCimLink = database.prepare(`
      UPDATE deal_hunter_cim_requests SET submission_id = ?
      WHERE id = ? AND submission_id IS NULL
    `);
    database.transaction(() => {
      for (const request of legacyCimRequests) {
        const candidateIds = new Set(importIdsByDealKey.get(request.deal_key) || []);
        const listingIdentity = canonicalListingIdentity(request.listing_url);
        if (listingIdentity) {
          for (const id of submissionIdsByListingIdentity.get(listingIdentity) || []) candidateIds.add(id);
        }
        for (const id of submissionIdsByDealKey.get(request.deal_key) || []) candidateIds.add(id);
        if (candidateIds.size === 1) updateLegacyCimLink.run(candidateIds.values().next().value, request.id);
      }
    })();
  }

  const insertSubmissionStatement = database.prepare(`
    INSERT INTO contact_submissions (
      id,
      created_at,
      updated_at,
      status,
      spam_score,
      spam_reasons,
      delivery_provider,
      delivery_status,
      delivery_error,
      crm_status,
      crm_error,
      source,
      ip_hash,
      user_agent,
      name,
      email,
      phone,
      company,
      role,
      message,
      status_updated_at,
      listing_url,
      business_website,
      prospectus_url,
      asking_price,
      ttm_revenue,
      ttm_ebitda,
      ebitda_multiple,
      net_margin,
      business_age,
      sba_eligible,
      broker_name,
      broker_email,
      broker_phone,
      seller_name,
      seller_email,
      seller_phone,
      lead_type,
      priority,
      tags,
      assigned_to,
      notes,
      follow_up_state,
      next_action_at,
      last_contacted_at,
      deal_hunter_opportunity_id,
      metadata
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
      @status,
      @spam_score,
      @spam_reasons,
      @delivery_provider,
      @delivery_status,
      @delivery_error,
      @crm_status,
      @crm_error,
      @source,
      @ip_hash,
      @user_agent,
      @name,
      @email,
      @phone,
      @company,
      @role,
      @message,
      @status_updated_at,
      @listing_url,
      @business_website,
      @prospectus_url,
      @asking_price,
      @ttm_revenue,
      @ttm_ebitda,
      @ebitda_multiple,
      @net_margin,
      @business_age,
      @sba_eligible,
      @broker_name,
      @broker_email,
      @broker_phone,
      @seller_name,
      @seller_email,
      @seller_phone,
      @lead_type,
      @priority,
      @tags,
      @assigned_to,
      @notes,
      @follow_up_state,
      @next_action_at,
      @last_contacted_at,
      @deal_hunter_opportunity_id,
      @metadata
    )
  `);

  const insertSecureUploadRequestStatement = database.prepare(`
    INSERT INTO secure_upload_requests (
      id,
      submission_id,
      created_at,
      updated_at,
      email,
      contact_name,
      requested_by,
      status,
      expires_at,
      nda_required,
      nda_accepted_at,
      last_uploaded_at,
      note,
      requested_documents,
      revoked_at,
      closed_at,
      upload_batch_count
    ) VALUES (
      @id,
      @submission_id,
      @created_at,
      @updated_at,
      @email,
      @contact_name,
      @requested_by,
      @status,
      @expires_at,
      @nda_required,
      @nda_accepted_at,
      @last_uploaded_at,
      @note,
      @requested_documents,
      @revoked_at,
      @closed_at,
      @upload_batch_count
    )
  `);

  const insertSecureDocumentStatement = database.prepare(`
    INSERT INTO secure_documents (
      id,
      request_id,
      submission_id,
      created_at,
      document_type,
      file_name,
      original_name,
      mime_type,
      size_bytes,
      storage_path,
      uploaded_by_email,
      note,
      nda_accepted_at
    ) VALUES (
      @id,
      @request_id,
      @submission_id,
      @created_at,
      @document_type,
      @file_name,
      @original_name,
      @mime_type,
      @size_bytes,
      @storage_path,
      @uploaded_by_email,
      @note,
      @nda_accepted_at
    )
  `);
  const deleteSecureDocumentStatement = database.prepare('DELETE FROM secure_documents WHERE id = ?');

  const insertEmailEventStatement = database.prepare(`
    INSERT INTO email_events (
      id,
      created_at,
      provider,
      event_type,
      message_id,
      provider_event_id,
      event_key,
      recipient_email,
      subject,
      submission_id,
      communication_id,
      opportunity_id,
      source,
      metadata
    ) VALUES (
      @id,
      @created_at,
      @provider,
      @event_type,
      @message_id,
      @provider_event_id,
      @event_key,
      @recipient_email,
      @subject,
      @submission_id,
      @communication_id,
      @opportunity_id,
      @source,
      @metadata
    )
    ON CONFLICT(event_key) DO NOTHING
  `);
  const getEmailEventByKeyStatement = database.prepare('SELECT * FROM email_events WHERE event_key = ? LIMIT 1');
  const insertCrmActivityEventStatement = database.prepare(`
    INSERT INTO crm_activity_events (
      id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
    ) VALUES (
      @id, @submission_id, @opportunity_id, @created_at, @actor, @role, @event_type, @summary, @metadata
    )
  `);
  const insertCrmCommunicationStatement = database.prepare(`
    INSERT INTO crm_communications (
      id, submission_id, opportunity_id, deal_key, cim_request_id, direction, channel, source, kind,
      provider, provider_message_id, source_event_id, idempotency_key, message_id, in_reply_to,
      references_json, parent_communication_id, thread_key, legacy_content_unavailable,
      content_redaction_state, recommendation_id, outbox_id, headers_json,
      reply_to_address, from_address, to_addresses, cc_addresses, bcc_addresses,
      subject, body_text, body_html_sanitized, occurred_at, created_at, updated_at,
      delivery_state, delivery_state_at, content_state, content_attempt_count,
      content_last_error, content_next_attempt_at, attachment_metadata, assigned_at,
      assigned_by, created_by, updated_by, metadata
    ) VALUES (
      @id, @submission_id, @opportunity_id, @deal_key, @cim_request_id, @direction, @channel, @source, @kind,
      @provider, @provider_message_id, @source_event_id, @idempotency_key, @message_id, @in_reply_to,
      @references_json, @parent_communication_id, @thread_key, @legacy_content_unavailable,
      @content_redaction_state, @recommendation_id, @outbox_id, @headers_json,
      @reply_to_address, @from_address, @to_addresses, @cc_addresses, @bcc_addresses,
      @subject, @body_text, @body_html_sanitized, @occurred_at, @created_at, @updated_at,
      @delivery_state, @delivery_state_at, @content_state, @content_attempt_count,
      @content_last_error, @content_next_attempt_at, @attachment_metadata, @assigned_at,
      @assigned_by, @created_by, @updated_by, @metadata
    )
    ON CONFLICT DO NOTHING
  `);
  const insertCrmEmailOutboxStatement = database.prepare(`
    INSERT INTO crm_email_outbox (
      id, communication_id, submission_id, cim_request_id, idempotency_key,
      client_request_key, state, provider, provider_message_id, attempt_count,
      next_attempt_at, claim_token, claimed_at, claim_expires_at, accepted_at,
      failed_at, ambiguous_at, last_error_category, last_error_message,
      expected_submission_version, actor, intended_follow_up_state,
      intended_next_action_at, created_at, updated_at, metadata
    ) VALUES (
      @id, @communication_id, @submission_id, @cim_request_id, @idempotency_key,
      @client_request_key, @state, @provider, @provider_message_id, @attempt_count,
      @next_attempt_at, @claim_token, @claimed_at, @claim_expires_at, @accepted_at,
      @failed_at, @ambiguous_at, @last_error_category, @last_error_message,
      @expected_submission_version, @actor, @intended_follow_up_state,
      @intended_next_action_at, @created_at, @updated_at, @metadata
    )
  `);
  const insertCrmFollowUpRecommendationStatement = database.prepare(`
    INSERT INTO crm_follow_up_recommendations (
      id, submission_id, cim_request_id, triggering_communication_id, input_fingerprint,
      engine_version, rules_version, model_provider, model_id, status, conversation_state,
      intent, action_type, priority_score, confidence, recommended_next_action_at,
      thread_parent_communication_id, rationale, evidence_json, signals_json,
      commitments_json, questions_json, blockers_json, safety_flags_json, draft_subject,
      draft_body_text, created_at, expires_at, acted_on_at, superseded_at, acted_on_by,
      outcome, metadata
    ) VALUES (
      @id, @submission_id, @cim_request_id, @triggering_communication_id, @input_fingerprint,
      @engine_version, @rules_version, @model_provider, @model_id, @status, @conversation_state,
      @intent, @action_type, @priority_score, @confidence, @recommended_next_action_at,
      @thread_parent_communication_id, @rationale, @evidence_json, @signals_json,
      @commitments_json, @questions_json, @blockers_json, @safety_flags_json, @draft_subject,
      @draft_body_text, @created_at, @expires_at, @acted_on_at, @superseded_at, @acted_on_by,
      @outcome, @metadata
    )
    ON CONFLICT(submission_id, input_fingerprint, engine_version) DO NOTHING
  `);
  const upsertEmailSuppressionStatement = database.prepare(`
    INSERT INTO email_suppressions (
      id, normalized_email, reason, source, source_event_id, source_communication_id,
      created_at, created_by, lifted_at, lifted_by, lift_reason, metadata
    ) VALUES (
      @id, @normalized_email, @reason, @source, @source_event_id, @source_communication_id,
      @created_at, @created_by, @lifted_at, @lifted_by, @lift_reason, @metadata
    )
    ON CONFLICT(normalized_email) DO UPDATE SET
      reason = excluded.reason,
      source = excluded.source,
      source_event_id = excluded.source_event_id,
      source_communication_id = excluded.source_communication_id,
      created_at = excluded.created_at,
      created_by = excluded.created_by,
      lifted_at = NULL,
      lifted_by = NULL,
      lift_reason = NULL,
      metadata = excluded.metadata
  `);

  function getExistingCrmCommunication(communication) {
    const serialized = serializeCrmCommunication(communication);
    return normalizeCrmCommunicationRow(
      database.prepare(`
        SELECT * FROM crm_communications
        WHERE id = @id
          OR (@idempotency_key IS NOT NULL AND idempotency_key = @idempotency_key)
          OR (
            @provider IS NOT NULL AND @source_event_id IS NOT NULL
            AND provider = @provider AND source_event_id = @source_event_id
          )
          OR (
            @provider IS NOT NULL AND @provider_message_id IS NOT NULL
            AND provider = @provider AND provider_message_id = @provider_message_id AND direction = @direction
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(serialized),
    );
  }

  const upsertDealHunterSeenDealStatement = database.prepare(`
    INSERT INTO deal_hunter_seen_deals (
      id,
      first_seen_at,
      last_seen_at,
      source_id,
      source_name,
      source_mode,
      external_id,
      listing_url,
      name,
      industry,
      location,
      annual_profit,
      annual_revenue,
      asking_price,
      score,
      should_remove,
      metadata
    ) VALUES (
      @id,
      @first_seen_at,
      @last_seen_at,
      @source_id,
      @source_name,
      @source_mode,
      @external_id,
      @listing_url,
      @name,
      @industry,
      @location,
      @annual_profit,
      @annual_revenue,
      @asking_price,
      @score,
      @should_remove,
      @metadata
    )
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      source_id = excluded.source_id,
      source_name = excluded.source_name,
      source_mode = excluded.source_mode,
      external_id = excluded.external_id,
      listing_url = excluded.listing_url,
      name = excluded.name,
      industry = excluded.industry,
      location = excluded.location,
      annual_profit = excluded.annual_profit,
      annual_revenue = excluded.annual_revenue,
      asking_price = excluded.asking_price,
      score = excluded.score,
      should_remove = excluded.should_remove,
      metadata = excluded.metadata
  `);
  const upsertDealHunterSeenDealsTransaction = database.transaction((records) => {
    records.forEach((record) => upsertDealHunterSeenDealStatement.run(serializeDealHunterSeenDeal(record)));
  });

  const upsertDealHunterCimRequestStatement = database.prepare(`
    INSERT INTO deal_hunter_cim_requests (
      id,
      created_at,
      updated_at,
      opportunity_id,
      deal_key,
      recipient_email,
      requested_by,
      status,
      delivery_error,
      provider_message_id,
      subject,
      deal_name,
      source_name,
      listing_url,
      score,
      follow_up_count,
      last_follow_up_at,
      next_follow_up_at,
      responded_at,
      submission_id,
      request_state,
      delivery_state,
      delivery_state_at,
      follow_up_state,
      first_requested_at,
      first_provider_accepted_at,
      delivered_at,
      last_attempt_at,
      last_delivery_event_at,
      reply_to_address,
      retry_of_request_id,
      attempt_count,
      last_activity_at,
      metadata
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
      @opportunity_id,
      @deal_key,
      @recipient_email,
      @requested_by,
      @status,
      @delivery_error,
      @provider_message_id,
      @subject,
      @deal_name,
      @source_name,
      @listing_url,
      @score,
      @follow_up_count,
      @last_follow_up_at,
      @next_follow_up_at,
      @responded_at,
      @submission_id,
      @request_state,
      @delivery_state,
      @delivery_state_at,
      @follow_up_state,
      @first_requested_at,
      @first_provider_accepted_at,
      @delivered_at,
      @last_attempt_at,
      @last_delivery_event_at,
      @reply_to_address,
      @retry_of_request_id,
      @attempt_count,
      @last_activity_at,
      @metadata
    )
    ON CONFLICT(deal_key, recipient_email) DO UPDATE SET
      updated_at = excluded.updated_at,
      opportunity_id = COALESCE(excluded.opportunity_id, deal_hunter_cim_requests.opportunity_id),
      requested_by = excluded.requested_by,
      status = excluded.status,
      delivery_error = excluded.delivery_error,
      provider_message_id = excluded.provider_message_id,
      subject = excluded.subject,
      deal_name = excluded.deal_name,
      source_name = excluded.source_name,
      listing_url = excluded.listing_url,
      score = excluded.score,
      follow_up_count = excluded.follow_up_count,
      last_follow_up_at = excluded.last_follow_up_at,
      next_follow_up_at = excluded.next_follow_up_at,
      responded_at = excluded.responded_at,
      submission_id = COALESCE(excluded.submission_id, deal_hunter_cim_requests.submission_id),
      request_state = COALESCE(excluded.request_state, deal_hunter_cim_requests.request_state),
      delivery_state = COALESCE(excluded.delivery_state, deal_hunter_cim_requests.delivery_state),
      delivery_state_at = COALESCE(excluded.delivery_state_at, deal_hunter_cim_requests.delivery_state_at),
      follow_up_state = COALESCE(excluded.follow_up_state, deal_hunter_cim_requests.follow_up_state),
      first_requested_at = COALESCE(deal_hunter_cim_requests.first_requested_at, excluded.first_requested_at, excluded.created_at),
      first_provider_accepted_at = COALESCE(deal_hunter_cim_requests.first_provider_accepted_at, excluded.first_provider_accepted_at),
      delivered_at = COALESCE(excluded.delivered_at, deal_hunter_cim_requests.delivered_at),
      last_attempt_at = COALESCE(excluded.last_attempt_at, deal_hunter_cim_requests.last_attempt_at),
      last_delivery_event_at = COALESCE(excluded.last_delivery_event_at, deal_hunter_cim_requests.last_delivery_event_at),
      reply_to_address = COALESCE(excluded.reply_to_address, deal_hunter_cim_requests.reply_to_address),
      retry_of_request_id = COALESCE(excluded.retry_of_request_id, deal_hunter_cim_requests.retry_of_request_id),
      attempt_count = COALESCE(excluded.attempt_count, deal_hunter_cim_requests.attempt_count, 0),
      last_activity_at = COALESCE(excluded.last_activity_at, excluded.updated_at, deal_hunter_cim_requests.last_activity_at),
      metadata = excluded.metadata
  `);
  const getDealHunterCimRequestConflictStatement = database.prepare(`
    SELECT id
    FROM deal_hunter_cim_requests
    WHERE deal_key = ? AND recipient_email = ?
    LIMIT 1
  `);
  function runDealHunterCimRequestUpsert(request) {
    const existing = getDealHunterCimRequestConflictStatement.get(request.deal_key, request.recipient_email);
    if (existing && !normalizeCanonicalCimRequestId(existing.id)) {
      const error = new Error('A legacy CIM request with a noncanonical CIM request ID cannot be updated.');
      error.code = 'DEAL_HUNTER_CIM_LEGACY_ID_COLLISION';
      throw error;
    }
    return upsertDealHunterCimRequestStatement.run(request);
  }
  const insertDealHunterCimRequestStatement = database.prepare(`
    INSERT INTO deal_hunter_cim_requests (
      id,
      created_at,
      updated_at,
      opportunity_id,
      deal_key,
      recipient_email,
      requested_by,
      status,
      delivery_error,
      provider_message_id,
      subject,
      deal_name,
      source_name,
      listing_url,
      score,
      follow_up_count,
      last_follow_up_at,
      next_follow_up_at,
      responded_at,
      submission_id,
      request_state,
      delivery_state,
      delivery_state_at,
      follow_up_state,
      first_requested_at,
      first_provider_accepted_at,
      delivered_at,
      last_attempt_at,
      last_delivery_event_at,
      reply_to_address,
      retry_of_request_id,
      attempt_count,
      last_activity_at,
      metadata
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
      @opportunity_id,
      @deal_key,
      @recipient_email,
      @requested_by,
      @status,
      @delivery_error,
      @provider_message_id,
      @subject,
      @deal_name,
      @source_name,
      @listing_url,
      @score,
      @follow_up_count,
      @last_follow_up_at,
      @next_follow_up_at,
      @responded_at,
      @submission_id,
      @request_state,
      @delivery_state,
      @delivery_state_at,
      @follow_up_state,
      @first_requested_at,
      @first_provider_accepted_at,
      @delivered_at,
      @last_attempt_at,
      @last_delivery_event_at,
      @reply_to_address,
      @retry_of_request_id,
      @attempt_count,
      @last_activity_at,
      @metadata
    )
  `);
  const claimDealHunterCimRequestStatement = database.prepare(`
    UPDATE deal_hunter_cim_requests SET
      id = @id,
      updated_at = @updated_at,
      opportunity_id = COALESCE(@opportunity_id, opportunity_id),
      requested_by = @requested_by,
      status = @status,
      delivery_error = @delivery_error,
      provider_message_id = @provider_message_id,
      subject = @subject,
      deal_name = @deal_name,
      source_name = @source_name,
      listing_url = @listing_url,
      score = @score,
      follow_up_count = @follow_up_count,
      last_follow_up_at = @last_follow_up_at,
      next_follow_up_at = @next_follow_up_at,
      responded_at = @responded_at,
      submission_id = COALESCE(@submission_id, submission_id),
      request_state = COALESCE(@request_state, request_state),
      delivery_state = COALESCE(@delivery_state, delivery_state),
      delivery_state_at = COALESCE(@delivery_state_at, delivery_state_at),
      follow_up_state = COALESCE(@follow_up_state, follow_up_state),
      first_requested_at = COALESCE(first_requested_at, @first_requested_at, created_at),
      first_provider_accepted_at = COALESCE(first_provider_accepted_at, @first_provider_accepted_at),
      delivered_at = COALESCE(@delivered_at, delivered_at),
      last_attempt_at = COALESCE(@last_attempt_at, last_attempt_at),
      last_delivery_event_at = COALESCE(@last_delivery_event_at, last_delivery_event_at),
      reply_to_address = COALESCE(@reply_to_address, reply_to_address),
      retry_of_request_id = COALESCE(@retry_of_request_id, retry_of_request_id),
      attempt_count = COALESCE(@attempt_count, attempt_count, 0),
      last_activity_at = COALESCE(@last_activity_at, @updated_at, last_activity_at),
      metadata = @metadata
    WHERE deal_key = @deal_key
      AND LOWER(recipient_email) = @recipient_email
      AND (
        status = 'failed'
        OR (status = 'pending' AND @pending_cutoff != '' AND updated_at <= @pending_cutoff)
      )
  `);

  const claimDealHunterCimRequestTransaction = database.transaction(({ request, pendingCutoff }) => {
    if (request.submission_id) assertCrmSubmissionWritableInTransaction(request.submission_id);
    const submission = request.submission_id
      ? database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(request.submission_id)
      : null;

    if (!submission || submission.status === 'archived') {
      const current = database.prepare(`
        SELECT *
        FROM deal_hunter_cim_requests
        WHERE deal_key = ? AND LOWER(recipient_email) = ?
        LIMIT 1
      `).get(request.deal_key, request.recipient_email);
      return {
        claimed: false,
        reason: submission ? 'submission-archived' : 'submission-missing',
        request: normalizeDealHunterCimRequestRow(current),
      };
    }

    const existing = database.prepare(`
      SELECT *
      FROM deal_hunter_cim_requests
      WHERE deal_key = ? AND LOWER(recipient_email) = ?
      LIMIT 1
    `).get(request.deal_key, request.recipient_email);

    if (request.retry_of_request_id) {
      const parent = database.prepare(`
        SELECT *
        FROM deal_hunter_cim_requests
        WHERE id = ? AND deal_key = ?
        LIMIT 1
      `).get(request.retry_of_request_id, request.deal_key);
      const eligibleDeliveryIssue = parent
        && parent.status === 'delivery_issue'
        && ['bounced', 'failed', 'complained', 'suppressed'].includes(parent.delivery_state);
      if (!eligibleDeliveryIssue) {
        return {
          claimed: false,
          request: normalizeDealHunterCimRequestRow(existing || parent),
        };
      }
    }

    if (existing) {
      const updateResult = claimDealHunterCimRequestStatement.run({
        ...request,
        pending_cutoff: pendingCutoff || '',
      });
      const current = database.prepare(`
        SELECT *
        FROM deal_hunter_cim_requests
        WHERE deal_key = ? AND LOWER(recipient_email) = ?
        LIMIT 1
      `).get(request.deal_key, request.recipient_email);
      if (updateResult.changes > 0 && current?.submission_id) {
        database.prepare(`
          UPDATE crm_follow_up_recommendations
          SET status = 'superseded', superseded_at = ?
          WHERE submission_id = ? AND status = 'current'
        `).run(request.updated_at || new Date().toISOString(), current.submission_id);
      }
      return {
        claimed: updateResult.changes > 0,
        request: normalizeDealHunterCimRequestRow(current),
      };
    }

    {
      const blockingRequest = database.prepare(`
        SELECT *
        FROM deal_hunter_cim_requests
        WHERE deal_key = ?
          AND (? IS NULL OR id <> ?)
          AND (
            status IN ('pending', 'sent', 'logged', 'responded', 'delivery_issue', 'follow_up_pending', 'follow_up_failed')
            OR request_state IN ('pending', 'provider_accepted', 'development_only', 'responded')
            OR delivery_state IN ('accepted', 'delivered', 'delayed', 'replied', 'development-only', 'bounced', 'complained', 'suppressed')
          )
        ORDER BY COALESCE(first_requested_at, created_at) ASC, id ASC
        LIMIT 1
      `).get(request.deal_key, request.retry_of_request_id, request.retry_of_request_id);
      if (blockingRequest) {
        return {
          claimed: false,
          request: normalizeDealHunterCimRequestRow(blockingRequest),
        };
      }
    }

    try {
      insertDealHunterCimRequestStatement.run(request);
    } catch (error) {
      if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw error;
      }
      const current = database.prepare(`
        SELECT *
        FROM deal_hunter_cim_requests
        WHERE deal_key = ? AND LOWER(recipient_email) = ?
        LIMIT 1
      `).get(request.deal_key, request.recipient_email);
      return { claimed: false, request: normalizeDealHunterCimRequestRow(current) };
    }

    const stored = database.prepare(`
      SELECT *
      FROM deal_hunter_cim_requests
      WHERE deal_key = ? AND LOWER(recipient_email) = ?
      LIMIT 1
    `).get(request.deal_key, request.recipient_email);
    if (stored?.submission_id) {
      database.prepare(`
        UPDATE crm_follow_up_recommendations
        SET status = 'superseded', superseded_at = ?
        WHERE submission_id = ? AND status = 'current'
      `).run(request.updated_at || new Date().toISOString(), stored.submission_id);
    }
    return { claimed: true, request: normalizeDealHunterCimRequestRow(stored) };
  });
	  const claimDealHunterCimFollowUpRequestStatement = database.prepare(`
	    UPDATE deal_hunter_cim_requests SET
	      status = 'follow_up_pending',
	      delivery_error = '',
      updated_at = @now_iso
    WHERE id = @id
      AND next_follow_up_at IS NOT NULL
      AND next_follow_up_at <= @due_before
      AND (
        status IN ('sent', 'logged', 'failed', 'follow_up_failed')
        OR (status = 'follow_up_pending' AND @stale_before != '' AND updated_at <= @stale_before)
	      )
	  `);
	  const claimDealHunterCimFollowUpRequestTransaction = database.transaction(({
	    id,
	    dueBefore,
	    staleBefore,
	    nowIso,
	  }) => {
	    const currentRequest = database.prepare('SELECT submission_id FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(id);
	    if (currentRequest?.submission_id) assertCrmSubmissionWritableInTransaction(currentRequest.submission_id);
	    const current = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(id);
	    if (isMarkedManualFollowUpRequest(normalizeDealHunterCimRequestRow(current))) {
	      return {
	        claimed: false,
	        reason: 'approval-required',
	        request: normalizeDealHunterCimRequestRow(current),
	      };
	    }
	    const submission = current?.submission_id
	      ? database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(current.submission_id)
	      : null;

	    if (!current || !submission || submission.status === 'archived') {
	      return {
	        claimed: false,
	        reason: !current
	          ? 'request-missing'
	          : submission
	            ? 'submission-archived'
	            : 'submission-missing',
	        request: normalizeDealHunterCimRequestRow(current),
	      };
	    }

	    const updateResult = claimDealHunterCimFollowUpRequestStatement.run({
	      id,
	      due_before: dueBefore,
	      stale_before: staleBefore || '',
	      now_iso: nowIso,
	    });
	    const row = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(id);
	    if (updateResult.changes > 0 && row?.submission_id) {
	      database.prepare(`
	        UPDATE crm_follow_up_recommendations
	        SET status = 'superseded', superseded_at = ?
	        WHERE submission_id = ? AND status = 'current'
	      `).run(nowIso, row.submission_id);
	    }

	    return {
	      claimed: updateResult.changes > 0,
	      reason: updateResult.changes > 0 ? '' : 'not-eligible',
	      request: normalizeDealHunterCimRequestRow(row),
	    };
	  });

  function loadManualFollowUpAuthority(requestId) {
    const requestRow = database.prepare(`
      SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1
    `).get(requestId);
    const submissionRow = requestRow?.submission_id
      ? database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(requestRow.submission_id)
      : null;
    return {
      requestRow,
      request: normalizeDealHunterCimRequestRow(requestRow),
      submissionRow,
      submission: submissionRow ? normalizeSubmissionRow(submissionRow) : null,
    };
  }

  const startDealHunterManualFollowUpsTransaction = database.transaction(({
    requestId,
    expectedRequestUpdatedAt,
    expectedSubmissionId,
    expectedSubmissionUpdatedAt,
    marker,
    nextFollowUpAt,
    activity,
  }) => {
    assertCrmSubmissionWritableInTransaction(expectedSubmissionId);
    const authority = loadManualFollowUpAuthority(requestId);
    if (!authority.request) {
      return manualFollowUpResult({ reason: 'request-missing' });
    }
    if (!authority.submission) {
      return manualFollowUpResult({ reason: 'submission-missing', request: authority.request });
    }
    if (authority.request.updated_at !== expectedRequestUpdatedAt
      || authority.request.submission_id !== expectedSubmissionId
      || authority.submission.id !== expectedSubmissionId
      || authority.submission.updated_at !== expectedSubmissionUpdatedAt) {
      return manualFollowUpResult({ reason: 'authority-changed', request: authority.request });
    }
    const count = Number(authority.request.follow_up_count);
    const existingMarker = manualFollowUpMarker(authority.request);
    const canonicalMarker = canonicalInitialManualFollowUpMarker(marker);
    const eligible = authority.submission.status !== 'archived'
      && authority.request.status === 'sent'
      && authority.request.request_state === 'provider_accepted'
      && ['accepted', 'delivered'].includes(authority.request.delivery_state)
      && !authority.request.responded_at
      && Number.isInteger(count)
      && count >= 0
      && count < MANUAL_FOLLOW_UP_MAXIMUM
      && !authority.request.next_follow_up_at
      && ['', 'not-scheduled'].includes(authority.request.follow_up_state || '')
      && Object.keys(existingMarker).length === 0
      && Boolean(canonicalMarker)
      && Number.isFinite(Date.parse(nextFollowUpAt || ''))
      && activity?.submission_id === expectedSubmissionId;
    if (!eligible) {
      return manualFollowUpResult({ reason: 'not-eligible', request: authority.request });
    }

    const metadata = {
      ...objectRecord(authority.request.metadata),
      manualFollowUp: canonicalMarker,
    };
    const updatedAt = canonicalMarker.enrolledAt;
    const update = database.prepare(`
      UPDATE deal_hunter_cim_requests
      SET updated_at = ?, follow_up_state = 'scheduled', next_follow_up_at = ?, metadata = ?
      WHERE id = ? AND updated_at = ? AND submission_id = ?
    `).run(
      updatedAt,
      nextFollowUpAt,
      JSON.stringify(metadata),
      requestId,
      expectedRequestUpdatedAt,
      expectedSubmissionId,
    );
    if (update.changes !== 1) {
      return manualFollowUpResult({
        reason: 'authority-changed',
        request: loadManualFollowUpAuthority(requestId).request,
      });
    }
    const storedActivity = insertCrmActivityEvent(activity);
    return manualFollowUpResult({
      applied: true,
      request: loadManualFollowUpAuthority(requestId).request,
      activity: storedActivity,
    });
  });

  const stopDealHunterManualFollowUpsTransaction = database.transaction(({
    requestId,
    expectedRequestUpdatedAt,
    expectedSubmissionId,
    expectedSubmissionUpdatedAt,
    stoppedAt,
    stoppedBy,
    reason,
    activity,
  }) => {
    assertCrmSubmissionWritableInTransaction(expectedSubmissionId);
    const authority = loadManualFollowUpAuthority(requestId);
    if (!authority.request) return manualFollowUpResult({ reason: 'request-missing' });
    if (!authority.submission) {
      return manualFollowUpResult({ reason: 'submission-missing', request: authority.request });
    }
    if (authority.request.updated_at !== expectedRequestUpdatedAt
      || authority.request.submission_id !== expectedSubmissionId
      || authority.submission.id !== expectedSubmissionId
      || authority.submission.updated_at !== expectedSubmissionUpdatedAt) {
      return manualFollowUpResult({ reason: 'authority-changed', request: authority.request });
    }
    const marker = manualFollowUpMarker(authority.request);
    const stoppedInFlight = authority.request.status === 'follow_up_pending';
    if (!hasStrictManualFollowUpCore(marker)
      || isManualFollowUpTerminal(authority.request, authority.submission)
      || Number(authority.request.follow_up_count) >= MANUAL_FOLLOW_UP_MAXIMUM
      || marker.stoppedAt
      || !Number.isFinite(Date.parse(stoppedAt || ''))
      || !boundedManualFollowUpText(stoppedBy, 300)
      || activity?.submission_id !== expectedSubmissionId) {
      return manualFollowUpResult({ reason: 'not-eligible', request: authority.request });
    }
    const metadata = {
      ...objectRecord(authority.request.metadata),
      manualFollowUp: {
        ...marker,
        stoppedAt,
        stoppedBy: boundedManualFollowUpText(stoppedBy, 300),
        stopReason: boundedManualFollowUpText(reason, 240),
      },
    };
    const update = database.prepare(`
      UPDATE deal_hunter_cim_requests
      SET updated_at = ?, follow_up_state = 'stopped', next_follow_up_at = NULL, metadata = ?
      WHERE id = ? AND updated_at = ? AND submission_id = ?
    `).run(stoppedAt, JSON.stringify(metadata), requestId, expectedRequestUpdatedAt, expectedSubmissionId);
    if (update.changes !== 1) {
      return manualFollowUpResult({
        reason: 'authority-changed',
        request: loadManualFollowUpAuthority(requestId).request,
      });
    }
    const storedActivity = insertCrmActivityEvent(activity);
    return manualFollowUpResult({
      applied: true,
      reason: stoppedInFlight ? 'stopped-in-flight' : '',
      request: loadManualFollowUpAuthority(requestId).request,
      activity: storedActivity,
    });
  });

  const claimDealHunterApprovedFollowUpTransaction = database.transaction(({
    requestId,
    expectedRequestUpdatedAt,
    expectedSubmissionId,
    expectedSubmissionUpdatedAt,
    expectedFollowUpCount,
    expectedFollowUpNumber,
    expectedNextFollowUpAt,
    claimedAt,
  }) => {
    assertCrmSubmissionWritableInTransaction(expectedSubmissionId);
    const authority = loadManualFollowUpAuthority(requestId);
    if (!authority.request) return manualFollowUpResult({ reason: 'request-missing' });
    if (!authority.submission) {
      return manualFollowUpResult({ reason: 'submission-missing', request: authority.request });
    }
    const marker = manualFollowUpMarker(authority.request);
    const count = Number(authority.request.follow_up_count);
    const claimedTimestamp = Date.parse(claimedAt || '');
    const dueTimestamp = Date.parse(authority.request.next_follow_up_at || '');
    const eligible = authority.request.updated_at === expectedRequestUpdatedAt
      && authority.request.submission_id === expectedSubmissionId
      && authority.submission.id === expectedSubmissionId
      && authority.submission.updated_at === expectedSubmissionUpdatedAt
      && authority.submission.status !== 'archived'
      && hasStrictManualFollowUpCore(marker)
      && !isManualFollowUpTerminal(authority.request, authority.submission)
      && Number.isInteger(count)
      && count === expectedFollowUpCount
      && Number.isInteger(expectedFollowUpNumber)
      && expectedFollowUpNumber >= 1
      && expectedFollowUpNumber <= MANUAL_FOLLOW_UP_MAXIMUM
      && expectedFollowUpNumber === count + 1
      && authority.request.next_follow_up_at === expectedNextFollowUpAt
      && Number.isFinite(dueTimestamp)
      && Number.isFinite(claimedTimestamp)
      && claimedTimestamp >= dueTimestamp
      && ['scheduled', 'failed'].includes(authority.request.follow_up_state)
      && ['sent', 'failed', 'follow_up_failed'].includes(authority.request.status)
      && authority.request.request_state === 'provider_accepted';
    if (!eligible) {
      return manualFollowUpResult({ reason: 'claim-ineligible', request: authority.request });
    }
    const update = database.prepare(`
      UPDATE deal_hunter_cim_requests
      SET status = 'follow_up_pending', delivery_error = '', updated_at = ?
      WHERE id = ? AND updated_at = ? AND submission_id = ?
    `).run(claimedAt, requestId, expectedRequestUpdatedAt, expectedSubmissionId);
    if (update.changes !== 1) {
      return manualFollowUpResult({
        reason: 'authority-changed',
        request: loadManualFollowUpAuthority(requestId).request,
      });
    }
    return manualFollowUpResult({
      applied: true,
      request: loadManualFollowUpAuthority(requestId).request,
    });
  });

  const finalizeDealHunterApprovedFollowUpTransaction = database.transaction(({
    requestId,
    expectedRequestUpdatedAt,
    expectedSubmissionId,
    expectedFollowUpNumber,
    expectedCommunicationId,
    outcome,
    acceptedAt,
    nextFollowUpAt,
    activity,
  }) => {
    const authority = loadManualFollowUpAuthority(requestId);
    if (!authority.request) return manualFollowUpResult({ reason: 'request-missing' });
    if (!authority.submission) {
      return manualFollowUpResult({ reason: 'submission-missing', request: authority.request });
    }
    const deterministicCommunicationId = buildManualFollowUpCommunicationId({
      requestId,
      followUpNumber: expectedFollowUpNumber,
    });
    if (!deterministicCommunicationId || expectedCommunicationId !== deterministicCommunicationId) {
      return manualFollowUpResult({ reason: 'finalize-ineligible', request: authority.request });
    }
    const communication = normalizeCrmCommunicationRow(database.prepare(`
      SELECT * FROM crm_communications WHERE id = ? LIMIT 1
    `).get(expectedCommunicationId));
    const outbox = normalizeCrmEmailOutboxRow(database.prepare(`
      SELECT * FROM crm_email_outbox WHERE communication_id = ? LIMIT 1
    `).get(expectedCommunicationId));
    const marker = manualFollowUpMarker(authority.request);
    const acceptedTouches = Array.isArray(marker.acceptedTouches) ? marker.acceptedTouches : [];
    const existingFollowUps = Array.isArray(authority.request.metadata?.followUps)
      ? authority.request.metadata.followUps
      : [];
    const alreadyAccepted = acceptedTouches.some((touch) => (
      Number(touch?.followUpNumber) === expectedFollowUpNumber
      && touch?.communicationId === expectedCommunicationId
    ));
    if (alreadyAccepted) {
      return manualFollowUpResult({
        reason: 'already-finalized',
        request: authority.request,
        alreadyFinalized: true,
      });
    }
    const previousAttempt = objectRecord(marker.currentAttempt);
    if (outcome !== 'accepted'
      && Number(previousAttempt.followUpNumber) === expectedFollowUpNumber
      && previousAttempt.communicationId === expectedCommunicationId
      && previousAttempt.outcome === outcome
      && authority.request.updated_at !== expectedRequestUpdatedAt) {
      return manualFollowUpResult({
        reason: 'already-finalized',
        request: authority.request,
        alreadyFinalized: true,
      });
    }
    const allowedOutcomes = new Set(['accepted', 'definitive-failure', 'ambiguous']);
    const count = Number(authority.request.follow_up_count);
    const communicationFollowUpNumber = Number(
      communication?.metadata?.followUpNumber ?? communication?.metadata?.follow_up_number,
    );
    const commonEligible = allowedOutcomes.has(outcome)
      && hasStrictManualFollowUpCore(marker)
      && authority.request.submission_id === expectedSubmissionId
      && authority.submission.id === expectedSubmissionId
      && Number.isInteger(expectedFollowUpNumber)
      && expectedFollowUpNumber >= 1
      && expectedFollowUpNumber <= MANUAL_FOLLOW_UP_MAXIMUM
      && Number.isInteger(count)
      && count === expectedFollowUpNumber - 1
      && communication?.id === expectedCommunicationId
      && communication?.cim_request_id === requestId
      && communication?.submission_id === expectedSubmissionId
      && communicationFollowUpNumber === expectedFollowUpNumber
      && activity?.submission_id === expectedSubmissionId;
    if (!commonEligible) {
      return manualFollowUpResult({ reason: 'finalize-ineligible', request: authority.request });
    }
    const derivedNextFollowUpAt = outcome === 'accepted'
      && expectedFollowUpNumber < MANUAL_FOLLOW_UP_MAXIMUM
      ? nextManualFollowUpAt(acceptedAt)
      : null;
    if (outcome === 'accepted') {
      const firstProviderAcceptedAt = communication.metadata?.manualFollowUp?.firstProviderAcceptedAt
        || (communication.delivery_state === 'accepted' ? communication.delivery_state_at : null);
      if (!['accepted', 'delivered', 'delayed', 'bounced', 'complained', 'suppressed', 'replied'].includes(communication.delivery_state)
        || !communication.provider_message_id
        || !Number.isFinite(Date.parse(acceptedAt || ''))
        || !Number.isFinite(Date.parse(firstProviderAcceptedAt || ''))
        || new Date(firstProviderAcceptedAt).toISOString() !== new Date(acceptedAt).toISOString()
        || (expectedFollowUpNumber < MANUAL_FOLLOW_UP_MAXIMUM
          && (!derivedNextFollowUpAt
            || Date.parse(nextFollowUpAt || '') !== Date.parse(derivedNextFollowUpAt)))) {
        return manualFollowUpResult({ reason: 'accepted-proof-missing', request: authority.request });
      }
    } else {
      if (authority.request.updated_at !== expectedRequestUpdatedAt
        || authority.request.status !== 'follow_up_pending'
        || isManualFollowUpTerminal(authority.request, authority.submission)) {
        return manualFollowUpResult({ reason: 'authority-changed', request: authority.request });
      }
      if (marker.currentAttempt?.outcome === 'ambiguous') {
        return manualFollowUpResult({ reason: 'reconciliation-required', request: authority.request });
      }
      if (outcome === 'definitive-failure' && !['failed', 'bounced', 'complained', 'suppressed'].includes(communication.delivery_state)) {
        return manualFollowUpResult({ reason: 'definitive-proof-missing', request: authority.request });
      }
      if (outcome === 'ambiguous' && (
        outbox?.state !== 'ambiguous'
        || outbox.communication_id !== expectedCommunicationId
        || outbox.cim_request_id !== requestId
        || outbox.submission_id !== expectedSubmissionId
        || !Number.isFinite(Date.parse(outbox.ambiguous_at || ''))
      )) {
        return manualFollowUpResult({ reason: 'ambiguous-proof-missing', request: authority.request });
      }
    }

    const mutationAt = [authority.request.updated_at, activity?.created_at, acceptedAt]
      .filter((value) => Number.isFinite(Date.parse(value || '')))
      .sort()
      .at(-1);
    const currentAttempt = {
      followUpNumber: expectedFollowUpNumber,
      communicationId: expectedCommunicationId,
      outcome,
      originalDueAt: marker.currentAttempt?.originalDueAt || authority.request.next_follow_up_at || null,
      updatedAt: mutationAt,
    };
    let metadata = {
      ...objectRecord(authority.request.metadata),
      manualFollowUp: {
        ...marker,
        currentAttempt,
      },
    };
    let status = authority.request.status;
    let requestState = authority.request.request_state;
    let deliveryState = authority.request.delivery_state;
    let followUpState = authority.request.follow_up_state;
    let followUpCount = count;
    let lastFollowUpAt = authority.request.last_follow_up_at;
    let nextDueAt = authority.request.next_follow_up_at;

    if (outcome === 'accepted') {
      const terminal = isManualFollowUpTerminal(authority.request, authority.submission);
      followUpCount += 1;
      lastFollowUpAt = acceptedAt;
      nextDueAt = terminal || expectedFollowUpNumber === MANUAL_FOLLOW_UP_MAXIMUM ? null : derivedNextFollowUpAt;
      followUpState = terminal
        ? (authority.request.follow_up_state === 'completed' ? 'completed' : 'stopped')
        : expectedFollowUpNumber === MANUAL_FOLLOW_UP_MAXIMUM
          ? 'completed'
          : 'scheduled';
      status = ['responded', 'delivery_issue'].includes(authority.request.status) ? authority.request.status : 'sent';
      requestState = authority.request.request_state === 'responded' ? 'responded' : 'provider_accepted';
      deliveryState = ['bounced', 'complained', 'suppressed'].includes(authority.request.delivery_state)
        ? authority.request.delivery_state
        : 'accepted';
      metadata = {
        ...metadata,
        followUps: [
          ...existingFollowUps,
          {
            number: expectedFollowUpNumber,
            attemptedAt: acceptedAt,
            acceptedAt,
            status: 'accepted',
            communicationId: expectedCommunicationId,
            providerMessageId: communication.provider_message_id || '',
            error: '',
          },
        ],
        manualFollowUp: {
          ...metadata.manualFollowUp,
          acceptedTouches: [
            ...acceptedTouches,
            {
              followUpNumber: expectedFollowUpNumber,
              communicationId: expectedCommunicationId,
              acceptedAt,
            },
          ],
          ...(expectedFollowUpNumber === MANUAL_FOLLOW_UP_MAXIMUM ? { completedAt: acceptedAt } : {}),
        },
      };
    } else if (outcome === 'definitive-failure') {
      status = 'follow_up_failed';
      followUpState = 'failed';
    } else {
      status = 'follow_up_failed';
      followUpState = 'ambiguous';
      nextDueAt = null;
    }

    const update = database.prepare(`
      UPDATE deal_hunter_cim_requests
      SET updated_at = ?, status = ?, request_state = ?, delivery_state = ?,
          follow_up_count = ?, last_follow_up_at = ?, next_follow_up_at = ?,
          follow_up_state = ?, last_activity_at = ?, metadata = ?
      WHERE id = ? AND submission_id = ?
    `).run(
      mutationAt,
      status,
      requestState,
      deliveryState,
      followUpCount,
      lastFollowUpAt,
      nextDueAt,
      followUpState,
      mutationAt,
      JSON.stringify(metadata),
      requestId,
      expectedSubmissionId,
    );
    if (update.changes !== 1) {
      return manualFollowUpResult({
        reason: 'authority-changed',
        request: loadManualFollowUpAuthority(requestId).request,
      });
    }
    const storedActivity = insertCrmActivityEvent(activity);
    return manualFollowUpResult({
      applied: true,
      request: loadManualFollowUpAuthority(requestId).request,
      activity: storedActivity,
    });
  });
	  const renewDealHunterCimRequestClaimStatement = database.prepare(`
	    UPDATE deal_hunter_cim_requests SET
	      updated_at = @now_iso
	    WHERE id = @id
	      AND updated_at = @expected_updated_at
	      AND status = @expected_status
	      AND submission_id IS NOT NULL
	      AND EXISTS (
	        SELECT 1
	        FROM contact_submissions AS submission
	        WHERE submission.id = deal_hunter_cim_requests.submission_id
	          AND submission.status <> 'archived'
	      )
	  `);
	  const renewDealHunterCimRequestClaimTransaction = database.transaction(({
	    id,
	    expectedUpdatedAt,
	    expectedStatus,
	    nowIso,
	  }) => {
	    const updateResult = renewDealHunterCimRequestClaimStatement.run({
	      id,
	      expected_updated_at: expectedUpdatedAt,
	      expected_status: expectedStatus,
	      now_iso: nowIso,
	    });
	    const row = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(id);
	    return {
	      renewed: updateResult.changes > 0,
	      reason: updateResult.changes > 0 ? '' : 'claim-ineligible',
	      request: normalizeDealHunterCimRequestRow(row),
	    };
	  });

	  const insertDealHunterCrmImportStatement = database.prepare(`
	    INSERT INTO deal_hunter_crm_imports (
	      id,
	      created_at,
	      updated_at,
	      opportunity_id,
	      deal_key,
	      listing_identity,
	      listing_url,
	      submission_id,
	      status,
	      source_name,
	      metadata
	    ) VALUES (
	      @id,
	      @created_at,
	      @updated_at,
	      @opportunity_id,
	      @deal_key,
	      @listing_identity,
	      @listing_url,
	      @submission_id,
	      @status,
	      @source_name,
	      @metadata
	    )
	  `);
	  const claimDealHunterCrmImportStatement = database.prepare(`
	    UPDATE deal_hunter_crm_imports SET
	      updated_at = @updated_at,
	      opportunity_id = COALESCE(@opportunity_id, opportunity_id),
	      listing_identity = @listing_identity,
	      listing_url = @listing_url,
	      status = @status,
	      source_name = @source_name,
	      metadata = @metadata
	    WHERE id = @id
	      AND (
	        status = 'failed'
	        OR (status = 'pending' AND @pending_cutoff != '' AND updated_at <= @pending_cutoff)
	      )
	  `);
	  const updateDealHunterCrmImportStatement = database.prepare(`
	    UPDATE deal_hunter_crm_imports SET
	      updated_at = COALESCE(@updated_at, updated_at),
	      opportunity_id = COALESCE(@opportunity_id, opportunity_id),
	      listing_identity = COALESCE(@listing_identity, listing_identity),
	      listing_url = COALESCE(@listing_url, listing_url),
	      submission_id = COALESCE(@submission_id, submission_id),
	      status = COALESCE(@status, status),
	      source_name = COALESCE(@source_name, source_name),
	      metadata = COALESCE(@metadata, metadata)
	    WHERE id = @id
	  `);

    function selectDealHunterCrmImportRow({ id = '', opportunityId = '', dealKey = '', listingIdentity = '' } = {}) {
      const lookups = [
        ['opportunity_id', opportunityId],
        ['id', id],
        ['deal_key', dealKey],
        ['listing_identity', listingIdentity],
      ];
      for (const [field, value] of lookups) {
        if (!value) continue;
        const row = database.prepare(`SELECT * FROM deal_hunter_crm_imports WHERE ${field} = ? ORDER BY updated_at DESC LIMIT 1`).get(value);
        if (row) return row;
      }
      return null;
    }

    const claimDealHunterCrmImportTransaction = database.transaction(({ record, pendingCutoff = '' }) => {
      const serializedRecord = serializeDealHunterCrmImport(record);
      let existing = selectDealHunterCrmImportRow({
        id: record.id,
        opportunityId: record.opportunity_id,
        dealKey: record.deal_key,
        listingIdentity: record.listing_identity,
      });

      if (existing?.submission_id) {
        assertCrmSubmissionWritableInTransaction(existing.submission_id);
      }

      if (!existing) {
        if (serializedRecord.submission_id) {
          assertCrmSubmissionWritableInTransaction(serializedRecord.submission_id);
        }
        try {
          insertDealHunterCrmImportStatement.run(serializedRecord);
          return {
            claimed: true,
            importRecord: normalizeDealHunterCrmImportRow(selectDealHunterCrmImportRow({ id: record.id })),
          };
        } catch (error) {
          if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
            throw error;
          }
          existing = selectDealHunterCrmImportRow({
            id: record.id,
            opportunityId: record.opportunity_id,
            dealKey: record.deal_key,
            listingIdentity: record.listing_identity,
          });
          if (existing?.submission_id) {
            assertCrmSubmissionWritableInTransaction(existing.submission_id);
          }
        }
      }

      const claimTarget = existing
        ? { ...serializedRecord, id: existing.id, pending_cutoff: pendingCutoff || '' }
        : { ...serializedRecord, pending_cutoff: pendingCutoff || '' };
      const updateResult = existing
        ? claimDealHunterCrmImportStatement.run(claimTarget)
        : { changes: 0 };
      return {
        claimed: updateResult.changes > 0,
        importRecord: normalizeDealHunterCrmImportRow(selectDealHunterCrmImportRow({
          id: existing?.id || record.id,
          opportunityId: record.opportunity_id,
          dealKey: record.deal_key,
          listingIdentity: record.listing_identity,
        })),
      };
    });

    const updateDealHunterCrmImportTransaction = database.transaction(({ id, values = {} }) => {
      const current = database.prepare('SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1').get(id);
      if (!current) return null;

      const sourceSubmissionId = String(current.submission_id || '').trim();
      if (sourceSubmissionId) {
        assertCrmSubmissionWritableInTransaction(sourceSubmissionId);
      }

      const targetSubmissionId = Object.hasOwn(values, 'submission_id')
        ? String(values.submission_id || '').trim()
        : '';
      if (targetSubmissionId && targetSubmissionId !== sourceSubmissionId) {
        assertCrmSubmissionWritableInTransaction(targetSubmissionId);
      }

      updateDealHunterCrmImportStatement.run({
        id,
        updated_at: values.updated_at || null,
        opportunity_id: values.opportunity_id || null,
        listing_identity: values.listing_identity || null,
        listing_url: values.listing_url || null,
        submission_id: values.submission_id || null,
        status: values.status || null,
        source_name: values.source_name || null,
        metadata: values.metadata ? JSON.stringify(values.metadata) : null,
      });

      return normalizeDealHunterCrmImportRow(
        database.prepare('SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1').get(id),
      );
    });

  const upsertDealHunterDispositionStatement = database.prepare(`
    INSERT INTO deal_hunter_dispositions (
      id, deal_key, submission_id, communication_id, listing_url, deal_name,
      created_at, updated_at, disposition, reason, note, dismissed_at,
      dismissed_by, restored_at, restored_by, created_by, updated_by, metadata
    ) VALUES (
      @id, @deal_key, @submission_id, @communication_id, @listing_url, @deal_name,
      @created_at, @updated_at, @disposition, @reason, @note, @dismissed_at,
      @dismissed_by, @restored_at, @restored_by, @created_by, @updated_by, @metadata
    )
    ON CONFLICT(deal_key) DO UPDATE SET
      submission_id = excluded.submission_id,
      communication_id = excluded.communication_id,
      listing_url = COALESCE(excluded.listing_url, deal_hunter_dispositions.listing_url),
      deal_name = COALESCE(excluded.deal_name, deal_hunter_dispositions.deal_name),
      updated_at = excluded.updated_at,
      disposition = excluded.disposition,
      reason = excluded.reason,
      note = excluded.note,
      dismissed_at = COALESCE(excluded.dismissed_at, deal_hunter_dispositions.dismissed_at),
      dismissed_by = COALESCE(excluded.dismissed_by, deal_hunter_dispositions.dismissed_by),
      restored_at = excluded.restored_at,
      restored_by = excluded.restored_by,
      updated_by = excluded.updated_by,
      metadata = excluded.metadata
  `);

  const submissionUpdateFields = [
    'updated_at',
    'status',
    'spam_score',
    'spam_reasons',
    'delivery_provider',
    'delivery_status',
    'delivery_error',
    'crm_status',
    'crm_error',
    'name',
    'email',
    'phone',
    'company',
    'role',
    'message',
    'status_updated_at',
    'listing_url',
    'business_website',
    'prospectus_url',
    'asking_price',
    'ttm_revenue',
    'ttm_ebitda',
    'ebitda_multiple',
    'net_margin',
    'business_age',
    'sba_eligible',
    'broker_name',
    'broker_email',
    'broker_phone',
    'seller_name',
    'seller_email',
    'seller_phone',
    'metadata',
    'lead_type',
    'priority',
    'tags',
    'assigned_to',
    'notes',
    'follow_up_state',
    'next_action_at',
    'last_contacted_at',
    'deal_hunter_opportunity_id',
    'archived_at',
    'archived_by',
    'archive_reason',
    'archive_note',
    'archive_communication_id',
    'restored_at',
    'restored_by',
  ];
  const submissionJsonFields = ['spam_reasons', 'metadata', 'tags'];

  function updateRecord(tableName, id, values, allowedFields, jsonFields = [], expectedUpdatedAt = '') {
    const updates = Object.entries(values).filter(([key]) => allowedFields.includes(key));

    if (updates.length === 0) {
      return { changes: 0 };
    }

    const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
    const payload = updates.reduce((accumulator, [key, value]) => {
      accumulator[key] = jsonFields.includes(key) ? JSON.stringify(value ?? []) : value;
      return accumulator;
    }, {});

    payload.id = id;
    payload.expected_updated_at = expectedUpdatedAt;
    const versionPredicate = expectedUpdatedAt ? ' AND updated_at = @expected_updated_at' : '';
    return database.prepare(`UPDATE ${tableName} SET ${fields} WHERE id = @id${versionPredicate}`).run(payload);
  }

  function insertCrmActivityEvent(event) {
    assertCrmSubmissionWritableInTransaction(event?.submission_id);
    insertCrmActivityEventStatement.run(serializeCrmActivityEvent(event));
    return normalizeCrmActivityEventRow(serializeCrmActivityEvent(event));
  }

  function linkEmailEventsToCommunication(record) {
    if (!record?.submission_id) return;
    database.prepare(`
      UPDATE email_events SET submission_id = ?, communication_id = ?
      WHERE communication_id = ?
        OR (
          ? IS NOT NULL AND provider = ? AND message_id = ?
        )
    `).run(
      record.submission_id,
      record.id,
      record.id,
      record.provider_message_id,
      record.provider,
      record.provider_message_id,
    );
  }

  function upsertDealHunterDispositionRecord(record) {
    const serialized = serializeDealHunterDisposition(record);
    upsertDealHunterDispositionStatement.run(serialized);
    return normalizeDealHunterDispositionRow(
      database.prepare('SELECT * FROM deal_hunter_dispositions WHERE deal_key = ? LIMIT 1').get(serialized.deal_key),
    );
  }

  const claimCrmCommunicationsPendingIngestionTransaction = database.transaction(({
    dueBefore,
    leaseUntil,
    limit,
    claimedBy,
  }) => {
    const candidates = database.prepare(`
      SELECT id
      FROM crm_communications
      WHERE content_state IN ('pending', 'failed')
        AND content_next_attempt_at IS NOT NULL
        AND content_next_attempt_at <= ?
      ORDER BY content_next_attempt_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(dueBefore, limit);

    if (candidates.length === 0) return [];

    const claimAt = new Date().toISOString();
    const claimStatement = database.prepare(`
      UPDATE crm_communications SET
        content_next_attempt_at = ?,
        updated_at = ?,
        updated_by = ?
      WHERE id = ?
        AND content_state IN ('pending', 'failed')
        AND content_next_attempt_at IS NOT NULL
        AND content_next_attempt_at <= ?
    `);
    const claimedIds = [];
    for (const candidate of candidates) {
      const result = claimStatement.run(leaseUntil, claimAt, claimedBy, candidate.id, dueBefore);
      if (result.changes > 0) claimedIds.push(candidate.id);
    }

    if (claimedIds.length === 0) return [];
    const rowsById = new Map(
      database.prepare(`SELECT * FROM crm_communications WHERE id IN (${placeholders(claimedIds.length)})`)
        .all(...claimedIds)
        .map((row) => [row.id, normalizeCrmCommunicationRow(row)]),
    );
    return claimedIds.map((id) => rowsById.get(id)).filter(Boolean);
  });

  function activeCimClaimForSubmission(submissionId, anchorIso) {
    const parsedAnchor = Date.parse(anchorIso || '');
    const anchor = Number.isFinite(parsedAnchor) ? parsedAnchor : Date.now();
    const initialCutoff = new Date(anchor - 10 * 60 * 1000).toISOString();
    const followUpCutoff = new Date(anchor - 30 * 60 * 1000).toISOString();
    return database.prepare(`
      SELECT *
      FROM deal_hunter_cim_requests
      WHERE submission_id = ?
        AND (
          (status = 'pending' AND updated_at > ?)
          OR (status = 'follow_up_pending' AND updated_at > ?)
        )
      ORDER BY updated_at DESC, id ASC
      LIMIT 1
    `).get(submissionId, initialCutoff, followUpCutoff);
  }

  function assertCrmSubmissionWritableInTransaction(submissionId) {
    const requestedSubmissionId = String(submissionId || '').trim();
    const relation = selectActiveCrmSubmissionSupersessions(database, {
      submissionIds: requestedSubmissionId ? [requestedSubmissionId] : [],
      limit: 1,
    }).find((candidate) => candidate.supersededSubmissionId === requestedSubmissionId);
    if (relation) {
      throw new CrmSubmissionSupersededError({
        submissionId: requestedSubmissionId,
        survivorSubmissionId: relation.survivorSubmissionId,
        opportunityId: relation.opportunityId,
      });
    }
  }

  const mutateWithCrmActivityTransaction = database.transaction(({ operation, payload, activity }) => {
    let record = null;

    if (activity?.submission_id) {
      assertCrmSubmissionWritableInTransaction(activity.submission_id);
    }

    const mutatedSubmissionId = operation === 'update_submission'
      ? payload.id
      : operation === 'archive_submission'
        ? payload.id || payload.submissionId
        : operation === 'dismiss_deal_hunter_opportunity'
          ? payload.submissionId
          : '';
    if (mutatedSubmissionId) {
      assertCrmSubmissionWritableInTransaction(mutatedSubmissionId);
    }

    if (operation === 'insert_submission') {
      const canonicalOpportunityId = payload.submission?.deal_hunter_opportunity_id || '';
      if (canonicalOpportunityId) {
        const opportunity = database.prepare(`
          SELECT status
          FROM deal_hunter_opportunities
          WHERE opportunity_id = ?
          LIMIT 1
        `).get(canonicalOpportunityId);
        if (opportunity?.status !== 'active') {
          throw new Error('A superseded or otherwise non-current opportunity cannot receive a CRM submission.');
        }
      }
      insertSubmissionStatement.run(serializeSubmission(payload.submission));
      record = payload.submission;
    } else if (operation === 'update_submission') {
      if (Object.hasOwn(payload.values || {}, 'deal_hunter_opportunity_id')) {
        throw new Error('Canonical CRM linkage must use the atomic Deal Hunter link primitive.');
      }
      const result = updateRecord(
        'contact_submissions',
        payload.id,
        payload.values || {},
        submissionUpdateFields,
        submissionJsonFields,
        payload.expectedUpdatedAt || '',
      );

      if (result.changes === 0) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(payload.id);
        return { applied: false, record: current ? normalizeSubmissionRow(current) : null, activity: null };
      }

      record = normalizeSubmissionRow(database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(payload.id));
    } else if (operation === 'insert_secure_upload_request') {
      insertSecureUploadRequestStatement.run(serializeUploadRequest(payload.request));
      record = payload.request;
    } else if (operation === 'finalize_secure_document_upload') {
      const values = serializeUploadRequestValues(payload.values || {});
      const allowedFields = [
        'updated_at',
        'status',
        'nda_accepted_at',
        'last_uploaded_at',
        'closed_at',
        'upload_batch_count',
      ];
      const updates = Object.entries(values).filter(([key]) => allowedFields.includes(key));

      if (updates.length === 0) {
        throw new Error('Secure upload finalization did not include request updates.');
      }

      const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
      const parameters = Object.fromEntries(updates);
      parameters.id = payload.requestId;
      const result = database
        .prepare(`UPDATE secure_upload_requests SET ${fields} WHERE id = @id AND status = 'uploading'`)
        .run(parameters);

      if (result.changes === 0) {
        const current = database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(payload.requestId);
        return { applied: false, record: normalizeUploadRequestRow(current), activity: null };
      }

      for (const document of payload.documents || []) {
        insertSecureDocumentStatement.run(document);
      }

      record = normalizeUploadRequestRow(
        database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(payload.requestId),
      );
    } else if (operation === 'update_secure_upload_request') {
      const values = serializeUploadRequestValues(payload.values || {});
      const allowedFields = [
        'updated_at',
        'status',
        'expires_at',
        'nda_required',
        'nda_accepted_at',
        'last_uploaded_at',
        'note',
        'requested_documents',
        'revoked_at',
        'closed_at',
        'upload_batch_count',
      ];
      const updates = Object.entries(values).filter(([key]) => allowedFields.includes(key));

      if (updates.length === 0) {
        throw new Error('Secure upload request mutation did not include updates.');
      }

      const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
      const parameters = Object.fromEntries(updates);
      parameters.id = payload.id;
      const expectedStatuses = normalizeList(payload.expectedStatuses, 10);
      const statusPredicate = expectedStatuses.length > 0
        ? ` AND status IN (${expectedStatuses.map((_, index) => `@expected_status_${index}`).join(', ')})`
        : '';
      expectedStatuses.forEach((status, index) => {
        parameters[`expected_status_${index}`] = status;
      });
      const result = database
        .prepare(`UPDATE secure_upload_requests SET ${fields} WHERE id = @id${statusPredicate}`)
        .run(parameters);

      if (result.changes === 0) {
        const current = database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(payload.id);
        return { applied: false, record: normalizeUploadRequestRow(current), activity: null };
      }

      record = normalizeUploadRequestRow(database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(payload.id));
    } else if (operation === 'delete_secure_document') {
      const existing = database.prepare('SELECT * FROM secure_documents WHERE id = ?').get(payload.id);

      if (!existing) {
        return { applied: false, record: null, activity: null };
      }

      deleteSecureDocumentStatement.run(payload.id);
      record = existing;
    } else if (operation === 'insert_email_event') {
      const result = insertEmailEventStatement.run(serializeEmailEvent(payload.event));

      if (result.changes === 0) {
        const existing = payload.event.event_key ? getEmailEventByKeyStatement.get(payload.event.event_key) : null;
        return { applied: false, record: normalizeEmailEventRow(existing), activity: null };
      }

      record = payload.event;
    } else if (operation === 'insert_crm_communication') {
      const communication = serializeCrmCommunication(payload.communication || {});
      const result = insertCrmCommunicationStatement.run(communication);

      if (result.changes === 0) {
        return { applied: false, record: getExistingCrmCommunication(communication), activity: null };
      }

      record = normalizeCrmCommunicationRow(
        database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(communication.id),
      );
      linkEmailEventsToCommunication(record);
    } else if (operation === 'assign_crm_communication') {
      const assignedAt = payload.updatedAt || new Date().toISOString();
      const assignmentMetadata = Object.hasOwn(payload, 'metadata')
        ? JSON.stringify(payload.metadata || {})
        : null;
      const result = database.prepare(`
        UPDATE crm_communications SET
          submission_id = ?,
          deal_key = COALESCE(?, deal_key),
          cim_request_id = COALESCE(?, cim_request_id),
          assigned_at = ?,
          assigned_by = ?,
          updated_at = ?,
          updated_by = ?,
          metadata = COALESCE(?, metadata)
        WHERE id = ? AND submission_id IS NULL
      `).run(
        payload.submissionId,
        payload.dealKey || null,
        payload.cimRequestId || null,
        assignedAt,
        payload.assignedBy || 'system',
        assignedAt,
        payload.assignedBy || 'system',
        assignmentMetadata,
        payload.id,
      );

      if (result.changes === 0) {
        const current = database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(payload.id);
        return { applied: false, record: normalizeCrmCommunicationRow(current), activity: null };
      }

      record = normalizeCrmCommunicationRow(
        database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(payload.id),
      );
      linkEmailEventsToCommunication(record);
    } else if (operation === 'archive_submission') {
      const submissionId = payload.id || payload.submissionId;
      if (!payload.expectedUpdatedAt) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);
        return {
          applied: false,
          reason: 'missing-expected-version',
          record: current ? normalizeSubmissionRow(current) : null,
          activity: null,
        };
      }
      const values = {
        ...(payload.values || {}),
        status: 'archived',
        follow_up_state: 'completed',
        next_action_at: null,
      };
      const activeClaim = activeCimClaimForSubmission(submissionId, values.updated_at);

      if (activeClaim) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);
        return {
          applied: false,
          reason: 'cim-send-in-progress',
          record: current ? normalizeSubmissionRow(current) : null,
          activity: null,
        };
      }

      const result = updateRecord(
        'contact_submissions',
        submissionId,
        values,
        submissionUpdateFields,
        submissionJsonFields,
        payload.expectedUpdatedAt || '',
      );

      if (result.changes === 0) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);
        return { applied: false, record: current ? normalizeSubmissionRow(current) : null, activity: null };
      }

      const stoppedAt = values.updated_at || new Date().toISOString();
      database.prepare(`
        UPDATE deal_hunter_cim_requests SET
          request_state = CASE WHEN request_state = 'responded' THEN request_state ELSE 'stopped' END,
          follow_up_state = CASE WHEN request_state = 'responded' THEN 'completed' ELSE 'stopped' END,
          next_follow_up_at = NULL,
          updated_at = ?,
          last_activity_at = ?
        WHERE submission_id = ?
      `).run(stoppedAt, stoppedAt, submissionId);
      record = normalizeSubmissionRow(database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId));
    } else if (operation === 'dismiss_deal_hunter_opportunity') {
      const submissionId = payload.submissionId;
      if (!payload.expectedUpdatedAt) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);
        return {
          applied: false,
          reason: 'missing-expected-version',
          record: { submission: current ? normalizeSubmissionRow(current) : null, disposition: null },
          activity: null,
        };
      }
      const values = {
        ...(payload.values || {}),
        status: 'archived',
        follow_up_state: 'completed',
        next_action_at: null,
      };
      const activeClaim = activeCimClaimForSubmission(submissionId, values.updated_at);

      if (activeClaim) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);
        return {
          applied: false,
          reason: 'cim-send-in-progress',
          record: {
            submission: current ? normalizeSubmissionRow(current) : null,
            disposition: null,
          },
          activity: null,
        };
      }

      const result = updateRecord(
        'contact_submissions',
        submissionId,
        values,
        submissionUpdateFields,
        submissionJsonFields,
        payload.expectedUpdatedAt || '',
      );

      if (result.changes === 0) {
        const current = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);
        return {
          applied: false,
          record: { submission: current ? normalizeSubmissionRow(current) : null, disposition: null },
          activity: null,
        };
      }

      const stoppedAt = values.updated_at || new Date().toISOString();
      database.prepare(`
        UPDATE deal_hunter_cim_requests SET
          request_state = CASE WHEN request_state = 'responded' THEN request_state ELSE 'stopped' END,
          follow_up_state = CASE WHEN request_state = 'responded' THEN 'completed' ELSE 'stopped' END,
          next_follow_up_at = NULL,
          updated_at = ?,
          last_activity_at = ?
        WHERE submission_id = ?
      `).run(stoppedAt, stoppedAt, submissionId);
      const disposition = upsertDealHunterDispositionRecord({
        ...(payload.disposition || {}),
        submission_id: submissionId,
      });
      record = {
        submission: normalizeSubmissionRow(database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId)),
        disposition,
      };
    } else if (operation === 'finalize_deal_hunter_cim_request_claim') {
      const request = serializeDealHunterCimRequest(payload.request);
      const current = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(request.id);
      const expectedStatuses = normalizeList(payload.expectedStatuses, 10);
      const submissionId = request.submission_id || current?.submission_id || '';
      const submission = submissionId
        ? database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(submissionId)
        : null;
      const claimMatches = Boolean(
        current
          && payload.expectedUpdatedAt
          && current.updated_at === payload.expectedUpdatedAt
          && (expectedStatuses.length === 0 || expectedStatuses.includes(current.status))
          && current.deal_key === request.deal_key
          && String(current.recipient_email || '').toLowerCase() === request.recipient_email
          && submission
          && submission.status !== 'archived',
      );

      if (!claimMatches) {
        return {
          applied: false,
          reason: submission?.status === 'archived' ? 'submission-archived' : 'claim-ineligible',
          record: normalizeDealHunterCimRequestRow(current),
          activity: null,
        };
      }

      runDealHunterCimRequestUpsert({ ...request, submission_id: submissionId });
      record = normalizeDealHunterCimRequestRow(
        database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(request.id),
      );
    } else if (operation === 'upsert_deal_hunter_cim_request') {
      let request = serializeDealHunterCimRequest(payload.request);
      const current = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(request.id);
      const submissionId = request.submission_id || current?.submission_id || '';
      const submission = submissionId
        ? database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(submissionId)
        : null;
      const preserveStoppedOutreach = payload.preserveStoppedOutreach === true;
      const currentRequest = normalizeDealHunterCimRequestRow(current);

      if (preserveStoppedOutreach && currentRequest) {
        const responded = currentRequest.request_state === 'responded';
        const stopped = submission?.status === 'archived'
          || currentRequest.request_state === 'stopped'
          || currentRequest.follow_up_state === 'stopped';
        if (responded || stopped) {
          request = serializeDealHunterCimRequest({
            ...request,
            status: responded ? 'responded' : currentRequest.status,
            request_state: responded ? 'responded' : 'stopped',
            follow_up_state: responded
              ? ['stopped', 'completed'].includes(currentRequest.follow_up_state)
                ? currentRequest.follow_up_state
                : 'completed'
              : 'stopped',
            next_follow_up_at: null,
          });
        }
      }
      const archivedResponse = Boolean(
        submission?.status === 'archived'
          && (
            (request.status === 'responded' && request.request_state === 'responded')
            || (preserveStoppedOutreach && request.request_state === 'stopped')
          )
          && ['stopped', 'completed'].includes(request.follow_up_state)
          && !request.next_follow_up_at,
      );

      if (submissionId && (!submission || (submission.status === 'archived' && !archivedResponse))) {
        return {
          applied: false,
          reason: submission?.status === 'archived' ? 'submission-archived' : 'submission-missing',
          record: normalizeDealHunterCimRequestRow(current),
          activity: null,
        };
      }

      runDealHunterCimRequestUpsert(request);
      record = normalizeDealHunterCimRequestRow(
        database
          .prepare('SELECT * FROM deal_hunter_cim_requests WHERE deal_key = ? AND LOWER(recipient_email) = ? LIMIT 1')
          .get(request.deal_key, request.recipient_email),
      );
    } else {
      throw new Error(`Unsupported atomic CRM activity operation: ${operation || 'unknown'}.`);
    }

    if (
      ['upsert_deal_hunter_cim_request', 'finalize_deal_hunter_cim_request_claim'].includes(operation)
      && record?.submission_id
    ) {
      database.prepare(`
        UPDATE crm_follow_up_recommendations
        SET status = 'superseded', superseded_at = ?
        WHERE submission_id = ? AND status = 'current'
      `).run(activity.created_at || record.updated_at || new Date().toISOString(), record.submission_id);
    }

    const storedActivity = insertCrmActivityEvent(activity);
    return { applied: true, record, activity: storedActivity };
  });

  return {
    provider: 'sqlite',

    async listActiveCrmSubmissionSupersessions(filters = {}) {
      return selectActiveCrmSubmissionSupersessions(database, filters);
    },

    async getCrmSubmissionSupersessionContext(submissionId) {
      const requestedSubmissionId = String(submissionId || '').trim();
      const relations = selectActiveCrmSubmissionSupersessions(database, {
        submissionIds: requestedSubmissionId ? [requestedSubmissionId] : [],
      });
      const supersededRelation = relations.find(
        (relation) => relation.supersededSubmissionId === requestedSubmissionId,
      ) || null;
      if (supersededRelation) {
        return {
          requestedSubmissionId,
          canonicalSubmissionId: supersededRelation.survivorSubmissionId,
          opportunityId: supersededRelation.opportunityId,
          isSuperseded: true,
          relation: supersededRelation,
          supersededSubmissions: [],
          historySubmissionIds: [
            supersededRelation.survivorSubmissionId,
            supersededRelation.supersededSubmissionId,
          ],
        };
      }
      const survivorRelations = relations.filter(
        (relation) => relation.survivorSubmissionId === requestedSubmissionId,
      );
      return {
        requestedSubmissionId,
        canonicalSubmissionId: requestedSubmissionId,
        opportunityId: survivorRelations[0]?.opportunityId || null,
        isSuperseded: false,
        relation: null,
        supersededSubmissions: survivorRelations,
        historySubmissionIds: [
          requestedSubmissionId,
          ...survivorRelations.map((relation) => relation.supersededSubmissionId),
        ],
      };
    },

    async assertCrmSubmissionWritable(submissionId) {
      assertCrmSubmissionWritableInTransaction(submissionId);
      return this.getCrmSubmissionSupersessionContext(submissionId);
    },

    async auditCrmSubmissionSupersessions() {
      const rawRows = database.prepare(`
        SELECT * FROM crm_submission_supersessions
        ORDER BY opportunity_id ASC, survivor_submission_id ASC,
          superseded_submission_id ASC, id ASC
        LIMIT ?
      `).all(crmSubmissionSupersessionMaximumRows + 1);
      const violations = [];
      if (rawRows.length > crmSubmissionSupersessionMaximumRows) {
        violations.push({ code: 'supersession-audit-bound-exceeded' });
      }
      const activeRoles = new Map();
      for (const rawRow of rawRows.slice(0, crmSubmissionSupersessionMaximumRows)) {
        const relation = normalizeCrmSubmissionSupersessionRow(rawRow);
        const survivor = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(
          relation.survivorSubmissionId,
        );
        const superseded = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(
          relation.supersededSubmissionId,
        );
        const opportunity = database.prepare(
          'SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?',
        ).get(relation.opportunityId);
        const receipt = database.prepare(
          'SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ?',
        ).get(relation.repairManifestId);
        if (!survivor) violations.push({ code: 'survivor-missing', relationId: relation.id });
        if (!superseded) violations.push({ code: 'superseded-missing', relationId: relation.id });
        if (
          !receipt
          || receipt.mode !== 'crm-duplicate-consolidation'
          || receipt.status !== 'applied'
          || receipt.checksum !== relation.repairDigest
        ) violations.push({ code: 'repair-receipt-invalid', relationId: relation.id });
        if (relation.status === 'active') {
          if (
            !opportunity
            || opportunity.status !== 'active'
            || opportunity.primary_submission_id !== relation.survivorSubmissionId
          ) violations.push({ code: 'opportunity-authority-invalid', relationId: relation.id });
          const survivorRow = survivor ? normalizeSubmissionRow(survivor) : null;
          const supersededRow = superseded ? normalizeSubmissionRow(superseded) : null;
          const survivorDirectOwner = String(survivorRow?.deal_hunter_opportunity_id || '').trim();
          const survivorMetadataOwner = crmSubmissionMetadataOwner(survivorRow);
          const supersededDirectOwner = String(supersededRow?.deal_hunter_opportunity_id || '').trim();
          const supersededMetadataOwner = crmSubmissionMetadataOwner(supersededRow);
          if (
            ![survivorDirectOwner, survivorMetadataOwner].includes(relation.opportunityId)
            || [survivorDirectOwner, survivorMetadataOwner].some(
              (owner) => owner && owner !== relation.opportunityId,
            )
          ) violations.push({ code: 'survivor-owner-invalid', relationId: relation.id });
          if ([supersededDirectOwner, supersededMetadataOwner].some(
            (owner) => owner && owner !== relation.opportunityId,
          )) violations.push({ code: 'superseded-owner-invalid', relationId: relation.id });
          const supersededIsPrimary = database.prepare(`
            SELECT 1 FROM deal_hunter_opportunities
            WHERE primary_submission_id = ? LIMIT 1
          `).get(relation.supersededSubmissionId);
          if (supersededIsPrimary) {
            violations.push({ code: 'superseded-is-primary', relationId: relation.id });
          }
          if (
            activeRoles.get(relation.survivorSubmissionId) === 'superseded'
            || activeRoles.has(relation.supersededSubmissionId)
          ) {
            violations.push({ code: 'active-role-conflict', relationId: relation.id });
          }
          if (!activeRoles.has(relation.survivorSubmissionId)) {
            activeRoles.set(relation.survivorSubmissionId, 'survivor');
          }
          activeRoles.set(relation.supersededSubmissionId, 'superseded');
        } else {
          const reversalReceipt = database.prepare(`
            SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ?
          `).get(relation.reversalManifestId);
          if (!crmSubmissionReversalReceiptMatches(relation, reversalReceipt)) {
            violations.push({ code: 'reversal-receipt-invalid', relationId: relation.id });
          }
        }
      }
      return { ok: violations.length === 0, violationCount: violations.length, violations };
    },

    async createApplicationBackup(destination) {
      await database.backup(destination);
      return destination;
    },

    close() {
      database.close();
    },

    async checkHealth() {
      database.prepare('SELECT 1 AS ok').get();
      return { ok: true };
    },

    async mutateWithCrmActivity(mutation) {
      return mutateWithCrmActivityTransaction.immediate(mutation);
    },

    async insertSubmission(submission) {
      insertSubmissionStatement.run(serializeSubmission(submission));
      return submission;
    },

    async updateSubmission(id, values) {
      const transaction = database.transaction(() => {
        assertCrmSubmissionWritableInTransaction(id);
        updateRecord(
          'contact_submissions',
          id,
          values,
          submissionUpdateFields,
          submissionJsonFields,
        );
        const row = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(id);
        return row ? normalizeSubmissionRow(row) : null;
      });
      return transaction.immediate();
    },

    async updateSubmissionIfCurrent(id, expectedUpdatedAt, values) {
      const transaction = database.transaction(() => {
        assertCrmSubmissionWritableInTransaction(id);
        const result = updateRecord(
          'contact_submissions',
          id,
          values,
          submissionUpdateFields,
          submissionJsonFields,
          expectedUpdatedAt,
        );
        if (result.changes === 0) return null;
        const row = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(id);
        return row ? normalizeSubmissionRow(row) : null;
      });
      return transaction.immediate();
    },

    async getSubmission(id) {
      const row = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(id);
      return row ? normalizeSubmissionRow(row) : null;
    },

    // Every Deal Hunter integrity check concerns a record that carries a
    // canonical link, a managed marker, or the daily-review source. Reading only
    // those avoids paging the entire CRM through JSON parsing on every audit.
    // The direct column is uniquely indexed; the metadata predicates also cover
    // records linked before that column existed, so nothing is missed.
    async listDealHunterLinkedSubmissions({ limit = 100000 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100000, 1000000));
      return database.prepare(`
        SELECT * FROM contact_submissions
        WHERE (deal_hunter_opportunity_id IS NOT NULL AND deal_hunter_opportunity_id <> '')
           OR source = 'deal-hunter-daily-review'
           OR COALESCE(json_extract(metadata, '$.dealHunter.opportunityId'), '') <> ''
           OR json_extract(metadata, '$.dealHunter.managed') IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
      `).all(safeLimit).map(normalizeSubmissionRow);
    },

    async listSubmissionsByIds(ids = [], { limit = 100000 } = {}) {
      const safeIds = normalizeList(ids, 100000).slice(0, Math.max(1, Math.min(Number(limit) || 100000, 1000000)));
      if (safeIds.length === 0) return [];
      const rows = [];
      // SQLite bounds host parameters per statement, so read in batches.
      for (let index = 0; index < safeIds.length; index += 500) {
        const batch = safeIds.slice(index, index + 500);
        rows.push(...database.prepare(
          `SELECT * FROM contact_submissions WHERE id IN (${batch.map(() => '?').join(', ')})`,
        ).all(...batch));
      }
      return rows.map(normalizeSubmissionRow);
    },

    async getSubmissionStrict(id) {
      const row = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(id);
      return row ? normalizeSubmissionRow(row) : null;
    },

    async deleteSubmission(id, { deletedAt = '' } = {}) {
      const transaction = database.transaction((submissionId, requestedDeletedAt) => {
        assertCrmSubmissionWritableInTransaction(submissionId);
        const existingRow = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(submissionId);

        if (!existingRow) {
          return null;
        }

        const effectiveDeletedAt = requestedDeletedAt || new Date().toISOString();
        if (activeCimClaimForSubmission(submissionId, effectiveDeletedAt)) {
          const error = new Error('CIM transmission is in progress; CRM deletion is blocked until its claim lease expires.');
          error.code = 'CIM_SEND_IN_PROGRESS';
          error.status = 409;
          throw error;
        }

        database.prepare('DELETE FROM secure_documents WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM secure_upload_requests WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM email_events WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM crm_communications WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM crm_activity_events WHERE submission_id = ?').run(submissionId);
        database
          .prepare("UPDATE deal_hunter_crm_imports SET submission_id = NULL, status = 'crm-deleted', updated_at = ? WHERE submission_id = ?")
          .run(effectiveDeletedAt, submissionId);
        database.prepare(`
          UPDATE deal_hunter_cim_requests SET
            submission_id = NULL,
            request_state = CASE WHEN request_state = 'responded' THEN request_state ELSE 'stopped' END,
            follow_up_state = CASE WHEN request_state = 'responded' THEN 'completed' ELSE 'stopped' END,
            next_follow_up_at = NULL,
            updated_at = ?,
            last_activity_at = ?
          WHERE submission_id = ?
        `).run(effectiveDeletedAt, effectiveDeletedAt, submissionId);
        database
          .prepare('UPDATE deal_hunter_dispositions SET submission_id = NULL, updated_at = ? WHERE submission_id = ?')
          .run(effectiveDeletedAt, submissionId);
        database.prepare('DELETE FROM contact_submissions WHERE id = ?').run(submissionId);
        return normalizeSubmissionRow(existingRow);
      });

      return transaction.immediate(id, deletedAt || '');
    },

    async getSubmissionByContactEmail(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();

      if (!normalizedEmail) {
        return null;
      }

      const row = database
        .prepare(
          `
            SELECT * FROM contact_submissions
            WHERE LOWER(email) = ?
              OR LOWER(COALESCE(broker_email, '')) = ?
              OR LOWER(COALESCE(seller_email, '')) = ?
            ORDER BY created_at DESC
            LIMIT 1
          `,
        )
        .get(normalizedEmail, normalizedEmail, normalizedEmail);

      return row ? normalizeSubmissionRow(row) : null;
    },

    async listSubmissionsByContactEmail(email, { limit = 25, openOnly = false } = {}) {
      const normalizedEmail = String(email || '').trim().toLowerCase();

      if (!normalizedEmail) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 250));
      const openPredicate = openOnly ? "AND LOWER(COALESCE(status, '')) NOT IN ('archived', 'spam')" : '';
      return database
        .prepare(
          `
            SELECT * FROM contact_submissions
            WHERE (
              LOWER(email) = ?
              OR LOWER(COALESCE(broker_email, '')) = ?
              OR LOWER(COALESCE(seller_email, '')) = ?
            )
            ${openPredicate}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `,
        )
        .all(normalizedEmail, normalizedEmail, normalizedEmail, safeLimit)
        .map(normalizeSubmissionRow);
    },

    async getSubmissionByBusinessWebsite(websiteUrl) {
      const normalizedUrl = String(websiteUrl || '').trim().toLowerCase();
      const websiteIdentity = canonicalWebsiteIdentity(websiteUrl);

      if (!normalizedUrl || !websiteIdentity) {
        return null;
      }

      const row = database
        .prepare(
          `
            SELECT * FROM contact_submissions
            WHERE LOWER(COALESCE(business_website, '')) = ?
            ORDER BY created_at DESC
            LIMIT 1
          `,
        )
        .get(normalizedUrl);

      if (row) {
        return normalizeSubmissionRow(row);
      }

      const rows = database
        .prepare(
          `
            SELECT * FROM contact_submissions
            WHERE TRIM(COALESCE(business_website, '')) <> ''
            ORDER BY created_at DESC
            LIMIT 10000
          `,
        )
        .all();
      const matchedRow = rows.find((candidate) => canonicalWebsiteIdentity(candidate.business_website) === websiteIdentity);

      return matchedRow ? normalizeSubmissionRow(matchedRow) : null;
    },

    async getSubmissionByListingUrl(listingUrl) {
      const normalizedUrl = String(listingUrl || '').trim().toLowerCase();
      const listingIdentity = canonicalListingIdentity(listingUrl);

      if (!normalizedUrl || !listingIdentity) {
        return null;
      }

      const row = database
        .prepare(
          `
            SELECT * FROM contact_submissions
            WHERE LOWER(COALESCE(listing_url, '')) = ?
            ORDER BY created_at DESC
            LIMIT 1
          `,
        )
        .get(normalizedUrl);

      if (row) {
        return normalizeSubmissionRow(row);
      }

      const rows = database
        .prepare(
          `
            SELECT * FROM contact_submissions
            WHERE TRIM(COALESCE(listing_url, '')) <> ''
            ORDER BY created_at DESC
            LIMIT 10000
          `,
        )
        .all();
      const matchedRow = rows.find((candidate) => canonicalListingIdentity(candidate.listing_url) === listingIdentity);

      return matchedRow ? normalizeSubmissionRow(matchedRow) : null;
    },

    async readDealHunterCrmMatchAuthority({
      limit = dealHunterCrmMatchAuthorityMaximumRows,
      supersessionLimit = crmSubmissionSupersessionMaximumRows,
    } = {}) {
      const read = database.transaction(() => dealHunterCrmMatchAuthoritySnapshot(database, {
        limit,
        supersessionLimit,
      }));
      const snapshot = read.deferred();
      return {
        rows: snapshot.rows,
        supersessions: snapshot.supersessions,
        count: snapshot.count,
        submissionCount: snapshot.submissionCount,
        supersessionCount: snapshot.supersessionCount,
        complete: snapshot.complete,
        revision: snapshot.revision,
        revisionVersion: snapshot.revisionVersion,
      };
    },

    async listSubmissions({ limit = 50, page = 1, search = '', status = 'all', createdAfter = '', sort = 'created_at', direction = 'desc' } = {}) {
      const clauses = [activeCrmSubmissionPredicate('submissions')];
      const params = [];

      if (status && status !== 'all') {
        clauses.push('status = ?');
        params.push(status);
      }

      if (createdAfter) {
        clauses.push('created_at >= ?');
        params.push(createdAfter);
      }

      if (search) {
        clauses.push(`
          INSTR(LOWER(
            COALESCE(name, '') || ' ' ||
            COALESCE(email, '') || ' ' ||
            COALESCE(company, '') || ' ' ||
            COALESCE(message, '') || ' ' ||
            COALESCE(notes, '') || ' ' ||
            COALESCE(listing_url, '') || ' ' ||
            COALESCE(business_website, '') || ' ' ||
            COALESCE(prospectus_url, '') || ' ' ||
            COALESCE(broker_name, '') || ' ' ||
            COALESCE(broker_email, '') || ' ' ||
            COALESCE(seller_name, '') || ' ' ||
            COALESCE(seller_email, '')
          ), ?) > 0
        `);
        params.push(String(search).toLowerCase());
      }

      const whereClause = `WHERE ${clauses.join(' AND ')}`;
      const requestedLimit = Number(limit);
      const requestedPage = Number(page);
      const safeLimit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(Math.trunc(requestedLimit), 5000))
        : 50;
      const safePage = Number.isFinite(requestedPage)
        ? Math.max(1, Math.min(Math.trunc(requestedPage), 1_000_000))
        : 1;
      const offset = (safePage - 1) * safeLimit;
      const sortExpressions = {
        created_at: 'created_at',
        updated_at: 'updated_at',
        company: "LOWER(COALESCE(company, name, ''))",
        next_action_at: "CASE WHEN next_action_at IS NULL OR next_action_at = '' THEN 1 ELSE 0 END, next_action_at",
        priority: "CASE priority WHEN 'urgent' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END",
        deal_score: "CASE WHEN json_extract(metadata, '$.dealHunter.score') IS NULL THEN 1 ELSE 0 END ASC, CAST(json_extract(metadata, '$.dealHunter.score') AS REAL)",
        listing_date: "CASE WHEN COALESCE(NULLIF(json_extract(metadata, '$.dealHunter.dateAdded'), ''), NULLIF(json_extract(metadata, '$.dealHunter.firstSeenAt'), '')) IS NULL THEN 1 ELSE 0 END ASC, COALESCE(NULLIF(json_extract(metadata, '$.dealHunter.dateAdded'), ''), NULLIF(json_extract(metadata, '$.dealHunter.firstSeenAt'), ''))",
        status: 'status',
      };
      const sortExpression = sortExpressions[sort] || sortExpressions.created_at;
      const sortDirection = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const rows = database
        .prepare(
          `
            SELECT submissions.* FROM contact_submissions AS submissions
            ${whereClause}
            ORDER BY ${sortExpression} ${sortDirection}, created_at DESC, id ASC
            LIMIT ?
            OFFSET ?
          `,
        )
        .all(...params, safeLimit, offset)
        .map(normalizeSubmissionRow);

      // List and count remain separate SQLite statements. Both independently
      // carry the same active-row predicate so pagination cannot count losers.
      const totalRow = database.prepare(`
        SELECT COUNT(*) AS count FROM contact_submissions AS submissions ${whereClause}
      `).get(...params);

      return {
        rows,
        total: totalRow?.count || 0,
      };
    },

    async listHistoricalSubmissionsForAdminExport() {
      return database.prepare(`
        SELECT *
        FROM contact_submissions
        ORDER BY created_at DESC, id ASC
        LIMIT 5000
      `).all().map(normalizeSubmissionRow);
    },

    async listFollowUpSubmissions({
      page = 1, pageSize = 25, search = '', view = 'crm-actions', sort = 'urgency', direction = 'desc',
      now = '', todayStart = '', todayEnd = '',
    } = {}) {
      const safePage = normalizePage(page);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const normalizeTimestamp = (value, fallback) => Number.isFinite(Date.parse(value || ''))
        ? new Date(value).toISOString()
        : fallback;
      const safeNow = normalizeTimestamp(now, new Date().toISOString());
      const safeTodayStart = normalizeTimestamp(todayStart, safeNow);
      const safeTodayEnd = normalizeTimestamp(todayEnd, safeNow);
      const allowedViews = new Set([
        'crm-actions', 'email-triage', 'due-today', 'overdue', 'awaiting-reply', 'inbound-reply',
        'delivery-problem', 'manual-review', 'completed', 'all',
      ]);
      const requestedView = normalizeList([view], 1)[0] || 'crm-actions';
      const safeView = allowedViews.has(requestedView) ? requestedView : 'crm-actions';
      const clauses = [
        activeCrmSubmissionPredicate('submission'),
        "submission.status NOT IN ('archived', 'spam')",
      ];
      const params = [];
      const latestDirection = `(SELECT communication.direction FROM crm_communications AS communication
        WHERE communication.submission_id = submission.id
        ORDER BY communication.occurred_at DESC, communication.id DESC LIMIT 1)`;
      const latestDeliveryState = `(SELECT communication.delivery_state FROM crm_communications AS communication
        WHERE communication.submission_id = submission.id AND communication.direction = 'outbound'
        ORDER BY communication.occurred_at DESC, communication.id DESC LIMIT 1)`;
      const currentRecommendationAction = `(SELECT recommendation.action_type FROM crm_follow_up_recommendations AS recommendation
        WHERE recommendation.submission_id = submission.id AND recommendation.status = 'current'
          AND (recommendation.expires_at IS NULL OR recommendation.expires_at > '${safeNow.replaceAll("'", "''")}')
        ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1)`;

      if (safeView === 'completed') {
        clauses.push("submission.follow_up_state = 'completed'");
      } else if (safeView === 'due-today') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push('submission.next_action_at >= ? AND submission.next_action_at < ?');
        params.push(safeTodayStart, safeTodayEnd);
      } else if (safeView === 'overdue') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push('submission.next_action_at IS NOT NULL AND submission.next_action_at < ?');
        params.push(safeTodayStart);
      } else if (safeView === 'awaiting-reply') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push(`(submission.follow_up_state = 'waiting-on-owner' OR ${latestDirection} = 'outbound')`);
      } else if (safeView === 'inbound-reply') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push(`${latestDirection} = 'inbound'`);
      } else if (safeView === 'delivery-problem') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push(`${latestDeliveryState} IN ('delayed', 'bounced', 'failed', 'complained', 'suppressed')`);
      } else if (safeView === 'manual-review') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push(`${currentRecommendationAction} = 'manual_review'`);
      } else if (safeView === 'email-triage') {
        clauses.push("submission.follow_up_state <> 'completed'");
        clauses.push(`(${latestDirection} = 'inbound' OR ${latestDeliveryState} IN ('delayed', 'bounced', 'failed', 'complained', 'suppressed'))`);
      } else if (safeView === 'crm-actions') {
        clauses.push("submission.follow_up_state <> 'completed'");
      }

      const normalizedSearch = String(search || '').trim().toLowerCase();
      if (normalizedSearch) {
        clauses.push(`(
          INSTR(LOWER(COALESCE(submission.company, '') || ' ' || COALESCE(submission.name, '') || ' ' ||
            COALESCE(submission.email, '') || ' ' || COALESCE(submission.broker_name, '') || ' ' ||
            COALESCE(submission.broker_email, '') || ' ' || COALESCE(submission.seller_name, '') || ' ' ||
            COALESCE(submission.seller_email, '') || ' ' || COALESCE(submission.listing_url, '')), ?) > 0
          OR EXISTS (
            SELECT 1 FROM crm_communications AS communication
            WHERE communication.submission_id = submission.id
              AND INSTR(LOWER(COALESCE(communication.subject, '') || ' ' || COALESCE(communication.deal_key, '')), ?) > 0
          )
        )`);
        params.push(normalizedSearch, normalizedSearch);
      }

      const whereClause = `WHERE ${clauses.join(' AND ')}`;
      const safeDirection = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const sortExpressions = {
        urgency: `CASE
          WHEN ${latestDeliveryState} IN ('bounced', 'failed', 'complained', 'suppressed') THEN 4
          WHEN ${latestDirection} = 'inbound' THEN 3
          WHEN submission.next_action_at IS NOT NULL AND submission.next_action_at < '${safeNow.replaceAll("'", "''")}' THEN 2
          ELSE 1 END DESC,
          COALESCE((SELECT recommendation.priority_score FROM crm_follow_up_recommendations AS recommendation
            WHERE recommendation.submission_id = submission.id AND recommendation.status = 'current'
              AND (recommendation.expires_at IS NULL OR recommendation.expires_at > '${safeNow.replaceAll("'", "''")}')
            ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1), 0) DESC,
          CASE WHEN submission.next_action_at IS NULL THEN 1 ELSE 0 END ASC, submission.next_action_at ASC`,
        next_action_at: 'CASE WHEN submission.next_action_at IS NULL THEN 1 ELSE 0 END ASC, submission.next_action_at',
        updated_at: 'submission.updated_at',
        company: "LOWER(COALESCE(submission.company, submission.name, ''))",
        priority: "CASE submission.priority WHEN 'urgent' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END",
        created_at: 'submission.created_at',
      };
      const sortExpression = sortExpressions[sort] || sortExpressions.urgency;
      const directionSuffix = sort === 'urgency' || !sortExpressions[sort] ? '' : ` ${safeDirection}`;
      const total = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM contact_submissions AS submission ${whereClause}
      `).get(...params)?.count || 0);
      const offset = (safePage - 1) * safePageSize;
      const rows = database.prepare(`
        SELECT submission.*,
          (SELECT communication.subject FROM crm_communications AS communication
            WHERE communication.submission_id = submission.id
            ORDER BY communication.occurred_at DESC, communication.id DESC LIMIT 1) AS follow_up_latest_subject,
          ${latestDirection} AS follow_up_latest_direction,
          ${latestDeliveryState} AS follow_up_latest_delivery_state,
          (SELECT communication.occurred_at FROM crm_communications AS communication
            WHERE communication.submission_id = submission.id
            ORDER BY communication.occurred_at DESC, communication.id DESC LIMIT 1) AS follow_up_latest_communication_at,
          (SELECT communication.deal_key FROM crm_communications AS communication
            WHERE communication.submission_id = submission.id AND communication.deal_key IS NOT NULL
            ORDER BY communication.occurred_at DESC, communication.id DESC LIMIT 1) AS follow_up_deal_key,
          (SELECT recommendation.id FROM crm_follow_up_recommendations AS recommendation
            WHERE recommendation.submission_id = submission.id AND recommendation.status = 'current'
              AND (recommendation.expires_at IS NULL OR recommendation.expires_at > '${safeNow.replaceAll("'", "''")}')
            ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1) AS follow_up_recommendation_id,
          ${currentRecommendationAction} AS follow_up_recommendation_action,
          (SELECT recommendation.conversation_state FROM crm_follow_up_recommendations AS recommendation
            WHERE recommendation.submission_id = submission.id AND recommendation.status = 'current'
              AND (recommendation.expires_at IS NULL OR recommendation.expires_at > '${safeNow.replaceAll("'", "''")}')
            ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1) AS follow_up_conversation_state,
          (SELECT recommendation.priority_score FROM crm_follow_up_recommendations AS recommendation
            WHERE recommendation.submission_id = submission.id AND recommendation.status = 'current'
              AND (recommendation.expires_at IS NULL OR recommendation.expires_at > '${safeNow.replaceAll("'", "''")}')
            ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1) AS follow_up_priority_score,
          (SELECT recommendation.confidence FROM crm_follow_up_recommendations AS recommendation
            WHERE recommendation.submission_id = submission.id AND recommendation.status = 'current'
              AND (recommendation.expires_at IS NULL OR recommendation.expires_at > '${safeNow.replaceAll("'", "''")}')
            ORDER BY recommendation.created_at DESC, recommendation.id DESC LIMIT 1) AS follow_up_confidence
        FROM contact_submissions AS submission
        ${whereClause}
        ORDER BY ${sortExpression}${directionSuffix}, submission.updated_at DESC, submission.id ASC
        LIMIT ? OFFSET ?
      `).all(...params, safePageSize, offset).map(normalizeSubmissionRow);
      return { rows, total, page: safePage, pageSize: safePageSize };
    },

    async listCimStage2MetricCommunications({ limit = 10000, offset = 0 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 10000, 100000));
      const safeOffset = Math.max(0, Math.min(Number(offset) || 0, 100000));
      return database.prepare(`
        SELECT id, submission_id, cim_request_id, opportunity_id, direction, kind,
          provider, provider_message_id, occurred_at, created_at, delivery_state,
          delivery_state_at
        FROM crm_communications
        WHERE kind = 'deal-hunter-cim-request'
        ORDER BY occurred_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(safeLimit, safeOffset);
    },

    async getSummary() {
      const activeSubmissionPredicate = activeCrmSubmissionPredicate('submission');
      const total = database.prepare(`
        SELECT COUNT(*) AS count
        FROM contact_submissions AS submission
        WHERE ${activeSubmissionPredicate}
      `).get()?.count || 0;
      const lastSevenDaysSince = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString();
      const lastSevenDays =
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM contact_submissions AS submission
          WHERE ${activeSubmissionPredicate} AND submission.created_at >= ?
        `).get(lastSevenDaysSince)
          ?.count || 0;
      const dueToday =
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM contact_submissions AS submission
             WHERE ${activeSubmissionPredicate}
               AND submission.next_action_at IS NOT NULL
               AND submission.next_action_at <= ?
               AND submission.status NOT IN ('archived', 'spam')`,
          )
          .get(new Date().toISOString())?.count || 0;
      const grouped = database
        .prepare(`
          SELECT submission.status, COUNT(*) AS count
          FROM contact_submissions AS submission
          WHERE ${activeSubmissionPredicate}
          GROUP BY submission.status
        `)
        .all()
        .reduce((accumulator, row) => {
          accumulator[row.status] = row.count;
          return accumulator;
        }, {});

      return {
        total,
        lastSevenDays,
        dueToday,
        new: grouped.new || 0,
        review: grouped.review || 0,
        contacted: grouped.contacted || 0,
        archived: grouped.archived || 0,
        spam: grouped.spam || 0,
      };
    },

    async addRateLimitEvent(bucket, createdAt) {
      const retentionMs = Math.max(0, Number(config.protection?.rateLimitRetentionMs) || 0);

      if (retentionMs > 0) {
        const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
        database.prepare('DELETE FROM contact_rate_limit_events WHERE created_at < ?').run(cutoffIso);
      }

      database.prepare('INSERT INTO contact_rate_limit_events (bucket, created_at) VALUES (?, ?)').run(bucket, createdAt);
    },

    async countRateLimitEvents(bucket, sinceIso) {
      return (
        database
          .prepare('SELECT COUNT(*) AS count FROM contact_rate_limit_events WHERE bucket = ? AND created_at >= ?')
          .get(bucket, sinceIso)?.count || 0
      );
    },

    async insertAnalyticsEvent(event, retentionDays = 90) {
      const cutoffIso = new Date(Date.now() - Math.max(1, Number(retentionDays) || 90) * 86_400_000).toISOString();
      database.prepare('DELETE FROM analytics_events WHERE created_at < ?').run(cutoffIso);
      database.prepare(`
        INSERT INTO analytics_events (
          id, created_at, event_name, path, referrer_host, utm_source, utm_medium, utm_campaign, placement
        ) VALUES (
          @id, @created_at, @event_name, @path, @referrer_host, @utm_source, @utm_medium, @utm_campaign, @placement
        )
      `).run(event);
      return event;
    },

    async listAnalyticsEvents({ sinceIso = '', limit = 1000 } = {}) {
      return database
        .prepare('SELECT * FROM analytics_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?')
        .all(sinceIso || '0000-01-01T00:00:00.000Z', Math.max(1, Math.min(Number(limit) || 1000, 10000)));
    },

    async insertSecureUploadRequest(requestRecord) {
      return database.transaction(() => {
        assertCrmSubmissionWritableInTransaction(requestRecord?.submission_id);
        insertSecureUploadRequestStatement.run(serializeUploadRequest(requestRecord));
        return requestRecord;
      }).immediate();
    },

    async updateSecureUploadRequest(id, values) {
      return database.transaction(() => {
        const request = database.prepare('SELECT submission_id FROM secure_upload_requests WHERE id = ?').get(id);
        if (request?.submission_id) assertCrmSubmissionWritableInTransaction(request.submission_id);
        updateRecord(
          'secure_upload_requests',
          id,
          serializeUploadRequestValues(values),
          ['updated_at', 'status', 'expires_at', 'nda_required', 'nda_accepted_at', 'last_uploaded_at', 'note', 'requested_documents', 'revoked_at', 'closed_at', 'upload_batch_count'],
        );
        return normalizeUploadRequestRow(database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(id));
      }).immediate();
    },

    async resetSecureUploadRequestIfUploading(id, values) {
      return database.transaction(() => {
        const request = database.prepare('SELECT submission_id FROM secure_upload_requests WHERE id = ?').get(id);
        if (request?.submission_id) assertCrmSubmissionWritableInTransaction(request.submission_id);
        const updates = Object.entries(serializeUploadRequestValues(values)).filter(([key]) =>
          ['updated_at', 'status'].includes(key),
        );
        if (updates.length === 0) return null;
        const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
        const payload = Object.fromEntries(updates);
        payload.id = id;
        const result = database
          .prepare(`UPDATE secure_upload_requests SET ${fields} WHERE id = @id AND status = 'uploading'`)
          .run(payload);
        return result.changes > 0
          ? normalizeUploadRequestRow(database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(id))
          : null;
      }).immediate();
    },

    async claimSecureUploadRequest(id, values, options = {}) {
      const updates = Object.entries(serializeUploadRequestValues(values)).filter(([key]) =>
        ['updated_at', 'status', 'nda_accepted_at', 'last_uploaded_at', 'note', 'closed_at', 'upload_batch_count'].includes(key),
      );
      if (updates.length === 0) return null;
      return database.transaction(() => {
        const request = database.prepare('SELECT submission_id FROM secure_upload_requests WHERE id = ?').get(id);
        if (request?.submission_id) assertCrmSubmissionWritableInTransaction(request.submission_id);
        const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
        const payload = Object.fromEntries(updates);
        payload.id = id;
        payload.stale_before = options.staleBefore || '';
        const result = database.prepare(`
          UPDATE secure_upload_requests SET ${fields}
          WHERE id = @id
            AND (
              status IN ('awaiting-documents', 'open', 'partially-received')
              OR (status = 'uploading' AND @stale_before != '' AND updated_at <= @stale_before)
            )
        `).run(payload);
        return result.changes > 0
          ? normalizeUploadRequestRow(database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(id))
          : null;
      }).immediate();
    },

    async getSecureUploadRequest(id) {
      const row = database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(id);
      return normalizeUploadRequestRow(row);
    },

    async getLatestSecureUploadRequestForSubmission(submissionId) {
      const row = database
        .prepare('SELECT * FROM secure_upload_requests WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(submissionId);
      return normalizeUploadRequestRow(row);
    },

    async listLatestSecureUploadRequestsForSubmissions(submissionIds = []) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM secure_upload_requests
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
          `,
        )
        .all(...ids)
        .map(normalizeUploadRequestRow);
    },

    async insertSecureDocument(document) {
      return database.transaction(() => {
        if (document?.submission_id) assertCrmSubmissionWritableInTransaction(document.submission_id);
        insertSecureDocumentStatement.run(document);
        if (document.submission_id) {
          database.prepare(`
            UPDATE crm_follow_up_recommendations
            SET status = 'superseded', superseded_at = ?
            WHERE submission_id = ? AND status = 'current'
          `).run(document.created_at || new Date().toISOString(), document.submission_id);
        }
        return document;
      }).immediate();
    },

    async deleteSecureDocument(id) {
      return database.transaction(() => {
        const document = database.prepare('SELECT submission_id FROM secure_documents WHERE id = ? LIMIT 1').get(id);
        if (document?.submission_id) assertCrmSubmissionWritableInTransaction(document.submission_id);
        deleteSecureDocumentStatement.run(id);
        if (document?.submission_id) {
          database.prepare(`
            UPDATE crm_follow_up_recommendations
            SET status = 'superseded', superseded_at = ?
            WHERE submission_id = ? AND status = 'current'
          `).run(new Date().toISOString(), document.submission_id);
        }
      }).immediate();
    },

    async getSecureDocument(id) {
      const row = database.prepare('SELECT * FROM secure_documents WHERE id = ? LIMIT 1').get(id);
      return row || null;
    },

    async listSecureDocumentsByRequest(requestId) {
      return database
        .prepare('SELECT * FROM secure_documents WHERE request_id = ? ORDER BY created_at DESC')
        .all(requestId);
    },

    async listSecureDocumentsForSubmission(submissionId) {
      return database
        .prepare('SELECT * FROM secure_documents WHERE submission_id = ? ORDER BY created_at DESC')
        .all(submissionId);
    },

    async listSecureDocumentsForSubmissions(submissionIds = []) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM secure_documents
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
          `,
        )
        .all(...ids);
    },

    async insertEmailEvent(event) {
      const result = insertEmailEventStatement.run(serializeEmailEvent(event));

      if (result.changes === 0 && event.event_key) {
        return normalizeEmailEventRow(getEmailEventByKeyStatement.get(event.event_key));
      }

      return event;
    },

    async listEmailEvents({ submissionId = '', recipientEmail = '', source = '', limit = 100 } = {}) {
      const clauses = [];
      const params = [];

      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(submissionId);
      }

      if (recipientEmail) {
        clauses.push("LOWER(COALESCE(recipient_email, '')) = ?");
        params.push(String(recipientEmail).trim().toLowerCase());
      }

      if (source) {
        clauses.push('source = ?');
        params.push(String(source).trim());
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(limit, 500));

      return database
        .prepare(
          `
            SELECT * FROM email_events
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeEmailEventRow);
    },

    async listCimStage2MetricEmailEvents({ limit = 10000 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 10000, 100000));
      return database.prepare(`
        SELECT id, created_at, provider, event_type, message_id, provider_event_id,
          event_key, submission_id, communication_id, opportunity_id, source
        FROM email_events
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(safeLimit);
    },

    async listEmailEventsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      return database
        .prepare(
          `
            SELECT * FROM email_events
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, safeLimit)
        .map(normalizeEmailEventRow);
    },

    async listEmailEventsForRecipients(recipientEmails = [], limit = 5000) {
      const emails = normalizeList(recipientEmails).map((email) => email.toLowerCase());

      if (emails.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      return database
        .prepare(
          `
            SELECT * FROM email_events
            WHERE LOWER(COALESCE(recipient_email, '')) IN (${placeholders(emails.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...emails, safeLimit)
        .map(normalizeEmailEventRow);
    },

    async listEmailEventsByMessageIds(messageIds = [], limit = 5000) {
      const ids = normalizeList(messageIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      return database
        .prepare(
          `
            SELECT * FROM email_events
            WHERE message_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, safeLimit)
        .map(normalizeEmailEventRow);
    },

    async getCrmCommunication(id) {
      if (!id) return null;
      return normalizeCrmCommunicationRow(
        database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(id),
      );
    },

    async getCrmCommunicationByProviderMessage(provider, messageId, direction = '') {
      const normalizedProvider = String(provider || '').trim();
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedProvider || !normalizedMessageId) return null;

      const directionClause = direction ? 'AND direction = ?' : '';
      const params = direction
        ? [normalizedProvider, normalizedMessageId, String(direction).trim()]
        : [normalizedProvider, normalizedMessageId];
      return normalizeCrmCommunicationRow(
        database.prepare(`
          SELECT * FROM crm_communications
          WHERE provider = ? AND provider_message_id = ? ${directionClause}
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1
        `).get(...params),
      );
    },

    async getCrmCommunicationBySourceEvent(provider, sourceEventId) {
      const normalizedProvider = String(provider || '').trim();
      const normalizedSourceEventId = String(sourceEventId || '').trim();
      if (!normalizedProvider || !normalizedSourceEventId) return null;
      return normalizeCrmCommunicationRow(
        database.prepare(`
          SELECT * FROM crm_communications
          WHERE provider = ? AND source_event_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1
        `).get(normalizedProvider, normalizedSourceEventId),
      );
    },

    async getCrmCommunicationByMessageId(messageId) {
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId) return null;
      return normalizeCrmCommunicationRow(
        database.prepare(`
          SELECT * FROM crm_communications
          WHERE message_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1
        `).get(normalizedMessageId),
      );
    },

    async insertCrmCommunication(communication = {}) {
      const serialized = serializeCrmCommunication(communication);
      return database.transaction(() => {
        if (serialized.submission_id) assertCrmSubmissionWritableInTransaction(serialized.submission_id);
        const result = insertCrmCommunicationStatement.run(serialized);
        if (result.changes === 0) return getExistingCrmCommunication(serialized);
        const stored = normalizeCrmCommunicationRow(
          database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(serialized.id),
        );
        linkEmailEventsToCommunication(stored);
        if (stored?.submission_id) {
          database.prepare(`
            UPDATE crm_follow_up_recommendations
            SET status = 'superseded', superseded_at = ?
            WHERE submission_id = ? AND status = 'current'
          `).run(stored.occurred_at || stored.updated_at || new Date().toISOString(), stored.submission_id);
        }
        return stored;
      }).immediate();
    },

    async updateCrmCommunication(id, values = {}) {
      const allowedFields = [
        'submission_id', 'opportunity_id', 'deal_key', 'cim_request_id', 'direction', 'channel', 'source', 'kind',
        'provider', 'provider_message_id', 'source_event_id', 'idempotency_key', 'message_id', 'in_reply_to',
        'references_json', 'parent_communication_id', 'thread_key', 'legacy_content_unavailable',
        'content_redaction_state', 'recommendation_id', 'outbox_id', 'headers_json',
        'reply_to_address', 'from_address', 'to_addresses', 'cc_addresses', 'bcc_addresses',
        'subject', 'body_text', 'body_html_sanitized', 'occurred_at', 'updated_at', 'delivery_state',
        'delivery_state_at', 'content_state', 'content_attempt_count', 'content_last_error',
        'content_next_attempt_at', 'attachment_metadata', 'assigned_at', 'assigned_by', 'updated_by',
        'metadata',
      ];
      return database.transaction(() => {
        const current = database.prepare('SELECT submission_id FROM crm_communications WHERE id = ? LIMIT 1').get(id);
        const existingSubmissionId = String(current?.submission_id || '').trim();
        const targetSubmissionId = Object.hasOwn(values, 'submission_id')
          ? String(values.submission_id || '').trim()
          : existingSubmissionId;
        if (existingSubmissionId) assertCrmSubmissionWritableInTransaction(existingSubmissionId);
        if (targetSubmissionId && targetSubmissionId !== existingSubmissionId) {
          assertCrmSubmissionWritableInTransaction(targetSubmissionId);
        }
        updateRecord(
          'crm_communications',
          id,
          serializeCrmCommunicationValues(values),
          allowedFields,
        );
        const updated = normalizeCrmCommunicationRow(
          database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(id),
        );
        if (updated?.submission_id) {
          database.prepare(`
            UPDATE crm_follow_up_recommendations
            SET status = 'superseded', superseded_at = ?
            WHERE submission_id = ? AND status = 'current'
          `).run(updated.updated_at || new Date().toISOString(), updated.submission_id);
        }
        return updated;
      }).immediate();
    },

    async createCrmEmailCommand({
      communication = {}, outbox = {}, activity = {}, expectedSubmissionVersion = '',
      manualTakeoverCimRequestId = '',
    } = {}) {
      const serializedCommunication = serializeCrmCommunication(communication);
      const serializedOutbox = serializeCrmEmailOutbox(outbox);
      const recommendationDecision = ['accepted', 'edited_and_accepted'].includes(outbox.metadata?.recommendationDecision)
        ? outbox.metadata.recommendationDecision
        : '';
      const command = database.transaction(() => {
        const duplicate = database.prepare(`
          SELECT * FROM crm_email_outbox WHERE client_request_key = ? LIMIT 1
        `).get(serializedOutbox.client_request_key);
        if (duplicate) {
          const existingOutbox = normalizeCrmEmailOutboxRow(duplicate);
          return {
            applied: false,
            reason: 'duplicate-client-request',
            outbox: existingOutbox,
            communication: normalizeCrmCommunicationRow(
              database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(existingOutbox.communication_id),
            ),
            submission: normalizeSubmissionRow(
              database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(existingOutbox.submission_id),
            ),
          };
        }

        assertCrmSubmissionWritableInTransaction(serializedOutbox.submission_id);

        const submission = database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1')
          .get(serializedOutbox.submission_id);
        if (!submission) return { applied: false, reason: 'submission-not-found', outbox: null, communication: null, submission: null };
        if (!expectedSubmissionVersion || submission.updated_at !== expectedSubmissionVersion) {
          return {
            applied: false,
            reason: 'stale-submission',
            outbox: null,
            communication: null,
            submission: normalizeSubmissionRow(submission),
          };
        }
        if (['archived', 'spam'].includes(String(submission.status || '').toLowerCase())) {
          return {
            applied: false,
            reason: `submission-${String(submission.status).toLowerCase()}`,
            outbox: null,
            communication: null,
            submission: normalizeSubmissionRow(submission),
          };
        }

        if (manualTakeoverCimRequestId) {
          const cimRequest = database.prepare(`
            SELECT * FROM deal_hunter_cim_requests
            WHERE id = ? AND submission_id = ?
            LIMIT 1
          `).get(manualTakeoverCimRequestId, serializedOutbox.submission_id);
          if (!cimRequest) {
            return { applied: false, reason: 'cim-request-not-found', outbox: null, communication: null, submission: normalizeSubmissionRow(submission) };
          }
          if (['pending', 'follow_up_pending'].includes(String(cimRequest.status || ''))) {
            return { applied: false, reason: 'cim-send-in-progress', outbox: null, communication: null, submission: normalizeSubmissionRow(submission) };
          }
          database.prepare(`
            UPDATE deal_hunter_cim_requests SET
              request_state = 'manual_takeover',
              follow_up_state = 'stopped',
              next_follow_up_at = NULL,
              follow_up_count = follow_up_count + 1,
              updated_at = ?,
              last_activity_at = ?,
              metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                '$.manualTakeoverAt', ?, '$.manualTakeoverBy', ?)
            WHERE id = ? AND submission_id = ?
          `).run(
            serializedOutbox.created_at,
            serializedOutbox.created_at,
            serializedOutbox.created_at,
            serializedOutbox.actor,
            manualTakeoverCimRequestId,
            serializedOutbox.submission_id,
          );
        }

        const communicationInsert = insertCrmCommunicationStatement.run(serializedCommunication);
        if (communicationInsert.changes !== 1) throw new Error('Unable to create the immutable CRM communication.');
        insertCrmEmailOutboxStatement.run(serializedOutbox);
        const recommendationId = String(serializedCommunication.recommendation_id || '').trim();
        if (recommendationId) {
          database.prepare(`
            UPDATE crm_follow_up_recommendations
            SET
              status = CASE
                WHEN ? = 'accepted' THEN 'accepted'
                WHEN ? = 'edited_and_accepted' THEN 'edited_and_accepted'
                WHEN COALESCE(draft_subject, '') = COALESCE(?, '')
                  AND COALESCE(draft_body_text, '') = COALESCE(?, '')
                THEN 'accepted'
                ELSE 'edited_and_accepted'
              END,
              acted_on_at = ?,
              acted_on_by = ?,
              outcome = 'email-command-created'
            WHERE id = ? AND submission_id = ? AND status = 'current'
          `).run(
            recommendationDecision,
            recommendationDecision,
            serializedCommunication.subject,
            serializedCommunication.body_text,
            serializedOutbox.created_at,
            serializedOutbox.actor,
            recommendationId,
            serializedOutbox.submission_id,
          );
        }
        database.prepare(`
          UPDATE crm_follow_up_recommendations
          SET status = 'superseded', superseded_at = ?
          WHERE submission_id = ? AND status = 'current'
        `).run(serializedOutbox.created_at, serializedOutbox.submission_id);
        insertCrmActivityEventStatement.run(serializeCrmActivityEvent(activity));
        const submissionUpdate = database.prepare(`
          UPDATE contact_submissions
          SET updated_at = ?
          WHERE id = ? AND updated_at = ?
        `).run(serializedOutbox.created_at, serializedOutbox.submission_id, expectedSubmissionVersion);
        if (submissionUpdate.changes !== 1) throw new Error('The CRM record changed while the email command was being created.');

        return {
          applied: true,
          reason: '',
          outbox: normalizeCrmEmailOutboxRow(
            database.prepare('SELECT * FROM crm_email_outbox WHERE id = ? LIMIT 1').get(serializedOutbox.id),
          ),
          communication: normalizeCrmCommunicationRow(
            database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(serializedCommunication.id),
          ),
          submission: normalizeSubmissionRow(
            database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(serializedOutbox.submission_id),
          ),
        };
      });
      return command.immediate();
    },

    async recordDealHunterManualFollowUpAmbiguity({
      requestId = '', submissionId = '', communicationId = '', idempotencyKey = '',
      actor = '', ambiguousAt = '', error = '',
    } = {}) {
      if (!requestId || !submissionId || !communicationId || !idempotencyKey || !actor
        || !Number.isFinite(Date.parse(ambiguousAt || ''))) return null;
      return database.transaction(() => {
        const communication = database.prepare('SELECT * FROM crm_communications WHERE id = ? LIMIT 1').get(communicationId);
        const request = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(requestId);
        const submission = database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(submissionId);
        if (!communication || !request || !submission
          || communication.cim_request_id !== requestId
          || communication.submission_id !== submissionId
          || request.submission_id !== submissionId
          || communication.idempotency_key !== idempotencyKey
          || communication.delivery_state !== 'ambiguous'
          || !Number.isFinite(Date.parse(communication.delivery_state_at || ''))
          || new Date(communication.delivery_state_at).toISOString() !== new Date(ambiguousAt).toISOString()) return null;
        const existing = database.prepare('SELECT * FROM crm_email_outbox WHERE communication_id = ? LIMIT 1').get(communicationId);
        if (existing) {
          return existing.state === 'ambiguous'
            && existing.cim_request_id === requestId
            && existing.submission_id === submissionId
            && existing.idempotency_key === `${idempotencyKey}:ambiguity-proof`
            && Number.isFinite(Date.parse(existing.ambiguous_at || ''))
            && new Date(existing.ambiguous_at).toISOString() === new Date(ambiguousAt).toISOString()
            ? normalizeCrmEmailOutboxRow(existing)
            : null;
        }
        const proofId = createHash('sha256').update(`deal-hunter-manual-follow-up-ambiguity:${communicationId}`).digest('hex');
        insertCrmEmailOutboxStatement.run(serializeCrmEmailOutbox({
          id: proofId,
          communication_id: communicationId,
          submission_id: submissionId,
          cim_request_id: requestId,
          idempotency_key: `${idempotencyKey}:ambiguity-proof`,
          client_request_key: `${proofId}:ambiguity-proof`,
          state: 'ambiguous',
          provider: communication.provider || null,
          provider_message_id: communication.provider_message_id || null,
          attempt_count: 1,
          ambiguous_at: ambiguousAt,
          expected_submission_version: submission.updated_at,
          actor: String(actor).slice(0, 300),
          created_at: ambiguousAt,
          updated_at: ambiguousAt,
          metadata: { kind: 'deal-hunter-manual-follow-up-ambiguity-proof', error: String(error || '').slice(0, 500) },
        }));
        return normalizeCrmEmailOutboxRow(
          database.prepare('SELECT * FROM crm_email_outbox WHERE communication_id = ? LIMIT 1').get(communicationId),
        );
      }).immediate();
    },

    async getCrmEmailOutbox(id) {
      if (!id) return null;
      return normalizeCrmEmailOutboxRow(
        database.prepare('SELECT * FROM crm_email_outbox WHERE id = ? LIMIT 1').get(id),
      );
    },

    async getCrmEmailOutboxByClientRequestKey(clientRequestKey) {
      const normalizedKey = String(clientRequestKey || '').trim();
      if (!normalizedKey) return null;
      return normalizeCrmEmailOutboxRow(
        database.prepare('SELECT * FROM crm_email_outbox WHERE client_request_key = ? LIMIT 1').get(normalizedKey),
      );
    },

    async getCrmEmailOutboxByProviderMessageId(providerMessageId) {
      const normalizedId = String(providerMessageId || '').trim();
      if (!normalizedId) return null;
      return normalizeCrmEmailOutboxRow(
        database.prepare(`
          SELECT * FROM crm_email_outbox
          WHERE provider_message_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(normalizedId),
      );
    },

    async listCrmEmailOutbox({ submissionId = '', states = [], limit = 25 } = {}) {
      const clauses = [];
      const params = [];
      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(String(submissionId).trim());
      }
      const safeStates = normalizeList(states, 20);
      if (safeStates.length > 0) {
        clauses.push(`state IN (${placeholders(safeStates.length)})`);
        params.push(...safeStates);
      }
      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
      return database.prepare(`
        SELECT * FROM crm_email_outbox ${whereClause}
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(...params, safeLimit).map(normalizeCrmEmailOutboxRow);
    },

    async claimCrmEmailOutbox({ id = '', claimToken = '', claimedAt = '', claimExpiresAt = '' } = {}) {
      return database.transaction(() => {
        const current = database.prepare('SELECT submission_id, state FROM crm_email_outbox WHERE id = ? LIMIT 1').get(id);
        if (current?.submission_id && ['queued', 'retryable_failed', 'sending'].includes(current.state)) {
          assertCrmSubmissionWritableInTransaction(current.submission_id);
        }
        const row = database.prepare(`
          UPDATE crm_email_outbox SET
            state = 'sending',
            attempt_count = attempt_count + 1,
            claim_token = ?,
            claimed_at = ?,
            claim_expires_at = ?,
            updated_at = ?
          WHERE id = ?
            AND (
              state = 'queued'
              OR (state = 'retryable_failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (state = 'sending' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
            )
          RETURNING *
        `).get(claimToken, claimedAt, claimExpiresAt, claimedAt, id, claimedAt, claimedAt);
        return {
          claimed: Boolean(row),
          outbox: normalizeCrmEmailOutboxRow(
            row || database.prepare('SELECT * FROM crm_email_outbox WHERE id = ? LIMIT 1').get(id),
          ),
        };
      }).immediate();
    },

    async finishCrmEmailOutboxClaim(id, claimToken, values = {}) {
      const allowedFields = [
        'state', 'provider', 'provider_message_id', 'next_attempt_at', 'accepted_at', 'failed_at',
        'ambiguous_at', 'last_error_category', 'last_error_message', 'updated_at', 'metadata',
      ];
      const safeValues = Object.fromEntries(Object.entries(values).filter(([field]) => allowedFields.includes(field)));
      if (Object.hasOwn(safeValues, 'metadata')) safeValues.metadata = JSON.stringify(safeValues.metadata || {});
      const assignments = Object.keys(safeValues).map((field) => `${field} = @${field}`);
      if (assignments.length === 0) return this.getCrmEmailOutbox(id);
      assignments.push('claim_token = NULL', 'claimed_at = NULL', 'claim_expires_at = NULL');
      const row = database.prepare(`
        UPDATE crm_email_outbox
        SET ${assignments.join(', ')}
        WHERE id = @id AND claim_token = @claim_token AND state = 'sending'
        RETURNING *
      `).get({ ...safeValues, id, claim_token: claimToken });
      return normalizeCrmEmailOutboxRow(row);
    },

    async countCrmEmailOutboxByStates(states = []) {
      const safeStates = normalizeList(states, 20);
      if (safeStates.length === 0) return 0;
      return Number(database.prepare(`
        SELECT COUNT(*) AS count FROM crm_email_outbox
        WHERE state IN (${placeholders(safeStates.length)})
      `).get(...safeStates)?.count || 0);
    },

    async countCrmFollowUpSends({ recipient = '', since = '' } = {}) {
      const normalizedRecipient = String(recipient || '').trim().toLowerCase();
      const clauses = [
        "communication.kind = 'crm-follow-up'",
        "outbox.state NOT IN ('permanent_failed', 'cancelled')",
      ];
      const params = [];
      if (since) {
        clauses.push('outbox.created_at >= ?');
        params.push(String(since));
      }
      if (normalizedRecipient) {
        clauses.push(`EXISTS (
          SELECT 1 FROM json_each(communication.to_addresses)
          WHERE LOWER(json_each.value) = ?
        )`);
        params.push(normalizedRecipient);
      }
      return Number(database.prepare(`
        SELECT COUNT(*) AS count
        FROM crm_email_outbox AS outbox
        JOIN crm_communications AS communication ON communication.id = outbox.communication_id
        WHERE ${clauses.join(' AND ')}
      `).get(...params)?.count || 0);
    },

    async getCrmFollowUpOperationalMetrics({ since = '' } = {}) {
      const windowStartedAt = String(since || '1970-01-01T00:00:00.000Z');
      const row = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'queued') AS outbox_queued,
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'sending') AS outbox_sending,
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'accepted') AS outbox_accepted,
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'ambiguous') AS outbox_ambiguous,
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'retryable_failed') AS outbox_retryable_failed,
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'permanent_failed') AS outbox_permanent_failed,
          (SELECT COUNT(*) FROM crm_email_outbox WHERE created_at >= @since AND state = 'cancelled') AS outbox_cancelled,
          (SELECT COUNT(*) FROM crm_communications WHERE occurred_at >= @since AND kind = 'crm-follow-up' AND direction = 'outbound' AND delivery_state = 'delivered') AS delivered,
          (SELECT COUNT(*) FROM crm_communications WHERE occurred_at >= @since AND kind = 'crm-follow-up' AND direction = 'outbound' AND delivery_state = 'delayed') AS delayed,
          (SELECT COUNT(*) FROM crm_communications WHERE occurred_at >= @since AND kind = 'crm-follow-up' AND direction = 'outbound' AND delivery_state = 'bounced') AS bounced,
          (SELECT COUNT(*) FROM crm_communications WHERE occurred_at >= @since AND kind = 'crm-follow-up' AND direction = 'outbound' AND delivery_state = 'complained') AS complained,
          (SELECT COUNT(*) FROM crm_communications WHERE occurred_at >= @since AND kind = 'crm-follow-up' AND direction = 'outbound' AND delivery_state = 'failed') AS delivery_failed,
          (SELECT COUNT(*) FROM crm_communications AS outbound
            WHERE outbound.occurred_at >= @since AND outbound.kind = 'crm-follow-up' AND outbound.direction = 'outbound'
              AND EXISTS (
                SELECT 1 FROM crm_communications AS inbound
                WHERE inbound.direction = 'inbound'
                  AND inbound.submission_id = outbound.submission_id
                  AND inbound.occurred_at >= outbound.occurred_at
                  AND (
                    inbound.parent_communication_id = outbound.id
                    OR (outbound.message_id IS NOT NULL AND inbound.in_reply_to = outbound.message_id)
                    OR (outbound.thread_key IS NOT NULL AND inbound.thread_key = outbound.thread_key)
                  )
              )) AS replied,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND status = 'current') AS recommendations_current,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND status = 'accepted') AS recommendations_accepted,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND status = 'edited_and_accepted') AS recommendations_edited_and_accepted,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND status = 'dismissed') AS recommendations_dismissed,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND status = 'superseded') AS recommendations_superseded,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND status = 'failed') AS recommendations_failed,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND model_provider IS NOT NULL) AS ai_used,
          (SELECT COUNT(*) FROM crm_follow_up_recommendations WHERE created_at >= @since AND json_extract(metadata, '$.aiRequested') = 1 AND json_extract(metadata, '$.aiUsed') = 0) AS ai_fallback,
          (SELECT COUNT(*) FROM email_suppressions WHERE lifted_at IS NULL) AS suppressions_active
      `).get({ since: windowStartedAt });
      const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
      const aiMetadata = database.prepare(`
        SELECT metadata FROM crm_follow_up_recommendations
        WHERE created_at >= ? AND json_extract(metadata, '$.aiRequested') = 1
      `).all(windowStartedAt).map((item) => parseJsonColumn(item.metadata, {}));
      const countsBy = (field) => aiMetadata.reduce((result, metadata) => {
        const value = String(metadata?.[field] || '').trim();
        if (value) result[value] = count(result[value]) + 1;
        return result;
      }, {});
      const observedValues = (field) => aiMetadata
        .map((metadata) => metadata?.[field])
        .filter((value) => (typeof value === 'number' || typeof value === 'string')
          && String(value).trim() !== '')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0);
      const aggregate = (values) => values.length > 0 ? {
        observed: values.length,
        average: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10,
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        total: values.reduce((total, value) => total + value, 0),
      } : { observed: 0, average: null, minimum: null, maximum: null, total: null };
      const latency = aggregate(observedValues('aiLatencyMs'));
      const inputTokens = aggregate(observedValues('aiInputTokens'));
      const outputTokens = aggregate(observedValues('aiOutputTokens'));
      const cachedTokens = aggregate(observedValues('aiCachedTokens'));
      const reasoningTokens = aggregate(observedValues('aiReasoningTokens'));
      return {
        windowStartedAt,
        outbox: {
          queued: count(row.outbox_queued), sending: count(row.outbox_sending), accepted: count(row.outbox_accepted),
          ambiguous: count(row.outbox_ambiguous), retryableFailed: count(row.outbox_retryable_failed),
          permanentFailed: count(row.outbox_permanent_failed), cancelled: count(row.outbox_cancelled),
        },
        delivery: {
          delivered: count(row.delivered), delayed: count(row.delayed), bounced: count(row.bounced),
          complained: count(row.complained), failed: count(row.delivery_failed), replied: count(row.replied),
        },
        recommendations: {
          current: count(row.recommendations_current), accepted: count(row.recommendations_accepted),
          editedAndAccepted: count(row.recommendations_edited_and_accepted), dismissed: count(row.recommendations_dismissed),
          superseded: count(row.recommendations_superseded), failed: count(row.recommendations_failed),
          aiUsed: count(row.ai_used), aiFallback: count(row.ai_fallback),
        },
        ai: {
          fallbackReasons: countsBy('aiFallbackReason'),
          responseStates: countsBy('aiResponseState'),
          latencyMs: latency,
          tokens: {
            observed: Math.max(inputTokens.observed, outputTokens.observed),
            inputTotal: inputTokens.total,
            outputTotal: outputTokens.total,
            cachedTotal: cachedTokens.total,
            reasoningTotal: reasoningTokens.total,
          },
        },
        suppressions: { active: count(row.suppressions_active) },
      };
    },

    async insertCrmFollowUpRecommendation(recommendation = {}) {
      const serialized = serializeCrmFollowUpRecommendation(recommendation);
      return database.transaction(() => {
        assertCrmSubmissionWritableInTransaction(serialized.submission_id);
        insertCrmFollowUpRecommendationStatement.run(serialized);
        return normalizeCrmFollowUpRecommendationRow(database.prepare(`
          SELECT * FROM crm_follow_up_recommendations
          WHERE submission_id = ? AND input_fingerprint = ? AND engine_version = ?
          LIMIT 1
        `).get(serialized.submission_id, serialized.input_fingerprint, serialized.engine_version));
      }).immediate();
    },

    async getCurrentCrmFollowUpRecommendation(submissionId) {
      return normalizeCrmFollowUpRecommendationRow(database.prepare(`
        SELECT * FROM crm_follow_up_recommendations
        WHERE submission_id = ? AND status = 'current'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(submissionId));
    },

    async getCrmFollowUpRecommendation(id) {
      return normalizeCrmFollowUpRecommendationRow(database.prepare(`
        SELECT * FROM crm_follow_up_recommendations WHERE id = ? LIMIT 1
      `).get(id));
    },

    async supersedeCrmFollowUpRecommendations(submissionId, supersededAt) {
      return database.transaction(() => {
        assertCrmSubmissionWritableInTransaction(submissionId);
        return database.prepare(`
          UPDATE crm_follow_up_recommendations
          SET status = 'superseded', superseded_at = ?
          WHERE submission_id = ? AND status = 'current'
        `).run(supersededAt, submissionId).changes;
      }).immediate();
    },

    async updateCrmFollowUpRecommendation(id, values = {}) {
      const allowedFields = ['status', 'acted_on_at', 'superseded_at', 'acted_on_by', 'outcome', 'metadata'];
      const safeValues = Object.fromEntries(Object.entries(values).filter(([field]) => allowedFields.includes(field)));
      if (Object.hasOwn(safeValues, 'metadata')) safeValues.metadata = JSON.stringify(safeValues.metadata || {});
      return database.transaction(() => {
        const current = database.prepare('SELECT submission_id FROM crm_follow_up_recommendations WHERE id = ? LIMIT 1').get(id);
        if (current?.submission_id) assertCrmSubmissionWritableInTransaction(current.submission_id);
        if (Object.keys(safeValues).length === 0) return normalizeCrmFollowUpRecommendationRow(
          database.prepare('SELECT * FROM crm_follow_up_recommendations WHERE id = ? LIMIT 1').get(id),
        );
        const assignments = Object.keys(safeValues).map((field) => `${field} = @${field}`).join(', ');
        return normalizeCrmFollowUpRecommendationRow(database.prepare(`
          UPDATE crm_follow_up_recommendations SET ${assignments} WHERE id = @id RETURNING *
        `).get({ ...safeValues, id }));
      }).immediate();
    },

    async getActiveEmailSuppression(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) return null;
      return normalizeEmailSuppressionRow(database.prepare(`
        SELECT * FROM email_suppressions
        WHERE normalized_email = ? AND lifted_at IS NULL
        LIMIT 1
      `).get(normalizedEmail));
    },

    async upsertEmailSuppression(suppression = {}) {
      const serialized = serializeEmailSuppression(suppression);
      upsertEmailSuppressionStatement.run(serialized);
      return this.getActiveEmailSuppression(serialized.normalized_email);
    },

    async liftEmailSuppression(email, { liftedAt = '', liftedBy = '', liftReason = '' } = {}) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const row = database.prepare(`
        UPDATE email_suppressions SET lifted_at = ?, lifted_by = ?, lift_reason = ?
        WHERE normalized_email = ? AND lifted_at IS NULL
        RETURNING *
      `).get(liftedAt, liftedBy, liftReason, normalizedEmail);
      return normalizeEmailSuppressionRow(row);
    },

    async listCrmCommunications({
      submissionId = '', cimRequestId = '', dealKey = '', unassigned = false, direction = '',
      channels = [], deliveryStates = [], contentStates = [], search = '', before = '', page = 1, pageSize = 25,
    } = {}) {
      const clauses = [];
      const params = [];
      const safeChannels = normalizeList(channels, 20);
      const safeDeliveryStates = normalizeList(deliveryStates, 20).map((value) => value.replaceAll('_', '-'));
      const safeContentStates = normalizeList(contentStates, 20);

      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(String(submissionId).trim());
      }
      if (cimRequestId) {
        clauses.push('cim_request_id = ?');
        params.push(String(cimRequestId).trim());
      }
      if (dealKey) {
        clauses.push('deal_key = ?');
        params.push(String(dealKey).trim());
      }
      if (unassigned) clauses.push('submission_id IS NULL');
      if (direction) {
        clauses.push('direction = ?');
        params.push(String(direction).trim());
      }
      if (safeChannels.length > 0) {
        clauses.push(`channel IN (${placeholders(safeChannels.length)})`);
        params.push(...safeChannels);
      }
      if (safeDeliveryStates.length > 0) {
        clauses.push(`delivery_state IN (${placeholders(safeDeliveryStates.length)})`);
        params.push(...safeDeliveryStates);
      }
      if (safeContentStates.length > 0) {
        clauses.push(`content_state IN (${placeholders(safeContentStates.length)})`);
        params.push(...safeContentStates);
      }
      const normalizedSearch = String(search || '').trim().toLowerCase();
      if (normalizedSearch) {
        clauses.push(`(
          INSTR(LOWER(COALESCE(subject, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(from_address, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(body_text, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(deal_key, '')), ?) > 0
        )`);
        params.push(normalizedSearch, normalizedSearch, normalizedSearch, normalizedSearch);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM crm_communications ${whereClause}`).get(...params)?.count || 0);
      const rowClauses = [...clauses];
      const rowParams = [...params];
      if (before) {
        rowClauses.push('occurred_at < ?');
        rowParams.push(String(before).trim());
      }
      const rowsWhereClause = rowClauses.length > 0 ? `WHERE ${rowClauses.join(' AND ')}` : '';
      const safePage = normalizePage(page);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const offset = before ? 0 : (safePage - 1) * safePageSize;
      const rows = database.prepare(`
        SELECT * FROM crm_communications
        ${rowsWhereClause}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...rowParams, safePageSize, offset).map(normalizeCrmCommunicationRow);

      return { rows, total, page: safePage, pageSize: safePageSize };
    },

    async countCrmCommunications({
      submissionId = '', cimRequestId = '', unassigned = false, direction = '', contentStates = [], deliveryStates = [],
    } = {}) {
      const clauses = [];
      const params = [];
      const safeContentStates = normalizeList(contentStates, 20);
      const safeDeliveryStates = normalizeList(deliveryStates, 20);
      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(String(submissionId).trim());
      }
      if (cimRequestId) {
        clauses.push('cim_request_id = ?');
        params.push(String(cimRequestId).trim());
      }
      if (unassigned) clauses.push('submission_id IS NULL');
      if (direction) {
        clauses.push('direction = ?');
        params.push(String(direction).trim());
      }
      if (safeContentStates.length > 0) {
        clauses.push(`content_state IN (${placeholders(safeContentStates.length)})`);
        params.push(...safeContentStates);
      }
      if (safeDeliveryStates.length > 0) {
        clauses.push(`delivery_state IN (${placeholders(safeDeliveryStates.length)})`);
        params.push(...safeDeliveryStates);
      }
      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return Number(database.prepare(`SELECT COUNT(*) AS count FROM crm_communications ${whereClause}`).get(...params)?.count || 0);
    },

    async listCrmCommunicationsPendingIngestion({ dueBefore = '', limit = 25 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 250));
      const dueAt = String(dueBefore || new Date().toISOString()).trim();
      return database.prepare(`
        SELECT * FROM crm_communications
        WHERE content_state IN ('pending', 'failed')
          AND content_next_attempt_at IS NOT NULL
          AND content_next_attempt_at <= ?
        ORDER BY content_next_attempt_at ASC, created_at ASC, id ASC
        LIMIT ?
      `).all(dueAt, safeLimit).map(normalizeCrmCommunicationRow);
    },

    async claimCrmCommunicationsPendingIngestion({
      dueBefore = '',
      limit = 25,
      leaseUntil = '',
      claimedBy = 'communications-ingestion',
    } = {}) {
      const dueAt = normalizeCanonicalUtcIso(
        String(dueBefore || new Date().toISOString()).trim(),
        'Communication ingestion due time',
      );
      const requestedLeaseUntil = leaseUntil || new Date(Date.parse(dueAt) + 5 * 60 * 1000).toISOString();
      const leaseAt = normalizeCanonicalUtcIso(String(requestedLeaseUntil).trim(), 'Communication ingestion lease expiry');
      if (Date.parse(leaseAt) <= Date.parse(dueAt)) {
        throw new Error('Communication ingestion lease expiry must be later than its due time.');
      }
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 250));
      const safeClaimedBy = String(claimedBy || 'communications-ingestion').trim().slice(0, 160)
        || 'communications-ingestion';
      return claimCrmCommunicationsPendingIngestionTransaction.immediate({
        dueBefore: dueAt,
        leaseUntil: leaseAt,
        limit: safeLimit,
        claimedBy: safeClaimedBy,
      });
    },

    async insertCrmActivityEvent(event) {
      return database.transaction(() => insertCrmActivityEvent(event)).immediate();
    },

    async listCrmActivityEvents({ submissionId = '', eventTypes = [], limit = 200, before = '' } = {}) {
      const clauses = [];
      const params = [];
      const safeTypes = normalizeList(eventTypes, 25);

      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(String(submissionId));
      }

      if (safeTypes.length > 0) {
        clauses.push(`event_type IN (${placeholders(safeTypes.length)})`);
        params.push(...safeTypes);
      }

      if (before) {
        clauses.push('created_at < ?');
        params.push(String(before));
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
      return database
        .prepare(`
          SELECT * FROM crm_activity_events
          ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `)
        .all(...params, safeLimit)
        .map(normalizeCrmActivityEventRow);
    },



	    async listDealHunterSeenDeals({ limit = 100000 } = {}) {
	      const safeLimit = Math.max(1, Math.min(limit, 100000));

	      return database
	        .prepare(
	          `
	            SELECT * FROM deal_hunter_seen_deals
	            ORDER BY last_seen_at DESC
	            LIMIT ?
	          `,
	        )
	        .all(safeLimit)
	        .map(normalizeDealHunterSeenDealRow);
	    },

	    async upsertDealHunterSeenDeals(records = []) {
		      if (!Array.isArray(records) || records.length === 0) {
		        return [];
		      }

		      upsertDealHunterSeenDealsTransaction(records);
		      return records;
		    },

    async allocateDealHunterSourceGeneration({ sourceId, runId } = {}) {
      const source = String(sourceId || '').trim();
      const run = String(runId || '').trim();
      if (!source || source.length > 160 || !run || run.length > 200) {
        throw new Error('Freshness source and run identities must be bounded.');
      }
      return database.transaction(() => {
        const state = database.prepare('SELECT * FROM deal_hunter_source_freshness_state WHERE source_id = ?').get(source);
        if (state?.accepted_run_id === run) return { sourceId: source, runId: run, generation: state.accepted_generation };
        const generation = Number(state?.next_generation || 0) + 1;
        if (!Number.isSafeInteger(generation)) throw new Error('Freshness source generation overflow.');
        database.prepare(`INSERT INTO deal_hunter_source_freshness_state (source_id, next_generation)
          VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET next_generation = excluded.next_generation`
        ).run(source, generation);
        return { sourceId: source, runId: run, generation };
      }).immediate();
    },

    async insertDealHunterDealOsImport(record) {
      const serialized = serializeDealHunterDealOsImport(record);
      const freshnessRun = record?.freshnessRun || (record?.freshness_generation
        ? { sourceId: 'deal-os-export', runId: record.id, generation: record.freshness_generation }
        : null);
      const acceptedRows = Array.isArray(record?.acceptedRowEvidence) ? record.acceptedRowEvidence : [];
      const insert = database.transaction(() => {
        let generation = null;
        let acceptedAt = null;
        let digest = null;
        if (freshnessRun) {
          if (freshnessRun.sourceId !== 'deal-os-export' || freshnessRun.runId !== record.id
            || !Number.isSafeInteger(freshnessRun.generation) || freshnessRun.generation < 1) {
            throw new Error('Deal OS freshness run does not match the accepted import rows.');
          }
          generation = freshnessRun.generation;
          digest = createHash('sha256').update(JSON.stringify({
            file_sha256: record.file_sha256,
            row_accounting: serialized.row_accounting,
            records: serialized.records,
            scope: record.scope,
          })).digest('hex');
          const state = database.prepare('SELECT * FROM deal_hunter_source_freshness_state WHERE source_id = ?').get('deal-os-export');
          if (!state || generation > state.next_generation) throw new Error('Deal OS freshness generation was not allocated.');
          if (generation <= state.accepted_generation) {
            if (generation !== state.accepted_generation || state.accepted_run_id !== record.id || state.accepted_digest !== digest) {
              throw new Error('Stale or conflicting Deal OS freshness run.');
            }
            const prior = database.prepare('SELECT * FROM deal_hunter_deal_os_imports WHERE id = ?').get(record.id);
            if (!prior || prior.file_sha256 !== record.file_sha256 || prior.records !== serialized.records) {
              throw new Error('Conflicting Deal OS import replay.');
            }
            return normalizeDealHunterDealOsImportRow(prior);
          }
          if (acceptedRows.length !== Number(record.accepted_row_count)) {
            throw new Error('Deal OS freshness run does not match the accepted import rows.');
          }
          acceptedAt = database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at").get().at;
        }
        database.prepare(`
        INSERT INTO deal_hunter_deal_os_imports (
          id, created_at, imported_by, exported_at, file_name, file_type, file_size, file_sha256,
          scope, coverage_label, expected_row_count, row_count, source_row_count, accepted_row_count,
          rejected_row_count, canonical_record_count, parser_version, row_accounting,
          duplicate_count, stable_id_count, listing_url_count, coverage_limit_reached, records, metadata,
          freshness_generation, freshness_projection_state
        ) VALUES (
          @id, @created_at, @imported_by, @exported_at, @file_name, @file_type, @file_size, @file_sha256,
          @scope, @coverage_label, @expected_row_count, @row_count, @source_row_count, @accepted_row_count,
          @rejected_row_count, @canonical_record_count, @parser_version, @row_accounting,
          @duplicate_count, @stable_id_count, @listing_url_count, @coverage_limit_reached, @records, @metadata,
          @freshness_generation, @freshness_projection_state
        )
      `).run({ ...serialized, freshness_generation: generation, freshness_projection_state: generation ? 'pending' : null });
        if (freshnessRun) {
          const insertEvidence = database.prepare(`INSERT INTO deal_hunter_freshness_evidence
            (id, source_id, source_name, source_record_id, run_id, generation,
             event_type, field_key, event_ordinal, accepted_at, raw_header, raw_value,
             publication_precision, publication_meaning, publication_date,
             publication_instant, publication_state, after_value, metric, currency, period)
            VALUES (@id, 'deal-os-export', 'SMB Deal OS Export', @source_record_id, @run_id, @generation,
             @event_type, @field_key, @event_ordinal, @accepted_at, @raw_header, @raw_value,
             @publication_precision, @publication_meaning, @publication_date,
             @publication_instant, @publication_state, @after_value, @metric, @currency, @period)`);
          for (const row of acceptedRows) {
            const sourceRecordId = String(row.sourceRecordId || '').trim();
            const ordinal = row.eventOrdinal;
            if (!sourceRecordId || sourceRecordId.length > 200 || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 10000) {
              throw new Error('Deal OS accepted source-row identity is invalid.');
            }
            const evidence = normalizeSourceFreshnessEvidence(row.freshnessEvidence);
            const writeEvent = (eventType, fieldKey, claim, afterValue = null) => {
              const id = `fl01:${createHash('sha256').update([record.id, sourceRecordId, eventType, fieldKey, ordinal].join('\u0000')).digest('hex')}`;
              insertEvidence.run({
                id, source_record_id: sourceRecordId, run_id: record.id, generation,
                event_type: eventType, field_key: fieldKey, event_ordinal: ordinal, accepted_at: acceptedAt,
                raw_header: claim?.rawHeader || null, raw_value: claim?.rawValue || null,
                publication_precision: eventType === 'publication_evidence'
                  ? (claim?.precision === 'datetime' ? 'instant' : claim?.precision || 'unknown') : 'unknown',
                publication_meaning: claim?.meaning || 'unknown',
                publication_date: acceptedPublicationClaim(claim, acceptedAt).date,
                publication_instant: acceptedPublicationClaim(claim, acceptedAt).instant,
                publication_state: acceptedPublicationClaim(claim, acceptedAt).state,
                after_value: afterValue, metric: claim?.metric || 'unknown',
                currency: claim?.currency || 'unknown', period: claim?.period || 'unknown',
              });
            };
            writeEvent('accepted_source_record', '', null);
            if (evidence?.dateAdded) writeEvent('publication_evidence', 'date_added', evidence.dateAdded);
            for (const [fieldKey, claim] of [
              ['annual_profit', evidence?.annualProfit], ['annual_revenue', evidence?.annualRevenue],
              ['asking_price', evidence?.askingPrice],
            ]) {
              if (!claim) continue;
              const parsedValue = Number(String(claim.rawValue).replaceAll(/[$,]/g, ''));
              writeEvent('accepted_source_record', fieldKey, claim, Number.isFinite(parsedValue) ? parsedValue : null);
            }
          }
          database.prepare(`UPDATE deal_hunter_deal_os_imports SET freshness_projection_state = 'superseded'
            WHERE id <> ? AND freshness_projection_state = 'pending'`).run(record.id);
          database.prepare(`UPDATE deal_hunter_source_freshness_state SET accepted_generation = ?,
            accepted_run_id = ?, accepted_digest = ?, accepted_at = ?, projection_state = 'pending'
            WHERE source_id = ?`).run(generation, record.id, digest, acceptedAt, 'deal-os-export');
        }
        return normalizeDealHunterDealOsImportRow(
        database.prepare('SELECT * FROM deal_hunter_deal_os_imports WHERE id = ?').get(record.id),
      );
      });
      return insert.immediate();
    },

    async getLatestDealHunterDealOsImport() {
      return normalizeDealHunterDealOsImportRow(
        database.prepare(`
          SELECT * FROM deal_hunter_deal_os_imports
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get(),
      );
    },

    async getDealHunterDealOsImport(id) {
      return normalizeDealHunterDealOsImportRow(
        database.prepare('SELECT * FROM deal_hunter_deal_os_imports WHERE id = ? LIMIT 1').get(String(id || '').trim()),
      );
    },

    async listDealHunterDealOsImports({ limit = 25 } = {}) {
      return database.prepare(`
        SELECT * FROM deal_hunter_deal_os_imports
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(Math.max(1, Math.min(Number(limit) || 25, 100))).map(normalizeDealHunterDealOsImportRow);
    },

	    async getDealHunterCrmImport({ id = '', opportunityId = '', dealKey = '', listingIdentity = '' } = {}) {
	      if (!id && !opportunityId && !dealKey && !listingIdentity) {
	        return null;
	      }

	      return normalizeDealHunterCrmImportRow(selectDealHunterCrmImportRow({
          id, opportunityId, dealKey, listingIdentity,
        }));
	    },

      async getDealHunterCanonicalCrmOwnershipHealth() {
        return {
          healthy: canonicalCrmOwnershipHealthy,
          collisions: crmImportOpportunityCollisions.map((row) => ({
            opportunityId: row.opportunity_id,
            recordCount: Number(row.record_count || 0),
          })),
        };
      },

      async listDealHunterCrmImports({ limit = 5000 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 100000));
        return database.prepare(`
          SELECT * FROM deal_hunter_crm_imports
          ORDER BY updated_at DESC, id
          LIMIT ?
        `).all(safeLimit).map(normalizeDealHunterCrmImportRow);
      },

      async startDealHunterCrmReconciliationRun(run, items = []) {
        const insertRun = database.prepare(`
          INSERT INTO deal_hunter_crm_reconciliation_runs (
            id, created_at, updated_at, completed_at, import_id, mode, plan_digest,
            idempotency_key, status, requested_by, counts, plan, results, last_error, metadata
          ) VALUES (
            @id, @created_at, @updated_at, @completed_at, @import_id, @mode, @plan_digest,
            @idempotency_key, @status, @requested_by, @counts, @plan, @results, @last_error, @metadata
          )
        `);
        const insertItem = database.prepare(`
          INSERT INTO deal_hunter_crm_reconciliation_items (
            id, run_id, opportunity_id, deal_key, action, status, submission_id,
            source_row_numbers, planned_changes, error, created_at, updated_at, metadata
          ) VALUES (
            @id, @run_id, @opportunity_id, @deal_key, @action, @status, @submission_id,
            @source_row_numbers, @planned_changes, @error, @created_at, @updated_at, @metadata
          )
        `);
        const transaction = database.transaction(() => {
          insertRun.run({
            ...run,
            completed_at: run.completed_at || null,
            requested_by: run.requested_by || null,
            counts: JSON.stringify(run.counts || {}),
            plan: JSON.stringify(run.plan || {}),
            results: JSON.stringify(run.results || {}),
            last_error: run.last_error || null,
            metadata: JSON.stringify(run.metadata || {}),
          });
          for (const item of items) {
            insertItem.run({
              ...item,
              deal_key: item.deal_key || null,
              submission_id: item.submission_id || null,
              source_row_numbers: JSON.stringify(item.source_row_numbers || []),
              planned_changes: JSON.stringify(item.planned_changes || {}),
              error: item.error || null,
              metadata: JSON.stringify(item.metadata || {}),
            });
          }
        });
        try {
          transaction();
        } catch (error) {
          if (!['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(error?.code)) throw error;
        }
        return normalizeDealHunterCrmReconciliationRunRow(database.prepare(`
          SELECT * FROM deal_hunter_crm_reconciliation_runs
          WHERE id = ? OR idempotency_key = ? ORDER BY created_at DESC LIMIT 1
        `).get(run.id, run.idempotency_key));
      },

      async getDealHunterCrmReconciliationRun({ id = '', idempotencyKey = '' } = {}) {
        if (!id && !idempotencyKey) return null;
        return normalizeDealHunterCrmReconciliationRunRow(database.prepare(`
          SELECT * FROM deal_hunter_crm_reconciliation_runs
          WHERE id = ? OR idempotency_key = ? ORDER BY created_at DESC LIMIT 1
        `).get(id || '', idempotencyKey || ''));
      },

      // --- Deal Hunter opportunity scoring -------------------------------
      //
      // Machine-computed scoring and operator decisions are written by separate
      // methods with disjoint column lists. Neither method can reach the other's
      // columns, so no import, sync, reconciliation, rescore, or retry is able
      // to overwrite an operator decision.

      async writeDealHunterOpportunityScore(score = {}, evidence = []) {
        for (const field of dealHunterOperatorOwnedScoreFields) {
          if (Object.hasOwn(score, field)) {
            throw new Error(`Machine score writes must not carry operator-owned field "${field}".`);
          }
        }
        for (const field of dealHunterEligibilityOwnedScoreFields) {
          if (Object.hasOwn(score, field)) {
            throw new Error(`Machine score writes must not carry eligibility-owned field "${field}".`);
          }
        }
        const opportunityId = String(score.opportunity_id || '').trim();
        if (!opportunityId) throw new Error('A canonical opportunity id is required to write a score.');
        const now = score.scored_at || new Date().toISOString();
        const serialized = {
          opportunity_id: opportunityId,
          created_at: now,
          scored_at: now,
          deal_key: score.deal_key || null,
          name: score.name || null,
          state: score.state || null,
          listing_url: score.listing_url || null,
          fit_score: Number(score.fit_score || 0),
          score_status: String(score.score_status || 'provisional'),
          confidence: String(score.confidence || 'low'),
          completeness_score: Number(score.completeness_score || 0),
          contradiction_count: Number(score.contradiction_count || 0),
          missing_evidence_count: Number(score.missing_evidence_count || 0),
          should_remove: score.should_remove ? 1 : 0,
          high_fit: score.high_fit ? 1 : 0,
          gate_count: Number(score.gate_count || 0),
          score_fingerprint: String(score.score_fingerprint || ''),
          semantic_digest: score.semantic_digest ? String(score.semantic_digest) : null,
          engine_version: String(score.engine_version || ''),
          rules_version: String(score.rules_version || ''),
          profile_version: String(score.profile_version || ''),
          completeness_policy_version: String(score.completeness_policy_version || ''),
          dimensions: JSON.stringify(score.dimensions || []),
          gates: JSON.stringify(score.gates || []),
          applied_caps: JSON.stringify(score.applied_caps || []),
          missing_evidence: JSON.stringify(score.missing_evidence || []),
          confidence_reasons: JSON.stringify(score.confidence_reasons || []),
          summary: JSON.stringify(score.summary || {}),
          current_triage_eligible: 0,
        };
        // The score and the evidence describing it are replaced together, so no
        // reader can observe a score at fingerprint B beside evidence from A.
        const transaction = database.transaction(() => {
          const opportunity = database.prepare(`
            SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
          `).get(opportunityId);
          if (opportunity?.status !== 'active') {
            throw new Error('A superseded or otherwise non-current opportunity cannot be scored.');
          }
          database.prepare(`
            INSERT INTO deal_hunter_opportunity_scores (
              opportunity_id, created_at, scored_at, deal_key, name, state, listing_url, fit_score, score_status, confidence,
              completeness_score, contradiction_count, missing_evidence_count, should_remove, high_fit,
              gate_count, score_fingerprint, semantic_digest, engine_version, rules_version, profile_version,
              completeness_policy_version, dimensions, gates, applied_caps, missing_evidence,
              confidence_reasons, summary, current_triage_eligible
            ) VALUES (
              @opportunity_id, @created_at, @scored_at, @deal_key, @name, @state, @listing_url, @fit_score, @score_status, @confidence,
              @completeness_score, @contradiction_count, @missing_evidence_count, @should_remove, @high_fit,
              @gate_count, @score_fingerprint, @semantic_digest, @engine_version, @rules_version, @profile_version,
              @completeness_policy_version, @dimensions, @gates, @applied_caps, @missing_evidence,
              @confidence_reasons, @summary, @current_triage_eligible
            )
            ON CONFLICT(opportunity_id) DO UPDATE SET
              scored_at = excluded.scored_at,
              deal_key = excluded.deal_key,
              name = excluded.name,
              state = excluded.state,
              listing_url = excluded.listing_url,
              fit_score = excluded.fit_score,
              score_status = excluded.score_status,
              confidence = excluded.confidence,
              completeness_score = excluded.completeness_score,
              contradiction_count = excluded.contradiction_count,
              missing_evidence_count = excluded.missing_evidence_count,
              should_remove = excluded.should_remove,
              high_fit = excluded.high_fit,
              gate_count = excluded.gate_count,
              score_fingerprint = excluded.score_fingerprint,
              semantic_digest = excluded.semantic_digest,
              engine_version = excluded.engine_version,
              rules_version = excluded.rules_version,
              profile_version = excluded.profile_version,
              completeness_policy_version = excluded.completeness_policy_version,
              dimensions = excluded.dimensions,
              gates = excluded.gates,
              applied_caps = excluded.applied_caps,
              missing_evidence = excluded.missing_evidence,
              confidence_reasons = excluded.confidence_reasons,
              summary = excluded.summary
          `).run(serialized);
          database.prepare('DELETE FROM deal_hunter_score_evidence WHERE opportunity_id = ?').run(opportunityId);
          const insertEvidence = database.prepare(`
            INSERT INTO deal_hunter_score_evidence (
              id, opportunity_id, score_fingerprint, created_at, dimension, rule_id, rule_label,
              evidence_class, field, value, observed_value, terms, source_id, source_name,
              source_record_id, listing_url, observed_at
            ) VALUES (
              @id, @opportunity_id, @score_fingerprint, @created_at, @dimension, @rule_id, @rule_label,
              @evidence_class, @field, @value, @observed_value, @terms, @source_id, @source_name,
              @source_record_id, @listing_url, @observed_at
            )
          `);
          (Array.isArray(evidence) ? evidence : []).forEach((row, index) => {
            insertEvidence.run({
              id: `${opportunityId}:${serialized.score_fingerprint}:${index}`,
              opportunity_id: opportunityId,
              score_fingerprint: serialized.score_fingerprint,
              created_at: now,
              dimension: row.dimension || null,
              rule_id: String(row.ruleId || row.rule_id || ''),
              rule_label: String(row.ruleLabel || row.rule_label || ''),
              evidence_class: String(row.evidenceClass || row.evidence_class || ''),
              field: row.field || null,
              value: row.value === null || row.value === undefined ? null : String(row.value),
              observed_value: row.observedValue === null || row.observedValue === undefined ? null : String(row.observedValue),
              terms: JSON.stringify(row.terms || []),
              source_id: row.sourceId || row.source_id || null,
              source_name: row.sourceName || row.source_name || null,
              source_record_id: row.sourceRecordId || row.source_record_id || null,
              listing_url: row.listingUrl || row.listing_url || null,
              observed_at: row.observedAt || row.observed_at || null,
            });
          });
        });
        transaction.immediate();
        return this.getDealHunterOpportunityScore(opportunityId);
      },

      async passDealHunterOpportunity(command = {}) {
        const opportunityId = String(command.opportunityId || '').trim();
        const expectedFreshness = freshnessReviewExpectedPair(command);
        const actor = String(command.actor || 'admin').trim() || 'admin';
        const occurredAt = command.occurredAt || new Date().toISOString();
        if (!opportunityId || !command.dispositionId || !command.archiveActivityId || !command.triageActivityId) {
          throw new Error('Atomic opportunity Pass requires canonical command identity.');
        }
        const transaction = database.transaction(() => {
          const opportunity = database.prepare(`
            SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
          `).get(opportunityId);
          if (!opportunity || opportunity.status !== 'active') return { applied: false, reason: 'not-current' };
          assertFreshnessReviewCurrent(opportunity, expectedFreshness);
          if (command.submissionId) {
            assertCrmSubmissionWritableInTransaction(command.submissionId);
          }
          if (opportunity.primary_submission_id) {
            assertCrmSubmissionWritableInTransaction(opportunity.primary_submission_id);
          }

          const score = database.prepare(`
            SELECT * FROM deal_hunter_opportunity_scores
            WHERE opportunity_id = ? AND current_triage_eligible = 1
            LIMIT 1
          `).get(opportunityId);
          if (!score) return { applied: false, reason: 'not-current' };
          if (score.should_remove) return { applied: false, reason: 'not-actionable' };

          const existingDisposition = database.prepare(`
            SELECT * FROM deal_hunter_dispositions WHERE deal_key = ? LIMIT 1
          `).get(score.deal_key);
          if (existingDisposition?.disposition === 'dismissed') {
            return {
              applied: false,
              reason: 'already-passed',
              disposition: normalizeDealHunterDispositionRow(existingDisposition),
              score: normalizeDealHunterOpportunityScoreRow(score),
            };
          }

          const submission = opportunity.primary_submission_id
            ? database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(opportunity.primary_submission_id)
            : null;
          if (opportunity.primary_submission_id && !submission) {
            return { applied: false, reason: 'linked-submission-missing' };
          }
          const archiveSubmission = Boolean(submission && submission.status !== 'archived');
          if (archiveSubmission) {
            assertCrmSubmissionWritableInTransaction(submission.id);
          }
          if (archiveSubmission && activeCimClaimForSubmission(submission.id, occurredAt)) {
            return { applied: false, reason: 'cim-send-in-progress' };
          }

          if (archiveSubmission) {
            const existingMetadata = parseJsonColumn(submission.metadata, {});
            updateRecord(
              'contact_submissions',
              submission.id,
              {
                updated_at: occurredAt,
                status: 'archived',
                status_updated_at: occurredAt,
                follow_up_state: 'completed',
                next_action_at: null,
                archived_at: occurredAt,
                archived_by: actor,
                archive_reason: command.reason,
                archive_note: command.note || null,
                archive_communication_id: null,
                metadata: {
                  ...existingMetadata,
                  acquisitionCommand: {
                    ...(existingMetadata.acquisitionCommand || {}),
                    pipelineStage: 'passed',
                    passReason: command.reason,
                    fitFeedback: 'false-positive',
                    updatedAt: occurredAt,
                    updatedBy: actor,
                  },
                  leadArchive: {
                    previousStatus: submission.status,
                    archivedAt: occurredAt,
                    archivedBy: actor,
                    reason: command.reason,
                    communicationId: '',
                  },
                },
              },
              submissionUpdateFields,
              submissionJsonFields,
            );
            database.prepare(`
              UPDATE deal_hunter_cim_requests SET
                request_state = CASE WHEN request_state = 'responded' THEN request_state ELSE 'stopped' END,
                follow_up_state = CASE WHEN request_state = 'responded' THEN 'completed' ELSE 'stopped' END,
                next_follow_up_at = NULL,
                updated_at = ?,
                last_activity_at = ?
              WHERE submission_id = ?
            `).run(occurredAt, occurredAt, submission.id);
          }

          const disposition = upsertDealHunterDispositionRecord({
            id: command.dispositionId,
            deal_key: score.deal_key,
            submission_id: submission?.id || null,
            listing_url: score.listing_url || null,
            deal_name: score.name || opportunity.canonical_name || null,
            created_at: occurredAt,
            updated_at: occurredAt,
            disposition: 'dismissed',
            reason: command.reason,
            note: command.note || null,
            dismissed_at: occurredAt,
            dismissed_by: actor,
            restored_at: null,
            restored_by: null,
            created_by: actor,
            updated_by: actor,
            metadata: {},
          });

          database.prepare(`
            UPDATE deal_hunter_opportunity_scores SET
              reviewed_at = ?,
              reviewed_by = ?,
              reviewed_fingerprint = score_fingerprint,
              reviewed_semantic_digest = semantic_digest,
              reviewed_discovery_revision = CASE WHEN ? IS NULL THEN reviewed_discovery_revision ELSE ? END,
              reviewed_material_revision = CASE WHEN ? IS NULL THEN reviewed_material_revision ELSE ? END,
              operator_updated_at = ?
            WHERE opportunity_id = ? AND current_triage_eligible = 1
          `).run(occurredAt, actor,
            expectedFreshness?.discovery ?? null, expectedFreshness?.discovery ?? null,
            expectedFreshness?.material ?? null, expectedFreshness?.material ?? null,
            occurredAt, opportunityId);

          if (submission) {
            if (archiveSubmission) {
              insertCrmActivityEvent({
                id: command.archiveActivityId,
                submission_id: submission.id,
                opportunity_id: opportunityId,
                created_at: occurredAt,
                actor,
                role: 'admin',
                event_type: 'submission.archived',
                summary: `Lead archived: ${String(command.reason || '').replace(/-/g, ' ')}.`,
                metadata: {
                  archiveReason: command.reason,
                  communicationId: '',
                  previousStatus: submission.status,
                  dealKey: score.deal_key,
                  dispositionId: disposition.id,
                },
              });
            }
            insertCrmActivityEvent({
              id: command.triageActivityId,
              submission_id: submission.id,
              opportunity_id: opportunityId,
              created_at: occurredAt,
              actor,
              role: 'admin',
              event_type: 'opportunity.triaged',
              summary: 'Operator triage: marked reviewed, passed.',
              metadata: {
                markedReviewed: true,
                reviewedFingerprint: score.score_fingerprint,
                fitScoreAtDecision: score.fit_score,
                dispositionId: disposition.id,
              },
            });
          }

          return {
            applied: true,
            reason: '',
            disposition,
            score: normalizeDealHunterOpportunityScoreRow(database.prepare(`
              SELECT * FROM deal_hunter_opportunity_scores WHERE opportunity_id = ? LIMIT 1
            `).get(opportunityId)),
            submission: submission
              ? normalizeSubmissionRow(database.prepare('SELECT * FROM contact_submissions WHERE id = ? LIMIT 1').get(submission.id))
              : null,
            archived: Boolean(submission?.status === 'archived' || archiveSubmission),
          };
        });
        return transaction.immediate();
      },

      async setDealHunterOpportunityOperatorDecision(decision = {}) {
        const opportunityId = String(decision.opportunityId || '').trim();
        const expectedFreshness = freshnessReviewExpectedPair(decision);
        if (!opportunityId) throw new Error('A canonical opportunity id is required to record an operator decision.');
        const assignments = [];
        const params = { opportunity_id: opportunityId, operator_updated_at: decision.updatedAt || new Date().toISOString() };
        if (decision.priority !== undefined) {
          assignments.push('operator_priority = @operator_priority');
          params.operator_priority = String(decision.priority || 'normal');
        }
        if (decision.note !== undefined) {
          assignments.push('operator_note = @operator_note');
          params.operator_note = decision.note === null ? null : String(decision.note);
        }
        if (decision.reviewed) {
          assignments.push(
            'reviewed_at = @reviewed_at', 'reviewed_by = @reviewed_by',
            'reviewed_fingerprint = @reviewed_fingerprint', 'reviewed_semantic_digest = @reviewed_semantic_digest',
          );
          params.reviewed_at = decision.reviewedAt || params.operator_updated_at;
          params.reviewed_by = String(decision.reviewedBy || 'admin');
          params.reviewed_fingerprint = String(decision.reviewedFingerprint || '');
          params.reviewed_semantic_digest = decision.reviewedSemanticDigest
            ? String(decision.reviewedSemanticDigest) : null;
          if (expectedFreshness) {
            assignments.push('reviewed_discovery_revision = @reviewed_discovery_revision',
              'reviewed_material_revision = @reviewed_material_revision');
            params.reviewed_discovery_revision = expectedFreshness.discovery;
            params.reviewed_material_revision = expectedFreshness.material;
          }
        }
        if (assignments.length === 0) return this.getCurrentDealHunterOpportunityScore(opportunityId);
        const transaction = database.transaction(() => {
          const opportunity = database.prepare(`
            SELECT status, discovery_revision, material_revision FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
          `).get(opportunityId);
          if (!opportunity) return false;
          if (opportunity?.status !== 'active') {
            throw new Error('A superseded or otherwise non-current opportunity cannot receive a triage decision.');
          }
          assertFreshnessReviewCurrent(opportunity, expectedFreshness);
          const existing = database
            .prepare('SELECT opportunity_id, deal_key FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?')
            .get(opportunityId);
          if (!existing) return false;
          const disposition = database.prepare(`
            SELECT disposition FROM deal_hunter_dispositions WHERE deal_key = ? LIMIT 1
          `).get(existing.deal_key);
          if (disposition?.disposition === 'dismissed') {
            const error = new Error('This opportunity has already been passed and is durably dismissed.');
            error.code = 'DEAL_HUNTER_OPPORTUNITY_DISMISSED';
            error.status = 409;
            throw error;
          }
          database.prepare(`
            UPDATE deal_hunter_opportunity_scores
            SET ${assignments.join(', ')}, operator_updated_at = @operator_updated_at
            WHERE opportunity_id = @opportunity_id
          `).run(params);
          return true;
        });
        if (!transaction.immediate()) return null;
        return this.getDealHunterOpportunityScore(opportunityId);
      },

      async getDealHunterOpportunityScore(opportunityId) {
        return normalizeDealHunterOpportunityScoreRow(
          database.prepare('SELECT * FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?').get(String(opportunityId || '').trim()),
        );
      },

      async getCurrentDealHunterOpportunityScore(opportunityId) {
        return normalizeDealHunterOpportunityScoreRow(
          database.prepare(`
            SELECT scores.*
            FROM deal_hunter_opportunity_scores AS scores
            JOIN deal_hunter_opportunities AS opportunity
              ON opportunity.opportunity_id = scores.opportunity_id
             AND opportunity.status = 'active'
            WHERE scores.opportunity_id = ? AND scores.current_triage_eligible = 1
          `).get(String(opportunityId || '').trim()),
        );
      },

      async getCurrentDealHunterOpportunityScoreByDealKey(dealKey) {
        const rows = database.prepare(`
          SELECT scores.*
          FROM deal_hunter_opportunity_scores AS scores
          JOIN deal_hunter_opportunities AS opportunity
            ON opportunity.opportunity_id = scores.opportunity_id
           AND opportunity.status = 'active'
          WHERE scores.deal_key = ? AND scores.current_triage_eligible = 1
          LIMIT 2
        `).all(String(dealKey || '').trim());
        if (rows.length > 1) {
          const error = new Error('A Deal Hunter key maps to more than one current Inbox opportunity.');
          error.code = 'DEAL_HUNTER_CURRENT_DEAL_KEY_CONFLICT';
          throw error;
        }
        return normalizeDealHunterOpportunityScoreRow(rows[0]);
      },

      async reconcileDealHunterCurrentScoreEligibility(opportunityIds = []) {
        const idsJson = JSON.stringify(normalizeList(opportunityIds, 100000));
        const transaction = database.transaction(() => {
          const activated = Number(database.prepare(`
            SELECT COUNT(*) AS count
            FROM deal_hunter_opportunity_scores AS scores
            JOIN deal_hunter_opportunities AS opportunity
              ON opportunity.opportunity_id = scores.opportunity_id
             AND opportunity.status = 'active'
            WHERE scores.current_triage_eligible = 0
              AND scores.opportunity_id IN (SELECT value FROM json_each(?))
          `).get(idsJson)?.count || 0);
          const deactivated = Number(database.prepare(`
            SELECT COUNT(*) AS count
            FROM deal_hunter_opportunity_scores AS scores
            LEFT JOIN deal_hunter_opportunities AS opportunity
              ON opportunity.opportunity_id = scores.opportunity_id
             AND opportunity.status = 'active'
            WHERE scores.current_triage_eligible = 1
              AND (
                opportunity.opportunity_id IS NULL
                OR scores.opportunity_id NOT IN (SELECT value FROM json_each(?))
              )
          `).get(idsJson)?.count || 0);
          database.prepare(`
            UPDATE deal_hunter_opportunity_scores
            SET current_triage_eligible = CASE
              WHEN opportunity_id IN (
                SELECT requested.value
                FROM json_each(@opportunity_ids) AS requested
                JOIN deal_hunter_opportunities AS opportunity
                  ON opportunity.opportunity_id = requested.value
                 AND opportunity.status = 'active'
              ) THEN 1
              ELSE 0
            END
            WHERE current_triage_eligible <> CASE
              WHEN opportunity_id IN (
                SELECT requested.value
                FROM json_each(@opportunity_ids) AS requested
                JOIN deal_hunter_opportunities AS opportunity
                  ON opportunity.opportunity_id = requested.value
                 AND opportunity.status = 'active'
              ) THEN 1
              ELSE 0
            END
          `).run({ opportunity_ids: idsJson });
          return { activated, deactivated };
        });
        return transaction.immediate();
      },

      async listDealHunterOpportunityScoreFingerprints(opportunityIds = []) {
        const ids = normalizeList(opportunityIds, 100000);
        if (ids.length === 0) return [];
        const rows = [];
        for (let index = 0; index < ids.length; index += 500) {
          const batch = ids.slice(index, index + 500);
          rows.push(...database.prepare(`
            SELECT opportunity_id, score_fingerprint, semantic_digest, rules_version, engine_version,
                   profile_version, completeness_policy_version, reviewed_at
            FROM deal_hunter_opportunity_scores
            WHERE opportunity_id IN (${batch.map(() => '?').join(', ')})
          `).all(...batch));
        }
        return rows;
      },

      async listDealHunterContradictionEvidence(opportunityIds = []) {
        const ids = normalizeList(opportunityIds, 100000);
        if (ids.length === 0) return [];
        const rows = [];
        for (let index = 0; index < ids.length; index += 500) {
          const batch = ids.slice(index, index + 500);
          rows.push(...database.prepare(`
            SELECT opportunity_id, evidence_class, field, value, observed_value
            FROM deal_hunter_score_evidence
            WHERE evidence_class = 'contradicted'
              AND opportunity_id IN (${batch.map(() => '?').join(', ')})
          `).all(...batch));
        }
        return rows;
      },

      async listDealHunterScoreEvidence(opportunityId, { limit = 500 } = {}) {
        return database.prepare(`
          SELECT * FROM deal_hunter_score_evidence
          WHERE opportunity_id = ?
          ORDER BY dimension, evidence_class, rule_id
          LIMIT ?
        `).all(String(opportunityId || '').trim(), Math.max(1, Math.min(Number(limit) || 500, 5000)))
          .map(normalizeDealHunterScoreEvidenceRow);
      },

      async listDealHunterOpportunityScores({
        view = 'needs-review', page = 1, pageSize = 25, search = '', sort = 'fit-score', direction = 'desc',
        minScore = null, confidence = '', priority = '', state = '',
      } = {}) {
        const parsedPage = Number(page);
        const parsedPageSize = Number(pageSize);
        const safePage = Number.isFinite(parsedPage) ? Math.max(1, Math.min(Math.trunc(parsedPage), 10000)) : 1;
        const safePageSize = Number.isFinite(parsedPageSize) ? Math.max(1, Math.min(Math.trunc(parsedPageSize), 100)) : 25;
        const clauses = ['scores.current_triage_eligible = 1'];
        const params = [];

        // Dismissal stays owned by the existing disposition record rather than
        // being duplicated as another state column on the score row.
        const dismissedJoin = `
          JOIN deal_hunter_opportunities AS opportunity
            ON opportunity.opportunity_id = scores.opportunity_id
           AND opportunity.status = 'active'
          LEFT JOIN deal_hunter_dispositions AS disposition
            ON disposition.deal_key = scores.deal_key AND disposition.disposition = 'dismissed'
        `;
        if (view === 'dismissed') {
          clauses.push('disposition.deal_key IS NOT NULL');
        } else {
          clauses.push('disposition.deal_key IS NULL');
          if (view === 'needs-review') {
            clauses.push(`(scores.reviewed_at IS NULL OR (
              CASE WHEN scores.reviewed_semantic_digest IS NOT NULL
                THEN scores.reviewed_semantic_digest <> COALESCE(scores.semantic_digest, '')
                ELSE scores.reviewed_fingerprint IS NULL OR scores.reviewed_fingerprint <> scores.score_fingerprint
              END))`);
            clauses.push('scores.should_remove = 0');
          } else if (view === 'high-priority') {
            clauses.push("(scores.high_fit = 1 OR scores.operator_priority IN ('urgent', 'high'))");
            clauses.push('scores.should_remove = 0');
          } else if (view === 'watchlist') {
            clauses.push("((scores.fit_score >= 60 AND scores.fit_score < 75) OR scores.operator_priority = 'watch')");
            clauses.push('scores.should_remove = 0');
          } else if (view === 'low-confidence') {
            clauses.push("(scores.confidence = 'low' OR scores.contradiction_count > 0)");
            clauses.push('scores.should_remove = 0');
          }
        }

        const searchTerm = String(search || '').trim().toLowerCase();
        if (searchTerm) {
          clauses.push('(LOWER(COALESCE(scores.name, \'\')) LIKE ? OR LOWER(COALESCE(scores.deal_key, \'\')) LIKE ?)');
          params.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }
        if (Number.isFinite(Number(minScore)) && minScore !== null && minScore !== '') {
          clauses.push('scores.fit_score >= ?');
          params.push(Number(minScore));
        }
        if (confidence) {
          clauses.push('scores.confidence = ?');
          params.push(String(confidence));
        }
        if (priority) {
          clauses.push('scores.operator_priority = ?');
          params.push(String(priority));
        }
        if (state) {
          clauses.push('UPPER(COALESCE(scores.state, \'\')) = ?');
          params.push(String(state).toUpperCase());
        }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const safeDirection = String(direction || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        const sortColumns = {
          'acquisition-priority': `CASE WHEN scores.operator_priority IN ('urgent', 'high') THEN 1 ELSE 0 END DESC,
            CASE WHEN scores.high_fit = 1 AND (scores.reviewed_at IS NULL OR
              CASE WHEN scores.reviewed_semantic_digest IS NOT NULL
                THEN scores.reviewed_semantic_digest <> COALESCE(scores.semantic_digest, '')
                ELSE scores.reviewed_fingerprint IS NULL OR scores.reviewed_fingerprint <> scores.score_fingerprint
              END) THEN 1 ELSE 0 END DESC,
            scores.fit_score DESC,
            CASE scores.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
            COALESCE((SELECT MAX(observed_at) FROM deal_hunter_opportunity_source_observations AS freshness
              WHERE freshness.opportunity_id = scores.opportunity_id), scores.scored_at) DESC,
            scores.opportunity_id ASC`,
          'fit-score': 'scores.fit_score',
          confidence: "CASE scores.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
          completeness: 'scores.completeness_score',
          'scored-at': 'scores.scored_at',
          name: 'LOWER(COALESCE(scores.name, \'\'))',
          changed: `CASE WHEN scores.reviewed_at IS NULL THEN 1
            WHEN scores.reviewed_semantic_digest IS NOT NULL
              THEN CASE WHEN scores.reviewed_semantic_digest <> COALESCE(scores.semantic_digest, '') THEN 1 ELSE 0 END
            WHEN scores.reviewed_fingerprint IS NULL OR scores.reviewed_fingerprint <> scores.score_fingerprint THEN 1
            ELSE 0 END`,
        };
        const normalizedSort = String(sort || 'fit-score');
        const sortColumn = sortColumns[normalizedSort] || sortColumns['fit-score'];
        // opportunity_id is always the final key so pagination is stable when
        // rows tie on the requested sort.
        const orderBy = normalizedSort === 'acquisition-priority'
          ? `ORDER BY ${sortColumn}`
          : `ORDER BY ${sortColumn} ${safeDirection}, `
            + "CASE scores.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, "
            + 'scores.opportunity_id ASC';

        const total = Number(database.prepare(`
          SELECT COUNT(*) AS total FROM deal_hunter_opportunity_scores AS scores ${dismissedJoin} ${where}
        `).get(...params)?.total || 0);
        const summary = database.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN disposition.deal_key IS NULL AND scores.should_remove = 0 AND (
              scores.reviewed_at IS NULL OR CASE WHEN scores.reviewed_semantic_digest IS NOT NULL
                THEN scores.reviewed_semantic_digest <> COALESCE(scores.semantic_digest, '')
                ELSE scores.reviewed_fingerprint IS NULL OR scores.reviewed_fingerprint <> scores.score_fingerprint
              END
            ) THEN 1 ELSE 0 END), 0) AS needsReview,
            COALESCE(SUM(CASE WHEN disposition.deal_key IS NULL AND scores.should_remove = 0
              AND (scores.high_fit = 1 OR scores.operator_priority IN ('urgent', 'high')) THEN 1 ELSE 0 END), 0) AS highPriority,
            COALESCE(SUM(CASE WHEN disposition.deal_key IS NULL AND scores.should_remove = 0
              AND ((scores.fit_score >= 60 AND scores.fit_score < 75) OR scores.operator_priority = 'watch') THEN 1 ELSE 0 END), 0) AS watchlist,
            COALESCE(SUM(CASE WHEN disposition.deal_key IS NULL AND scores.should_remove = 0
              AND (scores.confidence = 'low' OR scores.contradiction_count > 0) THEN 1 ELSE 0 END), 0) AS lowConfidence,
            COALESCE(SUM(CASE WHEN disposition.deal_key IS NULL THEN 1 ELSE 0 END), 0) AS currentOpportunities
          FROM deal_hunter_opportunity_scores AS scores ${dismissedJoin}
          WHERE scores.current_triage_eligible = 1
        `).get() || {};
        const rows = database.prepare(`
          SELECT
            scores.opportunity_id, scores.deal_key, scores.name, scores.state, scores.listing_url,
            scores.fit_score, scores.score_status, scores.confidence, scores.completeness_score,
            scores.contradiction_count, scores.missing_evidence_count, scores.should_remove,
            scores.high_fit, scores.score_fingerprint, scores.semantic_digest, scores.scored_at,
            scores.rules_version, scores.operator_priority, scores.reviewed_at,
            scores.reviewed_by, scores.reviewed_fingerprint, scores.reviewed_semantic_digest,
            disposition.reason AS dismissed_reason, disposition.dismissed_at AS dismissed_at,
            json_extract(scores.summary, '$.strengths[0]') AS top_strength,
            json_extract(scores.summary, '$.concerns[0]') AS top_concern,
            (SELECT value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'industry'
              ORDER BY source.observed_at DESC, source.id ASC LIMIT 1) AS industry,
            (SELECT value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'location'
              ORDER BY source.observed_at DESC, source.id ASC LIMIT 1) AS location,
            (SELECT value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'annual_profit'
              ORDER BY source.observed_at DESC, source.id ASC LIMIT 1) AS annual_profit,
            (SELECT value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'annual_revenue'
              ORDER BY source.observed_at DESC, source.id ASC LIMIT 1) AS annual_revenue,
            (SELECT value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'asking_price'
              ORDER BY source.observed_at DESC, source.id ASC LIMIT 1) AS asking_price,
            (SELECT value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'profit_multiple'
              ORDER BY source.observed_at DESC, source.id ASC LIMIT 1) AS profit_multiple,
            (SELECT MAX(observed_at) FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id) AS observation_freshness,
            COALESCE((SELECT submission.status FROM contact_submissions AS submission
              WHERE submission.id = opportunity.primary_submission_id LIMIT 1), 'not-started') AS crm_status,
            COALESCE((SELECT cim.status FROM deal_hunter_cim_requests AS cim
              WHERE cim.opportunity_id = scores.opportunity_id
              ORDER BY cim.updated_at DESC, cim.id DESC LIMIT 1), 'not-requested') AS cim_status
          FROM deal_hunter_opportunity_scores AS scores
          ${dismissedJoin}
          ${where}
          ${orderBy}
          LIMIT ? OFFSET ?
        `).all(...params, safePageSize, (safePage - 1) * safePageSize).map(normalizeDealHunterOpportunityScoreRow);

        return { rows, total, summary, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
      },

      async listDealHunterFreshInbox({ area = 'inbox', cursor = null, limit = null,
        search = '', confidence = '', priority = '', state = '', sort = 'acquisition-priority',
        asOf = new Date().toISOString() } = {}) {
        const filters = { search: String(search || '').trim().toLowerCase().slice(0, 160),
          confidence: String(confidence || ''), priority: String(priority || ''),
          state: String(state || '').toUpperCase() };
        const clauses = ["scores.current_triage_eligible = 1", "scores.should_remove = 0",
          "opportunity.status = 'active'", 'disposition.deal_key IS NULL'];
        const params = [area === 'research' ? 1 : 0];
        if (filters.search) {
          clauses.push("(LOWER(COALESCE(scores.name, '')) LIKE ? OR LOWER(COALESCE(scores.deal_key, '')) LIKE ?)");
          params.push(`%${filters.search}%`, `%${filters.search}%`);
        }
        if (filters.confidence) { clauses.push('scores.confidence = ?'); params.push(filters.confidence); }
        if (filters.priority) { clauses.push('scores.operator_priority = ?'); params.push(filters.priority); }
        if (filters.state) { clauses.push("UPPER(COALESCE(scores.state, '')) = ?"); params.push(filters.state); }
        const publicationJoin = `FROM deal_hunter_opportunity_source_observations AS date_observation
          JOIN deal_hunter_freshness_evidence AS core ON core.id = date_observation.accepted_evidence_id
          JOIN deal_hunter_freshness_evidence AS publication
            ON publication.run_id = core.run_id AND publication.source_id = core.source_id
            AND publication.source_record_id = core.source_record_id
            AND publication.event_type = 'publication_evidence' AND publication.field_key = 'date_added'
          WHERE date_observation.opportunity_id = scores.opportunity_id
            AND date_observation.field = 'date_added'
            AND publication.current_canonical_id = scores.opportunity_id
            AND publication.publication_meaning = 'listing_publication'`;
        const query = database.prepare(`SELECT
          scores.opportunity_id, scores.fit_score, scores.confidence,
          scores.contradiction_count, scores.operator_priority,
          scores.reviewed_at, scores.reviewed_discovery_revision,
          scores.reviewed_material_revision, scores.score_fingerprint,
          scores.semantic_digest,
          (SELECT MAX(source.updated_at)
            FROM deal_hunter_opportunity_source_observations AS source
            WHERE source.opportunity_id = scores.opportunity_id) AS source_snapshot_updated_at,
          opportunity.first_accepted_at, opportunity.discovery_state,
          opportunity.discovery_revision, opportunity.material_revision,
          opportunity.last_material_change_at,
          NULL AS due_at,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT publication.publication_date ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) END AS publication_date,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT publication.publication_instant ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) END AS publication_instant,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT publication.publication_state ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) END AS publication_state,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT publication.source_name ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) END AS publication_source,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT publication.publication_precision ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) END AS publication_precision,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT COUNT(DISTINCT COALESCE(publication.publication_date,
              publication.publication_instant)) ${publicationJoin}
              AND publication.publication_state = 'valid') END AS publication_distinct_count,
          CASE WHEN opportunity.first_accepted_at IS NOT NULL
            AND opportunity.discovery_revision > scores.reviewed_discovery_revision
            THEN (SELECT COUNT(*) ${publicationJoin}
              AND publication.publication_state <> 'valid') END AS publication_unsupported_count,
          CASE WHEN ? = 1 THEN (SELECT COUNT(*) FROM (SELECT source.field
            FROM deal_hunter_opportunity_source_observations AS source
            WHERE source.opportunity_id = scores.opportunity_id
              AND source.field IN ('annual_profit', 'annual_revenue', 'asking_price')
            GROUP BY source.field HAVING COUNT(DISTINCT source.value) > 1))
            ELSE 0 END AS source_conflict_count,
          CASE WHEN opportunity.material_revision > scores.reviewed_material_revision
            THEN (SELECT event.field_key FROM deal_hunter_freshness_evidence AS event
            WHERE event.current_canonical_id = scores.opportunity_id
              AND event.event_type = 'material_change'
              AND event.material_revision = opportunity.material_revision
            ORDER BY event.accepted_at DESC, event.id LIMIT 1) END AS material_field
          FROM deal_hunter_opportunity_scores AS scores
          JOIN deal_hunter_opportunities AS opportunity ON opportunity.opportunity_id = scores.opportunity_id
          LEFT JOIN deal_hunter_dispositions AS disposition
            ON disposition.deal_key = scores.deal_key AND disposition.disposition = 'dismissed'
          WHERE ${clauses.join(' AND ')}`);
        return database.transaction(() => {
          const dueByOpportunity = new Map(database.prepare(`
            SELECT request.opportunity_id, MIN(request.next_follow_up_at) AS due_at
            FROM deal_hunter_cim_requests AS request
            JOIN deal_hunter_opportunities AS opportunity
              ON opportunity.opportunity_id = request.opportunity_id
                AND opportunity.primary_submission_id = request.submission_id
                AND opportunity.status = 'active'
            JOIN contact_submissions AS submission ON submission.id = request.submission_id
            WHERE request.follow_up_state = 'scheduled'
              AND request.request_state = 'provider_accepted'
              AND request.delivery_state = 'accepted'
              AND request.responded_at IS NULL AND request.follow_up_count < 5
              AND request.next_follow_up_at <= ? AND submission.status NOT IN ('archived', 'spam')
              AND NOT EXISTS (SELECT 1 FROM crm_submission_supersessions AS supersession
                WHERE supersession.superseded_submission_id = submission.id AND supersession.status = 'active')
              AND json_extract(request.metadata, '$.manualFollowUp.mode') = 'operator-approved'
              AND json_extract(request.metadata, '$.manualFollowUp.version') =
                'deal-hunter-manual-follow-up-v1'
              AND json_extract(request.metadata, '$.manualFollowUp.maximumFollowUps') = 5
              AND json_extract(request.metadata, '$.manualFollowUp.cadencePolicy') =
                'accepted-local-date-plus-2-weekend-forward-0900-pt-v1'
              AND json_extract(request.metadata, '$.manualFollowUp.stoppedAt') IS NULL
            GROUP BY request.opportunity_id
          `).all(asOf).map((row) => [row.opportunity_id, row.due_at]));
          const replyByOpportunity = new Map(database.prepare(`
            SELECT opportunity.opportunity_id, communication.occurred_at AS action_at
            FROM deal_hunter_opportunities AS opportunity
            JOIN contact_submissions AS submission ON submission.id = opportunity.primary_submission_id
            JOIN crm_communications AS communication ON communication.id = (
              SELECT latest.id FROM crm_communications AS latest
              WHERE latest.submission_id = submission.id
              ORDER BY latest.occurred_at DESC, latest.id DESC LIMIT 1)
            WHERE opportunity.status = 'active' AND submission.status NOT IN ('archived', 'spam')
              AND submission.follow_up_state <> 'completed'
              AND NOT EXISTS (SELECT 1 FROM crm_submission_supersessions AS supersession
                WHERE supersession.superseded_submission_id = submission.id AND supersession.status = 'active')
              AND communication.direction = 'inbound' AND communication.source = 'resend-webhook'
              AND communication.kind = 'broker-reply' AND communication.delivery_state = 'replied'
          `).all().map((row) => [row.opportunity_id, row.action_at]));
          const materialsByOpportunity = new Map(database.prepare(`
            SELECT opportunity.opportunity_id, MAX(material.action_at) AS action_at
            FROM deal_hunter_opportunities AS opportunity
            JOIN contact_submissions AS submission ON submission.id = opportunity.primary_submission_id
            JOIN (
              SELECT document.submission_id, document.created_at AS action_at
              FROM secure_documents AS document
              WHERE document.document_type IN ('cim','teaser','prospectus','offering_memorandum',
                'offering_materials','data_room','broker_materials','financials','financial_package',
                'financial_statements','p_and_l','tax_returns','balance_sheet')
              UNION ALL
              SELECT request.submission_id, COALESCE(request.last_uploaded_at, request.updated_at)
              FROM secure_upload_requests AS request
              WHERE request.status IN ('completed', 'documents-received')
                AND EXISTS (SELECT 1 FROM json_each(request.requested_documents) AS requested
                  WHERE (CASE WHEN requested.type = 'text' THEN requested.value
                    ELSE COALESCE(json_extract(requested.value, '$.category'),
                      json_extract(requested.value, '$.id')) END) IN
                    ('cim','teaser','prospectus','offering_memorandum','offering_materials',
                    'data_room','broker_materials','financials','financial_package',
                    'financial_statements','p_and_l','tax_returns','balance_sheet'))
            ) AS material ON material.submission_id = submission.id
            WHERE opportunity.status = 'active' AND submission.status NOT IN ('archived', 'spam')
              AND submission.follow_up_state <> 'completed'
              AND NOT EXISTS (SELECT 1 FROM crm_submission_supersessions AS supersession
                WHERE supersession.superseded_submission_id = submission.id AND supersession.status = 'active')
              AND COALESCE(json_extract(submission.metadata, '$.diligence.stage'), '')
                NOT IN ('financial-review','lender-review','loi-candidate')
              AND COALESCE(json_extract(submission.metadata, '$.acquisitionCommand.pipelineStage'), '')
                NOT IN ('diligence','loi-candidate')
            GROUP BY opportunity.opportunity_id
          `).all().map((row) => [row.opportunity_id, row.action_at]));
          const candidateRows = query.all(...params);
          const candidates = candidateRows.map((row) => ({ ...row,
            due_at: replyByOpportunity.get(row.opportunity_id)
              || materialsByOpportunity.get(row.opportunity_id)
              || dueByOpportunity.get(row.opportunity_id) || null,
            action_reason: replyByOpportunity.has(row.opportunity_id) ? 'broker_reply'
              : materialsByOpportunity.has(row.opportunity_id) ? 'materials_ready'
                : dueByOpportunity.has(row.opportunity_id) ? 'due_follow_up' : null,
            reviewed_discovery_revision: Number(row.reviewed_discovery_revision || 0),
            reviewed_material_revision: Number(row.reviewed_material_revision || 0),
          }));
          const result = buildFreshInboxAreas(candidates, { area, cursor, limit, asOf, filters, sort });
          const hydrate = database.prepare(`SELECT scores.*,
            opportunity.primary_submission_id,
            (SELECT MAX(source.accepted_at) FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id) AS latest_accepted_observation_at,
            (SELECT publication.publication_date ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) AS publication_date,
            (SELECT publication.publication_instant ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) AS publication_instant,
            (SELECT publication.publication_state ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) AS publication_state,
            (SELECT publication.source_name ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) AS publication_source,
            (SELECT publication.publication_precision ${publicationJoin}
              ORDER BY publication.accepted_at DESC, publication.id LIMIT 1) AS publication_precision,
            (SELECT COUNT(DISTINCT COALESCE(publication.publication_date,
              publication.publication_instant)) ${publicationJoin}
              AND publication.publication_state = 'valid') AS publication_distinct_count,
            (SELECT COUNT(*) ${publicationJoin}
              AND publication.publication_state <> 'valid') AS publication_unsupported_count,
            (SELECT COUNT(*) FROM (SELECT source.field
              FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id
                AND source.field IN ('annual_profit', 'annual_revenue', 'asking_price')
              GROUP BY source.field HAVING COUNT(DISTINCT source.value) > 1))
              AS source_conflict_count,
            (SELECT event.field_key FROM deal_hunter_freshness_evidence AS event
              JOIN deal_hunter_opportunities AS opportunity
                ON opportunity.opportunity_id = scores.opportunity_id
              WHERE event.current_canonical_id = scores.opportunity_id
                AND event.event_type = 'material_change'
                AND event.material_revision = opportunity.material_revision
              ORDER BY event.accepted_at DESC, event.id LIMIT 1) AS material_field,
            (SELECT event.before_value FROM deal_hunter_freshness_evidence AS event
              WHERE event.current_canonical_id = scores.opportunity_id
                AND event.event_type = 'material_change'
                AND event.material_revision = opportunity.material_revision
              ORDER BY event.accepted_at DESC, event.id LIMIT 1) AS material_before_value,
            (SELECT event.after_value FROM deal_hunter_freshness_evidence AS event
              WHERE event.current_canonical_id = scores.opportunity_id
                AND event.event_type = 'material_change'
                AND event.material_revision = opportunity.material_revision
              ORDER BY event.accepted_at DESC, event.id LIMIT 1) AS material_after_value,
            (SELECT event.currency FROM deal_hunter_freshness_evidence AS event
              WHERE event.current_canonical_id = scores.opportunity_id
                AND event.event_type = 'material_change'
                AND event.material_revision = opportunity.material_revision
              ORDER BY event.accepted_at DESC, event.id LIMIT 1) AS material_currency,
            (SELECT source.value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'industry'
              ORDER BY source.observed_at DESC, source.id LIMIT 1) AS industry,
            (SELECT source.value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'location'
              ORDER BY source.observed_at DESC, source.id LIMIT 1) AS location,
            (SELECT source.value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'annual_profit'
              ORDER BY source.observed_at DESC, source.id LIMIT 1) AS annual_profit,
            (SELECT json_object('metric', evidence.metric, 'period', evidence.period,
                'currency', evidence.currency)
              FROM deal_hunter_opportunity_source_observations AS source
              JOIN deal_hunter_freshness_evidence AS core ON core.id = source.accepted_evidence_id
              JOIN deal_hunter_freshness_evidence AS evidence ON evidence.run_id = core.run_id
                AND evidence.source_id = core.source_id
                AND evidence.source_record_id = core.source_record_id
                AND evidence.event_type = 'accepted_source_record'
                AND evidence.field_key = 'annual_profit'
                AND evidence.current_canonical_id = scores.opportunity_id
              WHERE source.id = (SELECT chosen.id FROM deal_hunter_opportunity_source_observations AS chosen
                WHERE chosen.opportunity_id = scores.opportunity_id AND chosen.field = 'annual_profit'
                ORDER BY chosen.observed_at DESC, chosen.id LIMIT 1)
                AND CAST(source.value AS REAL) = evidence.after_value
              LIMIT 1) AS annual_profit_evidence,
            (SELECT source.value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'annual_revenue'
              ORDER BY source.observed_at DESC, source.id LIMIT 1) AS annual_revenue,
            (SELECT source.value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'asking_price'
              ORDER BY source.observed_at DESC, source.id LIMIT 1) AS asking_price,
            (SELECT source.value FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id AND source.field = 'profit_multiple'
              ORDER BY source.observed_at DESC, source.id LIMIT 1) AS profit_multiple,
            COALESCE((SELECT MAX(source.observed_at)
              FROM deal_hunter_opportunity_source_observations AS source
              WHERE source.opportunity_id = scores.opportunity_id), scores.scored_at)
              AS observation_freshness,
            COALESCE((SELECT submission.status FROM contact_submissions AS submission
              JOIN deal_hunter_opportunities AS opportunity
                ON opportunity.primary_submission_id = submission.id
              WHERE opportunity.opportunity_id = scores.opportunity_id), 'not-started') AS crm_status
            FROM deal_hunter_opportunity_scores AS scores
            JOIN deal_hunter_opportunities AS opportunity
              ON opportunity.opportunity_id = scores.opportunity_id
            WHERE scores.opportunity_id = ?`);
          const hydrated = new Map();
          for (const row of result.areas.flatMap((item) => item.rows)) {
            if (hydrated.has(row.opportunity_id)) continue;
            const score = normalizeDealHunterOpportunityScoreRow(hydrate.get(row.opportunity_id));
            hydrated.set(row.opportunity_id, { ...score,
              top_strength: score.summary?.strengths?.[0] || '',
              top_concern: score.summary?.concerns?.[0] || '' });
          }
          return { ...result, areas: result.areas.map((item) => ({ ...item,
            rows: item.rows.map((row) => classifyFreshInboxCandidate(
              { ...row, ...hydrated.get(row.opportunity_id) }, asOf)) })) };
        }).deferred();
      },

      async listDealHunterCrmReconciliationItems(runId, { limit = 5000 } = {}) {
        return database.prepare(`
          SELECT * FROM deal_hunter_crm_reconciliation_items
          WHERE run_id = ? ORDER BY opportunity_id LIMIT ?
        `).all(runId, Math.max(1, Math.min(Number(limit) || 5000, 100000))).map(normalizeDealHunterCrmReconciliationItemRow);
      },

      async updateDealHunterCrmReconciliationItem(id, values = {}) {
        const fields = ['status', 'submission_id', 'error', 'updated_at', 'metadata'];
        updateRecord('deal_hunter_crm_reconciliation_items', id, values, fields, ['metadata']);
        return normalizeDealHunterCrmReconciliationItemRow(
          database.prepare('SELECT * FROM deal_hunter_crm_reconciliation_items WHERE id = ?').get(id),
        );
      },

      async updateDealHunterCrmReconciliationRun(id, values = {}) {
        const fields = ['updated_at', 'completed_at', 'status', 'counts', 'results', 'last_error', 'metadata'];
        updateRecord('deal_hunter_crm_reconciliation_runs', id, values, fields, ['counts', 'results', 'metadata']);
        return normalizeDealHunterCrmReconciliationRunRow(
          database.prepare('SELECT * FROM deal_hunter_crm_reconciliation_runs WHERE id = ?').get(id),
        );
      },

      async insertDealHunterCimReviews(reviews = []) {
        const safeReviews = Array.isArray(reviews) ? reviews.filter((review) => review?.id && review?.deal_key) : [];
        const statement = database.prepare(`
          INSERT INTO deal_hunter_cim_reviews (
            id, created_at, deal_key, decision, pass_reason, original_recipient_email,
            final_recipient_email, recipient_edited, score, actor, automation_stage, metadata,
            opportunity_id, snapshot_digest, evidence_version, rule_version,
            source_policy_version, source_policy_hash, source_ids, actor_role, decision_at
          ) VALUES (
            @id, @created_at, @deal_key, @decision, @pass_reason, @original_recipient_email,
            @final_recipient_email, @recipient_edited, @score, @actor, @automation_stage, @metadata,
            @opportunity_id, @snapshot_digest, @evidence_version, @rule_version,
            @source_policy_version, @source_policy_hash, @source_ids, @actor_role, @decision_at
          )
        `);
        const transaction = database.transaction((items) => items.forEach((review) => statement.run({
          ...review,
          recipient_edited: review.recipient_edited ? 1 : 0,
          opportunity_id: review.opportunity_id || null,
          snapshot_digest: review.snapshot_digest || null,
          evidence_version: review.evidence_version || null,
          rule_version: review.rule_version || null,
          source_policy_version: review.source_policy_version || null,
          source_policy_hash: review.source_policy_hash || null,
          source_ids: JSON.stringify(Array.isArray(review.source_ids) ? review.source_ids : []),
          actor_role: review.actor_role || null,
          decision_at: review.decision_at || review.created_at,
          metadata: JSON.stringify(review.metadata || {}),
        })));
        transaction(safeReviews);
        return safeReviews;
      },

      async listDealHunterCimReviews({ limit = 5000 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 100000));
        return database.prepare('SELECT * FROM deal_hunter_cim_reviews ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(safeLimit)
          .map((review) => ({
            ...review,
            recipient_edited: Boolean(review.recipient_edited),
            source_ids: parseJsonColumn(review.source_ids, []),
            metadata: parseJsonColumn(review.metadata, {}),
          }));
      },

      async listCimStage2MetricReviews({ limit = 5000 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 100000));
        return database.prepare(`
          SELECT id, created_at, deal_key, opportunity_id, decision, pass_reason,
            recipient_edited, score, actor, actor_role, automation_stage,
            snapshot_digest, evidence_version, rule_version, source_policy_version,
            source_policy_hash, source_ids, decision_at,
            json_extract(metadata, '$.source') AS review_source,
            json_extract(metadata, '$.stage2CohortEligible') AS cohort_eligible,
            json_extract(metadata, '$.outcome') AS response_outcome
          FROM deal_hunter_cim_reviews
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(safeLimit).map((review) => ({
          ...review,
          recipient_edited: Boolean(review.recipient_edited),
          source_ids: parseJsonColumn(review.source_ids, []),
          metadata: {
            source: review.review_source || '',
            stage2CohortEligible: Boolean(review.cohort_eligible),
            outcome: review.response_outcome || '',
          },
        }));
      },

      async getDealHunterAutomationSettings() {
        const row = database.prepare('SELECT * FROM deal_hunter_automation_settings WHERE id = ? LIMIT 1').get('cim-initial-outreach');
        return row ? { ...row, paused: Boolean(row.paused), metadata: parseJsonColumn(row.metadata, {}) } : null;
      },

      async upsertDealHunterAutomationSettings(settings = {}) {
        database.prepare(`
          INSERT INTO deal_hunter_automation_settings (id, updated_at, paused, updated_by, metadata)
          VALUES (@id, @updated_at, @paused, @updated_by, @metadata)
          ON CONFLICT(id) DO UPDATE SET
            updated_at = excluded.updated_at,
            paused = excluded.paused,
            updated_by = excluded.updated_by,
            metadata = excluded.metadata
        `).run({
          id: 'cim-initial-outreach',
          updated_at: settings.updated_at || new Date().toISOString(),
          paused: settings.paused ? 1 : 0,
          updated_by: settings.updated_by || '',
          metadata: JSON.stringify(settings.metadata || {}),
        });
        return this.getDealHunterAutomationSettings();
      },

      async checkCimStage2Storage() {
        const requiredTables = [
          'deal_hunter_cim_stage2_activations',
          'deal_hunter_cim_stage2_runs',
          'deal_hunter_cim_stage2_decisions',
        ];
        const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        const reviewColumns = new Set(database.prepare('PRAGMA table_info(deal_hunter_cim_reviews)').all().map((column) => column.name));
        const missingTables = requiredTables.filter((table) => !tables.has(table));
        const missingReviewColumns = [
          'opportunity_id', 'snapshot_digest', 'evidence_version', 'rule_version',
          'source_policy_version', 'source_policy_hash', 'source_ids', 'actor_role', 'decision_at',
        ].filter((column) => !reviewColumns.has(column));
        return { ok: missingTables.length === 0 && missingReviewColumns.length === 0, missingTables, missingReviewColumns };
      },

      async getCurrentCimStage2Activation() {
        return normalizeCimStage2ActivationRow(database.prepare(`
          SELECT * FROM deal_hunter_cim_stage2_activations
          WHERE status = 'current'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `).get());
      },

      async listCimStage2Activations({ limit = 50 } = {}) {
        return database.prepare(`
          SELECT * FROM deal_hunter_cim_stage2_activations
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(Math.max(1, Math.min(Number(limit) || 50, 500))).map(normalizeCimStage2ActivationRow);
      },

      async createCimStage2Activation(activation = {}) {
        const insert = database.prepare(`
          INSERT INTO deal_hunter_cim_stage2_activations (
            id, created_at, updated_at, status, mode, actor, reason, confirmation_phrase,
            policy_hash, rule_version, source_policy_version, source_policy_hash,
            evidence_checksum, evidence_generated_at, backup_reference, backup_checksum,
            identity_audit_reference, identity_audit_checksum, compliance_reference,
            sender_auth_reference, timezone, window_start, window_end, weekdays_only,
            canary_daily_cap, active_daily_cap, recipient_cap_24_hours,
            recipient_cap_30_days, expires_at, superseded_at, superseded_by, metadata
          ) VALUES (
            @id, @created_at, @updated_at, 'current', @mode, @actor, @reason, @confirmation_phrase,
            @policy_hash, @rule_version, @source_policy_version, @source_policy_hash,
            @evidence_checksum, @evidence_generated_at, @backup_reference, @backup_checksum,
            @identity_audit_reference, @identity_audit_checksum, @compliance_reference,
            @sender_auth_reference, @timezone, @window_start, @window_end, @weekdays_only,
            @canary_daily_cap, @active_daily_cap, @recipient_cap_24_hours,
            @recipient_cap_30_days, @expires_at, NULL, NULL, @metadata
          )
        `);
        const transaction = database.transaction((record) => {
          database.prepare(`
            UPDATE deal_hunter_cim_stage2_activations
            SET status = 'superseded', updated_at = ?, superseded_at = ?, superseded_by = ?
            WHERE status = 'current'
          `).run(record.created_at, record.created_at, record.actor);
          insert.run({
            ...record,
            updated_at: record.updated_at || record.created_at,
            weekdays_only: record.weekdays_only ? 1 : 0,
            metadata: JSON.stringify(record.metadata || {}),
          });
        });
        transaction(activation);
        return this.getCurrentCimStage2Activation();
      },

      async getCimStage2Run({ id = '', runKey = '' } = {}) {
        if (!id && !runKey) return null;
        return normalizeCimStage2RunRow(database.prepare(`
          SELECT * FROM deal_hunter_cim_stage2_runs
          WHERE id = ? OR run_key = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(id || '', runKey || ''));
      },

      async claimCimStage2Run(run = {}) {
        try {
          database.prepare(`
            INSERT INTO deal_hunter_cim_stage2_runs (
              id, run_key, created_at, updated_at, completed_at, pacific_business_date,
              mode, status, triggered_by, policy_hash, rule_version, source_policy_hash,
              activation_id, considered_count, eligible_count, would_send_count,
              attempted_count, accepted_count, failed_count, ambiguous_count,
              deferred_count, blocked_counts, last_error, metadata
            ) VALUES (
              @id, @run_key, @created_at, @updated_at, NULL, @pacific_business_date,
              @mode, @status, @triggered_by, @policy_hash, @rule_version, @source_policy_hash,
              @activation_id, 0, 0, 0, 0, 0, 0, 0, 0, '{}', NULL, @metadata
            )
          `).run({
            ...run,
            updated_at: run.updated_at || run.created_at,
            activation_id: run.activation_id || null,
            metadata: JSON.stringify(run.metadata || {}),
          });
          return { claimed: true, run: await this.getCimStage2Run({ id: run.id }) };
        } catch (error) {
          if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw error;
          return { claimed: false, run: await this.getCimStage2Run({ runKey: run.run_key }) };
        }
      },

      async updateCimStage2Run(id, updates = {}) {
        const current = await this.getCimStage2Run({ id });
        if (!current) return null;
        const next = { ...current, ...updates, id };
        database.prepare(`
          UPDATE deal_hunter_cim_stage2_runs SET
            updated_at = @updated_at, completed_at = @completed_at, status = @status,
            activation_id = @activation_id, considered_count = @considered_count,
            eligible_count = @eligible_count, would_send_count = @would_send_count,
            attempted_count = @attempted_count, accepted_count = @accepted_count,
            failed_count = @failed_count, ambiguous_count = @ambiguous_count,
            deferred_count = @deferred_count, blocked_counts = @blocked_counts,
            last_error = @last_error, metadata = @metadata
          WHERE id = @id
        `).run({
          ...next,
          completed_at: next.completed_at || null,
          activation_id: next.activation_id || null,
          blocked_counts: JSON.stringify(next.blocked_counts || {}),
          last_error: next.last_error || null,
          metadata: JSON.stringify(next.metadata || {}),
        });
        return this.getCimStage2Run({ id });
      },

      async listCimStage2Runs({ mode = '', policyHash = '', limit = 50 } = {}) {
        const clauses = [];
        const values = [];
        if (mode) { clauses.push('mode = ?'); values.push(mode); }
        if (policyHash) { clauses.push('policy_hash = ?'); values.push(policyHash); }
        values.push(Math.max(1, Math.min(Number(limit) || 50, 500)));
        return database.prepare(`
          SELECT * FROM deal_hunter_cim_stage2_runs
          ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(...values).map(normalizeCimStage2RunRow);
      },

      async insertCimStage2Decisions(decisions = []) {
        const safe = Array.isArray(decisions) ? decisions.slice(0, 500) : [];
        const statement = database.prepare(`
          INSERT OR IGNORE INTO deal_hunter_cim_stage2_decisions (
            id, run_id, created_at, updated_at, opportunity_id, deal_key, decision_state,
            policy_hash, rule_version, source_policy_hash, activation_id, snapshot_digest,
            recipient_hash, source_snapshot_digest, reasons, claim_token, claimed_at,
            consumed_at, cim_request_id, communication_id, provider_state, last_error, metadata
          ) VALUES (
            @id, @run_id, @created_at, @updated_at, @opportunity_id, @deal_key, @decision_state,
            @policy_hash, @rule_version, @source_policy_hash, @activation_id, @snapshot_digest,
            @recipient_hash, @source_snapshot_digest, @reasons, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, @metadata
          )
        `);
        database.transaction((items) => items.forEach((item) => statement.run({
          ...item,
          updated_at: item.updated_at || item.created_at,
          activation_id: item.activation_id || null,
          reasons: JSON.stringify(item.reasons || []),
          metadata: JSON.stringify(item.metadata || {}),
        })))(safe);
        return this.listCimStage2Decisions({ runId: safe[0]?.run_id || '', limit: 500 });
      },

      async getCimStage2Decision(id) {
        return normalizeCimStage2DecisionRow(database.prepare(`
          SELECT * FROM deal_hunter_cim_stage2_decisions WHERE id = ? LIMIT 1
        `).get(id));
      },

      async listCimStage2Decisions({ runId = '', opportunityId = '', state = '', limit = 100, offset = 0 } = {}) {
        const clauses = [];
        const values = [];
        if (runId) { clauses.push('run_id = ?'); values.push(runId); }
        if (opportunityId) { clauses.push('opportunity_id = ?'); values.push(opportunityId); }
        if (state) { clauses.push('decision_state = ?'); values.push(state); }
        values.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
        values.push(Math.max(0, Math.min(Number(offset) || 0, 10000)));
        return database.prepare(`
          SELECT * FROM deal_hunter_cim_stage2_decisions
          ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
        `).all(...values).map(normalizeCimStage2DecisionRow);
      },

      async claimCimStage2Decision({ id = '', claimToken = '', claimedAt = '', activationId = '' } = {}) {
        try {
          const result = database.prepare(`
            UPDATE deal_hunter_cim_stage2_decisions
            SET decision_state = 'claimed', claim_token = ?, claimed_at = ?, updated_at = ?, activation_id = ?
            WHERE id = ? AND decision_state = 'eligible' AND claim_token IS NULL
          `).run(claimToken, claimedAt, claimedAt, activationId || null, id);
          return { claimed: result.changes === 1, decision: await this.getCimStage2Decision(id) };
        } catch (error) {
          if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
          return { claimed: false, decision: await this.getCimStage2Decision(id) };
        }
      },

      async transitionCimStage2Decision({ id = '', expectedStates = [], state = '', updates = {} } = {}) {
        const current = await this.getCimStage2Decision(id);
        if (!current || !expectedStates.includes(current.decision_state)) return { applied: false, decision: current };
        const next = { ...current, ...updates, decision_state: state, updated_at: updates.updated_at || new Date().toISOString() };
        const result = database.prepare(`
          UPDATE deal_hunter_cim_stage2_decisions SET
            updated_at = @updated_at, decision_state = @decision_state, activation_id = @activation_id,
            claim_token = @claim_token, claimed_at = @claimed_at, consumed_at = @consumed_at,
            cim_request_id = @cim_request_id, communication_id = @communication_id,
            provider_state = @provider_state, last_error = @last_error, reasons = @reasons,
            metadata = @metadata
          WHERE id = @id AND decision_state = @expected_state
        `).run({
          ...next,
          expected_state: current.decision_state,
          activation_id: next.activation_id || null,
          claim_token: next.claim_token || null,
          claimed_at: next.claimed_at || null,
          consumed_at: next.consumed_at || null,
          cim_request_id: next.cim_request_id || null,
          communication_id: next.communication_id || null,
          provider_state: next.provider_state || null,
          last_error: next.last_error || null,
          reasons: JSON.stringify(next.reasons || []),
          metadata: JSON.stringify(next.metadata || {}),
        });
        return { applied: result.changes === 1, decision: await this.getCimStage2Decision(id) };
      },

      async countCimStage2Capacity({ pacificBusinessDate = '' } = {}) {
        return Number(database.prepare(`
          SELECT COUNT(*) AS count
          FROM deal_hunter_cim_stage2_decisions AS decision
          JOIN deal_hunter_cim_stage2_runs AS run ON run.id = decision.run_id
          WHERE run.pacific_business_date = ?
            AND run.mode IN ('canary', 'active')
            AND decision.decision_state IN ('claimed', 'attempting', 'accepted', 'failed', 'ambiguous')
        `).get(pacificBusinessDate)?.count || 0);
      },

	    async claimDealHunterCrmImport(record = {}, { pendingCutoff = '' } = {}) {
	      if (!canonicalCrmOwnershipHealthy) {
          throw new Error('Canonical CRM ownership has duplicate opportunity claims. Run the integrity audit before reconciliation.');
        }
	      return claimDealHunterCrmImportTransaction.immediate({ record, pendingCutoff });
	    },

	    async updateDealHunterCrmImport(id, values = {}) {
	      if (!id) {
	        return null;
	      }

	      return updateDealHunterCrmImportTransaction.immediate({ id, values });
	    },

    async inspectCrmDuplicateConsolidation() {
      return inspectCrmDuplicateConsolidation(database, null, crmDuplicateConsolidationConfigAuthority);
    },

    async inspectCrmDuplicateConsolidationRuntimeSafety() {
      return inspectCrmDuplicateConsolidationRuntimeSafety(database, {
        configAuthority: crmDuplicateConsolidationConfigAuthority,
      });
    },

    getCrmDuplicateConsolidationConfigAuthority() {
      return crmDuplicateConsolidationConfigAuthority;
    },

    async verifyCrmDuplicateConsolidationBackupPlan({ artifact, backup } = {}) {
      const backupPath = path.resolve(String(backup?.path || ''));
      const before = fs.statSync(backupPath, { bigint: true });
      const bytes = fs.readFileSync(backupPath);
      const after = fs.statSync(backupPath, { bigint: true });
      if (!before.isFile()
        || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((field) => before[field] !== after[field])
        || createHash('sha256').update(bytes).digest('hex') !== backup?.sha256) {
        throw new Error('Apply refused: backup path or SHA changed during verification.');
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (fs.existsSync(`${backupPath}${suffix}`)) {
          throw new Error('Apply refused: backup has an unverified SQLite sidecar.');
        }
      }
      const snapshotBytes = Buffer.from(bytes);
      snapshotBytes[18] = 1;
      snapshotBytes[19] = 1;
      const snapshot = new Database(snapshotBytes);
      try {
        snapshot.pragma('query_only = ON');
        const inspection = inspectCrmDuplicateConsolidation(snapshot, {
          readonly: true,
          fileMustExist: true,
          queryOnly: true,
          consistentReadTransaction: true,
        }, artifact.plan.runtimeSafetyAuthority?.config);
        if (inspection.blockers.length) {
          throw new Error(`backup inspection blockers: ${inspection.blockers.join(', ')}`);
        }
        const planned = buildCrmDuplicateConsolidationPlan({
          inspection,
          actor: artifact.plan.actor,
          reason: artifact.plan.reason,
          executionRelease: artifact.plan.execution.release,
          toolingRevision: artifact.plan.execution.toolingRevision,
          recoveryCheckpoint: {
            ...artifact.plan.recoveryCheckpoint,
            backupPath: artifact.recoveryCheckpointPath,
          },
        });
        if (planned.planChecksum !== artifact.planChecksum
          || inspection.database.authorityLogicalDigest !== artifact.plan.database.authorityLogicalDigest
          || inspection.schema.digest !== artifact.plan.schema.digest) {
          throw new Error('backup does not reproduce the reviewed V3 plan and authoritative database digest');
        }
        const verification = Object.freeze({
          planChecksum: planned.planChecksum,
          databaseAuthorityLogicalDigest: inspection.database.authorityLogicalDigest,
          schemaDigest: inspection.schema.digest,
        });
        crmDuplicateConsolidationBackupVerifications.set(verification, {
          verifiedAtMs: Date.now(),
          backupPath,
          backupSha256: backup.sha256,
          backupIdentity: stableCrmDuplicateConsolidationJson(backup),
          artifactIdentity: stableCrmDuplicateConsolidationJson({
            manifestId: artifact.manifestId,
            planChecksum: artifact.planChecksum,
            recoveryCheckpointPath: artifact.recoveryCheckpointPath,
            recoveryCheckpoint: artifact.plan.recoveryCheckpoint,
          }),
          fileIdentity: Object.fromEntries(
            ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((field) => [field, before[field]]),
          ),
        });
        return verification;
      } finally {
        snapshot.close();
      }
    },

    async applyCrmDuplicateConsolidation({
      artifact,
      backup,
      confirmation,
      backupVerification,
      actor,
      reason,
      executionRelease,
      toolingRevision,
      nowIso,
      testHooks = null,
    } = {}) {
      if (confirmation !== CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION) {
        throw new Error('CRM duplicate consolidation transaction requires the exact confirmation phrase.');
      }
      const verifiedAuthority = backupVerification && typeof backupVerification === 'object'
        ? crmDuplicateConsolidationBackupVerifications.get(backupVerification)
        : null;
      if (!verifiedAuthority) {
        throw new Error('CRM duplicate consolidation transaction requires fresh non-forgeable verified backup evidence.');
      }
      crmDuplicateConsolidationBackupVerifications.delete(backupVerification);
      const artifactIdentity = stableCrmDuplicateConsolidationJson({
        manifestId: artifact?.manifestId,
        planChecksum: artifact?.planChecksum,
        recoveryCheckpointPath: artifact?.recoveryCheckpointPath,
        recoveryCheckpoint: artifact?.plan?.recoveryCheckpoint,
      });
      if (verifiedAuthority.artifactIdentity !== artifactIdentity
        || verifiedAuthority.backupIdentity !== stableCrmDuplicateConsolidationJson(backup)
        || backupVerification.planChecksum !== artifact?.planChecksum
        || Date.now() - verifiedAuthority.verifiedAtMs > 5 * 60 * 1000) {
        throw new Error('CRM duplicate consolidation verified backup evidence is stale or bound to different authority.');
      }
      const backupPath = path.resolve(String(backup?.path || ''));
      let backupBefore;
      let backupBytes;
      let backupAfter;
      try {
        backupBefore = fs.statSync(backupPath, { bigint: true });
        backupBytes = fs.readFileSync(backupPath);
        backupAfter = fs.statSync(backupPath, { bigint: true });
      } catch (error) {
        throw new Error(`CRM duplicate consolidation verified backup is unavailable: ${error.message}`);
      }
      const identityFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
      if (!backupBefore.isFile()
        || backupPath !== verifiedAuthority.backupPath
        || identityFields.some((field) => (
          backupBefore[field] !== backupAfter[field]
          || backupBefore[field] !== verifiedAuthority.fileIdentity[field]
        ))
        || createHash('sha256').update(backupBytes).digest('hex') !== verifiedAuthority.backupSha256
        || ['-wal', '-shm', '-journal'].some((suffix) => fs.existsSync(`${backupPath}${suffix}`))) {
        throw new Error('CRM duplicate consolidation verified backup evidence changed before transaction entry.');
      }
      const transaction = database.transaction(() => {
        const currentRuntimeSafetyAuthority = crmDuplicateConsolidationRuntimeSafety(
          database,
          crmDuplicateConsolidationConfigAuthority,
        );
        assertCrmDuplicateConsolidationRuntimeSafetyAuthorityMatches(
          currentRuntimeSafetyAuthority,
          artifact.plan.runtimeSafetyAuthority,
        );
        const existingReceipt = normalizeDealHunterRepairManifestRow(database.prepare(`
          SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ? LIMIT 1
        `).get(artifact.manifestId));
        if (existingReceipt) {
          const finalState = crmDuplicateConsolidationFinalState(database, {
            artifact, actor, reason, backup,
          });
          assertCrmDuplicateConsolidationProtectedTables(
            database, artifact.plan.authorityTableDigests, 'replay protected-table drift',
          );
          return {
            status: 'verified-prior-apply',
            mode: 'apply',
            applied: false,
            mutationCount: 0,
            mutations: [],
            manifestId: artifact.manifestId,
            planChecksum: artifact.planChecksum,
            finalState,
          };
        }

        const inspection = inspectCrmDuplicateConsolidationState(database, {
          connection: {
            readonly: false,
            fileMustExist: true,
            queryOnly: false,
            consistentReadTransaction: true,
          },
          configAuthority: crmDuplicateConsolidationConfigAuthority,
        });
        if (inspection.blockers.length) {
          throw new Error(`Apply refused: partial, satisfied-without-receipt, or unsafe state (${inspection.blockers.join(', ')}).`);
        }
        const planned = buildCrmDuplicateConsolidationPlan({
          inspection,
          actor,
          reason,
          executionRelease,
          toolingRevision,
          recoveryCheckpoint: {
            ...artifact.plan.recoveryCheckpoint,
            backupPath: artifact.recoveryCheckpointPath,
          },
        });
        if (planned.manifestId !== artifact.manifestId
          || planned.planChecksum !== artifact.planChecksum
          || inspection.database.authorityLogicalDigest !== artifact.plan.database.authorityLogicalDigest
          || inspection.schema.digest !== artifact.plan.schema.digest
          || stableCrmDuplicateConsolidationJson(inspection.rawRows)
            !== stableCrmDuplicateConsolidationJson(artifact.plan.rawRows)) {
          throw new Error('Apply refused: live raw-row, schema, authoritative database, or reviewed plan drift.');
        }

        const receiptManifest = {
          repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
          repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
          manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
          approvalSchema: artifact.approvalSchema,
          manifestId: artifact.manifestId,
          planChecksum: artifact.planChecksum,
          actor,
          reason,
          backup,
          artifact,
          appliedAt: nowIso,
          mutationCount: 4,
        };
        const receiptMetadata = {
          repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
          repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
          manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
          approvalSchema: artifact.approvalSchema,
          planChecksum: artifact.planChecksum,
          pairKeys: ['pooler', 'berlin'],
          berlinPriorSubmissionId: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.beforeSubmissionId,
        };
        const receiptInsert = database.prepare(`
          INSERT INTO deal_hunter_cim_repair_manifests (
            id, created_at, updated_at, mode, status, actor,
            backup_reference, checksum, manifest, metadata
          ) VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)
        `).run(
          artifact.manifestId,
          nowIso,
          nowIso,
          CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
          actor,
          backup.path,
          artifact.planChecksum,
          stableCrmDuplicateConsolidationJson(receiptManifest),
          stableCrmDuplicateConsolidationJson(receiptMetadata),
        );
        if (receiptInsert.changes !== 1) throw new Error('CRM duplicate consolidation receipt insert was not exact.');
        if (testHooks?.failAfterWrite === 1) throw new Error('Injected failure after write 1.');

        let writeNumber = 1;
        for (const pair of CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs) {
          const relationInsert = database.prepare(`
            INSERT INTO crm_submission_supersessions (
              id, created_at, updated_at, status, survivor_submission_id,
              superseded_submission_id, opportunity_id, reason_code, reason_text,
              approved_by, approved_at, actor, repair_version, repair_manifest_id,
              repair_digest, reversed_at, reversed_by, reversal_reason,
              reversal_manifest_id, metadata
            ) VALUES (
              ?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', ?,
              ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?
            )
          `).run(
            crmDuplicateConsolidationRelationId(pair),
            nowIso,
            nowIso,
            pair.survivorSubmissionId,
            pair.supersededSubmissionId,
            pair.opportunityId,
            reason,
            CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.approvedBy,
            CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.approvedAt,
            actor,
            CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
            artifact.manifestId,
            artifact.planChecksum,
            stableCrmDuplicateConsolidationJson({
              schema: 'crm-submission-supersession-metadata-v1',
              pairKey: pair.key,
              listingIdentity: pair.listingIdentity,
              manifestId: artifact.manifestId,
            }),
          );
          if (relationInsert.changes !== 1) {
            throw new Error(`CRM duplicate consolidation ${pair.key} relation insert was not exact.`);
          }
          writeNumber += 1;
          if (testHooks?.failAfterWrite === writeNumber) {
            throw new Error(`Injected failure after write ${writeNumber}.`);
          }
        }

        const berlinBefore = database.prepare(`
          SELECT * FROM deal_hunter_crm_imports WHERE id = ? LIMIT 1
        `).get(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id);
        if (crmDuplicateConsolidationRawDigest(berlinBefore)
          !== artifact.plan.currentState.berlinImport.rawDigest) {
          throw new Error('Apply refused: Berlin import raw-row digest changed before compare-and-set.');
        }
        if (testHooks?.forceBerlinCasConflict === true) {
          database.prepare('UPDATE deal_hunter_crm_imports SET submission_id = ? WHERE id = ?')
            .run('__TASK8_TEST_CAS_CONFLICT__', CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id);
        }
        const priorMetadata = berlinBefore.metadata;
        const nextMetadata = {
          ...parseCrmDuplicateConsolidationMetadata(priorMetadata),
          crmDuplicateConsolidation: {
            schema: 'crm-duplicate-consolidation-import-provenance-v1',
            manifestId: artifact.manifestId,
            planChecksum: artifact.planChecksum,
            priorSubmissionId: berlinBefore.submission_id,
            priorUpdatedAt: berlinBefore.updated_at,
            priorMetadataDigest: canonicalJsonSha256(priorMetadata || '{}'),
          },
        };
        const berlinUpdate = database.prepare(`
          UPDATE deal_hunter_crm_imports
          SET submission_id = ?, updated_at = ?, metadata = ?
          WHERE id = ?
            AND submission_id = ?
            AND opportunity_id IS NULL
            AND updated_at = ?
            AND metadata = ?
        `).run(
          CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.afterSubmissionId,
          nowIso,
          JSON.stringify(nextMetadata),
          CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.id,
          CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport.beforeSubmissionId,
          berlinBefore.updated_at,
          priorMetadata,
        );
        if (berlinUpdate.changes !== 1) {
          throw new Error('Apply refused: Berlin import compare-and-set did not change exactly one row.');
        }
        if (testHooks?.failAfterWrite === 4) throw new Error('Injected failure after write 4.');

        if (testHooks?.dropReversalGuardBeforePostconditions === true) {
          database.exec('DROP TRIGGER trg_crm_submission_supersessions_reverse_only');
        }

        const finalState = crmDuplicateConsolidationFinalState(database, {
          artifact, actor, reason, backup,
        });
        assertCrmDuplicateConsolidationProtectedTables(
          database, artifact.plan.authorityTableDigests, 'prohibited-table postcondition failed',
        );
        if (testHooks?.forcePostconditionFailure === true) {
          throw new Error('Injected postcondition failure.');
        }
        return {
          status: 'repair-required',
          mode: 'apply',
          applied: true,
          mutationCount: 4,
          mutations: CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER,
          manifestId: artifact.manifestId,
          planChecksum: artifact.planChecksum,
          finalState,
        };
      });
      return transaction.immediate();
    },

    async inspectDealHunterCanonicalOpportunityMerge({ approval, actor = '', reason = '' } = {}) {
      return inspectCanonicalOpportunityMerge(database, { approval, actor, reason });
    },

    async verifyDealHunterCanonicalOpportunityMergeBackupPlan({
      approval,
      actor = '',
      reason = '',
      backupEvidence = null,
      expectedPlanChecksum = '',
    } = {}) {
      const checkedApproval = checkedCanonicalOpportunityMergeApproval(approval);
      try {
        const bundlePath = fs.realpathSync(path.resolve(String(backupEvidence?.path || '')));
        const relativePath = String(backupEvidence?.databaseRelativePath || '');
        const resolvedDatabasePath = path.resolve(bundlePath, relativePath);
        if (!resolvedDatabasePath.startsWith(`${bundlePath}${path.sep}`)) {
          throw new Error('database snapshot resolves outside the verified bundle');
        }
        const databasePath = fs.realpathSync(resolvedDatabasePath);
        if (!databasePath.startsWith(`${bundlePath}${path.sep}`)) {
          throw new Error('database snapshot escapes the verified bundle through a symbolic link');
        }
        const snapshotStat = fs.statSync(databasePath);
        if (!snapshotStat.isFile() || snapshotStat.size !== backupEvidence?.databaseSizeBytes) {
          throw new Error('database snapshot size no longer matches verified evidence');
        }
        const snapshotDigest = await sha256CanonicalMergeFile(databasePath);
        const snapshotStatAfterHash = fs.statSync(databasePath);
        if (
          snapshotDigest !== backupEvidence?.databaseSha256
          || snapshotStatAfterHash.dev !== snapshotStat.dev
          || snapshotStatAfterHash.ino !== snapshotStat.ino
          || snapshotStatAfterHash.size !== snapshotStat.size
          || snapshotStatAfterHash.mtimeMs !== snapshotStat.mtimeMs
        ) {
          throw new Error('database snapshot checksum changed after backup verification');
        }
        const sidecarSuffixes = ['-wal', '-shm', '-journal'];
        const unexpectedSidecars = sidecarSuffixes.filter((suffix) => fs.existsSync(`${databasePath}${suffix}`));
        if (unexpectedSidecars.length > 0) {
          throw new Error(`verified database snapshot has unverified SQLite sidecars: ${unexpectedSidecars.join(', ')}`);
        }
        const snapshotBuffer = fs.readFileSync(databasePath);
        const snapshotStatAfterRead = fs.statSync(databasePath);
        if (
          createHash('sha256').update(snapshotBuffer).digest('hex') !== backupEvidence.databaseSha256
          || snapshotStatAfterRead.dev !== snapshotStat.dev
          || snapshotStatAfterRead.ino !== snapshotStat.ino
          || snapshotStatAfterRead.size !== snapshotStat.size
          || snapshotStatAfterRead.mtimeMs !== snapshotStat.mtimeMs
          || sidecarSuffixes.some((suffix) => fs.existsSync(`${databasePath}${suffix}`))
        ) {
          throw new Error('database snapshot changed while loading verified in-memory evidence');
        }
        const inMemorySnapshot = Buffer.from(snapshotBuffer);
        inMemorySnapshot[18] = 1;
        inMemorySnapshot[19] = 1;
        const backupDatabase = new Database(inMemorySnapshot);
        try {
          backupDatabase.pragma('query_only = ON');
          assertCanonicalOpportunityMergeSqliteSchema(backupDatabase);
          const quickCheck = String(backupDatabase.pragma('quick_check', { simple: true }) || '');
          if (quickCheck !== 'ok') throw new Error(`SQLite quick_check returned ${quickCheck || 'no result'}`);
          const backupPause = backupDatabase.prepare(`
            SELECT updated_at, outreach_paused
            FROM deal_hunter_cim_safety_settings WHERE id = 'global' LIMIT 1
          `).get();
          if (!backupPause || Number(backupPause.outreach_paused) !== 1 || !Number.isFinite(Date.parse(backupPause.updated_at))) {
            throw new Error('database snapshot does not contain an active global CIM outreach pause');
          }
          const inspection = inspectCanonicalOpportunityMergeState(backupDatabase, checkedApproval);
          const plan = buildCanonicalOpportunityMergePlan({
            approval: checkedApproval,
            inspection,
            actor,
            reason,
          });
          if (plan.planChecksum !== expectedPlanChecksum) {
            throw new Error('database snapshot plan checksum differs from the reviewed plan');
          }
          return { planChecksum: plan.planChecksum, pauseUpdatedAt: backupPause.updated_at };
        } finally {
          backupDatabase.close();
        }
      } catch (error) {
        throw new Error(`Apply refused: verified SQLite backup does not reproduce the reviewed pre-merge plan: ${error.message}`);
      }
    },

    async applyDealHunterCanonicalOpportunityMerge({
      approval,
      actor = '',
      reason = '',
      confirmation = '',
      expectedPlanChecksum = '',
      backupEvidence = null,
      nowIso = '',
    } = {}) {
      const checkedApproval = checkedCanonicalOpportunityMergeApproval(approval);
      if (confirmation !== (checkedApproval.confirmation || CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION)) {
        throw new Error('Canonical opportunity merge transaction requires the exact confirmation phrase.');
      }
      if (!/^[a-f0-9]{64}$/.test(String(expectedPlanChecksum || ''))) {
        throw new Error('Canonical opportunity merge transaction requires an exact plan checksum.');
      }
      if (
        backupEvidence?.provider !== 'sqlite'
        || !String(backupEvidence.path || '').trim()
        || !/^[a-f0-9]{64}$/.test(String(backupEvidence.databaseSha256 || ''))
        || backupEvidence.reviewedPlanChecksum !== expectedPlanChecksum
        || !Number.isFinite(Date.parse(backupEvidence.pauseUpdatedAt))
      ) {
        throw new Error('Canonical opportunity merge transaction requires verified SQLite backup evidence.');
      }
      if (!Number.isFinite(Date.parse(nowIso))) {
        throw new Error('Canonical opportunity merge transaction requires a valid audit timestamp.');
      }
      const transaction = database.transaction(() => {
        assertCanonicalOpportunityMergeSqliteSchema(database);
        const pause = database.prepare(`
          SELECT * FROM deal_hunter_cim_safety_settings WHERE id = 'global' LIMIT 1
        `).get();
        if (!pause || Number(pause.outreach_paused) !== 1) {
          throw new Error('Apply refused: global Deal Hunter CIM outreach must already be paused.');
        }
        if (pause.updated_at !== backupEvidence.pauseUpdatedAt) {
          throw new Error('Apply refused: the verified backup does not contain the active outreach-pause epoch.');
        }
        const manifestId = canonicalOpportunityMergeManifestId(checkedApproval);
        const existingManifest = normalizeDealHunterRepairManifestRow(database.prepare(`
          SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ? LIMIT 1
        `).get(manifestId));
        if (existingManifest) {
          const replay = validateCanonicalOpportunityMergeReplayManifest({
            approval: checkedApproval,
            manifest: existingManifest,
            actor,
            reason,
            expectedPlanChecksum,
          });
          const finalState = validateCanonicalMergeFinalState(database, {
            approval: checkedApproval,
            actor: replay.actor,
            reason: replay.reason,
            planChecksum: replay.planChecksum,
            manifestId: replay.manifestId,
          });
          return {
            ok: true,
            mode: 'apply',
            applied: false,
            alreadyApplied: true,
            planChecksum: replay.planChecksum,
            movedAliasCount: 0,
            manifestId: replay.manifestId,
            manifest: finalState.manifest,
            finalState,
          };
        }

        const inspection = inspectCanonicalOpportunityMergeState(database, checkedApproval);
        const planned = buildCanonicalOpportunityMergePlan({
          approval: checkedApproval,
          inspection,
          actor,
          reason,
        });
        if (planned.planChecksum !== expectedPlanChecksum) {
          throw new Error('Apply refused: the dry-run plan checksum is stale or does not match current state.');
        }

        for (const move of planned.plan.aliasMoves) {
          const result = database.prepare(`
            UPDATE deal_hunter_opportunity_aliases
            SET opportunity_id = ?
            WHERE alias_key = ?
              AND alias_type = ?
              AND alias_value = ?
              AND opportunity_id = ?
          `).run(
            checkedApproval.survivorId,
            move.aliasKey,
            move.aliasType,
            move.aliasValue,
            checkedApproval.supersededId,
          );
          if (result.changes !== 1) {
            throw new Error(`Canonical opportunity merge alias changed after planning: ${move.aliasKey}.`);
          }
        }

        assertCanonicalMergeAliasPostconditions(database, checkedApproval);

        const supersededBefore = planned.plan.opportunities.superseded;
        const supersededMetadata = {
          ...(supersededBefore.metadata || {}),
          canonicalOpportunityMerge: {
            repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
            schemaVersion: 1,
            mergedInto: checkedApproval.survivorId,
            supersededOpportunityId: checkedApproval.supersededId,
            exceptionId: checkedApproval.exceptionId,
            actor: planned.actor,
            reason: planned.reason,
            planChecksum: planned.planChecksum,
            supersededAt: nowIso,
          },
        };
        const supersededUpdate = database.prepare(`
          UPDATE deal_hunter_opportunities
          SET status = 'superseded', updated_at = ?, metadata = ?
          WHERE opportunity_id = ? AND status = 'active' AND updated_at = ?
        `).run(
          nowIso,
          JSON.stringify(supersededMetadata),
          checkedApproval.supersededId,
          supersededBefore.updated_at,
        );
        if (supersededUpdate.changes !== 1) {
          throw new Error('Canonical opportunity merge loser changed before supersession.');
        }

        const exceptionBefore = planned.plan.identityException;
        const exceptionMetadata = {
          ...(exceptionBefore.metadata || {}),
          canonicalOpportunityMerge: {
            repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
            schemaVersion: 1,
            decision: 'merge',
            survivorId: checkedApproval.survivorId,
            supersededId: checkedApproval.supersededId,
            planChecksum: planned.planChecksum,
          },
        };
        const exceptionUpdate = database.prepare(`
          UPDATE deal_hunter_identity_exceptions
          SET updated_at = ?, status = 'resolved', resolved_at = ?, resolved_by = ?,
              resolution_reason = ?, metadata = ?
          WHERE id = ? AND status = 'open' AND updated_at = ?
            AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL
        `).run(
          nowIso,
          nowIso,
          planned.actor,
          planned.reason,
          JSON.stringify(exceptionMetadata),
          checkedApproval.exceptionId,
          exceptionBefore.updated_at,
        );
        if (exceptionUpdate.changes !== 1) {
          throw new Error('Canonical opportunity merge exception changed before resolution.');
        }

        const manifestRecord = {
          id: planned.manifestId,
          created_at: nowIso,
          updated_at: nowIso,
          mode: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
          status: 'applied',
          actor: planned.actor,
          backup_reference: backupEvidence.path,
          checksum: planned.planChecksum,
          manifest: {
            repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
            manifestSchema: CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA,
            approvalSchema: checkedApproval.approvalSchema,
            approvalTuple: planned.plan.approvalTuple,
            planChecksum: planned.planChecksum,
            actor: planned.actor,
            reason: planned.reason,
            appliedAt: nowIso,
            aliasMoves: planned.plan.aliasMoves,
            backupEvidence,
            plan: planned.plan,
          },
          metadata: {
            repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
            manifestSchema: CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA,
            approvalSchema: checkedApproval.approvalSchema,
            exceptionId: checkedApproval.exceptionId,
            survivorId: checkedApproval.survivorId,
            supersededId: checkedApproval.supersededId,
            planChecksum: planned.planChecksum,
          },
        };
        const manifestInsert = database.prepare(`
          INSERT INTO deal_hunter_cim_repair_manifests (
            id, created_at, updated_at, mode, status, actor,
            backup_reference, checksum, manifest, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          manifestRecord.id,
          manifestRecord.created_at,
          manifestRecord.updated_at,
          manifestRecord.mode,
          manifestRecord.status,
          manifestRecord.actor,
          manifestRecord.backup_reference,
          manifestRecord.checksum,
          JSON.stringify(manifestRecord.manifest),
          JSON.stringify(manifestRecord.metadata),
        );
        if (manifestInsert.changes !== 1) {
          throw new Error('Canonical opportunity merge manifest was not inserted exactly once.');
        }

        const finalState = validateCanonicalMergeFinalState(database, {
          approval: checkedApproval,
          actor: planned.actor,
          reason: planned.reason,
          planChecksum: planned.planChecksum,
          manifestId: planned.manifestId,
        });
        return {
          ok: true,
          mode: 'apply',
          applied: true,
          alreadyApplied: false,
          planChecksum: planned.planChecksum,
          movedAliasCount: planned.plan.aliasMoves.length,
          manifestId: planned.manifestId,
          manifest: finalState.manifest,
          finalState,
        };
      });
      return transaction.immediate();
    },

    async getDealHunterOpportunity(opportunityId) {
      if (!opportunityId) return null;
      return normalizeDealHunterOpportunityRow(database.prepare(`
        SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
      `).get(String(opportunityId).trim()));
    },

    async getCurrentDealHunterOpportunity(opportunityId) {
      if (!opportunityId) return null;
      return normalizeDealHunterOpportunityRow(database.prepare(`
        SELECT * FROM deal_hunter_opportunities
        WHERE opportunity_id = ? AND status = 'active'
        LIMIT 1
      `).get(String(opportunityId).trim()));
    },

    async getLatestDealHunterMaterialChange({ opportunityId, materialRevision } = {}) {
      if (!opportunityId || !Number.isSafeInteger(Number(materialRevision)) || Number(materialRevision) < 1) return null;
      return database.prepare(`SELECT field_key, before_value, after_value, currency, period,
        source_name, accepted_at FROM deal_hunter_freshness_evidence
        WHERE current_canonical_id = ? AND event_type = 'material_change' AND material_revision = ?
        ORDER BY accepted_at DESC, id LIMIT 1`).get(String(opportunityId), Number(materialRevision)) || null;
    },

    async markDealHunterOpportunityDiscoveryPending({ opportunityId, createdAt } = {}) {
      const id = String(opportunityId || '').trim();
      const timestamp = String(createdAt || '').trim();
      return database.transaction(() => {
        const current = database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?').get(id);
        if (!current || current.created_at !== timestamp || current.status !== 'active'
          || current.first_accepted_at !== null || current.discovery_revision !== 0
          || !['untracked_legacy', 'pending'].includes(current.discovery_state)) {
          throw new Error('Freshness pending state requires a newly created active canonical identity.');
        }
        if (current.discovery_state === 'untracked_legacy') {
          database.prepare("UPDATE deal_hunter_opportunities SET discovery_state = 'pending' WHERE opportunity_id = ?").run(id);
        }
        return normalizeDealHunterOpportunityRow(database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?').get(id));
      }).immediate();
    },

    async getCimStage2SubmissionAuthority(opportunityId) {
      const normalizedOpportunityId = String(opportunityId || '').trim();
      if (!normalizedOpportunityId) {
        return { opportunity: null, primarySubmissionWritable: false, supersession: null };
      }
      const readAuthority = database.transaction(() => {
        const opportunity = database.prepare(`
          SELECT * FROM deal_hunter_opportunities
          WHERE opportunity_id = ? AND status = 'active'
          LIMIT 1
        `).get(normalizedOpportunityId);
        const primarySubmissionId = String(opportunity?.primary_submission_id || '').trim();
        const supersession = primarySubmissionId
          ? database.prepare(`
            SELECT * FROM crm_submission_supersessions
            WHERE status = 'active' AND superseded_submission_id = ?
            LIMIT 1
          `).get(primarySubmissionId)
          : null;
        return {
          opportunity: normalizeDealHunterOpportunityRow(opportunity),
          primarySubmissionWritable: Boolean(opportunity) && !supersession,
          supersession: normalizeCrmSubmissionSupersessionRow(supersession),
        };
      });
      return readAuthority.immediate();
    },

    async listDealHunterOpportunities({ opportunityIds = [], recipientEmails = [], limit = 1000 } = {}) {
      const ids = normalizeList(opportunityIds);
      const recipients = normalizeList(recipientEmails).map((value) => value.toLowerCase());
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 100000));
      const clauses = [];
      const params = [];
      if (ids.length > 0) {
        clauses.push(`opportunity_id IN (${placeholders(ids.length)})`);
        params.push(...ids);
      }
      if (recipients.length > 0) {
        clauses.push(`LOWER(canonical_recipient) IN (${placeholders(recipients.length)})`);
        params.push(...recipients);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return database.prepare(`
        SELECT * FROM deal_hunter_opportunities ${where}
        ORDER BY updated_at DESC, opportunity_id
        LIMIT ?
      `).all(...params, safeLimit).map(normalizeDealHunterOpportunityRow);
    },

    async listCurrentDealHunterOpportunities({ opportunityIds = [], recipientEmails = [], limit = 1000 } = {}) {
      const ids = normalizeList(opportunityIds);
      const recipients = normalizeList(recipientEmails).map((value) => value.toLowerCase());
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 100000));
      const clauses = ["status = 'active'"];
      const params = [];
      if (ids.length > 0) {
        clauses.push(`opportunity_id IN (${placeholders(ids.length)})`);
        params.push(...ids);
      }
      if (recipients.length > 0) {
        clauses.push(`LOWER(canonical_recipient) IN (${placeholders(recipients.length)})`);
        params.push(...recipients);
      }
      return database.prepare(`
        SELECT * FROM deal_hunter_opportunities
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC, opportunity_id
        LIMIT ?
      `).all(...params, safeLimit).map(normalizeDealHunterOpportunityRow);
    },

    async listCimStage2IdentityOpportunities({ limit = 5000 } = {}) {
      return database.prepare(`
        SELECT opportunity_id, primary_submission_id
        FROM deal_hunter_opportunities
        WHERE status = 'active'
        ORDER BY updated_at DESC, opportunity_id
        LIMIT ?
      `).all(Math.max(1, Math.min(Number(limit) || 5000, 100000)));
    },

    async listCimStage2EvidenceAliases({ limit = 10000 } = {}) {
      return database.prepare(`
        SELECT alias.alias_type, alias.alias_value, alias.opportunity_id
        FROM deal_hunter_opportunity_aliases AS alias
        JOIN deal_hunter_opportunities AS opportunity
          ON opportunity.opportunity_id = alias.opportunity_id
         AND opportunity.status = 'active'
        ORDER BY alias.last_observed_at DESC, alias.alias_key
        LIMIT ?
      `).all(Math.max(1, Math.min(Number(limit) || 10000, 100000)));
    },

    async findDealHunterOpportunityByAliases(aliasKeys = []) {
      const owners = completeCanonicalAliasOwners(database, aliasKeys);
      if (owners.length > 1) {
        throw canonicalAliasOwnershipError(
          'DEAL_HUNTER_OPPORTUNITY_ALIAS_CONFLICT',
          'Conflicting Deal Hunter opportunity aliases require review.',
          owners.map((owner) => owner.opportunity_id),
        );
      }
      return owners[0] || null;
    },

    async findCurrentDealHunterOpportunityByAliases(aliasKeys = []) {
      const owners = completeCanonicalAliasOwners(database, aliasKeys);
      if (owners.length > 1) {
        throw canonicalAliasOwnershipError(
          'DEAL_HUNTER_OPPORTUNITY_ALIAS_CONFLICT',
          'Conflicting Deal Hunter opportunity aliases require review.',
          owners.map((owner) => owner.opportunity_id),
        );
      }
      if (owners[0] && owners[0].status !== 'active') {
        const error = new Error('Deal Hunter opportunity alias belongs to a non-current canonical opportunity.');
        error.code = 'DEAL_HUNTER_OPPORTUNITY_NOT_CURRENT';
        error.opportunityId = owners[0].opportunity_id;
        throw error;
      }
      return owners[0] || null;
    },

    async createDealHunterOpportunityWithAliases({
      opportunity: opportunityRecord = {},
      aliases: records = [],
      existingOwnerMode = 'return-current',
      identityException: identityExceptionRecord = null,
    } = {}) {
      const aliases = Array.isArray(records)
        ? records.filter((record) => record?.alias_key && record?.opportunity_id)
        : [];
      if (!opportunityRecord.opportunity_id || opportunityRecord.status !== 'active' || aliases.length === 0) {
        throw new Error('Atomic canonical opportunity creation requires one active opportunity and at least one alias.');
      }
      if (!['return-current', 'conflict'].includes(existingOwnerMode)) {
        throw new Error('Atomic canonical opportunity creation received an unsupported existing-owner mode.');
      }
      const proposedOwnerIds = new Set(aliases.map((record) => record.opportunity_id));
      if (proposedOwnerIds.size !== 1 || !proposedOwnerIds.has(opportunityRecord.opportunity_id)) {
        throw new Error('Atomic canonical opportunity aliases must target the proposed opportunity.');
      }
      const transaction = database.transaction(() => {
        let currentIdentityException = null;
        if (identityExceptionRecord) {
          currentIdentityException = normalizeDealHunterIdentityExceptionRow(database.prepare(`
            SELECT * FROM deal_hunter_identity_exceptions WHERE id = ? LIMIT 1
          `).get(identityExceptionRecord.id));
          if (
            !currentIdentityException
            || currentIdentityException.status !== 'open'
            || currentIdentityException.resolved_at
            || currentIdentityException.resolved_by
            || currentIdentityException.resolution_reason
          ) {
            return {
              created: false,
              linked: false,
              conflict: { reason: 'identity-exception-not-open', opportunity_id: '', alias_key: '' },
              opportunity: null,
              aliases: [],
              identityException: currentIdentityException,
            };
          }
        }

        const owners = completeCanonicalAliasOwners(database, aliases.map((record) => record.alias_key));
        if (owners.length > 1) {
          return {
            created: false,
            linked: false,
            conflict: {
              reason: 'conflicting-alias-owners',
              opportunity_id: owners[0].opportunity_id,
              opportunity_ids: owners.map((owner) => owner.opportunity_id),
              alias_key: '',
            },
            opportunity: null,
            aliases: [],
            identityException: currentIdentityException,
          };
        }

        let opportunity = owners[0] || null;
        let created = false;
        if (opportunity) {
          if (opportunity.status !== 'active') {
            return {
              created: false,
              linked: false,
              conflict: {
                reason: 'alias-owner-not-current',
                opportunity_id: opportunity.opportunity_id,
                alias_key: '',
              },
              opportunity,
              aliases: [],
              identityException: currentIdentityException,
            };
          }
          if (existingOwnerMode === 'conflict') {
            return {
              created: false,
              linked: false,
              conflict: {
                reason: 'alias-owner-exists',
                opportunity_id: opportunity.opportunity_id,
                alias_key: '',
              },
              opportunity,
              aliases: [],
              identityException: currentIdentityException,
            };
          }
        } else {
          database.prepare(`
            INSERT INTO deal_hunter_opportunities (
              opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
              canonical_location, primary_submission_id, identity_version, status, metadata
            ) VALUES (
              @opportunity_id, @created_at, @updated_at, @canonical_name, @canonical_recipient,
              @canonical_location, @primary_submission_id, @identity_version, @status, @metadata
            )
          `).run({
            ...opportunityRecord,
            canonical_recipient: opportunityRecord.canonical_recipient || null,
            canonical_location: opportunityRecord.canonical_location || null,
            primary_submission_id: opportunityRecord.primary_submission_id || null,
            metadata: JSON.stringify(opportunityRecord.metadata || {}),
          });
          opportunity = normalizeDealHunterOpportunityRow(database.prepare(`
            SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
          `).get(opportunityRecord.opportunity_id));
          created = true;
        }

        const aliasStatement = database.prepare(`
          INSERT INTO deal_hunter_opportunity_aliases (
            id, opportunity_id, alias_type, alias_value, alias_key, source,
            first_observed_at, last_observed_at, evidence_version, resolution_method,
            confidence_state, resolved_by, metadata
          ) VALUES (
            @id, @opportunity_id, @alias_type, @alias_value, @alias_key, @source,
            @first_observed_at, @last_observed_at, @evidence_version, @resolution_method,
            @confidence_state, @resolved_by, @metadata
          )
          ON CONFLICT(alias_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            source = COALESCE(excluded.source, deal_hunter_opportunity_aliases.source),
            metadata = excluded.metadata
          WHERE deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id
        `);
        const linkedAliases = [];
        for (const record of aliases) {
          aliasStatement.run({
            ...record,
            opportunity_id: opportunity.opportunity_id,
            source: record.source || null,
            resolved_by: record.resolved_by || null,
            metadata: JSON.stringify(record.metadata || {}),
          });
          const linkedAlias = normalizeDealHunterOpportunityAliasRow(database.prepare(`
            SELECT * FROM deal_hunter_opportunity_aliases WHERE alias_key = ? LIMIT 1
          `).get(record.alias_key));
          if (linkedAlias?.opportunity_id !== opportunity.opportunity_id) {
            throw new Error('Atomic canonical opportunity alias acquisition failed its owner postcondition.');
          }
          linkedAliases.push(linkedAlias);
        }

        let resolvedIdentityException = currentIdentityException;
        if (identityExceptionRecord) {
          const update = database.prepare(`
            UPDATE deal_hunter_identity_exceptions
            SET updated_at = @updated_at,
                status = @status,
                resolved_at = @resolved_at,
                resolved_by = @resolved_by,
                resolution_reason = @resolution_reason,
                metadata = @metadata
            WHERE id = @id
              AND status = 'open'
              AND resolved_at IS NULL
              AND resolved_by IS NULL
              AND resolution_reason IS NULL
          `).run({
            ...identityExceptionRecord,
            metadata: JSON.stringify(identityExceptionRecord.metadata || {}),
          });
          if (update.changes !== 1) {
            throw new Error('Atomic canonical opportunity creation could not resolve the expected open identity exception.');
          }
          resolvedIdentityException = normalizeDealHunterIdentityExceptionRow(database.prepare(`
            SELECT * FROM deal_hunter_identity_exceptions WHERE id = ? LIMIT 1
          `).get(identityExceptionRecord.id));
        }

        return {
          created,
          linked: true,
          conflict: null,
          opportunity,
          aliases: linkedAliases,
          identityException: resolvedIdentityException,
        };
      });
      return transaction.immediate();
    },

    async upsertDealHunterOpportunity(record = {}) {
      database.prepare(`
        INSERT INTO deal_hunter_opportunities (
          opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
          canonical_location, primary_submission_id, identity_version, status, metadata
        ) VALUES (
          @opportunity_id, @created_at, @updated_at, @canonical_name, @canonical_recipient,
          @canonical_location, @primary_submission_id, @identity_version, @status, @metadata
        )
        ON CONFLICT(opportunity_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          canonical_name = excluded.canonical_name,
          canonical_recipient = COALESCE(excluded.canonical_recipient, deal_hunter_opportunities.canonical_recipient),
          canonical_location = COALESCE(excluded.canonical_location, deal_hunter_opportunities.canonical_location),
          primary_submission_id = COALESCE(excluded.primary_submission_id, deal_hunter_opportunities.primary_submission_id),
          identity_version = excluded.identity_version,
          status = excluded.status,
          metadata = excluded.metadata
        WHERE deal_hunter_opportunities.status = 'active'
      `).run({
        ...record,
        canonical_recipient: record.canonical_recipient || null,
        canonical_location: record.canonical_location || null,
        primary_submission_id: record.primary_submission_id || null,
        metadata: JSON.stringify(record.metadata || {}),
      });
      return this.getDealHunterOpportunity(record.opportunity_id);
    },

    async listDealHunterOpportunityFacts(opportunityId, { limit = 500 } = {}) {
      return database.prepare(`
        SELECT * FROM deal_hunter_opportunity_facts
        WHERE opportunity_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(String(opportunityId || '').trim(), Number.isFinite(Number(limit)) ? Math.max(1, Math.min(Math.trunc(Number(limit)), 500)) : 500).map(normalizeDealHunterOpportunityFactRow);
    },

    async insertCurrentDealHunterOpportunityFact(fact = {}) {
      const record = normalizeOperatorOpportunityFactRecord(fact);
      const transaction = database.transaction(() => {
        const current = database.prepare(`SELECT opportunity_id FROM deal_hunter_opportunities WHERE opportunity_id = ? AND status = 'active' LIMIT 1`)
          .get(record.opportunity_id);
        if (!current) return null;
        database.prepare(`INSERT INTO deal_hunter_opportunity_facts (id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at)
          VALUES (@id, @opportunity_id, @field, @value, @source, @verified, @actor, @note, @created_at, @updated_at)`).run({ ...record, verified: record.verified ? 1 : 0 });
        return normalizeDealHunterOpportunityFactRow(database.prepare(`SELECT * FROM deal_hunter_opportunity_facts WHERE id = ?`).get(record.id));
      });
      return transaction.immediate();
    },

    async upsertDealHunterOpportunityFact(fact = {}) {
      const record = normalizeOperatorOpportunityFactRecord(fact);
      database.prepare(`
        INSERT INTO deal_hunter_opportunity_facts (
          id, opportunity_id, field, value, source, verified, actor, note, created_at, updated_at
        ) VALUES (
          @id, @opportunity_id, @field, @value, @source, @verified, @actor, @note, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          field = excluded.field,
          value = excluded.value,
          source = excluded.source,
          verified = excluded.verified,
          actor = excluded.actor,
          note = excluded.note,
          updated_at = excluded.updated_at
      `).run({ ...record, verified: record.verified ? 1 : 0 });
      return normalizeDealHunterOpportunityFactRow(database.prepare(`
        SELECT * FROM deal_hunter_opportunity_facts WHERE id = ? LIMIT 1
      `).get(record.id));
    },

    async listDealHunterOpportunitySourceObservations(opportunityId, { limit = 500 } = {}) {
      return database.prepare(`
        SELECT * FROM deal_hunter_opportunity_source_observations
        WHERE opportunity_id = ?
        ORDER BY observed_at DESC, id ASC
        LIMIT ?
      `).all(String(opportunityId || '').trim(), Number.isFinite(Number(limit)) ? Math.max(1, Math.min(Math.trunc(Number(limit)), 500)) : 500).map(normalizeDealHunterOpportunitySourceObservationRow);
    },

    async bindAcceptedDealHunterFreshness({ importId, opportunityId, sourceRecordId, expectedGeneration, snapshot } = {}) {
      const runId = String(importId || '').trim();
      const canonicalId = String(opportunityId || '').trim();
      const recordId = String(sourceRecordId || '').trim();
      const normalizedSnapshot = normalizeOpportunitySourceObservationSnapshot(snapshot);
      if (!runId || !canonicalId || !recordId || normalizedSnapshot.source_id !== 'deal-os-export'
        || normalizedSnapshot.opportunity_id !== canonicalId || normalizedSnapshot.source_record_id !== recordId
        || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
        throw new Error('Deal OS freshness binding identity does not match the accepted source record.');
      }
      return database.transaction(() => {
        const imported = database.prepare('SELECT * FROM deal_hunter_deal_os_imports WHERE id = ?').get(runId);
        const state = database.prepare("SELECT * FROM deal_hunter_source_freshness_state WHERE source_id = 'deal-os-export'").get();
        const event = database.prepare(`SELECT * FROM deal_hunter_freshness_evidence
          WHERE run_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?
            AND event_type = 'accepted_source_record' AND field_key = ''
          ORDER BY event_ordinal LIMIT 1`).get(runId, recordId);
        const canonical = database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?').get(canonicalId);
        if (!imported || imported.freshness_generation !== expectedGeneration || !event
          || event.generation !== expectedGeneration || !canonical || canonical.status !== 'active') {
          throw new Error('Deal OS freshness binding lacks an accepted import and current canonical identity.');
        }
        const conflicting = database.prepare(`SELECT id FROM deal_hunter_freshness_evidence
          WHERE run_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?
            AND current_canonical_id IS NOT NULL AND current_canonical_id <> ? LIMIT 1`
        ).get(runId, recordId, canonicalId);
        if (conflicting) throw new Error('Accepted Deal OS evidence is already bound to another canonical identity.');
        database.prepare(`UPDATE deal_hunter_freshness_evidence
          SET current_canonical_id = ?, binding_audit_id = ?
          WHERE run_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?
            AND current_canonical_id IS NULL`
        ).run(canonicalId, runId, runId, recordId);
        const priorAccepted = database.prepare(`SELECT earlier.id, earlier.run_id,
            earlier.accepted_at, earlier.current_canonical_id,
            json_extract(older_import.row_accounting,
              '$[' || CAST(earlier.event_ordinal AS INTEGER) || '].listingIdentity') AS listing_identity
          FROM deal_hunter_freshness_evidence AS earlier
          JOIN deal_hunter_deal_os_imports AS older_import ON older_import.id = earlier.run_id
          WHERE earlier.source_id = 'deal-os-export' AND earlier.source_record_id = ?
            AND earlier.event_type = 'accepted_source_record' AND earlier.field_key = ''
            AND earlier.accepted_at < ?
          ORDER BY earlier.accepted_at, earlier.id LIMIT 1`
        ).get(recordId, event.accepted_at);
        const currentListingIdentity = database.prepare(`SELECT json_extract(row_accounting,
          '$[' || CAST(? AS INTEGER) || '].listingIdentity') AS listing_identity
          FROM deal_hunter_deal_os_imports WHERE id = ?`
        ).get(event.event_ordinal, runId)?.listing_identity;
        const provenEarlier = priorAccepted && currentListingIdentity
          && priorAccepted.listing_identity === currentListingIdentity;
        if (provenEarlier && priorAccepted.current_canonical_id
          && priorAccepted.current_canonical_id !== canonicalId) {
          throw new Error('Earlier accepted Deal OS listing is bound to another canonical identity.');
        }
        if (provenEarlier && !priorAccepted.current_canonical_id) {
          database.prepare(`UPDATE deal_hunter_freshness_evidence
            SET current_canonical_id = ?, binding_audit_id = ?
            WHERE run_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?
              AND current_canonical_id IS NULL`
          ).run(canonicalId, runId, priorAccepted.run_id, recordId);
        }
        if (canonical.discovery_state === 'pending' && canonical.first_accepted_at === null) {
          if (!priorAccepted || provenEarlier) database.prepare(`UPDATE deal_hunter_opportunities SET first_accepted_at = ?,
            first_discovery_evidence_id = ?, discovery_state = ?,
            discovery_revision = discovery_revision + 1 WHERE opportunity_id = ?`
          ).run(provenEarlier ? priorAccepted.accepted_at : event.accepted_at,
            provenEarlier ? priorAccepted.id : event.id,
            !provenEarlier && state?.accepted_generation === expectedGeneration && state?.accepted_run_id === runId
              ? 'known_prospective' : 'known_recovered', canonicalId);
        } else if (['known_prospective', 'known_recovered'].includes(canonical.discovery_state)
          && canonical.first_accepted_at && event.accepted_at < canonical.first_accepted_at) {
          database.prepare(`UPDATE deal_hunter_opportunities SET first_accepted_at = ?,
            first_discovery_evidence_id = ?, discovery_state = 'known_recovered',
            discovery_revision = discovery_revision + 1 WHERE opportunity_id = ?`
          ).run(event.accepted_at, event.id, canonicalId);
        }
        if (!state || state.accepted_generation !== expectedGeneration || state.accepted_run_id !== runId) {
          database.prepare("UPDATE deal_hunter_deal_os_imports SET freshness_projection_state = 'superseded' WHERE id = ?")
            .run(runId);
          return { bound: true, projectionState: 'superseded' };
        }
        for (const [fieldKey, claim] of [
          ['annual_profit', normalizedSnapshot.freshness_evidence?.annualProfit],
          ['annual_revenue', normalizedSnapshot.freshness_evidence?.annualRevenue],
          ['asking_price', normalizedSnapshot.freshness_evidence?.askingPrice],
        ]) {
          if (!claim) continue;
          const after = database.prepare(`SELECT * FROM deal_hunter_freshness_evidence
            WHERE run_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?
              AND event_type = 'accepted_source_record' AND field_key = ? AND event_ordinal = ?`
          ).get(runId, recordId, fieldKey, event.event_ordinal);
          if (!after) throw new Error('Deal OS financial projection lacks its accepted field evidence.');
          const priorObservation = database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
            WHERE opportunity_id = ? AND source_id = 'deal-os-export'
              AND source_record_id = ? AND field = ?`
          ).get(canonicalId, recordId, fieldKey);
          if (!priorObservation) continue;
          const priorCore = priorObservation.accepted_evidence_id
            ? database.prepare('SELECT run_id, event_ordinal FROM deal_hunter_freshness_evidence WHERE id = ?')
              .get(priorObservation.accepted_evidence_id) : null;
          const before = priorCore ? database.prepare(`SELECT * FROM deal_hunter_freshness_evidence
            WHERE run_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?
              AND event_type = 'accepted_source_record' AND field_key = ? AND event_ordinal = ?`
          ).get(priorCore.run_id, recordId, fieldKey, priorCore.event_ordinal) : null;
          if (before?.after_value === after.after_value
            || priorObservation.value === String(after.after_value)) continue;
          const competing = database.prepare(`SELECT 1 FROM deal_hunter_opportunity_source_observations
            WHERE opportunity_id = ? AND source_id <> 'deal-os-export'
              AND field = ? AND value <> ? LIMIT 1`
          ).get(canonicalId, fieldKey, String(after.after_value));
          const comparable = Boolean(before && !competing && before.after_value !== null
            && after.after_value !== null && after.metric !== 'unknown'
            && after.currency !== 'unknown' && after.period !== 'unknown'
            && before.metric === after.metric && before.currency === after.currency
            && before.period === after.period && before.current_canonical_id === canonicalId);
          const eventType = comparable ? 'material_change' : 'evidence_state_change';
          const revision = comparable ? database.prepare(`SELECT material_revision
            FROM deal_hunter_opportunities WHERE opportunity_id = ?`).get(canonicalId).material_revision + 1 : null;
          database.prepare(`INSERT INTO deal_hunter_freshness_evidence
            (id, source_id, source_name, source_record_id, run_id, generation,
              event_type, field_key, event_ordinal, accepted_at, original_canonical_id,
              current_canonical_id, before_value, after_value, before_evidence_id,
              after_evidence_id, metric, currency, period, classification, material_revision)
            VALUES (?, 'deal-os-export', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(`fl01:${createHash('sha256').update([runId, recordId, eventType,
            fieldKey, event.event_ordinal].join('\u0000')).digest('hex')}`,
            after.source_name, recordId, runId, expectedGeneration, eventType, fieldKey,
            event.event_ordinal, event.accepted_at, canonicalId, canonicalId,
            before?.after_value ?? null, after.after_value, before?.id || null, after.id,
            after.metric, after.currency, after.period,
            comparable ? 'comparable_change' : competing ? 'conflict' : 'new_evidence', revision);
          if (comparable) database.prepare(`UPDATE deal_hunter_opportunities
            SET material_revision = ?, last_material_change_at = ? WHERE opportunity_id = ?`
          ).run(revision, event.accepted_at, canonicalId);
        }
        const upsert = database.prepare(`INSERT INTO deal_hunter_opportunity_source_observations (
          id, opportunity_id, source_id, source_name, source_record_id, field, value,
          observed_at, created_at, updated_at, accepted_at, accepted_run_id,
          accepted_evidence_id, publication_raw_header, publication_raw_value,
          publication_precision, publication_offset, publication_meaning
        ) VALUES (
          @id, @opportunity_id, @source_id, @source_name, @source_record_id, @field, @value,
          @observed_at, @created_at, @updated_at, @accepted_at, @accepted_run_id,
          @accepted_evidence_id, @publication_raw_header, @publication_raw_value,
          @publication_precision, @publication_offset, @publication_meaning
        ) ON CONFLICT(opportunity_id, source_id, source_record_id, field) DO UPDATE SET
          source_name = excluded.source_name, value = excluded.value,
          observed_at = excluded.observed_at, updated_at = excluded.updated_at,
          accepted_at = excluded.accepted_at, accepted_run_id = excluded.accepted_run_id,
          accepted_evidence_id = excluded.accepted_evidence_id,
          publication_raw_header = excluded.publication_raw_header,
          publication_raw_value = excluded.publication_raw_value,
          publication_precision = excluded.publication_precision,
          publication_offset = excluded.publication_offset,
          publication_meaning = excluded.publication_meaning`);
        const desiredFields = new Set(normalizedSnapshot.observations.map((observation) => observation.field));
        for (const observation of normalizedSnapshot.observations) {
          const publication = observation.field === 'date_added' ? normalizedSnapshot.freshness_evidence?.dateAdded : null;
          upsert.run({
            ...observation,
            accepted_at: event.accepted_at,
            accepted_run_id: runId,
            accepted_evidence_id: event.id,
            publication_raw_header: publication?.rawHeader || null,
            publication_raw_value: publication?.rawValue || null,
            publication_precision: publication?.precision === 'datetime' ? 'instant' : publication?.precision || null,
            publication_offset: publication?.offset || null,
            publication_meaning: publication?.meaning || null,
          });
        }
        for (const observation of database.prepare(`SELECT id, field FROM deal_hunter_opportunity_source_observations
          WHERE opportunity_id = ? AND source_id = 'deal-os-export' AND source_record_id = ?`).all(canonicalId, recordId)) {
          if (!desiredFields.has(observation.field)) {
            database.prepare('DELETE FROM deal_hunter_opportunity_source_observations WHERE id = ?').run(observation.id);
          }
        }
        const unbound = database.prepare(`SELECT count(*) AS n FROM deal_hunter_freshness_evidence
          WHERE run_id = ? AND source_id = 'deal-os-export' AND event_type = 'accepted_source_record'
            AND field_key = '' AND current_canonical_id IS NULL`).get(runId).n;
        const projectionState = unbound === 0 ? 'accepted' : 'pending';
        database.prepare('UPDATE deal_hunter_deal_os_imports SET freshness_projection_state = ? WHERE id = ?')
          .run(projectionState, runId);
        database.prepare("UPDATE deal_hunter_source_freshness_state SET projection_state = ? WHERE source_id = 'deal-os-export'")
          .run(projectionState);
        return { bound: true, projectionState };
      }).immediate();
    },

    async upsertDealHunterOpportunitySourceObservation(observation = {}) {
      const normalizedObservation = normalizeOpportunitySourceObservation(observation);
      database.prepare(`
        INSERT INTO deal_hunter_opportunity_source_observations (
          id, opportunity_id, source_id, source_name, source_record_id, field, value,
          observed_at, created_at, updated_at
        ) VALUES (
          @id, @opportunity_id, @source_id, @source_name, @source_record_id, @field, @value,
          @observed_at, @created_at, @updated_at
        )
        ON CONFLICT(opportunity_id, source_id, source_record_id, field) DO UPDATE SET
          source_name = excluded.source_name,
          value = excluded.value,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at,
          accepted_at = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.accepted_at END,
          accepted_run_id = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.accepted_run_id END,
          accepted_evidence_id = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.accepted_evidence_id END,
          publication_raw_header = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_raw_header END,
          publication_raw_value = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_raw_value END,
          publication_precision = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_precision END,
          publication_offset = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_offset END,
          publication_meaning = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
            THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_meaning END
      `).run(normalizedObservation);
      return normalizeDealHunterOpportunitySourceObservationRow(database.prepare(`
        SELECT * FROM deal_hunter_opportunity_source_observations
        WHERE opportunity_id = ? AND source_id = ? AND source_record_id = ? AND field = ?
        LIMIT 1
      `).get(
        normalizedObservation.opportunity_id,
        normalizedObservation.source_id,
        normalizedObservation.source_record_id,
        normalizedObservation.field,
      ));
    },

    async replaceDealHunterOpportunitySourceObservationSnapshot(snapshot = {}) {
      const normalizedSnapshot = normalizeOpportunitySourceObservationSnapshot(snapshot);
      const replace = database.transaction((value) => {
        for (const observation of value.observations) {
          database.prepare(`
            INSERT INTO deal_hunter_opportunity_source_observations (
              id, opportunity_id, source_id, source_name, source_record_id, field, value,
              observed_at, created_at, updated_at
            ) VALUES (
              @id, @opportunity_id, @source_id, @source_name, @source_record_id, @field, @value,
              @observed_at, @created_at, @updated_at
            )
            ON CONFLICT(opportunity_id, source_id, source_record_id, field) DO UPDATE SET
              source_name = excluded.source_name,
              value = excluded.value,
              observed_at = excluded.observed_at,
              updated_at = excluded.updated_at,
              accepted_at = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.accepted_at END,
              accepted_run_id = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.accepted_run_id END,
              accepted_evidence_id = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.accepted_evidence_id END,
              publication_raw_header = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_raw_header END,
              publication_raw_value = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_raw_value END,
              publication_precision = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_precision END,
              publication_offset = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_offset END,
              publication_meaning = CASE WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value
                THEN NULL ELSE deal_hunter_opportunity_source_observations.publication_meaning END
          `).run(observation);
        }
        const fields = value.observations.map((observation) => observation.field);
        const condition = fields.length > 0
          ? `AND field NOT IN (${fields.map(() => '?').join(', ')})`
          : '';
        database.prepare(`
          DELETE FROM deal_hunter_opportunity_source_observations
          WHERE opportunity_id = ? AND source_id = ? AND source_record_id = ? ${condition}
        `).run(value.opportunity_id, value.source_id, value.source_record_id, ...fields);
        return database.prepare(`
          SELECT * FROM deal_hunter_opportunity_source_observations
          WHERE opportunity_id = ? AND source_id = ? AND source_record_id = ?
          ORDER BY observed_at DESC, id ASC
        `).all(value.opportunity_id, value.source_id, value.source_record_id)
          .map(normalizeDealHunterOpportunitySourceObservationRow);
      });
      return replace(normalizedSnapshot);
    },

    async replaceDealHunterOpportunitySourceSnapshot() {
      throw new Error('Complete per-opportunity source snapshot replacement is not admitted.');
    },

    async replaceDealHunterSourceSnapshot(snapshot = {}) {
      normalizeDealHunterSourceSnapshot(snapshot);
      throw new Error('Complete Google Sheet source snapshot admission is required.');
    },

    async replaceAdmittedCompleteGoogleSheetSourceSnapshot(snapshot = {}) {
      const admission = consumeCompleteGoogleSheetSourceSnapshotAdmission({
        admission: snapshot.admission,
        snapshot,
      });
      const normalizedSnapshot = normalizeCompleteGoogleSheetFreshnessSnapshot(snapshot);
      const replace = database.transaction((value) => {
        const run = admission.run || null;
        let acceptedAt = null;
        const evidenceByRecord = new Map();
        const currentByRecord = new Map();
        if (run) {
          const state = database.prepare('SELECT * FROM deal_hunter_source_freshness_state WHERE source_id = ?').get(value.source_id);
          if (!state || run.sourceId !== value.source_id || run.generation > state.next_generation) {
            throw new Error('Complete Sheet freshness generation was not allocated.');
          }
          if (run.generation <= state.accepted_generation) {
            if (run.generation !== state.accepted_generation || run.runId !== state.accepted_run_id
              || admission.freshness_digest !== state.accepted_digest) {
              throw new Error('Stale or conflicting complete Sheet freshness run.');
            }
            return database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
              WHERE source_id = ? ORDER BY observed_at DESC, id ASC`).all(value.source_id)
              .map(normalizeDealHunterOpportunitySourceObservationRow);
          }
          acceptedAt = database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at").get().at;
          for (const row of database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
            WHERE source_id = ?`).all(value.source_id)) {
            const key = `${row.source_record_id}\u0000${row.field}`;
            currentByRecord.set(key, row);
          }
          if (value.unresolved.length > 0) {
            for (const item of value.unresolved) {
              const exception = database.prepare(`SELECT id FROM deal_hunter_identity_exceptions
                WHERE id = ? AND status = 'open'`).get(item.identity_exception_id);
              if (!exception) throw new Error('Deferred Sheet evidence requires a current open identity exception.');
            }
            for (const item of [
              ...value.records.map((record) => ({ ...record, identity_exception_id: null })),
              ...value.unresolved,
            ]) {
              const evidence = normalizeSourceFreshnessEvidence(item.freshness_evidence);
              const recordDigest = createHash('sha256').update(JSON.stringify(item)).digest('hex');
              const common = {
                source_id: value.source_id, source_name: value.source_name,
                source_record_id: item.source_record_id, run_id: run.runId,
                generation: run.generation, record_digest: recordDigest,
                accepted_at: acceptedAt, original_canonical_id: item.opportunity_id || null,
                current_canonical_id: item.opportunity_id || null,
                identity_exception_id: item.identity_exception_id || null,
              };
              const add = (eventType, fieldKey, claim = null) => database.prepare(`
                INSERT INTO deal_hunter_freshness_evidence (
                  id, source_id, source_name, source_record_id, run_id, generation, record_digest,
                  event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
                  identity_exception_id, raw_header, raw_value, publication_meaning,
                  publication_precision, publication_offset, publication_date,
                  publication_instant, publication_state, metric, currency, period
                ) VALUES (
                  @id, @source_id, @source_name, @source_record_id, @run_id, @generation, @record_digest,
                  @event_type, @field_key, @accepted_at, @original_canonical_id, @current_canonical_id,
                  @identity_exception_id, @raw_header, @raw_value, @publication_meaning,
                  @publication_precision, @publication_offset, @publication_date,
                  @publication_instant, @publication_state, @metric, @currency, @period
                )`).run({
                ...common, event_type: eventType, field_key: fieldKey,
                id: `fl01:${createHash('sha256').update([run.runId, value.source_id,
                  item.source_record_id, eventType, fieldKey].join('\u0000')).digest('hex')}`,
                raw_header: claim?.rawHeader || null, raw_value: claim?.rawValue || null,
                publication_meaning: claim?.meaning || 'unknown',
                publication_precision: eventType === 'publication_evidence'
                  ? (claim?.precision === 'datetime' ? 'instant' : claim?.precision || 'unknown') : 'unknown',
                publication_offset: claim?.offset || null, metric: claim?.metric || 'unknown',
                publication_date: acceptedPublicationClaim(claim, acceptedAt).date,
                publication_instant: acceptedPublicationClaim(claim, acceptedAt).instant,
                publication_state: acceptedPublicationClaim(claim, acceptedAt).state,
                currency: claim?.currency || 'unknown', period: claim?.period || 'unknown',
              });
              add('accepted_source_record', '');
              if (evidence?.dateAdded) add('publication_evidence', 'date_added', evidence.dateAdded);
              for (const [field, claim] of [
                ['annual_profit', evidence?.annualProfit], ['annual_revenue', evidence?.annualRevenue],
                ['asking_price', evidence?.askingPrice],
              ]) if (claim) add('accepted_source_record', field, claim);
            }
            database.prepare(`UPDATE deal_hunter_source_freshness_state SET accepted_generation = ?,
              accepted_run_id = ?, accepted_digest = ?, accepted_at = ?, projection_state = 'deferred'
              WHERE source_id = ?`).run(run.generation, run.runId, admission.freshness_digest, acceptedAt, value.source_id);
            return database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
              WHERE source_id = ? ORDER BY observed_at DESC, id ASC`).all(value.source_id)
              .map(normalizeDealHunterOpportunitySourceObservationRow);
          }
          const insertEvidence = database.prepare(`INSERT INTO deal_hunter_freshness_evidence (
            id, source_id, source_name, source_record_id, run_id, generation, record_digest,
            event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
            raw_header, raw_value, publication_meaning, publication_precision,
            publication_offset, publication_date, publication_instant, publication_state,
            after_value, metric, currency, period
          ) VALUES (
            @id, @source_id, @source_name, @source_record_id, @run_id, @generation, @record_digest,
            @event_type, @field_key, @accepted_at, @canonical_id, @canonical_id,
            @raw_header, @raw_value, @publication_meaning, @publication_precision,
            @publication_offset, @publication_date, @publication_instant, @publication_state,
            @after_value, @metric, @currency, @period
          )`);
          for (const record of value.records) {
            const sourceRecordId = record.source_record_id;
            const freshnessEvidence = normalizeSourceFreshnessEvidence(record.freshness_evidence);
            const recordDigest = createHash('sha256').update(JSON.stringify({
              sourceRecordId,
              observations: record.observations.map(({ field, value: observedValue }) => [field, observedValue])
                .sort(([left], [right]) => left.localeCompare(right)),
              freshnessEvidence,
            })).digest('hex');
            const current = [...currentByRecord.values()].find((row) => row.source_record_id === sourceRecordId);
            const priorEvidence = current?.accepted_evidence_id
              ? database.prepare('SELECT * FROM deal_hunter_freshness_evidence WHERE id = ?').get(current.accepted_evidence_id)
              : null;
            if (priorEvidence?.record_digest === recordDigest && current.opportunity_id === record.opportunity_id) {
              evidenceByRecord.set(sourceRecordId, { coreId: current.accepted_evidence_id, changed: false });
              continue;
            }
            const eventId = (eventType, fieldKey = '') => `fl01:${createHash('sha256')
              .update([run.runId, value.source_id, sourceRecordId, eventType, fieldKey].join('\u0000')).digest('hex')}`;
            const writeEvent = (eventType, fieldKey, claim, afterValue = null) => {
              const id = eventId(eventType, fieldKey);
              insertEvidence.run({
                id, source_id: value.source_id, source_name: value.source_name,
                source_record_id: sourceRecordId, run_id: run.runId, generation: run.generation,
                record_digest: recordDigest, event_type: eventType, field_key: fieldKey,
                accepted_at: acceptedAt, canonical_id: record.opportunity_id,
                raw_header: claim?.rawHeader || null, raw_value: claim?.rawValue || null,
                publication_meaning: claim?.meaning || 'unknown',
                publication_precision: eventType === 'publication_evidence'
                  ? (claim?.precision === 'datetime' ? 'instant' : claim?.precision || 'unknown') : 'unknown',
                publication_offset: claim?.offset || null,
                publication_date: acceptedPublicationClaim(claim, acceptedAt).date,
                publication_instant: acceptedPublicationClaim(claim, acceptedAt).instant,
                publication_state: acceptedPublicationClaim(claim, acceptedAt).state,
                after_value: afterValue, metric: claim?.metric || 'unknown',
                currency: claim?.currency || 'unknown', period: claim?.period || 'unknown',
              });
              return id;
            };
            const coreId = writeEvent('accepted_source_record', '', null);
            const earlierProven = database.prepare(`SELECT evidence.id, evidence.accepted_at,
                evidence.run_id, evidence.source_record_id, evidence.identity_exception_id
                FROM deal_hunter_freshness_evidence AS evidence
              LEFT JOIN deal_hunter_identity_exceptions AS exception
                ON exception.id = evidence.identity_exception_id
              WHERE evidence.source_id = ?
                AND evidence.run_id <> ?
                AND evidence.event_type = 'accepted_source_record' AND evidence.field_key = ''
                AND (evidence.current_canonical_id = ? OR (evidence.current_canonical_id IS NULL
                  AND exception.status = 'resolved'
                  AND json_extract(exception.metadata, '$.resolvedOpportunityId') = ?))
              ORDER BY evidence.accepted_at, evidence.id LIMIT 1`
            ).get(value.source_id, run.runId, record.opportunity_id, record.opportunity_id);
            if (earlierProven?.identity_exception_id) {
              database.prepare(`UPDATE deal_hunter_freshness_evidence
                SET current_canonical_id = ?, binding_audit_id = ?
                WHERE source_id = ? AND source_record_id = ? AND run_id = ?
                  AND current_canonical_id IS NULL AND identity_exception_id = ?`
              ).run(record.opportunity_id, run.runId, value.source_id,
                earlierProven.source_record_id, earlierProven.run_id, earlierProven.identity_exception_id);
            }
            if (freshnessEvidence?.dateAdded) writeEvent('publication_evidence', 'date_added', freshnessEvidence.dateAdded);
            for (const [fieldKey, claim] of [
              ['annual_profit', freshnessEvidence?.annualProfit], ['annual_revenue', freshnessEvidence?.annualRevenue],
              ['asking_price', freshnessEvidence?.askingPrice],
            ]) {
              if (!claim) continue;
              const parsedValue = Number(String(claim.rawValue).replaceAll(/[$,]/g, ''));
              const afterValue = Number.isFinite(parsedValue) ? parsedValue : null;
              const afterId = writeEvent('accepted_source_record', fieldKey, claim, afterValue);
              const beforeObservation = currentByRecord.get(`${sourceRecordId}\u0000${fieldKey}`);
              const beforeCore = beforeObservation?.accepted_evidence_id
                ? database.prepare('SELECT run_id FROM deal_hunter_freshness_evidence WHERE id = ?').get(beforeObservation.accepted_evidence_id)
                : null;
              const before = beforeCore ? database.prepare(`SELECT * FROM deal_hunter_freshness_evidence
                WHERE run_id = ? AND source_id = ? AND source_record_id = ?
                  AND event_type = 'accepted_source_record' AND field_key = ? LIMIT 1`
              ).get(beforeCore.run_id, value.source_id, sourceRecordId, fieldKey)
                : database.prepare(`SELECT * FROM deal_hunter_freshness_evidence
                  WHERE source_id = ? AND source_record_id = ? AND field_key = ?
                    AND event_type = 'accepted_source_record' AND run_id <> ?
                    AND current_canonical_id = ?
                  ORDER BY accepted_at DESC, id DESC LIMIT 1`
                ).get(value.source_id, sourceRecordId, fieldKey, run.runId, record.opportunity_id);
              if (beforeObservation?.opportunity_id !== record.opportunity_id
                || before?.after_value === afterValue) continue;
              const competing = database.prepare(`SELECT 1 FROM deal_hunter_opportunity_source_observations
                WHERE opportunity_id = ? AND source_id <> ? AND field = ? AND value <> ? LIMIT 1`
              ).get(record.opportunity_id, value.source_id, fieldKey, String(afterValue));
              const comparable = before && !competing && before.after_value !== null && afterValue !== null
                && claim.metric !== 'unknown' && claim.currency !== 'unknown' && claim.period !== 'unknown'
                && before.metric === claim.metric && before.currency === claim.currency
                && before.period === claim.period && before.current_canonical_id === record.opportunity_id;
              const classification = comparable ? 'comparable_change' : competing ? 'conflict' : 'new_evidence';
              const transitionType = comparable ? 'material_change' : 'evidence_state_change';
              const revision = comparable
                ? database.prepare('SELECT material_revision FROM deal_hunter_opportunities WHERE opportunity_id = ?')
                  .get(record.opportunity_id).material_revision + 1
                : null;
              database.prepare(`INSERT INTO deal_hunter_freshness_evidence (
                id, source_id, source_name, source_record_id, run_id, generation, record_digest,
                event_type, field_key, accepted_at, original_canonical_id, current_canonical_id,
                before_value, after_value, before_evidence_id, after_evidence_id,
                metric, currency, period, classification, material_revision
              ) VALUES (
                @id, @source_id, @source_name, @source_record_id, @run_id, @generation, @record_digest,
                @event_type, @field_key, @accepted_at, @canonical_id, @canonical_id,
                @before_value, @after_value, @before_evidence_id, @after_evidence_id,
                @metric, @currency, @period, @classification, @material_revision
              )`).run({
                id: eventId(transitionType, fieldKey), source_id: value.source_id,
                source_name: value.source_name, source_record_id: sourceRecordId,
                run_id: run.runId, generation: run.generation, record_digest: recordDigest,
                event_type: transitionType, field_key: fieldKey, accepted_at: acceptedAt,
                canonical_id: record.opportunity_id, before_value: before?.after_value ?? null,
                after_value: afterValue, before_evidence_id: before?.id || null,
                after_evidence_id: afterId, metric: claim.metric, currency: claim.currency,
                period: claim.period, classification, material_revision: revision,
              });
              if (comparable) database.prepare(`UPDATE deal_hunter_opportunities
                SET material_revision = ?, last_material_change_at = ? WHERE opportunity_id = ?`
              ).run(revision, acceptedAt, record.opportunity_id);
            }
            evidenceByRecord.set(sourceRecordId, { coreId, changed: true });
            database.prepare(`UPDATE deal_hunter_opportunities SET first_accepted_at = ?,
              first_discovery_evidence_id = ?, discovery_state = ?,
              discovery_revision = discovery_revision + 1
              WHERE opportunity_id = ? AND discovery_state = 'pending' AND first_accepted_at IS NULL`
            ).run(earlierProven?.accepted_at || acceptedAt, earlierProven?.id || coreId,
              earlierProven || current?.accepted_evidence_id === null && current?.opportunity_id === record.opportunity_id
                ? 'known_recovered' : 'known_prospective', record.opportunity_id);
          }
        }
        const desiredKeys = new Set();
        const upsert = database.prepare(`
          INSERT INTO deal_hunter_opportunity_source_observations (
            id, opportunity_id, source_id, source_name, source_record_id, field, value,
            observed_at, created_at, updated_at, accepted_at, accepted_run_id,
            accepted_evidence_id, publication_raw_header, publication_raw_value,
            publication_precision, publication_offset, publication_meaning
          ) VALUES (
            @id, @opportunity_id, @source_id, @source_name, @source_record_id, @field, @value,
            @observed_at, @created_at, @updated_at, @accepted_at, @accepted_run_id,
            @accepted_evidence_id, @publication_raw_header, @publication_raw_value,
            @publication_precision, @publication_offset, @publication_meaning
          )
          ON CONFLICT(opportunity_id, source_id, source_record_id, field) DO UPDATE SET
            source_name = excluded.source_name,
            value = excluded.value,
            observed_at = excluded.observed_at,
            updated_at = excluded.updated_at,
            accepted_at = CASE WHEN excluded.accepted_run_id IS NOT NULL THEN excluded.accepted_at
              WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value THEN NULL
              ELSE deal_hunter_opportunity_source_observations.accepted_at END,
            accepted_run_id = CASE WHEN excluded.accepted_run_id IS NOT NULL THEN excluded.accepted_run_id
              WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value THEN NULL
              ELSE deal_hunter_opportunity_source_observations.accepted_run_id END,
            accepted_evidence_id = CASE WHEN excluded.accepted_run_id IS NOT NULL THEN excluded.accepted_evidence_id
              WHEN excluded.value IS NOT deal_hunter_opportunity_source_observations.value THEN NULL
              ELSE deal_hunter_opportunity_source_observations.accepted_evidence_id END,
            publication_raw_header = excluded.publication_raw_header,
            publication_raw_value = excluded.publication_raw_value,
            publication_precision = excluded.publication_precision,
            publication_offset = excluded.publication_offset,
            publication_meaning = excluded.publication_meaning
        `);
        for (const record of value.records) {
          for (const observation of record.observations) {
            desiredKeys.add([observation.opportunity_id, observation.source_record_id, observation.field].join('\u0000'));
            const evidence = evidenceByRecord.get(record.source_record_id);
            const publication = observation.field === 'date_added' ? record.freshness_evidence?.dateAdded : null;
            upsert.run({
              ...observation,
              accepted_at: acceptedAt,
              accepted_run_id: run?.runId || null,
              accepted_evidence_id: evidence?.coreId || null,
              publication_raw_header: publication?.rawHeader || null,
              publication_raw_value: publication?.rawValue || null,
              publication_precision: publication?.precision === 'datetime' ? 'instant' : publication?.precision || null,
              publication_offset: publication?.offset || null,
              publication_meaning: publication?.meaning || null,
            });
          }
        }

        const current = database.prepare(`
          SELECT opportunity_id, source_record_id, field, accepted_evidence_id
          FROM deal_hunter_opportunity_source_observations
          WHERE source_id = ?
        `).all(value.source_id);
        const remove = database.prepare(`
          DELETE FROM deal_hunter_opportunity_source_observations
          WHERE source_id = ? AND opportunity_id = ? AND source_record_id = ? AND field = ?
        `);
        for (const observation of current) {
          const key = [observation.opportunity_id, observation.source_record_id, observation.field].join('\u0000');
          if (!desiredKeys.has(key)) {
            if (run && ['asking_price', 'annual_profit', 'annual_revenue'].includes(observation.field)) {
              const previousCore = observation.accepted_evidence_id
                ? database.prepare('SELECT run_id FROM deal_hunter_freshness_evidence WHERE id = ?').get(observation.accepted_evidence_id)
                : null;
              const previousField = previousCore ? database.prepare(`SELECT * FROM deal_hunter_freshness_evidence
                WHERE run_id = ? AND source_id = ? AND source_record_id = ?
                  AND event_type = 'accepted_source_record' AND field_key = ? LIMIT 1`
              ).get(previousCore.run_id, value.source_id, observation.source_record_id, observation.field) : null;
              if (previousField) database.prepare(`INSERT INTO deal_hunter_freshness_evidence (
                id, source_id, source_name, source_record_id, run_id, generation, event_type,
                field_key, accepted_at, original_canonical_id, current_canonical_id,
                before_value, before_evidence_id, metric, currency, period, classification
              ) VALUES (?, ?, ?, ?, ?, ?, 'evidence_state_change', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disappearance')`
              ).run(`fl01:${createHash('sha256').update([run.runId, value.source_id,
                observation.source_record_id, 'evidence_state_change', observation.field].join('\u0000')).digest('hex')}`,
                value.source_id, value.source_name, observation.source_record_id, run.runId,
                run.generation, observation.field, acceptedAt, observation.opportunity_id,
                observation.opportunity_id, previousField.after_value, previousField.id,
                previousField.metric, previousField.currency, previousField.period);
            }
            remove.run(value.source_id, observation.opportunity_id, observation.source_record_id, observation.field);
          }
        }

        if (run) {
          database.prepare(`UPDATE deal_hunter_source_freshness_state SET accepted_generation = ?,
            accepted_run_id = ?, accepted_digest = ?, accepted_at = ?, projection_state = 'accepted'
            WHERE source_id = ?`).run(run.generation, run.runId, admission.freshness_digest, acceptedAt, value.source_id);
        }

        return database.prepare(`
          SELECT * FROM deal_hunter_opportunity_source_observations
          WHERE source_id = ?
          ORDER BY observed_at DESC, id ASC
        `).all(value.source_id)
          .map(normalizeDealHunterOpportunitySourceObservationRow);
      });
      return replace.immediate(normalizedSnapshot);
    },

    async linkDealHunterCrmSubmissionIfAuthorityCurrent({
      opportunityId,
      submissionId,
      expectedAuthorityRevision,
      updatedAt = '',
    } = {}) {
      const timestamp = updatedAt || new Date().toISOString();
      const transaction = database.transaction(() => {
        const candidateIds = [submissionId];
        const authority = dealHunterCrmMatchAuthoritySnapshot(database, {
          limit: dealHunterCrmMatchAuthorityMaximumRows,
          supersessionLimit: crmSubmissionSupersessionMaximumRows,
        });
        if (!authority.complete
          || typeof expectedAuthorityRevision !== 'string'
          || !expectedAuthorityRevision
          || authority.revision !== expectedAuthorityRevision) {
          throw dealHunterCrmMatchAuthorityError({ candidateIds });
        }
        assertCrmSubmissionWritableInTransaction(submissionId);

        const opportunity = database.prepare(`
          SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(opportunityId);
        if (!opportunity || opportunity.status !== 'active') {
          throw dealHunterCrmMatchAuthorityError({ candidateIds });
        }
        if (opportunity.primary_submission_id && opportunity.primary_submission_id !== submissionId) {
          throw dealHunterCrmMatchAuthorityError({ candidateIds: [opportunity.primary_submission_id, submissionId] });
        }

        const submission = authority.rawRows.find((row) => row.id === submissionId);
        if (!submission || ['archived', 'spam'].includes(String(submission.status || '').trim().toLowerCase())) {
          throw dealHunterCrmMatchAuthorityError({ candidateIds });
        }
        const directOwner = String(submission.deal_hunter_opportunity_id || '').trim();
        const metadataOwner = rawDealHunterCrmMetadataOwner(submission, candidateIds);
        if ((directOwner && directOwner !== opportunityId)
          || (metadataOwner && metadataOwner !== opportunityId)
          || (directOwner && metadataOwner && directOwner !== metadataOwner)) {
          throw dealHunterCrmMatchAuthorityError({ candidateIds });
        }

        const conflicting = authority.rawRows.find((row) => (
          row.id !== submissionId
          && String(row.deal_hunter_opportunity_id || '').trim() === opportunityId
        ));
        if (conflicting) {
          throw dealHunterCrmMatchAuthorityError({ candidateIds: [submissionId, conflicting.id] });
        }

        database.prepare(`
          UPDATE contact_submissions SET deal_hunter_opportunity_id = ?, updated_at = ? WHERE id = ?
        `).run(opportunityId, timestamp, submissionId);
        database.prepare(`
          UPDATE deal_hunter_opportunities SET primary_submission_id = ?, updated_at = ? WHERE opportunity_id = ?
        `).run(submissionId, timestamp, opportunityId);
      });
      transaction.immediate();
      return this.getDealHunterOpportunity(opportunityId);
    },

    async listDealHunterOpportunityAliases({ opportunityIds = [], aliasKeys = [], limit = 5000 } = {}) {
      const ids = normalizeList(opportunityIds);
      const keys = normalizeList(aliasKeys);
      const clauses = [];
      const params = [];
      if (ids.length > 0) {
        clauses.push(`opportunity_id IN (${placeholders(ids.length)})`);
        params.push(...ids);
      }
      if (keys.length > 0) {
        clauses.push(`alias_key IN (${placeholders(keys.length)})`);
        params.push(...keys);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 100000));
      return database.prepare(`
        SELECT * FROM deal_hunter_opportunity_aliases ${where}
        ORDER BY last_observed_at DESC, id
        LIMIT ?
      `).all(...params, safeLimit).map(normalizeDealHunterOpportunityAliasRow);
    },

    async upsertDealHunterOpportunityAlias(record = {}) {
      const transaction = database.transaction(() => {
        const opportunity = database.prepare(`
          SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(record.opportunity_id);
        if (opportunity?.status !== 'active') {
          throw new Error('A superseded or otherwise non-current opportunity cannot own a new alias.');
        }
        database.prepare(`
          INSERT INTO deal_hunter_opportunity_aliases (
            id, opportunity_id, alias_type, alias_value, alias_key, source,
            first_observed_at, last_observed_at, evidence_version, resolution_method,
            confidence_state, resolved_by, metadata
          ) VALUES (
            @id, @opportunity_id, @alias_type, @alias_value, @alias_key, @source,
            @first_observed_at, @last_observed_at, @evidence_version, @resolution_method,
            @confidence_state, @resolved_by, @metadata
          )
          ON CONFLICT(alias_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            source = COALESCE(excluded.source, deal_hunter_opportunity_aliases.source),
            metadata = excluded.metadata
          WHERE deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id
        `).run({
          ...record,
          source: record.source || null,
          resolved_by: record.resolved_by || null,
          metadata: JSON.stringify(record.metadata || {}),
        });
      });
      transaction.immediate();
      return normalizeDealHunterOpportunityAliasRow(database.prepare(`
        SELECT * FROM deal_hunter_opportunity_aliases WHERE alias_key = ? LIMIT 1
      `).get(record.alias_key));
    },

    async linkDealHunterOpportunityAliases(records = []) {
      const aliases = Array.isArray(records) ? records.filter((record) => record?.alias_key && record?.opportunity_id) : [];
      if (aliases.length === 0) return { linked: true, conflict: null, aliases: [] };
      const opportunityIds = new Set(aliases.map((record) => record.opportunity_id));
      if (opportunityIds.size !== 1) throw new Error('A canonical alias batch must target exactly one opportunity.');
      const transaction = database.transaction(() => {
        const targetOpportunityId = [...opportunityIds][0];
        const opportunity = database.prepare(`
          SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(targetOpportunityId);
        if (opportunity?.status !== 'active') {
          throw new Error('A superseded or otherwise non-current opportunity cannot own new aliases.');
        }
        for (const record of aliases) {
          const owner = database.prepare(`
            SELECT * FROM deal_hunter_opportunity_aliases WHERE alias_key = ? LIMIT 1
          `).get(record.alias_key);
          if (owner?.opportunity_id && owner.opportunity_id !== record.opportunity_id) {
            return { linked: false, conflict: normalizeDealHunterOpportunityAliasRow(owner), aliases: [] };
          }
        }
        const statement = database.prepare(`
          INSERT INTO deal_hunter_opportunity_aliases (
            id, opportunity_id, alias_type, alias_value, alias_key, source,
            first_observed_at, last_observed_at, evidence_version, resolution_method,
            confidence_state, resolved_by, metadata
          ) VALUES (
            @id, @opportunity_id, @alias_type, @alias_value, @alias_key, @source,
            @first_observed_at, @last_observed_at, @evidence_version, @resolution_method,
            @confidence_state, @resolved_by, @metadata
          )
          ON CONFLICT(alias_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            source = COALESCE(excluded.source, deal_hunter_opportunity_aliases.source),
            metadata = excluded.metadata
          WHERE deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id
        `);
        for (const record of aliases) {
          statement.run({
            ...record,
            source: record.source || null,
            resolved_by: record.resolved_by || null,
            metadata: JSON.stringify(record.metadata || {}),
          });
        }
        return {
          linked: true,
          conflict: null,
          aliases: aliases.map((record) => normalizeDealHunterOpportunityAliasRow(database.prepare(`
            SELECT * FROM deal_hunter_opportunity_aliases WHERE alias_key = ? LIMIT 1
          `).get(record.alias_key))),
        };
      });
      return transaction();
    },

    async upsertDealHunterIdentityException(record = {}) {
      database.prepare(`
        INSERT INTO deal_hunter_identity_exceptions (
          id, created_at, updated_at, status, observed_deal_key, observed_name,
          observed_recipient, candidate_opportunity_ids, reason, evidence_version,
          resolved_at, resolved_by, resolution_reason, metadata
        ) VALUES (
          @id, @created_at, @updated_at, @status, @observed_deal_key, @observed_name,
          @observed_recipient, @candidate_opportunity_ids, @reason, @evidence_version,
          @resolved_at, @resolved_by, @resolution_reason, @metadata
        )
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          status = excluded.status,
          candidate_opportunity_ids = excluded.candidate_opportunity_ids,
          reason = excluded.reason,
          resolved_at = excluded.resolved_at,
          resolved_by = excluded.resolved_by,
          resolution_reason = excluded.resolution_reason,
          metadata = excluded.metadata
      `).run({
        ...record,
        observed_deal_key: record.observed_deal_key || null,
        observed_name: record.observed_name || null,
        observed_recipient: record.observed_recipient || null,
        candidate_opportunity_ids: JSON.stringify(record.candidate_opportunity_ids || []),
        resolved_at: record.resolved_at || null,
        resolved_by: record.resolved_by || null,
        resolution_reason: record.resolution_reason || null,
        metadata: JSON.stringify(record.metadata || {}),
      });
      return normalizeDealHunterIdentityExceptionRow(database.prepare(`
        SELECT * FROM deal_hunter_identity_exceptions WHERE id = ? LIMIT 1
      `).get(record.id));
    },

    async listDealHunterIdentityExceptions({ statuses = [], limit = 1000 } = {}) {
      const safeStatuses = normalizeList(statuses, 20);
      const where = safeStatuses.length > 0 ? `WHERE status IN (${placeholders(safeStatuses.length)})` : '';
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 100000));
      return database.prepare(`
        SELECT * FROM deal_hunter_identity_exceptions ${where}
        ORDER BY updated_at DESC, id
        LIMIT ?
      `).all(...safeStatuses, safeLimit).map(normalizeDealHunterIdentityExceptionRow);
    },

    async listCimStage2IdentityExceptions({ statuses = [], limit = 5000 } = {}) {
      const safeStatuses = normalizeList(statuses, 20);
      const where = safeStatuses.length > 0 ? `WHERE status IN (${placeholders(safeStatuses.length)})` : '';
      return database.prepare(`
        SELECT id, status, created_at, updated_at
        FROM deal_hunter_identity_exceptions ${where}
        ORDER BY updated_at DESC, id
        LIMIT ?
      `).all(...safeStatuses, Math.max(1, Math.min(Number(limit) || 5000, 100000)));
    },

    async claimDealHunterCimOpportunity({ opportunityId = '', requestId = '', recipientEmail = '', allowedRequestIds = [], nowIso = '', metadata = {} } = {}) {
      if (!opportunityId || !requestId || !recipientEmail || !nowIso) return { claimed: false, reason: 'invalid-claim', claim: null };
      const transaction = database.transaction(() => {
        const opportunity = database.prepare(`
          SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(opportunityId);
        if (opportunity?.status !== 'active') {
          return { claimed: false, reason: 'opportunity-not-current', claim: null };
        }
        const existing = database.prepare(`
          SELECT * FROM deal_hunter_cim_opportunity_claims WHERE opportunity_id = ? LIMIT 1
        `).get(opportunityId);
        const allowed = new Set([requestId, ...normalizeList(allowedRequestIds)]);
        if (existing && !allowed.has(existing.request_id)) {
          return { claimed: false, reason: 'opportunity-already-claimed', claim: { ...existing, metadata: parseJsonColumn(existing.metadata, {}) } };
        }
        database.prepare(`
          INSERT INTO deal_hunter_cim_opportunity_claims (
            opportunity_id, request_id, recipient_email, state, claimed_at, updated_at, metadata
          ) VALUES (?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT(opportunity_id) DO UPDATE SET
            request_id = excluded.request_id,
            recipient_email = excluded.recipient_email,
            state = 'active',
            updated_at = excluded.updated_at,
            metadata = excluded.metadata
        `).run(opportunityId, requestId, String(recipientEmail).toLowerCase(), nowIso, nowIso, JSON.stringify(metadata || {}));
        const claim = database.prepare(`
          SELECT * FROM deal_hunter_cim_opportunity_claims WHERE opportunity_id = ? LIMIT 1
        `).get(opportunityId);
        return { claimed: true, reason: '', claim: { ...claim, metadata: parseJsonColumn(claim.metadata, {}) } };
      });
      return transaction.immediate();
    },

    async getDealHunterCimOpportunityClaim(opportunityId) {
      if (!opportunityId) return null;
      const row = database.prepare(`SELECT * FROM deal_hunter_cim_opportunity_claims WHERE opportunity_id = ? LIMIT 1`).get(opportunityId);
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async getDealHunterCimRecipientClaim(recipientEmail) {
      const recipient = String(recipientEmail || '').trim().toLowerCase();
      if (!recipient) return null;
      const row = database.prepare(`SELECT * FROM deal_hunter_cim_recipient_claims WHERE recipient_email = ? LIMIT 1`).get(recipient);
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async claimDealHunterCimRecipient({ recipientEmail = '', requestId = '', opportunityId = '', nowIso = '', expiresAt = '', metadata = {} } = {}) {
      if (!recipientEmail || !requestId || !opportunityId || !nowIso || !expiresAt) return { claimed: false, reason: 'invalid-claim' };
      const recipient = String(recipientEmail).trim().toLowerCase();
      const transaction = database.transaction(() => {
        const opportunity = database.prepare(`
          SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(opportunityId);
        if (opportunity?.status !== 'active') {
          return { claimed: false, reason: 'opportunity-not-current', claim: null };
        }
        const existing = database.prepare(`SELECT * FROM deal_hunter_cim_recipient_claims WHERE recipient_email = ? LIMIT 1`).get(recipient);
        if (existing && existing.request_id !== requestId && Date.parse(existing.expires_at) > Date.parse(nowIso)) {
          return { claimed: false, reason: 'recipient-send-in-progress', claim: { ...existing, metadata: parseJsonColumn(existing.metadata, {}) } };
        }
        database.prepare(`
          INSERT INTO deal_hunter_cim_recipient_claims (
            recipient_email, request_id, opportunity_id, claimed_at, expires_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(recipient_email) DO UPDATE SET
            request_id = excluded.request_id,
            opportunity_id = excluded.opportunity_id,
            claimed_at = excluded.claimed_at,
            expires_at = excluded.expires_at,
            metadata = excluded.metadata
        `).run(recipient, requestId, opportunityId, nowIso, expiresAt, JSON.stringify(metadata || {}));
        return { claimed: true, reason: '', claim: { recipient_email: recipient, request_id: requestId, opportunity_id: opportunityId, claimed_at: nowIso, expires_at: expiresAt, metadata } };
      });
      return transaction.immediate();
    },

    async releaseDealHunterCimRecipientClaim({ recipientEmail = '', requestId = '' } = {}) {
      if (!recipientEmail || !requestId) return false;
      return database.prepare(`DELETE FROM deal_hunter_cim_recipient_claims WHERE recipient_email = ? AND request_id = ?`)
        .run(String(recipientEmail).trim().toLowerCase(), requestId).changes > 0;
    },

    async upsertDealHunterCimRecipientOverride(record = {}) {
      const transaction = database.transaction(() => {
        const existing = database.prepare(`
          SELECT opportunity_id
          FROM deal_hunter_cim_recipient_overrides
          WHERE id = ?
          LIMIT 1
        `).get(record.id);
        if (existing && existing.opportunity_id !== record.opportunity_id) {
          throw new Error('CIM recipient override ID already belongs to another canonical opportunity.');
        }
        const opportunity = database.prepare(`
          SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(record.opportunity_id);
        if (opportunity?.status !== 'active') {
          throw new Error('A superseded or otherwise non-current opportunity cannot receive CIM authority.');
        }
        database.prepare(`
          INSERT INTO deal_hunter_cim_recipient_overrides (
            id, opportunity_id, recipient_email, created_at, expires_at, consumed_at, created_by, reason, metadata
          ) VALUES (
            @id, @opportunity_id, @recipient_email, @created_at, @expires_at, @consumed_at, @created_by, @reason, @metadata
          )
          ON CONFLICT(id) DO UPDATE SET
            expires_at = excluded.expires_at,
            consumed_at = excluded.consumed_at,
            reason = excluded.reason,
            metadata = excluded.metadata
          WHERE deal_hunter_cim_recipient_overrides.opportunity_id = excluded.opportunity_id
        `).run({ ...record, recipient_email: String(record.recipient_email || '').toLowerCase(), consumed_at: record.consumed_at || null, metadata: JSON.stringify(record.metadata || {}) });
      });
      transaction.immediate();
      const row = database.prepare(`SELECT * FROM deal_hunter_cim_recipient_overrides WHERE id = ? LIMIT 1`).get(record.id);
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async getActiveDealHunterCimRecipientOverride({ opportunityId = '', recipientEmail = '', nowIso = '' } = {}) {
      const row = database.prepare(`
        SELECT override.*
        FROM deal_hunter_cim_recipient_overrides AS override
        JOIN deal_hunter_opportunities AS opportunity
          ON opportunity.opportunity_id = override.opportunity_id
         AND opportunity.status = 'active'
        WHERE override.opportunity_id = ? AND LOWER(override.recipient_email) = ?
          AND override.consumed_at IS NULL AND override.expires_at > ?
        ORDER BY override.created_at DESC LIMIT 1
      `).get(opportunityId, String(recipientEmail).toLowerCase(), nowIso);
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async consumeDealHunterCimRecipientOverride(id, consumedAt) {
      database.prepare(`UPDATE deal_hunter_cim_recipient_overrides SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(consumedAt, id);
      const row = database.prepare(`SELECT * FROM deal_hunter_cim_recipient_overrides WHERE id = ? LIMIT 1`).get(id);
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async getDealHunterCimSafetySettings() {
      return normalizeDealHunterCimSafetySettingsRow(database.prepare(`
        SELECT * FROM deal_hunter_cim_safety_settings WHERE id = 'global' LIMIT 1
      `).get());
    },

    async upsertDealHunterCimSafetySettings(settings = {}) {
      database.prepare(`
        INSERT INTO deal_hunter_cim_safety_settings (id, updated_at, outreach_paused, updated_by, metadata)
        VALUES ('global', @updated_at, @outreach_paused, @updated_by, @metadata)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          outreach_paused = excluded.outreach_paused,
          updated_by = excluded.updated_by,
          metadata = excluded.metadata
      `).run({
        updated_at: settings.updated_at || new Date().toISOString(),
        outreach_paused: settings.outreach_paused ? 1 : 0,
        updated_by: settings.updated_by || null,
        metadata: JSON.stringify(settings.metadata || {}),
      });
      return this.getDealHunterCimSafetySettings();
    },

    async upsertDealHunterCimRepairManifest(record = {}) {
      database.prepare(`
        INSERT INTO deal_hunter_cim_repair_manifests (
          id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest, metadata
        ) VALUES (
          @id, @created_at, @updated_at, @mode, @status, @actor, @backup_reference, @checksum, @manifest, @metadata
        )
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          status = excluded.status,
          backup_reference = excluded.backup_reference,
          checksum = excluded.checksum,
          manifest = excluded.manifest,
          metadata = excluded.metadata
      `).run({
        ...record,
        backup_reference: record.backup_reference || null,
        manifest: JSON.stringify(record.manifest || {}),
        metadata: JSON.stringify(record.metadata || {}),
      });
      return normalizeDealHunterRepairManifestRow(database.prepare(`
        SELECT * FROM deal_hunter_cim_repair_manifests WHERE id = ? LIMIT 1
      `).get(record.id));
    },

    async listDealHunterCimRepairManifests({ limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
      return database.prepare(`SELECT * FROM deal_hunter_cim_repair_manifests ORDER BY created_at DESC LIMIT ?`)
        .all(safeLimit).map(normalizeDealHunterRepairManifestRow);
    },

    async applyDealHunterCimIdentityRepair(batch = {}) {
      const transaction = database.transaction(() => {
        const counts = {
          opportunities: 0,
          aliases: 0,
          requests: 0,
          imports: 0,
          communications: 0,
          emailEvents: 0,
          activities: 0,
          stoppedSequences: 0,
          repairActivities: 0,
        };
        for (const opportunity of batch.opportunityRecords || []) {
          counts.opportunities += database.prepare(`
            INSERT INTO deal_hunter_opportunities (
              opportunity_id, created_at, updated_at, canonical_name, canonical_recipient,
              canonical_location, primary_submission_id, identity_version, status, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(opportunity_id) DO UPDATE SET
              updated_at = excluded.updated_at,
              canonical_name = excluded.canonical_name,
              canonical_recipient = COALESCE(excluded.canonical_recipient, deal_hunter_opportunities.canonical_recipient),
              canonical_location = COALESCE(excluded.canonical_location, deal_hunter_opportunities.canonical_location),
              primary_submission_id = COALESCE(excluded.primary_submission_id, deal_hunter_opportunities.primary_submission_id),
              metadata = excluded.metadata
          `).run(
            opportunity.opportunity_id,
            opportunity.created_at,
            opportunity.updated_at,
            opportunity.canonical_name,
            opportunity.canonical_recipient || null,
            opportunity.canonical_location || null,
            opportunity.primary_submission_id || null,
            opportunity.identity_version,
            opportunity.status || 'active',
            JSON.stringify(opportunity.metadata || {}),
          ).changes;
        }
        for (const alias of batch.aliasRecords || []) {
          const result = database.prepare(`
            INSERT INTO deal_hunter_opportunity_aliases (
              id, opportunity_id, alias_type, alias_value, alias_key, source,
              first_observed_at, last_observed_at, evidence_version, resolution_method,
              confidence_state, resolved_by, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(alias_key) DO UPDATE SET
              last_observed_at = excluded.last_observed_at,
              metadata = excluded.metadata
            WHERE deal_hunter_opportunity_aliases.opportunity_id = excluded.opportunity_id
          `).run(
            alias.id,
            alias.opportunity_id,
            alias.alias_type,
            alias.alias_value,
            alias.alias_key,
            alias.source || null,
            alias.first_observed_at,
            alias.last_observed_at,
            alias.evidence_version,
            alias.resolution_method,
            alias.confidence_state,
            alias.resolved_by || null,
            JSON.stringify(alias.metadata || {}),
          );
          if (result.changes === 0) {
            const owner = database.prepare(`SELECT opportunity_id FROM deal_hunter_opportunity_aliases WHERE alias_key = ?`).get(alias.alias_key);
            if (owner?.opportunity_id !== alias.opportunity_id) {
              throw new Error(`Canonical alias conflict for ${alias.alias_key}`);
            }
          }
          counts.aliases += result.changes;
        }
        const applyLinks = (table, links, { hasUpdatedAt = false } = {}) => {
          for (const link of links || []) {
            const updatedAt = hasUpdatedAt ? ', updated_at = COALESCE(?, updated_at)' : '';
            const params = [link.opportunity_id, link.submission_id || null];
            if (hasUpdatedAt) params.push(link.updated_at || null);
            params.push(link.id);
            if (hasUpdatedAt) params.push(link.expected_updated_at || null);
            params.push(link.opportunity_id, link.submission_id || null, link.submission_id || null);
            const result = database.prepare(`
              UPDATE ${table}
              SET opportunity_id = ?, submission_id = COALESCE(?, submission_id)${updatedAt}
              WHERE id = ?
                ${hasUpdatedAt ? 'AND updated_at IS ?' : ''}
                AND (opportunity_id IS NOT ? OR (? IS NOT NULL AND submission_id IS NOT ?))
            `).run(...params);
            if (result.changes === 0) {
              const current = database.prepare(`SELECT opportunity_id, submission_id${hasUpdatedAt ? ', updated_at' : ''} FROM ${table} WHERE id = ? LIMIT 1`).get(link.id);
              const desired = current
                && current.opportunity_id === link.opportunity_id
                && (!link.submission_id || current.submission_id === link.submission_id);
              if (!desired) {
                const reason = current && hasUpdatedAt && current.updated_at !== link.expected_updated_at
                  ? 'version changed after the dry-run audit'
                  : 'record is missing or no longer matches the repair plan';
                throw new Error(`CIM identity repair conflict for ${table}:${link.id}: ${reason}`);
              }
            }
            counts[link.countKey] += result.changes;
          }
        };
        applyLinks('deal_hunter_cim_requests', (batch.requestLinks || []).map((item) => ({ ...item, countKey: 'requests' })), { hasUpdatedAt: true });
        applyLinks('deal_hunter_crm_imports', (batch.importLinks || []).map((item) => ({ ...item, countKey: 'imports' })), { hasUpdatedAt: true });
        applyLinks('crm_communications', (batch.communicationLinks || []).map((item) => ({ ...item, countKey: 'communications' })), { hasUpdatedAt: true });
        applyLinks('email_events', (batch.emailEventLinks || []).map((item) => ({ ...item, countKey: 'emailEvents' })));
        applyLinks('crm_activity_events', (batch.activityLinks || []).map((item) => ({ ...item, countKey: 'activities' })));

        for (const stopped of batch.stopRequests || []) {
          counts.stoppedSequences += database.prepare(`
            UPDATE deal_hunter_cim_requests
            SET request_state = 'stopped', follow_up_state = 'stopped', next_follow_up_at = NULL,
                updated_at = ?, last_activity_at = ?, metadata = ?
            WHERE id = ? AND (next_follow_up_at IS NOT NULL OR follow_up_state NOT IN ('stopped', 'completed'))
          `).run(
            stopped.updated_at,
            stopped.updated_at,
            JSON.stringify(stopped.metadata || {}),
            stopped.id,
          ).changes;
        }
        for (const event of batch.repairActivities || []) {
          counts.repairActivities += database.prepare(`
            INSERT OR IGNORE INTO crm_activity_events (
              id, submission_id, opportunity_id, created_at, actor, role, event_type, summary, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            event.id,
            event.submission_id,
            event.opportunity_id || null,
            event.created_at,
            event.actor,
            event.role,
            event.event_type,
            event.summary,
            JSON.stringify(event.metadata || {}),
          ).changes;
        }
        if (batch.manifest?.id) {
          database.prepare(`
            INSERT INTO deal_hunter_cim_repair_manifests (
              id, created_at, updated_at, mode, status, actor, backup_reference, checksum, manifest, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `).run(
            batch.manifest.id,
            batch.manifest.created_at,
            batch.manifest.updated_at,
            batch.manifest.mode,
            batch.manifest.status,
            batch.manifest.actor,
            batch.manifest.backup_reference || null,
            batch.manifest.checksum,
            JSON.stringify(batch.manifest.manifest || {}),
            JSON.stringify(batch.manifest.metadata || {}),
          );
        }
        return counts;
      });
      return transaction.immediate();
    },

    async getDealHunterCimRequestById(id) {
      if (!id) return null;
      return normalizeDealHunterCimRequestRow(
        database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(String(id).trim()),
      );
    },

    async getDealHunterCimRequestByReplyToAddress(replyToAddress, requestToken = '') {
      const normalizedAddress = String(replyToAddress || '').trim().toLowerCase();
      if (normalizedAddress) {
        const exact = database.prepare(`
          SELECT * FROM deal_hunter_cim_requests
          WHERE LOWER(COALESCE(reply_to_address, '')) = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(normalizedAddress);
        if (exact) return normalizeDealHunterCimRequestRow(exact);
      }

      const token = String(requestToken || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
      if (!token) return null;
      const matches = database.prepare(`
        SELECT * FROM deal_hunter_cim_requests
        WHERE LOWER(id) LIKE ?
        ORDER BY created_at ASC, id ASC
        LIMIT 2
      `).all(`${token}%`);
      return matches.length === 1 ? normalizeDealHunterCimRequestRow(matches[0]) : null;
    },

	    async getDealHunterCimRequest({ dealKey = '', recipientEmail = '' } = {}) {
      const normalizedEmail = String(recipientEmail || '').trim().toLowerCase();

      if (!dealKey || !normalizedEmail) {
        return null;
      }

      const row = database
        .prepare(
          `
            SELECT * FROM deal_hunter_cim_requests
            WHERE deal_key = ? AND LOWER(recipient_email) = ?
            ORDER BY updated_at DESC
            LIMIT 1
          `,
        )
        .get(dealKey, normalizedEmail);

      return normalizeDealHunterCimRequestRow(row);
    },

    async listDealHunterCimRequests({
      dealKeys = [],
      opportunityIds = [],
      recipientEmails = [],
      statuses = [],
      dueBefore = '',
      detailAuthority = false,
      limit = 1000,
    } = {}) {
      const keys = normalizeList(dealKeys);
      const canonicalIds = normalizeList(opportunityIds);
      const recipients = normalizeList(recipientEmails).map((value) => value.toLowerCase());
      const safeStatuses = normalizeList(statuses);
      const clauses = [];
      const params = [];

      if (keys.length > 0) {
        clauses.push(`deal_key IN (${placeholders(keys.length)})`);
        params.push(...keys);
      }

      if (canonicalIds.length > 0) {
        clauses.push(`opportunity_id IN (${placeholders(canonicalIds.length)})`);
        params.push(...canonicalIds);
      }

      const useDetailAuthority = detailAuthority === true
        && canonicalIds.length > 0
        && keys.length === 0
        && recipients.length === 0
        && safeStatuses.length === 0
        && !dueBefore;
      if (useDetailAuthority) {
        clauses.push('deal_hunter_cim_record_id_sort_key(id) IS NOT NULL');
      }

      if (recipients.length > 0) {
        clauses.push(`LOWER(recipient_email) IN (${placeholders(recipients.length)})`);
        params.push(...recipients);
      }

      if (safeStatuses.length > 0) {
        clauses.push(`status IN (${placeholders(safeStatuses.length)})`);
        params.push(...safeStatuses);
      }

      if (dueBefore) {
        clauses.push('next_follow_up_at IS NOT NULL AND next_follow_up_at <= ?');
        params.push(dueBefore);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 100000));
      // Only the detail projection explicitly requests strict timestamp and
      // canonical-ID authority before its bounded candidate window. Generic
      // opportunity history retains its established provider-native order and
      // malformed legacy membership for audit and operational safety.
      const orderClause = useDetailAuthority
        ? `
          ORDER BY
            CASE WHEN deal_hunter_cim_authority_sort_key(updated_at, created_at) IS NULL THEN 1 ELSE 0 END ASC,
            deal_hunter_cim_authority_sort_key(updated_at, created_at) DESC,
            deal_hunter_cim_record_id_sort_key(id) ASC
        `
        : 'ORDER BY updated_at DESC, id ASC';
      return database
        .prepare(
          `
            SELECT * FROM deal_hunter_cim_requests
            ${whereClause}
            ${orderClause}
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeDealHunterCimRequestRow);
    },

    async listCimStage2MetricRequests({ limit = 10000 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 10000, 100000));
      return database.prepare(`
        SELECT id, created_at, updated_at, deal_key, opportunity_id, recipient_email,
          status, provider_message_id, follow_up_count, last_follow_up_at,
          next_follow_up_at, responded_at, submission_id, request_state,
          delivery_state, delivery_state_at, follow_up_state, first_requested_at,
          first_provider_accepted_at, delivered_at, last_activity_at,
          json_extract(metadata, '$.initialCommunicationId') AS initial_communication_id,
          json_extract(metadata, '$.followUps') AS metric_follow_ups
        FROM deal_hunter_cim_requests
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(safeLimit).map((request) => ({
        ...request,
        metadata: {
          initialCommunicationId: request.initial_communication_id || '',
          followUps: parseJsonColumn(request.metric_follow_ups, []),
        },
      }));
    },

    async getLatestDealHunterCimRequestForSubmission(submissionId) {
      const normalizedId = String(submissionId || '').trim();
      if (!normalizedId) return null;
      return normalizeDealHunterCimRequestRow(database.prepare(`
        SELECT * FROM deal_hunter_cim_requests
        WHERE submission_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(normalizedId));
    },

    async listDealHunterCimRequestHistory({
      page = 1,
      pageSize = 25,
      search = '',
      requestStates = [],
      deliveryStates = [],
      statuses = [],
      replyState = '',
      followUpState = '',
      sort = 'last-activity',
      direction = 'desc',
    } = {}) {
      const baseClauses = [];
      const baseParams = [];
      const normalizedSearch = String(search || '').trim().toLowerCase();
      if (normalizedSearch) {
        baseClauses.push(`(
          INSTR(LOWER(COALESCE(deal_name, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(recipient_email, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(subject, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(listing_url, '')), ?) > 0
          OR INSTR(LOWER(COALESCE(deal_key, '')), ?) > 0
        )`);
        baseParams.push(normalizedSearch, normalizedSearch, normalizedSearch, normalizedSearch, normalizedSearch);
      }

      const clauses = [...baseClauses];
      const params = [...baseParams];
      const safeRequestStates = normalizeList(requestStates, 20);
      const safeDeliveryStates = normalizeList(deliveryStates, 20).map((value) => value.replaceAll('_', '-'));
      const safeStatuses = normalizeList(statuses, 20);
      if (safeRequestStates.length > 0) {
        clauses.push(`request_state IN (${placeholders(safeRequestStates.length)})`);
        params.push(...safeRequestStates);
      }
      if (safeDeliveryStates.length > 0) {
        clauses.push(`delivery_state IN (${placeholders(safeDeliveryStates.length)})`);
        params.push(...safeDeliveryStates);
      }
      if (safeStatuses.length > 0) {
        clauses.push(`status IN (${placeholders(safeStatuses.length)})`);
        params.push(...safeStatuses);
      }
      if (replyState === 'replied') clauses.push("(request_state = 'responded' OR responded_at IS NOT NULL)");
      if (replyState === 'awaiting') clauses.push("request_state <> 'responded' AND responded_at IS NULL");
      const normalizedFollowUpState = String(followUpState || '').trim().toLowerCase().replaceAll('_', '-');
      if (normalizedFollowUpState) {
        clauses.push('follow_up_state = ?');
        params.push(normalizedFollowUpState);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
	      const safePage = normalizePage(page);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const safeDirection = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const sortExpressions = {
        'first-request': `COALESCE(first_requested_at, created_at) ${safeDirection}, id ${safeDirection}`,
        'last-activity': `COALESCE(last_activity_at, updated_at, created_at) ${safeDirection}, id ${safeDirection}`,
        failure: `CASE WHEN delivery_state IN ('delayed', 'bounced', 'failed', 'complained', 'suppressed') THEN 0 ELSE 1 END ASC, COALESCE(last_delivery_event_at, updated_at) ${safeDirection}, id ${safeDirection}`,
      };
      const orderBy = sortExpressions[sort] || sortExpressions['last-activity'];
      const offset = (safePage - 1) * safePageSize;
      const rows = database.prepare(`
        SELECT * FROM deal_hunter_cim_requests
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, safePageSize, offset).map(normalizeDealHunterCimRequestRow);
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_requests ${whereClause}`).get(...params)?.count || 0);

      const countsWhereClause = baseClauses.length > 0 ? `WHERE ${baseClauses.join(' AND ')}` : '';
      const counts = database.prepare(`
        SELECT
          SUM(CASE WHEN request_state = 'ready' THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN request_state = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN request_state = 'provider_accepted' THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN delivery_state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN delivery_state IN ('delayed', 'bounced', 'failed', 'complained', 'suppressed') THEN 1 ELSE 0 END) AS delivery_issue,
          SUM(CASE WHEN request_state = 'responded' OR responded_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
        FROM deal_hunter_cim_requests
        ${countsWhereClause}
      `).get(...baseParams) || {};

      return {
        rows,
        total,
        page: safePage,
        pageSize: safePageSize,
        counts: {
          ready: Number(counts.ready || 0),
          pending: Number(counts.pending || 0),
          accepted: Number(counts.accepted || 0),
          delivered: Number(counts.delivered || 0),
          deliveryIssue: Number(counts.delivery_issue || 0),
          replied: Number(counts.replied || 0),
        },
      };
    },

	    async upsertDealHunterCimRequest(request = {}) {
	      const serialized = serializeDealHunterCimRequest(request);
	      return database.transaction(() => {
	        if (serialized.submission_id) assertCrmSubmissionWritableInTransaction(serialized.submission_id);
	        runDealHunterCimRequestUpsert(serialized);
	        const stored = database.prepare(`
	          SELECT * FROM deal_hunter_cim_requests
	          WHERE deal_key = ? AND LOWER(recipient_email) = ?
	          LIMIT 1
	        `).get(serialized.deal_key, serialized.recipient_email);
	        if (stored?.submission_id) {
	          database.prepare(`
	            UPDATE crm_follow_up_recommendations
	            SET status = 'superseded', superseded_at = ?
	            WHERE submission_id = ? AND status = 'current'
	          `).run(serialized.updated_at || new Date().toISOString(), stored.submission_id);
	        }
	        return normalizeDealHunterCimRequestRow(stored);
	      }).immediate();
	    },

	    async claimDealHunterCimRequest(request = {}, { pendingCutoff = '' } = {}) {
	      const serializedRequest = serializeDealHunterCimRequest(request);

	      return claimDealHunterCimRequestTransaction.immediate({
	        request: serializedRequest,
	        pendingCutoff: pendingCutoff || '',
	      });
	    },

      async startDealHunterManualFollowUps({
        requestId = '',
        expectedRequestUpdatedAt = '',
        expectedSubmissionId = '',
        expectedSubmissionUpdatedAt = '',
        marker = {},
        nextFollowUpAt = '',
        activity = null,
      } = {}) {
        if (!requestId || !expectedRequestUpdatedAt || !expectedSubmissionId
          || !expectedSubmissionUpdatedAt || !nextFollowUpAt || !activity) {
          return manualFollowUpResult({ reason: 'invalid-input' });
        }
        return startDealHunterManualFollowUpsTransaction.immediate({
          requestId,
          expectedRequestUpdatedAt,
          expectedSubmissionId,
          expectedSubmissionUpdatedAt,
          marker,
          nextFollowUpAt,
          activity,
        });
      },

      async stopDealHunterManualFollowUps({
        requestId = '',
        expectedRequestUpdatedAt = '',
        expectedSubmissionId = '',
        expectedSubmissionUpdatedAt = '',
        stoppedAt = '',
        stoppedBy = '',
        reason = '',
        activity = null,
      } = {}) {
        if (!requestId || !expectedRequestUpdatedAt || !expectedSubmissionId
          || !expectedSubmissionUpdatedAt || !stoppedAt || !stoppedBy || !activity) {
          return manualFollowUpResult({ reason: 'invalid-input' });
        }
        return stopDealHunterManualFollowUpsTransaction.immediate({
          requestId,
          expectedRequestUpdatedAt,
          expectedSubmissionId,
          expectedSubmissionUpdatedAt,
          stoppedAt,
          stoppedBy,
          reason,
          activity,
        });
      },

      async claimDealHunterApprovedFollowUp({
        requestId = '',
        expectedRequestUpdatedAt = '',
        expectedSubmissionId = '',
        expectedSubmissionUpdatedAt = '',
        expectedFollowUpCount = null,
        expectedFollowUpNumber = null,
        expectedNextFollowUpAt = '',
        claimedAt = '',
      } = {}) {
        if (!requestId || !expectedRequestUpdatedAt || !expectedSubmissionId
          || !expectedSubmissionUpdatedAt || !expectedNextFollowUpAt || !claimedAt
          || !Number.isInteger(expectedFollowUpCount) || !Number.isInteger(expectedFollowUpNumber)) {
          return manualFollowUpResult({ reason: 'invalid-input' });
        }
        return claimDealHunterApprovedFollowUpTransaction.immediate({
          requestId,
          expectedRequestUpdatedAt,
          expectedSubmissionId,
          expectedSubmissionUpdatedAt,
          expectedFollowUpCount,
          expectedFollowUpNumber,
          expectedNextFollowUpAt,
          claimedAt,
        });
      },

      async finalizeDealHunterApprovedFollowUp({
        requestId = '',
        expectedRequestUpdatedAt = '',
        expectedSubmissionId = '',
        expectedFollowUpNumber = null,
        expectedCommunicationId = '',
        outcome = '',
        acceptedAt = null,
        nextFollowUpAt = null,
        activity = null,
      } = {}) {
        if (!requestId || !expectedRequestUpdatedAt || !expectedSubmissionId
          || !expectedCommunicationId || !Number.isInteger(expectedFollowUpNumber) || !activity) {
          return manualFollowUpResult({ reason: 'invalid-input' });
        }
        return finalizeDealHunterApprovedFollowUpTransaction.immediate({
          requestId,
          expectedRequestUpdatedAt,
          expectedSubmissionId,
          expectedFollowUpNumber,
          expectedCommunicationId,
          outcome,
          acceptedAt,
          nextFollowUpAt,
          activity,
        });
      },

	    async claimDealHunterCimFollowUpRequest({ id = '', dueBefore = '', staleBefore = '', nowIso = '' } = {}) {
	      if (!id || !dueBefore || !nowIso) {
	        return { claimed: false, request: null };
	      }

	      return claimDealHunterCimFollowUpRequestTransaction.immediate({
	        id,
	        dueBefore,
	        staleBefore: staleBefore || '',
	        nowIso,
	      });
	    },

	    async renewDealHunterCimRequestClaim({ id = '', expectedUpdatedAt = '', expectedStatus = '', nowIso = '' } = {}) {
	      if (!id || !expectedUpdatedAt || !expectedStatus || !nowIso) {
	        return { renewed: false, reason: 'invalid-claim', request: null };
	      }

	      return renewDealHunterCimRequestClaimTransaction.immediate({
	        id,
	        expectedUpdatedAt,
	        expectedStatus,
	        nowIso,
	      });
	    },

    async getDealHunterDisposition({ id = '', dealKey = '' } = {}) {
      if (!id && !dealKey) return null;
      const row = id
        ? database.prepare('SELECT * FROM deal_hunter_dispositions WHERE id = ? LIMIT 1').get(String(id).trim())
        : database.prepare('SELECT * FROM deal_hunter_dispositions WHERE deal_key = ? LIMIT 1').get(String(dealKey).trim());
      return normalizeDealHunterDispositionRow(row);
    },

    async upsertDealHunterDisposition(record = {}) {
      return upsertDealHunterDispositionRecord(record);
    },

    async listDealHunterDispositions({ dealKeys = [], statuses = [], activeOnly = false, limit = 1000 } = {}) {
      const clauses = [];
      const params = [];
      const keys = normalizeList(dealKeys);
      const safeStatuses = normalizeList(statuses, 20);
      if (keys.length > 0) {
        clauses.push(`deal_key IN (${placeholders(keys.length)})`);
        params.push(...keys);
      }
      if (safeStatuses.length > 0) {
        clauses.push(`disposition IN (${placeholders(safeStatuses.length)})`);
        params.push(...safeStatuses);
      } else if (activeOnly) {
        clauses.push("disposition = 'dismissed'");
      }
      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000));
      return database.prepare(`
        SELECT * FROM deal_hunter_dispositions
        ${whereClause}
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `).all(...params, safeLimit).map(normalizeDealHunterDispositionRow);
    },

    async claimScheduledJob({
      jobKey = '',
      jobName = '',
      triggeredBy = '',
      claimToken = '',
      nowIso = '',
      staleBefore = '',
      retryDueAt = '',
      metadata = {},
    } = {}) {
      if (!jobKey || !jobName || !nowIso) return scheduledJobResult(false, 'missing', null);

      const legacy = !claimToken && !retryDueAt;
      const safeJobKey = normalizeScheduledJobText(jobKey, 'Scheduled-job key', 240);
      const safeJobName = normalizeScheduledJobText(jobName, 'Scheduled-job name', 120);
      const safeTriggeredBy = normalizeScheduledJobText(
        triggeredBy,
        'Scheduled-job trigger',
        200,
        { required: false },
      );
      const safeToken = normalizeScheduledJobToken(claimToken, { generate: true });
      const safeNow = normalizeCanonicalUtcIso(nowIso, 'Scheduled-job claim time');
      const safeStaleBefore = staleBefore
        ? normalizeCanonicalUtcIso(staleBefore, 'Scheduled-job stale cutoff')
        : '';
      const safeRetryDueAt = retryDueAt
        ? normalizeCanonicalUtcIso(retryDueAt, 'Scheduled-job retry cutoff')
        : '';
      const safeMetadata = normalizeScheduledJobMetadata(metadata, 'Scheduled-job claim metadata');

      return database.transaction(() => {
        const initialMetadata = {
          ...safeMetadata,
          claimToken: safeToken,
          claimedAt: safeNow,
        };
        if (!scheduledJobMetadataFits(initialMetadata)) {
          return scheduledJobResult(false, 'wrong-state', null);
        }
        const insertResult = database.prepare(`
          INSERT OR IGNORE INTO scheduled_job_runs (
            job_key, job_name, created_at, updated_at, started_at, status, triggered_by, attempt_count, metadata
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?)
        `).run(
          safeJobKey,
          safeJobName,
          safeNow,
          safeNow,
          safeNow,
          safeTriggeredBy || null,
          JSON.stringify(initialMetadata),
        );

        if (insertResult.changes > 0) {
          const inserted = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(safeJobKey);
          return scheduledJobResult(true, 'claimed', inserted);
        }

        const current = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(safeJobKey);
        if (!current) return scheduledJobResult(false, 'missing', null);
        if (current.job_name !== safeJobName) return scheduledJobResult(false, 'wrong-state', current);

        const reason = scheduledJobClaimDenialReason(current, {
          staleBefore: safeStaleBefore,
          retryDueAt: safeRetryDueAt,
          legacy,
        });
        if (reason !== 'claimed') return scheduledJobResult(false, reason, current);
        if (parseJsonColumn(current.metadata, {}).claimToken === safeToken) {
          return scheduledJobResult(false, 'wrong-state', current);
        }

        const nextMetadata = mergeScheduledJobMetadata(parseJsonColumn(current.metadata, {}), safeMetadata);
        nextMetadata.claimToken = safeToken;
        nextMetadata.claimedAt = safeNow;
        if (!scheduledJobMetadataFits(nextMetadata)) {
          return scheduledJobResult(false, 'wrong-state', current);
        }
        const updateResult = database.prepare(`
          UPDATE scheduled_job_runs SET
            updated_at = ?, started_at = ?, completed_at = NULL, status = 'pending',
            triggered_by = ?, attempt_count = attempt_count + 1,
            provider_message_id = NULL, last_error = NULL, metadata = ?
          WHERE job_key = ? AND job_name = ? AND status = ? AND updated_at = ?
        `).run(
          safeNow,
          safeNow,
          safeTriggeredBy || null,
          JSON.stringify(nextMetadata),
          safeJobKey,
          safeJobName,
          current.status,
          current.updated_at,
        );
        const run = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(safeJobKey);
        return updateResult.changes > 0
          ? scheduledJobResult(true, 'claimed', run)
          : scheduledJobResult(false, scheduledJobClaimDenialReason(run, {
              staleBefore: safeStaleBefore,
              retryDueAt: safeRetryDueAt,
              legacy,
            }), run);
      }).immediate();
    },

    async transitionScheduledJob({
      jobKey = '',
      claimToken = '',
      expectedStatuses = [],
      status = '',
      nowIso = '',
      providerMessageId = '',
      lastError = '',
      metadataPatch = {},
      completedAt = '',
    } = {}) {
      if (!jobKey || !claimToken || !nowIso) return scheduledJobResult(false, 'missing', null);
      const safeJobKey = normalizeScheduledJobText(jobKey, 'Scheduled-job key', 240);
      const safeToken = normalizeScheduledJobToken(claimToken);
      const safeNow = normalizeCanonicalUtcIso(nowIso, 'Scheduled-job transition time');
      const safeStatus = normalizeScheduledJobText(status, 'Scheduled-job status', 40);
      if (!scheduledJobStatuses.has(safeStatus)) throw new Error('Scheduled-job status is not supported.');
      if (!Array.isArray(expectedStatuses)) throw new Error('Scheduled-job expected statuses must be an array.');
      const safeExpectedStatuses = [...new Set(expectedStatuses.map((value) => (
        normalizeScheduledJobText(value, 'Scheduled-job expected status', 40)
      )))];
      if (safeExpectedStatuses.length === 0 || safeExpectedStatuses.some((value) => !scheduledJobStatuses.has(value))) {
        throw new Error('At least one supported expected scheduled-job status is required.');
      }
      const safeProviderMessageId = providerMessageId
        ? normalizeScheduledJobText(providerMessageId, 'Scheduled-job provider message ID', 500)
        : '';
      const safeLastError = lastError
        ? normalizeScheduledJobText(lastError, 'Scheduled-job error', 1000)
        : '';
      const safeMetadataPatch = normalizeScheduledJobMetadata(metadataPatch, 'Scheduled-job metadata patch');
      const safeCompletedAt = completedAt
        ? normalizeCanonicalUtcIso(completedAt, 'Scheduled-job completion time')
        : '';

      return database.transaction(() => {
        const current = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(safeJobKey);
        if (!current) return scheduledJobResult(false, 'missing', null);
        if (current.status === 'completed') return scheduledJobResult(false, 'completed', current);
        const currentMetadata = parseJsonColumn(current.metadata, {});
        if (currentMetadata.claimToken !== safeToken) return scheduledJobResult(false, 'not-owner', current);
        if (!safeExpectedStatuses.includes(current.status)) return scheduledJobResult(false, 'wrong-state', current);
        if (!scheduledJobTransitions.get(current.status)?.has(safeStatus)) {
          return scheduledJobResult(false, 'wrong-state', current);
        }

        const nextMetadata = mergeScheduledJobMetadata(currentMetadata, safeMetadataPatch);
        nextMetadata.claimToken = currentMetadata.claimToken;
        nextMetadata.claimedAt = currentMetadata.claimedAt;
        if (safeStatus === 'failed') {
          nextMetadata.failedAt = safeNow;
          nextMetadata.nextRetryAt = new Date(Date.parse(safeNow) + scheduledJobRetryDelayMs).toISOString();
        }
        if (!scheduledJobMetadataFits(nextMetadata)) {
          return scheduledJobResult(false, 'wrong-state', current);
        }
        const expectedPlaceholders = safeExpectedStatuses.map(() => '?').join(', ');
        const updateResult = database.prepare(`
          UPDATE scheduled_job_runs SET
            updated_at = ?,
            completed_at = ?,
            status = ?,
            provider_message_id = CASE WHEN ? <> '' THEN ? ELSE provider_message_id END,
            last_error = ?,
            metadata = ?
          WHERE job_key = ?
            AND status IN (${expectedPlaceholders})
            AND json_extract(metadata, '$.claimToken') = ?
        `).run(
          safeNow,
          safeStatus === 'completed' ? (safeCompletedAt || safeNow) : current.completed_at,
          safeStatus,
          safeProviderMessageId,
          safeProviderMessageId,
          safeLastError || null,
          JSON.stringify(nextMetadata),
          safeJobKey,
          ...safeExpectedStatuses,
          safeToken,
        );
        const run = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(safeJobKey);
        if (updateResult.changes > 0) return scheduledJobResult(true, 'claimed', run);
        if (!run) return scheduledJobResult(false, 'missing', null);
        if (run.status === 'completed') return scheduledJobResult(false, 'completed', run);
        if (parseJsonColumn(run.metadata, {}).claimToken !== safeToken) {
          return scheduledJobResult(false, 'not-owner', run);
        }
        return scheduledJobResult(false, 'wrong-state', run);
      }).immediate();
    },

    async completeScheduledJob(jobKey, values = {}) {
      const completedAt = values.completed_at || new Date().toISOString();
      database
        .prepare(`
          UPDATE scheduled_job_runs SET
            updated_at = ?, completed_at = ?, status = ?, provider_message_id = ?, last_error = ?, metadata = ?
          WHERE job_key = ?
        `)
        .run(
          completedAt,
          completedAt,
          values.status || 'completed',
          values.provider_message_id || null,
          values.last_error || null,
          JSON.stringify(values.metadata || {}),
          jobKey,
        );
      return this.getScheduledJob(jobKey);
    },

    async getScheduledJob(jobKey) {
      const run = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(jobKey);
      return normalizeScheduledJobRow(run);
    },

    async listScheduledJobs({ limit = 100 } = {}) {
      return database
        .prepare('SELECT * FROM scheduled_job_runs ORDER BY updated_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(Number(limit) || 100, 500)))
        .map(normalizeScheduledJobRow);
    },

    async getDatabaseStatus() {
      const pageCount = Number(database.pragma('page_count', { simple: true }) || 0);
      const pageSize = Number(database.pragma('page_size', { simple: true }) || 0);
      return {
        provider: 'sqlite',
        integrity: String(database.pragma('quick_check', { simple: true }) || ''),
        journalMode: String(database.pragma('journal_mode', { simple: true }) || ''),
        pageCount,
        pageSize,
        databaseBytes: pageCount * pageSize,
      };
    },

    async insertAdminAuditEvent(event) {
      database
        .prepare(`
          INSERT INTO admin_audit_events (
            id, created_at, request_id, actor, role, method, path, status_code, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.id,
          event.created_at,
          event.request_id || null,
          event.actor,
          event.role,
          event.method,
          event.path,
          Number(event.status_code || 0),
          JSON.stringify(event.metadata || {}),
        );
      return event;
    },

    async listAdminAuditEvents({ requestId = '', limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
      const rows = requestId
        ? database.prepare('SELECT * FROM admin_audit_events WHERE request_id = ? ORDER BY created_at ASC LIMIT ?').all(requestId, safeLimit)
        : database.prepare('SELECT * FROM admin_audit_events ORDER BY created_at DESC LIMIT ?').all(safeLimit);
      return rows.map((row) => ({ ...row, metadata: parseJsonColumn(row.metadata, {}) }));
    },

    async insertSourceHealthSnapshot(snapshot) {
      database.prepare(`
        INSERT INTO source_health_snapshots (
          id, created_at, healthy, source_count, issue_count, snapshot
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.id,
        snapshot.created_at,
        snapshot.healthy ? 1 : 0,
        Number(snapshot.source_count || 0),
        Number(snapshot.issue_count || 0),
        JSON.stringify(snapshot.snapshot || {}),
      );
      return snapshot;
    },

    async listSourceHealthSnapshots({ limit = 30 } = {}) {
      return database
        .prepare('SELECT * FROM source_health_snapshots ORDER BY created_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(Number(limit) || 30, 365)))
        .map((row) => ({ ...row, healthy: Boolean(row.healthy), snapshot: parseJsonColumn(row.snapshot, {}) }));
    },

    async insertAdminMagicLink(record) {
      database.prepare(`
        INSERT INTO admin_magic_links (
          token_hash, created_at, expires_at, consumed_at, email, role, requested_ip_hash, metadata
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(record.token_hash, record.created_at, record.expires_at, record.email, record.role, record.requested_ip_hash || null, JSON.stringify(record.metadata || {}));
      return record;
    },

    async consumeAdminMagicLink(tokenHash, consumedAt) {
      const transaction = database.transaction(() => {
        const result = database.prepare(`
          UPDATE admin_magic_links SET consumed_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
        `).run(consumedAt, tokenHash, consumedAt);
        if (result.changes === 0) return null;
        return database.prepare('SELECT * FROM admin_magic_links WHERE token_hash = ?').get(tokenHash);
      });
      const row = transaction();
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async insertAdminSession(session) {
      database.prepare(`
        INSERT INTO admin_sessions (
          id, created_at, expires_at, last_seen_at, revoked_at, username, principal_id, role,
          created_ip_hash, user_agent, metadata
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id, session.created_at, session.expires_at, session.last_seen_at,
        session.username, session.principal_id, session.role, session.created_ip_hash || null, session.user_agent || null,
        JSON.stringify(session.metadata || {}),
      );
      return session;
    },

    async getAdminSession(id) {
      const row = database.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(id);
      return row ? { ...row, metadata: parseJsonColumn(row.metadata, {}) } : null;
    },

    async listAdminOnboardingProgress(principalId) {
      return database
        .prepare(`
          SELECT * FROM admin_onboarding_progress
          WHERE principal_id = ?
          ORDER BY updated_at DESC, tour_key ASC, tour_version DESC
        `)
        .all(principalId)
        .map(normalizeAdminOnboardingProgressRow);
    },

    async upsertAdminOnboardingProgress(record) {
      database.prepare(`
        INSERT INTO admin_onboarding_progress (
          principal_id, tour_key, tour_version, status, last_completed_step_id,
          started_at, updated_at, completed_at, skipped_at
        ) VALUES (
          @principal_id, @tour_key, @tour_version, @status, @last_completed_step_id,
          @started_at, @updated_at, @completed_at, @skipped_at
        )
        ON CONFLICT(principal_id, tour_key, tour_version) DO UPDATE SET
          status = CASE
            WHEN admin_onboarding_progress.status = 'completed' THEN admin_onboarding_progress.status
            WHEN admin_onboarding_progress.status = 'skipped' AND excluded.status <> 'completed' THEN admin_onboarding_progress.status
            ELSE excluded.status
          END,
          last_completed_step_id = CASE
            WHEN admin_onboarding_progress.status = 'completed' THEN admin_onboarding_progress.last_completed_step_id
            WHEN admin_onboarding_progress.status = 'skipped' AND excluded.status <> 'completed' THEN admin_onboarding_progress.last_completed_step_id
            WHEN COALESCE((
              SELECT CAST(key AS INTEGER)
              FROM json_each(@valid_step_ids_json)
              WHERE value = excluded.last_completed_step_id
            ), -1) < COALESCE((
              SELECT CAST(key AS INTEGER)
              FROM json_each(@valid_step_ids_json)
              WHERE value = admin_onboarding_progress.last_completed_step_id
            ), -1) THEN admin_onboarding_progress.last_completed_step_id
            ELSE excluded.last_completed_step_id
          END,
          updated_at = CASE
            WHEN admin_onboarding_progress.status = 'completed' THEN admin_onboarding_progress.updated_at
            WHEN admin_onboarding_progress.status = 'skipped' AND excluded.status <> 'completed' THEN admin_onboarding_progress.updated_at
            WHEN admin_onboarding_progress.status = 'in_progress'
              AND excluded.status = 'in_progress'
              AND COALESCE((
                SELECT CAST(key AS INTEGER)
                FROM json_each(@valid_step_ids_json)
                WHERE value = excluded.last_completed_step_id
              ), -1) <= COALESCE((
                SELECT CAST(key AS INTEGER)
                FROM json_each(@valid_step_ids_json)
                WHERE value = admin_onboarding_progress.last_completed_step_id
              ), -1) THEN admin_onboarding_progress.updated_at
            ELSE excluded.updated_at
          END,
          completed_at = CASE
            WHEN admin_onboarding_progress.status = 'completed' THEN admin_onboarding_progress.completed_at
            WHEN excluded.status = 'completed' THEN excluded.completed_at
            ELSE NULL
          END,
          skipped_at = CASE
            WHEN admin_onboarding_progress.status = 'completed' THEN NULL
            WHEN admin_onboarding_progress.status = 'skipped' AND excluded.status <> 'completed' THEN admin_onboarding_progress.skipped_at
            WHEN excluded.status = 'skipped' THEN excluded.skipped_at
            ELSE NULL
          END
      `).run({
        ...record,
        valid_step_ids_json: JSON.stringify(record.valid_step_ids || []),
      });

      return normalizeAdminOnboardingProgressRow(database.prepare(`
        SELECT * FROM admin_onboarding_progress
        WHERE principal_id = ? AND tour_key = ? AND tour_version = ?
      `).get(record.principal_id, record.tour_key, record.tour_version));
    },

    async touchAdminSession(id, lastSeenAt) {
      database.prepare(`
        UPDATE admin_sessions SET last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
      `).run(lastSeenAt, id, lastSeenAt);
    },

    async revokeAdminSession(id, revokedAt) {
      const result = database.prepare(`
        UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      `).run(revokedAt, id);
      return result.changes > 0;
    },

    async revokeAdminSessionsForPrincipal(principalId, revokedAt) {
      const result = database.prepare(`
        UPDATE admin_sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL
      `).run(revokedAt, principalId);
      return result.changes;
    },

    async cleanupExpiredAuthRecords(nowIso) {
      const magicLinks = database.prepare('DELETE FROM admin_magic_links WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(nowIso).changes;
      const sessions = database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(nowIso).changes;
      return { magicLinks, sessions };
    },

    async insertSecureDocumentCleanupJob(job) {
      database
        .prepare(`
          INSERT INTO secure_document_cleanup_jobs (
            id, submission_id, created_at, updated_at, completed_at, status,
            trash_directory, files, attempt_count, last_error, metadata,
            lease_claimed_at, lease_expires_at, lease_token
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          job.id,
          job.submission_id,
          job.created_at,
          job.updated_at,
          job.completed_at || null,
          job.status,
          job.trash_directory || null,
          JSON.stringify(job.files || []),
          Number(job.attempt_count || 0),
          job.last_error || null,
          JSON.stringify(job.metadata || {}),
          job.lease_claimed_at || null,
          job.lease_expires_at || null,
          job.lease_token || null,
        );
      return this.getSecureDocumentCleanupJob(job.id);
    },

    async updateSecureDocumentCleanupJob(id, values = {}) {
      if (['lease_claimed_at', 'lease_expires_at', 'lease_token'].some((field) => Object.hasOwn(values, field))) {
        throw new Error('Cleanup-job lease fields require a token-fenced update.');
      }
      const normalizedValues = normalizeSecureDocumentCleanupJobUpdate(values);
      const assignments = Object.keys(normalizedValues).map((field) => `${field} = @${field}`).join(', ');
      const row = database.prepare(`
        UPDATE secure_document_cleanup_jobs
        SET ${assignments}
        WHERE id = @id AND lease_token IS NULL
        RETURNING *
      `).get({ ...normalizedValues, id });

      return normalizeSecureDocumentCleanupJobRow(row);
    },

    async claimSecureDocumentCleanupJob(id, lease = {}) {
      const { claimedAt, leaseExpiresAt, leaseToken } = normalizeSecureDocumentCleanupLease(lease);
      const row = database.prepare(`
        UPDATE secure_document_cleanup_jobs
        SET updated_at = ?, lease_claimed_at = ?, lease_expires_at = ?, lease_token = ?
        WHERE id = ?
          AND status IN ('staging', 'pending-purge', 'cleanup-pending', 'reconciliation-pending', 'cleanup-failed', 'restore-failed')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        RETURNING *
      `).get(claimedAt, claimedAt, leaseExpiresAt, leaseToken, id, claimedAt);

      return normalizeSecureDocumentCleanupJobRow(row);
    },

    async renewSecureDocumentCleanupJobLease(id, leaseToken, durationMs) {
      const expectedLeaseToken = normalizeCleanupLeaseToken(leaseToken);
      const normalizedDurationMs = normalizeCleanupLeaseDuration(durationMs);
      const row = database.prepare(`
        UPDATE secure_document_cleanup_jobs
        SET
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          lease_expires_at = strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            julianday('now') + (@durationMs / 86400000.0)
          )
        WHERE id = @id
          AND lease_token = @expectedLeaseToken
          AND julianday(lease_expires_at) > julianday('now')
        RETURNING *
      `).get({
        id,
        expectedLeaseToken,
        durationMs: normalizedDurationMs,
      });

      return normalizeSecureDocumentCleanupJobRow(row);
    },

    async updateSecureDocumentCleanupJobIfLeased(id, leaseToken, values = {}) {
      const expectedLeaseToken = normalizeCleanupLeaseToken(leaseToken);
      const normalizedValues = normalizeSecureDocumentCleanupJobUpdate(values);
      const assignments = Object.keys(normalizedValues).map((field) => `${field} = @${field}`).join(', ');
      const row = database.prepare(`
        UPDATE secure_document_cleanup_jobs
        SET ${assignments}
        WHERE id = @id
          AND lease_token = @expectedLeaseToken
          AND julianday(lease_expires_at) > julianday('now')
        RETURNING *
      `).get({
        ...normalizedValues,
        id,
        expectedLeaseToken,
      });

      return normalizeSecureDocumentCleanupJobRow(row);
    },

    async getSecureDocumentCleanupJob(id) {
      const row = database.prepare('SELECT * FROM secure_document_cleanup_jobs WHERE id = ?').get(id);
      return normalizeSecureDocumentCleanupJobRow(row);
    },

    async listPendingSecureDocumentCleanupJobs(limit = 100) {
      return database
        .prepare(`
          SELECT * FROM secure_document_cleanup_jobs
          WHERE status NOT IN ('completed', 'restored')
          ORDER BY created_at ASC
          LIMIT ?
        `)
        .all(Math.max(1, Math.min(Number(limit) || 100, 500)))
        .map(normalizeSecureDocumentCleanupJobRow);
    },

    async listSecureDocumentCleanupJobs({ limit = 100 } = {}) {
      return database
        .prepare('SELECT * FROM secure_document_cleanup_jobs ORDER BY updated_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(Number(limit) || 100, 500)))
        .map(normalizeSecureDocumentCleanupJobRow);
    },
	  };
}
