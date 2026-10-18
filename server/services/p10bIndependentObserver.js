import { createP10bObserverControls } from './p10bRuntimeObserver.js';
import { openP10bNativeMachineClient, openP10bNativeLogClient } from './p10bNativeMachineClient.js';
import { createP10bOperatorProcesses } from './p10bOperatorProcesses.js';
import { publicP10bNativeLogFailure } from './p10bNativeFailure.js';
import { assertP10bRecoveryAdmission } from './p10bAdmissionRecovery.js';
import { inspectP10bRecovery } from './p10bOperatorFiles.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from './p10bRuntimeOnlyOperator.js';
import { p10bInheritedAppTokenEnvironment } from './p10bHostAuthentication.js';
import { sanitizeP10bGuardianLog } from './p10bRuntimeObserver.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { P10B_OBSERVER_POLICY, startP10bMetadataSampling, createP10bObserverCleanup, verifyP10bObserverCompletion } from './p10bObserverPolicy.js';
import { assertP10bFlyExecutable } from './p10bOperatorSource.js';

function waitForObserver(ms, signal) {
  return new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    if (signal?.aborted) { resolve(); return; }
    timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runP10bIndependentObserver({ session, approval, phase, machine, nativeExecutable, recovery,
  flyExecutable = session?.flyExecutable?.path, openNative = openP10bNativeMachineClient, openLogs = openP10bNativeLogClient,
  processes, environment, record, attached = () => {},
  clock = () => Date.now(),
  monotonicClock = () => performance.now(), signal,
  wait = waitForObserver, inspectRecovery = () => inspectP10bRecovery(session) }) {
  const stopAt = Date.parse(phase.window.stopAt); const began = clock(); const elapsedBegan = monotonicClock();
  // Preserve the metadata policy's final request tail and reply/precision
  // allowance. Log polling keeps its separate, earlier stopAt+750 deadline.
  const wallEnd = Math.min(stopAt + P10B_OBSERVER_POLICY.finalDispatchTailMs + P10B_OBSERVER_POLICY.maximumGapMs,
    Date.parse(session.sessionDeadline) - P10B_OBSERVER_POLICY.cleanupTimeoutMs);
  const elapsedEnd = elapsedBegan + Math.max(0, wallEnd - began);
  const logEnd = Math.min(stopAt + 750, Date.parse(session.sessionDeadline));
  const remaining = () => Math.min(wallEnd - clock(), elapsedEnd - monotonicClock());
  const logRemaining = () => Math.min(remaining(), logEnd - clock(), elapsedBegan + logEnd - began - monotonicClock());
  const assertActive = () => { if (signal?.aborted || remaining() <= 0) throw Error('Observer lifetime ended'); };
  const waitController = new AbortController();
  const boundedWait = ms => wait(Math.min(ms, Math.max(1, remaining())), waitController.signal);
  assertActive();
  assertP10bNoEmailApproval(session, approval, clock()); assertP10bFrozenPhase(session, phase);
  assertP10bFlyExecutable(session, flyExecutable);
  assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
  if (!environment && (openNative === openP10bNativeMachineClient || openLogs === openP10bNativeLogClient)) environment = p10bInheritedAppTokenEnvironment({ session, approval, clock });
  processes ||= createP10bOperatorProcesses({ environment });
  const native = await openNative({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config], environment, signal });
  const rows = []; const publish = row => { record(row); rows.push(row); };
  const controls = createP10bObserverControls({ phase, machine, client: native.client, record: publish, clock });
  let logs; let logInitializationReaped = true; let reapBatch;
  const reapAll = () => {
    if (!reapBatch) {
      // Start every owned reap before awaiting any one reader. One hanging or
      // throwing child cannot prevent the other from entering bounded cleanup.
      const readers = [native, ...(logs ? [logs] : [])];
      reapBatch = Promise.allSettled([Promise.resolve().then(() => processes.reap()),
        ...readers.map(reader => Promise.resolve().then(() => reader.reap()))]).then(results => ({
        processesReaped: results[0].status === 'fulfilled' && results[0].value === true,
        nativeReaped: logInitializationReaped && results.slice(1).every(result => result.status === 'fulfilled' && result.value === true),
      }));
    }
    return reapBatch;
  };
  // Scope cleanup before starting the second reader. Its initialization must
  // settle before final cleanup snapshots ownership, including cancellation.
  const cleanup = createP10bObserverCleanup({ processes: { async reap() { return (await reapAll()).processesReaped; } },
    native: { async reap() { return (await reapAll()).nativeReaped; } }, clock,
    sessionDeadline: session.sessionDeadline, window: phase.window });
  let sampler; let logFailed = false; let logReads = 0; let logStage = 'native-initialization';
  const seen = new Set();
  const stopSampling = () => { sampler?.abort(); waitController.abort(); };
  const cancel = () => { stopSampling(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const reportLogFailure = error => publish({ kind: 'observer-log-read-error', at: new Date(clock()).toISOString(),
    stage: logStage, nativeFailure: publicP10bNativeLogFailure(error) });
  const pollLogs = async (timeoutMs = 5000) => {
    if (++logReads > P10B_OBSERVER_POLICY.maximumLogReads) throw Error('Log poll bound exceeded');
    const requestedAt = new Date(clock()).toISOString(); let success = false;
    try {
      assertActive();
      logStage = 'native-read';
      const timeout = Math.min(timeoutMs, Math.floor(logRemaining()));
      if (timeout < 1) throw Error('Log observation deadline expired');
      const output = await logs.client('GET', undefined, timeout);
      assertActive();
      logStage = 'validation';
      if (!Array.isArray(output) || output.length > 128) throw Error('Invalid public log response');
      for (const row of output) {
        if (!row || Object.keys(row).sort().join(',') !== 'instance,message,region,timestamp') throw Error('Invalid public log row');
        const safe = sanitizeP10bGuardianLog(row, phase.window);
        if (!safe) throw Error('Invalid public guardian log');
        // Preserve original provider timestamp precision when deduplicating.
        // Only admitted public guardian fields are hashed, never app log text.
        const key = sha256(stableCanonicalJson({ ...safe, timestamp: row.timestamp }));
        if (!seen.has(key)) {
          if (seen.size >= 128) throw Error('Guardian log record bound exceeded');
          seen.add(key); controls.log(row);
        }
      }
      logStage = 'completion';
      success = true;
    } finally { publish({ kind: 'observer-log-poll', requestedAt, at: new Date(clock()).toISOString(), success }); }
  };
  try {
    publish({ kind: 'observer-policy', version: P10B_OBSERVER_POLICY.version, windowDigest: sha256(stableCanonicalJson(phase.window)), sessionDigest: sha256(stableCanonicalJson(session)),
      policyDigest: sha256(stableCanonicalJson(P10B_OBSERVER_POLICY)), sessionDeadline: session.sessionDeadline, at: new Date(clock()).toISOString() });
    assertActive();
    sampler = startP10bMetadataSampling({ window: phase.window, sessionDeadline: session.sessionDeadline,
      tick: () => { assertActive(); return controls.tick(); }, record: publish, clock, wait: boundedWait });
    if (!await sampler.initial) throw Error('Independent observer initial metadata sample failed');
    try {
      assertActive(); logInitializationReaped = false;
      logs = await openLogs({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config], environment, signal });
      logInitializationReaped = true;
      assertActive();
      if (!sampler.healthy() || !controls.healthy() || !controls.attached()) throw Error('Initial metadata changed during log initialization');
      await pollLogs();
    } catch (error) {
      if (!logs) logInitializationReaped = Object.getOwnPropertyDescriptor(error ?? {}, 'reapVerified')?.value === true;
      logFailed = true; reportLogFailure(error); throw error;
    }
    if (!sampler.healthy() || !controls.healthy() || !controls.attached()) throw Error('Independent observer initial stopped observation failed');
    publish({ kind: 'log-source-ready', mode: 'bounded-read-only-poll', at: new Date(clock()).toISOString() });
    if (!sampler.healthy() || !controls.healthy()) throw Error('Independent observer attachment became stale');
    assertActive();
    await attached({ attached: true, separateSession: true, observerPid: process.pid,
      instanceId: machine.instance_id, imageDigest: machine.image_ref.digest });
    assertActive();
    const end = Date.parse(phase.window.stopAt); let due = clock();
    while (clock() < end) {
      if (signal?.aborted || logRemaining() <= 0 || logReads >= P10B_OBSERVER_POLICY.maximumLogReads) {
        logFailed = true; stopSampling();
        publish({ kind: 'observer-log-read-error', at: new Date(clock()).toISOString(), stage: 'lifetime', nativeFailure: null }); break;
      }
      due = Math.min(due + 750, end);
      await boundedWait(Math.min(Math.max(1, due - clock()), Math.max(1, logRemaining())));
      if (clock() - due > 250) { logFailed = true; publish({ kind: 'observer-log-missed-poll', at: new Date(clock()).toISOString() }); }
      const left = logRemaining();
      try {
        if (left <= 0) throw Error('Log observation deadline expired');
        await pollLogs(Math.min(700, Math.floor(left)));
        if (clock() - due > 750 || clock() > end + 750) throw Error('Log observation completion late');
      }
      catch (error) { logFailed = true; reportLogFailure(error); stopSampling(); break; }
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
    signal?.removeEventListener('abort', cancel);
    stopSampling();
    // Drain the only metadata task before cleanup; no background writer survives.
    try { await sampler?.done; } finally { await cleanup(); }
  }
}
