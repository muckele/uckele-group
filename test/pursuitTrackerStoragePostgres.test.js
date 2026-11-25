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
const { PURSUIT_TRACKER_SCENARIOS, simIntake } = await import('./fixtures/pursuitTrackerScenarios.js');
const { PURSUIT_CIM_DOCUMENT_TYPES, pursuitStageRequestDigest } =
  await import('../server/storage/pursuitTrackerStorageContract.js');

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

test('a SIM intake and a concurrent CIM convergence on the same campaign both commit without a deadlock',
  { ...gated, timeout: 180_000 }, async (t) => {
    let backend;
    const world = await createWorld(t, async (context) => {
      backend = await createPostgresBackend(context);
      return backend;
    }, { start: START });
    const campaign = await autoPursuedAndSent(world, { opportunityId: 'opp-auto' });
    assert.equal(campaign.state, 'active-follow-up');
    world.clock.set(pacific('2030-01-07', '10:00'));

    // Session A is a CIM-path transaction. Its first CIM RPC (a convergence that matches no
    // campaign) takes the CIM advisory lock, held until A commits, without touching this deal.
    const sessionA = openSession(backend.database.container, backend.database.database);
    const at = world.clock.peek().toISOString();
    let result;
    try {
      const first = JSON.parse(await sessionA.query(`set role service_role; begin;
        select public.pursue_cim_converge_terminal_authority_v1(jsonb_build_object(
          'opportunityId', 'opp-unrelated', 'reasonCode', 'stopped_by_owner', 'evidenceType', 'tracker-test',
          'evidenceId', 'tracker-lock-order', 'actor', 'tracker-test', 'source', 'tracker-test',
          'observedAt', '${at}', 'now', '${at}'))::text;`));
      assert.deepEqual(first.outcomes, []);

      let settled = false;
      const intake = world.storage.recordPursuitSimIntake(simIntake(world,
        { submissionId: campaign.crm_submission_id })).finally(() => { settled = true; });
      await sessionA.query('select pg_sleep(1);');
      assert.equal(settled, false, 'the intake waits on the CIM advisory lock');
      // A then writes on the same campaign: a CRM diligence change that the terminal trigger
      // converges, locking the deal's opportunity row after the advisory lock. An intake that took
      // the row first and the advisory lock second would deadlock here.
      await sessionA.query(`update public.contact_submissions
        set metadata = metadata || '{"diligence": {"stage": "cim-received"}}'::jsonb
        where id = '${campaign.crm_submission_id}';`);
      assert.equal(await sessionA.query(`select state from public.deal_hunter_cim_campaigns
        where id = '${campaign.id}';`), 'materials-received');
      await sessionA.query('commit;');
      result = await intake;
    } finally {
      await sessionA.close();
    }

    assert.deepEqual([result.applied, result.conflict, result.event.kind], [true, null, 'sim-intake']);
    assert.equal((await world.campaignFor('opp-auto')).state, 'materials-received');
    // A converged the campaign; the intake's document found it already terminal.
    assert.deepEqual((await world.all(`SELECT reason_code, evidence_type FROM deal_hunter_cim_terminal_events
      WHERE campaign_id = ? AND reason_code = 'materials_received'`, campaign.id)).map((row) => ({ ...row })),
    [{ reason_code: 'materials_received', evidence_type: 'diligence' }]);
    assert.equal(await world.count('secure_documents', 'id = ?', result.document.id), 1);
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
      await assert.rejects(query(`set role ${role};
        select public.pursuit_tracker_list_v1('{}'::jsonb);`), /permission denied/);
      await assert.rejects(query(`set role ${role};
        select public.pursuit_tracker_record_sim_intake_v1('{}'::jsonb);`), /permission denied/);
    }
    // The writers' shared helpers are not callable on their own, not even by service_role.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const helper of ['pursuit_tracker_event_command_valid_v1(\'{}\'::jsonb)',
        'pursuit_tracker_event_preflight_v1(\'{}\'::jsonb)',
        'pursuit_tracker_append_event_v1(\'{}\'::jsonb, \'{}\'::jsonb)']) {
        await assert.rejects(query(`set role ${role}; select public.${helper};`), /permission denied/);
      }
    }
    await assert.rejects(query(`set role service_role;
      select public.pursuit_tracker_record_sim_intake_v1('{}'::jsonb);`), /Invalid pursuit SIM intake/);
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
    assert.equal(await query(`set role service_role; select public.pursuit_tracker_list_v1('{}'::jsonb);`), '[]');
    for (const bad of [`'[]'`, `'{"opportunityIds":"x"}'`, `'{"opportunityIds":[1]}'`, `'{"opportunityIds":["a b"]}'`,
      `jsonb_build_object('opportunityIds', (select jsonb_agg('o' || n) from generate_series(1, 201) n))`]) {
      await assert.rejects(query(`set role service_role; select public.pursuit_tracker_list_v1(${bad}::jsonb);`),
        /Invalid pursuit bundle list/);
    }
  });

test('the tracker migration is mirrored exactly at the end of the fresh schema', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const start = schema.indexOf(migration);
  assert.ok(start >= 0, 'the fresh schema must contain the exact tracker block');
  // Only later migrations' blocks follow it.
  const later = fs.readFileSync(path.join(root, 'supabase/migrations/20261113120000_pursue_gmail_signature.sql'),
    'utf8').trim();
  assert.equal(schema.slice(start + migration.length).trim(), later,
    'the tracker block is followed only by the Gmail signature block');
  assert.deepEqual(migrationFunctionNames(migration), ['pursuit_tracker_append_event_v1',
    'pursuit_tracker_event_command_valid_v1', 'pursuit_tracker_event_preflight_v1', 'pursuit_tracker_list_v1',
    'pursuit_tracker_record_event_v1', 'pursuit_tracker_record_sim_intake_v1',
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

test('the SIM intake RPC takes the CIM advisory lock before the opportunity row and is service_role only', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const start = migration.indexOf('create or replace function public.pursuit_tracker_record_sim_intake_v1(');
  const rpc = migration.slice(start, migration.indexOf('\n$$;', start));
  assert.match(rpc, /^create or replace function public\.pursuit_tracker_record_sim_intake_v1\(p_command jsonb\)\s+returns jsonb\s+language plpgsql\s+security definer\s+set search_path = public/);
  const advisory = rpc.indexOf('pg_catalog.pg_advisory_xact_lock(17499,48146)');
  const rowLock = rpc.search(/from public\.deal_hunter_opportunities where [^;]* for update;/);
  assert.ok(advisory > 0 && rowLock > advisory, 'advisory lock first, then the opportunity row');
  assert.ok(rpc.indexOf('insert into') > rowLock, 'both locks before any write');
  assert.match(migration, /revoke all on function public\.pursuit_tracker_record_sim_intake_v1\(jsonb\)\s+from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.pursuit_tracker_record_sim_intake_v1\(jsonb\) to service_role;/);
  assert.doesNotMatch(migration, /create (constraint )?trigger[^;]*(secure_documents|secure_upload_requests|crm_activity_events)/i,
    'the existing triggers converge; the tracker adds none');
});

test('the list RPC is stable, security definer, service_role only and spells the CIM document types', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const rpc = migration.slice(migration.indexOf('create or replace function public.pursuit_tracker_list_v1('));
  assert.match(rpc, /^create or replace function public\.pursuit_tracker_list_v1\(p_command jsonb\)\s+returns jsonb\s+language plpgsql\s+stable\s+security definer\s+set search_path = public/);
  assert.doesNotMatch(rpc, /security invoker/i);
  assert.match(rpc, /revoke all on function public\.pursuit_tracker_list_v1\(jsonb\)\s+from public, anon, authenticated;/);
  assert.match(rpc, /grant execute on function public\.pursuit_tracker_list_v1\(jsonb\) to service_role;/);
  assert.doesNotMatch(rpc, /primary_submission_id/);
  assert.match(rpc, new RegExp(`doc\\.document_type in \\(${PURSUIT_CIM_DOCUMENT_TYPES.map((type) => `'${type}'`)
    .join(',\\s*')}\\)`));
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
