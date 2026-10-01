import assert from 'node:assert/strict';
import test from 'node:test';

import * as providerService from '../server/services/pursueCimProvider.js';

function reconciliationTransmission(overrides = {}) {
  return { id: 'transmission-1', state: 'provider-pending', row_version: 3,
    invocation_authority_count: 1, payload_digest: 'd'.repeat(64),
    provider_idempotency_key: 'idem-1', from_address: 'sender@example.test',
    to_addresses: ['broker@example.test'], cc_addresses: [], bcc_addresses: [],
    reply_to_address: 'reply@example.test', subject: 'Exact subject', ...overrides };
}

function proofFor(transmission, overrides = {}) {
  return { type: 'provider-read', id: 'provider-read-1', provider: 'resend',
    outcome: 'unresolved', observedAt: '2026-09-25T19:01:00.000Z',
    binding: { transmissionId: transmission.id, payloadDigest: transmission.payload_digest,
      providerIdempotencyKey: transmission.provider_idempotency_key,
      fromAddress: transmission.from_address, toAddresses: transmission.to_addresses,
      ccAddresses: transmission.cc_addresses, bccAddresses: transmission.bcc_addresses,
      replyToAddress: transmission.reply_to_address, subject: transmission.subject },
    candidates: [], ...overrides };
}

test('P6C canonical normalizer distinguishes provider outcomes from local boundary denial', () => {
  assert.equal(typeof providerService.normalizeCimProviderOutcome, 'function');
  const normalize = providerService.normalizeCimProviderOutcome;

  assert.deepEqual(normalize({
    status: 'sent', provider: 'resend', providerMessageId: 'provider-message-1',
    providerAttempted: true, providerSeamEntered: true,
  }), {
    category: 'accepted', provider: 'resend', providerMessageId: 'provider-message-1',
    providerResultCode: 'accepted',
  });
  assert.deepEqual(normalize({
    status: 'failed', provider: 'resend', providerMessageId: '',
    errorCategory: 'provider-nonacceptance', definitiveFailure: true,
    providerAttempted: true, providerSeamEntered: true,
  }), {
    category: 'definitive-failure', provider: 'resend', providerMessageId: null,
    providerResultCode: 'provider-nonacceptance',
  });
  assert.deepEqual(normalize({
    status: 'failed', provider: 'resend', providerMessageId: '',
    errorCategory: 'cim-provider-hard-off', definitiveFailure: true,
    providerAttempted: false, providerSeamEntered: false,
  }), {
    category: 'pending', provider: 'resend', providerMessageId: null,
    providerResultCode: 'cim-provider-hard-off',
  });
});

test('P6C accepted-looking results with missing or conflicting provider identities are ambiguous', () => {
  const normalize = providerService.normalizeCimProviderOutcome;
  for (const [name, result, providerResultCode] of [
    ['empty', { providerMessageId: '' }, 'missing-provider-id'],
    ['whitespace', { providerMessageId: '  ' }, 'missing-provider-id'],
    ['non-string', { providerMessageId: 42 }, 'missing-provider-id'],
    ['oversized', { providerMessageId: 'x'.repeat(241) }, 'missing-provider-id'],
    ['conflicting', { providerMessageId: 'one', providerMessageIds: ['two'] }, 'conflicting-provider-id'],
  ]) {
    assert.deepEqual(normalize({ status: 'sent', provider: 'resend',
      providerAttempted: true, providerSeamEntered: true, ...result }), {
      category: 'ambiguous', provider: 'resend', providerMessageId: null, providerResultCode,
    }, name);
  }
  assert.equal(normalize({ status: 'sent', providerMessageId: 'provider-message-1',
    providerAttempted: true, providerSeamEntered: true }).category, 'ambiguous');
});

test('P6C provider outcome orchestration finalizes only an actual attempted provider result', async () => {
  assert.equal(typeof providerService.finalizeAuthorizedCimTransmission, 'function');
  const finalizeCalls = [];
  const storage = {
    async finalizeCimTransmission(command) {
      finalizeCalls.push(command);
      return { applied: true, existing: false, conflict: false,
        transmission: { id: command.transmissionId, state: command.outcome } };
    },
  };
  const common = {
    storage,
    finalGateResult: { authorized: true,
      transmission: { id: 'transmission-1', state: 'provider-pending', row_version: 2,
        payload_digest: 'd'.repeat(64) } },
    authorizationId: 'authorization-1', writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', actor: 'fixture-owner',
    now: new Date('2026-09-25T19:00:00.000Z'),
  };

  const accepted = await providerService.finalizeAuthorizedCimTransmission({ ...common,
    sendAuthorized: async () => ({ status: 'sent', provider: 'resend',
      providerMessageId: 'provider-message-1', providerAttempted: true,
      providerSeamEntered: true, providerFinalizationRowVersion: 3,
      providerOutcomeObservedAt: '2026-09-25T19:00:01.000Z' }) });
  assert.equal(accepted.outcome.category, 'accepted');
  assert.equal(accepted.durableResult.transmission.state, 'accepted');
  assert.deepEqual(finalizeCalls[0], {
    transmissionId: 'transmission-1', expectedRowVersion: 3, outcome: 'accepted',
    payloadDigest: 'd'.repeat(64),
    provider: 'resend', providerMessageId: 'provider-message-1',
    providerResultCode: 'accepted', actor: 'fixture-owner',
    observedAt: '2026-09-25T19:00:01.000Z',
    now: '2026-09-25T19:00:00.000Z',
  });

  const pending = await providerService.finalizeAuthorizedCimTransmission({ ...common,
    sendAuthorized: async () => ({ status: 'failed', provider: 'resend',
      errorCategory: 'cim-provider-seam-already-entered', definitiveFailure: true,
      reconciliationOnly: true, providerAttempted: false, providerSeamEntered: false }) });
  assert.equal(pending.outcome.category, 'pending');
  assert.equal(pending.durableResult, null);
  assert.equal(finalizeCalls.length, 1);
});

test('P6C reconciliation is read-only, absence is unresolved, and multiple IDs stay ambiguous', async () => {
  const calls = [];
  const transmission = reconciliationTransmission();
  const storage = { async reconcileCimTransmission(command) {
    calls.push(command);
    return { applied: true, unchanged: false, conflict: false,
      transmission: { ...transmission, state: command.outcome } };
  } };

  const absent = await providerService.reconcileCimProviderTransmission({
    storage, transmission, actor: 'fixture-owner',
    now: '2026-09-25T19:02:00.000Z', readProviderEvidence: async () => null,
  });
  assert.deepEqual(absent, { resolved: false, reconciliationOnly: true,
    providerCalls: 0, outcome: 'provider-pending', durableResult: null });
  assert.equal(calls.length, 0);

  const multiple = await providerService.reconcileCimProviderTransmission({
    storage, transmission,
    actor: 'fixture-owner', now: '2026-09-25T19:02:00.000Z',
    readProviderEvidence: async () => proofFor(transmission, { id: 'provider-read-2',
      outcome: 'ambiguous', candidates: [
        { provider: 'resend', providerMessageId: 'provider-a', evidenceId: 'candidate-a' },
        { provider: 'resend', providerMessageId: 'provider-b', evidenceId: 'candidate-b' },
      ] }),
  });
  assert.equal(multiple.outcome, 'ambiguous');
  assert.equal(multiple.resolved, false);
  assert.equal(multiple.providerCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerMessageId, null);
  assert.equal(calls[0].providerIdentities.length, 2);
  assert.equal(new Set(calls[0].providerIdentities.map(({ providerMessageId }) =>
    providerMessageId)).size, 2);
});

test('P6C exact accepted and definitive reconciliation converge without provider calls', async () => {
  const calls = [];
  const transmission = reconciliationTransmission({ state: 'ambiguous', row_version: 4 });
  const common = { storage: { async reconcileCimTransmission(command) {
    calls.push(command);
    return { applied: true, unchanged: false, conflict: false,
      transmission: { ...transmission, state: command.outcome } };
  } }, transmission, actor: 'fixture-owner', now: '2026-09-25T19:02:00.000Z' };
  const accepted = await providerService.reconcileCimProviderTransmission({ ...common,
    readProviderEvidence: async () => proofFor(transmission, {
      type: 'persisted-provider-result', id: 'result-1', outcome: 'accepted',
      candidates: [{ provider: 'resend', providerMessageId: 'provider-message-1',
        evidenceId: 'accepted-1' }] }),
  });
  assert.equal(accepted.resolved, true);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.providerCalls, 0);
  const rejected = await providerService.reconcileCimProviderTransmission({ ...common,
    readProviderEvidence: async () => proofFor(transmission, {
      type: 'persisted-provider-result', id: 'rejection-1', outcome: 'definitive-failure' }),
  });
  assert.equal(rejected.resolved, true);
  assert.equal(rejected.outcome, 'definitive-failure');
  assert.equal(rejected.providerCalls, 0);
  assert.equal(calls.length, 2);
});

test('P6C immediate finalization uses the provider-observed instant as the accepted anchor', async () => {
  const commands = [];
  const result = await providerService.finalizeAuthorizedCimTransmission({
    storage: { async finalizeCimTransmission(command) {
      commands.push(command);
      return { applied: true, transmission: { id: command.transmissionId,
        state: command.outcome } };
    } },
    finalGateResult: { authorized: true, transmission: { id: 'transmission-1',
      state: 'provider-pending', row_version: 2, payload_digest: 'd'.repeat(64) } },
    authorizationId: 'authorization-1', writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', actor: 'fixture-owner',
    now: new Date('2026-09-25T19:00:00.000Z'),
    sendAuthorized: async () => ({ status: 'sent', provider: 'resend',
      providerMessageId: 'provider-message-1', providerAttempted: true,
      providerSeamEntered: true, providerFinalizationRowVersion: 3,
      providerOutcomeObservedAt: '2026-09-25T19:00:07.000Z' }),
  });
  assert.equal(result.outcome.category, 'accepted');
  assert.equal(commands[0].observedAt, '2026-09-25T19:00:07.000Z');
  assert.equal(commands[0].now, '2026-09-25T19:00:00.000Z');
});

test('P6C restart reads through a seam denial to the exact durable terminal outcome', async () => {
  const accepted = { id: 'transmission-1', state: 'accepted', row_version: 4,
    payload_digest: 'd'.repeat(64), provider: 'resend',
    provider_message_id: 'provider-message-1', provider_result_code: 'accepted' };
  let reads = 0;
  const result = await providerService.finalizeAuthorizedCimTransmission({
    storage: {
      async readCimFinalGateContext() { reads += 1; return { transmission: accepted }; },
      async finalizeCimTransmission() { throw new Error('must not refinalize'); },
    },
    finalGateResult: { authorized: true, transmission: { id: 'transmission-1',
      state: 'provider-pending', row_version: 2, payload_digest: 'd'.repeat(64) } },
    authorizationId: 'authorization-1', writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider', actor: 'fixture-owner',
    now: new Date('2026-09-25T19:01:00.000Z'),
    sendAuthorized: async () => ({ status: 'failed', provider: 'resend',
      errorCategory: 'cim-provider-seam-already-entered', definitiveFailure: true,
      reconciliationOnly: true, providerAttempted: false, providerSeamEntered: false }),
  });
  assert.equal(reads, 1);
  assert.equal(result.outcome.category, 'accepted');
  assert.equal(result.durableResult.existing, true);
  assert.deepEqual(result.durableResult.transmission, accepted);
});

test('P6C reconciliation accepts only provider evidence bound to the immutable transmission envelope', async () => {
  const calls = [];
  const transmission = { id: 'transmission-1', state: 'ambiguous', row_version: 4,
    invocation_authority_count: 1, payload_digest: 'd'.repeat(64),
    provider_idempotency_key: 'idem-1', from_address: 'sender@example.test',
    to_addresses: ['broker@example.test'], cc_addresses: [], bcc_addresses: [],
    reply_to_address: 'reply@example.test', subject: 'Exact subject' };
  const exactBinding = { transmissionId: transmission.id,
    payloadDigest: transmission.payload_digest,
    providerIdempotencyKey: transmission.provider_idempotency_key,
    fromAddress: transmission.from_address, toAddresses: transmission.to_addresses,
    ccAddresses: [], bccAddresses: [], replyToAddress: transmission.reply_to_address,
    subject: transmission.subject };
  const storage = { async reconcileCimTransmission(command) {
    calls.push(command);
    return { applied: true, conflict: false,
      transmission: { ...transmission, state: command.outcome } };
  } };
  const readProviderEvidence = async () => ({ type: 'provider-read', id: 'read-1',
    provider: 'resend', outcome: 'accepted', observedAt: '2026-09-25T19:01:00.000Z',
    binding: exactBinding,
    candidates: [{ provider: 'resend', providerMessageId: 'provider-message-1',
      evidenceId: 'candidate-1' }] });
  const accepted = await providerService.reconcileCimProviderTransmission({ storage,
    transmission, readProviderEvidence, actor: 'fixture-owner',
    now: '2026-09-25T19:02:00.000Z' });
  assert.equal(accepted.resolved, true);
  assert.equal(accepted.providerCalls, 0);
  assert.match(calls[0].evidenceDigest, /^[0-9a-f]{64}$/);

  await assert.rejects(providerService.reconcileCimProviderTransmission({ storage,
    transmission, readProviderEvidence: async () => ({ ...(await readProviderEvidence()),
      binding: { ...exactBinding, payloadDigest: 'e'.repeat(64) } }),
    actor: 'fixture-owner', now: '2026-09-25T19:02:00.000Z' }),
  /immutable transmission/i);
  assert.equal(calls.length, 1);
});

test('P6C bounded Resend lookup matches the immutable envelope and never sends', async () => {
  assert.equal(typeof providerService.createCimResendReconciliationLookup, 'function');
  const transmission = reconciliationTransmission({
    provider_seam_entered_at: '2026-09-25T19:00:00.000Z',
  });
  let reads = 0;
  const lookup = providerService.createCimResendReconciliationLookup({
    clock: () => new Date('2026-09-25T19:05:00.000Z'),
    listSentEmails: async ({ limit }) => {
      reads += 1;
      assert.equal(limit, 100);
      return { data: [{ id: 'provider-message-1', from: transmission.from_address,
        to: transmission.to_addresses, cc: [], bcc: [], reply_to: transmission.reply_to_address,
        subject: transmission.subject, created_at: '2026-09-25T19:00:03.000Z' }] };
    },
  });
  const proof = await lookup({ transmission, binding: proofFor(transmission).binding });
  assert.equal(reads, 1);
  assert.equal(proof.outcome, 'accepted');
  assert.equal(proof.candidates[0].providerMessageId, 'provider-message-1');
  assert.deepEqual(proof.binding, proofFor(transmission).binding);
});
