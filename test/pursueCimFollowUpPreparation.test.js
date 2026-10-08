import assert from 'node:assert/strict';
import test from 'node:test';

import { runCimFollowUpPreparation } from '../server/services/pursueCimFollowUpPreparation.js';

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
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, ...(overrides[key] || {}) } : overrides[key] ?? value]));
}

function message() {
  return { payloadVersion: 'deal-hunter-cim-follow-up-1-v1',
    fromAddress: 'sender@example.test', toAddresses: ['broker@example.test'],
    ccAddresses: [], bccAddresses: [], replyToAddress: 'reply@example.test',
    subject: 'Re: CIM / NDA request', bodyText: 'Synthetic follow-up.',
    bodyHtmlSanitized: '<p>Synthetic follow-up.</p>', tags: ['source=cim-follow-up'] };
}

function harness({ before = authority(), after, claim, preparation } = {}) {
  const claimed = authority({ ...after, touch: { state: 'claimed', row_version: 5,
    claim_token_digest: digest('c'), claim_owner: 'follow-up-preparer',
    claim_expires_at: '2026-10-08T16:05:00.000Z', ...(after?.touch || {}) } });
  const reads = [before, after ? claimed : claimed];
  const calls = { provider: 0, claim: 0, prepare: 0 };
  return { calls, storage: {
    async claimDueCimTouch() {
      calls.claim += 1;
      return claim || { claimed: true, alreadyOwned: false, staleAuthority: false,
        terminal: false, conflict: false, touch: claimed.touch };
    },
    async prepareReservedCimFollowUp(command) {
      calls.prepare += 1;
      return preparation || { prepared: true, existing: false, capacityDeferred: false,
        payloadConflict: false, terminal: false, blockedReason: null,
        transmission: { id: 'transmission-1', state: 'prepared' },
        reservation: { id: 'reservation-1', state: 'reserved' }, command };
    },
    async sendProviderMessage() { calls.provider += 1; throw new Error('must not send'); },
  },
  loadAuthority: async () => reads.shift(),
  };
}

function input(overrides = {}) {
  return { candidate: candidate(), now, actor: 'follow-up-preparer',
    claimTokenDigest: digest('c'), buildPayload: async () => message(), ...overrides };
}

test('FL04C prepares one claimed follow-up through the atomic reservation boundary and never sends', async () => {
  const fake = harness();
  const result = await runCimFollowUpPreparation({ ...input(), storage: fake.storage,
    loadAuthority: fake.loadAuthority });
  assert.equal(result.prepared, true);
  assert.equal(result.transmission.id, 'transmission-1');
  assert.equal(result.reservation.state, 'reserved');
  assert.deepEqual(fake.calls, { provider: 0, claim: 1, prepare: 1 });
  assert.equal(Object.hasOwn(result, 'prepareCommand'), false,
    'the service must not expose a detached executable command');
  assert.equal(Object.hasOwn(result, 'command'), false,
    'the service must not echo injected storage inputs');
});

test('FL04C payload builders cannot overwrite reservation authority', async () => {
  const fake = harness();
  let observed;
  const original = fake.storage.prepareReservedCimFollowUp;
  fake.storage.prepareReservedCimFollowUp = async (command) => {
    observed = command;
    return original(command);
  };
  await runCimFollowUpPreparation({ ...input({
    buildPayload: async () => ({ ...message(), activationId: 'attacker',
      claimTokenDigest: digest('f'), preparationGeneration: 99, actor: 'attacker' }),
  }), storage: fake.storage, loadAuthority: fake.loadAuthority });
  assert.equal(observed.activationId, 'activation-fl04c');
  assert.equal(observed.claimTokenDigest, digest('c'));
  assert.equal(observed.preparationGeneration, 1);
  assert.equal(observed.actor, 'follow-up-preparer');
});

test('FL04C requires one exact recipient fingerprint across every authority', async () => {
  for (const current of [
    authority({ campaign: { recipient_fingerprint: digest('b') } }),
    authority({ conversation: { recipient_fingerprint: digest('b') } }),
    authority({ recipient: { fingerprint: digest('b') } }),
  ]) {
    const fake = harness({ before: current });
    const result = await runCimFollowUpPreparation({ ...input(), storage: fake.storage,
      loadAuthority: fake.loadAuthority });
    assert.equal(result.prepared, false);
    assert.equal(result.blockedReason, 'recipient_changed');
    assert.deepEqual(fake.calls, { provider: 0, claim: 0, prepare: 0 });
  }
});

test('FL04C blocks expiry, reply, materials, suppression, delivery risk, and ambiguity before claim', async () => {
  const cases = [
    [authority({ campaign: { local_expiry_at: now } }), 'campaign_expired'],
    [authority({ terminal: { replyReceived: true } }), 'reply_received'],
    [authority({ terminal: { materialsReceived: true } }), 'materials_received'],
    [authority({ terminal: { advancedDiligence: true } }), 'advanced_diligence'],
    [authority({ terminal: { suppressed: true } }), 'recipient_suppressed'],
    [authority({ terminal: { unsafeDelivery: true } }), 'unsafe_delivery'],
    [authority({ terminal: { providerAmbiguous: true } }), 'provider_ambiguous'],
  ];
  for (const [current, blockedReason] of cases) {
    const fake = harness({ before: current });
    const result = await runCimFollowUpPreparation({ ...input(), storage: fake.storage,
      loadAuthority: fake.loadAuthority });
    assert.equal(result.blockedReason, blockedReason);
    assert.equal(fake.calls.claim, 0);
    assert.equal(fake.calls.prepare, 0);
  }
});

test('FL04C rechecks authority after claim and performs no preparation on a reply race', async () => {
  const fake = harness({ after: authority({ terminal: { replyReceived: true } }) });
  const result = await runCimFollowUpPreparation({ ...input(), storage: fake.storage,
    loadAuthority: fake.loadAuthority });
  assert.equal(result.blockedReason, 'reply_received');
  assert.deepEqual(fake.calls, { provider: 0, claim: 1, prepare: 0 });
});

test('FL04C maps capacity deferral and claim conflicts without retrying', async () => {
  const deferred = harness({ preparation: { prepared: false, existing: false,
    capacityDeferred: true, payloadConflict: false, terminal: false,
    blockedReason: 'daily_capacity', transmission: null, reservation: null } });
  assert.equal((await runCimFollowUpPreparation({ ...input(), storage: deferred.storage,
    loadAuthority: deferred.loadAuthority })).blockedReason, 'daily_capacity');
  assert.deepEqual(deferred.calls, { provider: 0, claim: 1, prepare: 1 });

  const conflict = harness({ claim: { claimed: false, alreadyOwned: false,
    staleAuthority: false, terminal: false, conflict: true, touch: null } });
  assert.equal((await runCimFollowUpPreparation({ ...input(), storage: conflict.storage,
    loadAuthority: conflict.loadAuthority })).blockedReason, 'concurrent_winner');
  assert.deepEqual(conflict.calls, { provider: 0, claim: 1, prepare: 0 });
});

test('FL04C rejects malformed authority and storage without a reservation transition', async () => {
  const fake = harness({ before: null });
  assert.equal((await runCimFollowUpPreparation({ ...input(), storage: fake.storage,
    loadAuthority: fake.loadAuthority })).blockedReason, 'authority_unavailable');
  await assert.rejects(runCimFollowUpPreparation({ ...input(),
    storage: { claimDueCimTouch: async () => ({}) }, loadAuthority: async () => authority() }),
  /storage/i);
});
