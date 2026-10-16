import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
const modes = { 'native-failure': 'native-baseline-read', 'native-reap': 'native-baseline-verification',
  'start-failure': 'machine-start-command', 'ssh-failure': 'readiness-command', 'invalid-json': 'readiness-json',
  'ipc-async-failure': 'readiness-ipc', 'ipc-missing': 'readiness-ipc',
  'readiness-checkpoint-publication': 'publish-primary-readiness' };
for (const [mode, stage] of Object.entries(modes)) test(`actual demo primary CLI retains safe ${mode} stage and stops before readiness`, () => {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings',
    new URL('./helpers/p10bDemoPrimaryVm.js', import.meta.url).pathname, mode],
  { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.exitCode, 1); assert.equal(result.reaps, 1); assert.deepEqual(result.messages, []);
  assert.equal(result.unhandledIpcErrors, 0);
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
  const parsed = result.records['p10b-runtime-only-demo-primary-readiness.json'];
  assert.ok(parsed, 'Parsed-readiness checkpoint was discarded');
  assert.equal(parsed.version, 'p10b-demo-primary-readiness-v1');
  assert.equal(parsed.productionReady, false); assert.equal(parsed.readinessParsed, true);
  assert.match(parsed.readinessDigest, /^[a-f0-9]{64}$/);
});

for (const mode of ['no-callback', 'callback']) test(`actual Node closed IPC ${mode} demonstrates asynchronous failure outside try/catch`, async t => {
  const child = spawn(process.execPath, [new URL('./helpers/p10bIpcFailureFixture.js', import.meta.url).pathname, mode],
    { stdio: ['ignore', 'pipe', 'ignore', 'ipc'], env: { HOME: '/tmp', PATH: '/usr/bin:/bin' } });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const outputEnded = new Promise(resolve => child.stdout.once('end', resolve));
  t.after(async () => {
    child.kill('SIGKILL'); let cleanupTimer;
    try { await Promise.race([exited, new Promise((_, reject) => {
      cleanupTimer = setTimeout(() => reject(Error('Synthetic IPC child cleanup timed out')), 1500);
    })]); } finally { clearTimeout(cleanupTimer); }
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; assert.ok(output.length < 1024); });
  let timer;
  try {
    const ready = await Promise.race([new Promise(resolve => child.once('message', resolve)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic IPC readiness timed out')), 5000); })]);
    assert.equal(ready.fixtureReady, true); clearTimeout(timer); child.disconnect();
    // Explicit parent-side IPC disconnect need not emit ChildProcess.close;
    // this narrow API probe awaits OS exit and drained stdout separately.
    const [terminal] = await Promise.race([Promise.all([exited, outputEnded]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic IPC exit timed out')), 5000); })]);
    assert.deepEqual(terminal, { code: 1, signal: null });
    assert.deepEqual(JSON.parse(output), { caughtSynchronously: false,
      asynchronousErrorEvents: mode === 'no-callback' ? 1 : 0, callbackFailures: mode === 'callback' ? 1 : 0 });
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally { clearTimeout(timer); }
});
