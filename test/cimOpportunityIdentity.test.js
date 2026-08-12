import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCimOpportunityAliases,
  buildCimOpportunityRecord,
  compareCimOpportunityEvidence,
  createCimRecipientOverride,
  evaluateCimFollowUpWindow,
  evaluateCimRecipientPolicy,
  getCimIdentityOperationsStatus,
  resolveDealHunterOpportunity,
} from '../server/services/cimOpportunityIdentity.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const sharedDescription = [
  'Established commercial contractor serving recurring maintenance customers across a protected regional territory.',
  'Experienced technicians perform inspection installation repair replacement compliance and emergency field services.',
  'Management systems trained employees diversified accounts and service agreements support predictable operations.',
].join(' ');

function testStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-cim-identity-'));
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

function opportunityDeal(overrides = {}) {
  return {
    dealKey: 'url:https://market-a.example/listing/12345',
    dealKeyAliases: [],
    identityAliases: ['costar:12345'],
    sourceId: 'sheet-0',
    sourceName: 'Daily Deal Hunter',
    id: '17',
    stableExternalId: false,
    name: 'Commercial HVAC and Electrical Contractor',
    description: sharedDescription,
    location: 'Springfield, MO',
    city: 'Springfield',
    state: 'MO',
    country: 'US',
    annualProfit: 800000,
    annualRevenue: 5643224,
    askingPrice: 6500000,
    brokerName: 'Kelvin Woods',
    brokerEmail: 'kelvin.woods@cbiteam.com',
    listingUrl: 'https://market-a.example/listing/12345',
    sourceRecords: [{ sourceId: 'sheet-0' }, { sourceId: 'deal-os' }],
    ...overrides,
  };
}

test('generic numeric URL path segments are not promoted to marketplace listing IDs', () => {
  const aliases = buildCimOpportunityAliases(opportunityDeal({
    identityAliases: [],
    listingUrl: 'https://broker.example/territory/90210/listing',
  }));
  assert.equal(aliases.some((item) => item.alias_type === 'listing-id'), false);
  assert.equal(aliases.some((item) => item.alias_type === 'listing-url'), true);
});

test('CIM business-hours evaluation handles boundaries, weekdays, weekends, and Pacific DST', () => {
  const settings = {
    sendWindowStart: '08:00',
    sendWindowEnd: '17:00',
    timezone: 'America/Los_Angeles',
    weekdaysOnly: true,
  };
  assert.deepEqual(
    evaluateCimFollowUpWindow({ now: new Date('2026-07-20T14:59:00.000Z'), settings }).reason,
    'outside-send-window',
  );
  assert.equal(evaluateCimFollowUpWindow({ now: new Date('2026-07-20T15:00:00.000Z'), settings }).allowed, true);
  assert.equal(evaluateCimFollowUpWindow({ now: new Date('2026-07-20T23:59:00.000Z'), settings }).allowed, true);
  assert.equal(
    evaluateCimFollowUpWindow({ now: new Date('2026-07-21T00:00:00.000Z'), settings }).reason,
    'outside-send-window',
  );
  assert.equal(
    evaluateCimFollowUpWindow({ now: new Date('2026-07-18T16:00:00.000Z'), settings }).reason,
    'weekend',
  );
  assert.equal(
    evaluateCimFollowUpWindow({ now: new Date('2026-07-18T16:00:00.000Z'), settings: { ...settings, weekdaysOnly: false } }).allowed,
    true,
  );
  assert.equal(
    evaluateCimFollowUpWindow({ now: new Date('2026-03-09T15:00:00.000Z'), settings }).allowed,
    true,
    '08:00 after the spring DST transition is 15:00 UTC',
  );
  assert.equal(
    evaluateCimFollowUpWindow({ now: new Date('2026-11-02T16:00:00.000Z'), settings }).allowed,
    true,
    '08:00 after the fall DST transition is 16:00 UTC',
  );
});

test('persistent opportunity matching requires strongly similar descriptions and rejects materially different operations', () => {
  const opportunity = {
    opportunity_id: 'opp_existing',
    canonical_name: 'Commercial HVAC and Electrical Contractor',
    canonical_recipient: 'kelvin.woods@cbiteam.com',
    canonical_location: 'Springfield, MO',
    metadata: {
      identitySnapshot: {
        name: 'commercial hvac and electrical contractor',
        description: sharedDescription.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
        recipient: 'kelvin.woods@cbiteam.com',
        location: 'springfield mo',
        city: 'springfield',
        state: 'mo',
        country: 'us',
        askingPrice: 6500000,
        revenue: 5643224,
        profit: 800000,
        sourceIds: ['sheet 0', 'deal os'],
        listingIds: ['costar:12345'],
      },
    },
  };

  const same = compareCimOpportunityEvidence(opportunityDeal({
    listingUrl: 'https://market-b.example/listing/67890',
    identityAliases: ['dealstream:67890'],
  }), opportunity);
  assert.equal(same.automatic, true);
  assert.equal(same.evidence.descriptionMatch, true);

  const different = compareCimOpportunityEvidence(opportunityDeal({
    description: 'Family entertainment venue with birthday parties arcade games food service memberships event rentals indoor attractions youth programs weekend admissions seasonal promotions group bookings.',
    listingUrl: 'https://market-b.example/listing/67890',
    identityAliases: ['dealstream:67890'],
  }), opportunity);
  assert.equal(different.automatic, false);
  assert.equal(different.materiallyDistinct, true);
  assert.equal(different.evidence.descriptionConflict, true);
});

test('canonical observations retain prior contact and accumulated source evidence', async (t) => {
  const storage = testStorage(t);
  const first = await resolveDealHunterOpportunity({ deal: opportunityDeal(), storage, actor: 'test' });
  assert.equal(first.ok, true);

  const second = await resolveDealHunterOpportunity({
    deal: opportunityDeal({
      brokerName: '',
      brokerEmail: '',
      sourceId: 'deal-os',
      sourceRecords: [{ sourceId: 'deal-os' }],
      identityAliases: ['costar:12345', 'dealstream:09w2qq'],
    }),
    storage,
    actor: 'test',
  });

  assert.equal(second.opportunityId, first.opportunityId);
  assert.equal(second.opportunity.canonical_recipient, 'kelvin.woods@cbiteam.com');
  assert.deepEqual(
    new Set(second.opportunity.metadata.identitySnapshot.sourceIds),
    new Set(['sheet 0', 'deal os']),
  );
  assert.deepEqual(
    new Set(second.opportunity.metadata.identitySnapshot.listingIds),
    new Set(['costar:12345', 'dealstream:09w2qq']),
  );
});

test('canonical opportunity and recipient claims block concurrent duplicate first contact', async (t) => {
  const storage = testStorage(t);
  const identity = await resolveDealHunterOpportunity({ deal: opportunityDeal(), storage, actor: 'test' });
  const nowIso = new Date().toISOString();
  const first = await storage.claimDealHunterCimOpportunity({
    opportunityId: identity.opportunityId,
    requestId: 'request-one',
    recipientEmail: 'kelvin.woods@cbiteam.com',
    nowIso,
  });
  const duplicate = await storage.claimDealHunterCimOpportunity({
    opportunityId: identity.opportunityId,
    requestId: 'request-two',
    recipientEmail: 'kelvin.woods@cbiteam.com',
    nowIso,
  });
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, 'opportunity-already-claimed');

  const recipient = await storage.claimDealHunterCimRecipient({
    recipientEmail: 'kelvin.woods@cbiteam.com',
    requestId: 'request-one',
    opportunityId: identity.opportunityId,
    nowIso,
    expiresAt: new Date(Date.parse(nowIso) + 600000).toISOString(),
  });
  const recipientDuplicate = await storage.claimDealHunterCimRecipient({
    recipientEmail: 'kelvin.woods@cbiteam.com',
    requestId: 'request-two',
    opportunityId: identity.opportunityId,
    nowIso,
    expiresAt: new Date(Date.parse(nowIso) + 600000).toISOString(),
  });
  assert.equal(recipient.claimed, true);
  assert.equal(recipientDuplicate.claimed, false);
  assert.equal(recipientDuplicate.reason, 'recipient-send-in-progress');
});

test('conflicting durable aliases create an administrator exception instead of failing the whole review', async (t) => {
  const storage = testStorage(t);
  const observed = opportunityDeal();
  const nowIso = new Date().toISOString();
  for (const opportunityId of ['opp_alias_a', 'opp_alias_b']) {
    await storage.upsertDealHunterOpportunity(buildCimOpportunityRecord(observed, opportunityId, nowIso));
  }
  const aliases = buildCimOpportunityAliases(observed);
  const listingAlias = aliases.find((item) => item.alias_type === 'listing-url');
  const dealKeyAlias = aliases.find((item) => item.alias_type === 'deal-key');
  for (const [item, opportunityId] of [[listingAlias, 'opp_alias_a'], [dealKeyAlias, 'opp_alias_b']]) {
    await storage.upsertDealHunterOpportunityAlias({
      id: `alias-${opportunityId}`,
      opportunity_id: opportunityId,
      ...item,
      first_observed_at: nowIso,
      last_observed_at: nowIso,
      evidence_version: 'cim-opportunity-v1',
      resolution_method: 'fixture',
      confidence_state: 'exact',
      resolved_by: 'test',
      metadata: {},
    });
  }

  const result = await resolveDealHunterOpportunity({ deal: observed, storage, actor: 'test' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.identityException.reason, 'conflicting-canonical-aliases');
  assert.equal((await storage.listDealHunterIdentityExceptions({ statuses: ['open'] })).length, 1);
});

test('canonical alias batches reject ownership conflicts without partially linking weaker aliases', async (t) => {
  const storage = testStorage(t);
  const observed = opportunityDeal();
  const nowIso = new Date().toISOString();
  for (const opportunityId of ['opp_owner', 'opp_competing']) {
    await storage.upsertDealHunterOpportunity(buildCimOpportunityRecord(observed, opportunityId, nowIso));
  }
  await storage.upsertDealHunterOpportunityAlias({
    id: 'owned-alias',
    opportunity_id: 'opp_owner',
    alias_type: 'listing-url',
    alias_value: 'https://market-a.example/listing/12345',
    alias_key: 'listing-url:https://market-a.example/listing/12345',
    source: 'fixture',
    first_observed_at: nowIso,
    last_observed_at: nowIso,
    evidence_version: 'cim-opportunity-v1',
    resolution_method: 'fixture',
    confidence_state: 'exact',
    resolved_by: 'test',
    metadata: {},
  });

  const result = await storage.linkDealHunterOpportunityAliases([
    {
      id: 'would-be-partial-alias',
      opportunity_id: 'opp_competing',
      alias_type: 'source-id',
      alias_value: 'daily-deal-hunter:stable-12345',
      alias_key: 'source-id:daily-deal-hunter:stable-12345',
      source: 'fixture',
      first_observed_at: nowIso,
      last_observed_at: nowIso,
      evidence_version: 'cim-opportunity-v1',
      resolution_method: 'fixture',
      confidence_state: 'exact',
      resolved_by: 'test',
      metadata: {},
    },
    {
      id: 'conflicting-alias',
      opportunity_id: 'opp_competing',
      alias_type: 'listing-url',
      alias_value: 'https://market-a.example/listing/12345',
      alias_key: 'listing-url:https://market-a.example/listing/12345',
      source: 'fixture',
      first_observed_at: nowIso,
      last_observed_at: nowIso,
      evidence_version: 'cim-opportunity-v1',
      resolution_method: 'fixture',
      confidence_state: 'exact',
      resolved_by: 'test',
      metadata: {},
    },
  ]);

  assert.equal(result.linked, false);
  assert.equal(result.conflict.opportunity_id, 'opp_owner');
  assert.equal((await storage.listDealHunterOpportunityAliases({
    aliasKeys: ['source-id:daily-deal-hunter:stable-12345'],
  })).length, 0);
});

test('recipient policy counts accepted logical touches but not failed attempts', async () => {
  const now = new Date('2026-08-12T16:00:00.000Z');
  const requests = [
    {
      id: 'failed-attempt',
      recipient_email: 'broker@example.com',
      status: 'failed',
      request_state: 'ready',
      delivery_state: 'failed',
      created_at: '2026-08-12T15:00:00.000Z',
      metadata: {},
    },
    {
      id: 'accepted-message',
      recipient_email: 'broker@example.com',
      status: 'sent',
      request_state: 'provider_accepted',
      delivery_state: 'accepted',
      first_provider_accepted_at: '2026-08-12T15:30:00.000Z',
      metadata: { initialCommunicationId: 'communication-one' },
    },
  ];
  const storage = { async listDealHunterCimRequests() { return requests; } };
  const config = { dealHunter: { cimOutreach: { recipientCap24Hours: 1, recipientCap30Days: 4 } } };
  const policy = await evaluateCimRecipientPolicy({
    recipientEmail: 'BROKER@example.com',
    storage,
    config,
    now,
  });
  assert.equal(policy.touches24Hours, 1);
  assert.equal(policy.allowed, false);
  assert.equal(policy.reason, 'recipient-24-hour-cap');
});

test('administrator recipient override is confirmed, scoped, bounded, and consumed once', async (t) => {
  const storage = testStorage(t);
  const identity = await resolveDealHunterOpportunity({ deal: opportunityDeal(), storage, actor: 'test' });
  await storage.upsertDealHunterCimRequest({
    id: 'accepted-touch',
    created_at: '2026-08-12T15:00:00.000Z',
    updated_at: '2026-08-12T15:00:00.000Z',
    opportunity_id: identity.opportunityId,
    deal_key: opportunityDeal().dealKey,
    recipient_email: 'broker@example.test',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    first_provider_accepted_at: '2026-08-12T15:00:00.000Z',
    metadata: {},
  });
  const config = { dealHunter: { cimOutreach: { recipientCap24Hours: 1, recipientCap30Days: 4, overrideMaxHours: 2 } } };
  const unconfirmed = await createCimRecipientOverride({ opportunityId: identity.opportunityId, recipientEmail: 'broker@example.test', confirmed: false, reason: 'Two listings were verified as distinct.', actor: 'admin', storage, config });
  assert.equal(unconfirmed.ok, false);
  const overrideResult = await createCimRecipientOverride({ opportunityId: identity.opportunityId, recipientEmail: 'broker@example.test', confirmed: true, reason: 'Two provider listing IDs were verified as distinct.', actor: 'admin', expiresInHours: 1, storage, config });
  assert.equal(overrideResult.ok, true);
  assert.equal(overrideResult.override.metadata.scope, 'one-initial-touch');
  const allowed = await evaluateCimRecipientPolicy({ recipientEmail: 'broker@example.test', opportunityId: identity.opportunityId, storage, config, now: new Date(overrideResult.override.created_at) });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'administrator-override');
  await storage.consumeDealHunterCimRecipientOverride(overrideResult.override.id, overrideResult.override.created_at);
  const replay = await evaluateCimRecipientPolicy({ recipientEmail: 'broker@example.test', opportunityId: identity.opportunityId, storage, config, now: new Date(overrideResult.override.created_at) });
  assert.equal(replay.allowed, false);
});

test('identity operations metrics count only CIM-linked lifecycle records and report relationship mismatches', async () => {
  const nowIso = new Date().toISOString();
  const storage = {
    async findDealHunterOpportunityByAliases() { return null; },
    async listDealHunterOpportunityAliases() { return []; },
    async upsertDealHunterOpportunity() { return null; },
    async upsertDealHunterOpportunityAlias() { return null; },
    async upsertDealHunterIdentityException() { return null; },
    async claimDealHunterCimOpportunity() { return null; },
    async claimDealHunterCimRecipient() { return null; },
    async releaseDealHunterCimRecipientClaim() { return null; },
    async getDealHunterCimSafetySettings() { return { outreach_paused: false, metadata: {} }; },
    async upsertDealHunterCimSafetySettings() { return null; },
    async listDealHunterOpportunities() {
      return [{ opportunity_id: 'opp-one', primary_submission_id: 'submission-one' }];
    },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterCimRepairManifests() { return []; },
    async listDealHunterCimRequests() {
      return [{
        id: 'request-one', opportunity_id: 'opp-one', submission_id: 'submission-one',
        recipient_email: 'broker@example.test', next_follow_up_at: nowIso,
        first_provider_accepted_at: nowIso, request_state: 'provider_accepted', metadata: {},
      }];
    },
    async listCrmCommunications() {
      return {
        rows: [
          { id: 'communication-one', cim_request_id: 'request-one', opportunity_id: 'wrong-opportunity', submission_id: 'submission-one', provider_message_id: 'provider-one' },
          { id: 'unrelated-communication', cim_request_id: null, provider_message_id: 'unrelated-provider' },
        ],
        total: 2,
      };
    },
    async listEmailEventsForRecipients() {
      return [
        { id: 'event-one', communication_id: 'communication-one', opportunity_id: 'opp-one', submission_id: 'wrong-submission', provider: 'resend', message_id: 'provider-one' },
        { id: 'unrelated-event', communication_id: 'unrelated-communication', provider: 'resend', message_id: 'unrelated-provider' },
      ];
    },
  };
  const config = {
    dealHunter: {
      cimFollowUp: { sendWindowStart: '08:00', sendWindowEnd: '17:00', timezone: 'America/Los_Angeles', weekdaysOnly: true },
      cimOutreach: { paused: false, recipientCap24Hours: 1, recipientCap30Days: 4 },
    },
  };

  const status = await getCimIdentityOperationsStatus({ storage, config });

  assert.equal(status.storageHealthy, true);
  assert.equal(status.linkageMismatches, 2);
  assert.equal(status.rawLifecycleEvents, 1);
  assert.equal(status.logicalMessages, 1);
  assert.equal(status.recipientsAtCap, 1);
});
