import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createP10bOperatorProcesses, publicP10bCommandFailure } from '../server/services/p10bOperatorProcesses.js';

for (const mode of ['command-timeout', 'explicit-termination', 'terminal-uncertainty']) {
  test(`unreaped ${mode} permanently closes new process admission while preserving cleanup`, async t => {
    let launches = 0; const pid = 2147483002;
    t.mock.method(process, 'kill', target => {
      assert.equal(target, -pid); throw Object.assign(Error('synthetic denied signal'), { code: 'EPERM' });
    });
    const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough() });
    const manager = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
      spawnProcess() { launches++; return child; } });
    if (mode === 'command-timeout') {
      await assert.rejects(manager.command('/synthetic', [], 10), error => {
        const facts = publicP10bCommandFailure(error); assert.equal(facts.reason, 'timed-out');
        assert.equal(facts.clientsReaped, false); return true;
      });
    } else {
      const entry = manager.launch('/synthetic', []);
      if (mode === 'explicit-termination') assert.equal(await manager.terminate(entry), false);
      else { child.emit('close', 0, null); await entry.exited; assert.equal(entry.reaped, false); }
    }
    assert.throws(() => manager.launch('/synthetic', []), /retirement uncertain/);
    await assert.rejects(manager.command('/synthetic', [], 10), /retirement uncertain/);
    assert.equal(launches, 1); assert.equal(await manager.reap(), false);
  });
}

test('spawn failure closes admission without dispatching another child', async () => {
  let calls = 0;
  const manager = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin' },
    spawnProcess() { calls++; throw Error('synthetic private spawn failure'); } });
  assert.throws(() => manager.launch('/synthetic', []));
  assert.throws(() => manager.launch('/synthetic', []), /retirement uncertain/);
  assert.equal(calls, 1);
});

test('positive later group absence permits cleanup but cannot reopen new launch admission', async t => {
  let gone = false; const pid = 2147483002;
  t.mock.method(process, 'kill', target => {
    assert.equal(target, -pid); throw Object.assign(Error('synthetic'), { code: gone ? 'ESRCH' : 'EPERM' });
  });
  const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough() });
  const manager = createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin' }, spawnProcess: () => child });
  const entry = manager.launch('/synthetic', []); assert.equal(await manager.terminate(entry), false);
  gone = true; child.emit('close', null, 'SIGKILL'); await entry.exited;
  assert.equal(await manager.reap(), true);
  assert.throws(() => manager.launch('/synthetic', []), /retirement uncertain/);
});
