import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCimEmailIdempotencyKey,
  buildCimReplyToAddress,
  buildDealHunterCimFollowUpEmail,
  buildDealHunterCimRequestEmail,
  buildDailyDealHunterEmail,
  buildDailyDealHunterSourceAlertEmail,
  buildAdminEmailTestEmail,
  normalizeResendTags,
} from '../server/services/delivery.js';

test('controlled email test is clearly marked and asks for an unchanged-subject reply', () => {
  const message = buildAdminEmailTestEmail({
    to: 'admin@example.com',
    requestedBy: 'Admin',
    sentAt: new Date('2026-07-14T20:00:00.000Z'),
  });

  assert.equal(message.kind, 'admin-email-test');
  assert.match(message.subject, /^\[TEST\] Uckele Group email delivery verification/);
  assert.match(message.text, /reply to this message without changing the subject/i);
  assert.equal(message.tags.some((tag) => tag.name === 'source' && tag.value === 'admin-email-test'), true);
});

test('daily Deal Hunter email carries its deterministic provider idempotency key', () => {
  const message = buildDailyDealHunterEmail({
    to: 'admin@example.com',
    idempotencyKey: 'daily-deal-hunter-email:2026-07-12',
    review: { totals: {}, sources: [], criteriaRecommendations: [] },
  });
  assert.equal(message.idempotencyKey, 'daily-deal-hunter-email:2026-07-12');
  assert.equal(message.tracking.notificationType, 'normal-digest');
});

test('daily Deal Hunter email has clickable links for 75+ businesses and CIM approvals', () => {
  const message = buildDailyDealHunterEmail({
    to: 'admin@example.com',
    review: {
      totals: { cimReady: 1 },
      sources: [],
      criteriaRecommendations: [],
      qualified: [{
        dealKey: 'deal-1',
        name: 'Recurring HVAC Services',
        score: 88,
        brokerEmail: 'broker@example.com',
        cimRequest: { canRequest: true, recipientEmail: 'broker@example.com' },
      }],
    },
  });

  assert.match(message.text, /CIM requests ready for approval: 1/);
  assert.match(message.text, /Review 75\+ scored businesses: http:\/\/localhost:5173\/admin\/command-center/);
  assert.match(message.text, /Review and send CIM requests: http:\/\/localhost:5173\/admin\/deal-hunter\?view=cim-approvals/);
  assert.match(message.html, /<a href="http:\/\/localhost:5173\/admin\/command-center" target="_blank"[^>]*>Review 75\+ Scored Businesses<\/a>/);
  assert.match(message.html, /<a href="http:\/\/localhost:5173\/admin\/deal-hunter\?view=cim-approvals" target="_blank"[^>]*>Review &amp; Send 1 CIM Request<\/a>/);
  assert.doesNotMatch(message.html, />http:\/\/localhost:5173\/admin\/command-center<\/a>/);
  assert.doesNotMatch(message.html, />http:\/\/localhost:5173\/admin\/deal-hunter\?view=cim-approvals<\/a>/);
  assert.match(message.html, /bgcolor="#284638"[^>]*>[\s\S]*?Review 75\+ Scored Businesses/);
  assert.match(message.html, /bgcolor="#FFFFFF"[^>]*>[\s\S]*?Review &amp; Send 1 CIM Request/);
  assert.equal(message.tracking.cimReadyCount, 1);
});

test('daily Deal Hunter email always links to the 75+ scored-business dashboard', () => {
  const message = buildDailyDealHunterEmail({
    to: 'admin@example.com',
    review: { totals: {}, sources: [], criteriaRecommendations: [] },
  });

  assert.match(message.html, /href="http:\/\/localhost:5173\/admin\/command-center"/);
  assert.doesNotMatch(message.html, /href="http:\/\/localhost:5173\/admin\/deal-hunter\?view=cim-approvals"/);
});

test('daily Deal Hunter email clearly discloses an additional source coverage limit', () => {
  const message = buildDailyDealHunterEmail({
    to: 'admin@example.com',
    review: {
      totals: {},
      sources: [{ name: 'SMB Deal Hunter Google Sheet', fetched: true, rowCount: 290 }],
      coverageWarnings: [
        'The Deal OS export reached its listing ceiling and may be truncated.',
      ],
      criteriaRecommendations: [],
    },
  });

  assert.match(message.subject, /limited source coverage/i);
  assert.match(message.text, /LIMITED SOURCE COVERAGE/);
  assert.match(message.text, /Deal OS export reached its listing ceiling/);
  assert.match(message.html, /Limited source coverage/);
  assert.match(message.html, /Deal OS export reached its listing ceiling/);
});

test('daily Deal Hunter email prominently labels required, supplemental, and retired source coverage', () => {
  const warning = 'OPTIONAL DEAL OS IMPORT STALE — NOT USED: export exceeds the freshness limit.';
  const message = buildDailyDealHunterEmail({
    to: 'admin@example.com',
    review: {
      totals: {},
      sources: [
        { id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', fetched: true, rowCount: 290, required: true, sourceRole: 'required-primary' },
        { id: 'deal-os-export', name: 'SMB Deal OS export', fetched: false, rowCount: 120, required: false, sourceRole: 'optional-supplemental', error: 'export exceeds the freshness limit' },
      ],
      optionalSourceWarnings: [warning],
      coverageWarnings: [warning],
      criteriaRecommendations: [],
    },
  });

  assert.match(message.subject, /Deal OS warning/);
  assert.match(message.text, /ACTION RECOMMENDED — OPTIONAL DEAL OS DATA NOT USED/);
  assert.match(message.text, /Google Sheet: REQUIRED PRIMARY — healthy/);
  assert.match(message.text, /Deal OS export: OPTIONAL SUPPLEMENTAL — stale; not used/);
  assert.match(message.text, /Airtable Biz List: RETIRED — not fetched/);
  assert.match(message.html, /Action recommended — optional Deal OS data not used/);
  assert.match(message.html, /REQUIRED PRIMARY/);
  assert.match(message.html, /RETIRED/);
});

test('required-source alert is bounded, escaped, date-scoped, and contains no recommendations', () => {
  const unsafeError = `<script>alert(1)</script>${'x'.repeat(700)}END-OF-UNBOUNDED-ERROR`;
  const message = buildDailyDealHunterSourceAlertEmail({
    to: 'admin@example.com',
    idempotencyKey: 'daily-deal-hunter-email:2026-08-25',
    review: {
      generatedAt: '2026-08-25T18:00:00.000Z',
      latestSuccessfulDelivery: { createdAt: '2026-08-24T18:00:00.000Z', subject: 'Daily deal review' },
      sources: [
        { id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', fetched: false, required: true, sourceRole: 'required-primary', rowCount: 0, error: unsafeError },
        { id: 'deal-os-export', name: 'SMB Deal OS export', fetched: false, required: false, sourceRole: 'optional-supplemental', exportedAt: '2026-08-20T12:00:00.000Z', importedAt: '2026-08-20T12:05:00.000Z', error: 'stale' },
      ],
      qualified: [{ name: 'Must Not Appear Recommendation' }],
    },
  });

  assert.equal(message.idempotencyKey, 'daily-deal-hunter-email:2026-08-25');
  assert.equal(message.tracking.notificationType, 'required-source-alert');
  assert.match(message.subject, /2026-08-25/);
  assert.match(message.text, /Pacific business date: 2026-08-25/);
  assert.match(message.text, /No CRM synchronization, CIM request, follow-up, Stage 2 automation, or other broker outreach occurred/);
  assert.match(message.text, /Latest successful normal digest/);
  assert.match(message.text, /Deal OS: optional and stale; not used/);
  assert.doesNotMatch(message.text, /Must Not Appear Recommendation/);
  assert.doesNotMatch(message.html, /Must Not Appear Recommendation/);
  assert.doesNotMatch(message.html, /<script>/i);
  assert.match(message.html, /&lt;script&gt;/);
  assert.doesNotMatch(message.text, /END-OF-UNBOUNDED-ERROR/);
  assert.doesNotMatch(message.html, /END-OF-UNBOUNDED-ERROR/);
});

test('daily Deal Hunter email only makes HTTP(S) listing URLs clickable', () => {
  const message = buildDailyDealHunterEmail({
    to: 'admin@example.com',
    review: {
      totals: { qualified: 2 },
      sources: [],
      criteriaRecommendations: [],
      qualified: [
        { dealKey: 'safe-deal', name: 'Safe listing', score: 90, listingUrl: 'https://example.com/listing' },
        { dealKey: 'unsafe-deal', name: 'Unsafe listing', score: 89, listingUrl: 'javascript:alert(1)' },
      ],
    },
  });

  assert.match(message.html, /href="https:\/\/example.com\/listing"/);
  assert.doesNotMatch(message.html, /javascript:/i);
  assert.doesNotMatch(message.text, /javascript:/i);
});

test('CIM touch identifiers are deterministic and isolated by request and follow-up number', () => {
  const initialKey = buildCimEmailIdempotencyKey({ requestId: 'request-1' });

  assert.equal(initialKey, 'deal-hunter-cim-request-1-initial');
  assert.equal(buildCimEmailIdempotencyKey({ requestId: 'request-1' }), initialKey);
  assert.equal(
    buildCimEmailIdempotencyKey({ requestId: 'request-1', followUpNumber: 1 }),
    'deal-hunter-cim-request-1-follow-up-1',
  );
  assert.notEqual(
    buildCimEmailIdempotencyKey({ requestId: 'request-1', followUpNumber: 1 }),
    buildCimEmailIdempotencyKey({ requestId: 'request-1', followUpNumber: 2 }),
  );
  assert.equal(buildCimEmailIdempotencyKey(), '');
});

test('CIM requests get stable request-specific reply addresses on the configured inbound domain', () => {
  assert.equal(
    buildCimReplyToAddress({
      requestId: 'A'.repeat(64),
      replyTo: 'Uckele Deals <deals@inbound.example.com>',
    }),
    `cim-${'a'.repeat(32)}@inbound.example.com`,
  );
});

const sensitiveBrokerDetails = [
  'Internal Fit Score',
  'internal fit score',
  '92/100',
  'Score 92',
  '$450,000',
  '$1,600,000',
  'Profit',
  'Asking Price',
];

const visibleFollowUpSequenceLabels = [
  'Follow-Up',
  'follow-up',
  'Following up',
  'following up',
  'Second follow-up',
  'Final follow-up',
  'final follow-up',
];

const sampleDeal = {
  dealKey: 'commercial-hvac-maintenance-co',
  name: 'Commercial HVAC Maintenance Co',
  brokerName: 'Test Broker',
  industry: 'Commercial HVAC maintenance',
  location: 'San Diego, CA',
  annualProfit: 450000,
  askingPrice: 1600000,
  score: 92,
  listingUrl: 'https://uckelegroup.com/admin',
};

function brokerVisibleContent(message) {
  return [message.subject, message.text, message.html].join('\n');
}

function assertBrokerEmailHidesInternalDetails(message) {
  const visibleContent = brokerVisibleContent(message);

  for (const sensitiveDetail of sensitiveBrokerDetails) {
    assert.equal(
      visibleContent.includes(sensitiveDetail),
      false,
      `Broker email should not expose "${sensitiveDetail}"`,
    );
  }
}

function assertBrokerEmailHidesFollowUpSequenceLabels(message) {
  const visibleContent = brokerVisibleContent(message);

  for (const label of visibleFollowUpSequenceLabels) {
    assert.equal(
      visibleContent.includes(label),
      false,
      `Broker email should not expose follow-up sequence label "${label}"`,
    );
  }
}

function assertBrokerEmailOmitsBodyHeadline(message) {
  assert.equal(
    message.html.includes('<h1'),
    false,
    'Broker email body should not render a repeated subject headline',
  );
  assert.equal(
    message.html.includes('CIM Request</p>'),
    false,
    'Broker email body should not render a campaign-style CIM Request eyebrow',
  );
}

function assertBrokerEmailIncludesBrandLogo(message) {
  assert.match(
    message.html,
    /<img src="http:\/\/localhost:5173\/email-logo\.png" width="44" height="44" alt=""/,
    'Broker email should render the hosted Uckele Group logo mark',
  );
  assert.match(message.html, />\s*Uckele Group\s*<\/td>/);
}

test('CIM request email keeps internal score and deal economics out of broker-visible content', () => {
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: sampleDeal,
    requestedBy: 'Mathew Uckele',
    cimRequestId: 'request-1',
  });

  assert.equal(message.kind, 'deal-hunter-cim-request');
  assert.equal(message.idempotencyKey, 'deal-hunter-cim-request-1-initial');
  assert.match(message.subject, /CIM \/ NDA request/);
  assert.match(message.text, /Could you please send over the CIM or teaser, or let me know the NDA process\?/);
  assert.match(message.html, /View Listing/);
  assertBrokerEmailIncludesBrandLogo(message);
  assertBrokerEmailOmitsBodyHeadline(message);
  assertBrokerEmailHidesFollowUpSequenceLabels(message);
  assertBrokerEmailHidesInternalDetails(message);
});

test('CIM broker emails never expose an internal automation actor as the sender identity', () => {
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: sampleDeal,
    requestedBy: 'automation-stage-2',
    cimRequestId: 'request-automation',
  });

  assert.doesNotMatch(message.text, /automation-stage-2/i);
  assert.match(message.text, /Mathew Uckele/);
});

test('CIM request email tags are safe for Resend when deal keys contain punctuation', () => {
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: {
      ...sampleDeal,
      dealKey: 'SMB Deal Hunter Google Sheet | 20+ Year HVAC Company w/ strong earnings | erin@powerofpluck.com',
    },
    requestedBy: 'Mathew Uckele',
  });
  const tags = normalizeResendTags(message.tags);
  const dealKeyTag = tags.find((tag) => tag.name === 'deal_key');

  assert.ok(dealKeyTag);
  assert.match(dealKeyTag.value, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    dealKeyTag.value,
    'SMB-Deal-Hunter-Google-Sheet-20-Year-HVAC-Company-w-strong-earnings-erin-powerofpluck-com',
  );
  assert.equal(tags.every((tag) => /^[A-Za-z0-9_-]+$/.test(tag.name) && /^[A-Za-z0-9_-]+$/.test(tag.value)), true);
});

test('CIM follow-up emails keep internal score and deal economics out of broker-visible content', () => {
  for (const followUpNumber of [1, 2, 3]) {
    const message = buildDealHunterCimFollowUpEmail({
      to: 'broker@example.com',
      followUpNumber,
      requestedBy: 'Mathew Uckele',
      request: {
        id: 'request-1',
        deal_key: sampleDeal.dealKey,
        deal_name: sampleDeal.name,
        listing_url: sampleDeal.listingUrl,
        score: sampleDeal.score,
        metadata: {
          industry: sampleDeal.industry,
          location: sampleDeal.location,
          annualProfit: sampleDeal.annualProfit,
          askingPrice: sampleDeal.askingPrice,
        },
      },
    });

    assert.equal(message.kind, 'deal-hunter-cim-follow-up');
    assert.equal(message.idempotencyKey, `deal-hunter-cim-request-1-follow-up-${followUpNumber}`);
    assert.match(message.subject, /^Re: CIM \/ NDA request/);
    assert.equal(message.tracking.followUpNumber, followUpNumber);
    assert.equal(message.tags.some((tag) => tag.name === 'follow_up_number' && tag.value === String(followUpNumber)), true);
    assertBrokerEmailIncludesBrandLogo(message);
    assertBrokerEmailOmitsBodyHeadline(message);
    assertBrokerEmailHidesFollowUpSequenceLabels(message);
    assert.equal(message.text.includes(`#${followUpNumber}`), false);
    assert.equal(message.html.includes('>Follow-Up</td>'), false);
    assert.equal(message.html.includes(`>#${followUpNumber}</td>`), false);
    assertBrokerEmailHidesInternalDetails(message);
  }
});
