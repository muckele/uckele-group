import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadBrokerMaterialsAuthority } from '../server/services/dealHunterBrokerMaterials.js';
import {
  CONTACT_POLICY_VERSION,
  contactPolicyDigest,
  contactRulePermits,
  orchestratePursuitEnrollment,
  pursuitPermissionCohortDigest,
} from '../server/services/pursueCimEnrollment.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { seedP4bEligibleFixture } from './fixtures/pursueCimEnrollmentFixture.js';

const healthy = async () => ({ healthy: true, issues: [] });

// A named listing broker. The fixture's default address is a generic "broker-" mailbox.
function seed(t, options = {}) {
  return seedP4bEligibleFixture(t, { brokerEmail: 'jordan.lee@brokerfirm.test', ...options });
}

async function setContactRule(storage, enabled, now) {
  const { contactRule } = await storage.getPursueSendControls();
  await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled,
    policyVersion: CONTACT_POLICY_VERSION, expectedRevision: contactRule.revision,
    actor: 'fixture-owner', reason: 'synthetic', now });
  return storage.getPursueSendControls();
}

function enroll({ storage, opportunityId, decision, now }) {
  return orchestratePursuitEnrollment({ storage, opportunityId, enrollment: decision.enrollment,
    decision: decision.decision, actor: 'fixture-owner', now, readSourceHealth: healthy });
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('contactPolicyDigest is SHA-256 over the canonical policy version and control revision', () => {
  const controls = { contactRule: { enabled: true, revision: 7 } };
  assert.equal(CONTACT_POLICY_VERSION, 'listing-broker-inquiry-v1');
  assert.equal(contactPolicyDigest(controls),
    sha256(stableCanonicalJson({ policyVersion: 'listing-broker-inquiry-v1', revision: 7 })));
  assert.equal(contactPolicyDigest(controls),
    sha256('{"policyVersion":"listing-broker-inquiry-v1","revision":7}'));
  assert.notEqual(contactPolicyDigest({ contactRule: { enabled: true, revision: 8 } }),
    contactPolicyDigest(controls));
});

test('the rule permits a single structured-source listing broker with no prior outreach', async (t) => {
  const { storage, now, authority, recipient } = await seed(t);
  const controls = await setContactRule(storage, true, now);
  assert.deepEqual(contactRulePermits({ authority, recipient, controls }),
    { permitted: true, reason: '' });
});

test('contact_rule_off: the rule refuses while the control is off or was never set', async (t) => {
  const { storage, now, authority, recipient } = await seed(t);
  assert.deepEqual(contactRulePermits({ authority, recipient,
    controls: await storage.getPursueSendControls() }),
  { permitted: false, reason: 'contact_rule_off' });
  await setContactRule(storage, true, now);
  const controls = await setContactRule(storage, false, now);
  assert.equal(controls.contactRule.revision, 2);
  assert.deepEqual(contactRulePermits({ authority, recipient, controls }),
    { permitted: false, reason: 'contact_rule_off' });
});

test('contact_option_not_single: the rule refuses when the listing has more than one contact option', async (t) => {
  const { storage, now, authority, recipient } = await seed(t);
  const controls = await setContactRule(storage, true, now);
  const second = { ...recipient, email: 'second-broker@example.test', primary: true };
  assert.deepEqual(contactRulePermits({ authority: { ...authority,
    recipientOptions: [recipient, second] }, recipient, controls }),
  { permitted: false, reason: 'contact_option_not_single' });
  assert.deepEqual(contactRulePermits({ authority, recipient: second, controls }),
    { permitted: false, reason: 'contact_option_not_single' });
});

test('contact_source_not_allowed: the rule refuses a recipient known only from an inbound email', async (t) => {
  const { storage, now, authority, recipient } = await seed(t);
  const controls = await setContactRule(storage, true, now);
  assert.equal(recipient.provenance, 'structured_source');
  const inbound = { ...recipient, provenance: 'inbound_communication',
    provenances: [{ provenance: 'inbound_communication', label: 'Inbound email' }] };
  assert.deepEqual(contactRulePermits({ authority: { ...authority, recipientOptions: [inbound] },
    recipient: inbound, controls }), { permitted: false, reason: 'contact_source_not_allowed' });
  const mixed = { ...recipient, provenances: [...recipient.provenances,
    { provenance: 'secure_document', label: 'Secure document' }] };
  assert.deepEqual(contactRulePermits({ authority: { ...authority, recipientOptions: [mixed] },
    recipient: mixed, controls }), { permitted: false, reason: 'contact_source_not_allowed' });
});

test('generic_mailbox: the rule refuses a shared listings inbox', async (t) => {
  const { storage, now, authority, recipient } = await seed(t,
    { brokerEmail: 'listings@brokerfirm.test' });
  const controls = await setContactRule(storage, true, now);
  assert.deepEqual(contactRulePermits({ authority, recipient, controls }),
    { permitted: false, reason: 'generic_mailbox' });
});

test('recipient_suppressed: the rule refuses a suppressed recipient', async (t) => {
  const { storage, now, authority, recipient } = await seed(t);
  const controls = await setContactRule(storage, true, now);
  await storage.upsertEmailSuppression({ id: randomUUID(), normalized_email: recipient.email,
    reason: 'admin-block', source: 'fixture', created_at: now, created_by: 'fixture', metadata: {} });
  const suppression = await storage.getActiveEmailSuppression(recipient.email);
  assert.ok(suppression);
  assert.deepEqual(contactRulePermits({ authority, recipient, controls, suppression }),
    { permitted: false, reason: 'recipient_suppressed' });
});

test('prior_outreach: the rule refuses a listing that already has a CIM request', async (t) => {
  const { storage, db, opportunityId, now, recipient } = await seed(t);
  const controls = await setContactRule(storage, true, now);
  db.prepare(`INSERT INTO deal_hunter_cim_requests
    (id, created_at, updated_at, deal_key, recipient_email, status, request_state,
     delivery_state, metadata, opportunity_id)
    VALUES ('prior-request', ?, ?, 'deal:p4b-service', ?, 'failed', 'failed', 'failed', '{}', ?)`)
    .run(now, now, recipient.email, opportunityId);
  const authority = await loadBrokerMaterialsAuthority({ storage, opportunityId, now });
  assert.deepEqual(contactRulePermits({ authority, recipient: authority.recipientOptions[0], controls }),
    { permitted: false, reason: 'prior_outreach' });
});

test('rule on + permitted recipient enrolls with listing-broker-inquiry-v1 and no activation', async (t) => {
  const fixture = await seed(t, { enrollmentActivation: false });
  const { storage, db, now, authority, recipient } = fixture;
  assert.equal(count(db, 'deal_hunter_cim_capability_activations'), 0);
  const controls = await setContactRule(storage, true, now);
  const result = await enroll(fixture);
  assert.equal(result.enrollment.state, 'campaign-created', result.enrollment.reason_code);
  const campaign = db.prepare('SELECT * FROM deal_hunter_cim_campaigns').get();
  assert.equal(campaign.permission_version, 'listing-broker-inquiry-v1');
  assert.equal(campaign.permission_digest, contactPolicyDigest(controls));
  assert.equal(campaign.permission_revision, controls.contactRule.revision);
  assert.equal(campaign.permission_scope, pursuitPermissionCohortDigest(authority, recipient));
  assert.equal(campaign.state, 'initial-pending');
  assert.equal(db.prepare('SELECT state FROM deal_hunter_cim_campaign_touches').get().state, 'scheduled');
  assert.equal(db.prepare('SELECT recipient_address FROM deal_hunter_broker_conversations').get()
    .recipient_address, recipient.email);
  for (const table of ['deal_hunter_cim_capability_activations', 'deal_hunter_cim_transmissions',
    'deal_hunter_cim_live_provider_authorizations', 'crm_communications']) {
    assert.equal(count(db, table), 0, table);
  }
});

test('rule off falls back to waiting-on-eligibility contact_permission_missing exactly as before', async (t) => {
  const fixture = await seed(t, { enrollmentActivation: false });
  const { storage, db, now } = fixture;
  await setContactRule(storage, true, now);
  await setContactRule(storage, false, now);
  const result = await enroll(fixture);
  assert.equal(result.enrollment.state, 'waiting-on-eligibility');
  assert.equal(result.enrollment.reason_code, 'contact_permission_missing');
  assert.equal(count(db, 'deal_hunter_cim_campaigns'), 0);
  assert.equal(count(db, 'deal_hunter_broker_conversations'), 0);
});

test('rule off still enrolls through an owner-recorded activation', async (t) => {
  const fixture = await seed(t);
  const result = await enroll(fixture);
  assert.equal(result.enrollment.state, 'campaign-created', result.enrollment.reason_code);
  assert.equal(result.campaign.permission_version, 'p4b-enrollment');
});

test('rule on but refused (generic mailbox) still enrolls through an owner-recorded activation', async (t) => {
  const fixture = await seed(t, { brokerEmail: 'info@brokerfirm.test' });
  await setContactRule(fixture.storage, true, fixture.now);
  const result = await enroll(fixture);
  assert.equal(result.enrollment.state, 'campaign-created', result.enrollment.reason_code);
  assert.equal(result.campaign.permission_version, 'p4b-enrollment');
});

test('rule on but refused (generic mailbox) without an activation waits as before', async (t) => {
  const fixture = await seed(t, { brokerEmail: 'info@brokerfirm.test',
    enrollmentActivation: false });
  await setContactRule(fixture.storage, true, fixture.now);
  const result = await enroll(fixture);
  assert.equal(result.enrollment.state, 'waiting-on-eligibility');
  assert.equal(result.enrollment.reason_code, 'contact_permission_missing');
  assert.equal(count(fixture.db, 'deal_hunter_cim_campaigns'), 0);
});

test('a recipient who replied stop on an earlier listing is refused recipient_suppressed', async (t) => {
  const fixture = await seed(t, { enrollmentActivation: false });
  const { storage, db, now, authority, recipient } = fixture;
  const controls = await setContactRule(storage, true, now);
  // The suppression the inbound opt-out path writes when a broker replies "stop".
  await storage.upsertEmailSuppression({ id: randomUUID(), normalized_email: recipient.email,
    reason: 'explicit-opt-out', source: 'inbound-content', source_event_id: 'earlier-listing-event',
    source_communication_id: 'earlier-listing-stop-reply', created_at: now,
    created_by: 'resend-ingestion', metadata: { evidenceCommunicationId: 'earlier-listing-stop-reply' } });
  const suppression = await storage.getActiveEmailSuppression(recipient.email);
  assert.deepEqual(contactRulePermits({ authority, recipient, controls, suppression }),
    { permitted: false, reason: 'recipient_suppressed' });
  const result = await enroll(fixture);
  assert.equal(result.enrollment.reason_code, 'recipient_suppressed');
  assert.equal(result.enrollment.state, 'action-required');
  assert.equal(count(db, 'deal_hunter_cim_campaigns'), 0);
  assert.equal(count(db, 'deal_hunter_broker_conversations'), 0);
});

test('storage refuses a listing-broker basis whose control revision is no longer current', async (t) => {
  const fixture = await seed(t, { enrollmentActivation: false });
  const { storage, db, now } = fixture;
  const stale = await setContactRule(storage, true, now);
  await setContactRule(storage, false, now);
  await setContactRule(storage, true, now);
  const staleReader = new Proxy(storage, { get: (target, name) => (name === 'getPursueSendControls'
    ? async () => stale : target[name]?.bind?.(target) ?? target[name]) });
  const result = await enroll({ ...fixture, storage: staleReader });
  assert.notEqual(result.enrollment.state, 'campaign-created');
  assert.equal(count(db, 'deal_hunter_cim_campaigns'), 0);
  assert.equal(count(db, 'deal_hunter_broker_conversations'), 0);
});
