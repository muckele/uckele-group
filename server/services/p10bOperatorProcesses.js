import { spawn } from 'node:child_process';
import { spawnP10bOwnedProcess } from './p10bOwnedProcess.js';

const commandFailures = new WeakMap();
const signals = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP']);
// Only facts produced here are public. Never inspect arbitrary error fields or
// expose command output, argv, environment, exception text or stderr.
export class P10bOperatorCommandError extends Error {
  constructor(reason, timeoutMs, terminal, clientsReaped) {
    super('Bounded public command failed');
    if (!['timed-out', 'output-bound', 'private-output', 'command-failed'].includes(reason)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('Invalid public command facts');
    commandFailures.set(this, Object.freeze({ version: 'p10b-public-command-failure-v1', reason, timeoutMs,
      exitCode: Number.isInteger(terminal?.code) && terminal.code >= 0 && terminal.code <= 255 ? terminal.code : null,
      signal: signals.has(terminal?.signal) ? terminal.signal : null, clientsReaped: clientsReaped === true }));
  }
}
export function publicP10bCommandFailure(error) {
  const facts = commandFailures.get(error);
  return facts ? { ...facts } : null;
}

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
    const entry = launch(executable, args); let bytes = 0; let failure = null; const chunks = [];
    let timedOut;
    const cutoff = new Promise(resolve => { timedOut = resolve; });
    const timer = setTimeout(() => { failure ||= 'timed-out'; void terminate(entry).then(() => timedOut(null)); }, timeoutMs);
    for (const stream of [entry.child.stdout, entry.child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 131072) { failure ||= 'output-bound'; void terminate(entry); }
      else if (stream === entry.child.stdout) chunks.push(chunk);
    });
    const result = await Promise.race([entry.exited, cutoff]); clearTimeout(timer);
    const output = Buffer.concat(chunks).toString('utf8');
    if (environment.FLY_API_TOKEN && output.includes(environment.FLY_API_TOKEN)) failure ||= 'private-output';
    if (failure || !result || !entry.reaped || result.code !== 0 || result.signal !== null) {
      throw new P10bOperatorCommandError(failure || 'command-failed', timeoutMs, result, entry.reaped);
    }
    return output;
  }
  return { launch, terminate, command, async reap() { return (await Promise.all([...active].map(terminate))).every(v => v === true)
    && active.size === 0 && !retirementUncertain; } };
}
