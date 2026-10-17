import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';
import { stoppedDiagnosticFixture, diagnosticDigest } from './p10bStoppedDiagnosticFixture.js';

const historical = JSON.parse(fs.readFileSync(new URL('../fixtures/p10bHistoricalArchiveRecovery.json', import.meta.url)));
export function existingArchiveFixture(now = Date.now(), ownerHome) {
  const original = structuredClone(historical.records);
  const [archive, attempt, intent, terminal, verification] = original;
  if (ownerHome) {
    // CLI tests rebase only memory fixtures to the runner's home, never host files.
    const current = path.join(ownerHome, '.uckele-group-p10b-host');
    archive.path = path.join(current, path.basename(archive.path)); attempt.path = path.join(current, path.basename(attempt.path));
    const t = JSON.parse(terminal.bytes);
    t.activePath = path.join(current, '0803730bd1d7e8.active.json'); t.archivePath = archive.path;
    terminal.bytes = `${stableCanonicalJson(t)}\n`; terminal.sha256 = sha256(terminal.bytes);
    const v = JSON.parse(verification.bytes); v.terminalDigest = diagnosticDigest(t);
    verification.bytes = `${stableCanonicalJson(v)}\n`; verification.sha256 = sha256(verification.bytes);
  }
  const directory = path.dirname(archive.path);
  const activePath = path.join(directory, '0803730bd1d7e8.active.json');
  const record = JSON.parse(archive.bytes);
  const { session, approval } = stoppedDiagnosticFixture(now);
  session.nonce = '1234567890abcdef12345678';
  session.recovery = { directory, activePath, archivePath: archive.path, attemptPath: attempt.path,
    intentPath: '/synthetic/new-evidence/p10b-recovery-intent.json', terminalPath: '/synthetic/new-evidence/p10b-recovery-terminal.json',
    ...record, expectedSha256: archive.sha256,
    priorArchive: { nonce: '103e41746bf89e7e2dec9c5d', sessionDigest: JSON.parse(intent.bytes).sessionDigest,
      intent: { path: intent.path, sha256: intent.sha256 }, terminal: { path: terminal.path, sha256: terminal.sha256 },
      verification: { path: verification.path, sha256: verification.sha256 } } };
  approval.sessionDigest = diagnosticDigest(session);
  const files = new Map(original.map(row => [row.path, { ...row, regular: true, symlink: false,
    mode: 384, owner: process.getuid(), nlink: 1, mtime: '100', ctime: '100' }]));
  const writes = [];
  const filesystem = {
    statDirectory: () => ({ ownerControlled: true, symlink: false }),
    anchorDirectory(file) { return { ...this.statDirectory(file), ...this.stat(file) }; },
    stat(file) {
      if (file === directory || file === path.dirname(intent.path)) return { mode: 448, owner: process.getuid(), symlink: false };
      const row = files.get(file); if (!row) throw Object.assign(Error('absent'), { code: 'ENOENT' });
      return { ...row, bytes: undefined, size: Buffer.byteLength(row.bytes) };
    },
    read(file) { const row = files.get(file); if (!row) throw Object.assign(Error('absent'), { code: 'ENOENT' }); return row.bytes; },
    exists: file => files.has(file),
    snapshot(file) {
      const before = this.stat(file); const bytes = this.read(file); const after = this.stat(file);
      assert.deepEqual(before, after); return { bytes, stat: before };
    },
    writeExclusive(file, value) {
      assert.ok([session.recovery.intentPath, session.recovery.terminalPath].includes(file)); assert.equal(files.has(file), false);
      writes.push(file); files.set(file, { regular: true, symlink: false, bytes: `${stableCanonicalJson(value)}\n`,
        mode: 384, owner: process.getuid(), inode: String(files.size + 100), device: '7', nlink: 1, mtime: '100', ctime: '100' });
    },
    syncFile() {}, syncDirectoryOf() {},
    linkExclusive() { assert.fail('read-only adoption cannot link'); }, unlinkActive() { assert.fail('read-only adoption cannot unlink'); }
  };
  const baseline = { id: session.machineId, region: 'ewr', state: 'stopped',
    config: session.baselineConfig, image_ref: { digest: session.baselineImageDigest } };
  const independentBaseline = { machineDigest: diagnosticDigest(baseline), independent: true,
    observedAt: new Date(now).toISOString(), verifierPid: process.pid + 100 };
  return { session, approval, files, filesystem, writes, baseline, independentBaseline,
    now, digest: diagnosticDigest, sha: sha256, original };
}

// Real filesystem tests use only a newly created isolated directory. Historical
// content is retained; path/device/inode changes are explicit synthetic inputs.
export function materializeExistingArchive(root) {
  const f = existingArchiveFixture(); const r = f.session.recovery;
  const directory = path.join(root, '.uckele-group-p10b-host');
  const prior = path.join(root, 'prior-evidence');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(prior, { mode: 0o700 });
  const raw = f.original.map(row => row.bytes);
  const activePath = path.join(directory, '0803730bd1d7e8.active.json');
  const archivePath = `${activePath}.archived-uncertain-${r.priorArchive.nonce}.json`;
  const attemptPath = path.join(directory, path.basename(r.attemptPath));
  fs.writeFileSync(archivePath, raw[0], { mode: 0o600 }); fs.writeFileSync(attemptPath, raw[1], { mode: 0o600 });
  const st = fs.statSync(archivePath, { bigint: true });
  const terminal = { ...JSON.parse(raw[3]), activePath, archivePath, archiveDevice: String(st.dev), archiveInode: String(st.ino) };
  const verification = { ...JSON.parse(raw[4]), terminalDigest: diagnosticDigest(terminal) };
  const priorArchive = { nonce: r.priorArchive.nonce, sessionDigest: r.priorArchive.sessionDigest };
  for (const [key, name, value] of [['intent', 'intent', JSON.parse(raw[2])], ['terminal', 'terminal', terminal],
    ['verification', 'independent-verification', verification]]) {
    const file = path.join(prior, `p10b-recovery-${name}.json`); const bytes = `${stableCanonicalJson(value)}\n`;
    fs.writeFileSync(file, bytes, { mode: 0o600 }); priorArchive[key] = { path: file, sha256: sha256(bytes) };
  }
  return { ...r, directory, activePath, archivePath, attemptPath, priorArchive };
}
