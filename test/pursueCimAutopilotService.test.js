import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { getConfig } from '../server/config.js';
import { readCimCurrentAuthority, runCimCampaignSafety } from '../server/services/cimCampaignSafety.js';
import { loadBrokerMaterialsAuthority } from '../server/services/dealHunterBrokerMaterials.js';
import { orchestratePursuitEnrollment, pursuitPermissionBasisDigest,
  pursuitPermissionCohortDigest } from '../server/services/pursueCimEnrollment.js';
import { runDueCimInitialPreparations } from '../server/services/pursueCimInitialPreparation.js';
import {
  getPursueCimReleaseReport,
  stopPursueCimCampaign,
} from '../server/services/pursueCimRelease.js';
import {
  buildPursueCimReleaseEvidence,
  containPursueCimFindings,
  getPursueCimOperations,
  runPursueCimAutomaticContainment,
  runPursueCimShadow,
} from '../server/services/pursueCimOperations.js';
import { resolveDealHunterOpportunity } from '../server/services/cimOpportunityIdentity.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sha256 } from '../server/utils/security.js';
import { createPursueCimReleaseEvidenceReport } from '../scripts/audit-pursue-cim-autopilot.js';
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
  const campaign = db.prepare('SELECT * FROM deal_hunter_cim_campaigns').get();
  const touch = db.prepare('SELECT * FROM deal_hunter_cim_campaign_touches').get();
  const transmission = db.prepare('SELECT * FROM deal_hunter_cim_transmissions').get();
  const communication = db.prepare('SELECT * FROM crm_communications').get();
  const conversation = db.prepare('SELECT * FROM deal_hunter_broker_conversations').get();
  const metadata = JSON.parse(communication.metadata);
  const tags = new Set(metadata.tags);
  assert.ok(communication.reply_to_address.includes(campaign.conversation_id.slice(0, 32)),
    'the exact reply alias is conversation-bound');
  assert.equal(conversation.reply_alias_token_digest,
    sha256(campaign.conversation_id.slice(0, 32)),
    'the durable alias digest binds the exact conversation token');
  assert.ok(tags.has(`cim_conversation_id=${campaign.conversation_id}`));
  assert.ok(tags.has(`cim_touch_id=${touch.id}`));
  assert.equal(metadata.conversationId, campaign.conversation_id);
  assert.equal(metadata.transmissionId, transmission.id);
  assert.deepEqual(metadata.campaignIds, [campaign.id]);
  assert.deepEqual(metadata.touchIds, [touch.id]);
  assert.equal(metadata.memberDigest, transmission.member_digest);
});

test('P10A preparation binds the immutable message to one controlled mailbox recipient', async (t) => {
  const { storage, db, opportunityId, now, decision, recipient } = await seedP4bEligibleFixture(t);
  await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  await storage.recordCimCapabilityActivation({
    id: 'p10a-initial', capability: 'fl04b-initial', mode: 'active',
    policyHash: 'c'.repeat(64), configHash: 'd'.repeat(64), actor: 'fixture-owner',
    reason: 'synthetic controlled mailbox', confirmation: 'synthetic-confirmation',
    providerProfile: 'controlled-mailbox-v1', now,
    prerequisiteActivationId: 'p4b-enrollment',
    prerequisiteEvidenceId: 'p10a-initial-evidence', prerequisiteEvidenceHash: 'e'.repeat(64),
  });
  const configOverride = structuredClone(getConfig());
  configOverride.delivery = { ...configOverride.delivery, provider: 'console',
    resendApiKey: '', resendFromEmail: '', resendReplyTo: '', resendInboundDomain: '',
    emailWebhookSecret: '' };
  configOverride.dealHunter.cimProvider = {
    enabled: true, profile: 'controlled-mailbox-v1', mode: 'controlled-mailbox',
    provider: 'resend', resendApiKey: 'mailbox-outbound-key',
    resendFromEmail: 'Mailbox Sender <sender@mailbox.example.test>',
    resendReplyTo: 'replies@mailbox-inbound.example.test',
    resendInboundDomain: 'mailbox-inbound.example.test',
    emailWebhookSecret: 'mailbox-webhook-secret', reconciliationApiKey: 'mailbox-read-key',
    allowedRecipients: [recipient.email],
  };
  const outcomes = await runDueCimInitialPreparations({ storage, now, configOverride });
  assert.equal(outcomes[0].prepared, true, JSON.stringify(outcomes[0]));
  const communication = db.prepare('SELECT * FROM crm_communications').get();
  assert.equal(communication.from_address,
    'Mailbox Sender <sender@mailbox.example.test>');
  assert.deepEqual(JSON.parse(communication.to_addresses), [recipient.email]);
  assert.match(communication.reply_to_address, /@mailbox-inbound\.example\.test$/);
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

test('P8A release report exposes exact persisted canary copy and authority without provider secrets', async () => {
  const opportunityId = 'opp-p8a-release';
  const campaign = {
    id: 'campaign-p8a', opportunity_id: opportunityId, generation: 1,
    state: 'initial-pending', reason_code: 'awaiting_live_authorization',
    policy_version: 'deal-hunter-cim-autopilot-v1', template_version: 'template-v1',
    permission_version: 'activation-p8a', permission_digest: '1'.repeat(64),
    permission_revision: 7, permission_scope: 'cohort-p8a',
    recipient_authority_id: 'recipient-authority-p8a', recipient_fingerprint: '2'.repeat(64),
    timezone_revision: 3, terminal_revision: 0, row_version: 4,
    local_expiry_at: '2026-10-22T17:00:00.000Z', created_at: '2026-10-01T15:00:00.000Z',
  };
  const transmission = {
    id: 'transmission-p8a', communication_id: 'communication-p8a',
    state: 'prepared', release_state: 'awaiting-live-authorization', row_version: 2,
    member_digest: '3'.repeat(64), payload_digest: '4'.repeat(64),
    payload_version: 'payload-v1', preparation_generation: 1,
    from_address: 'buyer@example.test', to_addresses: ['broker@example.test'],
    cc_addresses: [], bcc_addresses: [], reply_to_address: 'reply@example.test',
    subject: 'Persisted CIM subject', provider_idempotency_key: 'never-expose-provider-key',
    boundary_nonce_digest: '5'.repeat(64), provider_message_id: 'never-expose-provider-id',
    created_at: '2026-10-01T15:01:00.000Z', updated_at: '2026-10-01T15:01:00.000Z',
  };
  const storage = {
    async readPursueCimProjection() {
      return {
        decision: { id: 'decision-p8a', action: 'pursue', created_at: '2026-10-01T14:59:00.000Z',
          selected_contact_reference_digest: '6'.repeat(64) },
        enrollment: { id: 'enrollment-p8a', state: 'campaign-created', reason_code: null,
          created_at: '2026-10-01T15:00:00.000Z' },
        campaign,
        initialTouch: { id: 'touch-p8a', state: 'prepared', due_at: '2026-10-01T16:00:00.000Z',
          due_local: '2026-10-01T09:00:00-07:00', row_version: 2 },
        transmission,
        legacySummary: { count: 0, accepted: 0, ambiguous: 0 }, actions: [],
      };
    },
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: opportunityId, canonical_name: 'P8A Durable Opportunity', status: 'active' };
    },
    async readPursuitEnrollmentAuthority() {
      return {
        timezone: { revision: 3, state: 'verified', iana_timezone: 'America/Los_Angeles',
          evidence_digest: 'never-expose-timezone-evidence' },
        activation: { id: 'activation-p8a', capability: 'fl04b-enrollment', mode: 'canary',
          status: 'current', expires_at: '2026-10-02T15:00:00.000Z',
          prerequisite_evidence_hash: 'never-expose-activation-evidence' },
        globalAuthorityRevision: 9,
      };
    },
    async getCrmCommunication() {
      return {
        id: 'communication-p8a', from_address: 'buyer@example.test',
        to_addresses: ['broker@example.test'], cc_addresses: [], bcc_addresses: [],
        reply_to_address: 'reply@example.test', subject: 'Persisted CIM subject',
        body_text: 'Exact persisted body.', body_html_sanitized: '<p>Exact persisted body.</p>',
        metadata: { signedContactRef: 'never-expose-signed-reference', providerPayload: { secret: true } },
      };
    },
    async getPursueCimLiveProviderAuthorization() {
      return { id: 'live-authorization-p8a', transmission_id: 'transmission-p8a',
        capability: 'fl04b-initial', writer_path: 'pursue-cim-autopilot-initial',
        payload_digest: '4'.repeat(64), recipient_authority_digest: '2'.repeat(64),
        issued_at: '2026-10-01T15:02:00.000Z', expires_at: '2026-10-01T15:17:00.000Z',
        consumed_at: null, withdrawn_at: null, boundary_nonce_digest: 'never-expose-auth-nonce' };
    },
    async readCimCadenceContext() {
      return { transmission, nextTouch: null, members: [{ membership: {
        transmission_id: 'transmission-p8a', touch_id: 'touch-p8a',
        opportunity_id: opportunityId, campaign_id: 'campaign-p8a', display_ordinal: 0,
        cancelled_at: null, cancellation_reason: null,
      } }] };
    },
  };
  const report = await getPursueCimReleaseReport({ storage, opportunityId,
    now: '2026-10-01T15:05:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control',
      updatedAt: '2026-10-01T15:04:00.000Z' }) });
  assert.deepEqual(report.transmission.copy, { subject: 'Persisted CIM subject',
    text: 'Exact persisted body.', html: '<p>Exact persisted body.</p>' });
  assert.deepEqual(report.transmission.addressing, { from: 'buyer@example.test',
    to: ['broker@example.test'], cc: [], bcc: [], replyTo: 'reply@example.test' });
  assert.deepEqual(report.transmission.membership, [{ opportunityId,
    campaignId: 'campaign-p8a', touchId: 'touch-p8a', displayOrdinal: 0,
    cancelledAt: '', cancellationReason: '' }]);
  assert.equal(report.status.code, 'awaiting_live_authorization');
  assert.equal(report.recipientAuthority.address, 'broker@example.test');
  assert.equal(report.timezoneAuthority.ianaTimezone, 'America/Los_Angeles');
  assert.equal(report.actions.canStop, true);
  assert.deepEqual(report.liveAuthorization, {
    id: 'live-authorization-p8a', capability: 'fl04b-initial',
    writerPath: 'pursue-cim-autopilot-initial', status: 'current',
    issuedAt: '2026-10-01T15:02:00.000Z', expiresAt: '2026-10-01T15:17:00.000Z',
    consumedAt: '', withdrawnAt: '',
  });
  const serialized = JSON.stringify(report);
  for (const secret of ['never-expose-provider-key', 'never-expose-provider-id',
    'never-expose-signed-reference', 'never-expose-timezone-evidence',
    'never-expose-activation-evidence', 'never-expose-auth-nonce',
    'boundaryNonceDigest', 'providerPayload']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const readCadenceContext = storage.readCimCadenceContext;
  storage.readCimCadenceContext = async () => ({ transmission, nextTouch: null, members: [] });
  await assert.rejects(() => getPursueCimReleaseReport({ storage, opportunityId,
    now: '2026-10-01T15:05:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) }),
  /membership binding mismatch/);
  storage.readCimCadenceContext = async () => ({ transmission, nextTouch: null, members: [{
    membership: { transmission_id: 'different-transmission', touch_id: 'touch-p8a',
      opportunity_id: opportunityId, campaign_id: 'campaign-p8a', display_ordinal: 0 },
  }] });
  await assert.rejects(() => getPursueCimReleaseReport({ storage, opportunityId,
    now: '2026-10-01T15:05:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) }),
  /membership binding mismatch/);
  storage.readCimCadenceContext = readCadenceContext;
  transmission.state = 'accepted';
  transmission.release_state = 'authorized';
  transmission.provider_result_code = 'accepted';
  const accepted = await getPursueCimReleaseReport({ storage, opportunityId,
    now: '2026-10-01T15:06:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) });
  assert.deepEqual(accepted.status,
    { code: 'provider_accepted', reason: 'accepted', actionRequired: false });
});

test('P8A queued release reads its selected recipient from the persisted campaign conversation', async () => {
  const opportunityId = 'opp-p8a-queued';
  const storage = {
    async readPursueCimProjection() {
      return {
        decision: { action: 'pursue' },
        enrollment: { state: 'campaign-created' },
        campaign: { id: 'campaign-p8a-queued', opportunity_id: opportunityId, generation: 1,
          conversation_id: 'conversation-p8a-queued', state: 'initial-pending', row_version: 1,
          terminal_revision: 0, recipient_authority_id: 'recipient-p8a-queued',
          recipient_fingerprint: '7'.repeat(64), permission_version: 'activation-p8a',
          permission_digest: '8'.repeat(64), permission_revision: 2,
          permission_scope: 'cohort-p8a' },
        initialTouch: { id: 'touch-p8a-queued', state: 'scheduled', row_version: 1 },
        transmission: null, legacySummary: { count: 0, accepted: 0, ambiguous: 0 }, actions: [],
      };
    },
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: opportunityId, canonical_name: 'Queued P8A', status: 'active' };
    },
    async readPursuitEnrollmentAuthority() {
      return { timezone: null, activation: null, globalAuthorityRevision: 1 };
    },
    async getPursueCimBrokerConversation() {
      return { id: 'conversation-p8a-queued', recipient_authority_id: 'recipient-p8a-queued',
        recipient_fingerprint: '7'.repeat(64), recipient_address: 'queued-broker@example.test' };
    },
  };
  const report = await getPursueCimReleaseReport({ storage, opportunityId,
    now: '2026-10-01T15:05:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) });
  assert.equal(report.recipientAuthority.address, 'queued-broker@example.test');
  assert.equal(report.transmission, null);
});

test('P8A explicit stop is revision-bound, idempotent, and returns the durable stopped report', async () => {
  let stopped = false;
  let appended;
  let appliedCommand;
  let appliedEventId = '';
  const campaign = () => ({ id: 'campaign-stop-p8a', opportunity_id: 'opp-stop-p8a',
    state: stopped ? 'stopped' : 'initial-pending', reason_code: stopped ? 'campaign_stopped' : null,
    row_version: stopped ? 6 : 5, terminal_revision: stopped ? 3 : 2, generation: 1 });
  const storage = {
    async readPursueCimProjection() {
      return { decision: { action: 'pursue' }, enrollment: { state: 'campaign-created' },
        campaign: campaign(), initialTouch: { id: 'touch-stop-p8a', state: 'scheduled', row_version: 1 },
        transmission: null, legacySummary: { count: 0, accepted: 0, ambiguous: 0 }, actions: [] };
    },
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-stop-p8a', canonical_name: 'Stop Fixture', status: 'active' };
    },
    async readPursuitEnrollmentAuthority() {
      return { timezone: null, activation: null, globalAuthorityRevision: 1 };
    },
    async appendCimTerminalEvent(command) {
      appended = command;
      if (stopped) return command.eventId === appliedEventId
        && command.metadataDigest === appliedCommand.metadataDigest
        ? { applied: false, replay: true, conflict: false, cancelledTouchIds: ['touch-stop-p8a'] }
        : { applied: false, replay: false, conflict: true, cancelledTouchIds: [] };
      appliedEventId = command.eventId;
      appliedCommand = command;
      stopped = true;
      return { applied: true, replay: false, conflict: false,
        campaignRevision: 3, conversationRevision: null, cancelledTouchIds: ['touch-stop-p8a'] };
    },
  };
  const result = await stopPursueCimCampaign({ storage, opportunityId: 'opp-stop-p8a',
    campaignId: 'campaign-stop-p8a', expectedRowVersion: 5, expectedTerminalRevision: 2,
    idempotencyKey: '252f9f52-8a03-4a7a-9c7b-51722474a4f0', reason: 'Owner stopped canary.',
    actor: 'release-owner', now: '2026-10-01T15:10:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) });
  assert.equal(result.ok, true);
  assert.equal(result.report.campaign.state, 'stopped');
  assert.equal(result.report.actions.canStop, false);
  assert.deepEqual({ scope: appended.scope, scopeId: appended.scopeId,
    expectedRevision: appended.expectedRevision, expectedRowVersion: appended.expectedRowVersion,
    nextState: appended.nextState, reasonCode: appended.reasonCode,
    evidenceType: appended.evidenceType, actor: appended.actor },
  { scope: 'campaign', scopeId: 'campaign-stop-p8a', expectedRevision: 2,
    expectedRowVersion: 5, nextState: 'stopped', reasonCode: 'campaign_stopped',
    evidenceType: 'operator-stop', actor: 'release-owner' });
  const replay = await stopPursueCimCampaign({ storage, opportunityId: 'opp-stop-p8a',
    campaignId: 'campaign-stop-p8a', expectedRowVersion: 5, expectedTerminalRevision: 2,
    idempotencyKey: '252f9f52-8a03-4a7a-9c7b-51722474a4f0', reason: 'Owner stopped canary.',
    actor: 'release-owner', now: '2026-10-01T15:10:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  const rebound = await stopPursueCimCampaign({ storage, opportunityId: 'opp-stop-p8a',
    campaignId: 'campaign-stop-p8a', expectedRowVersion: 6, expectedTerminalRevision: 3,
    idempotencyKey: '252f9f52-8a03-4a7a-9c7b-51722474a4f0', reason: 'Owner stopped canary.',
    actor: 'different-owner', now: '2026-10-01T15:11:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) });
  assert.deepEqual({ ok: rebound.ok, status: rebound.status, code: rebound.code },
    { ok: false, status: 409, code: 'stale_campaign' });
  const stale = await stopPursueCimCampaign({ storage, opportunityId: 'opp-stop-p8a',
    campaignId: 'campaign-stop-p8a', expectedRowVersion: 6, expectedTerminalRevision: 3,
    idempotencyKey: 'b781a49a-06a1-48a5-9ed0-9522af343c3b', reason: 'Different command.',
    actor: 'release-owner', now: '2026-10-01T15:11:00.000Z',
    getPauseStatus: async () => ({ paused: true, source: 'operations-control' }) });
  assert.deepEqual({ ok: stale.ok, status: stale.status, code: stale.code },
    { ok: false, status: 409, code: 'stale_campaign' });
});

test('P9 shadow is a bounded read-only projection with provider work structurally unavailable', async () => {
  let reads = 0;
  const privateSentinels = ['broker@example.test', 'Private subject', 'Private body'];
  const storage = {
    async readPursueCimOperationsSnapshot({ now, limit }) {
      reads += 1;
      assert.equal(now, '2026-10-01T17:00:00.000Z');
      assert.equal(limit, 100);
      return {
        counts: { ownerDecisions: 3, enrollments: 2, campaigns: 1, touches: 1,
          transmissions: 1, memberships: 1, crmOutbound: 1, outbox: 1,
          providerAuthorizations: 0, providerPending: 0, providerSeamEntries: 0 },
        stateCounts: { enrollments: { queued: 1 }, campaigns: { 'initial-pending': 1 },
          touches: { scheduled: 1 }, transmissions: { prepared: 1 } },
        reasonCounts: { enrollments: { timezone_missing: 1 }, campaigns: {},
          touches: {}, gateBlocks: { central_outreach_pause: 1 } },
        providerPending: { count: 0, oldestAt: '', oldestAgeSeconds: 0 },
        activations: { current: 2, expired: 0, nearestExpiryAt: '2026-10-02T17:00:00.000Z' },
        legacy: { total: 1, active: 0, ambiguous: 0, writerInvocations: 0,
          classifications: { terminal: 1 } },
        boundary: { accepts: 0, rejects: 2, byWriterPath: { 'pursue-cim-initial': 2 } },
        invariants: { duplicateProviderIdentities: 0, missingDurableAuthority: 0,
          multipleActiveCampaigns: 0, duplicateAcceptedTouches: 0,
          activeIdentityAmbiguities: 0, unexpectedLegacyInvocations: 0,
          replyOrMaterialsBeforeGateProviderCalls: 0, invalidClaimedTimezones: 0,
          expiredActivationAttempts: 0, missingEnvelopeAttempts: 0,
          readinessLoss: 0, shadowProviderCalls: 0 },
        pause: { paused: true, source: 'operations-control' },
        shadowCandidates: [
          { kind: 'would-enroll', subjectId: 'private-opportunity-1', eligible: true, reason: 'ready' },
          { kind: 'would-claim', subjectId: 'private-touch-1', eligible: false, reason: 'central_outreach_pause' },
          { kind: 'would-send', subjectId: 'private-transmission-1', eligible: false, reason: 'central_outreach_pause' },
        ],
        privateSentinels,
      };
    },
  };
  const operations = await getPursueCimOperations({ storage,
    now: '2026-10-01T17:00:00.000Z' });
  const shadow = await runPursueCimShadow({ storage,
    now: '2026-10-01T17:00:00.000Z' });

  assert.equal(reads, 2);
  assert.equal(shadow.providerCalls, 0);
  assert.deepEqual(shadow.counts, { wouldEnroll: 1, wouldClaim: 0, wouldSend: 0, blocked: 2 });
  assert.deepEqual(shadow.blockedReasons, { central_outreach_pause: 2 });
  assert.equal(shadow.decisions.length, 3);
  assert.ok(shadow.decisions.every((decision) => /^[0-9a-f]{64}$/.test(decision.decisionDigest)));
  assert.ok(shadow.decisions.every((decision) => !Object.hasOwn(decision, 'subjectId')));
  assert.equal(operations.alerts.length, 0);
  assert.equal(operations.containmentRequired, false);
  const serialized = JSON.stringify({ operations, shadow });
  for (const sentinel of [...privateSentinels, 'private-opportunity-1',
    'private-touch-1', 'private-transmission-1']) assert.equal(serialized.includes(sentinel), false);
});

test('P9 high-severity findings invoke one deterministic idempotent containment command', async () => {
  const commands = [];
  const storage = {
    async applyPursueCimAutomaticContainment(command) {
      commands.push(command);
      return { applied: commands.length === 1, replay: commands.length > 1,
        paused: true, withdrawnActivations: 2, withdrawnAuthorizations: 1 };
    },
  };
  const findings = [
    { code: 'duplicate_provider_identity', count: 1, severity: 'high',
      evidenceDigest: 'a'.repeat(64) },
    { code: 'missing_live_envelope', count: 2, severity: 'high',
      evidenceDigest: 'b'.repeat(64) },
  ];
  const first = await containPursueCimFindings({ storage, findings,
    actor: 'p9-shadow-containment', now: '2026-10-01T17:05:00.000Z' });
  const replay = await containPursueCimFindings({ storage, findings,
    actor: 'p9-shadow-containment', now: '2026-10-01T17:05:00.000Z' });
  assert.equal(first.applied, true);
  assert.equal(replay.replay, true);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
  assert.ok(/^[0-9a-f]{64}$/.test(commands[0].findingId));
  assert.ok(/^[0-9a-f]{64}$/.test(commands[0].evidenceDigest));
  assert.deepEqual(commands[0].findingCodes,
    ['duplicate_provider_identity', 'missing_live_envelope']);
});

test('P9 containment runner derives findings from durable operations without operator proof', async () => {
  let reads = 0;
  const commands = [];
  const storage = {
    async readPursueCimOperationsSnapshot() {
      reads += 1;
      return { counts: {}, stateCounts: {}, reasonCounts: {}, providerPending: {},
        activations: {}, legacy: {}, boundary: {}, pause: { paused: false },
        invariants: { missingEnvelopeAttempts: 1 }, shadowCandidates: [] };
    },
    async applyPursueCimAutomaticContainment(command) {
      commands.push(command);
      return { applied: true, replay: false, paused: true,
        withdrawnActivations: 1, withdrawnAuthorizations: 0 };
    },
  };
  const result = await runPursueCimAutomaticContainment({ storage,
    actor: 'p9-automatic-containment', now: '2026-10-01T17:05:00.000Z' });
  assert.equal(reads, 1);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].findingCodes, ['missing_live_envelope']);
  assert.equal(result.containment.applied, true);
});

test('P9 release evidence is bound to commit/tree and excludes addresses and copy', () => {
  const report = buildPursueCimReleaseEvidence({
    candidate: { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true },
    policy: { version: 'deal-hunter-cim-autopilot-v1', hash: '3'.repeat(64) },
    config: { hash: '4'.repeat(64), providerEnabled: false, centralPaused: true },
    scenarios: { attempted: 65, passed: 65, failed: 0, digest: '5'.repeat(64) },
    operations: { alerts: [], counts: { transmissions: 1 } },
    shadow: { providerCalls: 0, counts: { wouldEnroll: 1, wouldClaim: 0, wouldSend: 0, blocked: 2 },
      decisions: [{ decisionDigest: '6'.repeat(64), action: 'would-enroll', eligible: true, reason: 'ready' }] },
    generatedAt: '2026-10-01T17:10:00.000Z',
  });
  assert.equal(report.candidate.commit, '1'.repeat(40));
  assert.equal(report.candidate.tree, '2'.repeat(40));
  assert.equal(report.providerCalls, 0);
  assert.ok(/^[0-9a-f]{64}$/.test(report.evidenceDigest));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('@'), false);
  assert.equal(serialized.includes('subject'), false);
  assert.equal(serialized.includes('body'), false);
});

test('P9 release-evidence command composes only read-only operations and shadow projections', async () => {
  let reads = 0;
  const storage = { async readPursueCimOperationsSnapshot() {
    reads += 1;
    return { counts: {}, stateCounts: {}, reasonCounts: {}, providerPending: {},
      activations: { current: 2, expired: 0, modes: { active: 2 } }, legacy: {},
      boundary: {}, invariants: {}, pause: { paused: true, source: 'operations-control' },
      shadowCandidates: [] };
  } };
  const report = await createPursueCimReleaseEvidenceReport({ storage,
    config: { delivery: { provider: 'console', resendApiKey: 'private-secret' },
      dealHunter: { cimOutreach: { paused: true }, cimAutomation: { paused: true } } },
    candidate: { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true },
    scenarios: { attempted: 65, passed: 65, failed: 0, digest: '5'.repeat(64) },
    now: '2026-10-01T17:10:00.000Z' });
  assert.equal(reads, 2);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.config.providerEnabled, false);
  assert.equal(report.config.centralPaused, true);
  assert.equal(report.operations.activations.current, 2);
  assert.equal(JSON.stringify(report).includes('private-secret'), false);
});
