import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildManualFollowUpCommunicationId,
  buildManualFollowUpMarker,
  nextManualFollowUpAt,
} from '../server/services/dealHunterManualFollowUpPolicy.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

const initialAt = '2026-08-28T18:00:00.000Z';
const enrolledAt = '2026-09-01T16:00:00.000Z';
const firstDueAt = '2026-09-01T17:00:00.000Z';

function submission(id, overrides = {}) {
  return {
    id,
    created_at: initialAt,
    updated_at: initialAt,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'manual-follow-up-storage-test',
    ip_hash: '',
    user_agent: '',
    name: `Contact ${id}`,
    email: `${id}@example.test`,
    phone: '',
    company: `Company ${id}`,
    role: 'Broker',
    message: 'Storage contract test.',
    status_updated_at: initialAt,
    listing_url: `https://example.test/${id}`,
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: 'Storage Broker',
    broker_email: `${id}-broker@example.test`,
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
    metadata: {},
    ...overrides,
  };
}

function request(id, submissionId, overrides = {}) {
  return {
    id,
    created_at: initialAt,
    updated_at: initialAt,
    opportunity_id: `opportunity-${id}`,
    deal_key: `deal-${id}`,
    recipient_email: `${id}-broker@example.test`,
    requested_by: 'phase-2-admin',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    delivery_state_at: initialAt,
    follow_up_state: 'not-scheduled',
    first_requested_at: initialAt,
    first_provider_accepted_at: initialAt,
    submission_id: submissionId,
    follow_up_count: 0,
    last_follow_up_at: null,
    next_follow_up_at: null,
    metadata: {
      manualApproval: {
        approvedAt: initialAt,
        approvedBy: 'phase-2-admin',
        followUpPolicy: 'none',
      },
    },
    ...overrides,
  };
}

function activity(id, submissionId, createdAt, eventType = 'cim.manual-follow-up-test') {
  return {
    id,
    submission_id: submissionId,
    created_at: createdAt,
    actor: 'storage-admin',
    role: 'admin',
    event_type: eventType,
    summary: `Manual follow-up storage event ${id}.`,
    metadata: { fixture: true },
  };
}

function outboundCommunication({ requestId, submissionId, followUpNumber, deliveryState, occurredAt }) {
  const id = buildManualFollowUpCommunicationId({ requestId, followUpNumber });
  return {
    id,
    submission_id: submissionId,
    deal_key: `deal-${requestId}`,
    cim_request_id: requestId,
    direction: 'outbound',
    channel: 'email',
    source: 'deal-hunter-cim-follow-up',
    kind: 'cim-follow-up',
    provider: 'resend',
    provider_message_id: deliveryState === 'accepted' ? `provider-${requestId}-${followUpNumber}` : null,
    source_event_id: null,
    idempotency_key: `deal-hunter-cim-${requestId}-follow-up-${followUpNumber}`,
    in_reply_to: null,
    reply_to_address: `${requestId}@reply.example.test`,
    from_address: 'team@example.test',
    to_addresses: [`${requestId}-broker@example.test`],
    cc_addresses: [],
    bcc_addresses: [],
    subject: 'Requested materials follow-up',
    body_text: `Follow-Up ${followUpNumber}`,
    body_html_sanitized: `<p>Follow-Up ${followUpNumber}</p>`,
    occurred_at: occurredAt,
    created_at: occurredAt,
    updated_at: occurredAt,
    delivery_state: deliveryState,
    delivery_state_at: occurredAt,
    content_state: 'complete',
    content_attempt_count: 1,
    content_last_error: null,
    content_next_attempt_at: null,
    attachment_metadata: [],
    assigned_at: occurredAt,
    assigned_by: 'storage-admin',
    created_by: 'storage-admin',
    updated_by: 'storage-admin',
    metadata: { followUpNumber, templateVersion: 'deal-hunter-cim-follow-up-v1' },
  };
}

function marker() {
  return buildManualFollowUpMarker({ enrolledAt, enrolledBy: 'storage-admin' });
}

function assertNormalizedResult(result) {
  assert.deepEqual(
    Object.keys(result).sort(),
    ['activity', 'alreadyFinalized', 'applied', 'reason', 'request'].sort(),
  );
  assert.equal(typeof result.applied, 'boolean');
  assert.equal(typeof result.reason, 'string');
  assert.equal(typeof result.alreadyFinalized, 'boolean');
}

function createStorage(t, prefix = 'manual-follow-up-storage') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ug-${prefix}-`));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return storage;
}

async function seed(storage, suffix, { submissionOverrides = {}, requestOverrides = {} } = {}) {
  const submissionId = `submission-${suffix}`;
  const requestId = `request-${suffix}`;
  const storedSubmission = await storage.insertSubmission(submission(submissionId, submissionOverrides));
  const storedRequest = await storage.upsertDealHunterCimRequest(request(requestId, submissionId, requestOverrides));
  return { submission: storedSubmission, request: storedRequest };
}

async function enroll(storage, seeded, suffix = seeded.request.id) {
  return storage.startDealHunterManualFollowUps({
    requestId: seeded.request.id,
    expectedRequestUpdatedAt: seeded.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    marker: marker(),
    nextFollowUpAt: firstDueAt,
    activity: activity(`start-${suffix}`, seeded.submission.id, enrolledAt, 'cim.manual-follow-ups-enrolled'),
  });
}

test('SQLite manual follow-up start atomically writes marker schedule and one activity', async (t) => {
  // Break caught: enrollment can partially update the request, replace Phase 2
  // metadata, or create duplicate/no audit activity.
  const storage = createStorage(t, 'manual-start');
  const seeded = await seed(storage, 'start');
  const result = await enroll(storage, seeded);

  assertNormalizedResult(result);
  assert.equal(result.applied, true);
  assert.equal(result.reason, '');
  assert.equal(result.request.follow_up_count, 0);
  assert.equal(result.request.follow_up_state, 'scheduled');
  assert.equal(result.request.next_follow_up_at, firstDueAt);
  assert.deepEqual(result.request.metadata.manualApproval, seeded.request.metadata.manualApproval);
  assert.deepEqual(result.request.metadata.manualFollowUp, marker());
  assert.equal(result.activity.event_type, 'cim.manual-follow-ups-enrolled');
  const activities = await storage.listCrmActivityEvents({ submissionId: seeded.submission.id });
  assert.deepEqual(activities.map((event) => event.id), ['start-request-start']);
});

test('SQLite manual follow-up start compare-and-set loses to reply pass archive materials and existing sequence', async (t) => {
  // Break caught: a stale enrollment can overwrite terminal authority or an
  // already-active sequence.
  const storage = createStorage(t, 'manual-start-cas');
  const cases = [
    ['reply', {}, { status: 'responded', request_state: 'responded', responded_at: enrolledAt }],
    ['pass', { status: 'archived', metadata: { acquisitionCommand: { decision: 'pass' } } }, {}],
    ['archive', { status: 'archived', archived_at: enrolledAt }, {}],
    ['materials', { updated_at: enrolledAt, prospectus_url: 'https://example.test/cim.pdf' }, {}],
    ['existing', {}, {
      follow_up_state: 'scheduled',
      next_follow_up_at: firstDueAt,
      metadata: { manualApproval: { followUpPolicy: 'none' }, manualFollowUp: marker() },
    }],
  ];

  for (const [name, submissionOverrides, requestOverrides] of cases) {
    const seeded = await seed(storage, `start-cas-${name}`, { submissionOverrides, requestOverrides });
    const result = await storage.startDealHunterManualFollowUps({
      requestId: seeded.request.id,
      expectedRequestUpdatedAt: initialAt,
      expectedSubmissionId: seeded.submission.id,
      expectedSubmissionUpdatedAt: initialAt,
      marker: marker(),
      nextFollowUpAt: firstDueAt,
      activity: activity(`start-cas-${name}`, seeded.submission.id, enrolledAt),
    });
    assertNormalizedResult(result);
    assert.equal(result.applied, false, name);
  }
  assert.equal((await storage.listCrmActivityEvents({ limit: 100 })).length, 0);
});

test('SQLite manual follow-up stop atomically clears schedule preserves count and history and records bounded audit', async (t) => {
  // Break caught: Stop can erase accepted history/count, leave a schedule, or
  // allow re-enrollment after the permanent stop.
  const storage = createStorage(t, 'manual-stop');
  const seeded = await seed(storage, 'stop', {
    requestOverrides: {
      follow_up_count: 2,
      last_follow_up_at: '2026-08-27T18:00:00.000Z',
      metadata: {
        manualApproval: { approvedBy: 'phase-2-admin', followUpPolicy: 'none' },
        followUps: [{ followUpNumber: 1 }, { followUpNumber: 2 }],
      },
    },
  });
  const started = await enroll(storage, seeded);
  const longReason = `  ${'operator requested stop '.repeat(40)}  `;
  const stoppedAt = '2026-09-01T18:00:00.000Z';
  const stopped = await storage.stopDealHunterManualFollowUps({
    requestId: started.request.id,
    expectedRequestUpdatedAt: started.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    stoppedAt,
    stoppedBy: 'storage-admin',
    reason: longReason,
    activity: activity('stop-sequence', seeded.submission.id, stoppedAt, 'cim.manual-follow-ups-stopped'),
  });

  assertNormalizedResult(stopped);
  assert.equal(stopped.applied, true);
  assert.equal(stopped.request.follow_up_state, 'stopped');
  assert.equal(stopped.request.next_follow_up_at, null);
  assert.equal(stopped.request.follow_up_count, 2);
  assert.deepEqual(stopped.request.metadata.followUps, [{ followUpNumber: 1 }, { followUpNumber: 2 }]);
  assert.equal(stopped.request.metadata.manualFollowUp.stoppedAt, stoppedAt);
  assert.equal(stopped.request.metadata.manualFollowUp.stoppedBy, 'storage-admin');
  assert.ok(stopped.request.metadata.manualFollowUp.stopReason.length <= 500);
  assert.equal(stopped.request.metadata.manualFollowUp.stopReason.includes('\n'), false);
  assert.equal((await storage.listCrmActivityEvents({ submissionId: seeded.submission.id })).length, 2);

  const restart = await storage.startDealHunterManualFollowUps({
    requestId: stopped.request.id,
    expectedRequestUpdatedAt: stopped.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    marker: marker(),
    nextFollowUpAt: firstDueAt,
    activity: activity('forbidden-restart', seeded.submission.id, '2026-09-01T19:00:00.000Z'),
  });
  assert.equal(restart.applied, false);

  const terminalCases = [
    ['completed', {}, { follow_up_count: 5, follow_up_state: 'completed', metadata: { manualFollowUp: marker() } }],
    ['replied', {}, {
      status: 'responded',
      request_state: 'responded',
      responded_at: enrolledAt,
      follow_up_state: 'scheduled',
      next_follow_up_at: firstDueAt,
      metadata: { manualFollowUp: marker() },
    }],
    ['archived', { status: 'archived' }, {
      follow_up_state: 'scheduled',
      next_follow_up_at: firstDueAt,
      metadata: { manualFollowUp: marker() },
    }],
  ];
  for (const [name, submissionOverrides, requestOverrides] of terminalCases) {
    const terminal = await seed(storage, `stop-${name}`, { submissionOverrides, requestOverrides });
    const rejected = await storage.stopDealHunterManualFollowUps({
      requestId: terminal.request.id,
      expectedRequestUpdatedAt: terminal.request.updated_at,
      expectedSubmissionId: terminal.submission.id,
      expectedSubmissionUpdatedAt: terminal.submission.updated_at,
      stoppedAt,
      stoppedBy: 'storage-admin',
      reason: `Must not rewrite ${name}.`,
      activity: activity(`stop-${name}-forbidden`, terminal.submission.id, stoppedAt),
    });
    assert.equal(rejected.applied, false, name);
  }
});

test('SQLite approved follow-up claim requires marker request version count number due timestamp due-now and active submission', async (t) => {
  // Break caught: a claim can authorize a stale, early, wrong-number, or
  // detached request.
  const storage = createStorage(t, 'manual-claim');
  const seeded = await seed(storage, 'claim');
  const started = await enroll(storage, seeded);
  const base = {
    requestId: started.request.id,
    expectedRequestUpdatedAt: started.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  };
  const probes = [
    { ...base, expectedRequestUpdatedAt: initialAt },
    { ...base, expectedSubmissionUpdatedAt: enrolledAt },
    { ...base, expectedFollowUpCount: 1 },
    { ...base, expectedFollowUpNumber: 2 },
    { ...base, expectedNextFollowUpAt: '2026-09-01T17:01:00.000Z' },
    { ...base, claimedAt: '2026-09-01T16:59:59.999Z' },
  ];
  for (const probe of probes) {
    const result = await storage.claimDealHunterApprovedFollowUp(probe);
    assertNormalizedResult(result);
    assert.equal(result.applied, false);
  }

  const claimed = await storage.claimDealHunterApprovedFollowUp(base);
  assert.equal(claimed.applied, true);
  assert.equal(claimed.request.status, 'follow_up_pending');
  assert.equal(claimed.request.follow_up_count, 0);
  assert.equal(claimed.activity, null);
});

test('SQLite legacy automatic claim cannot authorize an operator-approved request', async (t) => {
  // Break caught: the legacy runner claim bypasses the operator-approved
  // storage boundary when feature flags/configuration are enabled.
  const storage = createStorage(t, 'legacy-claim-guard');
  const seeded = await seed(storage, 'legacy-claim-guard');
  const started = await enroll(storage, seeded);
  const legacy = await storage.claimDealHunterCimFollowUpRequest({
    id: started.request.id,
    dueBefore: firstDueAt,
    staleBefore: '2026-09-01T16:30:00.000Z',
    nowIso: firstDueAt,
  });
  assert.equal(legacy.claimed, false);
  assert.equal(legacy.reason, 'approval-required');
  assert.equal(legacy.request.status, 'sent');
});

test('SQLite accepted finalization increments once schedules two through five and completes five without six', async (t) => {
  // Break caught: accepted touches skip/double counts, use the wrong cadence,
  // or create a sixth touch.
  const storage = createStorage(t, 'accepted-sequence');
  const seeded = await seed(storage, 'accepted-sequence');
  let current = (await enroll(storage, seeded)).request;
  let dueAt = firstDueAt;

  for (let followUpNumber = 1; followUpNumber <= 5; followUpNumber += 1) {
    const claimedAt = dueAt;
    const claimed = await storage.claimDealHunterApprovedFollowUp({
      requestId: current.id,
      expectedRequestUpdatedAt: current.updated_at,
      expectedSubmissionId: seeded.submission.id,
      expectedSubmissionUpdatedAt: seeded.submission.updated_at,
      expectedFollowUpCount: followUpNumber - 1,
      expectedFollowUpNumber: followUpNumber,
      expectedNextFollowUpAt: dueAt,
      claimedAt,
    });
    assert.equal(claimed.applied, true, `claim ${followUpNumber}`);
    const acceptedAt = new Date(Date.parse(claimedAt) + 60 * 60 * 1000).toISOString();
    const exactCommunication = outboundCommunication({
      requestId: current.id,
      submissionId: seeded.submission.id,
      followUpNumber,
      deliveryState: 'accepted',
      occurredAt: acceptedAt,
    });
    await storage.insertCrmCommunication(exactCommunication);
    const proposedNextAt = nextManualFollowUpAt(acceptedAt);
    const finalized = await storage.finalizeDealHunterApprovedFollowUp({
      requestId: current.id,
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedSubmissionId: seeded.submission.id,
      expectedFollowUpNumber: followUpNumber,
      expectedCommunicationId: exactCommunication.id,
      outcome: 'accepted',
      acceptedAt,
      nextFollowUpAt: proposedNextAt,
      activity: activity(`accepted-${followUpNumber}`, seeded.submission.id, acceptedAt, 'cim.follow-up-accepted'),
    });
    assert.equal(finalized.applied, true, `finalize ${followUpNumber}`);
    assert.equal(finalized.request.follow_up_count, followUpNumber);
    assert.equal(finalized.request.last_follow_up_at, acceptedAt);
    assert.equal(finalized.request.metadata.followUps.length, followUpNumber);
    assert.deepEqual(finalized.request.metadata.followUps.at(-1), {
      number: followUpNumber,
      attemptedAt: acceptedAt,
      acceptedAt,
      status: 'accepted',
      communicationId: exactCommunication.id,
      providerMessageId: exactCommunication.provider_message_id,
      error: '',
    });
    if (followUpNumber < 5) {
      assert.equal(finalized.request.follow_up_state, 'scheduled');
      assert.equal(finalized.request.next_follow_up_at, proposedNextAt);
      dueAt = proposedNextAt;
    } else {
      assert.equal(finalized.request.follow_up_state, 'completed');
      assert.equal(finalized.request.next_follow_up_at, null);
    }
    current = finalized.request;
  }

  const sixth = await storage.claimDealHunterApprovedFollowUp({
    requestId: current.id,
    expectedRequestUpdatedAt: current.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 5,
    expectedFollowUpNumber: 6,
    expectedNextFollowUpAt: nextManualFollowUpAt(current.last_follow_up_at),
    claimedAt: '2026-10-01T17:00:00.000Z',
  });
  assert.equal(sixth.applied, false);
  assert.equal((await storage.listCrmActivityEvents({ submissionId: seeded.submission.id })).length, 6);
});

test('SQLite accepted finalization is idempotent by communication identity and preserves concurrent terminal authority', async (t) => {
  // Break caught: reconciliation duplicates count/activity or reopens a
  // sequence after Stop wins the request-version race.
  const storage = createStorage(t, 'accepted-idempotent');
  const seeded = await seed(storage, 'accepted-idempotent');
  const started = await enroll(storage, seeded);
  const claimed = await storage.claimDealHunterApprovedFollowUp({
    requestId: started.request.id,
    expectedRequestUpdatedAt: started.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  });
  const acceptedAt = '2026-09-01T17:10:00.000Z';
  const exactCommunication = outboundCommunication({
    requestId: started.request.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'accepted',
    occurredAt: acceptedAt,
  });
  await storage.insertCrmCommunication(exactCommunication);
  const stoppedAt = '2026-09-01T17:05:00.000Z';
  const stopped = await storage.stopDealHunterManualFollowUps({
    requestId: started.request.id,
    expectedRequestUpdatedAt: claimed.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    stoppedAt,
    stoppedBy: 'storage-admin',
    reason: 'Operator stopped while provider result was in flight.',
    activity: activity('stop-in-flight', seeded.submission.id, stoppedAt, 'cim.manual-follow-ups-stopped'),
  });
  assert.equal(stopped.applied, true);
  const finalizeInput = {
    requestId: started.request.id,
    expectedRequestUpdatedAt: claimed.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'accepted',
    acceptedAt,
    nextFollowUpAt: nextManualFollowUpAt(acceptedAt),
    activity: activity('accepted-after-stop', seeded.submission.id, acceptedAt, 'cim.follow-up-accepted'),
  };
  const first = await storage.finalizeDealHunterApprovedFollowUp(finalizeInput);
  const replay = await storage.finalizeDealHunterApprovedFollowUp(finalizeInput);
  assert.equal(first.applied, true);
  assert.equal(first.request.follow_up_count, 1);
  assert.equal(first.request.follow_up_state, 'stopped');
  assert.equal(first.request.next_follow_up_at, null);
  assert.equal(replay.applied, false);
  assert.equal(replay.alreadyFinalized, true);
  assert.equal(replay.request.follow_up_count, 1);
  assert.equal((await storage.listCrmActivityEvents({ submissionId: seeded.submission.id })).length, 3);
});

test('SQLite definitive failure preserves count number exact communication and original due without automatic retry', async (t) => {
  // Break caught: a provider rejection advances the sequence, changes exact
  // identity, or invents an automatic retry schedule.
  const storage = createStorage(t, 'definitive-failure');
  const seeded = await seed(storage, 'definitive-failure');
  const started = await enroll(storage, seeded);
  const claimed = await storage.claimDealHunterApprovedFollowUp({
    requestId: started.request.id,
    expectedRequestUpdatedAt: started.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  });
  const failedAt = '2026-09-01T17:05:00.000Z';
  const exactCommunication = outboundCommunication({
    requestId: started.request.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'failed',
    occurredAt: failedAt,
  });
  await storage.insertCrmCommunication(exactCommunication);
  const failureInput = {
    requestId: started.request.id,
    expectedRequestUpdatedAt: claimed.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'definitive-failure',
    acceptedAt: null,
    nextFollowUpAt: null,
    activity: activity('definitive-failure', seeded.submission.id, failedAt, 'cim.follow-up-failed'),
  };
  const failed = await storage.finalizeDealHunterApprovedFollowUp(failureInput);
  assert.equal(failed.applied, true);
  assert.equal(failed.request.follow_up_count, 0);
  assert.equal(failed.request.follow_up_state, 'failed');
  assert.equal(failed.request.next_follow_up_at, firstDueAt);
  assert.equal(failed.request.metadata.manualFollowUp.currentAttempt.followUpNumber, 1);
  assert.equal(failed.request.metadata.manualFollowUp.currentAttempt.communicationId, exactCommunication.id);
  assert.equal(failed.request.metadata.manualFollowUp.currentAttempt.outcome, 'definitive-failure');
  const failedReplay = await storage.finalizeDealHunterApprovedFollowUp(failureInput);
  assert.equal(failedReplay.applied, false);
  assert.equal(failedReplay.alreadyFinalized, true);

  const retryClaim = await storage.claimDealHunterApprovedFollowUp({
    requestId: failed.request.id,
    expectedRequestUpdatedAt: failed.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: '2026-09-01T18:00:00.000Z',
  });
  assert.equal(retryClaim.applied, true);
});

test('SQLite ambiguity clears the schedule and cannot become retry without reconciliation authority', async (t) => {
  // Break caught: an unknown provider result remains sendable or can be
  // relabeled failed without accepted/definitive external authority.
  const storage = createStorage(t, 'ambiguity');
  const seeded = await seed(storage, 'ambiguity');
  const started = await enroll(storage, seeded);
  const claimed = await storage.claimDealHunterApprovedFollowUp({
    requestId: started.request.id,
    expectedRequestUpdatedAt: started.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  });
  const ambiguousAt = '2026-09-01T17:05:00.000Z';
  const exactCommunication = outboundCommunication({
    requestId: started.request.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'ambiguous',
    occurredAt: ambiguousAt,
  });
  await storage.insertCrmCommunication(exactCommunication);
  const ambiguityInput = {
    requestId: started.request.id,
    expectedRequestUpdatedAt: claimed.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'ambiguous',
    acceptedAt: null,
    nextFollowUpAt: null,
    activity: activity('ambiguous', seeded.submission.id, ambiguousAt, 'cim.follow-up-ambiguous'),
  };
  const ambiguous = await storage.finalizeDealHunterApprovedFollowUp(ambiguityInput);
  assert.equal(ambiguous.applied, true);
  assert.equal(ambiguous.request.follow_up_count, 0);
  assert.equal(ambiguous.request.follow_up_state, 'ambiguous');
  assert.equal(ambiguous.request.next_follow_up_at, null);
  const ambiguityReplay = await storage.finalizeDealHunterApprovedFollowUp(ambiguityInput);
  assert.equal(ambiguityReplay.applied, false);
  assert.equal(ambiguityReplay.alreadyFinalized, true);

  const retryClaim = await storage.claimDealHunterApprovedFollowUp({
    requestId: ambiguous.request.id,
    expectedRequestUpdatedAt: ambiguous.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: '2026-09-01T18:00:00.000Z',
  });
  assert.equal(retryClaim.applied, false);
  const forbiddenRelabel = await storage.finalizeDealHunterApprovedFollowUp({
    requestId: ambiguous.request.id,
    expectedRequestUpdatedAt: ambiguous.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'definitive-failure',
    acceptedAt: null,
    nextFollowUpAt: null,
    activity: activity('forbidden-relabel', seeded.submission.id, '2026-09-01T18:00:00.000Z'),
  });
  assert.equal(forbiddenRelabel.applied, false);

  await storage.updateCrmCommunication(exactCommunication.id, {
    delivery_state: 'accepted',
    delivery_state_at: '2026-09-01T17:06:00.000Z',
    updated_at: '2026-09-01T17:06:00.000Z',
  });
  const reconciled = await storage.finalizeDealHunterApprovedFollowUp({
    requestId: ambiguous.request.id,
    expectedRequestUpdatedAt: ambiguous.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'accepted',
    acceptedAt: '2026-09-01T17:06:00.000Z',
    nextFollowUpAt: nextManualFollowUpAt('2026-09-01T17:06:00.000Z'),
    activity: activity('ambiguity-reconciled', seeded.submission.id, '2026-09-01T17:06:00.000Z', 'cim.follow-up-accepted'),
  });
  assert.equal(reconciled.applied, true);
  assert.equal(reconciled.request.follow_up_count, 1);
  assert.equal(reconciled.request.follow_up_state, 'scheduled');
});

test('SQLite concurrent start stop approval finalization and accepted reconciliation converge without duplicate activity or count', async (t) => {
  // Break caught: independent SQLite connections can both linearize the same
  // sequence mutation, duplicating activity/count or reopening after Stop.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-manual-concurrency-'));
  const config = {
    storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  };
  const first = createSqliteStorage(config);
  const second = createSqliteStorage(config);
  t.after(() => {
    first.close();
    second.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const seeded = await seed(first, 'concurrency');
  const startInput = {
    requestId: seeded.request.id,
    expectedRequestUpdatedAt: seeded.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    marker: marker(),
    nextFollowUpAt: firstDueAt,
    activity: activity('concurrent-start', seeded.submission.id, enrolledAt, 'cim.manual-follow-ups-enrolled'),
  };
  const starts = await Promise.all([
    first.startDealHunterManualFollowUps(startInput),
    second.startDealHunterManualFollowUps(startInput),
  ]);
  assert.equal(starts.filter((result) => result.applied).length, 1);
  const started = starts.find((result) => result.applied).request;

  const claimInput = {
    requestId: started.id,
    expectedRequestUpdatedAt: started.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  };
  const claims = await Promise.all([
    first.claimDealHunterApprovedFollowUp(claimInput),
    second.claimDealHunterApprovedFollowUp(claimInput),
  ]);
  assert.equal(claims.filter((result) => result.applied).length, 1);
  const claimed = claims.find((result) => result.applied).request;
  const acceptedAt = '2026-09-01T17:05:00.000Z';
  const exactCommunication = outboundCommunication({
    requestId: started.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'accepted',
    occurredAt: acceptedAt,
  });
  await first.insertCrmCommunication(exactCommunication);
  const finalizeInput = {
    requestId: started.id,
    expectedRequestUpdatedAt: claimed.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'accepted',
    acceptedAt,
    nextFollowUpAt: nextManualFollowUpAt(acceptedAt),
    activity: activity('concurrent-accepted', seeded.submission.id, acceptedAt, 'cim.follow-up-accepted'),
  };
  const finalizations = await Promise.all([
    first.finalizeDealHunterApprovedFollowUp(finalizeInput),
    second.finalizeDealHunterApprovedFollowUp(finalizeInput),
  ]);
  assert.equal(finalizations.filter((result) => result.applied).length, 1);
  assert.equal(finalizations.filter((result) => result.alreadyFinalized).length, 1);
  const accepted = await first.getDealHunterCimRequestById(started.id);
  assert.equal(accepted.follow_up_count, 1);

  const stoppedAt = '2026-09-03T18:00:00.000Z';
  const stopInput = {
    requestId: accepted.id,
    expectedRequestUpdatedAt: accepted.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    stoppedAt,
    stoppedBy: 'storage-admin',
    reason: 'Concurrent stop wins.',
    activity: activity('concurrent-stop', seeded.submission.id, stoppedAt, 'cim.manual-follow-ups-stopped'),
  };
  const nextClaimInput = {
    requestId: accepted.id,
    expectedRequestUpdatedAt: accepted.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 1,
    expectedFollowUpNumber: 2,
    expectedNextFollowUpAt: accepted.next_follow_up_at,
    claimedAt: stoppedAt,
  };
  await Promise.all([
    first.stopDealHunterManualFollowUps(stopInput),
    second.claimDealHunterApprovedFollowUp(nextClaimInput),
  ]);
  const converged = await first.getDealHunterCimRequestById(started.id);
  assert.equal(converged.follow_up_count, 1);
  assert.equal(converged.follow_up_state, 'stopped');
  assert.equal(converged.next_follow_up_at, null);
  const activities = await first.listCrmActivityEvents({ submissionId: seeded.submission.id });
  assert.deepEqual(
    activities.map((event) => event.id).sort(),
    ['concurrent-accepted', 'concurrent-start', 'concurrent-stop'],
  );
});

test('SQLite and Supabase manual follow-up adapters normalize equivalent results', async (t) => {
  // Break caught: either provider adapter changes method names, RPC payloads,
  // result keys, normalized rows, or the four-operation state transitions.
  const sqlite = createStorage(t, 'provider-parity-sqlite');
  const rpcBackend = createStorage(t, 'provider-parity-rpc');
  const directSeed = await seed(sqlite, 'provider-parity');
  const rpcSeed = await seed(rpcBackend, 'provider-parity');
  assert.deepEqual(rpcSeed, directSeed);

  const client = {
    async rpc(name, parameters) {
      const methods = {
        start_deal_hunter_manual_follow_ups: () => rpcBackend.startDealHunterManualFollowUps({
          requestId: parameters.p_request_id,
          expectedRequestUpdatedAt: parameters.p_expected_request_updated_at,
          expectedSubmissionId: parameters.p_expected_submission_id,
          expectedSubmissionUpdatedAt: parameters.p_expected_submission_updated_at,
          marker: parameters.p_marker,
          nextFollowUpAt: parameters.p_next_follow_up_at,
          activity: parameters.p_activity,
        }),
        stop_deal_hunter_manual_follow_ups: () => rpcBackend.stopDealHunterManualFollowUps({
          requestId: parameters.p_request_id,
          expectedRequestUpdatedAt: parameters.p_expected_request_updated_at,
          expectedSubmissionId: parameters.p_expected_submission_id,
          expectedSubmissionUpdatedAt: parameters.p_expected_submission_updated_at,
          stoppedAt: parameters.p_stopped_at,
          stoppedBy: parameters.p_stopped_by,
          reason: parameters.p_reason,
          activity: parameters.p_activity,
        }),
        claim_deal_hunter_approved_follow_up: () => rpcBackend.claimDealHunterApprovedFollowUp({
          requestId: parameters.p_request_id,
          expectedRequestUpdatedAt: parameters.p_expected_request_updated_at,
          expectedSubmissionId: parameters.p_expected_submission_id,
          expectedSubmissionUpdatedAt: parameters.p_expected_submission_updated_at,
          expectedFollowUpCount: parameters.p_expected_follow_up_count,
          expectedFollowUpNumber: parameters.p_expected_follow_up_number,
          expectedNextFollowUpAt: parameters.p_expected_next_follow_up_at,
          claimedAt: parameters.p_claimed_at,
        }),
        finalize_deal_hunter_approved_follow_up: () => rpcBackend.finalizeDealHunterApprovedFollowUp({
          requestId: parameters.p_request_id,
          expectedRequestUpdatedAt: parameters.p_expected_request_updated_at,
          expectedSubmissionId: parameters.p_expected_submission_id,
          expectedFollowUpNumber: parameters.p_expected_follow_up_number,
          expectedCommunicationId: parameters.p_expected_communication_id,
          outcome: parameters.p_outcome,
          acceptedAt: parameters.p_accepted_at,
          nextFollowUpAt: parameters.p_next_follow_up_at,
          activity: parameters.p_activity,
        }),
      };
      assert.ok(methods[name], `unexpected RPC ${name}`);
      return { data: await methods[name](), error: null };
    },
  };
  const supabase = createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-key' } },
    { client },
  );

  const startInput = {
    requestId: directSeed.request.id,
    expectedRequestUpdatedAt: directSeed.request.updated_at,
    expectedSubmissionId: directSeed.submission.id,
    expectedSubmissionUpdatedAt: directSeed.submission.updated_at,
    marker: marker(),
    nextFollowUpAt: firstDueAt,
    activity: activity('parity-start', directSeed.submission.id, enrolledAt, 'cim.manual-follow-ups-enrolled'),
  };
  const directStart = await sqlite.startDealHunterManualFollowUps(startInput);
  const rpcStart = await supabase.startDealHunterManualFollowUps(startInput);
  assert.deepEqual(rpcStart, directStart);

  const claimInput = {
    requestId: directStart.request.id,
    expectedRequestUpdatedAt: directStart.request.updated_at,
    expectedSubmissionId: directSeed.submission.id,
    expectedSubmissionUpdatedAt: directSeed.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  };
  const directClaim = await sqlite.claimDealHunterApprovedFollowUp(claimInput);
  const rpcClaim = await supabase.claimDealHunterApprovedFollowUp(claimInput);
  assert.deepEqual(rpcClaim, directClaim);

  const acceptedAt = '2026-09-01T17:05:00.000Z';
  const exactCommunication = outboundCommunication({
    requestId: directStart.request.id,
    submissionId: directSeed.submission.id,
    followUpNumber: 1,
    deliveryState: 'accepted',
    occurredAt: acceptedAt,
  });
  await sqlite.insertCrmCommunication(exactCommunication);
  await rpcBackend.insertCrmCommunication(exactCommunication);
  const finalizeInput = {
    requestId: directStart.request.id,
    expectedRequestUpdatedAt: directClaim.request.updated_at,
    expectedSubmissionId: directSeed.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: exactCommunication.id,
    outcome: 'accepted',
    acceptedAt,
    nextFollowUpAt: nextManualFollowUpAt(acceptedAt),
    activity: activity('parity-accepted', directSeed.submission.id, acceptedAt, 'cim.follow-up-accepted'),
  };
  const directFinalize = await sqlite.finalizeDealHunterApprovedFollowUp(finalizeInput);
  const rpcFinalize = await supabase.finalizeDealHunterApprovedFollowUp(finalizeInput);
  assert.deepEqual(rpcFinalize, directFinalize);

  const stoppedAt = '2026-09-03T18:00:00.000Z';
  const stopInput = {
    requestId: directFinalize.request.id,
    expectedRequestUpdatedAt: directFinalize.request.updated_at,
    expectedSubmissionId: directSeed.submission.id,
    expectedSubmissionUpdatedAt: directSeed.submission.updated_at,
    stoppedAt,
    stoppedBy: 'storage-admin',
    reason: 'Parity stop.',
    activity: activity('parity-stop', directSeed.submission.id, stoppedAt, 'cim.manual-follow-ups-stopped'),
  };
  const directStop = await sqlite.stopDealHunterManualFollowUps(stopInput);
  const rpcStop = await supabase.stopDealHunterManualFollowUps(stopInput);
  assert.deepEqual(rpcStop, directStop);
});
