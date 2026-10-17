import { createP10bOperatorProcesses, publicP10bCommandFailure } from '../server/services/p10bOperatorProcesses.js';
import path from 'node:path';
import { readP10bPublicJson, inspectP10bRecovery, createP10bOperatorEvidence } from '../server/services/p10bOperatorFiles.js';
import { assertP10bRecoveryAdmission } from '../server/services/p10bAdmissionRecovery.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { openP10bNativeMachineClient } from '../server/services/p10bNativeMachineClient.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { publicP10bNativeFailure } from '../server/services/p10bNativeFailure.js';
import { assertP10bNoEmailHostBinding, assertP10bFlyExecutable } from '../server/services/p10bOperatorSource.js';
import { p10bInheritedAppTokenEnvironment } from '../server/services/p10bHostAuthentication.js';
import { createP10bDemoReadinessBudget, P10B_DEMO_READINESS_RESERVE_MS } from '../server/services/p10bDemoReadiness.js';
import { createP10bParentLease } from '../server/services/p10bParentLease.js';
let processes; let evidence; let sessionDigest; let nativeReapVerified = null;
let stage = 'input-admission'; let lease; let keepAlive; let failureClosure; let mainFinished = false;
function failPrimary(error, failureStage = stage) {
  if (failureClosure) return failureClosure;
  clearInterval(keepAlive);
  failureClosure = (async () => {
    const commandFailure = publicP10bCommandFailure(error); const nativeFailure = publicP10bNativeFailure(error);
    let clientsReaped = false;
    try { clientsReaped = await processes?.reap() === true; } catch { /* retain failed cleanup */ }
    try {
      if (evidence && !evidence.has('p10b-runtime-only-demo-primary-failure.json')) {
        evidence.write('p10b-runtime-only-demo-primary-failure.json', { version: 'p10b-demo-primary-failure-v1',
          sessionDigest, stage: failureStage, commandFailure, nativeFailure, nativeReapVerified, clientsReaped,
          at: new Date().toISOString(), productionReady: false });
      }
    } finally {
      process.stderr.write('Demo primary failed; no proof admitted.\n'); process.exitCode = 1;
      if (mainFinished) lease?.close();
    }
  })();
  return failureClosure;
}
try {
  if (process.argv.length !== 3) throw Error();
  lease = createP10bParentLease({ owner: process, onLoss: () => failPrimary(null, 'parent-lease-loss') });
  const { session, approval, phase, recovery, flyExecutable, nativeExecutable, machine } = readP10bPublicJson(process.argv[2]);
  assertP10bNoEmailApproval(session, approval, Date.now());
  assertP10bNoEmailHostBinding(session);
  assertP10bFlyExecutable(session, flyExecutable);
  assertP10bFrozenPhase(session, phase); if (phase.label !== 'demo') throw Error();
  evidence = createP10bOperatorEvidence(path.dirname(path.resolve(process.argv[2])));
  sessionDigest = sha256(stableCanonicalJson(session));
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')) throw Error();
  assertP10bRecoveryAdmission({ session, recovery, inspect: () => inspectP10bRecovery(session) });
  const window = phase.window;
  const readinessRemaining = createP10bDemoReadinessBudget(evidence.read('p10b-runtime-only-demo-start-intent.json'), phase,
    { clock: () => Date.now(), monotonicClock: () => performance.now() });
  if (Date.now() < Date.parse(window.issuedAt) || Date.now() - Date.parse(window.issuedAt) > 60000
    || Date.parse(window.stopAt) - Date.now() < 240000) throw Error();
  const environment = p10bInheritedAppTokenEnvironment({ session, approval });
  lease.assertActive();
  processes = createP10bOperatorProcesses({ environment });
  stage = 'native-initialization';
  const native = await openP10bNativeMachineClient({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config], environment });
  let checked; let reaped;
  stage = 'native-baseline-read';
  try { lease.assertActive(); checked = await native.client(); }
  finally { reaped = await native.reap(); nativeReapVerified = reaped === true; }
  stage = 'native-baseline-verification';
  if (!reaped || checked.state !== 'stopped' || checked.instance_id !== machine.instance_id || stableCanonicalJson(checked.config) !== stableCanonicalJson(phase.config)) throw Error();
  lease.assertActive();
  evidence.write('p10b-runtime-only-demo-actual-start.json', { at: new Date().toISOString(), instanceId: checked.instance_id });
  if (Date.now() - Date.parse(window.issuedAt) > 60000 || Date.parse(window.stopAt) - Date.now() < 240000) throw Error();
  stage = 'machine-start-command';
  lease.assertActive();
  await processes.command(flyExecutable, ['machine', 'start', session.machineId, '--app', session.app],
    Math.min(10000, readinessRemaining(P10B_DEMO_READINESS_RESERVE_MS)));
  stage = 'readiness-command';
  lease.assertActive();
  const output = await processes.command(flyExecutable, ['ssh', 'console', '--app', session.app,
    '--machine', session.machineId, '--quiet', '--command', 'node /app/scripts/read-p10b-public-readiness.js'],
    readinessRemaining(P10B_DEMO_READINESS_RESERVE_MS));
  stage = 'readiness-json';
  lease.assertActive();
  readinessRemaining();
  const readiness = JSON.parse(output);
  stage = 'publish-primary-readiness';
  lease.assertActive();
  readinessRemaining();
  evidence.write('p10b-runtime-only-demo-primary-readiness.json', { version: 'p10b-demo-primary-readiness-v1',
    sessionDigest, windowDigest: sha256(stableCanonicalJson(window)), readinessDigest: sha256(stableCanonicalJson(readiness)),
    readinessParsed: true, at: new Date().toISOString(), productionReady: false });
  stage = 'readiness-ipc';
  lease.assertActive();
  const ipcTimeout = Math.min(500, readinessRemaining());
  if (typeof process.send !== 'function') throw Error('Primary IPC unavailable');
  // A failed asynchronous send otherwise emits an unhandled process error,
  // outside this catch. The callback confirms transport submission only; the
  // parent's separate received-readiness artifact remains required for proof.
  let ipcTimer;
  try {
    await new Promise((resolve, reject) => {
      ipcTimer = setTimeout(() => reject(Error('Primary IPC submission timed out')), ipcTimeout);
      process.send(readiness, error => error ? reject(Error('Primary IPC submission failed')) : resolve());
    });
  } finally { clearTimeout(ipcTimer); }
  readinessRemaining();
  lease.assertActive();
  keepAlive = setInterval(() => {}, 1000);
} catch (error) {
  await failPrimary(error);
} finally {
  mainFinished = true;
  if (failureClosure) lease?.close();
}
