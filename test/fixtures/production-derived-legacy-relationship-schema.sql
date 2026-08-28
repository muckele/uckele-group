-- Sanitized schema-only overlay derived from the production SQLite shape.
--
-- Tests apply this overlay to the repository-created current schema. Together,
-- those schemas represent the relationship-bearing production shape without
-- copying any production rows, identifiers, URLs, contacts, credentials, or
-- backup metadata.

CREATE TABLE admin_magic_links_legacy_v1 (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE deal_hunter_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  subject TEXT,
  raw_text TEXT,
  criteria_snapshot TEXT NOT NULL,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  watch_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  recommendation_count INTEGER NOT NULL DEFAULT 0,
  digest_status TEXT NOT NULL,
  digest_error TEXT,
  recommendations TEXT NOT NULL DEFAULT '[]',
  requested_by TEXT
);

CREATE TABLE deal_hunter_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  industry TEXT,
  description TEXT,
  asking_price INTEGER,
  annual_profit INTEGER,
  annual_revenue INTEGER,
  years_in_business INTEGER,
  source_url TEXT,
  broker TEXT,
  raw_text TEXT,
  score INTEGER NOT NULL,
  recession_score INTEGER NOT NULL,
  ai_resistance_score INTEGER NOT NULL,
  criteria_score INTEGER NOT NULL,
  status TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  matched_keywords TEXT NOT NULL DEFAULT '[]',
  excluded_reasons TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_deal_hunter_runs_created_at
  ON deal_hunter_runs(created_at DESC);
CREATE INDEX idx_deal_hunter_candidates_run_id
  ON deal_hunter_candidates(run_id, score DESC);
CREATE INDEX idx_deal_hunter_candidates_status
  ON deal_hunter_candidates(status, score DESC);

CREATE TABLE prospect_discovery_runs (
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

CREATE TABLE prospect_discoveries (
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
