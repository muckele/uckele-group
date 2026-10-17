import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bNoEmailApproval, createP10bRuntimePhase } from './p10bRuntimeOnlyOperator.js';
import { p10bAppTokenWorkingDirectory, reserveP10bLocalReap } from './p10bHostAuthentication.js';
import { sanitizeP10bGuardianLog } from './p10bRuntimeObserver.js';
import { P10bNativeLogRequestError, checkedP10bNativeLogObservation } from './p10bNativeFailure.js';

// JSON.parse accepts duplicate keys. This closed IPC protocol does not. Parse
// strings using JSON itself, then walk the already syntax-checked structure.
function strictJson(text) {
  const parsed = JSON.parse(text); let offset = 0;
  const space = () => { while (/\s/.test(text[offset] || '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) { const c = text[offset++]; if (c === '\\') offset++; else if (c === '"') return JSON.parse(text.slice(start, offset)); }
    throw Error();
  };
  const value = (depth = 0) => {
    if (depth > 32) throw Error();
    space(); const c = text[offset];
    if (c === '"') { string(); return; }
    if (c === '{') {
      offset++; space(); const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      do { space(); const key = string(); if (keys.has(key)) throw Error(); keys.add(key); space(); offset++; value(depth + 1); space(); } while (text[offset++] === ',');
      return;
    }
    if (c === '[') { offset++; space(); if (text[offset] === ']') { offset++; return; } do { value(depth + 1); space(); } while (text[offset++] === ','); return; }
    const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!token) throw Error(); offset += token[0].length;
  };
  value(); return parsed;
}
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Separate log-only process: no mutation method, CLI fallback or shared request
// queue with the metadata reader. Credentials remain opaque environment input.
export async function openP10bNativeLogClient({ executable, args = ['--serve-logs'], session, approval, configs,
  readOnly = true, environment, signal, spawnProcess = spawn, clock = Date.now, monotonicClock = () => performance.now() }) {
  if (signal?.aborted) throw Error('Log reader cancelled');
  assertP10bNoEmailApproval(session, approval, clock());
  if (readOnly !== true || configs?.length !== 1 || environment?.P10B_APP_TOKEN_CONTEXT !== 'p10b-app-token-context-v1') throw Error('Exact private log-only context required');
  const window = strictJson(configs[0]?.env?.P10B_GUEST_WINDOW);
  const issued = Date.parse(window?.issuedAt);
  const labels = session.version === 'p10b-guardian-only-session-v1' ? ['demo'] : ['demo', 'prepare'];
  if (!Number.isFinite(issued) || !labels.some(label => {
    const phase = createP10bRuntimePhase(session, label, issued);
    return stableCanonicalJson(phase.config) === stableCanonicalJson(configs[0]) && stableCanonicalJson(phase.window) === stableCanonicalJson(window);
  })) throw Error('Exact derived log-only phase required');
  const logEnd = Math.min(Date.parse(window.stopAt) + 750, Date.parse(session.sessionDeadline));
  const began = clock(); const monotonicEnd = monotonicClock() + logEnd - began;
  const active = () => !signal?.aborted && clock() < logEnd && monotonicClock() < monotonicEnd;
  if (!active() || began < issued) throw Error('Log reader lifetime ended');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024
    || sha256(fs.readFileSync(executable)) !== session.nativeClientSha256) throw Error('Exact reviewed native executable required');
  const canonical = stableCanonicalJson(session);
  const initialization = { version: 'p10b-native-log-init-v1', approved: true, readOnly: true,
    sessionCanonical: canonical, sessionDigest: sha256(canonical), configs };
  if (Buffer.byteLength(JSON.stringify(initialization)) > 131071) throw Error('Log initialization exceeds bound');
  const cwd = p10bAppTokenWorkingDirectory(environment); const reservation = reserveP10bLocalReap(environment);
  let child;
  try { if (!active()) throw Error(); child = spawnProcess(executable, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: false }); }
  catch { reservation.retire(true); throw Error('Log process creation failed'); }
  let pending; let sequence = 0; let failed = false; let failureCode = 'bridge-failed'; let closed = false; let buffer = ''; let stderrBytes = 0; let reapPromise; let onExit;
  const exited = new Promise(resolve => { onExit = resolve; });
  const bridgeError = (code, current) => new P10bNativeLogRequestError({ code, timeoutMs: current?.timeoutMs || 5000,
    httpStatus: null, dispatched: null, elapsedMs: Math.max(0, Math.floor(monotonicClock() - (current?.started ?? monotonicClock()))) });
  const fail = (code = 'bridge-failed') => {
    if (!failed) failureCode = code;
    failed = true;
    if (pending) { const current = pending; pending = null; clearTimeout(current.timer); current.reject(current.id ? bridgeError(code, current) : Error('Log initialization failed')); }
    if (!closed) child.kill('SIGKILL');
  };
  const cancel = () => fail();
  child.once('error', () => fail());
  child.once('close', () => { closed = true; onExit(); if (pending) fail(); });
  child.stdin.on('error', () => fail());
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(); });
  signal?.addEventListener('abort', cancel, { once: true });
  child.stdout.on('data', chunk => {
    if (failed) return;
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > 131072) { fail('bridge-protocol'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        if (environment.FLY_API_TOKEN && line.includes(environment.FLY_API_TOKEN)) throw Error();
        const frame = strictJson(line); const current = pending;
        if (!current) throw Error();
        if (!active() || monotonicClock() - current.started >= current.budget) { fail('bridge-timeout'); return; }
        let result;
        if (current.id === 0) {
          if (!exact(frame, ['version', 'ready']) || frame.version !== 'p10b-native-log-ready-v1' || frame.ready !== true) throw Error();
          result = true;
        } else {
          if (frame.version !== 'p10b-native-log-response-v1' || frame.id !== current.id || typeof frame.ok !== 'boolean'
            || !exact(frame, ['version', 'id', 'ok', 'observation', frame.ok ? 'logs' : 'error'])) throw Error();
          const observation = checkedP10bNativeLogObservation(frame.observation, frame.ok ? null : frame.error);
          if (frame.ok) {
            if (observation.httpStatus !== 200 || observation.elapsedMs >= current.timeoutMs || !Array.isArray(frame.logs) || frame.logs.length > 128) throw Error();
            result = frame.logs.map(row => {
              if (!exact(row, ['timestamp', 'message', 'instance', 'region']) || !sanitizeP10bGuardianLog(row, window)) throw Error();
              strictJson(row.message.slice('P10B_GUARDIAN_CHILD_EXIT '.length));
              return { timestamp: row.timestamp, message: row.message, instance: row.instance, region: row.region };
            });
          } else {
            if (!['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output'].includes(frame.error)) throw Error();
            const error = new P10bNativeLogRequestError({ code: frame.error, timeoutMs: current.timeoutMs, ...observation });
            clearTimeout(current.timer); pending = null; current.reject(error); fail(); return;
          }
        }
        if (!active() || monotonicClock() - current.started >= current.budget) { fail('bridge-timeout'); return; }
        clearTimeout(current.timer); pending = null;
        // A second unsolicited frame in this same chunk must invalidate the
        // response before its caller can act on an apparently successful read.
        queueMicrotask(() => {
          if (buffer.length) fail('bridge-protocol');
          if (failed) current.reject(current.id ? bridgeError(failureCode, current) : Error('Log initialization failed'));
          else if (!active() || monotonicClock() - current.started >= current.budget) { fail('bridge-timeout'); current.reject(current.id ? bridgeError('bridge-timeout', current) : Error('Log initialization failed')); }
          else current.resolve(result);
        });
      } catch { fail('bridge-protocol'); return; }
    }
  });
  const send = (id, value, budget) => new Promise((resolve, reject) => {
    if (failed || closed || pending || !active()) { reject(bridgeError('bridge-failed', { timeoutMs: value.timeoutMs })); return; }
    pending = { id, resolve, reject, timeoutMs: value.timeoutMs, budget, started: monotonicClock(),
      timer: setTimeout(() => fail('bridge-timeout'), Math.min(budget, Math.max(1, logEnd - clock()), Math.max(1, monotonicEnd - monotonicClock()))) };
    try { child.stdin.write(`${JSON.stringify(value)}\n`, error => { if (error) fail(); }); } catch { fail(); }
  });
  function reap() {
    if (reapPromise) return reapPromise;
    reapPromise = (async () => {
      fail(); let timer;
      try {
        const verified = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
        reservation.retire(verified); return verified;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    })();
    return reapPromise;
  }
  try { if (!active()) throw Error(); await send(0, initialization, 10000); if (!active() || failed || closed) throw Error(); }
  catch { const error = Error('Log initialization failed; retain public diagnostics'); error.reapVerified = await reap(); throw error; }
  return { pid: child.pid, client(method = 'GET', body, timeoutMs = 700) {
    if (method !== 'GET' || body !== undefined || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (sequence ? 700 : 5000) || sequence >= 410) {
      fail();
      return Promise.reject(new P10bNativeLogRequestError({ code: 'request-denied', timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 5000 ? timeoutMs : 700,
        httpStatus: null, elapsedMs: 0, dispatched: false }));
    }
    const id = ++sequence;
    return send(id, { id, method: 'GET', timeoutMs }, timeoutMs);
  }, reap, close: reap, terminal: () => exited };
}
