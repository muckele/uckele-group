import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizePreparedCimTransmission,
  normalizeCimProviderReadiness,
} from '../server/services/pursueCimFinalGate.js';
import { sha256 } from '../server/utils/security.js';

const now = '2026-09-25T19:00:00.000Z';
const hex = (character) => character.repeat(64);

function finalGateContext() {
  return {
    transmission: {
      id: 'transmission-1', conversation_id: 'conversation-1', state: 'prepared',
      release_state: 'ordinary', row_version: 1, invocation_authority_count: 0,
      payload_digest: hex('a'), member_digest: hex('b'), preparation_generation: 1,
      payload_version: 'deal-hunter-cim-manual-stage1-v1', communication_id: 'communication-1',
      outbox_id: 'outbox-1', provider_seam_entered_at: null,
    },
    conversation: {
      id: 'conversation-1', state: 'open', terminal_revision: 0, row_version: 1,
      recipient_authority_id: 'recipient-authority-1', recipient_fingerprint: hex('c'),
      recipient_address: 'broker@example.test',
      sender_policy_version: 'deal-hunter-cim-autopilot-v1',
      reply_policy_version: 'deal-hunter-cim-autopilot-v1',
      batching_policy_version: 'batching-off-v1',
    },
    authorization: {
      id: 'authorization-1', activation_id: 'activation-1', capability: 'fl04b-initial',
      writer_path: 'pursue-cim-initial', transmission_id: 'transmission-1',
      payload_digest: hex('a'), recipient_authority_digest: hex('c'),
      provider_profile: 'synthetic-provider', maximum_calls: 1,
      expires_at: '2026-09-25T20:00:00.000Z', consumed_at: null, withdrawn_at: null,
    },
    activation: {
      id: 'activation-1', capability: 'fl04b-initial', mode: 'active', status: 'current',
      policy_hash: hex('d'), config_hash: hex('e'), cohort_digest: hex('f'),
      permission_basis_digest: hex('1'), permission_revision: 1,
      provider_profile: 'synthetic-provider', prerequisite_activation_id: 'enrollment-activation',
    },
    safety: { outreach_paused: 0, updated_at: now },
    globalAuthorityRevision: 7,
    communication: {
      id: 'communication-1', outbox_id: 'outbox-1', delivery_state: 'not-attempted',
      direction: 'outbound', channel: 'email', source: 'pursue-cim-autopilot',
      kind: 'cim-initial', thread_id: 'thread-1', from_address: 'sender@example.test',
      to_addresses: ['broker@example.test'], cc_addresses: [], bcc_addresses: [],
      reply_to_address: 'reply@example.test', subject: 'Subject',
      body_text_digest: hex('2'), body_html_digest: hex('3'), tags: ['cim-initial'],
    },
    outbox: {
      id: 'outbox-1', communication_id: 'communication-1', state: 'prepared',
      attempt_count: 0, provider: null, provider_message_id: null,
      claim_token: null, claim_expires_at: null, retry_policy: 'reconcile-only-after-provider-pending',
    },
    members: [{
      membership: { transmission_id: 'transmission-1', touch_id: 'touch-1',
        campaign_id: 'campaign-1', opportunity_id: 'opportunity-1', display_ordinal: 1 },
      touch: { id: 'touch-1', campaign_id: 'campaign-1', opportunity_id: 'opportunity-1',
        state: 'claimed', row_version: 2, claim_token_digest: hex('4'),
        claim_expires_at: '2026-09-25T19:10:00.000Z', due_at: now,
        timezone_revision: 1, kind: 'initial', logical_slot: 'initial', ordinal: 0,
        transmission_id: 'transmission-1' },
      campaign: { id: 'campaign-1', opportunity_id: 'opportunity-1', generation: 1,
        enrollment_id: 'enrollment-1', decision_event_id: 'decision-1',
        state: 'initial-pending', terminal_revision: 0, row_version: 1,
        conversation_id: 'conversation-1', crm_submission_id: 'submission-1',
        crm_ownership_revision: 1, recipient_authority_id: 'recipient-authority-1',
        recipient_fingerprint: hex('c'), freshness_authority_digest: hex('5'),
        canonical_revision: 0, discovery_revision: 0, material_revision: 0,
        timezone_revision: 1, permission_version: 'enrollment-activation',
        permission_digest: hex('1'), permission_revision: 1, permission_scope: hex('f'),
        policy_version: 'deal-hunter-cim-autopilot-v1',
        template_version: 'deal-hunter-cim-autopilot-v1',
        local_expiry_at: null },
      decision: { id: 'decision-1', action: 'pursue', request_digest: hex('6') },
      enrollment: { id: 'enrollment-1', state: 'campaign-created', row_version: 2,
        authority_digest: hex('7'), decision_event_id: 'decision-1' },
      opportunity: { opportunity_id: 'opportunity-1', status: 'active',
        identity_version: 'identity-v1', campaign_authority_revision: 3,
        discovery_state: 'known-prospective', discovery_revision: 0, material_revision: 0,
        primary_submission_id: 'submission-1' },
      timezone: { opportunity_id: 'opportunity-1', revision: 1, state: 'verified',
        iana_timezone: 'America/Los_Angeles', evidence_digest: hex('8') },
      crmOwnership: { revision: 1, submission_id: 'submission-1' },
      crmSubmission: { id: 'submission-1', status: 'open', archived_at: null,
        deal_hunter_opportunity_id: 'opportunity-1' },
    }],
  };
}

function memberAuthority() {
  return {
    opportunityId: 'opportunity-1',
    recipientOptions: [{
      email: 'broker@example.test', provenanceFingerprint: hex('9'),
      permissionProvenanceFingerprint: hex('a'), contactAuthorityRevision: hex('b'),
    }],
    materialsState: { materialsReceived: false, advancedBeyondBrokerOutreach: false,
      evidenceCodes: [] },
    preparationBlockers: [], suppression: null, terminalReason: '', existingRequest: null,
    opportunityClaim: null, currentDispositionState: 'pursued', pursued: true,
  };
}

function currentAuthority() {
  return {
    opportunityId: 'opportunity-1', blocked: false, blockers: [],
    opportunity: { opportunity_id: 'opportunity-1', status: 'active',
      identity_version: 'identity-v1', campaign_authority_revision: 3,
      discovery_state: 'known-prospective', discovery_revision: 0, material_revision: 0 },
    sourceRows: [{ id: 'source-row-1', source_id: 'sheet-0', source_record_id: 'row-1',
      field: 'broker_email', value: 'broker@example.test', accepted_at: now }],
    sourceStates: [{ source_id: 'sheet-0', accepted_generation: 1,
      accepted_digest: hex('c'), accepted_at: now, projection_state: 'accepted' }],
    sourceHealth: { healthy: true, issues: [], requiredSources: ['sheet-0'] },
    identityExceptions: [], campaign: { id: 'campaign-1' },
  };
}

function ready() {
  return {
    version: 'cim-provider-readiness-v1', provider: 'resend', providerProfile: 'synthetic-provider',
    outboundConfigured: true, senderConfigured: true, senderAuthenticationAttested: true,
    webhookConfigured: true, requestReplyRoutingVerified: true, replyTrackingVerified: true,
    suppressionOperational: true, reconciliationOperational: true,
    evidenceRevision: 'synthetic-readiness-1', generatedAt: now,
    expiresAt: '2026-09-25T19:05:00.000Z',
  };
}

test('P6A service owns the canonical authority digest and returns a raw nonce only to the authorized execution', async () => {
  const commands = [];
  const storage = {
    async readCimFinalGateContext() { return finalGateContext(); },
    async authorizeCimProviderPending(command) {
      commands.push(command);
      return { authorized: true, blockedReason: null,
        transmission: { ...finalGateContext().transmission, state: 'provider-pending', row_version: 2,
          final_gate_authority_digest: command.finalGateAuthorityDigest,
          boundary_nonce_digest: command.boundaryNonceDigest, invocation_authority_count: 1 },
        boundaryNonceDigest: command.boundaryNonceDigest };
    },
  };
  const result = await authorizePreparedCimTransmission({ storage,
    transmissionId: 'transmission-1', authorizationId: 'authorization-1',
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'final-gate-worker', now,
    finalGateAuthorityDigest: hex('f'), boundaryNonce: 'caller-must-not-control-this',
    loadMemberAuthority: async () => memberAuthority(),
    readCurrentAuthority: async () => currentAuthority(),
    readProviderReadiness: async () => ready(),
  });

  assert.equal(result.authorized, true);
  assert.match(result.boundaryNonce, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(result.boundaryNonce, 'caller-must-not-control-this');
  assert.equal(commands.length, 1);
  assert.match(commands[0].finalGateAuthorityDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(commands[0].finalGateAuthorityDigest, hex('f'));
  assert.equal(commands[0].boundaryNonceDigest, sha256(result.boundaryNonce));
  assert.equal(JSON.stringify(commands[0]).includes(result.boundaryNonce), false);
  assert.equal(commands[0].authoritySnapshot.gateInstant, now);
  assert.equal(commands[0].authoritySnapshot.readiness.requestReplyRoutingVerified, true);
});

test('P6A blocked and ambiguous outcomes never expose the raw boundary nonce', async () => {
  const common = { transmissionId: 'transmission-1', authorizationId: 'authorization-1',
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'final-gate-worker', now,
    loadMemberAuthority: async () => memberAuthority(),
    readCurrentAuthority: async () => currentAuthority(),
    readProviderReadiness: async () => ready() };
  const blocked = await authorizePreparedCimTransmission({ ...common, storage: {
    async readCimFinalGateContext() { return finalGateContext(); },
    async authorizeCimProviderPending() {
      return { authorized: false, blockedReason: 'central_pause', transmission: null,
        boundaryNonceDigest: null };
    },
  } });
  assert.deepEqual(blocked, { authorized: false, blockedReason: 'central_pause',
    transmission: null, boundaryNonceDigest: null, reconciliationOnly: false });
  assert.equal(Object.hasOwn(blocked, 'boundaryNonce'), false);

  const ambiguous = await authorizePreparedCimTransmission({ ...common, storage: {
    async readCimFinalGateContext() { return finalGateContext(); },
    async authorizeCimProviderPending() {
      const error = new Error('synthetic commit result lost');
      error.code = 'CIM_FINAL_GATE_OUTCOME_UNKNOWN';
      throw error;
    },
  } });
  assert.deepEqual(ambiguous, { authorized: false,
    blockedReason: 'authorization_outcome_unknown', transmission: null,
    boundaryNonceDigest: null, reconciliationOnly: true });
  assert.equal(Object.hasOwn(ambiguous, 'boundaryNonce'), false);
});

test('P10A final gate rejects controlled-mailbox substitutions before readiness or provider-pending', async (t) => {
  const baseConfig = () => ({
    isProduction: false,
    delivery: { provider: 'console' },
    dealHunter: { cimProvider: {
      enabled: true, profile: 'controlled-mailbox-v1', mode: 'controlled-mailbox',
      provider: 'resend', resendApiKey: 'mailbox-outbound-key',
      resendFromEmail: 'sender@example.test', resendReplyTo: 'reply@mailbox.example.test',
      resendInboundDomain: 'mailbox.example.test', emailWebhookSecret: 'mailbox-webhook-secret',
      reconciliationApiKey: 'mailbox-read-key', allowedRecipients: ['broker@example.test'],
    } },
  });
  for (const [name, mutate, expectedReason] of [
    ['activation profile', (context) => { context.activation.provider_profile = 'production-resend-v1'; },
      'profile_mismatch'],
    ['authorization profile', (context) => { context.authorization.provider_profile = 'production-resend-v1'; },
      'profile_mismatch'],
    ['recipient', (context) => { context.communication.to_addresses = ['attacker@example.test']; },
      'mailbox_recipient_mismatch'],
    ['compound recipient', (context) => {
      context.communication.to_addresses = ['Broker <broker@example.test>, attacker@example.test'];
    }, 'mailbox_recipient_mismatch'],
    ['malformed carbon copy', (context) => {
      context.communication.cc_addresses = ['not-an-email'];
    }, 'mailbox_recipient_mismatch'],
    ['sender', (context) => { context.communication.from_address = 'production@example.test'; },
      'mailbox_sender_mismatch'],
    ['compound sender', (context) => {
      context.communication.from_address = 'Sender <sender@example.test>, attacker@example.test';
    }, 'mailbox_sender_mismatch'],
    ['reply domain', (context) => { context.communication.reply_to_address = 'reply@production.example.test'; },
      'mailbox_reply_domain_mismatch'],
    ['credential namespace', (context, config) => { config.dealHunter.cimProvider.resendApiKey = ''; },
      'outbound_credentials_missing'],
  ]) {
    await t.test(name, async () => {
      const context = finalGateContext();
      context.activation.provider_profile = 'controlled-mailbox-v1';
      context.authorization.provider_profile = 'controlled-mailbox-v1';
      context.communication.reply_to_address = 'reply@mailbox.example.test';
      const configOverride = baseConfig();
      mutate(context, configOverride);
      let readinessCalls = 0;
      let providerPendingCalls = 0;
      const outcome = await authorizePreparedCimTransmission({
        storage: {
          async readCimFinalGateContext() { return context; },
          async authorizeCimProviderPending() { providerPendingCalls += 1; throw new Error('must not authorize'); },
        },
        transmissionId: 'transmission-1', authorizationId: 'authorization-1',
        writerPath: 'pursue-cim-initial', providerProfile: 'controlled-mailbox-v1',
        actor: 'final-gate-worker', now, configOverride,
        readProviderReadiness: async () => { readinessCalls += 1; return ready(); },
      });
      assert.equal(outcome.blockedReason, expectedReason);
      assert.equal(readinessCalls, 0);
      assert.equal(providerPendingCalls, 0);
    });
  }
});

test('P10A exact controlled-mailbox authority can reach provider-pending', async () => {
  const context = finalGateContext();
  context.activation.provider_profile = 'controlled-mailbox-v1';
  context.authorization.provider_profile = 'controlled-mailbox-v1';
  context.communication.reply_to_address = 'reply@mailbox.example.test';
  let providerPendingCalls = 0;
  const storage = {
    async readCimFinalGateContext() { return context; },
    async authorizeCimProviderPending(command) {
      providerPendingCalls += 1;
      return { authorized: true, blockedReason: null,
        transmission: { ...context.transmission, state: 'provider-pending', row_version: 2,
          final_gate_authority_digest: command.finalGateAuthorityDigest,
          boundary_nonce_digest: command.boundaryNonceDigest, invocation_authority_count: 1 },
        boundaryNonceDigest: command.boundaryNonceDigest };
    },
  };
  const configOverride = {
    isProduction: false,
    delivery: { provider: 'console' },
    dealHunter: { cimProvider: {
      enabled: true, profile: 'controlled-mailbox-v1', mode: 'controlled-mailbox',
      provider: 'resend', resendApiKey: 'mailbox-outbound-key',
      resendFromEmail: 'sender@example.test', resendReplyTo: 'reply@mailbox.example.test',
      resendInboundDomain: 'mailbox.example.test', emailWebhookSecret: 'mailbox-webhook-secret',
      reconciliationApiKey: 'mailbox-read-key', allowedRecipients: ['broker@example.test'],
    } },
  };
  const outcome = await authorizePreparedCimTransmission({ storage,
    transmissionId: 'transmission-1', authorizationId: 'authorization-1',
    writerPath: 'pursue-cim-initial', providerProfile: 'controlled-mailbox-v1',
    actor: 'final-gate-worker', now, configOverride,
    loadMemberAuthority: async () => memberAuthority(),
    readCurrentAuthority: async () => currentAuthority(),
    readProviderReadiness: async () => ({ ...ready(), providerProfile: 'controlled-mailbox-v1' }),
  });
  assert.equal(outcome.authorized, true);
  assert.equal(providerPendingCalls, 1);
});

test('P6A production readiness remains closed until request-specific signed inbound routing is proven', () => {
  const readiness = normalizeCimProviderReadiness({
    provider: 'resend', outboundConfigured: true, senderConfigured: true,
    senderAuthenticationAttested: true, webhookConfigured: true,
    replyTrackingConfigured: true, replyTrackingVerified: true,
    suppressionOperational: true, reconciliationOperational: true,
    evidenceRevision: 'production-readiness-1', generatedAt: now,
    expiresAt: '2026-09-25T19:05:00.000Z',
  }, { providerProfile: 'production-resend', now });
  assert.equal(readiness.requestReplyRoutingVerified, false);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers, ['request_reply_routing_unverified']);
});

test('P6C unknown transmission or policy tuple terminalizes before readiness or provider work', async () => {
  for (const mutate of [
    (context) => { context.transmission.payload_version = 'future-payload-v2'; },
    (context) => { context.members[0].campaign.template_version = 'future-template-v2'; },
    (context) => { context.conversation.sender_policy_version = 'future-sender-v2'; },
    (context) => { context.members[0].campaign.permission_version = 'future-activation-v2'; },
    (context) => { context.conversation.batching_policy_version = 'future-batching-v2'; },
  ]) {
    const context = finalGateContext();
    mutate(context);
    let terminalCalls = 0;
    let readinessCalls = 0;
    let providerPendingCalls = 0;
    const outcome = await authorizePreparedCimTransmission({
      storage: {
        async readCimFinalGateContext() { return context; },
        async appendCimTerminalEvent() { terminalCalls += 1; return { applied: true }; },
        async authorizeCimProviderPending() { providerPendingCalls += 1;
          throw new Error('must not authorize'); },
      },
      transmissionId: 'transmission-1', authorizationId: 'authorization-1',
      writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
      actor: 'final-gate-worker', now,
      loadMemberAuthority: async () => memberAuthority(),
      readCurrentAuthority: async () => currentAuthority(),
      readProviderReadiness: async () => { readinessCalls += 1; return ready(); },
    });
    assert.equal(outcome.blockedReason, 'unknown_policy_version');
    assert.equal(terminalCalls, 1);
    assert.equal(readinessCalls, 0);
    assert.equal(providerPendingCalls, 0);
  }
});

test('P6C unknown-policy CAS conflict must re-read and prove a durable safe terminal state', async () => {
  const unknown = finalGateContext();
  unknown.members[0].campaign.policy_version = 'future-policy-v2';
  const terminal = structuredClone(unknown);
  terminal.members[0].campaign.state = 'action-required';
  terminal.members[0].campaign.reason_code = 'unknown_policy_version';
  terminal.members[0].campaign.row_version += 1;
  terminal.members[0].campaign.terminal_revision += 1;
  let reads = 0;
  const outcome = await authorizePreparedCimTransmission({
    storage: {
      async readCimFinalGateContext() { reads += 1; return reads === 1 ? unknown : terminal; },
      async appendCimTerminalEvent() { return { applied: false, replay: false, conflict: true }; },
      async authorizeCimProviderPending() { throw new Error('must not authorize'); },
    },
    transmissionId: 'transmission-1', authorizationId: 'authorization-1',
    writerPath: 'pursue-cim-initial', providerProfile: 'synthetic-provider',
    actor: 'final-gate-worker', now,
  });
  assert.equal(outcome.blockedReason, 'unknown_policy_version');
  assert.equal(reads, 2);
});
