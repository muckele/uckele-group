// Execute the unchanged production CLI control flow with synthetic external
// modules. No native executable, Fly command, auth directory or live input.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';
import { P10bOperatorCommandError, publicP10bCommandFailure } from '../../server/services/p10bOperatorProcesses.js';
import { P10bNativeRequestError, publicP10bNativeFailure } from '../../server/services/p10bNativeFailure.js';
const mode = process.argv[2]; const source = new URL('../../scripts/run-p10b-demo-primary.js', import.meta.url);
const override = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const now = Date.now(); const session = override.session || { sourceHead: 'a'.repeat(40), machineId: '0803730bd1d7e8', app: 'uckele-group-p10b' };
const machine = override.machine || { state: 'stopped', instance_id: 'synthetic-version', config: { synthetic: true } };
const phase = override.phase || { label: 'demo', config: machine.config, window: { issuedAt: new Date(now - 1000).toISOString(), stopAt: new Date(now + 299000).toISOString() } };
const records = {}; const calls = []; const messages = []; let reaps = 0; let stderr = '';
const input = { session, approval: {}, phase, recovery: {}, machine, flyExecutable: '/synthetic/fly', nativeExecutable: '/synthetic/native' };
const processes = { async command(_file, args, timeout) {
  calls.push({ operation: args[0], timeout });
  if (args[0] === 'machine') {
    if (mode === 'start-failure') throw new P10bOperatorCommandError('timed-out', timeout, { code: null, signal: 'SIGKILL' }, true);
    return '';
  }
  if (mode === 'ssh-failure') throw new P10bOperatorCommandError('command-failed', timeout, { code: 17, signal: null }, true);
  return mode === 'invalid-json' ? 'synthetic-private-json-canary' : JSON.stringify({ sourceHead: session.sourceHead, freshPathsVerified: true });
}, async reap() { reaps++; return true; } };
const modules = {
  './p10bOperatorProcesses.js': { createP10bOperatorProcesses: () => processes, publicP10bCommandFailure },
  './p10bOperatorFiles.js': { readP10bPublicJson: () => input, inspectP10bRecovery: () => ({}),
    createP10bOperatorEvidence: () => ({ has: n => Object.hasOwn(records, n), write(n, v) {
      if (mode === 'readiness-checkpoint-publication' && n === 'p10b-runtime-only-demo-primary-readiness.json') throw Error('synthetic private write canary');
      if (Object.hasOwn(records, n)) throw Error(); records[n] = v;
    } }) },
  './p10bAdmissionRecovery.js': { assertP10bRecoveryAdmission: () => {} },
  './p10bRuntimeOnlyOperator.js': { assertP10bNoEmailApproval: () => {}, assertP10bFrozenPhase: () => {} },
  './p10bNativeMachineClient.js': { openP10bNativeMachineClient: async () => ({ async client() {
    if (mode === 'native-failure') throw new P10bNativeRequestError({ code: 'timed-out', method: 'GET', timeoutMs: 1000 });
    return machine;
  }, async reap() { return mode !== 'native-reap'; } }) },
  './p10bNativeFailure.js': { publicP10bNativeFailure },
  './security.js': { sha256, stableCanonicalJson },
  './p10bOperatorSource.js': { assertP10bNoEmailHostBinding: () => {}, assertP10bFlyExecutable: () => {} },
  './p10bHostAuthentication.js': { p10bInheritedAppTokenEnvironment: () => ({}) },
};
let unhandledIpcErrors = 0;
const localProcess = Object.assign(new EventEmitter(), { argv: ['node', fileURLToPath(source), '/synthetic/input.json'],
  send(value, callback) {
    if (mode === 'ipc-async-failure') {
      queueMicrotask(() => { const error = Error('synthetic-private-ipc-canary');
        if (callback) callback(error); else localProcess.emit('error', error); });
      return false;
    }
    messages.push(value); if (callback) queueMicrotask(() => callback(null)); return true;
  }, stderr: { write: v => { stderr += v; } }, exitCode: 0 });
// The real process would exit on the unhandled error. Retain that outcome for
// inspection without allowing the harness to replace the CLI's missing catch.
localProcess.on('error', () => { unhandledIpcErrors++; localProcess.exitCode = 1; });
if (mode === 'ipc-missing') localProcess.send = undefined;
const ClockDate = override.now === undefined ? Date : class extends Date {
  constructor(...args) { super(...(args.length ? args : [override.now])); }
  static now() { return override.now; }
};
// JSON.parse and the real canonical-JSON validator must share a realm, as
// they do in the production CLI; VM-only prototype identities are not input.
const context = vm.createContext({ process: localProcess, Date: ClockDate, JSON, setInterval() {}, console });
const code = new vm.SourceTextModule(fs.readFileSync(source, 'utf8'), { context, identifier: source.href });
await code.link(async specifier => {
  const filename = path.basename(specifier);
  const exports = specifier === 'node:path' ? { default: path } : modules['./' + filename];
  if (!exports) throw Error('Unstubbed external boundary: ' + specifier);
  return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context });
});
await code.evaluate();
process.stdout.write(JSON.stringify({ records, calls, messages, reaps, stderr, exitCode: localProcess.exitCode, unhandledIpcErrors }) + '\n');
