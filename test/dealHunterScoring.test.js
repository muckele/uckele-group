import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import {
  buildGoogleSheetWorkbookUrl,
  eventMatchesCimRequest,
  extractGoogleSheetListingUrls,
  parseSheetCsvDeals,
  scoreDeal,
} from '../server/services/dealHunter.js';
import { normalizeResendTagToken } from '../server/services/delivery.js';

function baseDeal(overrides = {}) {
  const fullText = [
    overrides.name,
    overrides.industry,
    overrides.description,
    overrides.state,
    overrides.remoteFlag,
  ].filter(Boolean).join(' ');

  return {
    id: 'deal-1',
    name: 'Commercial HVAC Maintenance Co',
    industry: 'Commercial HVAC maintenance',
    description: '',
    annualProfit: 450000,
    annualRevenue: 1800000,
    askingPrice: 1400000,
    profitMultiple: null,
    yearsEstablished: 12,
    remoteFlag: '',
    franchiseFlag: '',
    state: 'CA',
    fullText,
    ...overrides,
  };
}

test('scoring qualifies durable recurring field-service deals as high fit', () => {
  const deal = baseDeal({
    description:
      'Commercial HVAC recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.shouldRemove, false);
  assert.ok(scored.score >= 75, `expected high-fit score, got ${scored.score}`);
  assert.equal(scored.concerns.some((concern) => /No explicit recurring/i.test(concern)), false);
});

test('scoring hard-removes excluded categories even with recurring revenue language', () => {
  const deal = baseDeal({
    name: 'Medical Practice With Recurring Patients',
    industry: 'Physician practice',
    description:
      'Recurring revenue, repeat patients, strong EBITDA, maintenance contracts, management in place, SBA eligible, but buyer must be a physician.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.shouldRemove, true);
  assert.ok(scored.score <= 34, `expected excluded score cap, got ${scored.score}`);
  assert.equal(scored.removeReasons.some((reason) => /Excluded category match/i.test(reason)), true);
});

test('scoring caps owner-dependent project work below high fit', () => {
  const deal = baseDeal({
    name: 'General Business Services Co',
    industry: 'Business services',
    description:
      'Project-based work with strong annual profit. Owner operator handles sales and production. One customer accounts for a large portion of revenue.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.shouldRemove, false);
  assert.ok(scored.score < 75, `expected capped watchlist score, got ${scored.score}`);
  assert.equal(scored.concerns.some((concern) => /Owner-dependency risk/i.test(concern)), true);
  assert.equal(scored.concerns.some((concern) => /Customer concentration risk/i.test(concern)), true);
});

test('scoring does not treat non-recurring language as recurring revenue strength', () => {
  const deal = baseDeal({
    name: 'Commercial Project Services Co',
    industry: 'Commercial facility services',
    description:
      'Commercial facility repair and maintenance services with non-recurring project-based revenue, field technicians, compliance work, and trained staff.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.strengths.some((strength) => /Recurring or repeat revenue signals/i.test(strength)), false);
  assert.equal(scored.concerns.some((concern) => /Financial quality risk language found/i.test(concern)), true);
});

test('CIM response matching ignores unrelated replies from the same broker', () => {
  const request = {
    id: 'cim-request-1',
    deal_key: 'commercial-hvac-maintenance-co',
    deal_name: 'Commercial HVAC Maintenance Co',
    recipient_email: 'broker@example.com',
    provider_message_id: 'request-message-1',
    created_at: '2026-06-16T16:00:00.000Z',
    metadata: {
      providerMessageIds: ['request-message-1'],
    },
  };
  const unrelatedReply = {
    event_type: 'replied',
    recipient_email: 'broker@example.com',
    from_email: 'broker@example.com',
    subject: 'Re: different opportunity',
    created_at: '2026-06-16T17:00:00.000Z',
  };
  const trackedReply = {
    ...unrelatedReply,
    subject: 'Re: CIM / NDA request for Commercial HVAC Maintenance Co',
  };

  assert.equal(eventMatchesCimRequest(unrelatedReply, request), false);
  assert.equal(eventMatchesCimRequest(trackedReply, request), true);
});

test('CIM response matching rejects generic and pre-request replies from the same broker', () => {
  const request = {
    id: 'cim-request-2',
    deal_key: 'fire-safety-inspection-co',
    deal_name: 'Fire Safety Inspection Co',
    recipient_email: 'broker@example.com',
    created_at: '2026-06-16T16:00:00.000Z',
  };
  const genericReply = {
    event_type: 'received',
    recipient_email: 'broker@example.com',
    subject: 'Re: CIM / NDA request',
    created_at: '2026-06-16T17:00:00.000Z',
  };
  const oldExactReply = {
    ...genericReply,
    subject: 'Re: CIM / NDA request for Fire Safety Inspection Co',
    created_at: '2026-06-15T17:00:00.000Z',
  };

  assert.equal(eventMatchesCimRequest(genericReply, request), false);
  assert.equal(eventMatchesCimRequest(oldExactReply, request), false);
});

test('CIM response matching uses the request-specific inbound address even when the broker changes the subject', () => {
  const firstRequest = {
    id: 'cim-request-first',
    deal_key: 'commercial-hvac-maintenance-co',
    deal_name: 'Commercial HVAC Maintenance Co',
    recipient_email: 'broker@example.com',
    created_at: '2026-06-16T16:00:00.000Z',
    metadata: {
      replyToAddress: 'cim-request-first@inbound.example.com',
    },
  };
  const secondRequest = {
    ...firstRequest,
    id: 'cim-request-second',
    deal_key: 'commercial-plumbing-service',
    deal_name: 'Commercial Plumbing Service',
    metadata: {
      replyToAddress: 'cim-request-second@inbound.example.com',
    },
  };
  const reply = {
    event_type: 'received',
    recipient_email: 'broker@example.com',
    subject: 'Requested materials attached',
    created_at: '2026-06-16T17:00:00.000Z',
    metadata: {
      fromEmail: 'broker@example.com',
      toEmail: 'cim-request-first@inbound.example.com',
    },
  };

  assert.equal(eventMatchesCimRequest(reply, firstRequest), true);
  assert.equal(eventMatchesCimRequest(reply, secondRequest), false);
});

test('CIM event matching accepts Resend-normalized deal key tags', () => {
  const request = {
    id: 'cim-request-1',
    deal_key: 'SMB Deal Hunter Google Sheet | 20+ Year HVAC Company w/ strong earnings | erin@powerofpluck.com',
    deal_name: '20+ Year HVAC Company w/ strong earnings',
    recipient_email: 'broker@example.com',
    created_at: '2026-06-16T16:00:00.000Z',
  };
  const deliveryEvent = {
    event_type: 'delivered',
    recipient_email: 'broker@example.com',
    subject: 'CIM / NDA request for 20+ Year HVAC Company w/ strong earnings',
    metadata: {
      tags: [{ name: 'deal_key', value: normalizeResendTagToken(request.deal_key) }],
    },
  };

  assert.equal(eventMatchesCimRequest(deliveryEvent, request), true);
});

test('Google Sheet CSV parsing caps rows before normalizing source deals', () => {
  const csv = [
    'Business Name,Industry,Location,Profit,Asking Price',
    'Commercial HVAC Maintenance Co,Commercial HVAC maintenance,"San Diego, CA","$450,000","$1,400,000"',
    'Commercial Plumbing Service,Commercial plumbing,"Los Angeles, CA","$420,000","$1,350,000"',
    'Fire Safety Inspection Co,Life safety,"New York, NY","$390,000","$1,250,000"',
  ].join('\n');
  const result = parseSheetCsvDeals(csv, 0, 2);

  assert.equal(result.source.rowCount, 2);
  assert.equal(result.deals.length, 2);
  assert.equal(result.deals[0].name, 'Commercial HVAC Maintenance Co');
  assert.equal(result.deals[1].name, 'Commercial Plumbing Service');
});

test('Google Sheet workbook extraction maps View Listing hyperlinks onto CSV deals', () => {
  const sharedStrings = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<si><t>Name</t></si><si><t>View Listing</t></si>',
    '<si><t>Alpha HVAC</t></si><si><t>Beta Plumbing</t></si><si><t>Unsafe Listing</t></si>',
    '</sst>',
  ].join('');
  const worksheet = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>',
    '<row r="4"><c r="A4" t="inlineStr"><is><t>&#9999999999;</t></is></c></row>',
    '<row r="5"><c r="B5" t="s"><v>0</v></c><c r="V5" t="s"><v>1</v></c></row>',
    '<row r="6"><c r="B6" t="s"><v>2</v></c><c r="V6" t="str"><f>HYPERLINK(&quot;https://broker.example/alpha?source=sheet&amp;deal=1&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>',
    '<row r="8"><c r="B8" t="s"><v>3</v></c><c r="V8" t="s"><v>1</v></c></row>',
    '<row r="9"><c r="B9" t="s"><v>4</v></c><c r="V9" t="str"><f>HYPERLINK(&quot;javascript:alert(1)&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>',
    '</sheetData><hyperlinks><hyperlink ref="V8" r:id="rId1"/><hyperlink ref="V9" r:id="rId2"/></hyperlinks></worksheet>',
  ].join('');
  const relationships = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://broker.example/beta" TargetMode="External"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://broker.example/should-not-be-used" TargetMode="Internal"/>',
    '</Relationships>',
  ].join('');
  const workbook = zipSync({
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    'xl/worksheets/sheet1.xml': strToU8(worksheet),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(relationships),
  });
  const extracted = extractGoogleSheetListingUrls(workbook);

  assert.equal(extracted.headerRow, 5);
  assert.equal(extracted.listingColumn, 'V');
  assert.equal(extracted.listingUrlsByRow.get(0), 'https://broker.example/alpha?source=sheet&deal=1');
  assert.equal(extracted.listingUrlsByRow.get(1), 'https://broker.example/beta');
  assert.equal(extracted.listingUrlsByRow.has(2), false);

  const csv = [
    'Name,Listing,View Listing',
    'Alpha HVAC,Descriptive listing title,View Listing',
    'Beta Plumbing,Another listing title,View Listing',
    'Unsafe Listing,Unsafe listing title,View Listing',
  ].join('\n');
  const parsed = parseSheetCsvDeals(csv, 0, Infinity, extracted.listingUrlsByRow);

  assert.equal(parsed.deals[0].listingUrl, 'https://broker.example/alpha?source=sheet&deal=1');
  assert.equal(parsed.deals[1].listingUrl, 'https://broker.example/beta');
  assert.equal(parsed.deals[2].listingUrl, '');
});

test('Google Sheet workbook extraction selects the worksheet matching the CSV rows', () => {
  const worksheet = (name, listingUrl) => [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="B1" t="inlineStr"><is><t>Business Name</t></is></c><c r="V1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    `<row r="2"><c r="B2" t="inlineStr"><is><t>${name}</t></is></c><c r="V2" t="str"><f>HYPERLINK(&quot;${listingUrl}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c></row>`,
    '</sheetData></worksheet>',
  ].join('');
  const workbook = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(worksheet('Archived Deal', 'https://broker.example/archive')),
    'xl/worksheets/sheet2.xml': strToU8(worksheet('Current Deal', 'https://broker.example/current')),
  });
  const expectedRows = [{ 'Business Name': 'Current Deal', 'View Listing': 'View Listing' }];
  const extracted = extractGoogleSheetListingUrls(workbook, expectedRows);

  assert.equal(extracted.listingUrlsByRow.get(0), 'https://broker.example/current');
  assert.throws(
    () => extractGoogleSheetListingUrls(workbook),
    /none uniquely matches the configured CSV source/i,
  );
});

test('Google Sheet workbook extraction skips hidden duplicate rows instead of shifting their links', () => {
  const row = (number, description, listingUrl) => [
    `<row r="${number}">`,
    `<c r="B${number}" t="inlineStr"><is><t>Repeated Deal</t></is></c>`,
    `<c r="C${number}" t="inlineStr"><is><t>${description}</t></is></c>`,
    `<c r="V${number}" t="str"><f>HYPERLINK(&quot;${listingUrl}&quot;, &quot;View Listing&quot;)</f><v>View Listing</v></c>`,
    '</row>',
  ].join('');
  const worksheet = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    '<row r="1"><c r="B1" t="inlineStr"><is><t>Business Name</t></is></c><c r="C1" t="inlineStr"><is><t>Description</t></is></c><c r="V1" t="inlineStr"><is><t>View Listing</t></is></c></row>',
    row(2, 'Visible alpha location', 'https://broker.example/alpha'),
    row(3, 'Hidden workbook-only location', 'https://broker.example/hidden'),
    row(4, 'Visible beta location', 'https://broker.example/beta'),
    '</sheetData></worksheet>',
  ].join('');
  const workbook = zipSync({ 'xl/worksheets/sheet1.xml': strToU8(worksheet) });
  const expectedRows = [
    { 'Business Name': 'Repeated Deal', Description: 'Visible alpha location', 'Annual Profit': '$100,000' },
    { 'Business Name': 'Repeated Deal', Description: 'Visible beta location', 'Annual Profit': '$120,000' },
  ];
  const extracted = extractGoogleSheetListingUrls(workbook, expectedRows);

  assert.equal(extracted.listingUrlsByRow.get(0), 'https://broker.example/alpha');
  assert.equal(extracted.listingUrlsByRow.get(1), 'https://broker.example/beta');
  assert.equal([...extracted.listingUrlsByRow.values()].includes('https://broker.example/hidden'), false);
  assert.equal(extracted.unmatchedListingUrlCount, 1);
});

test('Google Sheet workbook URL derivation preserves the selected tab and rejects filtered queries', () => {
  assert.equal(
    buildGoogleSheetWorkbookUrl('https://docs.google.com/spreadsheets/d/sheet-id/gviz/tq?tqx=out:csv&gid=123'),
    'https://docs.google.com/spreadsheets/d/sheet-id/export?format=xlsx&gid=123',
  );
  assert.equal(buildGoogleSheetWorkbookUrl('https://docs.google.com/spreadsheets/d/sheet-id/gviz/tq?tq=select+A&gid=123'), '');
  assert.equal(buildGoogleSheetWorkbookUrl('https://docs.google.com/spreadsheets/d/sheet-id/gviz/tq?headers=2&gid=123'), '');
  assert.equal(buildGoogleSheetWorkbookUrl('https://example.com/deals.csv'), '');
});

test('Google Sheet parsing preserves, ranks, and deduplicates multiple broker contacts', async () => {
  const { dedupeDeals } = await import('../server/services/dealHunter.js');
  const csv = [
    'Business Name,Listing URL,Broker Name,Broker Email,Contact Name 2,Contact Email 2,Receptionist Email',
    'Commercial HVAC Co,https://broker.example/hvac,Erin Gilliam,"erin@broker.example; office@broker.example",Alex Morgan,alex@broker.example,frontdesk@broker.example',
    'Commercial HVAC Co,https://broker.example/hvac,Jordan Lee,jordan@broker.example,,,,',
  ].join('\n');
  const parsed = parseSheetCsvDeals(csv);
  const contacts = parsed.deals[0].brokerContacts;

  assert.deepEqual(contacts.map((contact) => contact.email), [
    'erin@broker.example',
    'alex@broker.example',
    'frontdesk@broker.example',
    'office@broker.example',
  ]);
  assert.equal(contacts[0].name, 'Erin Gilliam');
  assert.equal(contacts[1].name, 'Alex Morgan');
  assert.equal(parsed.deals[0].brokerEmail, 'erin@broker.example');

  const [merged] = dedupeDeals(parsed.deals);
  assert.deepEqual(merged.brokerContacts.map((contact) => contact.email), [
    'erin@broker.example',
    'jordan@broker.example',
    'alex@broker.example',
    'frontdesk@broker.example',
    'office@broker.example',
  ]);
  assert.equal(merged.brokerEmail, 'erin@broker.example');
});

test('contact names stay bound to the matching role instead of leaking to the preferred email', () => {
  const csv = [
    'Business Name,Broker Email,Contact Name,Contact Email',
    'Commercial HVAC Co,erin@broker.example,Alex Contact,alex@broker.example',
  ].join('\n');
  const [deal] = parseSheetCsvDeals(csv).deals;

  assert.equal(deal.brokerEmail, 'erin@broker.example');
  assert.equal(deal.brokerName, '');
  assert.deepEqual(deal.brokerContacts.map(({ email, name }) => ({ email, name })), [
    { email: 'erin@broker.example', name: '' },
    { email: 'alex@broker.example', name: 'Alex Contact' },
  ]);
});

test('duplicate Google Sheet email headings preserve every address', () => {
  const csv = [
    'Business Name,Broker Email,Broker Email,Receptionist Email',
    'Commercial HVAC Co,erin@broker.example,jordan@broker.example,frontdesk@broker.example',
  ].join('\n');
  const [deal] = parseSheetCsvDeals(csv).deals;

  assert.deepEqual(new Set(deal.brokerContacts.map((contact) => contact.email)), new Set([
    'erin@broker.example',
    'jordan@broker.example',
    'frontdesk@broker.example',
  ]));
  assert.equal(deal.brokerContacts.find((contact) => contact.email === 'jordan@broker.example')?.sourceColumn, 'Broker Email 2');
});
