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
  sendPreparedMessage,
} from '../server/services/delivery.js';
import { buildDailyDealHunterEmailEnvelope } from '../server/services/dailyDealHunterDigest.js';

function taskThreeProjection(notificationType = 'normal-digest') {
  const alert = notificationType === 'required-source-alert';
  return {
    version: 'daily-deal-hunter-digest-v1',
    businessDate: '2026-07-15',
    generatedAt: '2026-07-15T15:00:00.000Z',
    status: alert ? 'action-required' : 'ready',
    notificationType,
    sourceAuthority: {
      requiredHealthy: !alert,
      blockingIssues: alert ? [{
        sourceId: 'sheet-0',
        sourceName: 'SMB Deal Hunter Google Sheet',
        classification: 'unavailable',
        title: 'Required source is unavailable',
        message: 'Required source data is currently unavailable.',
        checkedAt: '2026-07-15T15:00:00.000Z',
      }] : [],
      optionalWarnings: [],
    },
    summary: alert ? null : {
      needsReview: 2,
      highPriority: 1,
      watchlist: 1,
      lowConfidence: 0,
      currentOpportunities: 2,
    },
    topOpportunities: alert ? [] : [{
      opportunityId: 'opportunity-1',
      name: 'Durable Services <script>alert(1)</script>',
      state: 'CA',
      fitScore: 91,
      scoreStatus: 'current',
      confidence: 'high',
      operatorPriority: 'pursue',
      reviewed: false,
      changedSinceReview: true,
      topStrength: `Recurring revenue <strong>${'x'.repeat(800)}`,
      topConcern: `Customer concentration & diligence ${'y'.repeat(800)}`,
      workflow: { crmStatus: 'not-started', cimStatus: 'not-requested' },
      observationFreshness: '2026-07-15T14:55:00.000Z',
    }],
    job: { status: '', attemptCount: 0, completedAt: '', notificationType },
    actionsAllowed: !alert,
    links: {
      inbox: 'https://internal.example.test/admin/deal-hunter',
      operations: 'https://internal.example.test/admin/deal-hunter?view=operations',
    },
    rawSourceRows: [{ brokerEmail: 'broker-private@example.test', annualProfit: 999999 }],
    operatorNotes: 'Private operator note must not render.',
  };
}

function taskThreeDeliveryConfig(provider = 'resend', isProduction = true) {
  return {
    isProduction,
    server: { outboundRequestTimeoutMs: 100 },
    delivery: {
      provider,
      resendApiKey: 're_test_only',
      resendFromEmail: 'Uckele Group <sender@example.test>',
      resendReplyTo: '',
    },
  };
}

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

test('daily digest normal email renders only the approved projection fields', () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(),
    recipient: 'digest@example.test',
    sender: 'Uckele Group <sender@example.test>',
    preparedAt: '2026-07-15T15:00:00.000Z',
  });

  assert.equal(message.subject, 'Daily Deal Hunter — 2 to review — 2026-07-15');
  assert.match(message.text, /Durable Services/);
  assert.match(message.text, /High priority: 1/);
  assert.match(message.html, /Durable Services &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(`${message.text}\n${message.html}`, /broker-private@example\.test|999999|Private operator note/);
  assert.doesNotMatch(`${message.text}\n${message.html}`, /rawSourceRows|annualProfit|operatorNotes/);
});

test('daily digest source alert renders no opportunity counts names or recommendations', () => {
  const projection = taskThreeProjection('required-source-alert');
  projection.summary = { needsReview: 57, currentOpportunities: 90 };
  projection.topOpportunities = [{ name: 'Must Never Render', topStrength: 'Buy this business' }];
  const message = buildDailyDealHunterEmailEnvelope({
    projection,
    recipient: 'digest@example.test',
    sender: 'Uckele Group <sender@example.test>',
    preparedAt: '2026-07-15T15:00:00.000Z',
  });

  assert.equal(message.subject, 'ACTION REQUIRED — Deal Hunter source health — 2026-07-15');
  assert.match(message.text, /Required source data is currently unavailable/);
  assert.doesNotMatch(`${message.text}\n${message.html}`, /Must Never Render|Buy this business|57|90/);
});

test('daily digest uses deterministic key and exact source business-date notification tags', () => {
  const inputs = {
    projection: taskThreeProjection(),
    recipient: 'digest@example.test',
    sender: 'Uckele Group <sender@example.test>',
    preparedAt: '2026-07-15T15:00:00.000Z',
  };
  const first = buildDailyDealHunterEmailEnvelope(inputs);
  const second = buildDailyDealHunterEmailEnvelope(inputs);

  assert.deepEqual(first, second);
  assert.equal(first.idempotencyKey, 'daily-deal-hunter-email:2026-07-15');
  assert.deepEqual(first.tags.slice(0, 3), [
    { name: 'source', value: 'daily-deal-hunter' },
    { name: 'business_date', value: '2026-07-15' },
    { name: 'notification', value: 'normal-digest' },
  ]);
  assert.equal(first.tags.find((tag) => tag.name === 'payload_digest')?.value, first.payloadDigest);
  assert.match(first.payloadDigest, /^[a-f0-9]{64}$/);
});

test('daily digest fails closed before network on EmailJS Formspree and production console', async () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test',
  });
  for (const provider of ['emailjs', 'formspree', 'console']) {
    let networkCalls = 0;
    const result = await sendPreparedMessage(message, {
      configOverride: taskThreeDeliveryConfig(provider, true),
      fetcher: async () => { networkCalls += 1; throw new Error('network must not run'); },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.definitiveFailure, true);
    assert.equal(networkCalls, 0);
  }
});

test('daily digest Resend timeout is ambiguous', async () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test',
  });
  let networkCalls = 0;
  const result = await sendPreparedMessage(message, {
    configOverride: taskThreeDeliveryConfig(),
    fetcher: async () => { networkCalls += 1; throw new Error('Resend delivery timed out.'); },
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.errorCategory, 'provider-timeout');
  assert.equal(networkCalls, 1);
});

test('daily digest connection reset parse failure and uncertain HTTP response are ambiguous', async () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'Digest Admin <digest@example.test>', sender: 'sender@example.test',
  });
  const cases = [
    [async () => { throw new Error('socket connection reset'); }, 'provider-connection-unknown'],
    [async () => new Response('not-json', { status: 200 }), 'accepted-response-parse-unknown'],
    [async () => new Response('upstream result unknown', { status: 503 }), 'provider-http-unknown'],
    [async () => new Response(JSON.stringify({ id: 'invalid provider id' }), { status: 200 }), 'missing-provider-id'],
  ];
  for (const [fetcher, errorCategory] of cases) {
    const result = await sendPreparedMessage(message, {
      configOverride: taskThreeDeliveryConfig(),
      fetcher,
    });
    assert.equal(result.status, 'ambiguous', errorCategory);
    assert.equal(result.errorCategory, errorCategory);
    assert.notEqual(result.definitiveFailure, true);
  }
});

test('daily digest display-name recipient does not broaden unrelated prepared-message validation', async () => {
  const dailyMessage = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'Digest Admin <digest@example.test>', sender: 'sender@example.test',
  });
  const dailyResult = await sendPreparedMessage(dailyMessage, {
    configOverride: taskThreeDeliveryConfig('console', false),
  });
  const unrelatedResult = await sendPreparedMessage({
    kind: 'admin-magic-link',
    to: 'Admin <admin@example.test>',
    subject: 'Sign in',
    text: 'Test',
    html: '<p>Test</p>',
  }, {
    configOverride: taskThreeDeliveryConfig('console', false),
  });

  assert.equal(dailyResult.status, 'logged');
  assert.equal(unrelatedResult.status, 'failed');
  assert.equal(unrelatedResult.errorCategory, 'invalid-recipient');
  assert.throws(() => buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(),
    recipient: 'digest@example.test, attacker@example.test',
    sender: 'sender@example.test',
  }), /valid server-owned email address/);
});

test('daily digest accepted response without provider id is ambiguous', async () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test',
  });
  const result = await sendPreparedMessage(message, {
    configOverride: taskThreeDeliveryConfig(),
    fetcher: async () => new Response('{}', { status: 200 }),
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.errorCategory, 'missing-provider-id');
});

test('daily digest authoritative nonacceptance is definitive failure', async () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test',
  });
  const result = await sendPreparedMessage(message, {
    configOverride: taskThreeDeliveryConfig(),
    fetcher: async () => new Response(JSON.stringify({ message: 'rejected' }), { status: 422 }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.definitiveFailure, true);
  assert.equal(result.errorCategory, 'provider-nonacceptance');
});

test('daily digest renderer bounds and escapes source issues strengths and concerns', () => {
  const message = buildDailyDealHunterEmailEnvelope({
    projection: taskThreeProjection(), recipient: 'digest@example.test', sender: 'sender@example.test',
  });
  assert.doesNotMatch(message.html, /<script>|<strong>x/i);
  assert.match(message.html, /&lt;script&gt;|&lt;strong&gt;/);
  assert.ok(Buffer.byteLength(message.text, 'utf8') < 32 * 1024);
  assert.ok(Buffer.byteLength(message.html, 'utf8') < 96 * 1024);
  assert.doesNotMatch(message.text, /x{401}|y{401}/);
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

test('CIM follow-up idempotency keys are stable and distinct for one through five', () => {
  const keys = [1, 2, 3, 4, 5].map((followUpNumber) => (
    buildCimEmailIdempotencyKey({ requestId: 'request-1', followUpNumber })
  ));

  assert.deepEqual(keys, [
    'deal-hunter-cim-request-1-follow-up-1',
    'deal-hunter-cim-request-1-follow-up-2',
    'deal-hunter-cim-request-1-follow-up-3',
    'deal-hunter-cim-request-1-follow-up-4',
    'deal-hunter-cim-request-1-follow-up-5',
  ]);
  assert.equal(new Set(keys).size, 5);
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

test('manual Stage 1 CIM copy accepts only a validated greeting and returns its explicit template version', () => {
  // Break caught: the existing builder owns its greeting and has no exact,
  // versioned manual-review envelope.
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: sampleDeal,
    requestedBy: 'Mathew Uckele',
    cimRequestId: 'request-manual',
    manualStage1: { greeting: 'Hi Avery,' },
  });

  assert.equal(message.templateVersion, 'deal-hunter-cim-manual-stage1-v1');
  assert.equal(message.greeting, 'Hi Avery,');
  assert.equal(message.text.startsWith('Hi Avery,\n'), true);
  assert.match(message.html, />Hi Avery,</);
  assert.doesNotMatch(message.html, /Hello Test Broker/);
  for (const greeting of ['Hi\nAvery,', 'Hi\rAvery,', '\nHello,', 'Hello,\r', 'Hi\0Avery,', '<b>Hello</b>', 'x'.repeat(121)]) {
    assert.throws(() => buildDealHunterCimRequestEmail({
      to: 'broker@example.com', deal: sampleDeal, cimRequestId: 'request-manual', manualStage1: { greeting },
    }), /greeting|plain text|invalid/i);
  }
});

test('manual Stage 1 provider HTML adds no substantive copy absent from the reviewed subject and complete text', () => {
  // Break caught: the branded template currently adds preview/title/CTA copy
  // that an administrator cannot see in the plain-text review.
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: sampleDeal,
    requestedBy: 'Mathew Uckele',
    cimRequestId: 'request-manual-parity',
    manualStage1: { greeting: 'Hello,' },
  });
  const visibleHtml = message.html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const reviewed = `${message.subject} ${message.text}`.replace(/\s+/g, ' ');
  for (const phrase of visibleHtml.split(/[.!?]\s+/).map((value) => value.trim()).filter((value) => value.length > 20)) {
    assert.equal(reviewed.includes(phrase), true, `HTML-only phrase: ${phrase}`);
  }
});

test('default and Stage 2 CIM copy remain unchanged without the trusted manual option', () => {
  // Break caught: adding manual greeting support accidentally changes legacy
  // direct copy or removes Stage 2 compliance disclosures.
  const direct = buildDealHunterCimRequestEmail({ to: 'broker@example.com', deal: sampleDeal, requestedBy: 'Mathew Uckele', cimRequestId: 'direct' });
  const stage2 = buildDealHunterCimRequestEmail({ to: 'broker@example.com', deal: sampleDeal, requestedBy: 'automation-stage-2', cimRequestId: 'stage-2' });
  assert.equal(direct.subject, 'CIM / NDA request for Commercial HVAC Maintenance Co');
  assert.equal(direct.text.startsWith('Hello Test Broker,\n'), true);
  assert.match(direct.text, /Best,\nMathew Uckele\nUckele Group$/);
  assert.equal(Object.hasOwn(direct, 'templateVersion'), false);
  assert.match(stage2.text, /commercial acquisition-outreach message/);
  assert.match(stage2.text, /reply with “unsubscribe” or “stop”/);
  assert.match(stage2.text, /Postal address:/);
  assert.equal(Object.hasOwn(stage2, 'templateVersion'), false);
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

test('CIM follow-up copy has explicit distinct branches for four and five', () => {
  const request = {
    id: 'request-1',
    deal_key: sampleDeal.dealKey,
    deal_name: sampleDeal.name,
    listing_url: sampleDeal.listingUrl,
    metadata: { industry: sampleDeal.industry, location: sampleDeal.location },
  };
  const fourth = buildDealHunterCimFollowUpEmail({
    to: 'broker@example.com', request, followUpNumber: 4, requestedBy: 'Mathew Uckele',
  });
  const fifth = buildDealHunterCimFollowUpEmail({
    to: 'broker@example.com', request, followUpNumber: 5, requestedBy: 'Mathew Uckele',
  });

  assert.match(fourth.text, /If the opportunity is still active/i);
  assert.match(fourth.text, /CIM, teaser, offering materials, or the next step in the NDA process/i);
  assert.match(fourth.text, /brief status update/i);
  assert.doesNotMatch(fourth.text, /proof of funds|buyer profile/i);
  assert.match(fifth.text, /one final time/i);
  assert.match(fifth.text, /no further action is needed/i);
  assert.match(fifth.text, /close the loop/i);
  assert.notEqual(fourth.text, fifth.text);
  assert.notEqual(fourth.html, fifth.html);
  assert.equal(fourth.templateVersion, 'deal-hunter-cim-follow-up-4-v1');
  assert.equal(fifth.templateVersion, 'deal-hunter-cim-follow-up-5-v1');
});

test('CIM follow-up builder accepts a trusted greeting for one through five and rejects out of range', () => {
  const request = {
    id: 'request-1',
    deal_key: sampleDeal.dealKey,
    deal_name: sampleDeal.name,
    listing_url: sampleDeal.listingUrl,
    metadata: { industry: sampleDeal.industry, location: sampleDeal.location },
  };

  for (const followUpNumber of [1, 2, 3, 4, 5]) {
    const message = buildDealHunterCimFollowUpEmail({
      to: 'broker@example.com',
      request,
      followUpNumber,
      requestedBy: 'Mathew Uckele',
      manualFollowUp: { greeting: 'Hi Avery,' },
    });
    assert.equal(message.greeting, 'Hi Avery,');
    assert.equal(message.text.startsWith('Hi Avery,\n'), true);
    assert.match(message.html, /Hi Avery,/);
    assert.equal(message.templateVersion, `deal-hunter-cim-follow-up-${followUpNumber}-v1`);
  }

  for (const followUpNumber of [0, 6, -1, 1.5, '2']) {
    assert.throws(() => buildDealHunterCimFollowUpEmail({
      to: 'broker@example.com', request, followUpNumber, manualFollowUp: { greeting: 'Hi Avery,' },
    }), /follow-up number/i);
  }
  for (const manualFollowUp of [
    {},
    { greeting: '' },
    { greeting: 'Hello\nthere,' },
    { greeting: '<Hello>,' },
    { greeting: 'x'.repeat(121) },
    { greeting: 'Hello,', subject: 'override' },
  ]) {
    assert.throws(() => buildDealHunterCimFollowUpEmail({
      to: 'broker@example.com', request, followUpNumber: 1, manualFollowUp,
    }), /manual follow-up/i);
  }
});
