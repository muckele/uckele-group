import assert from 'node:assert/strict';
import test from 'node:test';
import { createPursueCimProviderFake } from './fixtures/pursueCimHarness.js';

test('P0 scenario 54 harness: inbound evidence cannot increment outbound seam or provider counters', () => {
  const provider = createPursueCimProviderFake();
  provider.recordInbound({ eventId: 'signed-inbound-1', conversationId: 'conversation-1' });
  assert.deepEqual(provider.inboundEvents, [
    { eventId: 'signed-inbound-1', conversationId: 'conversation-1' },
  ]);
  assert.equal(provider.seamEntries.length, 0);
  assert.equal(provider.providerCalls.length, 0);
});
