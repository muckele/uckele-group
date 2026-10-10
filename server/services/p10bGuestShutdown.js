import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sha256, stableCanonicalJson } from '../utils/security.js';

export const P10B_GUEST_PROCESSES = [
  { exec: ['node', 'server/index.js'] },
  { exec: ['node', 'scripts/run-p10b-guest-guardian-parent.js'], ignore_app_secrets: true },
];
const digest = (value) => sha256(stableCanonicalJson(value));
const canonicalDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export function p10bGuestWindow(packet) {
  const g = packet?.guest;
  const start = Date.parse(g?.issuedAt); const stop = Date.parse(g?.stopAt);
  const maximum = packet?.operation === 'prepare' ? 300000 : packet?.manifest?.maximumRuntimeMs;
  if (!g || Object.keys(g).sort().join(',') !== 'closureGraceMs,issuedAt,stopAt,stopReserveMs'
    || !canonicalDate(g.issuedAt) || !canonicalDate(g.stopAt) || stop <= start
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 900000
    || stop - start > maximum || ![g.closureGraceMs, g.stopReserveMs]
      .every((ms) => Number.isSafeInteger(ms) && ms > 0 && ms <= 30000)
    || stop - start <= g.closureGraceMs + g.stopReserveMs
    || (packet.operation === 'qualify' && (g.issuedAt !== packet.manifest.issuedAt
      || stop !== Math.min(Date.parse(packet.manifest.expiresAt), start + maximum)))) {
    throw new Error('Frozen guest shutdown window is invalid');
  }
  return { version: 'p10b-guest-window-v1', app: packet.target.app, machineId: packet.target.machineId,
    imageDigest: packet.target.imageDigest, sourceHead: packet.sourceHead, phase: packet.operation,
    databasePath: packet.databasePath, runBinding: digest({ ownerPermissionDigest: packet.ownerPermissionDigest,
      identity: packet.operation === 'prepare' ? packet.runId : packet.manifest.transmissionId }), ...g };
}

export function parseP10bGuestWindow(value, runtime) {
  const w = JSON.parse(value);
  if (!w || Object.keys(w).sort().join(',') !== 'app,closureGraceMs,databasePath,imageDigest,issuedAt,machineId,phase,runBinding,sourceHead,stopAt,stopReserveMs,version'
    || w.version !== 'p10b-guest-window-v1' || w.app !== 'uckele-group-p10b'
    || w.machineId !== '0803730bd1d7e8' || !['prepare', 'qualify'].includes(w.phase)
    || !/^[0-9a-f]{40}$/.test(w.sourceHead || '') || !/^sha256:[0-9a-f]{64}$/.test(w.imageDigest || '')
    || !/^[0-9a-f]{64}$/.test(w.runBinding || '')
    || !/^\/data\/p10b-first-mailbox-[a-z0-9-]{1,80}\.sqlite$/.test(w.databasePath || '')
    || !canonicalDate(w.issuedAt) || !canonicalDate(w.stopAt)
    || Date.parse(w.stopAt) - Date.parse(w.issuedAt) > (w.phase === 'prepare' ? 300000 : 900000)
    || Date.parse(w.stopAt) - Date.parse(w.issuedAt) <= w.closureGraceMs + w.stopReserveMs
    || ![w.closureGraceMs, w.stopReserveMs].every((ms) => Number.isSafeInteger(ms) && ms > 0 && ms <= 30000)
    || (runtime && (w.app !== runtime.app || w.machineId !== runtime.machineId || w.sourceHead !== runtime.sourceHead))) {
    throw new Error('Guest runtime shutdown binding is invalid');
  }
  return w;
}

export function p10bGuestPaths(window, databasePath = window.databasePath) {
  const prefix = `${databasePath}.p10b-${window.phase}-guardian`;
  return { ...Object.fromEntries(['start', 'ready', 'request', 'ack', 'receipt', 'outcome', 'handoff', 'export', 'cancel']
    .map((name) => [name, `${prefix}-${name}.json`])),
  parentStart: `${prefix}-parent-start.json`, processExit: `${prefix}-process-exit.json` };
}

// Freshness inventory for future no-send runs. The active guardian's three
// startup records already exist at the first SSH observation and are verified
// separately; every other marker and both phases on the unused path must be absent.
export function p10bGuestFreshPathInventory(databasePaths, { activeDatabasePath, activePhase } = {}) {
  return databasePaths.flatMap(databasePath => [databasePath, `${databasePath}-wal`, `${databasePath}-shm`,
    ...['start', 'preparation', 'qualify-start', 'qualify-worker'].map(name => `${databasePath}.p10b-${name}.json`),
    ...['prepare', 'qualify'].flatMap(phase => [
      ...Object.entries(p10bGuestPaths({ phase }, databasePath))
        .filter(([name]) => !(databasePath === activeDatabasePath && phase === activePhase
          && ['start', 'ready', 'parentStart'].includes(name))).map(([, file]) => file),
      ...['worker-process', 'server', 'server-closed'].map(name => `${databasePath}.p10b-${phase}-${name}.json`),
    ]),
  ]);
}

export function writeP10bGuestRecord(file, value, fileSystem = fs) {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 65536) throw new Error('Guest evidence exceeds bound');
  const pending = `${file}.pending-${randomUUID()}`;
  const fd = fileSystem.openSync(pending, 'wx', 0o600);
  try {
    try { fileSystem.writeFileSync(fd, bytes); fileSystem.fsyncSync(fd); }
    finally { fileSystem.closeSync(fd); }
    // Exclusive link publishes complete, synced bytes atomically. Readers
    // cannot observe an empty/partial record; existing evidence is retained.
    fileSystem.linkSync(pending, file);
  } finally {
    // Publication is the commit point. A private temporary-file removal
    // failure cannot turn its immutable published facts into a stale receipt.
    try { fileSystem.unlinkSync(pending); } catch { /* Retain private bytes if removal fails. */ }
  }
}

export function readP10bGuestRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid guest evidence');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function assertP10bGuestReady({ window, databasePath, timeoutMs = 2000,
  clock = () => Date.now(), signalProcess = process.kill } = {}) {
  const paths = p10bGuestPaths(window, databasePath);
  const end = Date.now() + timeoutMs;
  do {
    if (clock() >= Date.parse(window.stopAt) - window.stopReserveMs - window.closureGraceMs
      || fs.existsSync(paths.request) || fs.existsSync(paths.receipt)) throw new Error('Guest window is closing');
    if (fs.existsSync(paths.ready) && fs.existsSync(paths.parentStart)) {
      const ready = readP10bGuestRecord(paths.ready);
      const parent = readP10bGuestRecord(paths.parentStart);
      const start = readP10bGuestRecord(paths.start);
      if (ready.windowDigest !== digest(window) || !Number.isSafeInteger(ready.pid) || ready.pid < 2
        || parent.windowDigest !== digest(window) || parent.version !== 'p10b-guardian-parent-start-v1'
        || !Number.isSafeInteger(parent.pid) || parent.pid < 2 || parent.pid === ready.pid
        || start.pid !== ready.pid || start.windowDigest !== digest(window)
        || !canonicalDate(parent.startedAt) || !canonicalDate(start.startedAt)
        || Date.parse(parent.startedAt) < Date.parse(window.issuedAt)
        || Date.parse(parent.startedAt) > Date.parse(start.startedAt) || fs.existsSync(paths.processExit)) {
        throw new Error('Guardian readiness changed');
      }
      signalProcess(parent.pid, 0);
      signalProcess(ready.pid, 0);
      return ready;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < end);
  throw new Error('Guest guardian is unavailable');
}

export async function requestP10bGuestShutdown({ window, databasePath, outcome, failure = false,
  timeoutMs = 1000 } = {}) {
  const paths = p10bGuestPaths(window, databasePath);
  const windowDigest = digest(window);
  if (outcome && !fs.existsSync(paths.outcome)) writeP10bGuestRecord(paths.outcome, { windowDigest, outcome });
  if (!fs.existsSync(paths.request)) writeP10bGuestRecord(paths.request, { windowDigest, failure,
    outcomeDigest: outcome ? digest(outcome) : null });
  const end = Date.now() + timeoutMs;
  let handedOff = false;
  do {
    if (!handedOff && fs.existsSync(paths.ack)) {
      const ack = readP10bGuestRecord(paths.ack);
      if (ack.windowDigest !== windowDigest || ack.outcomeDigest !== digest(outcome)) {
        throw new Error('Guest closure acknowledgment changed');
      }
      if (!fs.existsSync(paths.handoff)) writeP10bGuestRecord(paths.handoff, { windowDigest, outcomeDigest: digest(outcome) });
      const handoff = readP10bGuestRecord(paths.handoff);
      if (handoff.windowDigest !== windowDigest || handoff.outcomeDigest !== digest(outcome)) {
        throw new Error('Guest candidate handoff changed');
      }
      handedOff = true;
    }
    if (fs.existsSync(paths.receipt)) {
      const receipt = readP10bGuestRecord(paths.receipt);
      if (receipt.windowDigest !== windowDigest) throw new Error('Guest shutdown receipt changed');
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  throw new Error('Guest shutdown acknowledgment is unavailable');
}

export function completeP10bGuestHandoff(window, databasePath) {
  const paths = p10bGuestPaths(window, databasePath);
  if (!fs.existsSync(paths.export)) writeP10bGuestRecord(paths.export, { windowDigest: digest(window) });
}
