import { expect, test } from '@playwright/test';

const emptySummary = {
  total: 15,
  new: 0,
  review: 15,
  contacted: 0,
  archived: 0,
  spam: 0,
  lastSevenDays: 0,
  actionItems: 0,
  overdue: 0,
  dueSoon: 0,
  emailEngaged: 0,
  hotLeads: 0,
};

function followUpRecord(index) {
  return {
    id: `browser-follow-up-${index}`,
    updated_at: '2026-08-09T16:00:00.000Z',
    status: 'review',
    follow_up_state: 'needs-response',
    next_action_at: '2026-08-09T17:00:00.000Z',
    priority: index === 0 ? 'high' : 'normal',
    company: `Browser Follow-Up ${index}`,
    name: `Broker ${index}`,
    email: `browser-broker-${index}@example.test`,
    broker_name: `Broker ${index}`,
    broker_email: `browser-broker-${index}@example.test`,
    follow_up_prompt: { title: 'Follow up due', kind: 'due' },
    follow_up_latest_subject: index === 0 ? 'Re: Browser acquisition question' : '',
    follow_up_latest_direction: index === 0 ? 'inbound' : '',
    follow_up_latest_delivery_state: index === 1 ? 'bounced' : '',
    follow_up_latest_communication_at: '2026-08-09T16:30:00.000Z',
    follow_up_priority_score: index === 0 ? 95 : 20,
  };
}

async function mockAuthenticatedAdmin(page) {
  await page.route('**/api/admin/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        authenticated: true,
        username: 'phase16-admin',
        role: 'admin',
        authMode: 'hybrid',
        magicLinkEnabled: true,
        passwordEnabled: true,
      }),
    });
  });

  await page.route('**/api/admin/onboarding', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        progress: [
          {
            tourKey: 'admin-foundations',
            tourVersion: 1,
            status: 'completed',
            lastCompletedStepId: 'foundations-page-guide',
          },
          {
            tourKey: 'deal-hunter',
            tourVersion: 1,
            status: 'completed',
            lastCompletedStepId: 'deal-hunter-history',
          },
        ],
      }),
    });
  });

  await page.route('**/api/admin/submissions?*', async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get('page') || 1);
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        summary: emptySummary,
        submissions: [],
        notifications: [],
        emailTriage: [],
        total: 15,
        page: pageNumber,
        pageSize: Number(url.searchParams.get('pageSize') || 25),
        totalPages: 2,
        sort: url.searchParams.get('sort') || 'created_at',
        direction: url.searchParams.get('direction') || 'desc',
      }),
    });
  });

  await page.route('**/api/admin/operations', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        operations: {
          scheduler: { runs: [], failures: 0, pending: 0 },
          sources: { current: { healthy: true, generatedAt: '2026-07-13T18:00:00.000Z', issues: [] }, history: [] },
          audit: { events: [] },
          cleanup: { jobs: [], failures: [] },
          storage: {
            disk: { ok: true, totalBytes: 1000, freeBytes: 700, usedBytes: 300, freePercent: 70 },
            database: { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 300 },
          },
          backup: { status: 'healthy', message: 'Latest backup verified.', latest: { createdAt: '2026-07-13T10:00:00.000Z', documentCount: 2 } },
        },
      }),
    });
  });

  await page.route('**/api/admin/follow-ups/*/context?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        context: {
          submission: {
            ...followUpRecord(0),
            assigned_to: 'Mathew Uckele',
          },
          communications: [{
            id: 'browser-inbound-1',
            direction: 'inbound',
            channel: 'email',
            from_address: 'browser-broker-0@example.test',
            to_addresses: ['reply@example.test'],
            subject: 'Re: Browser acquisition question',
            body_text: '<script>untrusted email instruction</script> Could you send the CIM?',
            body_html_sanitized: '<script>must not render</script>',
            message_id: '<browser-inbound-1@example.test>',
            references_json: [],
            delivery_state: 'replied',
            content_state: 'complete',
            attachment_metadata: [],
            occurred_at: '2026-08-09T16:30:00.000Z',
          }],
          communicationTotal: 1,
          documents: [],
          dealHunter: { linked: false, cimRequest: null, concerns: [], strengths: [], unansweredQuestions: [] },
          recommendation: null,
          outbox: [],
          recipients: [{ email: 'browser-broker-0@example.test', label: 'Broker 0', source: 'broker' }],
          suppressions: [],
          policy: {
            email: { enabled: false, ready: false, blockers: ['email-disabled'] },
            sender: { from: '', replyTo: '' },
            ai: { enabled: false, ready: true, optional: true },
            timezone: 'America/Los_Angeles',
            sendWindowStart: '08:00',
            sendWindowEnd: '17:00',
            maxTouches: 3,
          },
        },
      }),
    });
  });

  await page.route('**/api/admin/follow-ups?*', async (route) => {
    const rows = Array.from({ length: 25 }, (_, index) => followUpRecord(index));
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        items: rows,
        summary: { ...emptySummary, total: 25 },
        total: 25,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });

  await page.route('**/api/admin/acquisition-command-center', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ success: true, commandCenter: null }),
    });
  });
}

const phase1DimensionLabels = [
  'Financial fit',
  'Revenue durability',
  'Demand resilience',
  'Transferability',
  'Operating profile',
  'Concentration and quality risk',
  'Strategic and geographic fit',
];

function phase1CanonicalOpportunity(overrides = {}) {
  return {
    opportunityId: 'opp-default',
    dealKey: 'deal-default',
    name: 'Default Opportunity',
    state: 'CA',
    listingUrl: 'https://broker.example/default',
    geography: { city: 'Sacramento', state: 'CA', label: 'Sacramento, CA' },
    industry: 'Commercial field services',
    ...overrides,
  };
}

function phase1ScoreRow(overrides = {}) {
  return {
    opportunityId: 'opp-default',
    fitScore: 80,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 86,
    missingEvidenceCount: 2,
    contradictionCount: 0,
    shouldRemove: false,
    highFit: true,
    financials: { annualProfit: 410000, annualRevenue: 2100000, askingPrice: 1700000, profitMultiple: 4.15 },
    topStrength: 'Contracted inspections support durable recurring demand.',
    topConcern: 'Customer concentration still needs verification.',
    observationFreshness: '2026-08-29T17:00:00.000Z',
    operatorPriority: 'normal',
    operatorNote: 'Confirm renewal terms before advancing.',
    reviewed: false,
    reviewedAt: '',
    reviewedBy: '',
    changedSinceReview: false,
    scoredAt: '2026-08-29T16:00:00.000Z',
    evidenceObservedAt: '2026-08-29T15:30:00.000Z',
    scoreFingerprint: 'phase1-machine-score-default',
    rulesVersion: 'deal-hunter-fit-v2.1',
    ...overrides,
  };
}

function phase1SourceRows(opportunity, score, {
  sellerName = 'Morgan Structured Seller',
  observedAt = score.observationFreshness,
  annualProfit = score.financials.annualProfit,
} = {}) {
  return [
    {
      opportunityId: opportunity.opportunityId,
      sourceId: 'sheet-0',
      sourceName: 'Deal Hunter Google Sheet',
      sourceRecordId: `${opportunity.dealKey}-sheet`,
      observedAt,
      values: {
        name: opportunity.name,
        city: opportunity.geography.city,
        state: opportunity.geography.state,
        location: opportunity.geography.label,
        industry: opportunity.industry,
        seller_name: sellerName,
        seller_phone: '206-555-0147',
        broker_name: 'Riley Structured Broker',
        broker_company: 'Northwest Business Advisors',
        broker_phone: '503-555-0110',
        broker_contact: 'Call the main broker desk after 2 PM.',
        reason_for_sale: 'Owner retirement',
        real_estate_included: 'Lease only; real estate excluded',
        seller_financing: 'Seller will consider 10%',
        management_structure: 'General manager leads day-to-day operations',
        annual_profit: String(annualProfit),
        annual_revenue: String(score.financials.annualRevenue),
        asking_price: String(score.financials.askingPrice),
        profit_multiple: String(score.financials.profitMultiple),
        listing_id: `${opportunity.dealKey}-sheet`,
        listing_url: opportunity.listingUrl,
      },
    },
    {
      opportunityId: opportunity.opportunityId,
      sourceId: 'deal-os',
      sourceName: 'Deal OS',
      sourceRecordId: `${opportunity.dealKey}-deal-os`,
      observedAt: '2026-08-28T17:00:00.000Z',
      values: {
        seller_name: 'Deal OS Seller Claim',
        annual_profit: String(score.financials.annualProfit - 45000),
        listing_id: `${opportunity.dealKey}-deal-os`,
        listing_url: `https://dealos.example/${opportunity.opportunityId}`,
      },
    },
  ];
}

function createPhase1FixtureState() {
  const canonicalOpportunities = [
    phase1CanonicalOpportunity({ opportunityId: 'opp-cascade', dealKey: 'deal-cascade', name: 'Cascade Field Compliance', listingUrl: 'https://broker.example/cascade', geography: { city: 'Portland', state: 'OR', label: 'Portland, OR' }, state: 'OR', industry: 'Field compliance services' }),
    phase1CanonicalOpportunity({ opportunityId: 'opp-heritage', dealKey: 'deal-heritage', name: 'Heritage Inspection Partners', listingUrl: 'https://broker.example/heritage', geography: { city: 'Reno', state: 'NV', label: 'Reno, NV' }, state: 'NV', industry: 'Commercial inspection services' }),
    phase1CanonicalOpportunity({ opportunityId: 'opp-evergreen', dealKey: 'deal-evergreen', name: 'Evergreen Safety Services', listingUrl: 'https://broker.example/evergreen', geography: { city: 'Seattle', state: 'WA', label: 'Seattle, WA' }, state: 'WA', industry: 'Workplace safety services' }),
    phase1CanonicalOpportunity({ opportunityId: 'opp-summit', dealKey: 'deal-summit', name: 'Summit Fire Systems', listingUrl: 'https://broker.example/summit', geography: { city: 'Boise', state: 'ID', label: 'Boise, ID' }, state: 'ID', industry: 'Fire protection systems' }),
  ];
  const scoreRows = [
    phase1ScoreRow({ opportunityId: 'opp-cascade', fitScore: 84, scoreStatus: 'watchlist', confidence: 'low', completenessScore: 61, missingEvidenceCount: 4, financials: { annualProfit: 360000, annualRevenue: 1900000, askingPrice: 1500000, profitMultiple: 4.17 }, observationFreshness: '2026-08-28T19:00:00.000Z', scoredAt: '2026-08-28T18:00:00.000Z', scoreFingerprint: 'phase1-machine-score-cascade-84' }),
    phase1ScoreRow({ opportunityId: 'opp-heritage', fitScore: 71, scoreStatus: 'high-fit', confidence: 'medium', completenessScore: 77, contradictionCount: 1, highFit: false, financials: { annualProfit: 275000, annualRevenue: 1400000, askingPrice: 1150000, profitMultiple: 4.18 }, reviewed: true, reviewedAt: '2026-08-27T18:00:00.000Z', reviewedBy: 'phase1-admin', observationFreshness: '2026-08-27T17:00:00.000Z', scoredAt: '2026-08-27T16:00:00.000Z', scoreFingerprint: 'phase1-machine-score-heritage-71' }),
    phase1ScoreRow({ opportunityId: 'opp-evergreen', fitScore: 92, scoreStatus: 'high-fit', confidence: 'high', completenessScore: 91, financials: { annualProfit: 520000, annualRevenue: 2800000, askingPrice: 2100000, profitMultiple: 4.04 }, observationFreshness: '2026-08-30T16:00:00.000Z', scoredAt: '2026-08-30T15:00:00.000Z', evidenceObservedAt: '2026-08-30T14:30:00.000Z', scoreFingerprint: 'phase1-machine-score-evergreen-92' }),
    phase1ScoreRow({ opportunityId: 'opp-summit', fitScore: 78, scoreStatus: 'high-fit', confidence: 'medium', completenessScore: 79, operatorPriority: 'high', financials: { annualProfit: 390000, annualRevenue: 2050000, askingPrice: 1600000, profitMultiple: 4.1 }, observationFreshness: '2026-08-26T17:00:00.000Z', scoredAt: '2026-08-26T16:00:00.000Z', scoreFingerprint: 'phase1-machine-score-summit-78' }),
  ];
  const sourceObservations = canonicalOpportunities.flatMap((opportunity) => {
    const score = scoreRows.find((row) => row.opportunityId === opportunity.opportunityId);
    if (opportunity.opportunityId === 'opp-cascade') return phase1SourceRows(opportunity, score, { sellerName: 'Casey Structured Seller' });
    if (opportunity.opportunityId === 'opp-evergreen') return phase1SourceRows(opportunity, score, { annualProfit: 535000 });
    return phase1SourceRows(opportunity, score);
  });
  const crmSubmissions = canonicalOpportunities.map((opportunity) => ({
    opportunityId: opportunity.opportunityId,
    id: `crm-${opportunity.opportunityId}`,
    status: 'review',
    company: opportunity.name,
    sellerName: opportunity.opportunityId === 'opp-cascade' ? 'Casey CRM Seller' : 'Morgan CRM Seller',
    sellerEmail: '',
    brokerName: 'Riley CRM Broker',
    brokerEmail: 'riley.broker@example.test',
    brokerPhone: '503-555-0121',
    operatorContactNotes: 'Broker prefers scheduled calls.',
    updatedAt: '2026-08-29T19:00:00.000Z',
  }));
  const cimRequests = canonicalOpportunities.map((opportunity) => ({ opportunityId: opportunity.opportunityId, id: `cim-${opportunity.opportunityId}`, status: 'documents-received', updatedAt: '2026-08-29T19:00:00.000Z' }));
  return {
    // Provider-shaped inputs remain independent; responses are composed below.
    canonicalOpportunities,
    scoreRows,
    sourceObservations,
    operatorFacts: [
      { opportunityId: 'opp-evergreen', id: 'fact-evergreen-broker', field: 'broker_name', value: 'Riley Verified Broker', verified: true, actor: 'phase1-admin', note: 'Broker identity confirmed by phone.', createdAt: '2026-08-29T18:00:00.000Z', updatedAt: '2026-08-29T18:00:00.000Z' },
      { opportunityId: 'opp-evergreen', id: 'fact-evergreen-broker-phone', field: 'broker_phone', value: '503-555-0198', verified: true, actor: 'phase1-admin', note: 'Direct broker callback number verified by phone.', createdAt: '2026-08-29T18:05:00.000Z', updatedAt: '2026-08-29T18:05:00.000Z' },
    ],
    crmSubmissions,
    crmCommunications: canonicalOpportunities.flatMap((opportunity) => [
      { opportunityId: opportunity.opportunityId, id: `crm-email-${opportunity.opportunityId}`, direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T19:00:00.000Z', cimRequestId: `cim-${opportunity.opportunityId}` },
      { opportunityId: opportunity.opportunityId, id: `crm-call-${opportunity.opportunityId}`, direction: 'outbound', channel: 'phone', kind: 'seller-call', occurredAt: '2026-08-28T19:00:00.000Z', cimRequestId: '' },
    ]),
    cimRequests,
    cimCommunications: canonicalOpportunities.map((opportunity) => ({ opportunityId: opportunity.opportunityId, id: `cim-communication-${opportunity.opportunityId}`, direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T19:00:00.000Z', cimRequestId: `cim-${opportunity.opportunityId}` })),
    activities: [{ opportunityId: 'opp-evergreen', id: 'activity-evergreen-change', eventType: 'opportunity-rescored', summary: 'Core source evidence changed and returned the opportunity to Needs Review.', createdAt: '2026-08-30T15:00:00.000Z', actor: 'deal-hunter' }],
    dispositions: [{ opportunityId: 'opp-evergreen', id: 'disposition-evergreen-prior', disposition: 'dismissed', reason: 'timing', note: 'Previously passed, then restored after updated economics.', dismissedAt: '2026-08-20T18:00:00.000Z', dismissedBy: 'phase1-admin', restoredAt: '2026-08-21T18:00:00.000Z', restoredBy: 'phase1-admin' }],
    requests: [],
    apiRequests: [],
    unexpectedRequests: [],
    unexpectedApiRequests: [],
    offOriginRequests: [],
    actionPayloads: [],
    factPayloads: [],
    brokerPreparePayloads: [],
    brokerApprovePayloads: [],
    brokerApprovalCount: 0,
    brokerDetailLoads: {},
    followUpStartPayloads: [],
    followUpStopPayloads: [],
    followUpPreparePayloads: [],
    followUpApprovePayloads: [],
    followUpApprovalCount: 0,
    followUpProviderCalls: 0,
    automaticFollowUpRuns: 0,
    lastFollowUpPreparationByRequest: {},
    brokerMaterialsByOpportunity: Object.fromEntries(canonicalOpportunities.map((opportunity) => [opportunity.opportunityId, {
      recipientOptions: [{
        recipientContactRef: `contact-${opportunity.opportunityId}-structured`,
        email: `broker-${opportunity.opportunityId}@example.test`,
        displayName: 'Riley Structured Broker',
        provenance: 'structured_source',
        provenanceLabel: `Deal Hunter Google Sheet · ${opportunity.dealKey}-sheet`,
        primary: true,
      }],
      warnings: [],
      sendBlockers: [],
      existingRequest: null,
      multipleContacts: false,
      approvalMode: 'success',
      detailFailuresRemaining: 0,
      allowBrokerVerification: false,
    }])),
    sessionRole: 'admin',
  };
}

function phase1CurrentDisposition(state, opportunityId) {
  return state.dispositions.find((disposition) => disposition.opportunityId === opportunityId
    && disposition.disposition === 'dismissed'
    && !disposition.restoredAt) || null;
}

function phase1CurrentOpportunity(state, opportunityId) {
  const canonical = state.canonicalOpportunities.find((opportunity) => opportunity.opportunityId === opportunityId);
  const score = state.scoreRows.find((row) => row.opportunityId === opportunityId);
  if (!canonical || !score) return null;
  const disposition = phase1CurrentDisposition(state, opportunityId);
  const submission = state.crmSubmissions.find((row) => row.opportunityId === opportunityId);
  const cimRequest = state.cimRequests.find((row) => row.opportunityId === opportunityId);
  return {
    ...canonical,
    ...score,
    workflow: { crmStatus: submission?.status || '', cimStatus: cimRequest?.status || '' },
    dismissed: Boolean(disposition),
    dismissedReason: disposition?.reason || '',
  };
}

function phase1CurrentOpportunities(state) {
  return state.canonicalOpportunities.map((opportunity) => phase1CurrentOpportunity(state, opportunity.opportunityId));
}

function phase1DetailOpportunity(state, opportunityId) {
  const current = phase1CurrentOpportunity(state, opportunityId);
  if (!current) return null;
  const sources = state.sourceObservations
    .filter((source) => source.opportunityId === opportunityId)
    .sort((left, right) => Date.parse(right.observedAt || '') - Date.parse(left.observedAt || ''));
  const value = (...fields) => {
    for (const source of sources) {
      for (const field of fields) {
        if (source.values[field] !== undefined && source.values[field] !== '') return source.values[field];
      }
    }
    return '';
  };
  const number = (fallback, ...fields) => {
    const raw = value(...fields);
    if (raw === '') return fallback;
    const sourceValue = Number(raw);
    return Number.isFinite(sourceValue) ? sourceValue : fallback;
  };
  const city = value('city') || current.geography.city;
  const stateCode = value('state') || current.geography.state;
  const location = value('location') || [city, stateCode].filter(Boolean).join(', ') || current.geography.label;
  return {
    ...current,
    name: current.name || value('name', 'business_name') || 'Unnamed opportunity',
    state: stateCode,
    listingUrl: value('listing_url') || current.listingUrl,
    geography: { city, state: stateCode, label: location },
    industry: value('industry') || current.industry,
    financials: {
      annualProfit: number(current.financials.annualProfit, 'annual_profit', 'ttm_ebitda'),
      annualRevenue: number(current.financials.annualRevenue, 'annual_revenue', 'ttm_revenue'),
      askingPrice: number(current.financials.askingPrice, 'asking_price'),
      profitMultiple: number(current.financials.profitMultiple, 'profit_multiple', 'ebitda_multiple'),
    },
    observationFreshness: sources.find((source) => source.observedAt)?.observedAt || current.observationFreshness,
  };
}

function phase1QueueRow(opportunity) {
  return {
    opportunityId: opportunity.opportunityId,
    dealKey: opportunity.dealKey,
    name: opportunity.name,
    state: opportunity.state,
    listingUrl: opportunity.listingUrl,
    fitScore: opportunity.fitScore,
    scoreStatus: opportunity.scoreStatus,
    confidence: opportunity.confidence,
    completenessScore: opportunity.completenessScore,
    missingEvidenceCount: opportunity.missingEvidenceCount,
    contradictionCount: opportunity.contradictionCount,
    shouldRemove: opportunity.shouldRemove,
    highFit: opportunity.highFit,
    geography: { ...opportunity.geography },
    industry: opportunity.industry,
    financials: { ...opportunity.financials },
    topStrength: opportunity.topStrength,
    topConcern: opportunity.topConcern,
    workflow: { ...opportunity.workflow },
    observationFreshness: opportunity.observationFreshness,
    operatorPriority: opportunity.operatorPriority,
    reviewed: opportunity.reviewed,
    reviewedAt: opportunity.reviewedAt,
    reviewedBy: opportunity.reviewedBy,
    changedSinceReview: opportunity.changedSinceReview,
    dismissed: opportunity.dismissed,
    dismissedReason: opportunity.dismissedReason,
    scoredAt: opportunity.scoredAt,
    scoreFingerprint: opportunity.scoreFingerprint,
    rulesVersion: opportunity.rulesVersion,
  };
}

function phase1Summary(state) {
  const current = phase1CurrentOpportunities(state).filter((opportunity) => !opportunity.dismissed);
  return {
    needsReview: current.filter((opportunity) => !opportunity.reviewed || opportunity.changedSinceReview).length,
    highPriority: current.filter((opportunity) => opportunity.highFit || ['urgent', 'high'].includes(opportunity.operatorPriority)).length,
    watchlist: current.filter((opportunity) => (opportunity.fitScore >= 60 && opportunity.fitScore < 75) || opportunity.operatorPriority === 'watch').length,
    lowConfidence: current.filter((opportunity) => opportunity.confidence === 'low' || opportunity.contradictionCount > 0).length,
    currentOpportunities: current.length,
  };
}

function phase1AcquisitionOrder(left, right) {
  const operatorRank = (opportunity) => (['urgent', 'high'].includes(opportunity.operatorPriority) ? 1 : 0);
  const changedHighFitRank = (opportunity) => (opportunity.highFit && (!opportunity.reviewed || opportunity.changedSinceReview) ? 1 : 0);
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  return operatorRank(right) - operatorRank(left)
    || changedHighFitRank(right) - changedHighFitRank(left)
    || right.fitScore - left.fitScore
    || confidenceRank[right.confidence] - confidenceRank[left.confidence]
    || Date.parse(right.observationFreshness) - Date.parse(left.observationFreshness)
    || left.opportunityId.localeCompare(right.opportunityId);
}

function phase1QueueResponse(state, url) {
  const view = url.searchParams.get('view');
  const sort = url.searchParams.get('sort');
  const direction = url.searchParams.get('direction');
  const page = Number(url.searchParams.get('page'));
  const pageSize = Number(url.searchParams.get('pageSize'));
  if (!['needs-review', 'high-priority', 'watchlist', 'low-confidence', 'dismissed', 'all'].includes(view)) {
    throw new Error(`Phase 1 fixture received an invalid queue view: ${view}`);
  }
  if (!['acquisition-priority', 'fit-score', 'confidence', 'scored-at', 'name'].includes(sort)) {
    throw new Error(`Phase 1 fixture received an invalid queue sort: ${sort}`);
  }
  if (direction !== 'desc' || !Number.isInteger(page) || page < 1 || pageSize !== 25) {
    throw new Error(`Phase 1 fixture received malformed pagination: ${url.search}`);
  }

  let rows = phase1CurrentOpportunities(state).filter((opportunity) => {
    if (view === 'needs-review') return !opportunity.dismissed && (!opportunity.reviewed || opportunity.changedSinceReview);
    if (view === 'high-priority') return !opportunity.dismissed && (opportunity.highFit || ['urgent', 'high'].includes(opportunity.operatorPriority));
    if (view === 'watchlist') return !opportunity.dismissed && ((opportunity.fitScore >= 60 && opportunity.fitScore < 75) || opportunity.operatorPriority === 'watch');
    if (view === 'low-confidence') return !opportunity.dismissed && (opportunity.confidence === 'low' || opportunity.contradictionCount > 0);
    if (view === 'dismissed') return opportunity.dismissed;
    return !opportunity.dismissed;
  });
  const search = (url.searchParams.get('search') || '').toLowerCase();
  const confidence = url.searchParams.get('confidence') || '';
  const priority = url.searchParams.get('priority') || '';
  if (search) rows = rows.filter((opportunity) => `${opportunity.name} ${opportunity.dealKey}`.toLowerCase().includes(search));
  if (confidence) rows = rows.filter((opportunity) => opportunity.confidence === confidence);
  if (priority) rows = rows.filter((opportunity) => opportunity.operatorPriority === priority);
  if (sort === 'acquisition-priority') rows.sort(phase1AcquisitionOrder);
  if (sort === 'fit-score') rows.sort((left, right) => right.fitScore - left.fitScore || left.opportunityId.localeCompare(right.opportunityId));
  if (sort === 'confidence') rows.sort((left, right) => ({ high: 3, medium: 2, low: 1 })[right.confidence] - ({ high: 3, medium: 2, low: 1 })[left.confidence]);
  if (sort === 'scored-at') rows.sort((left, right) => Date.parse(right.scoredAt) - Date.parse(left.scoredAt));
  if (sort === 'name') rows.sort((left, right) => left.name.localeCompare(right.name));
  const total = rows.length;
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);
  return {
    success: true,
    ok: true,
    view,
    sort,
    direction,
    rows: paged.map(phase1QueueRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary: phase1Summary(state),
    sourceHealth: { healthy: true, generatedAt: '2026-08-30T18:00:00.000Z', issues: [] },
    views: ['needs-review', 'high-priority', 'watchlist', 'low-confidence', 'dismissed', 'all'],
    priorities: ['urgent', 'high', 'normal', 'watch'],
  };
}

function phase1EffectiveFacts(state, opportunityId) {
  const effective = {};
  const sources = state.sourceObservations.filter((source) => source.opportunityId === opportunityId);
  for (const source of sources) {
    for (const field of ['seller_name', 'seller_phone', 'broker_name', 'broker_company', 'broker_email', 'broker_phone', 'reason_for_sale', 'real_estate_included', 'seller_financing', 'management_structure']) {
      if (!effective[field] && source.values[field]) effective[field] = { value: source.values[field], provenance: 'structured-source', verified: false, actor: '', note: '' };
    }
    if (!effective.broker_phone && /^\+?[\d().\-\s]{7,}$/.test(source.values.broker_contact || '')) {
      effective.broker_phone = { value: source.values.broker_contact, provenance: 'structured-source', verified: false, actor: '', note: '' };
    }
  }
  const submission = state.crmSubmissions.find((row) => row.opportunityId === opportunityId);
  const crmFields = {
    seller_name: submission?.sellerName,
    seller_email: submission?.sellerEmail,
    broker_name: submission?.brokerName,
    broker_email: submission?.brokerEmail,
    broker_phone: submission?.brokerPhone,
    operator_contact_notes: submission?.operatorContactNotes,
  };
  for (const [field, value] of Object.entries(crmFields)) {
    if (value) effective[field] = { value, provenance: 'crm', verified: false, actor: '', note: '' };
  }
  for (const fact of state.operatorFacts.filter((row) => row.opportunityId === opportunityId)) {
    effective[fact.field] = {
      value: fact.value,
      provenance: 'operator',
      verified: fact.verified,
      actor: fact.actor,
      note: fact.note,
    };
  }
  return effective;
}

function phase2BrokerProjection(state, opportunityId) {
  const opportunity = phase1CurrentOpportunity(state, opportunityId);
  const fixture = state.brokerMaterialsByOpportunity[opportunityId];
  if (!opportunity || !fixture) return undefined;
  const pursued = opportunity.operatorPriority === 'high'
    && opportunity.reviewed
    && !opportunity.changedSinceReview
    && !opportunity.dismissed;
  const preparationBlockers = fixture.existingRequest
    ? []
    : !pursued
      ? [{ code: 'pursue_required', message: 'Pursue this opportunity before requesting broker materials.' }]
      : fixture.recipientOptions.length
        ? []
        : [{ code: 'broker_email_required', message: 'Add and verify a broker email before preparing this request.' }];
  return {
    existingRequest: fixture.existingRequest,
    pursued,
    preparationBlockers,
    sendBlockers: fixture.sendBlockers,
    warnings: fixture.warnings,
    recipientOptions: fixture.recipientOptions,
  };
}

function phase2PreparedResponse(state, opportunityId, body) {
  const fixture = state.brokerMaterialsByOpportunity[opportunityId];
  const opportunity = phase1CurrentOpportunity(state, opportunityId);
  const selected = fixture.recipientOptions.find((option) => option.recipientContactRef === body.recipientContactRef)
    || fixture.recipientOptions.find((option) => option.primary)
    || fixture.recipientOptions[0];
  const greeting = body.greeting === undefined ? 'Hi Riley,' : body.greeting;
  const subject = `CIM / NDA request for ${opportunity.name}`;
  const messageBody = `${greeting}\n\nPlease share the CIM and NDA for ${opportunity.name}.\n\nThank you,\nMathew`;
  return {
    success: true,
    previewOnly: state.sessionRole !== 'admin',
    ...(state.sessionRole === 'admin' ? {
      preparationToken: `signed-${opportunityId}-${state.brokerPreparePayloads.length}`,
      proposalDigest: String(state.brokerPreparePayloads.length).padStart(64, 'a'),
    } : {}),
    preparedAt: '2026-09-01T17:00:00.000Z',
    expiresAt: '2099-09-01T17:15:00.000Z',
    review: {
      opportunity: {
        canonicalOpportunityId: opportunityId,
        displayName: opportunity.name,
        sourceLabel: 'Deal Hunter Google Sheet',
        pursued: true,
        current: true,
        score: opportunity.fitScore,
        automatedScoreThreshold: 75,
        annualProfit: opportunity.financials.annualProfit,
      },
      recipient: {
        contactRef: selected.recipientContactRef,
        displayName: selected.displayName,
        email: selected.email,
        provenance: selected.provenance,
      },
      sender: { displayName: 'Mathew Uckele', email: 'mathew@uckelegroup.com', replyTo: 'reply+browser@example.test' },
      message: {
        requestType: 'cim_request',
        channel: 'email',
        greeting,
        subject,
        body: messageBody,
        templateVersion: 'deal-hunter-cim-manual-stage1-v1',
      },
    },
    recipientOptions: fixture.recipientOptions,
    warnings: fixture.warnings,
    sendBlockers: fixture.sendBlockers,
  };
}

function phase3FollowUps(overrides = {}) {
  return {
    enrolled: true,
    policyVersion: 'deal-hunter-manual-follow-up-v1',
    maximumFollowUps: 5,
    followUpCount: 0,
    currentFollowUpNumber: 1,
    nextFollowUpAt: '2026-09-03T16:00:00.000Z',
    state: 'due',
    terminalReason: '',
    retryEligible: false,
    preparationBlockers: [],
    sendBlockers: [],
    ...overrides,
  };
}

function phase3ExistingRequest(overrides = {}) {
  return {
    id: 'browser-request-opp-cascade',
    status: 'sent',
    requestState: 'provider_accepted',
    deliveryState: 'accepted',
    followUpState: 'not-scheduled',
    recipient: { email: 'broker-opp-cascade@example.test', displayName: 'Riley Structured Broker' },
    subject: 'CIM / NDA request for Cascade Field Compliance',
    createdAt: '2026-09-01T16:00:00.000Z',
    updatedAt: '2026-09-01T16:01:00.000Z',
    requestedAt: '2026-09-01T16:00:00.000Z',
    providerAcceptedAt: '2026-09-01T16:01:00.000Z',
    deliveredAt: '', respondedAt: '', errorSummary: '', canRetry: false, canCorrectRecipient: false,
    retryRoute: '', correctionRoute: '',
    followUps: phase3FollowUps(),
    ...overrides,
  };
}

function phase3PreparedResponse(state, opportunityId, requestId, body) {
  const fixture = state.brokerMaterialsByOpportunity[opportunityId];
  const projection = fixture.existingRequest.followUps;
  const retry = projection.state === 'retry';
  const followUpNumber = projection.currentFollowUpNumber;
  const greeting = retry ? 'Hello Riley,' : body.greeting === undefined ? 'Hello Riley,' : body.greeting;
  const subject = retry ? 'Exact persisted retry subject' : `Follow-Up ${followUpNumber}: ${phase1CurrentOpportunity(state, opportunityId).name}`;
  const messageBody = retry
    ? 'Exact persisted failed communication. This content cannot be edited.'
    : `${greeting}\n\nFollowing up on the CIM and NDA request for ${phase1CurrentOpportunity(state, opportunityId).name}.\n\nThank you,\nMathew`;
  const sequence = state.followUpPreparePayloads.length;
  return {
    success: true,
    previewOnly: state.sessionRole !== 'admin',
    ...(state.sessionRole === 'admin' ? {
      preparationToken: `signed-follow-up-${requestId}-${sequence}`,
      proposalDigest: String(sequence).padStart(64, 'c'),
    } : {}),
    preparedAt: `2026-09-03T16:${String(sequence).padStart(2, '0')}:00.000Z`,
    expiresAt: '2099-09-03T16:16:00.000Z',
    followUps: projection,
    sendBlockers: projection.sendBlockers || [],
    review: {
      mode: retry ? 'exact-retry' : 'first-attempt',
      followUpNumber,
      dueAt: projection.nextFollowUpAt,
      initialRequestedAt: fixture.existingRequest.requestedAt,
      previousAcceptedAt: followUpNumber === 1 ? fixture.existingRequest.providerAcceptedAt : `2026-09-0${followUpNumber}T16:01:00.000Z`,
      recipient: fixture.existingRequest.recipient,
      sender: { displayName: 'Mathew Uckele', email: 'mathew@uckelegroup.com', replyTo: 'reply+browser@example.test' },
      message: {
        greeting,
        greetingEditable: state.sessionRole === 'admin' && !retry,
        subject,
        body: messageBody,
        html: `<p>${messageBody}</p>`,
        templateVersion: `deal-hunter-cim-follow-up-${followUpNumber}-v1`,
      },
      communication: { id: `browser-follow-up-${requestId}-${followUpNumber}`, providerIdempotencyKey: `browser-idempotency-${requestId}-${followUpNumber}` },
    },
  };
}

function phase1DetailResponse(state, opportunityId) {
  const opportunity = phase1DetailOpportunity(state, opportunityId);
  const scoreRow = state.scoreRows.find((score) => score.opportunityId === opportunityId);
  const sourceRows = state.sourceObservations.filter((source) => source.opportunityId === opportunityId);
  const effectiveFacts = phase1EffectiveFacts(state, opportunityId);
  const operatorFacts = state.operatorFacts.filter((fact) => fact.opportunityId === opportunityId).map(({ opportunityId: _opportunityId, ...fact }) => fact);
  const conflictFields = ['annual_profit', 'seller_name'];
  const conflicts = conflictFields.map((field) => ({
    field,
    observations: sourceRows.filter((source) => source.values[field]).map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, sourceRecordId: source.sourceRecordId, value: source.values[field], observedAt: source.observedAt })),
  })).filter((conflict) => new Set(conflict.observations.map((observation) => observation.value)).size > 1);
  const submission = state.crmSubmissions.find((row) => row.opportunityId === opportunityId);
  const sourceProfit = String(scoreRow.financials.annualProfit);
  return {
    opportunity: { ...phase1QueueRow(opportunity), operatorNote: opportunity.operatorNote },
    effectiveFacts,
    operatorFacts,
    sourceObservations: sourceRows.map(({ opportunityId: _opportunityId, ...source }) => ({ ...source, values: { ...source.values }, conflicts })),
    missingCriticalFields: [...(!effectiveFacts.seller_email ? ['seller_email'] : []), ...(!effectiveFacts.broker_phone ? ['broker_phone'] : []), 'customer_concentration'],
    listingUrls: [...new Set(sourceRows.map((source) => source.values.listing_url).filter(Boolean))],
    score: {
      fitScore: opportunity.fitScore,
      scoreStatus: opportunity.scoreStatus,
      confidence: opportunity.confidence,
      completenessScore: opportunity.completenessScore,
      dimensions: phase1DimensionLabels.map((label, index) => ({
        id: label.toLowerCase().replace(/\s+/g, '-'),
        label,
        contribution: [34, 15, 12, 9, 8, 5, 9][index],
        evidence: index === 0 ? [{
          ruleId: 'profit.in-band',
          ruleLabel: 'Profit inside target acquisition band',
          evidenceClass: 'observed',
          field: 'annualProfit',
          value: sourceProfit,
          observedValue: `$${Number(sourceProfit).toLocaleString('en-US')} reported`,
          terms: ['recurring', 'inspection'],
          sourceId: 'sheet-0',
          sourceName: 'Deal Hunter Google Sheet',
          sourceRecordId: `${opportunity.dealKey}-sheet`,
          listingUrl: opportunity.listingUrl,
          // Score evidence is the persisted scoring-time observation. The
          // independently current source row may legitimately be newer.
          observedAt: scoreRow.evidenceObservedAt,
        }] : [],
      })),
      unattributedEvidence: [{
        ruleId: 'market.fragmented',
        ruleLabel: 'Fragmented market signal',
        evidenceClass: 'heuristic',
        field: 'industry',
        value: opportunity.industry,
        observedValue: 'Regional service providers',
        terms: ['fragmented'],
        sourceId: 'deal-os',
        sourceName: 'Deal OS',
        sourceRecordId: `${opportunity.dealKey}-deal-os`,
        observedAt: '2026-08-28T17:00:00.000Z',
      }],
      gates: [],
      appliedCaps: [{ ruleId: 'customer.concentration', reason: 'Customer concentration is unverified', cap: 95 }],
      confidenceReasons: ['Core financial fields are present; customer concentration remains missing.'],
      missingEvidence: ['customerConcentration'],
      summary: {
        strengths: ['Profit and recurring field-service demand fit the acquisition profile.'],
        concerns: ['Customer concentration has not been verified.'],
      },
    },
    brokerMaterials: phase2BrokerProjection(state, opportunityId),
    cimSummary: {
      requests: state.cimRequests.filter((row) => row.opportunityId === opportunityId).map(({ opportunityId: _opportunityId, ...request }) => request),
      communications: state.cimCommunications.filter((row) => row.opportunityId === opportunityId).map(({ opportunityId: _opportunityId, ...communication }) => communication),
    },
    crmSummary: {
      submission: submission ? {
        id: submission.id,
        status: submission.status,
        company: submission.company,
        sellerName: submission.sellerName,
        sellerEmail: submission.sellerEmail,
        brokerName: submission.brokerName,
        brokerEmail: submission.brokerEmail,
        updatedAt: submission.updatedAt,
      } : null,
      communications: state.crmCommunications.filter((row) => row.opportunityId === opportunityId).map(({ opportunityId: _opportunityId, ...communication }) => communication),
      factObservations: Object.entries({ seller_name: submission?.sellerName, broker_name: submission?.brokerName, broker_phone: submission?.brokerPhone }).filter(([, value]) => value).map(([field, value]) => ({ field, value, provenance: 'crm' })),
      conflicts: [{ field: 'broker_name', winningProvenance: effectiveFacts.broker_name.provenance, crmValue: 'Riley CRM Broker' }],
    },
    history: {
      activities: state.activities.filter((activity) => activity.opportunityId === opportunityId).map(({ opportunityId: _opportunityId, ...activity }) => activity),
      dispositions: state.dispositions.filter((disposition) => disposition.opportunityId === opportunityId).map(({ opportunityId: _opportunityId, ...disposition }) => disposition),
      operatorFacts,
      operatorState: {
        priority: opportunity.operatorPriority,
        note: opportunity.operatorNote,
        reviewed: opportunity.reviewed,
        reviewedAt: opportunity.reviewedAt,
        reviewedBy: opportunity.reviewedBy,
      },
    },
  };
}

async function fulfillPhase1Json(route, body, status = 200) {
  await route.fulfill({ contentType: 'application/json', status, body: JSON.stringify(body) });
}

const phase1AppOrigin = 'http://127.0.0.1:4173';

function phase1RequestRecord(request) {
  const url = new URL(request.url());
  return { method: request.method(), path: url.pathname, search: url.search };
}

function phase1RequestSignature({ method, path, search = '' }) {
  return `${method} ${path}${search}`;
}

async function rejectPhase1Request(route, state, reason) {
  const request = route.request();
  const record = phase1RequestRecord(request);
  state.unexpectedApiRequests.push(record);
  if (record.path.startsWith('/api/admin/deal-hunter/')) state.unexpectedRequests?.push(record);
  await fulfillPhase1Json(route, { success: false, error: reason }, 418);
}

async function installPhase1RequestAudit(page, state) {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === phase1AppOrigin && url.pathname.startsWith('/api/')) {
      state.apiRequests.push(phase1RequestRecord(request));
    } else if (url.origin !== phase1AppOrigin) {
      state.offOriginRequests.push({ method: request.method(), url: request.url() });
    }
  });

  // Playwright evaluates matching routes newest-first. Register this guard
  // before the exact local mocks so only those later handlers can bypass it.
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== phase1AppOrigin) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await rejectPhase1Request(route, state, `Unexpected application API request: ${request.method()} ${url.pathname}${url.search}`);
      return;
    }
    await route.continue();
  });

  // Keep this acceptance entirely local without weakening the off-origin
  // guard: strip the public site's remote font hints from the local document
  // fixture before Chromium can initiate either Google Fonts connection.
  await page.route(`${phase1AppOrigin}/admin/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'document') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = await response.text();
    const localBody = body.replace(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, '');
    await route.fulfill({ response, body: localBody });
  });
}

async function installPhase1AdminRoutes(page, state, { commandCenter = false, role = 'admin' } = {}) {
  await page.route('**/api/admin/session', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.search) {
      await rejectPhase1Request(route, state, 'Unexpected admin session request.');
      return;
    }
    await fulfillPhase1Json(route, {
      authenticated: true,
      username: 'phase1-admin',
      role,
      authMode: 'hybrid',
      magicLinkEnabled: true,
      passwordEnabled: true,
    });
  });

  await page.route('**/api/admin/onboarding', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.search) {
      await rejectPhase1Request(route, state, 'Unexpected admin onboarding request.');
      return;
    }
    await fulfillPhase1Json(route, {
      success: true,
      progress: [
        { tourKey: 'admin-foundations', tourVersion: 1, status: 'completed', lastCompletedStepId: 'foundations-page-guide' },
        { tourKey: 'deal-hunter', tourVersion: 1, status: 'completed', lastCompletedStepId: 'deal-hunter-history' },
      ],
    });
  });

  if (commandCenter) {
    await page.route('**/api/admin/acquisition-command-center', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.search) {
        await rejectPhase1Request(route, state, 'Unexpected acquisition command center request.');
        return;
      }
      await fulfillPhase1Json(route, { success: true, commandCenter: null });
    });
  }
}

function phase1QueueQueryIsClosed(url) {
  const required = ['view', 'page', 'pageSize', 'sort', 'direction'];
  const optional = ['search', 'confidence', 'priority'];
  const keys = [...url.searchParams.keys()];
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (keys.some((key) => url.searchParams.getAll(key).length !== 1)) return false;
  if (required.some((key) => !url.searchParams.has(key))) return false;
  if (url.searchParams.has('confidence') && !['high', 'medium', 'low'].includes(url.searchParams.get('confidence'))) return false;
  if (url.searchParams.has('priority') && !['urgent', 'high', 'normal', 'watch'].includes(url.searchParams.get('priority'))) return false;
  return true;
}

function phase1Body(request) {
  try {
    return request.postDataJSON();
  } catch {
    throw new Error(`Phase 1 fixture received malformed JSON at ${new URL(request.url()).pathname}`);
  }
}

const phase1DispositionReasons = new Set(['not-a-fit', 'unavailable', 'duplicate', 'broker-declined', 'valuation', 'geography', 'timing', 'financing', 'other']);

function phase1DispositionReason(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return phase1DispositionReasons.has(normalized) ? normalized : 'other';
}

async function installPhase1Fixture(page, { role = 'admin' } = {}) {
  const state = createPhase1FixtureState();
  state.sessionRole = role;
  await installPhase1RequestAudit(page, state);
  await installPhase1AdminRoutes(page, state, { role });
  await page.route('**/api/admin/deal-hunter/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    state.requests.push({ method, path, search: url.search });

    if (method === 'GET' && path === '/api/admin/deal-hunter/triage' && phase1QueueQueryIsClosed(url)) {
      try {
        await fulfillPhase1Json(route, phase1QueueResponse(state, url));
      } catch (error) {
        await rejectPhase1Request(route, state, error.message);
      }
      return;
    }

    if (method === 'POST' && path === '/api/admin/deal-hunter/cim-follow-ups/run' && !url.search) {
      const body = phase1Body(request);
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['limit']) || body.limit !== 1) {
        await rejectPhase1Request(route, state, `Malformed automatic follow-up runner payload: ${JSON.stringify(body)}`);
        return;
      }
      state.automaticFollowUpRuns += 1;
      await fulfillPhase1Json(route, { success: true, results: [{ requestId: 'browser-request-opp-cascade', status: 'approval-required' }], providerCalls: 0 });
      return;
    }

    const followUpRouteMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/broker-materials\/follow-ups\/([^/]+)\/(start|stop|prepare|approve)$/);
    if (method === 'POST' && followUpRouteMatch && !url.search) {
      const opportunityId = decodeURIComponent(followUpRouteMatch[1]);
      const requestId = decodeURIComponent(followUpRouteMatch[2]);
      const action = followUpRouteMatch[3];
      const fixture = state.brokerMaterialsByOpportunity[opportunityId];
      const body = phase1Body(request);
      if (!fixture?.existingRequest || fixture.existingRequest.id !== requestId) {
        await rejectPhase1Request(route, state, `Phase 3 request did not match canonical fixture: ${path}`);
        return;
      }

      if (action === 'start') {
        if (state.sessionRole !== 'admin' || Object.keys(body).length !== 0) {
          await rejectPhase1Request(route, state, `Malformed Phase 3 Start payload: ${JSON.stringify(body)}`);
          return;
        }
        state.followUpStartPayloads.push({ method, path, body });
        fixture.existingRequest.followUps = phase3FollowUps({ state: 'scheduled' });
        await fulfillPhase1Json(route, { success: true, canonicalOpportunityId: opportunityId, requestId, followUps: fixture.existingRequest.followUps });
        return;
      }

      if (action === 'stop') {
        const keys = Object.keys(body);
        if (state.sessionRole !== 'admin' || keys.some((key) => key !== 'reason') || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 240))) {
          await rejectPhase1Request(route, state, `Malformed Phase 3 Stop payload: ${JSON.stringify(body)}`);
          return;
        }
        state.followUpStopPayloads.push({ method, path, body });
        fixture.existingRequest.followUps = phase3FollowUps({
          state: 'stopped', followUpCount: fixture.existingRequest.followUps.followUpCount,
          currentFollowUpNumber: null, nextFollowUpAt: '',
        });
        await fulfillPhase1Json(route, { success: true, canonicalOpportunityId: opportunityId, requestId, followUps: fixture.existingRequest.followUps });
        return;
      }

      if (action === 'prepare') {
        const keys = Object.keys(body);
        if (keys.some((key) => key !== 'greeting') || (body.greeting !== undefined && typeof body.greeting !== 'string')) {
          await rejectPhase1Request(route, state, `Malformed Phase 3 Prepare payload: ${JSON.stringify(body)}`);
          return;
        }
        if (!['due', 'overdue', 'retry'].includes(fixture.existingRequest.followUps.state)) {
          await fulfillPhase1Json(route, { success: false, code: 'not_due', error: 'This follow-up is not due yet.' }, 409);
          return;
        }
        if (fixture.existingRequest.followUps.state === 'retry' && Object.hasOwn(body, 'greeting')) {
          await fulfillPhase1Json(route, { success: false, code: 'retry_message_immutable', error: 'A retry must use the exact persisted communication.' }, 409);
          return;
        }
        state.followUpPreparePayloads.push({ method, path, body });
        const prepared = phase3PreparedResponse(state, opportunityId, requestId, body);
        state.lastFollowUpPreparationByRequest[requestId] = prepared;
        await fulfillPhase1Json(route, prepared);
        return;
      }

      const prepared = state.lastFollowUpPreparationByRequest[requestId];
      if (state.sessionRole !== 'admin'
        || !prepared
        || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['approvedProposalDigest', 'preparationToken'])
        || body.preparationToken !== prepared.preparationToken
        || body.approvedProposalDigest !== prepared.proposalDigest) {
        await rejectPhase1Request(route, state, `Malformed Phase 3 Approve payload: ${JSON.stringify(body)}`);
        return;
      }
      state.followUpApprovalCount += 1;
      state.followUpApprovePayloads.push({ method, path, body });
      const approvalMode = fixture.followUpApprovalMode || 'success';
      if (approvalMode === 'blocked') {
        const sendBlockers = fixture.existingRequest.followUps.sendBlockers?.length
          ? fixture.existingRequest.followUps.sendBlockers
          : [{ code: 'cim_outreach_paused', message: 'Deal Hunter CIM outreach is globally paused.' }];
        fixture.existingRequest.followUps = { ...fixture.existingRequest.followUps, sendBlockers };
        await fulfillPhase1Json(route, { success: false, code: 'send_blocked', error: sendBlockers[0].message, sendBlockers, followUps: fixture.existingRequest.followUps }, 409);
        return;
      }

      state.followUpProviderCalls += 1;
      if (approvalMode === 'unknown') {
        fixture.existingRequest.followUps = phase3FollowUps({ state: 'ambiguous' });
        await route.abort('failed');
        return;
      }
      if (approvalMode === 'failure') {
        fixture.existingRequest.followUps = phase3FollowUps({ state: 'retry', retryEligible: true });
        await fulfillPhase1Json(route, { success: false, code: 'provider_failed', error: 'The provider did not accept the approved follow-up. A fresh review is required before an exact retry.', durableResult: { requestId, followUps: fixture.existingRequest.followUps } }, 502);
        return;
      }

      const sentNumber = prepared.review.followUpNumber;
      const completed = sentNumber >= 5;
      fixture.existingRequest.deliveryState = approvalMode === 'development-only' ? 'development-only' : 'accepted';
      fixture.existingRequest.followUps = phase3FollowUps({
        followUpCount: sentNumber,
        currentFollowUpNumber: completed ? null : sentNumber + 1,
        nextFollowUpAt: completed ? '' : `2026-09-${String(sentNumber + 3).padStart(2, '0')}T16:00:00.000Z`,
        state: completed ? 'completed' : 'scheduled',
      });
      await fulfillPhase1Json(route, {
        success: true,
        code: approvalMode === 'development-only' ? 'development_only' : '',
        canonicalOpportunityId: opportunityId,
        requestId,
        durableResult: { requestId, followUps: fixture.existingRequest.followUps },
      });
      return;
    }

    const prepareMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/broker-materials\/prepare$/);
    if (method === 'POST' && prepareMatch && !url.search) {
      const opportunityId = decodeURIComponent(prepareMatch[1]);
      const fixture = state.brokerMaterialsByOpportunity[opportunityId];
      const projection = phase2BrokerProjection(state, opportunityId);
      const body = phase1Body(request);
      const keys = Object.keys(body).sort();
      if (!fixture || keys.some((key) => !['greeting', 'recipientContactRef'].includes(key))) {
        await rejectPhase1Request(route, state, `Malformed Broker Materials prepare payload: ${JSON.stringify(body)}`);
        return;
      }
      if ((body.greeting !== undefined && typeof body.greeting !== 'string')
        || (body.recipientContactRef !== undefined && typeof body.recipientContactRef !== 'string')) {
        await rejectPhase1Request(route, state, `Malformed Broker Materials prepare values: ${JSON.stringify(body)}`);
        return;
      }
      state.brokerPreparePayloads.push({ method, path, body });
      if (projection.preparationBlockers.length) {
        await fulfillPhase1Json(route, { success: false, code: projection.preparationBlockers[0].code, error: projection.preparationBlockers[0].message }, 409);
        return;
      }
      if (fixture.multipleContacts && !body.recipientContactRef) {
        await fulfillPhase1Json(route, {
          success: false,
          code: 'recipient_selection_required',
          error: 'Select one authoritative broker recipient before preparing the request.',
          recipientOptions: fixture.recipientOptions,
          warnings: fixture.warnings,
          sendBlockers: fixture.sendBlockers,
        }, 409);
        return;
      }
      if (body.recipientContactRef && !fixture.recipientOptions.some((option) => option.recipientContactRef === body.recipientContactRef)) {
        await fulfillPhase1Json(route, { success: false, code: 'recipient_stale', error: 'The selected recipient is no longer authoritative.' }, 409);
        return;
      }
      const prepared = phase2PreparedResponse(state, opportunityId, body);
      state.lastBrokerPreparationByOpportunity ||= {};
      state.lastBrokerPreparationByOpportunity[opportunityId] = prepared;
      await fulfillPhase1Json(route, prepared);
      return;
    }

    const approveMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/broker-materials\/approve$/);
    if (method === 'POST' && approveMatch && !url.search) {
      const opportunityId = decodeURIComponent(approveMatch[1]);
      const fixture = state.brokerMaterialsByOpportunity[opportunityId];
      const prepared = state.lastBrokerPreparationByOpportunity?.[opportunityId];
      const body = phase1Body(request);
      const keys = Object.keys(body).sort();
      if (state.sessionRole !== 'admin'
        || !fixture
        || !prepared
        || JSON.stringify(keys) !== JSON.stringify(['approvedProposalDigest', 'preparationToken'])
        || body.preparationToken !== prepared.preparationToken
        || body.approvedProposalDigest !== prepared.proposalDigest) {
        await rejectPhase1Request(route, state, `Malformed Broker Materials approval payload: ${JSON.stringify(body)}`);
        return;
      }
      state.brokerApprovalCount += 1;
      state.brokerApprovePayloads.push({ method, path, body });
      fixture.existingRequest = {
        id: `browser-request-${opportunityId}`,
        status: 'sent',
        requestState: 'provider_accepted',
        deliveryState: 'accepted',
        followUpState: 'not-scheduled',
        recipient: prepared.review.recipient,
        subject: prepared.review.message.subject,
        createdAt: '2026-09-01T17:00:30.000Z',
        updatedAt: '2026-09-01T17:00:31.000Z',
        requestedAt: '2026-09-01T17:00:30.000Z',
        providerAcceptedAt: '2026-09-01T17:00:31.000Z',
        deliveredAt: '',
        respondedAt: '',
        errorSummary: '',
        canRetry: false,
        canCorrectRecipient: false,
        retryRoute: '',
        correctionRoute: '',
      };
      if (fixture.approvalMode === 'unknown') {
        fixture.detailFailuresRemaining = 1;
        await route.abort('failed');
        return;
      }
      await fulfillPhase1Json(route, {
        success: true,
        canonicalOpportunityId: opportunityId,
        durableResult: { cimRequest: fixture.existingRequest },
      });
      return;
    }

    const factMatch = path.match(/^\/api\/admin\/deal-hunter\/opportunities\/([^/]+)\/facts\/([^/]+)$/);
    if (method === 'PUT' && factMatch && !url.search) {
      const opportunityId = decodeURIComponent(factMatch[1]);
      const field = decodeURIComponent(factMatch[2]);
      const opportunity = state.canonicalOpportunities.find((item) => item.opportunityId === opportunityId);
      const score = state.scoreRows.find((item) => item.opportunityId === opportunityId);
      const body = phase1Body(request);
      const brokerFixture = state.brokerMaterialsByOpportunity[opportunityId];
      const allowedBrokerVerification = field === 'broker_email' && brokerFixture?.allowBrokerVerification;
      if (!opportunity || !score || (field !== 'seller_name' && !allowedBrokerVerification)) throw new Error(`Unexpected Phase 1 fact target: ${path}`);
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['note', 'value', 'verified'])) {
        throw new Error(`Malformed Phase 1 fact payload keys: ${JSON.stringify(body)}`);
      }
      const validSellerFact = field === 'seller_name'
        && body.verified === true
        && body.value === 'Morgan Verified Seller'
        && body.note === 'Confirmed directly with the seller on Aug 30.';
      const validBrokerFact = allowedBrokerVerification
        && body.verified === true
        && body.value === 'verified-browser-broker@example.test'
        && body.note === 'Verified for the broker materials request.';
      if (!validSellerFact && !validBrokerFact) {
        throw new Error(`Malformed Phase 1 fact payload values: ${JSON.stringify(body)}`);
      }
      const machineScore = score.fitScore;
      const fact = {
        opportunityId,
        id: 'fact-evergreen-seller',
        field,
        value: body.value,
        verified: true,
        actor: 'phase1-admin',
        note: body.note,
        createdAt: '2026-08-30T20:00:00.000Z',
        updatedAt: '2026-08-30T20:00:00.000Z',
      };
      state.operatorFacts = [...state.operatorFacts.filter((item) => item.opportunityId !== opportunityId || item.field !== field), fact];
      if (validBrokerFact) {
        brokerFixture.recipientOptions = [{
          recipientContactRef: `contact-${opportunityId}-verified-fact`,
          email: body.value,
          displayName: 'Verified Browser Broker',
          provenance: 'operator_verified_fact',
          provenanceLabel: 'Operator verified broker email',
          primary: true,
        }];
      }
      if (score.fitScore !== machineScore) throw new Error('Verified fact changed the machine score in the Phase 1 fixture.');
      state.factPayloads.push({ method, path, body });
      const { opportunityId: _opportunityId, ...responseFact } = fact;
      await fulfillPhase1Json(route, { success: true, fact: responseFact });
      return;
    }

    const actionMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/action$/);
    if (method === 'POST' && actionMatch && !url.search) {
      const opportunityId = decodeURIComponent(actionMatch[1]);
      const opportunity = state.canonicalOpportunities.find((item) => item.opportunityId === opportunityId);
      const score = state.scoreRows.find((item) => item.opportunityId === opportunityId);
      const body = phase1Body(request);
      if (!opportunity || !score || !['pursue', 'watch', 'pass'].includes(body.action)) throw new Error(`Malformed Phase 1 action target or action: ${path}`);
      const expectedKeys = body.action === 'pass' ? ['action', 'note', 'reason'] : ['action'];
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)) {
        throw new Error(`Malformed Phase 1 action payload keys: ${JSON.stringify(body)}`);
      }
      if (body.action === 'pass' && (body.reason !== 'valuation' || body.note !== 'Asking price exceeds the current acquisition valuation.')) {
        throw new Error(`Malformed Phase 1 Pass payload values: ${JSON.stringify(body)}`);
      }
      if (phase1CurrentDisposition(state, opportunityId)) {
        await fulfillPhase1Json(route, { success: false, error: 'Passed opportunities must be restored before another triage action.' }, 409);
        return;
      }
      const machineScore = score.fitScore;
      score.reviewed = true;
      score.reviewedAt = '2026-08-30T20:05:00.000Z';
      score.reviewedBy = 'phase1-admin';
      score.changedSinceReview = false;
      if (body.action === 'pursue') score.operatorPriority = 'high';
      if (body.action === 'watch') score.operatorPriority = 'watch';
      let disposition = null;
      if (body.action === 'pass') {
        disposition = {
          opportunityId,
          id: 'disposition-cascade-phase1',
          disposition: 'dismissed',
          reason: phase1DispositionReason(body.reason),
          note: body.note,
          dismissedAt: '2026-08-30T20:05:00.000Z',
          dismissedBy: 'phase1-admin',
        };
        state.dispositions = [disposition, ...state.dispositions];
        const submission = state.crmSubmissions.find((row) => row.opportunityId === opportunityId);
        if (submission) {
          submission.status = 'archived';
          submission.updatedAt = '2026-08-30T20:05:00.000Z';
        }
        const cimRequest = state.cimRequests.find((row) => row.opportunityId === opportunityId);
        if (cimRequest) {
          cimRequest.status = 'stopped';
          cimRequest.updatedAt = '2026-08-30T20:05:00.000Z';
        }
      }
      state.activities = [{
        opportunityId,
        id: `activity-${opportunity.opportunityId}-${body.action}`,
        eventType: body.action === 'pass' ? 'opportunity-disposition' : 'opportunity-triaged',
        summary: body.action === 'pursue' ? 'Priority high; marked reviewed.' : body.action === 'watch' ? 'Priority watch; marked reviewed.' : 'Passed with a durable disposition; marked reviewed.',
        createdAt: '2026-08-30T20:05:00.000Z',
        actor: 'phase1-admin',
      }, ...state.activities];
      if (score.fitScore !== machineScore) throw new Error(`${body.action} changed the machine score in the Phase 1 fixture.`);
      state.actionPayloads.push({ method, path, body, machineScore });
      const current = phase1CurrentOpportunity(state, opportunityId);
      await fulfillPhase1Json(route, {
        success: true,
        ok: true,
        action: body.action,
        opportunity: phase1QueueRow(current),
        ...(disposition ? { disposition: (({ opportunityId: _opportunityId, ...row }) => row)(disposition) } : {}),
      });
      return;
    }

    const detailMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)$/);
    if (method === 'GET' && detailMatch && !url.search) {
      const opportunityId = decodeURIComponent(detailMatch[1]);
      const opportunity = state.canonicalOpportunities.find((item) => item.opportunityId === opportunityId);
      if (!opportunity) throw new Error(`Unexpected Phase 1 detail target: ${path}`);
      state.brokerDetailLoads[opportunityId] = (state.brokerDetailLoads[opportunityId] || 0) + 1;
      const fixture = state.brokerMaterialsByOpportunity[opportunityId];
      if (fixture?.detailFailuresRemaining > 0) {
        fixture.detailFailuresRemaining -= 1;
        await route.abort('failed');
        return;
      }
      await fulfillPhase1Json(route, phase1DetailResponse(state, opportunityId));
      return;
    }

    await rejectPhase1Request(route, state, `Unexpected Deal Hunter request: ${method} ${path}${url.search}`);
  });
  return state;
}

async function installPhase1OperationsFixture(page) {
  const state = createPhase1FixtureState();
  await installPhase1RequestAudit(page, state);
  await installPhase1AdminRoutes(page, state, { commandCenter: true });

  await page.route('**/api/admin/deal-hunter/triage?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const inboxSearch = '?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc';
    const operationsSearch = '?view=needs-review&page=1&pageSize=25';
    if (request.method() !== 'GET' || ![inboxSearch, operationsSearch].includes(url.search)) {
      await rejectPhase1Request(route, state, `Unexpected Operations triage request: ${request.method()} ${url.pathname}${url.search}`);
      return;
    }
    if (url.search === inboxSearch) {
      await fulfillPhase1Json(route, phase1QueueResponse(state, url));
      return;
    }
    await fulfillPhase1Json(route, {
      success: true,
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
  });

  await page.route('**/api/admin/deal-hunter/review', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.search) {
      await rejectPhase1Request(route, state, 'Unexpected Operations source-review request.');
      return;
    }
    await fulfillPhase1Json(route, {
      success: true,
      review: {
        reviewMode: 'daily',
        lookbackDays: 1,
        totals: { reviewedDeals: 0, newMatches: 0, qualified: 0, cimReady: 0, watchlist: 0, removalCandidates: 0, crmEligible: 0 },
        sources: [{ id: 'sheet-0', name: 'SMB Deal Hunter Google Sheet', mode: 'csv', fetched: true, required: true, sourceRole: 'required-primary', rowCount: 0 }],
        disabledSources: [],
        criteriaRecommendations: [],
        newlySeenMatches: [],
        qualified: [],
        watchlist: [],
        removalCandidates: [],
        coverageWarnings: [],
        identityExceptions: [],
      },
    });
  });

  await page.route('**/api/admin/deal-hunter/cim-requests?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const expectedSearch = '?page=1&pageSize=25&sort=first_requested_at&direction=desc';
    if (request.method() !== 'GET' || url.search !== expectedSearch) {
      await rejectPhase1Request(route, state, `Unexpected Operations CIM-history request: ${request.method()} ${url.pathname}${url.search}`);
      return;
    }
    await fulfillPhase1Json(route, { success: true, rows: [], counts: {}, total: 0, page: 1, pageSize: 25, totalPages: 1 });
  });

  await page.route('**/api/admin/communications/unassigned?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.search !== '?page=1&pageSize=25') {
      await rejectPhase1Request(route, state, `Unexpected Operations unassigned-communications request: ${request.method()} ${url.pathname}${url.search}`);
      return;
    }
    await fulfillPhase1Json(route, { success: true, rows: [], total: 0, page: 1, pageSize: 25 });
  });

  return state;
}

async function expectPhase1Summary(page, label, value) {
  const inbox = page.getByRole('region', { name: 'Acquisition Inbox' });
  const labelNode = inbox.locator('p').filter({ hasText: new RegExp(`^${label}$`) }).first();
  await expect(labelNode).toHaveText(label);
  await expect(labelNode.locator('..').locator('p').first()).toHaveText(String(value));
}

async function expectPhase1DetailValue(dialog, label, value) {
  const labelNode = dialog.getByText(label, { exact: true }).first();
  await expect(labelNode).toBeVisible();
  await expect(labelNode.locator('..')).toContainText(String(value));
}

async function expectHorizontallyReachable(locator, viewportWidth) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 0.5);
}

function markBrokerOpportunityPursued(state, opportunityId = 'opp-cascade') {
  const score = state.scoreRows.find((row) => row.opportunityId === opportunityId);
  score.operatorPriority = 'high';
  score.reviewed = true;
  score.reviewedAt = '2026-09-01T16:55:00.000Z';
  score.reviewedBy = 'phase1-admin';
  score.changedSinceReview = false;
}

async function openBrokerOpportunity(page, name = 'Cascade Field Compliance') {
  await page.goto('/admin/deal-hunter');
  await expect(page.getByRole('list', { name: 'Opportunity queue' })).toBeVisible();
  const trigger = page.getByRole('button', { name: `Open ${name}` });
  if (await trigger.count() === 0) {
    await page.getByRole('tab', { name: 'All' }).click();
    await expect(trigger).toBeVisible();
  }
  await trigger.click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return { dialog, trigger, card: dialog.getByRole('region', { name: 'Broker Materials' }) };
}

function expectBrokerRouteAuditClean(state) {
  expect(state.unexpectedRequests).toEqual([]);
  expect(state.unexpectedApiRequests).toEqual([]);
  expect(state.offOriginRequests).toEqual([]);
  expect(state.requests.filter(({ path }) => /provider|reconcil|send-again|retry-approval/i.test(path))).toEqual([]);
}

test('overview summary cards are keyboard-accessible drill-down links', async ({ page }) => {
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin');

  await expect(page.getByRole('link', { name: 'View Total Records: 15' })).toHaveAttribute('href', '/admin/crm');
  await expect(page.getByRole('link', { name: 'View Action Items: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=action-items');
  await expect(page.getByRole('link', { name: 'View Overdue: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=overdue');
  await expect(page.getByRole('link', { name: 'View Due Soon: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=due-soon');
  await expect(page.getByRole('link', { name: 'View Warm Leads: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=warm-leads');
  await expect(page.getByRole('link', { name: 'View Last 7 Days: 0' })).toHaveAttribute('href', '/admin/crm?created=last-7-days');
  await expect(page.getByRole('link', { name: 'View Spam: 0' })).toHaveAttribute('href', '/admin/crm?status=spam');

  await page.getByRole('link', { name: 'View Last 7 Days: 0' }).click();
  await expect(page).toHaveURL(/\/admin\/crm\?created=last-7-days$/);
  await expect(page.getByLabel('Created').first()).toHaveValue('last-7-days');
});

test('authenticated CRM navigation persists page, size, sort, search, and status in the URL', async ({ page }) => {
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin/crm?search=HVAC&status=review&page=2&pageSize=10&sort=priority&direction=asc');

  await expect(page.getByRole('heading', { level: 1, name: 'CRM records' })).toBeVisible();
  await expect(page.getByLabel('Search CRM').first()).toHaveValue('HVAC');
  await expect(page.getByLabel('Status').first()).toHaveValue('review');
  await expect(page.getByLabel('Sort').first()).toHaveValue('priority:asc');
  await expect(page.getByLabel('Per page').first()).toHaveValue('10');
  await expect(page.getByText('11–15 of 15 records · Page 2 of 2').first()).toBeVisible();

  await page.getByRole('button', { name: /previous/i }).first().click();
  await expect(page.getByText('1–10 of 15 records · Page 1 of 2').first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
  expect(new URL(page.url()).searchParams.get('search')).toBe('HVAC');
  expect(new URL(page.url()).searchParams.get('pageSize')).toBe('10');

  await page.getByLabel('Sort').first().selectOption('deal_score:desc');
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('deal_score');
  await expect(page.getByLabel('Sort').first()).toHaveValue('deal_score:desc');

  await page.getByLabel('Sort').first().selectOption('listing_date:asc');
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('listing_date');
  await expect.poll(() => new URL(page.url()).searchParams.get('direction')).toBe('asc');
  await expect(page.getByLabel('Sort').first()).toHaveValue('listing_date:asc');
});

test('an authenticated administrator can reach the Operations Center', async ({ page }) => {
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin/operations');

  await expect(page.getByRole('heading', { name: /system health, history, and recovery readiness/i })).toBeVisible();
  await expect(page.getByText('70% free')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Job history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit events' })).toBeVisible();
});

test('the follow-up queue renders a full server page and its mobile dialog is keyboard-safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin/follow-ups?view=all');

  await expect(page.getByRole('heading', { name: 'Follow-Up decisions and email actions' })).toBeVisible();
  await expect(page.getByText('Showing 1–25 of 25 filtered records')).toBeVisible();
  await expect(page.getByRole('button', { name: /Browser Follow-Up/ })).toHaveCount(25);

  const firstRow = page.getByRole('button', { name: /Browser Follow-Up 0/ });
  await firstRow.focus();
  await firstRow.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close follow-up detail' })).toBeFocused();
  await expect(page.getByText('<script>untrusted email instruction</script> Could you send the CIM?')).toBeVisible();
  await expect(dialog.locator('script')).toHaveCount(0);
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(389);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(firstRow).toBeFocused();
});

test('Acquisition Inbox Phase 1 follows the real Operations destination under a separate read-only audit', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const state = await installPhase1OperationsFixture(page);

  await page.goto('/admin/deal-hunter');
  await expect(page.getByRole('heading', { level: 2, name: 'Acquisition Inbox' })).toBeVisible();
  const inboxViews = page.getByRole('navigation', { name: 'Deal Hunter views' });
  await inboxViews.getByRole('link', { name: 'Operations' }).click();

  await expect(page).toHaveURL('http://127.0.0.1:4173/admin/deal-hunter?view=operations');
  const operationsViews = page.getByRole('navigation', { name: 'Deal Hunter views' });
  await expect(operationsViews.getByRole('link', { name: 'Operations' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 2, name: 'Acquisition Inbox' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Daily source review' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Import SMB Deal OS export' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review Recent' })).toBeVisible();

  const expectedOperationsApiRequests = [
    'GET /api/admin/session',
    'GET /api/admin/onboarding',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25',
    'GET /api/admin/deal-hunter/review',
    'GET /api/admin/deal-hunter/cim-requests?page=1&pageSize=25&sort=first_requested_at&direction=desc',
    'GET /api/admin/communications/unassigned?page=1&pageSize=25',
    'GET /api/admin/acquisition-command-center',
  ].sort();
  await expect.poll(() => state.apiRequests.length).toBe(expectedOperationsApiRequests.length);
  expect(state.apiRequests.map(phase1RequestSignature).sort()).toEqual(expectedOperationsApiRequests);
  expect(state.apiRequests.every(({ method }) => method === 'GET')).toBe(true);
  expect(state.unexpectedRequests).toEqual([]);
  expect(state.unexpectedApiRequests).toEqual([]);
  expect(state.offOriginRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Acquisition Inbox Phase 1 is a stateful, human-controlled default workflow', async ({ page }, testInfo) => {
  test.slow();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const state = await installPhase1Fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto('/admin/deal-hunter');

  await expect(page).toHaveURL(/\/admin\/deal-hunter$/);
  await expect(page).toHaveTitle('Deal Hunter | Uckele Group Admin');
  await expect(page.getByRole('heading', { level: 2, name: 'Acquisition Inbox' })).toBeVisible();
  await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal')).toHaveCount(0);
  const dealHunterViews = page.getByRole('navigation', { name: 'Deal Hunter views' });
  await expect(dealHunterViews.getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/admin/deal-hunter');
  await expect(dealHunterViews.getByRole('link', { name: 'Operations' })).toHaveAttribute('href', '/admin/deal-hunter?view=operations');
  await expectPhase1Summary(page, 'Needs Review', 3);
  await expectPhase1Summary(page, 'High Priority', 3);
  await expectPhase1Summary(page, 'Watchlist', 1);
  await expectPhase1Summary(page, 'Low Confidence', 2);
  await expectPhase1Summary(page, 'Current Opportunities', 4);

  const queue = page.getByRole('list', { name: 'Opportunity queue' });
  await page.getByRole('tab', { name: 'Watchlist' }).click();
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText(['Heritage Inspection Partners']);
  await page.getByRole('tab', { name: 'Low Confidence' }).click();
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText([
    'Cascade Field Compliance',
    'Heritage Inspection Partners',
  ]);
  await page.getByRole('tab', { name: 'Needs Review' }).click();
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText([
    'Summit Fire Systems',
    'Evergreen Safety Services',
    'Cascade Field Compliance',
  ]);
  await expect(page.getByRole('combobox', { name: 'Sort opportunities', exact: true })).toHaveValue('acquisition-priority');
  const initialQueueRead = state.requests.find((request) => request.method === 'GET' && request.path === '/api/admin/deal-hunter/triage');
  expect(initialQueueRead).toBeTruthy();
  expect(new URLSearchParams(initialQueueRead.search).get('view')).toBe('needs-review');
  expect(new URLSearchParams(initialQueueRead.search).get('sort')).toBe('acquisition-priority');

  const search = page.getByRole('searchbox', { name: 'Search opportunities' });
  const confidence = page.getByRole('combobox', { name: 'Confidence', exact: true });
  const priority = page.getByRole('combobox', { name: 'Operator priority', exact: true });
  await search.fill('Evergreen');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText(['Evergreen Safety Services']);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&search=Evergreen');
  await search.fill('');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText([
    'Summit Fire Systems',
    'Evergreen Safety Services',
    'Cascade Field Compliance',
  ]);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc');

  await confidence.selectOption('low');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText(['Cascade Field Compliance']);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&confidence=low');
  await confidence.selectOption('');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText([
    'Summit Fire Systems',
    'Evergreen Safety Services',
    'Cascade Field Compliance',
  ]);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc');

  await priority.selectOption('high');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText(['Summit Fire Systems']);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&priority=high');
  await priority.selectOption('');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText([
    'Summit Fire Systems',
    'Evergreen Safety Services',
    'Cascade Field Compliance',
  ]);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc');

  await search.fill('Evergreen');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText(['Evergreen Safety Services']);
  await expect.poll(() => state.requests.filter(({ method, path }) => method === 'GET' && path === '/api/admin/deal-hunter/triage').at(-1)?.search)
    .toBe('?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&search=Evergreen');

  const evergreenTrigger = page.getByRole('button', { name: 'Open Evergreen Safety Services' });
  await evergreenTrigger.click();
  let dialog = page.getByRole('dialog', { name: 'Evergreen Safety Services' });
  await expect(dialog).toBeVisible();
  for (const section of ['Overview', 'Business & Financials', 'Broker & Seller', 'Score & Evidence', 'Sources', 'CRM/CIM', 'Notes & History']) {
    await expect(dialog.getByRole('heading', { name: section })).toBeVisible();
  }
  await expectPhase1DetailValue(dialog, 'Fit', 92);
  await expectPhase1DetailValue(dialog, 'Confidence', 'High');
  await expectPhase1DetailValue(dialog, 'Machine state', 'High Fit');
  const businessFinancials = dialog.getByRole('heading', { name: 'Business & Financials' }).locator('..');
  await expect(businessFinancials.getByText('$535,000', { exact: true })).toBeVisible();
  await expect(businessFinancials.getByText('$2,800,000', { exact: true })).toBeVisible();
  await expect(businessFinancials.getByText('$2,100,000', { exact: true })).toBeVisible();
  await expect(businessFinancials.getByText('4.04×', { exact: true })).toBeVisible();
  const brokerSellerSection = dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..');
  await expect(brokerSellerSection.getByText('Riley Verified Broker', { exact: true })).toBeVisible();
  await expect(brokerSellerSection.getByText('503-555-0198', { exact: true })).toBeVisible();
  await expect(brokerSellerSection.getByText('Operator verified', { exact: true })).toHaveCount(2);
  await expect(brokerSellerSection.getByText('Morgan CRM Seller', { exact: true })).toBeVisible();
  await expect(brokerSellerSection.getByText('CRM', { exact: true }).first()).toBeVisible();
  const missingInformation = dialog.getByRole('region', { name: 'Missing Information' });
  await expect(missingInformation.getByText('Seller email')).toBeVisible();
  await expect(missingInformation.getByText('Customer concentration')).toBeVisible();
  await expect(missingInformation.getByText('Not provided')).toHaveCount(2);
  const scoreSection = dialog.getByRole('heading', { name: 'Score & Evidence' }).locator('..');
  for (const dimension of phase1DimensionLabels) await expect(scoreSection.getByRole('heading', { name: dimension })).toBeVisible();
  await expect(scoreSection.getByText('Profit inside target acquisition band')).toBeVisible();
  await expect(scoreSection.getByText('Observed value: $520,000 reported', { exact: true })).toBeVisible();
  await expect(scoreSection.getByText(/Caps: Customer concentration is unverified/)).toBeVisible();
  await expect(scoreSection.getByText(/Missing evidence: Customer Concentration/)).toBeVisible();
  const sourcesSection = dialog.getByRole('heading', { name: 'Sources' }).locator('..');
  await expect(sourcesSection.getByRole('heading', { name: 'Deal Hunter Google Sheet' })).toBeVisible();
  await expect(sourcesSection.getByRole('heading', { name: 'Deal OS' })).toBeVisible();
  await expect(sourcesSection.getByText('Conflict: Annual Profit').first()).toBeVisible();
  await expect(sourcesSection.getByText(/Deal Hunter Google Sheet reported 535000/).first()).toBeVisible();
  await expect(sourcesSection.getByText(/Deal OS reported 475000/).first()).toBeVisible();
  await expect(sourcesSection.getByText('503-555-0110', { exact: true })).toBeVisible();
  await expect(sourcesSection.getByText('Call the main broker desk after 2 PM.', { exact: true })).toBeVisible();
  const originalListingLinks = sourcesSection.getByRole('link', { name: /View Original Listing/ });
  await expect(originalListingLinks).toHaveCount(2);
  await expect(originalListingLinks.first()).toHaveAttribute('href', 'https://broker.example/evergreen');
  await expect(originalListingLinks.nth(1)).toHaveAttribute('href', 'https://dealos.example/opp-evergreen');
  const crmCimSection = dialog.getByRole('heading', { name: 'CRM/CIM' }).locator('..');
  await expect(crmCimSection.getByRole('heading', { name: 'CRM record' })).toBeVisible();
  await expect(crmCimSection.getByRole('heading', { name: 'CIM history' })).toBeVisible();
  await expect(crmCimSection.getByRole('heading', { name: 'CRM communications' })).toBeVisible();
  await expect(crmCimSection.getByRole('heading', { name: 'CIM communications' })).toBeVisible();
  const historySection = dialog.getByRole('heading', { name: 'Notes & History' }).locator('..');
  await expect(historySection.getByText(/Note: Confirm renewal terms before advancing/)).toBeVisible();
  await expect(historySection.getByText(/Operator fact · Broker Name · Riley Verified Broker · Verified/)).toBeVisible();
  await expect(historySection.getByText(/Event: Opportunity Rescored/)).toBeVisible();
  await expect(historySection.getByText(/Passed: Timing · Previously passed, then restored after updated economics/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('phase1-desktop-drawer.png'), fullPage: false });

  await dialog.getByRole('button', { name: 'Close opportunity detail' }).click();
  await expect(dialog).toBeHidden();
  await expect(evergreenTrigger).toBeFocused();
  await expect(search).toHaveValue('Evergreen');
  await expect(confidence).toHaveValue('');
  await expect(priority).toHaveValue('');
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText(['Evergreen Safety Services']);

  await evergreenTrigger.click();
  dialog = page.getByRole('dialog', { name: 'Evergreen Safety Services' });
  await dialog.getByLabel('Verified fact field').selectOption('seller_name');
  await dialog.getByLabel('Verified fact value').fill('Morgan Verified Seller');
  await dialog.getByLabel('Verification note').fill('Confirmed directly with the seller on Aug 30.');
  await dialog.getByRole('button', { name: 'Save verified fact' }).click();
  await expect.poll(() => state.factPayloads.length).toBe(1);
  await expect(dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..').getByText('Morgan Verified Seller', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..').getByText('Operator verified', { exact: true })).toHaveCount(3);
  await expect(dialog.getByRole('heading', { name: 'Notes & History' }).locator('..').getByText(/Operator fact · Seller Name · Morgan Verified Seller · Verified/)).toBeVisible();
  await expect(dialog.getByText(/Confirmed directly with the seller on Aug 30/).first()).toBeVisible();

  const evergreen = state.scoreRows.find((score) => score.opportunityId === 'opp-evergreen');
  const evergreenSource = state.sourceObservations.find((source) => source.opportunityId === 'opp-evergreen' && source.sourceId === 'sheet-0');
  evergreenSource.values.seller_name = 'Morgan Refreshed Structured Seller';
  evergreenSource.observedAt = '2026-08-30T21:00:00.000Z';
  await dialog.getByRole('button', { name: 'Close opportunity detail' }).click();
  await evergreenTrigger.click();
  dialog = page.getByRole('dialog', { name: 'Evergreen Safety Services' });
  const refreshedBrokerSeller = dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..');
  await expect(refreshedBrokerSeller.getByText('Morgan Verified Seller', { exact: true }).first()).toBeVisible();
  await expect(refreshedBrokerSeller.getByText('Operator verified', { exact: true })).toHaveCount(3);
  const refreshedSources = dialog.getByRole('heading', { name: 'Sources' }).locator('..');
  await expect(refreshedSources.getByText('Morgan Refreshed Structured Seller', { exact: true }).first()).toBeVisible();
  await expect(refreshedSources.getByText(/Observed Aug 30, 2026/).first()).toBeVisible();
  expect(state.requests.some((request) => /refresh|review|backfill|import/i.test(request.path))).toBe(false);

  await dialog.getByRole('button', { name: 'Pursue Evergreen Safety Services' }).click();
  await expect.poll(() => state.actionPayloads.filter((payload) => payload.path === '/api/admin/deal-hunter/triage/opp-evergreen/action').length).toBe(1);
  await expectPhase1DetailValue(dialog, 'Operator state', 'High');
  await expectPhase1DetailValue(dialog, 'Fit', 92);
  expect(evergreen.fitScore).toBe(92);
  await dialog.getByRole('button', { name: 'Watch Evergreen Safety Services' }).click();
  await expect.poll(() => state.actionPayloads.filter((payload) => payload.path === '/api/admin/deal-hunter/triage/opp-evergreen/action').length).toBe(2);
  await expectPhase1DetailValue(dialog, 'Operator state', 'Watch');
  await expectPhase1DetailValue(dialog, 'Fit', 92);
  await expect(dialog.getByRole('heading', { name: 'Sources' }).locator('..').getByText('Morgan Refreshed Structured Seller', { exact: true }).first()).toBeVisible();
  expect(evergreen.fitScore).toBe(92);
  await dialog.getByRole('button', { name: 'Close opportunity detail' }).click();
  await expect(search).toHaveValue('Evergreen');
  await expect(confidence).toHaveValue('');
  await expect(priority).toHaveValue('');
  await expect(page.getByText('No opportunities in this view.')).toBeVisible();

  await search.fill('');
  await page.getByRole('tab', { name: 'Watchlist' }).click();
  await expect(queue.getByRole('button', { name: /^Open / })).toHaveText([
    'Evergreen Safety Services',
    'Heritage Inspection Partners',
  ]);
  await page.getByRole('tab', { name: 'All Current' }).click();
  const cascadeTrigger = page.getByRole('button', { name: 'Open Cascade Field Compliance' });
  await expect(cascadeTrigger).toBeVisible();
  const actionCountBeforePass = state.actionPayloads.length;
  await page.getByRole('button', { name: 'Pass Cascade Field Compliance' }).click();
  const passDialog = page.getByRole('dialog', { name: 'Pass Cascade Field Compliance' });
  await expect(passDialog).toBeVisible();
  expect(state.actionPayloads).toHaveLength(actionCountBeforePass);
  await passDialog.getByLabel('Pass reason').fill('valuation');
  await passDialog.getByLabel('Pass note (optional)').fill('Asking price exceeds the current acquisition valuation.');
  await passDialog.getByRole('button', { name: 'Confirm Pass' }).click();
  await expect.poll(() => state.actionPayloads.length).toBe(actionCountBeforePass + 1);
  await expect(passDialog).toBeHidden();
  await expect(cascadeTrigger).toHaveCount(0);
  const cascade = state.scoreRows.find((score) => score.opportunityId === 'opp-cascade');
  expect(cascade.fitScore).toBe(84);

  await page.getByRole('tab', { name: 'Passed' }).click();
  const passedCascade = page.getByRole('button', { name: 'Open Cascade Field Compliance' });
  await expect(passedCascade).toBeVisible();
  const passedRow = passedCascade.locator('..').locator('..');
  await expect(passedRow.getByText('84', { exact: true })).toBeVisible();
  await expect(passedRow.getByText('Passed: Valuation')).toBeVisible();
  await passedCascade.click();
  dialog = page.getByRole('dialog', { name: 'Cascade Field Compliance' });
  await expectPhase1DetailValue(dialog, 'Fit', 84);
  await expect(dialog.getByText('Passed: Valuation').first()).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Disposition history' })).toBeVisible();
  await expect(dialog.getByText(/Passed: Valuation · Asking price exceeds the current acquisition valuation. · phase1-admin/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Pursue Cascade Field Compliance' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Watch Cascade Field Compliance' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Pass Cascade Field Compliance' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close opportunity detail' }).click();

  const mobileWidth = 375;
  await page.setViewportSize({ width: mobileWidth, height: 812 });
  await page.goto('/admin/deal-hunter');
  await expect(page.getByRole('heading', { level: 2, name: 'Acquisition Inbox' })).toBeVisible();
  const mobileTablist = page.getByRole('tablist', { name: 'Opportunity queues' });
  const needsReviewTab = mobileTablist.getByRole('tab', { name: 'Needs Review' });
  const passedTab = mobileTablist.getByRole('tab', { name: 'Passed' });
  await expect(needsReviewTab).toHaveAttribute('aria-selected', 'true');
  const initialTabGeometry = await mobileTablist.evaluate((element) => ({
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  }));
  expect(initialTabGeometry.overflowX).toBe('auto');
  expect(initialTabGeometry.scrollWidth).toBeGreaterThan(initialTabGeometry.clientWidth);
  expect(initialTabGeometry.scrollLeft).toBe(0);
  const initialTablistBox = await mobileTablist.boundingBox();
  const initialPassedBox = await passedTab.boundingBox();
  expect(initialTablistBox).not.toBeNull();
  expect(initialPassedBox).not.toBeNull();
  expect(initialPassedBox.x).toBeGreaterThanOrEqual(initialTablistBox.x + initialTablistBox.width);

  await passedTab.scrollIntoViewIfNeeded();
  await expect.poll(() => mobileTablist.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expectHorizontallyReachable(passedTab, mobileWidth);
  const scrolledTablistBox = await mobileTablist.boundingBox();
  const scrolledPassedBox = await passedTab.boundingBox();
  expect(scrolledPassedBox.x).toBeGreaterThanOrEqual(scrolledTablistBox.x - 0.5);
  expect(scrolledPassedBox.x + scrolledPassedBox.width).toBeLessThanOrEqual(scrolledTablistBox.x + scrolledTablistBox.width + 0.5);
  await passedTab.click();
  await expect(passedTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Open Cascade Field Compliance' })).toBeVisible();

  await needsReviewTab.scrollIntoViewIfNeeded();
  await needsReviewTab.click();
  await expect(needsReviewTab).toHaveAttribute('aria-selected', 'true');
  const mobileSummit = page.getByRole('button', { name: 'Open Summit Fire Systems' });
  await expect(mobileSummit).toBeVisible();
  const mobileControls = [
    page.getByRole('searchbox', { name: 'Search opportunities' }),
    page.getByRole('combobox', { name: 'Confidence', exact: true }),
    page.getByRole('combobox', { name: 'Operator priority', exact: true }),
    page.getByRole('combobox', { name: 'Sort opportunities', exact: true }),
    page.getByRole('button', { name: 'Pursue Summit Fire Systems' }),
    page.getByRole('button', { name: 'Watch Summit Fire Systems' }),
    page.getByRole('button', { name: 'Pass Summit Fire Systems' }),
  ];
  for (const control of mobileControls) await expectHorizontallyReachable(control, mobileWidth);
  const defaultOverflow = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(defaultOverflow.scrollWidth).toBeLessThanOrEqual(defaultOverflow.clientWidth);

  await mobileSummit.click();
  dialog = page.getByRole('dialog', { name: 'Summit Fire Systems' });
  const mobileDialogBox = await dialog.boundingBox();
  expect(mobileDialogBox).not.toBeNull();
  expect(mobileDialogBox.width).toBeGreaterThanOrEqual(374);
  expect(mobileDialogBox.height).toBeGreaterThanOrEqual(811);
  for (const control of [
    dialog.getByRole('button', { name: 'Close opportunity detail' }),
    dialog.getByRole('button', { name: 'Pursue Summit Fire Systems' }),
    dialog.getByRole('button', { name: 'Watch Summit Fire Systems' }),
    dialog.getByRole('button', { name: 'Pass Summit Fire Systems' }),
    dialog.getByLabel('Verified fact field'),
    dialog.getByLabel('Verified fact value'),
    dialog.getByLabel('Verification note'),
    dialog.getByRole('button', { name: 'Save verified fact' }),
  ]) await expectHorizontallyReachable(control, mobileWidth);
  const drawerOverflow = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(drawerOverflow.scrollWidth).toBeLessThanOrEqual(drawerOverflow.clientWidth);
  await dialog.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('phase1-mobile-drawer.png'), fullPage: false });
  await dialog.getByRole('button', { name: 'Close opportunity detail' }).click();

  const expectedDealHunterRequests = [
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=watchlist&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=watchlist&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=low-confidence&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&search=Evergreen',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&search=Evergreen',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&search=Evergreen',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&search=Evergreen',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&confidence=low',
    'GET /api/admin/deal-hunter/triage?view=needs-review&page=1&pageSize=25&sort=acquisition-priority&direction=desc&priority=high',
    'GET /api/admin/deal-hunter/triage?view=all&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=all&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=dismissed&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage?view=dismissed&page=1&pageSize=25&sort=acquisition-priority&direction=desc',
    'GET /api/admin/deal-hunter/triage/opp-cascade',
    'GET /api/admin/deal-hunter/triage/opp-evergreen',
    'GET /api/admin/deal-hunter/triage/opp-evergreen',
    'GET /api/admin/deal-hunter/triage/opp-evergreen',
    'GET /api/admin/deal-hunter/triage/opp-evergreen',
    'GET /api/admin/deal-hunter/triage/opp-evergreen',
    'GET /api/admin/deal-hunter/triage/opp-evergreen',
    'GET /api/admin/deal-hunter/triage/opp-summit',
    'POST /api/admin/deal-hunter/triage/opp-cascade/action',
    'POST /api/admin/deal-hunter/triage/opp-evergreen/action',
    'POST /api/admin/deal-hunter/triage/opp-evergreen/action',
    'PUT /api/admin/deal-hunter/opportunities/opp-evergreen/facts/seller_name',
  ].sort();
  expect(state.requests).toHaveLength(33);
  expect(state.requests.map(phase1RequestSignature).sort()).toEqual(expectedDealHunterRequests);
  const independentlyObservedDealHunterRequests = state.apiRequests
    .filter(({ path }) => path.startsWith('/api/admin/deal-hunter/'));
  expect(independentlyObservedDealHunterRequests).toHaveLength(33);
  expect(independentlyObservedDealHunterRequests.map(phase1RequestSignature).sort()).toEqual(expectedDealHunterRequests);
  const expectedInboxApiRequests = [
    ...expectedDealHunterRequests,
    'GET /api/admin/session',
    'GET /api/admin/session',
    'GET /api/admin/onboarding',
    'GET /api/admin/onboarding',
  ].sort();
  expect(state.apiRequests).toHaveLength(37);
  expect(state.apiRequests.map(phase1RequestSignature).sort()).toEqual(expectedInboxApiRequests);
  expect(state.actionPayloads).toEqual([
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-evergreen/action', body: { action: 'pursue' }, machineScore: 92 },
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-evergreen/action', body: { action: 'watch' }, machineScore: 92 },
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-cascade/action', body: { action: 'pass', reason: 'valuation', note: 'Asking price exceeds the current acquisition valuation.' }, machineScore: 84 },
  ]);
  expect(state.factPayloads).toEqual([{
    method: 'PUT',
    path: '/api/admin/deal-hunter/opportunities/opp-evergreen/facts/seller_name',
    body: { value: 'Morgan Verified Seller', note: 'Confirmed directly with the seller on Aug 30.', verified: true },
  }]);
  const prohibitedPath = /(?:\/send(?:\/|$)|\/cim(?:[-_/]|$)|stage[-_]?2|scores?\/refresh|\/refresh(?:\/|$)|backfill|deal-os-import|\/import(?:\/|$)|source-refresh|crm-sync|follow-up|outreach|\/review(?:\/|$)|scrap)/i;
  expect(state.requests.filter((request) => prohibitedPath.test(request.path))).toEqual([]);
  expect(state.unexpectedRequests).toEqual([]);
  expect(state.unexpectedApiRequests).toEqual([]);
  expect(state.offOriginRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Request Broker Materials desktop review sends the exact approved proposal once and reloads durable lifecycle', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  const fixture = state.brokerMaterialsByOpportunity['opp-cascade'];
  fixture.warnings = [
    { code: 'below_automated_cim_score_threshold', message: 'Score 68 is below the automated CIM threshold; manual review remains allowed.' },
    { code: 'annual_profit_incomplete', message: 'Annual profit is incomplete; automated eligibility remains stricter.' },
  ];
  const score = state.scoreRows.find((row) => row.opportunityId === 'opp-cascade');
  score.fitScore = 68;
  score.financials.annualProfit = null;
  const { dialog, card } = await openBrokerOpportunity(page);

  await dialog.getByRole('button', { name: 'Pursue Cascade Field Compliance' }).click();
  await expect(card.getByRole('button', { name: 'Request Broker Materials' })).toBeVisible();
  await card.getByRole('button', { name: 'Request Broker Materials' }).click();

  await expect(card.getByRole('heading', { name: 'Prepared Broker Materials review' })).toBeFocused();
  await expect(card.getByText(/broker-opp-cascade@example\.test/).first()).toBeVisible();
  await expect(card.getByText(/Provenance: Deal Hunter Google Sheet · deal-cascade-sheet/)).toBeVisible();
  await expect(card.getByText(/Mathew Uckele · mathew@uckelegroup.com · Reply to reply\+browser@example.test/)).toBeVisible();
  await expect(card.getByText(/Score 68 is below the automated CIM threshold/)).toBeVisible();
  await expect(card.getByText(/Annual profit is incomplete/)).toBeVisible();
  await expect(card.getByLabel('Greeting')).toHaveValue('Hi Riley,');
  await expect(card.getByLabel('Subject')).toHaveValue('CIM / NDA request for Cascade Field Compliance');
  await expect(card.getByLabel('Complete message body')).toHaveValue('Hi Riley,\n\nPlease share the CIM and NDA for Cascade Field Compliance.\n\nThank you,\nMathew');
  await expect(card.getByRole('button', { name: 'Approve & Send' })).toBeEnabled();

  await card.getByLabel('Greeting').fill('Hello Riley,');
  await expect(card.getByRole('button', { name: 'Approve & Send' })).toBeDisabled();
  expect(state.brokerApprovalCount).toBe(0);
  await card.getByRole('button', { name: 'Update Preview' }).click();
  await expect(card.getByLabel('Complete message body')).toHaveValue('Hello Riley,\n\nPlease share the CIM and NDA for Cascade Field Compliance.\n\nThank you,\nMathew');
  await expect(card.getByLabel('Greeting')).toBeFocused();

  const approve = card.getByRole('button', { name: 'Approve & Send' });
  await approve.click();
  await expect(card.getByRole('heading', { name: 'Broker Materials status: Sent' })).toBeFocused();
  await expect(card.getByText('Sent', { exact: true })).toBeVisible();
  expect(state.brokerApprovalCount).toBe(1);
  expect(state.brokerApprovePayloads).toHaveLength(1);
  expect(state.brokerApprovePayloads[0].body).toEqual({
    preparationToken: state.lastBrokerPreparationByOpportunity['opp-cascade'].preparationToken,
    approvedProposalDigest: state.lastBrokerPreparationByOpportunity['opp-cascade'].proposalDigest,
  });
  expect(Object.keys(state.brokerApprovePayloads[0].body).sort()).toEqual(['approvedProposalDigest', 'preparationToken']);
  expect(state.brokerPreparePayloads.map(({ body }) => body)).toEqual([
    {},
    { recipientContactRef: 'contact-opp-cascade-structured', greeting: 'Hello Riley,' },
  ]);
  expectBrokerRouteAuditClean(state);
});

test('Request Broker Materials keeps global-pause review available while disabling approval with a reason', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].sendBlockers = [{ code: 'cim_outreach_paused', message: 'CIM sending is globally paused.' }];
  const { card } = await openBrokerOpportunity(page);

  await card.getByRole('button', { name: 'Request Broker Materials' }).click();
  await expect(card.getByLabel('Complete message body')).toBeVisible();
  const approval = card.getByTestId('broker-materials-final-approval');
  await expect(approval.getByText(/CIM sending is globally paused\./)).toBeVisible();
  await expect(approval).toHaveAttribute('data-mobile-sticky', 'true');
  await expect(card.getByRole('button', { name: 'Approve & Send' })).toBeDisabled();
  expect(state.brokerApprovalCount).toBe(0);
  expectBrokerRouteAuditClean(state);
});

test('Request Broker Materials requires an explicit opaque contact and verified manual email authority', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  const fixture = state.brokerMaterialsByOpportunity['opp-cascade'];
  fixture.multipleContacts = true;
  fixture.recipientOptions = [
    { recipientContactRef: 'contact-cascade-structured', email: 'structured@example.test', displayName: 'Structured Broker', provenance: 'structured_source', provenanceLabel: 'Deal Hunter Sheet · cascade', primary: false },
    { recipientContactRef: 'contact-cascade-crm', email: 'crm@example.test', displayName: 'CRM Broker', provenance: 'crm', provenanceLabel: 'Current CRM broker', primary: false },
  ];
  let opened = await openBrokerOpportunity(page);
  await opened.card.getByRole('button', { name: 'Request Broker Materials' }).click();
  await expect(opened.card.getByText('Recipient required', { exact: true })).toBeVisible();
  await expect(opened.card.getByRole('button', { name: 'Approve & Send' })).toHaveCount(0);
  await opened.card.getByLabel('Authoritative broker recipient').selectOption('contact-cascade-crm');
  await expect(opened.card.getByLabel('Complete message body')).toBeVisible();
  expect(state.brokerPreparePayloads.map(({ body }) => body)).toEqual([{}, { recipientContactRef: 'contact-cascade-crm' }]);
  expect(Object.values(state.brokerPreparePayloads[1].body)).not.toContain('crm@example.test');
  await opened.dialog.getByRole('button', { name: 'Close opportunity detail' }).click();

  const manualState = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(manualState);
  const manualFixture = manualState.brokerMaterialsByOpportunity['opp-cascade'];
  manualFixture.recipientOptions = [];
  manualFixture.allowBrokerVerification = true;
  manualState.operatorFacts.push({
    opportunityId: 'opp-cascade', id: 'fact-unverified-browser-broker', field: 'broker_email',
    value: 'verified-browser-broker@example.test', verified: false, actor: 'phase1-admin', note: '',
    createdAt: '2026-09-01T16:00:00.000Z', updatedAt: '2026-09-01T16:00:00.000Z',
  });
  opened = await openBrokerOpportunity(page);
  await expect(opened.card.getByText(/Add and verify a broker email/)).toBeVisible();
  expect(manualState.brokerPreparePayloads).toEqual([]);
  await opened.card.getByRole('button', { name: 'Add / Verify Broker Email' }).click();
  await expect(opened.dialog.getByLabel('Verified fact field')).toHaveValue('broker_email');
  await expect(opened.dialog.getByLabel('Verified fact value')).toBeFocused();
  await opened.dialog.getByLabel('Verified fact value').fill('verified-browser-broker@example.test');
  await opened.dialog.getByLabel('Verification note').fill('Verified for the broker materials request.');
  await opened.dialog.getByRole('button', { name: 'Save verified fact' }).click();
  await expect(opened.card.getByRole('button', { name: 'Request Broker Materials' })).toBeVisible();
  await opened.card.getByRole('button', { name: 'Request Broker Materials' }).click();
  await expect(opened.card.getByText(/verified-browser-broker@example\.test/).first()).toBeVisible();
  expect(manualState.factPayloads.at(-1).body).toEqual({ value: 'verified-browser-broker@example.test', note: 'Verified for the broker materials request.', verified: true });
  expectBrokerRouteAuditClean(manualState);
});

test('Request Broker Materials unknown approval outcome checks authority without retrying approval', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].approvalMode = 'unknown';
  const { card } = await openBrokerOpportunity(page);
  await card.getByRole('button', { name: 'Request Broker Materials' }).click();
  await card.getByRole('button', { name: 'Approve & Send' }).click();

  await expect(card.getByText('Checking', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check Again' })).toBeVisible();
  await expect(card.getByRole('button', { name: /Approve & Send|Send Again/i })).toHaveCount(0);
  expect(state.brokerApprovalCount).toBe(1);
  const detailLoadsBeforeCheck = state.brokerDetailLoads['opp-cascade'];
  await card.getByRole('button', { name: 'Check Again' }).click();
  await expect(card.getByText('Sent', { exact: true })).toBeVisible();
  expect(state.brokerDetailLoads['opp-cascade']).toBe(detailLoadsBeforeCheck + 1);
  expect(state.brokerApprovalCount).toBe(1);
  expect(state.brokerApprovePayloads).toHaveLength(1);
  expectBrokerRouteAuditClean(state);
});

test('Request Broker Materials viewer can inspect preview and status but cannot mutate', async ({ page }) => {
  const state = await installPhase1Fixture(page, { role: 'viewer' });
  markBrokerOpportunityPursued(state);
  const { dialog, card } = await openBrokerOpportunity(page);
  await expect(dialog.getByRole('button', { name: /Pursue|Watch|Pass/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save verified fact' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Preview Broker Materials' }).click();
  await expect(card.getByLabel('Greeting')).toHaveAttribute('readonly');
  await expect(card.getByLabel('Complete message body')).toBeVisible();
  await expect(card.getByRole('button', { name: /Approve & Send|Update Preview|Regenerate|Correct Recipient|Retry/i })).toHaveCount(0);
  await expect(card.getByTestId('broker-materials-final-approval')).not.toHaveAttribute('data-mobile-sticky', 'true');
  const detailLoadsBeforeCheck = state.brokerDetailLoads['opp-cascade'];
  await card.getByRole('button', { name: 'Check Request Status' }).click();
  await expect.poll(() => state.brokerDetailLoads['opp-cascade']).toBe(detailLoadsBeforeCheck + 1);
  expect(state.brokerApprovalCount).toBe(0);
  expect(state.factPayloads).toEqual([]);
  expect(state.actionPayloads).toEqual([]);
  expectBrokerRouteAuditClean(state);
});

test('Request Broker Materials mobile Prepared review is sticky, reachable, and greeting Enter cannot send', async ({ page }) => {
  const mobileWidth = 390;
  await page.setViewportSize({ width: mobileWidth, height: 844 });
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  const { dialog, card } = await openBrokerOpportunity(page);
  await expect(dialog).toHaveClass(/h-full/);
  await card.getByRole('button', { name: 'Request Broker Materials' }).click();
  const approval = card.getByTestId('broker-materials-final-approval');
  await expect(approval).toHaveCSS('position', 'sticky');
  await expect(approval.getByText(/broker-opp-cascade@example\.test/)).toBeVisible();
  const approve = approval.getByRole('button', { name: 'Approve & Send' });
  await expectHorizontallyReachable(approve, mobileWidth);

  const greeting = card.getByLabel('Greeting');
  await greeting.scrollIntoViewIfNeeded();
  await greeting.fill('Hello mobile Riley,');
  await greeting.press('Enter');
  await expect(greeting).toBeFocused();
  await expect(card.getByLabel('Complete message body')).toHaveValue('Hello mobile Riley,\n\nPlease share the CIM and NDA for Cascade Field Compliance.\n\nThank you,\nMathew');
  expect(state.brokerApprovalCount).toBe(0);
  await expect(approval).toHaveCSS('position', 'sticky');

  const body = card.getByLabel('Complete message body');
  await body.scrollIntoViewIfNeeded();
  const [bodyBox, approvalBox, reviewPadding] = await Promise.all([
    body.boundingBox(),
    approval.boundingBox(),
    card.getByTestId('broker-materials-review-content').evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
  ]);
  expect(bodyBox).not.toBeNull();
  expect(approvalBox).not.toBeNull();
  expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(approvalBox.y + 1);
  expect(reviewPadding).toBeGreaterThanOrEqual(128);
  expectBrokerRouteAuditClean(state);
});

test('Request Broker Materials ambiguous lifecycle announces no resend and exposes no initial-request retry', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].existingRequest = {
    id: 'browser-request-ambiguous',
    status: 'ambiguous',
    requestState: 'provider_ambiguous',
    deliveryState: 'ambiguous',
    followUpState: 'not-scheduled',
    recipient: { email: 'broker-opp-cascade@example.test', displayName: 'Riley Structured Broker' },
    subject: 'CIM request',
    createdAt: '2026-09-01T17:00:00.000Z',
    updatedAt: '2026-09-01T17:00:30.000Z',
    requestedAt: '2026-09-01T17:00:00.000Z',
    providerAcceptedAt: '',
    deliveredAt: '',
    respondedAt: '',
    errorSummary: 'Provider outcome is ambiguous.',
    canRetry: false,
    canCorrectRecipient: false,
    retryRoute: '',
    correctionRoute: '',
  };
  const { card } = await openBrokerOpportunity(page);
  await expect(card.getByText('Ambiguous', { exact: true })).toBeVisible();
  await expect(card.getByText('Delivery could not be confirmed. Do not send another request.')).toBeVisible();
  await expect(card.getByRole('status')).toContainText('Ambiguous. Do not send another request.');
  await expect(card.getByRole('button', { name: /Approve & Send|Send Again|Retry|Regenerate|Request Broker Materials/i })).toHaveCount(0);
  await expect(card.getByTestId('broker-materials-final-approval')).toHaveCount(0);
  expect(state.brokerApprovalCount).toBe(0);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 admin completes start future due review update preview approve and next schedule lifecycle', async ({ page }, testInfo) => {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  const fixture = state.brokerMaterialsByOpportunity['opp-cascade'];
  fixture.existingRequest = phase3ExistingRequest({
    followUps: phase3FollowUps({
      enrolled: false, policyVersion: '', state: 'not-enrolled', currentFollowUpNumber: 1,
      nextFollowUpAt: '', startEligible: true, startBlockers: [],
    }),
  });
  let opened = await openBrokerOpportunity(page);
  const followUps = opened.card.getByRole('region', { name: 'Follow-Ups' });
  await expect(followUps.getByText('Not Scheduled', { exact: true })).toBeVisible();
  await followUps.getByRole('button', { name: 'Start Follow-Up Sequence' }).click();
  await expect(followUps.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(followUps.getByText(/Follow-Up 1 of 5/)).toBeVisible();
  await expect(followUps.getByRole('button', { name: 'Review Follow-Up' })).toHaveCount(0);
  expect(state.followUpStartPayloads.map(({ body }) => body)).toEqual([{}]);

  fixture.existingRequest.followUps = phase3FollowUps({
    state: 'due',
    sendBlockers: [{ code: 'cim_outreach_paused', message: 'Deal Hunter CIM outreach is globally paused.' }],
  });
  fixture.followUpApprovalMode = 'blocked';
  await opened.dialog.getByRole('button', { name: 'Close opportunity detail' }).click();
  opened = await openBrokerOpportunity(page);
  const dueFollowUps = opened.card.getByRole('region', { name: 'Follow-Ups' });
  await expect(dueFollowUps.getByText('Due', { exact: true })).toBeVisible();
  await dueFollowUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  await expect(dueFollowUps.getByRole('heading', { name: 'Review Follow-Up 1 of 5' })).toBeFocused();
  await expect(dueFollowUps.getByText(/Initial request.*Sep 1, 2026/i)).toBeVisible();
  await expect(dueFollowUps.getByText(/Previous provider acceptance.*Sep 1, 2026/i)).toBeVisible();
  await expect(dueFollowUps.getByText(/^Riley Structured Broker · broker-opp-cascade@example\.test$/)).toBeVisible();
  await expect(dueFollowUps.getByLabel('Follow-up subject')).toHaveValue('Follow-Up 1: Cascade Field Compliance');
  await expect(dueFollowUps.getByLabel('Complete follow-up body')).toHaveValue(/Following up on the CIM and NDA request/);
  await expect(dueFollowUps.getByText('Deal Hunter CIM outreach is globally paused.')).toBeVisible();
  await expect(dueFollowUps.getByRole('button', { name: 'Approve & Send Follow-Up' })).toBeDisabled();
  expect(state.followUpProviderCalls).toBe(0);

  await dueFollowUps.getByLabel('Complete follow-up body').press('Escape');
  await expect(dueFollowUps.getByLabel('Complete follow-up body')).toHaveCount(0);
  fixture.existingRequest.followUps = phase3FollowUps({ state: 'due', sendBlockers: [] });
  fixture.followUpApprovalMode = 'success';
  await opened.dialog.getByRole('button', { name: 'Close opportunity detail' }).click();
  opened = await openBrokerOpportunity(page);
  const activeFollowUps = opened.card.getByRole('region', { name: 'Follow-Ups' });
  await activeFollowUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  const greeting = activeFollowUps.getByLabel('Follow-up greeting');
  await greeting.fill('Hi Riley,');
  await expect(activeFollowUps.getByRole('button', { name: 'Approve & Send Follow-Up' })).toBeDisabled();
  await activeFollowUps.getByRole('button', { name: 'Update Preview' }).click();
  await expect(greeting).toHaveValue('Hi Riley,');
  await expect(greeting).toBeFocused();
  const approval = activeFollowUps.getByRole('button', { name: 'Approve & Send Follow-Up' });
  await expect(approval).toBeEnabled();
  await approval.click();
  await expect(activeFollowUps.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(activeFollowUps.getByText('1 of 5 sent')).toBeVisible();
  await expect(activeFollowUps.getByText('Follow-Up 2 of 5')).toBeVisible();
  expect(state.followUpApprovalCount).toBe(1);
  expect(state.followUpProviderCalls).toBe(1);
  expect(state.followUpPreparePayloads.map(({ body }) => body)).toEqual([{}, {}, { greeting: 'Hi Riley,' }]);
  expect(state.followUpApprovePayloads[0].body).toEqual({
    preparationToken: state.lastFollowUpPreparationByRequest[fixture.existingRequest.id].preparationToken,
    approvedProposalDigest: state.lastFollowUpPreparationByRequest[fixture.existingRequest.id].proposalDigest,
  });

  await activeFollowUps.getByRole('button', { name: 'Stop Follow-Up Sequence' }).click();
  await activeFollowUps.getByLabel('Stop reason (optional)').fill('Broker asked us not to follow up again.');
  await activeFollowUps.getByRole('button', { name: 'Permanently Stop' }).click();
  await expect(activeFollowUps.getByText('Stopped', { exact: true })).toBeVisible();
  await expect(activeFollowUps.getByRole('button', { name: /Start|Review|Approve|Stop/i })).toHaveCount(0);
  expect(state.followUpStopPayloads[0].body).toEqual({ reason: 'Broker asked us not to follow up again.' });

  await page.screenshot({ path: testInfo.outputPath('phase3-admin-follow-ups-desktop.png'), fullPage: false });
  await expect(page.locator('vite-error-overlay, [data-vite-dev-id]')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toBe('');
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 automatic runner action cannot send a marked due follow-up', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ state: 'due' }) });
  await page.goto('/admin/deal-hunter');
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/admin/deal-hunter/cim-follow-ups/run', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1 }),
    });
    return response.json();
  });
  expect(result.results).toEqual([{ requestId: 'browser-request-opp-cascade', status: 'approval-required' }]);
  expect(state.automaticFollowUpRuns).toBe(1);
  expect(state.followUpProviderCalls).toBe(0);
  expect(state.followUpApprovalCount).toBe(0);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 viewer is read-only and never receives approval artifacts', async ({ page }) => {
  const state = await installPhase1Fixture(page, { role: 'viewer' });
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ state: 'due' }) });
  const { card } = await openBrokerOpportunity(page);
  const followUps = card.getByRole('region', { name: 'Follow-Ups' });
  await expect(followUps.getByRole('button', { name: 'Preview Follow-Up' })).toBeVisible();
  await followUps.getByRole('button', { name: 'Preview Follow-Up' }).click();
  await expect(followUps.getByLabel('Complete follow-up body')).toBeVisible();
  await expect(followUps.getByLabel('Follow-up greeting')).toHaveCount(0);
  await expect(followUps.getByRole('button', { name: /Approve|Review Retry|Stop Follow-Up|Start Follow-Up/i })).toHaveCount(0);
  const text = await followUps.innerText();
  expect(text).not.toContain('signed-follow-up');
  expect(text).not.toContain('cccccccc');
  expect(state.followUpPreparePayloads.map(({ body }) => body)).toEqual([{}]);
  expect(state.followUpApprovePayloads).toEqual([]);
  expect(state.followUpStartPayloads).toEqual([]);
  expect(state.followUpStopPayloads).toEqual([]);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 unknown approval outcome checks authoritative status without retransmission', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  const fixture = state.brokerMaterialsByOpportunity['opp-cascade'];
  fixture.existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ state: 'due' }) });
  fixture.followUpApprovalMode = 'unknown';
  const { card } = await openBrokerOpportunity(page);
  const followUps = card.getByRole('region', { name: 'Follow-Ups' });
  await followUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  await followUps.getByRole('button', { name: 'Approve & Send Follow-Up' }).click();
  await expect(followUps.getByText('Checking', { exact: true })).toBeVisible();
  await expect(followUps.getByText(/retransmission is prohibited/i)).toBeVisible();
  await expect(followUps.getByRole('button', { name: 'Check Again' })).toBeVisible();
  await expect(followUps.getByRole('button', { name: /Approve|Retry|Send Again|Review/i })).toHaveCount(0);
  const detailLoads = state.brokerDetailLoads['opp-cascade'];
  await followUps.getByRole('button', { name: 'Check Again' }).click();
  await expect.poll(() => state.brokerDetailLoads['opp-cascade']).toBe(detailLoads + 1);
  expect(state.followUpApprovalCount).toBe(1);
  expect(state.followUpProviderCalls).toBe(1);
  expect(state.followUpApprovePayloads).toHaveLength(1);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 definitive failure retries exact persisted communication after fresh review', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  const fixture = state.brokerMaterialsByOpportunity['opp-cascade'];
  fixture.existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ state: 'due' }) });
  fixture.followUpApprovalMode = 'failure';
  const { card } = await openBrokerOpportunity(page);
  const followUps = card.getByRole('region', { name: 'Follow-Ups' });
  await followUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  await followUps.getByRole('button', { name: 'Approve & Send Follow-Up' }).click();
  await expect(followUps.getByRole('button', { name: 'Review Retry' })).toBeVisible();
  await followUps.getByRole('button', { name: 'Review Retry' }).click();
  await expect(followUps.getByRole('heading', { name: 'Review Retry Follow-Up 1 of 5' })).toBeVisible();
  await expect(followUps.getByLabel('Follow-up greeting')).toHaveCount(0);
  await expect(followUps.getByLabel('Follow-up subject')).toHaveValue('Exact persisted retry subject');
  await expect(followUps.getByLabel('Complete follow-up body')).toHaveValue('Exact persisted failed communication. This content cannot be edited.');
  fixture.followUpApprovalMode = 'success';
  await followUps.getByRole('button', { name: 'Approve & Send Follow-Up' }).click();
  await expect(followUps.getByText('Scheduled', { exact: true })).toBeVisible();
  expect(state.followUpApprovalCount).toBe(2);
  expect(state.followUpProviderCalls).toBe(2);
  expect(state.followUpPreparePayloads.map(({ body }) => body)).toEqual([{}, {}]);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 mobile drawer keeps review actions reachable above keyboard and sticky controls do not obscure content', async ({ page }, testInfo) => {
  const mobileWidth = 390;
  await page.setViewportSize({ width: mobileWidth, height: 844 });
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ state: 'due' }) });
  const { dialog, card } = await openBrokerOpportunity(page);
  const followUps = card.getByRole('region', { name: 'Follow-Ups' });
  await followUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  const approval = followUps.getByTestId('broker-materials-follow-up-approval');
  await expect(approval).toHaveCSS('position', 'sticky');
  await expect(approval).toHaveAttribute('data-mobile-sticky', 'true');
  await expectHorizontallyReachable(approval.getByRole('button', { name: 'Approve & Send Follow-Up' }), mobileWidth);
  const body = followUps.getByLabel('Complete follow-up body');
  await body.scrollIntoViewIfNeeded();
  const [bodyBox, approvalBox, reviewPadding, safePadding] = await Promise.all([
    body.boundingBox(),
    approval.boundingBox(),
    followUps.getByTestId('broker-materials-follow-up-review').evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
    approval.evaluate((element) => getComputedStyle(element).paddingBottom),
  ]);
  expect(bodyBox).not.toBeNull();
  expect(approvalBox).not.toBeNull();
  expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(approvalBox.y + 1);
  expect(reviewPadding).toBeGreaterThanOrEqual(128);
  expect(safePadding).not.toBe('0px');
  const overflow = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await page.screenshot({ path: testInfo.outputPath('phase3-mobile-follow-up-review.png'), fullPage: false });
  await expect(dialog).toHaveClass(/h-full/);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 keyboard flow never sends on Enter and preserves Escape and focus restoration', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  state.brokerMaterialsByOpportunity['opp-cascade'].existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ state: 'due' }) });
  const { dialog, card, trigger } = await openBrokerOpportunity(page);
  const followUps = card.getByRole('region', { name: 'Follow-Ups' });
  await followUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  const greeting = followUps.getByLabel('Follow-up greeting');
  await greeting.fill('Hello keyboard Riley,');
  await greeting.press('Enter');
  await expect(greeting).toHaveValue('Hello keyboard Riley,');
  await expect(greeting).toBeFocused();
  expect(state.followUpApprovalCount).toBe(0);
  expect(state.followUpProviderCalls).toBe(0);
  await followUps.getByLabel('Complete follow-up body').press('Escape');
  await expect(followUps.getByRole('heading', { name: 'Follow-Ups' })).toBeFocused();
  await expect(followUps.getByLabel('Complete follow-up body')).toHaveCount(0);
  await dialog.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.followUpApprovalCount).toBe(0);
  expectBrokerRouteAuditClean(state);
});

test('Phase 3 Follow-Up five completes with no Follow-Up six control request or communication', async ({ page }) => {
  const state = await installPhase1Fixture(page);
  markBrokerOpportunityPursued(state);
  const fixture = state.brokerMaterialsByOpportunity['opp-cascade'];
  fixture.existingRequest = phase3ExistingRequest({ followUps: phase3FollowUps({ followUpCount: 4, currentFollowUpNumber: 5, state: 'due' }) });
  const { card } = await openBrokerOpportunity(page);
  const followUps = card.getByRole('region', { name: 'Follow-Ups' });
  await expect(followUps.getByText('Follow-Up 5 of 5')).toBeVisible();
  await followUps.getByRole('button', { name: 'Review Follow-Up' }).click();
  await expect(followUps.getByRole('heading', { name: 'Review Follow-Up 5 of 5' })).toBeVisible();
  await followUps.getByRole('button', { name: 'Approve & Send Follow-Up' }).click();
  await expect(followUps.getByText('Completed', { exact: true })).toBeVisible();
  await expect(followUps.getByText('5 of 5 sent')).toBeVisible();
  await expect(followUps.getByText(/Follow-Up 6/i)).toHaveCount(0);
  await expect(followUps.getByRole('button', { name: /Review|Start|Stop|Approve/i })).toHaveCount(0);
  expect(state.followUpPreparePayloads).toHaveLength(1);
  expect(state.followUpApprovePayloads).toHaveLength(1);
  expect(state.followUpProviderCalls).toBe(1);
  expect(state.requests.filter(({ path }) => /follow-up-?6/i.test(path))).toEqual([]);
  expectBrokerRouteAuditClean(state);
});
