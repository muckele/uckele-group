import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { config as workerConfig } from './helpers/p10bQualificationFixture.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from '../server/services/p10bProviderIdentity.js';
const operator = await import('../server/services/p10bRuntimeOnlyOperator.js').catch(() => ({}));
const recovery = await import('../server/services/p10bAdmissionRecovery.js').catch(() => ({}));
const diagnostics = await import('../server/services/p10bWorkerDiagnostics.js').catch(() => ({}));
const digest = value => sha256(stableCanonicalJson(value));
const now = Date.parse('2026-10-12T12:00:00.000Z');
const image = 'sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc';
// Retained baseline key/config shape; the seven newly admitted values are
// synthetic. No fixture lookup reads Fly metadata or credentials.
const observedBaseline = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bObservedBaselineShape.json', import.meta.url), 'utf8'));
const publicEnvironmentCases = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bPublicEnvironmentCases.json', import.meta.url), 'utf8'));
function session() {
  const config = structuredClone(observedBaseline);
  return { version: 'p10b-no-email-session-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
    sourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', hostSourceHead: '2'.repeat(40), nonce: 'c'.repeat(24), candidateImageDigest: image,
    baselineImageDigest: config.image.split('@')[1], baselineConfig: config,
    ownerPermissionDigest: 'd'.repeat(64), permissionEvidenceId: 'owner:offline-stub',
    nativeClientSha256: 'f0f100c036ac133232e26f771cd609a4bd188eacc0e700c2fee55a4ef7cf3d09',
    flyExecutable: { path: process.execPath, sha256: sha256(fs.readFileSync(process.execPath)) },
    namesClientPath: '/offline/names-client', namesClientSha256: 'a'.repeat(64),
    startedAt: new Date(now).toISOString(), sessionDeadline: new Date(now + 3600000).toISOString(),
    maximumStarts: 2, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 3,
    maximumIncrementalUsd: 1, maximumLocalBuilds: 1, maximumImagePushes: 1,
    productionReady: false, globalAutomationPaused: true,
    authenticationEvidence: { version: 'p10b-app-token-issuance-v1', ownerAttested: true, issuanceSucceeded: true,
      app: 'uckele-group-p10b', scope: 'app-deploy', tokenId: 'offline-token-id', revokedAt: null,
      tokenName: `p10b-runtime-no-email-${'c'.repeat(24)}`, issuanceEvidenceId: 'owner:offline-issuance',
      issuanceStartedAt: new Date(now - 60000).toISOString(), issuanceCompletedAt: new Date(now - 59000).toISOString(),
      requestedLifetimeMs: 7200000, expiresAt: new Date(now + 7140000).toISOString() },
    configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2',
      providerIdentity: P10B_PROVIDER_IDENTITY, providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY),
      flySecretMetadataDigest: 'e'.repeat(64), verifiedAt: new Date(now).toISOString() },
    budget: { priceEvidenceDigest: 'f'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 } };
}

test('observed 25-key baseline shape passes typed policy; forbidden namespaces and malformed values deny before boundaries', async () => {
  assert.equal(Object.keys(session().baselineConfig.env).length, 25);
  assert.equal(operator.validateP10bNoEmailSession(session(), now), true);
  for (const c of publicEnvironmentCases) {
    const s = session(); s.baselineConfig.env[c.name] = c.value;
    if (c.admitted) {
      assert.equal(operator.validateP10bNoEmailSession(s, now), true, c.name);
      if (c.name === 'PUBLIC_SITE_URL') assert.doesNotThrow(() => new URL(c.value), 'admitted origin must pass the server URL parser');
    }
    else {
      assert.throws(() => operator.validateP10bNoEmailSession(s, now), /public configuration/, c.name);
      let calls = 0;
      await assert.rejects(operator.runP10bNoEmailOperator({ session: s, approval: {}, evidence: memoryEvidence(),
        createBoundaries: () => { calls++; throw Error(); }, clock: () => now }));
      assert.equal(calls, 0);
    }
  }
});

test('observed public settings survive both candidates and are bound to approval, phase and full restoration digests', () => {
  const s = session(); const before = digest(s.baselineConfig);
  const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(s),
    ownerPermissionDigest: s.ownerPermissionDigest, sourceHead: s.sourceHead, hostSourceHead: s.hostSourceHead, expiresAt: s.sessionDeadline,
    recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  operator.assertP10bNoEmailApproval(s, approval, now);
  const names = ['ADMIN_ALLOW_PASSWORD_AUTH', 'ADMIN_AUTH_MODE', 'ANALYTICS_ENABLED', 'BACKUP_ENABLED',
    'OUTBOUND_HTTP_TIMEOUT_MS', 'PUBLIC_SITE_URL', 'SECURE_DOCUMENTS_STORAGE_DIR'];
  for (const label of ['demo', 'prepare']) {
    const p = operator.createP10bRuntimePhase(s, label, now);
    for (const k of names) {
      assert.equal(p.config.env[k], s.baselineConfig.env[k]);
      const altered = structuredClone(p); delete altered.config.env[k];
      assert.throws(() => operator.assertP10bFrozenPhase(s, altered));
      const changedSession = structuredClone(s); changedSession.baselineConfig.env[k] = k === 'ADMIN_AUTH_MODE' ? 'password'
        : k === 'PUBLIC_SITE_URL' ? 'https://other.test' : k === 'SECURE_DOCUMENTS_STORAGE_DIR' ? '/data/other'
          : k === 'OUTBOUND_HTTP_TIMEOUT_MS' ? '1000' : 'false';
      assert.notEqual(digest(changedSession.baselineConfig), before);
      assert.throws(() => operator.assertP10bNoEmailApproval(changedSession, approval, now));
    }
  }
  assert.equal(digest(s.baselineConfig), before);
});

test('preserved auth, analytics and backup switches cannot open preparation routes or startup/scheduler work', async () => {
  const { p10bIngressOnly, runServerStartupMaintenance, startServerSchedulers } = await import('../server/services/p10bRuntime.js');
  const config = workerConfig(); config.dealHunter.cimProvider.qualificationRuntime = true;
  config.dealHunter.cimProvider.qualificationPhase = 'prepare';
  config.admin = { authMode: 'hybrid', allowPasswordAuth: true }; config.analytics = { enabled: true }; config.backup = { enabled: true };
  let calls = 0;
  assert.deepEqual(await runServerStartupMaintenance(config, { cleanupAuth: () => { calls++; }, cleanupDocuments: () => { calls++; } }),
    { reviewed: 0, isolated: true });
  assert.deepEqual(startServerSchedulers(config, [() => { calls++; }]), []);
  for (const route of ['/api/admin/login', '/api/analytics', '/api/secure-documents']) {
    let status; p10bIngressOnly(config)({ method: 'POST', path: route },
      { status: code => { status = code; return { json() {} }; } }, () => { calls++; });
    assert.equal(status, 404);
  }
  assert.equal(calls, 0);
});

test('full public baseline preflight rejects stale, partial, changed-image/name/digest/source evidence without authentication', async () => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const s = session(); const envelope = { version: 'p10b-public-baseline-preflight-v1', app: s.app, machineId: s.machineId,
    volumeId: 'vol_vwnkpex1k3yx9dnv', sourceHead: s.sourceHead, hostSourceHead: s.hostSourceHead, instanceId: 'observed-instance', state: 'stopped',
    observedAt: new Date(now).toISOString(), observedEnvironmentNames: Object.keys(s.baselineConfig.env),
    fullConfigurationRetained: true, baselineConfig: s.baselineConfig, baselineImageDigest: s.baselineImageDigest,
    baselineConfigDigest: digest(s.baselineConfig) };
  let calls = 0; const run = e => runP10bNoEmailSessionCli(['--validate-baseline', 'public.json'], { read: () => e,
    clock: () => now, checkSource: h => { assert.equal(h, s.hostSourceHead); },
    openNative: () => { calls++; throw Error(); }, createBoundaries: () => { calls++; throw Error(); } });
  const result = await run(envelope); assert.equal(result.status, 'PUBLIC_BASELINE_VALIDATED');
  assert.equal(result.baselineConfigDigest, digest(s.baselineConfig)); assert.equal(result.environmentNameCount, 25);
  assert.equal(JSON.stringify(result).includes('secure-documents'), false);
  for (const mutate of [e => { e.fullConfigurationRetained = false; }, e => { delete e.baselineConfig.env.BACKUP_ENABLED; },
    e => { e.observedEnvironmentNames.pop(); }, e => { e.observedEnvironmentNames.push(e.observedEnvironmentNames[0]); },
    e => { e.baselineConfig.env.ADMIN_AUTH_MODE = 'password'; }, e => { e.baselineConfigDigest = '0'.repeat(64); },
    e => { e.baselineConfig.services[0].autostop = 'off'; e.baselineConfigDigest = digest(e.baselineConfig); },
    e => { e.baselineConfig.image += '@extra'; e.baselineConfigDigest = digest(e.baselineConfig); },
    e => { e.baselineConfig.image = `@${e.baselineImageDigest}`; e.baselineConfigDigest = digest(e.baselineConfig); },
    ...[c => { c.auto_destroy = 'false'; }, c => { c.schedule = false; }, c => { c.init.exec = false; },
      c => { c.init = false; }, c => { c.init = []; }, c => { c.env.TZ = 'é'.repeat(3000); },
      c => { c.mounts = { 0: c.mounts[0], length: 1 }; }].map(mutate => e => { mutate(e.baselineConfig); e.baselineConfigDigest = digest(e.baselineConfig); }),
    e => { e.baselineImageDigest = image; }, e => { e.observedAt = new Date(now - 1800001).toISOString(); },
    e => { e.observedAt = new Date(now + 1).toISOString(); }, e => { e.instanceId = ''; }, e => { e.sourceHead = ''; },
    e => { e.state = 'started'; }, e => { e.machineId = 'other'; }, e => { e.secret = 'synthetic-private-canary'; }]) {
    const e = structuredClone(envelope); mutate(e); await assert.rejects(run(e));
  }
  await assert.rejects(runP10bNoEmailSessionCli(['--validate-baseline', 'public.json'], { read: () => envelope,
    clock: () => now, checkSource: () => { throw Error('changed checkout'); }, openNative: () => { calls++; } }));
  assert.equal(calls, 0);
});
function memoryEvidence() {
  const files = new Map(); return { files, has: name => files.has(name), read: name => structuredClone(files.get(name)),
    write(name, value) { assert.equal(files.has(name), false); files.set(name, structuredClone(value)); } };
}
function requireExport(module, name) { assert.equal(typeof module[name], 'function', `${name} is implemented`); return module[name]; }

test('invalid local native request timeouts reject before dispatch or consuming a stopped update', async () => {
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const s = session(); s.nativeClientSha256 = sha256(fs.readFileSync(process.execPath));
  const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(s),
    ownerPermissionDigest: s.ownerPermissionDigest, sourceHead: s.sourceHead, hostSourceHead: s.hostSourceHead,
    expiresAt: s.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  const child = Object.assign(new EventEmitter(), { pid: 2147483002,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let dispatches = 0; let closed = false;
  child.kill = () => { if (!closed) { closed = true; child.emit('close', 0, null); } return true; };
  child.stdin.on('data', raw => {
    const frame = JSON.parse(raw); if (!frame.version) dispatches++;
    queueMicrotask(() => child.stdout.write(JSON.stringify(frame.version ? { version: 'p10b-native-ready-v1', ready: true }
      : { id: frame.id, ok: true, machine: { id: 'offline-machine' } }) + '\n'));
  });
  const native = await openP10bNativeMachineClient({ executable: process.execPath, session: s, approval,
    configs: [s.baselineConfig], recoveryVerified: true, clock: () => now,
    environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, spawnProcess: () => child });
  try {
    for (const timeout of [0, 10001, NaN, '1000', 1.5]) await assert.rejects(native.client('POST', {}, timeout));
    assert.equal(dispatches, 0);
    for (let i = 0; i < 3; i++) assert.equal((await native.client('POST', {}, 1000)).id, 'offline-machine');
    await assert.rejects(native.client('POST', {}, 1000)); assert.equal(dispatches, 3);
  } finally { assert.equal(await native.close(), true); }
});

test('native failure protocol rejects unknown codes, raw fields and contradictory success without retaining them', async t => {
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  for (const invalid of [{ error: 'synthetic-private-canary' }, { httpStatus: 422 },
    { body: 'synthetic-private-canary' }, { ok: true }, { error: undefined },
    { machine: { id: 'synthetic-private-canary' } }]) {
    await t.test(JSON.stringify(Object.keys(invalid)), async () => {
      const s = session(); s.nativeClientSha256 = sha256(fs.readFileSync(process.execPath));
      const approval = { ...operatorFixture().x.approval, sessionDigest: digest(s) };
      const child = Object.assign(new EventEmitter(), { pid: 2147483003,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let closed = false;
      child.kill = () => { if (!closed) { closed = true; child.emit('close', 0, null); } return true; };
      child.stdin.on('data', raw => {
        const frame = JSON.parse(raw);
        queueMicrotask(() => child.stdout.write(JSON.stringify(frame.version
          ? { version: 'p10b-native-ready-v1', ready: true }
          : { id: frame.id, ok: false, error: 'http-failed', ...invalid }) + '\n'));
      });
      const native = await openP10bNativeMachineClient({ executable: process.execPath, session: s, approval,
        configs: [s.baselineConfig], recoveryVerified: true, clock: () => now,
        environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, spawnProcess: () => child });
      try {
        await assert.rejects(native.client('POST', {}, 1000), error => {
          assert.deepEqual(error.publicFailure, { version: 'p10b-native-request-failure-v1',
            code: 'bridge-protocol', method: 'POST', timeoutMs: 1000 });
          assert.equal(JSON.stringify(error.publicFailure).includes('canary'), false); return true;
        });
        await assert.rejects(native.client('POST', {}, 1000), /unavailable/);
      } finally { assert.equal(await native.close(), true); }
    });
  }
});

test('guardian mutation responses still require observations and read-only responses reject private fields', async t => {
  const { spawn } = await import('node:child_process');
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const { createP10bAppTokenContext } = await import('../server/services/p10bHostAuthentication.js');
  for (const mode of ['mutation-missing-observation', 'readonly-extra-field', 'readonly-foreign-observation']) {
    await t.test(mode, async () => {
      const f = operatorFixture({ guardian: true }); const s = f.options.session;
      s.nativeClientSha256 = sha256(fs.readFileSync(process.execPath)); f.options.approval.sessionDigest = digest(s);
      const context = createP10bAppTokenContext({ session: s, approval: f.options.approval, clock: f.options.clock,
        environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-protocol-input-canary' } });
      const code = `const rl=require('node:readline').createInterface({input:process.stdin});let first=true;
        rl.on('line',line=>{const input=JSON.parse(line);if(first){first=false;console.log(JSON.stringify({version:'p10b-native-ready-v1',ready:true}));return;}
        const frame={id:input.id,ok:false,error:'http-failed'};
        ${mode === 'readonly-extra-field' ? "frame.rawBody='synthetic-private-response-canary';" : ''}
        ${mode === 'readonly-foreign-observation' ? 'frame.observation={httpStatus:401,elapsedMs:1,dispatched:true};' : ''}
        console.log(JSON.stringify(frame));});`;
      let native;
      try {
        native = await openP10bNativeMachineClient({ executable: process.execPath, args: ['-e', code], session: s,
          approval: f.options.approval, configs: [s.baselineConfig], readOnly: mode !== 'mutation-missing-observation',
          recoveryVerified: true, environment: context.environment, clock: f.options.clock, spawnProcess: spawn });
        await assert.rejects(native.client(), error => {
          assert.equal(error.publicFailure.code, 'bridge-protocol');
          assert.equal(JSON.stringify(error).includes('canary'), false); return true;
        });
      } finally {
        assert.equal(await native?.reap(), true); assert.equal(context.assertReaped(), true);
        assert.equal(context.cleanup({ reaped: true }), true);
      }
    });
  }
});

test('validated native failure crosses the actual bridge and remains in failed update closure without raw text', async t => {
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  for (const code of ['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output']) {
    await t.test(code, async () => {
      const f = operatorFixture(); const s = structuredClone(f.x.s);
      s.nativeClientSha256 = sha256(fs.readFileSync(process.execPath));
      const approval = { ...f.x.approval, sessionDigest: digest(s) };
      const child = Object.assign(new EventEmitter(), { pid: 2147483002,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let closed = false;
      child.kill = () => { if (!closed) { closed = true; child.emit('close', 0, null); } return true; };
      child.stdin.on('data', raw => {
        const frame = JSON.parse(raw);
        queueMicrotask(() => child.stdout.write(JSON.stringify(frame.version
          ? { version: 'p10b-native-ready-v1', ready: true }
          : { id: frame.id, ok: false, error: code }) + '\n'));
      });
      const native = await openP10bNativeMachineClient({ executable: process.execPath, session: s, approval,
        configs: [s.baselineConfig], recoveryVerified: true, clock: () => now,
        environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, spawnProcess: () => child });
      let failure;
      try { await native.client('POST', { config: s.baselineConfig, skip_launch: true, current_version: 'synthetic-version' }, 10000); }
      catch (error) { failure = error; }
      assert.equal(await native.close(), true);
      const expected = { version: 'p10b-native-request-failure-v1', code, method: 'POST', timeoutMs: 10000 };
      assert.deepEqual(failure.publicFailure, expected);
      // Raw exception text is deliberately hostile: only the typed property may survive.
      failure.message = 'synthetic-private-error-body-canary';
      failure.stack = 'synthetic-private-stack-canary';
      const original = f.options.createBoundaries; let posts = 0;
      f.options.createBoundaries = async () => {
        const boundaries = await original(); const read = boundaries.client;
        boundaries.client = async (method = 'GET', body) => {
          if (method === 'POST') { posts++; throw failure; }
          return read(method, body);
        };
        return boundaries;
      };
      await assert.rejects(operator.runP10bNoEmailOperator(f.options));
      const closure = f.evidence.read('p10b-runtime-only-session-closure.json');
      assert.equal(closure.failureStage, 'demo-stopped-update'); assert.equal(closure.restored, false); assert.equal(closure.mutationUncertain, true);
      assert.deepEqual(closure.failureDiagnostic, expected); assert.equal(posts, 1);
      assert.equal(JSON.stringify(closure).includes('canary'), false);
      assert.equal(f.evidence.has('p10b-runtime-only-demo-start-intent.json'), false);
    });
  }
});

test('phase packet binds fresh paths and unchanged no-email bounds without process environment mutation', () => {
  const build = requireExport(operator, 'createP10bRuntimePhase'); const s = session();
  const phase = build(s, 'prepare', now);
  assert.equal(phase.packet.operation, 'prepare'); assert.equal(phase.packet.target.imageDigest, image);
  assert.equal(phase.window.stopAt, '2026-10-12T12:05:00.000Z');
  assert.equal(phase.config.env.NODE_ENV, 'p10b'); assert.equal(phase.config.env.DELIVERY_PROVIDER, 'console');
  assert.match(phase.packet.databasePath, /^\/data\/p10b-first-mailbox-nosend-[a-f0-9]{24}\.sqlite$/);
  assert.equal(phase.config.processes[1].ignore_app_secrets, true);
  assert.equal(JSON.stringify(phase).includes('offline-sending-secret'), false);
  assert.equal(s.baselineConfig.env.P10B_GUEST_WINDOW, undefined);
  assert.notEqual(build(s, 'demo', now).packet.databasePath, phase.packet.databasePath);
});

test('phase packet denies deadline extension, qualify labels, changed capacity and secret-valued public config', () => {
  const build = requireExport(operator, 'createP10bRuntimePhase');
  assert.throws(() => build(session(), 'qualify', now));
  assert.throws(() => build(session(), 'prepare', now + 3599999));
  const s = session(); s.maximumStarts = 3; assert.throws(() => build(s, 'demo', now));
  const c = session(); c.baselineConfig.env.RESEND_API_KEY = 'private-canary'; assert.throws(() => build(c, 'demo', now));
  for (const key of ['DATABASE_URL', 'UNKNOWN_PRIVATE_VALUE']) {
    const c = session(); c.baselineConfig.env[key] = 'private-canary'; assert.throws(() => build(c, 'demo', now));
  }
});

test('held CLI template cannot create native or recovery boundaries', async () => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  let calls = 0;
  const result = await runP10bNoEmailSessionCli(['--validate-template', 'templates/p10b-no-email-session.json'], {
    openNative: () => { calls++; throw Error('must never load authentication'); } });
  assert.equal(result.status, 'SESSION_NOT_APPROVED'); assert.equal(calls, 0);
  await assert.rejects(runP10bNoEmailSessionCli(['--execute', '--bundle', 'templates/p10b-no-email-session.json',
    '--evidence', '/not-used', '--native-client', '/not-used'], { openNative: () => { calls++; throw Error(); } }));
  assert.equal(calls, 0);
});

test('native stdio adapter uses a mock helper, denies mutation and reaps timeout', async t => {
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-native-mock-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'mock-helper.mjs');
  fs.writeFileSync(script, `import readline from 'node:readline';let init=false;
    for await(const line of readline.createInterface({input:process.stdin})) {const r=JSON.parse(line);
    if(!init){init=true;process.stdout.write(JSON.stringify({version:'p10b-native-ready-v1',ready:true})+'\\n');}
    else if(r.method==='GET'&&r.timeoutMs===100){process.stdout.write(JSON.stringify({id:r.id,ok:true,machine:{id:'mock-machine'}})+'\\n');}}
  `);
  const s = session(); s.nativeClientSha256 = sha256(fs.readFileSync(process.execPath));
  const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(s),
    ownerPermissionDigest: s.ownerPermissionDigest, sourceHead: s.sourceHead, hostSourceHead: s.hostSourceHead, expiresAt: s.sessionDeadline,
    recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  let spawned = 0;
  await assert.rejects(openP10bNativeMachineClient({ session: s, approval: {}, clock: () => now,
    spawnProcess: () => { spawned++; throw Error(); } })); assert.equal(spawned, 0);
  const native = await openP10bNativeMachineClient({ executable: process.execPath, args: [script], session: s, approval,
    readOnly: true, configs: [s.baselineConfig], clock: () => now, environment: { PATH: process.env.PATH } });
  assert.equal((await native.client('GET', undefined, 100)).id, 'mock-machine');
  await assert.rejects(native.client('POST', {}));
  await assert.rejects(native.client('GET', undefined, 20));
  assert.equal(await native.reap(), true);
  const terminal = await native.terminal(); assert.equal(terminal.signal, 'SIGKILL');
});

test('observer accepts nanosecond platform time but discards malformed or arbitrary application log data', async () => {
  const { sanitizeP10bGuardianLog, normalizeP10bPlatformTime } = await import('../server/services/p10bRuntimeObserver.js');
  const { P10B_GUARDIAN_EXIT_PREFIX } = await import('../server/services/p10bGuardianParent.js');
  const phase = operator.createP10bRuntimePhase(session(), 'demo', now);
  const value = { version: 'p10b-guardian-child-exit-v1', windowDigest: digest(phase.window), productionReady: false,
    bindingVerified: true, code: 0, signal: null, spawnFailed: false, guardianPid: 5001, parentPid: 5000,
    exitedAt: '2026-10-12T12:04:00.000Z', parentStartedAt: '2026-10-12T12:00:00.000Z',
    readyDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), startDigest: 'c'.repeat(64) };
  const row = { instance: phase.window.machineId, region: 'ewr', timestamp: '2026-10-12T12:04:00.334578044Z',
    message: P10B_GUARDIAN_EXIT_PREFIX + JSON.stringify(value) };
  assert.equal(sanitizeP10bGuardianLog(row, phase.window).timestamp, '2026-10-12T12:04:00.334Z');
  assert.equal(normalizeP10bPlatformTime('2026-02-30T12:00:00Z'), null);
  assert.equal(sanitizeP10bGuardianLog({ ...row, message: 'private-canary' }, phase.window), null);
  assert.equal(sanitizeP10bGuardianLog({ ...row, message: P10B_GUARDIAN_EXIT_PREFIX + JSON.stringify({ ...value, secret: 'private-canary' }) }, phase.window), null);
});

test('recovery does not retire active reservation after its independent observation expires during fsync', () => {
  const x = recoveryFixture(); let clock = now;
  const original = x.filesystem.syncFile;
  x.filesystem.syncFile = file => { original(file); if (file === x.s.recovery.archivePath) clock += 30001; };
  assert.throws(() => recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval, baseline: x.baseline,
    independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => clock, operatorPid: 5010 }));
  assert.equal(x.f.has(x.s.recovery.activePath), true); assert.equal(x.f.get(x.s.recovery.archivePath).bytes, x.bytes);
});

test('worker public predicates never invoke credential getters or retain arbitrary values', () => {
  const capture = requireExport(diagnostics, 'captureP10bWorkerDiagnostics');
  const phase = requireExport(operator, 'createP10bRuntimePhase')(session(), 'prepare', now);
  const config = workerConfig(); config.storage = { provider: 'sqlite', sqlitePath: phase.packet.databasePath };
  config.dealHunter.cimProvider.qualificationPhase = 'prepare';
  config.dealHunter.cimProvider.qualificationGuestWindow = stableCanonicalJson(phase.window);
  for (const key of ['resendApiKey', 'reconciliationApiKey', 'emailWebhookSecret'])
    Object.defineProperty(config.dealHunter.cimProvider, key, { get() { throw Error('credential was queried'); } });
  const result = capture({ config, packet: phase.packet,
    runtime: { app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', sourceHead: '1'.repeat(40) },
    credentialKeyNames: ['DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY', 'UNEXPECTED_PRIVATE_NAME'] });
  assert.equal(result.predicates.databasePath, true); assert.equal(result.predicates.runtimeFlag, true);
  config.dealHunter.cimProvider.resendFromEmail = 'private-canary';
  const failed = capture({ config, packet: phase.packet, runtime: {}, credentialKeyNames: [] });
  assert.equal(failed.predicates.sender, false);
  assert.equal(JSON.stringify(failed).includes('private-canary'), false);
  assert.equal(JSON.stringify(result).includes('UNEXPECTED_PRIVATE_NAME'), false);
});

test('positive recovery gate rejects a pending intent before any runtime boundary can be invoked', () => {
  const gate = requireExport(recovery, 'assertP10bRecoveryAdmission');
  let calls = 0;
  assert.throws(() => gate({ session: session(), recovery: { intent: { status: 'pending' } },
    inspect: () => { calls++; return {}; }, now }), /recovery/i);
  assert.equal(calls, 0);
});

test('no-email operator rejects unapproved or closed sessions before constructing authenticated boundaries', async () => {
  const run = requireExport(operator, 'runP10bNoEmailOperator'); const evidence = memoryEvidence(); let calls = 0;
  await assert.rejects(run({ session: session(), approval: { status: 'SESSION_NOT_APPROVED' }, evidence,
    createBoundaries: () => { calls++; throw Error('must not authenticate'); }, clock: () => now }));
  assert.equal(calls, 0); assert.equal(evidence.files.size, 0);
  evidence.write('p10b-runtime-only-session-closure.json', { closed: true });
  await assert.rejects(run({ session: session(), approval: { approved: true }, evidence,
    createBoundaries: () => { calls++; throw Error('must not authenticate'); }, clock: () => now }));
  assert.equal(calls, 0);
});

function recoveryFixture({ directory = '/mock-admission', evidenceRoot = '/fresh/recovery', guardian = false } = {}) {
  const s = guardian ? guardianSession() : session(); const f = new Map(); const operations = [];
  const record = { version: 'p10b-machine-owner-v1', packetDigest: '4'.repeat(64), evidencePath: '/preserved/failed', reservedAt: '2026-10-10T07:12:20.821Z' };
  const bytes = JSON.stringify(record);
  s.recovery = { directory, activePath: `${directory}/0803730bd1d7e8.active.json`, archivePath: `${directory}/0803730bd1d7e8.active.json.archived-uncertain-${s.nonce}.json`,
    attemptPath: `${directory}/${record.packetDigest}.attempt.json`, intentPath: `${evidenceRoot}/p10b-recovery-intent.json`, terminalPath: `${evidenceRoot}/p10b-recovery-terminal.json`,
    expectedSha256: sha256(bytes), ...record };
  const item = { bytes, inode: '42', device: '7', mode: 384, owner: 501, mtime: 100, regular: true, symlink: false };
  f.set(s.recovery.activePath, item); f.set(s.recovery.attemptPath, { ...item, bytes: 'retained-attempt', inode: '43' });
  let failAt;
  const op = name => { operations.push(name); if (failAt === name) throw Error('synthetic interrupted action'); };
  const filesystem = {
    statDirectory: () => ({ ownerControlled: true, symlink: false }), read: file => f.get(file).bytes,
    stat: file => ({ ...f.get(file) }), exists: file => f.has(file),
    writeExclusive(file, value) { op(`write:${file}`); assert.equal(f.has(file), false); f.set(file, { ...item, bytes: JSON.stringify(value), inode: String(f.size + 100) }); },
    linkExclusive(from, to) { op('link'); assert.equal(f.has(to), false); f.set(to, f.get(from)); },
    syncFile(file) { op(`sync-file:${file}`); }, syncDirectoryOf(file) { op(`sync-directory:${file}`); },
    unlinkActive(file) { op('retire-active'); f.delete(file); },
  };
  const baseline = { id: s.machineId, state: 'stopped', region: 'ewr', instance_id: 'old-version', image_ref: { digest: s.baselineImageDigest }, config: s.baselineConfig };
  const approval = { version: guardian ? 'p10b-guardian-only-approval-v1' : 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(s), ownerPermissionDigest: s.ownerPermissionDigest,
    sourceHead: s.sourceHead, hostSourceHead: s.hostSourceHead, expiresAt: s.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  const independentBaseline = { machineDigest: digest(baseline), independent: true, observedAt: new Date(now).toISOString() };
  const inspect = () => ({ activeAbsent: !f.has(s.recovery.activePath), archiveSha256: sha256(f.get(s.recovery.archivePath).bytes),
    archiveDevice: f.get(s.recovery.archivePath).device, archiveInode: f.get(s.recovery.archivePath).inode, attemptSha256: sha256(f.get(s.recovery.attemptPath).bytes) });
  return { s, f, operations, filesystem, baseline, approval, independentBaseline, inspect, bytes, fail(name) { failAt = name; } };
}

test('recovery flushes an exclusive preserved inode before retirement and keeps failed attempt bytes', () => {
  const x = recoveryFixture();
  const recovered = requireExport(recovery, 'recoverP10bAdmissionReservation')({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  assert.equal(x.f.get(x.s.recovery.archivePath).bytes, x.bytes);
  assert.equal(x.f.get(x.s.recovery.attemptPath).bytes, 'retained-attempt');
  assert.equal(x.f.has(x.s.recovery.activePath), false);
  assert.ok(x.operations.indexOf(`sync-file:${x.s.recovery.archivePath}`) < x.operations.indexOf('retire-active'));
  assert.ok(x.operations.indexOf(`sync-directory:${x.s.recovery.archivePath}`) < x.operations.indexOf('retire-active'));
  assert.equal(recovered.terminal.historicalCleanupVerified, false);
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  assert.equal(recovery.assertP10bRecoveryAdmission({ session: x.s, recovery: { ...recovered, verification }, inspect: x.inspect, now }), true);
});

test('recovery crash before or after active retirement cannot pass the admission gate', async t => {
  for (const stage of ['link', 'archive-sync', 'terminal-write']) await t.test(stage, () => {
    const x = recoveryFixture(); x.fail(stage === 'archive-sync' ? `sync-file:${x.s.recovery.archivePath}` : stage === 'terminal-write' ? `write:${x.s.recovery.terminalPath}` : 'link');
    assert.throws(() => recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval, baseline: x.baseline,
      independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 }));
    assert.equal(x.f.get(x.s.recovery.attemptPath).bytes, 'retained-attempt');
    assert.equal(x.f.has(x.s.recovery.activePath), stage !== 'terminal-write');
    if (stage !== 'link') assert.equal(x.f.get(x.s.recovery.archivePath).bytes, x.bytes);
    assert.throws(() => recovery.assertP10bRecoveryAdmission({ session: x.s, recovery: {}, inspect: x.inspect, now }));
  });
});

test('recovery rejects unparseable stopped-observation time without writing an intent', () => {
  const x = recoveryFixture(); x.independentBaseline.observedAt = 'invalid';
  assert.throws(() => recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval, baseline: x.baseline,
    independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 }));
  assert.equal(x.operations.length, 0);
});

function operatorFixture(paths) {
  const x = recoveryFixture(paths); const evidence = memoryEvidence(); let clock = now; let updates = 0; const order = [];
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval, baseline: x.baseline,
    independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => clock, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  let machine = structuredClone(x.baseline);
  const result = { version: 'p10b-host-result-v1', operation: 'prepare', success: true, failureStage: null,
    stoppedVerified: true, processReaped: true, stopUncertain: false, startUncertain: false, productionReady: false, lifecycleVerified: false,
    preparation: { providerCalls: 0, productionReady: false, ingressClosed: true, sqliteClosed: true,
      guestShutdown: { handoffVerified: true, cleanupUncertain: false, failure: false, authorityClosed: true, ingressClosed: true, workerSqliteClosed: true } } };
  const options = { session: x.s, approval: x.approval, recovery: { ...recovered, verification }, inspectRecovery: x.inspect,
    verifyPrivateReap: () => true,
    evidence, clock: () => clock, createBoundaries: async () => ({
      client: async (method = 'GET', body) => { if (method === 'WAIT') return { ok: true, state: 'stopped', version: body.version }; if (method === 'POST') { updates++; machine = { ...machine, config: body.config,
        instance_id: `version-${updates}`, image_ref: { digest: body.config.image.split('@')[1] } }; } return structuredClone(machine); },
      startObserver: async ({ machine }) => ({ attached: true, separateSession: true, instanceId: machine.instance_id, imageDigest: machine.image_ref.digest }),
      demonstrate: async ({ phase }) => { order.push('demo'); clock += 305000; return { success: true, windowDigest: digest(phase.window), observerSurvived: true,
        primaryTerminationVerified: true, stopLatencyMs: 1600, maximumMetadataPollGapMs: 750, maximumMetadataResponseGapMs: 800,
        normalMachineExit: true, observerContinuous: true, unexpectedRestart: false, exitRecordCount: 1 }; },
      runPreparation: async ({phase}) => { order.push('prepare'); clock += 305000;
        result.packetDigest = digest(phase.packet); result.sourceHead = x.s.sourceHead;
        Object.assign(result.preparation, {app:x.s.app,machineId:x.s.machineId,sourceHead:x.s.sourceHead,
          runtimeConfigurationDigest:phase.packet.configurationEvidence.runtimeConfigurationDigests.prepare});
        Object.assign(result.preparation.guestShutdown,{windowDigest:digest(phase.window),stopAt:phase.window.stopAt});
        return { code: 0, signal: null, result }; },
      reap: async () => true, close: async () => true,
    }) };
  return {x,evidence,options,order,updates:()=>updates,machine:()=>machine};
}

test('operator runs guardian proof then preparation and restores baseline, with one-shot session closure', async () => {
  const {x,evidence,options,order,updates,machine}=operatorFixture();
  assert.equal((await operator.runP10bNoEmailOperator(options)).success, true);
  assert.deepEqual(order, ['demo', 'prepare']); assert.equal(updates(), 3);
  assert.deepEqual(machine().config, x.s.baselineConfig);
  assert.equal(evidence.read('p10b-runtime-only-session-closure.json').restored, true);
  await assert.rejects(operator.runP10bNoEmailOperator(options)); assert.equal(updates(), 3);
});


test('unresolved descendant reap blocks restoration before a third update can remove guardian configuration', async () => {
  const f = operatorFixture(); let gates = 0;
  f.options.verifyPrivateReap = () => { gates++; throw Error('synthetic descendant intent'); };
  await assert.rejects(operator.runP10bNoEmailOperator(f.options));
  assert.equal(gates, 1); assert.equal(f.updates(), 2);
  assert.equal(f.evidence.read('p10b-runtime-only-session-closure.json').restored, false);
});

test('operator failure matrix keeps sticky closure and restores stopped baseline without retry or preparation promotion', async t => {
  for (const failure of ['constructor','demo-proof','stale-result','reap','settle','close']) await t.test(failure, async () => {
    const f=operatorFixture();const factory=f.options.createBoundaries;
    f.options.createBoundaries=async ()=>{
      if(failure==='constructor')throw Error('private-canary');
      const b=await factory();
      if(failure==='demo-proof')b.demonstrate=async()=>({success:true});
      if(failure==='stale-result'){const prep=b.runPreparation;b.runPreparation=async x=>{const terminal=await prep(x);terminal.result.packetDigest='0'.repeat(64);return terminal;};}
      if(failure==='reap')b.reap=async()=>false;
      if(failure==='settle')b.settle=async()=>false;
      if(failure==='close')b.close=async()=>false;
      return b;
    };
    await assert.rejects(operator.runP10bNoEmailOperator(f.options));
    const closure=f.evidence.read('p10b-runtime-only-session-closure.json');assert.equal(closure.success,false);
    assert.equal(JSON.stringify(closure).includes('private-canary'),false);
    if(!['constructor','reap','settle'].includes(failure))assert.deepEqual(f.machine().config,f.x.s.baselineConfig);
    if(['reap','settle'].includes(failure)){assert.equal(f.updates(),2);assert.equal(closure.restored,false);}
    if(failure==='demo-proof')assert.deepEqual(f.order,[]);
    const count=f.updates();await assert.rejects(operator.runP10bNoEmailOperator(f.options));assert.equal(f.updates(),count);
  });
});

test('unknown public package fields fail before authentication or evidence publication', async () => {
  const f=operatorFixture();f.options.session.privateDiagnostic='private-canary';let calls=0;
  f.options.createBoundaries=()=>{calls++;throw Error();};
  await assert.rejects(operator.runP10bNoEmailOperator(f.options));assert.equal(calls,0);assert.equal(f.evidence.files.size,0);
});

async function observerPollFixture(readLogs = async () => [], late = false, options = {}) {
  const { runP10bIndependentObserver } = await import('../server/services/p10bIndependentObserver.js');
  const x = recoveryFixture(); const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now); let clock = now + (options.startOffsetMs || 0); let nativeReaps = 0; let logReaps = 0; let processReaps = 0; const queue = [];
  const wait = ms => new Promise(resolve => queue.push({ at: clock + ms + (late ? 300 : 0), resolve }));
  const rows = []; const reads = []; let metadataCalls = 0; let logOpens = 0; let attached; let attachedAt;
  const processes = { async command() { assert.fail('Observer must not invoke the Fly CLI'); },
    async reap() { processReaps++; if (options.cleanupMs) await wait(options.cleanupMs); return options.reaped !== false; } };
  const machine = { ...x.baseline, config: phase.config, image_ref: { digest: image } };
  const run = runP10bIndependentObserver({ session: x.s, approval: x.approval, phase, machine,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, record: row => {
      rows.push(row); if (row.kind === 'log-source-ready') clock += options.readyPublicationMs || 0;
    }, attached: value => { attached = value; attachedAt = clock; options.onAttach?.(); },
    processes, clock: () => options.freezeWall && attached ? now : clock,
    monotonicClock: () => clock - now, signal: options.signal, wait,
    async openLogs(input) {
      logOpens++; options.onLogInitialization?.();
      if (options.logInitializationMs) await wait(options.logInitializationMs);
      assert.equal(input.readOnly, true); assert.deepEqual(input.configs, [phase.config]);
      assert.equal(input.signal, options.signal);
      if (options.logInitializationFailure) throw options.logInitializationFailure;
      return { async client(method, body, timeout) {
        assert.equal(method, 'GET'); assert.equal(body, undefined);
        assert.equal(timeout, reads.length ? 700 : 5000);
        reads.push(clock);
        return readLogs({ phase, index: reads.length, at: clock, wait, advance(ms) { clock += ms; } });
      }, async reap() {
        logReaps++; if (options.logCleanupMs) await wait(options.logCleanupMs); if (options.logReapFailure) throw Error('synthetic private cleanup error');
        return options.logReaped !== false;
      } };
    },
    async openNative(input) { assert.equal(input.readOnly, true); return { async client(method, body, timeout) {
      assert.equal(method, 'GET'); assert.equal(body, undefined); assert.equal(timeout, 700);
      const index = metadataCalls++; await wait(typeof options.latency === 'function' ? options.latency(index) : (options.latency || 0));
      if (options.metadataFailureAt === index + 1) throw options.metadataFailure;
      return structuredClone(machine); },
      async reap() { nativeReaps++; if (options.nativeCleanupMs) await wait(options.nativeCleanupMs);
        if (options.nativeReapFailure) throw Error('synthetic private metadata cleanup error'); return options.nativeReaped !== false; } }; } });
  let done = false, success, error;
  run.then(value => { success = value; done = true; }, failure => { error = failure; done = true; });
  let steps = 0;
  while (!done) {
    assert.ok(++steps < 10000, 'Observer exceeded bounded virtual scheduling');
    await new Promise(setImmediate); if (done) break;
    queue.sort((a, b) => a.at - b.at); const next = queue.shift();
    if (!next) throw Error('Observer virtual clock stalled'); clock = Math.max(clock, next.at); next.resolve();
  }
  if (error && !options.expectFailure) throw error;
  return { success, error, attached, attachedAt, metadataCalls, logOpens, nativeReaps, logReaps, processReaps, rows, reads, phase };
}

test('log initialization failure reaps the already open metadata reader', async () => {
  const failure = Object.assign(Error('synthetic log init failure'), { reapVerified: true });
  const f = await observerPollFixture(undefined, false, { logInitializationFailure: failure, expectFailure: true });
  assert.ok(f.error); assert.equal(f.logOpens, 1); assert.equal(f.reads.length, 0); assert.equal(f.nativeReaps, 1);
  assert.equal(f.logReaps, 0); assert.equal(f.processReaps, 1); assert.equal(f.attached, undefined);
});

for (const kind of ['false', 'throw']) test(`log cleanup ${kind} cannot publish aggregate native reaping`, async () => {
  const f = await observerPollFixture(undefined, false, { logReaped: kind !== 'false', logReapFailure: kind === 'throw' });
  assert.equal(f.success, false); assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1);
  assert.equal(f.rows.at(-1).nativeReaped, false); assert.equal(f.rows.at(-1).normalCompletion, false);
});

test('both native reaps and process cleanup run in parallel inside the existing three-second bound', async () => {
  const f = await observerPollFixture(undefined, false, { nativeCleanupMs: 2700, logCleanupMs: 2700, cleanupMs: 2700 });
  assert.equal(f.success, true); assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1); assert.equal(f.processReaps, 1);
  const finished = f.rows.at(-1);
  assert.equal(Date.parse(finished.at) - Date.parse(finished.cleanupStartedAt), 2700);
  assert.equal(finished.nativeReaped, true); assert.equal(finished.processesReaped, true);
});

for (const kind of ['false', 'throw']) test(`metadata cleanup ${kind} still attempts log-reader cleanup`, async () => {
  const f = await observerPollFixture(undefined, false, { nativeReaped: kind !== 'false', nativeReapFailure: kind === 'throw' });
  assert.equal(f.success, false); assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1);
  assert.equal(f.rows.at(-1).nativeReaped, false);
});

test('cancellation during log initialization reaps a late reader without dispatching any log request', async () => {
  const controller = new AbortController();
  const f = await observerPollFixture(undefined, false, { signal: controller.signal,
    onLogInitialization: () => controller.abort(), logInitializationMs: 50, expectFailure: true });
  assert.ok(f.error); assert.equal(f.logOpens, 1); assert.equal(f.reads.length, 0);
  assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1); assert.equal(f.attached, undefined);
});

test('metadata failure during log initialization prevents the first log request', async () => {
  const f = await observerPollFixture(undefined, false, { latency: 100, metadataFailureAt: 2,
    metadataFailure: Error('synthetic metadata fault'), logInitializationMs: 2000, expectFailure: true });
  assert.ok(f.error); assert.equal(f.logOpens, 1); assert.equal(f.reads.length, 0);
  assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1); assert.equal(f.attached, undefined);
});

test('cancellation during an active log read cannot publish success or dispatch again', async () => {
  const controller = new AbortController();
  const f = await observerPollFixture(async ({ index, wait }) => {
    if (index === 2) { controller.abort(); await wait(50); } return [];
  }, false, { signal: controller.signal });
  assert.equal(f.success, false); assert.equal(f.reads.length, 2); assert.equal(f.logOpens, 1);
  assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1);
  assert.equal(f.rows.at(-1).normalCompletion, false);
});

test('slow native log reads do not serialize continuous metadata acquisition', async () => {
  const f = await observerPollFixture(async ({ wait }) => { await wait(600); return []; }, false, { latency: 100 });
  assert.equal(f.success, true); assert.ok(f.metadataCalls > 2000); assert.ok(f.reads.length > 390);
  assert.equal(f.nativeReaps, 1); assert.equal(f.logReaps, 1);
  const metadata = f.rows.filter(row => row.kind === 'metadata');
  assert.ok(metadata.slice(1).every((row, i) => Date.parse(row.requestedAt) - Date.parse(metadata[i].requestedAt) <= 1000));
});

test('native log failures retain only dedicated closed facts and never retry the reader', async () => {
  const { P10bNativeLogRequestError } = await import('../server/services/p10bNativeFailure.js');
  const error = new P10bNativeLogRequestError({ code: 'http-failed', timeoutMs: 700, httpStatus: 503, elapsedMs: 100, dispatched: true });
  error.message = 'private-canary';
  const f = await observerPollFixture(async ({ index }) => { if (index === 2) throw error; return []; });
  assert.equal(f.success, false); assert.equal(f.reads.length, 2); assert.equal(f.logOpens, 1);
  assert.deepEqual(f.rows.find(row => row.kind === 'observer-log-read-error').nativeFailure,
    { version: 'p10b-native-log-failure-v1', code: 'http-failed', timeoutMs: 700, httpStatus: 503, elapsedMs: 100, dispatched: true });
  assert.equal(JSON.stringify(f.rows).includes('private-canary'), false);
});

test('an invalid public log row fails revalidation without retaining its message', async () => {
  const f = await observerPollFixture(async ({ index, phase }) => index === 1 ? []
    : [{ timestamp: phase.window.issuedAt, instance: phase.window.machineId, region: 'ewr', message: 'private-canary' }]);
  assert.equal(f.success, false); assert.equal(f.reads.length, 2);
  assert.equal(f.rows.find(row => row.kind === 'observer-log-read-error').stage, 'validation');
  assert.equal(JSON.stringify(f.rows).includes('private-canary'), false);
});

test('observer wall rollback cannot outlive the original elapsed lifetime or spin past log quota', async () => {
  const f = await observerPollFixture(undefined, false, { freezeWall: true });
  assert.equal(f.success, false); assert.ok(f.reads.length <= 410);
  assert.equal(f.processReaps, 1); assert.equal(f.nativeReaps, 1);
  assert.equal(f.rows.at(-1).normalCompletion, false);
});

test('failed native log read ends further polling and cannot admit observer proof', async () => {
  const f = await observerPollFixture(async ({ index }) => {
    if (index === 2) throw Error('private-canary'); return [];
  });
  assert.equal(f.success, false); assert.equal(f.reads.length, 2);
  assert.equal(f.processReaps, 1); assert.equal(f.nativeReaps, 1);
});

test('observer parent cancellation after attachment performs cleanup without another log command', async () => {
  const controller = new AbortController();
  const f = await observerPollFixture(undefined, false, { signal: controller.signal,
    onAttach: () => controller.abort(), expectFailure: true });
  assert.ok(f.error); assert.equal(f.reads.length, 1);
  assert.ok(f.processReaps >= 1); assert.equal(f.nativeReaps, 1);
});

test('real observer waits release promptly on cancellation after wall-clock rollback', async () => {
  const { runP10bIndependentObserver } = await import('../server/services/p10bIndependentObserver.js');
  const x = recoveryFixture(); const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now); const rows = []; const controller = new AbortController();
  const machine = { ...x.baseline, config: phase.config, image_ref: { digest: image } };
  let rollback = false, reaps = 0, nativeReaps = 0, calls = 0, timer;
  const began = performance.now();
  try {
    const success = await runP10bIndependentObserver({ session: x.s, approval: x.approval, phase, machine,
      recovery: { ...recovered, verification }, inspectRecovery: x.inspect, record: row => rows.push(row),
      clock: () => now - (rollback ? 60000 : 0), signal: controller.signal,
      attached() { rollback = true; timer = setTimeout(() => controller.abort(), 20); },
      processes: { async command() { assert.fail('No observer CLI calls'); }, async reap() { reaps++; return true; } },
      async openLogs() { return { async client() { calls++; return []; }, async reap() { return true; } }; },
      async openNative() { return { async client() { return structuredClone(machine); },
        async reap() { nativeReaps++; return true; } }; } });
    assert.equal(success, false);
    assert.ok(performance.now() - began < 600, 'Cancellation left real wait timers pending');
    assert.equal(calls, 1); assert.ok(reaps >= 1); assert.equal(nativeReaps, 1);
    assert.equal(rows.some(r => r.kind === 'observer-finished' && r.normalCompletion), false);
  } finally { clearTimeout(timer); }
});

for (const code of ['request-failed', 'http-failed', 'invalid-output']) test(`metadata failure after28 samples remains failed with ${code} diagnostics`, async () => {
  const { P10bNativeRequestError } = await import('../server/services/p10bNativeFailure.js');
  const f = await observerPollFixture(undefined, false, { latency: 100, metadataFailureAt: 29,
    metadataFailure: new P10bNativeRequestError({ code, method: 'GET', timeoutMs: 700 }) });
  assert.equal(f.success, false); assert.equal(f.rows.filter(r => r.kind === 'metadata').length, 28);
  assert.equal(f.rows.find(r => r.kind === 'observer-read-error').nativeFailure.code, code);
  assert.equal(f.rows.at(-1).normalCompletion, false); assert.equal(f.metadataCalls, 29);
});

test('sanitized October17 timing replay stays failed and stops at the first native log fault', async () => {
  const timing = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bOct17PublicTimings.json', import.meta.url)));
  const { P10bOperatorCommandError } = await import('../server/services/p10bOperatorProcesses.js');
  assert.equal(timing.metadataElapsedMs.length, 28); assert.equal(timing.logTimeoutPolls.length, 38);
  assert.equal(timing.metadataFailureCategory, null);
  const f = await observerPollFixture(async ({ index, wait }) => {
    await wait(timing.logElapsedMs[index - 1]);
    if (timing.logTimeoutPolls.includes(index)) throw new P10bOperatorCommandError('timed-out', 700, null,
      !timing.logUnreapedPolls.includes(index));
    return [];
  }, false, { startOffsetMs: timing.observerStartOffsetMs,
    latency: i => timing.metadataElapsedMs[i] || 0, metadataFailureAt: 29,
    metadataFailure: Error('Unclassified historical metadata fault') });
  assert.equal(f.success, false);
  assert.equal(f.reads.length, timing.logTimeoutPolls[0]);
  assert.equal(f.rows.find(r => r.kind === 'observer-read-error').nativeFailure, null);
  assert.equal(f.rows.at(-1).normalCompletion, false);
});

test('attachment rechecks actual freshness after ready publication with inclusive1000ms boundary', async () => {
  const valid = await observerPollFixture(undefined, false, { readyPublicationMs: 1000 });
  assert.ok(valid.attached); assert.equal(valid.success, true);
  const invalid = await observerPollFixture(undefined, false, { readyPublicationMs: 1001, expectFailure: true });
  assert.equal(invalid.attached, undefined); assert.ok(invalid.error);
  assert.equal(invalid.nativeReaps, 1); assert.equal(invalid.processReaps, 1);
});

test('actual in-flight request preserves valid949ms initial metadata plus100ms initial log attachment', async () => {
  const f = await observerPollFixture(async ({ index, wait }) => { if (index === 1) await wait(100); return []; }, false, { latency: 949 });
  assert.equal(f.attachedAt, now + 1049); assert.equal(f.success, true);
  const first = f.rows.find(r => r.kind === 'metadata');
  assert.equal(first.requestedAt, new Date(now).toISOString()); assert.equal(first.at, new Date(now + 949).toISOString());
});

test('invalid initial metadata and a known later sampling failure during initial logs never attach', async () => {
  for (const latency of [() => 951, index => index === 0 ? 100 : 1000]) {
    const f = await observerPollFixture(async ({ wait }) => { await wait(1500); return []; }, false, { latency, expectFailure: true });
    assert.ok(f.error); assert.equal(f.attached, undefined);
    assert.ok(f.rows.some(r => r.kind === 'observer-sampling-error'));
    assert.equal(f.nativeReaps, 1); assert.equal(f.processReaps, 1);
  }
});

test('independent observer accepts successful empty log polls and preserves continuous metadata cadence through the final read', async () => {
  const { success, attached, metadataCalls, logOpens, nativeReaps, logReaps, processReaps, rows, reads, phase } = await observerPollFixture();
  assert.equal(success, true); assert.equal(logOpens, 1); assert.equal(attached.separateSession, true); assert.ok(metadataCalls >= 400);
  assert.equal(nativeReaps, 1); assert.equal(logReaps, 1); assert.equal(processReaps, 1); assert.equal(JSON.stringify(rows).includes('private-canary'), false);
  assert.equal(reads[0], now); assert.equal(reads.at(-1), Date.parse(phase.window.stopAt));
  assert.ok(reads.length <= 410);
  assert.equal(rows.at(-1).kind, 'observer-finished'); assert.equal(rows.at(-1).normalCompletion, true);
});

test('slow successful final log poll cannot admit normal observer completion', async () => {
  const f = await observerPollFixture(async ({ phase, at, advance }) => {
    if (at === Date.parse(phase.window.stopAt)) advance(751);
    return [];
  });
  assert.equal(f.success, false); assert.equal(f.rows.at(-1).normalCompletion, false);
  assert.ok(f.rows.some(row => row.kind === 'observer-log-read-error'));
  assert.equal(f.rows.find(row => row.kind === 'observer-log-read-error').stage, 'completion');
});

test('later failed, malformed, incomplete and missed log polls latch failure through observer completion', async t => {
  for (const failure of ['read', 'malformed', 'incomplete', 'late']) await t.test(failure, async () => {
    const f = await observerPollFixture(async ({ index }) => {
      if (index !== 2) return [];
      if (failure === 'read') throw Error('private-canary');
      return failure === 'malformed' ? {} : failure === 'incomplete' ? [null] : [];
    }, failure === 'late');
    assert.equal(f.success, false); assert.equal(f.attached.separateSession, true);
    assert.equal(f.rows.at(-1).normalCompletion, false);
    assert.ok(f.nativeReaps > 0 && f.processReaps > 0);
    assert.ok(f.rows.some(row => row.kind === (failure === 'late' ? 'observer-log-missed-poll' : 'observer-log-read-error')));
    if (failure !== 'late') {
      const failed = f.rows.find(row => row.kind === 'observer-log-read-error');
      assert.equal(failed.stage, failure === 'read' ? 'native-read' : 'validation');
      assert.equal(failed.nativeFailure, null);
    }
    assert.equal(JSON.stringify(f.rows).includes('private-canary'), false);
  });
});

test('overlapping log polls deduplicate exact guardian records but preserve distinct provider nanoseconds', async () => {
  const { P10B_GUARDIAN_EXIT_PREFIX } = await import('../server/services/p10bGuardianParent.js');
  const f = await observerPollFixture(async ({ phase, index }) => {
    if (index < 2) return [];
    const value = { version: 'p10b-guardian-child-exit-v1', windowDigest: digest(phase.window), productionReady: false,
      bindingVerified: true, code: 0, signal: null, spawnFailed: false, guardianPid: 5001, parentPid: 5000,
      exitedAt: '2026-10-12T12:04:00.000Z', parentStartedAt: '2026-10-12T12:00:00.000Z',
      readyDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), startDigest: 'c'.repeat(64) };
    const row = { instance: phase.window.machineId, region: 'ewr', timestamp: '2026-10-12T12:04:00.334578044Z',
      message: P10B_GUARDIAN_EXIT_PREFIX + JSON.stringify(value) };
    return [row, row, { ...row, timestamp: '2026-10-12T12:04:00.334578045Z' }];
  });
  const logs = f.rows.filter(row => row.kind === 'platform-log');
  assert.equal(f.success, true); assert.equal(logs.length, 2);
  assert.equal(logs[0].timestamp, logs[1].timestamp); // The proof layer still sees ambiguity.
  assert.equal(JSON.stringify(f.rows).includes('private-canary'), false);
});

test('failed initial log read cannot admit the first start and the operator retains its failure stage', async () => {
  const { runP10bIndependentObserver } = await import('../server/services/p10bIndependentObserver.js');
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  const f = operatorFixture(); let clock = now; let starts = 0; let attachments = 0; let nativeReaps = 0; let logReaps = 0;
  f.options.clock = () => clock;
  const original = f.options.createBoundaries;
  f.options.createBoundaries = async () => {
    const boundaries = await original();
    boundaries.demonstrate = async () => { starts++; throw Error('cold logs must not authorize a start'); };
    boundaries.startObserver = async ({ phase, machine }) => {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      // Empty successful reads are valid; a failed query must never attach.
      const logs = { child, exited: new Promise(() => {}) };
      return runP10bIndependentObserver({ ...f.options, phase, machine, record: () => {},
        attached: () => { attachments++; }, interval: () => 1, clear: () => {},
        async wait() {},
        processes: { launch: () => logs, async command() { assert.fail('No observer CLI calls'); }, async reap() { return true; } },
        async openLogs() { return { async client() { throw Error('synthetic log read failed'); }, async reap() { logReaps++; return true; } }; },
        async openNative() { return { client: async () => structuredClone(machine),
          async reap() { nativeReaps++; return true; } }; } });
    };
    return boundaries;
  };
  await assert.rejects(operator.runP10bNoEmailOperator(f.options), /runtime proof failed/);
  assert.equal(starts, 0); assert.equal(attachments, 0);
  assert.ok(nativeReaps > 0 && logReaps > 0);
  assert.equal(f.evidence.files.has('p10b-runtime-only-demo-start-intent.json'), false);
  assert.equal(f.evidence.read('p10b-runtime-only-session-closure.json').success, false);
  assert.equal(f.evidence.read('p10b-runtime-only-session-closure.json').restored, true);
  assert.equal(f.evidence.read('p10b-runtime-only-session-closure.json').failureStage, 'demo-observer-attachment');
});

test('retained current-phase failure reservation permits settlement and baseline rollback but never new-phase admission', async () => {
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/fresh/private-evidence';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'prepare', now); let activeRecord; let posts = 0;
  let nativeCloses = 0; let nativeOpens = 0;
  const inspect = () => ({ ...x.inspect(), activeAbsent: !activeRecord, ...(activeRecord ? { activeRecord } : {}) });
  const b = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: inspect, clock: () => now,
    processes: { command: async () => JSON.stringify([x.baseline]), terminate: async () => true, reap: async () => true },
    openNative: async () => { nativeOpens++; return { client: async (method = 'GET') => { if (method === 'POST') posts++;
      return { ...x.baseline, config: phase.config, image_ref: { digest: image } }; }, close: async () => { nativeCloses++; return true; } }; } });
  await b.authorizePhase(phase);
  activeRecord = { version: 'p10b-machine-owner-v1', packetDigest: digest(phase.packet),
    evidencePath: `${evidence.root}/p10b-runtime-only-preparation`, reservedAt: phase.window.issuedAt };
  await assert.rejects(b.client()); // No new runtime admission with an active reservation.
  assert.equal(await b.settle(phase), true);
  assert.equal(await b.reap(), true); assert.equal(nativeCloses, 1);
  assert.equal((await b.client()).state, 'stopped');
  assert.equal(nativeOpens, 2);
  await b.client('POST', { config: x.s.baselineConfig, current_version: 'old-version', skip_launch: true });
  assert.equal(posts, 1);
  await assert.rejects(b.client('POST', { config: phase.config }));
  assert.equal(posts, 1); assert.equal(activeRecord.packetDigest, digest(phase.packet));
  activeRecord.packetDigest = '0'.repeat(64); await assert.rejects(b.client());
  assert.equal(await b.close(), true);
});

async function guardianSettlementBudgetFixture(t, { anomaly = 'constant', stoppedOn = Infinity, failReads = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const x = recoveryFixture({ guardian: true }); const evidence = memoryEvidence(); evidence.root = '/fresh/private-evidence';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now);
  let clock = now + 10000, reads = 0, closes = 0;
  const b = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, clock: () => clock,
    processes: { command: async () => JSON.stringify([x.baseline]), terminate: async () => true, reap: async () => true },
    openNative: async () => ({ client: async (method = 'GET') => {
      assert.equal(method, 'GET', 'Settlement may not mutate'); reads++; if (anomaly === 'backward') clock--;
      if (reads > 441) throw Error('Settlement dispatched442');
      if (failReads) throw Error('Synthetic failed read');
      return { ...x.baseline, state: reads >= stoppedOn ? 'stopped' : 'started' };
    }, close: async () => { closes++; return true; } }) });
  async function settle() {
    let done = false, result, error;
    const pending = b.settle(phase);
    pending.then(value => { result = value; done = true; }, failure => { error = failure; done = true; });
    for (let step = 0; !done && step < 445; step++) {
      await new Promise(setImmediate); if (!done) t.mock.timers.tick(750);
    }
    // The old uncapped loop must terminate so RED is a count assertion, not a hang.
    if (!done) { clock = Date.parse(phase.window.stopAt) + 30000; t.mock.timers.tick(750); }
    await pending.catch(() => {});
    if (error) throw error; return result;
  }
  return { b, phase, evidence, settle, counts: () => ({ reads, closes }) };
}

test('guardian settlement accepts stopped read441 at the inclusive attempt limit', async t => {
  const f = await guardianSettlementBudgetFixture(t, { stoppedOn: 441 });
  try {
    assert.equal(await f.settle(), true); assert.equal(f.counts().reads, 441);
    const receipt = f.evidence.read('p10b-runtime-only-demo-settlement.json');
    assert.equal(receipt.settlementReadAttempts, 441); assert.equal(receipt.settlementReadLimit, 441);
    assert.equal(receipt.settlementReadBudgetExhausted, false);
  }
  finally { assert.equal(await f.b.close(), true); }
});

test('guardian settlement exhausted budget survives errors, clock anomalies and repeat calls', async t => {
  for (const variant of ['constant', 'backward', 'failed-reads']) await t.test(variant, async t => {
    const f = await guardianSettlementBudgetFixture(t, { anomaly: variant, failReads: variant === 'failed-reads' });
    try {
      assert.equal(await f.settle(), false);
      assert.equal(f.counts().reads, 441);
      const receipt = f.evidence.read('p10b-runtime-only-demo-settlement.json');
      assert.equal(receipt.stoppedVerified, false); assert.equal(receipt.hostStopCalls, 0);
      assert.equal(receipt.settlementReadAttempts, 441); assert.equal(receipt.settlementReadLimit, 441);
      assert.equal(receipt.settlementReadBudgetExhausted, true);
      // Exclusive evidence may reject replay, but it must not renew the quota.
      await f.settle().catch(() => {}); assert.equal(f.counts().reads, 441);
    } finally { assert.equal(await f.b.close(), true); }
    assert.equal(f.counts().closes, 1);
  });
});

test('mock registry evidence binds the exact immutable image and counts before any native boundary is created', async () => {
  const { assertP10bImagePrerequisite, runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const x = recoveryFixture();
  const imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: x.s.sourceHead, imageDigest: image,
    immutableImage: `registry.fly.io/uckele-group-p10b@${image}`, buildCount: 1, pushCount: 1,
    registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: new Date(now).toISOString() };
  assert.equal(assertP10bImagePrerequisite(x.s, imageEvidence, now), undefined);
  for (const changed of [{ sourceHead: '2'.repeat(40) }, { imageDigest: x.s.baselineImageDigest }, { pushCount: 2 },
    { buildCount: 2 }, { registryManifestVerified: false }, { verifiedAt: new Date(now - 1800001).toISOString() }]) {
    let nativeCalls = 0;
    await assert.rejects(runP10bNoEmailSessionCli(['--run', '--bundle', '/mock-bundle', '--evidence', '/not-used', '--native-client', '/not-used'],
      { clock: () => now, read: () => ({ session: x.s, approval: x.approval, imageEvidence: { ...imageEvidence, ...changed } }),
        openNative: () => { nativeCalls++; throw Error(); }, checkSource: () => {} }));
    assert.equal(nativeCalls, 0);
  }
});

test('six-minute authentication coverage and traversal-shaped recovery digests cannot admit a session', () => {
  const s = session(); s.authenticationEvidence.expiresAt = new Date(now + 360000).toISOString();
  assert.throws(() => operator.validateP10bNoEmailSession(s, now));
  const x = recoveryFixture(); x.s.recovery.packetDigest = '../private-canary';
  assert.throws(() => recovery.recoverP10bAdmissionReservation({ session: x.s, approval: { ...x.approval, sessionDigest: digest(x.s) },
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 }));
  assert.equal(x.operations.length, 0);
});

test('host CLI completes both offline phases with separately bound guest source and cleans private auth after restoration', async () => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const { createP10bAppTokenContext } = await import('../server/services/p10bHostAuthentication.js');
  const root = '/synthetic/private-evidence';
  const f = operatorFixture({ directory: path.join(os.homedir(), '.uckele-group-p10b-host'), evidenceRoot: root });
  f.evidence.root = root;
  f.evidence.write('p10b-recovery-independent-verification.json', f.options.recovery.verification);
  const s = f.options.session; let context; let received;
  const imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: s.sourceHead, imageDigest: image,
    immutableImage: `registry.fly.io/uckele-group-p10b@${image}`, buildCount: 1, pushCount: 1,
    registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: s.startedAt };
  const result = await runP10bNoEmailSessionCli(['--run', '--bundle', '/synthetic/bundle', '--evidence', root, '--native-client', '/synthetic/helper'], {
    read(file) { if (file === '/synthetic/bundle') return { session: s, approval: f.options.approval, imageEvidence };
      return file === s.recovery.intentPath ? f.options.recovery.intent : f.options.recovery.terminal; },
    clock: f.options.clock, checkSource: head => { assert.equal(head, s.hostSourceHead); },
    createEvidence: () => f.evidence, inspectRecovery: f.options.inspectRecovery,
    createAuth(input) { context = createP10bAppTokenContext({ ...input, environment: { FLY_API_TOKEN: 'synthetic-private-credential' } }); return context; },
    processes: { reap: async () => true },
    createBoundaries(input) { received = input; return f.options.createBoundaries(); },
    openNative() { throw Error('stubbed operator needs no native process'); } });
  assert.equal(result.success, true); assert.equal(result.restored, true); assert.equal(f.updates(), 3);
  assert.deepEqual(f.order, ['demo', 'prepare']); assert.equal(received.environment.FLY_API_TOKEN, undefined);
  assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), false);
  assert.equal(JSON.stringify([...f.evidence.files]).includes('synthetic-private-credential'), false);
});

test('host CLI holds private cleanup when native initialization cannot prove reap', async () => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const root = '/synthetic/private-evidence';
  const f = operatorFixture({ directory: path.join(os.homedir(), '.uckele-group-p10b-host'), evidenceRoot: root });
  f.evidence.root = root; const s = f.options.session; let cleanupReaped;
  const imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: s.sourceHead, imageDigest: image,
    immutableImage: `registry.fly.io/uckele-group-p10b@${image}`, buildCount: 1, pushCount: 1,
    registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: s.startedAt };
  await assert.rejects(runP10bNoEmailSessionCli(['--execute', '--bundle', '/synthetic/bundle', '--evidence', root, '--native-client', '/synthetic/helper'], {
    read: () => ({ session: s, approval: f.options.approval, imageEvidence }), clock: f.options.clock,
    checkSource: () => {}, createEvidence: () => f.evidence, processes: { reap: async () => true },
    createAuth: () => ({ environment: {}, cleanup({ reaped }) { cleanupReaped = reaped; if (!reaped) throw Error('cleanup held'); } }),
    openNative: async () => { throw Object.assign(Error('synthetic native failure'), { reapVerified: false }); } }));
  assert.equal(cleanupReaped, false);
  assert.equal(f.evidence.read('p10b-runtime-only-auth-closure.json').failureStage, 'recovery-native-initialization');
});

test('guardian recovery read failures retain only typed request diagnostics through CLI cleanup', async t => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const { P10bNativeRequestError } = await import('../server/services/p10bNativeFailure.js');
  const { P10B_GUARDIAN_NATIVE_SHA256 } = await import('../server/services/p10bOperatorSource.js');
  for (const code of ['http-failed', 'timed-out', 'bridge-protocol', 'bridge-timeout', 'invalid-output', null]) {
    await t.test(code || 'untyped-private-error', async () => {
      const root = '/synthetic/guardian-recovery-evidence';
      const f = operatorFixture({ guardian: true, directory: path.join(os.homedir(), '.uckele-group-p10b-host'), evidenceRoot: root });
      f.evidence.root = root; const s = f.options.session; s.nativeClientSha256 = P10B_GUARDIAN_NATIVE_SHA256;
      f.options.approval.sessionDigest = digest(s);
      const imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: s.sourceHead, imageDigest: image,
        immutableImage: `registry.fly.io/uckele-group-p10b@${image}`, buildCount: 1, pushCount: 1,
        registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: s.startedAt };
      const failure = code ? new P10bNativeRequestError({ code, method: 'GET', timeoutMs: 1000 }) : Error('synthetic-private-canary');
      Object.defineProperty(failure, 'message', { get() { throw Error('must not inspect private message'); } });
      Object.defineProperty(failure, 'stack', { get() { throw Error('must not inspect private stack'); } });
      if (!code) Object.defineProperty(failure, 'publicFailure', { get() { throw Error('must not inspect untyped fields'); } });
      let requests = 0; let reaps = 0; let cleanupReaped;
      await assert.rejects(runP10bNoEmailSessionCli(['--execute', '--bundle', '/synthetic/bundle', '--evidence', root,
        '--native-client', '/synthetic/native'], {
        read: () => ({ session: s, approval: f.options.approval, imageEvidence }), clock: f.options.clock,
        checkSource: () => {}, createEvidence: () => f.evidence,
        createAuth: () => ({ environment: {}, cleanup({ reaped }) { cleanupReaped = reaped; return true; } }),
        processes: { reap: async () => true, command() { throw Error('must not advance after read failure'); } },
        openNative: async input => { assert.equal(input.readOnly, true); return {
          async client() { requests++; throw failure; }, async reap() { reaps++; return true; } }; },
        createBoundaries() { throw Error('must not reach mutation or start'); },
      }));
      const closure = f.evidence.read('p10b-runtime-only-auth-closure.json');
      assert.deepEqual(closure.failure, code ? { version: 'p10b-native-request-failure-v1', code, method: 'GET', timeoutMs: 1000 } : null);
      assert.equal(closure.failureStage, 'recovery-baseline-read'); assert.equal(closure.success, false);
      assert.equal(closure.reapVerified, true); assert.equal(closure.cleanupVerified, true);
      assert.equal(cleanupReaped, true); assert.equal(requests, 1); assert.equal(reaps, 1);
      assert.equal(JSON.stringify([...f.evidence.files]).includes('canary'), false);
      assert.equal(f.evidence.has('p10b-runtime-only-operator-intent.json'), false);
    });
  }
});

test('host CLI unresolved private descendant intent blocks restoration and retains both closure holds', async t => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const { createP10bAppTokenContext } = await import('../server/services/p10bHostAuthentication.js');
  const root = '/synthetic/private-evidence';
  const f = operatorFixture({ directory: path.join(os.homedir(), '.uckele-group-p10b-host'), evidenceRoot: root });
  f.evidence.root = root; const s = f.options.session; let context;
  f.evidence.write('p10b-recovery-independent-verification.json', f.options.recovery.verification);
  const imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: s.sourceHead, imageDigest: image,
    immutableImage: `registry.fly.io/uckele-group-p10b@${image}`, buildCount: 1, pushCount: 1,
    registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: s.startedAt };
  t.after(() => { if (context) fs.rmSync(context.environment.FLY_CONFIG_DIR, { recursive: true, force: true }); });
  await assert.rejects(runP10bNoEmailSessionCli(['--run', '--bundle', '/synthetic/bundle', '--evidence', root, '--native-client', '/synthetic/helper'], {
    read(file) { if (file === '/synthetic/bundle') return { session: s, approval: f.options.approval, imageEvidence };
      return file === s.recovery.intentPath ? f.options.recovery.intent : f.options.recovery.terminal; },
    clock: f.options.clock, checkSource: () => {}, createEvidence: () => f.evidence, inspectRecovery: f.options.inspectRecovery,
    createAuth(input) { context = createP10bAppTokenContext({ ...input, environment: { FLY_API_TOKEN: 'synthetic-private-credential' } }); return context; },
    processes: { reap: async () => true },
    async createBoundaries() {
      const b = await f.options.createBoundaries(); const preparation = b.runPreparation;
      b.runPreparation = async input => {
        const result = await preparation(input);
        fs.writeFileSync(path.join(context.environment.FLY_CONFIG_DIR, '.p10b-reap-synthetic.pending'), 'synthetic pending reap', { mode: 0o600 });
        return result;
      };
      return b;
    } }));
  assert.equal(f.updates(), 2); assert.equal(f.evidence.read('p10b-runtime-only-session-closure.json').restored, false);
  assert.equal(f.evidence.read('p10b-runtime-only-auth-closure.json').cleanupVerified, false);
  assert.equal(f.evidence.read('p10b-runtime-only-auth-closure.json').success, false);
  assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), true);
  assert.equal(JSON.stringify([...f.evidence.files]).includes('synthetic-private-credential'), false);
});


function guardianSession() {
  return Object.assign(session(), { version: 'p10b-guardian-only-session-v1', operation: 'guardian-only', qualificationAllowed: false,
    recoveryPolicy: 'acknowledged-only-stopped-runtime-v1', maximumStarts: 1, maximumStoppedConfigUpdates: 2,
    maximumLocalBuilds: 0, maximumImagePushes: 0, baselineInstanceId: 'old-version', baselineObservedAt: new Date(now).toISOString() });
}
test('guardian session and approval enforce one inert phase, zero builds and no qualification promotion', () => {
  const s = guardianSession(); assert.equal(operator.validateP10bNoEmailSession(s, now), true);
  const phase = operator.createP10bRuntimePhase(s, 'demo', now);
  assert.equal(phase.config.processes.every(p => p.ignore_app_secrets === true), true);
  assert.deepEqual(phase.config.processes[0].exec, ['node', '-e', 'setInterval(() => {}, 2147483647)']);
  assert.throws(() => operator.createP10bRuntimePhase(s, 'prepare', now), /phase outside/);
  for (const mutate of [s => { s.maximumStarts = 2; }, s => { s.maximumStoppedConfigUpdates = 3; },
    s => { s.maximumLocalBuilds = 1; }, s => { s.maximumImagePushes = 1; }, s => { s.operation = 'prepare'; },
    s => { s.qualificationAllowed = true; }, s => { s.recoveryPolicy = 'retry'; }]) {
    const changed = structuredClone(s); mutate(changed); assert.throws(() => operator.validateP10bNoEmailSession(changed, now));
  }
  const approval = { ...recoveryFixture({ guardian: true }).approval };
  operator.assertP10bNoEmailApproval(s, { ...approval, sessionDigest: digest(s) }, now);
  assert.throws(() => operator.assertP10bNoEmailApproval(s, { ...approval, version: 'p10b-no-email-approval-v1' }, now));
});

test('guardian operator completes only one demonstration, restores exact baseline and reports no preparation authority', async () => {
  const f = operatorFixture({ guardian: true });
  const result = await operator.runP10bNoEmailOperator(f.options);
  assert.equal(result.success, true); assert.equal(result.operation, 'guardian-only');
  assert.equal(result.maximumStarts, 1); assert.equal(result.qualificationAllowed, false);
  assert.equal(result.mutationSettled, true); assert.equal(result.providerCalls, 0); assert.equal(result.emails, 0);
  assert.deepEqual(f.order, ['demo']); assert.equal(f.updates(), 2);
  assert.equal(f.evidence.has('p10b-runtime-only-prepare-packet.json'), false);
  assert.equal(f.evidence.has('p10b-runtime-only-preparation-accepted.json'), false);
  assert.equal(f.evidence.read('p10b-runtime-only-session-closure.json').mutationUncertain, false);
  assert.deepEqual(f.machine().config, f.x.s.baselineConfig);
  await assert.rejects(operator.runP10bNoEmailOperator(f.options)); assert.equal(f.updates(), 2);
});

test('guardian unacknowledged update closes failed without restoration, start or preparation', async () => {
  const f = operatorFixture({ guardian: true }); const factory = f.options.createBoundaries;
  f.options.createBoundaries = async () => {
    const b = await factory(); const api = b.client;
    b.client = async (method = 'GET', body) => { const value = await api(method, body); if (method === 'POST') throw Error('timeout'); return value; };
    return b;
  };
  await assert.rejects(operator.runP10bNoEmailOperator(f.options)); assert.deepEqual(f.order, []); assert.equal(f.updates(), 1);
  const closure = f.evidence.read('p10b-runtime-only-session-closure.json');
  assert.equal(closure.success, false); assert.equal(closure.restored, false); assert.equal(closure.mutationUncertain, true);
  assert.equal(f.evidence.has('p10b-runtime-only-demo-start-intent.json'), false);
});

test('guardian host CLI keeps only its exact native lease through restoration and fully cleans private auth', async () => {
  const { spawn } = await import('node:child_process'); const { once } = await import('node:events');
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const { createP10bAppTokenContext, reserveP10bLocalReap } = await import('../server/services/p10bHostAuthentication.js');
  const { P10B_GUARDIAN_NATIVE_SHA256 } = await import('../server/services/p10bOperatorSource.js');
  const root = '/synthetic/guardian-evidence';
  const f = operatorFixture({ guardian: true, directory: path.join(os.homedir(), '.uckele-group-p10b-host'), evidenceRoot: root });
  // Derive fresh recovery proof after binding the reviewed native revision.
  const s = f.options.session; s.nativeClientSha256 = P10B_GUARDIAN_NATIVE_SHA256;
  f.options.approval.sessionDigest = digest(s);
  f.options.recovery.intent.sessionDigest = digest(s);
  f.options.recovery.terminal.sessionDigest = digest(s); f.options.recovery.terminal.intentDigest = digest(f.options.recovery.intent);
  f.options.recovery.verification.sessionDigest = digest(s); f.options.recovery.verification.terminalDigest = digest(f.options.recovery.terminal);
  f.evidence.root = root; f.evidence.write('p10b-recovery-independent-verification.json', f.options.recovery.verification);
  const imageEvidence = { version: 'p10b-image-prerequisite-v1', sourceHead: s.sourceHead, imageDigest: image,
    immutableImage: `registry.fly.io/uckele-group-p10b@${image}`, buildCount: 1, pushCount: 1,
    registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: s.startedAt };
  let context; let child; let exited; let reservation;
  try {
    const result = await runP10bNoEmailSessionCli(['--run', '--bundle', '/synthetic/guardian-bundle', '--evidence', root, '--native-client', '/synthetic/native'], {
      read(file) { if (file === '/synthetic/guardian-bundle') return { session: s, approval: f.options.approval, imageEvidence };
        return file === s.recovery.intentPath ? f.options.recovery.intent : f.options.recovery.terminal; },
      clock: f.options.clock, checkSource: h => assert.equal(h, s.hostSourceHead), createEvidence: () => f.evidence, inspectRecovery: f.options.inspectRecovery,
      createAuth(input) { context = createP10bAppTokenContext({ ...input, environment: { FLY_API_TOKEN: 'synthetic-credential-canary' } }); return context; },
      processes: { reap: async () => true },
      async createBoundaries() {
        const b = await f.options.createBoundaries();
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }); exited = once(child, 'close');
        reservation = reserveP10bLocalReap(context.environment); const lease = reservation.transportLease(child, digest(s));
        b.reapForRestoration = async () => true; b.restorationLease = () => lease;
        b.close = async () => { child.kill('SIGKILL'); await exited; reservation.retire(true); return true; }; return b;
      }, openNative() { throw Error('External native boundary stubbed for this CLI test'); } });
    assert.equal(result.success, true); assert.equal(result.operation, 'guardian-only'); assert.equal(f.updates(), 2);
    assert.deepEqual(f.order, ['demo']); assert.equal(f.evidence.read('p10b-runtime-only-auth-closure.json').cleanupVerified, true);
    assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), false);
  } finally {
    if (child) { child.kill('SIGKILL'); await exited; reservation.retire(true); }
    if (context && fs.existsSync(context.environment.FLY_CONFIG_DIR)) context.cleanup({ reaped: true });
  }
});

for (const mode of ['primary-exit', 'readiness-timeout']) test(`concrete parent retains ${mode} before readiness without inventing controller-loss proof`, async t => {
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/synthetic/failure-evidence';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const child = new EventEmitter(); let terminations = 0;
  const boundaries = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, clock: () => now,
    openNative: async () => { assert.fail('No native client needed for readiness race'); },
    processes: { launch: () => ({ child, exited: mode === 'primary-exit' ? Promise.resolve({ code: 1, signal: null }) : new Promise(() => {}) }),
      async terminate() { terminations++; return true; } } });
  if (mode === 'readiness-timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now);
  evidence.write('p10b-runtime-only-demo-start-intent.json', { at: new Date(now).toISOString(), window: phase.window });
  const pending = boundaries.demonstrate({ phase, machine: x.baseline, observer: {} });
  if (mode === 'readiness-timeout') t.mock.timers.tick(15000);
  await assert.rejects(pending, /Demo primary exited before readiness|Demo readiness timeout/);
  const failure = evidence.read('p10b-runtime-only-demo-controller-failure.json');
  assert.equal(failure.reason, mode); assert.equal(failure.stage, 'await-primary-readiness');
  assert.equal(failure.primaryExitCode, mode === 'primary-exit' ? 1 : null);
  assert.equal(evidence.files.has('p10b-runtime-only-demo-readiness.json'), false);
  assert.equal(terminations, 0); // Settlement retains ownership; no premature controller-loss claim.
});

for (const mode of ['start-failure', 'ssh-failure', 'invalid-json', 'ipc-async-failure',
  'readiness-publication', 'observer-exit', 'observer-evidence-missing', 'termination-uncertain', 'wrong-primary-exit', 'primary-already-reaped']) {
  test(`composed primary and concrete parent distinguish ${mode} without losing verified termination`, async () => {
    const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
    const { spawnSync } = await import('node:child_process');
    const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/synthetic/composed-demo-evidence';
    const originalWrite = evidence.write;
    evidence.write = (name, value) => {
      if (mode === 'readiness-publication' && name === 'p10b-runtime-only-demo-readiness.json') throw Error('synthetic private write canary');
      originalWrite(name, value);
    };
    const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
      baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
    const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
    const phase = operator.createP10bRuntimePhase(x.s, 'demo', now);
    evidence.write('p10b-runtime-only-demo-start-intent.json', { at: new Date(now).toISOString(), window: phase.window });
    const machine = { ...x.baseline, config: phase.config };
    const child = Object.assign(new EventEmitter(), { pid: 5012, exitCode: null, signalCode: null }); let resolveExit, terminations = 0;
    const primary = { child, reaped: false, exited: new Promise(resolve => { resolveExit = resolve; }) };
    let sourceResult;
    const boundaries = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
      recovery: { ...recovered, verification }, inspectRecovery: x.inspect, clock: () => now,
      openNative: async () => assert.fail('All external native/Fly boundaries are synthetic'),
      processes: { launch(_file, args, options) {
        assert.equal(path.basename(args[0]), 'run-p10b-demo-primary.js'); assert.ok(options.stdio.includes('ipc'));
        const cliMode = ['start-failure', 'ssh-failure', 'invalid-json', 'ipc-async-failure'].includes(mode) ? mode : 'success';
        const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings',
          new URL('./helpers/p10bDemoPrimaryVm.js', import.meta.url).pathname, cliMode,
          JSON.stringify({ session: x.s, phase, machine, now, intent: evidence.read('p10b-runtime-only-demo-start-intent.json') })],
        { encoding: 'utf8', timeout: 5000, env: { HOME: '/tmp', PATH: '/usr/bin:/bin' } });
        assert.equal(result.status, 0, result.stderr); sourceResult = JSON.parse(result.stdout);
        for (const [name, value] of Object.entries(sourceResult.records)) evidence.write(name, value);
        queueMicrotask(() => {
          if (sourceResult.exitCode) resolveExit({ code: sourceResult.exitCode, signal: null });
          else {
            child.emit('message', sourceResult.messages[0]);
            if (mode === 'primary-already-reaped') { primary.reaped = true; resolveExit({ code: null, signal: 'SIGKILL' }); }
          }
        });
        return primary;
      }, async terminate(entry) {
        assert.equal(entry, primary); terminations++;
        primary.reaped = true;
        resolveExit(mode === 'wrong-primary-exit' ? { code: 0, signal: null } : { code: null, signal: 'SIGKILL' });
        return mode !== 'termination-uncertain';
      } } });
    const observer = { phase, output: '/synthetic/absent-observer-output.jsonl',
      entry: { child: { pid: process.pid }, exited: Promise.resolve({ code: mode === 'observer-evidence-missing' ? 0 : 1, signal: null }) } };
    await assert.rejects(boundaries.demonstrate({ phase, machine, observer }));
    const termination = evidence.files.get('p10b-runtime-only-demo-primary-termination.json');
    const failure = evidence.files.get('p10b-runtime-only-demo-controller-failure.json');
    assert.ok(failure, 'The actual parent failure stage was discarded');
    if (mode.startsWith('observer-')) {
      assert.ok(termination, 'Verified primary termination was discarded with observer failure');
      assert.equal(termination.primaryTerminationVerified, true); assert.equal(termination.primaryPid, 5012);
      assert.equal(termination.sessionDigest, digest(x.s)); assert.equal(termination.windowDigest, digest(phase.window));
      assert.equal(termination.readinessDigest, digest(sourceResult.messages[0]));
      assert.equal(termination.signal, 'SIGKILL'); assert.equal(termination.code, null);
      assert.equal(failure.stage, 'observer-completion'); assert.equal(terminations, 1);
      assert.equal(evidence.has('p10b-runtime-only-demo-readiness.json'), true);
    } else {
      assert.equal(termination, undefined);
      assert.equal(terminations, ['termination-uncertain', 'wrong-primary-exit'].includes(mode) ? 1 : 0);
      assert.equal(failure.stage, mode === 'readiness-publication' ? 'publish-readiness'
        : ['termination-uncertain', 'wrong-primary-exit', 'primary-already-reaped'].includes(mode) ? 'terminate-primary' : 'await-primary-readiness');
    }
    assert.equal(evidence.has('p10b-runtime-only-demo-proof.json'), false);
    assert.equal(JSON.stringify([...evidence.files]).includes('canary'), false);
  });
}

test('actual owned local IPC primary is OS-reaped and its termination receipt survives observer failure', async t => {
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const { createP10bOperatorProcesses } = await import('../server/services/p10bOperatorProcesses.js');
  const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/synthetic/owned-ipc-evidence';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const local = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
  t.after(async () => { assert.equal(await local.reap(), true); });
  const readiness = { sourceHead: x.s.sourceHead, freshPathsVerified: true };
  let entry;
  const boundaries = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, clock: () => now,
    openNative: async () => assert.fail('No native/Fly/provider client in owned IPC test'),
    processes: { ...local, launch(_file, args, options) {
      assert.equal(path.basename(args[0]), 'run-p10b-demo-primary.js');
      // Replace only the external primary boundary with a task-owned Node
      // process; production owner/group/IPC/termination wiring remains real.
      entry = local.launch(process.execPath, ['-e',
        'process.send(JSON.parse(process.argv[1])); setInterval(() => {}, 1000)', JSON.stringify(readiness)], options);
      return entry;
    } } });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now);
  evidence.write('p10b-runtime-only-demo-start-intent.json', { at: new Date(now).toISOString(), window: phase.window });
  await assert.rejects(boundaries.demonstrate({ phase, machine: x.baseline, observer: { phase,
    entry: { child: { pid: process.pid }, exited: Promise.resolve({ code: 1, signal: null }) } } }), /Observer completion failed/);
  const receipt = evidence.read('p10b-runtime-only-demo-primary-termination.json');
  assert.equal(receipt.primaryPid, entry.child.pid); assert.equal(receipt.primaryTerminationVerified, true);
  assert.equal(entry.reaped, true); assert.deepEqual(await entry.exited, { code: null, signal: 'SIGKILL' });
  assert.throws(() => process.kill(-entry.child.pid, 0), { code: 'ESRCH' });
  assert.equal(evidence.read('p10b-runtime-only-demo-controller-failure.json').stage, 'observer-completion');
  assert.equal(evidence.has('p10b-runtime-only-demo-proof.json'), false);
});

for (const mode of ['signal', 'code']) test(`actual owned primary ${mode} exit before close cannot claim deliberate termination`, async t => {
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const { createP10bOperatorProcesses } = await import('../server/services/p10bOperatorProcesses.js');
  const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/synthetic/exited-before-close';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const local = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
  t.after(async () => { assert.equal(await local.reap(), true); });
  let entry; let terminations = 0;
  const boundaries = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, clock: () => now,
    openNative: async () => assert.fail('No external boundary in pre-close regression'),
    processes: { ...local, launch(_file, _args, options) {
      // A same-group descendant retains stderr, separating real OS exit from
      // close/reap. Deliver synthetic readiness at that exact boundary.
      entry = local.launch(process.execPath, ['-e',
        `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          { stdio: ['ignore', 'ignore', 2] });
        setTimeout(() => ${mode === 'signal' ? "process.kill(process.pid, 'SIGKILL')" : 'process.exit(0)'}, 100);`], options);
      entry.child.once('exit', () => {
        assert.equal(entry.reaped, false);
        assert.equal(entry.child.exitCode, mode === 'code' ? 0 : null);
        assert.equal(entry.child.signalCode, mode === 'signal' ? 'SIGKILL' : null);
        entry.child.emit('message', { sourceHead: x.s.sourceHead, freshPathsVerified: true });
      });
      return entry;
    }, async terminate(primary) { terminations++; return local.terminate(primary); } } });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now);
  evidence.write('p10b-runtime-only-demo-start-intent.json', { at: new Date(now).toISOString(), window: phase.window });
  await assert.rejects(boundaries.demonstrate({ phase, machine: x.baseline, observer: { phase,
    entry: { child: { pid: process.pid }, exited: Promise.resolve({ code: 1, signal: null }) } } }), /Live owned primary unavailable/);
  assert.equal(terminations, 0);
  assert.equal(evidence.has('p10b-runtime-only-demo-primary-termination.json'), false);
  const failure = evidence.read('p10b-runtime-only-demo-controller-failure.json');
  assert.equal(failure.stage, 'terminate-primary'); assert.equal(failure.primaryTerminationVerified, false);
  assert.equal(failure.primaryExitCode, mode === 'code' ? 0 : null);
  assert.equal(failure.primaryExitSignal, mode === 'signal' ? 'SIGKILL' : null);
});

async function readinessParent({ time, launch, write } = {}) {
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/synthetic/absolute-readiness';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now);
  const child = Object.assign(new EventEmitter(), { pid: 5012, exitCode: null, signalCode: null });
  let resolveExit, launches = 0, terminations = 0;
  const primary = { child, exited: new Promise(resolve => { resolveExit = resolve; }) };
  const boundaries = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, clock: () => time?.value ?? now,
    monotonicClock: () => time?.elapsed ?? 0,
    openNative: async () => assert.fail('No native client in readiness deadline tests'),
    processes: { launch() { launches++; launch?.(child); return primary; },
      async terminate() { terminations++; resolveExit({ code: null, signal: 'SIGKILL' }); return true; } } });
  evidence.write('p10b-runtime-only-demo-start-intent.json', { at: new Date(now).toISOString(), window: phase.window });
  if (write) { const original = evidence.write; evidence.write = (name, value) => { original(name, value); write(name); }; }
  return { boundaries, evidence, child, phase, x, counts: () => ({ launches, terminations }),
    demonstrate: () => boundaries.demonstrate({ phase, machine: x.baseline, observer: { phase,
      entry: { child: { pid: process.pid }, exited: Promise.resolve({ code: 1, signal: null }) } } }) };
}

for (const delay of [14999, 15000, 15001]) test(`concrete parent admits readiness only before exact deadline: ${delay}ms`, async () => {
  const time = { value: now }; const f = await readinessParent({ time });
  const pending = f.demonstrate(); time.value = now + delay;
  // Message delivered before an overdue timer callback must still fail closed.
  f.child.emit('message', { sourceHead: f.x.s.sourceHead, freshPathsVerified: true });
  await assert.rejects(pending, delay < 15000 ? /Observer completion failed/ : /Demo readiness timeout/);
  assert.equal(f.evidence.has('p10b-runtime-only-demo-readiness.json'), delay < 15000);
  assert.equal(f.evidence.has('p10b-runtime-only-demo-primary-termination.json'), delay < 15000);
  assert.deepEqual(f.counts(), { launches: 1, terminations: delay < 15000 ? 1 : 0 });
});

test('parent publication crossing deadline cannot claim deliberate primary termination', async () => {
  const time = { value: now }; const f = await readinessParent({ time,
    write: name => { if (name === 'p10b-runtime-only-demo-readiness.json') time.value = now + 15000; } });
  const pending = f.demonstrate(); f.child.emit('message', { sourceHead: f.x.s.sourceHead, freshPathsVerified: true });
  await assert.rejects(pending, /Demo readiness timeout/);
  assert.equal(f.evidence.has('p10b-runtime-only-demo-primary-termination.json'), false);
  assert.deepEqual(f.counts(), { launches: 1, terminations: 0 });
});

test('parent timer uses intent remainder before launch and cannot renew after wall-clock rollback', async t => {
  const time = { value: now }; const f = await readinessParent({ time,
    launch: () => { t.mock.timers.tick(5000); time.value = now - 1000; } });
  time.value = now + 4000; t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.demonstrate(); const rejected = assert.rejects(pending, /Demo readiness timeout/);
  t.mock.timers.tick(5999); await Promise.resolve();
  assert.equal(f.evidence.has('p10b-runtime-only-demo-controller-failure.json'), false);
  t.mock.timers.tick(1); await rejected;
  assert.deepEqual(f.counts(), { launches: 1, terminations: 0 });
});

test('stalled launch and wall-clock rollback cannot admit queued readiness ahead of overdue timer', async () => {
  const time = { value: now, elapsed: 0 }; const f = await readinessParent({ time,
    launch: child => { time.elapsed = 15000; time.value = now - 1000;
      queueMicrotask(() => child.emit('message', { sourceHead: f.x.s.sourceHead, freshPathsVerified: true })); } });
  await assert.rejects(f.demonstrate(), /Demo readiness timeout/);
  assert.equal(f.evidence.has('p10b-runtime-only-demo-readiness.json'), false);
  assert.deepEqual(f.counts(), { launches: 1, terminations: 0 });
});

for (const kind of ['missing', 'extra', 'future', 'stale', 'window-mismatch']) test(`parent rejects ${kind} intent before launching`, async () => {
  const f = await readinessParent(); const name = 'p10b-runtime-only-demo-start-intent.json'; const intent = f.evidence.read(name);
  if (kind === 'missing') f.evidence.files.delete(name);
  if (kind === 'extra') intent.extra = true;
  if (kind === 'future') intent.at = new Date(now + 1).toISOString();
  if (kind === 'stale') intent.at = new Date(now - 15000).toISOString();
  if (kind === 'window-mismatch') intent.window = { ...intent.window, stopAt: new Date(now + 299999).toISOString() };
  if (kind !== 'missing') f.evidence.files.set(name, intent);
  await assert.rejects(f.demonstrate()); assert.deepEqual(f.counts(), { launches: 0, terminations: 0 });
});

test('parent input publication exhausting readiness budget cannot launch primary', async () => {
  const time = { value: now }; const f = await readinessParent({ time,
    write: name => { if (name === 'p10b-runtime-only-demo-primary-input.json') time.value = now + 15000; } });
  await assert.rejects(f.demonstrate(), /Demo readiness timeout/);
  assert.deepEqual(f.counts(), { launches: 0, terminations: 0 });
});
