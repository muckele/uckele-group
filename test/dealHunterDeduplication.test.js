import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = 'https://example.test/deduplication.csv';
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/deduplication.csv';
process.env.DEAL_HUNTER_LOOKBACK_DAYS = '30';
process.env.ADMIN_SESSION_SECRET = 'deal-hunter-deduplication-test-secret';

const {
  dedupeDeals,
  findExistingDealHunterSubmission,
  parseSheetCsvDeals,
  reviewDailyDeals,
} = await import('../server/services/dealHunter.js');

const originalFetch = globalThis.fetch;
const today = new Date().toISOString().slice(0, 10);
const longDescription = [
  'This established contractor provides commercial HVAC and electrical installation, repair, and recurring maintenance services.',
  'The trained field team serves diversified customers under service agreements and compliance-driven maintenance programs.',
  'Real estate and operating assets support the company, while management and technicians handle daily service delivery.',
].join(' ');
let activeCsv = '';
let fetchCalls = [];

beforeEach(() => {
  activeCsv = '';
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === 'https://example.test/deduplication.csv') {
      return new Response(activeCsv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
    }
    return new Response('not found', { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

function csvCell(value = '') {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sheetCsv(rows) {
  const headers = [
    'Listing ID', 'Business Name', 'Listing URL', 'Listing Source', 'State', 'Date Added',
    'Annual Profit', 'Annual Revenue', 'Asking Price', 'Broker Name', 'Broker Email', 'Description',
  ];
  return [headers.join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\n');
}

function syndicatedRows(overrides = {}) {
  return [
    {
      'Business Name': 'HVAC & Electrical Contractor with Real Estate',
      'Listing URL': 'https://www.bizbuysell.com/Business-Opportunity/hvac-electrical/2401626/',
      'Listing Source': 'BizBuySell',
      State: 'MO',
      'Date Added': today,
      'Annual Profit': '$800,000',
      'Annual Revenue': '$5,643,224',
      'Asking Price': '$6,500,000',
      'Broker Name': 'Kelvin Woods',
      'Broker Email': 'kelvin.woods@cbiteam.com',
      Description: longDescription,
      ...overrides.first,
    },
    {
      'Business Name': 'HVAC & Electrical Contractor with Real Estate',
      'Listing URL': 'https://dealstream.com/d/biz-sale/09w2qq',
      'Listing Source': 'DealStream',
      State: 'MO',
      'Date Added': today,
      'Annual Profit': '$800,000',
      'Annual Revenue': '$5,643,224',
      'Asking Price': '$6,500,000',
      Description: longDescription,
      ...overrides.second,
    },
  ];
}

function reviewStorage(overrides = {}) {
  return {
    async listDealHunterSeenDeals() { return []; },
    async listDealHunterCimRequests() { return []; },
    async listDealHunterDispositions() { return []; },
    ...overrides,
  };
}

function allReviewDeals(review) {
  return [...review.qualified, ...review.watchlist, ...review.removalCandidates];
}

test('numeric Sheet positions are not durable identities while explicit numeric listing IDs are', () => {
  const positional = parseSheetCsvDeals(sheetCsv([{
    'Business Name': 'Commercial HVAC Services',
    State: 'CA',
    'Annual Profit': '$450,000',
    Description: longDescription,
  }])).deals[0];
  const explicit = parseSheetCsvDeals(sheetCsv([{
    'Listing ID': '2401626',
    'Business Name': 'Commercial HVAC Services',
    State: 'CA',
    'Annual Profit': '$450,000',
    Description: longDescription,
  }])).deals[0];
  const [positionalResult] = dedupeDeals([positional]);
  const [explicitResult] = dedupeDeals([explicit]);

  assert.equal(positional.id, '1');
  assert.equal(positional.stableExternalId, false);
  assert.equal(positional.idFromSourceRowPosition, true);
  assert.equal(positionalResult.identityAliases.some((alias) => alias === 'source:sheet-0:1'), false);
  assert.equal(explicit.stableExternalId, true);
  assert.equal(explicit.idFromSourceRowPosition, false);
  assert.equal(explicitResult.identityAliases.includes('source:sheet-0:2401626'), true);
});

test('moving a Sheet row changes only its positional metadata, not its listing identity', () => {
  const target = {
    'Business Name': 'Commercial HVAC Services',
    'Listing URL': 'https://broker.example/listings/hvac-42',
    State: 'CA',
    'Annual Profit': '$450,000',
    Description: longDescription,
  };
  const firstPosition = parseSheetCsvDeals(sheetCsv([target])).deals[0];
  const secondPosition = parseSheetCsvDeals(sheetCsv([
    { 'Business Name': 'Another Listing', State: 'NY', Description: longDescription },
    target,
  ])).deals[1];
  const firstIdentity = dedupeDeals([firstPosition])[0];
  const secondIdentity = dedupeDeals([secondPosition])[0];

  assert.equal(firstPosition.id, '1');
  assert.equal(secondPosition.id, '2');
  assert.deepEqual(firstIdentity.identityAliases, secondIdentity.identityAliases);
  assert.equal(firstIdentity.dealKeyAliases[0], secondIdentity.dealKeyAliases[0]);
});

test('corroborated syndicated listings collapse to one canonical opportunity and inherit Kelvin Woods contact provenance', () => {
  const parsed = parseSheetCsvDeals(sheetCsv(syndicatedRows()));
  const deals = dedupeDeals(parsed.deals);

  assert.equal(deals.length, 1);
  const [deal] = deals;
  assert.equal(deal.listingUrl.includes('bizbuysell.com'), true);
  assert.deepEqual(new Set(deal.listingAliases), new Set([
    'https://www.bizbuysell.com/Business-Opportunity/hvac-electrical/2401626/',
    'https://dealstream.com/d/biz-sale/09w2qq',
  ]));
  assert.equal(deal.brokerName, 'Kelvin Woods');
  assert.equal(deal.brokerEmail, 'kelvin.woods@cbiteam.com');
  assert.equal(deal.brokerContacts[0].sourceListingUrl.includes('bizbuysell.com'), true);
  assert.equal(deal.sourceRecords.length, 2);
  assert.equal(deal.deduplicationMatches[0].decision, 'automatic');
  assert.equal(deal.deduplicationMatches[0].reason, 'title-description-location-financials');
});

test('matching text and financials in conflicting states remain distinct opportunities', () => {
  const parsed = parseSheetCsvDeals(sheetCsv(syndicatedRows({ second: { State: 'CA' } })));
  assert.equal(dedupeDeals(parsed.deals).length, 2);
});

test('near-title syndication requires near-identical descriptions, location, and two matching financials', () => {
  const parsed = parseSheetCsvDeals(sheetCsv(syndicatedRows({
    second: { 'Business Name': 'HVAC Electrical Contractor with Real Estate' },
  })));
  assert.equal(dedupeDeals(parsed.deals).length, 1);
});

test('description-free Deal OS and Daily Deal Update copies merge on exact title, geography, and financials', () => {
  const parsed = parseSheetCsvDeals(sheetCsv([
    {
      'Business Name': 'Nassau County HVAC Company',
      'Listing URL': 'https://www.bizbuysell.com/business-opportunity/nassau-county-hvac-company/2534394/',
      'Listing Source': 'BizBuySell',
      State: 'NY',
      'Annual Profit': '$427,747',
      'Annual Revenue': '$1,141,941',
      'Asking Price': '$950,000',
    },
  ])).deals[0];
  const dealOsCopy = {
    ...parsed,
    id: '',
    stableExternalId: false,
    sourceId: 'deal-os-export',
    sourceName: 'SMB Deal OS export',
    sourceMode: 'manual-export',
    name: 'Nassau County HVAC Company For Sale',
    listingUrl: 'https://www.dealstream.com/d/biz-sale/hvac/tomhyp',
    raw: { ...parsed.raw, 'Listing URL': 'https://www.dealstream.com/d/biz-sale/hvac/tomhyp' },
  };

  const deals = dedupeDeals([parsed, dealOsCopy]);
  assert.equal(deals.length, 1);
  assert.deepEqual(new Set(deals[0].listingAliases), new Set([
    'https://www.bizbuysell.com/business-opportunity/nassau-county-hvac-company/2534394/',
    'https://www.dealstream.com/d/biz-sale/hvac/tomhyp',
  ]));
  assert.equal(deals[0].deduplicationMatches[0].reason, 'near-title-location-financials');
});

test('same-marketplace re-listings merge only with exact title, geography, and corroborating financials', () => {
  const rows = [
    {
      'Business Name': 'Commercial Cabinet Manufacturer',
      'Listing URL': 'https://www.bizbuysell.com/business-opportunity/commercial-cabinet-manufacturer/2538197/',
      State: 'CT',
      'Annual Profit': '$300,166',
      'Annual Revenue': '$1,765,992',
      'Asking Price': '$650,000',
    },
    {
      'Business Name': 'Commercial Cabinet Manufacturer',
      'Listing URL': 'https://www.bizbuysell.com/business-opportunity/commercial-cabinet-manufacturer/2489676/',
      State: 'CT',
      'Annual Profit': '$300,166',
      'Annual Revenue': '$1,765,992',
      'Asking Price': '$650,000',
    },
  ];

  const deals = dedupeDeals(parseSheetCsvDeals(sheetCsv(rows)).deals);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].deduplicationMatches[0].reason, 'exact-title-location-financials');
});

test('near-identical description-free titles require all three matching financials', () => {
  const rows = [
    {
      'Business Name': 'Electric Firm with Niche in Fire Protection Systems',
      'Listing URL': 'https://www.businessbroker.net/business-for-sale/electric-firm-fire-protection/1010327.aspx',
      State: 'NY',
      'Annual Profit': '$717,956',
      'Annual Revenue': '$2,520,761',
      'Asking Price': '$1,785,000',
    },
    {
      'Business Name': 'Electric Firm with Niche in Fire Protection System',
      'Listing URL': 'https://www.dealstream.com/d/biz-sale/engineering/q40m15',
      State: 'NY',
      'Annual Profit': '$717,956',
      'Annual Revenue': '$2,520,761',
      'Asking Price': '$1,785,000',
    },
  ];

  const deals = dedupeDeals(parseSheetCsvDeals(sheetCsv(rows)).deals);
  assert.equal(deals.length, 1);
  assert.equal(deals[0].deduplicationMatches[0].reason, 'near-title-location-financials');
});

test('cluster expansion requires a direct canonical match and does not merge weak transitive links', () => {
  const common = Array.from({ length: 60 }, (_, index) => `common${index}`).join(' ');
  const leftOnly = Array.from({ length: 6 }, (_, index) => `left${index}`).join(' ');
  const rightOnly = Array.from({ length: 6 }, (_, index) => `right${index}`).join(' ');
  const rows = syndicatedRows()[0];
  const parsed = parseSheetCsvDeals(sheetCsv([
    { ...rows, 'Listing URL': 'https://market-a.example/a', 'Broker Name': '', 'Broker Email': '', Description: `${common} ${leftOnly}` },
    { ...rows, 'Listing URL': 'https://market-b.example/b', 'Broker Name': '', 'Broker Email': '', Description: common },
    { ...rows, 'Listing URL': 'https://market-c.example/c', 'Broker Name': '', 'Broker Email': '', Description: `${common} ${rightOnly}` },
  ]));

  assert.equal(dedupeDeals(parsed.deals).length, 2);
});

test('persisted aliases preserve canonical history and block duplicate CIM outreach when only another syndication remains', async () => {
  let lookupKeys = [];
  let persisted = [];
  const canonicalUrl = 'https://www.bizbuysell.com/Business-Opportunity/hvac-electrical/2401626/';
  const syndicatedUrl = 'https://dealstream.com/d/biz-sale/09w2qq';
  const canonicalKey = `url:${canonicalUrl.toLowerCase()}`;
  const syndicatedKey = `url:${syndicatedUrl.toLowerCase()}`;
  const storage = reviewStorage({
    async listDealHunterSeenDeals() {
      return [
        {
          id: syndicatedKey,
          first_seen_at: '2026-08-10T19:50:58.000Z',
          last_seen_at: '2026-08-10T19:50:58.000Z',
          source_id: 'sheet-0',
          external_id: '275',
          listing_url: syndicatedUrl,
          name: 'HVAC & Electrical Contractor with Real Estate',
          location: 'MO',
          annual_profit: 800000,
          annual_revenue: 5643224,
          asking_price: 6500000,
          metadata: {},
        },
        {
          id: canonicalKey,
          first_seen_at: '2026-06-13T10:57:40.000Z',
          last_seen_at: '2026-08-10T19:50:58.000Z',
          source_id: 'sheet-0',
          external_id: '257',
          listing_url: canonicalUrl,
          name: 'HVAC & Electrical Contractor with Real Estate',
          location: 'MO',
          annual_profit: 800000,
          annual_revenue: 5643224,
          asking_price: 6500000,
          metadata: {
            listingAliases: [canonicalUrl, syndicatedUrl],
            dealKeyAliases: [syndicatedKey],
          },
        },
      ];
    },
    async listDealHunterCimRequests({ dealKeys } = {}) {
      if (!dealKeys) return [];
      lookupKeys.push(...dealKeys);
      return dealKeys.includes(syndicatedKey) ? [{
        id: 'existing-cim-request',
        deal_key: syndicatedKey,
        recipient_email: 'kelvin.woods@cbiteam.com',
        status: 'sent',
        updated_at: '2026-08-11T12:00:00.000Z',
      }] : [];
    },
    async upsertDealHunterSeenDeals(records) { persisted = records; },
  });

  // Keep a confirmed source contact on the remaining syndication so the test
  // can also prove an earlier request blocks another first contact.
  activeCsv = sheetCsv([{
    ...syndicatedRows()[1],
    'Broker Name': 'Kelvin Woods',
    'Broker Email': 'kelvin.woods@cbiteam.com',
  }]);
  const review = await reviewDailyDeals({ markSeen: true, storage });
  const [deal] = allReviewDeals(review);

  assert.equal(deal.dealKey, canonicalKey);
  assert.equal(deal.firstSeenAt, '2026-06-13T10:57:40.000Z');
  assert.equal(deal.dealKeyAliases.includes(syndicatedKey), true);
  assert.equal(lookupKeys.includes(canonicalKey), true);
  assert.equal(lookupKeys.includes(syndicatedKey), true);
  assert.equal(deal.cimRequest.id, 'existing-cim-request');
  assert.equal(deal.cimRequest.canRequest, false);
  assert.deepEqual(new Set(persisted[0].metadata.listingAliases), new Set([canonicalUrl, syndicatedUrl]));
  assert.equal(persisted[0].metadata.dealKeyAliases.includes(syndicatedKey), true);
  assert.deepEqual(fetchCalls, ['https://example.test/deduplication.csv']);
});

test('inconsistent legacy row-position history cannot poison a different Sheet listing', async () => {
  activeCsv = sheetCsv([{
    'Business Name': 'HVAC & Electrical Contractor with Real Estate',
    State: 'MO',
    'Date Added': today,
    'Annual Profit': '$450,000',
    'Annual Revenue': '$2,000,000',
    Description: longDescription,
  }]);
  const storage = reviewStorage({
    async listDealHunterSeenDeals() {
      return [{
        id: 'fingerprint:fedex-route-business|ohio|transportation|1000000|250000',
        first_seen_at: '2025-01-01T00:00:00.000Z',
        source_id: 'sheet-0',
        external_id: '1',
        listing_url: '',
        name: 'HVAC & Electrical Contractor with Real Estate',
        industry: 'HVAC',
        location: 'MO',
        annual_profit: 450000,
        annual_revenue: 2000000,
      }];
    },
  });

  const review = await reviewDailyDeals({ storage });
  const [deal] = allReviewDeals(review);
  assert.equal(deal.isNew, true);
  assert.notEqual(deal.dealKey, 'fingerprint:fedex-route-business|ohio|transportation|1000000|250000');
});

test('CRM alias lookup prefers the active canonical card over an archived syndicated duplicate', async () => {
  const canonicalUrl = 'https://www.bizbuysell.com/Business-Opportunity/hvac-electrical/2401626/';
  const syndicatedUrl = 'https://dealstream.com/d/biz-sale/09w2qq';
  const canonicalKey = `url:${canonicalUrl.toLowerCase()}`;
  const archivedDuplicate = {
    id: 'archived-dealstream-card',
    status: 'archived',
    listing_url: syndicatedUrl,
    updated_at: '2026-08-12T12:00:00.000Z',
    metadata: { dealHunter: { dealKey: `url:${syndicatedUrl}` } },
  };
  const activeCanonical = {
    id: 'active-bizbuysell-card',
    status: 'review',
    listing_url: canonicalUrl,
    broker_email: 'kelvin.woods@cbiteam.com',
    updated_at: '2026-08-11T12:00:00.000Z',
    metadata: { dealHunter: { dealKey: canonicalKey, listingAliases: [canonicalUrl, syndicatedUrl] } },
  };
  const storage = {
    async getSubmissionByListingUrl(listingUrl) {
      return listingUrl === syndicatedUrl ? archivedDuplicate : activeCanonical;
    },
    async listSubmissions() { return { rows: [] }; },
  };

  const existing = await findExistingDealHunterSubmission(storage, {
    dealKey: canonicalKey,
    dealKeyAliases: [`url:${syndicatedUrl}`],
    listingUrl: syndicatedUrl,
    listingAliases: [syndicatedUrl, canonicalUrl],
  });

  assert.equal(existing.id, 'active-bizbuysell-card');
});

test('CRM lookup reuses a Daily Deal Update card for a corroborated Deal OS syndication', async () => {
  const searches = [];
  const dailyDealRecord = {
    id: 'daily-deal-update-card',
    status: 'review',
    company: 'Nassau County HVAC Company',
    listing_url: 'https://www.bizbuysell.com/business-opportunity/nassau-county-hvac-company/2534394/',
    asking_price: '$950,000',
    ttm_revenue: '$1,141,941',
    ttm_ebitda: '$427,747',
    updated_at: '2026-08-13T12:00:00.000Z',
    metadata: {
      dealHunter: {
        sourceId: 'sheet-0',
        sourceName: 'SMB Deal Hunter Google Sheet',
        sourceMode: 'csv',
        externalId: '42',
        raw: { State: 'NY' },
      },
    },
  };
  const storage = {
    async getSubmissionByListingUrl() { return null; },
    async listSubmissions({ search }) {
      searches.push(search);
      return { rows: search === dailyDealRecord.company ? [dailyDealRecord] : [] };
    },
  };

  const existing = await findExistingDealHunterSubmission(storage, {
    id: '',
    stableExternalId: false,
    sourceId: 'deal-os-export',
    sourceName: 'SMB Deal OS export',
    sourceMode: 'manual-export',
    dealKey: 'url:https://www.dealstream.com/d/biz-sale/hvac/tomhyp',
    name: 'Nassau County HVAC Company',
    state: 'NY',
    location: 'NY',
    annualProfit: 427747,
    annualRevenue: 1141941,
    askingPrice: 950000,
    description: '',
    listingUrl: 'https://www.dealstream.com/d/biz-sale/hvac/tomhyp',
  });

  assert.equal(existing.id, dailyDealRecord.id);
  assert.equal(searches.includes(dailyDealRecord.company), true);
});

test('CRM lookup does not reuse a same-name listing when geography conflicts', async () => {
  const dailyDealRecord = {
    id: 'different-market-card',
    status: 'review',
    company: 'Nassau County HVAC Company',
    listing_url: 'https://www.bizbuysell.com/business-opportunity/nassau-county-hvac-company/2534394/',
    asking_price: '$950,000',
    ttm_revenue: '$1,141,941',
    ttm_ebitda: '$427,747',
    metadata: {
      dealHunter: {
        sourceId: 'sheet-0',
        sourceName: 'SMB Deal Hunter Google Sheet',
        sourceMode: 'csv',
        externalId: '42',
        raw: { State: 'NJ' },
      },
    },
  };
  const storage = {
    async getSubmissionByListingUrl() { return null; },
    async listSubmissions({ search }) {
      return { rows: search === dailyDealRecord.company ? [dailyDealRecord] : [] };
    },
  };

  const existing = await findExistingDealHunterSubmission(storage, {
    sourceId: 'deal-os-export',
    sourceName: 'SMB Deal OS export',
    sourceMode: 'manual-export',
    dealKey: 'url:https://www.dealstream.com/d/biz-sale/hvac/tomhyp',
    name: dailyDealRecord.company,
    state: 'NY',
    location: 'NY',
    annualProfit: 427747,
    annualRevenue: 1141941,
    askingPrice: 950000,
    description: '',
    listingUrl: 'https://www.dealstream.com/d/biz-sale/hvac/tomhyp',
  });

  assert.equal(existing, null);
});
