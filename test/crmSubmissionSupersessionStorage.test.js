import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSqliteStorage } from '../server/storage/sqlite.js';

const timestamp = '2026-09-17T18:00:00.000Z';
const digest = 'a'.repeat(64);

function submission(id, { directOwner = null, metadataOwner = null } = {}) {
  return {
    id,
    created_at: timestamp,
    updated_at: timestamp,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: null,
    crm_status: 'not-applicable',
    crm_error: null,
    source: 'supersession-test',
    ip_hash: '',
    user_agent: '',
    name: `Submission ${id}`,
    email: `${id}@example.test`,
    phone: '',
    company: `Company ${id}`,
    role: 'Broker',
    message: 'Synthetic supersession fixture.',
    status_updated_at: timestamp,
    listing_url: '',
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: '',
    broker_email: '',
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: null,
    deal_hunter_opportunity_id: directOwner,
    metadata: metadataOwner ? { dealHunter: { opportunityId: metadataOwner } } : {},
  };
}

function relation(overrides = {}) {
  return {
    id: 'relation-loser-survivor',
    created_at: timestamp,
    updated_at: timestamp,
    status: 'active',
    survivor_submission_id: 'survivor',
    superseded_submission_id: 'loser',
    opportunity_id: 'opportunity',
    reason_code: 'confirmed-duplicate',
    reason_text: 'Reviewed duplicate CRM representation.',
    approved_by: 'owner@example.test',
    approved_at: timestamp,
    actor: 'test-operator',
    repair_version: 'crm-duplicate-consolidation-v1',
    repair_manifest_id: 'apply-receipt',
    repair_digest: digest,
    reversed_at: null,
    reversed_by: null,
    reversal_reason: null,
    reversal_manifest_id: null,
    metadata: JSON.stringify({ fixture: true }),
    ...overrides,
  };
}

function reversalManifest(overrides = {}) {
  return {
    schema: 'crm-duplicate-consolidation-reversal-manifest-v1',
    operation: 'reverse',
    relationId: 'relation-loser-survivor',
    applyManifestId: 'apply-receipt',
    repairDigest: digest,
    survivorSubmissionId: 'survivor',
    supersededSubmissionId: 'loser',
    opportunityId: 'opportunity',
    ...overrides,
  };
}

function runRelationReversal(database, reversalManifestId) {
  return database.prepare(`
    UPDATE crm_submission_supersessions
    SET status = 'reversed', updated_at = ?, reversed_at = ?, reversed_by = ?,
      reversal_reason = ?, reversal_manifest_id = ?
    WHERE id = 'relation-loser-survivor'
  `).run(
    '2026-09-17T20:00:00.000Z', '2026-09-17T20:00:00.000Z',
    'reviewer', 'Reviewed reversal.', reversalManifestId,
  );
}

function reverseRelation(sqlitePath, reversalManifestId) {
  return rawDatabase(sqlitePath, (database) => runRelationReversal(database, reversalManifestId));
}

const relationInsertSql = `
  INSERT INTO crm_submission_supersessions (
    id, created_at, updated_at, status, survivor_submission_id,
    superseded_submission_id, opportunity_id, reason_code, reason_text,
    approved_by, approved_at, actor, repair_version, repair_manifest_id,
    repair_digest, reversed_at, reversed_by, reversal_reason,
    reversal_manifest_id, metadata
  ) VALUES (
    @id, @created_at, @updated_at, @status, @survivor_submission_id,
    @superseded_submission_id, @opportunity_id, @reason_code, @reason_text,
    @approved_by, @approved_at, @actor, @repair_version, @repair_manifest_id,
    @repair_digest, @reversed_at, @reversed_by, @reversal_reason,
    @reversal_manifest_id, @metadata
  )
`;

function rawDatabase(sqlitePath, callback) {
  const database = new Database(sqlitePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function insertRelation(sqlitePath, record = relation()) {
  return rawDatabase(sqlitePath, (database) => database.transaction((value) => (
    database.prepare(relationInsertSql).run(value)
  )).immediate(record));
}

async function fixture(t, {
  survivor = {},
  loser = {},
  opportunity = {},
  receipt = {},
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-supersession-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (!survivor.omit) {
    await storage.insertSubmission(submission('survivor', {
      directOwner: 'opportunity',
      ...survivor,
    }));
  }
  if (!loser.omit) await storage.insertSubmission(submission('loser', loser));
  if (!opportunity.omit) {
    await storage.upsertDealHunterOpportunity({
      opportunity_id: 'opportunity',
      created_at: timestamp,
      updated_at: timestamp,
      canonical_name: 'Canonical opportunity',
      canonical_recipient: null,
      canonical_location: 'California',
      primary_submission_id: 'survivor',
      identity_version: 'supersession-test-v1',
      status: 'active',
      metadata: {},
      ...opportunity,
    });
  }
  if (!receipt.omit) {
    await storage.upsertDealHunterCimRepairManifest({
      id: 'apply-receipt',
      created_at: timestamp,
      updated_at: timestamp,
      mode: 'crm-duplicate-consolidation',
      status: 'applied',
      actor: 'test-operator',
      backup_reference: 'fixture-backup',
      checksum: digest,
      manifest: { version: 1 },
      metadata: {},
      ...receipt,
    });
  }
  return { directory, sqlitePath, storage };
}

test('accepts one valid active relation through the incident-equivalent SQL transaction', async (t) => {
  const { sqlitePath } = await fixture(t);
  assert.equal(insertRelation(sqlitePath).changes, 1);
  const stored = rawDatabase(sqlitePath, (database) => database.prepare(
    'SELECT * FROM crm_submission_supersessions WHERE id = ?',
  ).get('relation-loser-survivor'));
  assert.equal(stored.survivor_submission_id, 'survivor');
  assert.equal(stored.superseded_submission_id, 'loser');
  assert.equal(stored.status, 'active');
});

const invalidFixtureCases = [
  ['missing survivor', { survivor: { omit: true } }, {}, /survivor/i],
  ['missing loser', { loser: { omit: true } }, {}, /superseded|loser/i],
  ['missing opportunity', { opportunity: { omit: true } }, {}, /opportunity/i],
  ['inactive opportunity', { opportunity: { status: 'superseded' } }, {}, /active opportunity/i],
  ['opportunity primary not survivor', { opportunity: { primary_submission_id: 'loser' } }, {}, /primary/i],
  ['survivor conflicting direct owner', { survivor: { directOwner: 'other' } }, {}, /survivor owner/i],
  ['survivor conflicting metadata owner', { survivor: { metadataOwner: 'other' } }, {}, /survivor owner/i],
  ['loser conflicting direct owner', { loser: { directOwner: 'other' } }, {}, /superseded owner|loser owner/i],
  ['loser conflicting metadata owner', { loser: { metadataOwner: 'other' } }, {}, /superseded owner|loser owner/i],
  ['receipt missing', { receipt: { omit: true } }, {}, /receipt/i],
  ['receipt digest mismatch', {}, { repair_digest: 'b'.repeat(64) }, /digest|receipt/i],
];

for (const [name, fixtureOptions, relationOverrides, expected] of invalidFixtureCases) {
  test(`rejects ${name}`, async (t) => {
    const { sqlitePath } = await fixture(t, fixtureOptions);
    assert.throws(() => insertRelation(sqlitePath, relation(relationOverrides)), expected);
  });
}

test('rejects loser equal to survivor', async (t) => {
  const { sqlitePath } = await fixture(t);
  assert.throws(() => insertRelation(sqlitePath, relation({ superseded_submission_id: 'survivor' })), /constraint|same/i);
});

test('rejects a duplicate active loser', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(
    () => insertRelation(sqlitePath, relation({ id: 'second-relation' })),
    /unique|active loser/i,
  );
});

test('rejects a loser that is primary for another opportunity', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'other-opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Other', canonical_recipient: null, canonical_location: null,
    primary_submission_id: 'loser', identity_version: 'test-v1', status: 'active', metadata: {},
  });
  assert.throws(() => insertRelation(sqlitePath), /primary/i);
});

test('rejects an active survivor that is already an active loser', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  await storage.insertSubmission(submission('root', { directOwner: 'root-opportunity' }));
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'root-opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Root', canonical_recipient: null, canonical_location: null,
    primary_submission_id: 'root', identity_version: 'test-v1', status: 'active', metadata: {},
  });
  await storage.insertSubmission(submission('replacement', { metadataOwner: 'opportunity' }));
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Canonical opportunity', canonical_recipient: null,
    canonical_location: 'California', primary_submission_id: 'replacement',
    identity_version: 'supersession-test-v1', status: 'active', metadata: {},
  });
  await storage.updateSubmission('survivor', {
    deal_hunter_opportunity_id: null,
    metadata: { dealHunter: { opportunityId: 'root-opportunity' } },
  });
  insertRelation(sqlitePath, relation({
    id: 'survivor-is-loser', survivor_submission_id: 'root',
    superseded_submission_id: 'survivor', opportunity_id: 'root-opportunity',
  }));
  assert.throws(() => insertRelation(sqlitePath), /chain|active role/i);
});

test('rejects an active loser that is already an active survivor', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  await storage.insertSubmission(submission('leaf'));
  await storage.updateSubmission('loser', {
    metadata: { dealHunter: { opportunityId: 'opportunity' } },
  });
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opportunity', created_at: timestamp, updated_at: timestamp,
    canonical_name: 'Canonical opportunity', canonical_recipient: null,
    canonical_location: 'California', primary_submission_id: 'loser',
    identity_version: 'supersession-test-v1', status: 'active', metadata: {},
  });
  insertRelation(sqlitePath, relation({
    id: 'loser-is-survivor', survivor_submission_id: 'loser',
    superseded_submission_id: 'leaf',
  }));
  assert.throws(() => insertRelation(sqlitePath), /chain|active role/i);
});

test('rejects an attempted two-node cycle', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(() => insertRelation(sqlitePath, relation({
    id: 'cycle', survivor_submission_id: 'loser', superseded_submission_id: 'survivor',
  })), /chain|active role/i);
});

test('rejects an attempted multi-node chain', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  await storage.insertSubmission(submission('leaf'));
  insertRelation(sqlitePath);
  assert.throws(() => insertRelation(sqlitePath, relation({
    id: 'chain', survivor_submission_id: 'loser', superseded_submission_id: 'leaf',
  })), /chain|active role/i);
});

test('forbids mutation of immutable tuple, approval, repair, and metadata fields', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  const immutableMutations = {
    id: 'changed-id',
    survivor_submission_id: 'loser',
    approved_by: 'changed-owner',
    repair_digest: 'b'.repeat(64),
    metadata: '{}',
  };
  for (const [column, value] of Object.entries(immutableMutations)) {
    assert.throws(
      () => rawDatabase(sqlitePath, (database) => database.prepare(
        `UPDATE crm_submission_supersessions SET ${column} = ? WHERE id = 'relation-loser-survivor'`,
      ).run(value)),
      /immutable/i,
      column,
    );
  }
});

test('permits only a separately receipted active-to-reversed transition', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE crm_submission_supersessions
    SET status = 'reversed', updated_at = ?, reversed_at = ?, reversed_by = ?,
      reversal_reason = ?, reversal_manifest_id = ?
    WHERE id = 'relation-loser-survivor'
  `).run(timestamp, timestamp, 'reviewer', 'Reviewed reversal.', 'missing-reversal-receipt')), /reviewed|receipt|transition/i);

  await storage.upsertDealHunterCimRepairManifest({
    id: 'reversal-receipt', created_at: timestamp, updated_at: timestamp,
    mode: 'crm-duplicate-consolidation', status: 'applied', actor: 'reviewer',
    backup_reference: 'reversal-backup', checksum: 'e'.repeat(64),
    manifest: reversalManifest(), metadata: {},
  });
  assert.equal(reverseRelation(sqlitePath, 'reversal-receipt').changes, 1);
  assert.deepEqual(await storage.auditCrmSubmissionSupersessions(), {
    ok: true,
    violationCount: 0,
    violations: [],
  });
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE crm_submission_supersessions
    SET status = 'active', reversed_at = NULL, reversed_by = NULL,
      reversal_reason = NULL, reversal_manifest_id = NULL
    WHERE id = 'relation-loser-survivor'
  `).run()), /reviewed|transition|constraint/i);
});

test('rejects reuse of the original apply receipt as reversal authority', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(
    () => reverseRelation(sqlitePath, 'apply-receipt'),
    /reviewed|reverse|receipt|transition/i,
  );
});

test('rejects an unrelated applied consolidation receipt as reversal authority', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  insertRelation(sqlitePath);
  await storage.upsertDealHunterCimRepairManifest({
    id: 'unrelated-reversal-receipt', created_at: timestamp, updated_at: timestamp,
    mode: 'crm-duplicate-consolidation', status: 'applied', actor: 'reviewer',
    backup_reference: 'unrelated-backup', checksum: 'f'.repeat(64),
    manifest: reversalManifest({
      relationId: 'another-relation',
      supersededSubmissionId: 'another-loser',
    }),
    metadata: {},
  });
  assert.throws(
    () => reverseRelation(sqlitePath, 'unrelated-reversal-receipt'),
    /reviewed|reverse|receipt|transition/i,
  );
});

test('supersession audit rejects a reversed row with an unbound reversal receipt', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  insertRelation(sqlitePath);
  await storage.upsertDealHunterCimRepairManifest({
    id: 'unrelated-reversal-receipt', created_at: timestamp, updated_at: timestamp,
    mode: 'crm-duplicate-consolidation', status: 'applied', actor: 'reviewer',
    backup_reference: 'unrelated-backup', checksum: 'f'.repeat(64),
    manifest: reversalManifest({ relationId: 'another-relation' }), metadata: {},
  });
  rawDatabase(sqlitePath, (database) => {
    database.exec('DROP TRIGGER trg_crm_submission_supersessions_reverse_only');
    runRelationReversal(database, 'unrelated-reversal-receipt');
  });
  assert.deepEqual(await storage.auditCrmSubmissionSupersessions(), {
    ok: false,
    violationCount: 1,
    violations: [{ code: 'reversal-receipt-invalid', relationId: 'relation-loser-survivor' }],
  });
});

test('active relation authority cannot be invalidated by contact or opportunity updates', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE contact_submissions
    SET deal_hunter_opportunity_id = NULL, metadata = '{}'
    WHERE id = 'survivor'
  `).run()), /survivor owner/i);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE contact_submissions SET deal_hunter_opportunity_id = 'other'
    WHERE id = 'loser'
  `).run()), /superseded owner/i);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE deal_hunter_opportunities SET status = 'superseded'
    WHERE opportunity_id = 'opportunity'
  `).run()), /opportunity authority/i);
});

test('forbids physical relation deletion', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(
    'DELETE FROM crm_submission_supersessions WHERE id = ?',
  ).run('relation-loser-survivor')), /delete|immutable/i);
});

for (const [name, sql, value] of [
  ['contact', 'DELETE FROM contact_submissions WHERE id = ?', 'loser'],
  ['opportunity', 'DELETE FROM deal_hunter_opportunities WHERE opportunity_id = ?', 'opportunity'],
  ['receipt', 'DELETE FROM deal_hunter_cim_repair_manifests WHERE id = ?', 'apply-receipt'],
]) {
  test(`forbids ${name} deletion while referenced`, async (t) => {
    const { sqlitePath } = await fixture(t);
    insertRelation(sqlitePath);
    assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(sql).run(value)), /constraint|immutable|delete/i);
  });
}

test('rejects direct assignment of an active loser as an opportunity primary', async (t) => {
  const { sqlitePath } = await fixture(t);
  insertRelation(sqlitePath);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE deal_hunter_opportunities SET primary_submission_id = 'loser'
    WHERE opportunity_id = 'opportunity'
  `).run()), /superseded primary/i);
});

test('consolidation receipts are append-only while generic manifests retain upsert lifecycle behavior', async (t) => {
  const { sqlitePath, storage } = await fixture(t);
  const original = (await storage.listDealHunterCimRepairManifests({ limit: 10 }))
    .find((row) => row.id === 'apply-receipt');
  insertRelation(sqlitePath);

  await assert.rejects(storage.upsertDealHunterCimRepairManifest({
    ...original,
    updated_at: '2026-09-17T19:00:00.000Z',
    status: 'failed',
    checksum: 'b'.repeat(64),
    manifest: { changed: true },
  }), /immutable|append-only/i);
  const afterRejectedUpsert = (await storage.listDealHunterCimRepairManifests({ limit: 10 }))
    .find((row) => row.id === 'apply-receipt');
  assert.deepEqual(afterRejectedUpsert, original);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(
    "UPDATE deal_hunter_cim_repair_manifests SET status = 'failed' WHERE id = 'apply-receipt'",
  ).run()), /immutable|append-only/i);
  assert.throws(() => rawDatabase(sqlitePath, (database) => database.prepare(
    "DELETE FROM deal_hunter_cim_repair_manifests WHERE id = 'apply-receipt'",
  ).run()), /immutable|append-only/i);

  await storage.upsertDealHunterCimRepairManifest({
    id: 'generic-receipt', created_at: timestamp, updated_at: timestamp,
    mode: 'identity-repair', status: 'planned', actor: 'test', backup_reference: null,
    checksum: 'c'.repeat(64), manifest: { phase: 1 }, metadata: {},
  });
  const updated = await storage.upsertDealHunterCimRepairManifest({
    id: 'generic-receipt', created_at: timestamp, updated_at: '2026-09-17T20:00:00.000Z',
    mode: 'identity-repair', status: 'applied', actor: 'test', backup_reference: null,
    checksum: 'd'.repeat(64), manifest: { phase: 2 }, metadata: { complete: true },
  });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.checksum, 'd'.repeat(64));
  assert.deepEqual(updated.manifest, { phase: 2 });
  assert.equal(rawDatabase(sqlitePath, (database) => database.prepare(
    "DELETE FROM deal_hunter_cim_repair_manifests WHERE id = 'generic-receipt'",
  ).run()).changes, 1);
});

test('startup upgrades a pre-supersession database without losing existing rows', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-supersession-upgrade-'));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const config = { storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } };
  let storage = createSqliteStorage(config);
  await storage.insertSubmission(submission('existing-row'));
  storage.close();
  rawDatabase(sqlitePath, (database) => {
    for (const row of database.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name LIKE 'trg_crm_submission_supersessions_%'
         OR name LIKE 'trg_crm_duplicate_consolidation_%'
         OR name LIKE 'trg_deal_hunter_opportunities_reject_superseded_%'
         OR name LIKE 'idx_crm_submission_supersessions_%'
         OR name = 'uq_crm_submission_supersessions_active_loser'
    `).all()) database.exec(`DROP ${row.type.toUpperCase()} IF EXISTS ${row.name}`);
    database.exec('DROP TABLE IF EXISTS crm_submission_supersessions');
  });
  storage = createSqliteStorage(config);
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await storage.getSubmission('existing-row')).id, 'existing-row');
  const objects = rawDatabase(sqlitePath, (database) => database.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name LIKE '%crm_submission_supersessions%'
       OR name LIKE 'trg_crm_duplicate_consolidation_%'
       OR name LIKE 'trg_deal_hunter_opportunities_reject_superseded_%'
    ORDER BY name
  `).all());
  const names = new Set(objects.map((row) => row.name));
  for (const expected of [
    'crm_submission_supersessions',
    'idx_crm_submission_supersessions_survivor',
    'idx_crm_submission_supersessions_opportunity',
    'uq_crm_submission_supersessions_active_loser',
    'trg_crm_duplicate_consolidation_receipt_no_update',
    'trg_crm_duplicate_consolidation_receipt_no_delete',
    'trg_crm_submission_supersessions_validate_insert',
    'trg_crm_submission_supersessions_no_active_chain_insert',
    'trg_crm_submission_supersessions_no_active_chain_update',
    'trg_crm_submission_supersessions_immutable_update',
    'trg_crm_submission_supersessions_reverse_only',
    'trg_crm_submission_supersessions_no_delete',
    'trg_crm_submission_supersessions_guard_contact_owner_update',
    'trg_crm_submission_supersessions_guard_opportunity_update',
    'trg_deal_hunter_opportunities_reject_superseded_primary_insert',
    'trg_deal_hunter_opportunities_reject_superseded_primary_update',
  ]) assert.equal(names.has(expected), true, expected);
});
