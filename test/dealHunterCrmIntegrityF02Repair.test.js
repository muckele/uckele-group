import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY,
  DEAL_HUNTER_CRM_INTEGRITY_F02_CONFIRMATION,
  createDealHunterCrmIntegrityF02ApprovalManifest,
  createDealHunterCrmIntegrityF02TestAuthority,
  fingerprintDealHunterCrmIntegrityF02RawRow,
} from '../server/repairs/dealHunterCrmIntegrityF02.js';
import {
  applyDealHunterCrmIntegrityF02Repair,
  inspectDealHunterCrmIntegrityF02Repair,
} from '../server/services/dealHunterCrmIntegrityF02Repair.js';
import { createBackupBundle } from '../server/services/backups.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const execution = {
  actor: 'Owner Reviewer',
  reason: 'Repair the three reviewed F-02 CRM integrity defects.',
  executionRelease: 'release-121',
  toolingRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

function fixtureConfig(root) {
  return {
    storage: { provider: 'sqlite', sqlitePath: path.join(root, 'fixture.sqlite') },
    secureDocuments: { storageDir: path.join(root, 'secure-documents') },
    protection: { rateLimitRetentionMs: 0 },
    backup: {
      enabled: true,
      directory: path.join(root, 'backups'),
      retentionDays: 30,
      retentionCount: 5,
      time: '03:30',
      timezone: 'America/Los_Angeles',
      checkIntervalMs: 900000,
    },
  };
}

function insertSubmission(database, {
  id,
  company,
  opportunityId = null,
  metadata = {},
  source = 'deal-hunter-daily-review',
  index = 0,
}) {
  database.prepare(`
    INSERT INTO contact_submissions (
      id, created_at, updated_at, status, spam_score, spam_reasons,
      delivery_provider, delivery_status, crm_status, source, ip_hash,
      name, email, company, message, deal_hunter_opportunity_id, metadata
    ) VALUES (?, ?, ?, 'new', 0, '[]', 'fixture', 'not-sent', 'not-synced', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    '2026-09-12T10:00:00.000Z',
    '2026-09-12T10:00:00.000Z',
    source,
    `hash-${index}`,
    `Fixture Contact ${index}`,
    `fixture-${index}@example.test`,
    company,
    `Synthetic fixture message ${index}`,
    opportunityId,
    JSON.stringify(metadata),
  );
}

function insertOpportunity(database, opportunityId, primarySubmissionId = null, index = 0) {
  database.prepare(`
    INSERT INTO deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name,
      canonical_recipient, canonical_location, primary_submission_id,
      identity_version, status, metadata
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'fixture-v1', 'active', '{}')
  `).run(
    opportunityId,
    '2026-09-12T10:00:00.000Z',
    '2026-09-12T10:00:00.000Z',
    `Fixture Opportunity ${index}`,
    primarySubmissionId,
  );
}

function insertImport(database, {
  id,
  opportunityId,
  submissionId = null,
  index = 0,
}) {
  database.prepare(`
    INSERT INTO deal_hunter_crm_imports (
      id, created_at, updated_at, deal_key, listing_identity, listing_url,
      submission_id, status, source_name, metadata, opportunity_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'current', 'fixture-source', '{}', ?)
  `).run(
    id,
    '2026-09-12T10:00:00.000Z',
    '2026-09-12T10:00:00.000Z',
    `fixture-deal-${index}`,
    `fixture-listing-${index}`,
    `https://fixture.example.test/listing/${index}`,
    submissionId,
    opportunityId,
  );
}

function rawFingerprint(row) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

function rawRow(database, table, field, value) {
  return database.prepare(`SELECT * FROM ${table} WHERE ${field} = ?`).get(value);
}

function syntheticAuthority(database) {
  const relationships = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.relationships;
  const collision = relationships.collision;
  const backlink = relationships.backlink;
  const managedName = relationships.managedName;
  const backlinkImport = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports
    WHERE opportunity_id = ? AND submission_id = ?
  `).get(backlink.opportunityId, backlink.submissionId);
  return createDealHunterCrmIntegrityF02TestAuthority({
    legacyCollisionImport: rawFingerprint(rawRow(database, 'deal_hunter_crm_imports', 'id', collision.legacyImportId)),
    retainedUrlImport: rawFingerprint(rawRow(database, 'deal_hunter_crm_imports', 'id', collision.retainedImportId)),
    collisionOpportunity: rawFingerprint(rawRow(database, 'deal_hunter_opportunities', 'opportunity_id', collision.opportunityId)),
    collisionSubmission: rawFingerprint(rawRow(database, 'contact_submissions', 'id', collision.sharedSubmissionId)),
    backlinkOpportunity: rawFingerprint(rawRow(database, 'deal_hunter_opportunities', 'opportunity_id', backlink.opportunityId)),
    backlinkImport: rawFingerprint(backlinkImport),
    backlinkSubmission: rawFingerprint(rawRow(database, 'contact_submissions', 'id', backlink.submissionId)),
    nameMismatchSubmission: rawFingerprint(rawRow(database, 'contact_submissions', 'id', managedName.submissionId)),
  });
}

function snapshotDatabase(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    return Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]));
  } finally {
    database.close();
  }
}

function expectedAfterSnapshot(before) {
  const after = structuredClone(before);
  const mutations = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations;
  for (const mutation of mutations) {
    const key = mutation.table === 'deal_hunter_opportunities' ? 'opportunity_id' : 'id';
    const row = after[mutation.table].find((candidate) => candidate[key] === mutation.id);
    row[mutation.field] = mutation.after;
  }
  return after;
}

function countOperationalRows(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const count = (table) => Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return {
      reconciliationRuns: count('deal_hunter_crm_reconciliation_runs'),
      reconciliationItems: count('deal_hunter_crm_reconciliation_items'),
      communications: count('crm_communications'),
      outbox: count('crm_email_outbox'),
      emailEvents: count('email_events'),
    };
  } finally {
    database.close();
  }
}

async function createIncidentFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-f02-repair-'));
  const config = fixtureConfig(root);
  const storage = createSqliteStorage(config);
  storage.close();
  const database = new Database(config.storage.sqlitePath, { fileMustExist: true });
  const collision = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.relationships.collision;
  const backlink = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.relationships.backlink;
  const managedName = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.relationships.managedName;
  try {
    database.exec('DROP INDEX IF EXISTS idx_deal_hunter_crm_imports_unique_opportunity');

    insertSubmission(database, {
      id: collision.sharedSubmissionId,
      company: 'Synthetic Collision Company',
      opportunityId: collision.opportunityId,
      metadata: {
        dealHunter: {
          managed: true,
          opportunityId: collision.opportunityId,
          raw: { 'Business Name': 'Synthetic Collision Company' },
        },
      },
      index: 1,
    });
    insertSubmission(database, {
      id: backlink.submissionId,
      company: 'Synthetic Backlink Company',
      opportunityId: null,
      metadata: { dealHunter: { managed: true, raw: { 'Business Name': 'Synthetic Backlink Company' } } },
      index: 2,
    });
    insertSubmission(database, {
      id: managedName.submissionId,
      company: DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations[2].before,
      opportunityId: 'opp_fixture_name_mismatch',
      metadata: {
        dealHunter: {
          managed: true,
          opportunityId: 'opp_fixture_name_mismatch',
          raw: { 'Business Name': managedName.authoritativeCompany },
          workflow: { state: 'reviewed' },
        },
      },
      index: 3,
    });
    for (let index = 0; index < 27; index += 1) {
      const opportunityId = `opp_fixture_healthy_${index}`;
      const submissionId = `fixture-healthy-submission-${index}`;
      insertSubmission(database, {
        id: submissionId,
        company: `Healthy Fixture Company ${index}`,
        opportunityId,
        metadata: {
          dealHunter: {
            managed: true,
            opportunityId,
            raw: { 'Business Name': `Healthy Fixture Company ${index}` },
          },
        },
        index: index + 10,
      });
    }

    insertOpportunity(database, collision.opportunityId, collision.sharedSubmissionId, 1);
    insertOpportunity(database, backlink.opportunityId, backlink.submissionId, 2);
    insertOpportunity(database, 'opp_fixture_name_mismatch', managedName.submissionId, 3);
    for (let index = 0; index < 27; index += 1) {
      insertOpportunity(database, `opp_fixture_healthy_${index}`, `fixture-healthy-submission-${index}`, index + 10);
    }
    for (let index = 0; index < 445; index += 1) {
      insertOpportunity(database, `opp_fixture_unclaimed_${index}`, null, index + 100);
    }

    insertImport(database, {
      id: collision.legacyImportId,
      opportunityId: collision.opportunityId,
      submissionId: collision.sharedSubmissionId,
      index: 1,
    });
    insertImport(database, {
      id: collision.retainedImportId,
      opportunityId: collision.opportunityId,
      submissionId: collision.sharedSubmissionId,
      index: 2,
    });
    insertImport(database, {
      id: 'fixture-backlink-authority-import',
      opportunityId: backlink.opportunityId,
      submissionId: backlink.submissionId,
      index: 3,
    });
    insertImport(database, {
      id: 'fixture-name-import',
      opportunityId: 'opp_fixture_name_mismatch',
      submissionId: managedName.submissionId,
      index: 4,
    });
    for (let index = 0; index < 27; index += 1) {
      insertImport(database, {
        id: `fixture-healthy-import-${index}`,
        opportunityId: `opp_fixture_healthy_${index}`,
        submissionId: `fixture-healthy-submission-${index}`,
        index: index + 10,
      });
    }
    insertImport(database, {
      id: 'fixture-unclaimed-import',
      opportunityId: 'opp_fixture_unclaimed_0',
      submissionId: null,
      index: 100,
    });
    const authority = syntheticAuthority(database);
    database.pragma('wal_checkpoint(TRUNCATE)');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, config, databasePath: config.storage.sqlitePath, authority };
  } finally {
    database.close();
  }
}

async function createFixtureBackup(fixture, createdAt = '2026-09-13T02:00:00.000Z') {
  const storage = createSqliteStorage(fixture.config);
  try {
    return await createBackupBundle({ storage, config: fixture.config, now: new Date(createdAt) });
  } finally {
    storage.close();
  }
}

async function approvedDryRun(fixture, overrides = {}) {
  return inspectDealHunterCrmIntegrityF02Repair({
    databasePath: fixture.databasePath,
    provider: 'sqlite',
    authority: fixture.authority,
    generatedAt: '2026-09-13T01:00:00.000Z',
    ...execution,
    ...overrides,
  });
}

async function approvedApply(fixture, dryRun, backup, overrides = {}) {
  return applyDealHunterCrmIntegrityF02Repair({
    databasePath: fixture.databasePath,
    provider: 'sqlite',
    authority: fixture.authority,
    reviewedManifest: dryRun.approvalManifest,
    expectedPlanChecksum: dryRun.planChecksum,
    confirmation: DEAL_HUNTER_CRM_INTEGRITY_F02_CONFIRMATION,
    backupPath: backup.path,
    completedAt: '2026-09-13T03:00:00.000Z',
    ...execution,
    ...overrides,
  });
}

test('F-02 raw row fingerprints preserve SELECT-star property order exactly', () => {
  const rawRow = {
    id: 'row-1',
    opportunity_id: null,
    updated_at: '2026-09-13T00:00:00.000Z',
  };

  assert.equal(
    fingerprintDealHunterCrmIntegrityF02RawRow(rawRow),
    '46608be2aac3440432e12be08fce836463b1580cb92996708722e9c8a3841176',
  );
  assert.notEqual(
    fingerprintDealHunterCrmIntegrityF02RawRow({
      updated_at: rawRow.updated_at,
      opportunity_id: rawRow.opportunity_id,
      id: rawRow.id,
    }),
    '46608be2aac3440432e12be08fce836463b1580cb92996708722e9c8a3841176',
  );
});

test('F-02 authority fixes the three mutations and all diagnostic guards', () => {
  assert.equal(DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.evidence.release, '120');
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.evidence.revision,
    '1af79c5ff93dae3dbeeb0173cfdc6d59d5b29109',
  );
  assert.deepEqual(DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations, [
    {
      table: 'deal_hunter_crm_imports',
      id: 'cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31',
      field: 'opportunity_id',
      before: 'opp_683681c2-bd49-4c46-be4f-6d969143d907',
      after: null,
    },
    {
      table: 'contact_submissions',
      id: '1245f55a-9496-4628-9cbe-d23e53b791a1',
      field: 'deal_hunter_opportunity_id',
      before: null,
      after: 'opp_repair_6b75b5d5c825431d2bea921450f50c37',
    },
    {
      table: 'contact_submissions',
      id: '8e910798-9ac4-4d10-9c0f-9402feb9403a',
      field: 'company',
      before: 'Profitable Senior Independence Support With Virtual Family Connection For Sale',
      after: 'Lawn And Landscape Maintenance Company For Sale',
    },
  ]);
  assert.deepEqual(DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.expectedAuditBefore, {
    imports: 32,
    opportunities: 475,
    auditedSubmissions: 30,
    ownershipCollisions: 1,
    duplicatePrimaries: 0,
    identityMismatches: 0,
    nameMismatches: 1,
    tombstoneActive: 0,
    missingLinks: 1,
    ok: false,
    safeToReconcile: false,
  });
  assert.equal(Object.keys(DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.rowFingerprints).length, 8);
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.rowFingerprints.legacyCollisionImport,
    '0650ae104b7123bd94f76772bcd4895c6a9ac088443ac3b37b3f33ee4897ae84',
  );
});

test('F-02 plan checksum binds approvals but excludes incidental runtime values', () => {
  const approval = {
    actor: 'Owner Reviewer',
    reason: 'Repair the three reviewed F-02 CRM integrity defects.',
    executionRelease: 'release-121',
    toolingRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const first = createDealHunterCrmIntegrityF02ApprovalManifest({
    ...approval,
    generatedAt: '2026-09-13T01:00:00.000Z',
    databasePath: '/tmp/one.sqlite',
  });
  const second = createDealHunterCrmIntegrityF02ApprovalManifest({
    ...approval,
    generatedAt: '2026-09-13T02:00:00.000Z',
    databasePath: '/tmp/two.sqlite',
  });

  assert.match(first.planChecksum, /^[a-f0-9]{64}$/);
  assert.equal(first.planChecksum, second.planChecksum);
  assert.notEqual(
    first.planChecksum,
    createDealHunterCrmIntegrityF02ApprovalManifest({ ...approval, actor: 'Another Reviewer' }).planChecksum,
  );
  assert.equal(first.plan.requiredConfirmation, DEAL_HUNTER_CRM_INTEGRITY_F02_CONFIRMATION);
  assert.equal(Object.hasOwn(first.plan, 'generatedAt'), false);
  assert.equal(Object.hasOwn(first.plan, 'databasePath'), false);
});

test('F-02 dry run reads the exact unsafe incident without durable writes or PII output', async (t) => {
  const fixture = await createIncidentFixture(t);
  const before = snapshotDatabase(fixture.databasePath);

  const result = await approvedDryRun(fixture);

  assert.equal(result.status, 'repair-required');
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, false);
  assert.deepEqual(result.connection, { readonly: true, fileMustExist: true, queryOnly: true });
  assert.deepEqual(result.audit.counts, {
    imports: 32,
    opportunities: 475,
    auditedSubmissions: 30,
    ownershipCollisions: 1,
    duplicatePrimaries: 0,
    identityMismatches: 0,
    nameMismatches: 1,
    tombstoneActive: 0,
    missingLinks: 1,
  });
  assert.equal(result.audit.ok, false);
  assert.equal(result.audit.safeToReconcile, false);
  assert.match(result.planChecksum, /^[a-f0-9]{64}$/);
  assert.equal(result.approvalManifest.planChecksum, result.planChecksum);
  assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
  assert.equal(JSON.stringify(result).includes('@example.test'), false);
  assert.equal(JSON.stringify(result).includes('Synthetic fixture message'), false);
});

test('F-02 apply changes exactly three cells and produces the real clean audit', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const before = snapshotDatabase(fixture.databasePath);
  const operationalBefore = countOperationalRows(fixture.databasePath);

  const result = await approvedApply(fixture, dryRun, backup);

  assert.equal(result.status, 'applied');
  assert.equal(result.mode, 'apply');
  assert.equal(result.applied, true);
  assert.equal(result.mutationCount, 3);
  assert.deepEqual(snapshotDatabase(fixture.databasePath), expectedAfterSnapshot(before));
  assert.deepEqual(countOperationalRows(fixture.databasePath), operationalBefore);
  assert.equal(result.preservation.maskedLogicalDigestBefore, result.preservation.maskedLogicalDigestAfter);
  assert.equal(result.foreignKeyCheck.ok, true);
  assert.deepEqual(result.audit.counts, {
    imports: 32,
    opportunities: 475,
    auditedSubmissions: 30,
    ownershipCollisions: 0,
    duplicatePrimaries: 0,
    identityMismatches: 0,
    nameMismatches: 0,
    tombstoneActive: 0,
    missingLinks: 0,
  });
  assert.equal(result.audit.ok, true);
  assert.equal(result.audit.safeToReconcile, true);
  assert.equal(result.receipt.planChecksum, dryRun.planChecksum);
  assert.equal(result.receipt.mutationCount, 3);
  assert.equal(JSON.stringify(result.receipt).includes('@example.test'), false);
});

test('F-02 corrected state distinguishes satisfaction from validated prior execution', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const applied = await approvedApply(fixture, dryRun, backup);
  const corrected = snapshotDatabase(fixture.databasePath);

  const withoutReceipt = await approvedDryRun(fixture);
  const withReceipt = await approvedDryRun(fixture, { receipt: applied.receipt });

  assert.equal(withoutReceipt.status, 'already-satisfied');
  assert.equal(withoutReceipt.applied, false);
  assert.equal(withReceipt.status, 'verified-prior-apply');
  assert.equal(withReceipt.applied, false);
  assert.deepEqual(snapshotDatabase(fixture.databasePath), corrected);
});

test('F-02 refuses partial state, target drift, authority drift, and wrong global counts', async (t) => {
  const cases = [
    {
      name: 'partial state',
      mutate(database) {
        const mutation = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations[0];
        database.prepare('UPDATE deal_hunter_crm_imports SET opportunity_id = ? WHERE id = ?')
          .run(mutation.after, mutation.id);
      },
    },
    {
      name: 'target drift',
      mutate(database) {
        database.prepare('UPDATE contact_submissions SET updated_at = ? WHERE id = ?')
          .run('2026-09-13T09:00:00.000Z', DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations[1].id);
      },
    },
    {
      name: 'authority drift',
      mutate(database) {
        database.prepare('UPDATE deal_hunter_crm_imports SET source_name = ? WHERE id = ?')
          .run('drifted-source', DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.relationships.collision.retainedImportId);
      },
    },
    {
      name: 'wrong global count',
      mutate(database) {
        database.prepare('DELETE FROM deal_hunter_opportunities WHERE opportunity_id = ?')
          .run('opp_fixture_unclaimed_444');
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await createIncidentFixture(subtest);
      const database = new Database(fixture.databasePath, { fileMustExist: true });
      scenario.mutate(database);
      database.close();
      const before = snapshotDatabase(fixture.databasePath);

      const result = await approvedDryRun(fixture);

      assert.equal(result.status, 'refused');
      assert.equal(result.applied, false);
      assert.ok(result.blockers.length > 0);
      assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
    });
  }
});

test('F-02 refuses unsupported target triggers and non-SQLite providers', async (t) => {
  const fixture = await createIncidentFixture(t);
  const database = new Database(fixture.databasePath, { fileMustExist: true });
  database.exec(`
    CREATE TRIGGER fixture_secondary_write
    AFTER UPDATE ON contact_submissions
    BEGIN
      INSERT INTO analytics_events (
        id, created_at, event_name, path, referrer_host,
        utm_source, utm_medium, utm_campaign, placement
      ) VALUES ('trigger-write', '2026-09-13T00:00:00.000Z', 'trigger', '/', '', '', '', '', '');
    END
  `);
  database.close();

  const triggerResult = await approvedDryRun(fixture);
  const providerResult = await approvedDryRun(fixture, { provider: 'supabase' });

  assert.equal(triggerResult.status, 'refused');
  assert.match(triggerResult.blockers.join(' '), /trigger/i);
  assert.equal(providerResult.status, 'refused');
  assert.match(providerResult.blockers.join(' '), /SQLite/i);
});

test('F-02 apply requires exact approval, execution identity, and current matching backup evidence', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const cases = [
    ['missing backup', { backupPath: '' }, /backup/i],
    ['missing checksum', { expectedPlanChecksum: '' }, /checksum/i],
    ['wrong checksum', { expectedPlanChecksum: 'b'.repeat(64) }, /checksum/i],
    ['missing manifest', { reviewedManifest: null }, /manifest/i],
    ['wrong confirmation', { confirmation: 'WRONG' }, /confirmation/i],
    ['missing actor', { actor: '' }, /actor/i],
    ['short reason', { reason: 'too short' }, /reason/i],
    ['wrong release', { executionRelease: 'release-122' }, /checksum|manifest|execution/i],
    ['wrong tooling revision', { toolingRevision: 'b'.repeat(40) }, /checksum|manifest|tooling/i],
  ];
  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(approvedApply(fixture, dryRun, backup, overrides), expected);
    });
  }

  const invalidBackup = path.join(fixture.root, 'invalid-backup');
  fs.mkdirSync(invalidBackup);
  await assert.rejects(
    approvedApply(fixture, dryRun, { path: invalidBackup }),
    /backup verification/i,
  );

  const legacyPath = path.join(fixture.root, 'legacy-backup');
  fs.cpSync(backup.path, legacyPath, { recursive: true });
  const legacyManifestPath = path.join(legacyPath, 'manifest.json');
  const legacyManifest = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8'));
  legacyManifest.version = 1;
  fs.writeFileSync(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
  await assert.rejects(
    approvedApply(fixture, dryRun, { path: legacyPath }),
    /current-format|legacy|backup verification/i,
  );
});

test('F-02 backup snapshot and live database must both reproduce the reviewed preflight', async (t) => {
  const sourceFixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(sourceFixture);
  const mismatchedFixture = await createIncidentFixture(t);
  const drift = new Database(mismatchedFixture.databasePath, { fileMustExist: true });
  drift.prepare('UPDATE contact_submissions SET company = ? WHERE id = ?')
    .run('Changed unrelated healthy company', 'fixture-healthy-submission-0');
  drift.close();
  const mismatchedBackup = await createFixtureBackup(mismatchedFixture);

  await assert.rejects(
    approvedApply(sourceFixture, dryRun, mismatchedBackup),
    /backup.*preflight|preflight.*backup|digest/i,
  );

  const matchingBackup = await createFixtureBackup(sourceFixture);
  const liveDrift = new Database(sourceFixture.databasePath, { fileMustExist: true });
  liveDrift.prepare('UPDATE contact_submissions SET company = ? WHERE id = ?')
    .run('Changed after reviewed preflight', 'fixture-healthy-submission-0');
  liveDrift.close();
  await assert.rejects(
    approvedApply(sourceFixture, dryRun, matchingBackup),
    /live.*preflight|preflight.*live|digest/i,
  );
});

test('F-02 rolls back completely after every mutation boundary and on CAS conflict', async (t) => {
  for (const afterMutation of [1, 2, 3]) {
    await t.test(`failure after mutation ${afterMutation}`, async (subtest) => {
      const fixture = await createIncidentFixture(subtest);
      const dryRun = await approvedDryRun(fixture);
      const backup = await createFixtureBackup(fixture);
      const before = snapshotDatabase(fixture.databasePath);
      await assert.rejects(
        approvedApply(fixture, dryRun, backup, { testHooks: { failAfterMutation: afterMutation } }),
        new RegExp(`injected failure after mutation ${afterMutation}`, 'i'),
      );
      assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
    });
  }

  await t.test('compare-and-set conflict', async (subtest) => {
    const fixture = await createIncidentFixture(subtest);
    const dryRun = await approvedDryRun(fixture);
    const backup = await createFixtureBackup(fixture);
    const before = snapshotDatabase(fixture.databasePath);
    await assert.rejects(
      approvedApply(fixture, dryRun, backup, { testHooks: { forceCasConflictAt: 2 } }),
      /compare-and-set.*2|mutation 2.*one row/i,
    );
    assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
  });
});

test('F-02 normal startup creates only the deferred unique index and refreshes cached ownership health', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  await approvedApply(fixture, dryRun, backup);

  const independentlyVerified = await approvedDryRun(fixture);
  assert.equal(independentlyVerified.status, 'already-satisfied');
  const rowsBeforeStartup = snapshotDatabase(fixture.databasePath);
  const schemaBefore = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  const objectsBefore = schemaBefore.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
  schemaBefore.close();

  const storage = createSqliteStorage(fixture.config);
  const ownershipHealth = await storage.getDealHunterCanonicalCrmOwnershipHealth();
  storage.close();

  const schemaAfter = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  const objectsAfter = schemaAfter.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
  const legacyClaim = schemaAfter.prepare('SELECT opportunity_id FROM deal_hunter_crm_imports WHERE id = ?')
    .get(DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations[0].id);
  schemaAfter.close();

  assert.equal(ownershipHealth.healthy, true);
  assert.deepEqual(ownershipHealth.collisions, []);
  assert.deepEqual(snapshotDatabase(fixture.databasePath), rowsBeforeStartup);
  assert.equal(legacyClaim.opportunity_id, null);
  const createdObjects = objectsAfter.filter((after) => !objectsBefore.some(
    (before) => before.type === after.type && before.name === after.name,
  ));
  assert.deepEqual(createdObjects.map((item) => [item.type, item.name]), [
    ['index', 'idx_deal_hunter_crm_imports_unique_opportunity'],
  ]);
});

test('F-02 CLI is dry-run by default and exposes no arbitrary mutation selectors', async () => {
  const { parseDealHunterCrmIntegrityF02Args } = await import(
    '../scripts/repair-deal-hunter-crm-integrity-f02.js'
  );
  const required = [
    '--actor', execution.actor,
    '--reason', execution.reason,
    '--execution-release', execution.executionRelease,
    '--tooling-revision', execution.toolingRevision,
  ];

  const dryRun = parseDealHunterCrmIntegrityF02Args(required);

  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.actor, execution.actor);
  assert.equal(dryRun.reason, execution.reason);
  assert.throws(
    () => parseDealHunterCrmIntegrityF02Args([...required, '--submission-id', 'operator-selected']),
    /unknown option|submission-id/i,
  );
  assert.throws(
    () => parseDealHunterCrmIntegrityF02Args([...required, '--apply']),
    /checksum|manifest|backup|confirm/i,
  );
});

test('F-02 stale and foreign-key-invalid backups are refused', async (t) => {
  await t.test('stale backup', async (subtest) => {
    const fixture = await createIncidentFixture(subtest);
    const dryRun = await approvedDryRun(fixture);
    const staleBackup = await createFixtureBackup(fixture, '2026-09-13T00:30:00.000Z');
    await assert.rejects(approvedApply(fixture, dryRun, staleBackup), /stale|predates/i);
  });

  await t.test('foreign-key-invalid backup', async (subtest) => {
    const fixture = await createIncidentFixture(subtest);
    const database = new Database(fixture.databasePath, { fileMustExist: true });
    database.pragma('foreign_keys = OFF');
    database.exec(`
      CREATE TABLE fixture_fk_parent (id TEXT PRIMARY KEY);
      CREATE TABLE fixture_fk_child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES fixture_fk_parent(id)
      );
      INSERT INTO fixture_fk_child (id, parent_id) VALUES ('child', 'missing-parent');
    `);
    database.close();
    const authority = (() => {
      const read = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
      try {
        return syntheticAuthority(read);
      } finally {
        read.close();
      }
    })();
    fixture.authority = authority;
    const dryRun = await approvedDryRun(fixture);
    const invalidBackup = await createFixtureBackup(fixture);
    await assert.rejects(approvedApply(fixture, dryRun, invalidBackup), /foreign-key/i);
  });
});

test('F-02 rejects tampered reviewed manifests and wrong-provider apply', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const tampered = structuredClone(dryRun.approvalManifest);
  tampered.plan.reason = 'A different reason that was never owner reviewed.';

  await assert.rejects(
    approvedApply(fixture, dryRun, backup, { reviewedManifest: tampered }),
    /manifest checksum/i,
  );
  await assert.rejects(
    approvedApply(fixture, dryRun, backup, { provider: 'supabase' }),
    /provider.*SQLite/i,
  );
});

test('F-02 repeated apply on the exact corrected state performs zero writes', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  await approvedApply(fixture, dryRun, backup);
  const corrected = snapshotDatabase(fixture.databasePath);

  const repeated = await approvedApply(fixture, dryRun, backup);

  assert.equal(repeated.status, 'already-satisfied');
  assert.equal(repeated.applied, false);
  assert.equal(repeated.mutationCount, 0);
  assert.deepEqual(snapshotDatabase(fixture.databasePath), corrected);
});

test('F-02 CLI consumes its retained dry-run artifact without exposing synthetic authority flags', async (t) => {
  const fixture = await createIncidentFixture(t);
  const { runDealHunterCrmIntegrityF02Cli } = await import(
    '../scripts/repair-deal-hunter-crm-integrity-f02.js'
  );
  const commonArgs = [
    '--actor', execution.actor,
    '--reason', execution.reason,
    '--execution-release', execution.executionRelease,
    '--tooling-revision', execution.toolingRevision,
  ];
  const getConfigFn = () => fixture.config;
  const dryRun = await runDealHunterCrmIntegrityF02Cli({
    argv: commonArgs,
    getConfigFn,
    authority: fixture.authority,
    generatedAt: '2026-09-13T01:00:00.000Z',
  });
  assert.equal(dryRun.status, 'repair-required');
  const artifactPath = path.join(fixture.root, 'reviewed-dry-run.json');
  fs.writeFileSync(artifactPath, `${JSON.stringify(dryRun, null, 2)}\n`);
  const backup = await createFixtureBackup(fixture);

  const applied = await runDealHunterCrmIntegrityF02Cli({
    argv: [
      ...commonArgs,
      '--apply',
      '--expected-plan-checksum', dryRun.planChecksum,
      '--reviewed-manifest', artifactPath,
      '--backup', backup.path,
      '--confirm', DEAL_HUNTER_CRM_INTEGRITY_F02_CONFIRMATION,
    ],
    getConfigFn,
    authority: fixture.authority,
    completedAt: '2026-09-13T03:00:00.000Z',
  });

  assert.equal(applied.status, 'applied');
  assert.equal(applied.mutationCount, 3);
  const receiptPath = path.join(fixture.root, 'execution-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(applied, null, 2)}\n`);
  const verified = await runDealHunterCrmIntegrityF02Cli({
    argv: [...commonArgs, '--prior-receipt', receiptPath],
    getConfigFn,
    authority: fixture.authority,
    generatedAt: '2026-09-13T04:00:00.000Z',
  });
  assert.equal(verified.status, 'verified-prior-apply');
});

test('F-02 already-correct apply still refuses unrelated live drift from the reviewed digest', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  await approvedApply(fixture, dryRun, backup);
  const database = new Database(fixture.databasePath, { fileMustExist: true });
  database.prepare('UPDATE deal_hunter_opportunities SET canonical_name = ? WHERE opportunity_id = ?')
    .run('Unreviewed unrelated drift', 'opp_fixture_unclaimed_444');
  database.close();
  const drifted = snapshotDatabase(fixture.databasePath);

  await assert.rejects(
    approvedApply(fixture, dryRun, backup),
    /live database.*reviewed preflight|live preflight.*digest/i,
  );
  assert.deepEqual(snapshotDatabase(fixture.databasePath), drifted);
});

test('F-02 apply binds the inspected backup bytes to the verified manifest checksum', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const before = snapshotDatabase(fixture.databasePath);

  await assert.rejects(
    approvedApply(fixture, dryRun, backup, {
      testHooks: {
        afterBackupVerification({ snapshotPath }) {
          const database = new Database(snapshotPath, { fileMustExist: true });
          database.pragma('user_version = 7');
          database.close();
        },
      },
    }),
    /backup.*checksum|verified.*bytes|snapshot.*changed/i,
  );
  assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
});
