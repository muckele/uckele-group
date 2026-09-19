import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CRM_DUPLICATE_REVIEW_CATEGORIES,
  CRM_DUPLICATE_REVIEW_INCOMPLETE,
  CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
  CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
  buildCrmDuplicateReview,
  getCrmDuplicateReview,
} from '../server/services/crmDuplicateReview.js';

const POOLER = {
  survivorSubmissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
  supersededSubmissionId: 'b36a4b33-d35c-4e8d-b6c3-b6301030a92b',
  opportunityId: 'opp_683681c2-bd49-4c46-be4f-6d969143d907',
};

const BERLIN = {
  survivorSubmissionId: '0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da',
  supersededSubmissionId: '8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3',
  opportunityId: 'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
};

function submission(id, {
  identityAliases = [],
  listingAliases = [],
  listingUrl = '',
  dealKey = '',
  dealKeyAliases = [],
  opportunityId = '',
  raw = {},
} = {}) {
  return {
    id,
    listing_url: listingUrl,
    deal_hunter_opportunity_id: opportunityId,
    name: `private-contact-${id}`,
    email: `${id}@private.example`,
    notes: `private note for ${id}`,
    metadata: {
      dealHunter: {
        opportunityId,
        identityAliases,
        listingAliases,
        dealKey,
        dealKeyAliases,
        raw: {
          ...raw,
          EmailBody: `private email body for ${id}`,
          DocumentPath: `/private/documents/${id}.pdf`,
        },
      },
    },
  };
}

function approvedSubmissions() {
  return [
    submission(POOLER.survivorSubmissionId, {
      opportunityId: POOLER.opportunityId,
      identityAliases: ['costar:2516010'],
    }),
    submission(POOLER.supersededSubmissionId, { identityAliases: ['costar:2516010'] }),
    submission(BERLIN.survivorSubmissionId, {
      opportunityId: BERLIN.opportunityId,
      identityAliases: ['costar:2436873'],
    }),
    submission(BERLIN.supersededSubmissionId, { dealKeyAliases: ['fingerprint:berlin-reviewed'] }),
  ];
}

function activeRelation(id, pair) {
  return {
    id,
    status: 'active',
    survivorSubmissionId: pair.survivorSubmissionId,
    supersededSubmissionId: pair.supersededSubmissionId,
    opportunityId: pair.opportunityId,
    approvedBy: 'owner@example.test',
    approvedAt: '2026-09-17T20:00:00.000Z',
    reasonCode: 'confirmed-duplicate',
    repairVersion: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1',
    repairManifestId: `manifest-${id}`,
    repairDigest: 'a'.repeat(64),
    metadata: { privateNote: 'must never escape the projection' },
  };
}

function pairKey(left, right) {
  return [left, right].sort().join('::');
}

test('normalizes approved tuples into independent confirmed-duplicate pair rows before apply', () => {
  const report = buildCrmDuplicateReview({
    submissions: approvedSubmissions(),
    supersessions: [],
    approvedPairs: CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
    keepDistinctPairs: CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
  });

  assert.equal(report.complete, true);
  assert.deepEqual(report.categories, [
    'resolved/superseded',
    'confirmed-duplicate',
    'strong-candidate',
    'uncertain',
    'keep-distinct',
  ]);
  const confirmed = report.rows.filter((row) => row.category === 'confirmed-duplicate');
  assert.deepEqual(confirmed.map((row) => row.pairKey).sort(), [
    pairKey(POOLER.survivorSubmissionId, POOLER.supersededSubmissionId),
    pairKey(BERLIN.survivorSubmissionId, BERLIN.supersededSubmissionId),
  ].sort());
  assert.ok(confirmed.every((row) => row.lowerSubmissionId < row.higherSubmissionId));
  assert.ok(report.rows.every((row) => !('group' in row) && !('submissionIds' in row)));
});

test('active durable relations override descriptor evidence as resolved/superseded with survivor navigation', () => {
  const report = buildCrmDuplicateReview({
    submissions: approvedSubmissions(),
    supersessions: [activeRelation('pooler', POOLER), activeRelation('berlin', BERLIN)],
    approvedPairs: CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
    keepDistinctPairs: CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
  });

  const resolved = report.rows.filter((row) => row.category === 'resolved/superseded');
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((row) => row.activeSupersession?.survivorSubmissionId).sort(), [
    POOLER.survivorSubmissionId,
    BERLIN.survivorSubmissionId,
  ].sort());
  assert.equal(report.rows.some((row) => row.category === 'confirmed-duplicate'), false);
});

test('the owner-reviewed Pooler/Berlin boundary is keep-distinct and never creates transitive groups', () => {
  const submissions = approvedSubmissions().map((row) => ({
    ...row,
    metadata: {
      dealHunter: {
        ...row.metadata.dealHunter,
        identityAliases: [
          ...(row.metadata.dealHunter.identityAliases || []),
          'url:shared-title-and-financial-lookalike',
        ],
      },
    },
  }));
  const report = buildCrmDuplicateReview({
    submissions,
    supersessions: [],
    approvedPairs: CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
    keepDistinctPairs: CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
  });

  const poolerIds = [POOLER.survivorSubmissionId, POOLER.supersededSubmissionId];
  const berlinIds = [BERLIN.survivorSubmissionId, BERLIN.supersededSubmissionId];
  const crossPairKeys = poolerIds.flatMap((poolerId) => (
    berlinIds.map((berlinId) => pairKey(poolerId, berlinId))
  )).sort();
  const crossPairs = report.rows.filter((row) => crossPairKeys.includes(row.pairKey));
  assert.deepEqual(crossPairs.map((row) => row.pairKey).sort(), crossPairKeys);
  assert.ok(crossPairs.every((row) => row.category === 'keep-distinct'));
  assert.ok(crossPairs.every((row) => (
    row.blockers.includes('owner-reviewed-distinct-canonical-opportunities')
  )));
  assert.equal(report.rows.some((row) => 'groupId' in row || 'members' in row), false);
  assert.equal(report.rows.some((row) => (
    row.category !== 'keep-distinct' && crossPairKeys.includes(row.pairKey)
  )), false);
});

test('classifies exact stable-listing evidence as strong and weaker or conflicting evidence as uncertain', () => {
  const submissions = [
    submission('strong-a', { identityAliases: ['costar:9001'] }),
    submission('strong-b', { identityAliases: ['costar:9001'] }),
    submission('weak-a', { dealKey: 'fingerprint:weak-only' }),
    submission('weak-b', { dealKeyAliases: ['fingerprint:weak-only'] }),
    submission('conflict-a', { identityAliases: ['costar:9002'], opportunityId: 'opp-a' }),
    submission('conflict-b', { identityAliases: ['costar:9002'], opportunityId: 'opp-b' }),
  ];
  const report = buildCrmDuplicateReview({
    submissions,
    supersessions: [],
    approvedPairs: [],
    keepDistinctPairs: [],
  });

  const byKey = new Map(report.rows.map((row) => [row.pairKey, row]));
  const strong = byKey.get(pairKey('strong-a', 'strong-b'));
  const weak = byKey.get(pairKey('weak-a', 'weak-b'));
  const conflict = byKey.get(pairKey('conflict-a', 'conflict-b'));
  assert.equal(strong?.category, 'strong-candidate');
  assert.deepEqual(strong?.corroboratingEvidence.map((item) => item.category), ['stable-listing-identity']);
  assert.match(strong?.corroboratingEvidence[0]?.hash || '', /^[a-f0-9]{64}$/);
  assert.equal(weak?.category, 'uncertain');
  assert.ok(weak?.blockers.includes('insufficient-stable-listing-evidence'));
  assert.equal(conflict?.category, 'uncertain');
  assert.ok(conflict?.blockers.includes('canonical-opportunity-conflict'));
  assert.ok(conflict?.conflictingEvidence.every((item) => /^[a-f0-9]{64}$/.test(item.hash)));
});

test('uses canonical Deal Hunter listing and marketplace aliases for equivalent BizBuySell URL variants', () => {
  const report = buildCrmDuplicateReview({
    submissions: [
      submission('bizbuysell-a', {
        listingUrl: 'https://www.bizbuysell.com/business-opportunity/legacy-slug/2516010/?utm_source=mail',
      }),
      submission('bizbuysell-b', {
        listingAliases: [
          'https://bizbuysell.com/business-opportunity/current-slug/2516010?utm_campaign=syndication',
        ],
      }),
    ],
    supersessions: [],
    approvedPairs: [],
    keepDistinctPairs: [],
  });

  assert.equal(report.complete, true);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].pairKey, pairKey('bizbuysell-a', 'bizbuysell-b'));
  assert.equal(report.rows[0].category, 'strong-candidate');
  assert.deepEqual(report.rows[0].corroboratingEvidence.map((item) => item.category), [
    'stable-listing-identity',
  ]);
  assert.doesNotMatch(JSON.stringify(report), /legacy-slug|current-slug|utm_|2516010/i);
});

test('fails closed when a submission exceeds the established Deal Hunter identity-alias bound', () => {
  const report = buildCrmDuplicateReview({
    submissions: [
      submission('bounded-aliases', {
        identityAliases: Array.from({ length: 501 }, (_, index) => `costar:${index}`),
      }),
      submission('other'),
    ],
    supersessions: [],
    approvedPairs: [],
    keepDistinctPairs: [],
  });

  assert.equal(report.complete, false);
  assert.equal(report.code, CRM_DUPLICATE_REVIEW_INCOMPLETE);
  assert.equal(report.reason, 'identity-alias-bound-exceeded');
  assert.deepEqual(report.rows, []);
});

test('fails closed when an active durable relation contradicts any hard Pooler/Berlin keep-distinct pair', () => {
  for (const [index, decision] of CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS.entries()) {
    const relation = activeRelation(`cross-${index}`, {
      survivorSubmissionId: decision.leftSubmissionId,
      supersededSubmissionId: decision.rightSubmissionId,
      opportunityId: decision.opportunityIds[0],
    });
    const report = buildCrmDuplicateReview({
      submissions: approvedSubmissions(),
      supersessions: [relation],
      approvedPairs: CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
      keepDistinctPairs: CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
    });

    assert.equal(report.complete, false, decision.decisionReference);
    assert.equal(report.code, CRM_DUPLICATE_REVIEW_INCOMPLETE, decision.decisionReference);
    assert.equal(report.reason, 'durable-relation-conflicts-with-keep-distinct', decision.decisionReference);
    assert.deepEqual(report.rows, [], decision.decisionReference);
  }
});

test('projects privacy-safe evidence without contact text, bodies, notes, paths, or raw metadata', () => {
  const report = buildCrmDuplicateReview({
    submissions: [
      submission('private-a', { identityAliases: ['costar:private-safe'], raw: { Subject: 'secret subject' } }),
      submission('private-b', { identityAliases: ['costar:private-safe'], raw: { Subject: 'secret subject' } }),
    ],
    supersessions: [],
    approvedPairs: [],
    keepDistinctPairs: [],
  });
  const serialized = JSON.stringify(report);

  assert.doesNotMatch(serialized, /private-contact|private\.example|private note|email body|documents\/|secret subject|"metadata"|costar:private-safe/i);
  assert.match(serialized, /stable-listing-identity/);
  assert.match(serialized, /[a-f0-9]{64}/);
});

test('fails closed without prefix rows when the submission or candidate-pair bound is exceeded', () => {
  const tooManySubmissions = buildCrmDuplicateReview({
    submissions: Array.from({ length: 5001 }, (_, index) => submission(`bounded-${index}`)),
    supersessions: [],
    approvedPairs: [],
    keepDistinctPairs: [],
  });
  assert.deepEqual(tooManySubmissions, {
    version: 'crm-duplicate-review-v1',
    complete: false,
    code: CRM_DUPLICATE_REVIEW_INCOMPLETE,
    reason: 'submission-bound-exceeded',
    limits: { submissions: 5000, candidatePairs: 10000 },
    counts: { submissions: 5001, candidatePairs: null },
    categories: CRM_DUPLICATE_REVIEW_CATEGORIES,
    rows: [],
  });

  const tooManyPairs = buildCrmDuplicateReview({
    submissions: Array.from({ length: 142 }, (_, index) => (
      submission(`pair-${String(index).padStart(3, '0')}`, { identityAliases: ['costar:pair-bound'] })
    )),
    supersessions: [],
    approvedPairs: [],
    keepDistinctPairs: [],
  });
  assert.equal(tooManyPairs.complete, false);
  assert.equal(tooManyPairs.code, CRM_DUPLICATE_REVIEW_INCOMPLETE);
  assert.equal(tooManyPairs.reason, 'candidate-pair-bound-exceeded');
  assert.equal(tooManyPairs.counts.candidatePairs, 10001);
  assert.deepEqual(tooManyPairs.rows, []);
});

test('loads one complete bounded authority snapshot and reports incomplete storage reads without prefix rows', async () => {
  const calls = [];
  const complete = await getCrmDuplicateReview({
    storage: {
      async readDealHunterCrmMatchAuthority(options) {
        calls.push(options);
        return {
          complete: true,
          rows: [
            submission('service-a', { identityAliases: ['costar:service'] }),
            submission('service-b', { identityAliases: ['costar:service'] }),
          ],
          count: 2,
          submissionCount: 2,
          supersessions: [],
          supersessionCount: 0,
          revision: 'a'.repeat(64),
        };
      },
    },
  });
  assert.equal(complete.complete, true);
  assert.deepEqual(calls, [{ limit: 5000, supersessionLimit: 5000 }]);

  const incomplete = await getCrmDuplicateReview({
    storage: {
      async readDealHunterCrmMatchAuthority() {
        return { complete: false, rows: [submission('prefix')], count: 5001 };
      },
    },
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.code, CRM_DUPLICATE_REVIEW_INCOMPLETE);
  assert.equal(incomplete.reason, 'authority-snapshot-incomplete');
  assert.deepEqual(incomplete.rows, []);
});
