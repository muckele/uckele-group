import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertP10bNoEmailApproval } from './p10bRuntimeOnlyOperator.js';
import { assertP10bStoppedUpdateApproval } from './p10bStoppedUpdateContract.js';
const assertCredentialApproval = (session, approval, now) => session?.version === 'p10b-stopped-update-session-v1'
  ? assertP10bStoppedUpdateApproval(session, approval, now) : assertP10bNoEmailApproval(session, approval, now);

// Opaque, owner-supplied input only. No creation, parsing, renewal or persistent
// account configuration is performed here. Public issuance evidence is separate.
function privateEnvironment(environment, directory) {
  const token = environment.FLY_API_TOKEN;
  if (typeof token !== 'string' || !token.trim() || token.length > 16384
    || [...token].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw Error('Private app credential input required');
  }
  return { PATH: environment.PATH, HOME: environment.HOME, FLY_NO_UPDATE_CHECK: '1', FLY_AGENT_ISOLATED: '1',
    FLY_CONFIG_DIR: directory, FLY_API_TOKEN: token, P10B_APP_TOKEN_CONTEXT: 'p10b-app-token-context-v1' };
}

function privateDirectory(directory) {
  if (typeof directory !== 'string' || path.dirname(directory) !== os.tmpdir()
    || !/^p10b-app-auth-[A-Za-z0-9]+$/.test(path.basename(directory))) throw Error('Isolated app authentication directory required');
  let stat;
  try { stat = fs.lstatSync(directory, { bigint: true }); } catch { throw Error('Isolated app authentication directory unavailable'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== process.getuid() || (Number(stat.mode) & 0o777) !== 0o700) {
    throw Error('Private owner-controlled authentication directory required');
  }
  return stat;
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function p10bAppTokenWorkingDirectory(environment = {}) {
  if (environment.P10B_APP_TOKEN_CONTEXT !== 'p10b-app-token-context-v1') return undefined;
  privateDirectory(environment.FLY_CONFIG_DIR);
  return environment.FLY_CONFIG_DIR;
}

// Reserve before spawning. A failed/abrupt descendant leaves its own intent;
// the root never treats an exited controller as proof of descendant reaping.
export function reserveP10bLocalReap(environment = {}) {
  if (environment.P10B_APP_TOKEN_CONTEXT !== 'p10b-app-token-context-v1') return { retire() {} };
  const directory = environment.FLY_CONFIG_DIR; privateDirectory(directory);
  const file = path.join(directory, `.p10b-reap-${randomUUID()}.pending`);
  let original;
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeSync(fd, 'p10b-local-reap-pending-v1\n'); fs.fsyncSync(fd); original = fs.fstatSync(fd, { bigint: true }); }
    finally { fs.closeSync(fd); }
    syncDirectory(directory);
  } catch { throw Error('Private local-reap reservation unverified'); }
  let retired = false;
  return { retire(verified) {
    if (retired || verified !== true) return;
    try {
      privateDirectory(directory);
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev
        || current.uid !== original.uid || current.mode !== original.mode || current.size !== original.size) throw Error();
      fs.unlinkSync(file); syncDirectory(directory); retired = true;
    } catch { throw Error('Private local-reap retirement unverified'); }
  } };
}

export function createP10bAppTokenContext({ session, approval, clock = () => Date.now(), environment = process.env }) {
  assertCredentialApproval(session, approval, clock());
  // Validate input before allocating anything, and ignore any owner's config dir.
  const env = privateEnvironment(environment, undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-app-auth-'));
  const original = privateDirectory(directory);
  env.FLY_CONFIG_DIR = directory;
  let closed = false;
  const context = { assertReaped() {
    try {
      const current = privateDirectory(directory);
      if (current.ino !== original.ino || current.dev !== original.dev
        || fs.readdirSync(directory).some(name => name.startsWith('.p10b-reap-'))) throw Error();
      return true;
    } catch { throw Error('Private descendant-reap proof unavailable'); }
  }, cleanup({ reaped }) {
    if (closed) return true;
    if (reaped !== true) throw Error('Private authentication cleanup held: reap unverified');
    try {
      context.assertReaped();
      fs.rmSync(directory, { recursive: true, force: false });
    }
    catch { throw Error('Private authentication cleanup/reap unverified'); }
    delete env.FLY_API_TOKEN; closed = true; return true;
  } };
  // Accidental serialization of a context cannot publish its environment.
  Object.defineProperty(context, 'environment', { value: env, enumerable: false });
  return context;
}

export function p10bInheritedAppTokenEnvironment({ session, approval, clock = () => Date.now(), environment = process.env }) {
  assertCredentialApproval(session, approval, clock());
  const directory = environment.FLY_CONFIG_DIR;
  privateDirectory(directory);
  return privateEnvironment(environment, directory);
}
