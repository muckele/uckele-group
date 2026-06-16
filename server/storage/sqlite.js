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

function normalizeDealHunterSeenDealRow(row) {
  return row
    ? {
        ...row,
        should_remove: Boolean(row.should_remove),
        metadata: parseJsonColumn(row.metadata, {}),
      }
    : null;
}

function normalizeDealHunterCimRequestRow(row) {
  return row
    ? {
        ...row,
        follow_up_count: Number(row.follow_up_count || 0),
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

function normalizeProspectDiscoveryRunRow(row) {
  return row
    ? {
        ...row,
        source_data: parseJsonColumn(row.source_data, {}),
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
        reasons: parseJsonColumn(row.reasons, []),
        source_data: parseJsonColumn(row.source_data, {}),
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

function serializeUploadRequest(request) {
  return {
    ...request,
    nda_required: request.nda_required ? 1 : 0,
  };
}

function serializeUploadRequestValues(values) {
  return Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => [key, key === 'nda_required' ? (value ? 1 : 0) : value]),
  );
}

function serializeEmailEvent(event) {
  return {
    ...event,
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

function serializeDealHunterCimRequest(request) {
  return {
    ...request,
    recipient_email: String(request.recipient_email || '').trim().toLowerCase(),
    follow_up_count: Number(request.follow_up_count || 0),
    last_follow_up_at: request.last_follow_up_at || null,
    next_follow_up_at: request.next_follow_up_at || null,
    responded_at: request.responded_at || null,
    metadata: JSON.stringify(request.metadata || {}),
  };
}

function serializeDealHunterCrmImport(record) {
  return {
    ...record,
    metadata: JSON.stringify(record.metadata || {}),
  };
}

function serializeProspectDiscoveryRun(run) {
  return {
    ...run,
    source_data: JSON.stringify(run.source_data || {}),
  };
}

function serializeProspectDiscovery(discovery) {
  return {
    ...discovery,
    lead_tier: discovery.lead_tier || 'unclassified',
    business_quality_score: Number(discovery.business_quality_score || 0),
    presence_gap_score: Number(discovery.presence_gap_score || 0),
    recommended_action: discovery.recommended_action || '',
    outreach_angle: discovery.outreach_angle || '',
    reasons: JSON.stringify(discovery.reasons || []),
    source_data: JSON.stringify(discovery.source_data || {}),
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

    CREATE TABLE IF NOT EXISTS prospect_discovery_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      query TEXT NOT NULL,
      requested_by TEXT,
      max_results INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      source_data TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS prospect_discoveries (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_id TEXT,
      business_name TEXT NOT NULL,
      website_url TEXT,
      phone TEXT,
      address TEXT,
      category TEXT,
      rating REAL,
      review_count INTEGER NOT NULL DEFAULT 0,
      search_query TEXT,
      status TEXT NOT NULL,
      lead_tier TEXT NOT NULL DEFAULT 'unclassified',
      business_quality_score INTEGER NOT NULL DEFAULT 0,
      presence_gap_score INTEGER NOT NULL DEFAULT 0,
      recommended_action TEXT,
      outreach_angle TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      reasons TEXT NOT NULL DEFAULT '[]',
      submission_id TEXT,
      source_data TEXT NOT NULL DEFAULT '{}'
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
    CREATE INDEX IF NOT EXISTS idx_prospect_discovery_runs_created_at ON prospect_discovery_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prospect_discoveries_run_id ON prospect_discoveries(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prospect_discoveries_status ON prospect_discoveries(status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_discoveries_source ON prospect_discoveries(provider, source_id) WHERE source_id IS NOT NULL AND source_id <> '';
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_last_seen_at ON deal_hunter_seen_deals(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_source_id ON deal_hunter_seen_deals(source_id, last_seen_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_deal_recipient ON deal_hunter_cim_requests(deal_key, recipient_email);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_deal_key ON deal_hunter_cim_requests(deal_key, updated_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_deal_key ON deal_hunter_crm_imports(deal_key);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_listing_identity ON deal_hunter_crm_imports(listing_identity) WHERE listing_identity IS NOT NULL AND listing_identity <> '';
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_submission_id ON deal_hunter_crm_imports(submission_id);
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
  ensureColumn(database, 'prospect_discoveries', 'lead_tier', "TEXT NOT NULL DEFAULT 'unclassified'");
  ensureColumn(database, 'prospect_discoveries', 'business_quality_score', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'prospect_discoveries', 'presence_gap_score', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'prospect_discoveries', 'recommended_action', 'TEXT');
  ensureColumn(database, 'prospect_discoveries', 'outreach_angle', 'TEXT');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_event_key ON email_events(event_key)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_prospect_discoveries_lead_tier ON prospect_discoveries(lead_tier, score DESC)');
  ensureColumn(database, 'deal_hunter_cim_requests', 'follow_up_count', 'INTEGER NOT NULL DEFAULT 0');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'last_follow_up_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'next_follow_up_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_cim_requests', 'responded_at', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'listing_identity', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'listing_url', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'submission_id', 'TEXT');
	  ensureColumn(database, 'deal_hunter_crm_imports', 'source_name', 'TEXT');

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

  const insertProspectDiscoveryRunStatement = database.prepare(`
    INSERT INTO prospect_discovery_runs (
      id,
      created_at,
      updated_at,
      status,
      provider,
      query,
      requested_by,
      max_results,
      imported_count,
      skipped_count,
      error,
      source_data
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
      @status,
      @provider,
      @query,
      @requested_by,
      @max_results,
      @imported_count,
      @skipped_count,
      @error,
      @source_data
    )
  `);

  const insertProspectDiscoveryStatement = database.prepare(`
    INSERT OR IGNORE INTO prospect_discoveries (
      id,
      run_id,
      created_at,
      updated_at,
      provider,
      source_id,
      business_name,
      website_url,
      phone,
      address,
      category,
      rating,
      review_count,
      search_query,
      status,
      lead_tier,
      business_quality_score,
      presence_gap_score,
      recommended_action,
      outreach_angle,
      score,
      reasons,
      submission_id,
      source_data
    ) VALUES (
      @id,
      @run_id,
      @created_at,
      @updated_at,
      @provider,
      @source_id,
      @business_name,
      @website_url,
      @phone,
      @address,
      @category,
      @rating,
      @review_count,
      @search_query,
      @status,
      @lead_tier,
      @business_quality_score,
      @presence_gap_score,
      @recommended_action,
      @outreach_angle,
      @score,
      @reasons,
      @submission_id,
      @source_data
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

  const upsertDealHunterCimRequestStatement = database.prepare(`
    INSERT INTO deal_hunter_cim_requests (
      id,
      created_at,
      updated_at,
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
      metadata
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
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
      @metadata
    )
    ON CONFLICT(deal_key, recipient_email) DO UPDATE SET
      id = excluded.id,
      updated_at = excluded.updated_at,
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
      metadata = excluded.metadata
  `);
  const insertDealHunterCimRequestStatement = database.prepare(`
    INSERT INTO deal_hunter_cim_requests (
      id,
      created_at,
      updated_at,
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
      metadata
    ) VALUES (
      @id,
      @created_at,
      @updated_at,
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
      @metadata
    )
  `);
  const claimDealHunterCimRequestStatement = database.prepare(`
    UPDATE deal_hunter_cim_requests SET
      id = @id,
      updated_at = @updated_at,
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
      metadata = @metadata
    WHERE deal_key = @deal_key
      AND LOWER(recipient_email) = @recipient_email
      AND (
        status = 'failed'
        OR (status = 'pending' AND @pending_cutoff != '' AND updated_at <= @pending_cutoff)
      )
  `);
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

	  const insertDealHunterCrmImportStatement = database.prepare(`
	    INSERT INTO deal_hunter_crm_imports (
	      id,
	      created_at,
	      updated_at,
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
	      listing_identity = COALESCE(@listing_identity, listing_identity),
	      listing_url = COALESCE(@listing_url, listing_url),
	      submission_id = COALESCE(@submission_id, submission_id),
	      status = COALESCE(@status, status),
	      source_name = COALESCE(@source_name, source_name),
	      metadata = COALESCE(@metadata, metadata)
	    WHERE id = @id
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
      insertSecureUploadRequestStatement.run(serializeUploadRequest(requestRecord));
      return requestRecord;
    },

    async updateSecureUploadRequest(id, values) {
      updateRecord(
        'secure_upload_requests',
        id,
        serializeUploadRequestValues(values),
        ['updated_at', 'status', 'expires_at', 'nda_required', 'nda_accepted_at', 'last_uploaded_at', 'note'],
      );

      return this.getSecureUploadRequest(id);
    },

    async claimSecureUploadRequest(id, values, options = {}) {
      const updates = Object.entries(serializeUploadRequestValues(values)).filter(([key]) =>
        ['updated_at', 'status', 'nda_accepted_at', 'last_uploaded_at', 'note'].includes(key),
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
                status = 'awaiting-documents'
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

    async insertProspectDiscoveryRun(run) {
      insertProspectDiscoveryRunStatement.run(serializeProspectDiscoveryRun(run));
      return run;
    },

    async updateProspectDiscoveryRun(id, values) {
      updateRecord(
        'prospect_discovery_runs',
        id,
        values,
        ['updated_at', 'status', 'imported_count', 'skipped_count', 'error', 'source_data'],
        ['source_data'],
      );

      const row = database.prepare('SELECT * FROM prospect_discovery_runs WHERE id = ?').get(id);
      return normalizeProspectDiscoveryRunRow(row);
    },

    async listProspectDiscoveryRuns({ limit = 20 } = {}) {
      const safeLimit = Math.max(1, Math.min(limit, 100));
      return database
        .prepare(
          `
            SELECT * FROM prospect_discovery_runs
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(safeLimit)
        .map(normalizeProspectDiscoveryRunRow);
    },

    async getProspectDiscoveryBySource(provider, sourceId) {
      const normalizedProvider = String(provider || '').trim();
      const normalizedSourceId = String(sourceId || '').trim();

      if (!normalizedProvider || !normalizedSourceId) {
        return null;
      }

      const row = database
        .prepare(
          `
            SELECT * FROM prospect_discoveries
            WHERE provider = ? AND source_id = ?
            ORDER BY created_at DESC
            LIMIT 1
          `,
        )
        .get(normalizedProvider, normalizedSourceId);

      return normalizeProspectDiscoveryRow(row);
    },

    async insertProspectDiscovery(discovery) {
      const serialized = serializeProspectDiscovery(discovery);
      const result = insertProspectDiscoveryStatement.run(serialized);

      if (result.changes === 0 && discovery.source_id) {
        return this.getProspectDiscoveryBySource(discovery.provider, discovery.source_id);
      }

      return discovery;
    },

    async updateProspectDiscovery(id, values) {
      updateRecord(
        'prospect_discoveries',
        id,
        values,
        [
          'updated_at',
          'status',
          'lead_tier',
          'business_quality_score',
          'presence_gap_score',
          'recommended_action',
          'outreach_angle',
          'score',
          'reasons',
          'submission_id',
          'source_data',
        ],
        ['reasons', 'source_data'],
      );

      const row = database.prepare('SELECT * FROM prospect_discoveries WHERE id = ?').get(id);
      return normalizeProspectDiscoveryRow(row);
    },

    async listProspectDiscoveries({ runId = '', status = '', limit = 50 } = {}) {
      const clauses = [];
      const params = [];

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
            SELECT * FROM prospect_discoveries
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ?
          `,
        )
        .all(...params, safeLimit)
        .map(normalizeProspectDiscoveryRow);
    },

    async getProspectDiscoverySummary() {
      const rows = database
        .prepare(
          `
            SELECT status, lead_tier, COUNT(*) AS count
            FROM prospect_discoveries
            GROUP BY status, lead_tier
          `,
        )
        .all();
      const summary = {
        total: 0,
        imported: 0,
        discovered: 0,
        duplicate: 0,
        'import-error': 0,
        'not-prioritized': 0,
        byTier: { tier_a: 0, tier_b: 0, tier_c: 0, dnp: 0, unclassified: 0 },
      };

      for (const row of rows) {
        const count = Number(row.count || 0);
        const status = row.status || 'discovered';
        const leadTier = row.lead_tier || 'unclassified';

        summary.total += count;
        summary[status] = (summary[status] || 0) + count;
        summary.byTier[leadTier] = (summary.byTier[leadTier] || 0) + count;
      }

      return summary;
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

	    async getDealHunterCrmImport({ id = '', dealKey = '', listingIdentity = '' } = {}) {
	      if (!id && !dealKey && !listingIdentity) {
	        return null;
	      }

	      const row = database
	        .prepare(
	          `
	            SELECT * FROM deal_hunter_crm_imports
	            WHERE id = ?
	              OR deal_key = ?
	              OR (? <> '' AND listing_identity = ?)
	            ORDER BY updated_at DESC
	            LIMIT 1
	          `,
	        )
	        .get(id || '', dealKey || '', listingIdentity || '', listingIdentity || '');

	      return normalizeDealHunterCrmImportRow(row);
	    },

	    async claimDealHunterCrmImport(record = {}, { pendingCutoff = '' } = {}) {
	      const serializedRecord = serializeDealHunterCrmImport(record);

	      try {
	        insertDealHunterCrmImportStatement.run(serializedRecord);
	      } catch (error) {
	        if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
	          throw error;
	        }

	        const existingImport = await this.getDealHunterCrmImport({
	          id: record.id,
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
	        listing_identity: values.listing_identity || null,
	        listing_url: values.listing_url || null,
	        submission_id: values.submission_id || null,
	        status: values.status || null,
	        source_name: values.source_name || null,
	        metadata: values.metadata ? JSON.stringify(values.metadata) : null,
	      });

	      return this.getDealHunterCrmImport({ id });
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

    async listDealHunterCimRequests({ dealKeys = [], statuses = [], dueBefore = '', limit = 1000 } = {}) {
      const keys = normalizeList(dealKeys);
      const safeStatuses = normalizeList(statuses);
      const clauses = [];
      const params = [];

      if (keys.length > 0) {
        clauses.push(`deal_key IN (${placeholders(keys.length)})`);
        params.push(...keys);
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
      const safeLimit = Math.max(1, Math.min(limit, 5000));
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

	    async upsertDealHunterCimRequest(request = {}) {
	      upsertDealHunterCimRequestStatement.run(serializeDealHunterCimRequest(request));
	      return this.getDealHunterCimRequest({
	        dealKey: request.deal_key,
	        recipientEmail: request.recipient_email,
	      });
	    },

	    async claimDealHunterCimRequest(request = {}, { pendingCutoff = '' } = {}) {
	      const serializedRequest = serializeDealHunterCimRequest(request);

	      try {
	        insertDealHunterCimRequestStatement.run(serializedRequest);
	      } catch (error) {
	        if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
	          throw error;
	        }

	        const updateResult = claimDealHunterCimRequestStatement.run({
	          ...serializedRequest,
	          pending_cutoff: pendingCutoff || '',
	        });
	        const currentRequest = await this.getDealHunterCimRequest({
	          dealKey: request.deal_key,
	          recipientEmail: request.recipient_email,
	        });

	        return {
	          claimed: updateResult.changes > 0,
	          request: currentRequest,
	        };
	      }

	      return {
	        claimed: true,
	        request: await this.getDealHunterCimRequest({
	          dealKey: request.deal_key,
	          recipientEmail: request.recipient_email,
	        }),
	      };
	    },

	    async claimDealHunterCimFollowUpRequest({ id = '', dueBefore = '', staleBefore = '', nowIso = '' } = {}) {
	      if (!id || !dueBefore || !nowIso) {
	        return { claimed: false, request: null };
	      }

	      const updateResult = claimDealHunterCimFollowUpRequestStatement.run({
	        id,
	        due_before: dueBefore,
	        stale_before: staleBefore || '',
	        now_iso: nowIso,
	      });
	      const row = database.prepare('SELECT * FROM deal_hunter_cim_requests WHERE id = ? LIMIT 1').get(id);

	      return {
	        claimed: updateResult.changes > 0,
	        request: normalizeDealHunterCimRequestRow(row),
	      };
	    },
	  };
	}
