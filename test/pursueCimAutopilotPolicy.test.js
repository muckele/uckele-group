import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeterministicClock,
  createDeterministicNonceSource,
} from './fixtures/pursueCimHarness.js';

test('P0 harness: injected clock advances only when the test advances it', () => {
  const clock = createDeterministicClock('2026-08-12T15:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-08-12T15:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-08-12T15:00:00.000Z');
  assert.equal(clock.advance(60_000).toISOString(), '2026-08-12T15:01:00.000Z');
  assert.equal(clock.set('2026-11-02T16:00:00.000Z').toISOString(), '2026-11-02T16:00:00.000Z');
});
test('P0 harness: fake nonce source is deterministic and collision-free in sequence', () => {
  const nonce = createDeterministicNonceSource('boundary');
  assert.deepEqual([nonce(), nonce(), nonce()], [
    'boundary-0001',
    'boundary-0002',
    'boundary-0003',
  ]);
});
