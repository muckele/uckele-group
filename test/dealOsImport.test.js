import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
process.env.DEAL_HUNTER_DEAL_OS_EXPORT_MAX_AGE_HOURS = '72';
process.env.DEAL_HUNTER_DEAL_OS_EXPORT_MAX_RECORDS = '1000';
process.env.DEAL_HUNTER_DEAL_OS_EXPORT_MAX_PAYLOAD_BYTES = String(8 * 1024 * 1024);

const {
  dealHunterCrmSyncConfirmation,
  importDealOsExport,
  parseDealOsXlsxRows,
  parseSheetCsvDeals,
  repairDealHunterCrmSourceFields,
  reviewDailyDeals,
  syncDealHunterHighFitsToCrm,
} = await import('../server/services/dealHunter.js');
const { createSqliteStorage } = await import('../server/storage/sqlite.js');

function memoryStorage(initial = null) {
  let latest = initial;
  const imports = initial ? [initial] : [];

  return {
    async insertDealHunterDealOsImport(record) {
      latest = record;
      imports.unshift(record);
      return record;
    },
    async getLatestDealHunterDealOsImport() {
      return latest;
    },
    async listDealHunterDealOsImports() {
      return imports;
    },
  };
}

function freshTimestamp(offsetHours = 0) {
  return new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString();
}

function validCsv() {
  return [
    'Listing ID,Business Name,View Listing URL,Source,Date Added,Last Updated,Industry,Description,SDE,Revenue,Asking Price,Broker Name,Broker Email,Unretained Internal Column',
    'DOS-100,Commercial HVAC Services,https://broker.example/hvac,DealStream,2026-08-09,2026-08-10,HVAC,Recurring commercial maintenance,$450000,$2200000,$1800000,Jamie Broker,jamie@broker.example,do not retain',
    'DOS-100,Commercial HVAC Services,https://broker.example/hvac,DealStream,2026-08-09,2026-08-10,HVAC,Recurring commercial maintenance,$450000,$2200000,$1800000,Jamie Broker,backup@broker.example,do not retain',
    ',Industrial Inspection,https://broker.example/inspection,BizBuySell,2026-08-10,2026-08-10,Inspection,Compliance inspection contracts,$375000,$1600000,$1400000,Alex Broker,alex@broker.example,do not retain',
  ].join('\n');
}

function currentMarketplaceCsv() {
  return [
    'Listing,City,State,Asking Price,Revenue,Earnings,Margin %,Multiple,Years in Business,Remote,Franchise,Listing URL,Date Added,Notes',
    'Southern California Sign Company with 40+ Years of Operating History,,CA,"$1,450,000","$1,170,330","$365,112",31.2%,4.0x,41,No,No,https://www.bizbuysell.com/business-opportunity/southern-california-sign-company-with-40-years-of-operating-history/2540383/,8/13/2026,Recurring commercial customer relationships',
  ].join('\n');
}

function dealOsWorkbook() {
  const worksheet = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Listing ID</t></is></c><c r="B1" t="inlineStr"><is><t>Business Name</t></is></c><c r="C1" t="inlineStr"><is><t>View Listing URL</t></is></c><c r="D1" t="inlineStr"><is><t>Date Added</t></is></c><c r="E1" t="inlineStr"><is><t>SDE</t></is></c><c r="F1" t="inlineStr"><is><t>Broker Email</t></is></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>DOS-XLSX-1</t></is></c><c r="B2" t="inlineStr"><is><t>Fire Safety Inspection</t></is></c><c r="C2" t="inlineStr"><is><t>View Listing</t></is></c><c r="D2"><v>46244</v></c><c r="E2"><v>425000</v></c><c r="F2" t="inlineStr"><is><t>broker@example.com</t></is></c></row>',
    '</sheetData>',
    '<hyperlinks><hyperlink ref="C2" r:id="rId1"/></hyperlinks>',
    '</worksheet>',
  ].join('');
  const relationships = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://broker.example/fire-safety" TargetMode="External"/>',
    '</Relationships>',
  ].join('');

  return Buffer.from(zipSync({
    'xl/worksheets/sheet1.xml': strToU8(worksheet),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(relationships),
  }));
}

test('CSV import preserves durable identities, normalizes deal fields, deduplicates rows, and discards arbitrary columns', async () => {
  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: Buffer.from(validCsv()),
    fileName: 'deal-os-saved-search.csv',
    mimeType: 'text/csv',
    exportedAt: freshTimestamp(-1),
    scope: 'saved-search',
    coverageLabel: 'All active acquisition criteria',
    expectedRowCount: 3,
    importedBy: 'mathew@example.com',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.import.rowCount, 2);
  assert.equal(result.import.duplicateCount, 1);
  assert.equal(result.import.stableIdCount, 1);
  assert.equal(result.import.listingUrlCount, 2);
  const stored = await storage.getLatestDealHunterDealOsImport();
  assert.equal(stored.records[0].stableId, 'DOS-100');
  assert.equal(stored.records[0].annualProfit, 450000);
  assert.equal(stored.records[0].listingSource, 'DealStream');
  assert.deepEqual(stored.records[0].brokerContacts.map((contact) => contact.email), [
    'backup@broker.example',
    'jamie@broker.example',
  ]);
  assert.doesNotMatch(JSON.stringify(stored.records), /Unretained Internal Column|do not retain/);

  const review = await reviewDailyDeals({ storage });
  const source = review.sources.find((item) => item.id === 'deal-os-export');
  assert.equal(source.fetched, true);
  assert.equal(source.rowCount, 2);
  assert.equal(source.coverageLabel, 'All active acquisition criteria');
  assert.equal(review.disabledSources[0].id, 'airtable-disabled');
  assert.match(review.coverageWarnings[0], /Legacy Airtable is disabled/);
  const deals = [...review.qualified, ...review.watchlist, ...review.removalCandidates];
  const stableDeal = deals.find((deal) => deal.id === 'DOS-100');
  assert.equal(stableDeal.dealKey, 'source:deal-os-export:DOS-100');
  assert.equal(stableDeal.listingSource, 'DealStream');
});

test('ID-based exports can use bare Listing as the business name without a URL', async () => {
  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: Buffer.from('Listing ID,Listing,Earnings\nDOS-NAME-1,HVAC,$425000'),
    fileName: 'deal-os-id-and-name.csv',
    mimeType: 'text/csv',
    exportedAt: freshTimestamp(-1),
    scope: 'saved-search',
    coverageLabel: 'Stable-ID export without listing URLs',
    expectedRowCount: 1,
    importedBy: 'mathew@example.com',
    storage,
  });

  assert.equal(result.ok, true);
  const stored = await storage.getLatestDealHunterDealOsImport();
  assert.equal(stored.records[0].stableId, 'DOS-NAME-1');
  assert.equal(stored.records[0].name, 'HVAC');
  assert.equal(stored.records[0].listingUrl, '');
  assert.equal(stored.records[0].annualProfit, 425000);
});

test('exports with an explicit name can still use bare Listing as the URL', async () => {
  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: Buffer.from('Business Name,Listing,Earnings\nCommercial Roofing Company,https://broker.example/roofing,$425000'),
    fileName: 'deal-os-name-and-listing-url.csv',
    mimeType: 'text/csv',
    exportedAt: freshTimestamp(-1),
    scope: 'saved-search',
    coverageLabel: 'Legacy listing URL column',
    expectedRowCount: 1,
    importedBy: 'mathew@example.com',
    storage,
  });

  assert.equal(result.ok, true);
  const stored = await storage.getLatestDealHunterDealOsImport();
  assert.equal(stored.records[0].name, 'Commercial Roofing Company');
  assert.equal(stored.records[0].listingUrl, 'https://broker.example/roofing');
  assert.equal(stored.records[0].annualProfit, 425000);
});

test('current SMB Deal OS marketplace export maps Listing, Earnings, and Margin into normalized review fields', async () => {
  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: Buffer.from(currentMarketplaceCsv()),
    fileName: 'marketplace-export-2026-08-14.csv',
    mimeType: 'text/csv',
    exportedAt: freshTimestamp(-1),
    scope: 'deal-radar',
    coverageLabel: 'CA, NY, NJ, AZ, NV, CT Deal Radar filters',
    expectedRowCount: 1,
    importedBy: 'mathew@example.com',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.import.rowCount, 1);
  assert.equal(result.import.fieldCoverage.totalRecords, 1);
  assert.equal(result.import.fieldCoverage.fields.find((field) => field.key === 'listingUrl').percent, 100);
  assert.equal(result.import.fieldCoverage.fields.find((field) => field.key === 'industry').percent, 0);
  assert.equal(result.import.fieldCoverage.fields.find((field) => field.key === 'description').percent, 100);
  assert.equal(result.import.fieldCoverage.fields.find((field) => field.key === 'brokerEmail').percent, 0);
  const stored = await storage.getLatestDealHunterDealOsImport();
  assert.equal(stored.records[0].name, 'Southern California Sign Company with 40+ Years of Operating History');
  assert.equal(stored.records[0].annualProfit, 365112);
  assert.equal(stored.records[0].annualRevenue, 1170330);
  assert.equal(stored.records[0].askingPrice, 1450000);
  assert.equal(stored.records[0].profitMultiple, 4);
  assert.equal(stored.records[0].netMargin, 31.2);
  assert.equal(stored.records[0].yearsEstablished, 41);
  assert.equal(stored.records[0].state, 'CA');
  assert.equal(stored.records[0].listingUrl, 'https://www.bizbuysell.com/business-opportunity/southern-california-sign-company-with-40-years-of-operating-history/2540383/');

  const review = await reviewDailyDeals({ storage });
  const deals = [...review.qualified, ...review.watchlist, ...review.removalCandidates];
  assert.equal(deals[0].name, stored.records[0].name);
  assert.equal(deals[0].annualProfit, 365112);
  assert.equal(deals[0].netMargin, 31.2);
});

test('full-backfill review scores every canonical listing while daily review preserves the lookback', async () => {
  const now = new Date();
  const storage = memoryStorage({
    id: 'backfill-import',
    created_at: now.toISOString(),
    imported_by: 'admin@example.com',
    exported_at: now.toISOString(),
    file_name: 'backfill.csv',
    file_type: 'text/csv',
    file_size: 100,
    scope: 'saved-search',
    coverage_label: 'Backfill mode regression fixture',
    expected_row_count: 2,
    row_count: 2,
    duplicate_count: 0,
    stable_id_count: 2,
    listing_url_count: 2,
    coverage_limit_reached: false,
    metadata: {},
    records: [
      {
        stableId: 'RECENT-1',
        name: 'Recent Commercial HVAC Maintenance',
        industry: 'HVAC maintenance',
        description: 'Recurring commercial maintenance contracts and field technicians',
        state: 'CA',
        annualProfit: 425000,
        annualRevenue: 1800000,
        askingPrice: 1400000,
        listingUrl: 'https://broker.example/recent',
        dateAdded: now.toISOString(),
      },
      {
        stableId: 'OLD-1',
        name: 'Older Commercial Plumbing Maintenance',
        industry: 'Plumbing maintenance',
        description: 'Recurring commercial service agreements and field repair',
        state: 'NY',
        annualProfit: 400000,
        annualRevenue: 1600000,
        askingPrice: 1300000,
        listingUrl: 'https://broker.example/older',
        dateAdded: '2024-01-01T00:00:00.000Z',
      },
    ],
  });

  const daily = await reviewDailyDeals({ storage });
  const backfill = await reviewDailyDeals({ reviewMode: 'full-backfill', storage });

  assert.equal(daily.reviewMode, 'daily');
  assert.equal(daily.totals.reviewedDeals, 1);
  assert.equal(backfill.reviewMode, 'full-backfill');
  assert.equal(backfill.selection.strategy, 'all-canonical-listings');
  assert.equal(backfill.totals.reviewedDeals, 2);
  assert.equal(backfill.importSummary.scoredListings, 2);
});

test('explicit CRM sync rejects missing confirmation before reading sources or writing records', async () => {
  const storage = new Proxy({}, {
    get() {
      throw new Error('storage must not be touched before confirmation');
    },
  });
  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'sync',
    requestedBy: 'admin@example.com',
    storage,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, new RegExp(dealHunterCrmSyncConfirmation));
});

test('current SMB Deal OS financial fields update the matched CRM record', async () => {
  const [deal] = parseSheetCsvDeals(currentMarketplaceCsv()).deals;
  const existing = {
    id: 'crm-marketplace-listing',
    created_at: '2026-08-13T12:00:00.000Z',
    updated_at: '2026-08-13T12:00:00.000Z',
    source: 'deal-hunter-daily-review',
    status: 'review',
    company: deal.name,
    listing_url: deal.listingUrl,
    priority: 'high',
    tags: ['deal-hunter'],
    notes: '',
    metadata: {
      dealHunter: {
        managed: true,
        dealKey: `url:${deal.listingUrl.toLowerCase()}`,
        listingAliases: [deal.listingUrl],
      },
    },
  };
  let updatedValues = null;
  const storage = {
    async getSubmission(id) {
      return id === existing.id ? existing : null;
    },
    async mutateWithCrmActivity({ operation, payload }) {
      assert.equal(operation, 'update_submission');
      updatedValues = payload.values;
      return { applied: true, record: { ...existing, ...payload.values } };
    },
  };

  const result = await repairDealHunterCrmSourceFields({
    submissionId: existing.id,
    apply: true,
    actor: 'mathew@example.com',
    backupVerified: true,
    backupReference: 'test-only-backup',
    storage,
    sourceResults: [{ source: { id: 'deal-os-export', fetched: true }, deals: [deal] }],
  });

  assert.equal(result.ok, true);
  assert.equal(updatedValues.asking_price, '$1,450,000');
  assert.equal(updatedValues.ttm_revenue, '$1,170,330');
  assert.equal(updatedValues.ttm_ebitda, '$365,112');
  assert.equal(updatedValues.ebitda_multiple, '4x');
  assert.equal(updatedValues.net_margin, '31.2%');
  assert.equal(updatedValues.business_age, '41 years');
});

test('punctuation-distinct Deal OS IDs remain separate durable identities', async () => {
  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: Buffer.from([
      'Listing ID,Business Name',
      'A-1,Commercial Plumbing',
      'A 1,Industrial Plumbing',
    ].join('\n')),
    fileName: 'deal-os-distinct-ids.csv',
    exportedAt: freshTimestamp(-1),
    scope: 'saved-search',
    coverageLabel: 'Distinct stable IDs',
    expectedRowCount: 2,
    importedBy: 'admin',
    storage,
  });

  assert.equal(result.ok, true);
  assert.equal(result.import.rowCount, 2);
  const review = await reviewDailyDeals({ storage });
  const deals = [...review.qualified, ...review.watchlist, ...review.removalCandidates];
  assert.deepEqual(
    deals.map((deal) => deal.dealKey).sort(),
    ['source:deal-os-export:A%201', 'source:deal-os-export:A-1'],
  );
});

test('Deal OS stable IDs retain an established URL deal key so existing outreach history stays connected', async () => {
  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: Buffer.from(validCsv()),
    fileName: 'deal-os-continuity.csv',
    exportedAt: freshTimestamp(-1),
    scope: 'saved-search',
    coverageLabel: 'Existing listing continuity',
    expectedRowCount: 3,
    importedBy: 'admin',
    storage,
  });
  assert.equal(result.ok, true);
  storage.listDealHunterSeenDeals = async () => [{
    id: 'url:https://broker.example/hvac',
    first_seen_at: '2026-08-01T12:00:00.000Z',
    last_seen_at: '2026-08-09T12:00:00.000Z',
    source_id: 'sheet-0',
    source_name: 'SMB Deal Hunter Google Sheet',
    source_mode: 'csv',
    external_id: '42',
    listing_url: 'https://broker.example/hvac',
  }];

  const review = await reviewDailyDeals({ storage });
  const deals = [...review.qualified, ...review.watchlist, ...review.removalCandidates];
  const stableDeal = deals.find((deal) => deal.id === 'DOS-100');

  assert.equal(stableDeal.id, 'DOS-100');
  assert.equal(stableDeal.dealKey, 'url:https://broker.example/hvac');
  assert.equal(stableDeal.firstSeenAt, '2026-08-01T12:00:00.000Z');
});

test('XLSX import reads first-class cell values, external listing hyperlinks, and Excel date serials', async () => {
  const workbook = dealOsWorkbook();
  const parsed = parseDealOsXlsxRows(workbook);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]['View Listing URL'], 'https://broker.example/fire-safety');

  const storage = memoryStorage();
  const result = await importDealOsExport({
    fileBuffer: workbook,
    fileName: 'deal-radar.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    exportedAt: freshTimestamp(-1),
    scope: 'deal-radar',
    coverageLabel: 'NY and NJ field-service filters',
    expectedRowCount: 1,
    importedBy: 'admin',
    storage,
  });

  assert.equal(result.ok, true);
  const stored = await storage.getLatestDealHunterDealOsImport();
  assert.equal(stored.records[0].listingUrl, 'https://broker.example/fire-safety');
  assert.equal(stored.records[0].dateAdded, '2026-08-10T00:00:00.000Z');
  assert.equal(stored.records[0].brokerEmail, 'broker@example.com');
});

test('import rejects stale, incompatible, count-mismatched, and identity-free exports without persistence', async () => {
  const cases = [
    {
      name: 'stale',
      csv: validCsv(),
      exportedAt: freshTimestamp(-73),
      expectedRowCount: 3,
      pattern: /older than the 72-hour freshness limit/i,
    },
    {
      name: 'incompatible',
      csv: 'Company,Notes\nAlpha,No durable identity',
      exportedAt: freshTimestamp(-1),
      expectedRowCount: 1,
      pattern: /schema is incompatible/i,
    },
    {
      name: 'count mismatch',
      csv: validCsv(),
      exportedAt: freshTimestamp(-1),
      expectedRowCount: 2,
      pattern: /showed 2 expected listings.*contains 3 rows/i,
    },
    {
      name: 'unsafe URL',
      csv: 'Business Name,View Listing URL\nAlpha,javascript:alert(1)',
      exportedAt: freshTimestamp(-1),
      expectedRowCount: 1,
      pattern: /invalid row/i,
    },
  ];

  for (const scenario of cases) {
    const storage = memoryStorage();
    const result = await importDealOsExport({
      fileBuffer: Buffer.from(scenario.csv),
      fileName: `${scenario.name}.csv`,
      exportedAt: scenario.exportedAt,
      scope: 'saved-search',
      coverageLabel: 'Test coverage',
      expectedRowCount: scenario.expectedRowCount,
      importedBy: 'admin',
      storage,
    });
    assert.equal(result.ok, false, scenario.name);
    assert.match(result.error, scenario.pattern, scenario.name);
    assert.equal(await storage.getLatestDealHunterDealOsImport(), null, scenario.name);
  }
});

test('an accepted Deal OS import becomes an unavailable source after its freshness window', async () => {
  const staleImport = {
    id: '00000000-0000-4000-8000-000000000001',
    created_at: freshTimestamp(-80),
    imported_by: 'admin',
    exported_at: freshTimestamp(-80),
    file_name: 'stale.csv',
    file_type: 'text/csv',
    file_size: 100,
    file_sha256: 'a'.repeat(64),
    scope: 'saved-search',
    coverage_label: 'Stale saved search',
    expected_row_count: 1,
    row_count: 1,
    duplicate_count: 0,
    stable_id_count: 1,
    listing_url_count: 1,
    coverage_limit_reached: false,
    records: [{ stableId: 'STALE-1', name: 'Stale HVAC', listingUrl: 'https://broker.example/stale', brokerContacts: [] }],
    metadata: {},
  };
  const review = await reviewDailyDeals({ storage: memoryStorage(staleImport) });
  const source = review.sources.find((item) => item.id === 'deal-os-export');

  assert.equal(source.fetched, false);
  assert.match(source.error, /exceeds the 72-hour freshness limit/i);
  assert.equal(review.totals.reviewedDeals, 0);
});

test('SQLite persists normalized Deal OS import provenance and records without the uploaded file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-deal-os-import-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'deal-os.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const result = await importDealOsExport({
    fileBuffer: Buffer.from(validCsv()),
    fileName: 'deal-os.csv',
    exportedAt: freshTimestamp(-1),
    scope: 'saved-search',
    coverageLabel: 'Persisted source',
    expectedRowCount: 3,
    importedBy: 'admin@example.com',
    storage,
  });

  assert.equal(result.ok, true);
  const latest = await storage.getLatestDealHunterDealOsImport();
  assert.equal(latest.imported_by, 'admin@example.com');
  assert.equal(latest.records.length, 2);
  assert.equal(latest.metadata.parserVersion, 'deal-os-export-v1');
  assert.equal((await storage.listDealHunterDealOsImports({ limit: 10 })).length, 1);
});
