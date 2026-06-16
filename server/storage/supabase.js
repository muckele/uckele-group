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

function normalizeProspectDiscoveryRunRow(row) {
  return row
    ? {
        ...row,
        source_data: typeof row.source_data === 'object' && row.source_data !== null ? row.source_data : {},
      }
    : null;
}

function normalizeProspectDiscoveryRow(row) {
  return row
    ? {
        ...row,
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        review_count: Number(row.review_count || 0),
        score: Number(row.score || 0),
        business_quality_score: Number(row.business_quality_score || 0),
        presence_gap_score: Number(row.presence_gap_score || 0),
        reasons: Array.isArray(row.reasons) ? row.reasons : [],
        source_data: typeof row.source_data === 'object' && row.source_data !== null ? row.source_data : {},
      }
    : null;
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

export function createSupabaseStorage(config) {
  if (!config.storage.supabaseUrl || !config.storage.supabaseServiceRoleKey) {
    throw new Error('Supabase storage provider requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const client = createClient(config.storage.supabaseUrl, config.storage.supabaseServiceRoleKey, {
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

    async getSubmission(id) {
      const { data, error } = await client.from('contact_submissions').select('*').eq('id', id).single();

      if (error) {
        return null;
      }

      return normalizeSubmissionRow(data);
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

    async listSubmissions({ limit = 50, page = 1, search = '', status = 'all' } = {}) {
      const safeLimit = Math.max(1, Math.min(limit, 5000));
      const from = Math.max(0, page - 1) * safeLimit;
      const to = from + safeLimit - 1;
      let query = client
        .from('contact_submissions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (status && status !== 'all') {
        query = query.eq('status', status);
      }

      if (search) {
        const term = search.replace(/[,%()]/g, ' ').trim();
        query = query.or(
          `name.ilike.%${term}%,email.ilike.%${term}%,company.ilike.%${term}%,message.ilike.%${term}%,notes.ilike.%${term}%,listing_url.ilike.%${term}%,business_website.ilike.%${term}%,prospectus_url.ilike.%${term}%,broker_name.ilike.%${term}%,broker_email.ilike.%${term}%,seller_name.ilike.%${term}%,seller_email.ilike.%${term}%`,
        );
      }

      const { data, error, count } = await query;

      if (error) {
        throw error;
      }

      return {
        rows: (data || []).map(normalizeSubmissionRow),
        total: count || 0,
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

    async insertProspectDiscoveryRun(run) {
      const { data, error } = await client.from('prospect_discovery_runs').insert(run).select().single();

      if (error) {
        throw error;
      }

      return normalizeProspectDiscoveryRunRow(data);
    },

    async updateProspectDiscoveryRun(id, values) {
      const { data, error } = await client
        .from('prospect_discovery_runs')
        .update(values)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return normalizeProspectDiscoveryRunRow(data);
    },

    async listProspectDiscoveryRuns({ limit = 20 } = {}) {
      const safeLimit = Math.max(1, Math.min(limit, 100));
      const { data, error } = await client
        .from('prospect_discovery_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeProspectDiscoveryRunRow);
    },

    async getProspectDiscoveryBySource(provider, sourceId) {
      const normalizedProvider = String(provider || '').trim();
      const normalizedSourceId = String(sourceId || '').trim();

      if (!normalizedProvider || !normalizedSourceId) {
        return null;
      }

      const { data, error } = await client
        .from('prospect_discoveries')
        .select('*')
        .eq('provider', normalizedProvider)
        .eq('source_id', normalizedSourceId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return normalizeProspectDiscoveryRow(data);
    },

    async insertProspectDiscovery(discovery) {
      if (discovery.source_id) {
        const { data, error } = await client
          .from('prospect_discoveries')
          .upsert(discovery, { onConflict: 'provider,source_id', ignoreDuplicates: true })
          .select()
          .maybeSingle();

        if (error) {
          throw error;
        }

        return normalizeProspectDiscoveryRow(data) || this.getProspectDiscoveryBySource(discovery.provider, discovery.source_id);
      }

      const { data, error } = await client.from('prospect_discoveries').insert(discovery).select().single();

      if (error) {
        throw error;
      }

      return normalizeProspectDiscoveryRow(data);
    },

    async updateProspectDiscovery(id, values) {
      const { data, error } = await client
        .from('prospect_discoveries')
        .update(values)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return normalizeProspectDiscoveryRow(data);
    },

    async listProspectDiscoveries({ runId = '', status = '', limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(limit, 500));
      let query = client
        .from('prospect_discoveries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (runId) {
        query = query.eq('run_id', runId);
      }

      if (status && status !== 'all') {
        query = query.eq('status', status);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeProspectDiscoveryRow);
    },

    async getProspectDiscoverySummary() {
      const summary = {
        total: 0,
        imported: 0,
        discovered: 0,
        duplicate: 0,
        'import-error': 0,
        'not-prioritized': 0,
        byTier: { tier_a: 0, tier_b: 0, tier_c: 0, dnp: 0, unclassified: 0 },
      };
      const pageSize = 1000;

      for (let from = 0; ; from += pageSize) {
        const to = from + pageSize - 1;
        const { data, error } = await client
          .from('prospect_discoveries')
          .select('status, lead_tier')
          .range(from, to);

        if (error) {
          throw error;
        }

        for (const row of data || []) {
          const status = row.status || 'discovered';
          const leadTier = row.lead_tier || 'unclassified';

          summary.total += 1;
          summary[status] = (summary[status] || 0) + 1;
          summary.byTier[leadTier] = (summary.byTier[leadTier] || 0) + 1;
        }

        if (!data || data.length < pageSize) {
          break;
        }
      }

      return summary;
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
        .select()
        .single();

      if (claimError) {
        throw claimError;
      }

      return {
        claimed: true,
        importRecord: normalizeDealHunterCrmImportRow(claimedData),
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
	  };
	}
