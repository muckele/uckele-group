import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readCimCurrentAuthority, runCimCampaignSafety } from '../server/services/cimCampaignSafety.js';
import { loadBrokerMaterialsAuthority } from '../server/services/dealHunterBrokerMaterials.js';
import { orchestratePursuitEnrollment, pursuitPermissionBasisDigest,
  pursuitPermissionCohortDigest } from '../server/services/pursueCimEnrollment.js';
import { runDueCimInitialPreparations } from '../server/services/pursueCimInitialPreparation.js';
import { resolveDealHunterOpportunity } from '../server/services/cimOpportunityIdentity.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  augustLaterUrlListing,
  augustMateriallyDistinctLookalike,
  augustNoUrlListing,
} from './fixtures/pursueCimIncidentFixtures.js';

function createIdentityStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-cim-identity-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(directory, 'identity.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function seedP4bEligibleFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p4b-service-'));
  const sqlitePath = path.join(directory, 'service.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  const db = new Database(sqlitePath);
  t.after(() => { db.close(); storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const opportunityId = 'opp-p4b-service';
  const now = '2026-09-29T16:00:00.000Z';
  db.prepare(`INSERT INTO deal_hunter_opportunities
    (opportunity_id, created_at, updated_at, canonical_name, identity_version, canonical_location)
    VALUES (?, ?, ?, 'P4B Service Co', 'identity-v1', 'San Francisco, CA')`)
    .run(opportunityId, now, now);
  db.prepare(`INSERT INTO deal_hunter_opportunity_scores
    (opportunity_id, created_at, scored_at, deal_key, name, listing_url,
     score_fingerprint, engine_version, rules_version, profile_version,
     completeness_policy_version, current_triage_eligible)
    VALUES (?, ?, ?, 'deal:p4b-service', 'P4B Service Co',
      'https://broker.example/p4b-service', 'score-p4b', 'test', 'test', 'test', 'test', 1)`)
    .run(opportunityId, now, now);
  for (const [field, value] of [
    ['name', 'P4B Service Co'], ['broker_email', 'broker-p4b@example.test'],
    ['listing_url', 'https://broker.example/p4b-service'],
  ]) await storage.upsertDealHunterOpportunitySourceObservation({
    id: `p4b-${field}`, opportunity_id: opportunityId, source_id: 'sheet-0',
    source_name: 'Synthetic Sheet', source_record_id: 'row-p4b', field, value,
    observed_at: now, created_at: now, updated_at: now,
  });
  db.prepare(`INSERT INTO contact_submissions
    (id, created_at, updated_at, status, delivery_provider, delivery_status,
     crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
    VALUES ('submission-p4b', ?, ?, 'open', 'none', 'not-attempted',
      'active', 'synthetic', 'synthetic', 'P4B Service', 'owner@example.test',
      'Synthetic owner', ?)`)
    .run(now, now, opportunityId);
  db.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = 'submission-p4b'
    WHERE opportunity_id = ?`).run(opportunityId);
  const decision = await storage.recordOwnerDecision({ opportunityId, action: 'pursue',
    idempotencyKey: 'p4b-service-owner', actor: 'fixture-owner',
    policyVersion: 'owner-decision-v1', now,
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 });
  await storage.appendOpportunityTimezoneRevision({ opportunityId,
    expectedPriorRevision: 0, idempotencyKey: 'p4b-timezone', state: 'verified',
    ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
    evidenceId: 'p4b-timezone-evidence', evidenceDigest: 'a'.repeat(64),
    resolverVersion: 'explicit-v1', datasetDigest: 'b'.repeat(64),
    actor: 'fixture-owner', now });
  const authority = await loadBrokerMaterialsAuthority({ storage, opportunityId, now });
  assert.equal(authority.recipientOptions.length, 1);
  const recipient = authority.recipientOptions[0];
  const activation = { mode: 'active', policyHash: 'c'.repeat(64),
    configHash: 'd'.repeat(64), actor: 'fixture-owner', reason: 'synthetic only',
    confirmation: 'synthetic-confirmation', providerProfile: 'synthetic', now };
  await storage.recordCimCapabilityActivation({ ...activation,
    id: 'p4b-safety', capability: 'fl04a-safety' });
  await storage.recordCimCapabilityActivation({ ...activation,
    id: 'p4b-enrollment', capability: 'fl04b-enrollment',
    prerequisiteActivationId: 'p4b-safety', prerequisiteEvidenceId: 'p4b-evidence',
    prerequisiteEvidenceHash: 'e'.repeat(64),
    permissionBasisDigest: pursuitPermissionBasisDigest(authority, recipient),
    cohortDigest: pursuitPermissionCohortDigest(authority, recipient), permissionRevision: 1 });
  return { storage, db, opportunityId, now, decision, authority, recipient };
}

test('P4B current eligible Pursue allocates one scheduled initial touch without provider effects', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'campaign-created', result.enrollment.reason_code);
  assert.equal(result.campaign.generation, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaign_touches').get().count, 1);
  assert.equal(db.prepare(`SELECT state FROM deal_hunter_cim_campaign_touches`).get().state, 'scheduled');
  for (const table of ['deal_hunter_cim_transmissions', 'deal_hunter_cim_live_provider_authorizations',
    'crm_communications']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
});

test('P5 real Broker Materials authority prepares the Package 4B initial touch', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  const allocated = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(allocated.campaign.state, 'initial-pending');
  const activated = await storage.recordCimCapabilityActivation({
    id: 'p4b-initial', capability: 'fl04b-initial', mode: 'active',
    policyHash: 'c'.repeat(64), configHash: 'd'.repeat(64),
    actor: 'fixture-owner', reason: 'synthetic only',
    confirmation: 'synthetic-confirmation', providerProfile: 'synthetic', now,
    prerequisiteActivationId: 'p4b-enrollment',
    prerequisiteEvidenceId: 'p5-initial-evidence',
    prerequisiteEvidenceHash: 'e'.repeat(64),
  });
  assert.equal(activated.applied, true);
  const outcomes = await runDueCimInitialPreparations({ storage, now });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].prepared, true, JSON.stringify(outcomes[0]));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_communications').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_email_outbox').get().n, 1);
  assert.equal(db.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state, 'prepared');
});

test('P5 refuses preparation when the campaign leaves initial-pending after claim', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  const allocated = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(allocated.campaign.state, 'initial-pending');
  await storage.recordCimCapabilityActivation({
    id: 'p5-state-initial', capability: 'fl04b-initial', mode: 'active',
    policyHash: 'c'.repeat(64), configHash: 'd'.repeat(64),
    actor: 'fixture-owner', reason: 'synthetic only',
    confirmation: 'synthetic-confirmation', providerProfile: 'synthetic', now,
    prerequisiteActivationId: 'p4b-enrollment',
    prerequisiteEvidenceId: 'p5-initial-evidence',
    prerequisiteEvidenceHash: 'e'.repeat(64),
  });
  const racedStorage = new Proxy(storage, {
    get(target, key) {
      if (key === 'claimDueCimTouch') return async (command) => {
        const claim = await target.claimDueCimTouch(command);
        if (claim.claimed) db.prepare(`UPDATE deal_hunter_cim_campaigns
          SET state = 'active-follow-up' WHERE id = ?`).run(allocated.campaign.id);
        return claim;
      };
      return target[key];
    },
  });
  const outcomes = await runDueCimInitialPreparations({ storage: racedStorage, now });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].prepared, false, JSON.stringify(outcomes[0]));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
});

test('P5 refuses a claim whose lease expires during payload construction', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  await storage.recordCimCapabilityActivation({
    id: 'p5-lease-initial', capability: 'fl04b-initial', mode: 'active',
    policyHash: 'c'.repeat(64), configHash: 'd'.repeat(64),
    actor: 'fixture-owner', reason: 'synthetic only',
    confirmation: 'synthetic-confirmation', providerProfile: 'synthetic', now,
    prerequisiteActivationId: 'p4b-enrollment',
    prerequisiteEvidenceId: 'p5-initial-evidence',
    prerequisiteEvidenceHash: 'e'.repeat(64),
  });
  let currentInstant = now;
  const outcomes = await runDueCimInitialPreparations({ storage, now,
    clock: () => new Date(currentInstant),
    loadAuthority: async (args) => {
      const authority = await loadBrokerMaterialsAuthority(args);
      currentInstant = new Date(Date.parse(now) + 6 * 60 * 1000).toISOString();
      return authority;
    },
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].prepared, false, JSON.stringify(outcomes[0]));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
});

test('P4B downstream allocation failure preserves immutable Pursue and requires action', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  const failingStorage = new Proxy(storage, { get(target, property) {
    if (property === 'materializePursuitCampaign') return async () => { throw new Error('injected allocation failure'); };
    return Reflect.get(target, property);
  } });
  const result = await orchestratePursuitEnrollment({ storage: failingStorage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'action-required');
  assert.equal(result.enrollment.reason_code, 'allocation_failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_owner_decision_events').get().count, 1);
  for (const table of ['deal_hunter_broker_conversations', 'deal_hunter_cim_campaigns',
    'deal_hunter_cim_campaign_touches']) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
});

test('P4B ambiguous broker contacts expose opaque choices and create no campaign', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  await storage.upsertDealHunterOpportunitySourceObservation({
    id: 'p4b-other-broker', opportunity_id: opportunityId, source_id: 'sheet-0',
    source_name: 'Synthetic Sheet', source_record_id: 'row-other', field: 'broker_email',
    value: 'other@example.test', observed_at: now, created_at: now, updated_at: now,
  });
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.reason_code, 'recipient_ambiguous');
  assert.equal(result.recipientOptions.length, 2);
  assert.ok(result.recipientOptions.every((choice) => choice.recipientContactRef
    && choice.email), 'the admin must be able to distinguish contact choices by address');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P4B refuses truncated source recipient authority before automatic allocation', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  const newer = new Date(Date.parse(now) + 1000).toISOString();
  const older = new Date(Date.parse(now) - 1000).toISOString();
  const insert = db.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
    (id, opportunity_id, source_id, source_name, source_record_id, field, value,
     observed_at, created_at, updated_at)
    VALUES (?, ?, 'sheet-0', 'Synthetic Sheet', ?, 'name', 'Filler', ?, ?, ?)`);
  const batch = db.transaction(() => {
    for (let index = 0; index < 499; index += 1) {
      insert.run(`p4b-limit-${index}`, opportunityId, `limit-${index}`, newer, newer, newer);
    }
    db.prepare(`INSERT INTO deal_hunter_opportunity_source_observations
      (id, opportunity_id, source_id, source_name, source_record_id, field, value,
       observed_at, created_at, updated_at)
      VALUES ('p4b-hidden-broker', ?, 'sheet-0', 'Synthetic Sheet', 'hidden',
        'broker_email', 'hidden@example.test', ?, ?, ?)`).run(opportunityId, older, older, older);
  });
  batch();
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'waiting-on-eligibility');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns`).get().count, 0);
});

test('P4B refuses truncated operator-fact recipient authority before allocation', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  const newer = new Date(Date.parse(now) + 1000).toISOString();
  const older = new Date(Date.parse(now) - 1000).toISOString();
  const insert = db.prepare(`INSERT INTO deal_hunter_opportunity_facts
    (id, opportunity_id, field, value, source, verified, actor, created_at, updated_at)
    VALUES (?, ?, 'seller_name', 'Filler', 'operator', 1, 'fixture-owner', ?, ?)`);
  db.transaction(() => {
    for (let index = 0; index < 100; index += 1) {
      insert.run(`p4b-fact-limit-${index}`, opportunityId, newer, newer);
    }
    db.prepare(`INSERT INTO deal_hunter_opportunity_facts
      (id, opportunity_id, field, value, source, verified, actor, created_at, updated_at)
      VALUES ('p4b-hidden-fact-broker', ?, 'broker_email', 'hidden@example.test',
        'operator', 1, 'fixture-owner', ?, ?)`).run(opportunityId, older, older);
  })();
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'waiting-on-eligibility');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns`).get().count, 0);
});

test('P4B expired opaque broker contact reference cannot allocate', async (t) => {
  const { storage, db, opportunityId, now, decision, recipient } = await seedP4bEligibleFixture(t);
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision,
    recipientContactRef: recipient.recipientContactRef, actor: 'fixture-owner',
    now: new Date(Date.parse(now) + 16 * 60 * 1000),
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.reason_code, 'recipient_changed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P4B canonical CRM ambiguity prevents campaign creation', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  db.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = NULL
    WHERE opportunity_id = ?`).run(opportunityId);
  db.prepare(`UPDATE contact_submissions SET deal_hunter_opportunity_id = NULL,
    listing_url = 'https://broker.example/p4b-service' WHERE id = 'submission-p4b'`).run();
  db.prepare(`INSERT INTO contact_submissions
    (id, created_at, updated_at, status, delivery_provider, delivery_status,
     crm_status, source, ip_hash, name, email, message, listing_url)
    VALUES ('submission-p4b-other', ?, ?, 'open', 'none', 'not-attempted',
      'active', 'synthetic', 'synthetic', 'Other owner', 'other-owner@example.test',
      'Conflicting canonical owner', 'https://broker.example/p4b-service')`)
    .run(now, now);
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'action-required');
  assert.equal(result.enrollment.reason_code, 'crm_ambiguous');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P4B no CRM owner uses the durable import claim and links one exact owner', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  db.prepare(`UPDATE deal_hunter_opportunities SET primary_submission_id = NULL
    WHERE opportunity_id = ?`).run(opportunityId);
  db.prepare(`DELETE FROM contact_submissions WHERE id = 'submission-p4b'`).run();
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'campaign-created', result.enrollment.reason_code);
  const current = db.prepare(`SELECT primary_submission_id AS submissionId FROM deal_hunter_opportunities
    WHERE opportunity_id = ?`).get(opportunityId);
  assert.ok(current.submissionId);
  assert.equal(result.campaign.crm_submission_id, current.submissionId);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_crm_imports
    WHERE opportunity_id = ?`).get(opportunityId).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM contact_submissions
    WHERE deal_hunter_opportunity_id = ?`).get(opportunityId).count, 1);
});

test('P4B prior provider acceptance blocks ordinary generation without removing Pursue', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  db.prepare(`INSERT INTO deal_hunter_cim_requests
    (id, created_at, updated_at, deal_key, recipient_email, status,
     request_state, delivery_state, first_provider_accepted_at, metadata,
     opportunity_id)
    VALUES ('prior-accepted', ?, ?, 'deal:p4b-service', 'broker-p4b@example.test',
      'sent', 'provider_accepted', 'accepted', ?, '{}', ?)`)
    .run(now, now, now, opportunityId);
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'action-required');
  assert.equal(result.enrollment.reason_code, 'prior_provider_accepted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_owner_decision_events').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P4B absent current permission stays waiting and creates no campaign', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  await storage.withdrawCimCapabilityActivation({ id: 'p4b-enrollment',
    actor: 'fixture-owner', reason: 'synthetic withdrawal', now });
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'waiting-on-eligibility');
  assert.equal(result.enrollment.reason_code, 'contact_permission_missing');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P4B changed timezone blocks allocation', async (t) => {
  const fixture = await seedP4bEligibleFixture(t);
  const { storage, db, opportunityId, now, decision } = fixture;
  await storage.appendOpportunityTimezoneRevision({ opportunityId,
    expectedPriorRevision: 1, idempotencyKey: 'p4b-timezone-missing', state: 'missing',
    evidenceType: 'operator-verified', evidenceId: 'p4b-timezone-missing-evidence',
    evidenceDigest: 'a'.repeat(64), resolverVersion: 'explicit-v1',
    datasetDigest: 'b'.repeat(64), actor: 'fixture-owner', now });
  const timezoneResult = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(timezoneResult.enrollment.reason_code, 'timezone_missing');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P4B materials already received block ordinary allocation', async (t) => {
  const { storage, db, opportunityId, now, decision } = await seedP4bEligibleFixture(t);
  db.prepare(`UPDATE contact_submissions SET prospectus_url = 'https://broker.example/prospectus'
    WHERE id = 'submission-p4b'`).run();
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(result.enrollment.state, 'action-required');
  assert.equal(result.enrollment.reason_code, 'materials_received');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count, 0);
});

test('P2 safety shadow accounts for a run without consuming or mutating it', async () => {
  let consumptions = 0;
  const storage = {
    async listCimSafetyEvents() { return [{ id: 'event-1', status: 'pending',
      opportunity_id: 'op-shadow', event_type: 'source-record-changed' }]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending' } }; },
    async listDealHunterSourceFreshnessStates() { return []; },
    async consumeCimSafetyEvents() { consumptions += 1; throw new Error('shadow mutated safety'); },
  };
  const result = await runCimCampaignSafety({ storage, safetyRunId: 'safety-shadow',
    mode: 'shadow', now: '2026-09-28T12:00:00.000Z' });
  assert.equal(consumptions, 0);
  assert.deepEqual(result, { safetyRunId: 'safety-shadow', safetyEventsEmitted: 1,
    stopped: 0, reviewRequired: 0, noOp: 0, pending: 1,
    sourceProjectionPending: false, complete: false,
    proposed: { stopped: 0, reviewRequired: 1, noOp: 0 } });
});

test('P2 current authority exposes deferred source and open identity exception before safety consumption', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active', material_revision: 2 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'sheet-0',
      source_record_id: 'external:LAG', field: 'name', value: 'Lag Fixture' }]; },
    async listDealHunterIdentityExceptions() { return [{ id: 'exception-lag', status: 'open',
      candidate_opportunity_ids: ['op-lag'] }]; },
    async listDealHunterSourceFreshnessStates() { return [{ source_id: 'sheet-0',
      accepted_run_id: 'run-lag', projection_state: 'deferred' }]; },
    async readPursueCimProjection() { return { campaign: null }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.opportunity.material_revision, 2);
  assert.deepEqual(authority.blockers, ['identity-exception-open', 'source-projection-deferred']);
  assert.equal(authority.blocked, true);
});

test('P2 pending safety consumption cannot hide a changed campaign material revision', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active',
      material_revision: 2, discovery_revision: 1 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'sheet-0',
      source_record_id: 'external:LAG', field: 'asking_price', value: '120' }]; },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterSourceFreshnessStates() { return [{ source_id: 'sheet-0',
      accepted_run_id: 'changed-run', projection_state: 'accepted' }]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending',
      material_revision: 1, discovery_revision: 1 } }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.blocked, true);
  assert.deepEqual(authority.blockers, ['campaign-material-authority-changed',
    'campaign-source-authority-unproven']);
});

test('P2 consumer lag blocks a newly accepted source run when campaign revisions stay unchanged', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active',
      material_revision: 1, discovery_revision: 1 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'sheet-0',
      source_record_id: 'external:LAG', field: 'name', value: 'Changed broker name',
      accepted_at: '2026-09-28T12:01:00.000Z' }]; },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterSourceFreshnessStates() { return [{ source_id: 'sheet-0',
      accepted_run_id: 'run-after-campaign', accepted_at: '2026-09-28T12:01:00.000Z',
      projection_state: 'accepted' }]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending',
      created_at: '2026-09-28T12:00:00.000Z', material_revision: 1, discovery_revision: 1 } }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.blocked, true);
  assert.ok(authority.blockers.includes('campaign-source-authority-changed'));
});

test('P2 current authority sees a required Sheet removal even when only Deal OS rows remain', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active',
      material_revision: 1, discovery_revision: 1 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'deal-os-export',
      source_record_id: 'external:OLD', field: 'name', value: 'Prior name',
      accepted_at: '2026-09-28T11:59:00.000Z' }]; },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterSourceFreshnessStates() { return [
      { source_id: 'sheet-0', accepted_run_id: 'sheet-removal',
        accepted_at: '2026-09-28T12:01:00.000Z', projection_state: 'accepted' },
      { source_id: 'deal-os-export', accepted_run_id: 'old-os',
        accepted_at: '2026-09-28T11:59:00.000Z', projection_state: 'accepted' },
    ]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending',
      created_at: '2026-09-28T12:00:00.000Z', material_revision: 1, discovery_revision: 1 } }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.blocked, true);
  assert.ok(authority.blockers.includes('campaign-source-authority-changed'));
});

test('P0 scenarios 2 and 12: August no-URL listing retains its fingerprint when the URL arrives', async (t) => {
  const storage = createIdentityStorage(t);
  const original = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing,
    storage,
    actor: 'pursue-cim-regression',
  });
  const repeat = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing, storage, actor: 'pursue-cim-regression',
  });
  const later = await resolveDealHunterOpportunity({
    deal: augustLaterUrlListing,
    storage,
    actor: 'pursue-cim-regression',
  });
  const aliases = await storage.listDealHunterOpportunityAliases({
    opportunityIds: [original.opportunityId],
    limit: 100,
  });

  assert.equal(original.ok, true);
  assert.equal(repeat.opportunityId, original.opportunityId);
  assert.equal(later.ok, true);
  assert.equal(later.opportunityId, original.opportunityId);
  assert.ok(aliases.some(({ alias_type }) => alias_type === 'fingerprint-v1'));
  assert.ok(aliases.some(({ alias_type }) => alias_type === 'listing-url'));
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 1);
  assert.equal((await storage.readCimOutreachCounters()).campaigns, 0);
});

test('P0 scenario 5: exact syndicated listing identity resolves through its canonical aliases', async (t) => {
  const storage = createIdentityStorage(t);
  const sheet = await resolveDealHunterOpportunity({ deal: augustLaterUrlListing,
    storage, actor: 'pursue-cim-regression' });
  const syndicated = await resolveDealHunterOpportunity({ deal: {
    ...augustLaterUrlListing, sourceId: 'deal-os-export', id: 'syndicated-august',
    dealKey: 'deal-os:syndicated-august', sourceRecords: [{ sourceId: 'deal-os-export' }],
  }, storage, actor: 'pursue-cim-regression' });
  assert.equal(sheet.ok, true);
  assert.equal(syndicated.ok, true);
  assert.equal(syndicated.opportunityId, sheet.opportunityId);
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 1);
  assert.equal((await storage.readCimOutreachCounters()).campaigns, 0);
});

test('P0 scenario 3: independent SQLite connections converge simultaneous Sheet and Deal OS identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p2-concurrent-identity-'));
  const sqlitePath = path.join(directory, 'identity.sqlite');
  const sheetStorage = createSqliteStorage({ storage: { sqlitePath } });
  const dealOsStorage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { sheetStorage.close(); dealOsStorage.close();
    fs.rmSync(directory, { recursive: true, force: true }); });
  const [sheet, dealOs] = await Promise.all([
    resolveDealHunterOpportunity({ deal: augustLaterUrlListing,
      storage: sheetStorage, actor: 'pursue-cim-regression' }),
    resolveDealHunterOpportunity({ deal: { ...augustLaterUrlListing,
      sourceId: 'deal-os-export', id: 'concurrent-august',
      dealKey: 'deal-os:concurrent-august', sourceRecords: [{ sourceId: 'deal-os-export' }] },
    storage: dealOsStorage, actor: 'pursue-cim-regression' }),
  ]);
  const opportunities = await sheetStorage.listCurrentDealHunterOpportunities({ limit: 100 });
  const exceptions = await sheetStorage.listDealHunterIdentityExceptions({ statuses: ['open'] });
  assert.ok((sheet.ok && dealOs.ok && sheet.opportunityId === dealOs.opportunityId)
    || exceptions.length === 1);
  assert.ok(opportunities.length <= 2);
  assert.equal((await sheetStorage.readCimOutreachCounters()).campaigns, 0);
});
test('P0 scenario 4: materially distinct August lookalike remains a separate canonical opportunity', async (t) => {
  const storage = createIdentityStorage(t);
  const original = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing,
    storage,
    actor: 'pursue-cim-regression',
  });
  const lookalike = await resolveDealHunterOpportunity({
    deal: augustMateriallyDistinctLookalike,
    storage,
    actor: 'pursue-cim-regression',
  });

  assert.equal(original.ok, true);
  assert.equal(lookalike.ok, true);
  assert.notEqual(lookalike.opportunityId, original.opportunityId);
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 2);
});
