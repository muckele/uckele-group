import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  CANONICAL_OPPORTUNITY_MERGE_PAIR_SCOPED_POLICY,
  assertCanonicalOpportunityMergeApprovalShape,
  CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
  PRECISION_CARBON_CANONICAL_OPPORTUNITY_MERGE_INCIDENT,
  findCanonicalOpportunityMergeApprovalForException,
  getCanonicalOpportunityMergeApproval,
} from '../server/repairs/canonicalOpportunityMerge.js';
import { runCanonicalOpportunityMergeRepair } from '../server/services/canonicalOpportunityMergeRepair.js';
import { createBackupBundle, verifyBackupBundle } from '../server/services/backups.js';
import { createSqliteStorage, inspectCanonicalMergeDependentState } from '../server/storage/sqlite.js';
import { parseCanonicalOpportunityMergeArgs } from '../scripts/repair-canonical-opportunity-merge.js';

const incident = PRECISION_CARBON_CANONICAL_OPPORTUNITY_MERGE_INCIDENT;
const approval = getCanonicalOpportunityMergeApproval({ incident });
const { exceptionId, survivorId, supersededId } = approval;
const actor = 'owner@example.test';
const reason = approval.approvedResolutionReason;
const seededAt = '2026-11-02T15:00:40.000Z';
const nowIso = '2026-11-05T21:00:00.000Z';
const storagePaths = new WeakMap();
// Deferred freshness rows the fixture binds to the open exception when the descriptor leaves
// that count to the reviewed plan (it grows with each daily Sheet run in production).
const planPinnedUnboundFixtureCount = 7;
const planPinnedCollisionFixtureCount = 3;
const planPinnedSeenFixtureCount = 2;

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function withRawDatabase(sqlitePath, callback, { foreignKeys = true } = {}) {
  const database = new Database(sqlitePath);
  try {
    if (!foreignKeys) database.pragma('foreign_keys = OFF');
    return callback(database);
  } finally {
    database.close();
  }
}

function repairStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-precision-merge-'));
  const sqlitePath = path.join(directory, 'repair.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  storagePaths.set(storage, { sqlitePath, bundlePath: '' });
  return { storage, sqlitePath };
}

function factsFor(opportunityId) {
  return approval.approvedFactsByOpportunityId[opportunityId];
}

function opportunityRow(opportunityId) {
  const facts = factsFor(opportunityId);
  const created = opportunityId === survivorId ? '2026-10-31T15:00:32.916Z' : '2026-10-31T15:00:38.304Z';
  const recipient = facts.recipientPresent ? 'carbon-broker@example.test' : '';
  return {
    opportunity_id: opportunityId,
    created_at: created,
    updated_at: created,
    canonical_name: facts.canonicalName,
    canonical_recipient: recipient || null,
    canonical_location: facts.canonicalLocation,
    primary_submission_id: null,
    identity_version: approval.expectedEvidenceVersion,
    status: 'active',
    metadata: {
      retainedFixtureMetadata: `preserve-${opportunityId}`,
      identitySnapshot: {
        name: facts.identityName,
        description: 'x'.repeat(facts.identityDescriptionLength),
        recipient,
        location: facts.identityLocation,
        city: facts.city,
        county: facts.county,
        state: facts.state,
        country: facts.country,
        askingPrice: facts.askingPrice,
        revenue: facts.revenue,
        profit: facts.profit,
        sourceIds: ['sheet 0'],
        listingIds: facts.listingIds,
        listingUrl: facts.listingUrl,
      },
    },
  };
}

const observationFields = [
  'name', 'business_name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
  'annual_profit', 'annual_revenue', 'asking_price', 'profit_multiple', 'net_margin', 'years_established',
  'remote_flag', 'franchise_flag', 'five_years_flag', 'broker_name',
];

function ownerCounts(category) {
  const expected = approval.expectedPreservedState[category];
  return [[supersededId, expected.supersededCount], [survivorId, expected.survivorCount]];
}

function insertPreservedRows(sqlitePath) {
  withRawDatabase(sqlitePath, (database) => database.transaction(() => {
    const insertScore = database.prepare(`
      INSERT INTO deal_hunter_opportunity_scores (
        opportunity_id, created_at, scored_at, name, state, fit_score, score_status, should_remove,
        score_fingerprint, engine_version, rules_version, profile_version, completeness_policy_version,
        current_triage_eligible, operator_priority
      ) VALUES (?, ?, ?, ?, 'CA', 20, 'remove', 1, ?, 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', 1, 'normal')
    `);
    for (const [opportunityId, count] of ownerCounts('opportunityScores')) {
      for (let index = 0; index < count; index += 1) {
        insertScore.run(opportunityId, seededAt, seededAt, factsFor(opportunityId).canonicalName, `fp-${opportunityId}`);
      }
    }
    const insertEvidence = database.prepare(`
      INSERT INTO deal_hunter_score_evidence (
        id, opportunity_id, score_fingerprint, created_at, rule_id, rule_label, evidence_class, terms
      ) VALUES (?, ?, ?, ?, ?, ?, 'source', '[]')
    `);
    for (const [opportunityId, count] of ownerCounts('scoreEvidence')) {
      for (let index = 0; index < count; index += 1) {
        insertEvidence.run(`ev-${opportunityId}-${index}`, opportunityId, `fp-${opportunityId}`, seededAt,
          `rule-${index}`, `Rule ${index}`);
      }
    }
    const insertObservation = database.prepare(`
      INSERT INTO deal_hunter_opportunity_source_observations (
        id, opportunity_id, source_id, source_name, source_record_id, field, value, observed_at, created_at, updated_at
      ) VALUES (?, ?, 'sheet 0', 'SMB Deal Hunter Google Sheet', ?, ?, 'v', ?, ?, ?)
    `);
    const collisionCount = approval.expectedPreservedState.sourceObservations.collisionCount ?? planPinnedCollisionFixtureCount;
    for (const [opportunityId, count] of ownerCounts('sourceObservations')) {
      for (let index = 0; index < count; index += 1) {
        const colliding = index < collisionCount;
        insertObservation.run(`obs-${opportunityId}-${index}`, opportunityId,
          colliding ? 'shared-row' : `row-${opportunityId}-${Math.floor(index / observationFields.length)}`,
          observationFields[index % observationFields.length], seededAt, seededAt, seededAt);
      }
    }
    const insertSeen = database.prepare(`
      INSERT INTO deal_hunter_seen_deals (
        id, first_seen_at, last_seen_at, source_id, source_name, listing_url, name, location, should_remove, metadata
      ) VALUES (?, ?, ?, 'sheet 0', 'SMB Deal Hunter Google Sheet', NULL, 'Precision Carbon', 'CA', 0, ?)
    `);
    const seenCount = approval.expectedPreservedState.historicalIdentityEvidence.count ?? planPinnedSeenFixtureCount;
    for (let index = 0; index < seenCount; index += 1) {
      insertSeen.run(`seen-precision-${index}`, seededAt, seededAt,
        JSON.stringify({ aliasKey: approval.expectedAliases[index % approval.expectedAliases.length].aliasKey }));
    }
    const insertFreshness = database.prepare(`
      INSERT INTO deal_hunter_freshness_evidence (
        id, source_id, source_name, source_record_id, run_id, generation, event_type, accepted_at,
        original_canonical_id, current_canonical_id, identity_exception_id
      ) VALUES (?, 'sheet 0', 'SMB Deal Hunter Google Sheet', ?, ?, 1, 'accepted_source_record', ?, ?, ?, ?)
    `);
    const freshness = approval.expectedPreservedState.freshnessEvidence;
    for (const [opportunityId, count] of ownerCounts('freshnessEvidence')) {
      for (let index = 0; index < count; index += 1) {
        insertFreshness.run(`fresh-${opportunityId}-${index}`, `record-${opportunityId}-${index}`,
          `run-${index}`, seededAt, opportunityId, opportunityId, null);
      }
    }
    for (let index = 0; index < (freshness.unboundCount ?? planPinnedUnboundFixtureCount); index += 1) {
      insertFreshness.run(`fresh-unbound-${index}`, `record-unbound-${index}`, `run-unbound-${index}`,
        seededAt, null, null, exceptionId);
    }
    for (const [opportunityId, count] of ownerCounts('cimSafetyEvents')) {
      for (let index = 0; index < count; index += 1) insertSafetyEvent(database, opportunityId, index);
    }
    const auditCounts = Object.fromEntries(ownerCounts('cimAuditEvents'));
    for (const [opportunityId, count] of Object.entries(auditCounts)) {
      for (let index = 0; index < count; index += 1) {
        database.prepare(`
          INSERT INTO deal_hunter_cim_audit_events (
            id, event_type, opportunity_id, next_state, actor, source, occurred_at, metadata
          ) VALUES (?, 'safety-emitted', ?, 'pending', 'sheet-import', ?, ?, '{}')
        `).run(`audit-${opportunityId}-${index}`, opportunityId, `run-${index}`, seededAt);
      }
    }
  })());
}

function insertSafetyEvent(database, opportunityId, index, overrides = {}) {
  const row = {
    id: `safety-${opportunityId}-${index}`,
    safety_run_id: `cim-source:run-${index}`,
    opportunity_id: opportunityId,
    source_type: 'sheet-import',
    source_run_id: `run-${index}`,
    canonical_revision: 0,
    identity_exception_revision: 0,
    event_type: `source-record-changed#${String(index).padStart(32, '0')}`,
    evidence_id: sha(`evidence-${opportunityId}-${index}`),
    status: 'pending',
    outcome_evidence_id: null,
    created_at: seededAt,
    consumed_at: null,
    updated_at: seededAt,
    ...overrides,
  };
  database.prepare(`
    INSERT INTO deal_hunter_cim_safety_events (
      id, safety_run_id, opportunity_id, source_type, source_run_id, canonical_revision,
      identity_exception_revision, event_type, evidence_id, status, outcome_evidence_id,
      created_at, consumed_at, updated_at
    ) VALUES (@id, @safety_run_id, @opportunity_id, @source_type, @source_run_id, @canonical_revision,
      @identity_exception_revision, @event_type, @evidence_id, @status, @outcome_evidence_id,
      @created_at, @consumed_at, @updated_at)
  `).run(row);
}

async function createBundle(storage, now) {
  const paths = storagePaths.get(storage);
  const root = path.dirname(paths.sqlitePath);
  const backup = await createBackupBundle({
    storage,
    now,
    config: {
      storage: { provider: 'sqlite', sqlitePath: paths.sqlitePath },
      secureDocuments: { storageDir: path.join(root, 'secure-documents') },
      protection: { rateLimitRetentionMs: 0 },
      backup: {
        enabled: true, directory: path.join(root, 'application-backups'), retentionDays: 30,
        retentionCount: 14, time: '03:30', timezone: 'America/Los_Angeles', checkIntervalMs: 900000,
      },
    },
  });
  const verification = await verifyBackupBundle(backup.path);
  assert.equal(verification.ok, true, verification.errors.join(' '));
  paths.bundlePath = backup.path;
}

async function seedPrecisionCarbon(storage, sqlitePath) {
  await storage.upsertDealHunterOpportunity(opportunityRow(survivorId));
  await storage.upsertDealHunterOpportunity(opportunityRow(supersededId));
  for (const item of approval.expectedAliases) {
    await storage.upsertDealHunterOpportunityAlias({
      id: item.id,
      opportunity_id: item.opportunityId,
      alias_type: item.aliasType,
      alias_value: item.aliasValue,
      alias_key: item.aliasKey,
      source: 'SMB Deal Hunter Google Sheet',
      first_observed_at: '2026-10-31T15:00:32.000Z',
      last_observed_at: seededAt,
      evidence_version: approval.expectedEvidenceVersion,
      resolution_method: 'new-opportunity',
      confidence_state: 'exact',
      resolved_by: 'deal-hunter-review',
      metadata: { fixture: true },
    });
  }
  await storage.upsertDealHunterIdentityException({
    id: exceptionId,
    created_at: seededAt,
    updated_at: seededAt,
    status: 'open',
    observed_deal_key: null,
    observed_name: 'Precision Carbon & Graphite Manufacturer',
    observed_recipient: 'carbon-broker@example.test',
    candidate_opportunity_ids: approval.expectedExceptionCandidateOpportunityIds,
    reason: approval.expectedExceptionReason,
    evidence_version: approval.expectedEvidenceVersion,
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: { aliases: approval.expectedAliases.map(({ aliasKey }) => aliasKey), fixture: true },
  });
  insertPreservedRows(sqlitePath);
}

async function pauseAndBackUp(storage) {
  await storage.upsertDealHunterCimSafetySettings({
    updated_at: '2026-11-05T20:00:00.000Z',
    outreach_paused: true,
    updated_by: actor,
    metadata: { pauseReason: 'Precision Carbon merge fixture.' },
  });
  await createBundle(storage, new Date('2026-11-05T20:30:00.000Z'));
}

function dryRunInput(storage, overrides = {}) {
  return { incident, storage, actor, reason, now: new Date(nowIso), ...overrides };
}

function applyInput(storage, planChecksum, overrides = {}) {
  return dryRunInput(storage, {
    apply: true,
    confirmation: approval.confirmation,
    expectedPlanChecksum: planChecksum,
    backupPath: storagePaths.get(storage).bundlePath,
    ...overrides,
  });
}

const preservedTables = [
  ['deal_hunter_opportunity_scores', 'opportunity_id'],
  ['deal_hunter_score_evidence', 'id'],
  ['deal_hunter_opportunity_source_observations', 'id'],
  ['deal_hunter_seen_deals', 'id'],
  ['deal_hunter_freshness_evidence', 'id'],
  ['deal_hunter_cim_safety_events', 'id'],
  ['deal_hunter_cim_audit_events', 'id'],
  ['deal_hunter_crm_ownership_revisions', 'opportunity_id, revision'],
];

function snapshotPreservedTables(sqlitePath) {
  return withRawDatabase(sqlitePath, (database) => Object.fromEntries(preservedTables.map(([table, order]) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
  ])));
}

test('Precision Carbon descriptor is a pair-scoped incident that keeps the earliest-created deal', () => {
  assert.equal(approval.incident, 'precision-carbon-2026-11-02');
  assert.equal(approval.dependentPolicy, CANONICAL_OPPORTUNITY_MERGE_PAIR_SCOPED_POLICY);
  assert.equal(approval.exceptionId, '0cfa01f1fb4666903281f0c8d2b2da00027b307446a266c5adba7e0192343f56');
  assert.equal(approval.survivorRule, 'earliest-created');
  assert.equal(survivorId, 'opp_8cc53064-bf61-4d2f-9862-2694c2773e0e');
  assert.equal(supersededId, 'opp_910e6860-deea-4e3d-bcf2-20c6e0a0fc92');
  assert.deepEqual(approval.expectedExceptionCandidateOpportunityIds, []);
  assert.equal(approval.expectedAliases.filter((item) => item.opportunityId === survivorId).length, 5);
  assert.equal(approval.expectedAliases.filter((item) => item.opportunityId === supersededId).length, 4);
  assert.equal(approval.confirmation, `MERGE ${supersededId} INTO ${survivorId} FOR EXCEPTION ${exceptionId}`);
  assert.equal(Object.isFrozen(approval), true);
  assert.equal(findCanonicalOpportunityMergeApprovalForException(exceptionId), approval);
  assert.equal(findCanonicalOpportunityMergeApprovalForException('unknown'), null);
  for (const item of approval.expectedAliases) {
    assert.equal(item.id, sha(`cim-opportunity-alias:${item.aliasKey}`));
  }
});

test('Precision Carbon CLI is dry-run by default and refuses tuple overrides', () => {
  const parsed = parseCanonicalOpportunityMergeArgs(['--incident', incident, '--actor', actor, '--reason', reason]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.incident, incident);
  assert.throws(() => parseCanonicalOpportunityMergeArgs([
    '--incident', incident, '--survivor-id', supersededId, '--actor', actor, '--reason', reason,
  ]), /cannot be combined/);
  assert.throws(() => parseCanonicalOpportunityMergeArgs([
    '--exception-id', exceptionId, '--survivor-id', survivorId, '--superseded-id', supersededId,
    '--actor', actor, '--reason', reason,
  ]), /not an approved canonical opportunity merge tuple/);
});

test('Precision Carbon dry run prints every write and every preserved dependent without writing', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  const before = fs.readFileSync(fixture.sqlitePath);

  const result = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, false);
  assert.equal(result.approval.incident, incident);
  assert.match(result.planChecksum, /^[a-f0-9]{64}$/);
  const supersededAliases = approval.expectedAliases.filter((item) => item.opportunityId === supersededId);
  assert.deepEqual(result.changes.writes.map(({ table, action, rowCount }) => [table, action, rowCount]), [
    ['deal_hunter_opportunity_aliases', 'reassign-owner', supersededAliases.length],
    ['deal_hunter_opportunities', 'mark-superseded', 1],
    ['deal_hunter_identity_exceptions', 'resolve', 1],
    ['deal_hunter_cim_repair_manifests', 'insert', 1],
  ]);
  assert.deepEqual(
    result.changes.writes[0].rows.map(({ aliasKey }) => aliasKey).sort(),
    supersededAliases.map(({ aliasKey }) => aliasKey).sort(),
  );
  assert.equal(result.changes.writes[0].rows.every(({ from, to }) => from === supersededId && to === survivorId), true);
  assert.equal(result.changes.writes[1].opportunityId, supersededId);
  assert.equal(result.changes.writes[2].exceptionId, exceptionId);
  assert.equal(result.changes.writes[2].resolutionReason, reason);
  assert.equal(result.changes.writes[2].resolvedOpportunityId, survivorId);
  assert.equal(result.changes.writes[3].manifestId, result.manifestId);
  assert.equal(result.changes.deletes, 0);
  const preserved = result.changes.unchanged.preservedWithoutWrites;
  for (const category of ['opportunityScores', 'scoreEvidence', 'cimSafetyEvents', 'cimAuditEvents', 'crmOwnershipRevisions']) {
    const expected = approval.expectedPreservedState[category];
    assert.deepEqual(preserved[category], {
      supersededCount: expected.supersededCount,
      survivorCount: expected.survivorCount,
    }, category);
  }
  assert.equal(
    preserved.freshnessEvidence.unboundCount,
    approval.expectedPreservedState.freshnessEvidence.unboundCount ?? planPinnedUnboundFixtureCount,
  );
  assert.equal(result.plan.dependentState.counts.pursueCimAuthorities, 0);
  assert.deepEqual(result.plan.authorityGrantingOperationalState.pursueCimAuthority, {
    currentCapabilityActivations: 0,
    openLiveProviderAuthorizations: 0,
    currentAutoPursueActivations: 0,
    enabledLiveSendingControls: 0,
    authorityEffect: 'granting',
  });
  assert.deepEqual(fs.readFileSync(fixture.sqlitePath), before);
});

test('Precision Carbon accepts only the owner-approved resolution reason', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage, {
      reason: 'Same business on two sites, merging into the earliest deal.',
    })),
    /owner-approved resolution reason exactly/,
  );
});

test('Precision Carbon apply merges the pair and leaves every preserved dependent byte-for-byte', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  await pauseAndBackUp(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));
  const preservedBefore = snapshotPreservedTables(fixture.sqlitePath);

  const applied = await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));

  assert.equal(applied.applied, true);
  assert.equal(applied.planChecksum, dryRun.planChecksum);
  assert.deepEqual(snapshotPreservedTables(fixture.sqlitePath), preservedBefore);
  const aliases = await fixture.storage.listDealHunterOpportunityAliases({
    opportunityIds: [survivorId, supersededId], limit: 100,
  });
  assert.equal(aliases.length, approval.expectedAliases.length);
  assert.equal(aliases.every((row) => row.opportunity_id === survivorId), true);
  const [survivor, loser] = await Promise.all([
    fixture.storage.getDealHunterOpportunity(survivorId),
    fixture.storage.getDealHunterOpportunity(supersededId),
  ]);
  assert.equal(survivor.status, 'active');
  assert.equal(loser.status, 'superseded');
  assert.equal(loser.metadata.canonicalOpportunityMerge.mergedInto, survivorId);
  assert.equal(loser.metadata.retainedFixtureMetadata, `preserve-${supersededId}`);
  const resolved = (await fixture.storage.listDealHunterIdentityExceptions({ statuses: ['resolved'], limit: 10 }))
    .find(({ id }) => id === exceptionId);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, actor);
  assert.equal(resolved.resolution_reason, reason);
  assert.equal(resolved.metadata.resolvedOpportunityId, survivorId);
  assert.equal(resolved.metadata.canonicalOpportunityMerge.decision, 'merge');
  const manifests = (await fixture.storage.listDealHunterCimRepairManifests({ limit: 10 }))
    .filter(({ mode }) => mode === CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].checksum, dryRun.planChecksum);
  assert.equal(await fixture.storage.getCurrentDealHunterOpportunityScore(supersededId), null);

  const replay = await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.applied, false);
  const replayDryRun = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));
  assert.equal(replayDryRun.alreadyApplied, true);
  assert.equal(replayDryRun.changes, undefined);
});

test('Precision Carbon apply refuses when preserved evidence changes after the reviewed dry run', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  const dryRun = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));
  withRawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    UPDATE deal_hunter_cim_safety_events SET updated_at = ? WHERE opportunity_id = ? AND status = 'pending'
  `).run('2026-11-05T20:10:00.000Z', supersededId));
  await pauseAndBackUp(fixture.storage);
  const preservedBefore = snapshotPreservedTables(fixture.sqlitePath);
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /checksum/i,
  );
  assert.deepEqual(snapshotPreservedTables(fixture.sqlitePath), preservedBefore);
  assert.equal((await fixture.storage.getDealHunterOpportunity(supersededId)).status, 'active');
});

test('Precision Carbon apply refuses when a daily Sheet run adds deferred evidence after the dry run', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  const dryRun = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));
  withRawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    INSERT INTO deal_hunter_freshness_evidence (
      id, source_id, source_name, source_record_id, run_id, generation, event_type, accepted_at,
      original_canonical_id, current_canonical_id, identity_exception_id
    ) VALUES ('fresh-next-day', 'sheet 0', 'SMB Deal Hunter Google Sheet', 'record-next-day', 'run-next-day', 2,
      'accepted_source_record', '2026-11-06T15:00:00.000Z', NULL, NULL, ?)
  `).run(exceptionId));
  const nextDryRun = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));
  assert.notEqual(nextDryRun.planChecksum, dryRun.planChecksum);
  assert.equal(
    nextDryRun.plan.preservedIncidentState.freshnessEvidence.unbound.count,
    dryRun.plan.preservedIncidentState.freshnessEvidence.unbound.count + 1,
  );
  await pauseAndBackUp(fixture.storage);
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /checksum/i,
  );
  assert.equal((await fixture.storage.getDealHunterOpportunity(supersededId)).status, 'active');
});

test('Precision Carbon refuses freshness evidence that belongs to a third deal', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  withRawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    INSERT INTO deal_hunter_freshness_evidence (
      id, source_id, source_name, source_record_id, run_id, generation, event_type, accepted_at,
      original_canonical_id, current_canonical_id, identity_exception_id
    ) VALUES ('fresh-third-deal', 'sheet 0', 'SMB Deal Hunter Google Sheet', 'record-third', 'run-third', 1,
      'accepted_source_record', ?, ?, 'opp_third_deal', NULL)
  `).run(seededAt, supersededId));
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage)),
    /freshnessEvidence preservation topology drifted/,
  );
});

function insertDecisionEvent(database, id, opportunityId) {
  database.prepare(`
    INSERT INTO deal_hunter_owner_decision_events (
      id, idempotency_key, request_digest, opportunity_id, action, actor,
      expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision,
      selected_contact_reference_digest, policy_version, created_at
    ) VALUES (?, ?, ?, ?, 'pursue', ?, 1, 1, 1, 1, NULL, 'pursue-cim-policy-v1', ?)
  `).run(id, `${id}-key`, sha(id), opportunityId, actor, seededAt);
}

function insertCampaign(database, opportunityId) {
  database.prepare(`
    INSERT INTO deal_hunter_cim_campaigns (
      id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
      template_version, template_digest, permission_version, permission_digest, permission_revision,
      permission_scope, canonical_revision, crm_ownership_revision, recipient_authority_id,
      recipient_fingerprint, freshness_authority_digest, discovery_revision, material_revision,
      timezone_revision, conversation_id, state, created_at, updated_at
    ) VALUES (?, ?, 1, 'enrollment', 'decision', 'policy-v1', 'template-v1', ?, 'permission-v1', ?, 0,
      'scope', 0, 0, 'recipient-authority', ?, ?, 0, 0, 1, 'conversation-precision', 'queued', ?, ?)
  `).run(`campaign-${opportunityId}`, opportunityId, sha('t'), sha('p'), sha('r'), sha('f'), seededAt, seededAt);
}

const refusalCases = [
  {
    name: 'a recipient appearing on the duplicate after approval',
    mutate: (database) => database.prepare(`
      UPDATE deal_hunter_opportunities SET canonical_recipient = 'new-broker@example.test' WHERE opportunity_id = ?
    `).run(supersededId),
    pattern: /acquired recipient evidence after approval/,
  },
  {
    name: 'a Pursue decision on the duplicate',
    mutate: (database) => insertDecisionEvent(database, 'pursue-on-loser', supersededId),
    pattern: /unexpected dependent state: pursueCimAuthorities/,
  },
  {
    name: 'a CIM campaign on the survivor',
    foreignKeys: false,
    mutate: (database) => insertCampaign(database, survivorId),
    pattern: /unexpected dependent state: pursueCimAuthorities/,
  },
  {
    name: 'a consumed safety event on the duplicate',
    mutate: (database) => insertSafetyEvent(database, supersededId, 9, {
      status: 'no-op', consumed_at: seededAt, outcome_evidence_id: 'outcome',
    }),
    pattern: /unexpected dependent state: pursueCimAuthorities/,
  },
  {
    name: 'a campaign-linked audit event on the duplicate',
    mutate: (database) => database.prepare(`
      INSERT INTO deal_hunter_cim_audit_events (id, event_type, opportunity_id, prior_state, next_state,
        actor, source, occurred_at, metadata)
      VALUES ('audit-transition', 'safety-consumed', ?, 'pending', 'no-op', 'consumer', 'safety', ?, '{}')
    `).run(supersededId, seededAt),
    pattern: /unexpected dependent state: pursueCimAuthorities/,
  },
  {
    name: 'a non-baseline CRM ownership revision',
    mutate: (database) => database.prepare(`
      INSERT INTO deal_hunter_crm_ownership_revisions (opportunity_id, revision, submission_id)
      VALUES (?, 2, NULL)
    `).run(supersededId),
    pattern: /unexpected dependent state: pursueCimAuthorities/,
  },
  {
    name: 'a CIM opportunity claim',
    mutate: (database) => database.prepare(`
      INSERT INTO deal_hunter_cim_opportunity_claims (
        opportunity_id, request_id, recipient_email, state, claimed_at, updated_at, metadata
      ) VALUES (?, 'claim-request', 'carbon-broker@example.test', 'active', ?, ?, '{}')
    `).run(supersededId, seededAt, seededAt),
    pattern: /unexpected dependent state: opportunityClaims/,
  },
  {
    name: 'a current automatic Pursue activation',
    mutate: (database) => database.prepare(`
      INSERT INTO deal_hunter_auto_pursue_activations (id, mode, daily_cap, actor, reason, confirmation, status, created_at)
      VALUES ('auto-canary', 'canary', 1, ?, 'canary', 'ACTIVATE AUTO PURSUE CANARY', 'current', ?)
    `).run(actor, seededAt),
    pattern: /authority that can send email: currentAutoPursueActivations/,
  },
  {
    name: 'live sending switched on',
    mutate: (database) => database.prepare(`
      INSERT INTO deal_hunter_pursue_send_controls (control_key, enabled, changed_at, changed_by, revision)
      VALUES ('live_sending', 1, ?, ?, 1)
    `).run(seededAt, actor),
    pattern: /authority that can send email: enabledLiveSendingControls/,
  },
  {
    name: 'a current mailbox-mode CIM capability activation',
    mutate: (database) => database.prepare(`
      INSERT INTO deal_hunter_cim_capability_activations (
        id, capability, mode, status, policy_hash, config_hash, actor, reason, confirmation,
        provider_profile, created_at, updated_at
      ) VALUES ('activation-safety', 'fl04a-safety', 'mailbox', 'current', ?, ?, ?, 'r', 'c', 'gmail', ?, ?)
    `).run(sha('policy'), sha('config'), actor, seededAt, seededAt),
    pattern: /authority that can send email: currentCapabilityActivations/,
  },
];

for (const refusal of refusalCases) {
  test(`Precision Carbon refuses ${refusal.name}`, async (t) => {
    const fixture = repairStorage(t);
    await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
    withRawDatabase(fixture.sqlitePath, refusal.mutate, { foreignKeys: refusal.foreignKeys !== false });
    await assert.rejects(runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage)), refusal.pattern);
  });
}

test('Precision Carbon ignores Pursue state and inert authority that belong to other deals', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  await fixture.storage.upsertDealHunterOpportunity({
    ...opportunityRow(survivorId),
    opportunity_id: 'opp_unrelated',
    canonical_name: 'Unrelated Plumbing Co',
  });
  withRawDatabase(fixture.sqlitePath, (database) => {
    insertDecisionEvent(database, 'pursue-on-unrelated', 'opp_unrelated');
    insertSafetyEvent(database, 'opp_unrelated', 1, {
      status: 'no-op', consumed_at: seededAt, outcome_evidence_id: 'outcome',
    });
    database.prepare(`
      INSERT INTO deal_hunter_auto_pursue_activations (id, mode, daily_cap, actor, reason, confirmation, status, created_at)
      VALUES ('auto-shadow', 'shadow', 0, ?, 'shadow', 'ACTIVATE AUTO PURSUE SHADOW', 'current', ?)
    `).run(actor, seededAt);
    database.prepare(`
      INSERT INTO deal_hunter_pursue_send_controls (control_key, enabled, changed_at, changed_by, revision)
      VALUES ('live_sending', 0, ?, ?, 1)
    `).run(seededAt, actor);
  });
  const result = await runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage));
  assert.equal(result.plan.dependentState.counts.pursueCimAuthorities, 0);
});

test('descriptor guard rejects plan-pinned counts and incomplete pair-scoped approvals', () => {
  const clone = (mutate) => {
    const copy = structuredClone(approval);
    mutate(copy);
    return copy;
  };
  assert.equal(assertCanonicalOpportunityMergeApprovalShape(approval), true);
  assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
    copy.expectedDependentCounts.pursueCimAuthorities = null;
  })), /cannot leave dependent count pursueCimAuthorities to the plan/);
  assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
    copy.expectedPreservedState.cimSafetyEvents.supersededCount = null;
  })), /cannot leave cimSafetyEvents.supersededCount to the plan/);
  assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
    delete copy.dependentPolicy;
  })), /cannot leave dependent count \w+ to the plan/);
  for (const category of ['cimSafetyEvents', 'cimAuditEvents', 'crmOwnershipRevisions', 'freshnessEvidence']) {
    assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
      delete copy.expectedPreservedState[category];
    })), new RegExp(`must pin ${category}`));
  }
  assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
    copy.approvedResolutionReason = "Owner's decision: same business on two sites, keep the earliest.";
  })), /shell-safe approved resolution reason/);
  assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
    delete copy.survivorRule;
  })), /survivor rule/);
  assert.throws(() => assertCanonicalOpportunityMergeApprovalShape(clone((copy) => {
    copy.dependentPolicy = 'pair-scoped-preservation-v0';
  })), /unknown dependent policy/);
});

test('Precision Carbon refuses when the approved survivor is no longer the earliest-created deal', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  withRawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    UPDATE deal_hunter_opportunities SET created_at = '2026-10-31T15:00:40.000Z' WHERE opportunity_id = ?
  `).run(survivorId));
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(dryRunInput(fixture.storage)),
    /no longer the earliest-created/,
  );
});

test('pair-scoped scan follows a campaign to its conversation, transmissions, authorizations, terminal events, replies, and audit rows', async (t) => {
  const fixture = repairStorage(t);
  await seedPrecisionCarbon(fixture.storage, fixture.sqlitePath);
  withRawDatabase(fixture.sqlitePath, (database) => {
    insertCampaign(database, supersededId);
    database.prepare(`
      INSERT INTO deal_hunter_gmail_reply_messages (gmail_message_id, gmail_thread_id, conversation_id,
        classification, processed_at)
      VALUES ('replyMessage1', 'replyThread1', 'conversation-precision', 'reply', ?)
    `).run(seededAt);
    database.prepare(`
      INSERT INTO deal_hunter_cim_audit_events (id, event_type, campaign_id, next_state, actor, source,
        occurred_at, metadata)
      VALUES ('audit-campaign-linked', 'campaign-created', ?, 'queued', 'runner', 'pursue', ?, '{}')
    `).run(`campaign-${supersededId}`, seededAt);
    database.prepare(`
      INSERT INTO deal_hunter_cim_audit_events (id, event_type, next_state, actor, source, occurred_at, metadata)
      VALUES ('audit-metadata-linked', 'operator-note', 'noted', 'owner', 'review', ?, ?)
    `).run(seededAt, JSON.stringify({ opportunityId: survivorId }));
    database.prepare(`
      INSERT INTO deal_hunter_cim_transmission_touches (transmission_id, touch_id, opportunity_id, campaign_id,
        display_ordinal, created_at)
      VALUES ('transmission-precision', 'touch-precision', ?, ?, 1, ?)
    `).run(supersededId, `campaign-${supersededId}`, seededAt);
    database.prepare(`
      INSERT INTO deal_hunter_cim_live_provider_authorizations (id, activation_id, capability, writer_path,
        transmission_id, payload_digest, recipient_authority_digest, provider_profile, maximum_calls,
        issued_at, expires_at, actor, reason)
      VALUES ('authorization-precision', 'activation-elsewhere', 'fl04b-initial', 'initial-sender',
        'transmission-precision', ?, ?, 'gmail', 1, ?, '2026-11-02T16:00:40.000Z', 'runner', 'initial touch')
    `).run(sha('payload'), sha('recipient'), seededAt);
    database.prepare(`
      INSERT INTO deal_hunter_cim_terminal_events (id, scope, scope_id, campaign_id, revision, reason_code,
        evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at)
      VALUES ('terminal-precision', 'campaign', ?, ?, 1, 'stopped', 'owner', 'evidence', ?, 'owner', 'review', ?, ?)
    `).run(`campaign-${supersededId}`, `campaign-${supersededId}`, seededAt, sha('terminal'), seededAt);
    database.prepare(`
      INSERT INTO deal_hunter_cim_audit_events (id, event_type, authorization_id, next_state, actor, source,
        occurred_at, metadata)
      VALUES ('audit-authorization-linked', 'authorization-issued', 'authorization-precision', 'issued',
        'runner', 'pursue', ?, '{}')
    `).run(seededAt);
  }, { foreignKeys: false });
  const dependentState = withRawDatabase(fixture.sqlitePath, (database) => (
    inspectCanonicalMergeDependentState(database, approval)
  ));
  assert.deepEqual(dependentState.records.pursueCimAuthorities, [
    'deal_hunter_cim_audit_events:audit-authorization-linked',
    'deal_hunter_cim_audit_events:audit-campaign-linked',
    'deal_hunter_cim_audit_events:audit-metadata-linked',
    `deal_hunter_cim_campaigns:campaign-${supersededId}`,
    'deal_hunter_cim_live_provider_authorizations:authorization-precision',
    'deal_hunter_cim_terminal_events:terminal-precision',
    'deal_hunter_cim_transmission_touches:transmission-precision:touch-precision',
    'deal_hunter_gmail_reply_messages:replyMessage1',
  ]);
  assert.equal(dependentState.preservedIncidentState.cimAuditEvents.superseded.count,
    approval.expectedPreservedState.cimAuditEvents.supersededCount);
});
