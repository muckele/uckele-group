import { spawn } from 'node:child_process';
import { reserveP10bLocalReap } from './p10bHostAuthentication.js';

export function createP10bOperatorProcesses({ spawnProcess = spawn,
  environment = { PATH: process.env.PATH, HOME: process.env.HOME, FLY_NO_UPDATE_CHECK: '1' } } = {}) {
  const active = new Set();
  let retirementUncertain = false;
  function launch(executable, args, options = {}) {
    const reservation = reserveP10bLocalReap(environment);
    const child = spawnProcess(executable, args, { env: environment, detached: false,
      stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let terminal; const exited = new Promise(resolve => { terminal = resolve; });
    const entry = { child, exited, group: options.detached === true, terminationRequested: false }; active.add(entry);
    child.once('error', () => { if (!child.pid) { active.delete(entry); terminal({ code: null, signal: null }); } });
    child.once('close', (code, signal) => {
      try { reservation.retire(code === 0 || entry.terminationRequested); } catch { retirementUncertain = true; }
      active.delete(entry); terminal({ code, signal });
    });
    return entry;
  }
  async function terminate(entry) {
    if (!active.has(entry)) return true;
    entry.terminationRequested = true;
    if (entry.group) { try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { entry.child.kill('SIGKILL'); } }
    else entry.child.kill('SIGKILL');
    let timer;
    try { return await Promise.race([entry.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]); }
    finally { clearTimeout(timer); }
  }
  async function command(executable, args, timeoutMs = 10000) {
    const entry = launch(executable, args); let bytes = 0; let exceeded = false; const chunks = [];
    let timedOut;
    const cutoff = new Promise(resolve => { timedOut = resolve; });
    const timer = setTimeout(() => { exceeded = true; void terminate(entry).then(() => timedOut(null)); }, timeoutMs);
    for (const stream of [entry.child.stdout, entry.child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 131072) { exceeded = true; void terminate(entry); }
      else if (stream === entry.child.stdout) chunks.push(chunk);
    });
    const result = await Promise.race([entry.exited, cutoff]); clearTimeout(timer);
    const output = Buffer.concat(chunks).toString('utf8');
    if (exceeded || !result || result.code !== 0 || result.signal !== null
      || (environment.FLY_API_TOKEN && output.includes(environment.FLY_API_TOKEN))) throw Error('Bounded public command failed');
    return output;
  }
  return { launch, terminate, command, async reap() { return (await Promise.all([...active].map(terminate))).every(v => v === true)
    && active.size === 0 && !retirementUncertain; } };
}
