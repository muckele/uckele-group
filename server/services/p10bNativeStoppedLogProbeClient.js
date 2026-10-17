import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { sha256 } from '../utils/security.js';
import { strictP10bJson } from './p10bStrictJson.js';
import { p10bAppTokenWorkingDirectory, reserveP10bLocalReap } from './p10bHostAuthentication.js';
import { assertP10bStoppedLogProbeApproval, createP10bStoppedLogProbeBudget, checkedP10bStoppedLogObservation,
  exactProbeKeys, P10B_STOPPED_LOG_PROBE_STEPS, P10B_STOPPED_LOG_PROBE_BUDGETS } from './p10bStoppedLogProbeContract.js';

// Dedicated read-only process; no runtime transport lease or generic request API.
export async function openP10bNativeStoppedLogProbeClient({ probe, approval, executable, environment, signal,
  args = ['--serve-stopped-log-probe'], spawnProcess = spawn, clock = Date.now, monotonicClock = () => performance.now(), budget: suppliedBudget }) {
  const budget = suppliedBudget || createP10bStoppedLogProbeBudget(probe, { clock, monotonicClock });
  assertP10bStoppedLogProbeApproval(probe, approval, clock());
  const active = () => !signal?.aborted && budget.active();
  if (!active() || environment?.P10B_APP_TOKEN_CONTEXT !== 'p10b-app-token-context-v1') throw Error('Private stopped probe context required');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024 || sha256(fs.readFileSync(executable)) !== probe.nativeClientSha256) {
    throw Error('Exact stopped probe executable required');
  }
  const initialization = JSON.stringify({ probe, approval });
  if (Buffer.byteLength(initialization) > 131071 || !active()) throw Error('Stopped probe initialization denied');
  const cwd = p10bAppTokenWorkingDirectory(environment); const reservation = reserveP10bLocalReap(environment);
  let child;
  try { if (!active()) throw Error(); child = spawnProcess(executable, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: false }); }
  catch { reservation.retire(true); throw Error('Stopped probe spawn failed'); }
  let pending; let failed = false; let closed = false; let buffer = ''; let stderrBytes = 0; let sequence = 0; let reapPromise;
  let exit; const exited = new Promise(resolve => { exit = resolve; }); const decoder = new TextDecoder('utf-8', { fatal: true });
  const fail = () => { failed = true; if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.reject(Error('Stopped probe request failed')); }
    if (!closed) { try { child.kill('SIGKILL'); } catch { /* Unverified reap remains a hold. */ } } };
  const lifetime = setTimeout(fail, Math.max(1, budget.remaining()));
  const abort = () => fail(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  child.once('error', fail); child.once('close', () => { closed = true; exit(); if (pending) fail(); });
  child.stdin.on('error', fail); child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 8192) fail(); });
  child.stdout.on('data', bytes => {
    if (failed) return;
    try {
      buffer += decoder.decode(bytes, { stream: true });
      if (Buffer.byteLength(buffer) > 131072) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); const p = pending;
        if (!p || !active() || monotonicClock() - p.started >= p.limit || (environment.FLY_API_TOKEN && line.includes(environment.FLY_API_TOKEN))) throw Error();
        const frame = strictP10bJson(line); let result;
        if (p.id === 0) {
          if (!exactProbeKeys(frame, ['type', 'version']) || frame.type !== 'ready' || frame.version !== 'p10b-stopped-log-probe-v1') throw Error();
          result = true;
        } else {
          if (frame.type === 'error') {
            if (!exactProbeKeys(frame, ['type', 'id', 'code']) || frame.id !== p.id
              || !['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output'].includes(frame.code)) throw Error();
            throw Error();
          }
          if (!exactProbeKeys(frame, ['type', 'id', 'observation']) || frame.type !== 'success' || frame.id !== p.id) throw Error();
          result = checkedP10bStoppedLogObservation(frame.observation, P10B_STOPPED_LOG_PROBE_STEPS[p.id - 1], probe);
        }
        if (!active() || monotonicClock() - p.started >= p.limit) throw Error();
        pending = null; clearTimeout(p.timer);
        queueMicrotask(() => {
          if (buffer.length || failed || closed || !active() || monotonicClock() - p.started >= p.limit) { fail(); p.reject(Error('Stopped probe response denied')); }
          else p.resolve(result);
        });
      }
    } catch { fail(); }
  });
  const send = (id, frame, limit) => new Promise((resolve, reject) => {
    if (failed || closed || pending || !active()) { fail(); reject(Error('Stopped probe unavailable')); return; }
    pending = { id, resolve, reject, limit, started: monotonicClock(), timer: setTimeout(fail, Math.max(1, Math.min(limit, budget.remaining()))) };
    try { child.stdin.write(`${JSON.stringify(frame)}\n`, error => { if (error) fail(); }); } catch { fail(); }
  });
  const reap = () => {
    if (reapPromise) return reapPromise;
    reapPromise = (async () => {
      const started = monotonicClock(); fail(); clearTimeout(lifetime); let timer;
      try {
        const verified = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, Math.min(1000, budget.remaining(true)))); })]);
        const positive = verified === true && monotonicClock() - started < 1000 && budget.active(true);
        try { reservation.retire(positive); } catch { return false; }
        return positive;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    })(); return reapPromise;
  };
  try { await send(0, JSON.parse(initialization), 10000); if (!active() || failed || closed) throw Error(); }
  catch { const error = Error('Stopped probe initialization failed'); error.reapVerified = await reap(); throw error; }
  return { step(operation) {
    if (operation !== P10B_STOPPED_LOG_PROBE_STEPS[sequence] || sequence >= 4) { fail(); return Promise.reject(Error('Stopped probe sequence denied')); }
    const id = ++sequence; return send(id, { id, operation }, P10B_STOPPED_LOG_PROBE_BUDGETS[id - 1]);
  }, reap };
}
