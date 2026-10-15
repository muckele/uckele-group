import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../server/utils/security.js';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';
import { verifyP10bAdmissionArchive } from '../server/services/p10bAdmissionRecovery.js';
import { runP10bStoppedUpdateCli } from '../server/services/p10bStoppedUpdateCli.js';
import { P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 } from '../server/services/p10bStoppedUpdateContract.js';
import { stoppedDiagnosticFixture, diagnosticDigest as digest } from './helpers/p10bStoppedDiagnosticFixture.js';
function fixture() {
  let now = Date.now(); const { session, approval } = stoppedDiagnosticFixture(now); const root = '/synthetic/stopped-evidence';
  const records = new Map(); const files = new Map(); const directory = path.join(os.homedir(), '.uckele-group-p10b-host');
  const record = { version: 'p10b-machine-owner-v1', packetDigest: '4'.repeat(64), evidencePath: '/preserved/failed', reservedAt: '2026-10-10T07:12:20.821Z' };
  const bytes = JSON.stringify(record);
  session.nativeClientSha256 = P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256;
  session.recovery = { directory, activePath: `${directory}/${session.machineId}.active.json`,
    archivePath: `${directory}/${session.machineId}.active.json.archived-uncertain-${session.nonce}.json`,
    attemptPath: `${directory}/${record.packetDigest}.attempt.json`, intentPath: `${root}/p10b-recovery-intent.json`,
    terminalPath: `${root}/p10b-recovery-terminal.json`, expectedSha256: sha256(bytes), ...record };
  const r = session.recovery; approval.sessionDigest = digest(session);
  const item = { bytes, inode: '42', device: '7', mode: 384, owner: 501, mtime: 100, regular: true, symlink: false };
  files.set(r.activePath, item); files.set(r.attemptPath, { ...item, bytes: 'preserved-attempt' });
  const filesystem = { statDirectory: () => ({ ownerControlled: true, symlink: false }),
    read: file => files.get(file).bytes, stat: file => files.get(file), exists: file => files.has(file),
    writeExclusive(file, value) { assert.equal(files.has(file), false); files.set(file, { ...item, bytes: JSON.stringify(value) }); },
    linkExclusive(from, to) { assert.equal(files.has(to), false); files.set(to, files.get(from)); },
    syncFile() {}, syncDirectoryOf() {}, unlinkActive(file) { files.delete(file); } };
  const inspect = () => ({ activeAbsent: !files.has(r.activePath), archiveSha256: sha256(files.get(r.archivePath).bytes),
    archiveDevice: item.device, archiveInode: item.inode, attemptSha256: sha256(files.get(r.attemptPath).bytes) });
  const evidence = { root, has: name => records.has(name), read: name => records.get(name), write(name, value) {
    assert.equal(records.has(name), false); records.set(name, structuredClone(value)); } };
  const bundle = { version: 'p10b-stopped-update-bundle-v1', status: 'OWNER_APPROVED_STOPPED_UPDATE_DIAGNOSTIC', session, approval,
    imageEvidence: { version: 'p10b-image-prerequisite-v1', sourceHead: session.sourceHead, imageDigest: session.candidateImageDigest,
      immutableImage: `registry.fly.io/uckele-group-p10b@${session.candidateImageDigest}`, buildCount: 1, pushCount: 1,
      registryManifestVerified: true, manifestEvidenceDigest: '8'.repeat(64), verifiedAt: session.startedAt } };
  let config = session.baselineConfig; let instance = session.baselineInstanceId; let posts = 0; let contexts = 0; let context;
  const machine = () => ({ id: session.machineId, region: 'ewr', state: 'stopped', instance_id: instance,
    config: structuredClone(config), image_ref: { digest: config.image.split('@')[1] } });
  const options = { read(file) { return file === '/synthetic/bundle' ? bundle : JSON.parse(files.get(file).bytes); },
    clock: () => now, checkSource: head => assert.equal(head, session.hostSourceHead), createEvidence: () => evidence,
    recoveryFilesystem: () => filesystem, inspectRecovery: inspect,
    createAuth(input) { contexts++; context = createP10bAppTokenContext({ ...input, environment: { FLY_API_TOKEN: 'synthetic-offline-auth-canary' } }); return context; },
    processes: { async command(executable, args, timeout) {
      assert.ok(timeout <= 10000); assert.ok(args[0].endsWith('run-p10b-admission-verifier.js'));
      if (args[1] === '--baseline') evidence.write('p10b-recovery-independent-baseline.json', {
        machineDigest: digest(machine()), independent: true, observedAt: new Date(now).toISOString(), verifierPid: process.pid + 100 });
      else { assert.equal(args[1], '--archive'); evidence.write('p10b-recovery-independent-verification.json', verifyP10bAdmissionArchive({ session,
        recovery: { intent: JSON.parse(files.get(r.intentPath).bytes), terminal: JSON.parse(files.get(r.terminalPath).bytes) },
        inspect, verifierPid: process.pid + 100, now })); }
    }, async reap() { return true; } },
    async openNative(input) {
      assert.deepEqual(input.configs, [session.baselineConfig, session.diagnosticConfig]);
      assert.equal(input.environment.FLY_API_TOKEN, 'synthetic-offline-auth-canary');
      return { async client(method = 'GET', body) {
        if (method === 'POST') {
          assert.equal(input.readOnly, false); assert.equal(input.recoveryVerified, true); posts++;
          assert.equal(body.skip_launch, true); assert.equal(body.current_version, instance);
          config = body.config; instance = `version-${posts}`;
        }
        now++;
        return { machine: machine(), observation: { httpStatus: 200, elapsedMs: 1, dispatched: true } };
      }, async reap() { return true; } };
    } };
  return { options, args: ['--execute', '--bundle', '/synthetic/bundle', '--evidence', root, '--native-client', '/synthetic/native'],
    bundle, records, files, evidence, contexts: () => contexts, context: () => context, posts: () => posts, advance: ms => { now += ms; } };
}
test('diagnostic CLI integrates positive independent recovery, zero-start controller and private cleanup', async () => {
  const f = fixture(); const result = await runP10bStoppedUpdateCli(f.args, f.options);
  assert.equal(result.success, true); assert.equal(result.operation, 'stopped-update-diagnostic'); assert.equal(result.maximumStarts, 0);
  assert.equal(result.restored, true); assert.equal(f.posts(), 2);
  assert.equal(f.evidence.read('p10b-stopped-update-auth-closure.json').success, true);
  assert.equal(fs.existsSync(f.context().environment.FLY_CONFIG_DIR), false);
  assert.equal(JSON.stringify([...f.records]).includes('canary'), false);
  await assert.rejects(runP10bStoppedUpdateCli(f.args, f.options)); assert.equal(f.contexts(), 1);
});
test('diagnostic CLI holds legacy, unapproved, expired and alternate execution paths before credentials', async () => {
  for (const change of [f => { f.args[0] = '--run'; }, f => { f.bundle.status = 'SESSION_NOT_APPROVED'; },
    f => { f.bundle.version = 'p10b-no-email-bundle-v1'; }, f => { f.bundle.approval.approved = false; },
    f => { f.advance(900000); }, f => { f.bundle.session.maximumStarts = 2; }]) {
    const f = fixture(); change(f); await assert.rejects(runP10bStoppedUpdateCli(f.args, f.options));
    assert.equal(f.contexts(), 0); assert.equal(f.posts(), 0);
  }
});
test('diagnostic CLI cannot dispatch after independent baseline/archive verification fails', async () => {
  const f = fixture(); f.options.processes.command = async () => { throw Error('synthetic-independent-proof-failure'); };
  await assert.rejects(runP10bStoppedUpdateCli(f.args, f.options)); assert.equal(f.posts(), 0);
  assert.equal(f.evidence.read('p10b-stopped-update-auth-closure.json').cleanupVerified, true);
  assert.equal(fs.existsSync(f.context().environment.FLY_CONFIG_DIR), false);
});
test('original diagnostic cutoff is retained across recovery before controller admission', async () => {
  const f = fixture(); const command = f.options.processes.command;
  f.options.processes.command = async (...args) => { await command(...args); if (args[1][1] === '--archive') f.advance(80000); };
  await assert.rejects(runP10bStoppedUpdateCli(f.args, f.options)); assert.equal(f.posts(), 0);
  assert.equal(f.evidence.read('p10b-stopped-update-auth-closure.json').cleanupVerified, true);
});
test('unverified native initialization retains the private cleanup hold', async () => {
  const f = fixture(); let cleanupReaped;
  f.options.createAuth = () => ({ environment: {}, cleanup({ reaped }) { cleanupReaped = reaped; throw Error('hold'); } });
  f.options.openNative = async () => { throw Object.assign(Error('synthetic-private-native-error'), { reapVerified: false }); };
  await assert.rejects(runP10bStoppedUpdateCli(f.args, f.options)); assert.equal(cleanupReaped, false);
  assert.equal(f.evidence.read('p10b-stopped-update-auth-closure.json').cleanupVerified, false);
  assert.equal(f.posts(), 0);
});
test('CLI entry cutoff includes slow source and executable admission before credential allocation', async () => {
  const f = fixture(); f.options.checkSource = () => { f.advance(150000); };
  await assert.rejects(runP10bStoppedUpdateCli(f.args, f.options));
  assert.equal(f.contexts(), 0); assert.equal(f.posts(), 0);
});
