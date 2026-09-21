import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.ADMIN_SESSION_SECRET = 'deal-hunter-crm-match-ambiguity-test-secret';

const { findExistingDealHunterSubmission: findExistingDealHunterSubmissionWithAuthority } = await import('../server/services/dealHunter.js');

function withMatchAuthority(storage) {
  if (typeof storage?.listSubmissions !== 'function' || typeof storage.readDealHunterCrmMatchAuthority === 'function') {
    return storage;
  }
  return {
    ...storage,
    async readDealHunterCrmMatchAuthority({ limit = 5000 } = {}) {
      const result = await storage.listSubmissions({
        limit,
        page: 1,
        status: 'all',
        sort: 'created_at',
        direction: 'desc',
      });
      const count = Number(result?.total);
      const complete = Array.isArray(result?.rows)
        && Number.isInteger(count)
        && count >= 0
        && count <= limit
        && result.rows.length === count
        && new Set(result.rows.map((row) => row?.id).filter(Boolean)).size === count;
      return {
        rows: Array.isArray(result?.rows) ? result.rows : [],
        count: complete ? count : null,
        submissionCount: complete ? count : null,
        supersessions: Array.isArray(storage.supersessions) ? storage.supersessions : [],
        supersessionCount: Array.isArray(storage.supersessions) ? storage.supersessions.length : 0,
        complete,
        revision: complete ? 'a'.repeat(64) : null,
        revisionVersion: 'deal-hunter-crm-match-authority-v2',
      };
    },
  };
}

function activeSupersession(id, loserId, survivorId, opportunityId = 'opp-current') {
  return {
    id,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    status: 'active',
    survivorSubmissionId: survivorId,
    supersededSubmissionId: loserId,
    opportunityId,
    reasonCode: 'confirmed-duplicate',
    reasonText: 'Reviewed duplicate.',
    approvedBy: 'owner@example.test',
    approvedAt: '2026-09-17T00:00:00.000Z',
    actor: 'operator',
    repairVersion: 'crm-duplicate-consolidation-v1',
    repairManifestId: `manifest-${id}`,
    repairDigest: 'a'.repeat(64),
    reversedAt: null,
    reversedBy: null,
    reversalReason: null,
    reversalManifestId: null,
    metadata: {},
  };
}

function findExistingDealHunterSubmission(storage, deal) {
  return findExistingDealHunterSubmissionWithAuthority(withMatchAuthority(storage), deal);
}

const corroboratedDeal = {
  id: '',
  stableExternalId: false,
  sourceId: 'deal-os-export',
  sourceName: 'SMB Deal OS export',
  sourceMode: 'manual-export',
  dealKey: 'url:https://market.example/listing/hvac-42',
  name: 'Cross-source HVAC Services',
  city: 'Berlin Township',
  state: 'NJ',
  location: 'Berlin Township, NJ',
  annualProfit: 490070,
  annualRevenue: 3535760,
  askingPrice: 1400000,
  description: '',
  listingUrl: 'https://market.example/listing/hvac-42',
};

function legacyCandidate(id, updatedAt) {
  return {
    id,
    status: 'review',
    company: corroboratedDeal.name,
    listing_url: '',
    asking_price: '$1,400,000',
    ttm_revenue: '$3,535,760',
    ttm_ebitda: '$490,070',
    updated_at: updatedAt,
    metadata: {
      dealHunter: {
        raw: { City: corroboratedDeal.city, State: corroboratedDeal.state },
      },
    },
  };
}

test('exact evidence on a loser selects its direct survivor while retaining the evidence origin', async () => {
  const loser = {
    ...legacyCandidate('loser-exact', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const survivor = {
    ...legacyCandidate('survivor', '2026-09-02T00:00:00.000Z'),
    company: 'Canonical survivor title',
    metadata: { dealHunter: { opportunityId: 'opp-current', raw: { City: 'Berlin Township', State: 'NJ' } } },
  };
  const result = await findExistingDealHunterSubmission({
    supersessions: [activeSupersession('relation-one', loser.id, survivor.id)],
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: null };
    },
    async listSubmissions() { return { rows: [loser, survivor], total: 2 }; },
  }, { ...corroboratedDeal, opportunityId: 'opp-current' });

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, survivor.id);
  assert.deepEqual(result.candidateIds, [survivor.id]);
  assert.deepEqual(result.candidates[0].evidenceOriginSubmissionIds, [loser.id]);
});

test('loser and survivor evidence deduplicate after canonicalization and retain both origins', async () => {
  const loser = {
    ...legacyCandidate('loser-exact', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const survivor = {
    ...legacyCandidate('survivor-exact', '2026-09-02T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const result = await findExistingDealHunterSubmission({
    supersessions: [activeSupersession('relation-one', loser.id, survivor.id)],
    async listSubmissions() { return { rows: [loser, survivor], total: 2 }; },
  }, corroboratedDeal);

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, survivor.id);
  assert.deepEqual(result.candidateIds, [survivor.id]);
  assert.deepEqual(result.candidates[0].evidenceOriginSubmissionIds, [loser.id, survivor.id].sort());
});

test('multiple losers canonicalize once to one survivor but distinct final survivors remain ambiguous', async () => {
  const loserA = {
    ...legacyCandidate('loser-a', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const loserB = {
    ...legacyCandidate('loser-b', '2026-09-02T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const survivor = {
    ...legacyCandidate('survivor', '2026-09-03T00:00:00.000Z'),
    company: 'Canonical survivor title',
  };
  const oneSurvivor = await findExistingDealHunterSubmission({
    supersessions: [
      activeSupersession('relation-a', loserA.id, survivor.id),
      activeSupersession('relation-b', loserB.id, survivor.id),
    ],
    async listSubmissions() { return { rows: [loserA, loserB, survivor], total: 3 }; },
  }, corroboratedDeal);
  assert.equal(oneSurvivor.status, 'unique-exact');
  assert.equal(oneSurvivor.submission.id, survivor.id);
  assert.deepEqual(oneSurvivor.candidates[0].evidenceOriginSubmissionIds, [loserA.id, loserB.id].sort());

  const secondSurvivor = {
    ...legacyCandidate('second-survivor', '2026-09-04T00:00:00.000Z'),
    company: 'Second canonical survivor',
  };
  const distinctSurvivors = await findExistingDealHunterSubmission({
    supersessions: [
      activeSupersession('relation-a', loserA.id, survivor.id),
      activeSupersession('relation-b', loserB.id, secondSurvivor.id),
    ],
    async listSubmissions() {
      return { rows: [loserA, loserB, survivor, secondSurvivor], total: 4 };
    },
  }, corroboratedDeal);
  assert.equal(distinctSurvivors.status, 'ambiguous');
  assert.deepEqual(distinctSurvivors.candidateIds, [secondSurvivor.id, survivor.id].sort());
});

test('equally corroborated unlinked legacy CRM rows return ambiguity without selecting either row', async () => {
  const older = legacyCandidate('candidate-a', '2026-08-01T00:00:00.000Z');
  const newer = legacyCandidate('candidate-b', '2026-09-01T00:00:00.000Z');
  const storage = {
    async getSubmissionByListingUrl() { return null; },
    async listSubmissions({ search }) {
      if (!search) return { rows: [older, newer], total: 2 };
      return {
        rows: search === corroboratedDeal.name ? [older, newer] : [],
        total: search === corroboratedDeal.name ? 2 : 0,
      };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, corroboratedDeal);

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.submission, null);
  assert.deepEqual(result.candidateIds, ['candidate-a', 'candidate-b']);
  assert.deepEqual(result.evidenceCategories, ['corroborated-semantic']);
});

test('ambiguity is invariant to row order, timestamps, and lexicographic IDs', async () => {
  const first = legacyCandidate('z-last-id', '2030-01-01T00:00:00.000Z');
  const second = legacyCandidate('a-first-id', '2020-01-01T00:00:00.000Z');
  let rows = [first, second];
  const storage = {
    async getSubmissionByListingUrl() { return null; },
    async listSubmissions({ search }) {
      if (!search) return { rows, total: rows.length };
      const matches = search === corroboratedDeal.name ? rows : [];
      return { rows: matches, total: matches.length };
    },
  };

  const forward = await findExistingDealHunterSubmission(storage, corroboratedDeal);
  rows = [second, first];
  const reversed = await findExistingDealHunterSubmission(storage, corroboratedDeal);

  assert.equal(forward.status, 'ambiguous');
  assert.deepEqual(forward.candidateIds, ['a-first-id', 'z-last-id']);
  assert.deepEqual(reversed, forward);
});

test('bounded enumeration discovers corroborated near-title candidates that production substring search cannot', async () => {
  const nearTitle = {
    ...legacyCandidate('near-title', '2026-09-01T00:00:00.000Z'),
    company: 'Commercial HVAC Maintenance Company',
  };
  const current = {
    ...corroboratedDeal,
    name: 'Commercial HVAC Maintenance Services Company',
  };
  const storage = {
    async listSubmissions({ search = '' }) {
      const rows = search && !nearTitle.company.toLowerCase().includes(String(search).toLowerCase())
        ? []
        : [nearTitle];
      return { rows, total: rows.length };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, current);

  assert.equal(result.status, 'unique-corroborated');
  assert.equal(result.submission.id, nearTitle.id);
});

test('bounded enumeration discovers metadata-only listing aliases and reports equal matches as ambiguous', async () => {
  const metadataUrl = 'https://market.example/listing/metadata-only-42';
  const candidates = ['metadata-alias-a', 'metadata-alias-b'].map((id) => ({
    ...legacyCandidate(id, '2026-09-01T00:00:00.000Z'),
    company: `Historical name ${id}`,
    metadata: { dealHunter: { listingAliases: [metadataUrl] } },
  }));
  const storage = {
    async getSubmissionByListingUrl() { return null; },
    async listSubmissions({ search = '' }) {
      const searchable = (row) => [row.company, row.listing_url, row.notes].join(' ').toLowerCase();
      const rows = search
        ? candidates.filter((row) => searchable(row).includes(String(search).toLowerCase()))
        : candidates;
      return { rows, total: rows.length };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, {
    ...corroboratedDeal,
    name: 'Current renamed business',
    listingUrl: metadataUrl,
    dealKey: `url:${metadataUrl}`,
  });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.submission, null);
  assert.deepEqual(result.candidateIds, ['metadata-alias-a', 'metadata-alias-b']);
});

test('an exact alias beyond the former fiftieth position remains match authority', async () => {
  const listingAliases = Array.from({ length: 51 }, (_, index) => `https://market.example/listing/alias-${index + 1}`);
  const exact = {
    ...legacyCandidate('alias-51', '2026-09-01T00:00:00.000Z'),
    company: 'Historical alias-only name',
    metadata: { dealHunter: { listingAliases: [listingAliases[50]] } },
  };
  const result = await findExistingDealHunterSubmission({
    async listSubmissions({ search = '' }) {
      return search ? { rows: [], total: 0 } : { rows: [exact], total: 1 };
    },
  }, {
    ...corroboratedDeal,
    name: 'Current alias-only name',
    listingUrl: '',
    dealKey: '',
    listingAliases,
  });

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, exact.id);
});

test('more than five hundred direct identity aliases blocks the bounded match review', async () => {
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { return { rows: [], total: 0 }; },
    }, {
      ...corroboratedDeal,
      listingUrl: '',
      dealKey: '',
      identityAliases: Array.from({ length: 501 }, (_, index) => `costar:${1000000 + index}`),
    }),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE'
      && error.evidenceCategories?.includes('lookup-incomplete'),
  );
});

test('a valid canonical primary is exact authority even when unrelated legacy residue exists', async () => {
  const primary = {
    ...legacyCandidate('canonical-primary', '2026-09-01T00:00:00.000Z'),
    deal_hunter_opportunity_id: 'opp-current',
  };
  let searchCalls = 0;
  const storage = {
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: primary.id };
    },
    async listSubmissions() { searchCalls += 1; return { rows: [primary], total: 1 }; },
  };

  const result = await findExistingDealHunterSubmission(storage, {
    ...corroboratedDeal,
    opportunityId: 'opp-current',
  });

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, primary.id);
  assert.deepEqual(result.evidenceCategories, ['canonical-primary']);
  assert.equal(searchCalls, 1);
});

test('metadata-only canonical primary ownership remains valid authority', async () => {
  const primary = {
    ...legacyCandidate('metadata-primary', '2026-09-01T00:00:00.000Z'),
    deal_hunter_opportunity_id: null,
    metadata: { dealHunter: { opportunityId: 'opp-current' } },
  };
  const storage = {
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: primary.id };
    },
    async listSubmissions() { return { rows: [primary], total: 1 }; },
  };

  const result = await findExistingDealHunterSubmission(storage, {
    ...corroboratedDeal,
    opportunityId: 'opp-current',
  });

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, primary.id);
});

test('conflicting direct and metadata ownership blocks canonical primary selection', async () => {
  const primary = {
    ...legacyCandidate('conflicted-primary', '2026-09-01T00:00:00.000Z'),
    deal_hunter_opportunity_id: 'opp-current',
    metadata: { dealHunter: { opportunityId: 'opp-other' } },
  };
  const storage = {
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: primary.id };
    },
    async listSubmissions() { return { rows: [primary], total: 1 }; },
  };

  await assert.rejects(
    findExistingDealHunterSubmission(storage, { ...corroboratedDeal, opportunityId: 'opp-current' }),
    (error) => error?.code === 'CRM_MATCH_AUTHORITY_CONFLICT'
      && error.candidateIds?.[0] === primary.id,
  );
});

test('declared canonical opportunity requires current-authority lookup capability', async () => {
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { return { rows: [], total: 0 }; },
    }, { ...corroboratedDeal, opportunityId: 'opp-current' }),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE' && error.status === 503,
  );
});

test('missing or inactive canonical primary authority fails safely instead of searching for a replacement', async () => {
  let searchCalls = 0;
  const missingStorage = {
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: 'missing-primary' };
    },
    async listSubmissions() { searchCalls += 1; return { rows: [], total: 0 }; },
  };
  await assert.rejects(
    findExistingDealHunterSubmission(missingStorage, { ...corroboratedDeal, opportunityId: 'opp-current' }),
    (error) => error?.code === 'CRM_MATCH_AUTHORITY_STALE'
      && error.candidateIds?.[0] === 'missing-primary',
  );
  assert.equal(searchCalls, 1);

  const archived = {
    ...legacyCandidate('archived-primary', '2026-09-01T00:00:00.000Z'),
    status: 'archived',
    deal_hunter_opportunity_id: 'opp-current',
  };
  await assert.rejects(
    findExistingDealHunterSubmission({
      async getCurrentDealHunterOpportunity() {
        return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: archived.id };
      },
      async listSubmissions() { return { rows: [archived], total: 1 }; },
    }, { ...corroboratedDeal, opportunityId: 'opp-current' }),
    (error) => error?.code === 'CRM_MATCH_RECORD_INACTIVE',
  );
});

test('a passed canonical primary remains authoritative and is not converted into a creation decision', async () => {
  const passed = {
    ...legacyCandidate('passed-primary', '2026-09-01T00:00:00.000Z'),
    status: 'passed',
    deal_hunter_opportunity_id: 'opp-current',
  };
  const result = await findExistingDealHunterSubmission({
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: passed.id };
    },
    async listSubmissions() { return { rows: [passed], total: 1 }; },
  }, { ...corroboratedDeal, opportunityId: 'opp-current' });

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.status, 'passed');
});

test('a stable listing identity wins over weaker corroborated candidates despite financial drift', async () => {
  const exact = {
    ...legacyCandidate('exact-listing', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
    asking_price: '$9,999,999',
    ttm_revenue: '$1',
    ttm_ebitda: '$1',
  };
  const weaker = legacyCandidate('semantic-only', '2026-09-02T00:00:00.000Z');
  const storage = {
    async getSubmissionByListingUrl() { return exact; },
    async listSubmissions({ search }) {
      if (!search) return { rows: [exact, weaker], total: 2 };
      return { rows: search === corroboratedDeal.name ? [weaker] : [], total: search === corroboratedDeal.name ? 1 : 0 };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, corroboratedDeal);

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, exact.id);
  assert.deepEqual(result.evidenceCategories, ['stable-listing-identity']);
});

test('the same row discovered through multiple aliases is deduplicated before uniqueness is decided', async () => {
  const exact = {
    ...legacyCandidate('one-row', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const storage = {
    async getSubmissionByListingUrl() { return exact; },
    async listSubmissions() { return { rows: [exact], total: 1 }; },
  };

  const result = await findExistingDealHunterSubmission(storage, corroboratedDeal);

  assert.equal(result.status, 'unique-exact');
  assert.deepEqual(result.candidateIds, ['one-row']);
});

test('an exact deal-key alias cannot override hard geographic identity conflict', async () => {
  const wrongGeography = {
    ...legacyCandidate('wrong-geography', '2026-09-01T00:00:00.000Z'),
    notes: `Deal key: ${corroboratedDeal.dealKey}`,
    metadata: { dealHunter: { raw: { City: 'Pooler', State: 'GA' } } },
  };
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { return { rows: [wrongGeography], total: 1 }; },
    }, corroboratedDeal),
    (error) => error?.code === 'CRM_MATCH_IDENTITY_CONFLICT'
      && error.candidateIds?.[0] === wrongGeography.id
      && error.evidenceCategories?.includes('geography-conflict'),
  );
});

test('an exact deal-key alias cannot override stable source or marketplace identity conflict', async () => {
  const stableSourceConflictCandidate = {
    ...legacyCandidate('wrong-source-identity', '2026-09-01T00:00:00.000Z'),
    notes: 'Deal key: source:sheet:current-stable-id',
    metadata: {
      dealHunter: {
        sourceId: 'sheet',
        externalId: 'different-stable-id',
        sourceRecords: [{ externalId: 'different-stable-id', stableExternalId: true }],
        raw: { City: corroboratedDeal.city, State: corroboratedDeal.state },
      },
    },
  };
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { return { rows: [stableSourceConflictCandidate], total: 1 }; },
    }, {
      ...corroboratedDeal,
      id: 'current-stable-id',
      stableExternalId: true,
      sourceId: 'sheet',
      dealKey: 'source:sheet:current-stable-id',
      listingUrl: '',
    }),
    (error) => error?.code === 'CRM_MATCH_IDENTITY_CONFLICT'
      && error.evidenceCategories?.includes('source-identity-conflict'),
  );

  const marketplaceConflictCandidate = {
    ...legacyCandidate('wrong-marketplace-identity', '2026-09-01T00:00:00.000Z'),
    notes: 'Deal key: source:historical:shared-key',
    metadata: {
      dealHunter: {
        identityAliases: ['costar:2222222'],
        raw: { City: corroboratedDeal.city, State: corroboratedDeal.state },
      },
    },
  };
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { return { rows: [marketplaceConflictCandidate], total: 1 }; },
    }, {
      ...corroboratedDeal,
      dealKey: 'source:historical:shared-key',
      listingUrl: '',
      identityAliases: ['costar:1111111'],
    }),
    (error) => error?.code === 'CRM_MATCH_IDENTITY_CONFLICT'
      && error.evidenceCategories?.includes('marketplace-conflict'),
  );
});

test('an exact listing cannot override a conflicting stable source identity', async () => {
  const exactButWrongSource = {
    ...legacyCandidate('exact-listing-wrong-source', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
    metadata: {
      dealHunter: {
        sourceId: 'sheet',
        externalId: 'different-stable-id',
        sourceRecords: [{ externalId: 'different-stable-id', stableExternalId: true }],
        raw: { City: corroboratedDeal.city, State: corroboratedDeal.state },
      },
    },
  };

  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { return { rows: [exactButWrongSource], total: 1 }; },
    }, {
      ...corroboratedDeal,
      id: 'current-stable-id',
      stableExternalId: true,
      sourceId: 'sheet',
    }),
    (error) => error?.code === 'CRM_MATCH_IDENTITY_CONFLICT'
      && error.evidenceCategories?.includes('source-identity-conflict'),
  );
});

test('a weaker matching row owned by another opportunity blocks an otherwise unique exact match', async () => {
  const exact = {
    ...legacyCandidate('unowned-exact', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const ownedWeaker = {
    ...legacyCandidate('owned-weaker', '2026-09-01T00:00:00.000Z'),
    notes: `Deal key: ${corroboratedDeal.dealKey}`,
    company: 'Historical unrelated title',
    deal_hunter_opportunity_id: 'opp-other',
  };

  await assert.rejects(
    findExistingDealHunterSubmission({
      async getCurrentDealHunterOpportunity() {
        return { opportunity_id: 'opp-current', status: 'active', primary_submission_id: null };
      },
      async listSubmissions() { return { rows: [exact, ownedWeaker], total: 2 }; },
    }, { ...corroboratedDeal, opportunityId: 'opp-current' }),
    (error) => error?.code === 'CRM_MATCH_AUTHORITY_CONFLICT'
      && error.candidateIds?.[0] === ownedWeaker.id,
  );
});

test('candidate search uses one complete provider snapshot before declaring a unique exact match', async () => {
  const filler = Array.from({ length: 100 }, (_, index) => ({
    id: `filler-${index}`,
    status: 'review',
    company: `Different Company ${index}`,
  }));
  const exact = {
    ...legacyCandidate('page-two-exact', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const reads = [];
  const storage = {
    async listSubmissions(options) {
      reads.push(options);
      return { rows: [...filler, exact], total: 101 };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, corroboratedDeal);

  assert.equal(result.status, 'unique-exact');
  assert.equal(result.submission.id, exact.id);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].page, 1);
  assert.equal(reads[0].limit, 5000);
});

test('an equal-strength candidate after the former first-page boundary prevents unique selection', async () => {
  const first = {
    ...legacyCandidate('first-page-exact', '2026-09-01T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const second = {
    ...legacyCandidate('second-page-exact', '2026-09-02T00:00:00.000Z'),
    listing_url: corroboratedDeal.listingUrl,
  };
  const filler = Array.from({ length: 99 }, (_, index) => ({
    id: `unrelated-${index}`,
    status: 'review',
    company: `Unrelated ${index}`,
  }));
  const storage = {
    async listSubmissions({ page, limit }) {
      assert.equal(page, 1);
      assert.equal(limit, 5000);
      return { rows: [first, ...filler, second], total: 101 };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, corroboratedDeal);

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.submission, null);
  assert.deepEqual(result.candidateIds, ['first-page-exact', 'second-page-exact']);
});

test('Pooler and Berlin-shaped rows remain distinct despite matching title, broker, and revenue', async () => {
  const shared = {
    status: 'review',
    company: 'Profitable Senior Independence Support',
    broker_email: 'same-agent@example.test',
    ttm_revenue: '$2,400,000',
    ttm_ebitda: '$490,070',
    asking_price: '$1,400,000',
  };
  const pooler = {
    ...shared,
    id: 'pooler-2516010',
    listing_url: 'https://market.example/listing/2516010',
    metadata: { dealHunter: { raw: { City: 'Pooler', State: 'GA' } } },
  };
  const berlin = {
    ...shared,
    id: 'berlin-2436873',
    listing_url: 'https://market.example/listing/2436873',
    metadata: { dealHunter: { raw: { City: 'Berlin Township', State: 'NJ' } } },
  };
  const storage = {
    async getSubmissionByListingUrl(url) {
      return [pooler, berlin].find((row) => row.listing_url === url) || null;
    },
    async listSubmissions() { return { rows: [pooler, berlin], total: 2 }; },
  };

  const poolerResult = await findExistingDealHunterSubmission(storage, {
    ...corroboratedDeal,
    name: shared.company,
    city: 'Pooler',
    state: 'GA',
    location: 'Pooler, GA',
    annualRevenue: 2400000,
    listingUrl: pooler.listing_url,
    dealKey: `url:${pooler.listing_url}`,
  });
  const berlinResult = await findExistingDealHunterSubmission(storage, {
    ...corroboratedDeal,
    name: shared.company,
    annualRevenue: 2400000,
    listingUrl: berlin.listing_url,
    dealKey: `url:${berlin.listing_url}`,
  });

  assert.equal(poolerResult.status, 'unique-exact');
  assert.equal(poolerResult.submission.id, pooler.id);
  assert.equal(berlinResult.status, 'unique-exact');
  assert.equal(berlinResult.submission.id, berlin.id);
});

test('lookup failure and incomplete lookup are explicit fail-closed blockers', async () => {
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() { throw new Error('synthetic lookup outage'); },
    }, corroboratedDeal),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_FAILED' && error.status === 503,
  );

  await assert.rejects(
    findExistingDealHunterSubmission({}, corroboratedDeal),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE' && error.status === 503,
  );

  const partialPage = Array.from({ length: 100 }, (_, index) => ({
    ...legacyCandidate(`partial-${index}`, '2026-08-01T00:00:00.000Z'),
    company: `Unrelated record ${index}`,
    notes: '',
    metadata: {},
  }));
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() {
        return { rows: partialPage, total: 101 };
      },
    }, corroboratedDeal),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE' && error.status === 503,
  );

  let safetyLimitCalls = 0;
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() {
        safetyLimitCalls += 1;
        return {
          rows: Array.from({ length: 5000 }, (_, index) => ({
            ...legacyCandidate(`bounded-${index}`, '2026-08-01T00:00:00.000Z'),
            company: `Unrelated bounded record ${index}`,
            notes: '',
            metadata: {},
          })),
          total: 5001,
        };
      },
    }, corroboratedDeal),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE' && error.status === 503,
  );
  assert.equal(safetyLimitCalls, 1);

  const duplicate = legacyCandidate('duplicate-during-enumeration', '2026-08-01T00:00:00.000Z');
  await assert.rejects(
    findExistingDealHunterSubmission({
      async listSubmissions() {
        return { rows: [duplicate, duplicate], total: 2 };
      },
    }, corroboratedDeal),
    (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE'
      && error.evidenceCategories?.includes('lookup-incomplete'),
  );
});

test('name or broker overlap without corroboration is not a CRM identity match', async () => {
  const weak = {
    id: 'weak-overlap',
    status: 'review',
    company: corroboratedDeal.name,
    broker_email: 'same-broker@example.test',
    ttm_revenue: '$90,000,000',
    ttm_ebitda: '$10,000',
    asking_price: '$40,000,000',
    metadata: { dealHunter: { raw: { State: 'WA' } } },
  };
  const storage = {
    async getSubmissionByListingUrl() { return null; },
    async listSubmissions({ search }) {
      if (!search) return { rows: [weak], total: 1 };
      return { rows: search === corroboratedDeal.name ? [weak] : [], total: search === corroboratedDeal.name ? 1 : 0 };
    },
  };

  const result = await findExistingDealHunterSubmission(storage, {
    ...corroboratedDeal,
    brokerEmail: 'same-broker@example.test',
  });

  assert.equal(result.status, 'none');
  assert.equal(result.submission, null);
});
