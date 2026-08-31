import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  getEffectiveOpportunityFacts,
  buildOpportunitySourceObservationSnapshot,
  opportunityFactFields,
  opportunitySourceObservationFields,
  normalizeOpportunityFactField,
  setCurrentOperatorOpportunityFact,
  setOperatorOpportunityFact,
} from '../server/services/dealHunterOpportunityFacts.js';
import {
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES,
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY,
  getCanonicalOpportunityMergeApproval,
} from '../server/repairs/canonicalOpportunityMerge.js';

const supabaseModule = await import('../server/storage/supabase.js');
const opportunityFactWriteBoundaryMigrationUrl = new URL(
  '../supabase/migrations/20260830130000_deal_hunter_opportunity_fact_write_boundary.sql',
  import.meta.url,
);
const opportunitySourceObservationSnapshotMigrationUrl = new URL(
  '../supabase/migrations/20260830140000_deal_hunter_source_observation_snapshot.sql',
  import.meta.url,
);
const currentOperatorFactMigrationUrl = new URL(
  '../supabase/migrations/20260830180000_operator_fact_storage_boundary.sql',
  import.meta.url,
);
const supabaseSchemaUrl = new URL('../supabase/schema.sql', import.meta.url);
const dealHunterServiceUrl = new URL('../server/services/dealHunter.js', import.meta.url);
const submissionsServiceUrl = new URL('../server/services/submissions.js', import.meta.url);

const opportunityId = 'opp-facts-1';

function factRecord(overrides = {}) {
  return {
    id: 'fact-seller-verified',
    opportunity_id: opportunityId,
    field: 'seller_name',
    value: 'Verified Seller',
    source: 'operator',
    verified: true,
    actor: 'acquisition-admin',
    note: 'Confirmed during diligence call.',
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:00:00.000Z',
    ...overrides,
  };
}

function observationRecord(overrides = {}) {
  return {
    id: 'sheet:row-42:seller_name',
    opportunity_id: opportunityId,
    source_id: 'deal-hunter-sheet',
    source_name: 'Deal Hunter Google Sheet',
    source_record_id: 'row-42',
    field: 'seller_name',
    value: 'Source Refresh Seller',
    observed_at: '2026-08-30T12:30:00.000Z',
    created_at: '2026-08-30T12:30:00.000Z',
    updated_at: '2026-08-30T12:30:00.000Z',
    ...overrides,
  };
}

function observationSnapshot(overrides = {}) {
  const observation = observationRecord(overrides);
  return {
    opportunity_id: observation.opportunity_id,
    source_id: observation.source_id,
    source_name: observation.source_name,
    source_record_id: observation.source_record_id,
    observations: [observation],
  };
}

function withStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-opportunity-facts-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'facts.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function seedOpportunity(storage, id = opportunityId) {
  await storage.upsertDealHunterOpportunity({
    opportunity_id: id,
    created_at: '2026-08-30T11:00:00.000Z',
    updated_at: '2026-08-30T11:00:00.000Z',
    canonical_name: 'Facts Test Services',
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'facts-test-v1',
    status: 'active',
    metadata: {},
  });
}

function supabaseChain({ facts = [], observations = [] } = {}) {
  const calls = [];
  const chainFor = (table) => {
    let payload = null;
    const rows = table === 'deal_hunter_opportunity_facts' ? facts : observations;
    const chain = {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit() { return this; },
      upsert(value, options) {
        payload = value;
        calls.push({ table, value, options });
        return this;
      },
      single() {
        return Promise.resolve({ data: payload, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };
  return { client: { from: chainFor }, calls };
}

function constrainedSupabaseBoundary() {
  const calls = [];
  const facts = new Map();
  const observations = new Map();
  const observationKeysById = new Map();
  const observationKey = (record) => [record.opportunity_id, record.source_id, record.source_record_id, record.field].join('\u0000');
  return {
    calls,
    client: {
      from() {
        throw new Error('Task 2 durable writes must use the constrained RPC boundary.');
      },
      async rpc(name, payload) {
        calls.push({ name, payload });
        if (name === 'upsert_deal_hunter_opportunity_fact') {
          const existing = facts.get(payload.p_id);
          const row = existing
            ? {
                ...existing,
                field: payload.p_field,
                value: payload.p_value,
                source: payload.p_source,
                verified: payload.p_verified,
                actor: payload.p_actor,
                note: payload.p_note,
                updated_at: payload.p_updated_at,
              }
            : {
                id: payload.p_id,
                opportunity_id: payload.p_opportunity_id,
                field: payload.p_field,
                value: payload.p_value,
                source: payload.p_source,
                verified: payload.p_verified,
                actor: payload.p_actor,
                note: payload.p_note,
                created_at: payload.p_created_at,
                updated_at: payload.p_updated_at,
              };
          facts.set(row.id, row);
          return { data: row, error: null };
        }
        if (name === 'upsert_deal_hunter_opportunity_source_observation') {
          const incoming = {
            id: payload.p_id,
            opportunity_id: payload.p_opportunity_id,
            source_id: payload.p_source_id,
            source_name: payload.p_source_name,
            source_record_id: payload.p_source_record_id,
            field: payload.p_field,
            value: payload.p_value,
            observed_at: payload.p_observed_at,
            created_at: payload.p_created_at,
            updated_at: payload.p_updated_at,
          };
          const key = observationKey(incoming);
          const existing = observations.get(key);
          const existingKeyForId = observationKeysById.get(incoming.id);
          if (!existing && existingKeyForId && existingKeyForId !== key) {
            return { data: null, error: new Error('duplicate key value violates unique constraint on observation id') };
          }
          const row = existing
            ? {
                ...existing,
                source_name: incoming.source_name,
                value: incoming.value,
                observed_at: incoming.observed_at,
                updated_at: incoming.updated_at,
              }
            : incoming;
          observations.set(key, row);
          observationKeysById.set(row.id, key);
          return { data: row, error: null };
        }
        if (name === 'replace_deal_hunter_opportunity_source_observation_snapshot') {
          const incoming = Array.isArray(payload.p_observations) ? payload.p_observations : [];
          const snapshotRows = incoming.map((row) => ({
            id: row.id,
            opportunity_id: payload.p_opportunity_id,
            source_id: payload.p_source_id,
            source_name: payload.p_source_name,
            source_record_id: payload.p_source_record_id,
            field: row.field,
            value: row.value,
            observed_at: row.observed_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
          }));
          const nextObservations = new Map(observations);
          const nextIds = new Map(observationKeysById);
          const snapshotKey = [payload.p_opportunity_id, payload.p_source_id, payload.p_source_record_id].join('\u0000');
          for (const [key] of nextObservations) {
            if (key.startsWith(`${snapshotKey}\u0000`)) nextObservations.delete(key);
          }
          for (const row of snapshotRows) {
            const key = observationKey(row);
            const previousKey = nextIds.get(row.id);
            if (previousKey && previousKey !== key) {
              return { data: null, error: new Error('duplicate key value violates unique constraint on observation id') };
            }
            const existing = observations.get(key);
            const stored = existing ? { ...existing, ...row, id: existing.id, created_at: existing.created_at } : row;
            nextObservations.set(key, stored);
            nextIds.set(stored.id, key);
          }
          observations.clear();
          for (const [key, row] of nextObservations) observations.set(key, row);
          observationKeysById.clear();
          for (const [id, key] of nextIds) observationKeysById.set(id, key);
          return { data: [...nextObservations.values()].filter((row) => (
            row.opportunity_id === payload.p_opportunity_id
            && row.source_id === payload.p_source_id
            && row.source_record_id === payload.p_source_record_id
          )), error: null };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      },
    },
  };
}

function quotedIdentifiers(source) {
  return [...source.matchAll(/'([a-zA-Z][a-zA-Z0-9_]*)'/g)].map((match) => match[1]);
}

function declarationBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `Missing declaration: ${declaration}`);
  const arrayEnd = source.indexOf('];', start);
  const objectEnd = source.indexOf('};', start);
  const end = [arrayEnd, objectEnd].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;
  assert.notEqual(end, -1, `Missing declaration terminator: ${declaration}`);
  return source.slice(start, end + 2);
}

function objectIdentifiers(source) {
  return [...source.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*):/gm)].map((match) => match[1]);
}

function rpcDefinition(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `Missing RPC definition: ${name}`);
  const end = sql.indexOf('$$;', start);
  assert.notEqual(end, -1, `Missing RPC terminator: ${name}`);
  return sql.slice(start, end + 3);
}

function observationCheckFields(sql) {
  const checkStart = sql.indexOf('deal_hunter_opportunity_source_observations_bounded_check');
  assert.notEqual(checkStart, -1, 'source-observation bound CHECK must exist');
  const fieldStart = sql.indexOf('field in (', checkStart);
  assert.notEqual(fieldStart, -1, 'source-observation bound CHECK must constrain fields');
  const fieldEnd = sql.indexOf(')', fieldStart);
  return quotedIdentifiers(sql.slice(fieldStart, fieldEnd));
}

function conflictAssignments(definition, target) {
  const match = new RegExp(`on conflict \\(${target}\\) do update set([\\s\\S]*?)returning \\* into`, 'i').exec(definition);
  assert.ok(match, `Missing ${target} conflict update body`);
  return [...match[1].matchAll(/([a-z_]+)\s*=\s*excluded\./g)].map((assignment) => assignment[1]);
}

test('verified operator facts survive a structured-source refresh', async (t) => {
  // Break caught: a source refresh mutates or takes precedence over a verified operator fact.
  const storage = withStorage(t);
  await seedOpportunity(storage);

  await setOperatorOpportunityFact({
    opportunityId,
    field: 'seller_name',
    value: 'Verified Seller',
    actor: 'acquisition-admin',
    verified: true,
    note: 'Confirmed during diligence call.',
    storage,
  });
  await storage.upsertDealHunterOpportunitySourceObservation(observationRecord());

  const operatorFacts = await storage.listDealHunterOpportunityFacts(opportunityId);
  const sourceFacts = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  assert.equal(operatorFacts.length, 1);
  assert.equal(operatorFacts[0].value, 'Verified Seller');
  assert.deepEqual(getEffectiveOpportunityFacts({ opportunityId, operatorFacts, crmFacts: [], sourceFacts }), {
    seller_name: {
      value: 'Verified Seller',
      provenance: 'operator',
      verified: true,
      actor: 'acquisition-admin',
      note: 'Confirmed during diligence call.',
    },
  });
});

test('atomic current operator-fact write refuses a superseded opportunity without inserting a revision', async (t) => {
  const sqlite = withStorage(t);
  await sqlite.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z', canonical_name: 'Facts', canonical_recipient: null, canonical_location: null, primary_submission_id: null, identity_version: 'test', status: 'active', metadata: {} });
  const first = await setCurrentOperatorOpportunityFact({ opportunityId, field: 'seller_name', value: 'Current seller', actor: 'admin', verified: true, storage: sqlite });
  assert.equal(first.value, 'Current seller');
  const current = await sqlite.getDealHunterOpportunity(opportunityId);
  await sqlite.upsertDealHunterOpportunity({ ...current, status: 'superseded', updated_at: '2026-08-30T01:00:00.000Z' });
  await assert.rejects(setCurrentOperatorOpportunityFact({ opportunityId, field: 'seller_phone', value: '555-0100', actor: 'admin', verified: true, storage: sqlite }), /no longer current/);
  assert.equal((await sqlite.listDealHunterOpportunityFacts(opportunityId)).length, 1);
});

test('Supabase current-fact adapter uses exactly one atomic RPC, normalizes its raw provider row, and propagates failure', async () => {
  // Break caught: the service reintroduces a get-current/upsert gap or the
  // Supabase adapter routes the current-only write through another boundary.
  const calls = [];
  const returned = {
    ...factRecord({ id: 'rpc-fact', verified: 1 }),
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:00:00.000Z',
  };
  const client = { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: returned, error: null }; } };
  const storage = supabaseModule.createSupabaseStorage({ storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'key' } }, { client });
  const saved = await setCurrentOperatorOpportunityFact({ opportunityId, field: 'seller_name', value: 'Current Seller', actor: 'admin', verified: true, note: 'confirmed', storage });
  assert.notStrictEqual(saved, returned);
  assert.notDeepEqual(saved, returned);
  assert.deepEqual(Object.keys(saved).sort(), ['actor', 'created_at', 'field', 'id', 'note', 'opportunity_id', 'source', 'updated_at', 'value', 'verified']);
  assert.deepEqual(saved, { ...returned, verified: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'insert_current_deal_hunter_opportunity_fact');
  assert.deepEqual(Object.keys(calls[0].payload).sort(), ['p_actor', 'p_created_at', 'p_field', 'p_id', 'p_note', 'p_opportunity_id', 'p_source', 'p_updated_at', 'p_value', 'p_verified']);
  assert.deepEqual({ p_opportunity_id: calls[0].payload.p_opportunity_id, p_field: calls[0].payload.p_field, p_value: calls[0].payload.p_value, p_source: calls[0].payload.p_source, p_verified: calls[0].payload.p_verified, p_actor: calls[0].payload.p_actor, p_note: calls[0].payload.p_note }, { p_opportunity_id: opportunityId, p_field: 'seller_name', p_value: 'Current Seller', p_source: 'operator', p_verified: true, p_actor: 'admin', p_note: 'confirmed' });
  assert.match(calls[0].payload.p_id, /^[0-9a-f-]{36}$/i);
  assert.match(calls[0].payload.p_created_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(calls[0].payload.p_updated_at, calls[0].payload.p_created_at);

  const failed = supabaseModule.createSupabaseStorage({ storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'key' } }, { client: { rpc: async () => ({ data: null, error: new Error('P0002 unavailable') }) } });
  await assert.rejects(failed.insertCurrentDealHunterOpportunityFact(factRecord()), /P0002 unavailable/);
});

test('atomic current-fact write serializes against supersession in both lock orderings', async () => {
  // Break caught: a former get-current then upsert implementation can insert a
  // historical fact after another transaction supersedes the opportunity.
  const oldTwoCall = async (state) => {
    if (state.status !== 'active') throw new Error('unavailable');
    state.events.push('old:get-current');
    state.status = 'superseded'; state.events.push('supersede');
    state.facts.push('historical fact'); state.events.push('old:upsert');
  };
  const old = { status: 'active', facts: [], events: [] };
  await oldTwoCall(old);
  assert.deepEqual(old, { status: 'superseded', facts: ['historical fact'], events: ['old:get-current', 'supersede', 'old:upsert'] });

  const atomic = async (state, order) => {
    if (order === 'write-first') { state.events.push('write:lock'); if (state.status !== 'active') throw new Error('unavailable'); state.facts.push('current fact'); state.events.push('write:insert'); state.status = 'superseded'; state.events.push('supersede'); return; }
    state.status = 'superseded'; state.events.push('supersede'); state.events.push('write:lock');
    if (state.status !== 'active') throw new Error('unavailable');
  };
  const writeFirst = { status: 'active', facts: [], events: [] };
  await atomic(writeFirst, 'write-first');
  assert.deepEqual(writeFirst, { status: 'superseded', facts: ['current fact'], events: ['write:lock', 'write:insert', 'supersede'] });
  const supersedeFirst = { status: 'active', facts: [], events: [] };
  await assert.rejects(atomic(supersedeFirst, 'supersede-first'), /unavailable/);
  assert.deepEqual(supersedeFirst, { status: 'superseded', facts: [], events: ['supersede', 'write:lock'] });

  const calls = [];
  await setCurrentOperatorOpportunityFact({ opportunityId, field: 'seller_name', value: 'x', actor: 'admin', storage: { insertCurrentDealHunterOpportunityFact: async (fact) => { calls.push('insertCurrent'); return fact; }, getCurrentDealHunterOpportunity: async () => { calls.push('getCurrent'); }, upsertDealHunterOpportunityFact: async () => { calls.push('upsert'); } } });
  assert.deepEqual(calls, ['insertCurrent']);
});

test('provider fact and observation read limits normalize to integer bounds consistently', async (t) => {
  const sqlite = withStorage(t);
  await seedOpportunity(sqlite);
  await sqlite.upsertDealHunterOpportunityFact(factRecord());
  await sqlite.upsertDealHunterOpportunitySourceObservation(observationRecord());
  for (const limit of [1.9, Number.NaN, 'oops', 0, -2, 9999]) {
    await sqlite.listDealHunterOpportunityFacts(opportunityId, { limit });
    await sqlite.listDealHunterOpportunitySourceObservations(opportunityId, { limit });
  }
  const calls = [];
  const client = {
    from() {
      const chain = { select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit(value) { calls.push(value); return Promise.resolve({ data: [], error: null }); } };
      return chain;
    },
  };
  const supabase = supabaseModule.createSupabaseStorage({ storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'key' } }, { client });
  for (const limit of [1.9, Number.NaN, 'oops', 0, -2, 9999]) {
    await supabase.listDealHunterOpportunityFacts(opportunityId, { limit });
    await supabase.listDealHunterOpportunitySourceObservations(opportunityId, { limit });
  }
  assert.deepEqual(calls, [1, 1, 500, 500, 500, 500, 1, 1, 1, 1, 500, 500]);
});

test('current-fact RPC has the exact service-role fail-closed locking contract in both SQL sources', async () => {
  const migration = fs.readFileSync(currentOperatorFactMigrationUrl, 'utf8');
  const schema = fs.readFileSync(supabaseSchemaUrl, 'utf8');
  const normalizeRpc = (sql) => rpcDefinition(sql, 'insert_current_deal_hunter_opportunity_fact')
    .replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim();
  assert.equal(normalizeRpc(migration), normalizeRpc(schema), 'forward migration and fresh schema must carry the identical current-fact RPC');
  for (const sql of [migration, schema]) {
    const definition = rpcDefinition(sql, 'insert_current_deal_hunter_opportunity_fact');
    assert.match(definition, /^create or replace function public\.insert_current_deal_hunter_opportunity_fact\(\s*p_id text, p_opportunity_id text, p_field text, p_value text, p_source text,\s*p_verified boolean, p_actor text, p_note text, p_created_at timestamptz, p_updated_at timestamptz\s*\)/i);
    assert.match(definition, /security definer[\s\S]*set search_path = public/i);
    assert.match(definition, /status = 'active' for update[\s\S]*if not found[\s\S]*errcode = 'P0002'[\s\S]*insert into public\.deal_hunter_opportunity_facts[\s\S]*returning \* into v_fact[\s\S]*return v_fact/i);
    assert.match(sql, /revoke all privileges on function public\.insert_current_deal_hunter_opportunity_fact[\s\S]*from public, anon, authenticated/i);
    assert.match(sql, /grant execute on function public\.insert_current_deal_hunter_opportunity_fact[\s\S]*to service_role/i);
  }
});

test('operator-fact forward migration and fresh schema share the strict source and bound contract', () => {
  // Break caught: a later migration leaves either direct RPC permissive or lets
  // fresh and upgraded databases disagree about the operator-fact boundary.
  const migration = fs.readFileSync(currentOperatorFactMigrationUrl, 'utf8');
  const schema = fs.readFileSync(supabaseSchemaUrl, 'utf8');
  const normalizeSql = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  for (const functionName of ['upsert_deal_hunter_opportunity_fact', 'insert_current_deal_hunter_opportunity_fact']) {
    const migrationRpc = rpcDefinition(migration, functionName);
    const schemaRpc = rpcDefinition(schema, functionName);
    assert.equal(normalizeSql(migrationRpc), normalizeSql(schemaRpc), `${functionName} must be identical after forward migration`);
    assert.match(migrationRpc, /p_source is distinct from 'operator'/i, `${functionName} must reject source spoofing server-side`);
  }
  for (const [label, sql] of [['forward migration', migration], ['fresh schema', schema]]) {
    assert.match(sql, /deal_hunter_opportunity_facts_operator_boundary_check/i, `${label} must constrain operator facts`);
    assert.match(sql, /char_length\(id\) between 1 and 240/i, `${label} must bound fact IDs`);
    assert.match(sql, /field in \([\s\S]*'seller_name'[\s\S]*'operator_contact_notes'/i, `${label} must use the approved field allowlist`);
    assert.match(sql, /char_length\(value\) between 1 and 4000/i, `${label} must bound fact values`);
    assert.match(sql, /source = 'operator'/i, `${label} must require operator source for new facts`);
    assert.match(sql, /char_length\(actor\) between 1 and 200/i, `${label} must bound actors`);
    assert.match(sql, /char_length\(note\) between 1 and 4000/i, `${label} must bound notes`);
  }
  assert.match(migration, /\) not valid;/i, 'forward migration must preserve existing legacy/provider history without rewriting it');
});

test('direct SQLite current operator-fact storage rejects every hostile probe atomically', async (t) => {
  // Break caught: callers that bypass the fact service can persist unsupported,
  // unbounded, spoofed, blank, or truthily-coerced operator facts.
  const storage = withStorage(t);
  await seedOpportunity(storage);
  const hostileFacts = [
    ['unsupported field', { id: 'hostile-field', field: 'machine_score' }, /field/i],
    ['250-character id', { id: 'i'.repeat(250) }, /id/i],
    ['6,000-character value', { id: 'hostile-value', value: 'v'.repeat(6000) }, /value/i],
    ['arbitrary source', { id: 'hostile-source', source: 'structured-source' }, /source/i],
    ['empty actor', { id: 'hostile-actor', actor: '' }, /actor/i],
    ['5,000-character note', { id: 'hostile-note', note: 'n'.repeat(5000) }, /note/i],
    ['truthy verification coercion', { id: 'hostile-verified', verified: 'false' }, /verification|verified/i],
    ['unbounded metadata', { id: 'hostile-metadata', metadata: { raw: 'm'.repeat(5000) } }, /metadata/i],
  ];

  for (const [writerLabel, write] of [
    ['current', (fact) => storage.insertCurrentDealHunterOpportunityFact(fact)],
    ['direct upsert', (fact) => storage.upsertDealHunterOpportunityFact(fact)],
  ]) {
    for (const [label, overrides, expected] of hostileFacts) {
      await assert.rejects(write(factRecord(overrides)), expected, `${writerLabel}: ${label}`);
      assert.deepEqual(await storage.listDealHunterOpportunityFacts(opportunityId), [], `${writerLabel}: ${label} must leave no partial fact`);
    }
  }
});

test('direct Supabase current operator-fact adapter rejects every hostile probe before RPC', async () => {
  // Break caught: the provider adapter serializes hostile operator facts to its
  // security-definer RPC, relying on truthy JavaScript coercion or a caller's
  // convention instead of the bounded persistence contract.
  const calls = [];
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'key' } },
    { client: { rpc: async (name, payload) => { calls.push({ name, payload }); return { data: payload, error: null }; } } },
  );
  const hostileFacts = [
    ['unsupported field', { id: 'provider-hostile-field', field: 'machine_score' }, /field/i],
    ['250-character id', { id: 'i'.repeat(250) }, /id/i],
    ['6,000-character value', { id: 'provider-hostile-value', value: 'v'.repeat(6000) }, /value/i],
    ['arbitrary source', { id: 'provider-hostile-source', source: 'structured-source' }, /source/i],
    ['empty actor', { id: 'provider-hostile-actor', actor: '' }, /actor/i],
    ['5,000-character note', { id: 'provider-hostile-note', note: 'n'.repeat(5000) }, /note/i],
    ['truthy verification coercion', { id: 'provider-hostile-verified', verified: 'false' }, /verification|verified/i],
    ['unbounded metadata', { id: 'provider-hostile-metadata', metadata: { raw: 'm'.repeat(5000) } }, /metadata/i],
  ];

  for (const [writerLabel, write] of [
    ['current', (fact) => storage.insertCurrentDealHunterOpportunityFact(fact)],
    ['direct upsert', (fact) => storage.upsertDealHunterOpportunityFact(fact)],
  ]) {
    for (const [label, overrides, expected] of hostileFacts) {
      await assert.rejects(write(factRecord(overrides)), expected, `${writerLabel}: ${label}`);
    }
  }
  assert.deepEqual(calls, [], 'rejected direct writes must not reach the provider RPC');
});

test('effective facts use operator, CRM, structured-source, then enrichment-suggestion precedence', () => {
  // Break caught: a lower-authority source wins when the same field is present at multiple authority levels.
  const effective = getEffectiveOpportunityFacts({
    opportunityId,
    operatorFacts: [factRecord()],
    crmFacts: [
      { field: 'seller_name', value: 'CRM Seller' },
      { field: 'broker_name', value: 'CRM Broker' },
    ],
    sourceFacts: [
      { field: 'seller_name', value: 'Structured Seller' },
      { field: 'broker_name', value: 'Structured Broker' },
      { field: 'reason_for_sale', value: 'Structured retirement' },
      { field: 'seller_financing', value: 'Structured unknown' },
      { field: 'seller_financing', value: 'Suggested financing', suggestion: true },
      { field: 'management_structure', value: 'Suggested management', suggestion: true },
    ],
  });

  assert.deepEqual(effective, {
    seller_name: { value: 'Verified Seller', provenance: 'operator', verified: true, actor: 'acquisition-admin', note: 'Confirmed during diligence call.' },
    broker_name: { value: 'CRM Broker', provenance: 'crm', verified: false, actor: null, note: null },
    reason_for_sale: { value: 'Structured retirement', provenance: 'structured-source', verified: false, actor: null, note: null },
    seller_financing: { value: 'Structured unknown', provenance: 'structured-source', verified: false, actor: null, note: null },
    management_structure: { value: 'Suggested management', provenance: 'enrichment-suggestion', verified: false, actor: null, note: null },
  });
});

test('enrichment suggestions cannot overwrite a verified operator fact', () => {
  // Break caught: a future enrichment suggestion replaces a verified operator value.
  const effective = getEffectiveOpportunityFacts({
    opportunityId,
    operatorFacts: [factRecord({ field: 'broker_email', value: 'verified@example.test' })],
    crmFacts: [],
    sourceFacts: [{ field: 'broker_email', value: 'suggested@example.test', suggestion: true }],
  });

  assert.deepEqual(effective.broker_email, {
    value: 'verified@example.test',
    provenance: 'operator',
    verified: true,
    actor: 'acquisition-admin',
    note: 'Confirmed during diligence call.',
  });
});

test('malformed or unsupported operator fact fields reject before persistence', async () => {
  // Break caught: a caller can persist an unapproved field identifier or a malformed fact payload.
  assert.equal(normalizeOpportunityFactField(' Seller Name '), 'seller_name');
  assert.throws(() => normalizeOpportunityFactField('seller_names'), /Unsupported opportunity fact field/);
  assert.throws(() => normalizeOpportunityFactField('seller\u0000name'), /Unsupported opportunity fact field/);
  await assert.rejects(
    setOperatorOpportunityFact({
      opportunityId,
      field: 'broker_name',
      value: { raw: 'blob' },
      actor: 'acquisition-admin',
      verified: true,
      storage: { upsertDealHunterOpportunityFact: async () => null },
    }),
    /plain text, number, or boolean/,
  );
});

test('SQLite and Supabase adapters expose matching fact and source-observation shapes', async (t) => {
  // Break caught: one provider serializes booleans, names, or bounded columns differently from the other.
  const storage = withStorage(t);
  await seedOpportunity(storage);
  const fact = factRecord();
  const observation = observationRecord();
  await storage.upsertDealHunterOpportunityFact(fact);
  await storage.upsertDealHunterOpportunitySourceObservation(observation);

  const sqliteFacts = await storage.listDealHunterOpportunityFacts(opportunityId);
  const sqliteObservations = await storage.listDealHunterOpportunitySourceObservations(opportunityId);
  const chain = supabaseChain({ facts: [fact], observations: [observation] });
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: chain.client },
  );
  const supabaseFacts = await supabase.listDealHunterOpportunityFacts(opportunityId);
  const supabaseObservations = await supabase.listDealHunterOpportunitySourceObservations(opportunityId);

  assert.deepEqual(sqliteFacts, [fact]);
  assert.deepEqual(supabaseFacts, sqliteFacts);
  assert.deepEqual(sqliteObservations, [observation]);
  assert.deepEqual(supabaseObservations, sqliteObservations);
  assert.deepEqual(chain.calls, []);
});

test('fact conflicts preserve immutable identity while both providers update only mutable revision fields', async (t) => {
  // Break caught: Supabase merge-upsert can reassign an existing fact revision
  // to another opportunity or replace its original audit timestamp.
  const sqlite = withStorage(t);
  await seedOpportunity(sqlite);
  const first = factRecord({ id: 'fact-conflict', created_at: '2026-08-30T08:00:00.000Z' });
  const second = factRecord({
    id: first.id,
    opportunity_id: 'opp-reassignment-attempt',
    field: 'broker_name',
    value: 'Updated Broker',
    source: 'operator',
    verified: false,
    actor: 'second-operator',
    note: 'Corrected value',
    created_at: '2026-08-30T09:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
  });
  const boundary = constrainedSupabaseBoundary();
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: boundary.client },
  );

  await sqlite.upsertDealHunterOpportunityFact(first);
  await supabase.upsertDealHunterOpportunityFact(first);
  const sqliteFinal = await sqlite.upsertDealHunterOpportunityFact(second);
  const supabaseFinal = await supabase.upsertDealHunterOpportunityFact(second);

  assert.deepEqual(sqliteFinal, {
    ...second,
    opportunity_id: first.opportunity_id,
    created_at: first.created_at,
  });
  assert.deepEqual(supabaseFinal, sqliteFinal);
  assert.equal(boundary.calls[1].name, 'upsert_deal_hunter_opportunity_fact');
  assert.deepEqual(boundary.calls[1].payload, {
    p_id: second.id,
    p_opportunity_id: second.opportunity_id,
    p_field: second.field,
    p_value: second.value,
    p_source: second.source,
    p_verified: second.verified,
    p_actor: second.actor,
    p_note: second.note,
    p_created_at: second.created_at,
    p_updated_at: second.updated_at,
  });
});

test('source-observation conflicts preserve immutable source identity while both providers refresh mutable values', async (t) => {
  // Break caught: a source refresh replaces observation ownership, ID, or the
  // original creation timestamp in one provider but not the other.
  const sqlite = withStorage(t);
  await seedOpportunity(sqlite);
  const first = observationRecord({ id: 'observation-conflict', created_at: '2026-08-30T08:00:00.000Z' });
  const second = observationRecord({
    id: 'replacement-id-attempt',
    source_id: ` ${first.source_id} `,
    source_name: 'Refreshed Source Name',
    source_record_id: ` ${first.source_record_id} `,
    field: ' Seller Name ',
    value: 'Updated source value',
    observed_at: '2026-08-30T10:00:00.000Z',
    created_at: '2026-08-30T09:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
  });
  const boundary = constrainedSupabaseBoundary();
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: boundary.client },
  );

  await sqlite.upsertDealHunterOpportunitySourceObservation(first);
  await supabase.upsertDealHunterOpportunitySourceObservation(first);
  const sqliteFinal = await sqlite.upsertDealHunterOpportunitySourceObservation(second);
  const supabaseFinal = await supabase.upsertDealHunterOpportunitySourceObservation(second);

  assert.deepEqual(sqliteFinal, {
    ...second,
    id: first.id,
    source_id: first.source_id,
    source_record_id: first.source_record_id,
    field: first.field,
    created_at: first.created_at,
  });
  assert.deepEqual(supabaseFinal, sqliteFinal);
  assert.equal(boundary.calls[1].name, 'upsert_deal_hunter_opportunity_source_observation');
  assert.deepEqual(boundary.calls[1].payload, {
    p_id: second.id,
    p_opportunity_id: second.opportunity_id,
    p_source_id: first.source_id,
    p_source_name: second.source_name,
    p_source_record_id: first.source_record_id,
    p_field: first.field,
    p_value: second.value,
    p_observed_at: second.observed_at,
    p_created_at: second.created_at,
    p_updated_at: second.updated_at,
  });

  // A reused primary ID must not create a second observation under a different
  // ownership composite in either provider.
  await seedOpportunity(sqlite, 'opp-other-observation-owner');
  const reassignment = observationRecord({
    id: first.id,
    opportunity_id: 'opp-other-observation-owner',
    source_id: 'other-source',
    source_record_id: 'other-record',
    field: 'annual_revenue',
  });
  await assert.rejects(sqlite.upsertDealHunterOpportunitySourceObservation(reassignment), /UNIQUE constraint failed/);
  await assert.rejects(supabase.upsertDealHunterOpportunitySourceObservation(reassignment), /duplicate key value/);
  assert.deepEqual(await sqlite.listDealHunterOpportunitySourceObservations(first.opportunity_id), [sqliteFinal]);
});

test('source observations normalize the bounded Deal Hunter field set and reject malformed provider writes', async (t) => {
  // Break caught: unbounded/raw source payloads, whitespace-split identities,
  // unsupported normalized fields, or invalid timestamps reach durable storage.
  const raw = observationRecord({
    id: ' observation-normalized ',
    opportunity_id: opportunityId,
    source_id: ' deal-hunter-sheet ',
    source_name: ' Deal Hunter Google Sheet ',
    source_record_id: ' row-42 ',
    field: ' Broker Contact ',
    value: ' $1,450,000 ',
    observed_at: ' 2026-08-30T12:30:00Z ',
    created_at: ' 2026-08-30T12:30:00Z ',
    updated_at: ' 2026-08-30T12:30:00Z ',
  });
  const sqlite = withStorage(t);
  await seedOpportunity(sqlite);
  const canonical = await sqlite.upsertDealHunterOpportunitySourceObservation(raw);
  assert.deepEqual(canonical, {
    ...observationRecord({ field: 'broker_contact', value: '$1,450,000' }),
    id: 'observation-normalized',
    source_id: 'deal-hunter-sheet',
    source_name: 'Deal Hunter Google Sheet',
    source_record_id: 'row-42',
    field: 'broker_contact',
    value: '$1,450,000',
    observed_at: '2026-08-30T12:30:00.000Z',
    created_at: '2026-08-30T12:30:00.000Z',
    updated_at: '2026-08-30T12:30:00.000Z',
  });
  const boundary = constrainedSupabaseBoundary();
  const supabase = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: boundary.client },
  );
  assert.deepEqual(await supabase.upsertDealHunterOpportunitySourceObservation(raw), canonical);
  const invalid = observationRecord({ field: 'raw_metadata' });
  await assert.rejects(sqlite.upsertDealHunterOpportunitySourceObservation(invalid), /Unsupported opportunity source-observation field/);
  await assert.rejects(supabase.upsertDealHunterOpportunitySourceObservation(invalid), /Unsupported opportunity source-observation field/);
  await assert.rejects(
    sqlite.upsertDealHunterOpportunitySourceObservation(observationRecord({ value: 'x'.repeat(5001) })),
    /at most 5000 characters/,
  );
  await assert.rejects(
    supabase.upsertDealHunterOpportunitySourceObservation(observationRecord({ value: 'x'.repeat(5001) })),
    /at most 5000 characters/,
  );
  for (const value of [{ raw: 'blob' }, Buffer.from('blob')]) {
    await assert.rejects(
      sqlite.upsertDealHunterOpportunitySourceObservation(observationRecord({ value })),
      /plain text, number, or boolean/,
    );
    await assert.rejects(
      supabase.upsertDealHunterOpportunitySourceObservation(observationRecord({ value })),
      /plain text, number, or boolean/,
    );
  }
  await assert.rejects(
    sqlite.upsertDealHunterOpportunitySourceObservation(observationRecord({ observed_at: 'not-a-timestamp' })),
    /valid timestamp/,
  );
  await assert.rejects(
    supabase.upsertDealHunterOpportunitySourceObservation(observationRecord({ observed_at: 'not-a-timestamp' })),
    /valid timestamp/,
  );
});

test('a no-explicit-ID Sheet observation snapshot keeps its source record identity when the listing URL is corrected', () => {
  // Break caught: a corrected Sheet URL forks a new observation record even
  // though the source row remains the same supported no-ID Sheet record.
  const sourceDeal = {
    sourceId: 'sheet-0',
    sourceName: 'SMB Deal Hunter Google Sheet',
    sourceRowId: '42',
    id: '42',
    idFromSourceRowPosition: true,
    stableExternalId: false,
    name: 'No-ID Sheet HVAC',
    listingUrl: 'https://broker.example/original-listing',
    annualProfit: 450000,
  };
  const first = buildOpportunitySourceObservationSnapshot({ opportunityId, deal: sourceDeal, now: '2026-08-30T12:30:00.000Z' });
  const corrected = buildOpportunitySourceObservationSnapshot({
    opportunityId,
    deal: { ...sourceDeal, listingUrl: 'https://broker.example/corrected-listing' },
    now: '2026-08-30T13:30:00.000Z',
  });

  assert.equal(first.source_record_id, 'sheet-row:42');
  assert.equal(corrected.source_record_id, first.source_record_id);
  assert.deepEqual(
    corrected.observations.map((observation) => observation.id),
    first.observations.map((observation) => observation.id),
  );
});

test('SQLite source-observation snapshot replacement rolls back entirely when one incoming field write fails', async (t) => {
  // Break caught: sequential writes leave a durable hybrid of old and new
  // source values after a mid-snapshot persistence error.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-observation-snapshot-rollback-'));
  const sqlitePath = path.join(directory, 'facts.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await seedOpportunity(storage);

  const original = observationSnapshot();
  original.observations.push(observationRecord({
    id: 'sheet:row-42:annual_revenue',
    field: 'annual_revenue',
    value: '1200000',
  }));
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(original);
  const before = await storage.listDealHunterOpportunitySourceObservations(opportunityId);

  const database = new Database(sqlitePath);
  database.exec(`
    CREATE TRIGGER fail_source_observation_snapshot
    BEFORE INSERT ON deal_hunter_opportunity_source_observations
    WHEN NEW.field = 'annual_revenue'
    BEGIN
      SELECT RAISE(ABORT, 'injected source snapshot failure');
    END;
  `);
  database.close();

  const replacement = observationSnapshot({ value: 'Updated Seller' });
  replacement.observations.push(observationRecord({
    id: 'sheet:row-42:annual_revenue',
    field: 'annual_revenue',
    value: '1400000',
    updated_at: '2026-08-30T13:00:00.000Z',
  }));
  await assert.rejects(
    storage.replaceDealHunterOpportunitySourceObservationSnapshot(replacement),
    /injected source snapshot failure/,
  );
  assert.deepEqual(await storage.listDealHunterOpportunitySourceObservations(opportunityId), before);
});

test('Supabase source-observation snapshot replacement is one constrained RPC with SQLite-equivalent replacement semantics', async () => {
  // Break caught: Supabase performs a partial client-side sequence instead of
  // one atomic source-record replacement boundary.
  const boundary = constrainedSupabaseBoundary();
  const storage = supabaseModule.createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client: boundary.client },
  );
  const first = observationSnapshot();
  first.observations.push(observationRecord({ id: 'sheet:row-42:annual_revenue', field: 'annual_revenue', value: '1200000' }));
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(first);
  const refreshed = observationSnapshot({ value: 'Updated Seller', updated_at: '2026-08-30T13:00:00.000Z' });
  await storage.replaceDealHunterOpportunitySourceObservationSnapshot(refreshed);

  assert.deepEqual(boundary.calls.map((call) => call.name), [
    'replace_deal_hunter_opportunity_source_observation_snapshot',
    'replace_deal_hunter_opportunity_source_observation_snapshot',
  ]);
  assert.deepEqual(boundary.calls[1].payload.p_observations.map((observation) => observation.field), ['seller_name']);
});

test('Supabase snapshot replacement is a function-only, transactional, server-only migration matching the fresh schema', () => {
  // Break caught: concurrent replacements for one source record delete stale
  // fields before either one inserts, leaving their union instead of either
  // caller's complete snapshot; the transaction-scoped advisory lock makes
  // that source-record replacement linearizable.
  const migration = fs.readFileSync(opportunitySourceObservationSnapshotMigrationUrl, 'utf8');
  const schema = fs.readFileSync(supabaseSchemaUrl, 'utf8');
  for (const [label, sql] of [['migration', migration], ['fresh schema', schema]]) {
    const definition = rpcDefinition(sql, 'replace_deal_hunter_opportunity_source_observation_snapshot');
    assert.match(definition, /returns setof public\.deal_hunter_opportunity_source_observations/i, `${label} must return its complete replacement snapshot`);
    assert.match(definition, /security definer/i, `${label} must keep replacement server-side`);
    assert.match(definition, /set search_path = public/i, `${label} must pin its search path`);
    assert.match(definition, /delete from public\.deal_hunter_opportunity_source_observations/i, `${label} must reconcile stale fields`);
    assert.match(definition, /insert into public\.deal_hunter_opportunity_source_observations/i, `${label} must write incoming fields`);
    assert.match(definition, /on conflict \(opportunity_id, source_id, source_record_id, field\) do update/i, `${label} must preserve row identity on refresh`);
    assert.match(
      definition,
      /perform\s+pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(\s*pg_catalog\.jsonb_build_array\(\s*p_opportunity_id\s*,\s*p_source_id\s*,\s*p_source_record_id\s*\)::text\s*,\s*0\s*\)\s*\)\s*;/is,
      `${label} must serialize each complete source-record snapshot with an unambiguous transaction-scoped advisory lock`,
    );
    const lockIndex = definition.search(/perform\s+pg_catalog\.pg_advisory_xact_lock/i);
    const deleteIndex = definition.search(/delete from public\.deal_hunter_opportunity_source_observations/i);
    const insertIndex = definition.search(/insert into public\.deal_hunter_opportunity_source_observations/i);
    assert.ok(lockIndex >= 0 && lockIndex < deleteIndex && lockIndex < insertIndex, `${label} must acquire the lock before snapshot reconciliation`);
    assert.match(sql, /revoke all privileges on function public\.replace_deal_hunter_opportunity_source_observation_snapshot/i, `${label} must revoke public execution`);
    assert.match(sql, /grant execute on function public\.replace_deal_hunter_opportunity_source_observation_snapshot/i, `${label} must grant only service execution`);
  }
  assert.doesNotMatch(migration, /alter table|create table|drop table/i, 'function-only migration is safe for existing rows');
});

test('Supabase durable-write RPCs enforce the SQLite-compatible immutable conflict contract', () => {
  // Break caught: a future migration turns either constrained RPC back into a
  // merge-upsert that can rewrite owner, source identity, or created_at.
  const migration = fs.readFileSync(opportunityFactWriteBoundaryMigrationUrl, 'utf8');
  assert.match(migration, /constraint deal_hunter_opportunity_source_observations_bounded_check/i);
  assert.match(migration, /field in \([\s\S]*'asking_price'[\s\S]*'seller_name'/i);
  assert.match(migration, /create or replace function public\.upsert_deal_hunter_opportunity_fact\(/i);
  assert.match(migration, /on conflict \(id\) do update set[\s\S]*updated_at = excluded\.updated_at/i);
  assert.doesNotMatch(migration, /on conflict \(id\) do update set[\s\S]*opportunity_id\s*=/i);
  assert.doesNotMatch(migration, /on conflict \(id\) do update set[\s\S]*created_at\s*=/i);
  assert.match(migration, /create or replace function public\.upsert_deal_hunter_opportunity_source_observation\(/i);
  assert.match(migration, /on conflict \(opportunity_id, source_id, source_record_id, field\) do update set[\s\S]*updated_at = excluded\.updated_at/i);
  assert.doesNotMatch(migration, /on conflict \(opportunity_id, source_id, source_record_id, field\) do update set[\s\S]*\bid\s*=/i);
  assert.doesNotMatch(migration, /on conflict \(opportunity_id, source_id, source_record_id, field\) do update set[\s\S]*created_at\s*=/i);
  for (const functionName of [
    'upsert_deal_hunter_opportunity_fact',
    'upsert_deal_hunter_opportunity_source_observation',
  ]) {
    assert.match(migration, new RegExp(`revoke all privileges on function public\\.${functionName}\\(`, 'i'));
    assert.match(migration, new RegExp(`grant execute on function public\\.${functionName}\\(`, 'i'));
  }
});

test('source-observation allowlist exhaustively maps the current Deal Hunter and Deal OS normalized field inventories', () => {
  // Break caught: normalized fields added to either source model silently fail
  // durable provenance capture, or the source allowlist drifts into raw data.
  const dealHunterSource = fs.readFileSync(dealHunterServiceUrl, 'utf8');
  const submissionsSource = fs.readFileSync(submissionsServiceUrl, 'utf8');
  const dealHunterFields = quotedIdentifiers(declarationBody(dealHunterSource, 'const dealHunterManagedFields = ['));
  const dealOsFields = objectIdentifiers(declarationBody(submissionsSource, 'const dealFieldNormalizers = {'));
  const dealHunterAliases = {
    name: 'name', industry: 'industry', description: 'description', city: 'city', county: 'county', state: 'state',
    country: 'country', location: 'location', annualProfit: 'annual_profit', annualRevenue: 'annual_revenue',
    askingPrice: 'asking_price', profitMultiple: 'profit_multiple', netMargin: 'net_margin',
    yearsEstablished: 'years_established', remoteFlag: 'remote_flag', franchiseFlag: 'franchise_flag',
    fiveYearsFlag: 'five_years_flag', brokerName: 'broker_name', brokerEmail: 'broker_email',
    brokerCompany: 'broker_company', brokerContact: 'broker_contact', listingUrl: 'listing_url',
    listingSource: 'listing_source', dateAdded: 'date_added', lastUpdated: 'last_updated',
  };
  assert.deepEqual(Object.keys(dealHunterAliases), dealHunterFields);
  const expected = new Set([
    ...Object.values(dealHunterAliases),
    ...dealOsFields,
    ...opportunityFactFields,
    'business_name',
    'listing_id',
    'deal_key',
    'source_identity',
  ]);
  assert.deepEqual(new Set(opportunitySourceObservationFields), expected);
  assert.equal(opportunitySourceObservationFields.includes('raw_metadata'), false);
});

test('forward migration and fresh schema define identical constrained RPC and CHECK contracts', () => {
  // Break caught: the fresh schema or forward migration drifts on immutable
  // columns, return semantics, privileges, search path, or upgrade safety.
  const forwardMigration = fs.readFileSync(opportunityFactWriteBoundaryMigrationUrl, 'utf8');
  const schema = fs.readFileSync(supabaseSchemaUrl, 'utf8');
  assert.match(forwardMigration, /add constraint deal_hunter_opportunity_source_observations_bounded_check[\s\S]*?\) not valid;/i);
  assert.doesNotMatch(forwardMigration, /validate constraint deal_hunter_opportunity_source_observations_bounded_check/i);

  for (const [label, sql] of [['forward migration', forwardMigration], ['fresh schema', schema]]) {
    const fact = rpcDefinition(sql, 'upsert_deal_hunter_opportunity_fact');
    const observation = rpcDefinition(sql, 'upsert_deal_hunter_opportunity_source_observation');
    for (const definition of [fact, observation]) {
      assert.match(definition, /returns public\.deal_hunter_opportunity_/i, `${label} RPC must return its durable row`);
      assert.match(definition, /security definer/i, `${label} RPC must be constrained server-side`);
      assert.match(definition, /set search_path = public/i, `${label} RPC must pin its search path`);
      assert.match(definition, /returning \* into/i, `${label} RPC must return the post-conflict row`);
    }
    assert.deepEqual(
      conflictAssignments(fact, 'id'),
      ['field', 'value', 'source', 'verified', 'actor', 'note', 'updated_at'],
    );
    assert.deepEqual(
      conflictAssignments(observation, 'opportunity_id, source_id, source_record_id, field'),
      ['source_name', 'value', 'observed_at', 'updated_at'],
    );
    for (const functionName of ['upsert_deal_hunter_opportunity_fact', 'upsert_deal_hunter_opportunity_source_observation']) {
      assert.match(sql, new RegExp(`revoke all privileges on function public\\.${functionName}\\(`, 'i'));
      assert.match(sql, new RegExp(`grant execute on function public\\.${functionName}\\(`, 'i'));
    }
  }
  assert.match(forwardMigration, /field in \([\s\S]*'broker_contact'[\s\S]*'company'[\s\S]*'role'/i);
  assert.match(schema, /field in \([\s\S]*'broker_contact'[\s\S]*'company'[\s\S]*'role'/i);
  for (const [label, sql] of [['forward migration', forwardMigration], ['fresh schema', schema]]) {
    assert.deepEqual(
      new Set(observationCheckFields(sql)),
      new Set(opportunitySourceObservationFields),
      `${label} CHECK must match the shared bounded observation allowlist`,
    );
  }
});

test('operator-fact history remains queryable after a corrected value is recorded', async (t) => {
  // Break caught: upserting a correction destroys the older operator fact instead of retaining audit history.
  const storage = withStorage(t);
  await seedOpportunity(storage);
  await storage.upsertDealHunterOpportunityFact(factRecord({
    id: 'fact-seller-initial',
    value: 'Initial Seller',
    created_at: '2026-08-30T10:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
  }));
  await storage.upsertDealHunterOpportunityFact(factRecord({
    id: 'fact-seller-corrected',
    value: 'Corrected Seller',
    created_at: '2026-08-30T11:00:00.000Z',
    updated_at: '2026-08-30T11:00:00.000Z',
  }));

  assert.deepEqual(
    (await storage.listDealHunterOpportunityFacts(opportunityId)).map((fact) => ({ id: fact.id, value: fact.value })),
    [
      { id: 'fact-seller-corrected', value: 'Corrected Seller' },
      { id: 'fact-seller-initial', value: 'Initial Seller' },
    ],
  );
});

test('canonical-merge inspection classifies and preserves opportunity-owned facts and observations', async (t) => {
  // Break caught: a canonical merge treats either durable projection as unknown
  // schema or ignores its rows while deciding whether a merge is safe.
  const storage = withStorage(t);
  const approval = getCanonicalOpportunityMergeApproval({
    exceptionId: '8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571',
    survivorId: 'opp_cd57a315-feaf-4158-a02e-4bdde97a922e',
    supersededId: 'opp_c92d0c73-6a47-4fed-b528-6f310745e448',
  });
  for (const id of [approval.survivorId, approval.supersededId]) {
    await storage.upsertDealHunterOpportunity({
      opportunity_id: id,
      created_at: '2026-08-21T15:00:29.815Z',
      updated_at: '2026-08-26T19:00:00.000Z',
      canonical_name: approval.approvedFacts.canonicalName,
      canonical_recipient: 'broker@example.test',
      canonical_location: approval.approvedFacts.canonicalLocation,
      primary_submission_id: null,
      identity_version: approval.expectedEvidenceVersion,
      status: approval.expectedOpportunityStatus,
      metadata: {
        identitySnapshot: {
          name: approval.approvedFacts.identityName,
          description: 'x'.repeat(approval.approvedFacts.identityDescriptionLength),
          recipient: 'broker@example.test',
          location: approval.approvedFacts.canonicalLocation.toLowerCase(),
          city: approval.approvedFacts.city,
          county: approval.approvedFacts.county,
          state: approval.approvedFacts.state,
          country: approval.approvedFacts.country,
          askingPrice: approval.approvedFacts.askingPrice,
          revenue: approval.approvedFacts.revenue,
          profit: approval.approvedFacts.profit,
          sourceIds: ['sheet 0'],
          listingIds: approval.approvedFacts.listingIds,
          listingUrl: approval.approvedFacts.listingUrl,
        },
      },
    });
  }
  for (const [index, alias] of approval.expectedAliases.entries()) {
    await storage.upsertDealHunterOpportunityAlias({
      id: `merge-guard-alias-${index}`,
      opportunity_id: alias.opportunityId,
      alias_type: alias.aliasType,
      alias_value: alias.aliasValue,
      alias_key: alias.aliasKey,
      source: 'merge-guard-test',
      first_observed_at: '2026-08-21T15:00:29.815Z',
      last_observed_at: '2026-08-26T19:00:00.000Z',
      evidence_version: approval.expectedEvidenceVersion,
      resolution_method: 'exact-alias',
      confidence_state: 'exact',
      resolved_by: 'deal-hunter-review',
      metadata: {},
    });
  }
  await storage.upsertDealHunterIdentityException({
    id: approval.exceptionId,
    created_at: '2026-08-21T15:00:29.815Z',
    updated_at: '2026-08-26T19:00:00.000Z',
    status: approval.expectedExceptionStatus,
    observed_deal_key: null,
    observed_name: approval.approvedFacts.canonicalName,
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: [approval.supersededId, approval.survivorId],
    reason: approval.expectedExceptionReason,
    evidence_version: approval.expectedEvidenceVersion,
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: {},
  });
  await storage.upsertDealHunterOpportunityFact(factRecord({
    id: 'merge-guard-fact',
    opportunity_id: approval.survivorId,
  }));
  await storage.upsertDealHunterOpportunitySourceObservation(observationRecord({
    id: 'merge-guard-observation',
    opportunity_id: approval.survivorId,
  }));

  const inventory = new Map(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries
    .map((entry) => [`${entry.table}.${entry.column}`, entry]));
  assert.equal(
    inventory.get('deal_hunter_opportunity_facts.opportunity_id')?.category,
    CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
  );
  assert.equal(
    inventory.get('deal_hunter_opportunity_source_observations.opportunity_id')?.category,
    CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
  );
  assert.equal(
    inventory.get('deal_hunter_opportunity_source_observations.source_id')?.category,
    CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
  );

  await assert.rejects(
    storage.inspectDealHunterCanonicalOpportunityMerge({
      approval,
      actor: 'acquisition-admin',
      reason: 'Verify durable fact projections block a canonical merge.',
    }),
    /unexpected dependent state: operatorFacts, sourceObservations/,
  );
  assert.deepEqual((await storage.listDealHunterOpportunityFacts(approval.survivorId)).map((fact) => fact.id), ['merge-guard-fact']);
  assert.deepEqual(
    (await storage.listDealHunterOpportunitySourceObservations(approval.survivorId)).map((observation) => observation.id),
    ['merge-guard-observation'],
  );
});
