// Public failure provenance is a closed vocabulary. Never retain exception
// messages, stacks, stderr, environment values or arbitrary remote fields.
const stages = {
  host: new Set(['preflight', 'starting', 'worker', 'closing', 'stopping', 'terminal-verification']),
  worker: new Set(['bootstrap', 'packet', 'runtime-binding', 'guardian-ready', 'registration',
    'storage-open', 'fresh-start', 'prepare', 'sqlite-close', 'ingress-close', 'artifact-write',
    'shutdown-handoff', 'qualification-binding', 'qualify']),
  transport: new Set(['get-machine', 'get-secret-metadata', 'start-machine', 'open-worker']),
};
const reasons = new Set(['operation-failed', 'timed-out', 'cancelled', 'command-failed',
  'output-bound', 'invalid-output', 'invalid-diagnostic', 'module-unavailable',
  'native-module-unavailable', 'file-unavailable', 'permission-denied', 'sqlite-failed']);
const signals = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP']);
const version = 'p10b-runtime-failure-v1';
const fields = new Set(['version', 'origin', 'stage', 'reason', 'exitCode', 'signal']);

export function validateP10bRuntimeFailure(value) {
  return Boolean(value && !Array.isArray(value) && value.version === version
    && Object.keys(value).every(key => fields.has(key))
    && typeof value.origin === 'string' && Object.hasOwn(stages, value.origin)
    && stages[value.origin].has(value.stage) && reasons.has(value.reason)
    && (value.exitCode === undefined || value.exitCode === null
      || (Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255))
    && (value.signal === undefined || value.signal === null || signals.has(value.signal)));
}

export function p10bRuntimeFailure(origin, stage, error, terminal = {}) {
  if (validateP10bRuntimeFailure(error?.p10bFailure)) return { ...error.p10bFailure };
  let reason = terminal.reason || 'operation-failed';
  if (!terminal.reason) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code)) reason = 'module-unavailable';
    else if (error?.code === 'ERR_DLOPEN_FAILED') reason = 'native-module-unavailable';
    else if (error?.code === 'ENOENT') reason = 'file-unavailable';
    else if (['EACCES', 'EPERM'].includes(error?.code)) reason = 'permission-denied';
    else if (/^SQLITE_[A-Z_]+$/.test(error?.code || '')) reason = 'sqlite-failed';
  }
  const value = { version, origin, stage, reason,
    ...('exitCode' in terminal ? { exitCode: terminal.exitCode } : {}),
    ...('signal' in terminal ? { signal: signals.has(terminal.signal) ? terminal.signal : null } : {}) };
  if (!validateP10bRuntimeFailure(value)) throw Error('Invalid local failure vocabulary');
  return value;
}

export function p10bFailureError(origin, stage, error, terminal) {
  const failure = new Error('Isolated runtime operation failed');
  failure.p10bFailure = p10bRuntimeFailure(origin, stage, error, terminal);
  return failure;
}
