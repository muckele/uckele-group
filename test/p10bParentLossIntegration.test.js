import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const helper = new URL('./helpers/p10bDemoPrimaryVm.js', import.meta.url).pathname;
function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(label)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
const absent = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { assert.equal(error.code, 'ESRCH'); return true; }
};

function rehearsal(t, mode, options = {}) {
  const child = spawn(process.execPath, ['--experimental-vm-modules', '--no-warnings', helper,
    mode, JSON.stringify({ realParent: true, ...options })], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
  });
  const events = []; const commands = new Map(); const waiting = new Set();
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; assert.ok(output.length <= 65536); });
  child.stderr.on('data', chunk => { errors += chunk; assert.ok(errors.length <= 8192); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const drained = new Promise(resolve => child.stdout.once('end', resolve));
  child.on('message', value => {
    events.push(value);
    if (value.fixtureEvent === 'command-started') commands.set(value.pid, { ...value, exited: false });
    if (value.fixtureEvent === 'command-exited' && commands.has(value.pid)) commands.get(value.pid).exited = true;
    for (const waiter of waiting) if (waiter.predicate(value)) { waiting.delete(waiter); waiter.resolve(value); }
  });
  const until = (predicate, milliseconds = 3000) => {
    const existing = events.find(predicate); if (existing) return Promise.resolve(existing);
    const waiter = { predicate };
    return bounded(new Promise(resolve => { waiter.resolve = resolve; waiting.add(waiter); }), milliseconds,
      'Synthetic primary event timed out').finally(() => waiting.delete(waiter));
  };
  const terminal = milliseconds => bounded(Promise.all([exited, drained]), milliseconds,
    'Synthetic primary failed to exit and drain after parent loss').then(([value]) => value);
  t.after(async () => {
    // Only these freshly spawned fixture groups are eligible for cleanup.
    if (!absent(child.pid)) { process.kill(-child.pid, 'SIGKILL'); await bounded(exited, 2000, 'Fixture primary cleanup failed'); }
    for (const [pid, command] of commands) {
      if (!command.exited && !absent(pid)) {
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { assert.equal(error.code, 'ESRCH'); }
        const end = performance.now() + 2000;
        while (!absent(pid) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(absent(pid), true, 'Owned fixture command cleanup remained uncertain');
      }
    }
    if (child.connected) child.disconnect();
  });
  return { child, commands, until, terminal, result: () => {
    assert.equal(errors, ''); return JSON.parse(output);
  } };
}

function verifyReaped(fixture, result) {
  assert.equal(absent(fixture.child.pid), true);
  assert.deepEqual([...fixture.commands.keys()], result.commandPids);
  for (const pid of result.commandPids) {
    assert.equal(absent(pid), true, 'Synthetic command survived primary closure');
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  }
  assert.equal(result.calls.filter(value => value.operation === 'machine').length, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.unhandledIpcErrors, 0);
}

test('real one-second start and six-second partial SSH readiness survive inside the common deadline, then parent loss exits', { timeout: 15000 }, async t => {
  const began = performance.now();
  const f = rehearsal(t, 'success', { startMs: 1000, sshMs: 6000 });
  const ready = await f.until(value => value.freshPathsVerified === true, 11000);
  assert.equal(ready.sourceHead, 'a'.repeat(40));
  const elapsed = performance.now() - began;
  assert.ok(elapsed >= 6900, 'Readiness did not wait for the real partial command');
  assert.ok(elapsed < 15000, 'Readiness escaped the original deadline');
  const disconnected = performance.now(); f.child.disconnect();
  assert.deepEqual(await f.terminal(3000), { code: 1, signal: null });
  assert.ok(performance.now() - disconnected < 3000);
  const result = f.result(); verifyReaped(f, result);
  assert.equal(result.parentConnected, false);
  assert.equal(result.messages.length, 1);
  assert.equal(result.records['p10b-runtime-only-demo-primary-readiness.json'].readinessParsed, true);
  assert.equal(result.records['p10b-runtime-only-demo-primary-failure.json'].stage, 'parent-lease-loss');
  assert.equal(result.records['p10b-runtime-only-demo-primary-failure.json'].clientsReaped, true);
});

test('real parent loss during partial hanging SSH cancels and reaps it without publishing readiness or later work', { timeout: 7000 }, async t => {
  const f = rehearsal(t, 'hang');
  await f.until(value => value.fixtureEvent === 'command-started' && value.operation === 'ssh');
  f.child.disconnect();
  assert.deepEqual(await f.terminal(3000), { code: 1, signal: null });
  const result = f.result(); verifyReaped(f, result);
  assert.equal(result.parentConnected, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.records['p10b-runtime-only-demo-primary-readiness.json'], undefined);
  const failure = result.records['p10b-runtime-only-demo-primary-failure.json'];
  assert.equal(failure.stage, 'parent-lease-loss'); assert.equal(failure.clientsReaped, true);
});

for (const mode of ['invalid-json', 'partial-json', 'hang']) {
  test(`real ${mode} SSH fails and reaps within its existing allowance with one start`, { timeout: 7000 }, async t => {
    // Consume old intent time rather than introducing a test-only timeout.
    const f = rehearsal(t, mode, mode === 'hang' ? { intentAgeMs: 12000 } : {});
    assert.deepEqual(await f.terminal(5000), { code: 1, signal: null });
    const result = f.result(); verifyReaped(f, result);
    assert.equal(result.parentConnected, true, 'Harness must leave failed primary IPC connected until natural exit');
    assert.deepEqual(result.messages, []);
    const failure = result.records['p10b-runtime-only-demo-primary-failure.json'];
    assert.equal(failure.stage, mode === 'hang' ? 'readiness-command' : 'readiness-json');
    assert.equal(failure.clientsReaped, true);
    assert.equal(result.records['p10b-runtime-only-demo-primary-readiness.json'], undefined);
    if (mode === 'hang') assert.equal(failure.commandFailure.reason, 'timed-out');
    assert.equal(JSON.stringify(result.records).includes('canary'), false);
  });
}
