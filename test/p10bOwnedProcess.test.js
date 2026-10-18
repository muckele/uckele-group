import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnP10bOwnedProcess } from '../server/services/p10bOwnedProcess.js';

function fixture(t, probe, signal = () => true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-app-auth-'));
  const pid = 2147483002;
  const calls = [];
  const originalKill = process.kill;
  process.kill = (target, value) => {
    if (target !== -pid) return originalKill(target, value);
    calls.push(value);
    return value === 0 ? probe() : signal();
  };
  t.after(() => {
    process.kill = originalKill;
    // This directory contains only the synthetic reservation for this test.
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const child = Object.assign(new EventEmitter(), { pid });
  const entry = spawnP10bOwnedProcess('/synthetic/executable', [], {
    environment: { P10B_APP_TOKEN_CONTEXT: 'p10b-app-token-context-v1', FLY_CONFIG_DIR: directory },
    spawnProcess: () => child,
  });
  const pending = () => fs.readdirSync(directory).filter(name => name.startsWith('.p10b-reap-'));
  return { child, entry, calls, pending };
}
const error = code => { throw Object.assign(Error('synthetic group result'), { code }); };

test('closed owned child resolves transient post-kill EPERM only after positive group absence', async t => {
  let probes = 0;
  const f = fixture(t, () => {
    probes++;
    if (probes === 1) return true;
    return error(probes === 2 ? 'EPERM' : 'ESRCH');
  });
  f.child.emit('close', 0, null);
  assert.deepEqual(await f.entry.exited, { code: 0, signal: null });
  assert.equal(f.entry.reaped, true);
  assert.deepEqual(f.pending(), []);
  assert.deepEqual(f.calls.slice(0, 3), [0, 'SIGKILL', 0]);
  assert.ok(f.calls.slice(3).length > 0);
  assert.ok(f.calls.slice(3).every(value => value === 0));
});

test('permission uncertainty after exact child close permits only bounded read-only absence probes', async t => {
  let probes = 0;
  const f = fixture(t, () => error(++probes === 1 ? 'EPERM' : 'ESRCH'));
  f.child.emit('close', 0, null);
  await f.entry.exited;
  assert.equal(f.entry.reaped, true);
  assert.deepEqual(f.pending(), []);
  assert.ok(f.calls.length >= 2);
  assert.ok(f.calls.every(value => value === 0));
});

test('persistent permission uncertainty retains owned reservation within the existing bound', async t => {
  const f = fixture(t, () => error('EPERM'));
  const started = performance.now();
  f.child.emit('close', 0, null);
  await f.entry.exited;
  assert.equal(f.entry.reaped, false);
  assert.equal(f.pending().length, 1);
  assert.ok(performance.now() - started < 1500);
  assert.ok(f.calls.every(value => value === 0));
});

test('a present group after permission uncertainty remains held without another signal', async t => {
  let probes = 0;
  const f = fixture(t, () => ++probes === 1 ? error('EPERM') : true);
  f.child.emit('close', 0, null);
  await f.entry.exited;
  assert.equal(f.entry.reaped, false);
  assert.equal(f.pending().length, 1);
  assert.ok(f.calls.length > 1);
  assert.ok(f.calls.every(value => value === 0));
});

test('denied group kill after child close requires a subsequent positive absence probe', async t => {
  let probes = 0;
  const f = fixture(t, () => ++probes === 1 ? true : error('ESRCH'), () => error('EPERM'));
  f.child.emit('close', 0, null);
  await f.entry.exited;
  assert.equal(f.entry.reaped, true);
  assert.deepEqual(f.pending(), []);
  assert.equal(f.calls.filter(value => value === 'SIGKILL').length, 1);
  assert.ok(f.calls.slice(2).every(value => value === 0));
});

test('unexpected probe errors retain the owned reservation and issue no signal', async t => {
  const f = fixture(t, () => error('EINVAL'));
  f.child.emit('close', 0, null);
  await f.entry.exited;
  assert.equal(f.entry.reaped, false);
  assert.equal(f.pending().length, 1);
  assert.deepEqual(f.calls, [0]);
});

for (const delayed of ['timer', 'probe']) test(`late ${delayed} cannot retire an intent after the closure deadline`, async t => {
  let now = 0;
  let probes = 0;
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds !== 25) return originalTimeout(callback, milliseconds, ...args);
    queueMicrotask(() => { now = delayed === 'timer' ? 1001 : 25; callback(...args); });
  });
  const f = fixture(t, () => {
    if (++probes === 1) return error('EPERM');
    now = 1001;
    return error('ESRCH');
  });
  f.child.emit('close', 0, null);
  await f.entry.exited;
  assert.equal(f.entry.reaped, false);
  assert.equal(f.pending().length, 1);
  assert.ok(f.calls.every(value => value === 0));
  if (delayed === 'timer') assert.equal(probes, 1);
});
