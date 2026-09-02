import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
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
const sqlitePaths = new WeakMap();
const sqliteWorkerUrl = new URL('./fixtures/dealHunterManualFollowUpSqliteWorker.js', import.meta.url);

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

function outboundCommunication({ requestId, submissionId, followUpNumber, deliveryState, occurredAt, id: suppliedId = '' }) {
  const id = suppliedId || buildManualFollowUpCommunicationId({ requestId, followUpNumber });
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
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const storage = createSqliteStorage({
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  });
  sqlitePaths.set(storage, sqlitePath);
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return storage;
}

function writeOutboxProof(storage, {
  communicationId,
  submissionId,
  requestId,
  state,
  occurredAt,
} = {}) {
  const database = new Database(sqlitePaths.get(storage));
  try {
    database.prepare(`
      INSERT INTO crm_email_outbox (
        id, communication_id, submission_id, cim_request_id, idempotency_key,
        client_request_key, state, provider, provider_message_id, attempt_count,
        next_attempt_at, accepted_at, ambiguous_at, expected_submission_version,
        actor, created_at, updated_at, metadata
      ) VALUES (
        @id, @communication_id, @submission_id, @cim_request_id, @idempotency_key,
        @client_request_key, @state, 'resend', @provider_message_id, 1,
        NULL, @accepted_at, @ambiguous_at, @expected_submission_version,
        'storage-admin', @occurred_at, @occurred_at, '{}'
      )
      ON CONFLICT(communication_id) DO UPDATE SET
        state = excluded.state,
        provider_message_id = excluded.provider_message_id,
        accepted_at = excluded.accepted_at,
        ambiguous_at = excluded.ambiguous_at,
        updated_at = excluded.updated_at
    `).run({
      id: `outbox-${communicationId}`,
      communication_id: communicationId,
      submission_id: submissionId,
      cim_request_id: requestId,
      idempotency_key: `outbox-key-${communicationId}`,
      client_request_key: `outbox-client-${communicationId}`,
      state,
      provider_message_id: state === 'accepted' ? `provider-${communicationId}` : null,
      accepted_at: state === 'accepted' ? occurredAt : null,
      ambiguous_at: state === 'ambiguous' ? occurredAt : null,
      expected_submission_version: initialAt,
      occurred_at: occurredAt,
    });
  } finally {
    database.close();
  }
}

function waitForWorkerMessage(worker, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for SQLite worker ${worker.pid}.`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`SQLite worker ${worker.pid} exited before its expected message (${code ?? signal}).`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('exit', onExit);
  });
}

async function runOverlappingSqlitePair({ sqlitePath, operation, input }) {
  const argumentsList = [sqlitePath, operation, JSON.stringify(input)];
  const workers = [
    fork(sqliteWorkerUrl, argumentsList, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
    fork(sqliteWorkerUrl, argumentsList, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }),
  ];
  const trace = [];
  const errors = [];
  let blocker = null;
  for (const worker of workers) {
    worker.stderr.on('data', (chunk) => errors.push(chunk.toString()));
    worker.on('message', (message) => trace.push({ worker: worker.pid, phase: message.phase }));
  }
  try {
    await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, ({ phase }) => phase === 'ready')));
    blocker = new Database(sqlitePath);
    blocker.exec('BEGIN IMMEDIATE');
    trace.push({ worker: 'parent', phase: 'blocker-held' });
    const attempts = workers.map((worker) => waitForWorkerMessage(worker, ({ phase }) => phase === 'attempting'));
    for (const worker of workers) worker.send('go');
    await Promise.all(attempts);
    assert.equal(trace.filter(({ phase }) => phase === 'attempting').length, 2);
    assert.equal(trace.some(({ phase }) => phase === 'result'), false, 'neither writer may finish while the blocker owns BEGIN IMMEDIATE');
    const completions = workers.map((worker) => waitForWorkerMessage(
      worker,
      ({ phase }) => ['result', 'error'].includes(phase),
    ));
    blocker.exec('COMMIT');
    blocker.close();
    blocker = null;
    trace.push({ worker: 'parent', phase: 'blocker-released' });
    const messages = await Promise.all(completions);
    for (const message of messages) {
      assert.equal(message.phase, 'result', message.error || errors.join('\n'));
    }
    return { results: messages.map(({ result }) => result), trace };
  } finally {
    if (blocker?.inTransaction) blocker.exec('ROLLBACK');
    blocker?.close();
    for (const worker of workers) {
      if (worker.connected) worker.disconnect();
      if (worker.exitCode === null) worker.kill();
    }
  }
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

test('SQLite manual follow-up start accepts only the canonical server-owned marker', async (t) => {
  // Break caught: caller JSON can seed or replace policy/audit authority during
  // enrollment instead of being validated and reconstructed canonically.
  const storage = createStorage(t, 'manual-start-marker-authority');
  const canonical = marker();
  const invalidMarkers = [
    ['missing-version', Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== 'version'))],
    ['missing-cadence', Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== 'cadencePolicy'))],
    ['string-maximum', { ...canonical, maximumFollowUps: '5' }],
    ['malformed-enrolled-at', { ...canonical, enrolledAt: 'not-an-instant' }],
    ['blank-enrolled-by', { ...canonical, enrolledBy: '   ' }],
    ['seeded-accepted-touches', { ...canonical, acceptedTouches: [{ followUpNumber: 1 }] }],
    ['seeded-stop', { ...canonical, stoppedAt: enrolledAt }],
    ['unknown-field', { ...canonical, callerAuthority: true }],
    ['array-marker', [canonical]],
    ['primitive-marker', 'operator-approved'],
  ];

  for (const [name, suppliedMarker] of invalidMarkers) {
    const seeded = await seed(storage, `strict-marker-${name}`);
    const result = await storage.startDealHunterManualFollowUps({
      requestId: seeded.request.id,
      expectedRequestUpdatedAt: seeded.request.updated_at,
      expectedSubmissionId: seeded.submission.id,
      expectedSubmissionUpdatedAt: seeded.submission.updated_at,
      marker: suppliedMarker,
      nextFollowUpAt: firstDueAt,
      activity: activity(`strict-marker-${name}`, seeded.submission.id, enrolledAt, 'cim.manual-follow-ups-enrolled'),
    });
    assert.equal(result.applied, false, name);
    const unchanged = await storage.getDealHunterCimRequestById(seeded.request.id);
    assert.equal(unchanged.updated_at, seeded.request.updated_at, name);
    assert.equal(unchanged.follow_up_state, 'not-scheduled', name);
    assert.equal(Object.hasOwn(unchanged.metadata, 'manualFollowUp'), false, name);
  }

  assert.equal((await storage.listCrmActivityEvents({ limit: 100 })).length, 0);
});

test('SQLite approved claim rejects a partial operator-approved marker', async (t) => {
  // Break caught: a mode-only or partial marker becomes durable Phase 3 claim
  // authority even though it was never canonically enrolled.
  const storage = createStorage(t, 'manual-claim-partial-marker');
  const seeded = await seed(storage, 'claim-partial-marker', {
    requestOverrides: {
      follow_up_state: 'scheduled',
      next_follow_up_at: firstDueAt,
      metadata: {
        manualApproval: { followUpPolicy: 'none' },
        manualFollowUp: { mode: 'operator-approved', maximumFollowUps: 5 },
      },
    },
  });
  const result = await storage.claimDealHunterApprovedFollowUp({
    requestId: seeded.request.id,
    expectedRequestUpdatedAt: seeded.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    expectedFollowUpCount: 0,
    expectedFollowUpNumber: 1,
    expectedNextFollowUpAt: firstDueAt,
    claimedAt: firstDueAt,
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'claim-ineligible');
  assert.equal((await storage.getDealHunterCimRequestById(seeded.request.id)).status, 'sent');
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
  const longReason = `  ${'operator \n requested\t stop   '.repeat(40)}  `;
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
  const expectedStopReason = 'operator requested stop operator requested stop operator requested stop operator requested stop operator requested stop '
    + 'operator requested stop operator requested stop operator requested stop operator requested stop operator requested stop ';
  assert.equal(stopped.request.metadata.manualFollowUp.stopReason.length, 240);
  assert.equal(stopped.request.metadata.manualFollowUp.stopReason, expectedStopReason);
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

test('SQLite ambiguity proof rejects a timestamp that does not exactly match durable communication authority', async (t) => {
  // Break caught: callers can currently choose any parseable ambiguity time,
  // including on the duplicate/idempotent path.
  const storage = createStorage(t, 'ambiguity-timestamp');
  const seeded = await seed(storage, 'ambiguity-timestamp');
  const ambiguousAt = '2026-09-01T18:00:00.000Z';
  const communication = outboundCommunication({
    requestId: seeded.request.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'ambiguous',
    occurredAt: ambiguousAt,
  });
  await storage.insertCrmCommunication(communication);
  const input = {
    requestId: seeded.request.id,
    submissionId: seeded.submission.id,
    communicationId: communication.id,
    idempotencyKey: communication.idempotency_key,
    actor: 'storage-admin',
    ambiguousAt,
    error: 'provider result unknown',
  };
  assert.equal(await storage.recordDealHunterManualFollowUpAmbiguity({
    ...input,
    ambiguousAt: '2026-09-01T18:00:01.000Z',
  }), null);
  assert.equal((await storage.listCrmEmailOutbox({ submissionId: seeded.submission.id, states: ['ambiguous'] })).length, 0);

  const first = await storage.recordDealHunterManualFollowUpAmbiguity(input);
  assert.equal(first.state, 'ambiguous');
  assert.equal(first.ambiguous_at, ambiguousAt);
  assert.deepEqual(await storage.recordDealHunterManualFollowUpAmbiguity(input), first);
  assert.equal(await storage.recordDealHunterManualFollowUpAmbiguity({
    ...input,
    ambiguousAt: '2026-09-01T18:00:02.000Z',
  }), null);
  assert.equal(await storage.recordDealHunterManualFollowUpAmbiguity({
    ...input,
    idempotencyKey: 'wrong-provider-idempotency-key',
  }), null);
  assert.equal((await storage.listCrmEmailOutbox({ submissionId: seeded.submission.id, states: ['ambiguous'] })).length, 1);
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

test('SQLite accepted finalization rejects a noncanonical communication ID without mutation', async (t) => {
  // Break caught: any communication sharing request/submission/N can be
  // counted even when it is not the deterministic logical Follow-Up N.
  const storage = createStorage(t, 'accepted-wrong-communication');
  const seeded = await seed(storage, 'accepted-wrong-communication');
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
  const acceptedAt = '2026-09-01T17:05:00.000Z';
  const wrongCommunication = outboundCommunication({
    requestId: started.request.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'accepted',
    occurredAt: acceptedAt,
    id: 'not-the-deterministic-sha256-identity',
  });
  await storage.insertCrmCommunication(wrongCommunication);
  const result = await storage.finalizeDealHunterApprovedFollowUp({
    requestId: started.request.id,
    expectedRequestUpdatedAt: claimed.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedFollowUpNumber: 1,
    expectedCommunicationId: wrongCommunication.id,
    outcome: 'accepted',
    acceptedAt,
    nextFollowUpAt: '2026-09-03T16:00:00.000Z',
    activity: activity('wrong-communication-accepted', seeded.submission.id, acceptedAt, 'cim.follow-up-accepted'),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'finalize-ineligible');
  const unchanged = await storage.getDealHunterCimRequestById(started.request.id);
  assert.equal(unchanged.updated_at, claimed.request.updated_at);
  assert.equal(unchanged.follow_up_count, 0);
  assert.equal(unchanged.last_follow_up_at, null);
  assert.equal(unchanged.next_follow_up_at, firstDueAt);
  assert.deepEqual(unchanged.metadata.manualFollowUp.acceptedTouches || [], []);
  assert.deepEqual(
    (await storage.listCrmActivityEvents({ submissionId: seeded.submission.id })).map(({ id }) => id),
    ['start-request-accepted-wrong-communication'],
  );
});

test('SQLite accepted finalization derives Pacific cadence from acceptedAt and rejects a wrong assertion', async (t) => {
  // Break caught: a caller can persist an arbitrary next due unrelated to the
  // provider acceptance instant.
  const cases = [
    {
      name: 'thursday',
      acceptedAt: '2026-09-03T23:37:00.000Z',
      wrongDueAt: '2026-09-07T17:00:00.000Z',
      expectedDueAt: '2026-09-07T16:00:00.000Z',
    },
    {
      name: 'friday',
      acceptedAt: '2026-09-04T20:00:00.000Z',
      wrongDueAt: '2026-09-08T16:00:00.000Z',
      expectedDueAt: '2026-09-07T16:00:00.000Z',
    },
    {
      name: 'spring-dst',
      acceptedAt: '2026-03-06T20:00:00.000Z',
      wrongDueAt: '2026-03-09T17:00:00.000Z',
      expectedDueAt: '2026-03-09T16:00:00.000Z',
    },
    {
      name: 'fall-dst',
      acceptedAt: '2026-10-30T20:00:00.000Z',
      wrongDueAt: '2026-11-02T16:00:00.000Z',
      expectedDueAt: '2026-11-02T17:00:00.000Z',
    },
  ];

  for (const probe of cases) {
    const storage = createStorage(t, `accepted-cadence-${probe.name}`);
    const seeded = await seed(storage, `accepted-cadence-${probe.name}`);
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
    const communication = outboundCommunication({
      requestId: started.request.id,
      submissionId: seeded.submission.id,
      followUpNumber: 1,
      deliveryState: 'accepted',
      occurredAt: probe.acceptedAt,
    });
    await storage.insertCrmCommunication(communication);
    const base = {
      requestId: started.request.id,
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedSubmissionId: seeded.submission.id,
      expectedFollowUpNumber: 1,
      expectedCommunicationId: communication.id,
      outcome: 'accepted',
      acceptedAt: probe.acceptedAt,
      activity: activity(`accepted-cadence-${probe.name}`, seeded.submission.id, probe.acceptedAt, 'cim.follow-up-accepted'),
    };
    const wrong = await storage.finalizeDealHunterApprovedFollowUp({ ...base, nextFollowUpAt: probe.wrongDueAt });
    assert.equal(wrong.applied, false, `${probe.name} wrong assertion`);
    const unchanged = await storage.getDealHunterCimRequestById(started.request.id);
    assert.equal(unchanged.follow_up_count, 0, probe.name);
    assert.equal(unchanged.updated_at, claimed.request.updated_at, probe.name);

    const correct = await storage.finalizeDealHunterApprovedFollowUp({ ...base, nextFollowUpAt: probe.expectedDueAt });
    assert.equal(correct.applied, true, `${probe.name} correct assertion`);
    assert.equal(correct.request.last_follow_up_at, probe.acceptedAt, probe.name);
    assert.equal(correct.request.next_follow_up_at, probe.expectedDueAt, probe.name);
  }
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
    deliveryState: 'not-attempted',
    occurredAt: ambiguousAt,
  });
  await storage.insertCrmCommunication(exactCommunication);
  writeOutboxProof(storage, {
    communicationId: exactCommunication.id,
    submissionId: seeded.submission.id,
    requestId: started.request.id,
    state: 'ambiguous',
    occurredAt: ambiguousAt,
  });
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
    provider_message_id: 'provider-ambiguity-reconciled',
    delivery_state: 'accepted',
    delivery_state_at: '2026-09-01T17:06:00.000Z',
    updated_at: '2026-09-01T17:06:00.000Z',
  });
  writeOutboxProof(storage, {
    communicationId: exactCommunication.id,
    submissionId: seeded.submission.id,
    requestId: started.request.id,
    state: 'accepted',
    occurredAt: '2026-09-01T17:06:00.000Z',
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

test('SQLite independent processes overlap Start claim and accepted finalization with one logical winner', async (t) => {
  // Break caught: a sequential Promise.all test can stay green even if two
  // genuinely contending SQLite writers duplicate activity or accepted count.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-manual-concurrency-'));
  const sqlitePath = path.join(tempDir, 'crm.sqlite');
  const config = {
    storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 },
  };
  const storage = createSqliteStorage(config);
  t.after(() => {
    storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const seeded = await seed(storage, 'concurrency');
  const startInput = {
    requestId: seeded.request.id,
    expectedRequestUpdatedAt: seeded.request.updated_at,
    expectedSubmissionId: seeded.submission.id,
    expectedSubmissionUpdatedAt: seeded.submission.updated_at,
    marker: marker(),
    nextFollowUpAt: firstDueAt,
    activity: activity('concurrent-start', seeded.submission.id, enrolledAt, 'cim.manual-follow-ups-enrolled'),
  };
  const startRace = await runOverlappingSqlitePair({ sqlitePath, operation: 'startDealHunterManualFollowUps', input: startInput });
  assert.equal(startRace.trace.filter(({ phase }) => phase === 'ready').length, 2);
  assert.equal(startRace.trace.filter(({ phase }) => phase === 'attempting').length, 2);
  assert.equal(startRace.trace.some(({ phase }) => phase === 'blocker-held'), true);
  assert.equal(startRace.results.filter((result) => result.applied).length, 1);
  const started = await storage.getDealHunterCimRequestById(seeded.request.id);
  assert.equal((await storage.listCrmActivityEvents({ submissionId: seeded.submission.id })).length, 1);

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
  const claimRace = await runOverlappingSqlitePair({ sqlitePath, operation: 'claimDealHunterApprovedFollowUp', input: claimInput });
  assert.equal(claimRace.trace.filter(({ phase }) => phase === 'attempting').length, 2);
  assert.equal(claimRace.results.filter((result) => result.applied).length, 1);
  const claimed = await storage.getDealHunterCimRequestById(started.id);
  const acceptedAt = '2026-09-01T17:05:00.000Z';
  const exactCommunication = outboundCommunication({
    requestId: started.id,
    submissionId: seeded.submission.id,
    followUpNumber: 1,
    deliveryState: 'accepted',
    occurredAt: acceptedAt,
  });
  await storage.insertCrmCommunication(exactCommunication);
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
  const finalizeRace = await runOverlappingSqlitePair({
    sqlitePath,
    operation: 'finalizeDealHunterApprovedFollowUp',
    input: finalizeInput,
  });
  assert.equal(finalizeRace.trace.filter(({ phase }) => phase === 'attempting').length, 2);
  assert.equal(finalizeRace.results.filter((result) => result.applied).length, 1);
  assert.equal(finalizeRace.results.filter((result) => result.alreadyFinalized).length, 1);
  const accepted = await storage.getDealHunterCimRequestById(started.id);
  assert.equal(accepted.follow_up_count, 1);
  assert.equal(accepted.metadata.manualFollowUp.acceptedTouches.length, 1);
  const activities = await storage.listCrmActivityEvents({ submissionId: seeded.submission.id });
  assert.deepEqual(
    activities.map((event) => event.id).sort(),
    ['concurrent-accepted', 'concurrent-start'],
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
