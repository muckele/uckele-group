import { createClient } from '@supabase/supabase-js';
import { normalizeLeadType, normalizeSbaEligibility } from '../services/workflow.js';

function normalizeSubmissionRow(row) {
  return {
    ...row,
    lead_type: normalizeLeadType(row.lead_type, 'seller'),
    sba_eligible: normalizeSbaEligibility(row.sba_eligible, 'unknown'),
    spam_reasons: Array.isArray(row.spam_reasons) ? row.spam_reasons : [],
    metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
    tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

function normalizeUploadRequestRow(row) {
  return row
    ? {
        ...row,
        nda_required: Boolean(row.nda_required),
        requested_documents: Array.isArray(row.requested_documents) ? row.requested_documents : [],
        upload_batch_count: Number(row.upload_batch_count || 0),
      }
    : null;
}

function normalizeEmailEventRow(row) {
  return row
    ? {
        ...row,
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      }
    : null;
}

function normalizeCrmActivityEventRow(row) {
  return row
    ? {
        ...row,
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      }
    : null;
}

function normalizeCrmCommunicationRow(row) {
  return row
    ? {
        ...row,
        to_addresses: Array.isArray(row.to_addresses) ? row.to_addresses : [],
        cc_addresses: Array.isArray(row.cc_addresses) ? row.cc_addresses : [],
        bcc_addresses: Array.isArray(row.bcc_addresses) ? row.bcc_addresses : [],
        references_json: Array.isArray(row.references_json) ? row.references_json : [],
        headers_json: typeof row.headers_json === 'object' && row.headers_json !== null && !Array.isArray(row.headers_json)
          ? row.headers_json
          : {},
        attachment_metadata: Array.isArray(row.attachment_metadata) ? row.attachment_metadata : [],
        metadata: typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata : {},
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
        metadata: typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata : {},
      }
    : null;
}

function normalizeCrmFollowUpRecommendationRow(row) {
  return row
    ? {
        ...row,
        priority_score: Number(row.priority_score || 0),
        confidence: Number(row.confidence || 0),
        evidence_json: Array.isArray(row.evidence_json) ? row.evidence_json : [],
        signals_json: Array.isArray(row.signals_json) ? row.signals_json : [],
        commitments_json: Array.isArray(row.commitments_json) ? row.commitments_json : [],
        questions_json: Array.isArray(row.questions_json) ? row.questions_json : [],
        blockers_json: Array.isArray(row.blockers_json) ? row.blockers_json : [],
        safety_flags_json: Array.isArray(row.safety_flags_json) ? row.safety_flags_json : [],
        metadata: typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata : {},
      }
    : null;
}

function normalizeEmailSuppressionRow(row) {
  return row
    ? {
        ...row,
        metadata: typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata : {},
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

function normalizeSecureDocumentCleanupJobRow(row) {
  return row
    ? {
        ...row,
        files: Array.isArray(row.files) ? row.files : [],
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
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

  if (Object.hasOwn(values, 'files') && !Array.isArray(values.files)) {
    throw new Error('Cleanup-job files must be an array.');
  }
  if (
    Object.hasOwn(values, 'metadata') &&
    (!values.metadata || typeof values.metadata !== 'object' || Array.isArray(values.metadata))
  ) {
    throw new Error('Cleanup-job metadata must be an object.');
  }
  if (
    Object.hasOwn(values, 'attempt_count') &&
    (!Number.isSafeInteger(values.attempt_count) || values.attempt_count < 0)
  ) {
    throw new Error('Cleanup-job attempt count must be a non-negative integer.');
  }

  const normalized = { ...values };
  if (Object.hasOwn(normalized, 'lease_token')) {
    normalized.lease_token = null;
    normalized.lease_claimed_at = null;
    normalized.lease_expires_at = null;
  }
  return normalized;
}

function normalizeDealHunterSeenDealRow(row) {
  return row
    ? {
        ...row,
        should_remove: Boolean(row.should_remove),
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      }
    : null;
}

function normalizeDealHunterDealOsImportRow(row) {
  return row
    ? {
        ...row,
        coverage_limit_reached: Boolean(row.coverage_limit_reached),
        records: Array.isArray(row.records) ? row.records : [],
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      }
    : null;
}

function normalizeDealHunterCimRequestRow(row) {
  return row
    ? {
        ...row,
        follow_up_count: Number(row.follow_up_count || 0),
        attempt_count: Number(row.attempt_count || 0),
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      }
    : null;
}

function normalizeDealHunterDispositionRow(row) {
  return row
    ? {
        ...row,
        status: row.disposition,
        metadata: typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata : {},
      }
    : null;
}

function normalizeDealHunterCrmImportRow(row) {
  return row
    ? {
        ...row,
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      }
    : null;
}

function normalizeAtomicMutationResult(operation, data) {
  if (!data || typeof data !== 'object') {
    return { applied: false, record: null, activity: null };
  }

  const normalizers = {
    insert_submission: normalizeSubmissionRow,
    update_submission: normalizeSubmissionRow,
    insert_secure_upload_request: normalizeUploadRequestRow,
    finalize_secure_document_upload: normalizeUploadRequestRow,
    update_secure_upload_request: normalizeUploadRequestRow,
    insert_email_event: normalizeEmailEventRow,
    insert_crm_communication: normalizeCrmCommunicationRow,
    assign_crm_communication: normalizeCrmCommunicationRow,
    archive_submission: normalizeSubmissionRow,
    upsert_deal_hunter_cim_request: normalizeDealHunterCimRequestRow,
    finalize_deal_hunter_cim_request_claim: normalizeDealHunterCimRequestRow,
    dismiss_deal_hunter_opportunity: (record) => ({
      submission: record?.submission ? normalizeSubmissionRow(record.submission) : null,
      disposition: record?.disposition ? normalizeDealHunterDispositionRow(record.disposition) : null,
    }),
  };
  const normalizeRecord = normalizers[operation] || ((record) => record);

  return {
    applied: Boolean(data.applied),
    reason: data.reason || '',
    record: data.record ? normalizeRecord(data.record) : null,
    activity: data.activity ? normalizeCrmActivityEventRow(data.activity) : null,
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

function chunkValues(values = [], size = 500) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key|unique constraint/i.test(error?.message || '');
}

function safeDealHunterCimRequest(request = {}) {
  const now = new Date().toISOString();
  const status = String(request.status || 'pending').trim() || 'pending';
  const createdAt = request.created_at || now;
  const updatedAt = request.updated_at || createdAt;
  const metadata = request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
    ? request.metadata
    : {};
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
    ...request,
    id: String(request.id || '').trim(),
    created_at: createdAt,
    updated_at: updatedAt,
    deal_key: String(request.deal_key || '').trim(),
    recipient_email: String(request.recipient_email || '').trim().toLowerCase(),
    status,
    submission_id: String(request.submission_id || '').trim() || null,
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
    attempt_count: Object.hasOwn(request, 'attempt_count')
      ? Math.max(0, Number(request.attempt_count || 0))
      : status === 'pending' ? 0 : 1,
    last_activity_at: request.last_activity_at || updatedAt,
    follow_up_count: Number(request.follow_up_count || 0),
    metadata,
  };
}

function safeDealHunterCrmImport(record = {}) {
  return {
    ...record,
    deal_key: String(record.deal_key || '').trim(),
    listing_identity: String(record.listing_identity || '').trim(),
    listing_url: String(record.listing_url || '').trim(),
    submission_id: String(record.submission_id || '').trim() || null,
    metadata: typeof record.metadata === 'object' && record.metadata !== null ? record.metadata : {},
  };
}

const crmCommunicationFields = [
  'id', 'submission_id', 'deal_key', 'cim_request_id', 'direction', 'channel', 'source', 'kind',
  'provider', 'provider_message_id', 'source_event_id', 'idempotency_key', 'message_id', 'in_reply_to',
  'references_json', 'parent_communication_id', 'thread_key', 'legacy_content_unavailable',
  'content_redaction_state', 'recommendation_id', 'outbox_id', 'headers_json',
  'reply_to_address', 'from_address', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'subject',
  'body_text', 'body_html_sanitized', 'occurred_at', 'created_at', 'updated_at', 'delivery_state',
  'delivery_state_at', 'content_state', 'content_attempt_count', 'content_last_error',
  'content_next_attempt_at', 'attachment_metadata', 'assigned_at', 'assigned_by', 'created_by',
  'updated_by', 'metadata',
];

function safeCrmCommunication(record = {}, { update = false } = {}) {
  const payload = {};
  for (const field of crmCommunicationFields) {
    if (!Object.hasOwn(record, field)) continue;
    payload[field] = record[field];
  }
  if (!update) {
    payload.submission_id = String(payload.submission_id || '').trim() || null;
    payload.deal_key = String(payload.deal_key || '').trim() || null;
    payload.cim_request_id = String(payload.cim_request_id || '').trim() || null;
    payload.to_addresses = Array.isArray(payload.to_addresses) ? payload.to_addresses : [];
    payload.cc_addresses = Array.isArray(payload.cc_addresses) ? payload.cc_addresses : [];
    payload.bcc_addresses = Array.isArray(payload.bcc_addresses) ? payload.bcc_addresses : [];
    payload.references_json = Array.isArray(payload.references_json) ? payload.references_json : [];
    payload.headers_json = typeof payload.headers_json === 'object' && payload.headers_json !== null && !Array.isArray(payload.headers_json)
      ? payload.headers_json
      : {};
    payload.attachment_metadata = Array.isArray(payload.attachment_metadata) ? payload.attachment_metadata : [];
  }
  if (Object.hasOwn(payload, 'metadata')) {
    payload.metadata = typeof payload.metadata === 'object' && payload.metadata !== null && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
  }
  return payload;
}

function safeDealHunterDisposition(record = {}) {
  const disposition = String(record.disposition || record.status || 'dismissed').trim().toLowerCase();
  const now = record.updated_at || record.updatedAt || new Date().toISOString();
  return {
    id: String(record.id || '').trim(),
    deal_key: String(record.deal_key || record.dealKey || '').trim(),
    submission_id: String(record.submission_id || record.submissionId || '').trim() || null,
    communication_id: String(record.communication_id || record.communicationId || '').trim() || null,
    listing_url: String(record.listing_url || record.listingUrl || '').trim() || null,
    deal_name: String(record.deal_name || record.dealName || '').trim() || null,
    created_at: record.created_at || record.createdAt || now,
    updated_at: now,
    disposition,
    reason: String(record.reason || '').trim() || null,
    note: String(record.note || '').trim() || null,
    dismissed_at: record.dismissed_at || record.dismissedAt || (disposition === 'dismissed' ? now : null),
    dismissed_by: String(record.dismissed_by || record.dismissedBy || (disposition === 'dismissed' ? record.updated_by || record.created_by : '') || '').trim() || null,
    restored_at: record.restored_at || record.restoredAt || (disposition === 'restored' ? now : null),
    restored_by: String(record.restored_by || record.restoredBy || (disposition === 'restored' ? record.updated_by : '') || '').trim() || null,
    created_by: String(record.created_by || record.createdBy || 'system').trim() || 'system',
    updated_by: String(record.updated_by || record.updatedBy || 'system').trim() || 'system',
    metadata: typeof record.metadata === 'object' && record.metadata !== null && !Array.isArray(record.metadata) ? record.metadata : {},
  };
}

export function createSupabaseStorage(config, { client: clientOverride } = {}) {
  if (!clientOverride && (!config.storage.supabaseUrl || !config.storage.supabaseServiceRoleKey)) {
    throw new Error('Supabase storage provider requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const client = clientOverride || createClient(config.storage.supabaseUrl, config.storage.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  async function countByStatus(status) {
    const { count, error } = await client
      .from('contact_submissions')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);

    if (error) {
      throw error;
    }

    return count || 0;
  }

  async function getDealHunterCrmImportRecord({ id = '', dealKey = '', listingIdentity = '' } = {}) {
    if (id) {
      const { data, error } = await client
        .from('deal_hunter_crm_imports')
        .select('*')
        .eq('id', id)
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        return normalizeDealHunterCrmImportRow(data);
      }
    }

    if (dealKey) {
      const { data, error } = await client
        .from('deal_hunter_crm_imports')
        .select('*')
        .eq('deal_key', dealKey)
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        return normalizeDealHunterCrmImportRow(data);
      }
    }

    if (listingIdentity) {
      const { data, error } = await client
        .from('deal_hunter_crm_imports')
        .select('*')
        .eq('listing_identity', listingIdentity)
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        return normalizeDealHunterCrmImportRow(data);
      }
    }

    return null;
  }

  return {
    provider: 'supabase',

    async createApplicationBackup() {
      throw new Error('Application-managed backups are only available for SQLite storage. Use Supabase managed backups for this provider.');
    },

    async checkHealth() {
      const { error } = await client.from('contact_submissions').select('id').limit(1);
      if (error) {
        throw error;
      }
      return { ok: true };
    },

    async mutateWithCrmActivity({ operation, payload, activity }) {
      const communicationsOperations = new Set([
        'insert_crm_communication',
        'assign_crm_communication',
        'archive_submission',
        'upsert_deal_hunter_cim_request',
        'finalize_deal_hunter_cim_request_claim',
        'dismiss_deal_hunter_opportunity',
      ]);
      const lifecycleSubmissionFields = [
        'archived_at', 'archived_by', 'archive_reason', 'archive_note', 'archive_communication_id',
        'restored_at', 'restored_by',
      ];
      const usesLifecycleSubmissionFields = operation === 'update_submission'
        && lifecycleSubmissionFields.some((field) => Object.hasOwn(payload?.values || {}, field));
      const rpcName = communicationsOperations.has(operation) || usesLifecycleSubmissionFields
        ? 'mutate_communications_with_crm_activity'
        : 'mutate_with_crm_activity';
      const { data, error } = await client.rpc(rpcName, {
        p_operation: operation,
        p_payload: payload || {},
        p_activity: activity,
      });

      if (error) {
        throw error;
      }

      return normalizeAtomicMutationResult(operation, data);
    },

    async insertSubmission(submission) {
      const { data, error } = await client.from('contact_submissions').insert(submission).select().single();

      if (error) {
        throw error;
      }

      return normalizeSubmissionRow(data);
    },

    async updateSubmission(id, values) {
      const { data, error } = await client.from('contact_submissions').update(values).eq('id', id).select().single();

      if (error) {
        throw error;
      }

      return normalizeSubmissionRow(data);
    },

    async updateSubmissionIfCurrent(id, expectedUpdatedAt, values) {
      const { data, error } = await client
        .from('contact_submissions')
        .update(values)
        .eq('id', id)
        .eq('updated_at', expectedUpdatedAt)
        .select()
        .maybeSingle();

      if (error) {
        throw error;
      }

      return data ? normalizeSubmissionRow(data) : null;
    },

    async getSubmission(id) {
      const { data, error } = await client.from('contact_submissions').select('*').eq('id', id).single();

      if (error) {
        return null;
      }

      return normalizeSubmissionRow(data);
    },

    async getSubmissionStrict(id) {
      const { data, error } = await client.from('contact_submissions').select('*').eq('id', id).maybeSingle();

      if (error) {
        throw error;
      }

      return data ? normalizeSubmissionRow(data) : null;
    },

    async deleteSubmission(id, { deletedAt = '' } = {}) {
      const effectiveDeletedAt = deletedAt || new Date().toISOString();
      const { data, error } = await client.rpc('delete_crm_submission_lifecycle', {
        p_submission_id: id,
        p_deleted_at: effectiveDeletedAt,
      });
      if (error) {
        if (/CIM transmission is in progress/i.test(error.message || '')) {
          const conflict = new Error(error.message);
          conflict.code = 'CIM_SEND_IN_PROGRESS';
          conflict.status = 409;
          throw conflict;
        }
        throw error;
      }
      return data ? normalizeSubmissionRow(data) : null;
    },

    async getSubmissionByContactEmail(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();

      if (!normalizedEmail) {
        return null;
      }

      const { data, error } = await client
        .from('contact_submissions')
        .select('*')
        .or(`email.eq.${normalizedEmail},broker_email.eq.${normalizedEmail},seller_email.eq.${normalizedEmail}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return null;
      }

      return data ? normalizeSubmissionRow(data) : null;
    },

    async listSubmissionsByContactEmail(email, { limit = 25, openOnly = false } = {}) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) return [];
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 250));
      const { data, error } = await client.rpc('list_submissions_by_contact_email', {
        p_email: normalizedEmail,
        p_limit: safeLimit,
        p_open_only: Boolean(openOnly),
      });
      if (error) throw error;
      return Array.isArray(data) ? data.map(normalizeSubmissionRow) : [];
    },

    async getSubmissionByBusinessWebsite(websiteUrl) {
      const normalizedUrl = String(websiteUrl || '').trim().toLowerCase();
      const websiteIdentity = canonicalWebsiteIdentity(websiteUrl);

      if (!normalizedUrl || !websiteIdentity) {
        return null;
      }

      const { data, error } = await client
        .from('contact_submissions')
        .select('*')
        .ilike('business_website', normalizedUrl)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return null;
      }

      if (data) {
        return normalizeSubmissionRow(data);
      }

      const pageSize = 1000;

      for (let from = 0; from < 10000; from += pageSize) {
        const { data: rows, error: listError } = await client
          .from('contact_submissions')
          .select('*')
          .not('business_website', 'is', null)
          .neq('business_website', '')
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);

        if (listError) {
          return null;
        }

        const matchedRow = (rows || []).find((row) => canonicalWebsiteIdentity(row.business_website) === websiteIdentity);

        if (matchedRow) {
          return normalizeSubmissionRow(matchedRow);
        }

        if (!rows || rows.length < pageSize) {
          break;
        }
      }

      return null;
    },

    async getSubmissionByListingUrl(listingUrl) {
      const normalizedUrl = String(listingUrl || '').trim().toLowerCase();
      const listingIdentity = canonicalListingIdentity(listingUrl);

      if (!normalizedUrl || !listingIdentity) {
        return null;
      }

      const { data, error } = await client
        .from('contact_submissions')
        .select('*')
        .ilike('listing_url', normalizedUrl)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return null;
      }

      if (data) {
        return normalizeSubmissionRow(data);
      }

      const pageSize = 1000;

      for (let from = 0; from < 10000; from += pageSize) {
        const { data: rows, error: listError } = await client
          .from('contact_submissions')
          .select('*')
          .not('listing_url', 'is', null)
          .neq('listing_url', '')
          .order('created_at', { ascending: false })
          .range(from, from + pageSize - 1);

        if (listError) {
          return null;
        }

        const matchedRow = (rows || []).find((row) => canonicalListingIdentity(row.listing_url) === listingIdentity);

        if (matchedRow) {
          return normalizeSubmissionRow(matchedRow);
        }

        if (!rows || rows.length < pageSize) {
          break;
        }
      }

      return null;
    },

    async listSubmissions({ limit = 50, page = 1, search = '', status = 'all', createdAfter = '', sort = 'created_at', direction = 'desc' } = {}) {
      const requestedLimit = Number(limit);
      const requestedPage = Number(page);
      const safeLimit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(Math.trunc(requestedLimit), 5000))
        : 50;
      const safePage = Number.isFinite(requestedPage)
        ? Math.max(1, Math.min(Math.trunc(requestedPage), 1_000_000))
        : 1;
      const sortColumns = new Set(['created_at', 'updated_at', 'company', 'next_action_at', 'priority', 'status', 'deal_score', 'listing_date']);
      const sortColumn = sortColumns.has(sort) ? sort : 'created_at';
      const safeDirection = String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc';
      const { data, error } = await client.rpc('list_submissions_page', {
        p_limit: safeLimit,
        p_page: safePage,
        p_search: String(search || '').trim(),
        p_status: status && status !== 'all' ? String(status) : '',
        p_created_after: String(createdAfter || ''),
        p_sort: sortColumn,
        p_direction: safeDirection,
      });

      if (error) {
        throw error;
      }

      return {
        rows: (data?.rows || []).map(normalizeSubmissionRow),
        total: Number(data?.total || 0),
      };
    },

    async listFollowUpSubmissions({
      page = 1, pageSize = 25, search = '', view = 'crm-actions', sort = 'urgency', direction = 'desc',
      now = '', todayStart = '', todayEnd = '',
    } = {}) {
      const safePage = normalizePage(page);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const { data, error } = await client.rpc('list_follow_up_submissions_page', {
        p_limit: safePageSize,
        p_page: safePage,
        p_search: String(search || '').trim(),
        p_view: String(view || 'crm-actions'),
        p_sort: String(sort || 'urgency'),
        p_direction: String(direction || 'desc'),
        p_now: String(now || new Date().toISOString()),
        p_today_start: String(todayStart || now || new Date().toISOString()),
        p_today_end: String(todayEnd || now || new Date().toISOString()),
      });
      if (error) throw error;
      return {
        rows: (data?.rows || []).map(normalizeSubmissionRow),
        total: Number(data?.total || 0),
        page: safePage,
        pageSize: safePageSize,
      };
    },

    async getSummary() {
      const lastSevenDaysSince = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString();
      const nowIso = new Date().toISOString();

      const [
        totalQuery,
        lastSevenDaysQuery,
        dueTodayQuery,
        newCount,
        reviewCount,
        contactedCount,
        archivedCount,
        spamCount,
      ] = await Promise.all([
        client.from('contact_submissions').select('*', { count: 'exact', head: true }),
        client.from('contact_submissions').select('*', { count: 'exact', head: true }).gte('created_at', lastSevenDaysSince),
        client
          .from('contact_submissions')
          .select('*', { count: 'exact', head: true })
          .lte('next_action_at', nowIso)
          .not('status', 'in', "('archived','spam')"),
        countByStatus('new'),
        countByStatus('review'),
        countByStatus('contacted'),
        countByStatus('archived'),
        countByStatus('spam'),
      ]);

      if (totalQuery.error) {
        throw totalQuery.error;
      }

      if (lastSevenDaysQuery.error) {
        throw lastSevenDaysQuery.error;
      }

      if (dueTodayQuery.error) {
        throw dueTodayQuery.error;
      }

      return {
        total: totalQuery.count || 0,
        lastSevenDays: lastSevenDaysQuery.count || 0,
        dueToday: dueTodayQuery.count || 0,
        new: newCount,
        review: reviewCount,
        contacted: contactedCount,
        archived: archivedCount,
        spam: spamCount,
      };
    },

    async addRateLimitEvent(bucket, createdAt) {
      const retentionMs = Math.max(0, Number(config.protection?.rateLimitRetentionMs) || 0);

      if (retentionMs > 0) {
        const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
        const { error: pruneError } = await client.from('contact_rate_limit_events').delete().lt('created_at', cutoffIso);

        if (pruneError) {
          throw pruneError;
        }
      }

      const { error } = await client.from('contact_rate_limit_events').insert({ bucket, created_at: createdAt });

      if (error) {
        throw error;
      }
    },

    async countRateLimitEvents(bucket, sinceIso) {
      const { count, error } = await client
        .from('contact_rate_limit_events')
        .select('*', { count: 'exact', head: true })
        .eq('bucket', bucket)
        .gte('created_at', sinceIso);

      if (error) {
        throw error;
      }

      return count || 0;
    },

    async insertAnalyticsEvent(event, retentionDays = 90) {
      const cutoffIso = new Date(Date.now() - Math.max(1, Number(retentionDays) || 90) * 86_400_000).toISOString();
      const { error: pruneError } = await client.from('analytics_events').delete().lt('created_at', cutoffIso);

      if (pruneError) throw pruneError;

      const { data, error } = await client.from('analytics_events').insert(event).select().single();

      if (error) throw error;
      return data;
    },

    async listAnalyticsEvents({ sinceIso = '', limit = 1000 } = {}) {
      let query = client
        .from('analytics_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 1000, 10000)));

      if (sinceIso) query = query.gte('created_at', sinceIso);
      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    },

    async insertSecureUploadRequest(requestRecord) {
      const { data, error } = await client.from('secure_upload_requests').insert(requestRecord).select().single();

      if (error) {
        throw error;
      }

      return normalizeUploadRequestRow(data);
    },

    async updateSecureUploadRequest(id, values) {
      const { data, error } = await client
        .from('secure_upload_requests')
        .update(values)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return normalizeUploadRequestRow(data);
    },

    async resetSecureUploadRequestIfUploading(id, values) {
      const { data, error } = await client
        .from('secure_upload_requests')
        .update(values)
        .eq('id', id)
        .eq('status', 'uploading')
        .select()
        .maybeSingle();

      if (error) {
        throw error;
      }

      return normalizeUploadRequestRow(data);
    },

    async claimSecureUploadRequest(id, values, options = {}) {
      const activeClaim = await client
        .from('secure_upload_requests')
        .update(values)
        .eq('id', id)
        .in('status', ['awaiting-documents', 'open', 'partially-received'])
        .select()
        .maybeSingle();

      if (activeClaim.error) {
        throw activeClaim.error;
      }

      if (activeClaim.data) {
        return normalizeUploadRequestRow(activeClaim.data);
      }

      if (!options.staleBefore) {
        return null;
      }

      const staleClaim = await client
        .from('secure_upload_requests')
        .update(values)
        .eq('id', id)
        .eq('status', 'uploading')
        .lte('updated_at', options.staleBefore)
        .select()
        .maybeSingle();

      if (staleClaim.error) {
        throw staleClaim.error;
      }

      return normalizeUploadRequestRow(staleClaim.data);
    },

    async getSecureUploadRequest(id) {
      const { data, error } = await client.from('secure_upload_requests').select('*').eq('id', id).single();

      if (error) {
        return null;
      }

      return normalizeUploadRequestRow(data);
    },

    async getLatestSecureUploadRequestForSubmission(submissionId) {
      const { data, error } = await client
        .from('secure_upload_requests')
        .select('*')
        .eq('submission_id', submissionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return normalizeUploadRequestRow(data);
    },

    async listLatestSecureUploadRequestsForSubmissions(submissionIds = []) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const { data, error } = await client
        .from('secure_upload_requests')
        .select('*')
        .in('submission_id', ids)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeUploadRequestRow);
    },

    async insertSecureDocument(document) {
      const { data, error } = await client.from('secure_documents').insert(document).select().single();

      if (error) {
        throw error;
      }

      return data;
    },

    async deleteSecureDocument(id) {
      const { error } = await client.from('secure_documents').delete().eq('id', id);

      if (error) {
        throw error;
      }

      // Supabase invalidates recommendations in the related-record trigger so
      // the document mutation and invalidation cannot be separated by a crash.
    },

    async getSecureDocument(id) {
      const { data, error } = await client.from('secure_documents').select('*').eq('id', id).maybeSingle();

      if (error) {
        throw error;
      }

      return data || null;
    },

    async listSecureDocumentsByRequest(requestId) {
      const { data, error } = await client
        .from('secure_documents')
        .select('*')
        .eq('request_id', requestId)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return data || [];
    },

    async listSecureDocumentsForSubmission(submissionId) {
      const { data, error } = await client
        .from('secure_documents')
        .select('*')
        .eq('submission_id', submissionId)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return data || [];
    },

    async listSecureDocumentsForSubmissions(submissionIds = []) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const { data, error } = await client
        .from('secure_documents')
        .select('*')
        .in('submission_id', ids)
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return data || [];
    },

    async insertEmailEvent(event) {
      if (event.event_key) {
        const { data, error } = await client
          .from('email_events')
          .upsert(event, { onConflict: 'event_key', ignoreDuplicates: true })
          .select()
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (data) {
          return normalizeEmailEventRow(data);
        }

        const existing = await client.from('email_events').select('*').eq('event_key', event.event_key).maybeSingle();

        if (existing.error) {
          throw existing.error;
        }

        return normalizeEmailEventRow(existing.data);
      }

      const { data, error } = await client.from('email_events').insert(event).select().single();

      if (error) {
        throw error;
      }

      return normalizeEmailEventRow(data);
    },

    async listEmailEvents({ submissionId = '', recipientEmail = '', source = '', limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(limit, 500));
      let query = client
        .from('email_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (submissionId) {
        query = query.eq('submission_id', submissionId);
      }

      if (recipientEmail) {
        query = query.eq('recipient_email', String(recipientEmail).trim().toLowerCase());
      }

      if (source) {
        query = query.eq('source', String(source).trim());
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeEmailEventRow);
    },

    async listEmailEventsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      const { data, error } = await client
        .from('email_events')
        .select('*')
        .in('submission_id', ids)
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeEmailEventRow);
    },

    async listEmailEventsForRecipients(recipientEmails = [], limit = 5000) {
      const emails = normalizeList(recipientEmails).map((email) => email.toLowerCase());

      if (emails.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      const { data, error } = await client
        .from('email_events')
        .select('*')
        .in('recipient_email', emails)
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeEmailEventRow);
    },

    async listEmailEventsByMessageIds(messageIds = [], limit = 5000) {
      const ids = normalizeList(messageIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      const { data, error } = await client
        .from('email_events')
        .select('*')
        .in('message_id', ids)
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeEmailEventRow);
    },

    async getCrmCommunication(id) {
      if (!id) return null;
      const { data, error } = await client
        .from('crm_communications')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmCommunicationRow(data);
    },

    async getCrmCommunicationByProviderMessage(provider, messageId, direction = '') {
      if (!provider || !messageId) return null;
      let query = client
        .from('crm_communications')
        .select('*')
        .eq('provider', String(provider).trim())
        .eq('provider_message_id', String(messageId).trim())
        .order('occurred_at', { ascending: false })
        .limit(1);
      if (direction) query = query.eq('direction', String(direction).trim());
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return normalizeCrmCommunicationRow(data);
    },

    async getCrmCommunicationBySourceEvent(provider, sourceEventId) {
      if (!provider || !sourceEventId) return null;
      const { data, error } = await client
        .from('crm_communications')
        .select('*')
        .eq('provider', String(provider).trim())
        .eq('source_event_id', String(sourceEventId).trim())
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmCommunicationRow(data);
    },

    async getCrmCommunicationByMessageId(messageId) {
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId) return null;
      const { data, error } = await client
        .from('crm_communications')
        .select('*')
        .eq('message_id', normalizedMessageId)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmCommunicationRow(data);
    },

    async insertCrmCommunication(communication = {}) {
      const payload = safeCrmCommunication(communication);
      const { data, error } = await client.from('crm_communications').insert(payload).select().single();
      if (!error) return normalizeCrmCommunicationRow(data);
      if (!isUniqueViolation(error)) throw error;

      if (payload.id) {
        const existing = await this.getCrmCommunication(payload.id);
        if (existing) return existing;
      }
      if (payload.idempotency_key) {
        const result = await client.from('crm_communications').select('*').eq('idempotency_key', payload.idempotency_key).maybeSingle();
        if (result.error) throw result.error;
        if (result.data) return normalizeCrmCommunicationRow(result.data);
      }
      if (payload.provider && payload.source_event_id) {
        const existing = await this.getCrmCommunicationBySourceEvent(payload.provider, payload.source_event_id);
        if (existing) return existing;
      }
      if (payload.provider && payload.provider_message_id) {
        const existing = await this.getCrmCommunicationByProviderMessage(payload.provider, payload.provider_message_id, payload.direction);
        if (existing) return existing;
      }
      throw error;
    },

    async updateCrmCommunication(id, values = {}) {
      const payload = safeCrmCommunication(values, { update: true });
      for (const immutableField of ['id', 'created_at', 'created_by']) delete payload[immutableField];
      if (Object.keys(payload).length === 0) return this.getCrmCommunication(id);
      const { data, error } = await client
        .from('crm_communications')
        .update(payload)
        .eq('id', id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmCommunicationRow(data);
    },

    async createCrmEmailCommand({
      communication = {}, outbox = {}, activity = {}, expectedSubmissionVersion = '',
      manualTakeoverCimRequestId = '',
    } = {}) {
      const { data, error } = await client.rpc('create_crm_email_command', {
        p_communication: safeCrmCommunication(communication),
        p_outbox: outbox,
        p_activity: activity,
        p_expected_submission_version: expectedSubmissionVersion,
        p_manual_takeover_cim_request_id: manualTakeoverCimRequestId || null,
      });
      if (error) throw error;
      return {
        applied: Boolean(data?.applied),
        reason: data?.reason || '',
        communication: normalizeCrmCommunicationRow(data?.communication || null),
        outbox: normalizeCrmEmailOutboxRow(data?.outbox || null),
        submission: data?.submission ? normalizeSubmissionRow(data.submission) : null,
      };
    },

    async getCrmEmailOutbox(id) {
      if (!id) return null;
      const { data, error } = await client.from('crm_email_outbox').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return normalizeCrmEmailOutboxRow(data);
    },

    async getCrmEmailOutboxByClientRequestKey(clientRequestKey) {
      const normalizedKey = String(clientRequestKey || '').trim();
      if (!normalizedKey) return null;
      const { data, error } = await client
        .from('crm_email_outbox')
        .select('*')
        .eq('client_request_key', normalizedKey)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmEmailOutboxRow(data);
    },

    async getCrmEmailOutboxByProviderMessageId(providerMessageId) {
      const normalizedId = String(providerMessageId || '').trim();
      if (!normalizedId) return null;
      const { data, error } = await client
        .from('crm_email_outbox')
        .select('*')
        .eq('provider_message_id', normalizedId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmEmailOutboxRow(data);
    },

    async listCrmEmailOutbox({ submissionId = '', states = [], limit = 25 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
      let query = client
        .from('crm_email_outbox')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(safeLimit);
      if (submissionId) query = query.eq('submission_id', String(submissionId).trim());
      const safeStates = normalizeList(states, 20);
      if (safeStates.length > 0) query = query.in('state', safeStates);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(normalizeCrmEmailOutboxRow);
    },

    async claimCrmEmailOutbox({ id = '', claimToken = '', claimedAt = '', claimExpiresAt = '' } = {}) {
      const { data, error } = await client.rpc('claim_crm_email_outbox', {
        p_id: id,
        p_claim_token: claimToken,
        p_claimed_at: claimedAt,
        p_claim_expires_at: claimExpiresAt,
      });
      if (error) throw error;
      return { claimed: Boolean(data?.claimed), outbox: normalizeCrmEmailOutboxRow(data?.outbox || null) };
    },

    async finishCrmEmailOutboxClaim(id, claimToken, values = {}) {
      const allowedFields = new Set([
        'state', 'provider', 'provider_message_id', 'next_attempt_at', 'accepted_at', 'failed_at',
        'ambiguous_at', 'last_error_category', 'last_error_message', 'updated_at', 'metadata',
      ]);
      const payload = Object.fromEntries(Object.entries(values).filter(([field]) => allowedFields.has(field)));
      const { data, error } = await client.rpc('finish_crm_email_outbox_claim', {
        p_id: id,
        p_claim_token: claimToken,
        p_values: payload,
      });
      if (error) throw error;
      return normalizeCrmEmailOutboxRow(data);
    },

    async countCrmEmailOutboxByStates(states = []) {
      const safeStates = normalizeList(states, 20);
      if (safeStates.length === 0) return 0;
      const { count, error } = await client
        .from('crm_email_outbox')
        .select('*', { count: 'exact', head: true })
        .in('state', safeStates);
      if (error) throw error;
      return Number(count || 0);
    },

    async countCrmFollowUpSends({ recipient = '', since = '' } = {}) {
      const normalizedRecipient = String(recipient || '').trim().toLowerCase();
      const { data, error } = await client.rpc('count_crm_follow_up_sends', {
        p_recipient: normalizedRecipient,
        p_since: since || null,
      });
      if (error) throw error;
      return Number(data || 0);
    },

    async getCrmFollowUpOperationalMetrics({ since = '' } = {}) {
      const windowStartedAt = String(since || '1970-01-01T00:00:00.000Z');
      const { data, error } = await client.rpc('get_crm_follow_up_operational_metrics', {
        p_since: windowStartedAt,
      });
      if (error) throw error;
      const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
      const nullableNumber = (value) => (typeof value === 'number' || typeof value === 'string')
        && String(value).trim() !== ''
        && Number.isFinite(Number(value)) && Number(value) >= 0
        ? Number(value)
        : null;
      const countMap = (value) => Object.fromEntries(
        Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
          .map(([key, total]) => [String(key).slice(0, 80), count(total)]),
      );
      return {
        windowStartedAt,
        outbox: {
          queued: count(data?.outbox?.queued), sending: count(data?.outbox?.sending),
          accepted: count(data?.outbox?.accepted), ambiguous: count(data?.outbox?.ambiguous),
          retryableFailed: count(data?.outbox?.retryableFailed), permanentFailed: count(data?.outbox?.permanentFailed),
          cancelled: count(data?.outbox?.cancelled),
        },
        delivery: {
          delivered: count(data?.delivery?.delivered), delayed: count(data?.delivery?.delayed),
          bounced: count(data?.delivery?.bounced), complained: count(data?.delivery?.complained),
          failed: count(data?.delivery?.failed), replied: count(data?.delivery?.replied),
        },
        recommendations: {
          current: count(data?.recommendations?.current), accepted: count(data?.recommendations?.accepted),
          editedAndAccepted: count(data?.recommendations?.editedAndAccepted),
          dismissed: count(data?.recommendations?.dismissed), superseded: count(data?.recommendations?.superseded),
          failed: count(data?.recommendations?.failed), aiUsed: count(data?.recommendations?.aiUsed),
          aiFallback: count(data?.recommendations?.aiFallback),
        },
        ai: {
          fallbackReasons: countMap(data?.ai?.fallbackReasons),
          responseStates: countMap(data?.ai?.responseStates),
          latencyMs: {
            observed: count(data?.ai?.latencyMs?.observed),
            average: nullableNumber(data?.ai?.latencyMs?.average),
            minimum: nullableNumber(data?.ai?.latencyMs?.minimum),
            maximum: nullableNumber(data?.ai?.latencyMs?.maximum),
            total: nullableNumber(data?.ai?.latencyMs?.total),
          },
          tokens: {
            observed: count(data?.ai?.tokens?.observed),
            inputTotal: nullableNumber(data?.ai?.tokens?.inputTotal),
            outputTotal: nullableNumber(data?.ai?.tokens?.outputTotal),
            cachedTotal: nullableNumber(data?.ai?.tokens?.cachedTotal),
            reasoningTotal: nullableNumber(data?.ai?.tokens?.reasoningTotal),
          },
        },
        suppressions: { active: count(data?.suppressions?.active) },
      };
    },

    async insertCrmFollowUpRecommendation(recommendation = {}) {
      const { data, error } = await client
        .from('crm_follow_up_recommendations')
        .upsert(recommendation, {
          onConflict: 'submission_id,input_fingerprint,engine_version',
          ignoreDuplicates: true,
        })
        .select()
        .maybeSingle();
      if (error) throw error;
      if (data) return normalizeCrmFollowUpRecommendationRow(data);
      const existing = await client
        .from('crm_follow_up_recommendations')
        .select('*')
        .eq('submission_id', recommendation.submission_id)
        .eq('input_fingerprint', recommendation.input_fingerprint)
        .eq('engine_version', recommendation.engine_version)
        .maybeSingle();
      if (existing.error) throw existing.error;
      return normalizeCrmFollowUpRecommendationRow(existing.data);
    },

    async getCurrentCrmFollowUpRecommendation(submissionId) {
      const { data, error } = await client
        .from('crm_follow_up_recommendations')
        .select('*')
        .eq('submission_id', submissionId)
        .eq('status', 'current')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmFollowUpRecommendationRow(data);
    },

    async getCrmFollowUpRecommendation(id) {
      const { data, error } = await client
        .from('crm_follow_up_recommendations')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmFollowUpRecommendationRow(data);
    },

    async supersedeCrmFollowUpRecommendations(submissionId, supersededAt) {
      const { data, error } = await client
        .from('crm_follow_up_recommendations')
        .update({ status: 'superseded', superseded_at: supersededAt })
        .eq('submission_id', submissionId)
        .eq('status', 'current')
        .select('id');
      if (error) throw error;
      return data?.length || 0;
    },

    async updateCrmFollowUpRecommendation(id, values = {}) {
      const allowedFields = new Set(['status', 'acted_on_at', 'superseded_at', 'acted_on_by', 'outcome', 'metadata']);
      const payload = Object.fromEntries(Object.entries(values).filter(([field]) => allowedFields.has(field)));
      if (Object.keys(payload).length === 0) {
        const current = await client.from('crm_follow_up_recommendations').select('*').eq('id', id).maybeSingle();
        if (current.error) throw current.error;
        return normalizeCrmFollowUpRecommendationRow(current.data);
      }
      const { data, error } = await client
        .from('crm_follow_up_recommendations')
        .update(payload)
        .eq('id', id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return normalizeCrmFollowUpRecommendationRow(data);
    },

    async getActiveEmailSuppression(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) return null;
      const { data, error } = await client
        .from('email_suppressions')
        .select('*')
        .eq('normalized_email', normalizedEmail)
        .is('lifted_at', null)
        .maybeSingle();
      if (error) throw error;
      return normalizeEmailSuppressionRow(data);
    },

    async upsertEmailSuppression(suppression = {}) {
      const payload = {
        ...suppression,
        normalized_email: String(suppression.normalized_email || '').trim().toLowerCase(),
        lifted_at: null,
        lifted_by: null,
        lift_reason: null,
      };
      const { data, error } = await client
        .from('email_suppressions')
        .upsert(payload, { onConflict: 'normalized_email' })
        .select()
        .single();
      if (error) throw error;
      return normalizeEmailSuppressionRow(data);
    },

    async liftEmailSuppression(email, { liftedAt = '', liftedBy = '', liftReason = '' } = {}) {
      const { data, error } = await client
        .from('email_suppressions')
        .update({ lifted_at: liftedAt, lifted_by: liftedBy, lift_reason: liftReason })
        .eq('normalized_email', String(email || '').trim().toLowerCase())
        .is('lifted_at', null)
        .select()
        .maybeSingle();
      if (error) throw error;
      return normalizeEmailSuppressionRow(data);
    },

    async listCrmCommunications({
      submissionId = '', cimRequestId = '', dealKey = '', unassigned = false, direction = '',
      channels = [], deliveryStates = [], contentStates = [], search = '', before = '', page = 1, pageSize = 25,
    } = {}) {
      const safePage = normalizePage(page);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const offset = before ? 0 : (safePage - 1) * safePageSize;
      let query = client
        .from('crm_communications')
        .select('*', { count: 'exact' })
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + safePageSize - 1);
      if (submissionId) query = query.eq('submission_id', submissionId);
      if (cimRequestId) query = query.eq('cim_request_id', cimRequestId);
      if (dealKey) query = query.eq('deal_key', dealKey);
      if (unassigned) query = query.is('submission_id', null);
      if (direction) query = query.eq('direction', direction);
      const safeChannels = normalizeList(channels, 20);
      const safeDeliveryStates = normalizeList(deliveryStates, 20);
      const safeContentStates = normalizeList(contentStates, 20);
      if (safeChannels.length > 0) query = query.in('channel', safeChannels);
      if (safeDeliveryStates.length > 0) query = query.in('delivery_state', safeDeliveryStates);
      if (safeContentStates.length > 0) query = query.in('content_state', safeContentStates);
      if (before) query = query.lt('occurred_at', before);
      const safeSearch = String(search || '').trim().toLowerCase().replace(/["\\(),]/g, ' ').slice(0, 500);
      if (safeSearch) {
        query = query.or([
          `subject.ilike."*${safeSearch}*"`,
          `from_address.ilike."*${safeSearch}*"`,
          `body_text.ilike."*${safeSearch}*"`,
          `deal_key.ilike."*${safeSearch}*"`,
        ].join(','));
      }
      const { data, error, count } = await query;
      if (error) throw error;
      return {
        rows: (data || []).map(normalizeCrmCommunicationRow),
        total: Number(count || 0),
        page: safePage,
        pageSize: safePageSize,
      };
    },

    async countCrmCommunications({
      submissionId = '', cimRequestId = '', unassigned = false, direction = '', contentStates = [], deliveryStates = [],
    } = {}) {
      let query = client.from('crm_communications').select('*', { count: 'exact', head: true });
      if (submissionId) query = query.eq('submission_id', submissionId);
      if (cimRequestId) query = query.eq('cim_request_id', cimRequestId);
      if (unassigned) query = query.is('submission_id', null);
      if (direction) query = query.eq('direction', direction);
      const safeContentStates = normalizeList(contentStates, 20);
      const safeDeliveryStates = normalizeList(deliveryStates, 20);
      if (safeContentStates.length > 0) query = query.in('content_state', safeContentStates);
      if (safeDeliveryStates.length > 0) query = query.in('delivery_state', safeDeliveryStates);
      const { count, error } = await query;
      if (error) throw error;
      return Number(count || 0);
    },

    async listCrmCommunicationsPendingIngestion({ dueBefore = '', limit = 25 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 250));
      const { data, error } = await client
        .from('crm_communications')
        .select('*')
        .in('content_state', ['pending', 'failed'])
        .not('content_next_attempt_at', 'is', null)
        .lte('content_next_attempt_at', dueBefore || new Date().toISOString())
        .order('content_next_attempt_at', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(safeLimit);
      if (error) throw error;
      return (data || []).map(normalizeCrmCommunicationRow);
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
      const { data, error } = await client.rpc('claim_crm_communications_pending_ingestion', {
        p_due_before: dueAt,
        p_lease_until: leaseAt,
        p_limit: Math.max(1, Math.min(Number(limit) || 25, 250)),
        p_claimed_by: String(claimedBy || 'communications-ingestion').trim().slice(0, 160)
          || 'communications-ingestion',
      });
      if (error) throw error;
      return Array.isArray(data) ? data.map(normalizeCrmCommunicationRow) : [];
    },

    async insertCrmActivityEvent(event) {
      const { data, error } = await client.from('crm_activity_events').insert(event).select().single();

      if (error) {
        throw error;
      }

      return normalizeCrmActivityEventRow(data);
    },

    async listCrmActivityEvents({ submissionId = '', eventTypes = [], limit = 200, before = '' } = {}) {
      let query = client
        .from('crm_activity_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 200, 500)));

      if (submissionId) {
        query = query.eq('submission_id', submissionId);
      }

      const safeTypes = normalizeList(eventTypes, 25);
      if (safeTypes.length > 0) {
        query = query.in('event_type', safeTypes);
      }

      if (before) {
        query = query.lt('created_at', before);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeCrmActivityEventRow);
    },



    async listDealHunterSeenDeals({ limit = 100000 } = {}) {
      const safeLimit = Math.max(1, Math.min(limit, 100000));
      const rows = [];
      const pageSize = 1000;

      for (let from = 0; from < safeLimit; from += pageSize) {
        const to = Math.min(from + pageSize - 1, safeLimit - 1);
        const { data, error } = await client
          .from('deal_hunter_seen_deals')
          .select('*')
          .order('last_seen_at', { ascending: false })
          .range(from, to);

        if (error) {
          throw error;
        }

        rows.push(...(data || []));

        if (!data || data.length < pageSize) {
          break;
        }
      }

      return rows.map(normalizeDealHunterSeenDealRow);
    },

    async upsertDealHunterSeenDeals(records = []) {
      const safeRecords = Array.isArray(records) ? records.filter((record) => record?.id) : [];

      if (safeRecords.length === 0) {
        return [];
      }

      for (const chunk of chunkValues(safeRecords, 500)) {
        const { error } = await client.from('deal_hunter_seen_deals').upsert(chunk, { onConflict: 'id' });

        if (error) {
          throw error;
        }
      }

      return safeRecords;
    },

    async insertDealHunterDealOsImport(record) {
      const payload = {
        ...record,
        expected_row_count: record.expected_row_count ?? null,
        records: Array.isArray(record.records) ? record.records : [],
        metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
          ? record.metadata
          : {},
      };
      const { data, error } = await client.from('deal_hunter_deal_os_imports').insert(payload).select().single();
      if (error) throw error;
      return normalizeDealHunterDealOsImportRow(data);
    },

    async getLatestDealHunterDealOsImport() {
      const { data, error } = await client
        .from('deal_hunter_deal_os_imports')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return normalizeDealHunterDealOsImportRow(data);
    },

    async listDealHunterDealOsImports({ limit = 25 } = {}) {
      const { data, error } = await client
        .from('deal_hunter_deal_os_imports')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
      if (error) throw error;
      return (data || []).map(normalizeDealHunterDealOsImportRow);
    },

    async insertDealHunterCimReviews(reviews = []) {
      const safeReviews = Array.isArray(reviews) ? reviews.filter((review) => review?.id && review?.deal_key) : [];
      if (safeReviews.length === 0) return [];
      const { data, error } = await client.from('deal_hunter_cim_reviews').insert(safeReviews).select();
      if (error) throw error;
      return data || [];
    },

    async listDealHunterCimReviews({ limit = 5000 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 100000));
      const { data, error } = await client.from('deal_hunter_cim_reviews').select('*').order('created_at', { ascending: false }).limit(safeLimit);
      if (error) throw error;
      return data || [];
    },

    async getDealHunterAutomationSettings() {
      const { data, error } = await client.from('deal_hunter_automation_settings').select('*').eq('id', 'cim-initial-outreach').maybeSingle();
      if (error) throw error;
      return data;
    },

    async upsertDealHunterAutomationSettings(settings = {}) {
      const payload = {
        id: 'cim-initial-outreach',
        updated_at: settings.updated_at || new Date().toISOString(),
        paused: Boolean(settings.paused),
        updated_by: settings.updated_by || '',
        metadata: settings.metadata || {},
      };
      const { data, error } = await client.from('deal_hunter_automation_settings').upsert(payload, { onConflict: 'id' }).select().single();
      if (error) throw error;
      return data;
    },

    async getDealHunterCrmImport({ id = '', dealKey = '', listingIdentity = '' } = {}) {
      return getDealHunterCrmImportRecord({ id, dealKey, listingIdentity });
    },

    async claimDealHunterCrmImport(record = {}, { pendingCutoff = '' } = {}) {
      const safeRecord = safeDealHunterCrmImport(record);
      const { data, error } = await client
        .from('deal_hunter_crm_imports')
        .insert(safeRecord)
        .select()
        .single();

      if (!error) {
        return {
          claimed: true,
          importRecord: normalizeDealHunterCrmImportRow(data),
        };
      }

      if (!isUniqueViolation(error)) {
        throw error;
      }

      const existingImport = await getDealHunterCrmImportRecord({
        id: safeRecord.id,
        dealKey: safeRecord.deal_key,
        listingIdentity: safeRecord.listing_identity,
      });
      const updatedAt = Date.parse(existingImport?.updated_at || '');
      const staleAt = Date.parse(pendingCutoff || '');
      const reclaimable =
        existingImport?.status === 'failed' ||
        (existingImport?.status === 'pending' && Number.isFinite(updatedAt) && Number.isFinite(staleAt) && updatedAt <= staleAt);

      if (!existingImport || !reclaimable) {
        return {
          claimed: false,
          importRecord: existingImport,
        };
      }

      const reclaimPayload = {
        updated_at: safeRecord.updated_at,
        listing_identity: safeRecord.listing_identity || existingImport.listing_identity,
        listing_url: safeRecord.listing_url || existingImport.listing_url,
        submission_id: existingImport.submission_id || safeRecord.submission_id,
        status: safeRecord.status,
        source_name: safeRecord.source_name || existingImport.source_name,
        metadata: safeRecord.metadata,
      };
      const { data: claimedData, error: claimError } = await client
        .from('deal_hunter_crm_imports')
        .update(reclaimPayload)
        .eq('id', existingImport.id)
        .eq('status', existingImport.status)
        .eq('updated_at', existingImport.updated_at)
        .select()
        .maybeSingle();

      if (claimError) {
        throw claimError;
      }

      return claimedData
        ? { claimed: true, importRecord: normalizeDealHunterCrmImportRow(claimedData) }
        : {
            claimed: false,
            importRecord: await getDealHunterCrmImportRecord({
              id: existingImport.id,
              dealKey: safeRecord.deal_key,
              listingIdentity: safeRecord.listing_identity,
            }),
          };
    },

    async updateDealHunterCrmImport(id, values = {}) {
      if (!id) {
        return null;
      }

      const payload = {};
      const allowedFields = [
        'updated_at',
        'listing_identity',
        'listing_url',
        'submission_id',
        'status',
        'source_name',
        'metadata',
      ];

      for (const field of allowedFields) {
        if (Object.hasOwn(values, field)) {
          payload[field] = field === 'metadata'
            ? (typeof values[field] === 'object' && values[field] !== null ? values[field] : {})
            : values[field];
        }
      }

      const { data, error } = await client
        .from('deal_hunter_crm_imports')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return normalizeDealHunterCrmImportRow(data);
    },

    async getDealHunterCimRequestById(id) {
      if (!id) return null;
      const { data, error } = await client
        .from('deal_hunter_cim_requests')
        .select('*')
        .eq('id', String(id).trim())
        .maybeSingle();
      if (error) throw error;
      return normalizeDealHunterCimRequestRow(data);
    },

    async getDealHunterCimRequestByReplyToAddress(replyToAddress, requestToken = '') {
      const normalizedAddress = String(replyToAddress || '').trim().toLowerCase();
      if (normalizedAddress) {
        const exact = await client
          .from('deal_hunter_cim_requests')
          .select('*')
          .eq('reply_to_address', normalizedAddress)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (exact.error) throw exact.error;
        if (exact.data) return normalizeDealHunterCimRequestRow(exact.data);
      }

      const token = String(requestToken || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
      if (!token) return null;
      const { data, error } = await client
        .from('deal_hunter_cim_requests')
        .select('*')
        .ilike('id', `${token}%`)
        .order('created_at', { ascending: true })
        .limit(2);
      if (error) throw error;
      return data?.length === 1 ? normalizeDealHunterCimRequestRow(data[0]) : null;
    },

    async getDealHunterCimRequest({ dealKey = '', recipientEmail = '' } = {}) {
      const normalizedEmail = String(recipientEmail || '').trim().toLowerCase();

      if (!dealKey || !normalizedEmail) {
        return null;
      }

      const { data, error } = await client
        .from('deal_hunter_cim_requests')
        .select('*')
        .eq('deal_key', dealKey)
        .eq('recipient_email', normalizedEmail)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return normalizeDealHunterCimRequestRow(data);
    },

    async listDealHunterCimRequests({ dealKeys = [], statuses = [], dueBefore = '', limit = 1000 } = {}) {
      const keys = normalizeList(dealKeys);
      const safeStatuses = normalizeList(statuses);

      const safeLimit = Math.max(1, Math.min(limit, 5000));
      let query = client
        .from('deal_hunter_cim_requests')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(safeLimit);

      if (keys.length > 0) {
        query = query.in('deal_key', keys);
      }

      if (safeStatuses.length > 0) {
        query = query.in('status', safeStatuses);
      }

      if (dueBefore) {
        query = query.lte('next_follow_up_at', dueBefore);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeDealHunterCimRequestRow);
    },

    async getLatestDealHunterCimRequestForSubmission(submissionId) {
      const normalizedId = String(submissionId || '').trim();
      if (!normalizedId) return null;
      const { data, error } = await client
        .from('deal_hunter_cim_requests')
        .select('*')
        .eq('submission_id', normalizedId)
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return normalizeDealHunterCimRequestRow(data);
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
	      const safePage = normalizePage(page);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const safeDeliveryStates = normalizeList(deliveryStates, 20).map((value) => value.replaceAll('_', '-'));
      const normalizedFollowUpState = String(followUpState || '').trim().toLowerCase().replaceAll('_', '-');
      const { data, error } = await client.rpc('list_deal_hunter_cim_request_history', {
        p_page: safePage,
        p_page_size: safePageSize,
        p_search: String(search || '').trim().slice(0, 500),
        p_request_states: normalizeList(requestStates, 20),
        p_delivery_states: safeDeliveryStates,
        p_statuses: normalizeList(statuses, 20),
        p_reply_state: String(replyState || '').trim().toLowerCase(),
        p_follow_up_state: normalizedFollowUpState,
        p_sort: ['first-request', 'last-activity', 'failure'].includes(sort) ? sort : 'last-activity',
        p_direction: String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc',
      });
      if (error) throw error;
      const result = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      const counts = result.counts && typeof result.counts === 'object' ? result.counts : {};
      return {
        rows: Array.isArray(result.rows) ? result.rows.map(normalizeDealHunterCimRequestRow) : [],
        total: Number(result.total || 0),
        page: Number(result.page || safePage),
        pageSize: Number(result.pageSize || result.page_size || safePageSize),
        counts: {
          ready: Number(counts.ready || 0),
          pending: Number(counts.pending || 0),
          accepted: Number(counts.accepted || 0),
          delivered: Number(counts.delivered || 0),
          deliveryIssue: Number(counts.deliveryIssue || counts.delivery_issue || 0),
          replied: Number(counts.replied || 0),
        },
      };
    },

	    async upsertDealHunterCimRequest(request = {}) {
	      const safeRequest = safeDealHunterCimRequest(request);
	      const { data, error } = await client
	        .from('deal_hunter_cim_requests')
	        .upsert(safeRequest, { onConflict: 'deal_key,recipient_email' })
	        .select()
	        .single();

	      if (error) {
	        throw error;
	      }

	      return normalizeDealHunterCimRequestRow(data);
	    },

	    async claimDealHunterCimRequest(request = {}, { pendingCutoff = '' } = {}) {
	      const safeRequest = safeDealHunterCimRequest(request);
	      const { data, error } = await client.rpc('claim_deal_hunter_cim_request', {
	        p_request: safeRequest,
	        p_pending_cutoff: pendingCutoff || null,
	      });
	      if (error) throw error;
	      const result = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
	      return {
	        claimed: Boolean(result.claimed),
	        reason: result.reason || '',
	        request: result.request ? normalizeDealHunterCimRequestRow(result.request) : null,
	      };
	    },

	    async claimDealHunterCimFollowUpRequest({ id = '', dueBefore = '', staleBefore = '', nowIso = '' } = {}) {
	      if (!id || !dueBefore || !nowIso) {
	        return { claimed: false, request: null };
	      }

	      const { data, error } = await client.rpc('claim_deal_hunter_cim_follow_up_request', {
	        p_request_id: id,
	        p_due_before: dueBefore,
	        p_stale_before: staleBefore || null,
	        p_claimed_at: nowIso,
	      });
	      if (error) throw error;
	      const result = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
	      return {
	        claimed: Boolean(result.claimed),
	        reason: result.reason || '',
	        request: result.request ? normalizeDealHunterCimRequestRow(result.request) : null,
	      };
	    },

	    async renewDealHunterCimRequestClaim({ id = '', expectedUpdatedAt = '', expectedStatus = '', nowIso = '' } = {}) {
	      if (!id || !expectedUpdatedAt || !expectedStatus || !nowIso) {
	        return { renewed: false, reason: 'invalid-claim', request: null };
	      }

	      const { data, error } = await client.rpc('renew_deal_hunter_cim_request_claim', {
	        p_request_id: id,
	        p_expected_updated_at: expectedUpdatedAt,
	        p_expected_status: expectedStatus,
	        p_renewed_at: nowIso,
	      });
	      if (error) throw error;
	      const result = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
	      return {
	        renewed: Boolean(result.renewed),
	        reason: result.reason || '',
	        request: result.request ? normalizeDealHunterCimRequestRow(result.request) : null,
	      };
	    },

    async getDealHunterDisposition({ id = '', dealKey = '' } = {}) {
      if (!id && !dealKey) return null;
      let query = client.from('deal_hunter_dispositions').select('*');
      query = id ? query.eq('id', id) : query.eq('deal_key', dealKey);
      const { data, error } = await query.limit(1).maybeSingle();
      if (error) throw error;
      return normalizeDealHunterDispositionRow(data);
    },

    async upsertDealHunterDisposition(record = {}) {
      const payload = safeDealHunterDisposition(record);
      const { data, error } = await client
        .from('deal_hunter_dispositions')
        .upsert(payload, { onConflict: 'deal_key' })
        .select()
        .single();
      if (error) throw error;
      return normalizeDealHunterDispositionRow(data);
    },

    async listDealHunterDispositions({ dealKeys = [], statuses = [], activeOnly = false, limit = 1000 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000));
      let query = client
        .from('deal_hunter_dispositions')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(safeLimit);
      const keys = normalizeList(dealKeys);
      const safeStatuses = normalizeList(statuses, 20);
      if (keys.length > 0) query = query.in('deal_key', keys);
      if (safeStatuses.length > 0) query = query.in('disposition', safeStatuses);
      else if (activeOnly) query = query.eq('disposition', 'dismissed');
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(normalizeDealHunterDispositionRow);
    },

    async claimScheduledJob({ jobKey = '', jobName = '', triggeredBy = '', nowIso = '', staleBefore = '', metadata = {} } = {}) {
      if (!jobKey || !jobName || !nowIso) {
        return { claimed: false, run: null };
      }

      const record = {
        job_key: jobKey,
        job_name: jobName,
        created_at: nowIso,
        updated_at: nowIso,
        started_at: nowIso,
        completed_at: null,
        status: 'pending',
        triggered_by: triggeredBy,
        attempt_count: 1,
        provider_message_id: null,
        last_error: null,
        metadata: metadata || {},
      };
      const inserted = await client.from('scheduled_job_runs').insert(record).select().single();

      if (!inserted.error) {
        return { claimed: true, run: inserted.data };
      }

      if (!isUniqueViolation(inserted.error)) {
        throw inserted.error;
      }

      const reclaimPayload = {
        updated_at: nowIso,
        started_at: nowIso,
        completed_at: null,
        status: 'pending',
        triggered_by: triggeredBy,
        provider_message_id: null,
        last_error: null,
        metadata: metadata || {},
      };
      const failedClaim = await client
        .from('scheduled_job_runs')
        .update(reclaimPayload)
        .eq('job_key', jobKey)
        .eq('status', 'failed')
        .select()
        .maybeSingle();

      if (failedClaim.error) {
        throw failedClaim.error;
      }

      let claimedData = failedClaim.data;

      if (!claimedData && staleBefore) {
        const staleClaim = await client
          .from('scheduled_job_runs')
          .update(reclaimPayload)
          .eq('job_key', jobKey)
          .eq('status', 'pending')
          .lte('updated_at', staleBefore)
          .select()
          .maybeSingle();

        if (staleClaim.error) {
          throw staleClaim.error;
        }

        claimedData = staleClaim.data;
      }

      if (claimedData) {
        const attemptCount = Number(claimedData.attempt_count || 1) + 1;
        const updated = await client
          .from('scheduled_job_runs')
          .update({ attempt_count: attemptCount })
          .eq('job_key', jobKey)
          .select()
          .single();

        if (updated.error) {
          throw updated.error;
        }

        return { claimed: true, run: updated.data };
      }

      const existing = await client.from('scheduled_job_runs').select('*').eq('job_key', jobKey).maybeSingle();
      if (existing.error) {
        throw existing.error;
      }
      return { claimed: false, run: existing.data || null };
    },

    async completeScheduledJob(jobKey, values = {}) {
      const completedAt = values.completed_at || new Date().toISOString();
      const { data, error } = await client
        .from('scheduled_job_runs')
        .update({
          updated_at: completedAt,
          completed_at: completedAt,
          status: values.status || 'completed',
          provider_message_id: values.provider_message_id || null,
          last_error: values.last_error || null,
          metadata: values.metadata || {},
        })
        .eq('job_key', jobKey)
        .select()
        .single();
      if (error) {
        throw error;
      }
      return data;
    },

    async getScheduledJob(jobKey) {
      const { data, error } = await client.from('scheduled_job_runs').select('*').eq('job_key', jobKey).maybeSingle();
      if (error) {
        throw error;
      }
      return data || null;
    },

    async listScheduledJobs({ limit = 100 } = {}) {
      const { data, error } = await client
        .from('scheduled_job_runs')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
      if (error) throw error;
      return data || [];
    },

    async getDatabaseStatus() {
      await this.checkHealth();
      return { provider: 'supabase', integrity: 'remote-provider-healthy', journalMode: 'managed', databaseBytes: null };
    },

    async insertAdminAuditEvent(event) {
      const { data, error } = await client.from('admin_audit_events').insert(event).select().single();
      if (error) {
        throw error;
      }
      return data;
    },

    async listAdminAuditEvents({ requestId = '', limit = 100 } = {}) {
      let query = client
        .from('admin_audit_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
      if (requestId) {
        query = query.eq('request_id', requestId);
      }
      const { data, error } = await query;
      if (error) {
        throw error;
      }
      return data || [];
    },

    async insertSourceHealthSnapshot(snapshot) {
      const { data, error } = await client.from('source_health_snapshots').insert(snapshot).select().single();
      if (error) throw error;
      return data;
    },

    async listSourceHealthSnapshots({ limit = 30 } = {}) {
      const { data, error } = await client
        .from('source_health_snapshots')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 30, 365)));
      if (error) throw error;
      return data || [];
    },

    async insertAdminMagicLink(record) {
      const { data, error } = await client.from('admin_magic_links').insert(record).select().single();
      if (error) throw error;
      return data;
    },

    async consumeAdminMagicLink(tokenHash, consumedAt) {
      const { data, error } = await client
        .from('admin_magic_links')
        .update({ consumed_at: consumedAt })
        .eq('token_hash', tokenHash)
        .is('consumed_at', null)
        .gt('expires_at', consumedAt)
        .select()
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async insertAdminSession(session) {
      const { data, error } = await client.from('admin_sessions').insert(session).select().single();
      if (error) throw error;
      return data;
    },

    async getAdminSession(id) {
      const { data, error } = await client.from('admin_sessions').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async listAdminOnboardingProgress(principalId) {
      const { data, error } = await client
        .from('admin_onboarding_progress')
        .select('*')
        .eq('principal_id', principalId)
        .order('updated_at', { ascending: false })
        .order('tour_key', { ascending: true })
        .order('tour_version', { ascending: false });
      if (error) throw error;
      return (data || []).map(normalizeAdminOnboardingProgressRow);
    },

    async upsertAdminOnboardingProgress(record) {
      const { data, error } = await client.rpc('upsert_admin_onboarding_progress', {
        p_principal_id: record.principal_id,
        p_tour_key: record.tour_key,
        p_tour_version: record.tour_version,
        p_status: record.status,
        p_last_completed_step_id: record.last_completed_step_id || null,
        p_step_ids: record.valid_step_ids || [],
        p_started_at: record.started_at,
        p_updated_at: record.updated_at,
        p_completed_at: record.completed_at || null,
        p_skipped_at: record.skipped_at || null,
      });
      if (error) throw error;
      return normalizeAdminOnboardingProgressRow(Array.isArray(data) ? data[0] : data);
    },

    async touchAdminSession(id, lastSeenAt) {
      const { error } = await client.from('admin_sessions').update({ last_seen_at: lastSeenAt }).eq('id', id).is('revoked_at', null).gt('expires_at', lastSeenAt);
      if (error) throw error;
    },

    async revokeAdminSession(id, revokedAt) {
      const { data, error } = await client.from('admin_sessions').update({ revoked_at: revokedAt }).eq('id', id).is('revoked_at', null).select('id');
      if (error) throw error;
      return (data || []).length > 0;
    },

    async revokeAdminSessionsForPrincipal(principalId, revokedAt) {
      const { data, error } = await client.from('admin_sessions').update({ revoked_at: revokedAt }).eq('principal_id', principalId).is('revoked_at', null).select('id');
      if (error) throw error;
      return (data || []).length;
    },

    async cleanupExpiredAuthRecords(nowIso) {
      const [magicLinks, sessions] = await Promise.all([
        client.from('admin_magic_links').delete().or(`expires_at.lte.${nowIso},consumed_at.not.is.null`).select('token_hash'),
        client.from('admin_sessions').delete().or(`expires_at.lte.${nowIso},revoked_at.not.is.null`).select('id'),
      ]);
      if (magicLinks.error) throw magicLinks.error;
      if (sessions.error) throw sessions.error;
      return { magicLinks: magicLinks.data?.length || 0, sessions: sessions.data?.length || 0 };
    },

    async insertSecureDocumentCleanupJob(job) {
      const { data, error } = await client.from('secure_document_cleanup_jobs').insert(job).select().single();
      if (error) {
        throw error;
      }
      return normalizeSecureDocumentCleanupJobRow(data);
    },

    async updateSecureDocumentCleanupJob(id, values = {}) {
      if (['lease_claimed_at', 'lease_expires_at', 'lease_token'].some((field) => Object.hasOwn(values, field))) {
        throw new Error('Cleanup-job lease fields require a token-fenced update.');
      }
      const { data, error } = await client
        .from('secure_document_cleanup_jobs')
        .update(values)
        .eq('id', id)
        .is('lease_token', null)
        .select()
        .maybeSingle();
      if (error) {
        throw error;
      }
      return normalizeSecureDocumentCleanupJobRow(data);
    },

    async claimSecureDocumentCleanupJob(id, lease = {}) {
      const { durationMs, leaseToken } = normalizeSecureDocumentCleanupLease(lease);
      const { data, error } = await client.rpc('claim_secure_document_cleanup_job', {
        p_id: id,
        p_lease_duration_ms: durationMs,
        p_lease_token: leaseToken,
      });
      if (error) {
        throw error;
      }
      return normalizeSecureDocumentCleanupJobRow(data);
    },

    async renewSecureDocumentCleanupJobLease(id, leaseToken, durationMs) {
      const normalizedLeaseToken = normalizeCleanupLeaseToken(leaseToken);
      const normalizedDurationMs = normalizeCleanupLeaseDuration(durationMs);
      const { data, error } = await client.rpc('renew_secure_document_cleanup_job_lease', {
        p_id: id,
        p_lease_token: normalizedLeaseToken,
        p_lease_duration_ms: normalizedDurationMs,
      });
      if (error) {
        throw error;
      }
      return normalizeSecureDocumentCleanupJobRow(data);
    },

    async updateSecureDocumentCleanupJobIfLeased(id, leaseToken, values = {}) {
      const normalizedLeaseToken = normalizeCleanupLeaseToken(leaseToken);
      const normalizedValues = normalizeSecureDocumentCleanupJobUpdate(values);
      const { data, error } = await client.rpc('update_secure_document_cleanup_job_if_leased', {
        p_id: id,
        p_lease_token: normalizedLeaseToken,
        p_values: normalizedValues,
      });
      if (error) {
        throw error;
      }
      return normalizeSecureDocumentCleanupJobRow(data);
    },

    async getSecureDocumentCleanupJob(id) {
      const { data, error } = await client.from('secure_document_cleanup_jobs').select('*').eq('id', id).maybeSingle();
      if (error) {
        throw error;
      }
      return normalizeSecureDocumentCleanupJobRow(data);
    },

    async listPendingSecureDocumentCleanupJobs(limit = 100) {
      const { data, error } = await client
        .from('secure_document_cleanup_jobs')
        .select('*')
        .not('status', 'in', '(completed,restored)')
        .order('created_at', { ascending: true })
        .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
      if (error) {
        throw error;
      }
      return (data || []).map(normalizeSecureDocumentCleanupJobRow);
    },

    async listSecureDocumentCleanupJobs({ limit = 100 } = {}) {
      const { data, error } = await client
        .from('secure_document_cleanup_jobs')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
      if (error) throw error;
      return (data || []).map(normalizeSecureDocumentCleanupJobRow);
    },
	  };
}
