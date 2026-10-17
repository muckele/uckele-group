import fs from 'node:fs';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { p10bDatabaseIdentity } from './p10bRuntime.js';
import { p10bGuestPaths, readP10bGuestRecord, writeP10bGuestRecord } from './p10bGuestShutdown.js';

const digest = (value) => sha256(stableCanonicalJson(value));

// Only the already isolated, fresh/retained qualification SQLite path is
// admitted. This opens no storage factory, runs no migration and reads no key.
export function closeP10bGuestAuthority(window, databasePath, now) {
  if (!fs.existsSync(databasePath)) return { authorityClosed: true, databaseAbsent: true };
  const phase = window.phase === 'prepare' ? 'start' : 'qualify-start';
  const start = readP10bGuestRecord(`${databasePath}.p10b-${phase}.json`);
  if (start.sourceHead !== window.sourceHead || start.guestWindowDigest !== digest(window)) {
    throw new Error('Guest database provenance changed');
  }
  const identity = p10bDatabaseIdentity(databasePath);
  if (window.phase === 'qualify' && start.databaseIdentityHash !== identity) {
    throw new Error('Guest retained database identity changed');
  }
  const db = new Database(databasePath, { fileMustExist: true, timeout: 100 });
  try {
    return db.transaction(() => {
      const transmissions = db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions').get().count;
      const authorizations = db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_live_provider_authorizations').get().count;
      const activations = db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_capability_activations').get().count;
      if (transmissions > 1 || authorizations > 1 || activations > 128) throw new Error('Unexpected qualification history');
      if (window.phase === 'prepare' && authorizations !== 0) throw new Error('Preparation granted execution authority');
      db.prepare(`UPDATE deal_hunter_cim_live_provider_authorizations SET withdrawn_at=COALESCE(withdrawn_at, ?)`)
        .run(now);
      // No execution grant exists during preparation. Retain its reviewed
      // setup chain for the separately approved qualification window.
      if (window.phase === 'qualify') db.prepare(`UPDATE deal_hunter_cim_capability_activations
        SET status='withdrawn', withdrawn_at=?, updated_at=? WHERE status='current'`).run(now, now);
      const safety = db.prepare(`UPDATE deal_hunter_cim_safety_settings SET outreach_paused=1,
        updated_at=?, updated_by='p10b-guest-guardian' WHERE id='global'`).run(now);
      if (safety.changes !== 1) throw new Error('Pause restoration unavailable');
      db.prepare(`INSERT OR IGNORE INTO deal_hunter_cim_audit_events
        (id,event_type,reason_code,authority_digest,actor,source,occurred_at,metadata)
        VALUES (?, 'p10b-guest-authority-closed', 'p10b-window-closed', ?, 'p10b-guest-guardian',
          'p10b-guest-guardian', ?, '{}')`).run(`p10b-guest:${digest(window)}`, digest(window), now);
      return { authorityClosed: true, databaseIdentityHash: identity };
    }).immediate();
  } finally { db.close(); }
}

// The guardian child owns this timer. It never calls Fly or a provider. Its
// normal exit is reaped by the secret-free configured parent, whose exit lets
// Fly init stop the Machine; the host only observes stopped state. A stalled
// parent/filesystem/guest kernel/init remains outside the operational scope.
export async function runP10bGuestGuardian({ window, databasePath = window.databasePath,
  clock = () => Date.now(), monotonic = () => performance.now(), pid = process.pid,
  signalProcess = process.kill, closeAuthority = closeP10bGuestAuthority,
  pollMs = 20, exit = () => process.exit(0) } = {}) {
  const paths = p10bGuestPaths(window, databasePath);
  const windowDigest = digest(window);
  const remaining = Math.min(Date.parse(window.stopAt) - clock(),
    window.phase === 'prepare' ? 300000 : 900000);
  const began = monotonic();
  let finishPromise; let hardTimer; let failure = null; let finalized = false;
  const timeLeft = () => Math.min(Date.parse(window.stopAt) - clock(), remaining - (monotonic() - began));
  const writeOnce = (file, value) => { if (!fs.existsSync(file)) writeP10bGuestRecord(file, value); };
  const receipt = { version: 'p10b-guest-shutdown-receipt-v1', windowDigest,
    stopAt: window.stopAt, authorityClosed: false, ingressClosed: false,
    workerSqliteClosed: false, cleanupUncertain: true, failure: true, productionReady: false };
  const finish = () => {
    if (!finishPromise) finishPromise = (async () => {
      clearTimeout(hardTimer);
      try { writeOnce(paths.receipt, receipt); } catch { /* No proof can be released. */ }
      exit(receipt);
      return receipt;
    })();
    return finishPromise;
  };
  try {
    if (clock() < Date.parse(window.issuedAt) || remaining <= window.closureGraceMs + window.stopReserveMs) {
      throw new Error('Guest window expired before startup');
    }
    writeP10bGuestRecord(paths.start, { windowDigest, pid, startedAt: new Date(clock()).toISOString() });
    writeP10bGuestRecord(paths.ready, { windowDigest, pid });
    // Independent of async closure/read/handoff promises, including host loss.
    hardTimer = setTimeout(() => { if (!finalized) receipt.cleanupUncertain = true; void finish(); },
      Math.max(1, remaining - window.stopReserveMs));
    while (!fs.existsSync(paths.request) && timeLeft() > window.closureGraceMs + window.stopReserveMs) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!fs.existsSync(paths.request)) writeOnce(paths.request, { windowDigest, failure: true, outcomeDigest: null });
    const request = readP10bGuestRecord(paths.request);
    if (request.windowDigest !== windowDigest) throw new Error('Guest shutdown request changed');
    receipt.failure = request.failure === true;
    writeOnce(paths.cancel, { windowDigest });
    const workerFile = `${databasePath}.p10b-${window.phase}-worker-process.json`;
    if (fs.existsSync(workerFile)) {
      const worker = readP10bGuestRecord(workerFile);
      if (worker.windowDigest !== windowDigest || !Number.isSafeInteger(worker.pid) || worker.pid < 2) {
        throw new Error('Guest worker binding changed');
      }
      try { signalProcess(worker.pid, 'SIGUSR1'); } catch { /* A dead worker has no connection to close. */ }
    }
    try { Object.assign(receipt, closeAuthority(window, databasePath, new Date(clock()).toISOString())); }
    catch { failure = 'authority-close'; }
    const serverPrefix = `${databasePath}.p10b-${window.phase}-server`;
    if (fs.existsSync(`${serverPrefix}.json`)) {
      const server = readP10bGuestRecord(`${serverPrefix}.json`);
      if (server.sourceHead !== window.sourceHead || server.guestWindowDigest !== windowDigest
        || server.app !== window.app || server.machineId !== window.machineId || server.pid < 2) {
        throw new Error('Guest listener binding changed');
      }
      try { signalProcess(server.pid, 'SIGUSR2'); } catch { failure ||= 'listener-unavailable'; }
      const end = monotonic() + Math.min(window.closureGraceMs, Math.max(0, timeLeft() - window.stopReserveMs));
      while (!fs.existsSync(`${serverPrefix}-closed.json`) && monotonic() < end && !finishPromise) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      if (fs.existsSync(`${serverPrefix}-closed.json`)) {
        const closed = readP10bGuestRecord(`${serverPrefix}-closed.json`);
        receipt.ingressClosed = closed.closed === true && closed.guestWindowDigest === windowDigest
          && (!receipt.databaseIdentityHash || closed.databaseIdentityHash === receipt.databaseIdentityHash);
      }
    } else receipt.ingressClosed = receipt.databaseAbsent === true && !fs.existsSync(workerFile);
    if (fs.existsSync(paths.outcome)) {
      const retained = readP10bGuestRecord(paths.outcome);
      if (retained.windowDigest !== windowDigest || (request.outcomeDigest && request.outcomeDigest !== digest(retained.outcome))) {
        throw new Error('Retained candidate changed');
      }
      receipt.outcomeDigest = digest(retained.outcome);
      receipt.workerSqliteClosed = retained.outcome.sqliteClosed === true;
    } else receipt.workerSqliteClosed = !fs.existsSync(workerFile);
    receipt.cleanupUncertain = Boolean(failure || !receipt.authorityClosed || !receipt.ingressClosed || !receipt.workerSqliteClosed);
    receipt.failure = request.failure === true;
    if (finishPromise) return await finishPromise;
    writeP10bGuestRecord(paths.ack, receipt);
    // A final receipt is published only after the worker binds its preserved
    // candidate to these closure facts. Earlier acknowledgments cannot be
    // used by the host to release a final artifact.
    const handoffEnd = monotonic() + Math.min(1000, Math.max(0, timeLeft() - window.stopReserveMs));
    while (!fs.existsSync(paths.handoff) && monotonic() < handoffEnd && !finishPromise) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (finishPromise) return await finishPromise;
    const handoff = readP10bGuestRecord(paths.handoff);
    if (handoff.windowDigest !== windowDigest || !receipt.outcomeDigest
      || handoff.outcomeDigest !== receipt.outcomeDigest) throw new Error('Guest candidate handoff changed');
    receipt.handoffVerified = true;
    writeP10bGuestRecord(paths.receipt, receipt);
    finalized = true;
    // Export completion may accelerate exit but cannot renew the deadline.
    const exportEnd = monotonic() + Math.min(1000, Math.max(0, timeLeft() - window.stopReserveMs));
    while (!fs.existsSync(paths.export) && monotonic() < exportEnd && !finishPromise) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch { if (!finalized) receipt.cleanupUncertain = true; }
  finally { await finish(); }
  return receipt;
}
