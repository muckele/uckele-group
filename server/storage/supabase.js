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

function normalizeDealHunterCriteriaRow(row) {
  return row
    ? {
        ...row,
        criteria: typeof row.criteria === 'object' && row.criteria !== null ? row.criteria : {},
      }
    : null;
}

function normalizeDealHunterRunRow(row) {
  return row
    ? {
        ...row,
        criteria_snapshot:
          typeof row.criteria_snapshot === 'object' && row.criteria_snapshot !== null ? row.criteria_snapshot : {},
        recommendations: Array.isArray(row.recommendations) ? row.recommendations : [],
      }
    : null;
}

function normalizeDealHunterCandidateRow(row) {
  return row
    ? {
        ...row,
        reasons: Array.isArray(row.reasons) ? row.reasons : [],
        risks: Array.isArray(row.risks) ? row.risks : [],
        matched_keywords: Array.isArray(row.matched_keywords) ? row.matched_keywords : [],
        excluded_reasons: Array.isArray(row.excluded_reasons) ? row.excluded_reasons : [],
      }
    : null;
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

    async getDealHunterCriteria(id = 'default') {
      const { data, error } = await client.from('deal_hunter_criteria').select('*').eq('id', id).maybeSingle();

      if (error) {
        throw error;
      }

      return normalizeDealHunterCriteriaRow(data);
    },

    async upsertDealHunterCriteria(record) {
      const { data, error } = await client.from('deal_hunter_criteria').upsert(record).select().single();

      if (error) {
        throw error;
      }

      return normalizeDealHunterCriteriaRow(data);
    },

    async insertDealHunterRun(run, candidates = []) {
      const { data, error } = await client.from('deal_hunter_runs').insert(run).select().single();

      if (error) {
        throw error;
      }

      if (candidates.length > 0) {
        const { error: candidatesError } = await client.from('deal_hunter_candidates').insert(
          candidates.map((candidate) => ({
            ...candidate,
            run_id: run.id,
          })),
        );

        if (candidatesError) {
          throw candidatesError;
        }
      }

      return normalizeDealHunterRunRow(data);
    },

    async updateDealHunterRun(id, values) {
      const { data, error } = await client.from('deal_hunter_runs').update(values).eq('id', id).select().single();

      if (error) {
        throw error;
      }

      return normalizeDealHunterRunRow(data);
    },

    async getDealHunterRun(id) {
      const { data, error } = await client.from('deal_hunter_runs').select('*').eq('id', id).maybeSingle();

      if (error) {
        throw error;
      }

      return normalizeDealHunterRunRow(data);
    },

    async listDealHunterRuns({ limit = 8 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 50));
      const { data, error } = await client
        .from('deal_hunter_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeDealHunterRunRow);
    },

    async listDealHunterCandidates({ runId, status = '', limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      let query = client
        .from('deal_hunter_candidates')
        .select('*')
        .order('score', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(safeLimit);

      if (runId) {
        query = query.eq('run_id', runId);
      }

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return (data || []).map(normalizeDealHunterCandidateRow);
    },
  };
}
