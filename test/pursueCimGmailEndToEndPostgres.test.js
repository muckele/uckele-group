// Task 11: the Gmail Pursue owner loop end to end on Postgres through the Supabase adapter,
// with only the Gmail mailbox faked (spec 2026-11-03 §11). The same scenarios as the SQLite run
// (test/fixtures/pursueCimEndToEndFixture.js), each on a disposable postgres:16 with the fresh
// schema. The database clock follows the scenario's controlled clock (see
// test/fixtures/postgresServiceRoleClient.js). Gated: DEAL_HUNTER_POSTGRES_INTEGRATION=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-e2e-pg-'));
process.env.ADMIN_SESSION_SECRET = 'pursue-e2e-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'pursue-e2e-document-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'default.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;
process.on('exit', () => fs.rmSync(tempDir, { recursive: true, force: true }));

const { createSupabaseStorage } = await import('../server/storage/supabase.js');
const { createServiceRoleClient, startDisposableSupabasePostgres } =
  await import('./fixtures/postgresServiceRoleClient.js');
const { END_TO_END_SCENARIOS, HEALTHY_SOURCE_SNAPSHOT } = await import('./fixtures/pursueCimEndToEndFixture.js');

fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify(HEALTHY_SOURCE_SNAPSHOT));

const literal = (value) => (value === null || value === undefined ? 'null'
  : `'${String(value).replaceAll("'", "''")}'`);
const bind = (sql, params) => {
  let index = 0;
  return sql.replace(/\?/g, () => literal(params[index++]));
};

/** A fresh Postgres with the Supabase schema; the adapter runs on the service-role stand-in. */
async function createPostgresBackend(t) {
  const database = await startDisposableSupabasePostgres(t, 'ug-pursue-e2e');
  const client = createServiceRoleClient(database.session);
  const storage = createSupabaseStorage({ storage: {} }, { client });
  return {
    storage,
    all: async (sql, ...params) => JSON.parse(await database.superuser(`select coalesce(jsonb_agg(to_jsonb(q)),
      '[]'::jsonb)::text from (${bind(sql, params)}) q;`)),
    run: async (sql, ...params) => { await database.superuser(`${bind(sql, params)};`); },
  };
}

for (const [name, scenario] of END_TO_END_SCENARIOS) {
  test(name, { skip: !integrationEnabled && 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1' },
    (t) => scenario(t, createPostgresBackend));
}
