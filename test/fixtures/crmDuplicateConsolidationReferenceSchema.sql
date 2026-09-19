-- Task 8 fail-closed schema probe. Tests execute this only against disposable
-- databases after the production-shaped schema has been installed.
ALTER TABLE crm_submission_supersessions
  ADD COLUMN future_submission_id TEXT;

CREATE TABLE crm_duplicate_consolidation_unknown_references (
  id TEXT PRIMARY KEY,
  submission_id TEXT,
  opportunity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);
