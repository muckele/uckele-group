import { createHash } from 'node:crypto';

import { getStorage } from '../storage/index.js';

export const CRM_DUPLICATE_REVIEW_INCOMPLETE = 'CRM_DUPLICATE_REVIEW_INCOMPLETE';
export const CRM_DUPLICATE_REVIEW_CATEGORIES = Object.freeze([
  'resolved/superseded',
  'confirmed-duplicate',
  'strong-candidate',
  'uncertain',
  'keep-distinct',
]);

const reviewVersion = 'crm-duplicate-review-v1';
const submissionLimit = 5000;
const candidatePairLimit = 10000;

export const CRM_DUPLICATE_REVIEW_APPROVED_PAIRS = Object.freeze([
  Object.freeze({
    opportunityId: 'opp_683681c2-bd49-4c46-be4f-6d969143d907',
    survivorSubmissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
    supersededSubmissionId: 'b36a4b33-d35c-4e8d-b6c3-b6301030a92b',
    listingIdentity: 'costar:2516010',
    decisionReference: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1:pooler',
  }),
  Object.freeze({
    opportunityId: 'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
    survivorSubmissionId: '0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da',
    supersededSubmissionId: '8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3',
    listingIdentity: 'costar:2436873',
    decisionReference: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1:berlin',
  }),
]);

// The approved design requires the final Pooler and Berlin canonical records
// to remain distinct even when weaker title, broker, or financial observations
// happen to look alike. This read-only rule is deliberately pair-specific; V1
// does not create a persistent duplicate-decision table.
export const CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS = Object.freeze([
  Object.freeze({
    leftSubmissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
    rightSubmissionId: '0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da',
    opportunityIds: Object.freeze([
      'opp_683681c2-bd49-4c46-be4f-6d969143d907',
      'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
    ]),
    decisionReference: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1:pooler-berlin-distinct',
    actor: 'owner-approved-design',
    reason: 'distinct-canonical-opportunities',
    evidenceVersion: reviewVersion,
  }),
  Object.freeze({
    leftSubmissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
    rightSubmissionId: '8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3',
    opportunityIds: Object.freeze([
      'opp_683681c2-bd49-4c46-be4f-6d969143d907',
      'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
    ]),
    decisionReference: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1:pooler-berlin-distinct',
    actor: 'owner-approved-design',
    reason: 'distinct-canonical-opportunities',
    evidenceVersion: reviewVersion,
  }),
  Object.freeze({
    leftSubmissionId: 'b36a4b33-d35c-4e8d-b6c3-b6301030a92b',
    rightSubmissionId: '0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da',
    opportunityIds: Object.freeze([
      'opp_683681c2-bd49-4c46-be4f-6d969143d907',
      'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
    ]),
    decisionReference: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1:pooler-berlin-distinct',
    actor: 'owner-approved-design',
    reason: 'distinct-canonical-opportunities',
    evidenceVersion: reviewVersion,
  }),
  Object.freeze({
    leftSubmissionId: 'b36a4b33-d35c-4e8d-b6c3-b6301030a92b',
    rightSubmissionId: '8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3',
    opportunityIds: Object.freeze([
      'opp_683681c2-bd49-4c46-be4f-6d969143d907',
      'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
    ]),
    decisionReference: 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1:pooler-berlin-distinct',
    actor: 'owner-approved-design',
    reason: 'distinct-canonical-opportunities',
    evidenceVersion: reviewVersion,
  }),
]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function compact(value, limit = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizedToken(value) {
  return compact(value, 1200).toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedPair(leftId, rightId) {
  const left = compact(leftId, 300);
  const right = compact(rightId, 300);
  if (!left || !right || left === right) return null;
  const [lowerSubmissionId, higherSubmissionId] = [left, right].sort();
  return {
    lowerSubmissionId,
    higherSubmissionId,
    pairKey: `${lowerSubmissionId}::${higherSubmissionId}`,
  };
}

function limits() {
  return { submissions: submissionLimit, candidatePairs: candidatePairLimit };
}

function incompleteReport(reason, { submissions = null, candidatePairs = null } = {}) {
  return {
    version: reviewVersion,
    complete: false,
    code: CRM_DUPLICATE_REVIEW_INCOMPLETE,
    reason,
    limits: limits(),
    counts: { submissions, candidatePairs },
    categories: CRM_DUPLICATE_REVIEW_CATEGORIES,
    rows: [],
  };
}

function evidence(category, value) {
  return { category, hash: sha256(`${category}\0${value}`) };
}

function evidenceSort(left, right) {
  return left.category.localeCompare(right.category) || left.hash.localeCompare(right.hash);
}

function addEvidence(target, item) {
  if (!target.some((existing) => existing.category === item.category && existing.hash === item.hash)) {
    target.push(item);
    target.sort(evidenceSort);
  }
}

function pairOwner(submission = {}) {
  const direct = compact(submission.deal_hunter_opportunity_id, 300);
  const metadata = compact(submission.metadata?.dealHunter?.opportunityId, 300);
  return direct && metadata && direct !== metadata
    ? { owner: '', conflict: [direct, metadata].sort() }
    : { owner: direct || metadata, conflict: [] };
}

function identityTokens(submission = {}) {
  const metadata = submission.metadata?.dealHunter || {};
  const stableTokens = unique([
    ...(Array.isArray(metadata.identityAliases) ? metadata.identityAliases : []),
    ...(Array.isArray(metadata.listingAliases) ? metadata.listingAliases : []),
    compact(submission.listing_url, 2000),
  ].map(normalizedToken)).filter((token) => token && !token.startsWith('fingerprint:'));
  const weakTokens = unique([
    metadata.dealKey,
    ...(Array.isArray(metadata.dealKeyAliases) ? metadata.dealKeyAliases : []),
  ].map(normalizedToken)).filter((token) => token && !stableTokens.includes(token));
  return { stableTokens, weakTokens };
}

function activeRelationFields(relation = {}) {
  return {
    relationId: compact(relation.id, 300),
    status: compact(relation.status, 40),
    survivorSubmissionId: compact(relation.survivorSubmissionId || relation.survivor_submission_id, 300),
    supersededSubmissionId: compact(relation.supersededSubmissionId || relation.superseded_submission_id, 300),
    opportunityId: compact(relation.opportunityId || relation.opportunity_id, 300),
    repairManifestId: compact(relation.repairManifestId || relation.repair_manifest_id, 300),
    repairDigest: compact(relation.repairDigest || relation.repair_digest, 64).toLowerCase(),
    actor: compact(relation.approvedBy || relation.approved_by || relation.actor, 200),
    decidedAt: compact(relation.approvedAt || relation.approved_at || relation.createdAt || relation.created_at, 80),
  };
}

function createPairRecord(pair) {
  return {
    ...pair,
    category: 'uncertain',
    corroboratingEvidence: [],
    conflictingEvidence: [],
    currentRelationship: { opportunityId: null, primarySubmissionId: null },
    activeSupersession: null,
    ownerDecision: null,
    blockers: [],
    sources: { approved: null, keepDistinct: null, relation: null, sharedStable: false, sharedWeak: false },
  };
}

function publicPair(record, submissionsById) {
  const leftOwner = pairOwner(submissionsById.get(record.lowerSubmissionId));
  const rightOwner = pairOwner(submissionsById.get(record.higherSubmissionId));
  const ownerConflicts = unique([...leftOwner.conflict, ...rightOwner.conflict]);
  const distinctOwners = leftOwner.owner && rightOwner.owner && leftOwner.owner !== rightOwner.owner
    ? [leftOwner.owner, rightOwner.owner].sort()
    : [];
  for (const owner of ownerConflicts) {
    addEvidence(record.conflictingEvidence, evidence('submission-owner-conflict', owner));
  }
  if (distinctOwners.length > 0) {
    addEvidence(record.conflictingEvidence, evidence('canonical-opportunity-conflict', distinctOwners.join('\0')));
  }

  if (record.sources.relation) {
    const relation = record.sources.relation;
    record.category = 'resolved/superseded';
    record.currentRelationship = {
      opportunityId: relation.opportunityId || null,
      primarySubmissionId: relation.survivorSubmissionId || null,
    };
    record.activeSupersession = {
      relationId: relation.relationId || null,
      survivorSubmissionId: relation.survivorSubmissionId,
      supersededSubmissionId: relation.supersededSubmissionId,
      opportunityId: relation.opportunityId || null,
      repairManifestId: relation.repairManifestId || null,
      repairDigest: /^[a-f0-9]{64}$/.test(relation.repairDigest) ? relation.repairDigest : null,
    };
    record.ownerDecision = {
      reference: relation.repairManifestId || relation.relationId || null,
      actor: relation.actor || null,
      reason: 'confirmed-duplicate',
      evidenceVersion: reviewVersion,
      evidenceDigest: /^[a-f0-9]{64}$/.test(relation.repairDigest)
        ? relation.repairDigest
        : sha256(`${relation.relationId}\0${relation.survivorSubmissionId}\0${relation.supersededSubmissionId}`),
      decidedAt: relation.decidedAt || null,
    };
    record.blockers = [];
  } else if (record.sources.approved) {
    const approved = record.sources.approved;
    record.category = 'confirmed-duplicate';
    record.currentRelationship = {
      opportunityId: compact(approved.opportunityId, 300) || null,
      primarySubmissionId: compact(approved.survivorSubmissionId, 300) || null,
    };
    record.ownerDecision = {
      reference: compact(approved.decisionReference, 300) || null,
      actor: 'owner-approved-design',
      reason: 'confirmed-duplicate',
      evidenceVersion: reviewVersion,
      evidenceDigest: sha256([
        approved.opportunityId,
        approved.survivorSubmissionId,
        approved.supersededSubmissionId,
        approved.listingIdentity,
      ].join('\0')),
      decidedAt: null,
    };
    record.blockers = [];
  } else if (record.sources.keepDistinct) {
    const decision = record.sources.keepDistinct;
    record.category = 'keep-distinct';
    record.ownerDecision = {
      reference: compact(decision.decisionReference, 300) || null,
      actor: compact(decision.actor, 200) || null,
      reason: compact(decision.reason, 200) || 'distinct-canonical-opportunities',
      evidenceVersion: compact(decision.evidenceVersion, 120) || reviewVersion,
      evidenceDigest: sha256([
        record.lowerSubmissionId,
        record.higherSubmissionId,
        ...(Array.isArray(decision.opportunityIds) ? decision.opportunityIds : []),
      ].join('\0')),
      decidedAt: compact(decision.decidedAt, 80) || null,
    };
    record.blockers = ['owner-reviewed-distinct-canonical-opportunities'];
  } else if (record.sources.sharedStable && ownerConflicts.length === 0 && distinctOwners.length === 0) {
    record.category = 'strong-candidate';
    record.blockers = ['owner-review-required'];
  } else {
    record.category = 'uncertain';
    record.blockers = unique([
      !record.sources.sharedStable ? 'insufficient-stable-listing-evidence' : '',
      ownerConflicts.length > 0 ? 'submission-owner-conflict' : '',
      distinctOwners.length > 0 ? 'canonical-opportunity-conflict' : '',
      'owner-review-required',
    ]).sort();
  }

  if (!record.currentRelationship.opportunityId && leftOwner.owner && leftOwner.owner === rightOwner.owner) {
    record.currentRelationship = {
      opportunityId: leftOwner.owner,
      primarySubmissionId: null,
    };
  }

  const {
    sources: _sources,
    ...projected
  } = record;
  return projected;
}

export function buildCrmDuplicateReview({
  submissions = [],
  supersessions = [],
  approvedPairs = CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
  keepDistinctPairs = CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
} = {}) {
  if (!Array.isArray(submissions) || !Array.isArray(supersessions)
    || !Array.isArray(approvedPairs) || !Array.isArray(keepDistinctPairs)) {
    return incompleteReport('authority-snapshot-incomplete');
  }
  if (submissions.length > submissionLimit) {
    return incompleteReport('submission-bound-exceeded', {
      submissions: submissions.length,
      candidatePairs: null,
    });
  }

  const submissionsById = new Map();
  for (const submission of submissions) {
    const id = compact(submission?.id, 300);
    if (!id || submissionsById.has(id)) {
      return incompleteReport('authority-snapshot-incomplete', {
        submissions: submissions.length,
        candidatePairs: null,
      });
    }
    submissionsById.set(id, submission);
  }

  const pairs = new Map();
  let exceededPairBound = false;
  const getPair = (leftId, rightId) => {
    const pair = normalizedPair(leftId, rightId);
    if (!pair) return null;
    if (!pairs.has(pair.pairKey)) {
      pairs.set(pair.pairKey, createPairRecord(pair));
      if (pairs.size > candidatePairLimit) exceededPairBound = true;
    }
    return pairs.get(pair.pairKey);
  };

  for (const approved of approvedPairs) {
    const record = getPair(approved?.survivorSubmissionId, approved?.supersededSubmissionId);
    if (!record) continue;
    record.sources.approved = approved;
    addEvidence(record.corroboratingEvidence, evidence(
      'owner-approved-incident-descriptor',
      [approved.opportunityId, approved.survivorSubmissionId, approved.supersededSubmissionId, approved.listingIdentity].join('\0'),
    ));
  }
  for (const decision of keepDistinctPairs) {
    const record = getPair(
      decision?.leftSubmissionId || decision?.lowerSubmissionId,
      decision?.rightSubmissionId || decision?.higherSubmissionId,
    );
    if (!record) continue;
    record.sources.keepDistinct = decision;
    addEvidence(record.conflictingEvidence, evidence(
      'distinct-canonical-opportunities',
      [record.lowerSubmissionId, record.higherSubmissionId, ...(decision.opportunityIds || [])].join('\0'),
    ));
  }
  for (const rawRelation of supersessions) {
    const relation = activeRelationFields(rawRelation);
    if (relation.status !== 'active') continue;
    const record = getPair(relation.survivorSubmissionId, relation.supersededSubmissionId);
    if (!record) continue;
    record.sources.relation = relation;
    addEvidence(record.corroboratingEvidence, evidence(
      'active-crm-supersession',
      [relation.relationId, relation.survivorSubmissionId, relation.supersededSubmissionId, relation.opportunityId].join('\0'),
    ));
  }

  const stableBuckets = new Map();
  const weakBuckets = new Map();
  for (const submission of submissions) {
    const { stableTokens, weakTokens } = identityTokens(submission);
    for (const token of stableTokens) {
      const bucket = stableBuckets.get(token) || [];
      bucket.push(submission.id);
      stableBuckets.set(token, bucket);
    }
    for (const token of weakTokens) {
      const bucket = weakBuckets.get(token) || [];
      bucket.push(submission.id);
      weakBuckets.set(token, bucket);
    }
  }

  const addBucketPairs = (buckets, category, sourceFlag) => {
    for (const [token, ids] of buckets) {
      const distinctIds = unique(ids).sort();
      for (let leftIndex = 0; leftIndex < distinctIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < distinctIds.length; rightIndex += 1) {
          const record = getPair(distinctIds[leftIndex], distinctIds[rightIndex]);
          if (record) {
            record.sources[sourceFlag] = true;
            addEvidence(record.corroboratingEvidence, evidence(category, token));
          }
          if (exceededPairBound) return;
        }
      }
    }
  };
  addBucketPairs(stableBuckets, 'stable-listing-identity', 'sharedStable');
  if (!exceededPairBound) addBucketPairs(weakBuckets, 'deal-key-alias', 'sharedWeak');

  if (exceededPairBound) {
    return incompleteReport('candidate-pair-bound-exceeded', {
      submissions: submissions.length,
      candidatePairs: candidatePairLimit + 1,
    });
  }

  const rows = [...pairs.values()]
    .map((record) => publicPair(record, submissionsById))
    .sort((left, right) => left.pairKey.localeCompare(right.pairKey));
  return {
    version: reviewVersion,
    complete: true,
    code: null,
    reason: null,
    limits: limits(),
    counts: { submissions: submissions.length, candidatePairs: rows.length },
    categories: CRM_DUPLICATE_REVIEW_CATEGORIES,
    rows,
  };
}

export async function getCrmDuplicateReview({ storage = getStorage() } = {}) {
  if (!storage || typeof storage.readDealHunterCrmMatchAuthority !== 'function') {
    return incompleteReport('authority-snapshot-unavailable');
  }
  let authority;
  try {
    authority = await storage.readDealHunterCrmMatchAuthority({
      limit: submissionLimit,
      supersessionLimit: submissionLimit,
    });
  } catch {
    return incompleteReport('authority-snapshot-unavailable');
  }
  const rows = Array.isArray(authority?.rows) ? authority.rows : [];
  const supersessions = Array.isArray(authority?.supersessions) ? authority.supersessions : [];
  const reportedSubmissions = Number(authority?.submissionCount ?? authority?.count);
  const reportedSupersessions = Number(authority?.supersessionCount ?? supersessions.length);
  if (authority?.complete !== true
    || !Number.isInteger(reportedSubmissions)
    || !Number.isInteger(reportedSupersessions)
    || rows.length !== reportedSubmissions
    || supersessions.length !== reportedSupersessions) {
    return incompleteReport('authority-snapshot-incomplete', {
      submissions: Number.isInteger(reportedSubmissions) ? reportedSubmissions : null,
      candidatePairs: null,
    });
  }
  return buildCrmDuplicateReview({
    submissions: rows,
    supersessions,
    approvedPairs: CRM_DUPLICATE_REVIEW_APPROVED_PAIRS,
    keepDistinctPairs: CRM_DUPLICATE_REVIEW_KEEP_DISTINCT_PAIRS,
  });
}
