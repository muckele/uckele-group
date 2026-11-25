import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEventLoopSlicer,
  mapInSlices,
  runSteps,
  runStepsInSlices,
  setEventLoopSliceMs,
} from '../server/utils/eventLoopSlices.js';
import { holdsDealReviewLock, withDealReviewLock, withDealReviewLockHeld } from '../server/services/dealReviewLock.js';

function* doubled(values, log) {
  const out = [];
  for (const value of values) {
    if (value < 0) throw new Error(`negative ${value}`);
    out.push(value * 2);
    log.push(value);
    yield;
  }
  return out;
}

test('a step generator gives the same result run at once or in slices', async () => {
  const restore = setEventLoopSliceMs(0);
  try {
    const atOnce = runSteps(doubled([1, 2, 3], []));
    const inSlices = await runStepsInSlices(doubled([1, 2, 3], []));
    assert.deepEqual(atOnce, [2, 4, 6]);
    assert.deepEqual(inSlices, atOnce);
    await assert.rejects(runStepsInSlices(doubled([1, -1], [])), /negative -1/);
    assert.throws(() => runSteps(doubled([1, -1], [])), /negative -1/);
  } finally {
    restore();
  }
});

test('runStepsInSlices lets timers and I/O callbacks run between slices', async () => {
  // A 0 ms slice yields after every step: the immediate queued before the run gets a turn
  // after the first step, not after the last.
  const restore = setEventLoopSliceMs(0);
  try {
    const log = [];
    setImmediate(() => log.push('other work'));
    await runStepsInSlices(doubled([1, 2, 3], log));
    assert.deepEqual(log, [1, 'other work', 2, 3]);
  } finally {
    restore();
  }
});

test('a slicer is due only once its slice length has passed', async () => {
  let now = 0;
  const slicer = createEventLoopSlicer({ sliceMs: 40, now: () => now });
  now = 39;
  assert.equal(slicer.due(), false);
  now = 40;
  assert.equal(slicer.due(), true);
  await slicer.yield();
  assert.equal(slicer.due(), false, 'yielding starts a new slice');
  assert.deepEqual(await mapInSlices([1, 2], (value, index) => value + index, slicer), [1, 3]);
});

test('the deal review lock runs holders one at a time and releases after a throw', async () => {
  const order = [];
  const first = withDealReviewLock(async () => {
    order.push('first:start');
    await new Promise((resolve) => setImmediate(resolve));
    order.push('first:end');
    throw new Error('first failed');
  });
  const second = withDealReviewLock(async (token) => {
    order.push('second');
    assert.equal(holdsDealReviewLock(token), true);
    // A holder passes its token down instead of waiting on itself.
    return withDealReviewLockHeld(token, async () => 'nested');
  });
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'nested');
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('a token stops granting the lock once its holder has finished', async () => {
  let kept;
  await withDealReviewLock(async (token) => {
    kept = token;
  });
  assert.equal(holdsDealReviewLock(kept), false);
  assert.equal(holdsDealReviewLock({}), false);
  assert.equal(holdsDealReviewLock(null), false);
});
