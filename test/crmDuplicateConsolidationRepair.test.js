import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  buildCrmDuplicateConsolidationPlan,
  CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR,
  CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
  getCrmDuplicateConsolidationDescriptor,
  stableCanonicalJson,
} from '../server/repairs/crmDuplicateConsolidation.js';
import {
  applyCrmDuplicateConsolidation,
  previewCrmDuplicateConsolidation,
  verifyCrmDuplicateConsolidationReviewedArtifact,
} from '../server/services/crmDuplicateConsolidationRepair.js';
import {
  createSqliteCrmDuplicateConsolidationReadOnlyStorage,
  createSqliteStorage,
} from '../server/storage/sqlite.js';

const NOW = '2026-09-19T17:00:00.000Z';
const ACTOR = 'task-8-test-operator';
const REASON = 'Owner-reviewed consolidation of the two fixed historical CRM duplicate pairs.';
const RELEASE = 'v126-test';
const TOOLING = '0cb936ccfb2febb3366d2bff1ef573f1cf07adb8';
const POOLER = {
  key: 'pooler',
  opportunityId: 'opp_683681c2-bd49-4c46-be4f-6d969143d907',
  survivorSubmissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
  supersededSubmissionId: 'b36a4b33-d35c-4e8d-b6c3-b6301030a92b',
  listingIdentity: 'costar:2516010',
  askingPrice: '$1,580,000',
  revenue: '$3,535,760',
  financialLabel: 'Annual Profit',
  financialValue: '$535,397',
};

const BERLIN = {
  key: 'berlin',
  opportunityId: 'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
  survivorSubmissionId: '0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da',
  supersededSubmissionId: '8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3',
  listingIdentity: 'costar:2436873',
  askingPrice: '$1,400,000',
  revenue: '$3,535,760',
  financialLabel: 'Annual Profit',
  financialValue: '$490,070',
};

const BERLIN_IMPORT_ID = '508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8';
const BERLIN_CANONICAL_IMPORT_ID = '4e2075ca935de95f09a80bdcdc51ac513c9ab5864f384d20f7ad123f139357ad';
const POOLER_IMPORT_IDS = [
  'cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31',
  'fa231f927904b40a3ef6fd762f37b7830e9aab92c013d39ed740f51e3c84bfd0',
];

function canonicalDigest(value) {
  return createHash('sha256').update(stableCanonicalJson(value)).digest('hex');
}

function rawDatabase(sqlitePath, callback, options = {}) {
  const database = new Database(sqlitePath, { fileMustExist: true, ...options });
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function logicalSnapshot(sqlitePath) {
  return rawDatabase(sqlitePath, (database) => {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    return Object.fromEntries(tables.map((table) => {
      const rows = database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
        .sort((left, right) => {
          const leftJson = stableCanonicalJson(left);
          const rightJson = stableCanonicalJson(right);
          return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
        });
      return [table, rows];
    }));
  }, { readonly: true });
}

function submission(pair, role) {
  const isSurvivor = role === 'survivor';
  const id = isSurvivor ? pair.survivorSubmissionId : pair.supersededSubmissionId;
  const listingUrl = pair.key === 'berlin' && !isSurvivor
    ? ''
    : `https://www.bizbuysell.com/business-opportunity/reviewed/${pair.listingIdentity.split(':')[1]}/`;
  const syntheticBerlinDealKey = isSurvivor
    ? 'SYNTHETIC-CI-BERLIN-SURVIVOR-DEAL-KEY'
    : 'SYNTHETIC-CI-BERLIN-SUPERSEDED-DEAL-KEY';
  return {
    id,
    created_at: NOW,
    updated_at: NOW,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: null,
    crm_status: 'not-applicable',
    crm_error: null,
    source: 'task-8-disposable-fixture',
    ip_hash: '',
    user_agent: '',
    name: `Private ${pair.key} ${role}`,
    email: `${pair.key}-${role}@private.invalid`,
    phone: '',
    company: `Private ${pair.key}`,
    role: 'Broker',
    message: 'Private message excluded from preview artifacts.',
    status_updated_at: NOW,
    listing_url: listingUrl,
    business_website: '',
    prospectus_url: '',
    asking_price: pair.askingPrice,
    ttm_revenue: pair.revenue,
    ttm_ebitda: pair.financialValue,
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: 'Private broker',
    broker_email: 'private-broker@invalid.example',
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'urgent',
    tags: [],
    assigned_to: '',
    notes: 'Private note excluded from preview artifacts.',
    follow_up_state: 'needs-response',
    next_action_at: NOW,
    last_contacted_at: null,
    deal_hunter_opportunity_id: null,
    metadata: {
      dealHunter: {
        ...(isSurvivor ? { opportunityId: pair.opportunityId } : {}),
        ...(isSurvivor ? {
          listingAliases: [listingUrl],
          identityAliases: [pair.listingIdentity],
        } : {}),
        ...(pair.key === 'berlin' ? {
          dealKey: syntheticBerlinDealKey,
          sourceId: 'sheet-0',
          sourceMode: 'csv',
          externalId: isSurvivor ? '44' : '18',
          ...(isSurvivor ? {
            dealKeyAliases: [
              syntheticBerlinDealKey,
              'SYNTHETIC-CI-BERLIN-SUPERSEDED-DEAL-KEY',
            ],
            sourceRecords: [
              {
                sourceId: 'sheet-0',
                sourceMode: 'csv',
                externalId: '44',
                listingUrl,
              },
              {
                sourceId: 'deal-os-export',
                sourceMode: 'manual-export',
                externalId: '',
                listingUrl,
              },
            ],
          } : {}),
        } : {}),
        raw: { 'Annual Profit': pair.financialValue },
      },
      privateBody: `Private metadata ${pair.key} ${role}`,
    },
  };
}

function insertImport(database, {
  id,
  pair,
  submissionId,
  opportunityId = null,
  listingIdentity = pair.listingIdentity,
  dealKey = `url:https://fixture.invalid/${pair.key}/${id}`,
  listingUrl = `https://fixture.invalid/${pair.key}/${id}`,
  metadata = {},
}) {
  database.prepare(`
    INSERT INTO deal_hunter_crm_imports (
      id, created_at, updated_at, deal_key, listing_identity, listing_url,
      submission_id, status, source_name, metadata, opportunity_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', 'task-8-fixture', '{}', ?)
  `).run(
    id,
    NOW,
    NOW,
    dealKey,
    listingIdentity,
    listingUrl,
    submissionId,
    opportunityId,
  );
  database.prepare('UPDATE deal_hunter_crm_imports SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), id);
}

async function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-task8-repair-'));
  const sqlitePath = path.join(root, 'storage.sqlite');
  const config = {
    storage: { provider: 'sqlite', sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
    dealHunter: {
      cimFollowUp: { enabled: false },
      cimAutomation: { schedulerEnabled: false },
    },
  };
  const storage = createSqliteStorage(config, { crmDuplicateConsolidationEnvironment: {} });
  t.after(() => {
    try { storage.close(); } catch { /* already closed by the test */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const pair of [POOLER, BERLIN]) {
    await storage.insertSubmission(submission(pair, 'survivor'));
    await storage.insertSubmission(submission(pair, 'loser'));
    await storage.upsertDealHunterOpportunity({
      opportunity_id: pair.opportunityId,
      created_at: NOW,
      updated_at: NOW,
      canonical_name: `${pair.key} reviewed opportunity`,
      canonical_recipient: null,
      canonical_location: pair.key === 'pooler' ? 'Pooler, Georgia' : 'Berlin Township, New Jersey',
      primary_submission_id: pair.survivorSubmissionId,
      identity_version: 'cim-opportunity-v1',
      status: 'active',
      metadata: {},
    });
  }
  await storage.upsertDealHunterCimSafetySettings({
    updated_at: NOW,
    outreach_paused: true,
    updated_by: ACTOR,
    metadata: {},
  });
  rawDatabase(sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_automation_settings (id, updated_at, paused, updated_by, metadata)
      VALUES ('cim-initial-outreach', ?, 1, ?, '{}')
      ON CONFLICT(id) DO UPDATE SET paused = 1, updated_at = excluded.updated_at,
        updated_by = excluded.updated_by, metadata = excluded.metadata
    `).run(NOW, ACTOR);
    insertImport(database, {
      id: POOLER_IMPORT_IDS[0], pair: POOLER,
      submissionId: POOLER.survivorSubmissionId, listingIdentity: null,
    });
    insertImport(database, {
      id: POOLER_IMPORT_IDS[1], pair: POOLER,
      submissionId: POOLER.survivorSubmissionId, opportunityId: POOLER.opportunityId,
    });
    insertImport(database, {
      id: BERLIN_CANONICAL_IMPORT_ID, pair: BERLIN,
      submissionId: BERLIN.survivorSubmissionId, opportunityId: BERLIN.opportunityId,
      listingIdentity: `bizbuysell.com/business-opportunity/reviewed/${BERLIN.listingIdentity.split(':')[1]}`,
      dealKey: 'SYNTHETIC-CI-BERLIN-SURVIVOR-DEAL-KEY',
      listingUrl: `https://www.bizbuysell.com/business-opportunity/reviewed/${BERLIN.listingIdentity.split(':')[1]}/`,
      metadata: {
        sourceId: 'sheet-0',
        sourceMode: 'csv',
      },
    });
    insertImport(database, {
      id: BERLIN_IMPORT_ID, pair: BERLIN, submissionId: BERLIN.supersededSubmissionId,
      listingIdentity: '',
      listingUrl: '',
      dealKey: 'SYNTHETIC-CI-BERLIN-SUPERSEDED-DEAL-KEY',
      metadata: { sourceId: 'sheet-0', sourceMode: 'csv' },
    });
  });

  const backupPath = path.join(root, 'pre-apply.sqlite');
  await storage.createApplicationBackup(backupPath);
  const backupSha256 = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  const recoveryCheckpoint = {
    backupPath,
    backupManifestId: 'task-8-backup-manifest',
    backupSha256,
    backupProvider: 'sqlite',
    backupStatus: 'verified',
    backupQuickCheck: 'ok',
    backupForeignKeyViolationCount: 0,
    flySnapshotId: 'task-8-fly-snapshot',
    flySnapshotDigest: 'c'.repeat(64),
    flySnapshotStatus: 'created',
    flyRelease: RELEASE,
    toolingRevision: TOOLING,
    createdAt: NOW,
    verifiedAt: NOW,
  };
  return { root, sqlitePath, config, storage, backupPath, recoveryCheckpoint };
}

async function previewFixture(fixture) {
  const readOnly = createSqliteCrmDuplicateConsolidationReadOnlyStorage(
    fixture.config,
    { environment: {} },
  );
  try {
    return await previewCrmDuplicateConsolidation({
      storage: readOnly,
      actor: ACTOR,
      reason: REASON,
      executionRelease: RELEASE,
      toolingRevision: TOOLING,
      recoveryCheckpoint: fixture.recoveryCheckpoint,
    });
  } finally {
    readOnly.close();
  }
}

async function syntheticReviewedArtifactFixture(fixture) {
  const readOnly = createSqliteCrmDuplicateConsolidationReadOnlyStorage(
    fixture.config,
    { environment: {} },
  );
  try {
    const inspection = await readOnly.inspectCrmDuplicateConsolidation();
    const planned = buildCrmDuplicateConsolidationPlan({
      inspection: { ...inspection, blockers: [] },
      actor: ACTOR,
      reason: REASON,
      executionRelease: RELEASE,
      toolingRevision: TOOLING,
      recoveryCheckpoint: fixture.recoveryCheckpoint,
    });
    return {
      status: 'synthetic-contract-artifact',
      mode: 'test-only',
      applied: false,
      blockers: inspection.blockers,
      repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
      repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
      approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
      planSchema: CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
      manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
      manifestId: planned.manifestId,
      planChecksum: planned.planChecksum,
      recoveryCheckpointPath: fixture.recoveryCheckpoint.backupPath,
      connection: inspection.connection,
      plan: planned.plan,
    };
  } finally {
    readOnly.close();
  }
}

function applyInput(fixture, reviewedArtifact, overrides = {}) {
  return {
    apply: true,
    storage: fixture.storage,
    reviewedArtifact,
    expectedPlanChecksum: reviewedArtifact.planChecksum,
    expectedManifestId: reviewedArtifact.manifestId,
    backup: {
      path: fixture.recoveryCheckpoint.backupPath,
      manifestId: fixture.recoveryCheckpoint.backupManifestId,
      sha256: fixture.recoveryCheckpoint.backupSha256,
      flySnapshotId: fixture.recoveryCheckpoint.flySnapshotId,
      flySnapshotDigest: fixture.recoveryCheckpoint.flySnapshotDigest,
    },
    actor: ACTOR,
    reason: REASON,
    executionRelease: RELEASE,
    toolingRevision: TOOLING,
    confirmation: CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
    now: new Date(NOW),
    ...overrides,
  };
}

if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
test('descriptor freezes exactly the reviewed incident and four-row ledger', () => {
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE, 'crm-duplicate-consolidation');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA, 'crm-duplicate-consolidation-approval-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs, [POOLER, {
    ...BERLIN,
    supersededDealKeySha256: '3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733',
    supersededSource: { sourceId: 'sheet-0', sourceMode: 'csv', externalId: '18' },
  }]);
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport, {
    id: BERLIN_IMPORT_ID,
    beforeSubmissionId: BERLIN.supersededSubmissionId,
    afterSubmissionId: BERLIN.survivorSubmissionId,
    opportunityId: null,
    dealKeySha256: '3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733',
    sourceId: 'sheet-0',
    sourceMode: 'csv',
  });
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinCanonicalImport, {
    id: BERLIN_CANONICAL_IMPORT_ID,
    submissionId: BERLIN.survivorSubmissionId,
    opportunityId: BERLIN.opportunityId,
    listingIdentity: BERLIN.listingIdentity,
  });
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR), true);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs), true);
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER, [
    { table: 'crm_submission_supersessions', operation: 'insert', key: 'pooler' },
    { table: 'crm_submission_supersessions', operation: 'insert', key: 'berlin' },
    { table: 'deal_hunter_crm_imports', operation: 'update', key: BERLIN_IMPORT_ID },
    { table: 'deal_hunter_cim_repair_manifests', operation: 'insert', key: 'manifest' },
  ]);
});

test('runtime selectors cannot add, remove, swap, or cross the two immutable pairs', () => {
  assert.equal(getCrmDuplicateConsolidationDescriptor(), CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR);
  const forged = [
    { opportunityId: 'arbitrary' },
    { pairs: [POOLER] },
    { pairs: [BERLIN, POOLER] },
    { survivorSubmissionId: POOLER.supersededSubmissionId, supersededSubmissionId: POOLER.survivorSubmissionId },
    { survivorSubmissionId: BERLIN.survivorSubmissionId, supersededSubmissionId: POOLER.supersededSubmissionId },
  ];
  for (const input of forged) {
    assert.throws(() => getCrmDuplicateConsolidationDescriptor(input), /does not accept runtime.*ids|fixed.*incident/i);
  }
  assert.notEqual(POOLER.opportunityId, BERLIN.opportunityId);
  assert.equal(new Set(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.flatMap((pair) => (
    [pair.survivorSubmissionId, pair.supersededSubmissionId]
  ))).size, 4);
});

test('ordinary CI uses a clearly labeled synthetic Berlin identity and the fixed digest refuses mutation-free', async (t) => {
  const fixture = await createFixture(t);
  const before = logicalSnapshot(fixture.sqlitePath);
  const readOnly = createSqliteCrmDuplicateConsolidationReadOnlyStorage(
    fixture.config,
    { environment: {} },
  );
  try {
    const first = await readOnly.inspectCrmDuplicateConsolidation();
    const second = await readOnly.inspectCrmDuplicateConsolidation();
    assert.equal(first.connection.readonly, true);
    assert.equal(first.connection.fileMustExist, true);
    assert.equal(first.connection.queryOnly, true);
    assert.equal(first.connection.consistentReadTransaction, true);
    assert.deepEqual(first, second);
    assert.ok(first.blockers.includes('berlin-superseded-deal-key-digest-drift'));
    assert.ok(first.blockers.includes('berlin-survivor-deal-key-corroboration-drift'));
    assert.equal(first.blockers.includes('berlin-canonical-import-identity-drift'), false);
    assert.equal(first.blockers.includes('berlin-legacy-import-identity-drift'), true);
    assert.equal(first.blockers.some((blocker) => /listing-pooler|financial-.*-pooler/i.test(blocker)), false);
    assert.equal(first.database.authorityLogicalDigest, canonicalDigest(Object.fromEntries(
      Object.entries(before).filter(([name]) => !CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES.includes(name)),
    )));
  } finally {
    readOnly.close();
  }
  assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  await assert.rejects(previewFixture(fixture), (error) => (
    error?.code === 'CRM_DUPLICATE_CONSOLIDATION_REFUSED'
      && error.blockers.includes('berlin-superseded-deal-key-digest-drift')
  ));
});

test('preview refuses inspection evidence from the ordinary writable SQLite storage', async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    previewCrmDuplicateConsolidation({
      storage: fixture.storage,
      actor: ACTOR,
      reason: REASON,
      executionRelease: RELEASE,
      toolingRevision: TOOLING,
      recoveryCheckpoint: fixture.recoveryCheckpoint,
    }),
    (error) => error?.code === 'CRM_DUPLICATE_CONSOLIDATION_REFUSED'
      && /read.?only|query.?only|inspection evidence/i.test(error.message),
  );
});

test('synthetic public artifact exercises canonical V3 validation but cannot authorize the fixed transaction', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  const verified = verifyCrmDuplicateConsolidationReviewedArtifact({
    artifact: stableCanonicalJson(artifact),
    expectedPlanChecksum: artifact.planChecksum,
    expectedManifestId: artifact.manifestId,
  });
  assert.equal(verified.planChecksum, artifact.planChecksum);
  assert.equal(verified.plan.planSchema, 'crm-duplicate-consolidation-plan-v3');
  assert.ok(verified.plan.runtimeSafetyAuthority.digest);
  await assert.rejects(
    applyCrmDuplicateConsolidation(applyInput(fixture, artifact)),
    /berlin-superseded-deal-key-digest-drift|live raw-row.*drift|unsafe state/i,
  );

  for (const [name, mutation] of [
    ['checksum', (value) => { value.planChecksum = '0'.repeat(64); }],
    ['manifest', (value) => { value.manifestId = 'wrong'; }],
    ['tuple', (value) => { value.plan.approval.pairs[0].survivorSubmissionId = POOLER.supersededSubmissionId; }],
    ['schema', (value) => { value.plan.planSchema = 'wrong'; }],
  ]) {
    const changed = structuredClone(artifact);
    mutation(changed);
    assert.throws(() => verifyCrmDuplicateConsolidationReviewedArtifact({
      artifact: changed,
      expectedPlanChecksum: artifact.planChecksum,
      expectedManifestId: artifact.manifestId,
    }), name === 'manifest' ? /manifest/i : /checksum|tuple|schema/i);
  }
});
}

export {
  ACTOR,
  BERLIN,
  BERLIN_CANONICAL_IMPORT_ID,
  BERLIN_IMPORT_ID,
  NOW,
  POOLER,
  POOLER_IMPORT_IDS,
  REASON,
  RELEASE,
  TOOLING,
  applyInput,
  createFixture,
  logicalSnapshot,
  previewFixture,
  rawDatabase,
  stableCanonicalJson,
  syntheticReviewedArtifactFixture,
};
