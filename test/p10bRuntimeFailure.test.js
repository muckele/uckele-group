import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createP10bFlyControl } from '../server/services/p10bFlyControl.js';
import { p10bRuntimeFailure, validateP10bRuntimeFailure } from '../server/services/p10bRuntimeFailure.js';
import * as runtimeOnly from '../server/services/p10bRuntimeOnlyControl.js';

const target = { app: 'uckele-group-p10b', machineId: '0803730bd1d7e8' };
const privateText = 'synthetic-secret-do-not-retain';

test('runtime failure vocabulary cannot serialize arbitrary remote or exception fields', () => {
  const error = Object.assign(Error(privateText), { code: 'ENOENT', stack: privateText });
  const safe = p10bRuntimeFailure('worker', 'bootstrap', error);
  assert.equal(safe.reason, 'file-unavailable');
  assert.equal(JSON.stringify(safe).includes(privateText), false);
  for (const patch of [{ message: privateText }, { stage: privateText }, { reason: privateText },
    { origin: privateText }, { origin: '__proto__' }, { origin: 'constructor' }, { origin: ['worker'] },
    { signal: privateText }, { exitCode: privateText }, { exitCode: -1 }]) {
    assert.equal(validateP10bRuntimeFailure({ ...safe, ...patch }), false);
  }
});

test('an OS termination outside the public signal vocabulary safely rejects the command', async t => {
  const adapter = createP10bFlyControl({ spawnProcess: (_executable, _args, options) =>
    spawn(process.execPath, ['-e', "process.kill(process.pid,'SIGUSR2')"], options) });
  t.after(() => adapter.reap());
  await assert.rejects(adapter.getMachine(target), error => {
    assert.equal(error.p10bFailure.reason, 'command-failed');
    assert.equal(error.p10bFailure.exitCode, null); assert.equal(error.p10bFailure.signal, null); return true;
  });
});

test('operator child-completion path propagates actual child failure after retaining its exit', async () => {
  assert.equal(typeof runtimeOnly.awaitP10bPreparationChild, 'function');
  const child = spawn(process.execPath, ['-e', 'process.exitCode=7'], { stdio: 'ignore' });
  const exits = [];
  await assert.rejects(runtimeOnly.awaitP10bPreparationChild({ child,
    readResult: () => ({ success: false }), onExit: value => exits.push(value) }), /Preparation terminal failed/);
  assert.deepEqual(exits, [{ code: 7, signal: null }]);
});

test('operator completion segment exits nonzero for failed child or failed retained result', async () => {
  for (const code of [7, 0]) {
    const script = `
      import {spawn} from 'node:child_process';
      import {awaitP10bPreparationChild} from ${JSON.stringify(new URL('../server/services/p10bRuntimeOnlyControl.js', import.meta.url).href)};
      const child=spawn(process.execPath,['-e',${JSON.stringify(`process.exitCode=${code}`)}],{stdio:'ignore'});
      try {await awaitP10bPreparationChild({child,onExit:terminal=>process.stdout.write(JSON.stringify(terminal)+'\\n'),
        readResult:()=>({success:false})});}
      catch {process.stderr.write('Preparation terminal failed; retain evidence.\\n');process.exitCode=1;}
    `;
    const operator = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    operator.stdout.on('data', data => { stdout += data; }); operator.stderr.on('data', data => { stderr += data; });
    const [exitCode, signal] = await once(operator, 'close');
    assert.equal(exitCode, 1); assert.equal(signal, null);
    assert.deepEqual(JSON.parse(stdout), { code, signal: null });
    assert.equal(stderr, 'Preparation terminal failed; retain evidence.\n');
  }
});

test('first-mailbox CLI input failure exits nonzero without exposing raw exception text', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-cli-failure-'));
  const child = spawn(process.execPath, [new URL('../scripts/run-p10b-first-mailbox.js', import.meta.url).pathname,
    '--packet', path.join(directory, privateText), '--evidence-prefix', path.join(directory, 'retained')],
  { cwd: directory, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 1); assert.equal(signal, null); assert.equal(stdout, '');
  assert.equal(stderr, 'Isolated first-mailbox operation failed; retain evidence.\n');
});

test('concrete local command retains exit and timeout provenance without stderr', async t => {
  for (const variant of ['exit', 'timeout', 'invalid-json']) await t.test(variant, async t => {
    const adapter = createP10bFlyControl({ environment: { PATH: process.env.PATH, HOME: os.tmpdir() },
      spawnProcess: (_executable, args, options) => {
        assert.deepEqual(args, ['machines', 'list', '--app', target.app, '--json']);
        const script = variant === 'timeout' ? 'setInterval(()=>{},10000)'
          : variant === 'exit' ? `process.stderr.write(${JSON.stringify(privateText)});process.exitCode=17`
          : `process.stdout.write(${JSON.stringify(privateText)})`;
        return spawn(process.execPath, ['-e', script], options);
      } });
    t.after(() => adapter.reap());
    await assert.rejects(adapter.getMachine(target, { timeoutMs: variant === 'timeout' ? 50 : 2000 }), error => {
      assert.equal(error.p10bFailure.origin, 'transport'); assert.equal(error.p10bFailure.stage, 'get-machine');
      assert.equal(error.p10bFailure.reason,
        variant === 'timeout' ? 'timed-out' : variant === 'exit' ? 'command-failed' : 'invalid-output');
      if (variant === 'exit') assert.equal(error.p10bFailure.exitCode, 17);
      if (variant === 'timeout') assert.equal(error.p10bFailure.signal, 'SIGKILL');
      assert.equal(JSON.stringify(error.p10bFailure).includes(privateText), false); return true;
    });
    assert.equal(await adapter.reap(), true);
  });
});

test('SSH transport drains a diagnostic frame before reporting nonzero child exit', async t => {
  const failureDetails = p10bRuntimeFailure('worker', 'bootstrap', { code: 'ERR_MODULE_NOT_FOUND' });
  const adapter = createP10bFlyControl({ environment: { PATH: process.env.PATH, HOME: os.tmpdir() },
    spawnProcess: (_executable, _args, options) => spawn(process.execPath, ['-e',
      `process.stdout.write(${JSON.stringify(JSON.stringify({ version: 'p10b-control-v1', kind: 'worker-failed', failureDetails }) + '\n')});process.stderr.write(${JSON.stringify(privateText)});process.exitCode=9`], options) });
  t.after(() => adapter.reap());
  const worker = await adapter.openWorker(target);
  assert.deepEqual((await worker.channel.next()).failureDetails, failureDetails);
  await assert.rejects(worker.channel.next(), error => {
    assert.equal(error.p10bFailure.exitCode, 9); assert.equal(error.p10bFailure.stage, 'open-worker');
    assert.equal(JSON.stringify(error).includes(privateText), false); return true;
  });
  assert.equal(await worker.terminate(), true);
});

test('exact worker executable emits a safe bootstrap failure and exits nonzero', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p10b-bootstrap-'));
  const child = spawn(process.execPath, [new URL('../scripts/run-p10b-qualification-worker.js', import.meta.url).pathname],
    { cwd: directory, env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = once(child, 'close');
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 3000);
  const [code, signal] = await ended; clearTimeout(timer);
  assert.equal(expired, false, 'Bootstrap failure must exit even while SSH stdin remains open');
  assert.equal(code, 1); assert.equal(signal, null);
  const frame = JSON.parse(stdout.trim());
  assert.equal(frame.kind, 'worker-failed'); assert.equal(frame.failureDetails.stage, 'bootstrap');
  assert.equal(frame.failureDetails.reason, 'file-unavailable');
  assert.equal(stderr, 'Isolated qualification worker failed.\n');
});

test('operator preparation terminal gate rejects child failure and ambiguous receipts', () => {
  assert.equal(typeof runtimeOnly.assertP10bPreparationTerminal, 'function');
  const result = { version: 'p10b-host-result-v1', operation: 'prepare', success: true,
    stoppedVerified: true, processReaped: true, stopUncertain: false, startUncertain: false,
    productionReady: false, lifecycleVerified: false, failureStage: null,
    preparation: { providerCalls: 0, productionReady: false, ingressClosed: true, sqliteClosed: true,
      guestShutdown: { handoffVerified: true, cleanupUncertain: false, failure: false,
        authorityClosed: true, ingressClosed: true, workerSqliteClosed: true } } };
  assert.equal(runtimeOnly.assertP10bPreparationTerminal({ code: 0, signal: null, result }), true);
  for (const terminal of [{ code: 1, signal: null, result }, { code: null, signal: 'SIGKILL', result },
    { code: 0, signal: null, result: { ...result, success: false } },
    { code: 0, signal: null, result: { ...result, stopUncertain: true } },
    { code: 0, signal: null, result: { ...result, preparation: undefined } },
    { code: 0, signal: null, result: { ...result, preparation: { ...result.preparation, providerCalls: 1 } } }]) {
    assert.throws(() => runtimeOnly.assertP10bPreparationTerminal(terminal), /Preparation terminal failed/);
  }
});
