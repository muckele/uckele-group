import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { dedupeDeals } from '../server/services/dealHunter.js';
import { generateDedupeFixture } from './fixtures/dealHunterDedupeFixture.js';

const automaticReasons = [
  'shared-durable-identity',
  'title-description-location-financials',
  'near-title-description-location-financials',
  'exact-title-location-financials',
  'near-title-location-financials',
];

function clusterSizeHistogram(deduped) {
  const histogram = {};
  for (const deal of deduped) {
    const size = deal.sourceRecords.length;
    histogram[size] = (histogram[size] || 0) + 1;
  }
  return histogram;
}

// The expected values below were produced by origin/main's dedupeDeals
// (e0042f0, before match features were cached) on this exact fixture. Only
// regenerate them for a deliberate change to dedupe results or to the
// fixture, never to make a performance change pass. To regenerate:
//   mkdir /tmp/dedupe-golden && git archive <base commit> | tar -x -C /tmp/dedupe-golden
//   ln -s "$PWD/node_modules" /tmp/dedupe-golden/node_modules
//   node --input-type=module -e "
//     import { createHash } from 'node:crypto';
//     import { dedupeDeals } from '/tmp/dedupe-golden/server/services/dealHunter.js';
//     import { generateDedupeFixture } from '$PWD/test/fixtures/dealHunterDedupeFixture.js';
//     const out = dedupeDeals(generateDedupeFixture({ seed: 20261109, count: 600 }).deals);
//     const sizes = {};
//     for (const deal of out) sizes[deal.sourceRecords.length] = (sizes[deal.sourceRecords.length] || 0) + 1;
//     console.log(createHash('sha256').update(JSON.stringify(out)).digest('hex'), JSON.stringify(sizes));"
const goldenSeed = 20261109;
const goldenCount = 600;
const goldenSha256 = 'a09bf98f9281716b063597720f28eb4f929dec2aaae83c44520b45d86c7896c2';
const goldenClusterSizes = { 1: 469, 2: 61, 3: 3 };

test('dedupeDeals output is byte-identical to the pre-cache implementation on the seeded fixture', () => {
  const { deals, planted } = generateDedupeFixture({ seed: goldenSeed, count: goldenCount });
  assert.equal(deals.length, goldenCount);
  const deduped = dedupeDeals(deals);

  assert.deepEqual(clusterSizeHistogram(deduped), goldenClusterSizes);
  assert.equal(createHash('sha256').update(JSON.stringify(deduped)).digest('hex'), goldenSha256);

  // Guard against a vacuous golden: every automatic reason must fire.
  const reasonCounts = Object.fromEntries(automaticReasons.map((reason) => [reason, 0]));
  for (const deal of deduped) {
    for (const match of deal.deduplicationMatches) reasonCounts[match.reason] += 1;
  }
  for (const reason of automaticReasons) {
    assert.ok(reasonCounts[reason] > 0, `expected at least one ${reason} match, got ${JSON.stringify(reasonCounts)}`);
  }

  // Planted copies merge for the expected reason; near-misses and hard
  // conflicts stay separate.
  const clusterByExternalId = new Map();
  deduped.forEach((deal, index) => {
    for (const record of deal.sourceRecords) clusterByExternalId.set(record.externalId, index);
  });
  const checkedScenarios = new Set();
  for (const { scenario, expect, ids } of planted) {
    if (expect === null) continue;
    const clusters = new Set(ids.map((id) => clusterByExternalId.get(id)));
    if (expect === 'separate') {
      assert.equal(clusters.size, ids.length, `${scenario} ${ids.join(',')} must stay separate`);
    } else {
      assert.equal(clusters.size, 1, `${scenario} ${ids.join(',')} must merge`);
      const reasons = deduped[[...clusters][0]].deduplicationMatches.map((match) => match.reason);
      assert.deepEqual(reasons, [expect], `${scenario} ${ids.join(',')}`);
    }
    checkedScenarios.add(scenario);
  }
  assert.equal(checkedScenarios.size, 12);
});

// Wraps each listing's raw row so every full read of it is counted. Building
// a listing's identity aliases reads its raw row twice (getField scans all
// columns), so before this change a listing compared against hundreds of
// candidates had its raw row re-read hundreds of times.
function countRawRowReads(deals) {
  const reads = new Map();
  const wrapped = deals.map((deal) => {
    const counter = { id: deal.id, count: 0 };
    reads.set(deal.id, counter);
    const raw = new Proxy(deal.raw, {
      ownKeys(target) {
        counter.count += 1;
        return Reflect.ownKeys(target);
      },
    });
    return { ...deal, raw };
  });
  return { wrapped, reads };
}

test('dedupeDeals reads each listing a bounded number of times at 4,000 listings', () => {
  const { deals } = generateDedupeFixture({ seed: 4000, count: 4000 });
  const { wrapped, reads } = countRawRowReads(deals);

  const start = performance.now();
  const deduped = dedupeDeals(wrapped);
  const elapsedMs = performance.now() - start;

  assert.ok(deduped.length > 3000 && deduped.length < 4000, `unexpected cluster count ${deduped.length}`);
  assert.ok(deduped.some((deal) => deal.deduplicationMatches.length > 0));

  // Per listing, at most: identity setup (2), block lookup (2), its features
  // as a newcomer (2), indexing (2), its canonical record's features (2), and
  // the merge that copies it (3). None of these grow with the candidate count.
  const perListingLimit = 13;
  const worst = [...reads.values()].reduce((max, item) => (item.count > max.count ? item : max));
  assert.ok(
    worst.count <= perListingLimit,
    `listing ${worst.id} raw row read ${worst.count} times; limit ${perListingLimit}`,
  );

  // A generous backstop only; the read count above is the real check.
  assert.ok(elapsedMs < 15000, `dedupeDeals took ${Math.round(elapsedMs)} ms for 4,000 listings`);
});
