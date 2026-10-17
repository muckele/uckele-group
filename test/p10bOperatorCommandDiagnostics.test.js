import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as commands from '../server/services/p10bOperatorProcesses.js';

for (const mode of ['exit', 'timeout', 'output-bound', 'private-output']) test(`bounded public command retains safe ${mode} facts after reaping`, async () => {
  const secret = 'synthetic-private-command-canary';
  const manager = commands.createP10bOperatorProcesses({ environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: secret },
    spawnProcess: (_file, _args, options) => spawn(process.execPath, ['-e', mode === 'timeout' ? 'setInterval(()=>{},1000)'
      : mode === 'exit' ? `process.stderr.write('${secret}');process.exitCode=17`
      : mode === 'output-bound' ? "process.stdout.write('x'.repeat(140000))" : `process.stdout.write('${secret}')`], options) });
  try {
    await assert.rejects(manager.command('/synthetic/never-dispatched', [], mode === 'timeout' ? 50 : 3000), error => {
      assert.equal(typeof commands.publicP10bCommandFailure, 'function');
      const facts = commands.publicP10bCommandFailure(error);
      assert.equal(facts.reason, mode === 'exit' ? 'command-failed' : mode === 'timeout' ? 'timed-out' : mode);
      assert.equal(facts.timeoutMs, mode === 'timeout' ? 50 : 3000);
      assert.equal(facts.clientsReaped, true);
      if (mode === 'exit') assert.equal(facts.exitCode, 17);
      assert.equal(JSON.stringify(facts).includes(secret), false);
      assert.equal('message' in facts || 'stderr' in facts || 'stdout' in facts, false); return true;
    });
  } finally { assert.equal(await manager.reap(), true); }
});

test('untyped command error getters remain unread', () => {
  assert.equal(typeof commands.publicP10bCommandFailure, 'function');
  const error = {};
  for (const key of ['publicFailure', 'message', 'stack', 'code']) Object.defineProperty(error, key, { get() { throw Error('untyped getter read'); } });
  assert.equal(commands.publicP10bCommandFailure(error), null);
});
