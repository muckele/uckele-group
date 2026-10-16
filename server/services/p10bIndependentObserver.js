import { createJsonObjectFramer } from './p10bRuntimeObservation.js';
import { createP10bObserverControls } from './p10bRuntimeObserver.js';
import { openP10bNativeMachineClient } from './p10bNativeMachineClient.js';
import { createP10bOperatorProcesses, publicP10bCommandFailure } from './p10bOperatorProcesses.js';
import { assertP10bRecoveryAdmission } from './p10bAdmissionRecovery.js';
import { inspectP10bRecovery } from './p10bOperatorFiles.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from './p10bRuntimeOnlyOperator.js';
import { p10bInheritedAppTokenEnvironment } from './p10bHostAuthentication.js';
import { sanitizeP10bGuardianLog } from './p10bRuntimeObserver.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { P10B_OBSERVER_POLICY, startP10bMetadataSampling, createP10bObserverCleanup, verifyP10bObserverCompletion } from './p10bObserverPolicy.js';
import { assertP10bFlyExecutable } from './p10bOperatorSource.js';

export async function runP10bIndependentObserver({ session, approval, phase, machine, nativeExecutable, recovery,
  flyExecutable = session?.flyExecutable?.path, openNative = openP10bNativeMachineClient,
  processes, environment, record, attached = () => {},
  clock = () => Date.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), inspectRecovery = () => inspectP10bRecovery(session) }) {
  assertP10bNoEmailApproval(session, approval, clock()); assertP10bFrozenPhase(session, phase);
  assertP10bFlyExecutable(session, flyExecutable);
  assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
  if (!environment && openNative === openP10bNativeMachineClient) environment = p10bInheritedAppTokenEnvironment({ session, approval, clock });
  processes ||= createP10bOperatorProcesses({ environment });
  const native = await openNative({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config], environment });
  const rows = []; const publish = row => { record(row); rows.push(row); };
  const controls = createP10bObserverControls({ phase, machine, client: native.client, record: publish, clock });
  const cleanup = createP10bObserverCleanup({ processes, native, clock, sessionDeadline: session.sessionDeadline, window: phase.window });
  let sampler; let logFailed = false; let logReads = 0; let logStage = 'command';
  const seen = new Set();
  const pollLogs = async (timeoutMs = 5000) => {
    if (++logReads > 410) throw Error('Log poll bound exceeded');
    const requestedAt = new Date(clock()).toISOString(); let success = false;
    try {
      logStage = 'command';
      const output = await processes.command(flyExecutable,
        ['logs', '--app', session.app, '--instance', session.machineId, '--json', '--no-tail'], timeoutMs);
      logStage = 'framing';
      const framer = createJsonObjectFramer(row => {
        const safe = sanitizeP10bGuardianLog(row, phase.window);
        if (!safe) return;
        // Preserve original provider timestamp precision when deduplicating.
        // Only admitted public guardian fields are hashed, never app log text.
        const key = sha256(stableCanonicalJson({ ...safe, timestamp: row.timestamp ?? row.time }));
        if (!seen.has(key)) {
          if (seen.size >= 128) throw Error('Guardian log record bound exceeded');
          seen.add(key); controls.log(row);
        }
      });
      framer.write(output); framer.finish();
      logStage = 'completion';
      success = true;
    } finally { publish({ kind: 'observer-log-poll', requestedAt, at: new Date(clock()).toISOString(), success }); }
  };
  try {
    publish({ kind: 'observer-policy', version: P10B_OBSERVER_POLICY.version, windowDigest: sha256(stableCanonicalJson(phase.window)), sessionDigest: sha256(stableCanonicalJson(session)),
      policyDigest: sha256(stableCanonicalJson(P10B_OBSERVER_POLICY)), sessionDeadline: session.sessionDeadline, at: new Date(clock()).toISOString() });
    sampler = startP10bMetadataSampling({ window: phase.window, sessionDeadline: session.sessionDeadline,
      tick: controls.tick, record: publish, clock, wait });
    if (!await sampler.initial) throw Error('Independent observer initial metadata sample failed');
    await pollLogs();
    if (!sampler.healthy() || !controls.healthy() || !controls.attached()) throw Error('Independent observer initial stopped observation failed');
    publish({ kind: 'log-source-ready', mode: 'bounded-read-only-poll', at: new Date(clock()).toISOString() });
    if (!sampler.healthy() || !controls.healthy()) throw Error('Independent observer attachment became stale');
    attached({ attached: true, separateSession: true, observerPid: process.pid,
      instanceId: machine.instance_id, imageDigest: machine.image_ref.digest });
    const end = Date.parse(phase.window.stopAt); let due = clock();
    while (clock() < end) {
      due = Math.min(due + 750, end);
      await wait(Math.max(1, due - clock()));
      if (clock() - due > 250) { logFailed = true; publish({ kind: 'observer-log-missed-poll', at: new Date(clock()).toISOString() }); }
      const remaining = Math.min(end + 750, Date.parse(session.sessionDeadline)) - clock();
      try {
        if (remaining <= 0) throw Error('Log observation deadline expired');
        await pollLogs(Math.min(700, remaining));
        if (clock() - due > 750 || clock() > end + 750) throw Error('Log observation completion late');
      }
      catch (error) { logFailed = true; publish({ kind: 'observer-log-read-error', at: new Date(clock()).toISOString(),
        stage: logStage, commandFailure: publicP10bCommandFailure(error) }); }
      if (clock() - due > 1000) due = clock();
    }
    const samplingResult = await sampler.done;
    const sampling = { kind: 'observer-sampling-finished', version: P10B_OBSERVER_POLICY.version,
      windowDigest: sha256(stableCanonicalJson(phase.window)), sessionDigest: sha256(stableCanonicalJson(session)), policyDigest: sha256(stableCanonicalJson(P10B_OBSERVER_POLICY)),
      at: new Date(clock()).toISOString(), ...samplingResult, normalCompletion: samplingResult.normalCompletion && !logFailed, logReads };
    publish(sampling);
    const result = await cleanup();
    publish({ kind: 'observer-finished', version: P10B_OBSERVER_POLICY.version, windowDigest: sha256(stableCanonicalJson(phase.window)), sessionDigest: sha256(stableCanonicalJson(session)),
      samplingDigest: sha256(stableCanonicalJson(sampling)), ...result, normalCompletion: result.normalCompletion && sampling.normalCompletion });
    return verifyP10bObserverCompletion(rows, { window: phase.window, sessionDeadline: session.sessionDeadline, sessionDigest: sha256(stableCanonicalJson(session)) });
  } finally {
    sampler?.abort();
    // Drain the only metadata task before cleanup; no background writer survives.
    try { await sampler?.done; } finally { await cleanup(); }
  }
}
