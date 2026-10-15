import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reserveP10bLocalReap, p10bAppTokenWorkingDirectory } from './p10bHostAuthentication.js';

function absent(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('Owned process group unavailable');
  try { process.kill(-pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw Error('Owned process group uncertain'); }
}

// Every launched group is task-owned. Closing its immediate leader is not
// proof that an isolated SDK agent has exited; its reservation survives until
// the complete group is positively absent. Nested uncertainty remains held.
export function spawnP10bOwnedProcess(executable, args, { environment, options = {}, spawnProcess = spawn }) {
  const reservation = reserveP10bLocalReap(environment);
  const cwd = p10bAppTokenWorkingDirectory(environment);
  const env = cwd ? { ...environment, FLY_AGENT_ISOLATED: '1',
    FLY_AGENT_SOCKET_PATH: path.join(cwd, `a-${randomUUID().slice(0, 12)}.sock`) } : environment;
  let child;
  try { child = spawnProcess(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...options, env, detached: true }); }
  catch { throw Error('Owned process launch unverified'); }
  let resolveExit; let finishing = false; let denied = false;
  const entry = { child, reaped: false, group: true, exited: new Promise(resolve => { resolveExit = resolve; }) };
  const kill = () => {
    if (denied) return false;
    try { process.kill(-child.pid, 'SIGKILL'); return true; }
    catch (error) { if (error.code === 'ESRCH') return true; denied = true; return false; }
  };
  const finish = async (code, signal) => {
    if (finishing) return; finishing = true;
    try {
      if (!absent(child.pid) && !kill()) throw Error();
      const end = performance.now() + 1000;
      while (!absent(child.pid) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
      if (!absent(child.pid)) throw Error();
      reservation.retire(true); entry.reaped = true;
    } catch { /* Preserve the reservation; no raw SDK/process error is public. */ }
    resolveExit({ code, signal });
  };
  child.once('error', () => { if (!child.pid) void finish(null, null); });
  child.once('close', (code, signal) => { void finish(code, signal); });
  entry.terminate = async () => {
    if (entry.reaped) return true;
    if (!kill()) return false;
    let timer;
    try {
      return await Promise.race([entry.exited.then(() => entry.reaped),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
    } finally { clearTimeout(timer); }
  };
  return entry;
}
