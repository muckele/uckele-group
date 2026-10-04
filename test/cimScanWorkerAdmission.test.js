import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleCimScanAdmission } from '../server/services/cimScanWorkerAdmission.js';

test('worker admission allows one task globally and releases only its exact owner', async () => {
  const admission = createSingleCimScanAdmission();
  const first = await admission.acquire('11111111-1111-4111-8111-111111111111');
  const blocked = await admission.acquire('22222222-2222-4222-8222-222222222222');

  assert.equal(typeof first, 'function');
  assert.equal(blocked, null);
  first();
  first();
  const second = await admission.acquire('22222222-2222-4222-8222-222222222222');
  assert.equal(typeof second, 'function');
  second();
});

test('worker admission rejects malformed task identities before changing capacity', async () => {
  const admission = createSingleCimScanAdmission();
  await assert.rejects(admission.acquire('not-a-request-id'), /request|identity/i);
  assert.equal(typeof await admission.acquire('11111111-1111-4111-8111-111111111111'), 'function');
});
