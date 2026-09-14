import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY,
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION,
  createDealHunterCrmIntegrityF02Repair2ApprovalManifest,
  createDealHunterCrmIntegrityF02Repair2TestAuthority,
  fingerprintDealHunterCrmIntegrityF02Repair2RawRow,
} from '../server/repairs/dealHunterCrmIntegrityF02Repair2.js';
import {
  applyDealHunterCrmIntegrityF02Repair2,
  evaluateDealHunterCrmIntegrityF02Repair2DeclaredOwner,
  inspectDealHunterCrmIntegrityF02Repair2,
} from '../server/services/dealHunterCrmIntegrityF02Repair2.js';
import { createBackupBundle } from '../server/services/backups.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const execution = {
  actor: 'Owner Reviewer',
  reason: 'Repair the three reviewed F-02 Repair2 CRM integrity defects.',
  executionRelease: 'release-123',
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
  const relationships = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships;
  const collision = relationships.collision;
  const backlink = relationships.backlink;
  const managedName = relationships.managedName;
  const reviewedUnrelatedOpportunity = relationships.reviewedUnrelatedOpportunity;
  const backlinkImport = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports
    WHERE opportunity_id = ? AND submission_id = ?
  `).get(backlink.opportunityId, backlink.submissionId);
  return createDealHunterCrmIntegrityF02Repair2TestAuthority({
    legacyCollisionImport: rawFingerprint(rawRow(database, 'deal_hunter_crm_imports', 'id', collision.legacyImportId)),
    retainedUrlImport: rawFingerprint(rawRow(database, 'deal_hunter_crm_imports', 'id', collision.retainedImportId)),
    collisionOpportunity: rawFingerprint(rawRow(database, 'deal_hunter_opportunities', 'opportunity_id', collision.opportunityId)),
    collisionSubmission: rawFingerprint(rawRow(database, 'contact_submissions', 'id', collision.sharedSubmissionId)),
    backlinkOpportunity: rawFingerprint(rawRow(database, 'deal_hunter_opportunities', 'opportunity_id', backlink.opportunityId)),
    backlinkImport: rawFingerprint(backlinkImport),
    backlinkSubmission: rawFingerprint(rawRow(database, 'contact_submissions', 'id', backlink.submissionId)),
    nameMismatchSubmission: rawFingerprint(rawRow(database, 'contact_submissions', 'id', managedName.submissionId)),
    reviewedUnrelatedOpportunity: rawFingerprint(rawRow(
      database,
      'deal_hunter_opportunities',
      'opportunity_id',
      reviewedUnrelatedOpportunity.opportunityId,
    )),
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
  const mutations = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.mutations;
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
  const collision = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.collision;
  const backlink = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.backlink;
  const managedName = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.managedName;
  const reviewedUnrelatedOpportunity =
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.reviewedUnrelatedOpportunity;
  try {
    database.exec('DROP INDEX IF EXISTS idx_deal_hunter_crm_imports_unique_opportunity');

    insertSubmission(database, {
      id: collision.sharedSubmissionId,
      company: 'Synthetic Collision Company',
      opportunityId: null,
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
      company: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.mutations[2].before,
      opportunityId: null,
      metadata: {
        dealHunter: {
          managed: true,
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
    for (let index = 0; index < 27; index += 1) {
      insertOpportunity(database, `opp_fixture_healthy_${index}`, `fixture-healthy-submission-${index}`, index + 10);
    }
    for (let index = 0; index < 446; index += 1) {
      insertOpportunity(database, `opp_fixture_unclaimed_${index}`, null, index + 100);
    }
    insertOpportunity(database, reviewedUnrelatedOpportunity.opportunityId, null, 999);
    database.prepare(`
      UPDATE deal_hunter_opportunities
      SET canonical_name = ?, canonical_location = ?, metadata = ?
      WHERE opportunity_id = ?
    `).run(
      reviewedUnrelatedOpportunity.canonicalName,
      'Bridgeport, CT, US',
      JSON.stringify({ identitySnapshot: { listingIds: [reviewedUnrelatedOpportunity.listingId] } }),
      reviewedUnrelatedOpportunity.opportunityId,
    );

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
      opportunityId: null,
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
  return inspectDealHunterCrmIntegrityF02Repair2({
    databasePath: fixture.databasePath,
    provider: 'sqlite',
    authority: fixture.authority,
    generatedAt: '2026-09-13T01:00:00.000Z',
    ...execution,
    ...overrides,
  });
}

async function approvedApply(fixture, dryRun, backup, overrides = {}) {
  return applyDealHunterCrmIntegrityF02Repair2({
    databasePath: fixture.databasePath,
    provider: 'sqlite',
    authority: fixture.authority,
    reviewedManifest: dryRun.approvalManifest,
    expectedPlanChecksum: dryRun.planChecksum,
    confirmation: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION,
    backupPath: backup.path,
    completedAt: '2026-09-13T03:00:00.000Z',
    ...execution,
    ...overrides,
  });
}

test('F-02 Repair2 raw row fingerprints preserve SELECT-star property order exactly', () => {
  const rawRow = {
    id: 'row-1',
    opportunity_id: null,
    updated_at: '2026-09-13T00:00:00.000Z',
  };

  assert.equal(
    fingerprintDealHunterCrmIntegrityF02Repair2RawRow(rawRow),
    '46608be2aac3440432e12be08fce836463b1580cb92996708722e9c8a3841176',
  );
  assert.notEqual(
    fingerprintDealHunterCrmIntegrityF02Repair2RawRow({
      updated_at: rawRow.updated_at,
      opportunity_id: rawRow.opportunity_id,
      id: rawRow.id,
    }),
    '46608be2aac3440432e12be08fce836463b1580cb92996708722e9c8a3841176',
  );
});

test('F-02 Repair2 authority fixes the three mutations and all diagnostic guards', () => {
  assert.equal(DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.evidence.release, '122');
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.evidence.revision,
    '9fcfe65505348421373242aa304caefb4b30396b',
  );
  assert.deepEqual(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.evidence.supersession.opportunityCount,
    {
      before: 475,
      after: 476,
      reviewedAddition: 'opp_5ae93328-11e3-49de-b3f1-d28d4e76242e',
      workflow: 'september-13-daily-digest-full-backfill-canonicalization',
    },
  );
  assert.deepEqual(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.evidence.supersession
      .collisionOpportunityFingerprint.changedFields,
    ['updated_at'],
  );
  assert.deepEqual(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.evidence.supersession
      .v1DeclaredOwnerContract,
    {
      submissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
      submissionFingerprint: '6b811304f09d44b3737f73b2a479654c4a5c4b45fee4b5e2b6e67542eb674082',
      directOpportunityId: null,
      metadataOpportunityId: 'opp_683681c2-bd49-4c46-be4f-6d969143d907',
      defect: 'v1-required-direct-owner-despite-pinned-metadata-only-row',
    },
  );
  assert.deepEqual(DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.mutations, [
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
  assert.deepEqual(DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.expectedAuditBefore, {
    imports: 32,
    opportunities: 476,
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
  assert.equal(Object.keys(DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints).length, 9);
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints.legacyCollisionImport,
    '0650ae104b7123bd94f76772bcd4895c6a9ac088443ac3b37b3f33ee4897ae84',
  );
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints.collisionOpportunity,
    'a538b0ecd23b17a00a20bd6499de6ec922ec7aaeed4311aa84521c5eb668743e',
  );
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints.collisionSubmission,
    '6b811304f09d44b3737f73b2a479654c4a5c4b45fee4b5e2b6e67542eb674082',
  );
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints.reviewedUnrelatedOpportunity,
    '7049798420b1a7bb5a6f027a5cbed6a707fa25a96599a754b56ddea47d3053e8',
  );
  assert.deepEqual(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.collision.claimantImportIds,
    [
      'cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31',
      'fa231f927904b40a3ef6fd762f37b7830e9aab92c013d39ed740f51e3c84bfd0',
    ],
  );
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.collision.declaredOwnerSemantics,
    'direct-or-metadata-with-no-conflict',
  );
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.reviewedUnrelatedOpportunity.listingId,
    'costar:2552696',
  );
});

test('F-02 Repair2 declared-owner predicate accepts only the six reviewed shapes', () => {
  const expectedOpportunityId =
    DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.collision.opportunityId;
  const evaluate = (directOpportunityId, metadataOpportunityId) =>
    evaluateDealHunterCrmIntegrityF02Repair2DeclaredOwner({
      directOpportunityId,
      metadataOpportunityId,
      expectedOpportunityId,
    });

  assert.deepEqual(evaluate(null, expectedOpportunityId), {
    ok: true,
    declaredOpportunityId: expectedOpportunityId,
  });
  assert.deepEqual(evaluate(expectedOpportunityId, ''), {
    ok: true,
    declaredOpportunityId: expectedOpportunityId,
  });
  assert.deepEqual(evaluate(expectedOpportunityId, expectedOpportunityId), {
    ok: true,
    declaredOpportunityId: expectedOpportunityId,
  });
  assert.equal(evaluate(expectedOpportunityId, 'opp_other').blocker, 'COLLISION_DECLARED_OWNER_CONFLICT');
  assert.equal(evaluate(null, 'opp_other').blocker, 'COLLISION_DECLARED_OWNER_MISMATCH');
  assert.equal(evaluate(null, '').blocker, 'COLLISION_DECLARED_OWNER_MISSING');
});

test('F-02 Repair2 service enforces every collision declared-owner shape', async (t) => {
  const collision = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.collision;
  const cases = [
    ['direct NULL and metadata correct', null, collision.opportunityId, 'repair-required', null],
    ['direct correct and metadata empty', collision.opportunityId, '', 'repair-required', null],
    ['both direct and metadata correct', collision.opportunityId, collision.opportunityId, 'repair-required', null],
    ['direct and metadata disagree', collision.opportunityId, 'opp_other', 'refused', 'COLLISION_DECLARED_OWNER_CONFLICT'],
    ['metadata points elsewhere', null, 'opp_other', 'refused', 'COLLISION_DECLARED_OWNER_MISMATCH'],
    ['both owner fields empty', null, '', 'refused', 'COLLISION_DECLARED_OWNER_MISSING'],
  ];

  for (const [name, directOpportunityId, metadataOpportunityId, status, blocker] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createIncidentFixture(subtest);
      const database = new Database(fixture.databasePath, { fileMustExist: true });
      const row = database.prepare('SELECT metadata FROM contact_submissions WHERE id = ?')
        .get(collision.sharedSubmissionId);
      const metadata = JSON.parse(row.metadata);
      metadata.dealHunter.opportunityId = metadataOpportunityId;
      database.prepare(`
        UPDATE contact_submissions
        SET deal_hunter_opportunity_id = ?, metadata = ?
        WHERE id = ?
      `).run(directOpportunityId, JSON.stringify(metadata), collision.sharedSubmissionId);
      fixture.authority = syntheticAuthority(database);
      database.close();

      const result = await approvedDryRun(fixture);

      assert.equal(result.status, status);
      if (blocker) assert.equal(result.blockers.includes(blocker), true);
    });
  }
});

test('F-02 Repair2 plan checksum binds approvals but excludes incidental runtime values', () => {
  const approval = {
    actor: 'Owner Reviewer',
    reason: 'Repair the three reviewed F-02 Repair2 CRM integrity defects.',
    executionRelease: 'release-121',
    toolingRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const first = createDealHunterCrmIntegrityF02Repair2ApprovalManifest({
    ...approval,
    generatedAt: '2026-09-13T01:00:00.000Z',
    databasePath: '/tmp/one.sqlite',
  });
  const second = createDealHunterCrmIntegrityF02Repair2ApprovalManifest({
    ...approval,
    generatedAt: '2026-09-13T02:00:00.000Z',
    databasePath: '/tmp/two.sqlite',
  });

  assert.match(first.planChecksum, /^[a-f0-9]{64}$/);
  assert.equal(first.planChecksum, second.planChecksum);
  assert.notEqual(
    first.planChecksum,
    createDealHunterCrmIntegrityF02Repair2ApprovalManifest({ ...approval, actor: 'Another Reviewer' }).planChecksum,
  );
  assert.equal(first.plan.requiredConfirmation, DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION);
  assert.equal(Object.hasOwn(first.plan, 'generatedAt'), false);
  assert.equal(Object.hasOwn(first.plan, 'databasePath'), false);
});

test('F-02 Repair2 dry run reads the exact unsafe incident without durable writes or PII output', async (t) => {
  const fixture = await createIncidentFixture(t);
  const before = snapshotDatabase(fixture.databasePath);

  const result = await approvedDryRun(fixture);

  assert.equal(result.status, 'repair-required');
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, false);
  assert.deepEqual(result.connection, { readonly: true, fileMustExist: true, queryOnly: true });
  assert.deepEqual(result.audit.counts, {
    imports: 32,
    opportunities: 476,
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

test('F-02 Repair2 apply changes exactly three cells and produces the real clean audit', async (t) => {
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
    opportunities: 476,
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

test('F-02 Repair2 corrected state distinguishes satisfaction from validated prior execution', async (t) => {
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

test('F-02 Repair2 refuses partial state, target drift, authority drift, and wrong global counts', async (t) => {
  const cases = [
    {
      name: 'partial state',
      mutate(database) {
        const mutation = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.mutations[0];
        database.prepare('UPDATE deal_hunter_crm_imports SET opportunity_id = ? WHERE id = ?')
          .run(mutation.after, mutation.id);
      },
    },
    {
      name: 'target drift',
      mutate(database) {
        database.prepare('UPDATE contact_submissions SET updated_at = ? WHERE id = ?')
          .run('2026-09-13T09:00:00.000Z', DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.mutations[1].id);
      },
    },
    {
      name: 'authority drift',
      mutate(database) {
        database.prepare('UPDATE deal_hunter_crm_imports SET source_name = ? WHERE id = ?')
          .run('drifted-source', DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships.collision.retainedImportId);
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

test('F-02 Repair2 refuses every reviewed authority and global-guard drift', async (t) => {
  const relationships = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships;
  const scenarios = [
    {
      name: 'primary submission drift',
      blocker: /COLLISION_PRIMARY_RELATIONSHIP_MISMATCH|collisionOpportunity/,
      mutate(database) {
        database.prepare(`
          UPDATE deal_hunter_opportunities SET primary_submission_id = NULL
          WHERE opportunity_id = ?
        `).run(relationships.collision.opportunityId);
      },
    },
    {
      name: 'exact claimant set drift',
      blocker: /COLLISION_IMPORT_AUTHORITY_MISMATCH/,
      mutate(database) {
        database.prepare('UPDATE deal_hunter_crm_imports SET opportunity_id = NULL WHERE id = ?')
          .run(relationships.collision.retainedImportId);
        database.prepare('UPDATE deal_hunter_crm_imports SET opportunity_id = ? WHERE id = ?')
          .run(relationships.collision.opportunityId, 'fixture-unclaimed-import');
      },
    },
    {
      name: 'legacy import opportunity drift',
      blocker: /MIXED_OR_PARTIAL_REPAIR_STATE/,
      mutate(database) {
        database.prepare('UPDATE deal_hunter_crm_imports SET opportunity_id = NULL WHERE id = ?')
          .run(relationships.collision.legacyImportId);
      },
    },
    {
      name: 'retained import drift',
      blocker: /AUTHORITY_FINGERPRINT_MISMATCH:retainedUrlImport/,
      mutate(database) {
        database.prepare('UPDATE deal_hunter_crm_imports SET source_name = ? WHERE id = ?')
          .run('unreviewed-source', relationships.collision.retainedImportId);
      },
    },
    {
      name: 'reviewed 476th opportunity drift',
      blocker: /reviewedUnrelatedOpportunity|REVIEWED_UNRELATED_OPPORTUNITY/,
      mutate(database) {
        database.prepare('UPDATE deal_hunter_opportunities SET canonical_name = ? WHERE opportunity_id = ?')
          .run('Changed Brake Shop', relationships.reviewedUnrelatedOpportunity.opportunityId);
      },
    },
    {
      name: 'opportunity count advances to 477',
      blocker: /AUDIT_GUARD_MISMATCH:opportunities/,
      mutate(database) {
        insertOpportunity(database, 'opp_fixture_unreviewed_477', null, 1000);
      },
    },
    {
      name: 'collision opportunity fingerprint drift',
      blocker: /AUTHORITY_FINGERPRINT_MISMATCH:collisionOpportunity/,
      mutate(database) {
        database.prepare('UPDATE deal_hunter_opportunities SET updated_at = ? WHERE opportunity_id = ?')
          .run('2026-09-14T05:00:00.000Z', relationships.collision.opportunityId);
      },
    },
    {
      name: 'backlink target state drift',
      blocker: /MIXED_OR_PARTIAL_REPAIR_STATE/,
      mutate(database) {
        database.prepare('UPDATE contact_submissions SET deal_hunter_opportunity_id = ? WHERE id = ?')
          .run('opp_other', relationships.backlink.submissionId);
      },
    },
    {
      name: 'managed company before-value drift',
      blocker: /MIXED_OR_PARTIAL_REPAIR_STATE/,
      mutate(database) {
        database.prepare('UPDATE contact_submissions SET company = ? WHERE id = ?')
          .run('Unreviewed Company', relationships.managedName.submissionId);
      },
    },
    {
      name: 'generic audited-submission count drift',
      blocker: /AUDIT_GUARD_MISMATCH:auditedSubmissions/,
      mutate(database) {
        insertSubmission(database, {
          id: 'fixture-unreviewed-managed-submission',
          company: 'Unreviewed Managed Company',
          metadata: {
            dealHunter: {
              managed: true,
              raw: { 'Business Name': 'Unreviewed Managed Company' },
            },
          },
          index: 1000,
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await createIncidentFixture(subtest);
      const database = new Database(fixture.databasePath, { fileMustExist: true });
      scenario.mutate(database);
      database.close();
      const before = snapshotDatabase(fixture.databasePath);

      const result = await approvedDryRun(fixture);

      assert.equal(result.status, 'refused');
      assert.match(result.blockers.join(' '), scenario.blocker);
      assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
    });
  }
});

test('F-02 Repair2 refuses unsupported target triggers and non-SQLite providers', async (t) => {
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

test('F-02 Repair2 apply requires exact approval, execution identity, and current matching backup evidence', async (t) => {
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

test('F-02 Repair2 backup snapshot and live database must both reproduce the reviewed preflight', async (t) => {
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

test('F-02 Repair2 rolls back completely after every mutation boundary and on CAS conflict', async (t) => {
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

test('F-02 Repair2 rolls back when the post-repair audit is not clean', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const before = snapshotDatabase(fixture.databasePath);

  await assert.rejects(
    approvedApply(fixture, dryRun, backup, {
      testHooks: {
        forcePostconditionAuditFailure: true,
      },
    }),
    /postcondition audit failed/i,
  );
  assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
});

test('F-02 Repair2 rolls back when the final foreign-key check fails', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const before = snapshotDatabase(fixture.databasePath);

  await assert.rejects(
    approvedApply(fixture, dryRun, backup, {
      testHooks: {
        forceForeignKeyCheckFailure: true,
      },
    }),
    /foreign-key check failed/i,
  );
  assert.deepEqual(snapshotDatabase(fixture.databasePath), before);
});

test('F-02 Repair2 exposes no writable live-database callback before commit', async (t) => {
  const fixture = await createIncidentFixture(t);
  const dryRun = await approvedDryRun(fixture);
  const backup = await createFixtureBackup(fixture);
  const before = snapshotDatabase(fixture.databasePath);
  let callbackInvoked = false;

  const result = await approvedApply(fixture, dryRun, backup, {
    testHooks: {
      beforePostcondition() {
        callbackInvoked = true;
      },
      beforeForeignKeyCheck() {
        callbackInvoked = true;
      },
    },
  });

  assert.equal(result.status, 'applied');
  assert.equal(callbackInvoked, false);
  assert.deepEqual(snapshotDatabase(fixture.databasePath), expectedAfterSnapshot(before));
});

test('F-02 Repair2 normal startup creates only the deferred unique index and refreshes cached ownership health', async (t) => {
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
    .get(DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.mutations[0].id);
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

test('F-02 Repair2 CLI is dry-run by default and exposes no arbitrary mutation selectors', async () => {
  const { parseDealHunterCrmIntegrityF02Repair2Args } = await import(
    '../scripts/repair-deal-hunter-crm-integrity-f02-repair2.js'
  );
  const required = [
    '--actor', execution.actor,
    '--reason', execution.reason,
    '--execution-release', execution.executionRelease,
    '--tooling-revision', execution.toolingRevision,
  ];

  const dryRun = parseDealHunterCrmIntegrityF02Repair2Args(required);

  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.actor, execution.actor);
  assert.equal(dryRun.reason, execution.reason);
  assert.throws(
    () => parseDealHunterCrmIntegrityF02Repair2Args([...required, '--submission-id', 'operator-selected']),
    /unknown option|submission-id/i,
  );
  assert.throws(
    () => parseDealHunterCrmIntegrityF02Repair2Args([...required, '--apply']),
    /checksum|manifest|backup|confirm/i,
  );
});

test('F-02 Repair2 stale and foreign-key-invalid backups are refused', async (t) => {
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

test('F-02 Repair2 rejects tampered reviewed manifests and wrong-provider apply', async (t) => {
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

test('F-02 Repair2 repeated apply on the exact corrected state performs zero writes', async (t) => {
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

test('F-02 Repair2 CLI consumes its retained dry-run artifact without exposing synthetic authority flags', async (t) => {
  const fixture = await createIncidentFixture(t);
  const { runDealHunterCrmIntegrityF02Repair2Cli } = await import(
    '../scripts/repair-deal-hunter-crm-integrity-f02-repair2.js'
  );
  const commonArgs = [
    '--actor', execution.actor,
    '--reason', execution.reason,
    '--execution-release', execution.executionRelease,
    '--tooling-revision', execution.toolingRevision,
  ];
  const getConfigFn = () => fixture.config;
  const dryRun = await runDealHunterCrmIntegrityF02Repair2Cli({
    argv: commonArgs,
    getConfigFn,
    authority: fixture.authority,
    generatedAt: '2026-09-13T01:00:00.000Z',
  });
  assert.equal(dryRun.status, 'repair-required');
  const artifactPath = path.join(fixture.root, 'reviewed-dry-run.json');
  fs.writeFileSync(artifactPath, `${JSON.stringify(dryRun, null, 2)}\n`);
  const backup = await createFixtureBackup(fixture);

  const applied = await runDealHunterCrmIntegrityF02Repair2Cli({
    argv: [
      ...commonArgs,
      '--apply',
      '--expected-plan-checksum', dryRun.planChecksum,
      '--reviewed-manifest', artifactPath,
      '--backup', backup.path,
      '--confirm', DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION,
    ],
    getConfigFn,
    authority: fixture.authority,
    completedAt: '2026-09-13T03:00:00.000Z',
  });

  assert.equal(applied.status, 'applied');
  assert.equal(applied.mutationCount, 3);
  const receiptPath = path.join(fixture.root, 'execution-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(applied, null, 2)}\n`);
  const verified = await runDealHunterCrmIntegrityF02Repair2Cli({
    argv: [...commonArgs, '--prior-receipt', receiptPath],
    getConfigFn,
    authority: fixture.authority,
    generatedAt: '2026-09-13T04:00:00.000Z',
  });
  assert.equal(verified.status, 'verified-prior-apply');
});

test('F-02 Repair2 already-correct apply still refuses unrelated live drift from the reviewed digest', async (t) => {
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

test('F-02 Repair2 apply binds the inspected backup bytes to the verified manifest checksum', async (t) => {
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
