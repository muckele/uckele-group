import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverP10bAdmissionReservation, assertP10bRecoveryAdmission, verifyP10bAdmissionArchive } from '../server/services/p10bAdmissionRecovery.js';
import { inspectP10bRecovery, createP10bRecoveryFilesystem } from '../server/services/p10bOperatorFiles.js';
import { inspectP10bPriorArchive } from '../server/services/p10bExistingArchiveRecovery.js';
import { existingArchiveFixture, materializeExistingArchive } from './helpers/p10bExistingArchiveFixture.js';

const recover = f => recoverP10bAdmissionReservation({ ...f, clock: () => f.now });
const inspect = f => inspectP10bRecovery(f.session, f.filesystem);
const guardianFixture = () => {
  const f = existingArchiveFixture();
  Object.assign(f.session, { version: 'p10b-guardian-only-session-v1', operation: 'guardian-only',
    recoveryPolicy: 'acknowledged-only-stopped-runtime-v1',
    maximumStarts: 1, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 2,
    maximumLocalBuilds: 0, maximumImagePushes: 0,
    sessionDeadline: new Date(f.now + 3600000).toISOString() });
  f.approval.sessionDigest = f.digest(f.session);
  return f;
};
const verify = (f, recovery) => verifyP10bAdmissionArchive({ session: f.session, recovery,
  inspect: () => inspect(f), verifierPid: process.pid + 200, now: f.now });

test('guardian-only archive admission preserves all historical bytes and requires its own independent proof', () => {
  const f = guardianFixture(); const recovery = recover(f);
  assert.equal(recovery.terminal.archivePreserved, true);
  assert.equal(recovery.terminal.historicalCleanupVerified, false);
  assert.equal(recovery.intent.sessionDigest, f.digest(f.session));
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
  recovery.verification = verify(f, recovery);
  assert.equal(assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }), true);
  assert.deepEqual(f.writes, [f.session.recovery.intentPath, f.session.recovery.terminalPath]);
  for (const row of f.original) assert.equal(f.filesystem.read(row.path), row.bytes);
  assert.equal(f.filesystem.exists(f.session.recovery.activePath), false);
  assert.throws(() => recover(f));
});

test('guardian archive admission rejects broader authority before writing fresh evidence', async t => {
  const cases = {
    legacy: f => { f.session.version = 'p10b-no-email-session-v1'; },
    operation: f => { f.session.operation = 'prepare'; },
    policy: f => { f.session.recoveryPolicy = 'legacy'; },
    qualification: f => { f.session.qualificationAllowed = true; },
    starts: f => { f.session.maximumStarts = 2; },
    window: f => { f.session.maximumStartWindowMs = 300001; },
    updates: f => { f.session.maximumStoppedConfigUpdates = 3; },
    builds: f => { f.session.maximumLocalBuilds = 1; },
    pushes: f => { f.session.maximumImagePushes = 1; },
    production: f => { f.session.productionReady = true; },
    automation: f => { f.session.globalAutomationPaused = false; },
    deadline: f => { f.session.sessionDeadline = new Date(f.now + 3600001).toISOString(); }
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const f = guardianFixture(); mutate(f); f.approval.sessionDigest = f.digest(f.session);
    assert.throws(() => recover(f)); assert.equal(f.writes.length, 0);
  });
});

test('guardian archive proof refuses cross-session replay, stale verification and archive or active conflicts', async t => {
  const cases = {
    'session-replay': f => { f.session.nonce = 'f'.repeat(24); },
    'expired-proof': f => { f.now += 3600001; },
    'changed-archive': f => { f.files.get(f.session.recovery.archivePath).bytes += ' '; },
    'active-conflict': f => { f.files.set(f.session.recovery.activePath, { regular: true, bytes: '{}' }); },
    'same-verifier': (f, recovery) => {
      recovery.verification.verifierPid = recovery.terminal.operatorPid;
    }
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const f = guardianFixture(); const recovery = recover(f); recovery.verification = verify(f, recovery);
    mutate(f, recovery);
    assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
    for (const row of f.original) if (name !== 'changed-archive' || row.path !== f.session.recovery.archivePath)
      assert.equal(f.filesystem.read(row.path), row.bytes);
  });
});

test('guardian admission remains valid during its original session only with current coherent archive inspection', () => {
  const f = guardianFixture(); const recovery = recover(f); recovery.verification = verify(f, recovery);
  const admittedAt = f.now;
  f.now += 300000;
  let inspections = 0;
  const assertCurrent = () => assertP10bRecoveryAdmission({ session: f.session, recovery, now: f.now,
    clock: () => f.now, inspect: () => { inspections++; return inspect(f); } });
  assert.equal(assertCurrent(), true);
  assert.equal(inspections, 1);
  assert.equal(recovery.verification.verifiedAt, new Date(admittedAt).toISOString());
  f.files.get(f.session.recovery.archivePath).bytes += ' ';
  assert.throws(assertCurrent);
  f.files.get(f.session.recovery.archivePath).bytes = f.original[0].bytes;
  f.now = Date.parse(f.session.sessionDeadline);
  assert.throws(assertCurrent);
});

test('diagnostic archive proof still expires after two minutes within its unchanged session deadline', () => {
  const f = existingArchiveFixture(); const recovery = recover(f); recovery.verification = verify(f, recovery);
  f.now += 120001;
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, now: f.now,
    clock: () => f.now, inspect: () => inspect(f) }));
});

test('guardian archive admission requires fresh matching stopped baseline and separate observing process', async t => {
  const cases = {
    'missing-owner-approval': f => { f.approval.approved = false; },
    'missing-exclusive-writers': f => { f.approval.exclusiveAdmissionWriters = false; },
    'baseline-running': f => { f.baseline.state = 'started'; },
    'baseline-mismatch': f => { f.independentBaseline.machineDigest = 'f'.repeat(64); },
    'baseline-stale': f => { f.independentBaseline.observedAt = new Date(f.now - 30001).toISOString(); },
    'same-process-baseline': f => { f.independentBaseline.verifierPid = process.pid; }
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const f = guardianFixture(); mutate(f);
    assert.throws(() => recover(f)); assert.deepEqual(f.writes, []);
    for (const row of f.original) assert.equal(f.filesystem.read(row.path), row.bytes);
  });
});

test('guardian proof cannot be promoted to legacy or prepare authority by rehashing its current-session links', () => {
  for (const broaden of [s => { s.version = 'p10b-no-email-session-v1'; }, s => { s.operation = 'prepare'; }]) {
    const f = guardianFixture(); const recovery = recover(f); recovery.verification = verify(f, recovery);
    broaden(f.session);
    recovery.intent.sessionDigest = recovery.terminal.sessionDigest = recovery.verification.sessionDigest = f.digest(f.session);
    recovery.terminal.intentDigest = f.digest(recovery.intent);
    recovery.verification.terminalDigest = f.digest(recovery.terminal);
    assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
  }
});

test('existing preserved archive admits a new session through fresh independent read-only proof', () => {
  const f = existingArchiveFixture();
  const recovery = recover(f);
  assert.equal(recovery.intent.version, 'p10b-existing-archive-admission-intent-v1');
  assert.equal(recovery.terminal.version, 'p10b-existing-archive-admission-terminal-v1');
  assert.equal(recovery.terminal.activeAbsent, true);
  assert.equal(recovery.terminal.archivePreserved, true);
  assert.equal(recovery.terminal.historicalCleanupVerified, false);
  assert.equal(recovery.intent.sessionDigest, f.digest(f.session));
  assert.notEqual(recovery.intent.sessionDigest, f.session.recovery.priorArchive.sessionDigest);
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
  recovery.verification = verifyP10bAdmissionArchive({ session: f.session, recovery, inspect: () => inspect(f),
    verifierPid: process.pid + 200, now: f.now });
  assert.equal(assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }), true);
  assert.deepEqual(f.writes, [f.session.recovery.intentPath, f.session.recovery.terminalPath]);
  for (const row of f.original) assert.equal(f.filesystem.read(row.path), row.bytes);
  assert.throws(() => recover(f)); // exclusive current-session evidence makes replay fail
});

test('changed, missing, unsafe or inconsistent historical archive evidence fails before current proof writes', async t => {
  const cases = {
    active: f => f.files.set(f.session.recovery.activePath, { bytes: '{}', regular: true }),
    'active-symlink': f => f.files.set(f.session.recovery.activePath, { bytes: '', symlink: true }),
    'archive-missing': f => f.files.delete(f.session.recovery.archivePath),
    'archive-bytes': f => { f.files.get(f.session.recovery.archivePath).bytes += ' '; },
    'archive-inode': f => { f.files.get(f.session.recovery.archivePath).inode = 'different'; },
    'archive-mode': f => { f.files.get(f.session.recovery.archivePath).mode = 420; },
    'archive-owner': f => { f.files.get(f.session.recovery.archivePath).owner++; },
    'archive-symlink': f => { f.files.get(f.session.recovery.archivePath).symlink = true; },
    'attempt-bytes': f => { f.files.get(f.session.recovery.attemptPath).bytes += ' '; },
    'prior-receipt-missing': f => f.files.delete(f.session.recovery.priorArchive.intent.path),
    'prior-receipt-bytes': f => { f.files.get(f.session.recovery.priorArchive.terminal.path).bytes += ' '; },
    'prior-session': f => { f.session.recovery.priorArchive.sessionDigest = 'f'.repeat(64); },
    'prior-nonce': f => { f.session.recovery.priorArchive.nonce = 'f'.repeat(24); },
    'same-session': f => { f.session.recovery.priorArchive.sessionDigest = f.digest(f.session); },
    'baseline-stale': f => { f.independentBaseline.observedAt = new Date(f.now - 30001).toISOString(); },
    'baseline-mismatch': f => { f.independentBaseline.machineDigest = 'f'.repeat(64); },
    'unapproved': f => { f.approval.approved = false; },
    'archive-changed-during-read': f => {
      const read = f.filesystem.read;
      f.filesystem.read = file => { const bytes = read(file); if (file === f.session.recovery.archivePath) f.files.get(file).mtime = 'changed'; return bytes; };
    }
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const f = existingArchiveFixture(); mutate(f); f.approval.sessionDigest = f.digest(f.session);
    assert.throws(() => recover(f)); assert.equal(f.writes.length, 0);
  });
});

test('current proof cannot reuse old verification or survive changed historical bytes or active reappearance', () => {
  const f = existingArchiveFixture(); const recovery = recover(f);
  recovery.verification = JSON.parse(f.filesystem.read(f.session.recovery.priorArchive.verification.path));
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
  recovery.verification = verifyP10bAdmissionArchive({ session: f.session, recovery, inspect: () => inspect(f),
    verifierPid: process.pid + 200, now: f.now });
  f.files.set(f.session.recovery.activePath, { regular: true, bytes: '{}' });
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
  f.files.delete(f.session.recovery.activePath);
  f.files.get(f.session.recovery.priorArchive.intent.path).bytes += ' ';
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
});
test('directory replacement during a coherent snapshot holds without following the replacement alias', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-archive-directory-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recovery = materializeExistingArchive(root); const filesystem = createP10bRecoveryFilesystem();
  const snapshot = filesystem.snapshot; let replaced = false;
  filesystem.snapshot = file => {
    const result = snapshot(file);
    if (file === recovery.archivePath && !replaced) {
      replaced = true; fs.renameSync(recovery.directory, `${recovery.directory}.preserved`);
      fs.symlinkSync(`${recovery.directory}.preserved`, recovery.directory);
    }
    return result;
  };
  assert.throws(() => inspectP10bPriorArchive(recovery, filesystem));
  assert.equal(replaced, true);
});
test('freshness is checked again after historical proof inspection', () => {
  const f = existingArchiveFixture(); const recovery = recover(f);
  recovery.verification = verifyP10bAdmissionArchive({ session: f.session, recovery, inspect: () => inspect(f),
    verifierPid: process.pid + 200, now: f.now });
  const before = f.now;
  assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, now: before, clock: () => f.now,
    inspect: () => { const result = inspect(f); f.now += 125000; return result; } }));
});
test('absence uncertainty and changed directory identity never admit an existing archive', () => {
  for (const mode of ['access-error', 'directory-replaced']) {
    const f = existingArchiveFixture(); let checks = 0;
    if (mode === 'access-error') f.filesystem.exists = () => { throw Object.assign(Error('uncertain'), { code: 'EACCES' }); };
    else { const anchor = f.filesystem.anchorDirectory.bind(f.filesystem);
      f.filesystem.anchorDirectory = file => ({ ...anchor(file), inode: ++checks > 2 ? 'replacement' : 'original' }); }
    assert.throws(() => recover(f)); assert.equal(f.writes.length, 0);
  }
});
test('admission-only records reject retirement claims and unknown keys even with rehashed links', () => {
  for (const field of ['intent', 'terminal', 'verification']) {
    const f = existingArchiveFixture(); const recovery = recover(f);
    recovery.verification = verifyP10bAdmissionArchive({ session: f.session, recovery, inspect: () => inspect(f),
      verifierPid: process.pid + 200, now: f.now });
    recovery[field].activeRetired = true; recovery[field].retiredAt = new Date(f.now).toISOString();
    recovery.terminal.intentDigest = f.digest(recovery.intent);
    recovery.verification.terminalDigest = f.digest(recovery.terminal);
    assert.throws(() => assertP10bRecoveryAdmission({ session: f.session, recovery, inspect: () => inspect(f), now: f.now }));
  }
});
