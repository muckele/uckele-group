import { spawn } from 'node:child_process';
import { createP10bControlChannel } from './p10bControlChannel.js';
import { p10bFailureError } from './p10bRuntimeFailure.js';

export function createP10bFlyControl({ executable = '/opt/homebrew/bin/fly', environment = process.env,
  spawnProcess = spawn } = {}) {
  const env = { PATH: environment.PATH, HOME: environment.HOME, FLY_NO_UPDATE_CHECK: '1',
    ...(environment.FLY_API_TOKEN ? { FLY_API_TOKEN: environment.FLY_API_TOKEN } : {}) };
  const processes = new Map();
  const launch = (args, stdio) => {
    const child = spawnProcess(executable, args, { env, stdio });
    const exit = new Promise((resolve) => {
      child.once('error', () => { processes.delete(child); resolve(true); });
      child.once('close', () => { processes.delete(child); resolve(true); });
    });
    processes.set(child, exit);
    return { child, exit };
  };
  const terminate = async (child, exit) => {
    if (!processes.has(child)) return true;
    // A local Fly/SSH command has no application state to flush. Killing it
    // prevents a delayed start or SSH process from outliving the stop latch.
    child.kill('SIGKILL');
    let timer;
    try { return await Promise.race([exit, new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 1000);
    })]); } finally { clearTimeout(timer); }
  };
  const command = (stage, args, { signal, timeoutMs = 10000 } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(p10bFailureError('transport', stage, null, { reason: 'cancelled' })); return; }
    const { child } = launch(args, ['ignore', 'pipe', 'pipe']);
    let bytes = 0;
    const chunks = [];
    let failed = false;
    let reason = 'command-failed';
    const fail = (value) => { if (!failed) { reason = value; failed = true; child.kill('SIGKILL'); } };
    const abort = () => fail('cancelled');
    const timer = setTimeout(() => fail('timed-out'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (data) => {
      bytes += data.length;
      if (bytes > 1024 * 1024) fail('output-bound'); else chunks.push(data);
    });
    child.stderr.on('data', (data) => { bytes += data.length; if (bytes > 1024 * 1024) fail('output-bound'); });
    child.once('error', (error) => { cleanup(); reject(p10bFailureError('transport', stage, error)); });
    child.once('close', (code, signal) => {
      cleanup();
      if (failed || code !== 0) reject(p10bFailureError('transport', stage, null,
        { reason, exitCode: code, signal }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  return {
    async reap() {
      const outcomes = await Promise.all([...processes].map(([child, exit]) => terminate(child, exit)));
      return outcomes.every(Boolean) && processes.size === 0;
    },
    async getMachine({ app, machineId }, options) {
      const bytes = await command('get-machine', ['machines', 'list', '--app', app, '--json'], options);
      let rows;
      try { rows = JSON.parse(bytes); }
      catch { throw p10bFailureError('transport', 'get-machine', null, { reason: 'invalid-output' }); }
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== machineId) {
        throw new Error('Exact sole Machine is unavailable');
      }
      return rows[0];
    },
    async getSecretMetadata({ app }, options) {
      const bytes = await command('get-secret-metadata', ['secrets', 'list', '--app', app, '--json'], options);
      let rows;
      try { rows = JSON.parse(bytes); }
      catch { throw p10bFailureError('transport', 'get-secret-metadata', null, { reason: 'invalid-output' }); }
      if (!Array.isArray(rows) || rows.length > 32) throw new Error('Secret metadata is malformed');
      const result = rows.map((row) => ({ name: row.name ?? row.Name, digest: row.digest ?? row.Digest }));
      if (result.some((row) => !/^[A-Z0-9_]{1,120}$/.test(row.name || '')
        || !/^[0-9a-f]{6,128}$/i.test(row.digest || '')
        || ['RESEND_API_KEY', 'EMAIL_WEBHOOK_SECRET'].includes(row.name))) throw new Error('Unexpected secret namespace');
      return result.sort((a, b) => a.name.localeCompare(b.name));
    },
    async startMachine({ app, machineId }, options) {
      await command('start-machine', ['machine', 'start', machineId, '--app', app], options);
    },
    async openWorker({ app, machineId }, { signal } = {}) {
      if (signal?.aborted) throw p10bFailureError('transport', 'open-worker', null, { reason: 'cancelled' });
      const { child, exit } = launch(['ssh', 'console', '--app', app, '--machine', machineId,
        '--quiet', '--command', 'node /app/scripts/run-p10b-qualification-worker.js'], ['pipe', 'pipe', 'pipe']);
      const channel = createP10bControlChannel({ input: child.stdout, output: child.stdin });
      let stderrBytes = 0;
      const terminal = new Promise(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => resolve({ code: null, signal: null }));
      });
      const next = channel.next;
      channel.next = async () => {
        const frame = await next();
        if (frame) return frame;
        const { code, signal } = await terminal;
        if (code !== 0 || signal) throw p10bFailureError('transport', 'open-worker', null,
          { reason: 'command-failed', exitCode: code, signal });
        return null;
      };
      child.once('error', (error) => channel.close(p10bFailureError('transport', 'open-worker', error)));
      child.stderr.on('data', (data) => {
        stderrBytes += data.length;
        if (stderrBytes > 8192) {
          channel.close(p10bFailureError('transport', 'open-worker', null, { reason: 'output-bound' }));
          child.kill('SIGKILL');
        }
      });
      return { channel, terminate: () => terminate(child, exit) };
    },
  };
}
