// Pursued deals tracker Task 1 on Postgres through the Supabase adapter: the same scenarios as the
// SQLite run (test/fixtures/pursuitTrackerScenarios.js), each on a disposable postgres:16 with the
// fresh schema, plus the opportunity lock, the role boundary and the migration mirror.
// Gated: DEAL_HUNTER_POSTGRES_INTEGRATION=1.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const gated = { skip: !integrationEnabled && 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1' };
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursuit-tracker-pg-'));
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

const { createSupabaseStorage } = await import('../server/storage/supabase.js');
const { createServiceRoleClient, dockerCommand, openSession, startDisposableSupabasePostgres } =
  await import('./fixtures/postgresServiceRoleClient.js');
const { HEALTHY_SOURCE_SNAPSHOT, START, autoPursuedAndSent, brokerReplies, createWorld, pacific, pollAt } =
  await import('./fixtures/pursueCimEndToEndFixture.js');
const { PURSUIT_TRACKER_SCENARIOS } = await import('./fixtures/pursuitTrackerScenarios.js');
const { pursuitStageRequestDigest } = await import('../server/storage/pursuitTrackerStorageContract.js');

fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify(HEALTHY_SOURCE_SNAPSHOT));

const migrationPath = path.join(root, 'supabase/migrations/20261105120000_pursuing_tracker.sql');
// The schema as it stood before the Pursued deals tracker.
const schemaBeforeTracker = '0fd9bfd68cf288501e140e40129dec66eaa772df';
const OWNER = 'owner@uckele.test';

const literal = (value) => (value === null || value === undefined ? 'null'
  : `'${String(value).replaceAll("'", "''")}'`);
const bind = (sql, params) => {
  let index = 0;
  return sql.replace(/\?/g, () => literal(params[index++]));
};

function migrationFunctionNames(sql) {
  return [...new Set([...sql.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)]
    .map((match) => match[1]))].sort();
}

/** A fresh Postgres with the Supabase schema; the adapter runs on the service-role stand-in. */
async function createPostgresBackend(t) {
  const database = await startDisposableSupabasePostgres(t, 'ug-pursuit-tracker');
  const client = createServiceRoleClient(database.session);
  const storage = createSupabaseStorage({ storage: {} }, { client });
  return {
    storage,
    database,
    all: async (sql, ...params) => JSON.parse(await database.superuser(`select coalesce(jsonb_agg(to_jsonb(q)),
      '[]'::jsonb)::text from (${bind(sql, params)}) q;`)),
    run: async (sql, ...params) => { await database.superuser(`${bind(sql, params)};`); },
  };
}

function command(overrides) {
  const base = { id: randomUUID(), idempotencyKey: randomUUID(), opportunityId: 'opp-auto',
    expectedPreviousEventId: null, kind: 'stage-move', replyType: null, fromStage: 'cim-requested',
    stage: 'cim-requested', acknowledgedReplyId: null, actor: OWNER, now: new Date().toISOString(),
    secureDocumentId: null, ...overrides };
  return { ...base, requestDigest: pursuitStageRequestDigest(base) };
}

for (const [name, scenario] of PURSUIT_TRACKER_SCENARIOS) {
  test(name, gated, (t) => scenario(t, createPostgresBackend));
}

test('an acknowledge waits for a locked stage-move and both commit', { ...gated, timeout: 180_000 }, async (t) => {
  let backend;
  const world = await createWorld(t, async (context) => {
    backend = await createPostgresBackend(context);
    return backend;
  }, { start: START });
  const campaign = await autoPursuedAndSent(world, { opportunityId: 'opp-auto' });
  world.clock.set(pacific('2030-01-07', '14:00'));
  await brokerReplies(world, campaign, { body: 'Sure, NDA attached.' });
  assert.equal((await pollAt(world, pacific('2030-01-07', '14:05'))).responded, 1);
  const { gmail_message_id: replyId } = await world.one(`SELECT gmail_message_id
    FROM deal_hunter_gmail_reply_messages WHERE conversation_id = ? AND classification = 'reply'`,
  campaign.conversation_id);

  // Session A holds the opportunity lock: its stage-move is written but not committed.
  const sessionA = openSession(backend.database.container, backend.database.database);
  const stageMove = command({ stage: 'nda-sent', expectedPreviousEventId: 'genesis' });
  let held;
  let acknowledged;
  try {
    held = JSON.parse(await sessionA.query(`set role service_role; begin;
      select public.pursuit_tracker_record_event_v1($json$${JSON.stringify(stageMove)}$json$::jsonb)::text;`));
    assert.equal(held.applied, true);

    let settled = false;
    const acknowledge = world.storage.recordPursuitStageEvent(command({ kind: 'acknowledge',
      acknowledgedReplyId: replyId, expectedPreviousEventId: null })).finally(() => { settled = true; });
    await sessionA.query('select pg_sleep(1);');
    assert.equal(settled, false, 'the acknowledge waits on the opportunity lock');
    await sessionA.query('commit;');
    acknowledged = await acknowledge;
  } finally {
    // Closed here, not in an after hook, so psql quits before the container is removed.
    await sessionA.close();
  }

  assert.deepEqual([acknowledged.applied, acknowledged.conflict, acknowledged.event.previousEventId],
    [true, null, held.event.id]);
  assert.equal((await world.storage.getPursuitStageEventByIdempotencyKey(stageMove.idempotencyKey)).id,
    held.event.id);
  assert.equal(await world.count('deal_hunter_pursuit_stage_events'), 2);
});

test('anon and authenticated cannot read the table or execute the RPC', { ...gated, timeout: 120_000 },
  async (t) => {
    const database = await startDisposableSupabasePostgres(t, 'ug-pursuit-tracker-roles');
    const query = (sql) => database.session.query(`reset role; ${sql}`);
    assert.equal(await query(`select relrowsecurity from pg_class
      where oid = 'public.deal_hunter_pursuit_stage_events'::regclass;`), 't');
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(query(`set role ${role}; select * from public.deal_hunter_pursuit_stage_events;`),
        /permission denied/);
      await assert.rejects(query(`set role ${role};
        select public.pursuit_tracker_record_event_v1('{}'::jsonb);`), /permission denied/);
    }
    // service_role reads the table and writes it only through the RPC.
    assert.equal(await query('set role service_role; select count(*) from public.deal_hunter_pursuit_stage_events;'),
      '0');
    for (const statement of ['delete from public.deal_hunter_pursuit_stage_events',
      'update public.deal_hunter_pursuit_stage_events set actor = actor',
      `insert into public.deal_hunter_pursuit_stage_events (id) values ('x')`]) {
      await assert.rejects(query(`set role service_role; ${statement};`), /permission denied/);
    }
    await assert.rejects(query(`set role service_role;
      select public.pursuit_tracker_record_event_v1('{}'::jsonb);`), /Invalid pursuit stage event/);
  });

test('the tracker migration is mirrored exactly at the end of the fresh schema', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const start = schema.indexOf(migration);
  assert.ok(start >= 0, 'the fresh schema must contain the exact tracker block');
  assert.equal(schema.slice(start + migration.length).trim(), '', 'the tracker block is the end of the schema');
  assert.deepEqual(migrationFunctionNames(migration), ['pursuit_tracker_record_event_v1',
    'pursuit_tracker_reject_event_mutation_v1']);
  assert.match(migration, /alter table public\.deal_hunter_pursuit_stage_events enable row level security;/);
  assert.match(migration, /revoke all on table public\.deal_hunter_pursuit_stage_events\s+from public, anon, authenticated, service_role;/);
  assert.match(migration, /grant select on table public\.deal_hunter_pursuit_stage_events to service_role;/);
  assert.doesNotMatch(migration, /create\s+policy|to (anon|authenticated)\b/i);
  const rpc = migration.slice(migration.indexOf('create or replace function public.pursuit_tracker_record_event_v1('));
  assert.match(rpc, /^create or replace function public\.pursuit_tracker_record_event_v1\(p_command jsonb\)/);
  assert.match(rpc, /security definer\s+set search_path = public/);
  assert.match(rpc, /grant execute on function public\.pursuit_tracker_record_event_v1\(jsonb\) to service_role;/);
});

test('migration and schema.sql define identical functions', { ...gated, timeout: 180_000 }, async (t) => {
  const database = await startDisposableSupabasePostgres(t, 'ug-pursuit-tracker-mirror');
  const psql = (target, sql) => {
    const result = spawnSync(dockerCommand, ['exec', '-i', database.container, 'psql', '-X', '-qAt', '-v',
      'ON_ERROR_STOP=1', '-U', 'postgres', '-d', target], { input: sql, encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const migration = fs.readFileSync(migrationPath, 'utf8');
  psql('postgres', 'create database tracker_upgrade;');
  psql('tracker_upgrade', execFileSync('git', ['show', `${schemaBeforeTracker}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  psql('tracker_upgrade', migration);
  psql('tracker_upgrade', migration); // forward-only and re-runnable

  const names = migrationFunctionNames(migration);
  const definitions = (target) => JSON.parse(psql(target, `
    select jsonb_object_agg(p.proname, jsonb_build_object('definition', pg_get_functiondef(p.oid),
      'acl', coalesce(p.proacl::text, '')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(array[${names.map((name) => `'${name}'`).join(',')}]);`));
  const fresh = definitions(database.database);
  assert.deepEqual(Object.keys(fresh).sort(), names);
  assert.deepEqual(definitions('tracker_upgrade'), fresh);
  const shape = (target) => psql(target, `
    select concat_ws(E'\\n',
      (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'deal_hunter_pursuit_stage_events'),
      (select string_agg(conname || ':' || pg_get_constraintdef(oid), E'\\n' order by conname)
        from pg_constraint where conrelid = 'public.deal_hunter_pursuit_stage_events'::regclass),
      (select string_agg(indexdef, E'\\n' order by indexname) from pg_indexes
        where schemaname = 'public' and tablename = 'deal_hunter_pursuit_stage_events'),
      (select string_agg(tgname || ':' || pg_get_triggerdef(oid), E'\\n' order by tgname) from pg_trigger
        where tgrelid = 'public.deal_hunter_pursuit_stage_events'::regclass and not tgisinternal),
      (select relacl::text || ':' || relrowsecurity::text from pg_class
        where oid = 'public.deal_hunter_pursuit_stage_events'::regclass));`);
  assert.equal(shape('tracker_upgrade'), shape(database.database));
  assert.match(shape(database.database), /UNIQUE \(opportunity_id, previous_event_id\)/);
});
