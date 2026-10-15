import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bNoEmailApproval } from './p10bRuntimeOnlyOperator.js';
import { p10bAppTokenWorkingDirectory, reserveP10bLocalReap } from './p10bHostAuthentication.js';
import { P10bNativeRequestError } from './p10bNativeFailure.js';
import { assertP10bStoppedUpdateApproval, checkedP10bStoppedObservation, checkedP10bStoppedSettlement, P10bStoppedUpdateRequestError } from './p10bStoppedUpdateContract.js';

// No process is created until exact session approval has passed. Native code
// consumes opaque Fly authentication; JS only receives closed public responses.
export const openP10bNativeMachineClient = options => openMachineClient(false, options);
export const openP10bStoppedUpdateClient = options => openMachineClient(true, options);
async function openMachineClient(diagnostic, { executable, args = diagnostic ? ['--serve-stopped-update-diagnostic'] : ['--serve'], session, approval,
  configs, readOnly = false, recoveryVerified = false, spawnProcess = spawn, clock = () => Date.now(),
  environment = { PATH: process.env.PATH, HOME: process.env.HOME } }) {
  (diagnostic ? assertP10bStoppedUpdateApproval : assertP10bNoEmailApproval)(session, approval, clock());
  if (diagnostic && (environment.P10B_APP_TOKEN_CONTEXT !== 'p10b-app-token-context-v1'
    || stableCanonicalJson(configs) !== stableCanonicalJson([session.baselineConfig, session.diagnosticConfig]))) throw Error('Exact private stopped-only context required');
  if (!readOnly && recoveryVerified !== true) throw Error('Recovery gate must precede native mutation client');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024
    || sha256(fs.readFileSync(executable)) !== session.nativeClientSha256) throw Error('Exact reviewed native executable required');
  const canonical = stableCanonicalJson(session);
  const initialization = { version: diagnostic ? 'p10b-stopped-native-init-v1' : 'p10b-native-init-v1', approved: true, readOnly,
    sessionCanonical: canonical, sessionDigest: sha256(canonical), configs, recoveryVerified };
  if (Buffer.byteLength(JSON.stringify(initialization)) > 131071) throw Error('Native initialization exceeds bound');
  // The SDK's relative config lock must stay inside the private auth context too.
  const cwd = p10bAppTokenWorkingDirectory(environment);
  const reservation = reserveP10bLocalReap(environment);
  const child = spawnProcess(executable, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
  let pending; let sequence = 0; let buffer = ''; let failed = false; let closed = false;
  let stderrBytes = 0; let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  const fail = (reason = 'bridge-failed') => {
    failed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(pending.id === 0 ? Error('Native initialization failed') : diagnostic ? new P10bStoppedUpdateRequestError({
        code: ['bridge-timeout', 'bridge-protocol'].includes(reason) ? reason : 'bridge-failed', method: pending.method,
        timeoutMs: pending.timeoutMs, observation: { httpStatus: null,
          elapsedMs: Math.max(0, Math.floor(performance.now() - pending.startedMonotonic)), dispatched: null } }) : new P10bNativeRequestError({
        code: ['bridge-timeout', 'bridge-protocol'].includes(reason) ? reason : 'bridge-failed',
        method: pending.method, timeoutMs: pending.timeoutMs }));
      pending = null;
    }
    child.kill('SIGKILL');
  };
  child.once('error', fail);
  child.once('close', (code, signal) => { closed = true; exit({ code, signal }); if (pending) fail(); });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(); });
  child.stdout.on('data', chunk => {
    if (failed) return;
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > 1048576) { fail(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        if (environment.FLY_API_TOKEN && line.includes(environment.FLY_API_TOKEN)) throw Error();
        const frame = JSON.parse(line); const current = pending;
        if (!current || (current.id === 0 ? frame.version !== (diagnostic ? 'p10b-stopped-native-ready-v1' : 'p10b-native-ready-v1') || frame.ready !== true
          : frame.id !== current.id || typeof frame.ok !== 'boolean')) throw Error();
        if (current.id !== 0 && Object.keys(frame).some(k => !['id', 'ok', 'error', 'machine', ...(diagnostic ? ['observation', 'settlement'] : [])].includes(k))) throw Error();
        if (diagnostic && current.id === 0 && Object.keys(frame).some(k => !['version', 'ready'].includes(k))) throw Error();
        if (frame.error !== undefined && !['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output'].includes(frame.error)) throw Error();
        if (current.id !== 0 && (frame.ok === true ? frame.error !== undefined
          : frame.error === undefined || frame.machine !== undefined || frame.settlement !== undefined)) throw Error();
        const observation = diagnostic && current.id !== 0 ? checkedP10bStoppedObservation(frame.observation, frame.ok ? null : frame.error) : null;
        if (diagnostic && current.id !== 0 && frame.ok && (current.method === 'WAIT'
          ? frame.machine !== undefined || frame.settlement === undefined
          : frame.machine === undefined || frame.settlement !== undefined)) throw Error();
        const settlement = diagnostic && current.id !== 0 && frame.ok && current.method === 'WAIT'
          ? checkedP10bStoppedSettlement(frame.settlement, current.version) : null;
        const failure = current.id !== 0 && frame.ok !== true ? diagnostic ? new P10bStoppedUpdateRequestError({
          code: frame.error, method: current.method, timeoutMs: current.timeoutMs, observation }) : new P10bNativeRequestError({
          code: frame.error, method: current.method, timeoutMs: current.timeoutMs }) : null;
        clearTimeout(current.timer); pending = null;
        if (failure) current.reject(failure);
        else current.resolve(current.id === 0 ? true : diagnostic ? { ...(settlement ? { settlement } : { machine: frame.machine }), observation } : frame.machine);
      } catch { fail('bridge-protocol'); return; }
    }
  });
  const send = (id, value, timeoutMs) => new Promise((resolve, reject) => {
    if (failed || closed || pending || clock() >= Date.parse(session.sessionDeadline)) { reject(Error('Native client unavailable')); return; }
    pending = { id, resolve, reject, method: value.method, version: value.body?.version, timeoutMs: value.timeoutMs, startedMonotonic: performance.now(),
      timer: setTimeout(() => fail('bridge-timeout'), timeoutMs) };
    child.stdin.write(`${JSON.stringify(value)}\n`, error => { if (error) fail(); });
  });
  try { await send(0, initialization, 10000); }
  catch {
    const error = Error('Native initialization failed; retain public diagnostics');
    error.reapVerified = await reap();
    throw error;
  }
  let posts = 0;
  async function reap() {
    if (!closed) { child.stdin.end(); child.kill('SIGKILL'); }
    let timer;
    try {
      const verified = Boolean(await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]));
      reservation.retire(verified); return verified;
    }
    finally { clearTimeout(timer); }
  }
  return { pid: child.pid, client(method = 'GET', body, timeoutMs = 1000) {
    if (!(diagnostic ? ['GET', 'POST', 'WAIT'] : ['GET', 'POST']).includes(method) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || (method === 'POST' && (readOnly || posts >= (diagnostic ? 2 : 3)))
      || (diagnostic && (method === 'POST' ? timeoutMs !== 10000 : method === 'WAIT'
        ? timeoutMs < 1000 || timeoutMs > 9000 || !body || Object.keys(body).join(',') !== 'version' || !/^[A-Za-z0-9-]{1,80}$/.test(body.version || '')
        : timeoutMs > 1000))) return Promise.reject(diagnostic
        ? new P10bStoppedUpdateRequestError({ code: 'request-denied', method: ['GET', 'POST', 'WAIT'].includes(method) ? method : 'GET',
          timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10000 ? timeoutMs : 1000,
          observation: { httpStatus: null, elapsedMs: 0, dispatched: false } }) : Error('Native request denied'));
    if (method === 'POST') posts++;
    return send(++sequence, { id: sequence, method, timeoutMs, ...(body ? { body } : {}) }, timeoutMs + 250);
  }, reap, async close() { return reap(); }, async terminal() { return exited; } };
}
