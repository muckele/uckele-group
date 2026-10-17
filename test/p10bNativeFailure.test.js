import test from 'node:test';
import assert from 'node:assert/strict';
import { P10bNativeRequestError, publicP10bNativeFailure } from '../server/services/p10bNativeFailure.js';

test('only typed closed request facts survive, even when raw exception fields contain secrets', () => {
  const error = new P10bNativeRequestError({ code: 'http-failed', method: 'POST', timeoutMs: 10000 });
  error.message = 'synthetic-private-response-canary'; error.stack = 'synthetic-private-stack-canary';
  assert.deepEqual(publicP10bNativeFailure(error), { version: 'p10b-native-request-failure-v1',
    code: 'http-failed', method: 'POST', timeoutMs: 10000 });
  assert.equal(publicP10bNativeFailure(Object.assign(Error('synthetic-private-canary'), { publicFailure: error.publicFailure })), null);
  assert.equal(publicP10bNativeFailure(null), null);
  assert.equal(JSON.stringify(publicP10bNativeFailure(error)).includes('canary'), false);
});

test('unknown, extra, contradictory or unbounded native diagnostics cannot be constructed', () => {
  const valid = { code: 'http-failed', method: 'POST', timeoutMs: 10000 };
  for (const fields of [{ code: 'synthetic-private-canary' }, { body: 'synthetic-private-canary' },
    { method: 'DELETE' }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { timeoutMs: '1000' },
    { httpStatus: 99 }, { httpStatus: 600 }, { httpStatus: 200 }, { httpStatus: 299 },
    { httpStatus: '422' }, { httpStatus: {} }]) {
    assert.throws(() => new P10bNativeRequestError({ ...valid, ...fields }));
  }
});
