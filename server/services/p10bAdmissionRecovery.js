import { sha256, stableCanonicalJson } from '../utils/security.js';
const digest = value => sha256(stableCanonicalJson(value));
const deny = () => { throw Error('Independent admission recovery proof required'); };

// Positive gate precedes construction of every authenticated boundary. A
// missing active entry alone never releases a pending/crashed recovery.
export function assertP10bRecoveryAdmission({ session, recovery, inspect, now = Date.now() }) {
  const { intent, terminal, verification } = recovery || {};
  if (!Number.isFinite(now) || !intent || !terminal || !verification
    || intent.version !== 'p10b-admission-recovery-intent-v1' || intent.sessionDigest !== digest(session)
    || intent.originalSha256 !== session.recovery?.expectedSha256 || intent.historicalCleanupVerified !== false
    || !/^[a-f0-9]{64}$/.test(intent.attemptSha256 || '')
    || !Number.isSafeInteger(terminal.operatorPid) || terminal.operatorPid < 2 || terminal.operatorPid !== intent.operatorPid
    || !Number.isFinite(Date.parse(intent.intendedAt)) || !Number.isFinite(Date.parse(terminal.retiredAt))
    || Date.parse(intent.intendedAt) < Date.parse(session.startedAt) || Date.parse(terminal.retiredAt) < Date.parse(intent.intendedAt)
    || Date.parse(terminal.retiredAt) > now || terminal.version !== 'p10b-admission-recovery-terminal-v1'
    || terminal.sessionDigest !== digest(session) || terminal.intentDigest !== digest(intent)
    || terminal.originalSha256 !== session.recovery?.expectedSha256 || terminal.archivePath !== session.recovery?.archivePath
    || terminal.activePath !== session.recovery?.activePath || terminal.activeRetired !== true
    || terminal.historicalCleanupVerified !== false || terminal.productionReady !== false
    || verification.version !== 'p10b-independent-recovery-verification-v1' || verification.success !== true
    || verification.terminalDigest !== digest(terminal) || verification.sessionDigest !== digest(session)
    || !Number.isSafeInteger(verification.verifierPid) || verification.verifierPid < 2
    || verification.verifierPid === terminal.operatorPid || verification.archiveSha256 !== terminal.originalSha256
    || !Number.isFinite(Date.parse(verification.verifiedAt)) || now < Date.parse(verification.verifiedAt)
    || now - Date.parse(verification.verifiedAt) > 3600000) deny();
  const observed = inspect();
  if (observed.activeAbsent !== true || observed.archiveSha256 !== terminal.originalSha256
    || observed.archiveDevice !== terminal.archiveDevice || observed.archiveInode !== terminal.archiveInode
    || observed.attemptSha256 !== intent.attemptSha256) deny();
  return true;
}

// The failed current preparation owns a new retained reservation. It cannot
// admit a new phase, but its already approved read-only settlement and exact
// stopped-baseline rollback may continue without retiring that reservation.
export function assertP10bCurrentPhaseSettlement({ session, recovery, inspect, phase, evidenceRoot, now = Date.now() }) {
  const observed = inspect(); const record = observed.activeRecord;
  if (!observed.activeAbsent && (!phase || phase.label !== 'prepare'
    || !record || Object.keys(record).sort().join(',') !== 'evidencePath,packetDigest,reservedAt,version'
    || record.version !== 'p10b-machine-owner-v1' || record.packetDigest !== digest(phase.packet)
    || record.evidencePath !== `${evidenceRoot}/p10b-runtime-only-preparation`
    || !Number.isFinite(Date.parse(record.reservedAt)) || Date.parse(record.reservedAt) < Date.parse(phase.window.issuedAt)
    || Date.parse(record.reservedAt) > Date.parse(phase.window.stopAt) || Date.parse(record.reservedAt) > now)) deny();
  return assertP10bRecoveryAdmission({ session, recovery, inspect: () => ({ ...observed, activeAbsent: true }), now });
}

// Explicit injected filesystem only. The tests provide an in-memory boundary;
// merely importing this module cannot inspect or retire the real reservation.
export function recoverP10bAdmissionReservation({ session, approval, baseline, independentBaseline,
  filesystem: f, clock = () => Date.now(), operatorPid = process.pid }) {
  const expected = session.recovery; const now = clock();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.packetDigest || '') || !/^[a-f0-9]{64}$/.test(expected.expectedSha256 || '')
    || !Number.isFinite(Date.parse(expected.reservedAt)) || new Date(expected.reservedAt).toISOString() !== expected.reservedAt
    || ('version' in expected && expected.version !== 'p10b-machine-owner-v1')
    || approval?.approved !== true || approval.sessionDigest !== digest(session)
    || approval.recoveryApproved !== true || approval.exclusiveAdmissionWriters !== true
    || !Number.isFinite(now) || !Number.isFinite(Date.parse(session.startedAt)) || !Number.isFinite(Date.parse(session.sessionDeadline))
    || now < Date.parse(session.startedAt) || now + 30000 >= Date.parse(session.sessionDeadline)
    || baseline?.state !== 'stopped' || baseline.id !== session.machineId || baseline.region !== 'ewr'
    || baseline.image_ref?.digest !== session.baselineImageDigest || digest(baseline.config) !== digest(session.baselineConfig)
    || independentBaseline?.machineDigest !== digest(baseline) || independentBaseline.independent !== true
    || !Number.isFinite(Date.parse(independentBaseline.observedAt))
    || now - Date.parse(independentBaseline.observedAt) > 30000 || now < Date.parse(independentBaseline.observedAt)
    || !Number.isSafeInteger(operatorPid) || operatorPid < 2) deny();
  const directory = f.statDirectory(expected.directory);
  if (!directory.ownerControlled || directory.symlink) deny();
  const bytes = f.read(expected.activePath); const record = JSON.parse(bytes);
  const stat = f.stat(expected.activePath); const attemptBytes = f.read(expected.attemptPath);
  if (!stat.regular || stat.symlink || sha256(bytes) !== expected.expectedSha256
    || record.version !== 'p10b-machine-owner-v1' || record.packetDigest !== expected.packetDigest
    || record.evidencePath !== expected.evidencePath || record.reservedAt !== expected.reservedAt
    || f.exists(expected.archivePath) || f.exists(expected.intentPath) || f.exists(expected.terminalPath)) deny();
  const intent = { version: 'p10b-admission-recovery-intent-v1', sessionDigest: digest(session),
    originalSha256: expected.expectedSha256, attemptSha256: sha256(attemptBytes),
    baselineDigest: digest(baseline), independentBaselineDigest: digest(independentBaseline), operatorPid,
    intendedAt: new Date(now).toISOString(), historicalCleanupVerified: false };
  f.writeExclusive(expected.intentPath, intent); f.syncFile(expected.intentPath); f.syncDirectoryOf(expected.intentPath);
  f.linkExclusive(expected.activePath, expected.archivePath);
  const archive = f.stat(expected.archivePath);
  if (!archive.regular || archive.symlink || archive.device !== stat.device || archive.inode !== stat.inode
    || archive.mode !== stat.mode || archive.owner !== stat.owner || archive.mtime !== stat.mtime
    || sha256(f.read(expected.archivePath)) !== expected.expectedSha256) deny();
  f.syncFile(expected.archivePath); f.syncDirectoryOf(expected.archivePath);
  const current = f.stat(expected.activePath);
  if (current.device !== stat.device || current.inode !== stat.inode || current.symlink
    || sha256(f.read(expected.activePath)) !== expected.expectedSha256
    || sha256(f.read(expected.attemptPath)) !== intent.attemptSha256
    || !Number.isFinite(clock()) || clock() + 30000 >= Date.parse(session.sessionDeadline)
    || clock() - Date.parse(independentBaseline.observedAt) > 30000 || clock() < now) deny();
  f.unlinkActive(expected.activePath); f.syncDirectoryOf(expected.activePath);
  const terminal = { version: 'p10b-admission-recovery-terminal-v1', sessionDigest: digest(session),
    intentDigest: digest(intent), originalSha256: expected.expectedSha256, activePath: expected.activePath,
    archivePath: expected.archivePath, archiveDevice: archive.device, archiveInode: archive.inode,
    activeRetired: true, operatorPid, retiredAt: new Date(clock()).toISOString(),
    historicalCleanupVerified: false, productionReady: false };
  f.writeExclusive(expected.terminalPath, terminal); f.syncFile(expected.terminalPath); f.syncDirectoryOf(expected.terminalPath);
  return { intent, terminal };
}

export function verifyP10bAdmissionArchive({ session, recovery, inspect, verifierPid = process.pid, now = Date.now() }) {
  const terminal = recovery?.terminal;
  if (!terminal || terminal.operatorPid === verifierPid) deny();
  const observed = inspect();
  const verification = { version: 'p10b-independent-recovery-verification-v1', sessionDigest: digest(session),
    terminalDigest: digest(terminal), archiveSha256: observed.archiveSha256, verifierPid,
    verifiedAt: new Date(now).toISOString(), success: true };
  assertP10bRecoveryAdmission({ session, recovery: { ...recovery, verification }, inspect: () => observed, now });
  return verification;
}
