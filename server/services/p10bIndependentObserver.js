import { createJsonObjectFramer, startObserverCadence } from './p10bRuntimeObservation.js';
import { createP10bObserverControls } from './p10bRuntimeObserver.js';
import { openP10bNativeMachineClient } from './p10bNativeMachineClient.js';
import { createP10bOperatorProcesses } from './p10bOperatorProcesses.js';
import { assertP10bRecoveryAdmission } from './p10bAdmissionRecovery.js';
import { inspectP10bRecovery } from './p10bOperatorFiles.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from './p10bRuntimeOnlyOperator.js';
import { p10bInheritedAppTokenEnvironment } from './p10bHostAuthentication.js';
import { sanitizeP10bGuardianLog } from './p10bRuntimeObserver.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bFlyExecutable } from './p10bOperatorSource.js';

export async function runP10bIndependentObserver({ session, approval, phase, machine, nativeExecutable, recovery,
  flyExecutable = session?.flyExecutable?.path, openNative = openP10bNativeMachineClient,
  processes, environment, record, attached = () => {},
  clock = () => Date.now(), interval = globalThis.setInterval, clear = globalThis.clearInterval,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), inspectRecovery = () => inspectP10bRecovery(session) }) {
  assertP10bNoEmailApproval(session, approval, clock()); assertP10bFrozenPhase(session, phase);
  assertP10bFlyExecutable(session, flyExecutable);
  assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
  if (!environment && openNative === openP10bNativeMachineClient) environment = p10bInheritedAppTokenEnvironment({ session, approval, clock });
  processes ||= createP10bOperatorProcesses({ environment });
  const native = await openNative({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config], environment });
  const controls = createP10bObserverControls({ phase, machine, client: native.client, record, clock });
  let timer; let logFailed = false; let logReads = 0;
  const seen = new Set();
  const pollLogs = async (timeoutMs = 5000) => {
    if (++logReads > 410) throw Error('Log poll bound exceeded');
    const output = await processes.command(flyExecutable,
      ['logs', '--app', session.app, '--instance', session.machineId, '--json', '--no-tail'], timeoutMs);
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
  };
  try {
    const cadence = startObserverCadence(controls.tick, { setInterval: interval }); timer = cadence.timer;
    await cadence.initial;
    await pollLogs();
    if (!controls.attached()) throw Error('Independent observer initial stopped observation failed');
    record({ kind: 'log-source-ready', mode: 'bounded-read-only-poll', at: new Date(clock()).toISOString() });
    attached({ attached: true, separateSession: true, observerPid: process.pid,
      instanceId: machine.instance_id, imageDigest: machine.image_ref.digest });
    const end = Date.parse(phase.window.stopAt); let due = clock();
    while (clock() < end) {
      due = Math.min(due + 750, end);
      await wait(Math.max(1, due - clock()));
      if (clock() - due > 250) { logFailed = true; record({ kind: 'observer-log-missed-poll', at: new Date(clock()).toISOString() }); }
      const remaining = Math.min(end + 750, Date.parse(session.sessionDeadline)) - clock();
      try {
        if (remaining <= 0) throw Error('Log observation deadline expired');
        await pollLogs(Math.min(700, remaining));
        if (clock() - due > 750 || clock() > end + 750) throw Error('Log observation completion late');
      }
      catch { logFailed = true; record({ kind: 'observer-log-read-error', at: new Date(clock()).toISOString() }); }
      if (clock() - due > 1000) due = clock();
    }
    // Keep the independently anchored metadata cadence through one final
    // post-window tick, even when the last finite log read returns instantly.
    if (clock() < end + 750) await wait(end + 750 - clock());
    clear(timer); timer = undefined;
    const reaped = await controls.finish({ normalCompletion: !logFailed, reap: async () => {
      const local = await processes.reap(); const authenticated = await native.reap(); return local && authenticated;
    } });
    return reaped && !logFailed;
  } finally {
    if (timer) clear(timer);
    await processes.reap(); await native.reap();
  }
}
