import assert from 'node:assert/strict';
import test from 'node:test';

import * as providerService from '../server/services/pursueCimProvider.js';
import {
  BROKER,
  GATE_NOW,
  GMAIL_PROFILE,
  SENDER,
  createGmailGateFixture,
} from './fixtures/pursueCimGmailGateFixture.js';

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

function cadenceContext() {
  return { transmission: { id: 'transmission-1', campaign_terminal_revision: 0 },
    members: [{ membership: { transmission_id: 'transmission-1', touch_id: 'touch-1',
      campaign_id: 'campaign-1', cancelled_at: null },
    touch: { id: 'touch-1', campaign_id: 'campaign-1', opportunity_id: 'opp-1',
      logical_slot: 'initial', kind: 'initial', ordinal: 0, timezone_revision: 1,
      row_version: 4 },
    campaign: { id: 'campaign-1', opportunity_id: 'opp-1',
      policy_version: 'deal-hunter-cim-autopilot-v1', timezone_revision: 1,
      state: 'initial-pending', terminal_revision: 0, row_version: 8,
      initial_accepted_at: null, local_expiry_at: null, expiry_derivation: '{}' },
    timezone: { opportunity_id: 'opp-1', revision: 1,
      iana_timezone: 'America/New_York' } }] };
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
    async readCimCadenceContext() { return cadenceContext(); },
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
    cadence: finalizeCalls[0].cadence,
  });
  assert.equal(finalizeCalls[0].cadence.nextTouch.kind, 'follow-up-1');
  assert.equal(finalizeCalls[0].cadence.acceptedAt, '2026-09-25T19:00:01.000Z');

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
  const storage = { async readCimCadenceContext() { return cadenceContext(); },
    async reconcileCimTransmission(command) {
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
  const common = { storage: { async readCimCadenceContext() { return cadenceContext(); },
    async reconcileCimTransmission(command) {
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
    storage: { async readCimCadenceContext() { return cadenceContext(); },
      async finalizeCimTransmission(command) {
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
  assert.equal(commands[0].cadence.acceptedAt, '2026-09-25T19:00:07.000Z');
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
  const storage = { async readCimCadenceContext() { return cadenceContext(); },
    async reconcileCimTransmission(command) {
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

test('P10A reconciliation rejects evidence from a substituted provider profile', async () => {
  const transmission = reconciliationTransmission();
  const storage = {
    async readCimCadenceContext() { return cadenceContext(); },
    async reconcileCimTransmission(command) {
      return { applied: true, conflict: false,
        transmission: { ...transmission, state: command.outcome } };
    },
  };
  await assert.rejects(providerService.reconcileCimProviderTransmission({
    storage, transmission, providerProfile: 'controlled-mailbox-v1',
    actor: 'fixture-owner', now: '2026-09-25T19:02:00.000Z',
    readProviderEvidence: async () => ({ ...proofFor(transmission, {
      outcome: 'accepted', candidates: [{ provider: 'resend',
        providerMessageId: 'provider-message-1', evidenceId: 'candidate-1' }],
    }), providerProfile: 'production-resend-v1' }),
  }), /provider profile/i);
});

test('P10A configured reconciliation uses only the controlled read credential and profile binding', async () => {
  const providerProfile = 'controlled-mailbox-v1';
  const transmission = reconciliationTransmission({
    provider_seam_entered_at: '2026-09-25T19:00:00.000Z',
  });
  const binding = { ...proofFor(transmission).binding, providerProfile };
  let reads = 0;
  const lookup = providerService.createCimResendReconciliationLookup({
    configOverride: {
      delivery: { resendApiKey: 'production-read-key' },
      dealHunter: { cimProvider: { mode: 'controlled-mailbox', profile: providerProfile,
        provider: 'resend', reconciliationApiKey: 'mailbox-read-key' } },
    },
    clock: () => new Date('2026-09-25T19:05:00.000Z'),
    fetcher: async (url, options) => {
      reads += 1;
      assert.equal(url, 'https://api.resend.com/emails?limit=100');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer mailbox-read-key');
      assert.equal(JSON.stringify(options).includes('production-read-key'), false);
      return Response.json({ data: [{ id: 'provider-message-1',
        from: transmission.from_address, to: transmission.to_addresses, cc: [], bcc: [],
        reply_to: transmission.reply_to_address, subject: transmission.subject,
        created_at: '2026-09-25T19:00:03.000Z' }] });
    },
  });
  const proof = await lookup({ transmission, binding, providerProfile });
  assert.equal(reads, 1);
  assert.equal(proof.providerProfile, providerProfile);
  assert.equal(proof.binding.providerProfile, providerProfile);
  assert.equal(proof.outcome, 'accepted');
});

test('P10A configured reconciliation rejects a mismatched profile before the read', async () => {
  const transmission = reconciliationTransmission({
    provider_seam_entered_at: '2026-09-25T19:00:00.000Z',
  });
  const providerProfile = 'production-resend-v1';
  const binding = { ...proofFor(transmission).binding, providerProfile };
  let reads = 0;
  const lookup = providerService.createCimResendReconciliationLookup({
    configOverride: {
      delivery: { resendApiKey: 'production-read-key' },
      dealHunter: { cimProvider: { mode: 'controlled-mailbox',
        profile: 'controlled-mailbox-v1', provider: 'resend',
        reconciliationApiKey: 'mailbox-read-key' } },
    },
    fetcher: async () => { reads += 1; throw new Error('must not read'); },
  });
  await assert.rejects(lookup({ transmission, binding, providerProfile }), /provider profile/i);
  assert.equal(reads, 0);
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

async function gmailSend(fixture, outcome, { now = GATE_NOW } = {}) {
  return providerService.finalizeAuthorizedCimTransmission({ storage: fixture.storage,
    finalGateResult: outcome, authorizationId: fixture.authorization.id,
    writerPath: fixture.writerPath, providerProfile: GMAIL_PROFILE, actor: 'pursue-cim-sender',
    now: new Date(now), configOverride: fixture.config, mailProvider: fixture.mailProvider });
}

const row = (database, table, id) => database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const terminalEventCount = (database) => database.prepare(
  'SELECT COUNT(*) AS n FROM deal_hunter_cim_terminal_events').get().n;

test('gmail normalizer maps accepted, definitive failure, quota and not-attempted', () => {
  const normalize = providerService.normalizeCimProviderOutcome;
  const attempted = { provider: 'gmail', providerAttempted: true, providerSeamEntered: true };
  assert.deepEqual(normalize({ ...attempted, status: 'sent', providerMessageId: 'gmail-1' }),
    { category: 'accepted', provider: 'gmail', providerMessageId: 'gmail-1',
      providerResultCode: 'accepted' });
  assert.deepEqual(normalize({ ...attempted, status: 'failed', definitiveFailure: true,
    errorCategory: 'gmail_400' }), { category: 'definitive-failure', provider: 'gmail',
    providerMessageId: null, providerResultCode: 'gmail_400' });
  assert.deepEqual(normalize({ ...attempted, status: 'failed', providerUnsent: true,
    errorCategory: 'provider_quota' }), { category: 'unsent', provider: 'gmail',
    providerMessageId: null, providerResultCode: 'provider_quota' });
  assert.deepEqual(normalize({ ...attempted, status: 'failed', providerUnsent: true,
    errorCategory: 'gmail_token_invalid' }), { category: 'unsent', provider: 'gmail',
    providerMessageId: null, providerResultCode: 'gmail_token_invalid' });
  // An unsent claim with an unknown code is never released: it stays ambiguous.
  assert.equal(normalize({ ...attempted, status: 'failed', providerUnsent: true,
    errorCategory: 'gmail_500' }).category, 'ambiguous');
  assert.equal(normalize({ ...attempted, status: 'ambiguous', errorCategory: 'gmail_timeout' })
    .category, 'ambiguous');
});

test('gmail accepted outcome finalizes the touch with provider gmail and stores gmail threadId on the conversation', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-accepted');
  const { database, ids, mailProvider } = fixture;
  const gate = await fixture.gate();
  assert.equal(gate.authorized, true, JSON.stringify(gate));
  const result = await gmailSend(fixture, gate);
  assert.equal(result.outcome.category, 'accepted');
  assert.equal(result.durableResult.applied, true);
  assert.deepEqual(result.gmailThread, { applied: true, replay: false, conflict: false });
  assert.equal(mailProvider.sent.length, 1);
  const [sent] = mailProvider.sent;
  assert.equal(sent.rfcMessageId, `<${gate.transmission.id}@uckele.example.test>`);
  assert.equal(sent.to, BROKER);
  assert.equal(sent.from, SENDER);
  assert.equal(sent.inReplyTo, null);
  const transmission = row(database, 'deal_hunter_cim_transmissions', gate.transmission.id);
  assert.deepEqual({ state: transmission.state, provider: transmission.provider,
    providerMessageId: transmission.provider_message_id },
  { state: 'accepted', provider: 'gmail', providerMessageId: sent.messageId });
  assert.equal(row(database, 'deal_hunter_cim_campaign_touches', ids.touchId).state, 'accepted');
  assert.equal(row(database, 'deal_hunter_cim_campaigns', ids.campaignId).state, 'active-follow-up');
  assert.equal(row(database, 'deal_hunter_broker_conversations', ids.conversationId).gmail_thread_id,
    sent.threadId);
  assert.equal(result.durableResult.nextTouch.kind, 'follow-up-1');
});

test('gmail accepted outcome keeps a different stored thread and still finalizes', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-thread-conflict');
  const { database, ids } = fixture;
  database.prepare(`UPDATE deal_hunter_broker_conversations SET gmail_thread_id = 'older-thread'
    WHERE id = ?`).run(ids.conversationId);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const result = await gmailSend(fixture, await fixture.gate());
  assert.equal(result.outcome.category, 'accepted');
  assert.equal(result.durableResult.applied, true);
  assert.deepEqual(result.gmailThread, { applied: false, replay: false, conflict: true });
  assert.equal(row(database, 'deal_hunter_broker_conversations', ids.conversationId).gmail_thread_id,
    'older-thread');
  assert.equal(row(database, 'deal_hunter_cim_campaign_touches', ids.touchId).state, 'accepted');
  assert.deepEqual(warnings, ['[pursue-cim] gmail_thread_conflict: the conversation keeps its stored Gmail thread']);
});

test('gmail follow-up is sent into the conversation thread replying to the initial Message-ID', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-follow-up', { kind: 'follow-up' });
  const gate = await fixture.gate();
  assert.equal(gate.authorized, true, JSON.stringify(gate));
  const result = await gmailSend(fixture, gate);
  assert.equal(result.outcome.category, 'accepted');
  const [sent] = fixture.mailProvider.sent;
  assert.equal(sent.threadId, 'gmail-thread-gmail-follow-up');
  assert.equal(sent.inReplyTo, '<initial-gmail-follow-up@uckele.example.test>');
  assert.deepEqual(sent.references, ['<initial-gmail-follow-up@uckele.example.test>']);
  assert.match(sent.subject, /^Re: CIM \/ NDA request for Acme Plumbing$/);
  assert.equal(result.gmailThread.replay, true);
});

test('quota leaves the touch scheduled and not attempted', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-quota');
  const { database, storage, ids, mailProvider } = fixture;
  mailProvider.quotaNext();
  const gate = await fixture.gate();
  const result = await gmailSend(fixture, gate);
  assert.equal(result.outcome.category, 'unsent');
  assert.equal(result.outcome.providerResultCode, 'provider_quota');
  assert.equal(result.durableResult.applied, true);
  assert.equal(mailProvider.sent.length, 0);
  const touch = row(database, 'deal_hunter_cim_campaign_touches', ids.touchId);
  assert.deepEqual({ state: touch.state, transmission: touch.transmission_id,
    claim: touch.claim_token_digest }, { state: 'scheduled', transmission: null, claim: null });
  const transmission = row(database, 'deal_hunter_cim_transmissions', gate.transmission.id);
  assert.deepEqual({ state: transmission.state, provider: transmission.provider,
    code: transmission.provider_result_code, messageId: transmission.provider_message_id },
  { state: 'cancelled-before-provider', provider: 'gmail', code: 'provider_quota',
    messageId: null });
  assert.deepEqual({ ...row(database, 'deal_hunter_cim_campaigns', ids.campaignId) },
    { ...row(database, 'deal_hunter_cim_campaigns', ids.campaignId), state: 'initial-pending',
      terminal_revision: 0 });
  assert.equal(row(database, 'deal_hunter_broker_conversations', ids.conversationId).state, 'open');
  assert.equal(terminalEventCount(database), 0);
  // A replay of the release is idempotent.
  const replay = await storage.releaseCimProviderPendingUnsent({ transmissionId: gate.transmission.id,
    payloadDigest: gate.transmission.payload_digest, expectedRowVersion: gate.transmission.row_version + 1,
    provider: 'gmail', providerResultCode: 'provider_quota', actor: 'pursue-cim-sender', now: GATE_NOW });
  assert.equal(replay.replay, true);

  // The next run lists, claims, prepares (next generation) and sends the same touch.
  const later = '2026-09-30T16:00:00.000Z';
  const [candidate] = await storage.listDueCimInitialTouches({ now: later });
  assert.equal(candidate.touch_id, ids.touchId);
  assert.equal(candidate.preparation_generation, 2);
  const claim = await storage.claimDueCimTouch({ touchId: ids.touchId,
    expectedRowVersion: candidate.row_version, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: 'd'.repeat(64),
    claimOwner: 'gmail-worker', claimExpiresAt: '2026-09-30T16:04:00.000Z', now: later });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const communication = database.prepare('SELECT * FROM crm_communications WHERE id = ?')
    .get(gate.transmission.communication_id);
  const prepared = await storage.prepareCimTransmission({ touchIds: [ids.touchId],
    claimTokenDigest: 'd'.repeat(64), expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, preparationGeneration: 2,
    payloadVersion: 'deal-hunter-cim-pursue-initial-v2', fromAddress: SENDER,
    toAddresses: [BROKER], ccAddresses: [], bccAddresses: [], replyToAddress: SENDER,
    subject: communication.subject, bodyText: communication.body_text,
    bodyHtmlSanitized: communication.body_html_sanitized,
    tags: JSON.parse(communication.metadata).tags, actor: 'gmail-worker', now: later });
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  assert.notEqual(prepared.transmission.id, gate.transmission.id);
  const issued = await storage.issueCimLiveProviderAuthorization({ id: 'authorization-retry',
    activationId: 'gmail-fl04b-initial', capability: 'fl04b-initial',
    writerPath: 'pursue-cim-initial', transmissionId: prepared.transmission.id,
    payloadDigest: prepared.transmission.payload_digest,
    recipientAuthorityDigest: fixture.recipientFingerprint, providerProfile: GMAIL_PROFILE,
    expiresAt: '2026-09-30T17:00:00.000Z', actor: 'fixture-owner', reason: 'retry', now: later });
  assert.equal(issued.issued, true);
  const retryGate = await fixture.gate({ transmissionId: prepared.transmission.id,
    authorizationId: 'authorization-retry', now: later });
  assert.equal(retryGate.authorized, true, JSON.stringify(retryGate));
  const retry = await providerService.finalizeAuthorizedCimTransmission({ storage,
    finalGateResult: retryGate, authorizationId: 'authorization-retry',
    writerPath: 'pursue-cim-initial', providerProfile: GMAIL_PROFILE, actor: 'pursue-cim-sender',
    now: new Date(later), configOverride: fixture.config, mailProvider });
  assert.equal(retry.outcome.category, 'accepted');
  assert.equal(mailProvider.sent.length, 1);
  assert.equal(row(database, 'deal_hunter_cim_campaign_touches', ids.touchId).state, 'accepted');
});

test('not-attempted (revoked token on send) releases the touch with the provider code', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-not-attempted');
  fixture.mailProvider.failNext('not-attempted', { code: 'gmail_token_invalid' });
  const gate = await fixture.gate();
  const result = await gmailSend(fixture, gate);
  assert.equal(result.outcome.category, 'unsent');
  assert.equal(row(fixture.database, 'deal_hunter_cim_transmissions', gate.transmission.id)
    .provider_result_code, 'gmail_token_invalid');
  assert.equal(row(fixture.database, 'deal_hunter_cim_campaign_touches', fixture.ids.touchId).state,
    'scheduled');
  assert.equal(row(fixture.database, 'deal_hunter_cim_campaigns', fixture.ids.campaignId).state,
    'initial-pending');
  assert.equal(terminalEventCount(fixture.database), 0);
});

test('gmail definitive failure moves the campaign to action-required', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-definitive');
  fixture.mailProvider.failNext('definitive-failure', { code: 'gmail_400' });
  const result = await gmailSend(fixture, await fixture.gate());
  assert.equal(result.outcome.category, 'definitive-failure');
  assert.equal(row(fixture.database, 'deal_hunter_cim_campaigns', fixture.ids.campaignId).state,
    'action-required');
});

test('gmail ambiguous outcome is reconciled through findSent before anything else', async (t) => {
  const found = await createGmailGateFixture(t, 'gmail-ambiguous-found');
  found.mailProvider.failNext('ambiguous', { delivered: true });
  const foundResult = await gmailSend(found, await found.gate());
  assert.equal(foundResult.reconciled, true);
  assert.equal(foundResult.outcome.category, 'accepted');
  assert.equal(found.mailProvider.sent.length, 1);
  const foundTransmission = found.database.prepare(`SELECT * FROM deal_hunter_cim_transmissions
    WHERE state = 'accepted'`).get();
  assert.equal(foundTransmission.provider, 'gmail');
  assert.equal(foundTransmission.provider_message_id, found.mailProvider.sent[0].messageId);
  assert.equal(row(found.database, 'deal_hunter_broker_conversations', found.ids.conversationId)
    .gmail_thread_id, found.mailProvider.sent[0].threadId);

  const lost = await createGmailGateFixture(t, 'gmail-ambiguous-lost');
  lost.mailProvider.failNext('ambiguous');
  const lostResult = await gmailSend(lost, await lost.gate());
  assert.equal(lostResult.outcome.category, 'ambiguous');
  assert.equal(lost.mailProvider.sent.length, 0);
  assert.equal(row(lost.database, 'deal_hunter_cim_campaigns', lost.ids.campaignId).state,
    'provider-ambiguous');
});

test('the central pause still blocks with gmail ready', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-paused');
  fixture.database.prepare(`UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 1`).run();
  const outcome = await fixture.gate();
  assert.equal(outcome.authorized, false);
  assert.equal(outcome.blockedReason, 'central_pause');
  assert.equal(fixture.mailProvider.sent.length, 0);
  assert.equal(row(fixture.database, 'deal_hunter_cim_transmissions', fixture.transmission.id).state,
    'prepared');
});

test('revoked token: final gate refuses with gmail_token_invalid and the campaign state is unchanged', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-revoked');
  const { database, ids } = fixture;
  const before = row(database, 'deal_hunter_cim_campaigns', ids.campaignId);
  fixture.mailProvider.setReadinessReasons(['gmail_token_invalid']);
  const outcome = await fixture.gate();
  assert.equal(outcome.authorized, false);
  assert.equal(outcome.blockedReason, 'provider_readiness_unavailable');
  assert.deepEqual(outcome.readinessBlockers, ['gmail_token_invalid']);
  assert.deepEqual(row(database, 'deal_hunter_cim_campaigns', ids.campaignId), before);
  assert.equal(terminalEventCount(database), 0);
  assert.equal(row(database, 'deal_hunter_cim_transmissions', fixture.transmission.id).state,
    'prepared');
  assert.equal(fixture.mailProvider.attempts.length, 0);
});

test('a Gmail profile without a mail provider never reaches Resend', async (t) => {
  const fixture = await createGmailGateFixture(t, 'gmail-no-provider');
  const gate = await fixture.gate();
  let fetches = 0;
  const providerResult = await providerService.sendAuthorizedCimTransmission({
    storage: fixture.storage, finalGateResult: gate, authorizationId: fixture.authorization.id,
    writerPath: fixture.writerPath, providerProfile: GMAIL_PROFILE, actor: 'pursue-cim-sender',
    now: new Date(GATE_NOW), configOverride: fixture.config,
    fetcher: async () => { fetches += 1; return Response.json({ id: 'resend-id' }); } });
  assert.equal(providerResult.errorCategory, 'cim-provider-profile-mismatch');
  assert.notEqual(providerResult.providerSeamEntered, true);
  assert.equal(fetches, 0);
});
