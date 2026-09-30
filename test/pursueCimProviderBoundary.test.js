import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  buildCimProviderPayloadDigest,
  createCimProviderBoundaryAuthorization,
} from '../server/services/cimProviderBoundary.js';
import { sendPreparedMessage } from '../server/services/delivery.js';
import { createPursueCimProviderFake } from './fixtures/pursueCimHarness.js';

const resendBoundaryConfig = ({ enabled = true, profile = 'synthetic-provider' } = {}) => ({
  isProduction: false,
  server: { outboundRequestTimeoutMs: 100 },
  delivery: {
    provider: 'resend',
    resendApiKey: 'synthetic-key',
    resendFromEmail: 'sender@example.test',
  },
  dealHunter: { cimProvider: { enabled, profile } },
});

const legacyCimMessage = (overrides = {}) => ({
  kind: 'deal-hunter-cim-request',
  from: 'sender@example.test',
  to: ['broker@example.test'],
  replyTo: 'reply@example.test',
  subject: 'Request for materials',
  text: 'Please share the CIM.',
  html: '<p>Please share the CIM.</p>',
  tags: [{ name: 'cim_request_id', value: 'legacy-request-1' }],
  ...overrides,
});

function createBoundaryFixture({
  suffix = 'fixture',
  kind = 'cim-initial',
  writerPath = 'pursue-cim-initial',
  capability = 'fl04b-initial',
  memberKinds = ['initial'],
  seamResult = { entered: true, alreadyEntered: false, unauthorized: false },
} = {}) {
  const transmissionId = `transmission-${suffix}`;
  const authorizationId = `authorization-${suffix}`;
  const communicationId = `communication-${suffix}`;
  const outboxId = `outbox-${suffix}`;
  const rawNonce = `same-process-boundary-nonce-${suffix}`;
  const providerProfile = 'synthetic-provider';
  const message = {
    kind,
    transmissionId,
    communicationId,
    idempotencyKey: `provider-key-${suffix}`,
    from: 'sender@example.test',
    to: ['broker@example.test'],
    cc: [],
    bcc: [],
    replyTo: 'reply@example.test',
    subject: 'Synthetic subject',
    text: 'Synthetic body',
    html: '<p>Synthetic body</p>',
    tags: ['cim-outreach'],
  };
  const members = memberKinds.map((memberKind, index) => ({
    touch: { id: `touch-${index + 1}-${suffix}`, kind: memberKind },
    campaign: { template_version: `template-v${index + 1}` },
  }));
  const payloadDigest = buildCimProviderPayloadDigest({
    message,
    touchIds: members.map(({ touch }) => touch.id),
    templateVersions: members.map(({ campaign }) => campaign.template_version),
    payloadVersion: 'payload-v1',
  });
  const durable = {
    transmission: {
      id: transmissionId,
      state: 'provider-pending',
      row_version: 2,
      invocation_authority_count: 1,
      boundary_nonce_digest: createHash('sha256').update(rawNonce).digest('hex'),
      provider_seam_entered_at: null,
      payload_digest: payloadDigest,
      payload_version: 'payload-v1',
      provider_idempotency_key: message.idempotencyKey,
      communication_id: communicationId,
      outbox_id: outboxId,
    },
    authorization: {
      id: authorizationId,
      transmission_id: transmissionId,
      activation_id: `activation-${suffix}`,
      capability,
      writer_path: writerPath,
      payload_digest: payloadDigest,
      provider_profile: providerProfile,
      maximum_calls: 1,
      consumed_at: '2026-09-25T19:00:00.000Z',
      withdrawn_at: null,
      expires_at: '2026-09-25T20:00:00.000Z',
    },
    activation: {
      id: `activation-${suffix}`,
      capability,
      provider_profile: providerProfile,
      status: 'current',
    },
    communication: {
      id: communicationId,
      source: 'pursue-cim-autopilot',
      kind,
      delivery_state: 'provider-pending',
      from_address: message.from,
      to_addresses: message.to,
      cc_addresses: message.cc,
      bcc_addresses: message.bcc,
      reply_to_address: message.replyTo,
      subject: message.subject,
      body_text: message.text,
      body_html_sanitized: message.html,
      tags: message.tags,
    },
    outbox: {
      id: outboxId,
      communication_id: communicationId,
      state: 'provider-pending',
    },
    members,
  };
  const counts = { reads: 0, seamEntries: 0, providerCalls: 0 };
  const storage = {
    async readCimFinalGateContext() {
      counts.reads += 1;
      return durable;
    },
    async enterCimProviderSeam(command) {
      counts.seamEntries += 1;
      counts.lastSeamCommand = command;
      return typeof seamResult === 'function' ? seamResult(command, durable) : seamResult;
    },
  };
  const authorization = createCimProviderBoundaryAuthorization({
    finalGateResult: { authorized: true, boundaryNonce: rawNonce, transmission: durable.transmission },
    authorizationId,
    writerPath,
    providerProfile,
    actor: 'fixture-owner',
  });
  return { authorization, counts, durable, message, payloadDigest, rawNonce, storage };
}

async function attemptBoundary(fixture, {
  message = fixture.message,
  authorization = fixture.authorization,
  enabled = true,
  profile = 'synthetic-provider',
} = {}) {
  return sendPreparedMessage(message, {
    storage: fixture.storage,
    cimProviderAuthorization: authorization,
    now: new Date('2026-09-25T19:00:00.000Z'),
    configOverride: resendBoundaryConfig({ enabled, profile }),
    fetcher: async () => {
      fixture.counts.providerCalls += 1;
      return new Response(JSON.stringify({ id: 'synthetic-provider-message' }), { status: 200 });
    },
  });
}

function readCimProviderEnabled(environmentValue) {
  const script = "import { getConfig } from './server/config.js'; process.stdout.write(JSON.stringify(getConfig().dealHunter.cimProvider.enabled));";
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, DEAL_HUNTER_CIM_PROVIDER_ENABLED: environmentValue },
  }));
}

test('P6B CIM provider environment hard-off defaults false and accepts only exact true', () => {
  assert.equal(readCimProviderEnabled(''), false);
  assert.equal(readCimProviderEnabled('1'), false);
  assert.equal(readCimProviderEnabled('yes'), false);
  assert.equal(readCimProviderEnabled('TRUE'), false);
  assert.equal(readCimProviderEnabled('true'), true);
});

test('P6B private delivery seam default-denies CIM work without exact boundary authority', async () => {
  let providerCalls = 0;
  const result = await sendPreparedMessage(legacyCimMessage(), {
    configOverride: resendBoundaryConfig(),
    fetcher: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCategory, 'cim-provider-authorization-required');
  assert.equal(providerCalls, 0);
});

test('P6B unknown CIM namespace kinds fail closed at the private provider seam', async (t) => {
  for (const kind of ['cim-unknown-v2', 'deal-hunter-cim-unknown-v2']) {
    await t.test(kind, async () => {
      let providerCalls = 0;
      const result = await sendPreparedMessage(legacyCimMessage({ kind, tags: [] }), {
        configOverride: resendBoundaryConfig({ enabled: false }),
        fetcher: async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
        },
      });
      assert.equal(result.errorCategory, 'cim-provider-hard-off');
      assert.equal(providerCalls, 0);
    });
  }
});

test('P6B runtime provider profile independently binds the selected Resend environment', async () => {
  const fixture = createBoundaryFixture({ suffix: 'runtime-profile' });
  const result = await attemptBoundary(fixture, { profile: 'different-runtime-profile' });
  assert.equal(result.errorCategory, 'cim-provider-profile-mismatch');
  assert.equal(fixture.counts.reads, 0);
  assert.equal(fixture.counts.seamEntries, 0);
  assert.equal(fixture.counts.providerCalls, 0);
});

test('P6B durable CRM takeover ownership is protected even when the in-memory message looks generic', async () => {
  let providerCalls = 0;
  const storage = {
    async getCrmCommunication(id) {
      assert.equal(id, 'communication-cim-takeover');
      return {
        id,
        cim_request_id: 'legacy-cim-request',
        source: 'crm-follow-up',
        kind: 'email',
        metadata: {},
      };
    },
  };
  const result = await sendPreparedMessage({
    kind: 'crm-follow-up',
    communicationId: 'communication-cim-takeover',
    from: 'sender@example.test',
    to: ['broker@example.test'],
    subject: 'Following up',
    text: 'Checking in.',
    html: '<p>Checking in.</p>',
  }, {
    storage,
    configOverride: resendBoundaryConfig(),
    fetcher: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
    },
  });

  assert.equal(result.errorCategory, 'cim-provider-authorization-required');
  assert.equal(providerCalls, 0);
});

test('P6B exact same-process authorization enters the durable seam before one Resend call', async () => {
  const rawNonce = 'same-process-raw-boundary-nonce';
  const payloadDigest = '4dab3f34037ae8f4a0fa9d14d2d4b73710ce36f6c6b5a2eec89ebffd02edc247';
  let seamEntries = 0;
  let providerCalls = 0;
  const durable = {
    transmission: {
      id: 'transmission-1', state: 'provider-pending', row_version: 2,
      invocation_authority_count: 1, boundary_nonce_digest:
        'de5485d63656152b83e641b6ca42e07e16b1a46aaaa7f6141599ca8e8c0827b3',
      provider_seam_entered_at: null, payload_digest: payloadDigest,
      payload_version: 'payload-v1', provider_idempotency_key: 'provider-key-1',
      communication_id: 'communication-1', outbox_id: 'outbox-1',
    },
    authorization: {
      id: 'authorization-1', transmission_id: 'transmission-1',
      activation_id: 'activation-initial', capability: 'fl04b-initial',
      writer_path: 'pursue-cim-initial', payload_digest: payloadDigest,
      provider_profile: 'synthetic-provider', maximum_calls: 1,
      consumed_at: '2026-09-25T19:00:00.000Z', withdrawn_at: null,
      expires_at: '2026-09-25T20:00:00.000Z',
    },
    activation: {
      id: 'activation-initial', capability: 'fl04b-initial',
      provider_profile: 'synthetic-provider', status: 'current',
    },
    communication: {
      id: 'communication-1', source: 'pursue-cim-autopilot', kind: 'cim-initial',
      delivery_state: 'provider-pending',
      from_address: 'sender@example.test', to_addresses: ['broker@example.test'],
      cc_addresses: [], bcc_addresses: [], reply_to_address: 'reply@example.test',
      subject: 'Synthetic subject', body_text: 'Synthetic body',
      body_html_sanitized: '<p>Synthetic body</p>', tags: ['cim-initial'],
    },
    outbox: { id: 'outbox-1', communication_id: 'communication-1', state: 'provider-pending' },
    members: [{ touch: { id: 'touch-1', kind: 'initial' },
      campaign: { template_version: 'template-v1' } }],
  };
  const storage = {
    async readCimFinalGateContext() { return durable; },
    async enterCimProviderSeam(command) {
      seamEntries += 1;
      assert.equal(command.payloadDigest, payloadDigest);
      return { entered: true, alreadyEntered: false, unauthorized: false };
    },
  };
  const authorization = createCimProviderBoundaryAuthorization({
    finalGateResult: {
      authorized: true,
      boundaryNonce: rawNonce,
      transmission: durable.transmission,
    },
    authorizationId: 'authorization-1',
    writerPath: 'pursue-cim-initial',
    providerProfile: 'synthetic-provider',
    actor: 'fixture-owner',
  });
  const result = await sendPreparedMessage({
    kind: 'cim-initial', transmissionId: 'transmission-1', communicationId: 'communication-1',
    idempotencyKey: 'provider-key-1', from: 'sender@example.test',
    to: ['broker@example.test'], cc: [], bcc: [], replyTo: 'reply@example.test',
    subject: 'Synthetic subject', text: 'Synthetic body', html: '<p>Synthetic body</p>',
    tags: ['cim-initial'],
  }, {
    storage,
    cimProviderAuthorization: authorization,
    now: new Date('2026-09-25T19:00:00.000Z'),
    configOverride: resendBoundaryConfig(),
    fetcher: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ id: 'resend-message-1' }), { status: 200 });
    },
  });

  assert.equal(result.status, 'sent');
  assert.equal(seamEntries, 1);
  assert.equal(providerCalls, 1);
});

test('P6B canonical Package 5 payload digest parity vector remains stable', () => {
  const fixture = createBoundaryFixture({ suffix: 'digest-vector' });
  assert.equal(
    fixture.payloadDigest,
    buildCimProviderPayloadDigest({
      message: fixture.message,
      touchIds: fixture.durable.members.map(({ touch }) => touch.id).reverse(),
      templateVersions: fixture.durable.members.map(({ campaign }) => campaign.template_version),
      payloadVersion: fixture.durable.transmission.payload_version,
    }),
  );
  assert.match(fixture.payloadDigest, /^[0-9a-f]{64}$/);
});

test('P6B complete legacy/current/planned writer matrix is default-deny without an exact envelope', async (t) => {
  const writers = [
    ['A direct/admin initial', 'deal-hunter-cim-request', { tracking: { cimRequestId: 'direct' } }],
    ['B bulk legacy automatic initial', 'deal-hunter-cim-request', { tracking: { cimRequestId: 'bulk' } }],
    ['C Stage 2 automatic initial', 'deal-hunter-cim-request', { tracking: { cimRequestId: 'stage-2' } }],
    ['D Broker Materials manual initial', 'deal-hunter-cim-request', { tracking: { cimRequestId: 'broker-materials' } }],
    ['E legacy scheduled follow-up', 'deal-hunter-cim-follow-up', { tracking: { cimRequestId: 'scheduled' } }],
    ['F operator-approved manual follow-up', 'deal-hunter-cim-follow-up', { tracking: { cimRequestId: 'manual-follow-up' } }],
    ['H exported CIM request convenience', 'deal-hunter-cim-request', {}],
    ['H exported CIM follow-up convenience', 'deal-hunter-cim-follow-up', {}],
    ['H exported prepared-message seam', 'cim-initial', { transmissionId: 'prepared-export' }],
    ['J new follow-up without P6D/P11 authority', 'cim-follow-up', { transmissionId: 'future-follow-up' }],
    ['K new batch without active batch authority', 'cim-batch', { transmissionId: 'future-batch' }],
    ['retry/resend legacy route', 'deal-hunter-cim-request', { tracking: { cimRequestId: 'retry' } }],
  ];

  for (const [name, kind, fields] of writers) {
    await t.test(name, async () => {
      let providerCalls = 0;
      const result = await sendPreparedMessage(legacyCimMessage({ kind, ...fields }), {
        configOverride: resendBoundaryConfig(),
        fetcher: async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ id: 'must-not-send' }), { status: 200 });
        },
      });
      assert.equal(result.errorCategory, 'cim-provider-authorization-required');
      assert.equal(providerCalls, 0);
    });
  }
});

test('P6B scenario 80 selects exactly one new initial while every nonselected path stays blocked', async () => {
  const selected = createBoundaryFixture({ suffix: 'selected-a' });
  const nonselected = createBoundaryFixture({ suffix: 'nonselected-b' });

  const selectedResult = await attemptBoundary(selected);
  const nonselectedResult = await attemptBoundary(nonselected, { authorization: null });

  assert.equal(selectedResult.status, 'sent');
  assert.equal(selected.counts.seamEntries, 1);
  assert.equal(selected.counts.providerCalls, 1);
  assert.equal(nonselectedResult.errorCategory, 'cim-provider-authorization-required');
  assert.equal(nonselected.counts.seamEntries, 0);
  assert.equal(nonselected.counts.providerCalls, 0);
});

test('P6B payload mutation matrix stops before seam entry and provider invocation', async (t) => {
  const mutations = [
    ['body', (message) => { message.text = 'Changed body'; }],
    ['recipient', (message) => { message.to = ['other@example.test']; }],
    ['reply-to', (message) => { message.replyTo = 'other-reply@example.test'; }],
    ['subject', (message) => { message.subject = 'Changed subject'; }],
    ['tag', (message) => { message.tags = ['changed-tag']; }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = createBoundaryFixture({ suffix: `payload-${name}` });
      const message = structuredClone(fixture.message);
      mutate(message);
      const result = await attemptBoundary(fixture, { message });
      assert.equal(result.errorCategory, 'cim-provider-payload-mismatch');
      assert.equal(fixture.counts.seamEntries, 0);
      assert.equal(fixture.counts.providerCalls, 0);
    });
  }
});

test('P6B nonce mismatch matrix never enters the durable seam', async (t) => {
  await t.test('missing nonce/context', async () => {
    const fixture = createBoundaryFixture({ suffix: 'nonce-missing' });
    const result = await attemptBoundary(fixture, { authorization: null });
    assert.equal(result.errorCategory, 'cim-provider-authorization-required');
    assert.equal(fixture.counts.seamEntries, 0);
    assert.equal(fixture.counts.providerCalls, 0);
  });

  for (const [name, nonceValue] of [
    ['random nonce', 'random-boundary-nonce-long-enough'],
    ['nonce from another transmission', 'other-transmission-boundary-nonce'],
  ]) {
    await t.test(name, async () => {
      const fixture = createBoundaryFixture({ suffix: `nonce-${name.replaceAll(' ', '-')}` });
      fixture.durable.transmission.boundary_nonce_digest = createHash('sha256').update(nonceValue).digest('hex');
      const result = await attemptBoundary(fixture);
      assert.equal(result.errorCategory, 'cim-provider-nonce-invalid');
      assert.equal(fixture.counts.seamEntries, 0);
      assert.equal(fixture.counts.providerCalls, 0);
    });
  }

  await t.test('persisted digest supplied instead of raw nonce', async () => {
    const fixture = createBoundaryFixture({ suffix: 'nonce-digest' });
    const digestAsNonce = fixture.durable.transmission.boundary_nonce_digest;
    const authorization = createCimProviderBoundaryAuthorization({
      finalGateResult: {
        authorized: true,
        boundaryNonce: digestAsNonce,
        transmission: fixture.durable.transmission,
      },
      authorizationId: fixture.durable.authorization.id,
      writerPath: fixture.durable.authorization.writer_path,
      providerProfile: fixture.durable.authorization.provider_profile,
      actor: 'fixture-owner',
    });
    const result = await attemptBoundary(fixture, { authorization });
    assert.equal(result.errorCategory, 'cim-provider-nonce-invalid');
    assert.equal(fixture.counts.seamEntries, 0);
    assert.equal(fixture.counts.providerCalls, 0);
  });
});

test('P6B authorization mismatch matrix cannot reach the provider', async (t) => {
  const cases = [
    ['wrong authorization id', (fixture) => { fixture.durable.authorization.id = 'different-authorization'; }],
    ['withdrawn authorization', (fixture) => { fixture.durable.authorization.withdrawn_at = '2026-09-25T18:00:00.000Z'; }],
    ['different transmission authorization', (fixture) => { fixture.durable.authorization.transmission_id = 'different-transmission'; }],
    ['wrong capability', (fixture) => { fixture.durable.authorization.capability = 'fl04b-enrollment'; }],
    ['wrong activation', (fixture) => { fixture.durable.activation.id = 'different-activation'; }],
    ['stale activation', (fixture) => { fixture.durable.activation.status = 'withdrawn'; }],
    ['expired authorization', (fixture) => { fixture.durable.authorization.expires_at = '2026-09-25T18:59:59.000Z'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = createBoundaryFixture({ suffix: `authorization-${name.replaceAll(' ', '-')}` });
      mutate(fixture);
      const result = await attemptBoundary(fixture);
      assert.notEqual(result.status, 'sent');
      assert.equal(fixture.counts.seamEntries, 0);
      assert.equal(fixture.counts.providerCalls, 0);
    });
  }
});

test('P6B capability dependency negatives bind initial, follow-up, and batch work exactly', async (t) => {
  const cases = [
    ['enrollment cannot send initial', {
      kind: 'cim-initial', writerPath: 'pursue-cim-initial', capability: 'fl04b-enrollment', memberKinds: ['initial'],
    }],
    ['initial capability cannot send follow-up', {
      kind: 'cim-follow-up', writerPath: 'pursue-cim-initial', capability: 'fl04b-initial', memberKinds: ['follow-up'],
    }],
    ['follow-up capability cannot send batch', {
      kind: 'cim-batch', writerPath: 'pursue-cim-follow-up', capability: 'fl04c-followup', memberKinds: ['follow-up', 'follow-up'],
    }],
    ['batch capability cannot send one follow-up', {
      kind: 'cim-follow-up', writerPath: 'pursue-cim-batch', capability: 'fl04c-batch', memberKinds: ['follow-up'],
    }],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = createBoundaryFixture({ suffix: `capability-${name.replaceAll(' ', '-')}`, ...options });
      const result = await attemptBoundary(fixture);
      assert.notEqual(result.status, 'sent');
      assert.equal(fixture.counts.seamEntries, 0);
      assert.equal(fixture.counts.providerCalls, 0);
    });
  }
});

test('P6B scenario 58 durable pause race consumes authority but makes zero provider calls', async () => {
  const fixture = createBoundaryFixture({
    suffix: 'pause-race',
    seamResult: { entered: false, alreadyEntered: false, unauthorized: true },
  });
  const result = await attemptBoundary(fixture);
  assert.equal(result.errorCategory, 'cim-provider-seam-unauthorized');
  assert.equal(fixture.durable.authorization.consumed_at, '2026-09-25T19:00:00.000Z');
  assert.equal(fixture.counts.seamEntries, 1);
  assert.equal(fixture.counts.providerCalls, 0);
});

test('P6B restart and concurrent race semantics make the provider boundary one-shot', async (t) => {
  await t.test('restart before seam has no raw nonce', async () => {
    const fixture = createBoundaryFixture({ suffix: 'restart-before' });
    const result = await attemptBoundary(fixture, { authorization: null });
    assert.equal(result.errorCategory, 'cim-provider-authorization-required');
    assert.equal(fixture.counts.providerCalls, 0);
  });

  await t.test('restart after seam is reconciliation-only', async () => {
    const fixture = createBoundaryFixture({ suffix: 'restart-after' });
    fixture.durable.transmission.provider_seam_entered_at = '2026-09-25T19:00:01.000Z';
    const result = await attemptBoundary(fixture);
    assert.equal(result.errorCategory, 'cim-provider-seam-already-entered');
    assert.equal(result.reconciliationOnly, true);
    assert.equal(fixture.counts.seamEntries, 0);
    assert.equal(fixture.counts.providerCalls, 0);
  });

  await t.test('two equivalent executions have one durable CAS winner', async () => {
    let won = false;
    const fixture = createBoundaryFixture({
      suffix: 'concurrent',
      seamResult: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        if (won) return { entered: false, alreadyEntered: true, unauthorized: false };
        won = true;
        return { entered: true, alreadyEntered: false, unauthorized: false };
      },
    });
    const results = await Promise.all([attemptBoundary(fixture), attemptBoundary(fixture)]);
    assert.equal(results.filter(({ status }) => status === 'sent').length, 1);
    assert.equal(results.filter(({ reconciliationOnly }) => reconciliationOnly).length, 1);
    assert.equal(fixture.counts.seamEntries, 2);
    assert.equal(fixture.counts.providerCalls, 1);
  });
});

test('P6B environment hard-off is only a brake, never provider authority', async (t) => {
  const cases = [
    ['env disabled, otherwise valid', { enabled: false, expected: 'cim-provider-hard-off' }],
    ['env enabled, durable pause on', { seamResult: { entered: false, unauthorized: true }, expected: 'cim-provider-seam-unauthorized' }],
    ['env enabled, authorization missing', { authorization: null, expected: 'cim-provider-authorization-required' }],
    ['env enabled, nonce invalid', { invalidNonce: true, expected: 'cim-provider-nonce-invalid' }],
    ['env enabled, exact authority', { expected: '' }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = createBoundaryFixture({ suffix: `hard-off-${name.replaceAll(' ', '-')}`, seamResult: options.seamResult });
      if (options.invalidNonce) fixture.durable.transmission.boundary_nonce_digest = '0'.repeat(64);
      const authorization = options.authorization === null ? null : fixture.authorization;
      const result = await attemptBoundary(fixture, { authorization, enabled: options.enabled ?? true });
      assert.equal(result.errorCategory || '', options.expected);
      assert.equal(fixture.counts.providerCalls, options.expected ? 0 : 1);
    });
  }
});

test('P6B ordinary outbound mail remains outside the CIM boundary', async (t) => {
  const ordinaryKinds = [
    'submission-notification',
    'admin-magic-link',
    'admin-email-test',
    'secure-upload-invitation',
    'upload-notification',
    'crm-follow-up',
    'daily-deal-hunter',
    'daily-deal-hunter-source-alert',
  ];
  for (const kind of ordinaryKinds) {
    await t.test(kind, async () => {
      let providerCalls = 0;
      const result = await sendPreparedMessage({
        kind,
        idempotencyKey: kind === 'daily-deal-hunter' ? 'daily-deal-hunter-fixture' : '',
        from: 'sender@example.test',
        to: ['recipient@example.test'],
        subject: 'Ordinary application email',
        text: 'Ordinary body',
        html: '<p>Ordinary body</p>',
      }, {
        configOverride: resendBoundaryConfig({ enabled: false }),
        fetcher: async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ id: `provider-${kind}` }), { status: 200 });
        },
      });
      assert.equal(result.status, 'sent');
      assert.equal(providerCalls, 1);
    });
  }
});

test('P0 scenario 41 harness: seam entries are counted separately from provider calls', async () => {
  const provider = createPursueCimProviderFake({ crashAt: 'after-seam' });
  await assert.rejects(
    provider.execute({ transmissionId: 'tx-synthetic', payloadDigest: 'a'.repeat(64) }),
    /Synthetic crash at after-seam/,
  );
  assert.equal(provider.seamEntries.length, 1);
  assert.equal(provider.providerCalls.length, 0);
});
test('P0 scenario 42 harness: a crash after invocation records at most one provider call', async () => {
  const provider = createPursueCimProviderFake({ crashAt: 'after-provider-call' });
  await assert.rejects(
    provider.execute({ transmissionId: 'tx-synthetic', payloadDigest: 'b'.repeat(64) }),
    /Synthetic crash at after-provider-call/,
  );
  assert.equal(provider.seamEntries.length, 1);
  assert.equal(provider.providerCalls.length, 1);
});
