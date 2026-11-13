// Deterministic inputs for test/cimOpportunityIdentityScale.test.js.
//
// Every builder takes the identity module as an argument so the same inputs
// can be run against an older export of server/services/cimOpportunityIdentity.js
// when the expected digests in the test have to be regenerated.

import { createHash } from 'node:crypto';

export const fixtureNow = '2026-01-01T00:00:00.000Z';

const sharedDescription = [
  'Established commercial contractor serving recurring maintenance customers across a protected regional territory.',
  'Experienced technicians perform inspection installation repair replacement compliance and emergency field services.',
  'Management systems trained employees diversified accounts and service agreements support predictable operations.',
].join(' ');

const unrelatedDescription = [
  'Boutique coffee roaster with wholesale cafe accounts subscription boxes and a busy downtown retail tasting room.',
  'Owners source single origin beans directly from farms and run barista training classes for local hospitality staff.',
].join(' ');

export function listingDeal(overrides = {}) {
  return {
    dealKey: 'url:https://market-a.example/listing/12345',
    dealKeyAliases: [],
    identityAliases: [],
    sourceId: 'sheet-0',
    sourceName: 'Daily Deal Hunter',
    id: 'row-17',
    stableExternalId: false,
    name: 'Commercial HVAC and Electrical Contractor',
    description: sharedDescription,
    location: 'Springfield, MO',
    city: 'Springfield',
    state: 'MO',
    country: 'US',
    annualProfit: 800000,
    annualRevenue: 5643224,
    askingPrice: 6500000,
    brokerName: 'Kelvin Woods',
    brokerEmail: 'kelvin.woods@cbiteam.com',
    listingUrl: 'https://market-a.example/listing/12345',
    sourceRecords: [{ sourceId: 'sheet-0' }],
    ...overrides,
  };
}

function opportunityFor(identity, id, deal) {
  return identity.buildCimOpportunityRecord(deal, id, fixtureNow);
}

// Opportunities that never share the listing's name. Several carry the same
// description, recipient, location and financials as the listings, so only the
// name keeps them out of `automatic` and `ambiguous`.
function background(identity, prefix, count) {
  return Array.from({ length: count }, (_, index) => opportunityFor(identity, `${prefix}_bg_${index}`, listingDeal({
    name: `Unrelated Holding ${index}`,
    listingUrl: `https://market-b.example/listing/bg-${prefix}-${index}`,
    description: index % 3 === 0 ? unrelatedDescription : sharedDescription,
    brokerEmail: index % 2 === 0 ? 'kelvin.woods@cbiteam.com' : `broker${index}@example.com`,
  })));
}

function interleave(backgroundRows, rows) {
  const output = [];
  const step = Math.max(1, Math.floor(backgroundRows.length / (rows.length + 1)));
  let cursor = 0;
  for (const row of rows) {
    output.push(...backgroundRows.slice(cursor, cursor + step), row);
    cursor += step;
  }
  output.push(...backgroundRows.slice(cursor));
  return output;
}

function sameNameAmbiguous(identity, id, name, index) {
  // Same name and recipient, no description evidence: ambiguous, never automatic.
  return opportunityFor(identity, id, listingDeal({
    name,
    description: '',
    listingUrl: `https://market-c.example/listing/${id}`,
    location: index % 2 === 0 ? 'Springfield, MO' : '',
    annualRevenue: null,
  }));
}

export function buildBehaviourCases(identity) {
  const cases = [];

  {
    const deal = listingDeal({ name: 'Automatic Match Contractor', id: 'row-auto' });
    const match = opportunityFor(identity, 'opp_auto_match', listingDeal({
      name: 'Automatic Match Contractor',
      listingUrl: 'https://market-d.example/listing/auto',
    }));
    cases.push({ name: 'automatic', deal, opportunities: interleave(background(identity, 'auto', 30), [match]) });
  }

  {
    const name = 'Ambiguous Plumbing Group';
    const deal = listingDeal({ name, id: 'row-ambiguous' });
    const recipientOnly = sameNameAmbiguous(identity, 'opp_amb_recipient', name, 0);
    const corroborated = opportunityFor(identity, 'opp_amb_corroborated', listingDeal({
      name,
      brokerEmail: 'someone.else@example.com',
      listingUrl: 'https://market-d.example/listing/amb-corroborated',
      sourceRecords: [{ sourceId: 'deal-os' }],
      sourceId: 'deal-os',
    }));
    const distinctState = opportunityFor(identity, 'opp_amb_distinct_state', listingDeal({
      name,
      state: 'KS',
      listingUrl: 'https://market-d.example/listing/amb-distinct',
    }));
    const legacyFallback = {
      opportunity_id: 'opp_amb_legacy',
      created_at: fixtureNow,
      updated_at: fixtureNow,
      canonical_name: '  AMBIGUOUS   plumbing group ',
      canonical_recipient: 'Kelvin.Woods@cbiteam.com',
      canonical_location: 'Springfield, MO',
      status: 'active',
      metadata: {},
    };
    const inactive = { ...sameNameAmbiguous(identity, 'opp_amb_inactive', name, 0), status: 'superseded' };
    cases.push({
      name: 'ambiguous',
      deal,
      opportunities: interleave(background(identity, 'amb', 30), [recipientOnly, distinctState, corroborated, inactive, legacyFallback]),
    });
  }

  {
    const name = 'Overflow Electrical Services';
    const deal = listingDeal({ name, id: 'row-overflow' });
    const rows = Array.from({ length: 13 }, (_, index) => sameNameAmbiguous(identity, `opp_overflow_${String(index).padStart(2, '0')}`, name, index));
    cases.push({ name: 'ambiguous-overflow', deal, opportunities: interleave(background(identity, 'ovf', 40), rows.reverse()) });
  }

  {
    const name = 'Twice Matched Mechanical';
    const deal = listingDeal({ name, id: 'row-multi' });
    const first = opportunityFor(identity, 'opp_multi_auto_b', listingDeal({ name, listingUrl: 'https://market-d.example/listing/multi-b' }));
    const second = opportunityFor(identity, 'opp_multi_auto_a', listingDeal({ name, listingUrl: 'https://market-d.example/listing/multi-a' }));
    const ambiguousRows = Array.from({ length: 11 }, (_, index) => sameNameAmbiguous(identity, `opp_multi_amb_${index}`, name, index));
    cases.push({
      name: 'multiple-automatic',
      deal,
      opportunities: interleave(background(identity, 'multi', 40), [ambiguousRows[0], first, ...ambiguousRows.slice(1, 6), second, ...ambiguousRows.slice(6)]),
    });
  }

  {
    const deal = listingDeal({ name: 'Nobody Shares This Name', id: 'row-none' });
    cases.push({ name: 'no-match', deal, opportunities: background(identity, 'none', 30) });
  }

  {
    const deal = listingDeal({ name: 'Acme Widgets & Co.', id: 'row-unnormalized' });
    const evidence = listingDeal({ name: 'Acme Widgets & Co.', listingUrl: 'https://market-d.example/listing/acme' });
    const built = opportunityFor(identity, 'opp_unnormalized_raw', evidence);
    // Stored raw: the comparison reads it as-is, so it must not match.
    const raw = {
      ...built,
      metadata: { ...built.metadata, identitySnapshot: { ...built.metadata.identitySnapshot, name: 'Acme Widgets & Co.' } },
    };
    // Metadata name wins over canonical_name in both directions.
    const metadataWins = {
      ...opportunityFor(identity, 'opp_unnormalized_metadata_wins', evidence),
      canonical_name: 'Completely Different Name',
    };
    const canonicalIgnored = {
      ...built,
      opportunity_id: 'opp_unnormalized_canonical_ignored',
      canonical_name: 'Acme Widgets & Co.',
      metadata: { ...built.metadata, identitySnapshot: { ...built.metadata.identitySnapshot, name: 'acme widgets incorporated' } },
    };
    const missingName = {
      ...built,
      opportunity_id: 'opp_unnormalized_missing_name',
      metadata: { ...built.metadata, identitySnapshot: Object.fromEntries(Object.entries(built.metadata.identitySnapshot).filter(([key]) => key !== 'name')) },
    };
    cases.push({
      name: 'unnormalized-metadata-name',
      deal,
      opportunities: interleave(background(identity, 'unnorm', 20), [raw, canonicalIgnored, metadataWins, missingName]),
    });
    cases.push({
      name: 'unnormalized-metadata-name-only-raw',
      deal,
      opportunities: interleave(background(identity, 'unnorm2', 20), [raw, canonicalIgnored, missingName]),
    });
  }

  {
    const deal = listingDeal({ name: '', id: 'row-empty' });
    const punctuationDeal = listingDeal({ name: '  !!! -- ', id: 'row-punctuation', listingUrl: 'https://market-a.example/listing/punct' });
    const emptyEvidence = listingDeal({ name: '', listingUrl: 'https://market-d.example/listing/empty' });
    const emptyMetadata = opportunityFor(identity, 'opp_empty_metadata', emptyEvidence);
    const emptyCanonical = {
      opportunity_id: 'opp_empty_canonical',
      created_at: fixtureNow,
      updated_at: fixtureNow,
      canonical_name: '',
      canonical_recipient: 'kelvin.woods@cbiteam.com',
      canonical_location: 'Springfield, MO',
      status: 'active',
      metadata: null,
    };
    const opportunities = interleave(background(identity, 'empty', 20), [emptyMetadata, emptyCanonical]);
    cases.push({ name: 'empty-name', deal, opportunities });
    cases.push({ name: 'punctuation-only-name', deal: punctuationDeal, opportunities });
  }

  return cases;
}

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const generatedOpportunityId = /^opp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** JSON with the run's clock and random opportunity IDs replaced by placeholders. */
export function normalizedJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (typeof item !== 'string') return item;
    if (isoTimestamp.test(item) && item !== fixtureNow) return '<now>';
    if (generatedOpportunityId.test(item)) return '<generated-opportunity-id>';
    return item;
  });
}

export function createFakeIdentityStorage(opportunities = []) {
  const calls = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  return {
    calls,
    async findCurrentDealHunterOpportunityByAliases(aliasKeys) {
      calls.push(['findCurrentDealHunterOpportunityByAliases', aliasKeys]);
      return null;
    },
    async getCurrentDealHunterOpportunity(id) {
      return opportunities.find((item) => item.opportunity_id === id) || null;
    },
    async listCurrentDealHunterOpportunities(options) {
      calls.push(['listCurrentDealHunterOpportunities', options]);
      return [...opportunities];
    },
    async upsertDealHunterOpportunity(record) {
      calls.push(['upsertDealHunterOpportunity', clone(record)]);
      return record;
    },
    async upsertDealHunterOpportunityAlias(record) {
      calls.push(['upsertDealHunterOpportunityAlias', clone(record)]);
      return record;
    },
    async linkDealHunterOpportunityAliases(records) {
      calls.push(['linkDealHunterOpportunityAliases', clone(records)]);
      return { conflict: null };
    },
    async upsertDealHunterIdentityException(record) {
      calls.push(['upsertDealHunterIdentityException', clone(record)]);
      return record;
    },
    async createDealHunterOpportunityWithAliases(input) {
      calls.push(['createDealHunterOpportunityWithAliases', clone(input)]);
      return { created: true, opportunity: input.opportunity };
    },
  };
}

export const resolverModes = [
  { name: 'write-candidates', readOnly: false, passCandidates: true, allowCreate: true },
  { name: 'write-storage-list', readOnly: false, passCandidates: false, allowCreate: true },
  { name: 'write-no-create', readOnly: false, passCandidates: true, allowCreate: false },
  { name: 'read-only-candidates', readOnly: true, passCandidates: true },
  { name: 'read-only-storage-list', readOnly: true, passCandidates: false },
];

/** Runs every behaviour case through every resolver mode; returns normalized outcomes. */
export async function runBehaviourCases(identity) {
  const outcomes = [];
  for (const scenario of buildBehaviourCases(identity)) {
    for (const mode of resolverModes) {
      const storage = createFakeIdentityStorage(scenario.opportunities);
      const resolve = mode.readOnly ? identity.resolveDealHunterOpportunityReadOnly : identity.resolveDealHunterOpportunity;
      const result = await resolve({
        deal: scenario.deal,
        storage,
        ...(mode.readOnly ? {} : { allowCreate: mode.allowCreate, actor: 'deal-hunter-review' }),
        ...(mode.passCandidates ? { candidateOpportunities: scenario.opportunities } : {}),
      });
      outcomes.push({ scenario: scenario.name, mode: mode.name, result: JSON.parse(normalizedJson(result)), calls: JSON.parse(normalizedJson(storage.calls)) });
    }
  }
  return outcomes;
}

export function sha256Json(value) {
  return createHash('sha256').update(normalizedJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Scale: 1,000 listings against 5,000 active opportunities, resolved the way
// attachCanonicalOpportunityIdentities in server/services/dealHunter.js does it
// (one shared candidate list, updated after each resolution).

export const scaleOpportunityCount = 5000;
export const scaleListingCount = 1000;
const duplicatedNameCount = 500;

function scaleDescription(index) {
  return `${sharedDescription} Territory ${index} serves ${index % 17} counties with ${index % 9} branch offices.`;
}

function scaleOpportunityDeal(index) {
  // The last 500 opportunities repeat the names of the first 500.
  const nameIndex = index >= scaleOpportunityCount - duplicatedNameCount ? index - (scaleOpportunityCount - duplicatedNameCount) : index;
  return listingDeal({
    name: `Scale Business ${nameIndex}`,
    id: `opp-row-${index}`,
    description: scaleDescription(nameIndex),
    brokerEmail: `broker${nameIndex % 300}@example.com`,
    listingUrl: `https://market-s.example/listing/opp-${index}`,
    askingPrice: 1000000 + nameIndex * 1000,
    annualRevenue: 3000000 + nameIndex * 1000,
    annualProfit: 500000 + nameIndex * 100,
  });
}

export function buildScaleFixture(identity) {
  const opportunities = Array.from({ length: scaleOpportunityCount }, (_, index) => (
    opportunityFor(identity, `opp_scale_${String(index).padStart(5, '0')}`, scaleOpportunityDeal(index))
  ));
  const listings = Array.from({ length: scaleListingCount }, (_, index) => {
    if (index < 300) {
      // Same evidence as an existing opportunity on another URL. The first 150
      // names belong to two opportunities (multiple automatic candidates); the
      // next 150 to one (a single automatic match).
      const nameIndex = index < 150 ? index : 1000 + index;
      return { ...scaleOpportunityDeal(nameIndex), id: `listing-${index}`, listingUrl: `https://market-t.example/listing/${index}` };
    }
    if (index < 450) {
      // Same name and recipient but no description: ambiguous.
      return { ...scaleOpportunityDeal(2000 + index), id: `listing-${index}`, description: '', listingUrl: `https://market-t.example/listing/${index}` };
    }
    // New names; every tenth one repeats an earlier new listing's name.
    const newNameIndex = index % 10 === 0 ? index - 5 : index;
    return listingDeal({
      name: `Fresh Listing ${newNameIndex}`,
      id: `listing-${index}`,
      description: scaleDescription(10000 + newNameIndex),
      brokerEmail: `fresh${newNameIndex}@example.com`,
      listingUrl: `https://market-t.example/listing/${index}`,
    });
  });
  return { opportunities, listings };
}

/**
 * Counts every read of an opportunity's stored description evidence. The
 * comparison reads it once per pair, so the count is the work the resolver did.
 */
export function instrumentDescriptionReads(opportunities) {
  const counter = { reads: 0 };
  for (const opportunity of opportunities) {
    const snapshot = opportunity.metadata.identitySnapshot;
    const { description } = snapshot;
    Object.defineProperty(snapshot, 'description', {
      enumerable: true,
      configurable: true,
      get() {
        counter.reads += 1;
        return description;
      },
    });
  }
  return counter;
}

export async function runScaleResolution(identity, { opportunities, listings }) {
  const storage = createFakeIdentityStorage();
  const candidates = [...opportunities];
  const outcomes = [];
  for (const deal of listings) {
    const resolution = await identity.resolveDealHunterOpportunity({
      deal,
      storage,
      actor: 'deal-hunter-review',
      candidateOpportunities: candidates,
    });
    if (resolution.opportunity) {
      const candidateIndex = candidates.findIndex((item) => item.opportunity_id === resolution.opportunity.opportunity_id);
      if (candidateIndex >= 0) candidates[candidateIndex] = resolution.opportunity;
      else candidates.push(resolution.opportunity);
    }
    outcomes.push({
      status: resolution.status,
      resolution: resolution.resolution || resolution.identityException?.reason || '',
      opportunityId: resolution.opportunityId || '',
      candidates: resolution.identityException?.candidate_opportunity_ids || [],
      evidence: resolution.evidence || resolution.identityException?.metadata?.comparisons || null,
    });
  }
  return { outcomes, calls: storage.calls };
}

export function summarizeScaleOutcomes(outcomes) {
  const counts = {};
  for (const outcome of outcomes) {
    const key = `${outcome.status}:${outcome.resolution}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
