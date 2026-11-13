import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import * as identity from '../server/services/cimOpportunityIdentity.js';
import {
  buildScaleFixture,
  instrumentDescriptionReads,
  runBehaviourCases,
  runScaleResolution,
  scaleListingCount,
  scaleOpportunityCount,
  sha256Json,
  summarizeScaleOutcomes,
} from './fixtures/cimOpportunityIdentityFixture.js';

// The digests below were produced by origin/main's cimOpportunityIdentity.js
// (e0042f0, which compared every listing with every active opportunity) on
// the fixtures in test/fixtures/cimOpportunityIdentityFixture.js. They cover
// each resolver result and every storage write, including the stored identity
// exception's candidate order and comparison evidence. Only regenerate them
// for a deliberate change to identity results or to the fixtures, never to
// make a performance change pass. To regenerate:
//   mkdir /tmp/identity-golden && git archive <base commit> | tar -x -C /tmp/identity-golden
//   ln -s "$PWD/node_modules" /tmp/identity-golden/node_modules
//   node --input-type=module -e "
//     const identity = await import('/tmp/identity-golden/server/services/cimOpportunityIdentity.js');
//     const fx = await import('$PWD/test/fixtures/cimOpportunityIdentityFixture.js');
//     console.log(fx.sha256Json(await fx.runBehaviourCases(identity)));
//     const { outcomes, calls } = await fx.runScaleResolution(identity, fx.buildScaleFixture(identity));
//     console.log(JSON.stringify(fx.summarizeScaleOutcomes(outcomes)), fx.sha256Json(outcomes), fx.sha256Json(calls));"
// The base commit takes minutes on the scale fixture; that is the cost this test guards.
const behaviourSha256 = 'fc32176fcb40b6e1e7e43b8891f623f29df767dc0b30c5b1393f75e99f01637b';
const scaleSummary = {
  'ambiguous:multiple-high-confidence-candidates': 150,
  'resolved:high-confidence-transition': 204,
  'ambiguous:ambiguous-similarity': 150,
  'created:new-opportunity': 496,
};
const scaleOutcomesSha256 = 'e3fee84bc06d26dd30f3bb5e54a1bf21c26db543030ba181c00fb3c3022abac2';
const scaleCallsSha256 = 'b2c51ed3886024bf850164755e66dea68621bb649de94d928eb61bc350ad48c2';

function outcome(outcomes, scenario, mode) {
  const found = outcomes.find((item) => item.scenario === scenario && item.mode === mode);
  assert.ok(found, `${scenario}/${mode} ran`);
  return found.result;
}

function exceptionCandidates(result) {
  return result.identityException?.candidate_opportunity_ids;
}

test('identity resolution returns the same results, candidates and stored evidence as comparing every opportunity', async () => {
  const outcomes = await runBehaviourCases(identity);

  for (const mode of ['write-candidates', 'write-storage-list', 'write-no-create', 'read-only-candidates', 'read-only-storage-list']) {
    const automatic = outcome(outcomes, 'automatic', mode);
    assert.equal(automatic.status, 'resolved');
    assert.equal(automatic.resolution, 'high-confidence-transition');
    assert.equal(automatic.opportunityId, 'opp_auto_match');
    assert.equal(automatic.evidence.nameMatch, true);

    const ambiguous = outcome(outcomes, 'ambiguous', mode);
    assert.equal(ambiguous.identityException.reason, 'ambiguous-similarity');
    // Same-name recipient match, strongly corroborated without recipient, and a
    // legacy row matched through its normalized canonical name; the materially
    // distinct and superseded same-name rows are left out.
    assert.deepEqual(exceptionCandidates(ambiguous), ['opp_amb_recipient', 'opp_amb_corroborated', 'opp_amb_legacy']);

    const overflow = outcome(outcomes, 'ambiguous-overflow', mode);
    assert.deepEqual(exceptionCandidates(overflow), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]
      .map((index) => `opp_overflow_${String(index).padStart(2, '0')}`));
    assert.equal(overflow.identityException.metadata.comparisons.length, 10);

    const multiple = outcome(outcomes, 'multiple-automatic', mode);
    assert.equal(multiple.identityException.reason, 'multiple-high-confidence-candidates');
    assert.deepEqual(exceptionCandidates(multiple), [
      'opp_multi_auto_b', 'opp_multi_auto_a',
      ...Array.from({ length: 8 }, (_, index) => `opp_multi_amb_${index}`),
    ]);

    // The metadata name is the one compared: a raw stored name never matches,
    // and canonical_name is ignored whenever a metadata snapshot exists.
    assert.equal(outcome(outcomes, 'unnormalized-metadata-name', mode).opportunityId, 'opp_unnormalized_metadata_wins');

    const created = mode === 'write-candidates' || mode === 'write-storage-list';
    for (const scenario of ['no-match', 'unnormalized-metadata-name-only-raw', 'empty-name', 'punctuation-only-name']) {
      const result = outcome(outcomes, scenario, mode);
      assert.equal(result.status, created ? 'created' : 'unresolved', `${scenario}/${mode}`);
      if (created) assert.equal(result.resolution, 'new-opportunity');
    }
  }

  assert.equal(sha256Json(outcomes), behaviourSha256);
});

test('resolving 1,000 new listings against 5,000 opportunities compares only same-name opportunities', async (t) => {
  const fixture = buildScaleFixture(identity);
  assert.equal(fixture.opportunities.length, scaleOpportunityCount);
  assert.equal(fixture.listings.length, scaleListingCount);
  const counter = instrumentDescriptionReads(fixture.opportunities);

  const started = performance.now();
  const { outcomes, calls } = await runScaleResolution(identity, fixture);
  t.diagnostic(`resolved ${scaleListingCount} listings in ${(performance.now() - started).toFixed(0)} ms; ${counter.reads} description reads`);

  // Comparing every listing with every opportunity reads the stored
  // description about 4.9 million times here; same-name matching reads it
  // only for the few hundred opportunities that share a listing's name.
  assert.ok(counter.reads <= 2000, `expected at most 2,000 description reads, got ${counter.reads}`);

  assert.deepEqual(summarizeScaleOutcomes(outcomes), scaleSummary);
  assert.equal(sha256Json(outcomes), scaleOutcomesSha256);
  assert.equal(sha256Json(calls), scaleCallsSha256);
});
