import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { parseP10bGuestWindow, p10bGuestPaths, readP10bGuestRecord, writeP10bGuestRecord } from './p10bGuestShutdown.js';

export const P10B_GUARDIAN_EXIT_PREFIX = 'P10B_GUARDIAN_CHILD_EXIT ';
const digest = value => sha256(stableCanonicalJson(value));
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const receiptFields = new Set(['version', 'windowDigest', 'stopAt', 'authorityClosed', 'ingressClosed',
  'workerSqliteClosed', 'cleanupUncertain', 'failure', 'productionReady', 'databaseAbsent',
  'databaseIdentityHash', 'outcomeDigest', 'handoffVerified']);
const launchGuardian = ({ environment }) => spawn(process.execPath,
  [fileURLToPath(new URL('../../scripts/run-p10b-guest-guardian.js', import.meta.url))],
  { env: environment, stdio: 'ignore' });

function boundedWrite(output, line, milliseconds) {
  if (milliseconds <= 0) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = success => { if (!settled) { settled = true; clearTimeout(timer); resolve(success); } };
    const timer = setTimeout(() => finish(false), milliseconds);
    try { output.write(line, error => finish(!error)); } catch { finish(false); }
  });
}

// This parent only reaps the guardian's actual OS exit and reports that fact.
// It has no stop API, kill, retry, provider authority or independent run timer.
// The existing guardian child retains all closure/deadline arbitration.
export async function runP10bGuardianParent({ window, databasePath = window.databasePath,
  launch = launchGuardian, output = process.stdout, clock = () => Date.now(),
  monotonic = () => performance.now(), pid = process.pid, exit = code => process.exit(code) } = {}) {
  const paths = p10bGuestPaths(window, databasePath);
  const windowDigest = digest(parseP10bGuestWindow(JSON.stringify(window)));
  const began = monotonic(); const remaining = Date.parse(window.stopAt) - clock();
  const timeLeft = () => Math.min(Date.parse(window.stopAt) - clock(), remaining - (monotonic() - began));
  let record = null;
  try {
    if (clock() < Date.parse(window.issuedAt) || remaining <= window.closureGraceMs + window.stopReserveMs
      || !Number.isSafeInteger(pid) || pid < 2 || Object.values(paths).some(file => fs.existsSync(file))) {
      throw Error('Guardian parent startup is not fresh');
    }
    const parent = { version: 'p10b-guardian-parent-start-v1', windowDigest, pid,
      startedAt: new Date(clock()).toISOString() };
    writeP10bGuestRecord(paths.parentStart, parent);
    // Construct the child's environment solely from public frozen bindings.
    const child = launch({ environment: { FLY_APP_NAME: window.app, FLY_MACHINE_ID: window.machineId,
      P10B_GUEST_WINDOW: stableCanonicalJson(window) } });
    const terminated = await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      child.once('error', () => finish({ code: null, signal: null, spawnFailed: true,
        exitedAt: new Date(clock()).toISOString() }));
      // 'exit' is the OS child status; pipe 'close' is not an exit observation.
      child.once('exit', (code, signal) => finish({ code, signal, spawnFailed: false,
        exitedAt: new Date(clock()).toISOString() }));
    });
    let bindingVerified = false; let startDigest = null; let readyDigest = null; let receiptDigest = null;
    try {
      const start = readP10bGuestRecord(paths.start); const ready = readP10bGuestRecord(paths.ready);
      const receipt = readP10bGuestRecord(paths.receipt);
      bindingVerified = !terminated.spawnFailed && Number.isSafeInteger(child.pid) && child.pid > 1
        && start.pid === child.pid && ready.pid === child.pid && start.windowDigest === windowDigest
        && Object.keys(start).sort().join(',') === 'pid,startedAt,windowDigest'
        && Object.keys(ready).sort().join(',') === 'pid,windowDigest'
        && ready.windowDigest === windowDigest && receipt.windowDigest === windowDigest
        && receipt.stopAt === window.stopAt && receipt.productionReady === false
        && receipt.version === 'p10b-guest-shutdown-receipt-v1'
        && ['authorityClosed', 'ingressClosed', 'workerSqliteClosed', 'cleanupUncertain', 'failure']
          .every(name => typeof receipt[name] === 'boolean')
        && Object.keys(receipt).every(name => receiptFields.has(name))
        && ['databaseAbsent', 'handoffVerified'].every(name => !(name in receipt) || typeof receipt[name] === 'boolean')
        && ['databaseIdentityHash', 'outcomeDigest'].every(name => !(name in receipt)
          || (typeof receipt[name] === 'string' && /^[a-f0-9]{64}$/.test(receipt[name])))
        && canonicalTime(start.startedAt)
        && Date.parse(start.startedAt) >= Date.parse(parent.startedAt)
        && Date.parse(start.startedAt) <= Date.parse(terminated.exitedAt);
      startDigest = digest(start); readyDigest = digest(ready); receiptDigest = digest(receipt);
    } catch { /* Code0 without matching fresh guardian records is not proof. */ }
    record = { version: 'p10b-guardian-child-exit-v1', windowDigest, parentPid: pid,
      guardianPid: child.pid || null, parentStartedAt: parent.startedAt, ...terminated,
      bindingVerified, startDigest, readyDigest, receiptDigest, productionReady: false };
    writeP10bGuestRecord(paths.processExit, record);
    const emitted = await boundedWrite(output, P10B_GUARDIAN_EXIT_PREFIX + JSON.stringify(record) + '\n',
      Math.min(250, Math.max(0, timeLeft())));
    const success = emitted && bindingVerified && terminated.code === 0 && terminated.signal === null
      && Date.parse(terminated.exitedAt) <= Date.parse(window.stopAt) - window.stopReserveMs && timeLeft() > 0;
    exit(success ? 0 : 1);
    return { success, record, parentExitCode: success ? 0 : 1 };
  } catch {
    exit(1);
    return { success: false, record, parentExitCode: 1 };
  }
}
