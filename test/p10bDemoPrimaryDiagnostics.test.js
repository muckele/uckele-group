import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const modes = { 'native-failure': 'native-baseline-read', 'native-reap': 'native-baseline-verification',
  'start-failure': 'machine-start-command', 'ssh-failure': 'readiness-command', 'invalid-json': 'readiness-json' };
for (const [mode, stage] of Object.entries(modes)) test(`actual demo primary CLI retains safe ${mode} stage and stops before readiness`, () => {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings',
    new URL('./helpers/p10bDemoPrimaryVm.js', import.meta.url).pathname, mode],
  { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.exitCode, 1); assert.equal(result.reaps, 1); assert.deepEqual(result.messages, []);
  const failure = result.records['p10b-runtime-only-demo-primary-failure.json'];
  assert.ok(failure, 'Primary failure facts were discarded');
  assert.equal(failure.stage, stage); assert.equal(failure.productionReady, false);
  assert.equal(JSON.stringify(failure).includes('canary'), false);
  if (mode === 'native-failure') assert.equal(failure.nativeFailure.code, 'timed-out');
  assert.equal(failure.nativeReapVerified, mode !== 'native-reap');
  if (mode === 'start-failure') assert.equal(failure.commandFailure.reason, 'timed-out');
  if (mode === 'ssh-failure') assert.equal(failure.commandFailure.exitCode, 17);
  assert.equal(result.calls.filter(c => c.operation === 'machine').length, mode.startsWith('native') ? 0 : 1);
});

test('actual demo primary success still sends readiness after one start with unchanged command budgets', () => {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings',
    new URL('./helpers/p10bDemoPrimaryVm.js', import.meta.url).pathname, 'success'],
  { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.exitCode, 0); assert.equal(result.reaps, 0); assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].freshPathsVerified, true);
  assert.deepEqual(result.calls, [{ operation: 'machine', timeout: 10000 }, { operation: 'ssh', timeout: 5000 }]);
  assert.equal(result.records['p10b-runtime-only-demo-primary-failure.json'], undefined);
});
