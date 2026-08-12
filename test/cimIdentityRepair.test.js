import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { runCimIdentityRepair } from '../server/services/cimIdentityRepair.js';

const now = new Date('2026-08-12T18:00:00.000Z');

function request(id, overrides = {}) {
  return {
    id,
    created_at: '2026-07-01T16:00:00.000Z',
    updated_at: '2026-07-01T16:00:00.000Z',
    deal_key: `fingerprint:${id}`,
    recipient_email: 'broker@example.test',
    requested_by: 'fixture',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'delivered',
    follow_up_state: 'scheduled',
    first_requested_at: '2026-07-01T16:00:00.000Z',
    first_provider_accepted_at: '2026-07-01T16:00:00.000Z',
    next_follow_up_at: '2026-08-12T16:00:00.000Z',
    provider_message_id: `provider-${id}`,
    deal_name: 'Synthetic HVAC Services',
    source_name: 'fixture-source',
    listing_url: '',
    metadata: {
      description: 'Established commercial HVAC contractor with recurring maintenance agreements trained technicians diversified customers inspection installation repair replacement compliance programs and regional service operations.',
      location: 'Sacramento, CA',
      state: 'CA',
      askingPrice: 1_400_000,
      annualRevenue: 1_800_000,
      annualProfit: 450_000,
      sourceId: 'fixture-source',
      providerMessageIds: [`provider-${id}`],
    },
    ...overrides,
  };
}

function submission(id, listingUrl) {
  const timestamp = '2026-07-01T16:00:00.000Z';
  return {
    id,
    created_at: timestamp,
    updated_at: timestamp,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'cim-identity-repair-fixture',
    ip_hash: '',
    user_agent: '',
    name: 'Synthetic HVAC Services',
    email: 'broker@example.test',
    phone: '',
    company: 'Synthetic HVAC Services',
    role: 'Broker',
    message: 'Synthetic CRM identity drift fixture.',
    status_updated_at: timestamp,
    listing_url: listingUrl,
    business_website: '',
    prospectus_url: '',
    asking_price: '1400000',
    ttm_revenue: '1800000',
    ttm_ebitda: '450000',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: 'Synthetic Broker',
    broker_email: 'broker@example.test',
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'high',
    tags: ['cim-repair-fixture'],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: timestamp,
    metadata: {},
  };
}

function communication({ id, requestId, submissionId }) {
  const timestamp = '2026-07-20T16:00:00.000Z';
  return {
    id,
    submission_id: submissionId,
    opportunity_id: null,
    deal_key: 'url:https://bizbuysell.com/business-opportunity/synthetic-hvac/24681012',
    cim_request_id: requestId,
    direction: 'outbound',
    channel: 'email',
    source: 'email-provider',
    kind: 'cim-request',
    provider: 'resend',
    provider_message_id: 'provider-url',
    source_event_id: null,
    idempotency_key: 'synthetic-url-outbound',
    message_id: 'provider-url',
    in_reply_to: null,
    reply_to_address: 'deals@example.test',
    from_address: 'deals@example.test',
    to_addresses: ['broker@example.test'],
    cc_addresses: [],
    bcc_addresses: [],
    subject: 'Synthetic subject',
    body_text: 'Historical CIM request body that must remain byte-for-byte intact.',
    body_html_sanitized: '<p>Historical CIM request body that must remain byte-for-byte intact.</p>',
    occurred_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    delivery_state: 'delivered',
    delivery_state_at: timestamp,
    content_state: 'complete',
    content_attempt_count: 0,
    attachment_metadata: [],
    created_by: 'fixture',
    updated_by: 'fixture',
    metadata: { fixture: true },
  };
}

function repairStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cim-repair-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'repair.sqlite') }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

test('repair dry run is read-only and apply is confirmation-gated and idempotent', async (t) => {
  const storage = repairStorage(t);
  const primarySubmissionId = '10000000-0000-4000-8000-000000000001';
  const duplicateSubmissionId = '10000000-0000-4000-8000-000000000002';
  const communicationId = '20000000-0000-4000-8000-000000000001';
  const listingUrl = 'https://bizbuysell.com/business-opportunity/synthetic-hvac/24681012';
  await storage.insertSubmission(submission(primarySubmissionId, ''));
  await storage.insertSubmission(submission(duplicateSubmissionId, listingUrl));
  const fingerprint = request('fingerprint-request', { submission_id: primarySubmissionId });
  const matchingUrl = request('url-request', {
    created_at: '2026-07-20T16:00:00.000Z',
    updated_at: '2026-07-20T16:00:00.000Z',
    first_requested_at: '2026-07-20T16:00:00.000Z',
    first_provider_accepted_at: '2026-07-20T16:00:00.000Z',
    deal_key: `url:${listingUrl}`,
    listing_url: listingUrl,
    provider_message_id: 'provider-url',
    submission_id: duplicateSubmissionId,
  });
  const distinct = request('distinct-request', {
    deal_key: 'url:https://bizbuysell.com/business-opportunity/synthetic-hvac/99999999',
    listing_url: 'https://bizbuysell.com/business-opportunity/synthetic-hvac/99999999',
    metadata: {
      description: 'Established commercial HVAC contractor with recurring maintenance agreements trained technicians diversified customers inspection installation repair replacement compliance programs and regional service operations.',
      location: 'Austin, TX', state: 'TX', askingPrice: 4_800_000, annualRevenue: 6_000_000,
      annualProfit: 1_400_000, sourceId: 'fixture-source', providerMessageIds: ['provider-distinct'],
    },
  });
  await storage.upsertDealHunterCimRequest(fingerprint);
  await storage.upsertDealHunterCimRequest(matchingUrl);
  await storage.upsertDealHunterCimRequest(distinct);
  await storage.insertCrmCommunication(communication({
    id: communicationId,
    requestId: matchingUrl.id,
    submissionId: duplicateSubmissionId,
  }));
  for (const provider of ['provider-fingerprint-request', 'provider-url', 'provider-distinct']) {
    for (const eventType of ['sent-local', 'sent-webhook', 'delivered']) {
      await storage.insertEmailEvent({
        id: `${provider}-${eventType}`,
        created_at: '2026-07-20T16:00:00.000Z',
        provider: 'resend',
        event_type: eventType === 'delivered' ? 'delivered' : 'sent',
        message_id: provider,
        provider_event_id: `${provider}-${eventType}`,
        event_key: `${provider}-${eventType}`,
        recipient_email: 'broker@example.test',
        subject: 'Synthetic subject',
        submission_id: provider === 'provider-url' ? duplicateSubmissionId : null,
        communication_id: provider === 'provider-url' ? communicationId : null,
        opportunity_id: null,
        source: eventType === 'sent-local' ? 'email-provider' : 'resend-webhook',
        metadata: {},
      });
    }
  }

  const beforeRequests = await storage.listDealHunterCimRequests({ limit: 100 });
  const dryRun = await runCimIdentityRepair({ storage, now });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.audit.counts.fingerprintToUrlCandidates, 1);
  assert.equal(dryRun.audit.counts.materiallyDistinctPairs >= 1, true);
  assert.equal(dryRun.audit.counts.rawLifecycleEvents, 9);
  assert.equal(dryRun.audit.counts.distinctProviderMessages, 3);
  assert.equal(dryRun.audit.counts.duplicateCrmSubmissionGroups, 1);
  assert.equal(dryRun.audit.counts.linkageMismatches >= 2, true);
  assert.deepEqual(await storage.listDealHunterCimRequests({ limit: 100 }), beforeRequests);
  assert.equal((await storage.listDealHunterOpportunities({ limit: 100 })).length, 0);
  await assert.rejects(
    runCimIdentityRepair({ apply: true, confirmation: 'wrong', backupReference: '/verified', backupVerified: true, actor: 'admin', storage, now }),
    /exact confirmation/,
  );
  await assert.rejects(
    runCimIdentityRepair({ apply: true, confirmation: 'APPLY-CIM-IDENTITY-REPAIR', backupReference: '', backupVerified: false, actor: 'admin', storage, now }),
    /verified backup/,
  );
  await assert.rejects(
    runCimIdentityRepair({
      apply: true,
      confirmation: 'APPLY-CIM-IDENTITY-REPAIR',
      backupReference: '/synthetic/verified-backup',
      backupVerified: true,
      actor: 'repair-admin',
      storage,
      now,
    }),
    /pause all Deal Hunter CIM outreach/i,
  );
  await storage.upsertDealHunterCimSafetySettings({
    updated_at: now.toISOString(),
    outreach_paused: true,
    updated_by: 'repair-admin',
    metadata: { pauseReason: 'Identity repair test.' },
  });

  const applied = await runCimIdentityRepair({
    apply: true,
    confirmation: 'APPLY-CIM-IDENTITY-REPAIR',
    backupReference: '/synthetic/verified-backup',
    backupVerified: true,
    actor: 'repair-admin',
    storage,
    now,
  });
  assert.equal(applied.applied, true);
  const repaired = await storage.listDealHunterCimRequests({ limit: 100 });
  const repairedFingerprint = repaired.find((item) => item.id === fingerprint.id);
  const repairedUrl = repaired.find((item) => item.id === matchingUrl.id);
  const repairedDistinct = repaired.find((item) => item.id === distinct.id);
  assert.equal(repairedFingerprint.opportunity_id, repairedUrl.opportunity_id);
  assert.notEqual(repairedDistinct.opportunity_id, repairedUrl.opportunity_id);
  assert.equal(repairedUrl.next_follow_up_at, null);
  assert.equal(repairedUrl.submission_id, primarySubmissionId);
  const repairedCommunication = await storage.getCrmCommunication(communicationId);
  assert.equal(repairedCommunication.submission_id, primarySubmissionId);
  assert.equal(repairedCommunication.opportunity_id, repairedUrl.opportunity_id);
  assert.equal(repairedCommunication.body_text, 'Historical CIM request body that must remain byte-for-byte intact.');
  const repairedEvents = await storage.listEmailEventsForRecipients(['broker@example.test'], 100);
  assert.equal(repairedEvents.length, 9);
  const repairedUrlEvents = repairedEvents.filter((event) => event.message_id === 'provider-url');
  assert.equal(repairedUrlEvents.length, 3);
  assert.equal(repairedUrlEvents.every((event) => event.submission_id === primarySubmissionId), true);
  assert.equal(repairedUrlEvents.every((event) => event.opportunity_id === repairedUrl.opportunity_id), true);
  const replay = await runCimIdentityRepair({
    apply: true,
    confirmation: 'APPLY-CIM-IDENTITY-REPAIR',
    backupReference: '/synthetic/verified-backup',
    backupVerified: true,
    actor: 'repair-admin',
    storage,
    now,
  });
  assert.equal(replay.alreadyApplied, true);
  assert.equal((await storage.listDealHunterCimRepairManifests({ limit: 100 })).length, 1);
});

test('repair transaction rolls back canonical inserts when an audited request version changes', async (t) => {
  const storage = repairStorage(t);
  const existing = request('version-conflict');
  await storage.upsertDealHunterCimRequest(existing);
  const opportunityId = 'opp_repair_version_conflict';
  const manifest = {
    id: 'cim-repair-version-conflict',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    mode: 'apply',
    status: 'applied',
    actor: 'repair-admin',
    backup_reference: '/synthetic/verified-backup',
    checksum: 'version-conflict-checksum',
    manifest: {},
    metadata: {},
  };

  await assert.rejects(
    storage.applyDealHunterCimIdentityRepair({
      opportunityRecords: [{
        opportunity_id: opportunityId,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        canonical_name: 'Synthetic HVAC Services',
        canonical_recipient: 'broker@example.test',
        canonical_location: 'Sacramento, CA',
        primary_submission_id: null,
        identity_version: 'cim-opportunity-v1',
        status: 'active',
        metadata: {},
      }],
      requestLinks: [{
        id: existing.id,
        opportunity_id: opportunityId,
        submission_id: null,
        expected_updated_at: '2026-07-01T16:00:01.000Z',
        updated_at: now.toISOString(),
      }],
      manifest,
    }),
    /version changed after the dry-run audit/i,
  );

  assert.equal((await storage.listDealHunterOpportunities({ limit: 100 })).length, 0);
  assert.equal((await storage.listDealHunterCimRepairManifests({ limit: 100 })).length, 0);
  assert.equal((await storage.getDealHunterCimRequestById(existing.id)).opportunity_id, null);
});
