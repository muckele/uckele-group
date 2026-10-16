import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 } from '../server/services/p10bStoppedUpdateContract.js';
import { materializeExistingArchive } from './helpers/p10bExistingArchiveFixture.js';
const preflight = await import('../server/services/p10bOwnerPreflight.js').catch(() => ({}));
const digest = value => sha256(stableCanonicalJson(value));
const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bObservedBaselineShape.json', import.meta.url)));
const manifest = fs.readFileSync(new URL('./fixtures/p10bRetainedCandidateManifest.json', import.meta.url), 'utf8');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-preparer-fixture-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'runtime-evidence'); fs.mkdirSync(evidence, { mode: 0o700 });
  const bind = file => ({ path: file, sha256: sha256(fs.readFileSync(file)) });
  const price = path.join(root, 'price.json');
  fs.writeFileSync(price, JSON.stringify({ observedAt: new Date().toISOString(), source: 'https://docs.fly.io/about/pricing',
    ewrShared1Cpu512MbPer30DaysUsd: 3.69, tenMinuteComputeEstimateUsd: 0.0008541666666666667,
    volumeUsdPerProvisionedGbMonth: 0.15, stoppedRootfsUsdPerGbMonth: 0.15, snapshotsUsdPerStoredGbMonth: 0.08,
    northAmericaEgressUsdPerGb: 0.02, registrySeparateChargeVerified: false, oneUsdIsBillingCap: false, retainedStorageContinues: true }));
  const binary = bind(process.execPath);
  const recipe = { version: 'p10b-owner-preparer-recipe-v1', hostSourceHead: '2'.repeat(40),
    guestSourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', nonce: 'c'.repeat(24),
    app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', volumeId: 'vol_vwnkpex1k3yx9dnv',
    candidateImage: 'registry.fly.io/uckele-group-p10b@sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc',
    ownerHome: root, outputDirectory: root, evidenceDirectory: evidence,
    sealedBundlePath: path.join(root, 'sealed-session.json'), approvedBundlePath: path.join(root, 'approved-session.json'),
    files: { node: binary, python: binary, fly: binary, docker: binary, buildx: binary, names: binary, probe: binary,
      native: { path: process.execPath, sha256: 'de28af1f823644d0eb4f4cd025b74791b2e041a660cd061cafc67c7175c0b088' }, price: bind(price) },
    recovery: { directory: path.join(root, '.uckele-group-p10b-host'), activePath: path.join(root, '.uckele-group-p10b-host/0803730bd1d7e8.active.json'),
      packetDigest: 'a'.repeat(64), expectedSha256: 'b'.repeat(64), reservedAt: '2026-10-10T07:12:20.821Z', evidencePath: '/offline/historical-evidence' } };
  const receipt = { version: 'p10b-app-token-issuance-v1', ownerAttested: true, issuanceSucceeded: true, app: recipe.app, scope: 'app-deploy',
    tokenId: 'offline-id', tokenName: `p10b-runtime-no-email-${recipe.nonce}`, issuanceEvidenceId: 'offline:issuance',
    issuanceStartedAt: new Date(Date.now() - 1000).toISOString(), issuanceCompletedAt: new Date(Date.now() - 900).toISOString(),
    requestedLifetimeMs: 7200000, revokedAt: null, expiresAt: new Date(Date.now() - 1000 + 7200000).toISOString() };
  const permission = { version: 'p10b-owner-private-setup-v1', approved: true, recipeDigest: digest(recipe),
    approvedAt: new Date(Date.now() - 2000).toISOString(), providerCalls: 0, emails: 0, productionReady: false,
    globalAutomationPaused: true, exclusiveAdmissionWriters: true, recoveryApproved: true };
  const machine = { id: recipe.machineId, region: 'ewr', instance_id: 'offline-instance', state: 'stopped',
    image_ref: { digest: baseline.image.split('@')[1] }, config: structuredClone(baseline) };
  const commands = [];
  const runner = { async command(executable, args, _timeout, input) {
    commands.push({ executable, args, input });
    if (args[0] === 'machines') return JSON.stringify([machine]);
    if (args[0] === '--secret-names') return JSON.stringify(['DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY']);
    if (args[0] === '--registry-config') return '';
    if (args.includes('--raw')) return manifest;
    if (args[0].startsWith('-test.run=')) { assert.equal(input, stableCanonicalJson(baseline)); return 'PASS'; }
    throw Error('unexpected command');
  }, async reap() { return true; } };
  const options = { checkSource: head => assert.equal(head, recipe.hostSourceHead),
    checkFile: item => item === recipe.files.native ? item.path : preflight.boundP10bOwnerFile(item),
    createCommands: context => { const original = runner.command;
      runner.command = async (...args) => { const result = await original(...args);
        if (args[1][0] === '--registry-config') fs.writeFileSync(path.join(context.environment.DOCKER_CONFIG, 'config.json'),
          JSON.stringify({ auths: { 'registry.fly.io': { auth: 'offline-placeholder-encoding' } } }), { mode: 0o600 });
        return result; }; return runner; }, environment: { FLY_API_TOKEN: 'offline-opaque-input' } };
  return { root, recipe, receipt, permission, machine, commands, runner, options };
}
function existingArchiveDiagnostic(t) {
  const f = fixture(t); f.recipe.version = 'p10b-owner-stopped-update-recipe-v2';
  f.recipe.ownerIssuanceDirectory = path.join(f.root, 'owner-public-issuance');
  f.recipe.files.diagnosticNative = { path: process.execPath, sha256: P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 };
  f.recipe.recovery = materializeExistingArchive(f.root);
  delete f.recipe.recovery.intentPath; delete f.recipe.recovery.terminalPath;
  const check = f.options.checkFile;
  f.options.checkFile = item => item === f.recipe.files.diagnosticNative ? item.path : check(item);
  f.permission.recipeDigest = digest(f.recipe); return f;
}
test('existing-archive diagnostic static check verifies local provenance before credentials and seals exact old archive path', async t => {
  const f = existingArchiveDiagnostic(t);
  assert.equal(preflight.checkP10bOwnerRecipe(f.recipe, f.options).admissionRecovery, 'existing-archive-read-only');
  const result = await preflight.prepareP10bOwnerBundle({ ...f, ...f.options });
  const bundle = JSON.parse(fs.readFileSync(result.sealedBundlePath));
  assert.deepEqual(bundle.session.recovery.priorArchive, f.recipe.recovery.priorArchive);
  assert.equal(bundle.session.recovery.archivePath, f.recipe.recovery.archivePath);
  assert.equal(bundle.approval.approved, false);
});
test('legacy recipes reject existing-archive admission and local drift holds before private setup', async t => {
  await t.test('legacy', t => {
    const f = existingArchiveDiagnostic(t); f.recipe.version = 'p10b-owner-preparer-recipe-v1';
    assert.throws(() => preflight.checkP10bOwnerRecipe(f.recipe, f.options));
  });
  for (const mode of ['active', 'dangling-symlink', 'receipt-bytes', 'archive-inode']) await t.test(mode, t => {
    const f = existingArchiveDiagnostic(t); const r = f.recipe.recovery;
    if (mode === 'active') fs.writeFileSync(r.activePath, '{}', { mode: 0o600 });
    if (mode === 'dangling-symlink') fs.symlinkSync(path.join(f.root, 'absent'), r.activePath);
    if (mode === 'receipt-bytes') fs.appendFileSync(r.priorArchive.intent.path, ' ');
    if (mode === 'archive-inode') { const bytes = fs.readFileSync(r.archivePath); fs.renameSync(r.archivePath, `${r.archivePath}.preserved`); fs.writeFileSync(r.archivePath, bytes, { mode: 0o600 }); }
    assert.throws(() => preflight.checkP10bOwnerRecipe(f.recipe, f.options));
    assert.equal(f.commands.length, 0); assert.equal(fs.readdirSync(f.recipe.evidenceDirectory).length, 0);
  });
});
test('preparer seals actual bounded public facts with original clock and no manufactured final approval', async t => {
  assert.equal(typeof preflight.prepareP10bOwnerBundle, 'function');
  const f = fixture(t); const result = await preflight.prepareP10bOwnerBundle({ ...f, ...f.options });
  assert.equal(result.status, 'AWAITING_EXACT_OWNER_APPROVAL');
  const bundle = JSON.parse(fs.readFileSync(f.recipe.sealedBundlePath));
  assert.equal(bundle.approval.approved, false); assert.equal(bundle.session.ownerPermissionDigest, digest(f.permission));
  assert.equal(Date.parse(bundle.session.sessionDeadline) - Date.parse(bundle.session.startedAt), 3600000);
  assert.deepEqual(bundle.session.baselineConfig, baseline);
  assert.deepEqual(bundle.session.flyExecutable, f.recipe.files.fly);
  assert.equal(bundle.session.configurationEvidence.flySecretMetadataDigest, digest(['DEAL_HUNTER_CIM_MAILBOX_RESEND_API_KEY']));
  assert.equal(f.commands.filter(c => c.args[0] === 'machines').length, 2);
  assert.equal(f.commands.some(c => c.args[0] === 'secrets'), false);
  assert.equal(fs.existsSync(result.privateAuthDirectory), false);
});
test('stopped diagnostic preparer seals only zero-start authority after actual public preflight and cleanup', async t => {
  const f = fixture(t);
  f.recipe.version = 'p10b-owner-stopped-update-recipe-v2';
  f.recipe.ownerIssuanceDirectory = path.join(f.root, 'owner-public-issuance');
  f.recipe.files.diagnosticNative = { path: process.execPath, sha256: P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 };
  f.permission.recipeDigest = digest(f.recipe);
  const original = f.options.checkFile;
  f.options.checkFile = item => item === f.recipe.files.diagnosticNative ? item.path : original(item);
  assert.equal(preflight.checkP10bOwnerRecipe(f.recipe, f.options).recoveryPolicy, 'acknowledged-only-nonrunning-v1');
  const result = await preflight.prepareP10bOwnerBundle({ ...f, ...f.options });
  const bundle = JSON.parse(fs.readFileSync(f.recipe.sealedBundlePath));
  assert.equal(bundle.version, 'p10b-stopped-update-bundle-v2');
  assert.equal(bundle.session.version, 'p10b-stopped-update-session-v2');
  assert.equal(bundle.session.recoveryPolicy, 'acknowledged-only-nonrunning-v1');
  assert.equal(bundle.session.maximumStarts, 0); assert.equal(bundle.session.maximumStartWindowMs, 0);
  assert.equal(bundle.session.maximumDiagnosticPosts, 1); assert.equal(bundle.session.maximumRestorationPosts, 1);
  assert.equal(bundle.session.maximumStoppedConfigUpdates, 2); assert.equal(bundle.session.qualificationAllowed, false);
  assert.equal(bundle.approval.version, 'p10b-stopped-update-approval-v2'); assert.equal(bundle.approval.approved, false);
  assert.equal(result.operation, 'stopped-update-diagnostic'); assert.equal(result.preflightCleanupVerified, true);
  assert.equal(result.recoveryPolicy, 'acknowledged-only-nonrunning-v1');
  assert.equal(bundle.session.requestTimeoutMs, 10000); assert.equal(bundle.session.maximumObservationMs, 10000);
  assert.equal(bundle.session.maximumRunMs, 120000);
  assert.equal(Date.parse(bundle.session.sessionDeadline) - Date.parse(bundle.session.startedAt), 900000);
  assert.equal(fs.existsSync(result.privateAuthDirectory), false);
  assert.equal(f.commands.some(c => c.args.some(a => a === 'start' || a === 'update')), false);
});
test('superseded diagnostic recipe refuses before public commands or private allocation', async t => {
  const f = fixture(t); f.recipe.version = 'p10b-owner-stopped-update-recipe-v1';
  f.recipe.ownerIssuanceDirectory = path.join(f.root, 'owner-public-issuance');
  f.recipe.files.diagnosticNative = { path: process.execPath, sha256: P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 };
  f.permission.recipeDigest = digest(f.recipe);
  const original = f.options.checkFile;
  f.options.checkFile = item => item === f.recipe.files.diagnosticNative ? item.path : original(item);
  await assert.rejects(preflight.prepareP10bOwnerBundle({ ...f, ...f.options }), /Fixed reviewed recipe required/);
  assert.equal(f.commands.length, 0); assert.equal(fs.readdirSync(f.recipe.evidenceDirectory).length, 0);
  assert.equal(fs.existsSync(f.recipe.sealedBundlePath), false);
});
test('environment name admission precedes value access', () => {
  assert.equal(typeof preflight.projectP10bStoppedBaseline, 'function');
  const env = { ...baseline.env };
  Object.defineProperty(env, 'UNKNOWN_SECRET', { enumerable: true, get() { throw Error('value accessed'); } });
  const row = { id: '0803730bd1d7e8', state: 'stopped', region: 'ewr', instance_id: 'offline', config: { ...baseline, env } };
  assert.throws(() => preflight.projectP10bStoppedBaseline([row], true), /Environment names denied/);
});
test('public issuance validation is credential-free and rejects invalid ID, timing, coverage and old scope', async t => {
  for (const mode of ['ID', 'TIMING', 'COVERAGE', 'SCOPE']) await t.test(mode, t => {
    const f = fixture(t);
    if (mode === 'ID') f.receipt.tokenId = '';
    if (mode === 'TIMING') f.receipt.issuanceStartedAt = new Date(Date.now() - 62000).toISOString();
    if (mode === 'COVERAGE') f.receipt.expiresAt = new Date(Date.now() + 1800000).toISOString();
    if (mode === 'SCOPE') f.permission.approvedAt = new Date(Date.now() - 3600001).toISOString();
    assert.throws(() => preflight.validateP10bOwnerPublicInputs({ ...f, ...f.options }));
    assert.equal(f.commands.length, 0);
    assert.equal(fs.readdirSync(f.recipe.evidenceDirectory).length, 0);
  });
});
test('preparer failure, changed metadata, digest drift and uncertain reap never admit runtime', async t => {
  assert.equal(typeof preflight.prepareP10bOwnerBundle, 'function');
  for (const mode of ['SDK_FAILURE', 'REGISTRY_DRIFT', 'BASELINE_DRIFT', 'REAP_UNCERTAIN']) await t.test(mode, async t => {
    const f = fixture(t); const original = f.runner.command;
    f.runner.command = async (...args) => {
      if (mode === 'SDK_FAILURE') throw Error('private remote text');
      if (mode === 'REGISTRY_DRIFT' && args[1].includes('--raw')) return '{}';
      if (mode === 'BASELINE_DRIFT' && args[1][0] === 'machines' && f.commands.length) f.machine.instance_id = 'changed';
      return original(...args);
    };
    if (mode === 'REAP_UNCERTAIN') f.runner.reap = async () => false;
    await assert.rejects(preflight.prepareP10bOwnerBundle({ ...f, ...f.options }), /Preflight held/);
    assert.equal(fs.existsSync(f.recipe.sealedBundlePath), false);
    const closure = JSON.parse(fs.readFileSync(path.join(f.recipe.evidenceDirectory, 'p10b-owner-preflight-closure.json')));
    assert.equal(closure.success, false);
    assert.equal(closure.failureStage, { SDK_FAILURE: 'baseline-names-read', REGISTRY_DRIFT: 'immutable-registry-manifest',
      BASELINE_DRIFT: 'baseline-values-read', REAP_UNCERTAIN: 'preflight-local-reap' }[mode]);
    assert.equal(JSON.stringify(closure).includes('private remote text'), false);
    if (mode === 'REAP_UNCERTAIN') {
      assert.equal(closure.cleanupVerified, false); assert.equal(fs.existsSync(closure.privateAuthDirectory), true);
      fs.rmSync(closure.privateAuthDirectory, { recursive: true, force: true });
    }
  });
});
test('invalid issuance, expired scope, replay and dirty checkout refuse before private allocation', async t => {
  assert.equal(typeof preflight.prepareP10bOwnerBundle, 'function');
  for (const mode of ['ISSUANCE', 'PERMISSION', 'REPLAY', 'SOURCE']) await t.test(mode, async t => {
    const f = fixture(t);
    if (mode === 'ISSUANCE') f.receipt.expiresAt = new Date().toISOString();
    if (mode === 'PERMISSION') f.permission.approved = false;
    if (mode === 'REPLAY') fs.writeFileSync(f.recipe.sealedBundlePath, 'old evidence');
    if (mode === 'SOURCE') f.options.checkSource = () => { throw Error('dirty'); };
    await assert.rejects(preflight.prepareP10bOwnerBundle({ ...f, ...f.options }));
    assert.equal(f.commands.length, 0);
    assert.equal(fs.existsSync(path.join(f.recipe.evidenceDirectory, 'p10b-owner-preflight-closure.json')), false);
  });
});
test('bounded preflight command timeout reaps its owned OS group and contains raw output', async t => {
  assert.equal(typeof preflight.createP10bPreflightContext, 'function');
  const context = preflight.createP10bPreflightContext({ FLY_API_TOKEN: 'offline-private' });
  const commands = preflight.createP10bPreflightCommands(context);
  t.after(async () => { await commands.reap(); context.cleanup(true); });
  await assert.rejects(commands.command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 30), /Bounded preflight command failed/);
  assert.equal(await commands.reap(), true); assert.equal(context.cleanup(true), true);
});
test('a surviving group remains owned after its SDK leader exits and is boundedly terminated', async t => {
  const context = preflight.createP10bPreflightContext({ FLY_API_TOKEN: 'offline-private' });
  let leader;
  const commands = preflight.createP10bPreflightCommands(context, { spawnProcess: (...args) => {
    const child = spawn(...args); leader = child.pid; return child;
  } });
  const pidFile = path.join(context.directory, 'offline-descendant.pid');
  t.after(async () => { await commands.reap();
    try { context.cleanup(true); } catch { fs.rmSync(context.directory, { recursive: true, force: true }); } });
  const script = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.stdout.write('public');`;
  await commands.command(process.execPath, ['-e', script], 2000).catch(() => {});
  assert.ok(Number(fs.readFileSync(pidFile)) > 1);
  // Observe the owned group, rather than a exited PID that can remain as a
  // zombie or be reused by another concurrently running fixture.
  assert.throws(() => process.kill(-leader, 0), error => error.code === 'ESRCH');
  assert.equal(await commands.reap(), true);
  assert.equal(context.cleanup(true), true);
});

test('consolidated receipt location is bound statically without creating an issuance directory or accepting aliases', t => {
  const f = fixture(t);
  f.recipe.ownerIssuanceDirectory = path.join(f.root, 'owner-public-issuance');
  assert.equal(preflight.checkP10bOwnerRecipe(f.recipe, f.options).authenticatedActions, 0);
  assert.equal(fs.existsSync(f.recipe.ownerIssuanceDirectory), false);
  for (const bad of [null, 17, 'relative/owner-public-issuance', `${f.root}/alias/../owner-public-issuance`, f.root]) {
    f.recipe.ownerIssuanceDirectory = bad;
    assert.throws(() => preflight.checkP10bOwnerRecipe(f.recipe, f.options));
  }
});

test('guardian-only preflight preserves historical archive and seals one inert start without build or preparation authority', async t => {
  const f = existingArchiveDiagnostic(t);
  f.recipe.version = 'p10b-owner-guardian-only-recipe-v1';
  delete f.recipe.files.diagnosticNative;
  const source = await import('../server/services/p10bOperatorSource.js');
  f.recipe.files.guardianNative = { path: process.execPath, sha256: source.P10B_GUARDIAN_NATIVE_SHA256 || 'f'.repeat(64) };
  const originalCheck = f.options.checkFile;
  f.options.checkFile = item => item === f.recipe.files.guardianNative ? item.path : originalCheck(item);
  f.permission.recipeDigest = digest(f.recipe);
  const archivedBytes = fs.readFileSync(f.recipe.recovery.archivePath);
  const checked = preflight.checkP10bOwnerRecipe(f.recipe, f.options);
  assert.equal(checked.operation, 'guardian-only'); assert.equal(checked.maximumStarts, 1);
  assert.equal(checked.maximumLocalBuilds, 0); assert.equal(checked.maximumImagePushes, 0);
  assert.equal(checked.maximumStoppedConfigUpdates, 2); assert.equal(checked.qualificationAllowed, false);
  assert.equal(checked.recoveryPolicy, 'acknowledged-only-stopped-runtime-v1');
  const result = await preflight.prepareP10bOwnerBundle({ ...f, ...f.options });
  const bundle = JSON.parse(fs.readFileSync(result.sealedBundlePath));
  assert.equal(bundle.version, 'p10b-guardian-only-bundle-v1');
  assert.equal(bundle.approval.version, 'p10b-guardian-only-approval-v1'); assert.equal(bundle.approval.approved, false);
  const s = bundle.session;
  assert.equal(s.version, 'p10b-guardian-only-session-v1'); assert.equal(s.operation, 'guardian-only');
  assert.equal(s.maximumStarts, 1); assert.equal(s.maximumStartWindowMs, 300000); assert.equal(s.maximumStoppedConfigUpdates, 2);
  assert.equal(s.maximumLocalBuilds, 0); assert.equal(s.maximumImagePushes, 0); assert.equal(s.qualificationAllowed, false);
  assert.equal(s.recoveryPolicy, 'acknowledged-only-stopped-runtime-v1');
  assert.equal(s.nativeClientSha256, f.recipe.files.guardianNative.sha256);
  assert.equal(s.baselineInstanceId, f.machine.instance_id); assert.ok(s.baselineObservedAt);
  assert.equal(Date.parse(s.sessionDeadline) - Date.parse(s.startedAt), 3600000);
  assert.equal(bundle.imageEvidence.buildCount, 1); assert.equal(bundle.imageEvidence.pushCount, 1);
  assert.deepEqual(fs.readFileSync(f.recipe.recovery.archivePath), archivedBytes);
  assert.deepEqual(s.recovery.priorArchive, f.recipe.recovery.priorArchive);
  assert.equal(result.operation, 'guardian-only'); assert.equal(fs.existsSync(result.privateAuthDirectory), false);
  assert.equal(f.commands.some(c => c.args.some(a => ['start', 'update', 'build', 'push'].includes(a))), false);
});

test('guardian-only recipe refuses absent or legacy guardian binary before private commands', async t => {
  for (const mode of ['absent', 'legacy']) await t.test(mode, t => {
    const f = existingArchiveDiagnostic(t); f.recipe.version = 'p10b-owner-guardian-only-recipe-v1';
    if (mode === 'legacy') f.recipe.files.guardianNative = f.recipe.files.native;
    assert.throws(() => preflight.checkP10bOwnerRecipe(f.recipe, f.options));
    assert.equal(f.commands.length, 0); assert.equal(fs.readdirSync(f.recipe.evidenceDirectory).length, 0);
  });
});
