import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from '../server/services/p10bProviderIdentity.js';
import { validateP10bNoEmailSession, runP10bNoEmailOperator } from '../server/services/p10bRuntimeOnlyOperator.js';
import { createP10bRuntimePhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { createP10bOperatorProcesses } from '../server/services/p10bOperatorProcesses.js';
const auth = await import('../server/services/p10bHostAuthentication.js').catch(() => ({}));
const source = await import('../server/services/p10bOperatorSource.js');
const now = Date.parse('2026-10-13T22:00:00.000Z');
const digest = value => sha256(stableCanonicalJson(value));
const canary = 'synthetic-private-app-credential-canary';
function fixture() {
  const baselineConfig = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bObservedBaselineShape.json', import.meta.url)));
  const session = { version: 'p10b-no-email-session-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
    volumeId: 'vol_vwnkpex1k3yx9dnv', sourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', hostSourceHead: '2'.repeat(40),
    candidateImageDigest: 'sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc',
    nativeClientSha256: 'de28af1f823644d0eb4f4cd025b74791b2e041a660cd061cafc67c7175c0b088',
    flyExecutable: { path: process.execPath, sha256: sha256(fs.readFileSync(process.execPath)) },
    namesClientPath: '/offline/names-client', namesClientSha256: 'a'.repeat(64),
    baselineImageDigest: baselineConfig.image.split('@')[1], baselineConfig, nonce: 'c'.repeat(24),
    ownerPermissionDigest: 'd'.repeat(64), permissionEvidenceId: 'owner:offline-stub',
    startedAt: new Date(now).toISOString(), sessionDeadline: new Date(now + 3600000).toISOString(),
    maximumStarts: 2, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 3,
    maximumIncrementalUsd: 1, maximumLocalBuilds: 1, maximumImagePushes: 1,
    productionReady: false, globalAutomationPaused: true,
    authenticationEvidence: { version: 'p10b-app-token-issuance-v1', ownerAttested: true, issuanceSucceeded: true,
      app: 'uckele-group-p10b', scope: 'app-deploy', tokenId: 'offline-token-id', revokedAt: null,
      tokenName: `p10b-runtime-no-email-${'c'.repeat(24)}`, issuanceEvidenceId: 'owner:offline-issuance',
      issuanceStartedAt: new Date(now - 60000).toISOString(), issuanceCompletedAt: new Date(now - 59000).toISOString(),
      requestedLifetimeMs: 7200000, expiresAt: new Date(now + 7140000).toISOString() },
    configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2', providerIdentity: P10B_PROVIDER_IDENTITY,
      providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY), flySecretMetadataDigest: 'e'.repeat(64),
      verifiedAt: new Date(now).toISOString() },
    budget: { priceEvidenceDigest: 'f'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 } };
  const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(session),
    sourceHead: session.sourceHead, hostSourceHead: session.hostSourceHead, ownerPermissionDigest: session.ownerPermissionDigest,
    expiresAt: session.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  return { session, approval, clock: () => now };
}
function exported(module, name) { assert.equal(typeof module[name], 'function', `${name} is implemented`); return module[name]; }

async function assertPrivateSdkLockIsolation(t, executable, args) {
  const { spawn, execFileSync } = await import('node:child_process');
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-offline-sdk-checkout-'));
  const git = (...command) => execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Offline', '-c', 'user.email=offline@example.test', '-C', checkout, ...command],
  { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: checkout, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'Offline fixture');
  assert.equal(git('status', '--porcelain'), '');
  const f = fixture(); const offset = Date.now() - now - 1000;
  for (const key of ['startedAt', 'sessionDeadline']) f.session[key] = new Date(Date.parse(f.session[key]) + offset).toISOString();
  for (const key of ['issuanceStartedAt', 'issuanceCompletedAt', 'expiresAt']) {
    f.session.authenticationEvidence[key] = new Date(Date.parse(f.session.authenticationEvidence[key]) + offset).toISOString();
  }
  f.session.configurationEvidence.verifiedAt = f.session.startedAt;
  f.session.nativeClientSha256 = sha256(fs.readFileSync(executable));
  f.approval.sessionDigest = digest(f.session); f.approval.expiresAt = f.session.sessionDeadline; f.clock = Date.now;
  const context = auth.createP10bAppTokenContext({ ...f, environment: { HOME: checkout, FLY_API_TOKEN: canary } });
  t.after(() => { context.cleanup({ reaped: true }); fs.rmSync(checkout, { recursive: true, force: true }); });
  const client = await openP10bNativeMachineClient({ ...f, executable, args, readOnly: true,
    configs: [f.session.baselineConfig], environment: context.environment,
    // The pre-fix native inherits this synthetic checkout; never the real repository.
    spawnProcess(file, argv, options) { return spawn(file, argv, { ...options, cwd: options.cwd ?? checkout }); } });
  // Initialization constructs the SDK only. No Machine request is sent.
  assert.equal(await client.reap(), true);
  assert.deepEqual({ checkoutStatus: git('status', '--porcelain'),
    lockInPrivateContext: fs.existsSync(path.join(context.environment.FLY_CONFIG_DIR, 'flyctl.config.lock')) },
  { checkoutStatus: '', lockInPrivateContext: true });
  context.cleanup({ reaped: true });
  assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), false);
}

test('relative SDK lock stays inside private authentication instead of dirtying the checkout', async t => {
  await assertPrivateSdkLockIsolation(t, process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import readline from 'node:readline';
    for await (const line of readline.createInterface({ input: process.stdin })) {
      JSON.parse(line); fs.closeSync(fs.openSync('flyctl.config.lock', 'a', 0o600));
      process.stdout.write(JSON.stringify({ version: 'p10b-native-ready-v1', ready: true }) + '\\n');
    }`]);
});

test('real native SDK lock stays inside private authentication with zero Machine requests',
  { skip: !process.env.P10B_OFFLINE_NATIVE_CLIENT }, async t => {
    await assertPrivateSdkLockIsolation(t, process.env.P10B_OFFLINE_NATIVE_CLIENT, ['--serve']);
  });

test('explicit two-hour app issuance admits a separate host revision without changing guest identity or limits', () => {
  const { session } = fixture();
  assert.equal(validateP10bNoEmailSession(session, now), true);
  assert.notEqual(session.hostSourceHead, session.sourceHead);
  assert.equal(Date.parse(session.sessionDeadline) - Date.parse(session.startedAt), 3600000);
});

test('unknown/insufficient expiry, wrong scope and unsuccessful issuance deny before runtime boundaries or evidence', async () => {
  for (const mutate of [s => { s.authenticationEvidence.expiresAt = null; }, s => { s.authenticationEvidence.expiresAt = 'unknown'; },
    s => { s.authenticationEvidence.issuanceStartedAt = new Date(now - 7100000).toISOString(); s.authenticationEvidence.issuanceCompletedAt = new Date(now - 7099000).toISOString(); s.authenticationEvidence.expiresAt = new Date(now + 100000).toISOString(); },
    s => { s.authenticationEvidence.scope = 'org-deploy'; }, s => { s.authenticationEvidence.app = 'uckele-group'; },
    s => { s.authenticationEvidence.issuanceSucceeded = false; }, s => { s.authenticationEvidence.ownerAttested = false; },
    s => { s.authenticationEvidence.tokenName = 'unrelated'; }, s => { s.authenticationEvidence.tokenId = ''; },
    s => { s.authenticationEvidence.revokedAt = s.startedAt; }, s => { delete s.authenticationEvidence.revokedAt; },
    s => { s.authenticationEvidence.expiresAt = new Date(now + 14400000).toISOString(); },
    s => { s.authenticationEvidence.issuanceStartedAt = new Date(now + 1).toISOString(); },
    s => { s.authenticationEvidence.credential = canary; }, s => { delete s.hostSourceHead; },
    s => { s.authenticationEvidence = { version: 'p10b-normal-authentication-coverage-v1', ownerAttested: true, expiresAt: s.sessionDeadline }; }]) {
    const f = fixture(); mutate(f.session); let calls = 0; let writes = 0;
    await assert.rejects(runP10bNoEmailOperator({ ...f, evidence: { write() { writes++; } },
      createBoundaries() { calls++; throw Error('must not authenticate'); } }));
    assert.equal(calls, 0); assert.equal(writes, 0);
  }
});

test('host binding rejects stale host checkout and changed retained guest/image/native identities', () => {
  const bind = exported(source, 'assertP10bNoEmailHostBinding'); const { session } = fixture(); let checked;
  bind(session, head => { checked = head; }); assert.equal(checked, session.hostSourceHead);
  assert.throws(() => bind(session, () => { throw Error('stale host checkout'); }));
  for (const key of ['sourceHead', 'candidateImageDigest', 'nativeClientSha256', 'hostSourceHead']) {
    const s = structuredClone(session); s[key] = key === 'hostSourceHead' ? s.sourceHead : '0'.repeat(s[key].length);
    assert.throws(() => bind(s, () => { throw Error('must reject identity first'); }));
  }
});

test('session-bound Fly identity rejects changed files and alternate paths before runtime auth or evidence', async t => {
  const { runP10bNoEmailSessionCli } = await import('../server/services/p10bNoEmailSessionCli.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-offline-fly-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fly'); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const f = fixture(); f.session.flyExecutable = { path: file, sha256: sha256(fs.readFileSync(file)) };
  f.approval.sessionDigest = digest(f.session);
  assert.equal(source.assertP10bFlyExecutable(f.session), file);
  assert.throws(() => source.assertP10bFlyExecutable(f.session, process.execPath));
  for (const mutate of [s => { delete s.flyExecutable; }, s => { s.flyExecutable.path = 'fly'; },
    s => { s.flyExecutable.sha256 = 'unknown'; }, s => { s.flyExecutable.extra = true; }]) {
    const session = structuredClone(f.session); mutate(session);
    assert.throws(() => validateP10bNoEmailSession(session, now));
  }
  fs.appendFileSync(file, '# changed\n');
  let authCalls = 0; let evidenceCalls = 0;
  await assert.rejects(runP10bNoEmailSessionCli(['--execute', '--bundle', '/offline/bundle', '--evidence', '/offline/evidence', '--native-client', '/offline/native'],
    { read: () => ({ session: f.session, approval: f.approval, status: 'OWNER_APPROVED_NO_EMAIL_SESSION',
      imageEvidence: { version: 'p10b-image-prerequisite-v1', sourceHead: f.session.sourceHead,
        imageDigest: f.session.candidateImageDigest, immutableImage: `registry.fly.io/uckele-group-p10b@${f.session.candidateImageDigest}`,
        buildCount: 1, pushCount: 1, registryManifestVerified: true, manifestEvidenceDigest: 'a'.repeat(64), verifiedAt: f.session.startedAt } }),
    clock: f.clock, checkSource: () => {}, createAuth() { authCalls++; }, createEvidence() { evidenceCalls++; } }), /Fly executable changed/);
  assert.equal(authCalls, 0); assert.equal(evidenceCalls, 0);
});

test('preparation host exception binds the exact no-email phase; qualification and stale packets cannot borrow it', () => {
  const bind = exported(source, 'assertP10bPreparationHostSource'); const f = fixture();
  const phase = createP10bRuntimePhase(f.session, 'prepare', now);
  bind({ ...f, phase, packet: phase.packet, now, checkSource: h => assert.equal(h, f.session.hostSourceHead) });
  for (const mutate of [p => { p.operation = 'qualify'; }, p => { p.sourceHead = '0'.repeat(40); },
    p => { p.databasePath += '.other'; }, p => { p.guest.stopAt = new Date(now + 600000).toISOString(); }]) {
    const packet = structuredClone(phase.packet); mutate(packet);
    assert.throws(() => bind({ ...f, phase, packet, now, checkSource: () => {} }));
  }
  assert.throws(() => bind({ ...f, approval: {}, phase, packet: phase.packet, now, checkSource: () => {} }));
});

test('private context transmits only opaque local auth, never serializes it or persists owner configuration', async t => {
  const create = exported(auth, 'createP10bAppTokenContext'); const inherited = exported(auth, 'p10bInheritedAppTokenEnvironment');
  const f = fixture(); const original = { PATH: process.env.PATH, HOME: '/synthetic-owner-home', FLY_API_TOKEN: canary,
    FLY_CONFIG_DIR: '/must-not-use-owner-config', NODE_OPTIONS: '--inspect', AWS_SECRET_ACCESS_KEY: canary };
  const context = create({ ...f, environment: original }); t.after(() => context.cleanup({ reaped: true }));
  const env = context.environment; const directory = env.FLY_CONFIG_DIR;
  assert.equal(env.HOME, original.HOME); assert.notEqual(directory, original.FLY_CONFIG_DIR);
  assert.equal(env.FLY_AGENT_ISOLATED, '1');
  assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700); assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(env.FLY_API_TOKEN, canary); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(JSON.stringify(context).includes(canary), false); assert.deepEqual(original.FLY_CONFIG_DIR, '/must-not-use-owner-config');
  assert.deepEqual(inherited({ ...f, environment: env }), env);
  const processes = createP10bOperatorProcesses({ environment: env });
  const result = await processes.command(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify({privateInput:process.env.FLY_API_TOKEN?.startsWith("synthetic-"),config:!!process.env.FLY_CONFIG_DIR,unexpected:!!process.env.NODE_OPTIONS}))']);
  assert.deepEqual(JSON.parse(result), { privateInput: true, config: true, unexpected: false });
  assert.equal(result.includes(canary), false); assert.equal(await processes.reap(), true);
  fs.writeFileSync(path.join(directory, 'synthetic-sdk-cache'), canary, { mode: 0o600 });
  context.cleanup({ reaped: true }); assert.equal(fs.existsSync(directory), false); assert.equal(env.FLY_API_TOKEN, undefined);
});

test('SDK-style agent descendants stay in owned command groups until positive closure', async t => {
  const { spawn } = await import('node:child_process');
  const f = fixture(); const context = auth.createP10bAppTokenContext({ ...f, environment: { FLY_API_TOKEN: canary } });
  const pidFile = path.join(context.environment.FLY_CONFIG_DIR, 'synthetic-agent.pid'); let group;
  const processes = createP10bOperatorProcesses({ environment: context.environment,
    spawnProcess(file, args, options) {
      assert.equal(options.detached, true);
      assert.equal(options.env.FLY_AGENT_ISOLATED, '1');
      const child = spawn(file, args, options); group = child.pid; return child;
    } });
  t.after(async () => { await processes.reap(); context.cleanup({ reaped: true }); });
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const agent=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {stdio:'ignore',detached:process.env.FLY_AGENT_ISOLATED!=='1'}); agent.unref();
    fs.writeFileSync(${JSON.stringify(pidFile)},String(agent.pid)); process.stdout.write('public');`;
  assert.equal(await processes.command(process.execPath, ['-e', code], 3000), 'public');
  assert.ok(Number(fs.readFileSync(pidFile)) > 1);
  assert.throws(() => process.kill(-group, 0), error => error.code === 'ESRCH');
  assert.equal(await processes.reap(), true);
  assert.equal(context.assertReaped(), true);
});

test('denial does not read private input; uncertain reap preserves isolated directory and fails closed', () => {
  const create = exported(auth, 'createP10bAppTokenContext'); const f = fixture();
  let reads = 0; const environment = { get FLY_API_TOKEN() { reads++; return canary; } };
  assert.throws(() => create({ ...f, approval: {}, environment })); assert.equal(reads, 0);
  assert.throws(() => create({ ...f, environment: {} }));
  const context = create({ ...f, environment: { FLY_API_TOKEN: canary } }); const directory = context.environment.FLY_CONFIG_DIR;
  try { assert.throws(() => context.cleanup({ reaped: false }), /reap/i); assert.equal(fs.existsSync(directory), true); }
  finally { context.cleanup({ reaped: true }); }
});

test('failed directory removal cannot be reported as verified private cleanup', () => {
  const create = exported(auth, 'createP10bAppTokenContext'); const f = fixture();
  const context = create({ ...f, environment: { FLY_API_TOKEN: canary } });
  const directory = context.environment.FLY_CONFIG_DIR; const moved = `${directory}-moved`;
  fs.renameSync(directory, moved);
  try { assert.throws(() => context.cleanup({ reaped: true }), /cleanup/i); assert.equal(context.environment.FLY_API_TOKEN, canary); }
  finally { fs.renameSync(moved, directory); context.cleanup({ reaped: true }); }
});

test('nested native reap uncertainty holds root cleanup even after its immediate controller exits', async () => {
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const f = fixture(); f.session.nativeClientSha256 = sha256(fs.readFileSync(process.execPath)); f.approval.sessionDigest = digest(f.session);
  const context = exported(auth, 'createP10bAppTokenContext')({ ...f, environment: { FLY_API_TOKEN: canary } });
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  try {
    await assert.rejects(openP10bNativeMachineClient({ ...f, executable: process.execPath, readOnly: true,
      configs: [f.session.baselineConfig], environment: context.environment,
      spawnProcess() { queueMicrotask(() => child.stdout.write('{}\n')); return child; } }));
    assert.throws(() => context.cleanup({ reaped: true }), /reap/i);
    assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), true);
  } finally {
    // Synthetic fixture only; no real process or credential was created.
    fs.rmSync(context.environment.FLY_CONFIG_DIR, { recursive: true, force: true });
  }
});

test('pending-reap fsync failure prevents launch and preserves private cleanup hold', async () => {
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const f = fixture(); f.session.nativeClientSha256 = sha256(fs.readFileSync(process.execPath)); f.approval.sessionDigest = digest(f.session);
  const context = exported(auth, 'createP10bAppTokenContext')({ ...f, environment: { FLY_API_TOKEN: canary } });
  const fsync = fs.fsyncSync; let launches = 0;
  try {
    fs.fsyncSync = () => { throw Error('synthetic fsync denial'); };
    await assert.rejects(openP10bNativeMachineClient({ ...f, executable: process.execPath, readOnly: true,
      configs: [f.session.baselineConfig], environment: context.environment,
      spawnProcess() { launches++; throw Error('must not spawn'); } }));
    fs.fsyncSync = fsync;
    assert.equal(launches, 0); assert.throws(() => context.cleanup({ reaped: true }), /reap|cleanup/i);
  } finally { fs.fsyncSync = fsync; fs.rmSync(context.environment.FLY_CONFIG_DIR, { recursive: true, force: true }); }
});

test('private directory marker-reader failure holds cleanup without exposing credentials or raw errors', () => {
  const f = fixture(); const context = exported(auth, 'createP10bAppTokenContext')({ ...f, environment: { FLY_API_TOKEN: canary } });
  const read = fs.readdirSync;
  try {
    fs.readdirSync = () => { throw Error(canary); };
    assert.throws(() => context.cleanup({ reaped: true }), error => !String(error).includes(canary));
    assert.equal(context.environment.FLY_API_TOKEN, canary);
  } finally { fs.readdirSync = read; context.cleanup({ reaped: true }); }
});

test('native initialization failure carries unverified reap instead of hiding the live child', async () => {
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const f = fixture(); f.session.nativeClientSha256 = sha256(fs.readFileSync(process.execPath)); f.approval.sessionDigest = digest(f.session);
  let killed = 0; const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed++; } });
  await assert.rejects(openP10bNativeMachineClient({ ...f, executable: process.execPath, readOnly: true,
    configs: [f.session.baselineConfig], environment: {}, spawnProcess() {
      queueMicrotask(() => child.stdout.write('{}\n')); return child;
    } }), error => error.reapVerified === false);
  assert.ok(killed >= 1);
});

test('inherited auth refuses owner config paths, symlinks, broad permissions and missing opaque input', () => {
  const inherit = exported(auth, 'p10bInheritedAppTokenEnvironment'); const create = exported(auth, 'createP10bAppTokenContext');
  const f = fixture(); const context = create({ ...f, environment: { FLY_API_TOKEN: canary } });
  const env = context.environment; const link = path.join(os.tmpdir(), `p10b-app-auth-link-${process.pid}`);
  try {
    assert.throws(() => inherit({ ...f, environment: { ...env, FLY_API_TOKEN: undefined } }));
    assert.throws(() => inherit({ ...f, environment: { ...env, FLY_CONFIG_DIR: '/owner-config' } }));
    fs.symlinkSync(env.FLY_CONFIG_DIR, link);
    assert.throws(() => inherit({ ...f, environment: { ...env, FLY_CONFIG_DIR: link } }));
    fs.chmodSync(env.FLY_CONFIG_DIR, 0o755); assert.throws(() => inherit({ ...f, environment: env }));
    fs.chmodSync(env.FLY_CONFIG_DIR, 0o700);
  } finally { fs.rmSync(link, { force: true }); context.cleanup({ reaped: true }); }
});

test('bounded child command rejects credential-bearing stdout and never exposes credential-bearing stderr/errors', async () => {
  const processes = createP10bOperatorProcesses({ environment: { FLY_API_TOKEN: canary } });
  for (const code of ['process.stdout.write(process.env.FLY_API_TOKEN)', 'process.stderr.write(process.env.FLY_API_TOKEN);process.exit(1)']) {
    await assert.rejects(processes.command(process.execPath, ['-e', code]), error => !String(error).includes(canary));
  }
  assert.equal(await processes.reap(), true);
});

test('native adapter rejects accidental credential output while its initialization packet stays public', async t => {
  const { openP10bNativeMachineClient } = await import('../server/services/p10bNativeMachineClient.js');
  const { spawn } = await import('node:child_process'); const f = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-auth-output-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'stub-native.mjs');
  fs.writeFileSync(script, `import readline from 'node:readline'; let first=true;
    for await (const line of readline.createInterface({input:process.stdin})) {
      const r=JSON.parse(line);
      if(first){if(line.includes('synthetic-private'))process.exit(2);first=false;process.stdout.write(JSON.stringify({version:'p10b-native-ready-v1',ready:true})+'\\n');}
      else process.stdout.write(JSON.stringify({id:r.id,ok:true,machine:{id:'offline',accidental:process.env.FLY_API_TOKEN}})+'\\n');
    }`);
  f.session.nativeClientSha256 = sha256(fs.readFileSync(process.execPath)); f.approval.sessionDigest = digest(f.session);
  const client = await openP10bNativeMachineClient({ ...f, executable: process.execPath, args: [script], readOnly: true,
    configs: [f.session.baselineConfig], environment: { FLY_API_TOKEN: canary },
    spawnProcess(executable, args, options) { assert.equal(JSON.stringify(args).includes(canary), false); return spawn(executable, args, options); } });
  try { await assert.rejects(client.client('GET', undefined, 100), error => !String(error).includes(canary)); }
  finally { assert.equal(await client.reap(), true); }
});


function guardianFixture() {
  const f = fixture(); Object.assign(f.session, { version: 'p10b-guardian-only-session-v1', operation: 'guardian-only',
    qualificationAllowed: false, recoveryPolicy: 'acknowledged-only-stopped-runtime-v1', maximumStarts: 1,
    maximumStoppedConfigUpdates: 2, maximumLocalBuilds: 0, maximumImagePushes: 0,
    baselineInstanceId: 'baseline-version', baselineObservedAt: new Date(now).toISOString() });
  f.approval.version = 'p10b-guardian-only-approval-v1'; f.approval.sessionDigest = digest(f.session); return f;
}
test('guardian phase reap admits only its exact live direct native lease; final cleanup still requires full reap', async () => {
  const { spawn } = await import('node:child_process'); const { once } = await import('node:events');
  const f = guardianFixture(); const context = auth.createP10bAppTokenContext({ ...f, environment: { FLY_API_TOKEN: canary } });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  const exited = once(child, 'close'); const reservation = auth.reserveP10bLocalReap(context.environment);
  try {
    const lease = reservation.transportLease(child, digest(f.session));
    assert.throws(() => context.assertReaped()); assert.throws(() => context.cleanup({ reaped: true }));
    assert.equal(context.assertPhaseReaped(lease), true);
    assert.throws(() => context.assertPhaseReaped({}), /reap/i);
    const other = auth.reserveP10bLocalReap(context.environment);
    assert.throws(() => context.assertPhaseReaped(lease), /reap/i);
    other.retire(true); assert.equal(context.assertPhaseReaped(lease), true);
    const g = guardianFixture(); g.session.nonce = 'a'.repeat(24);
    g.session.authenticationEvidence.tokenName = `p10b-runtime-no-email-${g.session.nonce}`; g.approval.sessionDigest = digest(g.session);
    const otherContext = auth.createP10bAppTokenContext({ ...g, environment: { FLY_API_TOKEN: canary } });
    try { assert.throws(() => otherContext.assertPhaseReaped(lease)); } finally { otherContext.cleanup({ reaped: true }); }
    child.kill('SIGKILL'); await exited;
    assert.throws(() => context.assertPhaseReaped(lease));
    reservation.retire(true); assert.equal(context.assertReaped(), true); context.cleanup({ reaped: true });
  } finally {
    child.kill('SIGKILL'); await exited; reservation.retire(true); context.cleanup({ reaped: true });
  }
});
