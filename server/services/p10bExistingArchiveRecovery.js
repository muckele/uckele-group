import path from 'node:path';
import { sha256, stableCanonicalJson } from '../utils/security.js';
const digest = value => sha256(stableCanonicalJson(value));
const hold = () => { throw Error('Exact preserved archive admission proof required'); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;

export function assertP10bPriorArchiveBinding(e) {
  const p = e?.priorArchive;
  if (!exact(p, ['nonce', 'sessionDigest', 'intent', 'terminal', 'verification']) || !/^[a-f0-9]{24}$/.test(p.nonce || '')
    || !hex(p.sessionDigest) || !absolute(e.directory) || !hex(e.packetDigest) || !hex(e.expectedSha256)
    || e.activePath !== path.join(e.directory, '0803730bd1d7e8.active.json')
    || e.archivePath !== `${e.activePath}.archived-uncertain-${p.nonce}.json`
    || e.attemptPath !== path.join(e.directory, `${e.packetDigest}.attempt.json`)) hold();
  for (const [key, name] of [['intent', 'intent'], ['terminal', 'terminal'], ['verification', 'independent-verification']]) {
    if (!exact(p[key], ['path', 'sha256']) || !absolute(p[key].path) || !hex(p[key].sha256)
      || path.basename(p[key].path) !== `p10b-recovery-${name}.json`
      || path.dirname(p[key].path) !== path.dirname(p.intent.path)) hold();
  }
  return true;
}

// Pinned public records only; hashes and identities share coherent snapshots.
export function inspectP10bPriorArchive(e, f, now = Date.now()) {
  assertP10bPriorArchiveBinding(e);
  const directories = [e.directory, path.dirname(e.priorArchive.intent.path)].map(directory => {
    const s = f.anchorDirectory(directory);
    if (!s.ownerControlled || s.symlink) hold();
    return { path: directory, identity: s };
  });
  if (f.exists(e.activePath)) hold(); // production exists is lstat / ENOENT-only
  const rows = [];
  const read = (file, expected) => {
    const { bytes, stat: s } = f.snapshot(file);
    if (!s.regular || s.symlink || s.owner !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1
      || Buffer.byteLength(bytes) > 65536 || sha256(bytes) !== expected) hold();
    rows.push({ path: file, sha256: expected, identity: Object.fromEntries(
      ['device', 'inode', 'mode', 'owner', 'mtime', 'ctime', 'nlink', 'size'].map(key => [key, String(s[key])])) });
    return JSON.parse(bytes);
  };
  const record = read(e.archivePath, e.expectedSha256);
  const attemptSnapshot = f.snapshot(e.attemptPath);
  const attemptSha256 = sha256(attemptSnapshot.bytes);
  const attempt = read(e.attemptPath, attemptSha256);
  const p = e.priorArchive;
  const intent = read(p.intent.path, p.intent.sha256);
  const terminal = read(p.terminal.path, p.terminal.sha256);
  const verification = read(p.verification.path, p.verification.sha256);
  const archiveIdentity = rows[0].identity;
  if (!exact(record, ['version', 'packetDigest', 'evidencePath', 'reservedAt']) || record.version !== 'p10b-machine-owner-v1'
    || record.packetDigest !== e.packetDigest || record.evidencePath !== e.evidencePath || record.reservedAt !== e.reservedAt
    || !exact(attempt, ['packetDigest', 'evidencePath']) || attempt.packetDigest !== e.packetDigest || attempt.evidencePath !== e.evidencePath
    || !exact(intent, ['version', 'sessionDigest', 'originalSha256', 'attemptSha256', 'baselineDigest', 'independentBaselineDigest',
      'operatorPid', 'intendedAt', 'historicalCleanupVerified'])
    || intent.version !== 'p10b-admission-recovery-intent-v1' || intent.sessionDigest !== p.sessionDigest
    || intent.originalSha256 !== e.expectedSha256 || intent.attemptSha256 !== attemptSha256
    || !hex(intent.baselineDigest) || !hex(intent.independentBaselineDigest) || intent.historicalCleanupVerified !== false
    || !Number.isSafeInteger(intent.operatorPid) || intent.operatorPid < 2 || !time(intent.intendedAt)
    || !exact(terminal, ['version', 'sessionDigest', 'intentDigest', 'originalSha256', 'activePath', 'archivePath', 'archiveDevice',
      'archiveInode', 'activeRetired', 'operatorPid', 'retiredAt', 'historicalCleanupVerified', 'productionReady'])
    || terminal.version !== 'p10b-admission-recovery-terminal-v1' || terminal.sessionDigest !== p.sessionDigest
    || terminal.intentDigest !== digest(intent) || terminal.originalSha256 !== e.expectedSha256
    || terminal.activePath !== e.activePath || terminal.archivePath !== e.archivePath || terminal.activeRetired !== true
    || terminal.archiveDevice !== archiveIdentity.device || terminal.archiveInode !== archiveIdentity.inode
    || terminal.operatorPid !== intent.operatorPid || !time(terminal.retiredAt)
    || terminal.historicalCleanupVerified !== false || terminal.productionReady !== false
    || !exact(verification, ['version', 'sessionDigest', 'terminalDigest', 'archiveSha256', 'verifierPid', 'verifiedAt', 'success'])
    || verification.version !== 'p10b-independent-recovery-verification-v1' || verification.sessionDigest !== p.sessionDigest
    || verification.terminalDigest !== digest(terminal) || verification.archiveSha256 !== e.expectedSha256 || verification.success !== true
    || !Number.isSafeInteger(verification.verifierPid) || verification.verifierPid < 2 || verification.verifierPid === terminal.operatorPid
    || !time(verification.verifiedAt) || !time(e.reservedAt) || e.reservedAt > intent.intendedAt
    || intent.intendedAt > terminal.retiredAt || terminal.retiredAt > verification.verifiedAt || Date.parse(verification.verifiedAt) > now
    || f.exists(e.activePath)) hold();
  for (const row of rows) {
    const { bytes, stat: s } = f.snapshot(row.path);
    if (sha256(bytes) !== row.sha256 || Object.entries(row.identity).some(([key, value]) => String(s[key]) !== value)) hold();
  }
  if (f.exists(e.activePath)) hold();
  for (const row of directories) if (stableCanonicalJson(f.anchorDirectory(row.path)) !== stableCanonicalJson(row.identity)) hold();
  return { activeAbsent: true, archiveSha256: e.expectedSha256, archiveDevice: archiveIdentity.device,
    archiveInode: archiveIdentity.inode, attemptSha256,
    historicalProofDigest: digest({ priorArchive: p, rows, directories, activeAbsent: true }) };
}

export function admitP10bPriorArchive({ session, baseline, independentBaseline, filesystem: f, clock, operatorPid }) {
  const now = clock(); const e = session.recovery;
  if (session.version !== 'p10b-stopped-update-session-v2' || e.priorArchive.sessionDigest === digest(session)
    || !Number.isSafeInteger(independentBaseline.verifierPid) || independentBaseline.verifierPid < 2
    || independentBaseline.verifierPid === operatorPid) hold();
  const observed = inspectP10bPriorArchive(e, f, now);
  if (f.exists(e.intentPath) || f.exists(e.terminalPath)) hold();
  const intent = { version: 'p10b-existing-archive-admission-intent-v1', sessionDigest: digest(session), operatorPid,
    intendedAt: new Date(now).toISOString(), historicalProofDigest: observed.historicalProofDigest,
    originalSha256: observed.archiveSha256, attemptSha256: observed.attemptSha256,
    baselineDigest: digest(baseline), independentBaselineDigest: digest(independentBaseline), historicalCleanupVerified: false };
  f.writeExclusive(e.intentPath, intent); f.syncFile(e.intentPath); f.syncDirectoryOf(e.intentPath);
  if (inspectP10bPriorArchive(e, f).historicalProofDigest !== observed.historicalProofDigest
    || clock() < now || clock() + 30000 >= Date.parse(session.sessionDeadline)
    || clock() - Date.parse(independentBaseline.observedAt) > 30000) hold();
  const terminal = { version: 'p10b-existing-archive-admission-terminal-v1', sessionDigest: digest(session), operatorPid,
    intentDigest: digest(intent), historicalProofDigest: observed.historicalProofDigest,
    originalSha256: observed.archiveSha256, attemptSha256: observed.attemptSha256,
    activePath: e.activePath, archivePath: e.archivePath, archiveDevice: observed.archiveDevice, archiveInode: observed.archiveInode,
    activeAbsent: true, archivePreserved: true, verifiedAt: new Date(clock()).toISOString(), historicalCleanupVerified: false, productionReady: false };
  f.writeExclusive(e.terminalPath, terminal); f.syncFile(e.terminalPath); f.syncDirectoryOf(e.terminalPath);
  return { intent, terminal };
}

export function assertP10bPriorArchiveAdmission({ session, recovery, inspect, now, clock = Date.now }) {
  const { intent: i, terminal: t, verification: v } = recovery || {};
  if (session.version !== 'p10b-stopped-update-session-v2'
    || !exact(i, ['version', 'sessionDigest', 'operatorPid', 'intendedAt', 'historicalProofDigest', 'originalSha256',
      'attemptSha256', 'baselineDigest', 'independentBaselineDigest', 'historicalCleanupVerified'])
    || !exact(t, ['version', 'sessionDigest', 'operatorPid', 'intentDigest', 'historicalProofDigest', 'originalSha256',
      'attemptSha256', 'activePath', 'archivePath', 'archiveDevice', 'archiveInode', 'activeAbsent', 'archivePreserved',
      'verifiedAt', 'historicalCleanupVerified', 'productionReady'])
    || !exact(v, ['version', 'sessionDigest', 'terminalDigest', 'archiveSha256', 'verifierPid', 'verifiedAt', 'success'])
    || i.version !== 'p10b-existing-archive-admission-intent-v1' || t.version !== 'p10b-existing-archive-admission-terminal-v1'
    || i.sessionDigest !== digest(session) || t.sessionDigest !== digest(session) || v.sessionDigest !== digest(session)
    || t.intentDigest !== digest(i) || v.terminalDigest !== digest(t)
    || i.historicalCleanupVerified !== false || t.historicalCleanupVerified !== false || t.productionReady !== false
    || i.originalSha256 !== session.recovery.expectedSha256 || t.originalSha256 !== i.originalSha256
    || !hex(i.baselineDigest) || !hex(i.independentBaselineDigest)
    || !hex(i.attemptSha256) || t.attemptSha256 !== i.attemptSha256 || !hex(i.historicalProofDigest) || t.historicalProofDigest !== i.historicalProofDigest
    || t.activePath !== session.recovery.activePath || t.archivePath !== session.recovery.archivePath
    || t.activeAbsent !== true || t.archivePreserved !== true || !Number.isSafeInteger(i.operatorPid) || i.operatorPid < 2
    || t.operatorPid !== i.operatorPid || !Number.isSafeInteger(v.verifierPid) || v.verifierPid < 2 || v.verifierPid === t.operatorPid
    || v.version !== 'p10b-independent-recovery-verification-v1' || v.success !== true || v.archiveSha256 !== t.originalSha256
    || ![i.intendedAt, t.verifiedAt, v.verifiedAt].every(time) || !Number.isFinite(now)
    || Date.parse(i.intendedAt) < Date.parse(session.startedAt) || i.intendedAt > t.verifiedAt || t.verifiedAt > v.verifiedAt
    || Date.parse(v.verifiedAt) > now || now - Date.parse(v.verifiedAt) > 120000 || now >= Date.parse(session.sessionDeadline)) hold();
  const observed = inspect();
  if (observed.activeAbsent !== true || observed.archiveSha256 !== t.originalSha256 || observed.attemptSha256 !== i.attemptSha256
    || observed.archiveDevice !== t.archiveDevice || observed.archiveInode !== t.archiveInode
    || observed.historicalProofDigest !== i.historicalProofDigest) hold();
  const after = clock();
  if (!Number.isFinite(after) || after < now || after >= Date.parse(session.sessionDeadline)
    || after - Date.parse(v.verifiedAt) > 120000) hold();
  return true;
}
