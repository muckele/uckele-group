// A disposable postgres:16 with the fresh Supabase schema, and a Supabase client stand-in that
// runs the storage adapter's PostgREST queries and RPCs against it as service_role through one
// long-lived psql session. Used by gated Postgres tests that drive whole service paths (not
// single RPCs) through `createSupabaseStorage`.
//
// The database clock is controllable: `pg_catalog.clock_timestamp()` reads the session setting
// `ug.test_now` when it is set, so RPCs that stamp or compare with the database clock see the
// test's controlled clock. Every statement sets it from `now()` (the caller's clock) first.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/** One psql session; `query(sql)` runs statements in order and returns stdout, or throws. */
export function openSession(container, database) {
  const child = spawn(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=0',
    '-U', 'postgres', '-d', database], { cwd: root });
  let stdout = '';
  let stderr = '';
  let waiting = null;
  let sequence = 0;
  let chain = Promise.resolve();
  const settle = () => {
    if (!waiting) return;
    const out = stdout.indexOf(waiting.marker);
    const err = stderr.indexOf(waiting.marker);
    if (out < 0 || err < 0) return;
    const output = stdout.slice(0, out);
    const errors = stderr.slice(0, err);
    stdout = stdout.slice(out + waiting.marker.length).replace(/^\n/, '');
    stderr = stderr.slice(err + waiting.marker.length).replace(/^\n/, '');
    const { resolve } = waiting;
    waiting = null;
    resolve({ output, errors });
  };
  let exited = null;
  child.on('exit', (code) => {
    exited = `ERROR:  psql exited with code ${code}`;
    if (waiting) {
      const { resolve } = waiting;
      waiting = null;
      resolve({ output: '', errors: exited });
    }
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; settle(); });
  child.stderr.on('data', (chunk) => { stderr += chunk; settle(); });
  child.stdin.write('\\set VERBOSITY verbose\n');
  const query = (sql) => {
    const result = chain.then(() => new Promise((resolve) => {
      if (exited) {
        resolve({ output: '', errors: exited });
        return;
      }
      sequence += 1;
      const marker = `__ug_done_${sequence}__`;
      waiting = { marker, resolve };
      child.stdin.write(`${sql}\n\\echo ${marker}\n\\warn ${marker}\n`);
    })).then(({ output, errors }) => {
      const failure = errors.split('\n').find((line) => line.startsWith('ERROR:'));
      if (failure) {
        const match = /^ERROR:\s+([0-9A-Z]{5}): (.*)$/.exec(failure);
        const error = new Error(match ? match[2] : failure.replace(/^ERROR:\s+/, ''));
        error.code = match ? match[1] : 'XX000';
        throw error;
      }
      return output.replace(/\n$/, '');
    });
    chain = result.catch(() => {});
    return result;
  };
  const close = () => new Promise((resolve) => {
    if (exited) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.stdin.end('\\q\n');
  });
  return { query, close };
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function identifier(name) {
  if (!IDENTIFIER.test(name)) throw new Error(`unsupported identifier ${name}`);
  return name;
}

function dollar(text) {
  const tag = `q${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  return `$${tag}$${text}$${tag}$`;
}

function literal(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return `${dollar(JSON.stringify(value))}::jsonb`;
  return dollar(String(value));
}

/** PostgREST column expressions: `col`, `alias:col->>key`, `alias:col->key`. */
function columnExpression(token) {
  const [alias, expression] = token.includes(':') ? token.split(':') : [null, token];
  const json = /^([a-z_][a-z0-9_]*)(->>?)([a-zA-Z0-9_]+)$/.exec(expression.trim());
  if (json) {
    return [alias || json[3], `t.${identifier(json[1])}${json[2]}${dollar(json[3])}`];
  }
  return [alias || expression.trim(), `t.${identifier(expression.trim())}`];
}

function parseSelect(columns) {
  const tokens = [];
  let depth = 0;
  let current = '';
  for (const character of String(columns ?? '*')) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      tokens.push(current.trim());
      current = '';
    } else current += character;
  }
  if (current.trim()) tokens.push(current.trim());
  const plain = [];
  const embeds = [];
  for (const token of tokens) {
    const embed = /^([a-z_][a-z0-9_]*)!inner\(([^)]*)\)$/.exec(token);
    if (embed) embeds.push({ table: embed[1], columns: embed[2].split(',').map((item) => item.trim()) });
    else plain.push(token);
  }
  return { plain, embeds };
}

/** A PostgREST operator condition (`eq`, `in`, `is`, ...) on `column` as SQL. */
function condition(column, operator, value) {
  const negate = operator.startsWith('not.');
  const op = negate ? operator.slice(4) : operator;
  let sql;
  const target = column.includes('.') ? column.split('.').map(identifier).join('.') : `t.${identifier(column)}`;
  switch (op) {
    case 'eq': sql = `${target} = ${literal(value)}`; break;
    case 'neq': sql = `${target} <> ${literal(value)}`; break;
    case 'gt': sql = `${target} > ${literal(value)}`; break;
    case 'gte': sql = `${target} >= ${literal(value)}`; break;
    case 'lt': sql = `${target} < ${literal(value)}`; break;
    case 'lte': sql = `${target} <= ${literal(value)}`; break;
    case 'like': sql = `${target}::text like ${literal(String(value).replace(/\*/g, '%'))}`; break;
    case 'ilike': sql = `${target}::text ilike ${literal(String(value).replace(/^"|"$/g, '').replace(/\*/g, '%'))}`; break;
    case 'is': {
      const normalized = value === null ? 'null' : String(value).toLowerCase();
      if (!['null', 'true', 'false'].includes(normalized)) throw new Error(`unsupported is ${value}`);
      sql = `${target} is ${normalized}`;
      break;
    }
    case 'in': {
      const items = Array.isArray(value) ? value
        : String(value).replace(/^\(|\)$/g, '').split(',').map((item) => item.trim().replace(/^"|"$/g, ''))
          .filter((item) => item !== '');
      sql = items.length ? `${target} in (${items.map(literal).join(', ')})` : 'false';
      break;
    }
    default: throw new Error(`unsupported operator ${operator}`);
  }
  return negate ? `not (${sql})` : sql;
}

/** `a.eq.1,b.not.is.null,c.in.(x,y)` as an OR of conditions. */
function orConditions(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  if (current) parts.push(current);
  return `(${parts.map((part) => {
    const match = /^([a-z_][a-z0-9_]*)\.((?:not\.)?[a-z]+)\.(.*)$/.exec(part.trim());
    if (!match) throw new Error(`unsupported or condition ${part}`);
    return condition(match[1], match[2], match[3]);
  }).join(' or ')})`;
}

export function createServiceRoleClient(session, { now = () => new Date().toISOString(), log } = {}) {
  const procedures = new Map();
  const primaryKeys = new Map();
  const statement = async (sql) => {
    const instant = now();
    log?.(sql);
    return session.query(`reset role; set ug.test_now = ${dollar(instant)}; set role service_role;\n${sql}`);
  };
  const json = async (sql) => {
    const output = await statement(sql);
    return output === '' ? null : JSON.parse(output);
  };
  async function procedure(name) {
    if (!procedures.has(name)) {
      const output = await session.query(`select coalesce(jsonb_agg(jsonb_build_object('args',
        coalesce(p.proargnames, '{}'::text[]), 'types', (select coalesce(jsonb_agg(pg_catalog.format_type(x, null)
          order by ordinality), '[]'::jsonb) from unnest(p.proargtypes::oid[]) with ordinality as a(x, ordinality)),
        'set', p.proretset, 'returns', pg_catalog.format_type(p.prorettype, null))), '[]'::jsonb)::text
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = ${literal(name)};`);
      procedures.set(name, JSON.parse(output));
    }
    return procedures.get(name);
  }
  async function primaryKey(table) {
    if (!primaryKeys.has(table)) {
      const output = await session.query(`select coalesce(string_agg(a.attname, ',' order by k.ordinality), '')
        from pg_catalog.pg_index i cross join unnest(i.indkey) with ordinality as k(attnum, ordinality)
        join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where i.indrelid = ${literal(`public.${table}`)}::regclass and i.indisprimary;`);
      primaryKeys.set(table, output.trim());
    }
    return primaryKeys.get(table);
  }

  async function rpc(name, args = {}) {
    try {
      const overloads = await procedure(identifier(name));
      const keys = Object.keys(args ?? {});
      const chosen = overloads.find((item) => keys.every((key) => item.args.includes(key))
        && item.args.slice(0, item.types.length).filter((arg) => !keys.includes(arg)).length === 0)
        ?? overloads[0];
      if (!chosen) throw new Error(`function public.${name} does not exist`);
      const call = `public.${name}(${keys.map((key) => {
        const type = chosen.types[chosen.args.indexOf(key)] || 'text';
        const value = args[key];
        let text;
        if (value === null || value === undefined) text = 'null';
        else if (Array.isArray(value) && type.endsWith('[]')) {
          text = `array[${value.map((item) => dollar(String(item))).join(', ')}]`;
        } else text = dollar(typeof value === 'object' ? JSON.stringify(value) : String(value));
        return `${identifier(key)} => ${text}::${type}`;
      }).join(', ')})`;
      if (chosen.returns === 'void') {
        await statement(`select ${call};`);
        return { data: null, error: null };
      }
      const data = chosen.set
        ? await json(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)::text from ${call} r;`)
        : await json(`select coalesce(to_jsonb(${call})::text, 'null');`);
      // A function returning a single scalar column set comes back as rows of { fn: value }.
      if (chosen.set && Array.isArray(data) && data.length && Object.keys(data[0]).length === 1
        && Object.hasOwn(data[0], name)) {
        return { data: data.map((row) => row[name]), error: null };
      }
      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  function from(table) {
    identifier(table);
    const where = [];
    const orders = [];
    let mode = 'select';
    let payload = null;
    let upsertOptions = {};
    let returning = false;
    let columns = '*';
    let countMode = null;
    let head = false;
    let limit = null;
    let offset = null;
    let single = '';

    const projection = (alias) => {
      const { plain, embeds } = parseSelect(columns);
      const parts = [];
      for (const token of plain) {
        if (token === '*') parts.push(`to_jsonb(${alias})`);
        else {
          const [name, expression] = columnExpression(token);
          parts.push(`jsonb_build_object(${dollar(name)}, ${expression.replace(/^t\./, `${alias}.`)})`);
        }
      }
      for (const embed of embeds) {
        parts.push(`jsonb_build_object(${dollar(embed.table)}, jsonb_build_object(${embed.columns
          .map((column) => `${dollar(column)}, ${embed.table}.${identifier(column)}`).join(', ')}))`);
      }
      return { sql: parts.length ? parts.join(' || ') : `to_jsonb(${alias})`, embeds };
    };
    const joins = (embeds) => embeds.map((embed) => ` join public.${identifier(embed.table)} ${embed.table}
      on ${embed.table}.opportunity_id = t.opportunity_id`).join('');

    async function execute() {
      const filter = where.length ? `where ${where.join(' and ')}` : '';
      if (mode === 'select') {
        const { sql, embeds } = projection('t');
        const order = orders.length ? `order by ${orders.join(', ')}` : '';
        const window = `${limit === null ? '' : `limit ${limit}`} ${offset === null ? '' : `offset ${offset}`}`;
        let count = null;
        if (countMode) {
          count = Number(await statement(`select count(*) from public.${table} t${joins(embeds)} ${filter};`));
        }
        if (head) return { data: null, error: null, count };
        const rows = await json(`select coalesce(jsonb_agg(q.row order by q.ord), '[]'::jsonb)::text from (
          select ${sql} as row, row_number() over (${order}) as ord from public.${table} t${joins(embeds)}
          ${filter} ${order} ${window}) q;`);
        return { data: rows, error: null, count };
      }
      const rows = Array.isArray(payload) ? payload : [payload];
      let sql;
      if (mode === 'insert' || mode === 'upsert') {
        if (rows.length === 0) return { data: [], error: null };
        const names = [...new Set(rows.flatMap((row) => Object.keys(row)))].map(identifier);
        const conflict = mode === 'upsert'
          ? (upsertOptions.onConflict || await primaryKey(table)).split(',').map((name) => identifier(name.trim()))
          : [];
        const updates = names.filter((name) => !conflict.includes(name))
          .map((name) => `${name} = excluded.${name}`).join(', ');
        const onConflict = mode === 'upsert' ? ` on conflict (${conflict.join(', ')}) ${
          upsertOptions.ignoreDuplicates || !updates ? 'do nothing' : `do update set ${updates}`}` : '';
        sql = `insert into public.${table} as t (${names.join(', ')})
          select ${names.join(', ')} from jsonb_populate_recordset(null::public.${table},
            ${literal(rows)})${onConflict} returning t.*`;
      } else if (mode === 'update') {
        const names = Object.keys(payload).map(identifier);
        sql = `update public.${table} as t set (${names.join(', ')}) = (select ${names.join(', ')}
          from jsonb_populate_record(null::public.${table}, ${literal(payload)})) ${filter} returning t.*`;
      } else if (mode === 'delete') {
        sql = `delete from public.${table} as t ${filter} returning t.*`;
      }
      const { sql: shape } = projection('w');
      const data = await json(`with w as (${sql}) select coalesce(jsonb_agg(${shape}), '[]'::jsonb)::text from w;`);
      return { data: returning ? data : null, error: null, count: countMode ? data.length : null };
    }

    async function settle() {
      try {
        const result = await execute();
        if (!single) return result;
        const rows = Array.isArray(result.data) ? result.data : [];
        if (rows.length > 1 || (single === 'single' && rows.length !== 1)) {
          const error = new Error(`JSON object requested, multiple (or no) rows returned (${rows.length})`);
          error.code = 'PGRST116';
          return { data: null, error };
        }
        return { ...result, data: rows[0] ?? null };
      } catch (error) {
        return { data: null, error };
      }
    }

    const builder = {
      select(list = '*', options = {}) {
        columns = list || '*';
        if (mode === 'select') {
          countMode = options.count || null;
          head = options.head === true;
        } else returning = true;
        return builder;
      },
      insert(rows) { mode = 'insert'; payload = rows; return builder; },
      upsert(rows, options = {}) { mode = 'upsert'; payload = rows; upsertOptions = options; return builder; },
      update(values) { mode = 'update'; payload = values; return builder; },
      delete() { mode = 'delete'; return builder; },
      eq(column, value) { where.push(condition(column, 'eq', value)); return builder; },
      neq(column, value) { where.push(condition(column, 'neq', value)); return builder; },
      gt(column, value) { where.push(condition(column, 'gt', value)); return builder; },
      gte(column, value) { where.push(condition(column, 'gte', value)); return builder; },
      lt(column, value) { where.push(condition(column, 'lt', value)); return builder; },
      lte(column, value) { where.push(condition(column, 'lte', value)); return builder; },
      like(column, value) { where.push(condition(column, 'like', value)); return builder; },
      ilike(column, value) { where.push(condition(column, 'ilike', value)); return builder; },
      in(column, values) { where.push(condition(column, 'in', values)); return builder; },
      is(column, value) { where.push(condition(column, 'is', value)); return builder; },
      not(column, operator, value) { where.push(condition(column, `not.${operator}`, value)); return builder; },
      filter(column, operator, value) { where.push(condition(column, operator, value)); return builder; },
      match(values) {
        for (const [column, value] of Object.entries(values)) where.push(condition(column, 'eq', value));
        return builder;
      },
      or(text) { where.push(orConditions(text)); return builder; },
      order(column, { ascending = true, nullsFirst } = {}) {
        const nulls = nullsFirst === undefined ? '' : nullsFirst ? ' nulls first' : ' nulls last';
        orders.push(`t.${identifier(column)} ${ascending ? 'asc' : 'desc'}${nulls}`);
        return builder;
      },
      limit(count) { limit = Number(count); return builder; },
      range(start, end) { offset = Number(start); limit = Number(end) - Number(start) + 1; return builder; },
      single() { single = 'single'; return builder; },
      maybeSingle() { single = 'maybe'; return builder; },
      then(resolve, reject) { return settle().then(resolve, reject); },
    };
    return builder;
  }

  return { rpc, from, statement, json };
}

/**
 * Starts a disposable postgres:16 (never pulled) with the Supabase roles and `supabase/schema.sql`,
 * and makes `clock_timestamp()` follow `ug.test_now`. Returns `{ container, database, session,
 * superuser(sql) }`; `superuser` runs as the owner at `now()`. Everything is removed after the test.
 */
export async function startDisposableSupabasePostgres(t, prefix, database = 'ug_e2e',
  { now = () => new Date().toISOString() } = {}) {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  let session = null;
  t.after(async () => {
    if (session) await session.close();
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
  const psql = (target, sql) => run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v',
    'ON_ERROR_STOP=1', '-U', 'postgres', '-d', target], sql).trim();
  psql('postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create database ${identifier(database)};
  `);
  psql(database, fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  // The test's controlled clock, for RPCs that read the database clock.
  psql(database, `create or replace function pg_catalog.clock_timestamp() returns timestamptz
    language sql volatile as $$ select coalesce(nullif(pg_catalog.current_setting('ug.test_now', true), '')
      ::timestamptz, pg_catalog.statement_timestamp()) $$;`);
  session = openSession(container, database);
  return { container, database, session,
    superuser: (sql) => session.query(`reset role; set ug.test_now = ${dollar(now())};\n${sql}`) };
}
