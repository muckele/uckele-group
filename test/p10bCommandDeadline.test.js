import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createP10bOperatorProcesses, publicP10bCommandFailure } from '../server/services/p10bOperatorProcesses.js';

const block = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const timedOut = error => {
  assert.deepEqual(publicP10bCommandFailure(error), {
    version: 'p10b-public-command-failure-v1', reason: 'timed-out', timeoutMs: 700,
    exitCode: 0, signal: null, clientsReaped: true,
  });
  return true;
};

test('owned launch overhead consumes the original command deadline', { timeout: 5000 }, async t => {
  let child; let closed;
  const manager = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    spawnProcess(_file, _args, options) {
      child = spawn(process.execPath, ['-e', "process.stdout.write('synthetic finite snapshot')"], options);
      closed = new Promise(resolve => child.once('close', resolve));
      // The owned child completes while the synchronous launch boundary is held.
      block(750); return child;
    } });
  t.after(async () => { assert.equal(await manager.reap(), true); });
  await assert.rejects(manager.command('/synthetic/not-fly', [], 700), error => {
    const facts = publicP10bCommandFailure(error);
    assert.equal(facts.reason, 'timed-out'); assert.equal(facts.timeoutMs, 700);
    return true;
  });
  // A watchdog may precede Darwin's final close/absence notification; a
  // failed receipt stays conservative while the separate cleanup must verify.
  await closed;
  assert.equal(await manager.reap(), true);
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
});

test('a queued successful close cannot beat an overdue command timer', async t => {
  const pid = 2147483001;
  t.mock.method(process, 'kill', target => {
    assert.equal(target, -pid); throw Object.assign(Error('synthetic absent group'), { code: 'ESRCH' });
  });
  const manager = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    spawnProcess() {
      const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough() });
      // Microtasks precede overdue timer callbacks; model a stalled owner loop.
      queueMicrotask(() => { block(750); child.emit('close', 0, null); });
      return child;
    } });
  await assert.rejects(manager.command('/synthetic/not-fly', [], 700), timedOut);
  assert.equal(await manager.reap(), true);
});
