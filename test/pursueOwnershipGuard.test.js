import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

process.env.DELIVERY_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test_local_only';
process.env.RESEND_FROM_EMAIL = 'buyer@example.test';
process.env.RESEND_REPLY_TO = 'replies@example.test';
process.env.EMAIL_WEBHOOK_SECRET = 'pursue-ownership-webhook-secret';
process.env.LEAD_NOTIFICATION_EMAIL = 'admin@example.test';
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/pursue-ownership.csv';
process.env.DEAL_HUNTER_AIRTABLE_TOKEN = 'test-token';
process.env.DEAL_HUNTER_AIRTABLE_BASE_ID = 'appTest';
process.env.DEAL_HUNTER_AIRTABLE_TABLE_ID = 'tblTest';
process.env.DEAL_HUNTER_AIRTABLE_SHARED_VIEW_URL = '';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED = 'true';
process.env.DEAL_HUNTER_CIM_FOLLOW_UP_WEEKDAYS_ONLY = 'false';
process.env.DEAL_HUNTER_CIM_RECIPIENT_24_HOUR_CAP = '100';
process.env.DEAL_HUNTER_CIM_RECIPIENT_30_DAY_TOUCH_CAP = '100';
process.env.DEAL_HUNTER_CIM_AUTOMATION_STAGE = '2';
process.env.DEAL_HUNTER_CIM_AUTOMATION_MIN_SCORE = '75';
process.env.ADMIN_SESSION_SECRET = 'pursue-ownership-guard-test-secret';

const refusalCopy = 'This deal is in a SIM request campaign — manage it from the drawer.';
const today = new Date().toISOString().slice(0, 10);
const sourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Profit Multiple,Broker Name,Broker Email,Contact Name 2,Contact Email 2,Listing URL,Description',
  `"Commercial Safety Services","Fire safety inspection maintenance","CA","${today}","$450,000","$1,800,000","$1,400,000","3.1","Erin Broker","erin@example.com","Alex Contact","alex@example.com","https://broker.example.test/listing-42","Recurring commercial inspection, maintenance contracts, compliance work, trained field technicians, management in place, SBA eligible."`,
].join('\n');

const originalFetch = globalThis.fetch;
let providerCalls = [];

before(() => {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://example.test/pursue-ownership.csv') {
      return new Response(sourceCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
    }
    if (target.includes('api.airtable.com')) return Response.json({ records: [] });
    if (target.startsWith('https://api.resend.com/')) {
      providerCalls.push({ url: target, body: options.body });
      return Response.json({ id: `resend-message-${providerCalls.length}` }, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
});

beforeEach(() => {
  providerCalls = [];
});

after(() => {
  globalThis.fetch = originalFetch;
});

function testStorage(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-ownership-'));
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { storage, sqlitePath };
}

async function reviewedDeal(storage) {
  const { reviewDailyDeals } = await import('../server/services/dealHunter.js');
  const review = await reviewDailyDeals({ storage });
  const deal = review.qualified.find((item) => item.cimRequest?.canRequest);
  assert.ok(deal, 'fixture should produce a CIM-ready opportunity');
  return deal;
}

function recordOwnerDecisionRow(sqlitePath, opportunityId, action = 'pursue') {
  const database = new Database(sqlitePath);
  try {
    const id = `decision-${randomUUID()}`;
    database.prepare(`
      INSERT INTO deal_hunter_owner_decision_events (
        id, idempotency_key, request_digest, opportunity_id, action, actor,
        expected_discovery_revision, expected_material_revision,
        observed_discovery_revision, observed_material_revision, policy_version, created_at
      ) VALUES (?, ?, ?, ?, ?, 'guard-test-owner', 0, 0, 0, 0, 'owner-decision-v1', ?)
    `).run(id, `idem-${id}`, createHash('sha256').update(id).digest('hex'), opportunityId, action,
      new Date().toISOString());
  } finally {
    database.close();
  }
}

// Mirrors the legacy-evidence half of Pursue's lifecycle_conflict check
// (pursueCimSqliteTransitions.js priorRequest/priorClaim), which is internal SQL.
function pursueLifecycleLegacyEvidence(sqlitePath, opportunityId) {
  const database = new Database(sqlitePath, { readonly: true });
  try {
    const priorRequest = database.prepare(`SELECT 1 FROM deal_hunter_cim_requests
      WHERE opportunity_id = ? OR deal_key IN (SELECT deal_key
        FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?) LIMIT 1`)
      .get(opportunityId, opportunityId);
    const priorClaim = database.prepare(`SELECT 1 FROM deal_hunter_cim_opportunity_claims
      WHERE opportunity_id = ? LIMIT 1`).get(opportunityId);
    return { priorRequest: Boolean(priorRequest), priorClaim: Boolean(priorClaim) };
  } finally {
    database.close();
  }
}

const followUpSettings = {
  enabled: true,
  firstDelayHours: 1,
  intervalHours: 1,
  delaySequenceHours: [1],
  maxCount: 3,
  weekdaysOnly: false,
  timezone: 'America/Los_Angeles',
  sendWindowStart: '00:00',
  sendWindowEnd: '23:59',
};

async function scheduledLegacyRequest(storage, deal) {
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const initial = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'follow-up-guard-admin',
    storage,
  });
  assert.ok(initial.request?.id, 'the unpursued initial must create a durable legacy request');
  await storage.upsertDealHunterCimRequest({
    ...initial.request,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    status: 'sent',
    follow_up_state: 'scheduled',
    next_follow_up_at: new Date(Date.now() - 1000).toISOString(),
  });
  providerCalls = [];
  return initial.request;
}

test('readPursueOwnership: pursue decision, enrollment, ended campaign → owned; watch decision only → not owned; throw → pursue_authority_unavailable', async () => {
  const { readPursueOwnership } = await import('../server/services/pursueOwnership.js');
  const projectionStorage = (projection) => ({
    calls: [],
    async readPursueCimProjection(command) {
      this.calls.push(command);
      return projection;
    },
  });
  const empty = { decision: null, enrollment: null, campaign: null, initialTouch: null, transmission: null,
    legacySummary: { count: 0, accepted: 0, ambiguous: 0 }, actions: [] };

  const pursued = projectionStorage({ ...empty, decision: { id: 'd1', action: 'pursue' } });
  assert.deepEqual(await readPursueOwnership({ storage: pursued, opportunityId: 'opp-1' }),
    { owned: true, reason: 'pursue_owns_opportunity' });
  assert.deepEqual(pursued.calls, [{ opportunityId: 'opp-1' }]);

  assert.deepEqual(await readPursueOwnership({
    storage: projectionStorage({ ...empty, decision: { action: 'watch' }, enrollment: { id: 'e1', state: 'superseded' } }),
    opportunityId: 'opp-1',
  }), { owned: true, reason: 'pursue_owns_opportunity' }, 'any returned enrollment owns the deal');

  for (const state of ['stopped', 'expired', 'responded', 'active']) {
    assert.deepEqual(await readPursueOwnership({
      storage: projectionStorage({ ...empty, decision: { action: 'pass' }, campaign: { id: 'c1', state } }),
      opportunityId: 'opp-1',
    }), { owned: true, reason: 'pursue_owns_opportunity' }, `${state} campaign still owns the deal`);
  }

  for (const action of ['watch', 'pass']) {
    assert.deepEqual(await readPursueOwnership({
      storage: projectionStorage({ ...empty, decision: { action } }), opportunityId: 'opp-1',
    }), { owned: false, reason: null }, `${action} alone is not a Pursue claim`);
  }
  assert.deepEqual(await readPursueOwnership({ storage: projectionStorage(empty), opportunityId: 'opp-1' }),
    { owned: false, reason: null });

  const unavailable = { owned: true, reason: 'pursue_authority_unavailable' };
  assert.deepEqual(await readPursueOwnership({
    storage: { async readPursueCimProjection() { throw new Error('projection offline'); } }, opportunityId: 'opp-1',
  }), unavailable);
  for (const projection of [null, undefined, 'projection', 7, []]) {
    assert.deepEqual(await readPursueOwnership({ storage: projectionStorage(projection), opportunityId: 'opp-1' }),
      unavailable, `non-object projection ${JSON.stringify(projection)} fails closed`);
  }
  assert.deepEqual(await readPursueOwnership({ storage: {}, opportunityId: 'opp-1' }), unavailable,
    'missing projection capability fails closed');
});

test('legacy owner send refuses a pursued deal with 409 pursue_owns_opportunity and zero provider calls', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'pursue');

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'pursued-owner-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pursue_owns_opportunity');
  assert.equal(result.error, refusalCopy);
  assert.equal(result.providerAttempted, undefined);
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 0);
  assert.equal(await storage.getDealHunterCimOpportunityClaim(deal.opportunityId), null,
    'the pre-claim check leaves no legacy claim that would block the Pursue campaign');
});

test('legacy owner send refuses an ended campaign and a projection read failure', async (t) => {
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  for (const [label, projection, code] of [
    ['stopped campaign', async () => ({ decision: { action: 'pass' }, enrollment: null, campaign: { id: 'c1', state: 'stopped' } }), 'pursue_owns_opportunity'],
    ['projection failure', async () => { throw new Error('projection offline'); }, 'pursue_authority_unavailable'],
  ]) {
    await t.test(label, async (st) => {
      providerCalls = [];
      const { storage } = testStorage(st);
      const deal = await reviewedDeal(storage);
      storage.readPursueCimProjection = projection;
      const result = await sendDealHunterCimRequest({
        dealKey: deal.dealKey,
        snapshotToken: deal.cimRequest.snapshotToken,
        requestedBy: 'ended-campaign-admin',
        storage,
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 409);
      assert.equal(result.code, code);
      assert.equal(result.error, refusalCopy);
      assert.equal(providerCalls.length, 0);
      assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
      assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 0);
    });
  }
});

test('bulk send-ready refuses a pursued deal per item with 409 and the owner copy', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { sendDealHunterReadyCimRequests } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'pursue');

  const result = await sendDealHunterReadyCimRequests({
    requestedBy: 'bulk-admin',
    selections: [{
      dealKey: deal.dealKey,
      recipientEmail: deal.cimRequest.recipientEmail,
      snapshotToken: deal.cimRequest.snapshotToken,
    }],
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pursue_owns_opportunity');
  assert.equal(result.error, refusalCopy);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 409);
  assert.equal(result.results[0].code, 'pursue_owns_opportunity');
  assert.equal(result.results[0].error, refusalCopy);
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
});

test('broker-materials approve refuses a pursued deal with 409 and the owner copy', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const deal = await reviewedDeal(storage);
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: deal.opportunityId,
    scored_at: new Date().toISOString(),
    deal_key: deal.dealKey,
    name: deal.name,
    state: deal.state || '',
    listing_url: deal.listingUrl || '',
    fit_score: 70,
    score_status: 'watchlist',
    confidence: 'medium',
    completeness_score: 70,
    contradiction_count: 0,
    missing_evidence_count: 0,
    should_remove: false,
    high_fit: false,
    gate_count: 0,
    score_fingerprint: `guard-score-${deal.opportunityId}`,
    semantic_digest: `guard-semantic-${deal.opportunityId}`,
    engine_version: 'pursue-guard-test',
    rules_version: 'pursue-guard-test',
    profile_version: 'pursue-guard-test',
    completeness_policy_version: 'pursue-guard-test',
    dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
  }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([deal.opportunityId]);
  const { setTriageOperatorDecision } = await import('../server/services/dealHunterTriage.js');
  const priority = await setTriageOperatorDecision({
    opportunityId: deal.opportunityId, priority: 'high', markReviewed: true, actor: 'guard-admin', storage,
  });
  assert.equal(priority.ok, true, priority.error);
  const {
    approveDealHunterBrokerMaterials,
    loadBrokerMaterialsAuthority,
    prepareDealHunterBrokerMaterials,
  } = await import('../server/services/dealHunterBrokerMaterials.js');
  const session = { principal_id: 'guard-principal-1', role: 'admin', username: 'guard-admin' };
  const authority = await loadBrokerMaterialsAuthority({ opportunityId: deal.opportunityId, storage });
  const recipient = authority.recipientOptions.find((option) => option.email === deal.brokerEmail)
    || authority.recipientOptions[0];
  assert.ok(recipient, 'fixture must expose an authoritative recipient');
  const preparation = await prepareDealHunterBrokerMaterials({
    opportunityId: deal.opportunityId, recipientContactRef: recipient.recipientContactRef,
    greeting: 'Hello Erin,', session, storage,
  });
  assert.equal(preparation.success, true, preparation.error);
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'pursue');

  const result = await approveDealHunterBrokerMaterials({
    opportunityId: preparation.review.opportunity.canonicalOpportunityId,
    preparationToken: preparation.preparationToken,
    approvedProposalDigest: preparation.proposalDigest,
    session,
    storage,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pursue_owns_opportunity');
  assert.equal(result.error, refusalCopy);
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ opportunityIds: [deal.opportunityId], limit: 100 })).length, 0);
});

test('legacy owner send proceeds for an unpursued deal', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'watch');

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'unpursued-owner-admin',
    storage,
  });

  // The legacy CIM provider is hard-off in this release, so "proceeds" means the
  // send reached the provider boundary with its exact communication persisted.
  assert.notEqual(result.code, 'pursue_owns_opportunity');
  assert.equal(result.providerAttempted, true);
  assert.ok(result.request?.id);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 1);
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 1);
});

test('corrected-recipient retry of a bounced legacy request refuses a now-pursued deal', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { retryDealHunterCimRequestWithCorrectedRecipient } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const original = await scheduledLegacyRequest(storage, deal);
  await storage.upsertDealHunterCimRequest({
    ...(await storage.getDealHunterCimRequestById(original.id)),
    status: 'delivery_issue',
    delivery_state: 'bounced',
    follow_up_state: 'stopped',
    next_follow_up_at: null,
    updated_at: new Date().toISOString(),
  });
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'pursue');
  const requestsBefore = await storage.listDealHunterCimRequests({ opportunityIds: [deal.opportunityId], limit: 100 });

  const result = await retryDealHunterCimRequestWithCorrectedRecipient({
    requestId: original.id,
    newRecipientEmail: 'alex@example.com',
    confirmed: true,
    overrideReason: 'Bounced broker address corrected by the owner.',
    requestedBy: 'retry-admin',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pursue_owns_opportunity');
  assert.equal(result.error, refusalCopy);
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ opportunityIds: [deal.opportunityId], limit: 100 })).length,
    requestsBefore.length);
});

test('legacy follow-up runner skips a pursued deal with reason pursue_owns_opportunity', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { runDealHunterCimFollowUps } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const request = await scheduledLegacyRequest(storage, deal);
  const communicationsBefore = (await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total;
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'pursue');

  const result = await runDealHunterCimFollowUps({ storage, now: new Date(), settings: followUpSettings });

  assert.equal(result.reviewed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].status, 'skipped');
  assert.equal(result.results[0].reason, 'pursue_owns_opportunity');
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, communicationsBefore,
    'no follow-up communication was prepared');
  const after = await storage.getDealHunterCimRequestById(request.id);
  assert.equal(after.follow_up_count || 0, 0);
  assert.equal(after.follow_up_state, 'scheduled', 'the legacy request is skipped, not mutated');
});

test('legacy follow-up runner still attempts an unpursued deal', async (t) => {
  const { storage } = testStorage(t);
  const { runDealHunterCimFollowUps } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  await scheduledLegacyRequest(storage, deal);
  const communicationsBefore = (await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total;

  const result = await runDealHunterCimFollowUps({ storage, now: new Date(), settings: followUpSettings });

  assert.equal(result.reviewed, 1);
  assert.equal(result.skipped, 0);
  assert.notEqual(result.results[0].reason, 'pursue_owns_opportunity');
  assert.ok((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total > communicationsBefore,
    'the unpursued follow-up reached the provider boundary with a prepared communication');
});

test('an untrusted manual follow-up context is still rejected before any Pursue projection read', async () => {
  // The approved branch must reject forged contexts before touching storage;
  // the trusted-context refusal is covered by the manual follow-up approve test.
  const { executeDealHunterCimFollowUpRequest } = await import('../server/services/dealHunter.js');
  let projectionReads = 0;
  const result = await executeDealHunterCimFollowUpRequest({
    storage: {
      async readPursueCimProjection() {
        projectionReads += 1;
        return { decision: { action: 'pursue' }, enrollment: null, campaign: null };
      },
    },
    request: {
      id: 'manual-request-1',
      opportunity_id: 'opp-manual-pursued',
      recipient_email: 'broker@example.test',
      metadata: { manualFollowUp: { mode: 'operator-approved' } },
    },
    now: new Date(),
    approvedContext: { type: 'untrusted-context' },
  });
  assert.equal(result.status, 'approval-required');
  assert.equal(projectionReads, 0);
  assert.equal(providerCalls.length, 0);
});

test('Stage 2 skips a pursued candidate', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { runCimStage2Automation } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  recordOwnerDecisionRow(sqlitePath, deal.opportunityId, 'pursue');

  const shadow = await runCimStage2Automation({ mode: 'shadow', triggeredBy: 'pursue-guard-test', storage });
  const decisions = await storage.listCimStage2Decisions({ runId: shadow.run.id, limit: 100 });
  const decision = decisions.find((item) => item.opportunity_id === deal.opportunityId);

  assert.equal(shadow.providerCalls, 0);
  assert.ok(decision, 'the pursued opportunity keeps a durable run item');
  assert.equal(decision.decision_state, 'blocked');
  assert.ok(decision.reasons.includes('pursue_owns_opportunity'), JSON.stringify(decision.reasons));
  assert.equal(shadow.run.blockedCounts.pursue_owns_opportunity, 1);
  assert.equal(providerCalls.length, 0);
});

test('Stage 2 projection reads run at most ten at a time and keep their order', async () => {
  const { mapInChunks, STAGE2_PROJECTION_READ_CONCURRENCY } = await import('../server/services/dealHunter.js');
  assert.equal(STAGE2_PROJECTION_READ_CONCURRENCY, 10);
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 37 }, (_, index) => index);
  const results = await mapInChunks(items, STAGE2_PROJECTION_READ_CONCURRENCY, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return item * 2;
  });
  assert.equal(peak, 10);
  assert.deepEqual(results, items.map((item) => item * 2));
  assert.deepEqual(await mapInChunks([], 10, async () => 1), []);
});

test('Stage 2 does not add a Pursue reason for an unpursued candidate', async (t) => {
  const { storage } = testStorage(t);
  const { runCimStage2Automation } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);

  const shadow = await runCimStage2Automation({ mode: 'shadow', triggeredBy: 'pursue-guard-test', storage });
  const decisions = await storage.listCimStage2Decisions({ runId: shadow.run.id, limit: 100 });
  const decision = decisions.find((item) => item.opportunity_id === deal.opportunityId);

  assert.ok(decision);
  assert.equal(decision.reasons.includes('pursue_owns_opportunity'), false);
  assert.equal(decision.reasons.includes('pursue_authority_unavailable'), false);
});

test('race: Pursue decision recorded after legacy pre-checks but before claim is caught by the post-claim re-check', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const claimDealHunterCimOpportunity = storage.claimDealHunterCimOpportunity.bind(storage);
  let claimed = null;
  storage.claimDealHunterCimOpportunity = async (command) => {
    const result = await claimDealHunterCimOpportunity(command);
    claimed = { command, result };
    recordOwnerDecisionRow(sqlitePath, command.opportunityId, 'pursue');
    return result;
  };

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'race-admin',
    storage,
  });

  assert.equal(claimed?.result?.claimed, true, 'the legacy side reached and won its opportunity claim');
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pursue_owns_opportunity');
  assert.equal(result.error, refusalCopy);
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0,
    'no legacy request row was written');
  assert.equal((await storage.listCrmCommunications({ page: 1, pageSize: 25 })).total, 0,
    'no outbound communication was prepared');
  assert.equal(await storage.getDealHunterCimRecipientClaim(claimed.command.recipientEmail), null,
    'the durable recipient claim is released');
  assert.equal(await storage.getDealHunterCimOpportunityClaim(deal.opportunityId), null,
    'the legacy opportunity claim taken in the race is released');
  assert.deepEqual(pursueLifecycleLegacyEvidence(sqlitePath, deal.opportunityId), { priorRequest: false, priorClaim: false },
    'Pursue\'s lifecycle_conflict check no longer sees any legacy request or claim');
});

test('race refusal still refuses when releasing the legacy opportunity claim fails', async (t) => {
  const { storage, sqlitePath } = testStorage(t);
  const { sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  const deal = await reviewedDeal(storage);
  const claimDealHunterCimOpportunity = storage.claimDealHunterCimOpportunity.bind(storage);
  storage.claimDealHunterCimOpportunity = async (command) => {
    const result = await claimDealHunterCimOpportunity(command);
    recordOwnerDecisionRow(sqlitePath, command.opportunityId, 'pursue');
    return result;
  };
  let releaseAttempts = 0;
  storage.releaseDealHunterCimOpportunityClaim = async () => {
    releaseAttempts += 1;
    throw new Error('release storage offline');
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  let result;
  try {
    result = await sendDealHunterCimRequest({
      dealKey: deal.dealKey,
      snapshotToken: deal.cimRequest.snapshotToken,
      requestedBy: 'race-release-failure-admin',
      storage,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(releaseAttempts, 1);
  assert.ok(warnings.some((message) => /opportunity claim release after Pursue refusal failed/.test(message)));
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pursue_owns_opportunity');
  assert.equal(result.error, refusalCopy);
  assert.equal(providerCalls.length, 0);
  assert.equal((await storage.listDealHunterCimRequests({ dealKeys: [deal.dealKey], limit: 100 })).length, 0);
});

test('SQLite opportunity-claim release deletes only an exact claim with no request row', async (t) => {
  const { storage } = testStorage(t);
  const deal = await reviewedDeal(storage);
  const nowIso = new Date().toISOString();
  const claim = (requestId) => storage.claimDealHunterCimOpportunity({
    opportunityId: deal.opportunityId, requestId, recipientEmail: 'erin@example.com', nowIso, metadata: {},
  });

  assert.equal((await claim('release-request-1')).claimed, true);
  assert.deepEqual(await storage.releaseDealHunterCimOpportunityClaim({
    opportunityId: deal.opportunityId, requestId: 'other-request' }), { released: false });
  assert.deepEqual(await storage.releaseDealHunterCimOpportunityClaim({
    opportunityId: 'other-opportunity', requestId: 'release-request-1' }), { released: false });
  assert.deepEqual(await storage.releaseDealHunterCimOpportunityClaim({ opportunityId: deal.opportunityId }),
    { released: false });
  assert.ok(await storage.getDealHunterCimOpportunityClaim(deal.opportunityId));
  assert.deepEqual(await storage.releaseDealHunterCimOpportunityClaim({
    opportunityId: deal.opportunityId, requestId: 'release-request-1' }), { released: true });
  assert.equal(await storage.getDealHunterCimOpportunityClaim(deal.opportunityId), null);

  const initial = await scheduledLegacyRequest(storage, deal);
  const durableClaim = await storage.getDealHunterCimOpportunityClaim(deal.opportunityId);
  assert.equal(durableClaim?.request_id, initial.id);
  assert.deepEqual(await storage.releaseDealHunterCimOpportunityClaim({
    opportunityId: deal.opportunityId, requestId: initial.id }), { released: false },
  'a claim backing a durable request row is never released');
  assert.equal((await storage.getDealHunterCimOpportunityClaim(deal.opportunityId))?.request_id, initial.id);
});
