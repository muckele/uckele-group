import { spawn } from 'node:child_process';
import { spawnP10bOwnedProcess } from './p10bOwnedProcess.js';

export function createP10bOperatorProcesses({ spawnProcess = spawn,
  environment = { PATH: process.env.PATH, HOME: process.env.HOME, FLY_NO_UPDATE_CHECK: '1' } } = {}) {
  const active = new Set();
  let retirementUncertain = false;
  function launch(executable, args, options = {}) {
    const entry = spawnP10bOwnedProcess(executable, args, { environment, options, spawnProcess }); active.add(entry);
    entry.exited.then(() => { if (!entry.reaped) retirementUncertain = true; active.delete(entry); });
    return entry;
  }
  async function terminate(entry) {
    return entry.terminate();
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
    if (exceeded || !result || !entry.reaped || result.code !== 0 || result.signal !== null
      || (environment.FLY_API_TOKEN && output.includes(environment.FLY_API_TOKEN))) throw Error('Bounded public command failed');
    return output;
  }
  return { launch, terminate, command, async reap() { return (await Promise.all([...active].map(terminate))).every(v => v === true)
    && active.size === 0 && !retirementUncertain; } };
}
