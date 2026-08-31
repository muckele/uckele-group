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

function phase1Opportunity(overrides = {}) {
  return {
    opportunityId: 'opp-default',
    dealKey: 'deal-default',
    name: 'Default Opportunity',
    state: 'CA',
    listingUrl: 'https://broker.example/default',
    fitScore: 80,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 86,
    missingEvidenceCount: 2,
    contradictionCount: 1,
    shouldRemove: false,
    highFit: true,
    geography: { city: 'Sacramento', state: 'CA', label: 'Sacramento, CA' },
    industry: 'Commercial field services',
    financials: { annualProfit: 410000, annualRevenue: 2100000, askingPrice: 1700000, profitMultiple: 4.15 },
    topStrength: 'Contracted inspections support durable recurring demand.',
    topConcern: 'Customer concentration still needs verification.',
    workflow: { crmStatus: 'active', cimStatus: 'documents-received' },
    observationFreshness: '2026-08-29T17:00:00.000Z',
    operatorPriority: 'normal',
    operatorNote: 'Confirm renewal terms before advancing.',
    reviewed: false,
    reviewedAt: '',
    reviewedBy: '',
    changedSinceReview: false,
    dismissed: false,
    dismissedReason: '',
    scoredAt: '2026-08-29T16:00:00.000Z',
    scoreFingerprint: 'phase1-machine-score-default',
    rulesVersion: 'deal-hunter-fit-v2.1',
    crmSellerName: 'Morgan CRM Seller',
    sourceSellerName: 'Morgan Structured Seller',
    sourceObservedAt: '2026-08-29T17:00:00.000Z',
    operatorFacts: [],
    activities: [],
    dispositions: [],
    ...overrides,
  };
}

function createPhase1FixtureState() {
  const cascade = phase1Opportunity({
    opportunityId: 'opp-cascade',
    dealKey: 'deal-cascade',
    name: 'Cascade Field Compliance',
    listingUrl: 'https://broker.example/cascade',
    fitScore: 84,
    scoreStatus: 'high-fit',
    confidence: 'low',
    completenessScore: 61,
    missingEvidenceCount: 4,
    geography: { city: 'Portland', state: 'OR', label: 'Portland, OR' },
    state: 'OR',
    industry: 'Field compliance services',
    financials: { annualProfit: 360000, annualRevenue: 1900000, askingPrice: 1500000, profitMultiple: 4.17 },
    observationFreshness: '2026-08-28T19:00:00.000Z',
    scoredAt: '2026-08-28T18:00:00.000Z',
    scoreFingerprint: 'phase1-machine-score-cascade-84',
    crmSellerName: 'Casey CRM Seller',
    sourceSellerName: 'Casey Structured Seller',
  });
  const heritage = phase1Opportunity({
    opportunityId: 'opp-heritage',
    dealKey: 'deal-heritage',
    name: 'Heritage Inspection Partners',
    listingUrl: 'https://broker.example/heritage',
    fitScore: 71,
    scoreStatus: 'watchlist',
    confidence: 'medium',
    completenessScore: 77,
    highFit: false,
    geography: { city: 'Reno', state: 'NV', label: 'Reno, NV' },
    state: 'NV',
    industry: 'Commercial inspection services',
    financials: { annualProfit: 275000, annualRevenue: 1400000, askingPrice: 1150000, profitMultiple: 4.18 },
    reviewed: true,
    reviewedAt: '2026-08-27T18:00:00.000Z',
    reviewedBy: 'phase1-admin',
    observationFreshness: '2026-08-27T17:00:00.000Z',
    scoredAt: '2026-08-27T16:00:00.000Z',
    scoreFingerprint: 'phase1-machine-score-heritage-71',
  });
  const evergreen = phase1Opportunity({
    opportunityId: 'opp-evergreen',
    dealKey: 'deal-evergreen',
    name: 'Evergreen Safety Services',
    listingUrl: 'https://broker.example/evergreen',
    fitScore: 92,
    scoreStatus: 'high-fit',
    confidence: 'high',
    completenessScore: 91,
    geography: { city: 'Seattle', state: 'WA', label: 'Seattle, WA' },
    state: 'WA',
    industry: 'Workplace safety services',
    financials: { annualProfit: 520000, annualRevenue: 2800000, askingPrice: 2100000, profitMultiple: 4.04 },
    observationFreshness: '2026-08-30T16:00:00.000Z',
    scoredAt: '2026-08-30T15:00:00.000Z',
    scoreFingerprint: 'phase1-machine-score-evergreen-92',
    operatorFacts: [{
      id: 'fact-evergreen-broker',
      field: 'broker_name',
      value: 'Riley Verified Broker',
      verified: true,
      actor: 'phase1-admin',
      note: 'Broker identity confirmed by phone.',
      createdAt: '2026-08-29T18:00:00.000Z',
      updatedAt: '2026-08-29T18:00:00.000Z',
    }],
    activities: [{
      id: 'activity-evergreen-change',
      eventType: 'opportunity-rescored',
      summary: 'Core source evidence changed and returned the opportunity to Needs Review.',
      createdAt: '2026-08-30T15:00:00.000Z',
      actor: 'deal-hunter',
    }],
    dispositions: [{
      id: 'disposition-evergreen-prior',
      disposition: 'dismissed',
      reason: 'timing',
      note: 'Previously passed, then restored after updated economics.',
      dismissedAt: '2026-08-20T18:00:00.000Z',
      dismissedBy: 'phase1-admin',
    }],
  });
  const summit = phase1Opportunity({
    opportunityId: 'opp-summit',
    dealKey: 'deal-summit',
    name: 'Summit Fire Systems',
    listingUrl: 'https://broker.example/summit',
    fitScore: 78,
    scoreStatus: 'high-fit',
    confidence: 'medium',
    completenessScore: 79,
    operatorPriority: 'high',
    geography: { city: 'Boise', state: 'ID', label: 'Boise, ID' },
    state: 'ID',
    industry: 'Fire protection systems',
    financials: { annualProfit: 390000, annualRevenue: 2050000, askingPrice: 1600000, profitMultiple: 4.1 },
    observationFreshness: '2026-08-26T17:00:00.000Z',
    scoredAt: '2026-08-26T16:00:00.000Z',
    scoreFingerprint: 'phase1-machine-score-summit-78',
  });
  return {
    // Deliberately not in acquisition-priority order. The intercepted server
    // response owns ordering, while the rendered assertion proves the UI keeps it.
    opportunities: [cascade, heritage, evergreen, summit],
    requests: [],
    apiRequests: [],
    unexpectedRequests: [],
    unexpectedApiRequests: [],
    offOriginRequests: [],
    actionPayloads: [],
    factPayloads: [],
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
  const current = state.opportunities.filter((opportunity) => !opportunity.dismissed);
  return {
    needsReview: current.filter((opportunity) => !opportunity.reviewed || opportunity.changedSinceReview).length,
    highPriority: current.filter((opportunity) => opportunity.highFit || ['urgent', 'high'].includes(opportunity.operatorPriority)).length,
    watchlist: current.filter((opportunity) => opportunity.scoreStatus === 'watchlist' || opportunity.operatorPriority === 'watch').length,
    lowConfidence: current.filter((opportunity) => opportunity.confidence === 'low' || opportunity.contradictionCount > 1).length,
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

  let rows = state.opportunities.filter((opportunity) => {
    if (view === 'needs-review') return !opportunity.dismissed && (!opportunity.reviewed || opportunity.changedSinceReview);
    if (view === 'high-priority') return !opportunity.dismissed && (opportunity.highFit || ['urgent', 'high'].includes(opportunity.operatorPriority));
    if (view === 'watchlist') return !opportunity.dismissed && (opportunity.scoreStatus === 'watchlist' || opportunity.operatorPriority === 'watch');
    if (view === 'low-confidence') return !opportunity.dismissed && (opportunity.confidence === 'low' || opportunity.contradictionCount > 1);
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

function phase1EffectiveFacts(opportunity) {
  const effective = {
    seller_name: { value: opportunity.crmSellerName, provenance: 'crm', verified: false, actor: '', note: '' },
    seller_phone: { value: '206-555-0147', provenance: 'structured-source', verified: false, actor: '', note: '' },
    broker_name: { value: 'Riley CRM Broker', provenance: 'crm', verified: false, actor: '', note: '' },
    broker_company: { value: 'Northwest Business Advisors', provenance: 'structured-source', verified: false, actor: '', note: '' },
    broker_email: { value: 'riley.broker@example.test', provenance: 'crm', verified: false, actor: '', note: '' },
    broker_phone: { value: '425-555-0199', provenance: 'structured-source', verified: false, actor: '', note: '' },
    reason_for_sale: { value: 'Owner retirement', provenance: 'structured-source', verified: false, actor: '', note: '' },
    real_estate_included: { value: 'Lease only; real estate excluded', provenance: 'structured-source', verified: false, actor: '', note: '' },
    seller_financing: { value: 'Seller will consider 10%', provenance: 'structured-source', verified: false, actor: '', note: '' },
    management_structure: { value: 'General manager leads day-to-day operations', provenance: 'structured-source', verified: false, actor: '', note: '' },
    operator_contact_notes: { value: 'Broker prefers scheduled calls.', provenance: 'crm', verified: false, actor: '', note: '' },
  };
  for (const fact of opportunity.operatorFacts) {
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

function phase1DetailResponse(opportunity) {
  const effectiveFacts = phase1EffectiveFacts(opportunity);
  const sourceProfit = String(opportunity.financials.annualProfit);
  const dealOsProfit = String(opportunity.financials.annualProfit - 45000);
  const sourceConflict = {
    field: 'annual_profit',
    observations: [
      { sourceId: 'sheet-0', sourceName: 'Deal Hunter Google Sheet', sourceRecordId: `${opportunity.dealKey}-sheet`, value: sourceProfit, observedAt: opportunity.sourceObservedAt },
      { sourceId: 'deal-os', sourceName: 'Deal OS', sourceRecordId: `${opportunity.dealKey}-deal-os`, value: dealOsProfit, observedAt: '2026-08-28T17:00:00.000Z' },
    ],
  };
  const sellerConflict = {
    field: 'seller_name',
    observations: [
      { sourceId: 'sheet-0', sourceName: 'Deal Hunter Google Sheet', sourceRecordId: `${opportunity.dealKey}-sheet`, value: opportunity.sourceSellerName, observedAt: opportunity.sourceObservedAt },
      { sourceId: 'deal-os', sourceName: 'Deal OS', sourceRecordId: `${opportunity.dealKey}-deal-os`, value: 'Deal OS Seller Claim', observedAt: '2026-08-28T17:00:00.000Z' },
    ],
  };
  const operatorFacts = opportunity.operatorFacts.map((fact) => ({ ...fact }));
  return {
    opportunity: { ...phase1QueueRow(opportunity), operatorNote: opportunity.operatorNote },
    effectiveFacts,
    operatorFacts,
    sourceObservations: [
      {
        sourceId: 'sheet-0',
        sourceName: 'Deal Hunter Google Sheet',
        sourceRecordId: `${opportunity.dealKey}-sheet`,
        observedAt: opportunity.sourceObservedAt,
        values: {
          seller_name: opportunity.sourceSellerName,
          broker_name: 'Riley Structured Broker',
          annual_profit: sourceProfit,
          listing_id: `${opportunity.dealKey}-sheet`,
          listing_url: opportunity.listingUrl,
        },
        conflicts: [sourceConflict, sellerConflict],
      },
      {
        sourceId: 'deal-os',
        sourceName: 'Deal OS',
        sourceRecordId: `${opportunity.dealKey}-deal-os`,
        observedAt: '2026-08-28T17:00:00.000Z',
        values: {
          seller_name: 'Deal OS Seller Claim',
          annual_profit: dealOsProfit,
          listing_id: `${opportunity.dealKey}-deal-os`,
          listing_url: `https://dealos.example/${opportunity.opportunityId}`,
        },
        conflicts: [sourceConflict, sellerConflict],
      },
    ],
    missingCriticalFields: ['seller_email', 'customer_concentration'],
    listingUrls: [opportunity.listingUrl, `https://dealos.example/${opportunity.opportunityId}`],
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
          observedAt: opportunity.sourceObservedAt,
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
    cimSummary: {
      requests: [{ id: `cim-${opportunity.opportunityId}`, status: 'documents-received', updatedAt: '2026-08-29T19:00:00.000Z' }],
      communications: [{ id: `cim-communication-${opportunity.opportunityId}`, direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T19:00:00.000Z', cimRequestId: `cim-${opportunity.opportunityId}` }],
    },
    crmSummary: {
      submission: {
        id: `crm-${opportunity.opportunityId}`,
        status: 'review',
        company: opportunity.name,
        sellerName: opportunity.crmSellerName,
        sellerEmail: 'seller.crm@example.test',
        brokerName: 'Riley CRM Broker',
        brokerEmail: 'riley.broker@example.test',
        updatedAt: '2026-08-29T19:00:00.000Z',
      },
      communications: [
        { id: `crm-email-${opportunity.opportunityId}`, direction: 'inbound', channel: 'email', kind: 'broker-reply', occurredAt: '2026-08-29T19:00:00.000Z', cimRequestId: `cim-${opportunity.opportunityId}` },
        { id: `crm-call-${opportunity.opportunityId}`, direction: 'outbound', channel: 'phone', kind: 'seller-call', occurredAt: '2026-08-28T19:00:00.000Z', cimRequestId: '' },
      ],
      factObservations: [{ field: 'seller_name', value: opportunity.crmSellerName, provenance: 'crm' }],
      conflicts: [{ field: 'broker_name', winningProvenance: effectiveFacts.broker_name.provenance, crmValue: 'Riley CRM Broker' }],
    },
    history: {
      activities: opportunity.activities.map((activity) => ({ ...activity })),
      dispositions: opportunity.dispositions.map((disposition) => ({ ...disposition })),
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

async function installPhase1AdminRoutes(page, state, { commandCenter = false } = {}) {
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
      role: 'admin',
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

async function installPhase1Fixture(page) {
  const state = createPhase1FixtureState();
  await installPhase1RequestAudit(page, state);
  await installPhase1AdminRoutes(page, state);
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

    const factMatch = path.match(/^\/api\/admin\/deal-hunter\/opportunities\/([^/]+)\/facts\/([^/]+)$/);
    if (method === 'PUT' && factMatch && !url.search) {
      const opportunityId = decodeURIComponent(factMatch[1]);
      const field = decodeURIComponent(factMatch[2]);
      const opportunity = state.opportunities.find((item) => item.opportunityId === opportunityId);
      const body = phase1Body(request);
      if (!opportunity || field !== 'seller_name') throw new Error(`Unexpected Phase 1 fact target: ${path}`);
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['note', 'value', 'verified'])) {
        throw new Error(`Malformed Phase 1 fact payload keys: ${JSON.stringify(body)}`);
      }
      if (body.verified !== true || body.value !== 'Morgan Verified Seller' || body.note !== 'Confirmed directly with the seller on Aug 30.') {
        throw new Error(`Malformed Phase 1 fact payload values: ${JSON.stringify(body)}`);
      }
      const machineScore = opportunity.fitScore;
      const fact = {
        id: 'fact-evergreen-seller',
        field,
        value: body.value,
        verified: true,
        actor: 'phase1-admin',
        note: body.note,
        createdAt: '2026-08-30T20:00:00.000Z',
        updatedAt: '2026-08-30T20:00:00.000Z',
      };
      opportunity.operatorFacts = [...opportunity.operatorFacts.filter((item) => item.field !== field), fact];
      if (opportunity.fitScore !== machineScore) throw new Error('Verified fact changed the machine score in the Phase 1 fixture.');
      state.factPayloads.push({ method, path, body });
      await fulfillPhase1Json(route, { success: true, fact });
      return;
    }

    const actionMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)\/action$/);
    if (method === 'POST' && actionMatch && !url.search) {
      const opportunityId = decodeURIComponent(actionMatch[1]);
      const opportunity = state.opportunities.find((item) => item.opportunityId === opportunityId);
      const body = phase1Body(request);
      if (!opportunity || !['pursue', 'watch', 'pass'].includes(body.action)) throw new Error(`Malformed Phase 1 action target or action: ${path}`);
      const expectedKeys = body.action === 'pass' ? ['action', 'note', 'reason'] : ['action'];
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)) {
        throw new Error(`Malformed Phase 1 action payload keys: ${JSON.stringify(body)}`);
      }
      if (body.action === 'pass' && (body.reason !== 'strategic-fit' || body.note !== 'Focus outside the core acquisition market.')) {
        throw new Error(`Malformed Phase 1 Pass payload values: ${JSON.stringify(body)}`);
      }
      const machineScore = opportunity.fitScore;
      opportunity.reviewed = true;
      opportunity.reviewedAt = '2026-08-30T20:05:00.000Z';
      opportunity.reviewedBy = 'phase1-admin';
      opportunity.changedSinceReview = false;
      if (body.action === 'pursue') opportunity.operatorPriority = 'high';
      if (body.action === 'watch') opportunity.operatorPriority = 'watch';
      if (body.action === 'pass') {
        opportunity.dismissed = true;
        opportunity.dismissedReason = body.reason;
        opportunity.dispositions = [{
          id: 'disposition-cascade-phase1',
          disposition: 'dismissed',
          reason: body.reason,
          note: body.note,
          dismissedAt: '2026-08-30T20:05:00.000Z',
          dismissedBy: 'phase1-admin',
        }, ...opportunity.dispositions];
      }
      opportunity.activities = [{
        id: `activity-${opportunity.opportunityId}-${body.action}`,
        eventType: body.action === 'pass' ? 'opportunity-disposition' : 'opportunity-triaged',
        summary: body.action === 'pursue' ? 'Priority high; marked reviewed.' : body.action === 'watch' ? 'Priority watch; marked reviewed.' : 'Passed with a durable disposition; marked reviewed.',
        createdAt: '2026-08-30T20:05:00.000Z',
        actor: 'phase1-admin',
      }, ...opportunity.activities];
      if (opportunity.fitScore !== machineScore) throw new Error(`${body.action} changed the machine score in the Phase 1 fixture.`);
      state.actionPayloads.push({ method, path, body, machineScore });
      await fulfillPhase1Json(route, {
        success: true,
        ok: true,
        action: body.action,
        opportunity: phase1QueueRow(opportunity),
        ...(body.action === 'pass' ? { disposition: opportunity.dispositions[0] } : {}),
      });
      return;
    }

    const detailMatch = path.match(/^\/api\/admin\/deal-hunter\/triage\/([^/]+)$/);
    if (method === 'GET' && detailMatch && !url.search) {
      const opportunityId = decodeURIComponent(detailMatch[1]);
      const opportunity = state.opportunities.find((item) => item.opportunityId === opportunityId);
      if (!opportunity) throw new Error(`Unexpected Phase 1 detail target: ${path}`);
      await fulfillPhase1Json(route, phase1DetailResponse(opportunity));
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
  await expectPhase1Summary(page, 'Low Confidence', 1);
  await expectPhase1Summary(page, 'Current Opportunities', 4);

  const queue = page.getByRole('list', { name: 'Opportunity queue' });
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
  await expect(dialog.getByText('$520,000', { exact: true })).toBeVisible();
  await expect(dialog.getByText('$2,800,000', { exact: true })).toBeVisible();
  await expect(dialog.getByText('$2,100,000', { exact: true })).toBeVisible();
  await expect(dialog.getByText('4.04×', { exact: true })).toBeVisible();
  const brokerSellerSection = dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..');
  await expect(brokerSellerSection.getByText('Riley Verified Broker', { exact: true })).toBeVisible();
  await expect(brokerSellerSection.getByText('Operator verified', { exact: true })).toBeVisible();
  await expect(brokerSellerSection.getByText('Morgan CRM Seller', { exact: true })).toBeVisible();
  await expect(brokerSellerSection.getByText('CRM', { exact: true }).first()).toBeVisible();
  const missingInformation = dialog.getByRole('region', { name: 'Missing Information' });
  await expect(missingInformation.getByText('Seller email')).toBeVisible();
  await expect(missingInformation.getByText('Customer concentration')).toBeVisible();
  await expect(missingInformation.getByText('Not provided')).toHaveCount(2);
  const scoreSection = dialog.getByRole('heading', { name: 'Score & Evidence' }).locator('..');
  for (const dimension of phase1DimensionLabels) await expect(scoreSection.getByRole('heading', { name: dimension })).toBeVisible();
  await expect(scoreSection.getByText('Profit inside target acquisition band')).toBeVisible();
  await expect(scoreSection.getByText(/Caps: Customer concentration is unverified/)).toBeVisible();
  await expect(scoreSection.getByText(/Missing evidence: Customer Concentration/)).toBeVisible();
  const sourcesSection = dialog.getByRole('heading', { name: 'Sources' }).locator('..');
  await expect(sourcesSection.getByRole('heading', { name: 'Deal Hunter Google Sheet' })).toBeVisible();
  await expect(sourcesSection.getByRole('heading', { name: 'Deal OS' })).toBeVisible();
  await expect(sourcesSection.getByText('Conflict: Annual Profit').first()).toBeVisible();
  await expect(sourcesSection.getByText(/Deal Hunter Google Sheet reported 520000/).first()).toBeVisible();
  await expect(sourcesSection.getByText(/Deal OS reported 475000/).first()).toBeVisible();
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
  await expect(dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..').getByText('Operator verified', { exact: true })).toHaveCount(2);
  await expect(dialog.getByRole('heading', { name: 'Notes & History' }).locator('..').getByText(/Operator fact · Seller Name · Morgan Verified Seller · Verified/)).toBeVisible();
  await expect(dialog.getByText(/Confirmed directly with the seller on Aug 30/).first()).toBeVisible();

  const evergreen = state.opportunities.find((opportunity) => opportunity.opportunityId === 'opp-evergreen');
  evergreen.sourceSellerName = 'Morgan Refreshed Structured Seller';
  evergreen.sourceObservedAt = '2026-08-30T21:00:00.000Z';
  await dialog.getByRole('button', { name: 'Close opportunity detail' }).click();
  await evergreenTrigger.click();
  dialog = page.getByRole('dialog', { name: 'Evergreen Safety Services' });
  const refreshedBrokerSeller = dialog.getByRole('heading', { name: 'Broker & Seller' }).locator('..');
  await expect(refreshedBrokerSeller.getByText('Morgan Verified Seller', { exact: true }).first()).toBeVisible();
  await expect(refreshedBrokerSeller.getByText('Operator verified', { exact: true })).toHaveCount(2);
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
  await page.getByRole('tab', { name: 'All Current' }).click();
  const cascadeTrigger = page.getByRole('button', { name: 'Open Cascade Field Compliance' });
  await expect(cascadeTrigger).toBeVisible();
  const actionCountBeforePass = state.actionPayloads.length;
  await page.getByRole('button', { name: 'Pass Cascade Field Compliance' }).click();
  const passDialog = page.getByRole('dialog', { name: 'Pass Cascade Field Compliance' });
  await expect(passDialog).toBeVisible();
  expect(state.actionPayloads).toHaveLength(actionCountBeforePass);
  await passDialog.getByLabel('Pass reason').fill('strategic-fit');
  await passDialog.getByLabel('Pass note (optional)').fill('Focus outside the core acquisition market.');
  await passDialog.getByRole('button', { name: 'Confirm Pass' }).click();
  await expect.poll(() => state.actionPayloads.length).toBe(actionCountBeforePass + 1);
  await expect(passDialog).toBeHidden();
  await expect(cascadeTrigger).toHaveCount(0);
  const cascade = state.opportunities.find((opportunity) => opportunity.opportunityId === 'opp-cascade');
  expect(cascade.fitScore).toBe(84);

  await page.getByRole('tab', { name: 'Passed' }).click();
  const passedCascade = page.getByRole('button', { name: 'Open Cascade Field Compliance' });
  await expect(passedCascade).toBeVisible();
  const passedRow = passedCascade.locator('..').locator('..');
  await expect(passedRow.getByText('84', { exact: true })).toBeVisible();
  await expect(passedRow.getByText('Passed: Strategic Fit')).toBeVisible();
  await passedCascade.click();
  dialog = page.getByRole('dialog', { name: 'Cascade Field Compliance' });
  await expectPhase1DetailValue(dialog, 'Fit', 84);
  await expect(dialog.getByText('Passed: Strategic Fit').first()).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Disposition history' })).toBeVisible();
  await expect(dialog.getByText(/Passed: Strategic Fit · Focus outside the core acquisition market. · phase1-admin/)).toBeVisible();
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
  expect(state.requests).toHaveLength(29);
  expect(state.requests.map(phase1RequestSignature).sort()).toEqual(expectedDealHunterRequests);
  const independentlyObservedDealHunterRequests = state.apiRequests
    .filter(({ path }) => path.startsWith('/api/admin/deal-hunter/'));
  expect(independentlyObservedDealHunterRequests).toHaveLength(29);
  expect(independentlyObservedDealHunterRequests.map(phase1RequestSignature).sort()).toEqual(expectedDealHunterRequests);
  const expectedInboxApiRequests = [
    ...expectedDealHunterRequests,
    'GET /api/admin/session',
    'GET /api/admin/session',
    'GET /api/admin/onboarding',
    'GET /api/admin/onboarding',
  ].sort();
  expect(state.apiRequests).toHaveLength(33);
  expect(state.apiRequests.map(phase1RequestSignature).sort()).toEqual(expectedInboxApiRequests);
  expect(state.actionPayloads).toEqual([
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-evergreen/action', body: { action: 'pursue' }, machineScore: 92 },
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-evergreen/action', body: { action: 'watch' }, machineScore: 92 },
    { method: 'POST', path: '/api/admin/deal-hunter/triage/opp-cascade/action', body: { action: 'pass', reason: 'strategic-fit', note: 'Focus outside the core acquisition market.' }, machineScore: 84 },
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
