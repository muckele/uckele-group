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

function normalizeDealHunterCimRequestRow(row) {
  return row
    ? {
        ...row,
        follow_up_count: Number(row.follow_up_count || 0),
        metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
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
    upsert_deal_hunter_cim_request: normalizeDealHunterCimRequestRow,
  };
  const normalizeRecord = normalizers[operation] || ((record) => record);

  return {
    applied: Boolean(data.applied),
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
  return {
    ...request,
    recipient_email: String(request.recipient_email || '').trim().toLowerCase(),
    follow_up_count: Number(request.follow_up_count || 0),
  };
}

function dealHunterCimUpdatePayload(request = {}) {
  const payload = safeDealHunterCimRequest(request);
  delete payload.created_at;
  return payload;
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
      const { data, error } = await client.rpc('mutate_with_crm_activity', {
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

    async deleteSubmission(id) {
      const existing = await this.getSubmission(id);

      if (!existing) {
        return null;
      }

      const nowIso = new Date().toISOString();
      const relatedUpdates = await Promise.all([
        client.from('email_events').delete().eq('submission_id', id),
        client
          .from('deal_hunter_crm_imports')
          .update({ submission_id: null, status: 'crm-deleted', updated_at: nowIso })
          .eq('submission_id', id),
      ]);
      const relatedError = relatedUpdates.find((result) => result.error)?.error;

      if (relatedError) {
        throw relatedError;
      }

      const { error } = await client.from('contact_submissions').delete().eq('id', id);

      if (error) {
        throw error;
      }

      return existing;
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
	      const { data: insertedData, error: insertError } = await client
	        .from('deal_hunter_cim_requests')
	        .insert(safeRequest)
	        .select()
	        .single();

	      if (!insertError) {
	        return {
	          claimed: true,
	          request: normalizeDealHunterCimRequestRow(insertedData),
	        };
	      }

	      if (!isUniqueViolation(insertError)) {
	        throw insertError;
	      }

	      const updatePayload = dealHunterCimUpdatePayload(safeRequest);
	      const claimFailedRequest = async () => client
	        .from('deal_hunter_cim_requests')
	        .update(updatePayload)
	        .eq('deal_key', safeRequest.deal_key)
	        .eq('recipient_email', safeRequest.recipient_email)
	        .eq('status', 'failed')
	        .select()
	        .maybeSingle();
	      const claimStalePendingRequest = async () => {
	        if (!pendingCutoff) {
	          return { data: null, error: null };
	        }

	        return client
	          .from('deal_hunter_cim_requests')
	          .update(updatePayload)
	          .eq('deal_key', safeRequest.deal_key)
	          .eq('recipient_email', safeRequest.recipient_email)
	          .eq('status', 'pending')
	          .lte('updated_at', pendingCutoff)
	          .select()
	          .maybeSingle();
	      };
	      const failedClaim = await claimFailedRequest();

	      if (failedClaim.error) {
	        throw failedClaim.error;
	      }

	      if (failedClaim.data) {
	        return {
	          claimed: true,
	          request: normalizeDealHunterCimRequestRow(failedClaim.data),
	        };
	      }

	      const stalePendingClaim = await claimStalePendingRequest();

	      if (stalePendingClaim.error) {
	        throw stalePendingClaim.error;
	      }

	      if (stalePendingClaim.data) {
	        return {
	          claimed: true,
	          request: normalizeDealHunterCimRequestRow(stalePendingClaim.data),
	        };
	      }

	      return {
	        claimed: false,
	        request: await this.getDealHunterCimRequest({
	          dealKey: safeRequest.deal_key,
	          recipientEmail: safeRequest.recipient_email,
	        }),
	      };
	    },

	    async claimDealHunterCimFollowUpRequest({ id = '', dueBefore = '', staleBefore = '', nowIso = '' } = {}) {
	      if (!id || !dueBefore || !nowIso) {
	        return { claimed: false, request: null };
	      }

	      const updatePayload = {
	        status: 'follow_up_pending',
	        delivery_error: '',
	        updated_at: nowIso,
	      };
	      const activeClaim = await client
	        .from('deal_hunter_cim_requests')
	        .update(updatePayload)
	        .eq('id', id)
	        .not('next_follow_up_at', 'is', null)
	        .lte('next_follow_up_at', dueBefore)
	        .in('status', ['sent', 'logged', 'failed', 'follow_up_failed'])
	        .select()
	        .maybeSingle();

	      if (activeClaim.error) {
	        throw activeClaim.error;
	      }

	      if (activeClaim.data) {
	        return {
	          claimed: true,
	          request: normalizeDealHunterCimRequestRow(activeClaim.data),
	        };
	      }

	      if (staleBefore) {
	        const staleClaim = await client
	          .from('deal_hunter_cim_requests')
	          .update(updatePayload)
	          .eq('id', id)
	          .not('next_follow_up_at', 'is', null)
	          .lte('next_follow_up_at', dueBefore)
	          .eq('status', 'follow_up_pending')
	          .lte('updated_at', staleBefore)
	          .select()
	          .maybeSingle();

	        if (staleClaim.error) {
	          throw staleClaim.error;
	        }

	        if (staleClaim.data) {
	          return {
	            claimed: true,
	            request: normalizeDealHunterCimRequestRow(staleClaim.data),
	          };
	        }
	      }

	      const { data, error } = await client
	        .from('deal_hunter_cim_requests')
	        .select('*')
	        .eq('id', id)
	        .maybeSingle();

	      if (error) {
	        throw error;
	      }

	      return {
	        claimed: false,
	        request: normalizeDealHunterCimRequestRow(data),
	      };
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
