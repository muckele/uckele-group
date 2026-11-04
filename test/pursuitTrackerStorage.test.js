// Pursued deals tracker Task 1: the owner event table and its stage-event writes on real SQLite.
// The scenarios live in test/fixtures/pursuitTrackerScenarios.js and also run on gated Postgres
// (test/pursuitTrackerStoragePostgres.test.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursuit-tracker-'));
process.env.ADMIN_SESSION_SECRET = 'pursuit-tracker-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'pursuit-tracker-document-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'default.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { HEALTHY_SOURCE_SNAPSHOT } = await import('./fixtures/pursueCimEndToEndFixture.js');
const { PURSUIT_TRACKER_SCENARIOS } = await import('./fixtures/pursuitTrackerScenarios.js');

fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify(HEALTHY_SOURCE_SNAPSHOT));

/** A fresh SQLite store, with `?`-placeholder reads and writes on its own connection. */
function createSqliteBackend(t) {
  const directory = fs.mkdtempSync(path.join(tempDir, 'world-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  return {
    storage,
    all: async (sql, ...params) => database.prepare(sql).all(...params),
    run: async (sql, ...params) => { database.prepare(sql).run(...params); },
  };
}

for (const [name, scenario] of PURSUIT_TRACKER_SCENARIOS) {
  test(name, (t) => scenario(t, createSqliteBackend));
}
