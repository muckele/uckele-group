import { spawn } from 'node:child_process';
import { createP10bControlChannel } from './p10bControlChannel.js';

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
  const command = (args, { signal, timeoutMs = 10000 } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Isolated Fly command cancelled')); return; }
    const { child } = launch(args, ['ignore', 'pipe', 'pipe']);
    let bytes = 0;
    const chunks = [];
    let failed = false;
    const fail = () => { if (!failed) { failed = true; child.kill('SIGKILL'); } };
    const timer = setTimeout(fail, timeoutMs);
    signal?.addEventListener('abort', fail, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); };
    child.stdout.on('data', (data) => {
      bytes += data.length;
      if (bytes > 1024 * 1024) fail(); else chunks.push(data);
    });
    child.stderr.on('data', (data) => { bytes += data.length; if (bytes > 1024 * 1024) fail(); });
    child.once('error', () => { cleanup(); reject(new Error('Isolated Fly command failed')); });
    child.once('close', (code) => {
      cleanup();
      if (failed || code !== 0) reject(new Error('Isolated Fly command failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  return {
    async reap() {
      const outcomes = await Promise.all([...processes].map(([child, exit]) => terminate(child, exit)));
      return outcomes.every(Boolean) && processes.size === 0;
    },
    async getMachine({ app, machineId }, options) {
      const rows = JSON.parse(await command(['machines', 'list', '--app', app, '--json'], options));
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== machineId) {
        throw new Error('Exact sole Machine is unavailable');
      }
      return rows[0];
    },
    async getSecretMetadata({ app }, options) {
      const rows = JSON.parse(await command(['secrets', 'list', '--app', app, '--json'], options));
      if (!Array.isArray(rows) || rows.length > 32) throw new Error('Secret metadata is malformed');
      const result = rows.map((row) => ({ name: row.name ?? row.Name, digest: row.digest ?? row.Digest }));
      if (result.some((row) => !/^[A-Z0-9_]{1,120}$/.test(row.name || '')
        || !/^[0-9a-f]{6,128}$/i.test(row.digest || '')
        || ['RESEND_API_KEY', 'EMAIL_WEBHOOK_SECRET'].includes(row.name))) throw new Error('Unexpected secret namespace');
      return result.sort((a, b) => a.name.localeCompare(b.name));
    },
    async startMachine({ app, machineId }, options) {
      await command(['machine', 'start', machineId, '--app', app], options);
    },
    async openWorker({ app, machineId }, { signal } = {}) {
      if (signal?.aborted) throw new Error('Isolated worker opening cancelled');
      const { child, exit } = launch(['ssh', 'console', '--app', app, '--machine', machineId,
        '--quiet', '--command', 'node /app/scripts/run-p10b-qualification-worker.js'], ['pipe', 'pipe', 'pipe']);
      const channel = createP10bControlChannel({ input: child.stdout, output: child.stdin });
      let stderrBytes = 0;
      child.once('error', () => channel.close());
      child.stderr.on('data', (data) => {
        stderrBytes += data.length;
        if (stderrBytes > 8192) { channel.close(); child.kill('SIGKILL'); }
      });
      return { channel, terminate: () => terminate(child, exit) };
    },
  };
}
