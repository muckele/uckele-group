import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR,
  CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
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
import { auditDealHunterCrmIntegrity } from '../server/services/dealHunter.js';

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

function tableDigest(sqlitePath, table) {
  const snapshot = logicalSnapshot(sqlitePath);
  return canonicalDigest(snapshot[table] || []);
}

function submission(pair, role) {
  const isSurvivor = role === 'survivor';
  const id = isSurvivor ? pair.survivorSubmissionId : pair.supersededSubmissionId;
  const listingUrl = pair.key === 'berlin' && !isSurvivor
    ? ''
    : `https://www.bizbuysell.com/business-opportunity/reviewed/${pair.listingIdentity.split(':')[1]}/`;
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
        listingAliases: isSurvivor || pair.key === 'pooler' ? [pair.listingIdentity] : [],
        identityAliases: isSurvivor || pair.key === 'pooler' ? [pair.listingIdentity] : [],
        financialProvenance: {
          originalLabel: pair.financialLabel,
          originalValue: pair.financialValue,
          period: 'unknown',
        },
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
    `url:https://fixture.invalid/${pair.key}/${id}`,
    listingIdentity,
    `https://fixture.invalid/${pair.key}/${id}`,
    submissionId,
    opportunityId,
  );
}

async function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-task8-repair-'));
  const sqlitePath = path.join(root, 'storage.sqlite');
  const config = { storage: { provider: 'sqlite', sqlitePath }, protection: { rateLimitRetentionMs: 0 } };
  const storage = createSqliteStorage(config);
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
    metadata: { followUpsDisabled: true, schedulerDisabled: true },
  });
  rawDatabase(sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_automation_settings (id, updated_at, paused, updated_by, metadata)
      VALUES ('global', ?, 1, ?, '{"schedulerDisabled":true}')
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
    });
    insertImport(database, {
      id: BERLIN_IMPORT_ID, pair: BERLIN, submissionId: BERLIN.supersededSubmissionId,
      listingIdentity: null,
    });
  });

  const backupPath = path.join(root, 'pre-apply.sqlite');
  await storage.createApplicationBackup(backupPath);
  const backupSha256 = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  const recoveryCheckpoint = {
    backupPath,
    backupManifestId: 'task-8-backup-manifest',
    backupSha256,
    flySnapshotId: 'task-8-fly-snapshot',
    flySnapshotDigest: 'c'.repeat(64),
    flyRelease: RELEASE,
    createdAt: NOW,
    verifiedAt: NOW,
  };
  return { root, sqlitePath, config, storage, backupPath, recoveryCheckpoint };
}

async function previewFixture(fixture) {
  const readOnly = createSqliteCrmDuplicateConsolidationReadOnlyStorage(fixture.config);
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
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE, 'crm-duplicate-consolidation');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA, 'crm-duplicate-consolidation-approval-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1');
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs, [POOLER, BERLIN]);
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport, {
    id: BERLIN_IMPORT_ID,
    beforeSubmissionId: BERLIN.supersededSubmissionId,
    afterSubmissionId: BERLIN.survivorSubmissionId,
    opportunityId: null,
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

test('read-only preview is one query-only snapshot, deterministic, privacy-safe, and mutation-free', async (t) => {
  const fixture = await createFixture(t);
  const before = logicalSnapshot(fixture.sqlitePath);
  const first = await previewFixture(fixture);
  const second = await previewFixture(fixture);
  const alternateReadOnly = createSqliteCrmDuplicateConsolidationReadOnlyStorage(fixture.config);
  let alternatePath;
  try {
    alternatePath = await previewCrmDuplicateConsolidation({
      storage: alternateReadOnly,
      actor: ACTOR,
      reason: REASON,
      executionRelease: RELEASE,
      toolingRevision: TOOLING,
      recoveryCheckpoint: {
        ...fixture.recoveryCheckpoint,
        backupPath: `${fixture.recoveryCheckpoint.backupPath}.operator-selected-copy`,
      },
    });
  } finally {
    alternateReadOnly.close();
  }
  const after = logicalSnapshot(fixture.sqlitePath);

  assert.equal(first.status, 'repair-required');
  assert.equal(first.connection.readonly, true);
  assert.equal(first.connection.fileMustExist, true);
  assert.equal(first.connection.queryOnly, true);
  assert.equal(first.connection.consistentReadTransaction, true);
  assert.deepEqual(first.blockers, []);
  assert.match(first.planChecksum, /^[a-f0-9]{64}$/);
  assert.equal(first.planChecksum, second.planChecksum);
  assert.equal(first.manifestId, second.manifestId);
  assert.deepEqual(first.plan, second.plan);
  assert.deepEqual(after, before);
  assert.equal(first.plan.database.logicalDigest, canonicalDigest(before));
  assert.match(first.plan.schema.digest, /^[a-f0-9]{64}$/);
  assert.equal(first.plan.rawRows.length >= 9, true);
  assert.ok(first.plan.rawRows.every((row) => /^[a-f0-9]{64}$/.test(row.digest)));
  assert.deepEqual(first.plan.expectedMutationLedger, CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER);
  const { backupPath, ...recoveryReferences } = fixture.recoveryCheckpoint;
  assert.deepEqual(first.plan.recoveryCheckpoint, recoveryReferences);
  assert.equal(first.recoveryCheckpointPath, backupPath);
  assert.equal(alternatePath.recoveryCheckpointPath, `${backupPath}.operator-selected-copy`);
  assert.equal(alternatePath.planChecksum, first.planChecksum);
  assert.deepEqual(alternatePath.plan, first.plan);
  const serialized = stableCanonicalJson(first);
  assert.doesNotMatch(serialized, /private note|private message|private metadata|private-broker@/i);
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

test('reviewed artifact verification binds canonical bytes, checksum, manifest ID, schemas, and fixed tuples', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const verified = verifyCrmDuplicateConsolidationReviewedArtifact({
    artifact: stableCanonicalJson(artifact),
    expectedPlanChecksum: artifact.planChecksum,
    expectedManifestId: artifact.manifestId,
  });
  assert.equal(verified.planChecksum, artifact.planChecksum);
  assert.deepEqual(verified.plan.approval.pairs, [POOLER, BERLIN]);

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

test('first apply changes exactly four approved rows and replay byte-validates the receipt with zero writes', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const before = logicalSnapshot(fixture.sqlitePath);
  const result = await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
  const after = logicalSnapshot(fixture.sqlitePath);

  assert.equal(result.status, 'repair-required');
  assert.equal(result.applied, true);
  assert.equal(result.mutationCount, 4);
  assert.deepEqual(result.mutations, CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER);
  assert.equal(after.crm_submission_supersessions.length - before.crm_submission_supersessions.length, 2);
  assert.equal(after.deal_hunter_cim_repair_manifests.length - before.deal_hunter_cim_repair_manifests.length, 1);
  const beforeBerlin = before.deal_hunter_crm_imports.find((row) => row.id === BERLIN_IMPORT_ID);
  const afterBerlin = after.deal_hunter_crm_imports.find((row) => row.id === BERLIN_IMPORT_ID);
  assert.equal(beforeBerlin.submission_id, BERLIN.supersededSubmissionId);
  assert.equal(afterBerlin.submission_id, BERLIN.survivorSubmissionId);
  assert.equal(afterBerlin.opportunity_id, null);
  assert.deepEqual(
    after.deal_hunter_crm_imports.filter((row) => row.id !== BERLIN_IMPORT_ID),
    before.deal_hunter_crm_imports.filter((row) => row.id !== BERLIN_IMPORT_ID),
  );

  const allowed = new Set(['crm_submission_supersessions', 'deal_hunter_crm_imports', 'deal_hunter_cim_repair_manifests']);
  for (const table of Object.keys(before)) {
    if (!allowed.has(table)) assert.deepEqual(after[table], before[table], `${table} must not change`);
  }

  const receiptBefore = after.deal_hunter_cim_repair_manifests.find((row) => row.id === artifact.manifestId);
  const replayBefore = logicalSnapshot(fixture.sqlitePath);
  const replay = await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
  const replayAfter = logicalSnapshot(fixture.sqlitePath);
  assert.equal(replay.status, 'verified-prior-apply');
  assert.equal(replay.applied, false);
  assert.equal(replay.mutationCount, 0);
  assert.deepEqual(replayAfter, replayBefore);
  assert.deepEqual(
    replayAfter.deal_hunter_cim_repair_manifests.find((row) => row.id === artifact.manifestId),
    receiptBefore,
  );
});

test('apply refuses every missing or mismatched authority argument before mutation', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const before = logicalSnapshot(fixture.sqlitePath);
  const cases = [
    ['apply flag', { apply: false }],
    ['artifact', { reviewedArtifact: null }],
    ['manifest', { expectedManifestId: 'wrong' }],
    ['checksum', { expectedPlanChecksum: '0'.repeat(64) }],
    ['backup path', { backup: { ...applyInput(fixture, artifact).backup, path: '/wrong' } }],
    ['backup manifest', { backup: { ...applyInput(fixture, artifact).backup, manifestId: 'wrong' } }],
    ['backup sha', { backup: { ...applyInput(fixture, artifact).backup, sha256: '0'.repeat(64) } }],
    ['release', { executionRelease: 'wrong' }],
    ['tooling', { toolingRevision: '0'.repeat(40) }],
    ['actor', { actor: 'wrong' }],
    ['reason', { reason: 'wrong reason' }],
    ['confirmation', { confirmation: 'wrong' }],
  ];
  for (const [name, overrides] of cases) {
    await assert.rejects(
      applyCrmDuplicateConsolidation(applyInput(fixture, artifact, overrides)),
      new RegExp(name.split(' ')[0], 'i'),
      name,
    );
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before, name);
  }
});

test('consolidation receipt stays append-only while ordinary manifest upsert remains mutable', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
  const original = logicalSnapshot(fixture.sqlitePath).deal_hunter_cim_repair_manifests
    .find((row) => row.id === artifact.manifestId);

  await assert.rejects(fixture.storage.upsertDealHunterCimRepairManifest({
    ...original,
    status: 'changed',
    checksum: '0'.repeat(64),
    manifest: { changed: true },
    metadata: { changed: true },
  }), /append-only|immutable/i);
  rawDatabase(fixture.sqlitePath, (database) => {
    assert.throws(() => database.prepare('UPDATE deal_hunter_cim_repair_manifests SET status = ? WHERE id = ?')
      .run('changed', artifact.manifestId), /append-only|immutable/i);
    assert.throws(() => database.prepare('DELETE FROM deal_hunter_cim_repair_manifests WHERE id = ?')
      .run(artifact.manifestId), /append-only|immutable/i);
  });
  assert.deepEqual(
    logicalSnapshot(fixture.sqlitePath).deal_hunter_cim_repair_manifests.find((row) => row.id === artifact.manifestId),
    original,
  );

  const ordinary = {
    id: 'ordinary-mutable-manifest', created_at: NOW, updated_at: NOW,
    mode: 'ordinary-test', status: 'started', actor: ACTOR,
    backup_reference: null, checksum: 'first', manifest: { version: 1 }, metadata: {},
  };
  await fixture.storage.upsertDealHunterCimRepairManifest(ordinary);
  const updated = await fixture.storage.upsertDealHunterCimRepairManifest({
    ...ordinary, updated_at: '2026-09-19T18:00:00.000Z', status: 'applied',
    checksum: 'second', manifest: { version: 2 },
  });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.checksum, 'second');
  assert.deepEqual(updated.manifest, { version: 2 });
});

test('post-apply supersession audit and SQLite integrity are clean without changing generic audit semantics', async (t) => {
  const fixture = await createFixture(t);
  const genericBefore = await auditDealHunterCrmIntegrity({ storage: fixture.storage });
  const artifact = await previewFixture(fixture);
  await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
  const audit = await fixture.storage.auditCrmSubmissionSupersessions();
  const genericAfter = await auditDealHunterCrmIntegrity({ storage: fixture.storage });
  assert.deepEqual(audit, { ok: true, violationCount: 0, violations: [] });
  assert.equal(genericBefore.ok, true);
  assert.equal(genericAfter.ok, true);
  assert.equal(genericAfter.safeToReconcile, true);
  assert.deepEqual(genericAfter.findings, genericBefore.findings);
  assert.deepEqual(genericAfter.ownershipHealth, genericBefore.ownershipHealth);
  assert.equal(
    genericAfter.counts.auditedSubmissions,
    genericBefore.counts.auditedSubmissions - 1,
    'the unchanged generic audit read-through excludes the now-superseded Berlin loser',
  );
  assert.deepEqual(
    { ...genericAfter.counts, auditedSubmissions: genericBefore.counts.auditedSubmissions },
    genericBefore.counts,
  );
  rawDatabase(fixture.sqlitePath, (database) => {
    assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  }, { readonly: true });
  assert.equal(tableDigest(fixture.sqlitePath, 'contact_submissions'), artifact.plan.tableDigests.contact_submissions.digest);
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
};
