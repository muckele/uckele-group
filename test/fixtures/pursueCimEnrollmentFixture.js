import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadBrokerMaterialsAuthority } from '../../server/services/dealHunterBrokerMaterials.js';
import { pursuitPermissionBasisDigest,
  pursuitPermissionCohortDigest } from '../../server/services/pursueCimEnrollment.js';
import { createSqliteStorage } from '../../server/storage/sqlite.js';

/**
 * One Pursued opportunity on real SQLite, eligible for enrollment: a single structured-source
 * broker, a CRM owner and a verified timezone. `enrollmentActivation: false` leaves out the
 * fl04a-safety and fl04b-enrollment activations, so only the standing contact rule can enroll it.
 */
export async function seedP4bEligibleFixture(t, { timezone = true, dealState = null, dealLocation = null,
  brokerEmail = 'broker-p4b@example.test', enrollmentActivation = true } = {}) {
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
    (opportunity_id, created_at, scored_at, deal_key, name, state, listing_url,
     score_fingerprint, engine_version, rules_version, profile_version,
     completeness_policy_version, current_triage_eligible)
    VALUES (?, ?, ?, 'deal:p4b-service', 'P4B Service Co', ?,
      'https://broker.example/p4b-service', 'score-p4b', 'test', 'test', 'test', 'test', 1)`)
    .run(opportunityId, now, now, dealState);
  for (const [field, value] of [
    ['name', 'P4B Service Co'], ['broker_email', brokerEmail],
    ['listing_url', 'https://broker.example/p4b-service'],
    ...(dealLocation ? [['location', dealLocation]] : []),
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
  if (timezone) await storage.appendOpportunityTimezoneRevision({ opportunityId,
    expectedPriorRevision: 0, idempotencyKey: 'p4b-timezone', state: 'verified',
    ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
    evidenceId: 'p4b-timezone-evidence', evidenceDigest: 'a'.repeat(64),
    resolverVersion: 'explicit-v1', datasetDigest: 'b'.repeat(64),
    actor: 'fixture-owner', now });
  const authority = await loadBrokerMaterialsAuthority({ storage, opportunityId, now });
  assert.equal(authority.recipientOptions.length, 1);
  const recipient = authority.recipientOptions[0];
  if (enrollmentActivation) {
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
  }
  return { storage, db, opportunityId, now, decision, authority, recipient };
}
