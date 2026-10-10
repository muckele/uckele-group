import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, signedRequest, ingestFakeLifecycle } from './helpers/p10bQualificationFixture.js';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { executeP10bFirstMailboxQualification,
  executeP10bControlledMailbox, P10B_EXECUTION_CONFIRMATION } from '../server/services/pursueCimControlledMailboxHarness.js';
import { P10B_QUALIFICATION_VERSION, qualificationDigest, qualificationReason,
  validateQualificationContract } from '../server/services/p10bQualificationContract.js';
import { readQualificationLifecycleSnapshot, verifyQualificationLifecycle } from '../server/services/p10bQualificationLifecycle.js';
import { normalizeCimProviderReadiness } from '../server/services/pursueCimFinalGate.js';

// All credentials, runtime metadata, supervisor receipts, and provider
// outcomes below are explicit offline fixtures. They attest no live outcome.
test('first mailbox qualification uses real SQLite once while all ordinary hard-offs remain active', async (t) => {
  const f = await fixture(t);
  const result = await executeP10bFirstMailboxQualification(f.options)
    .catch((error) => assert.fail(JSON.stringify(error.p10bEvidence)));
  assert.equal(result.evidence.outcome, 'accepted');
  assert.equal(f.calls, 1);
  assert.equal(f.stops, 1);
  assert.equal(result.evidence.productionReady, false);
  assert.equal(result.evidence.lifecycleVerified, true);
  assert.equal(result.lifecycle.productionReady, false);
  assert.equal(f.options.config.dealHunter.cimProvider.enabled, false);
  assert.equal((await f.storage.getDealHunterCimSafetySettings()).outreach_paused, true);
  assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
  assert.equal(JSON.stringify(result).includes('offline-provider-message'), false);
  const projection = await f.storage.readPursueCimProjection({ opportunityId: f.prepared.opportunityId });
  assert.equal(projection.transmission.state, 'accepted');
  assert.equal(projection.transmission.invocation_authority_count, 1);
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(f.calls, 1);
});

test('documented display-name sender survives exact reconciliation without address-only normalization', async (t) => {
  for (const [label, from, accepted] of [
    ['documented display name', 'P10B Sender <sender@p10b-e2e.uckelegroup.com>', true],
    ['bare mailbox', 'sender@p10b-e2e.uckelegroup.com', false],
    ['different display name', 'Other Sender <sender@p10b-e2e.uckelegroup.com>', false],
    ['different mailbox', 'P10B Sender <other@p10b-e2e.uckelegroup.com>', false],
    ['different domain', 'P10B Sender <sender@other.example.test>', false],
    ['multiple senders', 'P10B Sender <sender@p10b-e2e.uckelegroup.com>, other@example.test', false],
  ]) await t.test(label, async (t) => {
    const f = await fixture(t);
    f.options.readFetcher = async () => new Response(JSON.stringify({ data: [{
      id: 'offline-provider-message', created_at: f.manifest.issuedAt, from,
      to: [f.manifest.recipient], cc: null, bcc: null, reply_to: [f.manifest.replyTo],
      subject: f.prepared.review.transmission.copy.subject,
    }] }), { status: 200 });
    if (accepted) {
      const result = await executeP10bFirstMailboxQualification(f.options);
      assert.equal(result.evidence.lifecycleVerified, true);
      assert.equal(result.evidence.productionReady, false);
    } else await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
      assert.equal(error.p10bEvidence.failureStage, 'reconciliation-write');
      assert.equal(error.p10bEvidence.lifecycleVerified, false);
      assert.equal(error.p10bEvidence.reconciliationOnly, true);
      assert.equal(error.p10bEvidence.stoppedVerified, true);
      return true;
    });
    assert.equal(f.calls, 1);
    assert.equal(f.stops, 1);
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(f.calls, 1, 'representation drift never grants a resend');
  });
});

test('validly signed delivery cannot replace the frozen sender representation', async (t) => {
  const f = await fixture(t);
  await executeP10bFirstMailboxQualification(f.options);
  const snapshot = await readQualificationLifecycleSnapshot({ storage: f.storage, manifest: f.manifest });
  for (const from of ['sender@p10b-e2e.uckelegroup.com',
    'Other Sender <sender@p10b-e2e.uckelegroup.com>',
    'P10B Sender <other@p10b-e2e.uckelegroup.com>']) await t.test(from, () => {
    const changed = structuredClone(snapshot);
    const receipt = changed.delivery.metadata.qualificationSignatureReceipt;
    const payload = JSON.parse(receipt.rawBody);
    payload.data.from = from;
    const request = signedRequest(payload, f.options.config, receipt.verifiedAt, receipt.svixId);
    receipt.rawBody = request.rawBody;
    receipt.svixSignature = request.headers['svix-signature'];
    assert.throws(() => verifyQualificationLifecycle({ manifest: f.manifest,
      config: f.options.config, snapshot: changed, reconciliation: f.reconciliation,
      now: f.manifest.issuedAt }), /delivery/);
  });
});

test('qualification manifest rejects identity, configuration, budget, payload and permission drift', async (t) => {
  const f = await fixture(t);
  const transmission = { id: f.manifest.transmissionId, payload_digest: f.manifest.payloadDigest };
  assert.equal(validateQualificationContract({ manifest: f.manifest, observed: f.observed,
    now: f.manifest.issuedAt, reviewedDigest: f.options.reviewedDigest, transmission }).valid, true);
  const mutations = [
    ['team', (m) => { m.runtime.teamId = 'other-team'; }],
    ['machine', (m) => { m.runtime.machineId = 'ffffffffffffff'; }],
    ['image', (m) => { m.runtime.imageDigest = `sha256:${'d'.repeat(64)}`; }],
    ['database', (m) => { m.runtime.databaseIdentityHash = 'd'.repeat(64); }],
    ['app', (m) => { m.runtime.app = 'uckele-group'; }],
    ['domain', (m) => { m.domain = 'uckelegroup.com'; }],
    ['recipient', (m) => { m.recipient = 'other@uckelegroup.com'; }],
    ['payload', (m) => { m.payloadDigest = 'd'.repeat(64); }],
    ['permission', (m) => { m.ownerPermissionDigest = 'd'.repeat(64); }],
    ['configuration evidence', (m) => { m.configurationEvidenceDigest = 'd'.repeat(64); }],
    ['second call', (m) => { m.maximumCalls = 2; }],
    ['retry', (m) => { m.retries = 1; }],
    ['budget', (m) => { m.maximumIncrementalUsd = 2; }],
    ['long expiry', (m) => { m.expiresAt = new Date(Date.parse(m.issuedAt) + 900001).toISOString(); }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const manifest = structuredClone(f.manifest);
    mutate(manifest);
    assert.equal(validateQualificationContract({ manifest, observed: f.observed,
      now: manifest.issuedAt, reviewedDigest: qualificationDigest(manifest), transmission }).valid, false);
  });
  for (const drift of [{ freshDatabase: false }, { stopSupervised: false }, { incrementalUsd: 1 }]) {
    assert.equal(validateQualificationContract({ manifest: f.manifest,
      observed: { ...f.observed, ...drift }, now: f.manifest.issuedAt,
      reviewedDigest: f.options.reviewedDigest }).valid, false);
  }
});

test('changed reviewed bytes and expired permission never open the fake provider', async (t) => {
  for (const kind of ['tamper', 'expired']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    if (kind === 'tamper') f.options.manifest.reviewDigest = 'd'.repeat(64);
    else f.clock = f.manifest.expiresAt;
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(f.calls, 0);
  });
});

test('normal controlled mailbox still rejects unverified production-readiness semantics', async (t) => {
  const f = await fixture(t);
  await assert.rejects(executeP10bControlledMailbox({ storage: f.storage, config: f.options.config,
    opportunityId: f.prepared.opportunityId, initialActivationId: f.prepared.initialActivationId,
    actor: 'offline-owner', reviewDigest: f.prepared.review.digest,
    confirmation: P10B_EXECUTION_CONFIRMATION, now: f.manifest.issuedAt,
    expiresAt: f.manifest.expiresAt, providerReadiness: { provider: 'resend',
      providerProfile: 'controlled-mailbox-v1', outboundConfigured: true, senderConfigured: true,
      generatedAt: f.manifest.issuedAt, expiresAt: f.manifest.expiresAt }, fetcher: f.options.fetcher }),
  /readiness/);
  assert.equal(f.calls, 0);
});

test('one process admits only one qualification supervisor for concurrent attempts', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const wait = new Promise((resolve) => { entered = resolve; });
  const original = f.options.fetcher;
  f.options.fetcher = async (...args) => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return original(...args);
  };
  const first = executeP10bFirstMailboxQualification(f.options);
  await wait;
  await assert.rejects(executeP10bFirstMailboxQualification(f.options), /supervisor/);
  release();
  await first;
  assert.equal(f.calls, 1);
  assert.equal(f.stops, 1);
});

test('crash after durable seam or provider response consumes permission and cannot replay', async (t) => {
  for (const phase of ['afterProviderSeam', 'afterProviderResult']) await t.test(phase, async (t) => {
    const f = await fixture(t);
    f.options.testHooks = { [phase]: async () => { throw new Error('offline simulated crash'); } };
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(f.calls, phase === 'afterProviderSeam' ? 0 : 1);
    const projection = await f.storage.readPursueCimProjection({ opportunityId: f.prepared.opportunityId });
    assert.equal(projection.transmission.state, 'provider-pending');
    assert.equal(projection.transmission.invocation_authority_count, 1);
    assert.ok(projection.transmission.provider_seam_entered_at);
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(f.calls, phase === 'afterProviderSeam' ? 0 : 1);
  });
});

test('deadline and observed identity are checked again after seam and before adapter call', async (t) => {
  for (const kind of ['expired', 'drift']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    f.options.testHooks = { afterProviderSeam: async () => {
      if (kind === 'expired') f.clock = f.manifest.expiresAt;
      else f.observed.runtime.imageDigest = `sha256:${'d'.repeat(64)}`;
    } };
    const result = await executeP10bFirstMailboxQualification(f.options).catch((error) => {
      assert.equal(kind, 'expired');
      return { evidence: error.p10bEvidence };
    });
    assert.equal(f.calls, 0);
    assert.equal(result.evidence.reconciliationOnly, true);
    if (kind === 'drift') assert.equal(result.evidence.outcome, 'ambiguous');
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  });
});

test('timeout or malformed provider acceptance is ambiguous and never retried', async (t) => {
  for (const kind of ['timeout', 'malformed', 'throw']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.options.fetcher = async () => {
      calls += 1;
      if (kind === 'timeout') return new Promise(() => {});
      if (kind === 'throw') throw new Error('offline-sending-secret');
      return new Response('{bad json', { status: 200 });
    };
    const result = await executeP10bFirstMailboxQualification(f.options);
    assert.equal(calls, 1);
    assert.equal(result.evidence.outcome, 'ambiguous');
    assert.equal(result.evidence.reconciliationOnly, true);
    assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(calls, 1);
  });
});

test('stop failure stays a hard failure despite successful durable permission closure', async (t) => {
  const f = await fixture(t);
  f.options.stopAndVerify = async () => ({ stopped: false });
  await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
    assert.equal(error.p10bEvidence.stoppedVerified, false);
    assert.equal(error.p10bEvidence.reconciliationOnly, true);
    assert.equal(error.p10bEvidence.cleanup.authorizationClosed, true);
    return true;
  });
  assert.equal(f.calls, 1);
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(f.calls, 1);
});

test('durable authorization replay rejects a changed qualification manifest reason', async (t) => {
  const f = await fixture(t);
  let issuedCommand;
  const issue = f.storage.issueCimLiveProviderAuthorization;
  f.storage.issueCimLiveProviderAuthorization = async (command) => {
    issuedCommand = command;
    return issue(command);
  };
  await executeP10bFirstMailboxQualification(f.options);
  assert.equal(issuedCommand.reason, qualificationReason(f.manifest));
  const changed = await issue({ ...issuedCommand, reason: `${P10B_QUALIFICATION_VERSION}:${'d'.repeat(64)}` });
  assert.equal(changed.replay, false);
  assert.equal(changed.conflict, true);
  assert.equal(f.calls, 1);
});

test('every qualification hard-off is explicit and rejects accidental activation', async (t) => {
  for (const [group, field, value] of [
    ['cimProvider', 'enabled', true], ['cimOutreach', 'paused', false],
    ['cimFollowUp', 'enabled', true], ['cimAutomation', 'schedulerEnabled', true],
    ['cimAutomation', 'paused', false], ['dailyEmail', 'enabled', true],
    ['followUp', 'emailEnabled', true], ['followUp', 'aiEnabled', true],
  ]) await t.test(`${group}.${field}`, async (t) => {
    const f = await fixture(t);
    const target = group === 'followUp' ? f.options.config.followUp : f.options.config.dealHunter[group];
    target[field] = value;
    await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
      assert.equal(error.p10bEvidence.failureStage, 'validation');
      assert.equal(error.p10bEvidence.stoppedVerified, true);
      return true;
    });
    assert.equal(f.calls, 0);
    assert.equal(f.stops, 1);
  });
});

test('lifecycle verifier rejects tampered, unsigned, stale and wrong-request evidence', async (t) => {
  const f = await fixture(t);
  const result = await executeP10bFirstMailboxQualification(f.options);
  const snapshot = await readQualificationLifecycleSnapshot({ storage: f.storage, manifest: f.manifest });
  const verify = (snapshot, reconciliation = f.reconciliation, now = f.manifest.issuedAt) => verifyQualificationLifecycle({
    manifest: f.manifest, config: f.options.config, snapshot, reconciliation, now });
  assert.equal(verify(snapshot).lifecycleVerified, true);
  assert.equal(normalizeCimProviderReadiness(result.lifecycle,
    { providerProfile: 'controlled-mailbox-v1', now: f.manifest.issuedAt }).ready, false);
  const mutations = [
    ['signature tamper', (s) => { s.reply.metadata.qualificationSignatureReceipt.svixSignature = 'v1,invalid'; }],
    ['raw bytes tamper', (s) => { s.delivery.metadata.qualificationSignatureReceipt.rawBody += ' '; }],
    ['unsigned boolean receipt', (s) => { s.reply.metadata = { signedProviderEvent: true }; }],
    ['wrong signing profile', (s) => { s.reply.metadata.qualificationSignatureReceipt.providerProfile = 'production-v1'; }],
    ['wrong delivery id', (s) => { s.delivery.message_id = 'other-provider-id'; }],
    ['wrong inbound id', (s) => { s.inbound.provider_message_id = 'other-inbound-id'; }],
    ['wrong raw receipt id', (s) => { s.reply.provider_event_id = 'other-event'; }],
    ['wrong source receipt', (s) => { s.inbound.source_event_id = 'other-event'; }],
    ['wrong recipient', (s) => { s.delivery.recipient_email = 'other@example.test'; }],
    ['wrong alias', (s) => { s.inbound.to_addresses = ['cim-other@p10b-e2e.uckelegroup.com']; }],
    ['wrong owner', (s) => { s.inbound.from_address = 'other@example.test'; }],
    ['retrieval pending', (s) => { s.inbound.content_state = 'pending'; }],
    ['retrieval expired', (s) => { s.inbound.metadata.contentRetrievedAt = f.manifest.expiresAt; }],
    ['attachment', (s) => { s.inbound.attachment_metadata = [{ filename: 'offline-synthetic.txt' }]; }],
    ['wrong request', (s) => { s.resolution.transmission.id = 'other-transmission'; }],
    ['ambiguous resolution', (s) => { s.resolution.ambiguous = true; }],
    ['responded alone', (s) => { s.terminal = null; }],
    ['wrong terminal receipt', (s) => { s.terminal.evidence_id = 'other-event'; }],
    ['terminal digest drift', (s) => { s.terminal.metadata_digest = 'd'.repeat(64); }],
    ['stale signature', (s) => { s.reply.metadata.qualificationSignatureReceipt.svixTimestamp = '1'; }],
    ['stale provider payload', (s) => { s.reply.created_at = '2020-01-01T00:00:00.000Z'; }],
    ['wrong payload', (s) => { s.transmission.payload_digest = 'd'.repeat(64); }],
    ['two invocation authorities', (s) => { s.transmission.invocation_authority_count = 2; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const changed = structuredClone(snapshot);
    mutate(changed);
    assert.throws(() => verify(changed));
  });
  const wrongRequest = structuredClone(snapshot);
  const receipt = wrongRequest.reply.metadata.qualificationSignatureReceipt;
  const payload = JSON.parse(receipt.rawBody);
  payload.data.to = ['cim-other@p10b-e2e.uckelegroup.com'];
  const request = signedRequest(payload, f.options.config, receipt.verifiedAt, receipt.svixId);
  receipt.rawBody = request.rawBody;
  receipt.svixSignature = request.headers['svix-signature'];
  assert.throws(() => verify(wrongRequest), /alias/);
  const reconciliation = structuredClone(f.reconciliation);
  reconciliation.candidates.push({ ...reconciliation.candidates[0], providerMessageId: 'other-provider' });
  assert.throws(() => verify(snapshot, reconciliation), /reconciliation/);
  for (const field of ['providerIdempotencyKey', 'fromAddress', 'subject', 'replyToAddress', 'providerProfile']) {
    const changed = structuredClone(f.reconciliation);
    changed.binding[field] = 'other-value';
    assert.throws(() => verify(snapshot, changed), /reconciliation/);
  }
  assert.throws(() => verify(snapshot, f.reconciliation, f.manifest.expiresAt));
  assert.throws(() => verify(result.lifecycle));
});

test('failed or hung initial observation stops the owned Machine without sending', async (t) => {
  for (const kind of ['throws', 'hung', 'clock-failure']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    f.options.manifest.maximumRuntimeMs = 30;
    f.options.reviewedDigest = qualificationDigest(f.manifest);
    if (kind === 'clock-failure') f.options.clock = () => { throw new Error('offline clock failure'); };
    else f.options.observe = kind === 'throws' ? async () => { throw new Error('offline metadata failure'); }
      : async () => new Promise(() => {});
    await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
      assert.equal(error.p10bEvidence.stoppedVerified, true);
      assert.equal(error.p10bEvidence.providerCalls, 0);
      return true;
    });
    assert.equal(f.stops, 1);
    assert.equal(f.calls, 0);
  });
});

test('hung stop verification is bounded, uncertain and retains admission against retry', async (t) => {
  const f = await fixture(t);
  let stopCalls = 0;
  f.options.stopTimeoutMs = 20;
  f.options.stopAndVerify = async () => { stopCalls += 1; return new Promise(() => {}); };
  await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
    assert.equal(error.p10bEvidence.stopUncertain, true);
    assert.equal(error.p10bEvidence.lifecycleVerified, false);
    assert.equal(error.p10bEvidence.reconciliationOnly, true);
    assert.equal(error.p10bEvidence.cleanup.authorizationClosed, true);
    return true;
  });
  assert.equal(stopCalls, 1);
  assert.equal(f.calls, 1);
  await assert.rejects(executeP10bFirstMailboxQualification(f.options), /supervisor/);
  assert.equal(stopCalls, 1);
  assert.equal(f.calls, 1);
});

test('lifecycle deadline stops once and never promotes incomplete signed evidence', async (t) => {
  const f = await fixture(t);
  f.manifest.maximumRuntimeMs = 150;
  f.options.reviewedDigest = qualificationDigest(f.manifest);
  f.options.testHooks = {};
  await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
    assert.equal(error.p10bEvidence.lifecycleVerified, false);
    assert.equal(error.p10bEvidence.stoppedVerified, true);
    assert.equal(error.p10bEvidence.reconciliationOnly, true);
    return true;
  });
  assert.equal(f.calls, 1);
  assert.equal(f.stops, 1);
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(f.calls, 1);
});

test('controlled webhook uses the reconciliation key and never reads attachment endpoints', async (t) => {
  const f = await fixture(t);
  f.options.testHooks = { beforeLifecycleObservation: async () => {
    const { replyResult } = await ingestFakeLifecycle({ storage: f.storage,
      configuration: f.options.config, manifest: f.manifest, at: f.manifest.issuedAt,
      attachments: [{ id: 'offline-attachment', filename: 'offline-synthetic.txt' }] });
    assert.equal(replyResult.ingestion[0].pendingRetry, true);
    f.clock = f.manifest.expiresAt;
  } };
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(f.calls, 1);
  assert.equal(f.stops, 1);
});

test('withdrawing initial or prerequisite authority after seam prevents the fake provider call', async (t) => {
  for (const kind of ['initial', 'enrollment', 'safety']) await t.test(kind, async (t) => {
  const f = await fixture(t);
  f.options.testHooks = { afterProviderSeam: async () => {
    const enrollment = (await f.storage.readPursuitEnrollmentAuthority({ opportunityId: f.prepared.opportunityId,
      now: f.manifest.issuedAt })).activation;
    const id = kind === 'initial' ? f.prepared.initialActivationId : kind === 'enrollment'
      ? enrollment.id : enrollment.prerequisite_activation_id;
    await f.storage.withdrawCimCapabilityActivation({ id,
      actor: 'offline-owner', reason: 'offline withdrawal', now: f.manifest.issuedAt });
  } };
  const result = await executeP10bFirstMailboxQualification(f.options);
  assert.equal(f.calls, 0);
  assert.equal(result.evidence.providerCalls, 0);
  assert.equal(result.evidence.reconciliationOnly, true);
  assert.equal(result.evidence.lifecycleVerified, false);
  });
});

test('a fresh process cannot reconstruct consumed qualification permission after crash', async (t) => {
  const f = await fixture(t);
  f.options.testHooks = { afterProviderSeam: async () => { throw new Error('offline crash'); } };
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  const dataPath = path.join(f.directory, 'offline-restart-fixture.json');
  fs.writeFileSync(dataPath, JSON.stringify({ config: f.options.config, manifest: f.manifest,
    observed: f.observed, opportunityId: f.prepared.opportunityId,
    initialActivationId: f.prepared.initialActivationId }), { mode: 0o600 });
  const script = `
    import fs from 'node:fs';
    import { createSqliteStorage } from ${JSON.stringify(new URL('../server/storage/sqlite.js', import.meta.url).href)};
    import { executeP10bFirstMailboxQualification } from ${JSON.stringify(new URL('../server/services/pursueCimControlledMailboxHarness.js', import.meta.url).href)};
    import { qualificationDigest } from ${JSON.stringify(new URL('../server/services/p10bQualificationContract.js', import.meta.url).href)};
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const storage = createSqliteStorage({ storage: { sqlitePath: process.argv[2] }, protection: { rateLimitRetentionMs: 0 } });
    let calls = 0, stops = 0, rejected = false;
    try {
      await executeP10bFirstMailboxQualification({ ...data, storage, actor: 'offline-owner',
        reviewedDigest: qualificationDigest(data.manifest), clock: () => data.manifest.issuedAt,
        supervisorTarget: { app: data.manifest.runtime.app, machineId: data.manifest.runtime.machineId },
        observe: async () => data.observed,
        stopAndVerify: async (target) => { stops++; return { ...target, stopped: true }; },
        fetcher: async () => { calls++; throw new Error('offline unexpected POST'); },
        readFetcher: async () => { calls++; throw new Error('offline unexpected GET'); } });
    } catch { rejected = true; }
    const state = (await storage.readPursueCimProjection({ opportunityId: data.opportunityId })).transmission.state;
    storage.close();
    console.log(JSON.stringify({ rejected, calls, stops, state }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, dataPath,
    path.join(f.directory, 'fixture.sqlite')], { encoding: 'utf8', timeout: 5000 });
  assert.deepEqual(JSON.parse(output), { rejected: true, calls: 0, stops: 1, state: 'provider-pending' });
  assert.equal(f.calls, 0);
});

test('prerequisite expiry after seam prevents the fake provider invocation', async (t) => {
  const f = await fixture(t);
  f.options.testHooks = { afterProviderSeam: async () => {
    const enrollment = (await f.storage.readPursuitEnrollmentAuthority({ opportunityId: f.prepared.opportunityId,
      now: f.manifest.issuedAt })).activation;
    const db = new Database(path.join(f.directory, 'fixture.sqlite'));
    try {
      db.prepare('UPDATE deal_hunter_cim_capability_activations SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.parse(f.manifest.issuedAt) + 10).toISOString(), enrollment.id);
    } finally { db.close(); }
    f.clock = new Date(Date.parse(f.manifest.issuedAt) + 20).toISOString();
  } };
  const result = await executeP10bFirstMailboxQualification(f.options);
  assert.equal(f.calls, 0);
  assert.equal(result.evidence.lifecycleVerified, false);
  assert.equal(result.evidence.reconciliationOnly, true);
});

test('authority withdrawal during lifecycle observation cannot promote an artifact', async (t) => {
  const f = await fixture(t);
  const capture = f.options.testHooks.beforeLifecycleObservation;
  f.options.testHooks.beforeLifecycleObservation = async (args) => {
    await capture(args);
    const enrollment = (await f.storage.readPursuitEnrollmentAuthority({ opportunityId: f.prepared.opportunityId,
      now: f.manifest.issuedAt })).activation;
    await f.storage.withdrawCimCapabilityActivation({ id: enrollment.id, actor: 'offline-owner',
      reason: 'offline lifecycle withdrawal', now: f.manifest.issuedAt });
  };
  await assert.rejects(executeP10bFirstMailboxQualification(f.options), (error) => {
    assert.equal(error.p10bEvidence.lifecycleVerified, false);
    assert.equal(error.p10bEvidence.stoppedVerified, true);
    return true;
  });
  assert.equal(f.calls, 1);
});

test('supervisor stops owned isolated Machine even when manifest validation fails early', async (t) => {
  const f = await fixture(t);
  f.options.supervisorTarget = { app: f.manifest.runtime.app, machineId: f.manifest.runtime.machineId };
  f.options.manifest.reviewDigest = 'd'.repeat(64);
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(f.calls, 0);
  assert.equal(f.stops, 1);
});

test('hung and oversized provider bodies are bounded and leave reconciliation-only work', async (t) => {
  for (const kind of ['hung', 'oversized']) await t.test(kind, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    f.options.fetcher = async () => {
      calls += 1;
      return new Response(new ReadableStream({ start(controller) {
        if (kind === 'oversized') controller.enqueue(new Uint8Array(65537));
      } }), { status: 200 });
    };
    const result = await executeP10bFirstMailboxQualification(f.options);
    assert.equal(calls, 1);
    assert.equal(result.evidence.outcome, 'ambiguous');
    assert.equal(result.evidence.reconciliationOnly, true);
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(calls, 1);
  });
});
