import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  buildCimOpportunityAliases,
  createCimRecipientOverride,
  getCimIdentityOperationsStatus,
  resolveDealHunterOpportunity,
  resolveCimIdentityException,
} from '../server/services/cimOpportunityIdentity.js';
import {
  findExistingDealHunterSubmission,
  parseSheetCsvDeals,
  repairDealHunterCrmSourceFields,
} from '../server/services/dealHunter.js';
import { createManualSubmission } from '../server/services/submissions.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const sqliteStoragePaths = new WeakMap();

function sqliteStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-current-opportunity-'));
  const sqlitePath = path.join(directory, 'current-opportunity.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  sqliteStoragePaths.set(storage, sqlitePath);
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

function sharedSqliteStorages(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-current-opportunity-shared-'));
  const sqlitePath = path.join(directory, 'current-opportunity.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const storages = [createSqliteStorage(config), createSqliteStorage(config)];
  for (const storage of storages) sqliteStoragePaths.set(storage, sqlitePath);
  t.after(() => {
    for (const storage of storages) storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storages;
}

function twoPartyBarrier() {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await ready;
  };
}

function storageWithRaceGate(storage, methodName, barrier) {
  return new Proxy(storage, {
    get(target, property) {
      if (property === methodName) {
        return async (...args) => {
          const result = await target[property](...args);
          await barrier();
          return result;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withRawSqlite(storage, callback) {
  const database = new Database(sqliteStoragePaths.get(storage));
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function deleteAliasOwner(storage, opportunityId) {
  withRawSqlite(storage, (database) => {
    database.prepare('DELETE FROM deal_hunter_opportunities WHERE opportunity_id = ?').run(opportunityId);
  });
}

async function seedOpportunity(storage, {
  opportunityId,
  status = 'active',
  metadata = {},
} = {}) {
  const timestamp = '2026-08-27T08:00:00.000Z';
  return storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: timestamp,
    updated_at: timestamp,
    canonical_name: `Opportunity ${opportunityId}`,
    canonical_recipient: null,
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status,
    metadata,
  });
}

async function seedAlias(storage, {
  aliasKey,
  opportunityId,
  observedAt = '2026-08-27T08:05:00.000Z',
} = {}) {
  const separator = aliasKey.indexOf(':');
  return storage.upsertDealHunterOpportunityAlias({
    id: `alias-${opportunityId}-${aliasKey.replace(/[^a-z0-9]+/gi, '-')}`,
    opportunity_id: opportunityId,
    alias_type: aliasKey.slice(0, separator),
    alias_value: aliasKey.slice(separator + 1),
    alias_key: aliasKey,
    source: 'current-opportunity-test',
    first_observed_at: observedAt,
    last_observed_at: observedAt,
    evidence_version: 'current-opportunity-test-v1',
    resolution_method: 'fixture',
    confidence_state: 'exact',
    resolved_by: 'test',
    metadata: {},
  });
}

async function supersedeOpportunity(storage, opportunityId, metadata = null) {
  const opportunity = await storage.getDealHunterOpportunity(opportunityId);
  return storage.upsertDealHunterOpportunity({
    ...opportunity,
    updated_at: '2026-08-27T08:10:00.000Z',
    status: 'superseded',
    metadata: metadata || opportunity.metadata || {},
  });
}

function supabaseOpportunityClient(rows) {
  let filters = [];
  const filteredRows = () => rows.filter((row) => filters.every(({ kind, column, value }) => (
    kind === 'eq' ? row[column] === value : value.includes(row[column])
  )));
  const chain = {
    from(table) {
      assert.equal(table, 'deal_hunter_opportunities');
      filters = [];
      return chain;
    },
    select() {
      return chain;
    },
    eq(column, value) {
      filters.push({ kind: 'eq', column, value });
      return chain;
    },
    in(column, values) {
      filters.push({ kind: 'in', column, value: values });
      return chain;
    },
    order() {
      return chain;
    },
    async maybeSingle() {
      return { data: filteredRows()[0] || null, error: null };
    },
    async range(start, end) {
      return { data: filteredRows().slice(start, end + 1), error: null };
    },
  };
  return chain;
}

function supabaseStorage(rows) {
  return createSupabaseStorage(
    {
      storage: {
        supabaseUrl: 'https://project.supabase.invalid',
        supabaseServiceRoleKey: 'service-role-key',
      },
    },
    { client: supabaseOpportunityClient(rows) },
  );
}

function supabaseAliasStorage({ opportunity, alias, opportunities = null, aliases = null }) {
  const opportunityRows = opportunities || [opportunity].filter(Boolean);
  const aliasRows = aliases || [alias].filter(Boolean);
  const client = {
    from(table) {
      if (table === 'deal_hunter_opportunity_aliases') {
        let aliasKeys = [];
        const query = {
          select() {
            return query;
          },
          in(column, values) {
            assert.equal(column, 'alias_key');
            aliasKeys = values;
            return query;
          },
          order() {
            return query;
          },
          async limit(limit) {
            return {
              data: aliasRows
                .filter((candidate) => aliasKeys.includes(candidate.alias_key))
                .slice(0, limit)
                .map(({ opportunity_id }) => ({ opportunity_id })),
              error: null,
            };
          },
          async range(start, end) {
            return {
              data: aliasRows
                .filter((candidate) => aliasKeys.includes(candidate.alias_key))
                .sort((left, right) => left.alias_key.localeCompare(right.alias_key))
                .slice(start, end + 1)
                .map(({ opportunity_id }) => ({ opportunity_id })),
              error: null,
            };
          },
        };
        return query;
      }
      assert.equal(table, 'deal_hunter_opportunities');
      let opportunityId = '';
      let opportunityIds = [];
      let status = '';
      const query = {
        select() {
          return query;
        },
        eq(column, value) {
          if (column === 'opportunity_id') opportunityId = value;
          else if (column === 'status') status = value;
          else assert.fail(`unexpected opportunity filter ${column}`);
          return query;
        },
        in(column, values) {
          assert.equal(column, 'opportunity_id');
          opportunityIds = values;
          return query;
        },
        order() {
          return query;
        },
        async range(start, end) {
          return {
            data: opportunityRows
              .filter((candidate) => opportunityIds.includes(candidate.opportunity_id))
              .sort((left, right) => left.opportunity_id.localeCompare(right.opportunity_id))
              .slice(start, end + 1)
              .map((candidate) => ({ ...candidate })),
            error: null,
          };
        },
        async maybeSingle() {
          const match = opportunityRows.find((candidate) => candidate.opportunity_id === opportunityId
            && (!status || candidate.status === status));
          return { data: match ? { ...match } : null, error: null };
        },
      };
      return query;
    },
  };
  return createSupabaseStorage(
    {
      storage: {
        supabaseUrl: 'https://project.supabase.invalid',
        supabaseServiceRoleKey: 'service-role-key',
      },
    },
    { client },
  );
}

function identityDeal(overrides = {}) {
  return {
    dealKey: 'url:https://broker.example/listing/historical-42',
    dealKeyAliases: [],
    identityAliases: ['marketplace:historical-42'],
    sourceId: 'sheet-0',
    sourceName: 'Daily Deal Hunter',
    id: '42',
    stableExternalId: false,
    name: 'Commercial HVAC Service Contractor',
    description: 'Established commercial HVAC contractor with recurring maintenance agreements, trained technicians, installation, repair, replacement, and emergency field service revenue.',
    location: 'Las Vegas, NV',
    city: 'Las Vegas',
    state: 'NV',
    country: 'US',
    annualProfit: 500000,
    annualRevenue: 4500000,
    askingPrice: 5000000,
    brokerName: 'Historical Broker',
    brokerEmail: 'broker@example.test',
    listingUrl: 'https://broker.example/listing/historical-42',
    sourceRecords: [{ sourceId: 'sheet-0' }],
    ...overrides,
  };
}

test('SQLite historical lookup returns a superseded row while current lookup rejects it', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, {
    opportunityId: 'opp-superseded',
    status: 'superseded',
    metadata: { canonicalOpportunityMerge: { mergedInto: 'opp-survivor' } },
  });

  assert.equal((await storage.getDealHunterOpportunity('opp-superseded')).status, 'superseded');
  assert.equal(await storage.getCurrentDealHunterOpportunity('opp-superseded'), null);
});

test('SQLite current opportunity listings include only active rows', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-active' });
  await seedOpportunity(storage, { opportunityId: 'opp-superseded', status: 'superseded' });

  assert.deepEqual(
    (await storage.listDealHunterOpportunities({ limit: 10 }))
      .map((row) => row.opportunity_id).sort(),
    ['opp-active', 'opp-superseded'],
  );
  assert.deepEqual(
    (await storage.listCurrentDealHunterOpportunities({ limit: 10 }))
      .map((row) => row.opportunity_id),
    ['opp-active'],
  );
});

test('SQLite current alias lookup fails closed when the only owner is superseded', async (t) => {
  const storage = sqliteStorage(t);
  const aliasKey = 'listing-id:historical-listing-42';
  await seedOpportunity(storage, { opportunityId: 'opp-superseded' });
  await seedAlias(storage, { aliasKey, opportunityId: 'opp-superseded' });
  await supersedeOpportunity(storage, 'opp-superseded');

  assert.equal(
    (await storage.findDealHunterOpportunityByAliases([aliasKey])).opportunity_id,
    'opp-superseded',
  );
  await assert.rejects(
    storage.findCurrentDealHunterOpportunityByAliases([aliasKey]),
    /alias.*non-current|non-current.*alias/i,
  );
});

test('SQLite historical and current alias lookup return the one complete active owner', async (t) => {
  const storage = sqliteStorage(t);
  const aliasKey = 'listing-id:one-active-owner';
  await seedOpportunity(storage, { opportunityId: 'opp-one-active-owner' });
  await seedAlias(storage, { aliasKey, opportunityId: 'opp-one-active-owner' });

  assert.equal(
    (await storage.findDealHunterOpportunityByAliases([aliasKey])).opportunity_id,
    'opp-one-active-owner',
  );
  assert.equal(
    (await storage.findCurrentDealHunterOpportunityByAliases([aliasKey])).opportunity_id,
    'opp-one-active-owner',
  );
});

test('SQLite historical and current alias lookup fail closed for an orphan-only owner', async (t) => {
  const storage = sqliteStorage(t);
  const aliasKey = 'listing-id:orphan-only-owner';
  await seedOpportunity(storage, { opportunityId: 'opp-orphan-only-owner' });
  await seedAlias(storage, { aliasKey, opportunityId: 'opp-orphan-only-owner' });
  deleteAliasOwner(storage, 'opp-orphan-only-owner');

  for (const lookup of [
    storage.findDealHunterOpportunityByAliases.bind(storage),
    storage.findCurrentDealHunterOpportunityByAliases.bind(storage),
  ]) {
    await assert.rejects(
      lookup([aliasKey]),
      (error) => error?.code === 'DEAL_HUNTER_OPPORTUNITY_ALIAS_INTEGRITY',
    );
  }
});

test('SQLite complete owner validation rejects active plus orphan ownership', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-active-with-orphan' });
  await seedOpportunity(storage, { opportunityId: 'opp-orphan-with-active' });
  await seedAlias(storage, {
    aliasKey: 'listing-id:active-with-orphan',
    opportunityId: 'opp-active-with-orphan',
  });
  await seedAlias(storage, {
    aliasKey: 'listing-id:orphan-with-active',
    opportunityId: 'opp-orphan-with-active',
  });
  deleteAliasOwner(storage, 'opp-orphan-with-active');
  const aliasKeys = ['listing-id:active-with-orphan', 'listing-id:orphan-with-active'];

  for (const lookup of [
    storage.findDealHunterOpportunityByAliases.bind(storage),
    storage.findCurrentDealHunterOpportunityByAliases.bind(storage),
  ]) {
    await assert.rejects(
      lookup(aliasKeys),
      (error) => error?.code === 'DEAL_HUNTER_OPPORTUNITY_ALIAS_INTEGRITY',
    );
  }
});

test('SQLite complete owner validation rejects active plus orphan plus another active owner', async (t) => {
  const storage = sqliteStorage(t);
  for (const opportunityId of ['opp-complete-owner-a', 'opp-complete-owner-orphan', 'opp-complete-owner-c']) {
    await seedOpportunity(storage, { opportunityId });
  }
  const aliases = [
    ['listing-id:complete-owner-a', 'opp-complete-owner-a'],
    ['listing-id:complete-owner-orphan', 'opp-complete-owner-orphan'],
    ['listing-id:complete-owner-c', 'opp-complete-owner-c'],
  ];
  for (const [aliasKey, opportunityId] of aliases) {
    await seedAlias(storage, { aliasKey, opportunityId });
  }
  deleteAliasOwner(storage, 'opp-complete-owner-orphan');

  for (const lookup of [
    storage.findDealHunterOpportunityByAliases.bind(storage),
    storage.findCurrentDealHunterOpportunityByAliases.bind(storage),
  ]) {
    await assert.rejects(
      lookup(aliases.map(([aliasKey]) => aliasKey)),
      (error) => error?.code === 'DEAL_HUNTER_OPPORTUNITY_ALIAS_INTEGRITY',
    );
  }
});

test('SQLite current alias lookup detects a minority owner beyond newer aliases from one owner', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-alias-majority' });
  await seedOpportunity(storage, { opportunityId: 'opp-alias-minority' });
  await seedAlias(storage, {
    aliasKey: 'listing-id:majority-newest',
    opportunityId: 'opp-alias-majority',
    observedAt: '2026-08-27T08:07:00.000Z',
  });
  await seedAlias(storage, {
    aliasKey: 'url:https://broker.example/majority-next',
    opportunityId: 'opp-alias-majority',
    observedAt: '2026-08-27T08:06:00.000Z',
  });
  await seedAlias(storage, {
    aliasKey: 'marketplace:minority-older',
    opportunityId: 'opp-alias-minority',
    observedAt: '2026-08-27T08:05:00.000Z',
  });

  await assert.rejects(
    storage.findCurrentDealHunterOpportunityByAliases([
      'listing-id:majority-newest',
      'url:https://broker.example/majority-next',
      'marketplace:minority-older',
    ]),
    /conflicting.*aliases/i,
  );
  await assert.rejects(
    storage.findDealHunterOpportunityByAliases([
      'listing-id:majority-newest',
      'url:https://broker.example/majority-next',
      'marketplace:minority-older',
    ]),
    /conflicting.*aliases/i,
  );
});

test('SQLite historical alias lookup sees an older minority owner behind many newer majority rows', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-historical-majority' });
  await seedOpportunity(storage, { opportunityId: 'opp-historical-minority' });
  const majorityAliases = Array.from({ length: 25 }, (_, index) => ({
    aliasKey: `listing-id:historical-majority-${String(index).padStart(2, '0')}`,
    opportunityId: 'opp-historical-majority',
    observedAt: `2026-08-27T09:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  for (const alias of majorityAliases) await seedAlias(storage, alias);
  const minorityAlias = {
    aliasKey: 'listing-id:historical-minority-oldest',
    opportunityId: 'opp-historical-minority',
    observedAt: '2026-08-26T09:00:00.000Z',
  };
  await seedAlias(storage, minorityAlias);

  await assert.rejects(
    storage.findDealHunterOpportunityByAliases([
      ...majorityAliases.map(({ aliasKey }) => aliasKey),
      minorityAlias.aliasKey,
    ]),
    /conflicting.*aliases/i,
  );
});

test('SQLite opportunity upsert cannot reactivate or rewrite a superseded historical row', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-no-resurrection' });
  await supersedeOpportunity(storage, 'opp-no-resurrection', {
    canonicalOpportunityMerge: { mergedInto: 'opp-survivor' },
    immutableHistoricalMarker: 'before-race',
  });
  const before = await storage.getDealHunterOpportunity('opp-no-resurrection');

  const attempted = await storage.upsertDealHunterOpportunity({
    ...before,
    updated_at: '2026-08-27T08:20:00.000Z',
    canonical_name: 'Concurrent observation must not rewrite history',
    status: 'active',
    metadata: { immutableHistoricalMarker: 'after-race' },
  });

  assert.deepEqual(attempted, before);
  assert.equal(await storage.getCurrentDealHunterOpportunity('opp-no-resurrection'), null);
});

test('Supabase historical lookup returns a superseded row while current lookup rejects it', async () => {
  const storage = supabaseStorage([{
    opportunity_id: 'opp-superseded',
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_name: 'Historical Opportunity',
    canonical_recipient: null,
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status: 'superseded',
    metadata: { canonicalOpportunityMerge: { mergedInto: 'opp-survivor' } },
  }]);

  assert.equal((await storage.getDealHunterOpportunity('opp-superseded')).status, 'superseded');
  assert.equal(await storage.getCurrentDealHunterOpportunity('opp-superseded'), null);
});

test('Supabase current opportunity listings include only active rows', async () => {
  const common = {
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_recipient: null,
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    metadata: {},
  };
  const storage = supabaseStorage([
    { ...common, opportunity_id: 'opp-active', canonical_name: 'Active', status: 'active' },
    { ...common, opportunity_id: 'opp-superseded', canonical_name: 'Historical', status: 'superseded' },
  ]);

  assert.deepEqual(
    (await storage.listDealHunterOpportunities({ limit: 10 }))
      .map((row) => row.opportunity_id).sort(),
    ['opp-active', 'opp-superseded'],
  );
  assert.deepEqual(
    (await storage.listCurrentDealHunterOpportunities({ limit: 10 }))
      .map((row) => row.opportunity_id),
    ['opp-active'],
  );
});

test('Supabase current alias lookup fails closed when the only owner is superseded', async () => {
  const aliasKey = 'listing-id:historical-listing-42';
  const storage = supabaseAliasStorage({
    opportunity: {
      opportunity_id: 'opp-superseded',
      created_at: '2026-08-27T08:00:00.000Z',
      updated_at: '2026-08-27T08:00:00.000Z',
      canonical_name: 'Historical Opportunity',
      canonical_recipient: null,
      canonical_location: 'Las Vegas, NV',
      primary_submission_id: null,
      identity_version: 'current-opportunity-test-v1',
      status: 'superseded',
      metadata: {},
    },
    alias: { alias_key: aliasKey, opportunity_id: 'opp-superseded' },
  });

  assert.equal(
    (await storage.findDealHunterOpportunityByAliases([aliasKey])).opportunity_id,
    'opp-superseded',
  );
  await assert.rejects(
    storage.findCurrentDealHunterOpportunityByAliases([aliasKey]),
    /alias.*non-current|non-current.*alias/i,
  );
});

test('Supabase current alias lookup pages through every requested alias before choosing an owner', async () => {
  const common = {
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_recipient: null,
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status: 'active',
    metadata: {},
  };
  const majorityAliases = Array.from({ length: 100 }, (_, index) => ({
    alias_key: `listing-id:majority-${String(index).padStart(3, '0')}`,
    opportunity_id: 'opp-alias-majority',
  }));
  const minorityAlias = {
    alias_key: 'listing-id:minority-100',
    opportunity_id: 'opp-alias-minority',
  };
  const aliases = [...majorityAliases, minorityAlias];
  const storage = supabaseAliasStorage({
    opportunities: [
      { ...common, opportunity_id: 'opp-alias-majority', canonical_name: 'Majority owner' },
      { ...common, opportunity_id: 'opp-alias-minority', canonical_name: 'Minority owner' },
    ],
    aliases,
  });

  await assert.rejects(
    storage.findCurrentDealHunterOpportunityByAliases(aliases.map(({ alias_key }) => alias_key)),
    /conflicting.*aliases/i,
  );
});

test('Supabase historical alias lookup pages beyond the former first-page owner bound', async () => {
  const common = {
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_recipient: null,
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status: 'active',
    metadata: {},
  };
  const majorityAliases = Array.from({ length: 100 }, (_, index) => ({
    alias_key: `listing-id:historical-page-majority-${String(index).padStart(3, '0')}`,
    opportunity_id: 'opp-historical-page-majority',
  }));
  const minorityAlias = {
    alias_key: 'listing-id:historical-page-minority-100',
    opportunity_id: 'opp-historical-page-minority',
  };
  const aliases = [...majorityAliases, minorityAlias];
  const storage = supabaseAliasStorage({
    opportunities: [
      { ...common, opportunity_id: 'opp-historical-page-majority', canonical_name: 'Majority owner' },
      { ...common, opportunity_id: 'opp-historical-page-minority', canonical_name: 'Minority owner' },
    ],
    aliases,
  });

  await assert.rejects(
    storage.findDealHunterOpportunityByAliases(aliases.map(({ alias_key }) => alias_key)),
    /conflicting.*aliases/i,
  );
});

test('Supabase historical and current alias lookup distinguish an orphan owner from non-current history', async () => {
  const aliasKey = 'listing-id:supabase-orphan-owner';
  const storage = supabaseAliasStorage({
    opportunities: [],
    aliases: [{ alias_key: aliasKey, opportunity_id: 'opp-supabase-orphan-owner' }],
  });

  for (const lookup of [
    storage.findDealHunterOpportunityByAliases.bind(storage),
    storage.findCurrentDealHunterOpportunityByAliases.bind(storage),
  ]) {
    await assert.rejects(
      lookup([aliasKey]),
      (error) => error?.code === 'DEAL_HUNTER_OPPORTUNITY_ALIAS_INTEGRITY',
    );
  }
});

test('Supabase opportunity upsert uses the atomic no-resurrection RPC', async () => {
  const calls = [];
  const historical = {
    opportunity_id: 'opp-no-resurrection',
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:10:00.000Z',
    canonical_name: 'Preserved historical row',
    canonical_recipient: null,
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status: 'superseded',
    metadata: { immutableHistoricalMarker: 'before-race' },
  };
  const storage = createSupabaseStorage(
    {
      storage: {
        supabaseUrl: 'https://project.supabase.invalid',
        supabaseServiceRoleKey: 'service-role-key',
      },
    },
    {
      client: {
        async rpc(name, payload) {
          calls.push({ name, payload });
          return { data: historical, error: null };
        },
      },
    },
  );

  const result = await storage.upsertDealHunterOpportunity({
    ...historical,
    status: 'active',
    metadata: { immutableHistoricalMarker: 'after-race' },
  });

  assert.equal(result.status, 'superseded');
  assert.equal(result.metadata.immutableHistoricalMarker, 'before-race');
  assert.deepEqual(calls, [{
    name: 'upsert_deal_hunter_opportunity',
    payload: {
      p_record: {
        ...historical,
        status: 'active',
        metadata: { immutableHistoricalMarker: 'after-race' },
      },
    },
  }]);
});

test('Supabase automatic opportunity-and-alias acquisition uses one atomic RPC', async () => {
  const calls = [];
  const proposed = {
    opportunity_id: 'opp-proposed-supabase-atomic',
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_name: 'Proposed Opportunity',
    canonical_recipient: 'broker@example.test',
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status: 'active',
    metadata: { proposed: true },
  };
  const existing = {
    ...proposed,
    opportunity_id: 'opp-existing-supabase-owner',
    canonical_name: 'Existing Opportunity',
    metadata: { existing: true },
  };
  const alias = {
    id: 'alias-supabase-atomic',
    opportunity_id: proposed.opportunity_id,
    alias_type: 'listing-id',
    alias_value: 'supabase-atomic',
    alias_key: 'listing-id:supabase-atomic',
    source: 'current-opportunity-test',
    first_observed_at: proposed.created_at,
    last_observed_at: proposed.updated_at,
    evidence_version: 'current-opportunity-test-v1',
    resolution_method: 'new-opportunity',
    confidence_state: 'exact',
    resolved_by: 'test',
    metadata: { observed: true },
  };
  const storage = createSupabaseStorage(
    {
      storage: {
        supabaseUrl: 'https://project.supabase.invalid',
        supabaseServiceRoleKey: 'service-role-key',
      },
    },
    {
      client: {
        async rpc(name, payload) {
          calls.push({ name, payload });
          return {
            data: {
              created: false,
              linked: true,
              conflict: null,
              opportunity: existing,
              aliases: [{ ...alias, opportunity_id: existing.opportunity_id }],
              identityException: null,
            },
            error: null,
          };
        },
      },
    },
  );

  const result = await storage.createDealHunterOpportunityWithAliases({
    opportunity: proposed,
    aliases: [alias],
    existingOwnerMode: 'return-current',
  });

  assert.equal(result.created, false);
  assert.equal(result.linked, true);
  assert.equal(result.opportunity.opportunity_id, existing.opportunity_id);
  assert.deepEqual(result.aliases.map((record) => record.opportunity_id), [existing.opportunity_id]);
  assert.deepEqual(calls, [{
    name: 'create_deal_hunter_opportunity_with_aliases',
    payload: {
      p_opportunity: proposed,
      p_aliases: [alias],
      p_existing_owner_mode: 'return-current',
      p_identity_exception: null,
    },
  }]);
});

test('Supabase manual keep-distinct sends exception resolution through the same atomic RPC', async () => {
  const calls = [];
  const opportunity = {
    opportunity_id: 'opp-supabase-manual-distinct',
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_name: 'Manual Distinct Opportunity',
    canonical_recipient: 'broker@example.test',
    canonical_location: null,
    primary_submission_id: null,
    identity_version: 'current-opportunity-test-v1',
    status: 'active',
    metadata: {},
  };
  const alias = {
    id: 'alias-supabase-manual-distinct',
    opportunity_id: opportunity.opportunity_id,
    alias_type: 'listing-id',
    alias_value: 'manual-distinct',
    alias_key: 'listing-id:manual-distinct',
    source: 'manual-identity-resolution',
    first_observed_at: opportunity.created_at,
    last_observed_at: opportunity.updated_at,
    evidence_version: 'current-opportunity-test-v1',
    resolution_method: 'manual-keep-distinct',
    confidence_state: 'manual',
    resolved_by: 'test',
    metadata: {},
  };
  const identityException = {
    id: 'exception-supabase-manual-distinct',
    created_at: opportunity.created_at,
    updated_at: opportunity.updated_at,
    status: 'resolved',
    observed_deal_key: alias.alias_key,
    observed_name: opportunity.canonical_name,
    observed_recipient: opportunity.canonical_recipient,
    candidate_opportunity_ids: [],
    reason: 'manual-review',
    evidence_version: 'current-opportunity-test-v1',
    resolved_at: opportunity.updated_at,
    resolved_by: 'test',
    resolution_reason: 'Confirmed as a distinct listing.',
    metadata: { resolvedOpportunityId: opportunity.opportunity_id },
  };
  const storage = createSupabaseStorage(
    {
      storage: {
        supabaseUrl: 'https://project.supabase.invalid',
        supabaseServiceRoleKey: 'service-role-key',
      },
    },
    {
      client: {
        async rpc(name, payload) {
          calls.push({ name, payload });
          return {
            data: {
              created: true,
              linked: true,
              conflict: null,
              opportunity,
              aliases: [alias],
              identityException,
            },
            error: null,
          };
        },
      },
    },
  );

  const result = await storage.createDealHunterOpportunityWithAliases({
    opportunity,
    aliases: [alias],
    existingOwnerMode: 'conflict',
    identityException,
  });

  assert.equal(result.created, true);
  assert.equal(result.identityException.id, identityException.id);
  assert.deepEqual(calls, [{
    name: 'create_deal_hunter_opportunity_with_aliases',
    payload: {
      p_opportunity: opportunity,
      p_aliases: [alias],
      p_existing_owner_mode: 'conflict',
      p_identity_exception: identityException,
    },
  }]);
});

test('automatic resolution fails closed without resurrecting or replacing a superseded alias owner', async (t) => {
  const storage = sqliteStorage(t);
  const deal = identityDeal();
  const alias = buildCimOpportunityAliases(deal)[0];
  await seedOpportunity(storage, { opportunityId: 'opp-superseded' });
  await seedAlias(storage, { aliasKey: alias.alias_key, opportunityId: 'opp-superseded' });
  await supersedeOpportunity(storage, 'opp-superseded', {
    canonicalOpportunityMerge: { mergedInto: 'opp-survivor' },
  });
  const before = await storage.getDealHunterOpportunity('opp-superseded');

  const resolution = await resolveDealHunterOpportunity({ deal, storage, actor: 'test' });

  assert.equal(resolution.ok, false);
  assert.equal(resolution.status, 'ambiguous');
  assert.equal(resolution.identityException.reason, 'non-current-canonical-alias');
  assert.deepEqual(resolution.identityException.candidate_opportunity_ids, ['opp-superseded']);
  assert.equal((await storage.listDealHunterOpportunities({ limit: 10 })).length, 1);
  assert.deepEqual(await storage.getDealHunterOpportunity('opp-superseded'), before);
});

test('concurrent automatic SQLite resolution creates one owner and no active aliasless orphan', async (t) => {
  const [firstStorage, secondStorage] = sharedSqliteStorages(t);
  const barrier = twoPartyBarrier();
  const firstRacer = storageWithRaceGate(firstStorage, 'listCurrentDealHunterOpportunities', barrier);
  const secondRacer = storageWithRaceGate(secondStorage, 'listCurrentDealHunterOpportunities', barrier);

  const [first, second] = await Promise.all([
    resolveDealHunterOpportunity({ deal: identityDeal(), storage: firstRacer, actor: 'automatic-race-a' }),
    resolveDealHunterOpportunity({ deal: identityDeal(), storage: secondRacer, actor: 'automatic-race-b' }),
  ]);

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.opportunityId, second.opportunityId);
  const opportunities = await firstStorage.listDealHunterOpportunities({ limit: 20 });
  const aliases = await firstStorage.listDealHunterOpportunityAliases({ limit: 100 });
  const aliasOwnerIds = new Set(aliases.map((alias) => alias.opportunity_id));
  assert.equal(opportunities.filter((opportunity) => opportunity.status === 'active').length, 1);
  assert.equal(aliasOwnerIds.size, 1);
  assert.deepEqual([...aliasOwnerIds], [first.opportunityId]);
  assert.deepEqual(
    opportunities.filter((opportunity) => opportunity.status === 'active'
      && !aliasOwnerIds.has(opportunity.opportunity_id)),
    [],
  );
});

test('automatic resolution treats a lookup-to-upsert supersession race as a non-current conflict before alias mutation', async () => {
  const activeSnapshot = {
    opportunity_id: 'opp-raced-to-superseded',
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    canonical_name: 'Commercial HVAC Service Contractor',
    canonical_recipient: 'broker@example.test',
    canonical_location: 'Las Vegas, NV',
    primary_submission_id: null,
    identity_version: 'cim-opportunity-v1',
    status: 'active',
    metadata: {},
  };
  const supersededSnapshot = {
    ...activeSnapshot,
    updated_at: '2026-08-27T08:01:00.000Z',
    status: 'superseded',
    metadata: { canonicalOpportunityMerge: { mergedInto: 'opp-survivor' } },
  };
  let aliasMutations = 0;
  let storedException = null;
  const storage = {
    async findCurrentDealHunterOpportunityByAliases() { return activeSnapshot; },
    async getCurrentDealHunterOpportunity() { return null; },
    async listCurrentDealHunterOpportunities() { return []; },
    async upsertDealHunterOpportunity() { return supersededSnapshot; },
    async upsertDealHunterOpportunityAlias(record) {
      aliasMutations += 1;
      return record;
    },
    async upsertDealHunterIdentityException(record) {
      storedException = record;
      return record;
    },
  };

  const resolution = await resolveDealHunterOpportunity({
    deal: identityDeal(),
    storage,
    actor: 'race-test',
  });

  assert.equal(resolution.ok, false);
  assert.equal(resolution.identityException.reason, 'non-current-canonical-alias');
  assert.deepEqual(resolution.identityException.candidate_opportunity_ids, ['opp-raced-to-superseded']);
  assert.equal(aliasMutations, 0);
  assert.equal(storedException?.reason, 'non-current-canonical-alias');
});

test('semantic resolution never selects a superseded high-similarity candidate', async (t) => {
  const storage = sqliteStorage(t);
  const first = await resolveDealHunterOpportunity({ deal: identityDeal(), storage, actor: 'test' });
  assert.equal(first.ok, true);
  await storage.upsertDealHunterOpportunity({
    ...first.opportunity,
    updated_at: '2026-08-27T09:00:00.000Z',
    status: 'superseded',
    metadata: {
      ...first.opportunity.metadata,
      canonicalOpportunityMerge: { mergedInto: 'opp-active-survivor' },
    },
  });

  const resolution = await resolveDealHunterOpportunity({
    deal: identityDeal({
      dealKey: 'url:https://syndicator.example/listing/new-99',
      identityAliases: ['syndicator:new-99'],
      listingUrl: 'https://syndicator.example/listing/new-99',
      description: `${identityDeal().description} Updated syndicated marketing copy.`,
    }),
    storage,
    actor: 'test',
  });

  assert.equal(resolution.ok, true, JSON.stringify(resolution));
  assert.notEqual(resolution.opportunityId, first.opportunityId);
  assert.equal((await storage.getDealHunterOpportunity(first.opportunityId)).status, 'superseded');
});

test('identity operations status counts active opportunities without hiding historical rows', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-active' });
  await seedOpportunity(storage, { opportunityId: 'opp-superseded', status: 'superseded' });
  const config = {
    dealHunter: {
      cimFollowUp: {
        sendWindowStart: '08:00',
        sendWindowEnd: '17:00',
        timezone: 'America/Los_Angeles',
        weekdaysOnly: true,
      },
      cimOutreach: { paused: false, recipientCap24Hours: 1, recipientCap30Days: 4 },
    },
  };

  const status = await getCimIdentityOperationsStatus({ storage, config });

  assert.equal(status.canonicalOpportunities, 1);
  assert.equal((await storage.listDealHunterOpportunities({ limit: 10 })).length, 2);
});

test('manual identity linking rejects a superseded target before any mutation and never redirects', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-survivor' });
  await seedOpportunity(storage, {
    opportunityId: 'opp-superseded',
    status: 'superseded',
    metadata: { canonicalOpportunityMerge: { mergedInto: 'opp-survivor' } },
  });
  const identityException = await storage.upsertDealHunterIdentityException({
    id: 'exception-manual-link',
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:00:00.000Z',
    status: 'open',
    observed_deal_key: 'url:https://broker.example/listing/manual-link',
    observed_name: 'Manual Link Candidate',
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: ['opp-superseded', 'opp-survivor'],
    reason: 'ambiguous-similarity',
    evidence_version: 'cim-opportunity-v1',
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: { aliases: ['listing-id:manual-link-42'] },
  });

  const result = await resolveCimIdentityException({
    exceptionId: identityException.id,
    opportunityId: 'opp-superseded',
    action: 'link',
    confirmed: true,
    reason: 'Operator deliberately tested the historical target.',
    actor: 'manual-link-test',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /superseded|not current/i);
  assert.equal(result.successorOpportunityId, 'opp-survivor');
  assert.deepEqual(
    (await storage.listDealHunterIdentityExceptions({ limit: 10 }))[0],
    identityException,
  );
  assert.deepEqual(await storage.listDealHunterOpportunityAliases({ limit: 10 }), []);
  assert.equal((await storage.getDealHunterOpportunity('opp-survivor')).updated_at, '2026-08-27T08:00:00.000Z');
});

test('manual identity linking to an explicitly selected active opportunity remains unchanged', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-active-manual-target' });
  await storage.upsertDealHunterIdentityException({
    id: 'exception-active-manual-link',
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:00:00.000Z',
    status: 'open',
    observed_deal_key: 'url:https://broker.example/listing/active-manual-link',
    observed_name: 'Active Manual Link Candidate',
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: ['opp-active-manual-target'],
    reason: 'ambiguous-similarity',
    evidence_version: 'cim-opportunity-v1',
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: { aliases: ['listing-id:active-manual-link-42'] },
  });

  const result = await resolveCimIdentityException({
    exceptionId: 'exception-active-manual-link',
    opportunityId: 'opp-active-manual-target',
    action: 'link',
    confirmed: true,
    reason: 'Operator deliberately selected the verified active target.',
    actor: 'manual-link-test',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.opportunity.opportunity_id, 'opp-active-manual-target');
  assert.equal(result.identityException.status, 'resolved');
  assert.equal(
    (await storage.findCurrentDealHunterOpportunityByAliases(['listing-id:active-manual-link-42'])).opportunity_id,
    'opp-active-manual-target',
  );
});

test('concurrent manual keep-distinct creates no orphan and resolves the exception to the sole alias owner', async (t) => {
  const [firstStorage, secondStorage] = sharedSqliteStorages(t);
  await firstStorage.upsertDealHunterIdentityException({
    id: 'exception-concurrent-keep-distinct',
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:00:00.000Z',
    status: 'open',
    observed_deal_key: 'url:https://broker.example/listing/concurrent-keep-distinct',
    observed_name: 'Concurrent Keep Distinct Candidate',
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: [],
    reason: 'ambiguous-similarity',
    evidence_version: 'cim-opportunity-v1',
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: {
      aliases: [
        'listing-id:concurrent-keep-distinct-42',
        'deal-key:url:https://broker.example/listing/concurrent-keep-distinct',
      ],
    },
  });
  const barrier = twoPartyBarrier();
  const firstRacer = storageWithRaceGate(firstStorage, 'listDealHunterOpportunityAliases', barrier);
  const secondRacer = storageWithRaceGate(secondStorage, 'listDealHunterOpportunityAliases', barrier);
  const input = {
    exceptionId: 'exception-concurrent-keep-distinct',
    action: 'keep-distinct',
    confirmed: true,
    reason: 'Operator confirmed this observation must remain a distinct opportunity.',
  };

  const results = await Promise.all([
    resolveCimIdentityException({ ...input, actor: 'manual-race-a', storage: firstRacer }),
    resolveCimIdentityException({ ...input, actor: 'manual-race-b', storage: secondRacer }),
  ]);

  const winner = results.find((result) => result.ok);
  const loser = results.find((result) => !result.ok);
  assert.ok(winner, JSON.stringify(results));
  assert.equal(loser?.status, 409, JSON.stringify(results));
  assert.match(loser?.error || '', /alias|concurrent|exception/i);
  const opportunities = await firstStorage.listDealHunterOpportunities({ limit: 20 });
  const aliases = await firstStorage.listDealHunterOpportunityAliases({ limit: 100 });
  const aliasOwnerIds = new Set(aliases.map((alias) => alias.opportunity_id));
  assert.equal(opportunities.filter((opportunity) => opportunity.status === 'active').length, 1);
  assert.equal(aliasOwnerIds.size, 1);
  assert.deepEqual([...aliasOwnerIds], [winner.opportunity.opportunity_id]);
  assert.deepEqual(
    opportunities.filter((opportunity) => opportunity.status === 'active'
      && !aliasOwnerIds.has(opportunity.opportunity_id)),
    [],
  );
  const [resolvedException] = await firstStorage.listDealHunterIdentityExceptions({ limit: 10 });
  assert.equal(resolvedException.status, 'resolved');
  assert.equal(
    resolvedException.metadata.resolvedOpportunityId,
    winner.opportunity.opportunity_id,
  );
});

test('manual keep-distinct fails closed when the exception has no usable alias set', async (t) => {
  const storage = sqliteStorage(t);
  const identityException = await storage.upsertDealHunterIdentityException({
    id: 'exception-keep-distinct-without-aliases',
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:00:00.000Z',
    status: 'open',
    observed_deal_key: 'unusable-observation-key',
    observed_name: 'Aliasless Keep Distinct Candidate',
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: [],
    reason: 'ambiguous-similarity',
    evidence_version: 'cim-opportunity-v1',
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: { aliases: ['not-an-alias'] },
  });

  const result = await resolveCimIdentityException({
    exceptionId: identityException.id,
    action: 'keep-distinct',
    confirmed: true,
    reason: 'Operator requested a distinct record but supplied no stable alias.',
    actor: 'manual-aliasless-test',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /alias/i);
  assert.deepEqual(await storage.listDealHunterOpportunities({ limit: 10 }), []);
  assert.deepEqual(
    (await storage.listDealHunterIdentityExceptions({ limit: 10 }))[0],
    identityException,
  );
});

test('manual CIM recipient override rejects a superseded canonical opportunity without persisting authority', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-superseded', status: 'superseded' });

  const result = await createCimRecipientOverride({
    opportunityId: 'opp-superseded',
    recipientEmail: 'broker@example.test',
    confirmed: true,
    reason: 'Operator verified the recipient but selected historical identity.',
    actor: 'override-test',
    expiresInHours: 1,
    storage,
    config: { dealHunter: { cimOutreach: { overrideMaxHours: 24 } } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /superseded|not current/i);
  assert.equal(await storage.getActiveDealHunterCimRecipientOverride({
    opportunityId: 'opp-superseded',
    recipientEmail: 'broker@example.test',
    nowIso: new Date().toISOString(),
  }), null);
});

test('manual CRM creation rejects a superseded canonical opportunity before writing a submission', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-superseded', status: 'superseded' });

  const result = await createManualSubmission({
    company: 'Historical HVAC Candidate',
    seller_name: 'Seller Example',
    seller_email: 'seller@example.test',
    deal_hunter_opportunity_id: 'opp-superseded',
  }, 'crm-admin', { storage });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /superseded|not current/i);
  assert.equal((await storage.listSubmissions({ page: 1, limit: 10, status: 'all' })).total, 0);
  assert.equal((await storage.getDealHunterOpportunity('opp-superseded')).status, 'superseded');
});

test('SQLite manual CRM creation revalidates canonical status inside the insert transaction', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-crm-insert-race' });
  let supersededAtMutationBoundary = false;
  const racingStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'mutateWithCrmActivity') {
        return async (mutation) => {
          supersededAtMutationBoundary = true;
          await supersedeOpportunity(target, 'opp-crm-insert-race');
          return target.mutateWithCrmActivity(mutation);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  await assert.rejects(createManualSubmission({
    company: 'Racing HVAC Candidate',
    seller_name: 'Seller Example',
    seller_email: 'seller@example.test',
    deal_hunter_opportunity_id: 'opp-crm-insert-race',
  }, 'crm-admin', { storage: racingStorage }), /superseded|not current/i);

  assert.equal(supersededAtMutationBoundary, true);
  assert.equal((await storage.listSubmissions({ page: 1, limit: 10, status: 'all' })).total, 0);
  assert.equal((await storage.getDealHunterOpportunity('opp-crm-insert-race')).status, 'superseded');
});

test('Supabase CRM insertion routes through the dedicated atomic current-authority RPC', async () => {
  const calls = [];
  const submission = {
    id: '00000000-0000-4000-8000-000000000001',
    deal_hunter_opportunity_id: 'opp-supabase-crm-insert',
  };
  const activity = {
    id: '00000000-0000-4000-8000-000000000002',
    submission_id: submission.id,
    event_type: 'submission.created',
    summary: 'Atomic insert routing test.',
  };
  const storage = createSupabaseStorage(
    {
      storage: {
        supabaseUrl: 'https://project.supabase.invalid',
        supabaseServiceRoleKey: 'service-role-key',
      },
    },
    {
      client: {
        async rpc(name, payload) {
          calls.push({ name, payload });
          return {
            data: { applied: true, record: submission, activity },
            error: null,
          };
        },
      },
    },
  );

  const result = await storage.mutateWithCrmActivity({
    operation: 'insert_submission',
    payload: { submission },
    activity,
  });

  assert.equal(result.applied, true);
  assert.deepEqual(calls, [{
    name: 'insert_submission_with_crm_activity',
    payload: { p_payload: { submission }, p_activity: activity },
  }]);
});

test('SQLite generic CRM updates refuse canonical linkage outside the atomic link primitive', async (t) => {
  const storage = sqliteStorage(t);
  const created = await createManualSubmission({
    company: 'Unlinked CRM Candidate',
    seller_name: 'Seller Example',
    seller_email: 'seller@example.test',
  }, 'crm-admin', { storage });
  assert.equal(created.ok, true);
  await seedOpportunity(storage, { opportunityId: 'opp-generic-update-link' });

  await assert.rejects(storage.mutateWithCrmActivity({
    operation: 'update_submission',
    payload: {
      id: created.submission.id,
      expectedUpdatedAt: created.submission.updated_at,
      values: {
        updated_at: '2026-08-27T11:30:00.000Z',
        deal_hunter_opportunity_id: 'opp-generic-update-link',
      },
    },
    activity: {
      id: 'generic-link-activity',
      submission_id: created.submission.id,
      opportunity_id: 'opp-generic-update-link',
      created_at: '2026-08-27T11:30:00.000Z',
      actor: 'test',
      role: 'system',
      event_type: 'submission.deal-hunter-synced',
      summary: 'This linkage must use the atomic primitive.',
      metadata: {},
    },
  }), /atomic.*link|link.*primitive/i);

  assert.equal((await storage.getSubmission(created.submission.id)).deal_hunter_opportunity_id, null);
});

test('SQLite Deal Hunter CRM refresh reloads the version advanced by atomic linkage', async (t) => {
  const storage = sqliteStorage(t);
  const opportunityId = 'opp-versioned-crm-refresh';
  const listingUrl = 'https://broker.example/versioned-hvac-refresh';
  await seedOpportunity(storage, { opportunityId });
  const created = await createManualSubmission({
    source: 'deal-hunter-daily-review',
    company: 'Versioned HVAC Services',
    listing_url: listingUrl,
    seller_name: 'Seller Example',
    seller_email: 'seller@example.test',
    broker_email: 'stale-broker@example.test',
    deal_hunter_opportunity_id: opportunityId,
    metadata: {
      dealHunter: {
        managed: true,
        opportunityId,
        dealKey: 'fingerprint:versioned-hvac-services|las-vegas-nv|3500000|450000',
      },
    },
  }, 'crm-admin', { storage });
  assert.equal(created.ok, true);
  await storage.updateSubmission(created.submission.id, {
    updated_at: '2026-08-27T00:00:00.000Z',
  });
  const source = parseSheetCsvDeals([
    'Name,Description,City,State,Annual Profit,Annual Revenue,Broker Name,Broker Email,Listing URL',
    `Versioned HVAC Services,Recurring commercial HVAC maintenance and repair contracts,Las Vegas,NV,$450000,$3500000,Current Broker,current-broker@example.test,${listingUrl}`,
  ].join('\n'));

  const result = await repairDealHunterCrmSourceFields({
    submissionId: created.submission.id,
    apply: true,
    actor: 'version-race-reviewer',
    backupVerified: true,
    backupReference: '/isolated/test/backup',
    storage,
    sourceResults: [source],
  });

  assert.equal(result.applied, true);
  const refreshed = await storage.getSubmission(created.submission.id);
  assert.equal(refreshed.deal_hunter_opportunity_id, opportunityId);
  assert.equal(refreshed.broker_email, 'current-broker@example.test');
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).primary_submission_id, created.submission.id);
  assert.equal(
    (await storage.listCrmActivityEvents({ submissionId: created.submission.id, limit: 20 }))
      .filter((event) => event.event_type === 'submission.deal-hunter-synced').length,
    1,
  );
});

test('SQLite CRM linkage atomically rejects a superseded canonical opportunity', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-superseded', status: 'superseded' });
  const created = await createManualSubmission({
    company: 'Unlinked Historical Candidate',
    seller_name: 'Seller Example',
    seller_email: 'seller@example.test',
  }, 'crm-admin', { storage });
  assert.equal(created.ok, true);

  await assert.rejects(
    storage.linkDealHunterCrmSubmission({
      opportunityId: 'opp-superseded',
      submissionId: created.submission.id,
      updatedAt: '2026-08-27T10:00:00.000Z',
    }),
    /superseded|not current/i,
  );
  assert.equal((await storage.getSubmission(created.submission.id)).deal_hunter_opportunity_id, null);
  assert.equal((await storage.getDealHunterOpportunity('opp-superseded')).primary_submission_id, null);
});

test('CRM preflight does not use a superseded opportunity primary submission as current authority', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-later-superseded' });
  const created = await createManualSubmission({
    company: 'Historical Linked Record',
    seller_name: 'Seller Example',
    seller_email: 'seller@example.test',
  }, 'crm-admin', { storage });
  await storage.linkDealHunterCrmSubmission({
    opportunityId: 'opp-later-superseded',
    submissionId: created.submission.id,
    updatedAt: '2026-08-27T10:00:00.000Z',
  });
  const historical = await storage.getDealHunterOpportunity('opp-later-superseded');
  await storage.upsertDealHunterOpportunity({
    ...historical,
    updated_at: '2026-08-27T10:05:00.000Z',
    status: 'superseded',
  });

  assert.equal(
    await findExistingDealHunterSubmission(storage, { opportunityId: 'opp-later-superseded' }),
    null,
  );
  assert.equal((await storage.getSubmission(created.submission.id)).id, created.submission.id);
  assert.equal((await storage.getDealHunterOpportunity('opp-later-superseded')).primary_submission_id, created.submission.id);
});

test('SQLite Stage 2 identity evidence exposes only active opportunities and their aliases', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-active' });
  await seedOpportunity(storage, { opportunityId: 'opp-superseded' });
  await seedAlias(storage, { aliasKey: 'deal-key:active-deal', opportunityId: 'opp-active' });
  await seedAlias(storage, { aliasKey: 'deal-key:historical-deal', opportunityId: 'opp-superseded' });
  await supersedeOpportunity(storage, 'opp-superseded');

  assert.deepEqual(
    (await storage.listCimStage2IdentityOpportunities({ limit: 10 }))
      .map((row) => row.opportunity_id),
    ['opp-active'],
  );
  assert.deepEqual(
    (await storage.listCimStage2EvidenceAliases({ limit: 10 }))
      .map((row) => row.opportunity_id),
    ['opp-active'],
  );
  assert.equal((await storage.listDealHunterOpportunities({ limit: 10 })).length, 2);
  assert.equal((await storage.listDealHunterOpportunityAliases({ limit: 10 })).length, 2);
});

test('SQLite atomically rejects new CIM claims for a superseded opportunity while retaining claim history', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-claim-history' });
  const firstClaim = await storage.claimDealHunterCimOpportunity({
    opportunityId: 'opp-claim-history',
    requestId: 'request-historical',
    recipientEmail: 'historical@example.test',
    nowIso: '2026-08-27T10:00:00.000Z',
  });
  assert.equal(firstClaim.claimed, true);
  const opportunity = await storage.getDealHunterOpportunity('opp-claim-history');
  await storage.upsertDealHunterOpportunity({
    ...opportunity,
    updated_at: '2026-08-27T10:01:00.000Z',
    status: 'superseded',
  });

  const opportunityClaim = await storage.claimDealHunterCimOpportunity({
    opportunityId: 'opp-claim-history',
    requestId: 'request-replacement',
    allowedRequestIds: ['request-historical'],
    recipientEmail: 'replacement@example.test',
    nowIso: '2026-08-27T10:02:00.000Z',
  });
  const recipientClaim = await storage.claimDealHunterCimRecipient({
    opportunityId: 'opp-claim-history',
    requestId: 'request-replacement',
    recipientEmail: 'replacement@example.test',
    nowIso: '2026-08-27T10:02:00.000Z',
    expiresAt: '2026-08-27T10:12:00.000Z',
  });

  assert.deepEqual(opportunityClaim, {
    claimed: false,
    reason: 'opportunity-not-current',
    claim: null,
  });
  assert.deepEqual(recipientClaim, {
    claimed: false,
    reason: 'opportunity-not-current',
    claim: null,
  });
  assert.equal(
    (await storage.getDealHunterCimOpportunityClaim('opp-claim-history')).request_id,
    'request-historical',
  );
  assert.equal(await storage.releaseDealHunterCimRecipientClaim({
    recipientEmail: 'replacement@example.test',
    requestId: 'request-replacement',
  }), false);
});

test('SQLite reads the current recipient claim by normalized recipient without mutating it', async (t) => {
  // Break caught: preparation has no read-only recipient-claim lookup and
  // would otherwise need to claim/release merely to explain a blocker.
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-recipient-claim-read' });
  const claimed = await storage.claimDealHunterCimRecipient({
    opportunityId: 'opp-recipient-claim-read', requestId: 'request-recipient-read',
    recipientEmail: ' Broker@Example.Test ', nowIso: '2026-08-31T17:00:00.000Z',
    expiresAt: '2026-08-31T18:30:00.000Z', metadata: { purpose: 'read-parity' },
  });
  assert.equal(claimed.claimed, true);
  const first = await storage.getDealHunterCimRecipientClaim('BROKER@example.test');
  const second = await storage.getDealHunterCimRecipientClaim(' broker@example.test ');
  assert.equal(first.request_id, 'request-recipient-read');
  assert.deepEqual(first, second);
  assert.deepEqual(first.metadata, { purpose: 'read-parity' });
});

test('Supabase recipient-claim getter uses one normalized read-only maybeSingle lookup', async () => {
  // Break caught: adapter parity accidentally routes through claim/delete RPCs
  // or queries an unnormalized recipient.
  const calls = [];
  const row = { recipient_email: 'broker@example.test', request_id: 'request-1', opportunity_id: 'opp-1' };
  const query = {
    select(columns) { calls.push(['select', columns]); return query; },
    eq(column, value) { calls.push(['eq', column, value]); return query; },
    async maybeSingle() { calls.push(['maybeSingle']); return { data: row, error: null }; },
  };
  const storage = createSupabaseStorage({ storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } }, {
    client: {
      from(table) { calls.push(['from', table]); return query; },
      async rpc(name) { assert.fail(`recipient read must not call RPC ${name}`); },
    },
  });
  assert.deepEqual(await storage.getDealHunterCimRecipientClaim(' Broker@Example.Test '), row);
  assert.deepEqual(calls, [
    ['from', 'deal_hunter_cim_recipient_claims'], ['select', '*'],
    ['eq', 'recipient_email', 'broker@example.test'], ['maybeSingle'],
  ]);
});

test('SQLite alias mutation primitives atomically reject a superseded target', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-alias-target', status: 'superseded' });
  const record = {
    id: 'alias-non-current-target',
    opportunity_id: 'opp-alias-target',
    alias_type: 'listing-id',
    alias_value: 'non-current-target',
    alias_key: 'listing-id:non-current-target',
    source: 'current-opportunity-test',
    first_observed_at: '2026-08-27T11:00:00.000Z',
    last_observed_at: '2026-08-27T11:00:00.000Z',
    evidence_version: 'current-opportunity-test-v1',
    resolution_method: 'fixture',
    confidence_state: 'exact',
    resolved_by: 'test',
    metadata: {},
  };

  await assert.rejects(storage.upsertDealHunterOpportunityAlias(record), /superseded|not current/i);
  await assert.rejects(storage.linkDealHunterOpportunityAliases([record]), /superseded|not current/i);
  assert.deepEqual(await storage.listDealHunterOpportunityAliases({ limit: 10 }), []);
});

test('SQLite recipient-override persistence atomically rejects a superseded target', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-override-target', status: 'superseded' });

  await assert.rejects(storage.upsertDealHunterCimRecipientOverride({
    id: 'override-non-current-target',
    opportunity_id: 'opp-override-target',
    recipient_email: 'broker@example.test',
    created_at: '2026-08-27T11:00:00.000Z',
    expires_at: '2026-08-27T12:00:00.000Z',
    consumed_at: null,
    created_by: 'test',
    reason: 'This should fail before storing current authority.',
    metadata: {},
  }), /superseded|not current/i);
  assert.equal(await storage.getActiveDealHunterCimRecipientOverride({
    opportunityId: 'opp-override-target',
    recipientEmail: 'broker@example.test',
    nowIso: '2026-08-27T11:30:00.000Z',
  }), null);
});

test('SQLite recipient-override upsert cannot rewrite a historical override through an active owner collision', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-historical-override' });
  await storage.upsertDealHunterCimRecipientOverride({
    id: 'override-owner-collision',
    opportunity_id: 'opp-historical-override',
    recipient_email: 'historical@example.test',
    created_at: '2026-08-27T11:00:00.000Z',
    expires_at: '2026-08-27T12:00:00.000Z',
    consumed_at: null,
    created_by: 'historical-operator',
    reason: 'Original historical approval evidence.',
    metadata: { immutableHistoricalMarker: 'before-collision' },
  });
  await supersedeOpportunity(storage, 'opp-historical-override');
  await seedOpportunity(storage, { opportunityId: 'opp-active-override-collision' });

  await assert.rejects(storage.upsertDealHunterCimRecipientOverride({
    id: 'override-owner-collision',
    opportunity_id: 'opp-active-override-collision',
    recipient_email: 'replacement@example.test',
    created_at: '2026-08-27T11:15:00.000Z',
    expires_at: '2026-08-27T13:00:00.000Z',
    consumed_at: null,
    created_by: 'replacement-operator',
    reason: 'This must not rewrite historical evidence.',
    metadata: { immutableHistoricalMarker: 'after-collision' },
  }), /belongs|collision|superseded|not current/i);

  const historical = await storage.consumeDealHunterCimRecipientOverride(
    'override-owner-collision',
    '2026-08-27T11:30:00.000Z',
  );
  assert.equal(historical.opportunity_id, 'opp-historical-override');
  assert.equal(historical.recipient_email, 'historical@example.test');
  assert.equal(historical.reason, 'Original historical approval evidence.');
  assert.deepEqual(historical.metadata, { immutableHistoricalMarker: 'before-collision' });
});

test('a previously created CIM override stops granting authority after its opportunity is superseded', async (t) => {
  const storage = sqliteStorage(t);
  await seedOpportunity(storage, { opportunityId: 'opp-stale-override' });
  await storage.upsertDealHunterCimRecipientOverride({
    id: 'override-that-becomes-historical',
    opportunity_id: 'opp-stale-override',
    recipient_email: 'broker@example.test',
    created_at: '2026-08-27T11:00:00.000Z',
    expires_at: '2026-08-27T12:00:00.000Z',
    consumed_at: null,
    created_by: 'test',
    reason: 'Valid while this canonical opportunity was active.',
    metadata: {},
  });
  const opportunity = await storage.getDealHunterOpportunity('opp-stale-override');
  await storage.upsertDealHunterOpportunity({
    ...opportunity,
    updated_at: '2026-08-27T11:15:00.000Z',
    status: 'superseded',
  });

  assert.equal(await storage.getActiveDealHunterCimRecipientOverride({
    opportunityId: 'opp-stale-override',
    recipientEmail: 'broker@example.test',
    nowIso: '2026-08-27T11:30:00.000Z',
  }), null);
});
