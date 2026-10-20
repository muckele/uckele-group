import { setTimeout as delay } from 'node:timers/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Observe only the executable this fixture is about to launch. The PID is
// recorded synchronously at spawn, before an asynchronous browser launch can
// finish or receive shutdown. No process enumeration or unrelated PID is used.
export function observeOwnedBrowserSpawn(executable, onSpawn) {
  const spawn = childProcess.spawn;
  const retirements = [];
  let publicationError;
  childProcess.spawn = function (command, ...args) {
    const child = spawn.call(this, command, ...args);
    if (command === executable && child.pid) {
      try { onSpawn(child.pid); }
      catch (error) {
        publicationError = error;
        // Publication can fail after native spawn (e.g. a full disk). Retain
        // ownership in memory and kill synchronously before returning the child
        // to Playwright. Disposal awaits positive absence, then reports failure.
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        const retirement = (async () => {
          const deadline = performance.now() + 2000;
          while (performance.now() < deadline) {
            try { process.kill(-child.pid, 0); }
            catch (probeError) {
              if (probeError.code === 'ESRCH') return;
              // A just-killed child can briefly report EPERM while reaping on
              // macOS. Treat that as unknown until the monotonic bound expires.
              if (probeError.code !== 'EPERM') throw probeError;
            }
            await delay(25);
          }
          throw new Error('Unpublished owned browser did not confirm stopped');
        })();
        retirement.catch(() => {}); // Observed and rethrown by disposal below.
        retirements.push(retirement);
      }
    }
    return child;
  };
  syncBuiltinESMExports();
  return async () => {
    childProcess.spawn = spawn; syncBuiltinESMExports();
    await Promise.all(retirements);
    if (publicationError) throw publicationError;
  };
}

// Call only for a freshly spawned, explicitly registered process-group leader.
// Stop signaling as soon as absence is established, including the first signal.
export async function stopOwnedProcessGroup(pid, { graceMs = 2000, killWaitMs = 2000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid owned process group');
  const signal = (name) => {
    try { process.kill(-pid, name); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  if (!signal('SIGTERM')) return { absent: true };
  for (const [waitMs, nextSignal] of [[graceMs, 'SIGKILL'], [killWaitMs, null]]) {
    const deadline = performance.now() + waitMs;
    while (performance.now() < deadline) {
      if (!signal(0)) return { absent: true };
      await delay(25);
    }
    if (nextSignal && !signal(nextSignal)) return { absent: true };
  }
  if (!signal(0)) return { absent: true };
  throw new Error('FL05 owned process group did not confirm stopped within its bound');
}
