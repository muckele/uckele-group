// The owner's Gmail signature snapshot on PostgreSQL: the migration mirrors the fresh schema,
// and the Supabase adapter behaves like the SQLite one (test/gmailSendStorage.test.js). The
// PostgreSQL part runs only with DEAL_HUNTER_POSTGRES_INTEGRATION=1 and a local postgres:16 image.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSupabaseStorage } from '../server/storage/supabase.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
// The schema as it stood before the Gmail signature work began.
const schemaBeforeSignature = 'b26b69a';
const migrationPath = path.join(root, 'supabase/migrations/20261113120000_pursue_gmail_signature.sql');
const table = 'deal_hunter_gmail_signatures';
const at = '2026-11-13T15:00:00.000Z';
const later = '2026-11-13T16:00:00.000Z';

const hex = (value) => createHash('sha256').update(String(value)).digest('hex');

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], sql).trim();
}

/** A Supabase client stand-in that runs the adapter's RPCs and reads as service_role. */
function serviceRoleClient(container, database) {
  const sql = (statement) => psql(container, database, `set role service_role; ${statement}`);
  const literal = (value) => `$json$${JSON.stringify(value)}$json$::jsonb`;
  return {
    async rpc(name, args) {
      try {
        const output = sql(`select coalesce(to_jsonb(public.${name}(${literal(args.p_command)}))::text, 'null');`);
        return { data: JSON.parse(output), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from(name) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(column, value) {
          filters.push(`t.${column} = '${String(value).replaceAll("'", "''")}'`);
          return builder;
        },
        async maybeSingle() {
          const where = filters.length ? `where ${filters.join(' and ')}` : '';
          const rows = JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text
            from public.${name} t ${where};`));
          return rows.length > 1 ? { data: null, error: new Error('multiple rows') } : { data: rows[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

test('the Gmail signature migration is mirrored exactly at the end of the fresh schema', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8').trim();
  const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
  const start = schema.indexOf(migration);
  assert.ok(start >= 0, 'the fresh schema must contain the exact Gmail signature block');
  assert.equal(schema.slice(start + migration.length).trim(), '', 'the block is the end of the schema');
  assert.deepEqual([...migration.matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)].map((m) => m[1]),
    ['deal_hunter_gmail_record_signature_refresh_v1']);
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`));
  assert.match(migration, new RegExp(`revoke all on table public\\.${table}\\s+from public, anon, authenticated, service_role;`));
  assert.match(migration, new RegExp(`grant select on table public\\.${table} to service_role;`));
  assert.match(migration, /security definer\s+set search_path = ''/);
  assert.match(migration, /revoke all on function public\.deal_hunter_gmail_record_signature_refresh_v1\(jsonb\)\s+from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.deal_hunter_gmail_record_signature_refresh_v1\(jsonb\) to service_role;/);
  assert.doesNotMatch(migration, /create\s+policy|to (anon|authenticated)\b/i);
});

test('PostgreSQL Gmail signature snapshot on fresh and upgraded schemas, like SQLite', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 180_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-gmail-signature-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, ['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  started = true;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`.match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }
  psql(container, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls; -- as in Supabase
    create database signature_fresh;
    create database signature_upgrade;
  `);
  const migration = fs.readFileSync(migrationPath, 'utf8');
  psql(container, 'signature_fresh', fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  psql(container, 'signature_upgrade', execFileSync('git', ['show', `${schemaBeforeSignature}:supabase/schema.sql`],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  psql(container, 'signature_upgrade', migration);
  psql(container, 'signature_upgrade', migration); // forward-only and re-runnable

  const shape = (database) => psql(container, database, `
    select (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name)
      from information_schema.columns where table_schema = 'public' and table_name = '${table}')
      || E'\\n' || (select string_agg(pg_get_constraintdef(oid), E'\\n' order by pg_get_constraintdef(oid))
      from pg_constraint where conrelid = 'public.${table}'::regclass)
      || E'\\n' || (select pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'deal_hunter_gmail_record_signature_refresh_v1');`);
  assert.equal(shape('signature_upgrade'), shape('signature_fresh'));

  for (const database of ['signature_fresh', 'signature_upgrade']) {
    assert.equal(psql(container, database, `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass;`), 't');
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => psql(container, database, `set role ${role}; select * from public.${table};`), /permission denied/);
    }
    assert.throws(() => psql(container, database, `set role service_role; delete from public.${table};`), /permission denied/);

    const storage = createSupabaseStorage({ storage: {} }, { client: serviceRoleClient(container, database) });
    assert.equal(await storage.getGmailSignature(), null);
    const failedFirst = await storage.recordGmailSignatureRefresh({ ok: false, errorCode: 'gmail_timeout', now: at });
    assert.deepEqual(failedFirst, { loaded: false, sendAsEmail: null, html: null, text: null, digest: null,
      fetchedAt: null, lastAttemptAt: at, lastErrorCode: 'gmail_timeout' });
    const snapshot = { sendAsEmail: 'owner@uckele.test', html: '<b>Pat Example</b>', text: 'Pat Example',
      digest: hex('<b>Pat Example</b>') };
    const stored = await storage.recordGmailSignatureRefresh({ ok: true, ...snapshot, now: at });
    assert.deepEqual(stored, { loaded: true, ...snapshot, fetchedAt: at, lastAttemptAt: at, lastErrorCode: null });
    const kept = await storage.recordGmailSignatureRefresh({ ok: false, errorCode: 'gmail_503', now: later });
    assert.deepEqual(kept, { ...stored, lastAttemptAt: later, lastErrorCode: 'gmail_503' });
    assert.deepEqual(await storage.getGmailSignature(), kept);
    const empty = await storage.recordGmailSignatureRefresh({ ok: true, sendAsEmail: 'owner@uckele.test',
      html: '', text: '', digest: hex(''), errorCode: 'gmail_signature_too_large', now: later });
    assert.equal(empty.html, '');
    assert.equal(empty.lastErrorCode, 'gmail_signature_too_large');
    assert.equal(psql(container, database, `select count(*) from public.${table};`), '1');
    assert.throws(() => psql(container, database, `set role service_role;
      select public.deal_hunter_gmail_record_signature_refresh_v1('{"ok":false,"now":"${at}"}'::jsonb);`),
    /Invalid Gmail signature refresh/);
  }
});
