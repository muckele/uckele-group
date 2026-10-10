import { createJsonObjectFramer, startObserverCadence } from './p10bRuntimeObservation.js';
import { createP10bObserverControls } from './p10bRuntimeObserver.js';
import { openP10bNativeMachineClient } from './p10bNativeMachineClient.js';
import { createP10bOperatorProcesses } from './p10bOperatorProcesses.js';
import { assertP10bRecoveryAdmission } from './p10bAdmissionRecovery.js';
import { inspectP10bRecovery } from './p10bOperatorFiles.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from './p10bRuntimeOnlyOperator.js';

export async function runP10bIndependentObserver({ session, approval, phase, machine, nativeExecutable, recovery,
  flyExecutable = '/opt/homebrew/bin/fly', openNative = openP10bNativeMachineClient,
  processes = createP10bOperatorProcesses(), record, attached = () => {},
  clock = () => Date.now(), interval = globalThis.setInterval, clear = globalThis.clearInterval,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), inspectRecovery = () => inspectP10bRecovery(session) }) {
  assertP10bNoEmailApproval(session, approval, clock()); assertP10bFrozenPhase(session, phase);
  assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
  const native = await openNative({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config] });
  const controls = createP10bObserverControls({ phase, machine, client: native.client, record, clock });
  let timer; let logs; let bytes = 0; let parseFailed = false; let logsExited = false; let logsAttached = false;
  const framer = createJsonObjectFramer(row => { logsAttached = true; controls.log(row); });
  try {
    logs = processes.launch(flyExecutable, ['logs', '--app', session.app, '--instance', session.machineId, '--json']);
    logs.child.stdin.end();
    logs.child.stdout.on('data', chunk => { bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { parseFailed = true; record({ kind: 'observer-parse-error', at: new Date(clock()).toISOString() }); void processes.terminate(logs); return; }
      try { framer.write(chunk); } catch { if (!parseFailed) record({ kind: 'observer-parse-error', at: new Date(clock()).toISOString() }); parseFailed = true; }
    });
    logs.child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) void processes.terminate(logs); });
    let finishing = false;
    logs.exited.then(() => { logsExited = true; if (!finishing) record({ kind: 'local-reader-exit', reader: 'logs', at: new Date(clock()).toISOString() }); });
    const cadence = startObserverCadence(controls.tick, { setInterval: interval }); timer = cadence.timer;
    await cadence.initial;
    const attachDeadline = clock() + 5000;
    while (!logsAttached && !logsExited && clock() < attachDeadline) await wait(20);
    if (!controls.attached() || !logsAttached || logsExited || parseFailed) throw Error('Independent observer initial stopped/log attachment failed');
    attached({ attached: true, separateSession: true, observerPid: process.pid,
      instanceId: machine.instance_id, imageDigest: machine.image_ref.digest });
    await wait(Math.max(1, Date.parse(phase.window.stopAt) + 750 - clock()));
    clear(timer); timer = undefined;
    finishing = true;
    framer.finish(); if (parseFailed) throw Error('Observer framing failed');
    return await controls.finish({ normalCompletion: true, reap: async () => {
      const local = await processes.reap(); const authenticated = await native.reap(); return local && authenticated;
    } });
  } finally {
    if (timer) clear(timer);
    await processes.reap(); await native.reap();
  }
}
