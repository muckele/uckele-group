import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
  CANONICAL_OPPORTUNITY_MERGE_PLAN_SCHEMA,
  CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES,
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY,
  canonicalOpportunityMergeManifestId,
  canonicalOpportunityMergePlanChecksum,
  canonicalOpportunityMergeRelationshipInventorySummary,
  getCanonicalOpportunityMergeApproval,
  isCanonicalOpportunityMergeRelationshipColumn,
  stableCanonicalJson,
} from '../server/repairs/canonicalOpportunityMerge.js';
import { runCanonicalOpportunityMergeRepair } from '../server/services/canonicalOpportunityMergeRepair.js';
import { resolveDealHunterOpportunity } from '../server/services/cimOpportunityIdentity.js';
import {
  createSqliteCanonicalOpportunityMergeReadOnlyStorage,
  createSqliteStorage,
} from '../server/storage/sqlite.js';
import {
  parseCanonicalOpportunityMergeArgs,
  runCanonicalOpportunityMergeCli,
} from '../scripts/repair-canonical-opportunity-merge.js';

const exceptionId = '8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571';
const survivorId = 'opp_cd57a315-feaf-4158-a02e-4bdde97a922e';
const supersededId = 'opp_c92d0c73-6a47-4fed-b528-6f310745e448';
const materialScannerPathEnforcement = 'material-scanner-path';
const independentGateEnforcement = 'independent-gate';
const approvalPreconditionEnforcement = 'approval-precondition';
const explicitExclusionEnforcement = 'explicit-exclusion';
const automationInertGate = 'automation-inert-policy-state-verification';
const persistedOutreachPauseGate = 'persisted-global-cim-outreach-pause';
const optionalLegacySchemaPresence = 'optional-legacy';
const productionDerivedLegacySchema = fs.readFileSync(
  new URL('./fixtures/production-derived-legacy-relationship-schema.sql', import.meta.url),
  'utf8',
);
const productionOnlyRelationshipClassifications = {
  'admin_magic_links_legacy_v1.email': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    enforcement: explicitExclusionEnforcement,
    scannerPath: 'excluded.adminAuthentication',
  },
  'deal_hunter_candidates.run_id': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    enforcement: materialScannerPathEnforcement,
    scannerPath: 'dependentState.records.legacyDealHunterCandidates',
  },
  'deal_hunter_candidates.source_url': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    enforcement: materialScannerPathEnforcement,
    scannerPath: 'dependentState.records.legacyDealHunterCandidates',
  },
  'prospect_discoveries.run_id': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    enforcement: materialScannerPathEnforcement,
    scannerPath: 'dependentState.records.linkedCrmState',
  },
  'prospect_discoveries.source_id': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    enforcement: materialScannerPathEnforcement,
    scannerPath: 'dependentState.records.linkedCrmState',
  },
  'prospect_discoveries.submission_id': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    enforcement: materialScannerPathEnforcement,
    scannerPath: 'dependentState.records.linkedCrmState',
  },
  'prospect_discoveries.website_url': {
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    enforcement: materialScannerPathEnforcement,
    scannerPath: 'dependentState.records.linkedCrmState',
  },
};

const expectedAliases = [
  ['deal-key', 'url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx', supersededId],
  ['listing-url', 'https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx', supersededId],
  ['source-identity', 'url:us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx', supersededId],
  ['deal-key', 'url:https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/', survivorId],
  ['deal-key', 'url:https://www.dealstream.com/d/biz-sale/hvac/acarj0', survivorId],
  ['fingerprint-v1', '0985c4d3eff0153a0793694edbd20f73682a223d2c37830abbc7dfde77256657', survivorId],
  ['fingerprint-v1', '388ed3db60b28f9fb0d12b547549e9513846f06c894356f6c72bff7a50ebdd43', survivorId],
  ['listing-id', 'costar:2542991', survivorId],
  ['listing-id', 'dealstream:/d/biz-sale/hvac/acarj0', survivorId],
  ['listing-url', 'https://bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991', survivorId],
  ['source-identity', 'url:bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991', survivorId],
  ['source-identity', 'url:dealstream.com/d/biz-sale/hvac/acarj0', survivorId],
].sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));

const fixtureNow = new Date('2026-08-26T20:00:00.000Z');
const fixtureNowIso = fixtureNow.toISOString();
const fixtureActor = 'incident-owner@example.test';
const fixtureReason = 'Reviewed syndicated HVAC listings are the same business; preserve the approved survivor.';
const cliBaseArgs = [
  '--exception-id', exceptionId,
  '--survivor-id', survivorId,
  '--superseded-id', supersededId,
  '--actor', fixtureActor,
  '--reason', fixtureReason,
];
const repairStoragePaths = new WeakMap();

function repairStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-canonical-merge-'));
  const sqlitePath = path.join(directory, 'repair.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  repairStoragePaths.set(storage, {
    sqlitePath,
    backupPath: path.join(directory, 'approved-pre-merge-backup.sqlite'),
  });
  return { storage, sqlitePath };
}

function approvedOpportunity(opportunityId) {
  return {
    opportunity_id: opportunityId,
    created_at: '2026-08-21T15:00:29.815Z',
    updated_at: '2026-08-26T19:00:00.000Z',
    canonical_name: 'High Earning HVAC, Plumbing, & Sheet Metal Business and Real Estate!',
    canonical_recipient: 'broker@example.test',
    canonical_location: 'Las Vegas, Clark, NV, US',
    primary_submission_id: null,
    identity_version: 'cim-opportunity-v1',
    status: 'active',
    metadata: {
      retainedFixtureMetadata: `preserve-${opportunityId}`,
      identitySnapshot: {
        name: 'high earning hvac plumbing and sheet metal business and real estate',
        description: 'x'.repeat(498),
        recipient: 'broker@example.test',
        location: 'las vegas clark nv us',
        city: 'las vegas',
        county: 'clark',
        state: 'nv',
        country: 'us',
        askingPrice: 5_000_000,
        revenue: 4_500_000,
        profit: 500_000,
        sourceIds: ['sheet 0'],
        listingIds: ['costar:2542991', 'dealstream:/d/biz-sale/hvac/acarj0'],
        listingUrl: 'https://bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991',
      },
    },
  };
}

async function seedApprovedRepair(storage) {
  const approval = getCanonicalOpportunityMergeApproval({ exceptionId, survivorId, supersededId });
  await storage.upsertDealHunterOpportunity(approvedOpportunity(survivorId));
  await storage.upsertDealHunterOpportunity(approvedOpportunity(supersededId));
  for (const [index, item] of approval.expectedAliases.entries()) {
    await storage.upsertDealHunterOpportunityAlias({
      id: `approved-alias-${index}`,
      opportunity_id: item.opportunityId,
      alias_type: item.aliasType,
      alias_value: item.aliasValue,
      alias_key: item.aliasKey,
      source: 'SMB Deal Hunter Google Sheet',
      first_observed_at: '2026-08-21T15:00:29.815Z',
      last_observed_at: '2026-08-26T19:00:00.000Z',
      evidence_version: 'cim-opportunity-v1',
      resolution_method: item.opportunityId === supersededId ? 'new-opportunity' : 'exact-alias',
      confidence_state: 'exact',
      resolved_by: 'deal-hunter-review',
      metadata: { fixture: true },
    });
  }
  await storage.upsertDealHunterIdentityException({
    id: exceptionId,
    created_at: '2026-08-21T15:00:29.815Z',
    updated_at: '2026-08-26T19:00:00.000Z',
    status: 'open',
    observed_deal_key: null,
    observed_name: 'High Earning HVAC, Plumbing, & Sheet Metal Business and Real Estate!',
    observed_recipient: 'broker@example.test',
    candidate_opportunity_ids: [supersededId, survivorId],
    reason: 'conflicting-canonical-aliases',
    evidence_version: 'cim-opportunity-v1',
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    metadata: { fixture: true },
  });
  const paths = repairStoragePaths.get(storage);
  if (paths) await storage.createApplicationBackup(paths.backupPath);
  return approval;
}

async function repairState(storage) {
  return {
    opportunities: await storage.listDealHunterOpportunities({ opportunityIds: [survivorId, supersededId], limit: 10 }),
    aliases: await storage.listDealHunterOpportunityAliases({ opportunityIds: [survivorId, supersededId], limit: 100 }),
    exceptions: await storage.listDealHunterIdentityExceptions({ limit: 100 }),
    manifests: await storage.listDealHunterCimRepairManifests({ limit: 100 }),
    pause: await storage.getDealHunterCimSafetySettings(),
  };
}

function repairInput(overrides = {}) {
  return {
    exceptionId,
    survivorId,
    supersededId,
    actor: fixtureActor,
    reason: fixtureReason,
    now: fixtureNow,
    ...overrides,
  };
}

function verifiedBackupEvidence(overrides = {}) {
  return {
    ok: true,
    errors: [],
    path: '/synthetic/verified-backup',
    manifest: {
      version: 1,
      provider: 'sqlite',
      id: 'synthetic-backup-2026-08-26',
      createdAt: '2026-08-26T19:30:00.000Z',
      database: {
        relativePath: 'uckele-group.sqlite',
        sizeBytes: 1024,
        sha256: 'b'.repeat(64),
      },
      secureDocuments: { count: 0, totalBytes: 0, files: [] },
      retention: { days: 30, count: 14 },
      verification: {
        verifiedAt: '2026-08-26T19:31:00.000Z',
        databaseCheck: 'quick_check',
        checksum: 'sha256',
      },
    },
    ...overrides,
  };
}

async function pauseOutreach(storage, { refreshBackup = true } = {}) {
  await storage.upsertDealHunterCimSafetySettings({
    updated_at: fixtureNowIso,
    outreach_paused: true,
    updated_by: fixtureActor,
    metadata: { pauseReason: 'Canonical opportunity merge fixture.' },
  });
  const paths = repairStoragePaths.get(storage);
  if (refreshBackup && paths) {
    fs.rmSync(paths.backupPath, { force: true });
    await storage.createApplicationBackup(paths.backupPath);
  }
}

function applyInput(storage, planChecksum, overrides = {}) {
  const paths = repairStoragePaths.get(storage);
  const backupVerification = paths
    ? verifiedBackupEvidence({
        path: path.dirname(paths.backupPath),
        manifest: {
          ...verifiedBackupEvidence().manifest,
          createdAt: fixtureNowIso,
          database: {
            ...verifiedBackupEvidence().manifest.database,
            relativePath: path.basename(paths.backupPath),
            sizeBytes: fs.statSync(paths.backupPath).size,
            sha256: createHash('sha256').update(fs.readFileSync(paths.backupPath)).digest('hex'),
          },
          verification: {
            ...verifiedBackupEvidence().manifest.verification,
            verifiedAt: fixtureNowIso,
          },
        },
      })
    : verifiedBackupEvidence();
  return repairInput({
    storage,
    apply: true,
    confirmation: CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
    expectedPlanChecksum: planChecksum,
    backupVerification,
    ...overrides,
  });
}

function resolverDealForObservation(observation) {
  const dealKey = observation.durableAliasKeys
    .find((aliasKey) => aliasKey.startsWith('deal-key:'))
    ?.slice('deal-key:'.length);
  return {
    id: observation.sourceRecordId,
    sourceId: 'sheet 0',
    sourceName: 'SMB Deal Hunter Google Sheet',
    dealKey,
    listingUrl: observation.listingUrl,
    identityAliases: observation.identityAliases,
  };
}

function withRawDatabase(sqlitePath, callback) {
  const database = new Database(sqlitePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function installProductionDerivedLegacySchema(sqlitePath) {
  withRawDatabase(sqlitePath, (database) => database.exec(productionDerivedLegacySchema));
}

async function assertReadOnlyPlanningRefuses(sqlitePath, pattern) {
  let readOnlyStorage;
  try {
    await assert.rejects(async () => {
      readOnlyStorage = createSqliteCanonicalOpportunityMergeReadOnlyStorage({
        storage: { provider: 'sqlite', sqlitePath },
      });
      await runCanonicalOpportunityMergeRepair(repairInput({ storage: readOnlyStorage }));
    }, pattern);
  } finally {
    readOnlyStorage?.close();
  }
}

function sqliteTableColumnMetadata(database, table) {
  return database.prepare(`
    SELECT name, hidden FROM pragma_table_xinfo(?) ORDER BY cid
  `).all(table);
}

function sqliteRelationshipSchema(database) {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  const relationshipColumns = tables.flatMap((table) => (
    sqliteTableColumnMetadata(database, table)
      .map((row) => row.name)
      .filter(isCanonicalOpportunityMergeRelationshipColumn)
      .map((column) => `${table}.${column}`)
  )).sort();
  return { tables, relationshipColumns };
}

function insertLegacyDealHunterCandidate(database, {
  id,
  sourceUrl,
  broker = null,
  rawText = null,
} = {}) {
  database.prepare(`
    INSERT INTO deal_hunter_candidates (
      id, run_id, created_at, company, source_url, broker, raw_text,
      score, recession_score, ai_resistance_score, criteria_score, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'synthetic-legacy-run',
    fixtureNowIso,
    'Synthetic legacy candidate',
    sourceUrl,
    broker,
    rawText,
    80,
    20,
    20,
    40,
    'qualified',
  );
}

function insertRetiredProspectDiscovery(database, {
  id,
  submissionId = null,
  websiteUrl = null,
  sourceData = {},
} = {}) {
  database.prepare(`
    INSERT INTO prospect_discoveries (
      id, run_id, created_at, updated_at, provider, source_id,
      business_name, website_url, status, submission_id, source_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'synthetic-discovery-run',
    fixtureNowIso,
    fixtureNowIso,
    'synthetic-provider',
    'synthetic-source-id',
    'Synthetic retired prospect',
    websiteUrl,
    'retired',
    submissionId,
    JSON.stringify(sourceData),
  );
}

function directoryFileSha256(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    const stat = fs.statSync(filePath);
    return [
      name,
      stat.isFile() ? createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : '<directory>',
    ];
  }));
}

function insertUnexpectedDependent(sqlitePath, category, opportunityId) {
  withRawDatabase(sqlitePath, (database) => {
    const id = `unexpected-${category}`;
    const targetDealKey = opportunityId === supersededId
      ? 'url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx'
      : 'url:https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/';
    switch (category) {
      case 'opportunityScores':
        database.prepare(`
          INSERT INTO deal_hunter_opportunity_scores (
            opportunity_id, created_at, scored_at, score_fingerprint,
            engine_version, rules_version, profile_version, completeness_policy_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(opportunityId, fixtureNowIso, fixtureNowIso, id, 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1');
        break;
      case 'scoreEvidence':
        insertUnexpectedDependent(sqlitePath, 'opportunityScores', opportunityId);
        database.prepare(`
          INSERT INTO deal_hunter_score_evidence (
            id, opportunity_id, score_fingerprint, created_at, rule_id,
            rule_label, evidence_class, terms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, opportunityId, 'unexpected-opportunityScores', fixtureNowIso, 'rule', 'Rule', 'source', '[]');
        break;
      case 'contactSubmissions':
        database.prepare(`
          INSERT INTO contact_submissions (
            id, created_at, updated_at, status, delivery_provider, delivery_status,
            crm_status, source, ip_hash, name, email, message,
            deal_hunter_opportunity_id, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, fixtureNowIso, fixtureNowIso, 'new', 'none', 'not-attempted',
          'not-synced', 'fixture', 'ip-hash', 'Fixture', 'fixture@example.test',
          'Unexpected dependent state.', opportunityId, '{}',
        );
        break;
      case 'crmImports':
        database.prepare(`
          INSERT INTO deal_hunter_crm_imports (
            id, created_at, updated_at, deal_key, status, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, fixtureNowIso, fixtureNowIso, targetDealKey, 'imported', '{}', opportunityId);
        break;
      case 'aliasDerivedCrmImport':
        database.prepare(`
          INSERT INTO deal_hunter_crm_imports (
            id, created_at, updated_at, deal_key, status, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        `).run(id, fixtureNowIso, fixtureNowIso, targetDealKey, 'imported', '{}');
        break;
      case 'crmReconciliationItems':
        database.prepare(`
          INSERT INTO deal_hunter_crm_reconciliation_runs (
            id, created_at, updated_at, import_id, mode, plan_digest,
            idempotency_key, status, counts, plan, results, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`${id}-run`, fixtureNowIso, fixtureNowIso, `${id}-import`, 'preview', id, `${id}-key`, 'completed', '{}', '{}', '{}', '{}');
        database.prepare(`
          INSERT INTO deal_hunter_crm_reconciliation_items (
            id, run_id, opportunity_id, deal_key, action, status,
            source_row_numbers, planned_changes, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, `${id}-run`, opportunityId, targetDealKey, 'none', 'planned', '[]', '{}', fixtureNowIso, fixtureNowIso, '{}');
        break;
      case 'crmReconciliationRuns':
        database.prepare(`
          INSERT INTO deal_hunter_crm_reconciliation_runs (
            id, created_at, updated_at, import_id, mode, plan_digest,
            idempotency_key, status, counts, plan, results, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, fixtureNowIso, fixtureNowIso, `${id}-import`, 'preview', id,
          `${id}-key`, 'completed', '{}', JSON.stringify({ opportunityId }), '{}', '{}',
        );
        break;
      case 'cimRequests':
        database.prepare(`
          INSERT INTO deal_hunter_cim_requests (
            id, created_at, updated_at, deal_key, recipient_email, status,
            metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, fixtureNowIso, fixtureNowIso, targetDealKey, 'broker@example.test', 'sent', '{}', opportunityId);
        break;
      case 'cimReviews':
        database.prepare(`
          INSERT INTO deal_hunter_cim_reviews (
            id, created_at, deal_key, decision, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, fixtureNowIso, targetDealKey, 'approved', '{}', opportunityId);
        break;
      case 'communications':
        database.prepare(`
          INSERT INTO crm_communications (
            id, deal_key, direction, channel, source, to_addresses, body_text,
            occurred_at, created_at, updated_at, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, targetDealKey, 'outbound', 'email', 'fixture', '[]', '', fixtureNowIso, fixtureNowIso, fixtureNowIso, '{}', opportunityId);
        break;
      case 'emailEvents':
        database.prepare(`
          INSERT INTO email_events (
            id, created_at, provider, event_type, source, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, fixtureNowIso, 'fixture', 'delivered', 'fixture', '{}', opportunityId);
        break;
      case 'metadataReference':
        database.prepare(`
          INSERT INTO email_events (
            id, created_at, provider, event_type, source, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        `).run(id, fixtureNowIso, 'fixture', 'delivered', 'fixture', JSON.stringify({ opportunityId }));
        break;
      case 'activityEvents':
        database.prepare(`
          INSERT INTO crm_activity_events (
            id, submission_id, created_at, actor, role, event_type,
            summary, metadata, opportunity_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, `${id}-submission`, fixtureNowIso, 'fixture', 'system', 'fixture', 'Unexpected state', '{}', opportunityId);
        break;
      case 'opportunityClaims':
        database.prepare(`
          INSERT INTO deal_hunter_cim_opportunity_claims (
            opportunity_id, request_id, recipient_email, state, claimed_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(opportunityId, `${id}-request`, 'broker@example.test', 'active', fixtureNowIso, fixtureNowIso, '{}');
        break;
      case 'recipientClaims':
        database.prepare(`
          INSERT INTO deal_hunter_cim_recipient_claims (
            recipient_email, request_id, opportunity_id, claimed_at, expires_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(`${category}@example.test`, `${id}-request`, opportunityId, fixtureNowIso, '2026-08-27T20:00:00.000Z', '{}');
        break;
      case 'recipientOverrides':
        database.prepare(`
          INSERT INTO deal_hunter_cim_recipient_overrides (
            id, opportunity_id, recipient_email, created_at, expires_at,
            created_by, reason, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, opportunityId, 'override@example.test', fixtureNowIso, '2026-08-27T20:00:00.000Z', 'fixture', 'Unexpected override', '{}');
        break;
      case 'stage2Decisions':
        database.prepare(`
          INSERT INTO deal_hunter_cim_stage2_decisions (
            id, run_id, created_at, updated_at, opportunity_id, deal_key,
            decision_state, policy_hash, rule_version, source_policy_hash,
            snapshot_digest, recipient_hash, source_snapshot_digest, reasons, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, `${id}-run`, fixtureNowIso, fixtureNowIso, opportunityId, targetDealKey,
          'blocked', 'policy', 'rules', 'source-policy', 'snapshot', 'recipient',
          'source-snapshot', '[]', '{}',
        );
        break;
      case 'followUpState':
        database.prepare(`
          INSERT INTO crm_follow_up_recommendations (
            id, submission_id, input_fingerprint, engine_version, rules_version,
            status, conversation_state, intent, action_type, created_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, `${id}-submission`, id, 'engine-v1', 'rules-v1',
          'pending', 'awaiting-reply', 'follow-up', 'email', fixtureNowIso,
          JSON.stringify({ opportunityId }),
        );
        break;
      case 'dispositions':
        database.prepare(`
          INSERT INTO deal_hunter_dispositions (
            id, deal_key, listing_url, deal_name, created_at, updated_at,
            disposition, reason, created_by, updated_by, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, targetDealKey, null, 'Unexpected disposition', fixtureNowIso, fixtureNowIso,
          'dismissed', 'Unexpected dependent state.', 'fixture', 'fixture', '{}',
        );
        break;
      case 'historicalIdentityEvidence':
        database.prepare(`
          INSERT INTO deal_hunter_seen_deals (
            id, first_seen_at, last_seen_at, source_id, source_name,
            listing_url, name, should_remove, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetDealKey, fixtureNowIso, fixtureNowIso, 'fixture', 'Fixture',
          null, 'Unexpected historical identity evidence', 0, '{}',
        );
        break;
      case 'sourceImportPayloads':
        database.prepare(`
          INSERT INTO deal_hunter_deal_os_imports (
            id, created_at, imported_by, exported_at, file_name, file_type,
            file_size, file_sha256, scope, coverage_label, row_count,
            records, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, fixtureNowIso, 'fixture', fixtureNowIso, 'fixture.json', 'application/json',
          1, 'c'.repeat(64), 'full', 'fixture', 1,
          JSON.stringify([{ opportunityId }]), '{}',
        );
        break;
      case 'otherIdentityExceptions':
        database.prepare(`
          INSERT INTO deal_hunter_identity_exceptions (
            id, created_at, updated_at, status, candidate_opportunity_ids,
            reason, evidence_version, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, fixtureNowIso, fixtureNowIso, 'open', JSON.stringify([opportunityId]),
          'fixture-conflict', 'cim-opportunity-v1', '{}',
        );
        break;
      case 'stage2Runs':
        database.prepare(`
          INSERT INTO deal_hunter_cim_stage2_runs (
            id, run_key, created_at, updated_at, pacific_business_date,
            mode, status, triggered_by, policy_hash, rule_version,
            source_policy_hash, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, `${id}-key`, fixtureNowIso, fixtureNowIso, '2026-08-26',
          'shadow', 'completed', 'fixture', 'policy', 'rules', 'source-policy',
          JSON.stringify({ opportunityId }),
        );
        break;
      case 'scheduledJobs':
        database.prepare(`
          INSERT INTO scheduled_job_runs (
            job_key, job_name, created_at, updated_at, started_at, status,
            triggered_by, attempt_count, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, 'fixture', fixtureNowIso, fixtureNowIso, fixtureNowIso,
          'pending', 'fixture', 1, JSON.stringify({ opportunityId }),
        );
        break;
      case 'linkedCrmState':
        database.prepare(`
          INSERT INTO secure_document_cleanup_jobs (
            id, submission_id, created_at, updated_at, status, files,
            attempt_count, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, `${id}-submission`, fixtureNowIso, fixtureNowIso,
          'reconciliation-pending', '[]', 0, JSON.stringify({ opportunityId }),
        );
        break;
      case 'otherRepairManifests':
        database.prepare(`
          INSERT INTO deal_hunter_cim_repair_manifests (
            id, created_at, updated_at, mode, status, actor,
            backup_reference, checksum, manifest, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, fixtureNowIso, fixtureNowIso, 'apply', 'applied', 'fixture',
          '/fixture', 'historical-checksum', JSON.stringify({ historicalOpportunityId: opportunityId }), '{}',
        );
        break;
      default:
        throw new Error(`Unknown dependent fixture category: ${category}`);
    }
  });
}

const dependentFixtureTables = {
  opportunityScores: 'deal_hunter_opportunity_scores',
  scoreEvidence: 'deal_hunter_score_evidence',
  contactSubmissions: 'contact_submissions',
  crmImports: 'deal_hunter_crm_imports',
  aliasDerivedCrmImport: 'deal_hunter_crm_imports',
  crmReconciliationItems: 'deal_hunter_crm_reconciliation_items',
  crmReconciliationRuns: 'deal_hunter_crm_reconciliation_runs',
  cimRequests: 'deal_hunter_cim_requests',
  cimReviews: 'deal_hunter_cim_reviews',
  communications: 'crm_communications',
  emailEvents: 'email_events',
  metadataReference: 'email_events',
  activityEvents: 'crm_activity_events',
  opportunityClaims: 'deal_hunter_cim_opportunity_claims',
  recipientClaims: 'deal_hunter_cim_recipient_claims',
  recipientOverrides: 'deal_hunter_cim_recipient_overrides',
  stage2Decisions: 'deal_hunter_cim_stage2_decisions',
  followUpState: 'crm_follow_up_recommendations',
  dispositions: 'deal_hunter_dispositions',
  historicalIdentityEvidence: 'deal_hunter_seen_deals',
  sourceImportPayloads: 'deal_hunter_deal_os_imports',
  otherIdentityExceptions: 'deal_hunter_identity_exceptions',
  stage2Runs: 'deal_hunter_cim_stage2_runs',
  scheduledJobs: 'scheduled_job_runs',
  linkedCrmState: 'secure_document_cleanup_jobs',
  otherRepairManifests: 'deal_hunter_cim_repair_manifests',
};

test('checked-in approval freezes the exact HVAC tuple and alias ownership set', () => {
  const approval = getCanonicalOpportunityMergeApproval({ exceptionId, survivorId, supersededId });

  assert.equal(CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE, 'canonical-opportunity-merge');
  assert.equal(
    CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
    `MERGE ${supersededId} INTO ${survivorId} FOR EXCEPTION ${exceptionId}`,
  );
  assert.equal(Object.isFrozen(approval), true);
  assert.equal(Object.isFrozen(approval.expectedAliases), true);
  assert.deepEqual(
    approval.expectedAliases
      .map((item) => [item.aliasType, item.aliasValue, item.opportunityId])
      .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000'))),
    expectedAliases,
  );
  assert.equal(approval.expectedAliases.filter((item) => item.opportunityId === supersededId).length, 3);
  assert.equal(approval.expectedAliases.filter((item) => item.opportunityId === survivorId).length, 9);
  assert.throws(
    () => getCanonicalOpportunityMergeApproval({ exceptionId, survivorId: supersededId, supersededId: survivorId }),
    /not an approved canonical opportunity merge/i,
  );
});

test('repair refuses every non-SQLite provider before planning', async () => {
  for (const provider of ['supabase', 'postgres', '', undefined]) {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(repairInput({ storage: { provider } })),
      /SQLite-only/i,
    );
  }
});

test('repair service requires explicitly supplied storage and never starts the application storage implicitly', async () => {
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: null })),
    /explicitly supplied storage.*automatic storage startup is disabled/i,
  );
});

test('operator CLI parsing is dry-run by default and requires explicit human identity fields', () => {
  const parsed = parseCanonicalOpportunityMergeArgs(cliBaseArgs);
  assert.deepEqual(parsed, {
    apply: false,
    exceptionId,
    survivorId,
    supersededId,
    actor: fixtureActor,
    reason: fixtureReason,
    expectedPlanChecksum: '',
    backupReference: '',
    confirmation: '',
  });
  for (const flag of ['--exception-id', '--survivor-id', '--superseded-id', '--actor', '--reason']) {
    const index = cliBaseArgs.indexOf(flag);
    const missing = cliBaseArgs.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
    assert.throws(() => parseCanonicalOpportunityMergeArgs(missing), new RegExp(flag.slice(2), 'i'));
  }
  assert.throws(
    () => parseCanonicalOpportunityMergeArgs([...cliBaseArgs, '--execute']),
    /unknown option|execute/i,
    'no apply alias or implicit mutation switch is accepted',
  );
  assert.throws(
    () => parseCanonicalOpportunityMergeArgs([...cliBaseArgs, '--actor=second-operator@example.test']),
    /--actor exactly once/i,
    'mixed --flag value and --flag=value spellings cannot override an audited field',
  );
});

test('operator CLI apply parsing requires every apply-only gate', () => {
  const applyArgs = [
    ...cliBaseArgs,
    '--apply',
    '--expected-plan-checksum', 'a'.repeat(64),
    '--backup', '/synthetic/backup',
    '--confirm', CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
  ];
  const parsed = parseCanonicalOpportunityMergeArgs(applyArgs);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.expectedPlanChecksum, 'a'.repeat(64));
  assert.equal(parsed.backupReference, '/synthetic/backup');
  assert.equal(parsed.confirmation, CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION);

  for (const flag of ['--expected-plan-checksum', '--backup', '--confirm']) {
    const index = applyArgs.indexOf(flag);
    const missing = applyArgs.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
    assert.throws(() => parseCanonicalOpportunityMergeArgs(missing), new RegExp(flag.slice(2), 'i'));
  }
  assert.throws(
    () => parseCanonicalOpportunityMergeArgs([
      ...cliBaseArgs,
      '--apply',
      '--expected-plan-checksum', 'not-a-checksum',
      '--backup', '/synthetic/backup',
      '--confirm', CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
    ]),
    /64-character.*checksum/i,
  );
});

test('operator CLI refuses non-SQLite before backup verification or repair execution', async () => {
  let backupCalls = 0;
  let repairCalls = 0;
  await assert.rejects(
    runCanonicalOpportunityMergeCli({
      argv: [
        ...cliBaseArgs,
        '--apply',
        '--expected-plan-checksum', 'a'.repeat(64),
        '--backup', '/synthetic/backup',
        '--confirm', CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
      ],
      getConfigFn: () => ({ storage: { provider: 'supabase' } }),
      getStorageFn: () => { throw new Error('storage must not open'); },
      verifyBackupBundleFn: async () => { backupCalls += 1; return verifiedBackupEvidence(); },
      runRepairFn: async () => { repairCalls += 1; return { ok: true }; },
    }),
    /SQLite-only/i,
  );
  assert.equal(backupCalls, 0);
  assert.equal(repairCalls, 0);
});

test('operator CLI rejects an unapproved tuple before backup verification', async () => {
  let backupCalls = 0;
  let repairCalls = 0;
  const args = [...cliBaseArgs];
  args[args.indexOf(survivorId)] = 'opp_unapproved_survivor';
  await assert.rejects(
    runCanonicalOpportunityMergeCli({
      argv: [
        ...args,
        '--apply',
        '--expected-plan-checksum', 'a'.repeat(64),
        '--backup', '/synthetic/backup',
        '--confirm', CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
      ],
      getConfigFn: () => ({ storage: { provider: 'sqlite', sqlitePath: '/unused' } }),
      getStorageFn: () => ({ provider: 'sqlite' }),
      verifyBackupBundleFn: async () => { backupCalls += 1; return verifiedBackupEvidence(); },
      runRepairFn: async () => { repairCalls += 1; return { ok: true }; },
    }),
    /not an approved canonical opportunity merge/i,
  );
  assert.equal(backupCalls, 0);
  assert.equal(repairCalls, 0);
});

test('operator CLI verifies apply backup evidence and passes the complete result to the repair service', async () => {
  const verification = verifiedBackupEvidence();
  const calls = [];
  const result = await runCanonicalOpportunityMergeCli({
    argv: [
      ...cliBaseArgs,
      '--apply',
      '--expected-plan-checksum', 'a'.repeat(64),
      '--backup', '/synthetic/backup',
      '--confirm', CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
    ],
    getConfigFn: () => ({ storage: { provider: 'sqlite', sqlitePath: '/unused' } }),
    getStorageFn: () => ({ provider: 'sqlite' }),
    verifyBackupBundleFn: async (backupPath) => {
      calls.push(['verify', backupPath]);
      return verification;
    },
    runRepairFn: async (input) => {
      calls.push(['repair', input]);
      return { ok: true, mode: 'apply' };
    },
  });
  assert.deepEqual(result, { ok: true, mode: 'apply' });
  assert.equal(calls[0][0], 'verify');
  assert.equal(path.isAbsolute(calls[0][1]), true);
  assert.equal(calls[1][0], 'repair');
  assert.equal(calls[1][1].backupVerification, verification);
  assert.equal(calls[1][1].storage.provider, 'sqlite');
  assert.equal(calls[1][1].actor, fixtureActor);
  assert.equal(calls[1][1].reason, fixtureReason);
});

test('operator CLI dry run never verifies a backup and direct refusals are prefixed and nonzero', async () => {
  let backupCalls = 0;
  let ordinaryStorageCalls = 0;
  let closeCalls = 0;
  const dryRun = await runCanonicalOpportunityMergeCli({
    argv: cliBaseArgs,
    getConfigFn: () => ({ storage: { provider: 'sqlite', sqlitePath: '/synthetic/read-only.sqlite' } }),
    getStorageFn: () => { ordinaryStorageCalls += 1; return { provider: 'sqlite' }; },
    createReadOnlyStorageFn: () => ({
      provider: 'sqlite',
      close: () => { closeCalls += 1; },
    }),
    verifyBackupBundleFn: async () => { backupCalls += 1; return verifiedBackupEvidence(); },
    runRepairFn: async (input) => ({ ok: true, mode: input.apply ? 'apply' : 'dry-run' }),
  });
  assert.deepEqual(dryRun, { ok: true, mode: 'dry-run' });
  assert.equal(backupCalls, 0);
  assert.equal(ordinaryStorageCalls, 0);
  assert.equal(closeCalls, 1);

  const direct = spawnSync(process.execPath, ['scripts/repair-canonical-opportunity-merge.js'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /^\[canonical-opportunity-merge-repair\]/);
  assert.equal(direct.stdout, '');
});

test('standalone CLI dry run leaves the SQLite file and directory byte-for-byte unchanged', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const cliDatabasePath = repairStoragePaths.get(fixture.storage).backupPath;
  const directory = path.dirname(cliDatabasePath);
  withRawDatabase(cliDatabasePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_cim_requests (
        id, created_at, updated_at, deal_key, recipient_email, status, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'unrelated-legacy-cim-request',
      '2026-08-20T12:00:00.000Z',
      '2026-08-20T12:00:00.000Z',
      'url:https://example.test/unrelated-listing',
      'unrelated@example.test',
      'sent',
      '{}',
    );
  });
  const beforeDatabaseSha256 = createHash('sha256')
    .update(fs.readFileSync(cliDatabasePath))
    .digest('hex');
  const beforeFiles = fs.readdirSync(directory).sort();

  const result = spawnSync(process.execPath, [
    'scripts/repair-canonical-opportunity-merge.js',
    ...cliBaseArgs,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      STORAGE_PROVIDER: 'sqlite',
      SQLITE_PATH: cliDatabasePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.applied, false);
  assert.equal(output.applyBlocked, false);
  const afterDatabaseSha256 = createHash('sha256')
    .update(fs.readFileSync(cliDatabasePath))
    .digest('hex');
  assert.equal(afterDatabaseSha256, beforeDatabaseSha256);
  assert.deepEqual(fs.readdirSync(directory).sort(), beforeFiles);
});

test('standalone CLI dry run reads current WAL state from a private snapshot without touching source files', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const directory = path.dirname(fixture.sqlitePath);
  const walPath = `${fixture.sqlitePath}-wal`;
  assert.equal(fs.existsSync(walPath), true);
  assert.ok(fs.statSync(walPath).size > 0, 'fixture must exercise committed state still present in WAL');
  const beforeFiles = directoryFileSha256(directory);

  const result = spawnSync(process.execPath, [
    'scripts/repair-canonical-opportunity-merge.js',
    ...cliBaseArgs,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      STORAGE_PROVIDER: 'sqlite',
      SQLITE_PATH: fixture.sqlitePath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.plan.observedAliases.length, 12);
  assert.deepEqual(directoryFileSha256(directory), beforeFiles);
});

test('standalone CLI dry run refuses schema drift without migrating or changing files', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const cliDatabasePath = repairStoragePaths.get(fixture.storage).backupPath;
  const directory = path.dirname(cliDatabasePath);
  withRawDatabase(cliDatabasePath, (database) => {
    database.exec('DROP TABLE deal_hunter_crm_reconciliation_runs');
  });
  const beforeDatabaseSha256 = createHash('sha256')
    .update(fs.readFileSync(cliDatabasePath))
    .digest('hex');
  const beforeFiles = fs.readdirSync(directory).sort();

  const result = spawnSync(process.execPath, [
    'scripts/repair-canonical-opportunity-merge.js',
    ...cliBaseArgs,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      STORAGE_PROVIDER: 'sqlite',
      SQLITE_PATH: cliDatabasePath,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^\[canonical-opportunity-merge-repair\]/);
  assert.match(result.stderr, /unsupported SQLite schema/i);
  assert.match(result.stderr, /deal_hunter_crm_reconciliation_runs \(table\)/);
  const afterDatabaseSha256 = createHash('sha256')
    .update(fs.readFileSync(cliDatabasePath))
    .digest('hex');
  assert.equal(afterDatabaseSha256, beforeDatabaseSha256);
  assert.deepEqual(fs.readdirSync(directory).sort(), beforeFiles);
});

test('dry run refuses an unclassified future relationship-bearing column', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec('ALTER TABLE deal_hunter_cim_requests ADD COLUMN future_opportunity_id TEXT');
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /unsupported SQLite schema.*unclassified.*deal_hunter_cim_requests\.future_opportunity_id/i,
  );
});

test('read-only planning refuses a virtual generated relationship column on a required current table', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const columns = withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      ALTER TABLE deal_hunter_cim_requests
      ADD COLUMN future_opportunity_id TEXT
      GENERATED ALWAYS AS (opportunity_id) VIRTUAL
    `);
    return sqliteTableColumnMetadata(database, 'deal_hunter_cim_requests');
  });
  assert.deepEqual(columns.find(({ name }) => name === 'opportunity_id'), {
    name: 'opportunity_id',
    hidden: 0,
  });
  assert.deepEqual(columns.find(({ name }) => name === 'future_opportunity_id'), {
    name: 'future_opportunity_id',
    hidden: 2,
  });

  await assertReadOnlyPlanningRefuses(
    fixture.sqlitePath,
    /unsupported SQLite schema.*unclassified relationship schema.*deal_hunter_cim_requests\.future_opportunity_id/i,
  );
});

test('read-only planning refuses a virtual generated optional-legacy opportunity relationship on an unlinked row', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  installProductionDerivedLegacySchema(fixture.sqlitePath);
  const evidence = withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      ALTER TABLE prospect_discoveries
      ADD COLUMN future_opportunity_id TEXT
      GENERATED ALWAYS AS (json_extract(source_data, '$.opportunityId')) VIRTUAL
    `);
    insertRetiredProspectDiscovery(database, {
      id: 'unlinked-generated-opportunity-prospect',
      submissionId: null,
      websiteUrl: 'https://example.test/unrelated-direct-origination-site',
      sourceData: { opportunityId: survivorId },
    });
    return {
      columns: sqliteTableColumnMetadata(database, 'prospect_discoveries'),
      row: database.prepare(`
        SELECT submission_id, future_opportunity_id
        FROM prospect_discoveries WHERE id = ?
      `).get('unlinked-generated-opportunity-prospect'),
    };
  });
  assert.deepEqual(evidence.columns.find(({ name }) => name === 'submission_id'), {
    name: 'submission_id',
    hidden: 0,
  });
  assert.deepEqual(evidence.columns.find(({ name }) => name === 'future_opportunity_id'), {
    name: 'future_opportunity_id',
    hidden: 2,
  });
  assert.deepEqual(evidence.row, {
    submission_id: null,
    future_opportunity_id: survivorId,
  });

  await assertReadOnlyPlanningRefuses(
    fixture.sqlitePath,
    /unsupported SQLite schema.*unclassified relationship schema.*prospect_discoveries\.future_opportunity_id/i,
  );
});

test('read-only planning refuses a stored generated relationship column', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const evidence = withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      CREATE TABLE admin_magic_links_legacy_v1 (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        source_data TEXT NOT NULL DEFAULT '{}',
        future_opportunity_id TEXT
          GENERATED ALWAYS AS (json_extract(source_data, '$.opportunityId')) STORED
      )
    `);
    database.prepare(`
      INSERT INTO admin_magic_links_legacy_v1 (
        id, email, created_at, expires_at, source_data
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      'stored-generated-relationship',
      'synthetic@example.test',
      fixtureNowIso,
      '2026-08-27T20:00:00.000Z',
      JSON.stringify({ opportunityId: survivorId }),
    );
    return {
      columns: sqliteTableColumnMetadata(database, 'admin_magic_links_legacy_v1'),
      value: database.prepare(`
        SELECT future_opportunity_id FROM admin_magic_links_legacy_v1 WHERE id = ?
      `).get('stored-generated-relationship').future_opportunity_id,
    };
  });
  assert.deepEqual(evidence.columns.find(({ name }) => name === 'email'), {
    name: 'email',
    hidden: 0,
  });
  assert.deepEqual(evidence.columns.find(({ name }) => name === 'future_opportunity_id'), {
    name: 'future_opportunity_id',
    hidden: 3,
  });
  assert.equal(evidence.value, survivorId);

  await assertReadOnlyPlanningRefuses(
    fixture.sqlitePath,
    /unsupported SQLite schema.*unclassified relationship schema.*admin_magic_links_legacy_v1\.future_opportunity_id/i,
  );
});

test('read-only planning applies relationship classification to hidden virtual-table columns', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const columns = withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec('CREATE VIRTUAL TABLE future_relationship_id USING fts5(body)');
    return sqliteTableColumnMetadata(database, 'future_relationship_id');
  });
  assert.deepEqual(columns.find(({ name }) => name === 'body'), {
    name: 'body',
    hidden: 0,
  });
  assert.deepEqual(columns.find(({ name }) => name === 'future_relationship_id'), {
    name: 'future_relationship_id',
    hidden: 1,
  });

  await assertReadOnlyPlanningRefuses(
    fixture.sqlitePath,
    /unsupported SQLite schema.*unclassified relationship schema.*future_relationship_id\.future_relationship_id/i,
  );
});

test('sanitized production-derived legacy schema is fully classified without embedding row data', async (t) => {
  const fixture = repairStorage(t);
  const before = withRawDatabase(fixture.sqlitePath, sqliteRelationshipSchema);
  assert.doesNotMatch(productionDerivedLegacySchema, /\b(?:INSERT|REPLACE|UPDATE|DELETE)\b/i);
  assert.doesNotMatch(
    productionDerivedLegacySchema,
    /https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\bopp_[A-Z0-9_-]+|\/data\//i,
  );

  installProductionDerivedLegacySchema(fixture.sqlitePath);
  const after = withRawDatabase(fixture.sqlitePath, sqliteRelationshipSchema);
  assert.deepEqual(
    after.tables.filter((table) => !before.tables.includes(table)),
    [
      'admin_magic_links_legacy_v1',
      'deal_hunter_candidates',
      'deal_hunter_runs',
      'prospect_discoveries',
      'prospect_discovery_runs',
    ],
  );
  assert.deepEqual(
    after.relationshipColumns.filter((column) => !before.relationshipColumns.includes(column)),
    Object.keys(productionOnlyRelationshipClassifications).sort(),
  );

  await seedApprovedRepair(fixture.storage);
  const readOnlyStorage = createSqliteCanonicalOpportunityMergeReadOnlyStorage({
    storage: { provider: 'sqlite', sqlitePath: fixture.sqlitePath },
  });
  let dryRun;
  try {
    dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: readOnlyStorage }));
  } finally {
    readOnlyStorage.close();
  }
  assert.equal(dryRun.plan.planSchema, 'canonical-opportunity-merge-plan-v2');
  assert.equal(dryRun.plan.dependentState.counts.legacyDealHunterCandidates, 0);
  assert.deepEqual(dryRun.plan.dependentState.records.legacyDealHunterCandidates, []);
});

test('optional legacy inventory tables require every classified column when the table exists', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      CREATE TABLE admin_magic_links_legacy_v1 (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )
    `);
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /unsupported SQLite schema.*missing required repair schema.*admin_magic_links_legacy_v1\.email/i,
  );
});

test('optional legacy inventory tables still fail closed on a future relationship-like column', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  installProductionDerivedLegacySchema(fixture.sqlitePath);
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec('ALTER TABLE prospect_discoveries ADD COLUMN future_opportunity_id TEXT');
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /unsupported SQLite schema.*unclassified relationship schema.*prospect_discoveries\.future_opportunity_id/i,
  );
});

test('legacy candidate scanner uses canonical listing identities and returns only bounded identifiers and a count', async (t) => {
  const fixture = repairStorage(t);
  installProductionDerivedLegacySchema(fixture.sqlitePath);
  const privateBroker = 'private-broker-sentinel@example.test';
  const privateSourceText = 'private source payload sentinel';
  withRawDatabase(fixture.sqlitePath, (database) => {
    for (let index = 0; index < 60; index += 1) {
      insertLegacyDealHunterCandidate(database, {
        id: `synthetic-matching-${String(index).padStart(2, '0')}`,
        sourceUrl: `https://WWW.BIZBUYSELL.COM/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/?utm_source=fixture-${index}#private-fragment`,
        broker: privateBroker,
        rawText: privateSourceText,
      });
    }
    insertLegacyDealHunterCandidate(database, {
      id: 'synthetic-near-match',
      sourceUrl: 'https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/25429910',
      broker: privateBroker,
      rawText: privateSourceText,
    });
  });

  const storageModule = await import('../server/storage/sqlite.js');
  assert.equal(
    typeof storageModule.inspectCanonicalMergeLegacyDealHunterCandidates,
    'function',
    'the production legacy-candidate scanner must be directly regression-testable',
  );
  const approval = getCanonicalOpportunityMergeApproval({ exceptionId, survivorId, supersededId });
  const summary = withRawDatabase(fixture.sqlitePath, (database) => (
    storageModule.inspectCanonicalMergeLegacyDealHunterCandidates(database, approval)
  ));
  assert.equal(summary.count, 60);
  assert.equal(summary.records.length, 50);
  assert.equal(summary.records.every((id) => /^deal_hunter_candidates:synthetic-matching-\d{2}$/.test(id)), true);
  assert.doesNotMatch(JSON.stringify(summary), /https?:|private-broker-sentinel|private source payload/i);
});

test('normalized legacy candidate source URL is an enforced blocking entity dependency', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  installProductionDerivedLegacySchema(fixture.sqlitePath);
  withRawDatabase(fixture.sqlitePath, (database) => {
    insertLegacyDealHunterCandidate(database, {
      id: 'normalized-approved-listing',
      sourceUrl: 'https://WWW.BIZBUYSELL.COM/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/?utm_medium=legacy#fragment',
      broker: 'must-not-appear@example.test',
      rawText: 'must not appear in repair diagnostics',
    });
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    (error) => {
      assert.match(error.message, /unexpected dependent state.*legacyDealHunterCandidates/i);
      assert.doesNotMatch(error.message, /bizbuysell|must-not-appear|repair diagnostics/i);
      return true;
    },
  );
});

test('unlinked retired prospect cannot become a blocker from website URL resemblance alone', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  installProductionDerivedLegacySchema(fixture.sqlitePath);
  withRawDatabase(fixture.sqlitePath, (database) => {
    insertRetiredProspectDiscovery(database, {
      id: 'unlinked-retired-prospect',
      submissionId: null,
      websiteUrl: 'https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/',
    });
  });

  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  assert.equal(dryRun.plan.dependentState.counts.linkedCrmState, 0);
  assert.deepEqual(dryRun.plan.dependentState.records.linkedCrmState, []);
});

test('linked retired prospect is selected by the submission parent scanner', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  installProductionDerivedLegacySchema(fixture.sqlitePath);
  insertUnexpectedDependent(fixture.sqlitePath, 'contactSubmissions', survivorId);
  withRawDatabase(fixture.sqlitePath, (database) => {
    insertRetiredProspectDiscovery(database, {
      id: 'linked-retired-prospect',
      submissionId: 'unexpected-contactSubmissions',
      websiteUrl: 'https://example.test/unrelated-direct-origination-site',
    });
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /unexpected dependent state:.*contactSubmissions.*linkedCrmState/i,
  );
  const retained = withRawDatabase(fixture.sqlitePath, (database) => (
    database.prepare('SELECT COUNT(*) AS count FROM prospect_discoveries WHERE id = ?')
      .get('linked-retired-prospect').count
  ));
  assert.equal(retained, 1);
});

test('standalone apply verifies backup evidence before writable storage startup', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const cliDatabasePath = repairStoragePaths.get(fixture.storage).backupPath;
  const directory = path.dirname(cliDatabasePath);
  const beforeDatabaseSha256 = createHash('sha256')
    .update(fs.readFileSync(cliDatabasePath))
    .digest('hex');
  const beforeFiles = fs.readdirSync(directory).sort();

  const result = spawnSync(process.execPath, [
    'scripts/repair-canonical-opportunity-merge.js',
    ...cliBaseArgs,
    '--apply',
    '--expected-plan-checksum', 'a'.repeat(64),
    '--backup', path.join(directory, 'does-not-exist'),
    '--confirm', CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      STORAGE_PROVIDER: 'sqlite',
      SQLITE_PATH: cliDatabasePath,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^\[canonical-opportunity-merge-repair\]/);
  assert.match(result.stderr, /Backup verification failed/i);
  const afterDatabaseSha256 = createHash('sha256')
    .update(fs.readFileSync(cliDatabasePath))
    .digest('hex');
  assert.equal(afterDatabaseSha256, beforeDatabaseSha256);
  assert.deepEqual(fs.readdirSync(directory).sort(), beforeFiles);
});

test('dry run returns the exact deterministic plan and writes nothing', async (t) => {
  const { storage } = repairStorage(t);
  await seedApprovedRepair(storage);
  const before = await repairState(storage);

  const first = await runCanonicalOpportunityMergeRepair(repairInput({ storage }));
  const second = await runCanonicalOpportunityMergeRepair(repairInput({ storage }));

  assert.equal(first.ok, true);
  assert.equal(first.mode, 'dry-run');
  assert.equal(first.applied, false);
  assert.equal(first.applyBlocked, false);
  assert.deepEqual(first.applyBlockers, []);
  assert.match(first.planChecksum, /^[a-f0-9]{64}$/);
  assert.equal(first.planChecksum, second.planChecksum);
  assert.equal(first.plan.planSchema, CANONICAL_OPPORTUNITY_MERGE_PLAN_SCHEMA);
  assert.equal(first.plan.planSchema, 'canonical-opportunity-merge-plan-v2');
  assert.match(first.manifestId, /^canonical-opportunity-merge:v1:[a-f0-9]{64}$/);
  assert.equal(first.plan.observedAliases.length, 12);
  assert.equal(first.plan.aliasMoves.length, 3);
  assert.equal(first.plan.resolutionSafety.structuralInvariantSatisfied, true);
  assert.deepEqual(first.plan.resolutionSafety.blockers, first.applyBlockers);
  assert.deepEqual(
    first.plan.observedAliases
      .map((item) => [item.alias_type, item.alias_value, item.opportunity_id])
      .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000'))),
    expectedAliases,
  );
  assert.deepEqual(first.plan.aliasMoves.map((item) => item.beforeOpportunityId), [
    supersededId,
    supersededId,
    supersededId,
  ]);
  assert.equal(Object.values(first.plan.dependentState.counts).every((count) => count === 0), true);
  assert.deepEqual(await repairState(storage), before);
});

test('relationship inventory classifies every reviewed omission exactly once in all four categories', () => {
  const entries = CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries;
  const keys = entries.map((entry) => `${entry.table}.${entry.column}`);
  assert.equal(entries.length, 231);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    [...new Set(entries.map((entry) => entry.category))].sort(),
    Object.values(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES).sort(),
  );
  assert.deepEqual(
    Object.fromEntries(Object.values(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES).map((category) => [
      category,
      entries.filter((entry) => entry.category === category).length,
    ])),
    {
      [CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY]: 91,
      [CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT]: 51,
      [CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE]: 54,
      [CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED]: 35,
    },
  );
  assert.deepEqual(
    Object.fromEntries([
      materialScannerPathEnforcement,
      independentGateEnforcement,
      approvalPreconditionEnforcement,
      explicitExclusionEnforcement,
    ].map((enforcement) => [
      enforcement,
      entries.filter((entry) => entry.enforcement === enforcement).length,
    ])),
    {
      [materialScannerPathEnforcement]: 186,
      [independentGateEnforcement]: 10,
      [approvalPreconditionEnforcement]: 11,
      [explicitExclusionEnforcement]: 24,
    },
  );
  const optionalLegacyEntries = entries.filter((entry) => (
    entry.schemaPresence === optionalLegacySchemaPresence
  ));
  assert.deepEqual(
    optionalLegacyEntries.map((entry) => `${entry.table}.${entry.column}`).sort(),
    Object.keys(productionOnlyRelationshipClassifications).sort(),
  );
  assert.deepEqual(
    [...new Set(optionalLegacyEntries.map((entry) => entry.table))].sort(),
    ['admin_magic_links_legacy_v1', 'deal_hunter_candidates', 'prospect_discoveries'],
  );
  assert.equal(entries.filter((entry) => entry.schemaPresence === 'required').length, 224);
  for (const entry of entries) {
    assert.ok(entry.reason, `${entry.table}.${entry.column} must document its classification`);
    assert.ok(entry.enforcement, `${entry.table}.${entry.column} must declare its enforcement class`);
    assert.ok(
      ['required', optionalLegacySchemaPresence].includes(entry.schemaPresence),
      `${entry.table}.${entry.column} must declare its schema presence contract`,
    );
    if (entry.enforcement === materialScannerPathEnforcement) {
      assert.ok(entry.scannerPath, `${entry.table}.${entry.column} must name its material scanner path`);
    } else if (entry.enforcement === independentGateEnforcement) {
      assert.equal(entry.scannerPath, null, `${entry.table}.${entry.column} must not claim a material scanner path`);
      assert.ok(entry.gateId, `${entry.table}.${entry.column} must name its independent gate`);
    } else if (entry.enforcement === approvalPreconditionEnforcement) {
      assert.match(entry.scannerPath, /^approvalCore\./, `${entry.table}.${entry.column} must name an approval precondition`);
    } else if (entry.enforcement === explicitExclusionEnforcement) {
      assert.match(entry.scannerPath, /^excluded\./, `${entry.table}.${entry.column} must name an explicit exclusion`);
    } else {
      assert.fail(`${entry.table}.${entry.column} has an unknown enforcement class`);
    }
  }
  for (const [key, expected] of Object.entries(productionOnlyRelationshipClassifications)) {
    const matches = entries.filter((entry) => `${entry.table}.${entry.column}` === key);
    assert.equal(matches.length, 1, `${key} must be classified exactly once`);
    assert.deepEqual(
      {
        category: matches[0].category,
        enforcement: matches[0].enforcement,
        scannerPath: matches[0].scannerPath,
      },
      expected,
    );
    assert.equal(matches[0].schemaPresence, optionalLegacySchemaPresence);
    assert.ok(matches[0].reason, `${key} must document its production-derived classification`);
  }
  for (const key of [
    'contact_submissions.archive_communication_id',
    'email_events.provider_event_id',
    'email_events.event_key',
    'crm_communications.source_event_id',
    'crm_communications.message_id',
    'crm_communications.in_reply_to',
    'crm_communications.references_json',
    'crm_communications.parent_communication_id',
    'crm_communications.recommendation_id',
    'crm_communications.outbox_id',
    'crm_email_outbox.provider_message_id',
    'crm_follow_up_recommendations.thread_parent_communication_id',
    'crm_follow_up_recommendations.evidence_json',
    'email_suppressions.normalized_email',
    'email_suppressions.source_event_id',
    'email_suppressions.source_communication_id',
    'deal_hunter_seen_deals.external_id',
    'deal_hunter_cim_requests.provider_message_id',
    'deal_hunter_cim_requests.retry_of_request_id',
    'deal_hunter_crm_reconciliation_runs.import_id',
    'deal_hunter_score_evidence.source_record_id',
    'deal_hunter_cim_reviews.source_ids',
    'deal_hunter_cim_stage2_activations.status',
    'deal_hunter_cim_stage2_runs.activation_id',
    'deal_hunter_cim_stage2_decisions.activation_id',
    'scheduled_job_runs.provider_message_id',
  ]) {
    assert.equal(keys.filter((candidate) => candidate === key).length, 1, `${key} must be classified once`);
  }
});

test('relationship inventory checksum is deterministic over the complete presence-aware inventory', () => {
  const first = canonicalOpportunityMergeRelationshipInventorySummary();
  const second = canonicalOpportunityMergeRelationshipInventorySummary();
  assert.deepEqual(first, second);
  assert.equal(first.entryCount, 231);
  assert.equal(first.checksum, '64e4e3376bca92e17a33f9f7ac5b1ccdd0f5954478d3eaf54f546723e52a404e');
  assert.equal(
    first.checksum,
    createHash('sha256')
      .update(stableCanonicalJson(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY))
      .digest('hex'),
  );
});

test('relationship inventory validates real material paths and explicit independent gates', async (t) => {
  const repairModule = await import('../server/repairs/canonicalOpportunityMerge.js');
  const validateInventory = repairModule.validateCanonicalOpportunityMergeRelationshipInventory;
  assert.equal(typeof validateInventory, 'function', 'the production inventory validator must be exported');

  const entries = CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries;
  const independentEntries = entries.filter(({ table }) => [
    'deal_hunter_automation_settings',
    'deal_hunter_cim_safety_settings',
  ].includes(table));
  assert.equal(independentEntries.length, 10);
  for (const entry of independentEntries) {
    assert.equal(entry.enforcement, independentGateEnforcement);
    assert.equal(entry.scannerPath, null);
    assert.equal(
      entry.gateId,
      entry.table === 'deal_hunter_automation_settings'
        ? automationInertGate
        : persistedOutreachPauseGate,
    );
  }

  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  assert.doesNotThrow(() => validateInventory({ entries, inspection: dryRun.plan }));

  const materialEntry = entries.find((entry) => (
    entry.table === 'contact_submissions' && entry.column === 'listing_url'
  ));
  assert.throws(
    () => validateInventory({
      entries: [{
        ...materialEntry,
        enforcement: materialScannerPathEnforcement,
        scannerPath: 'dependentState.records.nonexistentScanner',
      }],
      inspection: dryRun.plan,
    }),
    /material scanner path.*does not resolve/i,
  );
  assert.throws(
    () => validateInventory({
      entries: [{
        ...independentEntries[0],
        enforcement: '',
      }],
      inspection: dryRun.plan,
    }),
    /enforcement class/i,
  );
  assert.throws(
    () => validateInventory({
      entries: [{
        ...independentEntries[0],
        gateId: 'invented-independent-gate',
      }],
      inspection: dryRun.plan,
    }),
    /unknown independent gate/i,
  );
  assert.doesNotThrow(() => validateInventory({
    entries: [independentEntries[0]],
    inspection: dryRun.plan,
  }));
  const optionalCandidateEntries = entries.filter((entry) => entry.table === 'deal_hunter_candidates');
  assert.equal(optionalCandidateEntries.length, 2);
  assert.throws(
    () => validateInventory({
      entries: [
        optionalCandidateEntries[0],
        { ...optionalCandidateEntries[1], schemaPresence: 'required' },
      ],
      inspection: dryRun.plan,
    }),
    /conflicting schema presence.*deal_hunter_candidates/i,
  );
  assert.throws(
    () => validateInventory({
      entries: [{ ...materialEntry, schemaPresence: '' }],
      inspection: dryRun.plan,
    }),
    /schema presence is missing or invalid/i,
  );
});

test('recipient-global suppression is count-only preserved state and is never rewritten', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const suppression = {
    id: 'suppression-approved-recipient',
    normalized_email: 'broker@example.test',
    reason: 'hard-bounce',
    source: 'fixture',
    source_event_id: 'provider-event-fixture',
    source_communication_id: null,
    created_at: '2026-08-20T12:00:00.000Z',
    created_by: 'fixture',
    lifted_at: null,
    lifted_by: null,
    lift_reason: null,
    metadata: JSON.stringify({ fixture: true }),
  };
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO email_suppressions (
        id, normalized_email, reason, source, source_event_id, source_communication_id,
        created_at, created_by, lifted_at, lifted_by, lift_reason, metadata
      ) VALUES (
        @id, @normalized_email, @reason, @source, @source_event_id, @source_communication_id,
        @created_at, @created_by, @lifted_at, @lifted_by, @lift_reason, @metadata
      )
    `).run(suppression);
  });
  const before = withRawDatabase(fixture.sqlitePath, (database) => (
    database.prepare('SELECT * FROM email_suppressions WHERE id = ?').get(suppression.id)
  ));

  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));

  assert.deepEqual(dryRun.plan.preservedOperationalState.emailSuppressions, {
    recipientResolution: 'deterministic-approved-pair',
    matchedRecipientCount: 1,
    totalCount: 1,
    activeCount: 1,
    liftedCount: 0,
    authorityEffect: 'restrictive',
  });
  assert.doesNotMatch(
    JSON.stringify(dryRun.plan.preservedOperationalState),
    /broker@example\.test/i,
  );
  const after = withRawDatabase(fixture.sqlitePath, (database) => (
    database.prepare('SELECT * FROM email_suppressions WHERE id = ?').get(suppression.id)
  ));
  assert.deepEqual(after, before);

  insertUnexpectedDependent(fixture.sqlitePath, 'cimRequests', supersededId);
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /unexpected dependent state.*cimRequests/i,
  );
  assert.deepEqual(
    withRawDatabase(fixture.sqlitePath, (database) => (
      database.prepare('SELECT * FROM email_suppressions WHERE id = ?').get(suppression.id)
    )),
    before,
  );
});

test('current Stage 2 activation is separate granting authority and fails the repair closed', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_cim_stage2_activations (
        id, created_at, updated_at, status, mode, actor, reason, confirmation_phrase,
        policy_hash, rule_version, source_policy_version, source_policy_hash,
        evidence_checksum, evidence_generated_at, backup_reference, backup_checksum,
        identity_audit_reference, identity_audit_checksum, compliance_reference,
        sender_auth_reference, timezone, window_start, window_end, weekdays_only,
        canary_daily_cap, active_daily_cap, recipient_cap_24_hours,
        recipient_cap_30_days, expires_at, superseded_at, superseded_by, metadata
      ) VALUES (
        'stage2-current-fixture', @now, @now, 'current', 'canary', 'fixture',
        'Granting authority fixture', 'fixture-confirmation', 'policy', 'rules',
        'source-policy-v1', 'source-policy-hash', 'evidence', @now, '/backup',
        'backup-checksum', '/identity-audit', 'identity-checksum', '/compliance',
        '/sender-auth', 'America/Los_Angeles', '08:00', '17:00', 1, 1, 1, 1, 1,
        '2026-08-28T20:00:00.000Z', NULL, NULL, '{}'
      )
    `).run({ now: fixtureNowIso });
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /authority-granting operational state.*stage2Activations/i,
  );
  assert.equal(withRawDatabase(fixture.sqlitePath, (database) => (
    database.prepare("SELECT COUNT(*) AS count FROM deal_hunter_cim_stage2_activations WHERE status = 'current'").get().count
  )), 1);
});

test('a pre-v2 plan checksum is stale after relationship inventory enters the plan', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const legacyPlan = {
    ...dryRun.plan,
    planSchema: 'canonical-opportunity-merge-plan-v1',
  };
  delete legacyPlan.relationshipInventory;
  delete legacyPlan.preservedOperationalState;
  delete legacyPlan.authorityGrantingOperationalState;
  const legacyChecksum = canonicalOpportunityMergePlanChecksum(legacyPlan);
  assert.notEqual(legacyChecksum, dryRun.planChecksum);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, legacyChecksum)),
    /stale|plan checksum|reviewed plan/i,
  );
});

test('dry run refuses opportunity, exception, alias, business-evidence, and manifest drift', async (t) => {
  const cases = [
    {
      name: 'missing opportunity',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.prepare('DELETE FROM deal_hunter_opportunities WHERE opportunity_id = ?').run(supersededId);
      }),
      pattern: /opportunity.*missing/i,
    },
    {
      name: 'already superseded opportunity',
      mutate: async ({ storage }) => {
        await storage.upsertDealHunterOpportunity({ ...approvedOpportunity(supersededId), status: 'superseded' });
      },
      pattern: /not active/i,
    },
    {
      name: 'changed exception candidates',
      mutate: async ({ storage }) => {
        const [current] = await storage.listDealHunterIdentityExceptions({ limit: 10 });
        await storage.upsertDealHunterIdentityException({
          ...current,
          candidate_opportunity_ids: [survivorId, 'opp_third_party'],
        });
      },
      pattern: /candidate set drifted/i,
    },
    {
      name: 'open exception with resolution fields',
      mutate: async ({ storage }) => {
        const [current] = await storage.listDealHunterIdentityExceptions({ limit: 10 });
        await storage.upsertDealHunterIdentityException({
          ...current,
          resolved_by: 'unexpected-operator',
          resolution_reason: 'Unexpected partial resolution state.',
        });
      },
      pattern: /no longer pristine and open/i,
    },
    {
      name: 'missing approved alias',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.prepare('DELETE FROM deal_hunter_opportunity_aliases WHERE alias_key = ?').run(
          'listing-url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
        );
      }),
      pattern: /alias ownership set drifted/i,
    },
    {
      name: 'additional alias on survivor',
      mutate: async ({ storage }) => {
        await storage.upsertDealHunterOpportunityAlias({
          id: 'unexpected-extra-alias',
          opportunity_id: survivorId,
          alias_type: 'listing-id',
          alias_value: 'unexpected:third-listing',
          alias_key: 'listing-id:unexpected:third-listing',
          source: 'unexpected',
          first_observed_at: fixtureNowIso,
          last_observed_at: fixtureNowIso,
          evidence_version: 'cim-opportunity-v1',
          resolution_method: 'unexpected',
          confidence_state: 'exact',
          resolved_by: 'unexpected',
          metadata: {},
        });
      },
      pattern: /alias ownership set drifted/i,
    },
    {
      name: 'approved alias changed owner',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.prepare('UPDATE deal_hunter_opportunity_aliases SET opportunity_id = ? WHERE alias_key = ?').run(
          survivorId,
          'listing-url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
        );
      }),
      pattern: /alias ownership set drifted/i,
    },
    {
      name: 'approved alias gained a third-party owner',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.prepare(`
          INSERT INTO deal_hunter_opportunity_aliases (
            id, opportunity_id, alias_type, alias_value, alias_key, source,
            first_observed_at, last_observed_at, evidence_version, resolution_method,
            confidence_state, resolved_by, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'malformed-third-owner',
          'opp_third_party',
          'listing-url',
          'https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
          'malformed-third-party-alias-key',
          'unexpected',
          fixtureNowIso,
          fixtureNowIso,
          'cim-opportunity-v1',
          'unexpected',
          'exact',
          'unexpected',
          '{}',
        );
      }),
      pattern: /third-party ownership/i,
    },
    {
      name: 'approved business facts changed',
      mutate: async ({ storage }) => {
        const changed = approvedOpportunity(survivorId);
        changed.metadata.identitySnapshot.revenue = 4_400_000;
        await storage.upsertDealHunterOpportunity(changed);
      },
      pattern: /revenue drifted/i,
    },
    {
      name: 'reviewed pair description compatibility changed',
      mutate: async ({ storage }) => {
        const changed = approvedOpportunity(supersededId);
        changed.metadata.identitySnapshot.description = 'y'.repeat(498);
        await storage.upsertDealHunterOpportunity(changed);
      },
      pattern: /no longer compatible.*description|description.*no longer compatible/i,
    },
    {
      name: 'untyped manifest occupies deterministic key',
      mutate: async ({ storage }) => {
        const approval = getCanonicalOpportunityMergeApproval({ exceptionId, survivorId, supersededId });
        await storage.upsertDealHunterCimRepairManifest({
          id: canonicalOpportunityMergeManifestId(approval),
          created_at: fixtureNowIso,
          updated_at: fixtureNowIso,
          mode: 'apply',
          status: 'applied',
          actor: fixtureActor,
          backup_reference: '/synthetic/backup',
          checksum: 'wrong-type',
          manifest: {},
          metadata: {},
        });
      },
      pattern: /manifest collision/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (caseTest) => {
      const fixture = repairStorage(caseTest);
      await seedApprovedRepair(fixture.storage);
      await item.mutate(fixture);
      await assert.rejects(
        runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
        item.pattern,
      );
    });
  }
});

test('dry run requires zero unexpected dependent state on both canonical IDs', async (t) => {
  const cases = [
    ['opportunityScores', supersededId],
    ['scoreEvidence', survivorId],
    ['contactSubmissions', survivorId],
    ['crmImports', supersededId],
    ['aliasDerivedCrmImport', survivorId],
    ['crmReconciliationItems', survivorId],
    ['crmReconciliationRuns', supersededId],
    ['cimRequests', supersededId],
    ['cimReviews', survivorId],
    ['communications', supersededId],
    ['emailEvents', survivorId],
    ['metadataReference', supersededId],
    ['activityEvents', survivorId],
    ['opportunityClaims', supersededId],
    ['recipientClaims', survivorId],
    ['recipientOverrides', supersededId],
    ['stage2Decisions', survivorId],
    ['followUpState', supersededId],
    ['dispositions', survivorId],
    ['historicalIdentityEvidence', supersededId],
    ['sourceImportPayloads', survivorId],
    ['otherIdentityExceptions', supersededId],
    ['stage2Runs', survivorId],
    ['scheduledJobs', supersededId],
    ['linkedCrmState', survivorId],
    ['otherRepairManifests', supersededId],
  ];

  for (const [category, opportunityId] of cases) {
    await t.test(`${category} on ${opportunityId}`, async (caseTest) => {
      const fixture = repairStorage(caseTest);
      await seedApprovedRepair(fixture.storage);
      insertUnexpectedDependent(fixture.sqlitePath, category, opportunityId);
      await assert.rejects(
        runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
        /unexpected dependent state/i,
      );
      const after = withRawDatabase(fixture.sqlitePath, (database) => (
        database.prepare(`SELECT COUNT(*) AS count FROM ${dependentFixtureTables[category]}`).get().count
      ));
      assert.ok(after > 0, 'dry-run refusal must not delete or reparent dependent state');
    });
  }
});

test('apply refuses every missing or invalid operator safety gate', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));

  await t.test('missing actor', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, { actor: '' })),
      /accountable actor/i,
    );
  });
  await t.test('missing reason', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, { reason: '' })),
      /specific human reason/i,
    );
  });
  await t.test('wrong confirmation phrase', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, { confirmation: 'MERGE IT' })),
      /exact confirmation phrase/i,
    );
  });
  await t.test('missing backup verification', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, { backupVerification: null })),
      /verified SQLite backup/i,
    );
  });
  await t.test('failed backup verification', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, {
        backupVerification: verifiedBackupEvidence({ ok: false, errors: ['checksum mismatch'] }),
      })),
      /verified SQLite backup/i,
    );
  });
  await t.test('non-SQLite backup verification', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, {
        backupVerification: verifiedBackupEvidence({
          manifest: { ...verifiedBackupEvidence().manifest, provider: 'supabase' },
        }),
      })),
      /verified SQLite backup/i,
    );
  });
  await t.test('malformed backup digest', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum, {
        backupVerification: verifiedBackupEvidence({
          manifest: {
            ...verifiedBackupEvidence().manifest,
            database: { ...verifiedBackupEvidence().manifest.database, sha256: 'not-a-digest' },
          },
        }),
      })),
      /verified SQLite backup/i,
    );
  });
  await t.test('missing plan checksum', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, '', {})),
      /plan checksum/i,
    );
  });
  await t.test('outreach not paused', async () => {
    await assert.rejects(
      runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
      /outreach.*paused/i,
    );
  });
});

test('apply refuses a verified SQLite backup whose pre-merge plan differs from the reviewed checksum', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const backupPath = repairStoragePaths.get(fixture.storage).backupPath;
  withRawDatabase(backupPath, (database) => {
    const row = database.prepare(`
      SELECT metadata FROM deal_hunter_opportunity_aliases WHERE alias_key = ?
    `).get('listing-id:costar:2542991');
    database.prepare(`
      UPDATE deal_hunter_opportunity_aliases SET metadata = ? WHERE alias_key = ?
    `).run(
      JSON.stringify({ ...JSON.parse(row.metadata), backupDrift: true }),
      'listing-id:costar:2542991',
    );
  });
  const before = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /backup.*reviewed.*plan|backup.*plan checksum/i,
  );

  assert.deepEqual(await repairState(fixture.storage), before);
});

test('apply refuses a matching backup that predates the active outreach-pause epoch', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage, { refreshBackup: false });
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const before = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /backup.*pause|pause.*backup|pause epoch/i,
  );

  assert.deepEqual(await repairState(fixture.storage), before);
});

test('apply rehashes the verified backup immediately before plan reconstruction', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const input = applyInput(fixture.storage, dryRun.planChecksum);
  const backupPath = repairStoragePaths.get(fixture.storage).backupPath;
  withRawDatabase(backupPath, (database) => database.pragma('user_version = 42'));
  const before = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(input),
    /backup.*checksum|checksum.*backup/i,
  );

  assert.deepEqual(await repairState(fixture.storage), before);
});

test('apply backup verification never creates or mutates files inside the verified bundle', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const backupPath = repairStoragePaths.get(fixture.storage).backupPath;
  const backupDirectory = path.dirname(backupPath);
  const backupName = path.basename(backupPath);
  const backupArtifacts = () => Object.fromEntries(Object.entries(directoryFileSha256(backupDirectory))
    .filter(([name]) => name === backupName || name.startsWith(`${backupName}-`)));
  const beforeFiles = backupArtifacts();

  const result = await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));

  assert.equal(result.applied, true);
  assert.deepEqual(backupArtifacts(), beforeFiles);
});

test('the SQLite transaction independently rechecks the global outreach pause', async (t) => {
  const fixture = repairStorage(t);
  const approval = await seedApprovedRepair(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const before = await repairState(fixture.storage);

  await assert.rejects(
    fixture.storage.applyDealHunterCanonicalOpportunityMerge({
      approval,
      actor: fixtureActor,
      reason: fixtureReason,
      confirmation: CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
      expectedPlanChecksum: dryRun.planChecksum,
      backupEvidence: {
        provider: 'sqlite',
        path: '/synthetic/verified-backup',
        databaseSha256: 'b'.repeat(64),
        reviewedPlanChecksum: dryRun.planChecksum,
        pauseUpdatedAt: fixtureNowIso,
      },
      nowIso: fixtureNowIso,
    }),
    /outreach.*paused/i,
  );
  assert.deepEqual(await repairState(fixture.storage), before);
});

test('the reviewed plan records that ordinary current-opportunity paths exclude superseded rows', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const before = await repairState(fixture.storage);

  assert.equal(dryRun.applyBlocked, false);
  assert.deepEqual(dryRun.applyBlockers, []);
  assert.equal(dryRun.plan.resolutionSafety.structuralInvariantSatisfied, true);
  assert.deepEqual(dryRun.plan.resolutionSafety.blockers, []);
  assert.deepEqual(await repairState(fixture.storage), before);
});

test('apply atomically moves only approved aliases, supersedes the loser, resolves the exception, and writes a typed manifest', async (t) => {
  const fixture = repairStorage(t);
  const approval = await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const before = await repairState(fixture.storage);
  const beforeAliases = new Map(before.aliases.map((item) => [item.alias_key, item]));
  const beforePause = before.pause;

  const applied = await runCanonicalOpportunityMergeRepair(
    applyInput(fixture.storage, dryRun.planChecksum),
  );

  assert.equal(applied.ok, true);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.applied, true);
  assert.equal(applied.alreadyApplied, false);
  assert.equal(applied.planChecksum, dryRun.planChecksum);
  assert.equal(applied.movedAliasCount, 3);

  const after = await repairState(fixture.storage);
  assert.equal(after.opportunities.length, 2);
  const survivor = after.opportunities.find((item) => item.opportunity_id === survivorId);
  const superseded = after.opportunities.find((item) => item.opportunity_id === supersededId);
  assert.equal(survivor.status, 'active');
  assert.deepEqual(survivor.metadata, approvedOpportunity(survivorId).metadata);
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.metadata.retainedFixtureMetadata, `preserve-${supersededId}`);
  assert.deepEqual(superseded.metadata.identitySnapshot, approvedOpportunity(supersededId).metadata.identitySnapshot);
  assert.deepEqual(superseded.metadata.canonicalOpportunityMerge, {
    repairType: 'canonical-opportunity-merge',
    schemaVersion: 1,
    mergedInto: survivorId,
    supersededOpportunityId: supersededId,
    exceptionId,
    actor: fixtureActor,
    reason: fixtureReason,
    planChecksum: dryRun.planChecksum,
    supersededAt: fixtureNowIso,
  });

  assert.equal(after.aliases.length, 12);
  assert.equal(after.aliases.every((item) => item.opportunity_id === survivorId), true);
  for (const item of after.aliases) {
    const beforeAlias = beforeAliases.get(item.alias_key);
    assert.ok(beforeAlias);
    const expectedOwner = approval.expectedAliases.find((alias) => alias.aliasKey === item.alias_key).opportunityId;
    assert.deepEqual(
      { ...item, opportunity_id: expectedOwner },
      beforeAlias,
      `only ownership may change for ${item.alias_key}`,
    );
  }

  assert.equal(after.exceptions.length, 1);
  const [identityException] = after.exceptions;
  assert.equal(identityException.id, exceptionId);
  assert.equal(identityException.status, 'resolved');
  assert.equal(identityException.resolved_at, fixtureNowIso);
  assert.equal(identityException.resolved_by, fixtureActor);
  assert.equal(identityException.resolution_reason, fixtureReason);
  assert.deepEqual(identityException.candidate_opportunity_ids, [supersededId, survivorId]);
  assert.deepEqual(identityException.metadata.canonicalOpportunityMerge, {
    repairType: 'canonical-opportunity-merge',
    schemaVersion: 1,
    decision: 'merge',
    survivorId,
    supersededId,
    planChecksum: dryRun.planChecksum,
  });

  assert.equal(after.manifests.length, 1);
  const [manifest] = after.manifests;
  assert.equal(manifest.id, canonicalOpportunityMergeManifestId(approval));
  assert.equal(manifest.mode, 'canonical-opportunity-merge');
  assert.equal(manifest.status, 'applied');
  assert.equal(manifest.actor, fixtureActor);
  assert.equal(manifest.backup_reference, path.dirname(repairStoragePaths.get(fixture.storage).backupPath));
  assert.equal(manifest.checksum, dryRun.planChecksum);
  assert.equal(manifest.manifest.repairType, 'canonical-opportunity-merge');
  assert.equal(manifest.manifest.manifestSchema, 'canonical-opportunity-merge-manifest-v1');
  assert.equal(manifest.manifest.backupEvidence.reviewedPlanChecksum, dryRun.planChecksum);
  assert.deepEqual(manifest.manifest.approvalTuple, {
    exceptionId,
    survivorId,
    supersededId,
  });
  assert.deepEqual(manifest.manifest.aliasMoves, dryRun.plan.aliasMoves);
  const fixtureBackup = repairStoragePaths.get(fixture.storage).backupPath;
  assert.equal(
    manifest.manifest.backupEvidence.databaseSha256,
    createHash('sha256').update(fs.readFileSync(fixtureBackup)).digest('hex'),
  );
  assert.equal(manifest.manifest.backupEvidence.pauseUpdatedAt, beforePause.updated_at);
  assert.equal(manifest.metadata.repairType, 'canonical-opportunity-merge');
  assert.equal(manifest.metadata.manifestSchema, 'canonical-opportunity-merge-manifest-v1');
  assert.deepEqual(after.pause, beforePause, 'the repair must not alter or unpause outreach');
});

test('post-merge ordinary resolution sends every approved HVAC observation only to the survivor', async (t) => {
  const fixture = repairStorage(t);
  const approval = await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));
  const immediateAliases = await fixture.storage.listDealHunterOpportunityAliases({
    opportunityIds: [survivorId, supersededId],
    limit: 100,
  });
  assert.equal(immediateAliases.length, 12, 'the committed repair state starts with exactly the approved alias set');
  assert.equal(immediateAliases.every((item) => item.opportunity_id === survivorId), true);

  const observedDeals = approval.sourceObservations.map(resolverDealForObservation);
  observedDeals.push({
    id: '23',
    sourceId: 'sheet 0',
    sourceName: 'SMB Deal Hunter Google Sheet',
    dealKey: resolverDealForObservation(approval.sourceObservations[0]).dealKey,
    dealKeyAliases: approval.sourceObservations
      .map(resolverDealForObservation)
      .map((deal) => deal.dealKey),
    identityAliases: approval.sourceObservations.flatMap((item) => item.identityAliases),
  });

  for (const deal of observedDeals) {
    const result = await resolveDealHunterOpportunity({
      deal,
      storage: fixture.storage,
      actor: 'canonical-merge-regression',
      allowCreate: false,
    });
    assert.equal(result.ok, true, `source observation ${deal.id} must resolve`);
    assert.equal(result.status, 'resolved');
    assert.equal(result.resolution, 'exact-alias');
    assert.equal(result.opportunityId, survivorId);
    assert.notEqual(result.opportunityId, supersededId);
  }

  const aliases = await fixture.storage.listDealHunterOpportunityAliases({
    opportunityIds: [survivorId, supersededId],
    limit: 100,
  });
  assert.equal(aliases.every((item) => item.opportunity_id === survivorId), true);
  const aliasesByKey = new Map(aliases.map((item) => [item.alias_key, item]));
  for (const approvedAlias of approval.expectedAliases) {
    assert.equal(aliasesByKey.get(approvedAlias.aliasKey)?.opportunity_id, survivorId);
  }
  assert.equal(
    aliasesByKey.get('listing-url:https://dealstream.com/d/biz-sale/hvac/acarj0')?.opportunity_id,
    survivorId,
    'the unchanged resolver may add newly observed evidence, but only on the survivor',
  );
  assert.equal(aliases.length, 13);
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /approved alias ownership set|alias postcondition/i,
    'a later alias appearance must invalidate completed-repair replay even when it belongs to the survivor',
  );

  const semanticOnly = await resolveDealHunterOpportunity({
    deal: {
      id: 'semantic-only-regression',
      sourceId: 'sheet 0',
      sourceName: 'SMB Deal Hunter Google Sheet',
      dealKey: 'url:https://example.test/unapproved-hvac-observation',
      name: approvedOpportunity(survivorId).canonical_name,
      description: approvedOpportunity(survivorId).metadata.identitySnapshot.description,
      brokerEmail: approvedOpportunity(survivorId).canonical_recipient,
      location: approvedOpportunity(survivorId).canonical_location,
      askingPrice: 5_000_000,
      annualRevenue: 4_500_000,
      annualProfit: 500_000,
    },
    storage: fixture.storage,
    actor: 'canonical-merge-regression',
    allowCreate: false,
  });
  assert.equal(semanticOnly.ok, false);
  assert.equal(semanticOnly.status, 'ambiguous');
  assert.notEqual(semanticOnly.opportunityId, supersededId);
  assert.deepEqual(
    [...semanticOnly.identityException.candidate_opportunity_ids].sort(),
    [survivorId],
    'semantic fallback must fail closed without admitting the superseded row as a candidate',
  );
});

test('apply refuses a wrong or stale plan checksum without writing', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const before = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, '0'.repeat(64))),
    /plan checksum.*stale|stale.*plan checksum|backup.*plan checksum|backup.*reviewed.*plan/i,
  );

  assert.deepEqual(await repairState(fixture.storage), before);
});

test('an identical second apply is explicitly idempotent and byte-for-byte write-free', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));
  const afterFirstApply = await repairState(fixture.storage);

  const replay = await runCanonicalOpportunityMergeRepair(applyInput(
    fixture.storage,
    dryRun.planChecksum,
    { now: new Date('2026-08-26T21:00:00.000Z') },
  ));

  assert.equal(replay.ok, true);
  assert.equal(replay.mode, 'apply');
  assert.equal(replay.applied, false);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.planChecksum, dryRun.planChecksum);
  assert.equal(replay.movedAliasCount, 0);
  assert.deepEqual(await repairState(fixture.storage), afterFirstApply);

  const completedDryRun = await runCanonicalOpportunityMergeRepair(repairInput({
    storage: fixture.storage,
    now: new Date('2026-08-26T22:00:00.000Z'),
  }));
  assert.equal(completedDryRun.ok, true);
  assert.equal(completedDryRun.mode, 'dry-run');
  assert.equal(completedDryRun.applied, false);
  assert.equal(completedDryRun.alreadyApplied, true);
  assert.equal(completedDryRun.planChecksum, dryRun.planChecksum);
  assert.deepEqual(await repairState(fixture.storage), afterFirstApply);
});

test('idempotent replay rejects a different plan identity or stale checksum without writing', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const approvedPlan = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const alternateActor = 'different-incident-owner@example.test';
  const alternatePlan = await runCanonicalOpportunityMergeRepair(repairInput({
    storage: fixture.storage,
    actor: alternateActor,
  }));
  assert.notEqual(alternatePlan.planChecksum, approvedPlan.planChecksum);
  await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, approvedPlan.planChecksum));
  const completed = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(
      fixture.storage,
      alternatePlan.planChecksum,
      { actor: alternateActor },
    )),
    /manifest.*actor|actor.*manifest|plan identity/i,
  );
  assert.deepEqual(await repairState(fixture.storage), completed);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, '0'.repeat(64))),
    /manifest.*checksum|checksum.*manifest|stale|backup.*plan checksum|backup.*reviewed.*plan/i,
  );
  assert.deepEqual(await repairState(fixture.storage), completed);
});

test('idempotent replay validates final state and fails closed on post-apply drift', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));
  withRawDatabase(fixture.sqlitePath, (database) => {
    const row = database.prepare('SELECT metadata FROM deal_hunter_opportunities WHERE opportunity_id = ?').get(supersededId);
    const metadata = JSON.parse(row.metadata);
    metadata.canonicalOpportunityMerge.mergedInto = 'opp_unapproved_owner';
    database.prepare('UPDATE deal_hunter_opportunities SET metadata = ? WHERE opportunity_id = ?').run(
      JSON.stringify(metadata),
      supersededId,
    );
  });
  const drifted = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /supersession metadata.*validation|final state/i,
  );
  assert.deepEqual(await repairState(fixture.storage), drifted);
});

test('completed dry-run and apply replay reject an alias added to either canonical ID', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_opportunity_aliases (
        id, opportunity_id, alias_type, alias_value, alias_key, source,
        first_observed_at, last_observed_at, evidence_version,
        resolution_method, confidence_state, resolved_by, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'post-apply-unapproved-alias',
      survivorId,
      'listing-id',
      'post-apply:unapproved',
      'listing-id:post-apply:unapproved',
      'fixture',
      fixtureNowIso,
      fixtureNowIso,
      'cim-opportunity-v1',
      'fixture',
      'exact',
      'fixture',
      '{}',
    );
  });
  const drifted = await repairState(fixture.storage);

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
    /alias postcondition|alias ownership set|approved alias/i,
  );
  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /alias postcondition|alias ownership set|approved alias/i,
  );
  assert.deepEqual(await repairState(fixture.storage), drifted);
});

test('idempotent replay rejects tampered backup and audit timestamps', async (t) => {
  const cases = [
    {
      name: 'backup verification summary',
      mutate: (database, approval) => {
        const id = canonicalOpportunityMergeManifestId(approval);
        const row = database.prepare('SELECT manifest FROM deal_hunter_cim_repair_manifests WHERE id = ?').get(id);
        const manifest = JSON.parse(row.manifest);
        delete manifest.backupEvidence.verifiedAt;
        database.prepare('UPDATE deal_hunter_cim_repair_manifests SET manifest = ? WHERE id = ?').run(
          JSON.stringify(manifest),
          id,
        );
      },
      pattern: /backup or audit evidence/i,
    },
    {
      name: 'loser superseded timestamp',
      mutate: (database) => {
        const row = database.prepare('SELECT metadata FROM deal_hunter_opportunities WHERE opportunity_id = ?').get(supersededId);
        const metadata = JSON.parse(row.metadata);
        metadata.canonicalOpportunityMerge.supersededAt = '2026-08-26T23:00:00.000Z';
        database.prepare('UPDATE deal_hunter_opportunities SET metadata = ? WHERE opportunity_id = ?').run(
          JSON.stringify(metadata),
          supersededId,
        );
      },
      pattern: /supersession metadata.*validation/i,
    },
    {
      name: 'exception resolution timestamp',
      mutate: (database) => {
        database.prepare('UPDATE deal_hunter_identity_exceptions SET resolved_at = ? WHERE id = ?').run(
          '2026-08-26T23:00:00.000Z',
          exceptionId,
        );
      },
      pattern: /exception resolution.*validation/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (caseTest) => {
      const fixture = repairStorage(caseTest);
      const approval = await seedApprovedRepair(fixture.storage);
      await pauseOutreach(fixture.storage);
      const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
      await runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum));
      withRawDatabase(fixture.sqlitePath, (database) => item.mutate(database, approval));
      const drifted = await repairState(fixture.storage);

      await assert.rejects(
        runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
        item.pattern,
      );
      assert.deepEqual(await repairState(fixture.storage), drifted);
    });
  }
});

test('manifest namespace rejects wrong type, schema, tuple, and noncanonical duplicate keys', async (t) => {
  const cases = [
    ['wrong repair type', {
      mode: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifest: { repairType: 'historical-cim-repair', manifestSchema: 'canonical-opportunity-merge-manifest-v1' },
      metadata: { repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE },
    }],
    ['wrong schema', {
      mode: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifest: { repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE, manifestSchema: 'canonical-opportunity-merge-manifest-v2' },
      metadata: { repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE },
    }],
    ['wrong tuple', {
      mode: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifest: {
        repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
        manifestSchema: 'canonical-opportunity-merge-manifest-v1',
        approvalTuple: { exceptionId, survivorId, supersededId: 'opp_wrong' },
      },
      metadata: { repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE },
    }],
    ['duplicate typed row at noncanonical key', {
      id: 'canonical-opportunity-merge:v1:noncanonical-key',
      mode: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifest: {
        repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
        manifestSchema: 'canonical-opportunity-merge-manifest-v1',
        approvalTuple: { exceptionId, survivorId, supersededId },
      },
      metadata: { repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE },
    }],
  ];

  for (const [name, manifestOverrides] of cases) {
    await t.test(name, async (caseTest) => {
      const fixture = repairStorage(caseTest);
      const approval = await seedApprovedRepair(fixture.storage);
      await fixture.storage.upsertDealHunterCimRepairManifest({
        id: canonicalOpportunityMergeManifestId(approval),
        created_at: fixtureNowIso,
        updated_at: fixtureNowIso,
        mode: 'canonical-opportunity-merge',
        status: 'applied',
        actor: fixtureActor,
        backup_reference: '/synthetic/verified-backup',
        checksum: 'a'.repeat(64),
        manifest: {},
        metadata: {},
        ...manifestOverrides,
      });
      const before = await repairState(fixture.storage);

      await assert.rejects(
        runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage })),
        /manifest.*collision|canonical opportunity merge manifest already exists/i,
      );
      assert.deepEqual(await repairState(fixture.storage), before);
    });
  }
});

test('an unrelated typed canonical-merge manifest remains valid historical data', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await fixture.storage.upsertDealHunterCimRepairManifest({
    id: `canonical-opportunity-merge:v1:${'d'.repeat(64)}`,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    mode: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
    status: 'applied',
    actor: 'historical-operator@example.test',
    backup_reference: '/historical/backup',
    checksum: 'e'.repeat(64),
    manifest: {
      repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifestSchema: 'canonical-opportunity-merge-manifest-v1',
      approvalTuple: {
        exceptionId: 'historical-exception',
        survivorId: 'opp_historical_survivor',
        supersededId: 'opp_historical_loser',
      },
    },
    metadata: {
      repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifestSchema: 'canonical-opportunity-merge-manifest-v1',
      exceptionId: 'historical-exception',
      survivorId: 'opp_historical_survivor',
      supersededId: 'opp_historical_loser',
    },
  });

  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.plan.observedAliases.length, 12);
});

test('apply re-reads every dry-run invariant and refuses intervening drift', async (t) => {
  const cases = [
    {
      name: 'new score on survivor',
      mutate: ({ sqlitePath }) => insertUnexpectedDependent(sqlitePath, 'opportunityScores', survivorId),
      pattern: /unexpected dependent state/i,
    },
    {
      name: 'new CIM request on loser',
      mutate: ({ sqlitePath }) => insertUnexpectedDependent(sqlitePath, 'cimRequests', supersededId),
      pattern: /unexpected dependent state/i,
    },
    {
      name: 'new CRM import on survivor',
      mutate: ({ sqlitePath }) => insertUnexpectedDependent(sqlitePath, 'crmImports', survivorId),
      pattern: /unexpected dependent state/i,
    },
    {
      name: 'new communication on loser',
      mutate: ({ sqlitePath }) => insertUnexpectedDependent(sqlitePath, 'communications', supersededId),
      pattern: /unexpected dependent state/i,
    },
    {
      name: 'new active opportunity claim on survivor',
      mutate: ({ sqlitePath }) => insertUnexpectedDependent(sqlitePath, 'opportunityClaims', survivorId),
      pattern: /unexpected dependent state/i,
    },
    {
      name: 'alias row metadata changed',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.prepare('UPDATE deal_hunter_opportunity_aliases SET metadata = ? WHERE alias_key = ?').run(
          JSON.stringify({ fixture: false, drifted: true }),
          'listing-id:costar:2542991',
        );
      }),
      pattern: /plan checksum.*stale/i,
    },
    {
      name: 'additional survivor alias appeared',
      mutate: async ({ storage }) => {
        await storage.upsertDealHunterOpportunityAlias({
          id: 'post-plan-extra-alias',
          opportunity_id: survivorId,
          alias_type: 'listing-id',
          alias_value: 'post-plan:extra',
          alias_key: 'listing-id:post-plan:extra',
          source: 'fixture',
          first_observed_at: fixtureNowIso,
          last_observed_at: fixtureNowIso,
          evidence_version: 'cim-opportunity-v1',
          resolution_method: 'fixture',
          confidence_state: 'exact',
          resolved_by: 'fixture',
          metadata: {},
        });
      },
      pattern: /alias ownership set drifted/i,
    },
    {
      name: 'unclassified relationship schema appeared',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.exec('ALTER TABLE deal_hunter_cim_requests ADD COLUMN intervening_opportunity_id TEXT');
      }),
      pattern: /unsupported SQLite schema.*unclassified.*intervening_opportunity_id/i,
    },
    {
      name: 'generated relationship schema appeared',
      mutate: ({ sqlitePath }) => withRawDatabase(sqlitePath, (database) => {
        database.exec(`
          ALTER TABLE deal_hunter_cim_requests
          ADD COLUMN intervening_relationship_id TEXT
          GENERATED ALWAYS AS (opportunity_id) VIRTUAL
        `);
        assert.deepEqual(
          sqliteTableColumnMetadata(database, 'deal_hunter_cim_requests')
            .find(({ name }) => name === 'intervening_relationship_id'),
          { name: 'intervening_relationship_id', hidden: 2 },
        );
      }),
      pattern: /unsupported SQLite schema.*unclassified.*intervening_relationship_id/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (caseTest) => {
      const fixture = repairStorage(caseTest);
      await seedApprovedRepair(fixture.storage);
      await pauseOutreach(fixture.storage);
      const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
      await item.mutate(fixture);
      const drifted = await repairState(fixture.storage);

      await assert.rejects(
        runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
        item.pattern,
      );

      assert.deepEqual(await repairState(fixture.storage), drifted);
    });
  }
});

test('transaction failure after alias mutation rolls back aliases, opportunities, exception, and manifest', async (t) => {
  const fixture = repairStorage(t);
  await seedApprovedRepair(fixture.storage);
  await pauseOutreach(fixture.storage);
  const dryRun = await runCanonicalOpportunityMergeRepair(repairInput({ storage: fixture.storage }));
  const before = await repairState(fixture.storage);
  withRawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      CREATE TRIGGER abort_canonical_merge_exception_update
      BEFORE UPDATE OF status ON deal_hunter_identity_exceptions
      WHEN OLD.id = '${exceptionId}' AND NEW.status = 'resolved'
      BEGIN
        SELECT RAISE(ABORT, 'injected canonical merge transaction failure');
      END;
    `);
  });

  await assert.rejects(
    runCanonicalOpportunityMergeRepair(applyInput(fixture.storage, dryRun.planChecksum)),
    /injected canonical merge transaction failure/i,
  );

  assert.deepEqual(await repairState(fixture.storage), before);
});
