import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { demonstrateOfflineGuardianLoss, offlineDemoWindow } from './helpers/p10bRuntimeOnlyFixture.js';
import { createP10bRuntimeOnlyControl } from '../server/services/p10bRuntimeOnlyControl.js';
import { fixture, config, signedRequest } from './helpers/p10bQualificationFixture.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { recordEmailEventsFromWebhook } from '../server/services/emailEvents.js';
import { retryPendingInboundIngestion } from '../server/services/communications.js';
import { executeP10bFirstMailboxQualification } from '../server/services/pursueCimControlledMailboxHarness.js';
import { P10B_QUALIFICATION_VERSION, qualificationDigest } from '../server/services/p10bQualificationContract.js';
import { P10B_CONFIGURATION_EVIDENCE_VERSION, P10B_PROVIDER_IDENTITY, P10B_RUNTIME_PACKET_VERSION,
  p10bProviderIdentityDigest } from '../server/services/p10bProviderIdentity.js';
import { createP10bControlChannel } from '../server/services/p10bControlChannel.js';
import { runP10bQualificationHost, validateP10bRuntimePacket } from '../server/services/p10bQualificationHost.js';
import { initializeP10bRuntimeFilesystem, p10bDatabaseIdentity, p10bPublicConfigurationDigest,
  runServerStartupMaintenance, startServerSchedulers } from '../server/services/p10bRuntime.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_GUEST_PROCESSES, p10bGuestWindow } from '../server/services/p10bGuestShutdown.js';

const digest = (value) => sha256(stableCanonicalJson(value));
const sourceHead = '1'.repeat(40);

async function hostFixture(t, variant = '') {
  const f = await fixture(t);
  const databasePath = path.join(f.directory, 'fixture.sqlite');
  f.manifest.runtime.machineId = '0803730bd1d7e8';
  const admission = new Set();
  const admissionDirectory = path.join(f.directory, 'host-admission');
  f.options.config.storage = { provider: 'sqlite', sqlitePath: '/data/p10b-first-mailbox-offline.sqlite' };
  f.options.config.protection = { rateLimitRetentionMs: 0 };
  f.manifest.runtime.databaseIdentityHash = p10bDatabaseIdentity(databasePath);
  f.manifest.maximumRuntimeMs = 10000;
  const secrets = [{ name: 'DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY', digest: 'abc123' }];
  const configurationEvidence = { version: P10B_CONFIGURATION_EVIDENCE_VERSION,
    providerIdentity: structuredClone(P10B_PROVIDER_IDENTITY),
    providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY),
    verifiedAt: f.manifest.issuedAt, flySecretMetadataDigest: digest(secrets),
    runtimeConfigurationDigests: { qualify: p10bPublicConfigurationDigest(f.options.config) } };
  f.manifest.configurationEvidenceDigest = digest(configurationEvidence);
  f.options.reviewedDigest = qualificationDigest(f.manifest);
  const packet = { version: P10B_RUNTIME_PACKET_VERSION, operation: 'qualify',
    guest: { issuedAt: f.manifest.issuedAt, stopAt: new Date(Date.parse(f.manifest.issuedAt) + 10000).toISOString(),
      closureGraceMs: 200, stopReserveMs: 200 },
    target: { app: f.manifest.runtime.app, machineId: f.manifest.runtime.machineId, imageDigest: f.manifest.runtime.imageDigest },
    sourceHead, databasePath: '/data/p10b-first-mailbox-offline.sqlite', actor: 'offline-owner',
    ownerPermissionDigest: f.manifest.ownerPermissionDigest, configurationEvidence,
    configurationEvidenceDigest: f.manifest.configurationEvidenceDigest,
    budget: { priceEvidenceDigest: 'c'.repeat(64), maximumUsdPerSecond: 0.000001, fixedIncrementalUsd: 0.001 },
    manifest: f.manifest, reviewedDigest: f.options.reviewedDigest,
    opportunityId: f.prepared.opportunityId, initialActivationId: f.prepared.initialActivationId };
  fs.writeFileSync(`${databasePath}.p10b-preparation.json`, JSON.stringify({
    sourceHead, app: packet.target.app, machineId: packet.target.machineId,
    providerIdentityDigest: configurationEvidence.providerIdentityDigest,
    databaseIdentityHash: f.manifest.runtime.databaseIdentityHash,
    opportunityId: packet.opportunityId, initialActivationId: packet.initialActivationId,
    review: f.prepared.review }), { flag: 'wx', mode: 0o600 });
  if (variant === 'preparation-provider-drift') {
    const retained = JSON.parse(fs.readFileSync(`${databasePath}.p10b-preparation.json`));
    retained.providerIdentityDigest = 'd'.repeat(64);
    fs.writeFileSync(`${databasePath}.p10b-preparation.json`, JSON.stringify(retained));
  }
  fs.writeFileSync(`${databasePath}.p10b-qualify-start.json`, JSON.stringify({
    version: 'p10b-one-start-v1', sourceHead, databaseIdentityHash: f.manifest.runtime.databaseIdentityHash,
    startedAt: f.manifest.issuedAt }), { flag: 'wx', mode: 0o600 });
  const env = { STORAGE_PROVIDER: 'sqlite', NODE_ENV: 'p10b', P10B_QUALIFICATION_RUNTIME: 'true', P10B_QUALIFICATION_PHASE: 'qualify',
    SQLITE_PATH: packet.databasePath, DELIVERY_PROVIDER: 'console',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1', DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'false',
    DEAL_HUNTER_CIM_OUTREACH_PAUSED: 'true', DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false',
    DEAL_HUNTER_CIM_AUTOMATION_PAUSED: 'true', DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false',
    DEAL_HUNTER_DAILY_EMAIL_ENABLED: 'false', FOLLOW_UP_EMAIL_ENABLED: 'false', FOLLOW_UP_AI_ENABLED: 'false',
    DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: f.manifest.from, DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: 'replies@p10b-e2e.uckelegroup.com',
    DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: f.manifest.domain, DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: f.manifest.recipient };
  f.options.config.dealHunter.cimProvider.qualificationGuestWindow = stableCanonicalJson(p10bGuestWindow(packet));
  env.P10B_GUEST_WINDOW = f.options.config.dealHunter.cimProvider.qualificationGuestWindow;
  const machine = { id: packet.target.machineId, state: 'stopped', region: 'ewr', image_ref: { digest: packet.target.imageDigest },
    config: { env, processes: P10B_GUEST_PROCESSES, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }, restart: { policy: 'no' },
      mounts: [{ volume: 'vol_vwnkpex1k3yx9dnv', path: '/data' }], services: [{ autostart: false, autostop: false, internal_port: 8787 }] } };
  let starts = 0;
  let stops = 0;
  let reads = 0;
  let child;
  let guardian;
  let exit;
  let workerStderr = '';
  const ledger = path.join(f.directory, 'offline-posts.jsonl');
  const data = path.join(f.directory, 'offline-worker-data.json');
  fs.writeFileSync(data, JSON.stringify({ config: f.options.config, sourceHead, databasePath,
    manifest: f.manifest, review: f.prepared.review, variant, ledger }), { mode: 0o600 });
  const script = path.join(f.directory, 'offline-worker.mjs');
  // This actual child process exercises the shipped stdio/worker/API path.
  // Fly control, runtime identity and email fetches are explicit fake boundaries.
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import { createP10bControlChannel } from ${JSON.stringify(new URL('../server/services/p10bControlChannel.js', import.meta.url).href)};
    import { serveP10bQualificationWorker } from ${JSON.stringify(new URL('../server/services/p10bQualificationWorker.js', import.meta.url).href)};
    import { createSqliteStorage } from ${JSON.stringify(new URL('../server/storage/sqlite.js', import.meta.url).href)};
    import { executeP10bFirstMailboxQualification } from ${JSON.stringify(new URL('../server/services/pursueCimControlledMailboxHarness.js', import.meta.url).href)};
    import { ingestFakeLifecycle } from ${JSON.stringify(new URL('./helpers/p10bQualificationFixture.js', import.meta.url).href)};
    import { createServer } from 'node:http';
    import { installP10bIngressClosure, requestP10bIngressClosure } from ${JSON.stringify(new URL('../server/services/p10bIngressClosure.js', import.meta.url).href)};
    const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const channel = createP10bControlChannel({ input: process.stdin, output: process.stdout });
    const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const runtime = { app: data.manifest.runtime.app, machineId: data.manifest.runtime.machineId, sourceHead: data.sourceHead };
    const cached = createSqliteStorage({ ...data.config, storage: { sqlitePath: data.databasePath } });
    installP10bIngressClosure({ config: data.config, runtime, server, databasePath: data.databasePath,
      closeStorage: () => cached.close() });
    await serveP10bQualificationWorker({ channel, config: data.config,
      runtime: { app: data.manifest.runtime.app, machineId: data.manifest.runtime.machineId, sourceHead: data.sourceHead },
      closeIngress: async (opts) => {
        await requestP10bIngressClosure(opts);
        if (data.variant === 'slow-cleanup') await new Promise(resolve => setTimeout(resolve, 300));
      },
      createStorage: (cfg) => { const storage = createSqliteStorage({ ...cfg, storage: { sqlitePath: data.databasePath } });
        if (data.variant === 'sqlite-acquire-failure') throw new Error('offline storage factory failure');
        if (data.variant === 'sqlite-close-failure') storage.close = () => { throw new Error('offline SQLite close failure'); };
        return storage; },
      resolveDatabasePath: () => data.databasePath, clock: () => data.manifest.issuedAt,
      execute: (options) => executeP10bFirstMailboxQualification({ ...options, lifecyclePollMs: 20, stopTimeoutMs: data.supervisorStopTimeoutMs,
        fetcher: async (url, request) => {
          if (url !== 'https://api.resend.com/emails' || request.method !== 'POST') throw new Error('Unexpected offline request');
          fs.appendFileSync(data.ledger, JSON.stringify({ method: request.method, body: JSON.parse(request.body) }) + '\\n');
          return new Response(data.variant === 'malformed-provider' ? '{broken' : JSON.stringify({ id: 'offline-provider-message' }), { status: 200 });
        },
        readFetcher: async () => new Response(JSON.stringify({ data: [{ id: 'offline-provider-message',
          created_at: data.manifest.issuedAt, from: data.manifest.from, to: [data.manifest.recipient],
          cc: [], bcc: [], reply_to: data.manifest.replyTo, subject: data.review.transmission.copy.subject }] }), { status: 200 }),
        testHooks: { beforeLifecycleObservation: async () => {
          if (data.variant !== 'no-reply') await ingestFakeLifecycle({ storage: options.storage,
            configuration: data.config, manifest: data.manifest, at: data.manifest.issuedAt });
        } },
      }),
    });
  `, { mode: 0o600 });
  const guardScript = path.join(f.directory, 'offline-guardian.mjs');
  fs.writeFileSync(guardScript, `
    import fs from 'node:fs';
    import { runP10bGuestGuardian } from ${JSON.stringify(new URL('../server/services/p10bGuestGuardian.js', import.meta.url).href)};
    const data = JSON.parse(fs.readFileSync(process.argv[2]));
    const window = JSON.parse(data.config.dealHunter.cimProvider.qualificationGuestWindow);
    await runP10bGuestGuardian({ window, databasePath: data.databasePath,
      clock: () => Date.parse(data.manifest.issuedAt) + Date.now() - data.wallStartedAt });
  `);
  const parentScript = path.join(f.directory, 'offline-guardian-parent.mjs');
  fs.writeFileSync(parentScript, `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { runP10bGuardianParent } from ${JSON.stringify(new URL('../server/services/p10bGuardianParent.js', import.meta.url).href)};
    const data = JSON.parse(fs.readFileSync(process.argv[2]));
    const window = JSON.parse(data.config.dealHunter.cimProvider.qualificationGuestWindow);
    await runP10bGuardianParent({ window, databasePath: data.databasePath,
      clock: () => Date.parse(data.manifest.issuedAt) + Date.now() - data.wallStartedAt,
      launch: ({ environment }) => spawn(process.execPath, [${JSON.stringify(guardScript)}, process.argv[2]],
        { env: environment, stdio: 'ignore' }) });
  `);
  const adapter = {
    async getMachine() { reads += 1; return structuredClone(machine); },
    async getSecretMetadata() { return secrets; },
    async startMachine() {
      starts += 1;
      if (variant === 'start-failure') throw new Error('offline-sending-secret');
      machine.state = 'started';
      guardian = spawn(process.execPath, [parentScript, data], { stdio: 'ignore' });
      guardian.once('close', async () => {
        stops += 1;
        if (variant !== 'stop-timeout' && variant !== 'stop-failure') machine.state = 'stopped';
        child?.kill('SIGTERM');
      });
      t.after(() => { if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGKILL'); });
    },
    async stopMachine() {
      assert.fail('Host must never call Fly stop; the guest owns shutdown');
    },
    async openWorker() {
      if (variant === 'open-hung') return new Promise(() => {});
      child = spawn(process.execPath, [script, data], { stdio: ['pipe', 'pipe', 'pipe'] });
      exit = new Promise((resolve) => child.once('close', () => resolve(true)));
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; workerStderr += chunk; });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
      const channel = createP10bControlChannel({ input: child.stdout, output: child.stdin });
      const originalNext = channel.next;
      channel.next = async () => {
        const frame = await originalNext();
        if (variant === 'malformed-frame' && frame?.kind === 'observe') return { ...frame, kind: 'unknown' };
        if (variant === 'tampered-candidate' && frame?.kind === 'terminal') frame.candidate.proof.payloadDigest = '0'.repeat(64);
        return frame;
      };
      return { channel, async terminate() {
        if (variant === 'uncertain-process') return false;
        child.kill('SIGTERM');
        const result = await exit;
        assert.equal(stderr.includes('offline-sending-secret'), false);
        return result;
      } };
    },
  };
  return { f, packet, adapter, machine, ledger, admission, admissionDirectory, get starts() { return starts; }, get stops() { return stops; },
    get reads() { return reads; }, get child() { return child; }, get workerStderr() { return workerStderr; }, evidencePath: path.join(f.directory, 'host'),
    run: (options = {}) => {
      if (!starts) {
        packet.guest.stopAt = new Date(Math.min(Date.parse(f.manifest.expiresAt),
          Date.parse(f.manifest.issuedAt) + f.manifest.maximumRuntimeMs)).toISOString();
        packet.guest.closureGraceMs = options.closureGraceMs || 200;
        packet.guest.stopReserveMs = options.stopTimeoutMs || 200;
        f.options.config.dealHunter.cimProvider.qualificationGuestWindow = stableCanonicalJson(p10bGuestWindow(packet));
        env.P10B_GUEST_WINDOW = f.options.config.dealHunter.cimProvider.qualificationGuestWindow;
        configurationEvidence.runtimeConfigurationDigests.qualify = p10bPublicConfigurationDigest(f.options.config);
        f.manifest.configurationEvidenceDigest = digest(configurationEvidence);
        packet.configurationEvidenceDigest = f.manifest.configurationEvidenceDigest;
        packet.reviewedDigest = qualificationDigest(f.manifest);
        const marker = JSON.parse(fs.readFileSync(`${databasePath}.p10b-qualify-start.json`));
        marker.guestWindowDigest = digest(p10bGuestWindow(packet));
        fs.writeFileSync(`${databasePath}.p10b-qualify-start.json`, JSON.stringify(marker));
        const childData = JSON.parse(fs.readFileSync(data)); childData.config = f.options.config; childData.manifest = f.manifest;
        childData.wallStartedAt = Date.now(); childData.supervisorStopTimeoutMs = options.stopTimeoutMs || 200;
        fs.writeFileSync(data, JSON.stringify(childData));
      }
      return runP10bQualificationHost({ packet, adapter,
        evidencePath: path.join(f.directory, 'host'), clock: () => f.manifest.issuedAt,
        stopTimeoutMs: 200, closureGraceMs: 200, admission, admissionDirectory, ...options });
    } };
}

test('early worker failure keeps verifying through transient reads, slow reads and reap failure', async t => {
  for (const variant of ['transient-read', 'slow-read', 'reap-failure']) await t.test(variant, async t => {
    const h = await hostFixture(t);
    h.f.manifest.maximumRuntimeMs = 3200;
    h.adapter.openWorker = async () => { throw Error('offline-sending-secret'); };
    const read = h.adapter.getMachine;
    let activeSignal; let stoppingReads = 0;
    h.adapter.getMachine = async (target, options) => {
      activeSignal ||= options.signal;
      if (options.signal !== activeSignal) {
        stoppingReads++;
        if (stoppingReads === 1 && variant === 'transient-read') throw Error('offline-sending-secret');
        if (stoppingReads === 1 && variant === 'slow-read') await new Promise(resolve => setTimeout(resolve, 1100));
      }
      return read(target, options);
    };
    let reaps = 0;
    h.adapter.reap = async () => {
      if (++reaps === 1 && variant === 'reap-failure') throw Error('offline-sending-secret');
      return true;
    };
    const result = await h.run({ closureGraceMs: 400, stopTimeoutMs: 400 });
    assert.equal(result.failureStage, 'worker'); assert.equal(result.success, false);
    assert.equal(result.stoppedVerified, true, JSON.stringify(result));
    assert.equal(result.stopUncertain, variant === 'reap-failure');
    assert.ok(stoppingReads > 0); assert.equal(h.starts, 1); assert.equal(h.stops, 1);
    assert.equal(fs.existsSync(h.ledger), false); assert.equal(result.artifact, undefined);
    assert.deepEqual(result.failureDetails, { version: 'p10b-runtime-failure-v1',
      origin: 'host', stage: 'worker', reason: 'operation-failed' });
    assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
  });
});

test('pre-admission storage failure retains a safe worker phase in the host receipt', async t => {
  const h = await hostFixture(t, 'sqlite-acquire-failure');
  h.f.manifest.maximumRuntimeMs = 3200;
  const result = await h.run({ closureGraceMs: 400, stopTimeoutMs: 400 });
  assert.equal(result.success, false); assert.equal(result.artifact, undefined);
  assert.deepEqual(result.failureDetails, { version: 'p10b-runtime-failure-v1',
    origin: 'worker', stage: 'storage-open', reason: 'operation-failed' }, h.workerStderr);
  assert.equal(fs.existsSync(h.ledger), false);
});

test('persistent stopped-read failures exhaust the frozen cutoff without another start or artifact', async t => {
  const h = await hostFixture(t); h.f.manifest.maximumRuntimeMs = 1600;
  h.adapter.openWorker = async () => { throw Error('offline-sending-secret'); };
  const read = h.adapter.getMachine; let activeSignal;
  h.adapter.getMachine = async (target, options) => {
    activeSignal ||= options.signal;
    if (options.signal !== activeSignal) throw Error('offline-sending-secret');
    return read(target, options);
  };
  h.adapter.reap = async () => true;
  const began = Date.now(); const result = await h.run({ closureGraceMs: 300, stopTimeoutMs: 300 });
  assert.equal(result.stoppedVerified, false); assert.equal(result.stopUncertain, true);
  assert.ok(Date.now() - began >= 1500); assert.ok(Date.now() - began < 2300);
  assert.ok(result.stopVerification.readFailures > 1); assert.ok(result.stopVerification.readAttempts < 30);
  assert.equal(result.success, false); assert.equal(h.starts, 1); assert.equal(result.artifact, undefined);
  assert.equal(fs.existsSync(h.ledger), false);
  assert.ok(fs.existsSync(path.join(h.admissionDirectory, `${h.packet.target.machineId}.active.json`)));
  assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
});

test('a pending stopped-state read is aborted and reaped at the original cutoff', async t => {
  const h = await hostFixture(t); h.f.manifest.maximumRuntimeMs = 1600;
  h.adapter.openWorker = async () => { throw Error('offline-sending-secret'); };
  const read = h.adapter.getMachine; let activeSignal; let inflight = 0; let aborted = 0; let reaps = 0;
  h.adapter.getMachine = async (target, options) => {
    activeSignal ||= options.signal;
    if (options.signal === activeSignal) return read(target, options);
    inflight++; assert.equal(inflight, 1); assert.ok(options.timeoutMs <= 1600);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted++; inflight--; reject(Error('offline-sending-secret'));
    }, { once: true }));
  };
  h.adapter.reap = async () => { reaps++; return inflight === 0; };
  const result = await h.run({ closureGraceMs: 300, stopTimeoutMs: 300 });
  assert.equal(result.success, false); assert.equal(result.stopUncertain, true);
  assert.equal(result.stopVerification.readAttempts, 1); assert.equal(aborted, 1); assert.equal(inflight, 0);
  assert.ok(reaps >= 1); assert.equal(h.starts, 1); assert.equal(fs.existsSync(h.ledger), false);
});

test('a malformed remote failure diagnostic stays failed without leaking arbitrary fields', async t => {
  const h = await hostFixture(t); h.f.manifest.maximumRuntimeMs = 3200;
  const open = h.adapter.openWorker;
  h.adapter.openWorker = async (...args) => {
    const worker = await open(...args); const next = worker.channel.next; let replaced = false;
    worker.channel.next = async () => {
      const frame = await next();
      if (!replaced && frame?.kind === 'observe') {
        replaced = true;
        return { version: 'p10b-control-v1', kind: 'worker-failed', failureDetails: {
          version: 'p10b-runtime-failure-v1', origin: '__proto__', stage: 'bootstrap',
          reason: 'operation-failed', message: 'offline-sending-secret' } };
      }
      return frame;
    };
    return worker;
  };
  const result = await h.run({ closureGraceMs: 400, stopTimeoutMs: 400 });
  assert.equal(result.success, false); assert.equal(result.artifact, undefined);
  assert.equal(result.failureDetails.reason, 'invalid-diagnostic');
  assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
  assert.equal(fs.existsSync(h.ledger), false); assert.equal(h.starts, 1); assert.equal(h.stops, 1);
});

test('actual offline worker closes SQLite authority before process death and host artifact release', async (t) => {
  const h = await hostFixture(t);
  const result = await h.run({ stopTimeoutMs: 1000, closureGraceMs: 1000 });
  const guardianFiles = Object.fromEntries(['request', 'ack', 'receipt'].map(name => {
    const file = `${path.join(h.f.directory, 'fixture.sqlite')}.p10b-qualify-guardian-${name}.json`;
    return [name, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null];
  }));
  assert.equal(result.success, true, JSON.stringify({ result, guardianFiles, posted: fs.existsSync(h.ledger) }));
  assert.equal(result.lifecycleVerified, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.processReaped, true);
  assert.equal(h.starts, 1); assert.equal(h.stops, 1);
  assert.equal(h.child.signalCode, 'SIGTERM');
  const posts = fs.readFileSync(h.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.from, h.packet.manifest.from);
  const context = await h.f.storage.readCimFinalGateContext({ transmissionId: h.f.manifest.transmissionId,
    authorizationId: `p10b-q-${h.packet.reviewedDigest.slice(0, 48)}`, now: h.f.manifest.issuedAt });
  assert.equal(context.activation.status, 'withdrawn');
  assert.equal(context.safety.outreach_paused, 1);
  assert.ok(context.authorization.consumed_at);
  assert.ok(fs.existsSync(`${h.evidencePath}.attempt.json`));
  assert.ok(fs.existsSync(`${h.evidencePath}.result.json`));
  const replay = await h.run();
  assert.equal(replay.success, false); assert.equal(h.starts, 1); assert.equal(h.stops, 1);
});


test('delayed cleanup reproduces the compressed fixture budget and succeeds within a reserved bounded budget', async t => {
  for (const milliseconds of [200, 1000]) await t.test(String(milliseconds), async t => {
    const h = await hostFixture(t, 'slow-cleanup');
    const result = await h.run({ stopTimeoutMs: milliseconds, closureGraceMs: milliseconds });
    assert.equal(result.success, milliseconds === 1000, JSON.stringify(result));
    assert.equal(result.lifecycleVerified, milliseconds === 1000);
    assert.equal(result.productionReady, false); assert.equal(h.starts, 1); assert.equal(h.stops, 1);
    assert.equal(fs.readFileSync(h.ledger, 'utf8').trim().split('\n').length, 1);
    if (milliseconds === 200) { assert.equal(result.failureStage, 'worker'); assert.equal(result.artifact, undefined); }
  });
});

test('host failures retain evidence, stop once and never release qualification', async (t) => {
  for (const variant of ['start-failure', 'malformed-provider', 'malformed-frame',
    'tampered-candidate', 'preparation-provider-drift', 'sqlite-close-failure', 'sqlite-acquire-failure', 'stop-failure', 'stop-timeout', 'uncertain-process']) await t.test(variant, async (t) => {
    const h = await hostFixture(t, variant);
    const began = Date.now();
    const result = await h.run();
    assert.equal(result.success, false); assert.equal(result.lifecycleVerified, false);
    assert.equal(result.artifact, undefined); assert.equal(h.stops, variant === 'start-failure' ? 0 : 1);
    if (variant === 'preparation-provider-drift') assert.equal(fs.existsSync(h.ledger), false);
    if (variant === 'stop-timeout' || variant === 'stop-failure') {
      assert.ok(Date.now() - began < 5000, 'Verified guest handoff must not renew the stopped-readback budget');
    }
    assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
    assert.ok(fs.existsSync(`${h.evidencePath}.result.json`));
    if (variant === 'sqlite-close-failure' || variant === 'sqlite-acquire-failure') {
      const retained = JSON.parse(fs.readFileSync(path.join(h.f.directory, 'fixture.sqlite.p10b-qualify-guardian-outcome.json')));
      assert.equal(retained.outcome.sqliteClosed, false);
    }
  });
});

test('deadline owns stop even when worker opening hangs and admission rejects concurrent owners', async (t) => {
  const h = await hostFixture(t, 'open-hung');
  h.f.manifest.maximumRuntimeMs = 1500;
  h.packet.reviewedDigest = qualificationDigest(h.f.manifest);
  const first = h.run({ stopTimeoutMs: 300, closureGraceMs: 200 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(h.run(), /already owns/);
  const result = await first;
  assert.equal(result.success, false); assert.equal(h.starts, 1); assert.equal(h.stops, 1);
  assert.equal(result.stoppedVerified, true);
});

test('packet identity, freshness, budget and hard-offs fail before outbound work', async (t) => {
  const h = await hostFixture(t);
  for (const mutate of [
    (p) => { p.target.app = 'uckele-group'; },
    (p) => { p.sourceHead = 'main'; },
    (p) => { p.databasePath = '/data/p10b-readiness.sqlite'; },
    (p) => { p.configurationEvidence.verifiedAt = '2020-01-01T00:00:00Z'; },
    (p) => { p.configurationEvidence.providerIdentity.outboundKey.permission = 'full_access'; },
    (p) => { p.manifest.runtime.teamId = 'wrong-team'; },
  ]) {
    const changed = structuredClone(h.packet); mutate(changed);
    assert.throws(() => validateP10bRuntimePacket(changed, h.f.manifest.issuedAt));
  }
  h.machine.config.env.DEAL_HUNTER_CIM_PROVIDER_ENABLED = 'true';
  const result = await h.run();
  assert.equal(result.success, false); assert.equal(h.starts, 0); assert.equal(h.stops, 0);
  assert.equal(fs.existsSync(h.ledger), false);
});

test('isolated startup suppresses all maintenance/retry jobs while ordinary startup is preserved', async () => {
  const cfg = config();
  let cleanup = 0; let schedulers = 0;
  const tasks = { cleanupAuth: async () => { cleanup += 1; }, cleanupDocuments: async () => { cleanup += 1; return { reviewed: 0 }; } };
  const factories = Array.from({ length: 7 }, () => () => { schedulers += 1; return {}; });
  await runServerStartupMaintenance(cfg, tasks);
  assert.deepEqual(startServerSchedulers(cfg, factories), []);
  assert.equal(cleanup, 0); assert.equal(schedulers, 0);
  cfg.dealHunter.cimProvider.qualificationRuntime = false;
  await runServerStartupMaintenance(cfg, tasks); startServerSchedulers(cfg, factories);
  assert.equal(cleanup, 2); assert.equal(schedulers, 7);
});

test('fresh startup and retained qualification markers refuse restart or database replacement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-startup-'));
  const logical = '/data/p10b-first-mailbox-offline.sqlite';
  const actual = path.join(directory, 'p10b-first-mailbox-offline.sqlite');
  const map = (file) => String(file).startsWith('/data/') ? path.join(directory, path.basename(file)) : file;
  const fileSystem = Object.fromEntries(['existsSync', 'writeFileSync', 'readFileSync', 'realpathSync', 'statSync', 'lstatSync']
    .map((name) => [name, (file, ...args) => fs[name](map(file), ...args)]));
  const cfg = config(); cfg.storage = { provider: 'sqlite', sqlitePath: logical }; cfg.dealHunter.cimProvider.qualificationPhase = 'prepare';
  const options = { fileSystem, sourceHead, environment: { FLY_APP_NAME: 'uckele-group-p10b', FLY_MACHINE_ID: '0803730bd1d7e8' } };
  initializeP10bRuntimeFilesystem(cfg, options);
  assert.throws(() => initializeP10bRuntimeFilesystem(cfg, options), /retained/);
  fs.writeFileSync(actual, 'offline SQLite identity fixture');
  fs.writeFileSync(`${actual}.p10b-preparation.json`, JSON.stringify({ sourceHead, app: 'uckele-group-p10b',
    machineId: '0803730bd1d7e8', databaseIdentityHash: p10bDatabaseIdentity(actual) }));
  cfg.dealHunter.cimProvider.qualificationPhase = 'qualify';
  initializeP10bRuntimeFilesystem(cfg, options);
  assert.throws(() => initializeP10bRuntimeFilesystem(cfg, options));
});

test('failed inbound retrieval consumes its durable read and cannot replay or enter background ingestion', async (t) => {
  const f = await fixture(t);
  let gets = 0;
  f.manifest.maximumRuntimeMs = 700;
  f.options.reviewedDigest = qualificationDigest(f.manifest);
  f.options.testHooks.beforeLifecycleObservation = async () => {
    const payload = { type: 'email.received', created_at: f.manifest.issuedAt,
      data: { email_id: 'offline-inbound-message', from: f.manifest.recipient, to: [f.manifest.replyTo],
        created_at: f.manifest.issuedAt, attachments: [] } };
    const request = signedRequest(payload, f.options.config, f.manifest.issuedAt, 'evt_reply');
    const options = { storage: f.storage, configOverride: f.options.config, now: f.manifest.issuedAt,
      clock: () => f.manifest.issuedAt, fetcher: async () => { gets += 1; throw new Error('offline-read-secret'); } };
    await recordEmailEventsFromWebhook(request, options);
    await recordEmailEventsFromWebhook(request, options);
    const second = createSqliteStorage({ storage: { sqlitePath: path.join(f.directory, 'fixture.sqlite') }, protection: { rateLimitRetentionMs: 0 } });
    try { await recordEmailEventsFromWebhook(request, { ...options, storage: second }); }
    finally { second.close(); }
    const retry = await retryPendingInboundIngestion(options);
    assert.equal(retry.reviewed, 0); assert.equal(gets, 1);
  };
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(gets, 1);
  const row = await f.storage.getCrmCommunicationByProviderMessage('resend', 'offline-inbound-message', 'inbound');
  assert.equal(row.content_attempt_count, 1); assert.equal(row.content_next_attempt_at, null);
});

test('late inbound body after authority closure cannot write content or release proof', async (t) => {
  const f = await fixture(t);
  f.manifest.maximumRuntimeMs = 400;
  f.options.reviewedDigest = qualificationDigest(f.manifest);
  let release;
  let ingestion;
  let gets = 0;
  f.options.testHooks.beforeLifecycleObservation = async () => {
    const payload = { type: 'email.received', created_at: f.manifest.issuedAt,
      data: { email_id: 'offline-late-inbound', from: f.manifest.recipient, to: [f.manifest.replyTo],
        created_at: f.manifest.issuedAt, attachments: [] } };
    ingestion = recordEmailEventsFromWebhook(signedRequest(payload, f.options.config, f.manifest.issuedAt, 'evt_late'), {
      storage: f.storage, configOverride: f.options.config, now: f.manifest.issuedAt, clock: () => f.manifest.issuedAt,
      fetcher: async () => { gets += 1; await new Promise((resolve) => { release = resolve; });
        return new Response(JSON.stringify({ id: 'offline-late-inbound', from: f.manifest.recipient,
          to: [f.manifest.replyTo], text: 'Late fixture must never be committed.', attachments: [] }), { status: 200 }); },
    });
  };
  await assert.rejects(executeP10bFirstMailboxQualification(f.options));
  assert.equal(gets, 1); release(); await ingestion;
  const row = await f.storage.getCrmCommunicationByProviderMessage('resend', 'offline-late-inbound', 'inbound');
  assert.notEqual(row.content_state, 'complete'); assert.equal(row.body_text, '');
  assert.equal(row.content_attempt_count, 1);
});

test('oversized, malformed and late control frames are bounded without secret output', async () => {
  for (const bytes of ['{malformed}\n', 'x'.repeat(65537), JSON.stringify({ version: 'wrong', kind: 'terminal' }) + '\n']) {
    const input = new PassThrough(); const output = new PassThrough();
    const channel = createP10bControlChannel({ input, output });
    const pending = channel.next(); input.write(bytes);
    await assert.rejects(pending);
  }
});

test('fixed target and independent stop budget cover early clock failure and permission expiry', async (t) => {
  for (const variant of ['clock', 'expired', 'machine-drift', 'late-runtime']) await t.test(variant, async (t) => {
    const h = await hostFixture(t);
    let clock = () => h.f.manifest.issuedAt;
    if (variant === 'clock') clock = () => { throw new Error('offline-sending-secret'); };
    if (variant === 'expired') clock = () => new Date(Date.parse(h.f.manifest.issuedAt) + 20000);
    if (variant === 'machine-drift') {
      const p = structuredClone(h.packet); p.target.machineId = '00000000000001';
      assert.throws(() => validateP10bRuntimePacket(p, h.f.manifest.issuedAt));
      await assert.rejects(h.run({ packet: p }), /ownership/);
      assert.equal(h.starts, 0); assert.equal(h.stops, 0); return;
    }
    if (variant === 'late-runtime') {
      h.f.manifest.maximumRuntimeMs = 1000;
      h.packet.reviewedDigest = qualificationDigest(h.f.manifest);
      clock = () => new Date(Date.parse(h.f.manifest.issuedAt) + 800);
    }
    const result = await h.run({ clock });
    assert.equal(result.success, false); assert.equal(h.starts, 0); assert.equal(h.stops, 0);
    assert.equal(result.stoppedVerified, true);
    assert.equal(JSON.stringify(result).includes('offline-sending-secret'), false);
  });
});

test('durable admission rejects another process state or evidence prefix before any Machine mutation', async (t) => {
  const h = await hostFixture(t, 'open-hung');
  h.f.manifest.maximumRuntimeMs = 1000; h.packet.reviewedDigest = qualificationDigest(h.f.manifest);
  const first = h.run({ stopTimeoutMs: 100, closureGraceMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const competing = structuredClone(h.packet); competing.actor = 'another-owner';
  const denied = await h.run({ packet: competing, evidencePath: path.join(h.f.directory, 'other-evidence'), admission: new Set() });
  assert.equal(denied.success, false); assert.equal(h.starts, 1); assert.equal(h.stops, 0);
  await first;
  const replay = await h.run({ evidencePath: path.join(h.f.directory, 'replay-evidence'), admission: new Set() });
  assert.equal(replay.success, false); assert.equal(h.starts, 1); assert.equal(h.stops, 1);
});

test('host cancellation aborts a pending start and reaps a late SSH worker', async (t) => {
  for (const variant of ['late-start', 'late-worker']) await t.test(variant, async (t) => {
    const h = await hostFixture(t);
    h.f.manifest.maximumRuntimeMs = 700; h.packet.reviewedDigest = qualificationDigest(h.f.manifest);
    let aborted = false; let lateReaped = false;
    if (variant === 'late-start') h.adapter.startMachine = (_target, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
    });
    else h.adapter.openWorker = async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { channel: { send() { throw new Error('late channel'); } },
        async terminate() { lateReaped = true; return true; } };
    };
    const result = await h.run({ stopTimeoutMs: 100, closureGraceMs: 100 });
    assert.equal(result.success, false); assert.equal(h.stops, variant === 'late-start' ? 0 : 1);
    if (variant === 'late-start') assert.equal(aborted, true);
    else { await new Promise((resolve) => setTimeout(resolve, 150)); assert.equal(lateReaped, true); }
  });
});

test('terminal failure and cancelled no-reply child close authority before guest exit', async (t) => {
  const h = await hostFixture(t, 'no-reply');
  h.f.manifest.maximumRuntimeMs = 1300; h.packet.reviewedDigest = qualificationDigest(h.f.manifest);
  // Update the child's immutable manifest after this test narrows the window.
  const dataPath = path.join(h.f.directory, 'offline-worker-data.json');
  const data = JSON.parse(fs.readFileSync(dataPath)); data.manifest = h.f.manifest;
  fs.writeFileSync(dataPath, JSON.stringify(data));
  const originalRead = h.adapter.getMachine;
  h.adapter.getMachine = async (...args) => {
    const observed = await originalRead(...args);
    if (h.starts && observed.state === 'stopped') {
    const ctx = await h.f.storage.readCimFinalGateContext({ transmissionId: h.f.manifest.transmissionId,
      authorizationId: `p10b-q-${h.packet.reviewedDigest.slice(0, 48)}`, now: h.f.manifest.issuedAt });
    assert.equal(ctx.activation.status, 'withdrawn');
    assert.ok(ctx.authorization.consumed_at || ctx.authorization.withdrawn_at); assert.equal(ctx.safety.outreach_paused, 1);
    }
    return observed;
  };
  const result = await h.run();
  assert.equal(result.success, false); assert.equal(result.artifact, undefined); assert.equal(h.stops, 1);
});

test('delayed signed ingress cannot insert placeholders, terminal rows or email events after closure', async (t) => {
  for (const variant of ['placeholder', 'delivery', 'terminal']) await t.test(variant, async (t) => {
    const f = await fixture(t);
    f.manifest.maximumRuntimeMs = 400; f.options.reviewedDigest = qualificationDigest(f.manifest);
    let release; let work; let blocked;
    const storage = { ...f.storage };
    if (variant === 'placeholder') {
      const original = storage.getCrmCommunicationByProviderMessage;
      storage.getCrmCommunicationByProviderMessage = async (...args) => {
        if (args[2] === 'inbound') { blocked = true; await new Promise((resolve) => { release = resolve; }); }
        return original(...args);
      };
    } else if (variant === 'delivery') {
      for (const name of ['insertEmailEvent', 'mutateWithCrmActivity']) {
        const original = storage[name];
        storage[name] = async (...args) => {
          blocked = true; await new Promise((resolve) => { release = resolve; }); return original(...args);
        };
      }
    } else {
      const original = storage.appendCimTerminalEvent;
      storage.appendCimTerminalEvent = async (...args) => {
        blocked = true; await new Promise((resolve) => { release = resolve; }); return original(...args);
      };
    }
    f.options.testHooks.beforeLifecycleObservation = async () => {
      const payload = { type: variant === 'delivery' ? 'email.delivered' : 'email.received',
        created_at: f.manifest.issuedAt, data: {
          email_id: variant === 'delivery' ? 'offline-provider-message' : 'offline-late-placeholder',
          from: variant === 'delivery' ? f.manifest.from : f.manifest.recipient,
          to: [variant === 'delivery' ? f.manifest.recipient : f.manifest.replyTo],
          created_at: f.manifest.issuedAt, attachments: [] } };
      work = recordEmailEventsFromWebhook(signedRequest(payload, f.options.config, f.manifest.issuedAt, 'evt_delayed'), {
        storage, configOverride: f.options.config, clock: () => f.manifest.issuedAt,
        now: f.manifest.issuedAt, fetcher: () => { throw new Error('Late read prohibited'); },
      }).catch(() => ({ ok: false }));
    };
    await assert.rejects(executeP10bFirstMailboxQualification(f.options));
    assert.equal(blocked, true); release(); await work;
    const rows = await f.storage.listEmailEvents({ source: 'webhook', limit: 100 });
    if (variant !== 'placeholder') assert.equal(rows.length, 0);
    const row = await f.storage.getCrmCommunicationByProviderMessage('resend', 'offline-late-placeholder', 'inbound');
    assert.equal(row, null);
  });
});

test('unrelated, attached and response-mismatched inbound never release proof or perform a second GET', async (t) => {
  for (const variant of ['wrong-owner', 'wrong-alias', 'attachments', 'wrong-content-id', 'hung-body', 'oversized-body']) {
    await t.test(variant, async (t) => {
      const f = await fixture(t); let gets = 0; let cancelled = false;
      f.manifest.maximumRuntimeMs = 400; f.options.reviewedDigest = qualificationDigest(f.manifest);
      f.options.testHooks.beforeLifecycleObservation = async () => {
        const payload = { type: 'email.received', created_at: f.manifest.issuedAt, data: {
          email_id: 'offline-bounded-inbound', from: variant === 'wrong-owner' ? 'other@example.com' : f.manifest.recipient,
          to: [variant === 'wrong-alias' ? 'cim-other@p10b-e2e.uckelegroup.com' : f.manifest.replyTo],
          created_at: f.manifest.issuedAt, attachments: variant === 'attachments' ? [{ id: 'blocked' }] : [] } };
        const request = signedRequest(payload, f.options.config, f.manifest.issuedAt, 'evt_bounded');
        const opts = { storage: f.storage, configOverride: f.options.config, now: f.manifest.issuedAt,
          clock: () => f.manifest.issuedAt, fetcher: async () => {
            gets += 1;
            if (variant === 'hung-body') return new Response(new ReadableStream({
              start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
            }));
            return new Response(JSON.stringify({ id: variant === 'wrong-content-id' ? 'wrong-id' : 'offline-bounded-inbound',
              from: f.manifest.recipient, to: [f.manifest.replyTo], attachments: [],
              text: variant === 'oversized-body' ? 'x'.repeat(65537) : 'offline body' }));
          } };
        await recordEmailEventsFromWebhook(request, opts); await recordEmailEventsFromWebhook(request, opts);
      };
      await assert.rejects(executeP10bFirstMailboxQualification(f.options));
      assert.equal(gets, ['wrong-owner', 'wrong-alias', 'attachments'].includes(variant) ? 0 : 1);
      if (variant === 'hung-body') assert.equal(cancelled, true);
    });
  }
});

test('concrete parent-based no-send demo and preparation restore stopped baseline before separately stubbed qualification', async (t) => {
  const { createP10bFlyControl } = await import('../server/services/p10bFlyControl.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-concrete-'));
  const databasePath = path.join(directory, 'prepared.sqlite');
  const logicalPath = '/data/p10b-first-mailbox-concrete-offline.sqlite';
  const at = '2026-10-12T16:00:00.000Z';
  const machineId = '0803730bd1d7e8';
  const cfg = config(); cfg.storage = { provider: 'sqlite', sqlitePath: logicalPath };
  cfg.protection = { rateLimitRetentionMs: 0 }; cfg.dealHunter.cimProvider.qualificationPhase = 'prepare';
  const env = { STORAGE_PROVIDER: 'sqlite', NODE_ENV: 'p10b', P10B_QUALIFICATION_RUNTIME: 'true', P10B_QUALIFICATION_PHASE: 'prepare',
    SQLITE_PATH: logicalPath, DELIVERY_PROVIDER: 'console',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1', DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'false',
    DEAL_HUNTER_CIM_OUTREACH_PAUSED: 'true', DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false',
    DEAL_HUNTER_CIM_AUTOMATION_PAUSED: 'true', DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false',
    DEAL_HUNTER_DAILY_EMAIL_ENABLED: 'false', FOLLOW_UP_EMAIL_ENABLED: 'false', FOLLOW_UP_AI_ENABLED: 'false',
    DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: cfg.dealHunter.cimProvider.resendFromEmail,
    DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: cfg.dealHunter.cimProvider.resendReplyTo,
    DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: cfg.dealHunter.cimProvider.resendInboundDomain,
    DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'mathew@uckelegroup.com' };
  const machine = { id: machineId, state: 'stopped', region: 'ewr', image_ref: { digest: `sha256:${'a'.repeat(64)}` },
    config: { env, processes: P10B_GUEST_PROCESSES, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }, restart: { policy: 'no' },
      mounts: [{ volume: 'vol_vwnkpex1k3yx9dnv', path: '/data' }], services: [{ autostart: false, autostop: false, internal_port: 8787 }] } };
  const baselineConfig = structuredClone(machine.config);
  baselineConfig.image = `registry.fly.io/uckele-group@sha256:${'b'.repeat(64)}`;
  baselineConfig.processes = [{exec:['node','server/index.js']}];
  const demoConfig = structuredClone(machine.config);
  demoConfig.image = `registry.fly.io/uckele-group-p10b@${machine.image_ref.digest}`;
  const prepareConfig = structuredClone(demoConfig);
  const demoWindow=offlineDemoWindow(machine,sourceHead);
  demoConfig.env.P10B_GUEST_WINDOW=stableCanonicalJson(demoWindow);
  demoConfig.processes=[{exec:['node','-e','setInterval(()=>{},2147483647)'],ignore_app_secrets:true},
    {exec:['node','scripts/run-p10b-guest-guardian-parent.js'],ignore_app_secrets:true}];
  const evidenceRecords = new Map();
  const control = createP10bRuntimeOnlyControl({ session: {
    app: 'uckele-group-p10b', machineId, startedAt: new Date().toISOString(),
    sessionDeadline: new Date(Date.now()+3600000).toISOString(), maximumStarts:2,maximumStartWindowMs:300000,
    maximumIncrementalUsd:1,maximumStoppedConfigUpdates:3,productionReady:false,globalAutomationPaused:true,
    ownerPermissionDigest:'f'.repeat(64), candidateImageDigest:machine.image_ref.digest,
    baselineImageDigest:`sha256:${'b'.repeat(64)}` }, evidence:{
      has:name=>evidenceRecords.has(name),read:name=>evidenceRecords.get(name),
      write(name,value){assert.equal(evidenceRecords.has(name),false);evidenceRecords.set(name,structuredClone(value));} } });
  let machineVersion = 0; let transitionReads = 0; let apiUpdates = 0;
  machine.config = structuredClone(baselineConfig); machine.image_ref.digest = `sha256:${'b'.repeat(64)}`;
  machine.instance_id = 'baseline-0';
  const api = async (method='GET',body) => {
    if(method==='POST'){
      assert.equal(machine.state,'stopped');assert.equal(body.skip_launch,true);
      assert.equal(body.current_version,machine.instance_id);apiUpdates++;
      machine.config=structuredClone(body.config);machine.image_ref.digest=body.config.image.split('@')[1];
      machine.instance_id='candidate-'+(++machineVersion);transitionReads=1;
      return {...structuredClone(machine),state:'created'};
    }
    const result=structuredClone(machine);if(transitionReads-- >0)result.state='created';return result;
  };
  await control.guardedUpdate(api,baselineConfig,demoConfig,'demo');
  const demonstration = await demonstrateOfflineGuardianLoss(t,{directory,machine,
    databasePath:path.join(directory,'watchdog.sqlite'),sourceHead,window:demoWindow});
  assert.equal(demonstration.proof.success,true,JSON.stringify(demonstration.proof));
  evidenceRecords.set('p10b-runtime-only-demo-proof.json',demonstration.proof);
  const statePath = path.join(directory, 'machine.json'); fs.writeFileSync(statePath, JSON.stringify(machine));
  const configPath = path.join(directory, 'config.json'); fs.writeFileSync(configPath, JSON.stringify(cfg));
  const commands = path.join(directory, 'commands.jsonl'); const posts = path.join(directory, 'posts.jsonl');
  const fakeFly = path.join(directory, 'fake-fly.mjs');
  fs.writeFileSync(fakeFly, `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { runP10bGuestGuardian } from ${JSON.stringify(new URL('../server/services/p10bGuestGuardian.js', import.meta.url).href)};
    import { runP10bGuardianParent } from ${JSON.stringify(new URL('../server/services/p10bGuardianParent.js', import.meta.url).href)};
    import { assertP10bGuestReady } from ${JSON.stringify(new URL('../server/services/p10bGuestShutdown.js', import.meta.url).href)};
    import { createP10bControlChannel } from ${JSON.stringify(new URL('../server/services/p10bControlChannel.js', import.meta.url).href)};
    import { serveP10bQualificationWorker } from ${JSON.stringify(new URL('../server/services/p10bQualificationWorker.js', import.meta.url).href)};
    import { createSqliteStorage } from ${JSON.stringify(new URL('../server/storage/sqlite.js', import.meta.url).href)};
    import { executeP10bFirstMailboxQualification } from ${JSON.stringify(new URL('../server/services/pursueCimControlledMailboxHarness.js', import.meta.url).href)};
    import { createServer } from 'node:http';
    import { installP10bIngressClosure, requestP10bIngressClosure } from ${JSON.stringify(new URL('../server/services/p10bIngressClosure.js', import.meta.url).href)};
    import { initializeP10bRuntimeFilesystem } from ${JSON.stringify(new URL('../server/services/p10bRuntime.js', import.meta.url).href)};
    import { ingestFakeLifecycle } from ${JSON.stringify(new URL('./helpers/p10bQualificationFixture.js', import.meta.url).href)};
    const args = process.argv.slice(2);
    if (!['offline-guest', 'offline-guardian'].includes(args[0])) fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args)+'\\n');
    const machine = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}));
    const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}));
    const window=JSON.parse(cfg.dealHunter.cimProvider.qualificationGuestWindow);
    const runtimePath=${JSON.stringify(databasePath)}+'.offline-boot-'+window.phase+'.json';
    if(args[0]==='offline-guardian') {
      const boot=JSON.parse(fs.readFileSync(runtimePath));
      await runP10bGuestGuardian({window,databasePath:${JSON.stringify(databasePath)},
        clock:()=>Date.parse(window.issuedAt)+Date.now()-boot.wallStartedAt});
    } else if(args[0]==='offline-guest') {
      const boot=JSON.parse(fs.readFileSync(runtimePath));
      await runP10bGuardianParent({window,databasePath:${JSON.stringify(databasePath)},
        launch:({environment})=>spawn(process.execPath,[${JSON.stringify(fakeFly)},'offline-guardian'],
          {env:environment,stdio:'ignore'}),
        clock:()=>Date.parse(window.issuedAt)+Date.now()-boot.wallStartedAt,exit:(code)=>{
          const latest=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}));latest.state='stopped';
          fs.writeFileSync(${JSON.stringify(statePath)},JSON.stringify(latest));
          const serverPath=${JSON.stringify(databasePath)}+'.p10b-'+window.phase+'-server.json';
          if(fs.existsSync(serverPath)){try{process.kill(JSON.parse(fs.readFileSync(serverPath)).pid,'SIGTERM');}catch{}}
          process.exit(code);
        }});
    } else if (args[0] === 'machines') process.stdout.write(JSON.stringify([machine]));
    else if (args[0] === 'secrets') process.stdout.write(JSON.stringify([{name:'DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY',digest:'abc123'}]));
    else if (args[0] === 'machine' && args[1] === 'start') {
      fs.writeFileSync(runtimePath,JSON.stringify({wallStartedAt:Date.now()}));
      const guest=spawn(process.execPath,[${JSON.stringify(fakeFly)},'offline-guest'],{detached:true,stdio:'ignore'});
      guest.unref();
      fs.writeFileSync(runtimePath+'.pid',String(guest.pid));
      await assertP10bGuestReady({window,databasePath:${JSON.stringify(databasePath)},clock:()=>Date.parse(window.issuedAt)});
      const map = (file) => String(file).startsWith(${JSON.stringify(logicalPath)})
        ? ${JSON.stringify(databasePath)}+String(file).slice(${logicalPath.length}) : file;
      const fileSystem = Object.fromEntries(['existsSync','writeFileSync','readFileSync','realpathSync','statSync','lstatSync']
        .map((name) => [name,(file,...rest) => fs[name](map(file),...rest)]));
      initializeP10bRuntimeFilesystem(cfg,{sourceHead:${JSON.stringify(sourceHead)},fileSystem,
        environment:{FLY_APP_NAME:'uckele-group-p10b',FLY_MACHINE_ID:${JSON.stringify(machineId)}},clock:()=>${JSON.stringify(at)}});
      machine.state='started'; fs.writeFileSync(${JSON.stringify(statePath)},JSON.stringify(machine));
    } else if (args[0] === 'ssh') {
      const channel=createP10bControlChannel({input:process.stdin,output:process.stdout});
      const server=createServer();await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
      const runtime={app:'uckele-group-p10b',machineId:${JSON.stringify(machineId)},sourceHead:${JSON.stringify(sourceHead)}};
      const cached=createSqliteStorage({...cfg,storage:{sqlitePath:${JSON.stringify(databasePath)}}});
      installP10bIngressClosure({config:cfg,runtime,server,databasePath:${JSON.stringify(databasePath)},
        closeStorage:()=>cached.close()});
      await serveP10bQualificationWorker({channel,config:cfg,
        runtime:{app:'uckele-group-p10b',machineId:${JSON.stringify(machineId)},sourceHead:${JSON.stringify(sourceHead)}},
        createStorage:(c)=>createSqliteStorage({...c,storage:{sqlitePath:${JSON.stringify(databasePath)}}}),
        resolveDatabasePath:()=>${JSON.stringify(databasePath)},clock:()=>${JSON.stringify(at)},
        closeIngress:(options)=>requestP10bIngressClosure(options),
        execute:(opts)=>executeP10bFirstMailboxQualification({...opts,stopTimeoutMs:1000,lifecyclePollMs:20,
          fetcher:async(url,request)=>{if(url!=='https://api.resend.com/emails'||request.method!=='POST')throw Error('unexpected fake request');
            fs.appendFileSync(${JSON.stringify(posts)},request.body+'\\n');return new Response(JSON.stringify({id:'offline-provider-message'}));},
          readFetcher:async()=>new Response(JSON.stringify({data:[{id:'offline-provider-message',created_at:opts.manifest.issuedAt,
            from:opts.manifest.from,to:[opts.manifest.recipient],cc:[],bcc:[],reply_to:opts.manifest.replyTo,
            subject:'P10B controlled mailbox lifecycle test'}]})),
          testHooks:{beforeLifecycleObservation:()=>ingestFakeLifecycle({storage:opts.storage,configuration:cfg,
            manifest:opts.manifest,at:opts.manifest.issuedAt})}})});
    } else throw Error('Unknown offline command');
  `);
  const children = [];
  const adapter = createP10bFlyControl({ environment: { PATH: process.env.PATH, HOME: directory },
    spawnProcess: (_executable, args, options) => {
      assert.equal(options.env.FLY_API_TOKEN, undefined);
      assert.deepEqual(Object.keys(options.env).sort(), ['FLY_NO_UPDATE_CHECK', 'HOME', 'PATH']);
      const child = spawn(process.execPath, [fakeFly, ...args], options);
      child.stderr.on('data', (chunk) => fs.appendFileSync(path.join(directory, 'fake-stderr.log'), chunk));
      children.push(child); return child;
    } });
  t.after(async () => { await adapter.reap(); });
  const secrets = [{ name: 'DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY', digest: 'abc123' }];
  const qualifyCfg = structuredClone(cfg); qualifyCfg.dealHunter.cimProvider.qualificationPhase = 'qualify';
  const evidence = { version: P10B_CONFIGURATION_EVIDENCE_VERSION,
    providerIdentity: structuredClone(P10B_PROVIDER_IDENTITY),
    providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY), verifiedAt: at,
    flySecretMetadataDigest: digest(secrets), runtimeConfigurationDigests: {
      prepare: '4'.repeat(64), qualify: '5'.repeat(64) } };
  const packet = { version: P10B_RUNTIME_PACKET_VERSION, operation: 'prepare',
    guest: { issuedAt: at, stopAt: new Date(Date.parse(at)+10000).toISOString(), closureGraceMs: 1000, stopReserveMs: 2000 }, target: {
    app: 'uckele-group-p10b', machineId, imageDigest: machine.image_ref.digest }, sourceHead,
    databasePath: logicalPath, actor: 'offline-owner', runId: 'offline-concrete-first-mailbox',
    permissionEvidenceId: 'offline-permission', ownerPermissionDigest: 'f'.repeat(64),
    configurationEvidence: evidence, configurationEvidenceDigest: digest(evidence),
    budget: { priceEvidenceDigest: 'c'.repeat(64), maximumUsdPerSecond: 0.000001, fixedIncrementalUsd: 0.001 } };
  cfg.dealHunter.cimProvider.qualificationGuestWindow = stableCanonicalJson(p10bGuestWindow(packet));
  prepareConfig.env.P10B_GUEST_WINDOW = cfg.dealHunter.cimProvider.qualificationGuestWindow;
  evidence.runtimeConfigurationDigests.prepare = p10bPublicConfigurationDigest(cfg);
  packet.configurationEvidenceDigest = digest(evidence);
  await control.guardedUpdate(api,demoConfig,prepareConfig,'prepare');
  fs.writeFileSync(statePath,JSON.stringify(machine));fs.writeFileSync(configPath,JSON.stringify(cfg));
  t.after(()=>{for(const phase of ['prepare','qualify']){
    const pidFile=databasePath+'.offline-boot-'+phase+'.json.pid';
    if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile)),'SIGKILL');}catch{/* Offline guardian already exited. */}}
  }});
  const admissionDirectory = path.join(directory, 'admission');
  const prepare = await runP10bQualificationHost({ packet, adapter, clock: () => at,
    evidencePath: path.join(directory, 'prepare'), admissionDirectory, stopTimeoutMs: 2000, closureGraceMs: 1000 });
  assert.equal(prepare.success, true, JSON.stringify(prepare));
  assert.equal(prepare.lifecycleVerified, false); assert.equal(fs.existsSync(posts), false);
  assert.equal(prepare.preparation.providerCalls, 0);
  const noSendRestored = await control.restoreBaseline(api,baselineConfig,[demoConfig,prepareConfig]);
  assert.equal(noSendRestored.fullConfigRestored,true);assert.equal(machine.state,'stopped');
  assert.deepEqual(machine.config,baselineConfig);assert.equal(machine.image_ref.digest,`sha256:${'b'.repeat(64)}`);
  assert.equal(apiUpdates,3);assert.equal(fs.existsSync(posts),false);
  await assert.rejects(control.guardedUpdate(api,baselineConfig,demoConfig,'demo'),/replay/);
  // The following qualification is a separate offline protocol fixture with
  // injected email responses, not authority granted by the no-send sequence.
  machine.config=structuredClone(prepareConfig);machine.image_ref.digest=`sha256:${'a'.repeat(64)}`;
  const r = prepare.preparation;
  const manifest = { version: P10B_QUALIFICATION_VERSION, runtime: {
    providerIdentity: structuredClone(evidence.providerIdentity), providerIdentityDigest: r.providerIdentityDigest,
    ...packet.target, databaseIdentityHash: r.databaseIdentityHash }, domain: evidence.providerIdentity.domain.name,
    recipient: 'mathew@uckelegroup.com', from: cfg.dealHunter.cimProvider.resendFromEmail,
    replyTo: r.review.transmission.addressing.replyTo, ownerPermissionDigest: packet.ownerPermissionDigest,
    configurationEvidenceDigest: packet.configurationEvidenceDigest,
    transmissionId: r.review.transmission.id, payloadDigest: r.review.transmission.payloadDigest,
    reviewDigest: r.review.digest, issuedAt: r.preparedAt,
    expiresAt: new Date(Date.parse(r.preparedAt) + 600000).toISOString(), maximumCalls: 1, retries: 0,
    maximumIncrementalUsd: 1, maximumRuntimeMs: 10000 };
  machine.config.env.P10B_QUALIFICATION_PHASE = 'qualify';
  const qualification = { ...packet, operation: 'qualify', manifest, reviewedDigest: qualificationDigest(manifest),
    opportunityId: r.opportunityId, initialActivationId: r.initialActivationId };
  delete qualification.runId; delete qualification.permissionEvidenceId;
  qualification.guest={issuedAt:manifest.issuedAt,stopAt:new Date(Date.parse(manifest.issuedAt)+manifest.maximumRuntimeMs).toISOString(),
    closureGraceMs:1000,stopReserveMs:2000};
  qualifyCfg.dealHunter.cimProvider.qualificationGuestWindow=stableCanonicalJson(p10bGuestWindow(qualification));
  machine.config.env.P10B_GUEST_WINDOW=qualifyCfg.dealHunter.cimProvider.qualificationGuestWindow;
  evidence.runtimeConfigurationDigests.qualify=p10bPublicConfigurationDigest(qualifyCfg);
  qualification.configurationEvidenceDigest=digest(evidence);manifest.configurationEvidenceDigest=digest(evidence);
  qualification.reviewedDigest=qualificationDigest(manifest);
  fs.writeFileSync(statePath,JSON.stringify(machine));fs.writeFileSync(configPath,JSON.stringify(qualifyCfg));
  const result = await runP10bQualificationHost({ packet: qualification, adapter, clock: () => r.preparedAt,
    evidencePath: path.join(directory, 'qualify'), admissionDirectory, stopTimeoutMs: 2000, closureGraceMs: 1000 });
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.productionReady, false);
  const ledger = fs.readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter((args) => args[0] === 'machine' && args[1] === 'start').length, 2);
  assert.equal(ledger.filter((args) => args[0] === 'machine' && args[1] === 'stop').length, 0);
  assert.equal(fs.readFileSync(posts, 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).state, 'stopped');
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test('ingress closure is idempotent after success or failure and refuses a missing acknowledgment', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { installP10bIngressClosure, requestP10bIngressClosure } = await import('../server/services/p10bIngressClosure.js');
  for (const failure of [false, true]) await t.test(String(failure), async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-drain-'));
    const databasePath = path.join(directory, 'offline.sqlite'); fs.writeFileSync(databasePath, 'offline inode');
    const cfg = config(); cfg.storage = { provider: 'sqlite', sqlitePath: databasePath };
    const processControl = new EventEmitter(); processControl.pid = 1;
    let drains = 0; let closes = 0; let signals = 0;
    const runtime = { app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', sourceHead };
    const installed = installP10bIngressClosure({ config: cfg, runtime, processControl, databasePath,
      server: { close(callback) { drains += 1; queueMicrotask(() => callback(failure ? new Error('drain failed') : null)); } },
      closeStorage: () => { closes += 1; } });
    const options = { config: cfg, runtime, databasePath, timeoutMs: 100,
      signalProcess: (pid, signal) => { assert.equal(pid, 1); signals += 1; processControl.emit(signal); } };
    try {
      if (failure) {
        await assert.rejects(requestP10bIngressClosure(options), /unverified/);
        await assert.rejects(requestP10bIngressClosure(options), /unverified/);
      } else {
        await requestP10bIngressClosure(options); await requestP10bIngressClosure(options);
      }
      processControl.emit('SIGUSR2'); await installed.close();
      assert.equal(drains, 1); assert.equal(closes, failure ? 0 : 1); assert.equal(signals, 1);
      assert.equal(processControl.listenerCount('SIGUSR2'), 1);
    } finally { installed.dispose(); }
  });
  const cfg = config(); cfg.storage = { provider: 'sqlite', sqlitePath: path.join(os.tmpdir(), 'missing-p10b-ack.sqlite') };
  await assert.rejects(requestP10bIngressClosure({ config: cfg,
    runtime: { app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', sourceHead }, timeoutMs: 40 }), /timed out/);
});

test('isolated HTTP ingress refuses public/admin mutations and preparation webhook work before storage access', async () => {
  const { p10bIngressOnly } = await import('../server/services/p10bRuntime.js');
  const { resolveCimProviderProfile } = await import('../server/config.js');
  const cfg = config(); let next = 0;
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json() {} };
  for (const path of ['/api/contact', '/api/admin/deal-hunter', '/api/secure-documents/upload', '/api/analytics/events']) {
    p10bIngressOnly(cfg)({ method: 'POST', path }, response, () => { next += 1; });
    assert.equal(response.statusCode, 404);
  }
  assert.equal(next, 0);
  p10bIngressOnly(cfg)({ method: 'POST', path: '/api/webhooks/resend' }, response, () => { next += 1; });
  cfg.dealHunter.cimProvider.qualificationPhase = 'prepare';
  p10bIngressOnly(cfg)({ method: 'POST', path: '/api/webhooks/resend' }, response, () => { next += 1; });
  assert.equal(next, 1);
  cfg.dealHunter.cimProvider = resolveCimProviderProfile({ P10B_QUALIFICATION_RUNTIME: 'true',
    DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'production-v1' });
  assert.throws(() => startServerSchedulers(cfg, [() => { throw new Error('must not start'); }]));
});

test('explicit host cancellation closes authority and start ambiguity retains durable admission', async (t) => {
  const h = await hostFixture(t, 'open-hung');
  h.f.manifest.maximumRuntimeMs = 700;
  const controller = new AbortController();
  const result = h.run({ signal: controller.signal, closureGraceMs: 30 });
  setTimeout(() => controller.abort(), 40);
  const stopped = await result;
  assert.equal(stopped.success, false); assert.equal(stopped.failureStage, 'host_cancelled');
  assert.equal(h.stops, 1);
  const ambiguous = await hostFixture(t, 'start-failure');
  const uncertain = await ambiguous.run();
  assert.equal(uncertain.startUncertain, true); assert.equal(uncertain.stopUncertain, true);
  assert.ok(fs.existsSync(path.join(ambiguous.admissionDirectory, '0803730bd1d7e8.active.json')));
});

test('host refuses missing guardian, renewable shutdown configuration and init overrides before start', async (t) => {
  for (const variant of ['processes', 'window', 'init', 'schedule', 'autostop']) await t.test(variant, async (t) => {
    const h = await hostFixture(t);
    if (variant === 'processes') h.machine.config.processes = [{ exec: ['node', 'server/index.js'] }];
    if (variant === 'window') h.packet.guest.issuedAt = '2020-01-01T00:00:00.000Z';
    if (variant === 'init') h.machine.config.init = { exec: ['sleep', 'infinity'] };
    if (variant === 'schedule') h.machine.config.schedule = 'hourly';
    if (variant === 'autostop') h.machine.config.services[0].autostop = 'stop';
    if (variant === 'window') await assert.rejects(async () => h.run(), /Frozen/);
    else {
      const result = await h.run();
      assert.equal(result.success, false); assert.equal(result.artifact, undefined);
    }
    assert.equal(h.starts, 0); assert.equal(h.stops, 0); assert.equal(fs.existsSync(h.ledger), false);
  });
});
