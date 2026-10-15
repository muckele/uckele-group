import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { sha256 } from '../utils/security.js';
import { createP10bControlChannel } from './p10bControlChannel.js';
import { p10bFailureError } from './p10bRuntimeFailure.js';
import { spawnP10bOwnedProcess } from './p10bOwnedProcess.js';

export function createP10bFlyControl({ executable = '/opt/homebrew/bin/fly', environment = process.env,
  spawnProcess = spawn, executableSha256, secretNamesExecutable, secretNamesSha256 } = {}) {
  const env = { PATH: environment.PATH, HOME: environment.HOME, FLY_NO_UPDATE_CHECK: '1', FLY_AGENT_ISOLATED: '1',
    ...(environment.FLY_CONFIG_DIR ? { FLY_CONFIG_DIR: environment.FLY_CONFIG_DIR } : {}),
    ...(environment.P10B_APP_TOKEN_CONTEXT === 'p10b-app-token-context-v1' ? { P10B_APP_TOKEN_CONTEXT: environment.P10B_APP_TOKEN_CONTEXT } : {}),
    ...(environment.FLY_API_TOKEN ? { FLY_API_TOKEN: environment.FLY_API_TOKEN } : {}) };
  const processes = new Map();
  let retirementUncertain = false;
  const launch = (args, stdio, binary = executable) => {
    if (binary === executable && executableSha256 !== undefined) {
      const stat = fs.lstatSync(binary);
      if (!/^[a-f0-9]{64}$/.test(executableSha256) || !stat.isFile() || stat.isSymbolicLink()
        || stat.size > 256 * 1024 * 1024 || sha256(fs.readFileSync(binary)) !== executableSha256) throw Error('Bound Fly executable changed');
    }
    const owned = spawnP10bOwnedProcess(binary, args, { environment: env, options: { stdio }, spawnProcess });
    processes.set(owned.child, owned);
    owned.exited.then(() => { if (!owned.reaped) retirementUncertain = true; processes.delete(owned.child); });
    return owned;
  };
  const command = (stage, args, { signal, timeoutMs = 10000 } = {}, binary = executable) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(p10bFailureError('transport', stage, null, { reason: 'cancelled' })); return; }
    const owned = launch(args, ['ignore', 'pipe', 'pipe'], binary); const { child } = owned;
    let bytes = 0;
    const chunks = [];
    let failed = false;
    let reason = 'command-failed';
    const fail = (value) => {
      if (failed) return;
      reason = value; failed = true;
      void owned.terminate().then(() => {
        cleanup();
        reject(p10bFailureError('transport', stage, null, { reason }));
      });
    };
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
    child.once('close', async (code, signal) => {
      await owned.exited;
      cleanup();
      const output = Buffer.concat(chunks).toString('utf8');
      if (failed || !owned.reaped || code !== 0 || signal !== null || (env.FLY_API_TOKEN && output.includes(env.FLY_API_TOKEN))) reject(p10bFailureError('transport', stage, null,
        { reason, exitCode: code, signal }));
      else resolve(output);
    });
  });
  return {
    async reap() {
      const outcomes = await Promise.all([...processes.values()].map(owned => owned.terminate()));
      return outcomes.every(Boolean) && processes.size === 0 && !retirementUncertain;
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
    async getSecretNames({ app }, options) {
      if (app !== 'uckele-group-p10b' || typeof secretNamesExecutable !== 'string'
        || !/^[a-f0-9]{64}$/.test(secretNamesSha256 || '')) throw Error('Bound names-exclusive client required');
      const stat = fs.lstatSync(secretNamesExecutable);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024
        || sha256(fs.readFileSync(secretNamesExecutable)) !== secretNamesSha256) throw Error('Names-exclusive client changed');
      const bytes = await command('get-secret-metadata', ['--secret-names'], options, secretNamesExecutable);
      let names; try { names = JSON.parse(bytes); } catch { throw Error('Names-only output invalid'); }
      if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length
        || names.some(name => typeof name !== 'string' || !/^[A-Z0-9_]{1,120}$/.test(name)
          || ['RESEND_API_KEY', 'EMAIL_WEBHOOK_SECRET'].includes(name))) throw Error('Names-only inventory invalid');
      return names.sort();
    },
    async startMachine({ app, machineId }, options) {
      await command('start-machine', ['machine', 'start', machineId, '--app', app], options);
    },
    async openWorker({ app, machineId }, { signal } = {}) {
      if (signal?.aborted) throw p10bFailureError('transport', 'open-worker', null, { reason: 'cancelled' });
      const owned = launch(['ssh', 'console', '--app', app, '--machine', machineId,
        '--quiet', '--command', 'node /app/scripts/run-p10b-qualification-worker.js'], ['pipe', 'pipe', 'pipe']);
      const { child } = owned;
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
          void owned.terminate();
        }
      });
      return { channel, terminate: () => owned.terminate() };
    },
  };
}
