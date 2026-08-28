import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
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
  validateCanonicalOpportunityMergeReplayManifest,
} from '../repairs/canonicalOpportunityMerge.js';
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
    id: String(request.id || '').trim(),
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

function inspectCanonicalMergeDependentState(database, approval) {
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

  const opportunityScores = selectCanonicalMergeRows(database, 'deal_hunter_opportunity_scores', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'deal_key', values: dealKeys },
    { column: 'listing_url', values: listingUrls },
  ]);
  const scoreEvidence = selectCanonicalMergeRows(database, 'deal_hunter_score_evidence', [
    { column: 'opportunity_id', values: opportunityIds },
    { column: 'listing_url', values: listingUrls },
  ]);
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
    opportunityScores: canonicalMergeRecordIds('deal_hunter_opportunity_scores', opportunityScores, 'opportunity_id'),
    scoreEvidence: canonicalMergeRecordIds('deal_hunter_score_evidence', scoreEvidence),
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
  return { counts, records };
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
  return {
    opportunities,
    identityException,
    aliases,
    globalAliasOwnership,
    manifestAtId,
    typedManifests,
    dependentState: inspectCanonicalMergeDependentState(database, approval),
    ...operationalState,
  };
}

function checkedCanonicalOpportunityMergeApproval(approval = {}) {
  return getCanonicalOpportunityMergeApproval({
    exceptionId: approval.exceptionId,
    survivorId: approval.survivorId,
    supersededId: approval.supersededId,
  });
}

const canonicalOpportunityMergeRequiredSchema = Object.freeze({
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
    SELECT alias_key, alias_type, alias_value, opportunity_id
    FROM deal_hunter_opportunity_aliases
    WHERE opportunity_id IN (${placeholders(canonicalIds.length)})
    ORDER BY alias_key, opportunity_id
  `).all(...canonicalIds);
  const expectedOwnedAliases = approval.expectedAliases
    .map((item) => ({
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
  const expectedCandidateIds = uniqueCanonicalMergeValues([approval.survivorId, approval.supersededId]);
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
  const unexpected = Object.entries(dependentState.counts).filter(([, count]) => count !== 0);
  if (unexpected.length > 0) {
    throw new Error(`Canonical opportunity merge final state acquired unexpected dependents: ${unexpected.map(([name]) => name).join(', ')}.`);
  }
  return { survivor, superseded, identityException, aliases, manifest, dependentState };
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

export function createSqliteStorage(config) {
  const directory = path.dirname(config.storage.sqlitePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const database = new Database(config.storage.sqlitePath);
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
        metadata TEXT NOT NULL DEFAULT '{}'
      );

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
	    const current = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(id);
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

  const mutateWithCrmActivityTransaction = database.transaction(({ operation, payload, activity }) => {
    let record = null;

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

      upsertDealHunterCimRequestStatement.run({ ...request, submission_id: submissionId });
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

      upsertDealHunterCimRequestStatement.run(request);
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
      updateRecord(
        'contact_submissions',
        id,
        values,
        submissionUpdateFields,
        submissionJsonFields,
      );

      return this.getSubmission(id);
    },

    async updateSubmissionIfCurrent(id, expectedUpdatedAt, values) {
      const result = updateRecord(
        'contact_submissions',
        id,
        values,
        submissionUpdateFields,
        submissionJsonFields,
        expectedUpdatedAt,
      );

      return result.changes > 0 ? this.getSubmission(id) : null;
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

    async listSubmissions({ limit = 50, page = 1, search = '', status = 'all', createdAfter = '', sort = 'created_at', direction = 'desc' } = {}) {
      const clauses = [];
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

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
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
            SELECT * FROM contact_submissions
            ${whereClause}
            ORDER BY ${sortExpression} ${sortDirection}, created_at DESC, id ASC
            LIMIT ?
            OFFSET ?
          `,
        )
        .all(...params, safeLimit, offset)
        .map(normalizeSubmissionRow);

      const totalRow = database.prepare(`SELECT COUNT(*) AS count FROM contact_submissions ${whereClause}`).get(...params);

      return {
        rows,
        total: totalRow?.count || 0,
      };
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
      const clauses = ["submission.status NOT IN ('archived', 'spam')"];
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
      const total = database.prepare('SELECT COUNT(*) AS count FROM contact_submissions').get()?.count || 0;
      const lastSevenDaysSince = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString();
      const lastSevenDays =
        database.prepare('SELECT COUNT(*) AS count FROM contact_submissions WHERE created_at >= ?').get(lastSevenDaysSince)
          ?.count || 0;
      const dueToday =
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM contact_submissions WHERE next_action_at IS NOT NULL AND next_action_at <= ? AND status NOT IN ('archived', 'spam')`,
          )
          .get(new Date().toISOString())?.count || 0;
      const grouped = database
        .prepare('SELECT status, COUNT(*) AS count FROM contact_submissions GROUP BY status')
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
      insertSecureUploadRequestStatement.run(serializeUploadRequest(requestRecord));
      return requestRecord;
    },

    async updateSecureUploadRequest(id, values) {
      updateRecord(
        'secure_upload_requests',
        id,
        serializeUploadRequestValues(values),
        ['updated_at', 'status', 'expires_at', 'nda_required', 'nda_accepted_at', 'last_uploaded_at', 'note', 'requested_documents', 'revoked_at', 'closed_at', 'upload_batch_count'],
      );

      return this.getSecureUploadRequest(id);
    },

    async resetSecureUploadRequestIfUploading(id, values) {
      const updates = Object.entries(serializeUploadRequestValues(values)).filter(([key]) =>
        ['updated_at', 'status'].includes(key),
      );

      if (updates.length === 0) {
        return null;
      }

      const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
      const payload = Object.fromEntries(updates);
      payload.id = id;
      const result = database
        .prepare(`UPDATE secure_upload_requests SET ${fields} WHERE id = @id AND status = 'uploading'`)
        .run(payload);

      return result.changes > 0 ? this.getSecureUploadRequest(id) : null;
    },

    async claimSecureUploadRequest(id, values, options = {}) {
      const updates = Object.entries(serializeUploadRequestValues(values)).filter(([key]) =>
        ['updated_at', 'status', 'nda_accepted_at', 'last_uploaded_at', 'note', 'closed_at', 'upload_batch_count'].includes(key),
      );

      if (updates.length === 0) {
        return null;
      }

      const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
      const payload = updates.reduce((accumulator, [key, value]) => {
        accumulator[key] = value;
        return accumulator;
      }, {});

      payload.id = id;
      payload.stale_before = options.staleBefore || '';
      const result = database
        .prepare(
          `
            UPDATE secure_upload_requests SET ${fields}
            WHERE id = @id
              AND (
                status IN ('awaiting-documents', 'open', 'partially-received')
                OR (status = 'uploading' AND @stale_before != '' AND updated_at <= @stale_before)
              )
          `,
        )
        .run(payload);

      return result.changes > 0 ? this.getSecureUploadRequest(id) : null;
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
      insertSecureDocumentStatement.run(document);
      if (document.submission_id) {
        database.prepare(`
          UPDATE crm_follow_up_recommendations
          SET status = 'superseded', superseded_at = ?
          WHERE submission_id = ? AND status = 'current'
        `).run(document.created_at || new Date().toISOString(), document.submission_id);
      }
      return document;
    },

    async deleteSecureDocument(id) {
      const document = database.prepare('SELECT submission_id FROM secure_documents WHERE id = ? LIMIT 1').get(id);
      deleteSecureDocumentStatement.run(id);
      if (document?.submission_id) {
        database.prepare(`
          UPDATE crm_follow_up_recommendations
          SET status = 'superseded', superseded_at = ?
          WHERE submission_id = ? AND status = 'current'
        `).run(new Date().toISOString(), document.submission_id);
      }
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
      })();
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
      updateRecord(
        'crm_communications',
        id,
        serializeCrmCommunicationValues(values),
        allowedFields,
      );
      const updated = await this.getCrmCommunication(id);
      if (updated?.submission_id) {
        database.prepare(`
          UPDATE crm_follow_up_recommendations
          SET status = 'superseded', superseded_at = ?
          WHERE submission_id = ? AND status = 'current'
        `).run(updated.updated_at || new Date().toISOString(), updated.submission_id);
      }
      return updated;
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
      return { claimed: Boolean(row), outbox: normalizeCrmEmailOutboxRow(row || database.prepare('SELECT * FROM crm_email_outbox WHERE id = ? LIMIT 1').get(id)) };
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
      insertCrmFollowUpRecommendationStatement.run(serialized);
      return normalizeCrmFollowUpRecommendationRow(database.prepare(`
        SELECT * FROM crm_follow_up_recommendations
        WHERE submission_id = ? AND input_fingerprint = ? AND engine_version = ?
        LIMIT 1
      `).get(serialized.submission_id, serialized.input_fingerprint, serialized.engine_version));
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
      return database.prepare(`
        UPDATE crm_follow_up_recommendations
        SET status = 'superseded', superseded_at = ?
        WHERE submission_id = ? AND status = 'current'
      `).run(supersededAt, submissionId).changes;
    },

    async updateCrmFollowUpRecommendation(id, values = {}) {
      const allowedFields = ['status', 'acted_on_at', 'superseded_at', 'acted_on_by', 'outcome', 'metadata'];
      const safeValues = Object.fromEntries(Object.entries(values).filter(([field]) => allowedFields.includes(field)));
      if (Object.hasOwn(safeValues, 'metadata')) safeValues.metadata = JSON.stringify(safeValues.metadata || {});
      if (Object.keys(safeValues).length === 0) return normalizeCrmFollowUpRecommendationRow(
        database.prepare('SELECT * FROM crm_follow_up_recommendations WHERE id = ? LIMIT 1').get(id),
      );
      const assignments = Object.keys(safeValues).map((field) => `${field} = @${field}`).join(', ');
      return normalizeCrmFollowUpRecommendationRow(database.prepare(`
        UPDATE crm_follow_up_recommendations SET ${assignments} WHERE id = @id RETURNING *
      `).get({ ...safeValues, id }));
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
      return insertCrmActivityEvent(event);
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

    async insertDealHunterDealOsImport(record) {
      const serialized = serializeDealHunterDealOsImport(record);
      database.prepare(`
        INSERT INTO deal_hunter_deal_os_imports (
          id, created_at, imported_by, exported_at, file_name, file_type, file_size, file_sha256,
          scope, coverage_label, expected_row_count, row_count, source_row_count, accepted_row_count,
          rejected_row_count, canonical_record_count, parser_version, row_accounting,
          duplicate_count, stable_id_count, listing_url_count, coverage_limit_reached, records, metadata
        ) VALUES (
          @id, @created_at, @imported_by, @exported_at, @file_name, @file_type, @file_size, @file_sha256,
          @scope, @coverage_label, @expected_row_count, @row_count, @source_row_count, @accepted_row_count,
          @rejected_row_count, @canonical_record_count, @parser_version, @row_accounting,
          @duplicate_count, @stable_id_count, @listing_url_count, @coverage_limit_reached, @records, @metadata
        )
      `).run(serialized);
      return normalizeDealHunterDealOsImportRow(
        database.prepare('SELECT * FROM deal_hunter_deal_os_imports WHERE id = ?').get(record.id),
      );
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

        const lookups = [
          ['opportunity_id', opportunityId],
          ['id', id],
          ['deal_key', dealKey],
          ['listing_identity', listingIdentity],
        ];
        let row = null;
        for (const [field, value] of lookups) {
          if (!value) continue;
          row = database.prepare(`SELECT * FROM deal_hunter_crm_imports WHERE ${field} = ? ORDER BY updated_at DESC LIMIT 1`).get(value);
          if (row) break;
        }

	      return normalizeDealHunterCrmImportRow(row);
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

      async setDealHunterOpportunityOperatorDecision(decision = {}) {
        const opportunityId = String(decision.opportunityId || '').trim();
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
        }
        if (assignments.length === 0) return this.getCurrentDealHunterOpportunityScore(opportunityId);
        const transaction = database.transaction(() => {
          const opportunity = database.prepare(`
            SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
          `).get(opportunityId);
          if (!opportunity) return false;
          if (opportunity?.status !== 'active') {
            throw new Error('A superseded or otherwise non-current opportunity cannot receive a triage decision.');
          }
          const existing = database
            .prepare('SELECT opportunity_id FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?')
            .get(opportunityId);
          if (!existing) return false;
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
            SELECT opportunity_id, score_fingerprint, semantic_digest, rules_version, engine_version, profile_version
            FROM deal_hunter_opportunity_scores
            WHERE opportunity_id IN (${batch.map(() => '?').join(', ')})
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
        const safePage = Math.max(1, Math.min(Number(page) || 1, 10000));
        const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
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
        const sortColumn = sortColumns[String(sort || 'fit-score')] || sortColumns['fit-score'];
        // opportunity_id is always the final key so pagination is stable when
        // rows tie on the requested sort.
        const orderBy = `ORDER BY ${sortColumn} ${safeDirection}, `
          + "CASE scores.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, "
          + 'scores.opportunity_id ASC';

        const total = Number(database.prepare(`
          SELECT COUNT(*) AS total FROM deal_hunter_opportunity_scores AS scores ${dismissedJoin} ${where}
        `).get(...params)?.total || 0);
        const rows = database.prepare(`
          SELECT scores.*, disposition.reason AS dismissed_reason, disposition.dismissed_at AS dismissed_at
          FROM deal_hunter_opportunity_scores AS scores
          ${dismissedJoin}
          ${where}
          ${orderBy}
          LIMIT ? OFFSET ?
        `).all(...params, safePageSize, (safePage - 1) * safePageSize).map(normalizeDealHunterOpportunityScoreRow);

        return { rows, total, page: safePage, pageSize: safePageSize, totalPages: Math.max(1, Math.ceil(total / safePageSize)) };
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
	      const serializedRecord = serializeDealHunterCrmImport(record);

	      try {
	        insertDealHunterCrmImportStatement.run(serializedRecord);
	      } catch (error) {
	        if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
	          throw error;
	        }

	        const existingImport = await this.getDealHunterCrmImport({
	          id: record.id,
	          opportunityId: record.opportunity_id,
	          dealKey: record.deal_key,
	          listingIdentity: record.listing_identity,
	        });
	        const claimTarget = existingImport
	          ? { ...serializedRecord, id: existingImport.id, pending_cutoff: pendingCutoff || '' }
	          : { ...serializedRecord, pending_cutoff: pendingCutoff || '' };
	        const updateResult = existingImport
	          ? claimDealHunterCrmImportStatement.run(claimTarget)
	          : { changes: 0 };
	        const currentImport = await this.getDealHunterCrmImport({
	          id: existingImport?.id || record.id,
	          opportunityId: record.opportunity_id,
	          dealKey: record.deal_key,
	          listingIdentity: record.listing_identity,
	        });

	        return {
	          claimed: updateResult.changes > 0,
	          importRecord: currentImport,
	        };
	      }

	      return {
	        claimed: true,
	        importRecord: await this.getDealHunterCrmImport({
	          id: record.id,
	          opportunityId: record.opportunity_id,
	          dealKey: record.deal_key,
	          listingIdentity: record.listing_identity,
	        }),
	      };
	    },

	    async updateDealHunterCrmImport(id, values = {}) {
	      if (!id) {
	        return null;
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

	      return this.getDealHunterCrmImport({ id });
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
      if (confirmation !== CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION) {
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

    async linkDealHunterCrmSubmission({ opportunityId, submissionId, updatedAt = '' } = {}) {
      const timestamp = updatedAt || new Date().toISOString();
      const transaction = database.transaction(() => {
        const opportunity = database.prepare(`
          SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ? LIMIT 1
        `).get(opportunityId);
        if (!opportunity) throw new Error('Canonical Deal Hunter opportunity not found.');
        if (opportunity.status !== 'active') {
          throw new Error('Canonical Deal Hunter opportunity is superseded or otherwise not current.');
        }
        if (opportunity.primary_submission_id && opportunity.primary_submission_id !== submissionId) {
          throw new Error('Canonical opportunity already owns another CRM submission.');
        }
        const submission = database.prepare(`
          SELECT id, deal_hunter_opportunity_id
          FROM contact_submissions
          WHERE id = ?
          LIMIT 1
        `).get(submissionId);
        if (!submission) throw new Error('CRM submission not found.');
        if (submission.deal_hunter_opportunity_id
          && submission.deal_hunter_opportunity_id !== opportunityId) {
          throw new Error('CRM submission already belongs to another canonical opportunity.');
        }
        const conflicting = database.prepare(`
          SELECT id FROM contact_submissions
          WHERE deal_hunter_opportunity_id = ? AND id <> ? LIMIT 1
        `).get(opportunityId, submissionId);
        if (conflicting) throw new Error('Canonical opportunity already owns another CRM submission.');
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

    async listDealHunterCimRequests({ dealKeys = [], opportunityIds = [], recipientEmails = [], statuses = [], dueBefore = '', limit = 1000 } = {}) {
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
      return database
        .prepare(
          `
            SELECT * FROM deal_hunter_cim_requests
            ${whereClause}
            ORDER BY updated_at DESC
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
	        upsertDealHunterCimRequestStatement.run(serialized);
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

    async claimScheduledJob({ jobKey = '', jobName = '', triggeredBy = '', nowIso = '', staleBefore = '', metadata = {} } = {}) {
      if (!jobKey || !jobName || !nowIso) {
        return { claimed: false, run: null };
      }

      const insertResult = database
        .prepare(`
          INSERT OR IGNORE INTO scheduled_job_runs (
            job_key, job_name, created_at, updated_at, started_at, status, triggered_by, attempt_count, metadata
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?)
        `)
        .run(jobKey, jobName, nowIso, nowIso, nowIso, triggeredBy, JSON.stringify(metadata || {}));
      let reclaimed = false;

      if (insertResult.changes === 0) {
        const updateResult = database
          .prepare(`
            UPDATE scheduled_job_runs SET
              updated_at = ?, started_at = ?, completed_at = NULL, status = 'pending',
              triggered_by = ?, attempt_count = attempt_count + 1,
              provider_message_id = NULL, last_error = NULL, metadata = ?
            WHERE job_key = ?
              AND (status = 'failed' OR (status = 'pending' AND ? <> '' AND updated_at <= ?))
          `)
          .run(nowIso, nowIso, triggeredBy, JSON.stringify(metadata || {}), jobKey, staleBefore, staleBefore);
        reclaimed = updateResult.changes > 0;
      }

      const run = database.prepare('SELECT * FROM scheduled_job_runs WHERE job_key = ?').get(jobKey);
      return {
        claimed: insertResult.changes > 0 || reclaimed,
        run: run ? { ...run, metadata: parseJsonColumn(run.metadata, {}) } : null,
      };
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
      return run ? { ...run, metadata: parseJsonColumn(run.metadata, {}) } : null;
    },

    async listScheduledJobs({ limit = 100 } = {}) {
      return database
        .prepare('SELECT * FROM scheduled_job_runs ORDER BY updated_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(Number(limit) || 100, 500)))
        .map((run) => ({ ...run, metadata: parseJsonColumn(run.metadata, {}) }));
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
