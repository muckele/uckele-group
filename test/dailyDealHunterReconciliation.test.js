import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  reconcileDailyDealHunterJob,
  writeDailyDealHunterMarker,
} from '../server/services/dailyDealHunterReconciliation.js';
import { buildDailyDealHunterEmailEnvelope } from '../server/services/dailyDealHunterDigest.js';

const businessDate = '2026-07-15';
const jobKey = `daily-deal-hunter-email:${businessDate}`;
const claimToken = 'task-three-claim-token-0001';
const providerId = 'resend-daily-001';

const canonicalEnvelope = buildDailyDealHunterEmailEnvelope({
  projection: {
    businessDate,
    generatedAt: '2026-07-15T15:00:00.000Z',
    notificationType: 'normal-digest',
    summary: { needsReview: 2, highPriority: 1, watchlist: 1, lowConfidence: 0, currentOpportunities: 2 },
    topOpportunities: [],
    sourceAuthority: { optionalWarnings: [] },
    links: {
      inbox: 'https://internal.example.test/admin/deal-hunter',
      operations: 'https://internal.example.test/admin/deal-hunter?view=operations',
    },
  },
  recipient: 'digest@example.test',
  sender: 'Uckele Group <sender@example.test>',
  preparedAt: '2026-07-15T15:00:00.000Z',
});
const payloadDigest = canonicalEnvelope.payloadDigest;

function preparedEnvelope(overrides = {}) {
  return {
    ...canonicalEnvelope,
    ...overrides,
  };
}

function scheduledRun(overrides = {}) {
  const envelope = preparedEnvelope();
  return {
    job_key: jobKey,
    job_name: 'daily-deal-hunter-email',
    status: 'transmitting',
    started_at: '2026-07-15T15:00:00.000Z',
    updated_at: '2026-07-15T15:00:00.000Z',
    completed_at: null,
    attempt_count: 1,
    provider_message_id: null,
    metadata: {
      claimToken,
      businessDate,
      pacificDate: businessDate,
      dateKey: businessDate,
      timezone: 'America/Los_Angeles',
      notificationType: envelope.notificationType,
      preparedEnvelope: envelope,
      payloadDigest,
      firstPreparedAt: envelope.preparedAt,
      providerBoundaryAt: '2026-07-15T15:00:00.000Z',
    },
    ...overrides,
  };
}

function createStorage({ run = scheduledRun(), events = [] } = {}) {
  let current = structuredClone(run);
  const state = { events: structuredClone(events), transitions: [] };
  return {
    state,
    async getScheduledJob(key) {
      return key === current?.job_key ? structuredClone(current) : null;
    },
    async listEmailEvents({ source } = {}) {
      return state.events
        .filter((event) => !source || event.source === source)
        .map((event) => structuredClone(event));
    },
    async transitionScheduledJob(input) {
      state.transitions.push(structuredClone(input));
      if (!current || current.job_key !== input.jobKey) return { applied: false, reason: 'missing', run: null };
      if (current.status === 'completed') return { applied: false, reason: 'completed', run: structuredClone(current) };
      if (current.metadata.claimToken !== input.claimToken) return { applied: false, reason: 'not-owner', run: structuredClone(current) };
      if (!input.expectedStatuses.includes(current.status)) return { applied: false, reason: 'wrong-state', run: structuredClone(current) };
      current = {
        ...current,
        status: input.status,
        updated_at: input.nowIso,
        completed_at: input.status === 'completed' ? (input.completedAt || input.nowIso) : current.completed_at,
        provider_message_id: input.providerMessageId || current.provider_message_id,
        last_error: input.lastError || null,
        metadata: { ...current.metadata, ...(input.metadataPatch || {}) },
      };
      return { applied: true, reason: 'claimed', run: structuredClone(current) };
    },
    get run() {
      return structuredClone(current);
    },
  };
}

function exactEvent(overrides = {}) {
  return {
    id: 'event-1',
    source: 'daily-deal-hunter',
    provider: 'resend',
    event_type: 'sent',
    message_id: providerId,
    recipient_email: 'digest@example.test',
    subject: `Daily Deal Hunter — 2 to review — ${businessDate}`,
    created_at: '2026-07-15T15:00:01.000Z',
    metadata: {
      tracking: {
        jobKey,
        businessDate,
        notificationType: 'normal-digest',
        payloadDigest,
      },
      tags: [
        { name: 'source', value: 'daily-deal-hunter' },
        { name: 'business_date', value: businessDate },
        { name: 'notification', value: 'normal-digest' },
        { name: 'payload_digest', value: payloadDigest },
      ],
    },
    ...overrides,
  };
}

function providerCandidate(overrides = {}) {
  return {
    id: providerId,
    to: ['digest@example.test'],
    subject: `Daily Deal Hunter — 2 to review — ${businessDate}`,
    createdAt: '2026-07-15T15:00:01.000Z',
    tags: exactEvent().metadata.tags,
    ...overrides,
  };
}

function markerEvidence(overrides = {}) {
  return {
    version: 1,
    jobKey,
    businessDate,
    notificationType: 'normal-digest',
    payloadDigest,
    providerMessageId: providerId,
    acceptedAt: '2026-07-15T15:00:01.000Z',
    ...overrides,
  };
}

test('matching marker reconciles provider acceptance without a send', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-digest-marker-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  await writeDailyDealHunterMarker({ markerDir, evidence: markerEvidence() });
  const storage = createStorage();
  let providerLookups = 0;

  const result = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir,
    now: new Date('2026-07-15T15:10:00.000Z'),
    providerLookup: async () => { providerLookups += 1; return []; },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.source, 'marker');
  assert.equal(storage.run.provider_message_id, providerId);
  assert.equal(providerLookups, 1);
});

test('daily digest aggregates all available reconciliation evidence before completion', async (t) => {
  const conflictingMarkerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-digest-conflicting-marker-'));
  const duplicateMarkerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-digest-duplicate-marker-'));
  t.after(() => {
    fs.rmSync(conflictingMarkerDir, { recursive: true, force: true });
    fs.rmSync(duplicateMarkerDir, { recursive: true, force: true });
  });

  await writeDailyDealHunterMarker({
    markerDir: conflictingMarkerDir,
    evidence: markerEvidence({ providerMessageId: 'provider-marker-a' }),
  });
  const markerLocalConflict = createStorage({
    events: [exactEvent({ message_id: 'provider-local-b' })],
  });
  const markerLocalConflictResult = await reconcileDailyDealHunterJob({
    storage: markerLocalConflict,
    jobKey,
    markerDir: conflictingMarkerDir,
    now: new Date('2026-07-15T15:05:00.000Z'),
  });
  assert.equal(markerLocalConflictResult.status, 'ambiguous');
  assert.equal(markerLocalConflictResult.reason, 'conflicting-provider-evidence');
  assert.equal(markerLocalConflict.run.provider_message_id, null);
  assert.equal(markerLocalConflict.run.metadata.reconciliation.severity, 'high');

  const localWebhookConflict = createStorage({
    events: [
      exactEvent({ message_id: 'provider-local-a' }),
      exactEvent({
        source: 'webhook',
        message_id: 'provider-webhook-b',
        provider_event_id: 'svix-conflicting-webhook',
        metadata: { ...exactEvent().metadata, svixId: 'svix-conflicting-webhook', rawType: 'email.sent' },
      }),
    ],
  });
  const localWebhookConflictResult = await reconcileDailyDealHunterJob({
    storage: localWebhookConflict,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T15:05:00.000Z'),
  });
  assert.equal(localWebhookConflictResult.status, 'ambiguous');
  assert.equal(localWebhookConflictResult.reason, 'conflicting-provider-evidence');
  assert.equal(localWebhookConflict.run.provider_message_id, null);

  const webhookProviderConflict = createStorage({
    events: [exactEvent({
      source: 'webhook',
      message_id: 'provider-webhook-a',
      provider_event_id: 'svix-provider-conflict',
      metadata: { ...exactEvent().metadata, svixId: 'svix-provider-conflict', rawType: 'email.sent' },
    })],
  });
  const webhookProviderConflictResult = await reconcileDailyDealHunterJob({
    storage: webhookProviderConflict,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T15:05:00.000Z'),
    providerLookup: async () => [providerCandidate({ id: 'provider-lookup-b' })],
  });
  assert.equal(webhookProviderConflictResult.status, 'ambiguous');
  assert.equal(webhookProviderConflictResult.reason, 'conflicting-provider-evidence');
  assert.equal(webhookProviderConflict.run.provider_message_id, null);

  await writeDailyDealHunterMarker({
    markerDir: duplicateMarkerDir,
    evidence: markerEvidence({ providerMessageId: 'provider-same-a' }),
  });
  const duplicateIdentity = createStorage({
    events: [exactEvent({ message_id: 'provider-same-a' })],
  });
  const duplicateIdentityResult = await reconcileDailyDealHunterJob({
    storage: duplicateIdentity,
    jobKey,
    markerDir: duplicateMarkerDir,
    now: new Date('2026-07-15T15:05:00.000Z'),
  });
  assert.equal(duplicateIdentityResult.status, 'completed');
  assert.equal(duplicateIdentity.run.provider_message_id, 'provider-same-a');

  const alreadyAmbiguous = createStorage({
    run: scheduledRun({ status: 'ambiguous' }),
    events: [
      exactEvent({ message_id: 'provider-local-a' }),
      exactEvent({
        source: 'webhook',
        message_id: 'provider-webhook-b',
        provider_event_id: 'svix-existing-ambiguous-conflict',
        metadata: { ...exactEvent().metadata, svixId: 'svix-existing-ambiguous-conflict', rawType: 'email.sent' },
      }),
    ],
  });
  const alreadyAmbiguousResult = await reconcileDailyDealHunterJob({
    storage: alreadyAmbiguous,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T16:05:00.000Z'),
  });
  assert.equal(alreadyAmbiguousResult.status, 'ambiguous');
  assert.equal(alreadyAmbiguousResult.reason, 'conflicting-provider-evidence');
  assert.equal(alreadyAmbiguousResult.severity, 'high');
  assert.equal(alreadyAmbiguous.run.status, 'ambiguous');
  assert.equal(alreadyAmbiguous.run.provider_message_id, null);
});

test('provider lookup outage does not bypass daily digest ambiguity window', async () => {
  const lookupFailure = async () => { throw new Error('provider lookup unavailable with private details'); };
  const beforeWindow = createStorage();
  const beforeResult = await reconcileDailyDealHunterJob({
    storage: beforeWindow,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T15:59:00.000Z'),
    providerLookup: lookupFailure,
  });
  assert.equal(beforeResult.status, 'transmitting');
  assert.equal(beforeResult.reason, 'provider-lookup-unavailable');
  assert.equal(beforeWindow.run.status, 'transmitting');

  const afterWindow = createStorage();
  const afterResult = await reconcileDailyDealHunterJob({
    storage: afterWindow,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T16:01:00.000Z'),
    providerLookup: lookupFailure,
  });
  assert.equal(afterResult.status, 'ambiguous');
  assert.equal(afterResult.reason, 'provider-lookup-unavailable');
  assert.equal(afterWindow.run.status, 'ambiguous');
  assert.equal(afterWindow.run.metadata.reconciliation.errorCategory, 'provider-lookup-unavailable');
  assert.doesNotMatch(JSON.stringify(afterResult), /private details/);

  const exactLocal = createStorage({ events: [exactEvent()] });
  const exactResult = await reconcileDailyDealHunterJob({
    storage: exactLocal,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T16:01:00.000Z'),
    providerLookup: lookupFailure,
  });
  assert.equal(exactResult.status, 'completed');
  assert.equal(exactResult.source, 'local-event');
  assert.equal(exactLocal.run.provider_message_id, providerId);
});

test('matching local email event reconciles provider acceptance without a send', async () => {
  const storage = createStorage({ events: [exactEvent()] });
  const result = await reconcileDailyDealHunterJob({ storage, jobKey, markerDir: '' });
  assert.equal(result.status, 'completed');
  assert.equal(result.source, 'local-event');
  assert.equal(storage.run.provider_message_id, providerId);
});

test('signed email sent webhook tags reconcile the exact daily date', async () => {
  const storage = createStorage({ events: [exactEvent({
    source: 'webhook',
    provider_event_id: 'svix-daily-1',
    metadata: { ...exactEvent().metadata, svixId: 'svix-daily-1', rawType: 'email.sent' },
  })] });
  const result = await reconcileDailyDealHunterJob({ storage, jobKey, markerDir: '' });
  assert.equal(result.status, 'completed');
  assert.equal(result.source, 'signed-webhook');
});

test('webhook for another source date or payload cannot complete the job', async () => {
  const wrongTags = [
    { name: 'source', value: 'daily-deal-hunter' },
    { name: 'business_date', value: '2026-07-14' },
    { name: 'notification', value: 'normal-digest' },
    { name: 'payload_digest', value: 'b'.repeat(64) },
  ];
  const storage = createStorage({ events: [exactEvent({
    source: 'webhook',
    provider_event_id: 'svix-wrong-1',
    metadata: { ...exactEvent().metadata, svixId: 'svix-wrong-1', rawType: 'email.sent', tags: wrongTags },
  })] });
  const result = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T15:30:00.000Z'),
    providerLookup: async () => [],
  });
  assert.equal(result.status, 'transmitting');
  assert.equal(storage.run.status, 'transmitting');
});

test('bounded provider lookup requires exactly matching retrieved tags', async () => {
  const storage = createStorage();
  const result = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir: '',
    providerLookup: async () => [
      providerCandidate({ id: 'wrong-notification', tags: providerCandidate().tags.map((tag) => (
        tag.name === 'notification' ? { ...tag, value: 'required-source-alert' } : tag
      )) }),
      providerCandidate(),
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.source, 'provider-lookup');
  assert.equal(storage.run.provider_message_id, providerId);
});

test('zero provider matches becomes ambiguous after the reconciliation window', async () => {
  const storage = createStorage();
  const result = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T16:00:00.000Z'),
    providerLookup: async () => [],
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(storage.run.status, 'ambiguous');
  assert.equal(storage.run.metadata.reconciliation.errorCategory, 'no-provider-proof');
});

test('multiple provider matches remain ambiguous and raise an operations issue', async () => {
  const storage = createStorage();
  const result = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir: '',
    now: new Date('2026-07-15T15:05:00.000Z'),
    providerLookup: async () => [providerCandidate(), providerCandidate({ id: 'resend-daily-002' })],
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(storage.run.status, 'ambiguous');
  assert.equal(storage.run.metadata.reconciliation.severity, 'high');
  assert.equal(storage.run.metadata.reconciliation.errorCategory, 'conflicting-provider-evidence');
});

test('late exact provider proof moves ambiguous to completed monotonically', async () => {
  const storage = createStorage({ run: scheduledRun({ status: 'ambiguous' }) });
  const first = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir: '',
    providerLookup: async () => [providerCandidate()],
  });
  const replay = await reconcileDailyDealHunterJob({
    storage,
    jobKey,
    markerDir: '',
    providerLookup: async () => [],
  });
  assert.equal(first.status, 'completed');
  assert.equal(replay.status, 'completed');
  assert.equal(storage.state.transitions.filter((item) => item.status === 'completed').length, 1);
});

test('bounce complaint and out-of-order delivery never reopen a completed date', async () => {
  const completed = scheduledRun({
    status: 'completed',
    provider_message_id: providerId,
    completed_at: '2026-07-15T15:01:00.000Z',
  });
  const storage = createStorage({
    run: completed,
    events: [
      exactEvent({ source: 'webhook', event_type: 'complained', provider_event_id: 'svix-complaint' }),
      exactEvent({ source: 'webhook', event_type: 'delivered', provider_event_id: 'svix-delivered' }),
    ],
  });
  const result = await reconcileDailyDealHunterJob({ storage, jobKey, markerDir: '' });
  assert.equal(result.status, 'completed');
  assert.equal(storage.run.status, 'completed');
  assert.equal(storage.state.transitions.length, 0);
});
