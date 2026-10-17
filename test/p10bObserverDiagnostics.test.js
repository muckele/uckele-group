import test from 'node:test';
import assert from 'node:assert/strict';
import { createP10bObserverControls } from '../server/services/p10bRuntimeObserver.js';
import { startP10bMetadataSampling } from '../server/services/p10bObserverPolicy.js';
import { P10bNativeRequestError } from '../server/services/p10bNativeFailure.js';

const now = Date.parse('2026-10-17T18:00:00.000Z');
const phase = { window: { issuedAt: new Date(now).toISOString(), stopAt: new Date(now + 300000).toISOString() } };
for (const code of ['timed-out', 'http-failed', 'bridge-timeout', 'bridge-protocol', 'bridge-failed']) {
  test(`observer retains only closed ${code} facts, stops sampling and remains failed`, async () => {
    const rows = []; let calls = 0;
    const error = new P10bNativeRequestError({ code, method: 'GET', timeoutMs: 700 });
    error.message = 'private-secret-canary'; error.stack = 'private-secret-canary'; error.body = 'private-secret-canary';
    const controls = createP10bObserverControls({ phase, machine: {}, clock: () => now, record: r => rows.push(r),
      async client(method, _body, timeout) { calls++; assert.equal(method, 'GET'); assert.equal(timeout, 700); throw error; } });
    const sampler = startP10bMetadataSampling({ window: phase.window, sessionDeadline: new Date(now + 330000).toISOString(),
      clock: () => now, wait: async () => assert.fail('Failed sampling must not resume'), tick: controls.tick, record: r => rows.push(r) });
    assert.equal((await sampler.done).normalCompletion, false); assert.equal(calls, 1); assert.equal(controls.healthy(), false);
    assert.deepEqual(rows.find(r => r.kind === 'observer-read-error'), { kind: 'observer-read-error', at: new Date(now).toISOString(),
      nativeFailure: { version: 'p10b-native-request-failure-v1', code, method: 'GET', timeoutMs: 700 } });
    assert.equal(JSON.stringify(rows).includes('canary'), false);
  });
}

for (const kind of ['arbitrary', 'spoofed', 'target-mismatch']) test(`observer ${kind} error retains null public diagnostics`, async () => {
  const rows = []; const fake = new Error('private-secret-canary');
  if (kind === 'spoofed') fake.publicFailure = { version: 'p10b-native-request-failure-v1', code: 'timed-out', method: 'GET', timeoutMs: 700 };
  else Object.defineProperty(fake, 'publicFailure', { get() { return assert.fail('Untrusted getters must not run'); } });
  const controls = createP10bObserverControls({ phase, machine: {}, clock: () => now, record: r => rows.push(r), async client() {
    if (kind === 'target-mismatch') return { id: 'wrong' }; throw fake;
  } });
  assert.equal(await controls.tick(), undefined); assert.equal(controls.healthy(), false);
  assert.deepEqual(rows, [{ kind: 'observer-read-error', at: new Date(now).toISOString(), nativeFailure: null }]);
  assert.equal(JSON.stringify(rows).includes('canary'), false);
});
