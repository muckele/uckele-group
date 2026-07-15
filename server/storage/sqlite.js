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
    metadata: JSON.stringify(event.metadata || {}),
  };
}

function serializeCrmActivityEvent(event) {
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
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_last_seen_at ON deal_hunter_seen_deals(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_hunter_seen_deals_source_id ON deal_hunter_seen_deals(source_id, last_seen_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_deal_recipient ON deal_hunter_cim_requests(deal_key, recipient_email);
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_cim_requests_deal_key ON deal_hunter_cim_requests(deal_key, updated_at DESC);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_deal_key ON deal_hunter_crm_imports(deal_key);
	    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_listing_identity ON deal_hunter_crm_imports(listing_identity) WHERE listing_identity IS NOT NULL AND listing_identity <> '';
	    CREATE INDEX IF NOT EXISTS idx_deal_hunter_crm_imports_submission_id ON deal_hunter_crm_imports(submission_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_name_updated_at ON scheduled_job_runs(job_name, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created_at ON admin_audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secure_document_cleanup_jobs_status ON secure_document_cleanup_jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_source_health_snapshots_created_at ON source_health_snapshots(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_magic_links_expires_at ON admin_magic_links(expires_at);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_username ON admin_sessions(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
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
    ON CONFLICT(event_key) DO NOTHING
  `);
  const getEmailEventByKeyStatement = database.prepare('SELECT * FROM email_events WHERE event_key = ? LIMIT 1');
  const insertCrmActivityEventStatement = database.prepare(`
    INSERT INTO crm_activity_events (
      id, submission_id, created_at, actor, role, event_type, summary, metadata
    ) VALUES (
      @id, @submission_id, @created_at, @actor, @role, @event_type, @summary, @metadata
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

  const mutateWithCrmActivityTransaction = database.transaction(({ operation, payload, activity }) => {
    let record = null;

    if (operation === 'insert_submission') {
      insertSubmissionStatement.run(serializeSubmission(payload.submission));
      record = payload.submission;
    } else if (operation === 'update_submission') {
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
    } else if (operation === 'upsert_deal_hunter_cim_request') {
      const request = serializeDealHunterCimRequest(payload.request);
      upsertDealHunterCimRequestStatement.run(request);
      record = normalizeDealHunterCimRequestRow(
        database
          .prepare('SELECT * FROM deal_hunter_cim_requests WHERE deal_key = ? AND LOWER(recipient_email) = ? LIMIT 1')
          .get(request.deal_key, request.recipient_email),
      );
    } else {
      throw new Error(`Unsupported atomic CRM activity operation: ${operation || 'unknown'}.`);
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
      return mutateWithCrmActivityTransaction(mutation);
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

    async getSubmissionStrict(id) {
      const row = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(id);
      return row ? normalizeSubmissionRow(row) : null;
    },

    async deleteSubmission(id) {
      const existing = await this.getSubmission(id);

      if (!existing) {
        return null;
      }

      const transaction = database.transaction((submissionId) => {
        database.prepare('DELETE FROM secure_documents WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM secure_upload_requests WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM email_events WHERE submission_id = ?').run(submissionId);
        database.prepare('DELETE FROM crm_activity_events WHERE submission_id = ?').run(submissionId);
        database
          .prepare("UPDATE deal_hunter_crm_imports SET submission_id = NULL, status = 'crm-deleted', updated_at = ? WHERE submission_id = ?")
          .run(new Date().toISOString(), submissionId);
        database.prepare('DELETE FROM contact_submissions WHERE id = ?').run(submissionId);
      });

      transaction(id);

      return existing;
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
      return document;
    },

    async deleteSecureDocument(id) {
      deleteSecureDocumentStatement.run(id);
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
