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
