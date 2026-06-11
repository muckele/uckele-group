import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
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

function normalizeResearchRunRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeProspectAuditRow(row) {
  return row
    ? {
        ...row,
        findings: parseJsonColumn(row.findings, []),
        competitor_insights: parseJsonColumn(row.competitor_insights, []),
        sources: parseJsonColumn(row.sources, []),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeMarketReportRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeGeneratedReportDocumentRow(row) {
  return row
    ? {
        ...row,
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
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
    spam_reasons: JSON.stringify(submission.spam_reasons || []),
    metadata: JSON.stringify(submission.metadata || {}),
    tags: JSON.stringify(submission.tags || []),
  };
}

function serializeEmailEvent(event) {
  return {
    ...event,
    metadata: JSON.stringify(event.metadata || {}),
  };
}

function serializeResearchRun(run) {
  return {
    ...run,
    metadata: JSON.stringify(run.metadata || {}),
  };
}

function serializeProspectAudit(audit) {
  return {
    ...audit,
    findings: JSON.stringify(audit.findings || []),
    competitor_insights: JSON.stringify(audit.competitor_insights || []),
    sources: JSON.stringify(audit.sources || []),
    metadata: JSON.stringify(audit.metadata || {}),
  };
}

function serializeMarketReport(report) {
  return {
    ...report,
    metadata: JSON.stringify(report.metadata || {}),
  };
}

function serializeGeneratedReportDocument(document) {
  return {
    ...document,
    metadata: JSON.stringify(document.metadata || {}),
  };
}

function serializeDealHunterSeenDeal(deal) {
  return {
    ...deal,
    should_remove: deal.should_remove ? 1 : 0,
    metadata: JSON.stringify(deal.metadata || {}),
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

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function createSqliteStorage(config) {
  const directory = path.dirname(config.storage.sqlitePath);
  fs.mkdirSync(directory, { recursive: true });

  const database = new Database(config.storage.sqlitePath);
  database.pragma('journal_mode = WAL');

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
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS contact_rate_limit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      note TEXT
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
      source TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      run_type TEXT NOT NULL,
      source TEXT NOT NULL,
      query TEXT,
      location TEXT,
      industry TEXT,
      requested_by TEXT,
      started_at TEXT,
      completed_at TEXT,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      total_audited INTEGER NOT NULL DEFAULT 0,
      total_reports INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS prospect_audits (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      submission_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      business_name TEXT NOT NULL,
      website_url TEXT,
      contact_name TEXT,
      contact_email TEXT,
      phone TEXT,
      location TEXT,
      industry TEXT,
      score INTEGER,
      summary TEXT,
      findings TEXT NOT NULL DEFAULT '[]',
      competitor_insights TEXT NOT NULL DEFAULT '[]',
      sources TEXT NOT NULL DEFAULT '[]',
      report_id TEXT,
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS generated_market_reports (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      audit_id TEXT,
      submission_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      report_type TEXT NOT NULL,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      storage_path TEXT,
      content TEXT,
      summary TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

	    CREATE TABLE IF NOT EXISTS generated_report_documents (
	      id TEXT PRIMARY KEY,
      report_id TEXT,
      run_id TEXT,
      audit_id TEXT,
      submission_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT,
      checksum TEXT,
      status TEXT NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at ON contact_submissions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_status ON contact_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_email ON contact_submissions(email);
    CREATE INDEX IF NOT EXISTS idx_contact_submissions_ip_hash ON contact_submissions(ip_hash);
    CREATE INDEX IF NOT EXISTS idx_contact_rate_limit_events_bucket ON contact_rate_limit_events(bucket, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_upload_requests_submission_id ON secure_upload_requests(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_documents_submission_id ON secure_documents(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_documents_request_id ON secure_documents(request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_submission_id ON email_events(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_recipient_email ON email_events(recipient_email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_events_message_id ON email_events(message_id);
    CREATE INDEX IF NOT EXISTS idx_email_events_event_type ON email_events(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_runs_created_at ON research_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_runs_status ON research_runs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_research_runs_run_type ON research_runs(run_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prospect_audits_run_id ON prospect_audits(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prospect_audits_submission_id ON prospect_audits(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prospect_audits_website_url ON prospect_audits(website_url);
    CREATE INDEX IF NOT EXISTS idx_prospect_audits_status ON prospect_audits(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_market_reports_run_id ON generated_market_reports(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_market_reports_audit_id ON generated_market_reports(audit_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_market_reports_submission_id ON generated_market_reports(submission_id, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_generated_report_documents_report_id ON generated_report_documents(report_id, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_generated_report_documents_run_id ON generated_report_documents(run_id, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_generated_report_documents_audit_id ON generated_report_documents(audit_id, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_generated_report_documents_submission_id ON generated_report_documents(submission_id, created_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_last_seen_at ON deal_hunter_seen_deals(last_seen_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_source_id ON deal_hunter_seen_deals(source_id, last_seen_at DESC);
	  `);

  ensureColumn(database, 'contact_submissions', 'lead_type', "TEXT NOT NULL DEFAULT 'owner'");
  ensureColumn(database, 'contact_submissions', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(database, 'contact_submissions', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'contact_submissions', 'assigned_to', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'notes', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'follow_up_state', "TEXT NOT NULL DEFAULT 'needs-response'");
  ensureColumn(database, 'contact_submissions', 'next_action_at', 'TEXT');
  ensureColumn(database, 'contact_submissions', 'last_contacted_at', 'TEXT');
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
  ensureColumn(database, 'email_events', 'provider_event_id', 'TEXT');
  ensureColumn(database, 'email_events', 'event_key', 'TEXT');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_event_key ON email_events(event_key)');

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
      note
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
      @note
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

  const insertEmailEventStatement = database.prepare(`
    INSERT OR IGNORE INTO email_events (
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
      @source,
      @metadata
    )
  `);
  const getEmailEventByKeyStatement = database.prepare('SELECT * FROM email_events WHERE event_key = ? LIMIT 1');

  const insertResearchRunStatement = database.prepare(`
    INSERT INTO research_runs (
      id,
      created_at,
      updated_at,
      status,
      run_type,
      source,
      query,
      location,
      industry,
      requested_by,
      started_at,
      completed_at,
      total_candidates,
      total_audited,
      total_reports,
      error,
      metadata
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
      @status,
      @run_type,
      @source,
      @query,
      @location,
      @industry,
      @requested_by,
      @started_at,
      @completed_at,
      @total_candidates,
      @total_audited,
      @total_reports,
      @error,
      @metadata
    )
  `);

  const insertProspectAuditStatement = database.prepare(`
    INSERT INTO prospect_audits (
      id,
      run_id,
      submission_id,
      created_at,
      updated_at,
      status,
      business_name,
      website_url,
      contact_name,
      contact_email,
      phone,
      location,
      industry,
      score,
      summary,
      findings,
      competitor_insights,
      sources,
      report_id,
      error,
      metadata
    ) VALUES (
      @id,
      @run_id,
      @submission_id,
      @created_at,
      @updated_at,
      @status,
      @business_name,
      @website_url,
      @contact_name,
      @contact_email,
      @phone,
      @location,
      @industry,
      @score,
      @summary,
      @findings,
      @competitor_insights,
      @sources,
      @report_id,
      @error,
      @metadata
    )
  `);

  const insertMarketReportStatement = database.prepare(`
    INSERT INTO generated_market_reports (
      id,
      run_id,
      audit_id,
      submission_id,
      created_at,
      updated_at,
      report_type,
      title,
      format,
      status,
      storage_path,
      content,
      summary,
      metadata
    ) VALUES (
      @id,
      @run_id,
      @audit_id,
      @submission_id,
      @created_at,
      @updated_at,
      @report_type,
      @title,
      @format,
      @status,
      @storage_path,
      @content,
      @summary,
      @metadata
    )
  `);

	  const insertGeneratedReportDocumentStatement = database.prepare(`
    INSERT INTO generated_report_documents (
      id,
      report_id,
      run_id,
      audit_id,
      submission_id,
      created_at,
      updated_at,
      document_type,
      title,
      file_name,
      mime_type,
      size_bytes,
      storage_path,
      checksum,
      status,
      metadata
    ) VALUES (
      @id,
      @report_id,
      @run_id,
      @audit_id,
      @submission_id,
      @created_at,
      @updated_at,
      @document_type,
      @title,
      @file_name,
      @mime_type,
      @size_bytes,
      @storage_path,
      @checksum,
      @status,
      @metadata
    )
	  `);

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

  function updateRecord(tableName, id, values, allowedFields, jsonFields = []) {
    const updates = Object.entries(values).filter(([key]) => allowedFields.includes(key));

    if (updates.length === 0) {
      return;
    }

    const fields = updates.map(([key]) => `${key} = @${key}`).join(', ');
    const payload = updates.reduce((accumulator, [key, value]) => {
      accumulator[key] = jsonFields.includes(key) ? JSON.stringify(value ?? []) : value;
      return accumulator;
    }, {});

    payload.id = id;
    database.prepare(`UPDATE ${tableName} SET ${fields} WHERE id = @id`).run(payload);
  }

  return {
    async insertSubmission(submission) {
      insertSubmissionStatement.run(serializeSubmission(submission));
      return submission;
    },

    async updateSubmission(id, values) {
      updateRecord(
        'contact_submissions',
        id,
        values,
        [
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
        ],
        ['spam_reasons', 'metadata', 'tags'],
      );

      return this.getSubmission(id);
    },

    async getSubmission(id) {
      const row = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(id);
      return row ? normalizeSubmissionRow(row) : null;
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

    async listSubmissions({ limit = 50, page = 1, search = '', status = 'all' } = {}) {
      const clauses = [];
      const params = [];

      if (status && status !== 'all') {
        clauses.push('status = ?');
        params.push(status);
      }

      if (search) {
        clauses.push(`
          LOWER(
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
          ) LIKE ?
        `);
        params.push(`%${search.toLowerCase()}%`);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(limit, 5000));
      const offset = Math.max(0, page - 1) * safeLimit;
      const rows = database
        .prepare(
          `
            SELECT * FROM contact_submissions
            ${whereClause}
            ORDER BY created_at DESC
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
      database.prepare('INSERT INTO contact_rate_limit_events (bucket, created_at) VALUES (?, ?)').run(bucket, createdAt);
    },

    async countRateLimitEvents(bucket, sinceIso) {
      return (
        database
          .prepare('SELECT COUNT(*) AS count FROM contact_rate_limit_events WHERE bucket = ? AND created_at >= ?')
          .get(bucket, sinceIso)?.count || 0
      );
    },

    async insertSecureUploadRequest(requestRecord) {
      insertSecureUploadRequestStatement.run(requestRecord);
      return requestRecord;
    },

    async updateSecureUploadRequest(id, values) {
      updateRecord(
        'secure_upload_requests',
        id,
        values,
        ['updated_at', 'status', 'expires_at', 'nda_required', 'nda_accepted_at', 'last_uploaded_at', 'note'],
      );

      return this.getSecureUploadRequest(id);
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
      return document;
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

    async listEmailEvents({ submissionId = '', recipientEmail = '', limit = 100 } = {}) {
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

    async insertResearchRun(run) {
      const record = {
        query: '',
        location: '',
        industry: '',
        requested_by: '',
        started_at: null,
        completed_at: null,
        total_candidates: 0,
        total_audited: 0,
        total_reports: 0,
        error: '',
        metadata: {},
        ...run,
        status: run.status || 'queued',
        run_type: run.run_type || 'manual-audit',
        source: run.source || 'manual',
      };

      insertResearchRunStatement.run(serializeResearchRun(record));
      return this.getResearchRun(record.id);
    },

    async updateResearchRun(id, values) {
      updateRecord(
        'research_runs',
        id,
        values,
        [
          'updated_at',
          'status',
          'run_type',
          'source',
          'query',
          'location',
          'industry',
          'requested_by',
          'started_at',
          'completed_at',
          'total_candidates',
          'total_audited',
          'total_reports',
          'error',
          'metadata',
        ],
        ['metadata'],
      );

      return this.getResearchRun(id);
    },

    async getResearchRun(id) {
      const row = database.prepare('SELECT * FROM research_runs WHERE id = ?').get(id);
      return normalizeResearchRunRow(row);
    },

    async listResearchRuns({ status = 'all', runType = '', limit = 50 } = {}) {
      const clauses = [];
      const params = [];

      if (status && status !== 'all') {
        clauses.push('status = ?');
        params.push(status);
      }

      if (runType) {
        clauses.push('run_type = ?');
        params.push(runType);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(limit, 500));

      return database
        .prepare(
          `
            SELECT * FROM research_runs
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeResearchRunRow);
    },

    async insertProspectAudit(audit) {
      const record = {
        run_id: null,
        submission_id: null,
        website_url: '',
        contact_name: '',
        contact_email: '',
        phone: '',
        location: '',
        industry: '',
        score: null,
        summary: '',
        findings: [],
        competitor_insights: [],
        sources: [],
        report_id: null,
        error: '',
        metadata: {},
        ...audit,
        status: audit.status || 'queued',
        business_name: audit.business_name || 'Unknown business',
      };

      insertProspectAuditStatement.run(serializeProspectAudit(record));
      return this.getProspectAudit(record.id);
    },

    async updateProspectAudit(id, values) {
      updateRecord(
        'prospect_audits',
        id,
        values,
        [
          'run_id',
          'submission_id',
          'updated_at',
          'status',
          'business_name',
          'website_url',
          'contact_name',
          'contact_email',
          'phone',
          'location',
          'industry',
          'score',
          'summary',
          'findings',
          'competitor_insights',
          'sources',
          'report_id',
          'error',
          'metadata',
        ],
        ['findings', 'competitor_insights', 'sources', 'metadata'],
      );

      return this.getProspectAudit(id);
    },

    async getProspectAudit(id) {
      const row = database.prepare('SELECT * FROM prospect_audits WHERE id = ?').get(id);
      return normalizeProspectAuditRow(row);
    },

    async listProspectAudits({ submissionId = '', runId = '', status = 'all', limit = 100 } = {}) {
      const clauses = [];
      const params = [];

      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(submissionId);
      }

      if (runId) {
        clauses.push('run_id = ?');
        params.push(runId);
      }

      if (status && status !== 'all') {
        clauses.push('status = ?');
        params.push(status);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(limit, 500));

      return database
        .prepare(
          `
            SELECT * FROM prospect_audits
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeProspectAuditRow);
    },

    async listProspectAuditsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      return database
        .prepare(
          `
            SELECT * FROM prospect_audits
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, safeLimit)
        .map(normalizeProspectAuditRow);
    },

    async insertGeneratedMarketReport(report) {
      const record = {
        run_id: null,
        audit_id: null,
        submission_id: null,
        storage_path: '',
        content: '',
        summary: '',
        metadata: {},
        ...report,
        report_type: report.report_type || 'prospect-audit',
        title: report.title || 'Generated market report',
        format: report.format || 'markdown',
        status: report.status || 'draft',
      };

      insertMarketReportStatement.run(serializeMarketReport(record));
      return this.getGeneratedMarketReport(record.id);
    },

    async updateGeneratedMarketReport(id, values) {
      updateRecord(
        'generated_market_reports',
        id,
        values,
        [
          'run_id',
          'audit_id',
          'submission_id',
          'updated_at',
          'report_type',
          'title',
          'format',
          'status',
          'storage_path',
          'content',
          'summary',
          'metadata',
        ],
        ['metadata'],
      );

      return this.getGeneratedMarketReport(id);
    },

    async getGeneratedMarketReport(id) {
      const row = database.prepare('SELECT * FROM generated_market_reports WHERE id = ?').get(id);
      return normalizeMarketReportRow(row);
    },

    async listGeneratedMarketReports({ submissionId = '', auditId = '', runId = '', limit = 100 } = {}) {
      const clauses = [];
      const params = [];

      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(submissionId);
      }

      if (auditId) {
        clauses.push('audit_id = ?');
        params.push(auditId);
      }

      if (runId) {
        clauses.push('run_id = ?');
        params.push(runId);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(limit, 500));

      return database
        .prepare(
          `
            SELECT * FROM generated_market_reports
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeMarketReportRow);
    },

    async listGeneratedMarketReportsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      return database
        .prepare(
          `
            SELECT * FROM generated_market_reports
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, safeLimit)
        .map(normalizeMarketReportRow);
    },

    async insertGeneratedReportDocument(document) {
      const record = {
        report_id: null,
        run_id: null,
        audit_id: null,
        submission_id: null,
        file_name: '',
        mime_type: '',
        size_bytes: 0,
        storage_path: '',
        checksum: '',
        metadata: {},
        ...document,
        document_type: document.document_type || 'report',
        title: document.title || document.file_name || 'Generated report document',
        status: document.status || 'ready',
      };

      insertGeneratedReportDocumentStatement.run(serializeGeneratedReportDocument(record));
      return this.getGeneratedReportDocument(record.id);
    },

    async updateGeneratedReportDocument(id, values) {
      updateRecord(
        'generated_report_documents',
        id,
        values,
        [
          'report_id',
          'run_id',
          'audit_id',
          'submission_id',
          'updated_at',
          'document_type',
          'title',
          'file_name',
          'mime_type',
          'size_bytes',
          'storage_path',
          'checksum',
          'status',
          'metadata',
        ],
        ['metadata'],
      );

      return this.getGeneratedReportDocument(id);
    },

    async getGeneratedReportDocument(id) {
      const row = database.prepare('SELECT * FROM generated_report_documents WHERE id = ?').get(id);
      return normalizeGeneratedReportDocumentRow(row);
    },

    async listGeneratedReportDocuments({ reportId = '', submissionId = '', auditId = '', runId = '', limit = 100 } = {}) {
      const clauses = [];
      const params = [];

      if (reportId) {
        clauses.push('report_id = ?');
        params.push(reportId);
      }

      if (submissionId) {
        clauses.push('submission_id = ?');
        params.push(submissionId);
      }

      if (auditId) {
        clauses.push('audit_id = ?');
        params.push(auditId);
      }

      if (runId) {
        clauses.push('run_id = ?');
        params.push(runId);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const safeLimit = Math.max(1, Math.min(limit, 500));

      return database
        .prepare(
          `
            SELECT * FROM generated_report_documents
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeGeneratedReportDocumentRow);
    },

	    async listGeneratedReportDocumentsForSubmissions(submissionIds = [], limit = 5000) {
	      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      const safeLimit = Math.max(1, Math.min(limit, 10000));
      return database
        .prepare(
          `
            SELECT * FROM generated_report_documents
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
	        .all(...ids, safeLimit)
	        .map(normalizeGeneratedReportDocumentRow);
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
	  };
	}
