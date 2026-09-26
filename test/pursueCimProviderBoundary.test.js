import assert from 'node:assert/strict';
import test from 'node:test';
import { createPursueCimProviderFake } from './fixtures/pursueCimHarness.js';

test('P0 scenario 41 harness: seam entries are counted separately from provider calls', async () => {
  const provider = createPursueCimProviderFake({ crashAt: 'after-seam' });
  await assert.rejects(
    provider.execute({ transmissionId: 'tx-synthetic', payloadDigest: 'a'.repeat(64) }),
    /Synthetic crash at after-seam/,
  );
  assert.equal(provider.seamEntries.length, 1);
  assert.equal(provider.providerCalls.length, 0);
});
test('P0 scenario 42 harness: a crash after invocation records at most one provider call', async () => {
  const provider = createPursueCimProviderFake({ crashAt: 'after-provider-call' });
  await assert.rejects(
    provider.execute({ transmissionId: 'tx-synthetic', payloadDigest: 'b'.repeat(64) }),
    /Synthetic crash at after-provider-call/,
  );
  assert.equal(provider.seamEntries.length, 1);
  assert.equal(provider.providerCalls.length, 1);
});
