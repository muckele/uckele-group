import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bNoEmailApproval } from './p10bRuntimeOnlyOperator.js';

// No process is created until exact session approval has passed. Native code
// owns normal Fly authentication; JS only receives closed public responses.
export async function openP10bNativeMachineClient({ executable, args = ['--serve'], session, approval,
  configs, readOnly = false, recoveryVerified = false, spawnProcess = spawn, clock = () => Date.now(),
  environment = { PATH: process.env.PATH, HOME: process.env.HOME } }) {
  assertP10bNoEmailApproval(session, approval, clock());
  if (!readOnly && recoveryVerified !== true) throw Error('Recovery gate must precede native mutation client');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024
    || sha256(fs.readFileSync(executable)) !== session.nativeClientSha256) throw Error('Exact reviewed native executable required');
  const canonical = stableCanonicalJson(session);
  const initialization = { version: 'p10b-native-init-v1', approved: true, readOnly,
    sessionCanonical: canonical, sessionDigest: sha256(canonical), configs, recoveryVerified };
  if (Buffer.byteLength(JSON.stringify(initialization)) > 131071) throw Error('Native initialization exceeds bound');
  const child = spawnProcess(executable, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
  let pending; let sequence = 0; let buffer = ''; let failed = false; let closed = false;
  let stderrBytes = 0; let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  const fail = () => {
    failed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(Error('Native client failed; retain public exit diagnostics')); pending = null; }
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
        const frame = JSON.parse(line); const current = pending;
        if (!current || (current.id === 0 ? frame.version !== 'p10b-native-ready-v1' || frame.ready !== true
          : frame.id !== current.id || typeof frame.ok !== 'boolean')) throw Error();
        if (current.id !== 0 && Object.keys(frame).some(k => !['id', 'ok', 'error', 'machine'].includes(k))) throw Error();
        if (frame.error && !['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output'].includes(frame.error)) throw Error();
        clearTimeout(current.timer); pending = null;
        if (current.id !== 0 && frame.ok !== true) current.reject(Error(`Native request ${frame.error || 'request-failed'}`));
        else current.resolve(current.id === 0 ? true : frame.machine);
      } catch { fail(); return; }
    }
  });
  const send = (id, value, timeoutMs) => new Promise((resolve, reject) => {
    if (failed || closed || pending || clock() >= Date.parse(session.sessionDeadline)) { reject(Error('Native client unavailable')); return; }
    pending = { id, resolve, reject, timer: setTimeout(fail, timeoutMs) };
    child.stdin.write(`${JSON.stringify(value)}\n`, error => { if (error) fail(); });
  });
  try { await send(0, initialization, 10000); }
  catch { await reap(); throw Error('Native initialization failed; retain public diagnostics'); }
  let posts = 0;
  async function reap() {
    if (!closed) { child.stdin.end(); child.kill('SIGKILL'); }
    let timer;
    try { return Boolean(await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })])); }
    finally { clearTimeout(timer); }
  }
  return { pid: child.pid, client(method = 'GET', body, timeoutMs = 1000) {
    if (!['GET', 'POST'].includes(method) || (method === 'POST' && (readOnly || posts >= 3))) return Promise.reject(Error('Native request denied'));
    if (method === 'POST') posts++;
    return send(++sequence, { id: sequence, method, timeoutMs, ...(body ? { body } : {}) }, timeoutMs + 250);
  }, reap, async close() { return reap(); }, async terminal() { return exited; } };
}
