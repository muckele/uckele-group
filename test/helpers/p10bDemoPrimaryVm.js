// Execute the unchanged production CLI control flow with synthetic external
// modules. No native executable, Fly command, auth directory or live input.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';
import { createP10bOperatorProcesses, P10bOperatorCommandError, publicP10bCommandFailure } from '../../server/services/p10bOperatorProcesses.js';
import { P10bNativeRequestError, publicP10bNativeFailure } from '../../server/services/p10bNativeFailure.js';
const override = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const mode = process.argv[2]; const source = override.sourcePath ? pathToFileURL(override.sourcePath)
  : new URL('../../scripts/run-p10b-demo-primary.js', import.meta.url);
const now = override.now ?? Date.now(); let currentTime = now + (override.launchDelayMs || 0);
let elapsedTime = 0;
const advance = ms => { currentTime += ms; elapsedTime += ms; };
const session = override.session || { sourceHead: 'a'.repeat(40), machineId: '0803730bd1d7e8', app: 'uckele-group-p10b' };
const machine = override.machine || { state: 'stopped', instance_id: 'synthetic-version', config: { synthetic: true } };
const windowStart = now - Math.max(1000, override.intentAgeMs || 0);
const phase = override.phase || { label: 'demo', config: machine.config, window: { issuedAt: new Date(windowStart).toISOString(), stopAt: new Date(windowStart + 300000).toISOString() } };
const records = {}; const calls = []; const messages = []; let reaps = 0; let stderr = '';
const intent = Object.hasOwn(override, 'intent') ? override.intent : { at: new Date(now - (override.intentAgeMs || 0)).toISOString(), window: phase.window };
const input = { session, approval: {}, phase, recovery: {}, machine, flyExecutable: '/synthetic/fly', nativeExecutable: '/synthetic/native' };
const syntheticProcesses = { async command(_file, args, timeout) {
  calls.push({ operation: args[0], timeout });
  if (args[0] === 'machine') {
    advance(override.startMs || 0);
    if (mode === 'start-failure') throw new P10bOperatorCommandError('timed-out', timeout, { code: null, signal: 'SIGKILL' }, true);
    return '';
  }
  const elapsed = override.sshMs || 0; advance(elapsed);
  currentTime -= override.wallRollbackMs || 0;
  if (elapsed > timeout && !override.ignoreTimeout) throw new P10bOperatorCommandError('timed-out', timeout, { code: null, signal: 'SIGKILL' }, override.reaped !== false);
  if (mode === 'ssh-failure') throw new P10bOperatorCommandError('command-failed', timeout, { code: 17, signal: null }, true);
  return mode === 'invalid-json' ? 'synthetic-private-json-canary' : JSON.stringify({ sourceHead: session.sourceHead, freshPathsVerified: true });
}, async reap() { reaps++; return override.reaped !== false; } };
// The real-OS rehearsal redirects the one synthetic executable boundary only.
// Production command timeout, process-group ownership and reap logic stay real.
const commandPids = [];
const actualProcesses = override.realParent ? createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
  spawnProcess(file, args, options) {
    if (file !== '/synthetic/fly') throw Error('Only synthetic Fly boundary admitted');
    const operation = args[0];
    const ready = JSON.stringify({ sourceHead: session.sourceHead, freshPathsVerified: true });
    const script = operation === 'machine' ? `setTimeout(()=>{},${override.startMs ?? 10});`
      : mode === 'hang' ? `process.stdout.write('{');setInterval(()=>{},1000);`
        : mode === 'invalid-json' ? `process.stdout.write('synthetic-private-json-canary');`
          : mode === 'partial-json' ? `process.stdout.write('{"sourceHead":');`
            : `const output=${JSON.stringify(ready)};process.stdout.write(output.slice(0,12));setTimeout(()=>process.stdout.write(output.slice(12)),${override.sshMs ?? 20});`;
    const child = spawn(process.execPath, ['-e', script], options);
    commandPids.push(child.pid);
    process.send?.({ fixtureEvent: 'command-started', operation, pid: child.pid }, () => {});
    child.once('exit', () => { if (process.connected) process.send?.({ fixtureEvent: 'command-exited', pid: child.pid }, () => {}); });
    return child;
  } }) : null;
const processes = actualProcesses ? { command(file, args, timeout) {
  calls.push({ operation: args[0], timeout }); return actualProcesses.command(file, args, timeout);
}, async reap() { reaps++; return actualProcesses.reap(); } } : syntheticProcesses;
const modules = {
  './p10bOperatorProcesses.js': { createP10bOperatorProcesses: () => processes, publicP10bCommandFailure },
  './p10bOperatorFiles.js': { readP10bPublicJson: () => input, inspectP10bRecovery: () => ({}),
    createP10bOperatorEvidence: () => ({ read: () => intent, has: n => Object.hasOwn(records, n), write(n, v) {
      if (mode === 'readiness-checkpoint-publication' && n === 'p10b-runtime-only-demo-primary-readiness.json') throw Error('synthetic private write canary');
      if (Object.hasOwn(records, n)) throw Error(); records[n] = v;
      if (n === 'p10b-runtime-only-demo-primary-readiness.json') advance(override.publicationMs || 0);
      if (mode === 'ipc-missing' && n === 'p10b-runtime-only-demo-primary-readiness.json') localProcess.send = undefined;
    } }) },
  './p10bAdmissionRecovery.js': { assertP10bRecoveryAdmission: () => {} },
  './p10bRuntimeOnlyOperator.js': { assertP10bNoEmailApproval: () => {}, assertP10bFrozenPhase: () => {} },
  './p10bNativeMachineClient.js': { openP10bNativeMachineClient: async () => ({ async client() {
    advance(override.initializationMs || 0);
    if (mode === 'native-failure') throw new P10bNativeRequestError({ code: 'timed-out', method: 'GET', timeoutMs: 1000 });
    return machine;
  }, async reap() { return mode !== 'native-reap'; } }) },
  './p10bNativeFailure.js': { publicP10bNativeFailure },
  './security.js': { sha256, stableCanonicalJson },
  './p10bOperatorSource.js': { assertP10bNoEmailHostBinding: () => {}, assertP10bFlyExecutable: () => {} },
  './p10bHostAuthentication.js': { p10bInheritedAppTokenEnvironment: () => ({}) },
};
let unhandledIpcErrors = 0;
const localProcess = Object.assign(new EventEmitter(), { connected: true, argv: ['node', fileURLToPath(source), '/synthetic/input.json'],
  send(value, callback) {
    if (mode === 'ipc-async-failure') {
      queueMicrotask(() => { const error = Error('synthetic-private-ipc-canary');
        if (callback) callback(error); else localProcess.emit('error', error); });
      return false;
    }
    messages.push(value);
    if (mode === 'ipc-no-callback') return false;
    advance(override.ipcMs || 0);
    if (callback) queueMicrotask(() => callback(null)); return true;
  }, stderr: { write: v => { stderr += v; } }, exitCode: 0 });
if (override.realParent) {
  Object.defineProperties(localProcess, { connected: { get: () => process.connected },
    exitCode: { get: () => process.exitCode || 0, set: value => { process.exitCode = value; } } });
  localProcess.send = (value, callback) => { messages.push(value); return process.send(value, callback); };
  // Delegate listener ownership too: a harness disconnect listener would keep
  // Node's IPC reference alive and hide whether the CLI closes its own lease.
  localProcess.on = process.on.bind(process);
  localProcess.removeListener = process.removeListener.bind(process);
}
// The real process would exit on the unhandled error. Retain that outcome for
// inspection without allowing the harness to replace the CLI's missing catch.
localProcess.on('error', () => { unhandledIpcErrors++; localProcess.exitCode = 1; });
const ClockDate = class extends Date {
  constructor(...args) { super(...(args.length ? args : [currentTime])); }
  static now() { return currentTime; }
};
// JSON.parse and the real canonical-JSON validator must share a realm, as
// they do in the production CLI; VM-only prototype identities are not input.
const context = vm.createContext({ process: localProcess, Date: override.realParent ? Date : ClockDate,
  performance: override.realParent ? performance : { now: () => elapsedTime },
  JSON, setInterval: override.realParent ? setInterval : () => {}, clearInterval: override.realParent ? clearInterval : () => {},
  setTimeout, clearTimeout, console });
const code = new vm.SourceTextModule(fs.readFileSync(source, 'utf8'), { context, identifier: source.href });
await code.link(async specifier => {
  const filename = path.basename(specifier);
  const exports = specifier === 'node:path' ? { default: path } : ['p10bDemoReadiness.js', 'p10bParentLease.js'].includes(filename)
    ? await import('../../server/services/' + filename) : modules['./' + filename];
  if (!exports) throw Error('Unstubbed external boundary: ' + specifier);
  return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context });
});
await code.evaluate();
if (mode === 'parent-loss-after-readiness') {
  localProcess.connected = false; localProcess.emit('disconnect'); await new Promise(setImmediate);
}
const report = () => process.stdout.write(JSON.stringify({ records, calls, messages, reaps, stderr,
  exitCode: localProcess.exitCode, unhandledIpcErrors,
  ...(override.realParent ? { commandPids, parentConnected: process.connected } : {}) }) + '\n');
if (override.realParent) {
  // A successful primary must remain alive solely under its actual IPC lease
  // and keepalive. Publish only at natural exit, never terminate it in the harness.
  process.once('beforeExit', report);
} else report();
