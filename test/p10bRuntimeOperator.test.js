import assert from 'node:assert/strict';
import test from 'node:test';
import { config as workerConfig } from './helpers/p10bQualificationFixture.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from '../server/services/p10bProviderIdentity.js';
const operator = await import('../server/services/p10bRuntimeOnlyOperator.js').catch(() => ({}));
const recovery = await import('../server/services/p10bAdmissionRecovery.js').catch(() => ({}));
const diagnostics = await import('../server/services/p10bWorkerDiagnostics.js').catch(() => ({}));
const digest = value => sha256(stableCanonicalJson(value));
const now = Date.parse('2026-10-12T12:00:00.000Z');
const image = `sha256:${'a'.repeat(64)}`;
function session() {
  const config = { image: `registry.fly.io/uckele-group@sha256:${'b'.repeat(64)}`, env: {},
    restart: { policy: 'no' }, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
    mounts: [{ volume: 'vol_vwnkpex1k3yx9dnv', path: '/data' }],
    services: [{ autostart: false, autostop: false, internal_port: 8787 }] };
  return { version: 'p10b-no-email-session-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
    sourceHead: '1'.repeat(40), nonce: 'c'.repeat(24), candidateImageDigest: image,
    baselineImageDigest: `sha256:${'b'.repeat(64)}`, baselineConfig: config,
    ownerPermissionDigest: 'd'.repeat(64), permissionEvidenceId: 'owner:offline-stub',
    nativeClientSha256: '9'.repeat(64),
    startedAt: new Date(now).toISOString(), sessionDeadline: new Date(now + 3600000).toISOString(),
    maximumStarts: 2, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 3,
    maximumIncrementalUsd: 1, maximumLocalBuilds: 1, maximumImagePushes: 1,
    productionReady: false, globalAutomationPaused: true,
    authenticationEvidence: { version: 'p10b-normal-authentication-coverage-v1', ownerAttested: true,
      expiresAt: new Date(now + 3600000).toISOString() },
    configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2',
      providerIdentity: P10B_PROVIDER_IDENTITY, providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY),
      flySecretMetadataDigest: 'e'.repeat(64), verifiedAt: new Date(now).toISOString() },
    budget: { priceEvidenceDigest: 'f'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 } };
}
function memoryEvidence() {
  const files = new Map(); return { files, has: name => files.has(name), read: name => structuredClone(files.get(name)),
    write(name, value) { assert.equal(files.has(name), false); files.set(name, structuredClone(value)); } };
}
function requireExport(module, name) { assert.equal(typeof module[name], 'function', `${name} is implemented`); return module[name]; }

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
    ownerPermissionDigest: s.ownerPermissionDigest, sourceHead: s.sourceHead, expiresAt: s.sessionDeadline,
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
  const row = { instance: session().machineId, region: 'ewr', timestamp: '2026-10-12T12:04:00.334578044Z',
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

function recoveryFixture() {
  const s = session(); const f = new Map(); const operations = [];
  const record = { version: 'p10b-machine-owner-v1', packetDigest: '4'.repeat(64), evidencePath: '/preserved/failed', reservedAt: '2026-10-10T07:12:20.821Z' };
  const bytes = JSON.stringify(record); const directory = '/mock-admission';
  s.recovery = { directory, activePath: `${directory}/0803730bd1d7e8.active.json`, archivePath: `${directory}/0803730bd1d7e8.active.json.archived-uncertain-${s.nonce}.json`,
    attemptPath: `${directory}/${record.packetDigest}.attempt.json`, intentPath: '/fresh/recovery/intent.json', terminalPath: '/fresh/recovery/terminal.json',
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
  const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(s), ownerPermissionDigest: s.ownerPermissionDigest,
    sourceHead: s.sourceHead, expiresAt: s.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
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

function operatorFixture() {
  const x = recoveryFixture(); const evidence = memoryEvidence(); let clock = now; let updates = 0; const order = [];
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval, baseline: x.baseline,
    independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => clock, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  let machine = structuredClone(x.baseline);
  const result = { version: 'p10b-host-result-v1', operation: 'prepare', success: true, failureStage: null,
    stoppedVerified: true, processReaped: true, stopUncertain: false, startUncertain: false, productionReady: false, lifecycleVerified: false,
    preparation: { providerCalls: 0, productionReady: false, ingressClosed: true, sqliteClosed: true,
      guestShutdown: { handoffVerified: true, cleanupUncertain: false, failure: false, authorityClosed: true, ingressClosed: true, workerSqliteClosed: true } } };
  const options = { session: x.s, approval: x.approval, recovery: { ...recovered, verification }, inspectRecovery: x.inspect,
    evidence, clock: () => clock, createBoundaries: async () => ({
      client: async (method = 'GET', body) => { if (method === 'POST') { updates++; machine = { ...machine, config: body.config,
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

test('independent observer wiring preserves continuous cadence and reaps both mock boundaries', async () => {
  const { runP10bIndependentObserver } = await import('../server/services/p10bIndependentObserver.js');
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  const x = recoveryFixture(); const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'demo', now); let clock = now; let scheduled; let nativeReaps = 0; let processReaps = 0;
  const rows = []; let metadataCalls = 0; let attached;
  const logs = { child: new EventEmitter(), exited: new Promise(() => {}) };
  Object.assign(logs.child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const processes = { launch() { queueMicrotask(() => logs.child.stdout.write('{"message":"private-canary"}\n')); return logs; },
    async reap() { processReaps++; return true; }, async terminate() { return true; } };
  const machine = { ...x.baseline, config: phase.config, image_ref: { digest: image } };
  const success = await runP10bIndependentObserver({ session: x.s, approval: x.approval, phase, machine,
    recovery: { ...recovered, verification }, inspectRecovery: x.inspect, record: row => rows.push(row), attached: value => { attached = value; },
    processes, clock: () => clock, interval(tick) { scheduled = tick; return 1; }, clear: () => {},
    async wait(ms) { const end = clock + ms; while (clock + 750 <= end) { clock += 750; await scheduled(); } clock = end; },
    async openNative(input) { assert.equal(input.readOnly, true); return { async client() { metadataCalls++; return structuredClone(machine); },
      async reap() { nativeReaps++; return true; } }; } });
  assert.equal(success, true); assert.equal(attached.separateSession, true); assert.ok(metadataCalls > 400);
  assert.ok(nativeReaps >= 1 && processReaps >= 1); assert.equal(JSON.stringify(rows).includes('private-canary'), false);
  assert.equal(rows.at(-1).kind, 'observer-finished'); assert.equal(rows.at(-1).normalCompletion, true);
});

test('retained current-phase failure reservation permits settlement and baseline rollback but never new-phase admission', async () => {
  const { createP10bNoEmailBoundaries } = await import('../server/services/p10bNoEmailBoundaries.js');
  const x = recoveryFixture(); const evidence = memoryEvidence(); evidence.root = '/fresh/private-evidence';
  const recovered = recovery.recoverP10bAdmissionReservation({ session: x.s, approval: x.approval,
    baseline: x.baseline, independentBaseline: x.independentBaseline, filesystem: x.filesystem, clock: () => now, operatorPid: 5010 });
  const verification = recovery.verifyP10bAdmissionArchive({ session: x.s, recovery: recovered, inspect: x.inspect, verifierPid: 5011, now });
  const phase = operator.createP10bRuntimePhase(x.s, 'prepare', now); let activeRecord; let posts = 0;
  const inspect = () => ({ ...x.inspect(), activeAbsent: !activeRecord, ...(activeRecord ? { activeRecord } : {}) });
  const b = await createP10bNoEmailBoundaries({ session: x.s, approval: x.approval, evidence,
    recovery: { ...recovered, verification }, inspectRecovery: inspect, clock: () => now,
    processes: { command: async () => JSON.stringify([x.baseline]), terminate: async () => true, reap: async () => true },
    openNative: async () => ({ client: async (method = 'GET') => { if (method === 'POST') posts++;
      return { ...x.baseline, config: phase.config, image_ref: { digest: image } }; }, close: async () => true }) });
  await b.authorizePhase(phase);
  activeRecord = { version: 'p10b-machine-owner-v1', packetDigest: digest(phase.packet),
    evidencePath: `${evidence.root}/p10b-runtime-only-preparation`, reservedAt: phase.window.issuedAt };
  await assert.rejects(b.client()); // No new runtime admission with an active reservation.
  assert.equal(await b.settle(phase), true);
  assert.equal((await b.client()).state, 'stopped');
  await b.client('POST', { config: x.s.baselineConfig, current_version: 'old-version', skip_launch: true });
  assert.equal(posts, 1);
  await assert.rejects(b.client('POST', { config: phase.config }));
  assert.equal(posts, 1); assert.equal(activeRecord.packetDigest, digest(phase.packet));
  activeRecord.packetDigest = '0'.repeat(64); await assert.rejects(b.client());
  assert.equal(await b.close(), true);
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
