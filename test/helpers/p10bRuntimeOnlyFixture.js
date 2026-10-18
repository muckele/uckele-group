import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { p10bGuestPaths, assertP10bGuestReady, readP10bGuestRecord } from '../../server/services/p10bGuestShutdown.js';
import { createJsonObjectFramer, startObserverCadence, proveP10bGuardianStop } from '../../server/services/p10bRuntimeObservation.js';

// Actual guardian/parent/controller OS processes; all platform fields below
// are a local fake transport. No Fly executable, provider or email is used.
export function offlineDemoWindow(machine, sourceHead) {
  const issuedAt = new Date().toISOString();
  return { version: 'p10b-guest-window-v1', app: 'uckele-group-p10b', machineId: machine.id,
    sourceHead, imageDigest: machine.image_ref.digest, phase: 'prepare',
    databasePath: '/data/p10b-first-mailbox-watchdog-fixture.sqlite', runBinding: 'c'.repeat(64), issuedAt,
    stopAt: new Date(Date.parse(issuedAt) + 6000).toISOString(), closureGraceMs: 2000, stopReserveMs: 1000 };
}
export async function demonstrateOfflineGuardianLoss(t, { directory, machine, databasePath, sourceHead, abnormal = false,
  window = offlineDemoWindow(machine, sourceHead) }) {
  const script = path.join(directory, 'offline-demo-parent.mjs');
  const childScript = path.join(directory, 'offline-demo-guardian.mjs');
  fs.writeFileSync(childScript, `import {runP10bGuestGuardian} from ${JSON.stringify(new URL('../../server/services/p10bGuestGuardian.js', import.meta.url).href)};
    await runP10bGuestGuardian({window:JSON.parse(process.env.P10B_GUEST_WINDOW),databasePath:process.argv[2]});`);
  fs.writeFileSync(script, `import {spawn} from 'node:child_process';
    import {runP10bGuardianParent} from ${JSON.stringify(new URL('../../server/services/p10bGuardianParent.js', import.meta.url).href)};
    await runP10bGuardianParent({window:JSON.parse(process.argv[2]),databasePath:process.argv[3],
      launch:({environment})=>spawn(process.execPath,[${JSON.stringify(childScript)},process.argv[3]],{env:environment,stdio:'ignore'})});`);
  const rows = []; const framer = createJsonObjectFramer(object => rows.push({ kind: 'platform-log',
    timestamp: object.timestamp, message: object.message, machineId: object.instance, region: object.region }));
  const tick = async () => {
    const requestedAt = new Date().toISOString();
    await Promise.resolve();
    rows.push({ kind: 'metadata', requestedAt, at: new Date().toISOString(), state: machine.state,
      imageDigest: machine.image_ref.digest, instanceId: machine.instance_id, events: structuredClone(machine.events || []) });
  };
  const { timer, initial } = startObserverCadence(tick); await initial;
  const parent = spawn(process.execPath, [script, JSON.stringify(window), databasePath],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = ''; let stderr = ''; parent.stderr.on('data', chunk => { stderr += chunk; });
  parent.stdout.on('data', chunk => {
    pending += chunk.toString(); let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const message = pending.slice(0, newline); pending = pending.slice(newline + 1);
      const bytes = Buffer.from(JSON.stringify({ instance: machine.id, region: 'ewr',
        timestamp: new Date().toISOString(), message }, null, 2) + '\n');
      // The old line parser discards this exact pretty-printed transport.
      for (let offset = 0; offset < bytes.length; offset += 7) framer.write(bytes.subarray(offset, offset + 7));
    }
  });
  machine.state = 'started';
  const stopped = once(parent, 'close').then(([code, signal]) => {
    assert.equal(stderr, ''); framer.finish();
    machine.state = 'stopped';
    machine.events = [{ type: 'exit', status: 'stopped', request: { exit_event: {
      exited_at: new Date().toISOString(), requested_stop: false, restarting: false,
      guest_exit_code: abnormal ? 1 : code, exit_code: abnormal ? 1 : code,
      guest_signal: signal ? 15 : -1, signal: signal ? 15 : -1,
      guest_error: '', error: '', oom_killed: false } } }];
  });
  const primary = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { clearInterval(timer); for (const child of [primary, parent]) {
    if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* local fixture exited */ }
  } });
  await assertP10bGuestReady({ window, databasePath });
  const paths = p10bGuestPaths(window, databasePath);
  const readiness = { sourceHead, guardianAlive: true, parentAlive: true,
    guardianReady: readP10bGuestRecord(paths.ready), guardianStart: readP10bGuestRecord(paths.start),
    guardianParentStart: readP10bGuestRecord(paths.parentStart) };
  const killedAt = Date.now(); const killed = once(primary, 'exit'); process.kill(-primary.pid, 'SIGKILL');
  const [primaryCode, primarySignal] = await killed;
  assert.equal(primaryCode, null); assert.equal(primarySignal, 'SIGKILL');
  assert.equal(process.kill(parent.pid, 0), true);
  await stopped;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(window.stopAt) + 750 - Date.now())));
  clearInterval(timer);
  rows.push({ kind: 'observer-finished', at: new Date().toISOString(), normalCompletion: true });
  const proof = proveP10bGuardianStop(rows, { window, readiness, killedAt, expectedInstanceId: machine.instance_id });
  assert.equal(fs.existsSync(databasePath), false);
  assert.equal(fs.existsSync(paths.processExit), true);
  return { proof, rows, window, readiness, killedAt, primaryPid: primary.pid, parentPid: parent.pid };
}
