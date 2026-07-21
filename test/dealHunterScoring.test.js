import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventMatchesCimRequest, parseSheetCsvDeals, scoreDeal } from '../server/services/dealHunter.js';
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
