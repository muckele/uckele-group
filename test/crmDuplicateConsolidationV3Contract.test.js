import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
  CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY,
  validateCrmDuplicateConsolidationRowAuthority,
  crmDuplicateConsolidationManifestId,
  CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  canonicalJsonSha256,
} from '../server/repairs/crmDuplicateConsolidation.js';
import { verifyCrmDuplicateConsolidationReviewedArtifact } from '../server/services/crmDuplicateConsolidationRepair.js';
import { createSqliteCrmDuplicateConsolidationReadOnlyStorage } from '../server/storage/sqlite.js';
import {
  createFixture,
  NOW,
  POOLER,
  rawDatabase,
  syntheticReviewedArtifactFixture,
} from './crmDuplicateConsolidationRepair.test.js';

async function inspect(fixture) {
  const storage = createSqliteCrmDuplicateConsolidationReadOnlyStorage(
    fixture.config, { environment: {} },
  );
  try {
    return await storage.inspectCrmDuplicateConsolidation();
  } finally {
    storage.close();
  }
}

function growVolatile(fixture, { analytics = false, rateLimit = false } = {}) {
  rawDatabase(fixture.sqlitePath, (db) => {
    if (analytics) db.prepare(`INSERT INTO analytics_events
      (id, created_at, event_name, path) VALUES (?, ?, 'page_view', ?)`).run(
      'v3-analytics-event', NOW, '/v3/volatile',
    );
    if (rateLimit) db.prepare(`INSERT INTO contact_rate_limit_events (bucket, created_at)
      VALUES (?, ?)`).run('v3-rate-limit', NOW);
  });
}

function insertMany(db, table, count) {
  db.prepare(`WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
  ) INSERT INTO ${table} (value) SELECT n FROM seq`).run(count);
}

test('V3 authoritative digest and count ignore both volatile tables', async (t) => {
  for (const variant of [{ analytics: true }, { rateLimit: true }, { analytics: true, rateLimit: true }]) {
    await t.test(JSON.stringify(variant), async (subtest) => {
      const fixture = await createFixture(subtest);
      const before = await inspect(fixture);
      growVolatile(fixture, variant);
      const after = await inspect(fixture);
      assert.equal(typeof before.database.authorityLogicalDigest, 'string');
      assert.equal(typeof before.database.authorityTotalRows, 'number');
      assert.equal(after.database.authorityLogicalDigest, before.database.authorityLogicalDigest);
      assert.equal(after.database.authorityTotalRows, before.database.authorityTotalRows);
      assert.deepEqual(after.authorityTableDigests, before.authorityTableDigests);
      assert.equal(after.schema.digest, before.schema.digest);
      assert.equal(Object.hasOwn(after.authorityTableDigests, 'analytics_events'), false);
      assert.equal(Object.hasOwn(after.authorityTableDigests, 'contact_rate_limit_events'), false);
    });
  }
});

test('V3 reference inventory never scans volatile incident tokens', async (t) => {
  const fixture = await createFixture(t);
  const before = await inspect(fixture);
  rawDatabase(fixture.sqlitePath, (db) => {
    db.prepare(`INSERT INTO analytics_events (id, created_at, event_name, path)
      VALUES ('v3-reference', ?, 'page_view', ?)`).run(NOW, `/${POOLER.supersededSubmissionId}`);
    db.prepare(`INSERT INTO contact_rate_limit_events (bucket, created_at)
      VALUES (?, ?)`).run(POOLER.supersededSubmissionId, NOW);
  });
  const after = await inspect(fixture);
  assert.deepEqual(after.relationshipInventory, before.relationshipInventory);
  assert.deepEqual(after.referenceIdentifiers, before.referenceIdentifiers);
  assert.ok(after.relationshipInventory.every((entry) =>
    !['analytics_events', 'contact_rate_limit_events'].includes(entry.table)));
  assert.equal(after.blockers.some((value) => /analytics_events|contact_rate_limit_events/.test(value)), false);
});

test('V3 schema includes volatile tables and changes on each DDL', async (t) => {
  for (const table of CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES) {
    await t.test(table, async (subtest) => {
      const fixture = await createFixture(subtest);
      const before = await inspect(fixture);
      assert.ok(before.schema.tables.some((entry) => entry.name === table));
      rawDatabase(fixture.sqlitePath, (db) => db.exec(`ALTER TABLE ${table} ADD COLUMN v3_probe TEXT`));
      const after = await inspect(fixture);
      assert.notEqual(after.schema.digest, before.schema.digest);
      assert.equal(after.database.authorityLogicalDigest, before.database.authorityLogicalDigest);
    });
  }
});

test('V3 unrelated authoritative row update and insert change authority', async (t) => {
  const fixture = await createFixture(t);
  const before = await inspect(fixture);
  rawDatabase(fixture.sqlitePath, (db) => db.prepare(`UPDATE deal_hunter_opportunities
    SET canonical_name = ? WHERE opportunity_id = ?`).run('changed', POOLER.opportunityId));
  const updated = await inspect(fixture);
  assert.notEqual(updated.database.authorityLogicalDigest, before.database.authorityLogicalDigest);
  rawDatabase(fixture.sqlitePath, (db) => db.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
    (id, opportunity_id, source_id, source_name, source_record_id, field, value,
      observed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'v3-authoritative-insert', POOLER.opportunityId, 'v3-test', 'V3 test', 'v3-record',
    'name', 'unrelated', NOW, NOW, NOW,
  ));
  const inserted = await inspect(fixture);
  assert.notEqual(inserted.database.authorityLogicalDigest, updated.database.authorityLogicalDigest);
  assert.equal(inserted.database.authorityTotalRows, updated.database.authorityTotalRows + 1);
});

test('V3 authoritative new table defaults to row authority', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (db) => db.exec('CREATE TABLE v3_new_table (value INTEGER NOT NULL)'));
  const before = await inspect(fixture);
  assert.equal(before.authorityTableDigests.v3_new_table?.rowCount, 0);
  rawDatabase(fixture.sqlitePath, (db) => db.prepare('INSERT INTO v3_new_table (value) VALUES (?)').run(1));
  const after = await inspect(fixture);
  assert.equal(after.database.authorityTotalRows, before.database.authorityTotalRows + 1);
  assert.notEqual(after.database.authorityLogicalDigest, before.database.authorityLogicalDigest);
  assert.equal(after.schema.digest, before.schema.digest);
  assert.equal(after.authorityTableDigests.v3_new_table.rowCount, 1);
});

test('V3 authoritative row bound rejects 250001 new-table rows before row read', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (db) => {
    db.exec('CREATE TABLE v3_bound_probe (value INTEGER NOT NULL)');
    insertMany(db, 'v3_bound_probe', 250001);
  });
  const prepared = [];
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function observedPrepare(sql, ...args) {
    prepared.push(String(sql));
    return original.call(this, sql, ...args);
  };
  try {
    await assert.rejects(inspect(fixture), /inspection row bound exceeded/);
  } finally {
    Database.prototype.prepare = original;
  }
  assert.equal(prepared.some((sql) => /SELECT\s+\*\s+FROM\s+"?v3_bound_probe"?/i.test(sql)), false);
});

test('V3 authoritative row bound ignores 250001 rate-limit rows', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (db) => db.prepare(`WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
  ) INSERT INTO contact_rate_limit_events (bucket, created_at)
    SELECT 'v3-rate-limit', ? FROM seq`).run(250001, NOW));
  const inspection = await inspect(fixture);
  assert.equal(typeof inspection.database.authorityLogicalDigest, 'string');
  assert.equal(inspection.database.quickCheck, 'ok');
});

test('V3 schema refuses missing excluded table before row SQL', async (t) => {
  for (const table of CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES) {
    await t.test(table, async (subtest) => {
      const fixture = await createFixture(subtest);
      rawDatabase(fixture.sqlitePath, (db) => db.exec(`DROP TABLE ${table}`));
      const prepared = [];
      const original = Database.prototype.prepare;
      Database.prototype.prepare = function observedPrepare(sql, ...args) {
        prepared.push(String(sql));
        return original.call(this, sql, ...args);
      };
      try {
        await assert.rejects(inspect(fixture), new RegExp(`required schema table missing: ${table}`));
      } finally {
        Database.prototype.prepare = original;
      }
      assert.equal(prepared.some((sql) => /SELECT\s+(?:COUNT\(\*\)[\s\S]*?|\*)\s+FROM\s+"?[a-z_]+"?/i.test(sql)), false);
    });
  }
});

test('V3 authoritative inspection prepares no excluded-table row scan', async (t) => {
  const fixture = await createFixture(t);
  const prepared = [];
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function observedPrepare(sql, ...args) {
    prepared.push(String(sql));
    return original.call(this, sql, ...args);
  };
  try {
    await inspect(fixture);
  } finally {
    Database.prototype.prepare = original;
  }
  for (const table of CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES) {
    assert.equal(prepared.some((sql) => new RegExp(`SELECT\\s+(?:COUNT\\(\\*\\)[\\s\\S]*?|\\*)\\s+FROM\\s+"?${table}"?`, 'i').test(sql)), false,
      `unexpected row read on ${table}`);
  }
});

test('V3 policy is closed, sorted, deeply frozen, and rejects recomputed-policy variants', () => {
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
    ['analytics_events', 'contact_rate_limit_events']);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES), true);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY), true);
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, {
    schema: 'crm-duplicate-consolidation-row-authority-v1',
    policy: 'schema-bound-row-content-excluded',
    excludedRowTables: ['analytics_events', 'contact_rate_limit_events'],
  });
  for (const excludedRowTables of [
    ['contact_rate_limit_events', 'analytics_events'],
    ['analytics_events', 'contact_rate_limit_events', 'email_events'],
    ['analytics_events'],
  ]) {
    assert.throws(() => validateCrmDuplicateConsolidationRowAuthority({
      ...CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, excludedRowTables,
    }), /row.authority.*policy/i);
  }
  assert.throws(() => validateCrmDuplicateConsolidationRowAuthority({
    ...CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, override: true,
  }), /row.authority.*policy/i);
});

test('V3 namespace changes only versioned repair contracts', () => {
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA, 'crm-duplicate-consolidation-approval-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA, 'crm-duplicate-consolidation-checkpoint-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.match(crmDuplicateConsolidationManifestId(), /^crm-duplicate-consolidation:v3:[a-f0-9]{64}$/);
});

test('V3 pure validator refuses old or missing policy even with a valid checksum', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  for (const mutate of [
    (item) => { item.repairVersion = 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2'; },
    (item) => { delete item.plan.rowAuthority; },
    (item) => { item.plan.rowAuthority.policy = 'unreviewed'; },
  ]) {
    const candidate = structuredClone(artifact);
    mutate(candidate);
    candidate.planChecksum = canonicalJsonSha256(candidate.plan);
    assert.throws(() => verifyCrmDuplicateConsolidationReviewedArtifact({
      artifact: candidate, expectedPlanChecksum: candidate.planChecksum,
      expectedManifestId: candidate.manifestId,
    }), /version|row.authority.*policy/i);
  }
});
