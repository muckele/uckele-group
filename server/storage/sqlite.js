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
    lead_source_url: row.listing_url || '',
    service_interest: row.prospectus_url || '',
    package_budget: row.asking_price || '',
    monthly_lead_value: row.ttm_revenue || '',
    lead_goal: row.ttm_ebitda || '',
    current_provider: row.ebitda_multiple || '',
    conversion_issue: row.net_margin || '',
    priority_fit: normalizeSbaEligibility(row.sba_eligible, 'unknown'),
    partner_name: row.broker_name || '',
    partner_email: row.broker_email || '',
    partner_phone: row.broker_phone || '',
    primary_contact_name: row.seller_name || '',
    primary_contact_email: row.seller_email || '',
    primary_contact_phone: row.seller_phone || '',
    lead_type: normalizeLeadType(row.lead_type, 'prospect'),
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

function normalizeJsonRecordRow(row, jsonFields = []) {
  if (!row) {
    return null;
  }

  return jsonFields.reduce(
    (record, field) => ({
      ...record,
      [field]: parseJsonColumn(record[field], Array.isArray(record[field]) ? [] : {}),
    }),
    { ...row },
  );
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

function serializeJsonRecord(record, jsonFields = []) {
  return jsonFields.reduce(
    (payload, field) => ({
      ...payload,
      [field]: JSON.stringify(payload[field] || (field.endsWith('s') ? [] : {})),
    }),
    { ...record },
  );
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
      submission_id TEXT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_by TEXT,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      source_url TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      tier TEXT,
      summary TEXT,
      source_data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS prospect_audits (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      submission_id TEXT,
      created_at TEXT NOT NULL,
      website_url TEXT,
      uptime_status TEXT,
      http_status INTEGER,
      ssl_status TEXT,
      page_title TEXT,
      meta_description TEXT,
      has_contact_form INTEGER NOT NULL DEFAULT 0,
      has_phone_link INTEGER NOT NULL DEFAULT 0,
      has_booking_link INTEGER NOT NULL DEFAULT 0,
      has_mobile_viewport INTEGER NOT NULL DEFAULT 0,
      cta_count INTEGER NOT NULL DEFAULT 0,
      broken_link_count INTEGER NOT NULL DEFAULT 0,
      page_size_bytes INTEGER NOT NULL DEFAULT 0,
      load_time_ms INTEGER NOT NULL DEFAULT 0,
      findings TEXT NOT NULL DEFAULT '[]',
      source_links TEXT NOT NULL DEFAULT '[]',
      raw_snapshot TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS generated_reports (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      submission_id TEXT,
      created_at TEXT NOT NULL,
      report_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      content_markdown TEXT,
      personalization TEXT NOT NULL DEFAULT '{}',
      recommended_email_subject TEXT,
      recommended_email_body TEXT
    );

    CREATE TABLE IF NOT EXISTS outreach_messages (
      id TEXT PRIMARY KEY,
      submission_id TEXT,
      report_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cadence_name TEXT NOT NULL,
      cadence_step INTEGER NOT NULL,
      status TEXT NOT NULL,
      scheduled_at TEXT,
      sent_at TEXT,
      recipient_email TEXT,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT,
      provider_message_id TEXT,
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS website_visits (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      submission_id TEXT,
      session_id TEXT,
      page_path TEXT NOT NULL,
      full_url TEXT,
      referrer TEXT,
      source TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS email_suppressions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      email TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT,
      submission_id TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_research_runs_submission_id ON research_runs(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prospect_audits_submission_id ON prospect_audits(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_reports_submission_id ON generated_reports(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outreach_messages_submission_id ON outreach_messages(submission_id, scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outreach_messages_status_due ON outreach_messages(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_website_visits_submission_id ON website_visits(submission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_suppressions_email ON email_suppressions(email);
  `);

  ensureColumn(database, 'contact_submissions', 'lead_type', "TEXT NOT NULL DEFAULT 'prospect'");
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
      id, created_at, updated_at, submission_id, run_type, status, requested_by, started_at, completed_at,
      error, source_url, score, tier, summary, source_data
    ) VALUES (
      @id, @created_at, @updated_at, @submission_id, @run_type, @status, @requested_by, @started_at, @completed_at,
      @error, @source_url, @score, @tier, @summary, @source_data
    )
  `);

  const insertProspectAuditStatement = database.prepare(`
    INSERT INTO prospect_audits (
      id, run_id, submission_id, created_at, website_url, uptime_status, http_status, ssl_status,
      page_title, meta_description, has_contact_form, has_phone_link, has_booking_link, has_mobile_viewport,
      cta_count, broken_link_count, page_size_bytes, load_time_ms, findings, source_links, raw_snapshot
    ) VALUES (
      @id, @run_id, @submission_id, @created_at, @website_url, @uptime_status, @http_status, @ssl_status,
      @page_title, @meta_description, @has_contact_form, @has_phone_link, @has_booking_link, @has_mobile_viewport,
      @cta_count, @broken_link_count, @page_size_bytes, @load_time_ms, @findings, @source_links, @raw_snapshot
    )
  `);

  const insertGeneratedReportStatement = database.prepare(`
    INSERT INTO generated_reports (
      id, run_id, submission_id, created_at, report_type, status, title, summary,
      content_markdown, personalization, recommended_email_subject, recommended_email_body
    ) VALUES (
      @id, @run_id, @submission_id, @created_at, @report_type, @status, @title, @summary,
      @content_markdown, @personalization, @recommended_email_subject, @recommended_email_body
    )
  `);

  const insertOutreachMessageStatement = database.prepare(`
    INSERT INTO outreach_messages (
      id, submission_id, report_id, created_at, updated_at, cadence_name, cadence_step, status, scheduled_at,
      sent_at, recipient_email, subject, body_text, body_html, provider_message_id, error, metadata
    ) VALUES (
      @id, @submission_id, @report_id, @created_at, @updated_at, @cadence_name, @cadence_step, @status, @scheduled_at,
      @sent_at, @recipient_email, @subject, @body_text, @body_html, @provider_message_id, @error, @metadata
    )
  `);

  const insertWebsiteVisitStatement = database.prepare(`
    INSERT INTO website_visits (
      id, created_at, submission_id, session_id, page_path, full_url, referrer, source, ip_hash, user_agent, metadata
    ) VALUES (
      @id, @created_at, @submission_id, @session_id, @page_path, @full_url, @referrer, @source, @ip_hash, @user_agent, @metadata
    )
  `);

  const insertEmailSuppressionStatement = database.prepare(`
    INSERT INTO email_suppressions (
      id, created_at, email, reason, source, submission_id, metadata
    ) VALUES (
      @id, @created_at, @email, @reason, @source, @submission_id, @metadata
    )
  `);

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

    async getSecureDocument(id) {
      return database.prepare('SELECT * FROM secure_documents WHERE id = ?').get(id);
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
      insertResearchRunStatement.run(serializeJsonRecord(run, ['source_data']));
      return run;
    },

    async updateResearchRun(id, values) {
      updateRecord(
        'research_runs',
        id,
        values,
        ['updated_at', 'status', 'started_at', 'completed_at', 'error', 'source_url', 'score', 'tier', 'summary', 'source_data'],
        ['source_data'],
      );

      return this.getResearchRun(id);
    },

    async getResearchRun(id) {
      const row = database.prepare('SELECT * FROM research_runs WHERE id = ?').get(id);
      return normalizeJsonRecordRow(row, ['source_data']);
    },

    async listResearchRunsForSubmission(submissionId, limit = 10) {
      return database
        .prepare('SELECT * FROM research_runs WHERE submission_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(submissionId, Math.max(1, Math.min(limit, 100)))
        .map((row) => normalizeJsonRecordRow(row, ['source_data']));
    },

    async listResearchRunsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM research_runs
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, Math.max(1, Math.min(limit, 10000)))
        .map((row) => normalizeJsonRecordRow(row, ['source_data']));
    },

    async insertProspectAudit(audit) {
      const payload = {
        ...audit,
        has_contact_form: audit.has_contact_form ? 1 : 0,
        has_phone_link: audit.has_phone_link ? 1 : 0,
        has_booking_link: audit.has_booking_link ? 1 : 0,
        has_mobile_viewport: audit.has_mobile_viewport ? 1 : 0,
      };
      insertProspectAuditStatement.run(serializeJsonRecord(payload, ['findings', 'source_links', 'raw_snapshot']));
      return audit;
    },

    async listProspectAuditsForSubmission(submissionId, limit = 10) {
      return database
        .prepare('SELECT * FROM prospect_audits WHERE submission_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(submissionId, Math.max(1, Math.min(limit, 100)))
        .map((row) => {
          const audit = normalizeJsonRecordRow(row, ['findings', 'source_links', 'raw_snapshot']);
          return audit
            ? {
                ...audit,
                has_contact_form: Boolean(audit.has_contact_form),
                has_phone_link: Boolean(audit.has_phone_link),
                has_booking_link: Boolean(audit.has_booking_link),
                has_mobile_viewport: Boolean(audit.has_mobile_viewport),
              }
            : null;
        });
    },

    async listProspectAuditsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM prospect_audits
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, Math.max(1, Math.min(limit, 10000)))
        .map((row) => {
          const audit = normalizeJsonRecordRow(row, ['findings', 'source_links', 'raw_snapshot']);
          return {
            ...audit,
            has_contact_form: Boolean(audit.has_contact_form),
            has_phone_link: Boolean(audit.has_phone_link),
            has_booking_link: Boolean(audit.has_booking_link),
            has_mobile_viewport: Boolean(audit.has_mobile_viewport),
          };
        });
    },

    async insertGeneratedReport(report) {
      insertGeneratedReportStatement.run(serializeJsonRecord(report, ['personalization']));
      return report;
    },

    async listGeneratedReportsForSubmission(submissionId, limit = 10) {
      return database
        .prepare('SELECT * FROM generated_reports WHERE submission_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(submissionId, Math.max(1, Math.min(limit, 100)))
        .map((row) => normalizeJsonRecordRow(row, ['personalization']));
    },

    async listGeneratedReportsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM generated_reports
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, Math.max(1, Math.min(limit, 10000)))
        .map((row) => normalizeJsonRecordRow(row, ['personalization']));
    },

    async insertOutreachMessage(message) {
      insertOutreachMessageStatement.run(serializeJsonRecord(message, ['metadata']));
      return message;
    },

    async updateOutreachMessage(id, values) {
      updateRecord(
        'outreach_messages',
        id,
        values,
        ['updated_at', 'status', 'scheduled_at', 'sent_at', 'provider_message_id', 'error', 'metadata'],
        ['metadata'],
      );

      const row = database.prepare('SELECT * FROM outreach_messages WHERE id = ?').get(id);
      return normalizeJsonRecordRow(row, ['metadata']);
    },

    async claimOutreachMessageForSending(id, { now = new Date().toISOString() } = {}) {
      const row = database
        .prepare(
          `
            UPDATE outreach_messages
            SET updated_at = ?, status = 'sending'
            WHERE id = ? AND status = 'scheduled'
            RETURNING *
          `,
        )
        .get(now, id);

      return normalizeJsonRecordRow(row, ['metadata']);
    },

    async listOutreachMessagesForSubmission(submissionId, limit = 20) {
      return database
        .prepare('SELECT * FROM outreach_messages WHERE submission_id = ? ORDER BY scheduled_at ASC, created_at ASC LIMIT ?')
        .all(submissionId, Math.max(1, Math.min(limit, 200)))
        .map((row) => normalizeJsonRecordRow(row, ['metadata']));
    },

    async listOutreachMessagesForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM outreach_messages
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY scheduled_at ASC, created_at ASC
            LIMIT ?
          `,
        )
        .all(...ids, Math.max(1, Math.min(limit, 10000)))
        .map((row) => normalizeJsonRecordRow(row, ['metadata']));
    },

    async listDueOutreachMessages({ now = new Date().toISOString(), limit = 25 } = {}) {
      return database
        .prepare(
          `
            SELECT * FROM outreach_messages
            WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
            ORDER BY scheduled_at ASC
            LIMIT ?
          `,
        )
        .all(now, Math.max(1, Math.min(limit, 250)))
        .map((row) => normalizeJsonRecordRow(row, ['metadata']));
    },

    async countSentOutreachMessagesSince(sinceIso) {
      return (
        database
          .prepare(
            `
              SELECT COUNT(*) AS count FROM outreach_messages
              WHERE (status = 'sent' AND sent_at IS NOT NULL AND sent_at >= ?)
                OR (status = 'sending' AND updated_at >= ?)
            `,
          )
          .get(sinceIso, sinceIso)?.count || 0
      );
    },

    async insertWebsiteVisit(visit) {
      insertWebsiteVisitStatement.run(serializeJsonRecord(visit, ['metadata']));
      return visit;
    },

    async listWebsiteVisitsForSubmission(submissionId, limit = 50) {
      return database
        .prepare('SELECT * FROM website_visits WHERE submission_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(submissionId, Math.max(1, Math.min(limit, 500)))
        .map((row) => normalizeJsonRecordRow(row, ['metadata']));
    },

    async listWebsiteVisitsForSubmissions(submissionIds = [], limit = 5000) {
      const ids = normalizeList(submissionIds);

      if (ids.length === 0) {
        return [];
      }

      return database
        .prepare(
          `
            SELECT * FROM website_visits
            WHERE submission_id IN (${placeholders(ids.length)})
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...ids, Math.max(1, Math.min(limit, 10000)))
        .map((row) => normalizeJsonRecordRow(row, ['metadata']));
    },

    async insertEmailSuppression(suppression) {
      insertEmailSuppressionStatement.run(serializeJsonRecord(suppression, ['metadata']));
      return suppression;
    },

    async getEmailSuppression(email) {
      const normalizedEmail = String(email || '').trim().toLowerCase();

      if (!normalizedEmail) {
        return null;
      }

      const row = database.prepare('SELECT * FROM email_suppressions WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(normalizedEmail);
      return normalizeJsonRecordRow(row, ['metadata']);
    },

  };
}
