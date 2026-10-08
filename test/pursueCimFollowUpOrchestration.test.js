import assert from 'node:assert/strict';
import test from 'node:test';

import { runDueCimFollowUpOrchestration } from
  '../server/services/pursueCimFollowUpOrchestration.js';
import { runCimFollowUpPreparation } from
  '../server/services/pursueCimFollowUpPreparation.js';

const now = '2026-10-08T16:00:00.000Z';
const digest = (character) => character.repeat(64);

function candidate(overrides = {}) {
  return {
    touch_id: 'touch-follow-up-1', campaign_id: 'campaign-1',
    opportunity_id: 'opportunity-1', conversation_id: 'conversation-1',
    kind: 'follow-up-1', state: 'scheduled', due_at: '2026-10-08T15:00:00.000Z',
    row_version: 4, timezone_revision: 2,
    campaign_terminal_revision: 3, conversation_terminal_revision: 5,
    crm_submission_id: 'submission-1', recipient_address: 'broker@example.test',
    recipient_fingerprint: digest('a'), activation_id: 'activation-fl04c',
    ...overrides,
  };
}

function authority(overrides = {}) {
  const base = {
    touch: { id: 'touch-follow-up-1', campaign_id: 'campaign-1',
      opportunity_id: 'opportunity-1', kind: 'follow-up-1', logical_slot: 'follow-up-1',
      ordinal: 1, state: 'scheduled', due_at: '2026-10-08T15:00:00.000Z',
      timezone_revision: 2, row_version: 4, transmission_id: null,
      claim_token_digest: null, claim_owner: null, claim_expires_at: null },
    campaign: { id: 'campaign-1', conversation_id: 'conversation-1',
      opportunity_id: 'opportunity-1', crm_submission_id: 'submission-1',
      state: 'active-follow-up', policy_version: 'deal-hunter-cim-autopilot-v1',
      template_version: 'deal-hunter-cim-autopilot-v1', terminal_revision: 3,
      timezone_revision: 2, local_expiry_at: '2026-10-20T16:00:00.000Z',
      recipient_fingerprint: digest('a') },
    conversation: { id: 'conversation-1', state: 'open', terminal_revision: 5,
      recipient_address: 'broker@example.test', recipient_fingerprint: digest('a') },
    opportunity: { opportunity_id: 'opportunity-1', status: 'active' },
    crmOwnership: { submission_id: 'submission-1', revision: 7 },
    crmSubmission: { id: 'submission-1', deal_hunter_opportunity_id: 'opportunity-1',
      archived_at: null },
    recipient: { address: 'broker@example.test', fingerprint: digest('a'),
      authorityRevision: 'contact-7' },
    terminal: { replyReceived: false, materialsReceived: false,
      advancedDiligence: false, suppressed: false, unsafeDelivery: false,
      providerPending: false, providerAmbiguous: false },
    activation: { id: 'activation-fl04c', capability: 'fl04c-followup',
      status: 'current', mode: 'active', expires_at: '2026-10-08T18:00:00.000Z' },
  };
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key,
    { ...value, ...(overrides[key] || {}) }]));
}

function message() {
  return { payloadVersion: 'deal-hunter-cim-follow-up-1-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Re: CIM / NDA request', bodyText: 'Synthetic follow-up.',
    bodyHtmlSanitized: '<p>Synthetic follow-up.</p>', tags: ['source=cim-follow-up'] };
}

function preparationHarness({ before = authority(), after, preparation } = {}) {
  const claimed = authority({ ...after, touch: { state: 'claimed', row_version: 5,
    claim_token_digest: digest('c'), claim_owner: 'follow-up-orchestrator',
    claim_expires_at: '2026-10-08T16:05:00.000Z', ...(after?.touch || {}) } });
  const reads = [before, claimed];
  const calls = { claim: 0, prepare: 0, provider: 0 };
  return { calls, preparation: {
    storage: {
      async claimDueCimTouch() {
        calls.claim += 1;
        return { claimed: true, alreadyOwned: false, staleAuthority: false,
          terminal: false, conflict: false, touch: claimed.touch };
      },
      async prepareReservedCimFollowUp() {
        calls.prepare += 1;
        return preparation || { prepared: true, existing: false, capacityDeferred: false,
          payloadConflict: false, terminal: false, blockedReason: null,
          transmission: { id: 'transmission-1', state: 'prepared' },
          reservation: { id: 'reservation-1', state: 'reserved' } };
      },
      async sendProviderMessage() {
        calls.provider += 1;
        throw new Error('provider must remain unreachable');
      },
    },
    loadAuthority: async () => reads.shift(),
    buildPayload: async () => message(),
  } };
}

function orchestration(overrides = {}) {
  return {
    now,
    limit: 25,
    listDueWork: async () => [candidate()],
    prepareFollowUp: runCimFollowUpPreparation,
    createClaimTokenDigest: async () => digest('c'),
    ...overrides,
  };
}

test('FL04C due work is sorted, exact duplicates are collapsed, and each slot is scheduled once', async () => {
  const observed = [];
  const early = candidate({ touch_id: 'touch-a', due_at: '2026-10-08T14:00:00.000Z' });
  const tied = candidate({ touch_id: 'touch-b', due_at: early.due_at });
  const later = candidate({ touch_id: 'touch-c', due_at: '2026-10-08T15:00:00.000Z' });
  const result = await runDueCimFollowUpOrchestration(orchestration({
    listDueWork: async () => [later, tied, { ...early }, early],
    createClaimTokenDigest: async ({ index }) => digest(String(index + 1)),
    prepareFollowUp: async (input) => {
      observed.push({ touchId: input.candidate.touch_id, token: input.claimTokenDigest });
      return { prepared: true, existing: false, capacityDeferred: false,
        blockedReason: null, transmission: { id: `transmission-${input.candidate.touch_id}` } };
    },
  }));
  assert.deepEqual(observed.map(({ touchId }) => touchId), ['touch-a', 'touch-b', 'touch-c']);
  assert.equal(new Set(observed.map(({ token }) => token)).size, 3);
  assert.deepEqual({ selected: result.selected, scheduled: result.scheduled,
    duplicateCount: result.duplicateCount, attempted: result.attempted,
    cancelled: result.cancelled },
  { selected: 4, scheduled: 3, duplicateCount: 1, attempted: 3, cancelled: false });
});

test('FL04C cancellation stops before selection and between serial preparations', async () => {
  const before = new AbortController();
  before.abort();
  let selections = 0;
  const stopped = await runDueCimFollowUpOrchestration(orchestration({
    signal: before.signal,
    listDueWork: async () => { selections += 1; return [candidate()]; },
  }));
  assert.equal(selections, 0);
  assert.deepEqual(stopped, { selected: 0, scheduled: 0, duplicateCount: 0,
    attempted: 0, cancelled: true, outcomes: [] });

  const during = new AbortController();
  const prepared = [];
  const interrupted = await runDueCimFollowUpOrchestration(orchestration({
    signal: during.signal,
    listDueWork: async () => [candidate({ touch_id: 'touch-a' }),
      candidate({ touch_id: 'touch-b' })],
    createClaimTokenDigest: async ({ index }) => digest(String(index + 1)),
    prepareFollowUp: async ({ candidate: item }) => {
      prepared.push(item.touch_id);
      during.abort();
      return { prepared: true, existing: false, capacityDeferred: false,
        blockedReason: null, transmission: { id: 'transmission-a' } };
    },
  }));
  assert.deepEqual(prepared, ['touch-a']);
  assert.equal(interrupted.cancelled, true);
  assert.equal(interrupted.attempted, 1);
});

test('FL04C orchestration preserves reply, material, opt-out, expiry, and ambiguous stops', async () => {
  const cases = [
    [authority({ terminal: { replyReceived: true } }), 'reply_received'],
    [authority({ terminal: { materialsReceived: true } }), 'materials_received'],
    [authority({ terminal: { suppressed: true } }), 'recipient_suppressed'],
    [authority({ campaign: { local_expiry_at: now } }), 'campaign_expired'],
    [authority({ terminal: { providerAmbiguous: true } }), 'provider_ambiguous'],
  ];
  for (const [current, blockedReason] of cases) {
    const fake = preparationHarness({ before: current });
    const result = await runDueCimFollowUpOrchestration(orchestration({
      preparation: fake.preparation,
    }));
    assert.equal(result.outcomes[0].blockedReason, blockedReason);
    assert.deepEqual(fake.calls, { claim: 0, prepare: 0, provider: 0 });
  }
});

test('FL04C orchestration preserves the post-claim reply race and performs no provider work', async () => {
  const fake = preparationHarness({ after: authority({ terminal: { replyReceived: true } }) });
  const result = await runDueCimFollowUpOrchestration(orchestration({
    preparation: fake.preparation,
  }));
  assert.equal(result.outcomes[0].blockedReason, 'reply_received');
  assert.deepEqual(fake.calls, { claim: 1, prepare: 0, provider: 0 });
});

test('FL04C capacity deferral and atomic existing-result dedup are never retried', async () => {
  for (const preparation of [
    { prepared: false, existing: false, capacityDeferred: true,
      blockedReason: 'daily_capacity', transmission: null, reservation: null },
    { prepared: false, existing: true, capacityDeferred: false,
      blockedReason: null, transmission: { id: 'transmission-existing' },
      reservation: { id: 'reservation-existing' } },
  ]) {
    const fake = preparationHarness({ preparation });
    const item = candidate();
    const result = await runDueCimFollowUpOrchestration(orchestration({
      listDueWork: async () => [item, { ...item }],
      preparation: fake.preparation,
    }));
    assert.equal(result.attempted, 1);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.outcomes[0].prepared, preparation.prepared);
    assert.equal(result.outcomes[0].capacityDeferred, preparation.capacityDeferred);
    assert.equal(result.outcomes[0].existing, preparation.existing);
    assert.deepEqual(fake.calls, { claim: 1, prepare: 1, provider: 0 });
  }
});

test('FL04C concurrent orchestration relies on one atomic claim winner and never retries', async () => {
  let claimed = false;
  const calls = { claim: 0, prepare: 0, provider: 0 };
  const claimedAuthority = authority({ touch: { state: 'claimed', row_version: 5,
    claim_token_digest: digest('c'), claim_owner: 'follow-up-orchestrator',
    claim_expires_at: '2026-10-08T16:05:00.000Z' } });
  const preparation = {
    storage: {
      async claimDueCimTouch() {
        calls.claim += 1;
        if (claimed) return { claimed: false, alreadyOwned: false,
          staleAuthority: false, terminal: false, conflict: true, touch: null };
        claimed = true;
        return { claimed: true, alreadyOwned: false, staleAuthority: false,
          terminal: false, conflict: false, touch: claimedAuthority.touch };
      },
      async prepareReservedCimFollowUp() {
        calls.prepare += 1;
        return { prepared: true, existing: false, capacityDeferred: false,
          payloadConflict: false, terminal: false, blockedReason: null,
          transmission: { id: 'transmission-winner' }, reservation: { id: 'reservation-winner' } };
      },
      async sendProviderMessage() {
        calls.provider += 1;
        throw new Error('provider must remain unreachable');
      },
    },
    loadAuthority: async () => claimed ? claimedAuthority : authority(),
    buildPayload: async () => message(),
  };
  const [first, second] = await Promise.all([
    runDueCimFollowUpOrchestration(orchestration({ preparation,
      createClaimTokenDigest: async () => digest('c') })),
    runDueCimFollowUpOrchestration(orchestration({ preparation,
      createClaimTokenDigest: async () => digest('d') })),
  ]);
  assert.equal([first, second].filter((item) => item.outcomes[0].prepared).length, 1);
  assert.equal([first, second].filter((item) =>
    item.outcomes[0].blockedReason === 'concurrent_winner').length, 1);
  assert.deepEqual(calls, { claim: 2, prepare: 1, provider: 0 });
});

test('FL04C rejects malformed or divergent due selection before any preparation', async () => {
  let prepared = 0;
  const prepareFollowUp = async () => { prepared += 1; return {}; };
  for (const selected of [
    'not-an-array',
    [candidate({ kind: 'initial' })],
    [candidate({ kind: 'not-follow-up' })],
    [candidate({ due_at: '2026-10-08T17:00:00.000Z' })],
    [candidate(), candidate({ campaign_id: 'campaign-other' })],
  ]) {
    await assert.rejects(runDueCimFollowUpOrchestration(orchestration({
      listDueWork: async () => selected,
      prepareFollowUp,
    })), /due|follow-up|duplicate/i);
  }
  assert.equal(prepared, 0);
});

test('FL04C rejects duplicate claim authority before preparation', async () => {
  let prepared = 0;
  await assert.rejects(runDueCimFollowUpOrchestration(orchestration({
    listDueWork: async () => [candidate({ touch_id: 'touch-a' }),
      candidate({ touch_id: 'touch-b' })],
    createClaimTokenDigest: async () => digest('c'),
    prepareFollowUp: async () => { prepared += 1; return {}; },
  })), /claim token/i);
  assert.equal(prepared, 0);
});
