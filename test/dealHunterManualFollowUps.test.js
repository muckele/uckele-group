import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_SESSION_SECRET = 'phase3-task3-manual-follow-up-secret';
process.env.DELIVERY_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_task3_local_only';
process.env.RESEND_FROM_EMAIL = 'Mathew Uckele <buyer@example.test>';
process.env.RESEND_REPLY_TO = 'replies@example.test';
process.env.LEAD_NOTIFICATION_EMAIL = 'admin@example.test';
process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED = 'false';
process.env.DEAL_HUNTER_CIM_RECIPIENT_24_HOUR_CAP = '100';
process.env.DEAL_HUNTER_CIM_RECIPIENT_30_DAY_TOUCH_CAP = '100';

const {
  approveDealHunterManualFollowUp,
  parseManualFollowUpApprovalInput,
  parseManualFollowUpPreparationInput,
  parseManualFollowUpStartInput,
  parseManualFollowUpStopInput,
  prepareDealHunterManualFollowUp,
  startDealHunterManualFollowUps,
  stopDealHunterManualFollowUps,
} = await import('../server/services/dealHunterManualFollowUps.js');
const { verifySignedPayload } = await import('../server/utils/security.js');
const { getConfig } = await import('../server/config.js');
const { buildManualFollowUpCommunicationId } = await import('../server/services/dealHunterManualFollowUpPolicy.js');

const opportunityId = 'opp-task3-manual-follow-up';
const requestId = 'request-task3-manual-follow-up';
const submissionId = 'submission-task3-manual-follow-up';
const administrator = { principal_id: 'principal-task3-admin', role: 'admin', username: 'task3-admin' };
const viewer = { principal_id: 'principal-task3-viewer', role: 'viewer', username: 'task3-viewer' };
const dueNow = new Date();
dueNow.setUTCHours(dueNow.getUTCHours() - 2);
const acceptedAt = new Date(dueNow);
acceptedAt.setUTCDate(acceptedAt.getUTCDate() - 4);

function initialCommunication(overrides = {}) {
  return {
    id: 'initial-communication-task3', submission_id: submissionId, opportunity_id: opportunityId,
    cim_request_id: requestId, direction: 'outbound', kind: 'deal-hunter-cim-request',
    provider: 'resend', provider_message_id: 'resend-initial-task3', delivery_state: 'accepted',
    delivery_state_at: acceptedAt.toISOString(), to_addresses: ['broker@example.test'],
    subject: 'CIM / NDA request for Durable Services Co', body_text: 'Initial request',
    body_html_sanitized: '<p>Initial request</p>', created_at: acceptedAt.toISOString(),
    updated_at: acceptedAt.toISOString(), metadata: {}, ...overrides,
  };
}

function baseRequest(overrides = {}) {
  return {
    id: requestId, opportunity_id: opportunityId, submission_id: submissionId, deal_key: 'deal-task3',
    recipient_email: 'broker@example.test', requested_by: 'phase2-admin', status: 'sent',
    request_state: 'provider_accepted', delivery_state: 'accepted', follow_up_state: 'not-scheduled',
    follow_up_count: 0, next_follow_up_at: null, last_follow_up_at: null, responded_at: null,
    first_provider_accepted_at: acceptedAt.toISOString(), subject: 'CIM / NDA request for Durable Services Co',
    deal_name: 'Durable Services Co', listing_url: 'https://broker.example.test/durable-services',
    created_at: acceptedAt.toISOString(), updated_at: new Date(acceptedAt.getTime() + 1000).toISOString(),
    metadata: {
      initialCommunicationId: 'initial-communication-task3',
      manualApproval: { intent: 'manual_stage_1', followUpPolicy: 'none', administratorPrincipalId: 'phase2-principal' },
      industry: 'Commercial services', location: 'Los Angeles, CA', brokerName: 'Avery Broker',
    },
    ...overrides,
  };
}

function manualMarker(overrides = {}) {
  return {
    version: 'deal-hunter-manual-follow-up-v1', mode: 'operator-approved', maximumFollowUps: 5,
    cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
    enrolledAt: new Date(acceptedAt.getTime() + 2000).toISOString(), enrolledBy: administrator.username,
    ...overrides,
  };
}

function markedRequest(overrides = {}) {
  const request = baseRequest({
    follow_up_state: 'scheduled', next_follow_up_at: dueNow.toISOString(),
    updated_at: new Date(acceptedAt.getTime() + 3000).toISOString(),
  });
  return {
    ...request,
    ...overrides,
    metadata: { ...request.metadata, manualFollowUp: manualMarker(), ...(overrides.metadata || {}) },
  };
}

function sourceRow(field, value, id = field) {
  return {
    id: `source-${id}`, opportunity_id: opportunityId, source_id: 'sheet', source_name: 'Deal Hunter Sheet',
    source_record_id: 'row-task3', field, value, observed_at: acceptedAt.toISOString(),
    created_at: acceptedAt.toISOString(), updated_at: acceptedAt.toISOString(),
  };
}

function task3Storage({ request = baseRequest(), communications = [initialCommunication()] } = {}) {
  const state = {
    opportunity: {
      opportunity_id: opportunityId, canonical_name: 'Durable Services Co', canonical_location: 'Los Angeles, CA',
      primary_submission_id: submissionId, identity_version: 'identity-task3-v1', status: 'active',
      created_at: acceptedAt.toISOString(), updated_at: acceptedAt.toISOString(), metadata: {},
    },
    score: {
      opportunity_id: opportunityId, deal_key: 'deal-task3', name: 'Durable Services Co', fit_score: 82,
      score_fingerprint: 'score-task3', semantic_digest: 'semantic-task3', reviewed_fingerprint: 'score-task3',
      reviewed_semantic_digest: 'semantic-task3', reviewed_at: acceptedAt.toISOString(), reviewed_by: 'task3-admin',
      operator_priority: 'high', changed_since_review: false, should_remove: false,
      listing_url: 'https://broker.example.test/durable-services', scored_at: acceptedAt.toISOString(), metadata: {},
    },
    submission: {
      id: submissionId, status: 'active', company: 'Durable Services Co', broker_name: 'Avery Broker',
      broker_email: 'broker@example.test', updated_at: new Date(acceptedAt.getTime() + 500).toISOString(), metadata: {},
    },
    request,
    requests: [request],
    communications: [...communications],
    dispositions: [], secureDocuments: [], latestUploadRequest: null, suppression: null,
    recipientClaim: null, opportunityClaim: null, safety: { outreach_paused: false, metadata: {} },
    calls: { start: 0, stop: 0, claim: 0, finalize: 0, provider: 0 },
  };
  const storage = {
    state,
    async getCurrentDealHunterOpportunity(id) { return id === opportunityId ? state.opportunity : null; },
    async getCurrentDealHunterOpportunityScore(id) { return id === opportunityId ? state.score : null; },
    async listDealHunterOpportunityAliases() {
      return [{ id: 'alias-task3', opportunity_id: opportunityId, alias_type: 'deal-key', alias_value: 'deal-task3', alias_key: 'deal-key:deal-task3', evidence_version: 'v1', confidence_state: 'exact' }];
    },
    async listDealHunterOpportunityFacts() { return []; },
    async listDealHunterOpportunitySourceObservations() {
      return [sourceRow('name', 'Durable Services Co'), sourceRow('broker_email', 'broker@example.test'), sourceRow('broker_first_name', 'Avery')];
    },
    async getSubmission(id) { return id === submissionId ? state.submission : null; },
    async listSecureDocumentsForSubmission() { return state.secureDocuments; },
    async getLatestSecureUploadRequestForSubmission() { return state.latestUploadRequest; },
    async listDealHunterCimRequests({ opportunityIds = [], dealKeys = [], recipientEmails = [] } = {}) {
      const candidates = [...new Map([...state.requests, state.request].map((candidate) => [candidate.id, candidate])).values()];
      return candidates.filter((candidate) => (
        (!opportunityIds.length || opportunityIds.includes(candidate.opportunity_id))
        && (!dealKeys.length || dealKeys.includes(candidate.deal_key))
        && (!recipientEmails.length || recipientEmails.includes(candidate.recipient_email))
      ));
    },
    async getDealHunterCimRequestById(id) {
      return state.request.id === id ? state.request : state.requests.find((candidate) => candidate.id === id) || null;
    },
    async listDealHunterDispositions() { return state.dispositions; },
    async listDealHunterIdentityExceptions() { return []; },
    async getDealHunterCimOpportunityClaim() { return state.opportunityClaim; },
    async getDealHunterCimRecipientClaim() { return state.recipientClaim; },
    async getActiveEmailSuppression() { return state.suppression; },
    async getDealHunterCimSafetySettings() { return state.safety; },
    async listCrmCommunications({ submissionId: id } = {}) {
      const rows = state.communications.filter((row) => !id || row.submission_id === id);
      return { rows, total: rows.length };
    },
    async getCrmCommunication(id) { return state.communications.find((row) => row.id === id) || null; },
    async listEmailEvents() { return []; },
    async listEmailEventsByMessageIds() { return []; },
    async startDealHunterManualFollowUps(input) {
      state.calls.start += 1;
      state.request = { ...state.request, updated_at: input.marker.enrolledAt, follow_up_state: 'scheduled', next_follow_up_at: input.nextFollowUpAt, metadata: { ...state.request.metadata, manualFollowUp: input.marker } };
      state.requests = state.requests.map((candidate) => candidate.id === state.request.id ? state.request : candidate);
      return { applied: true, reason: '', request: state.request, activity: input.activity, alreadyFinalized: false };
    },
    async stopDealHunterManualFollowUps(input) {
      state.calls.stop += 1;
      state.request = { ...state.request, updated_at: input.stoppedAt, follow_up_state: 'stopped', next_follow_up_at: null, metadata: { ...state.request.metadata, manualFollowUp: { ...state.request.metadata.manualFollowUp, stoppedAt: input.stoppedAt, stoppedBy: input.stoppedBy, stopReason: input.reason } } };
      state.requests = state.requests.map((candidate) => candidate.id === state.request.id ? state.request : candidate);
      return { applied: true, reason: '', request: state.request, activity: input.activity, alreadyFinalized: false };
    },
  };
  return storage;
}

const dependencies = {
  async getReadiness() { return { outboundConfigured: true, provider: 'resend', issues: [] }; },
  async evaluateRecipientPolicy() { return { allowed: true, reason: '', touches24Hours: 0, touches30Days: 0, override: null }; },
  evaluateWindow() { return { allowed: true, reason: '' }; },
};

async function prepare(storage, options = {}) {
  return prepareDealHunterManualFollowUp({
    opportunityId, requestId, session: administrator, storage, now: new Date(), dependencies,
    ...options,
  });
}

test('Start Follow-Up Sequence requires administrator canonical request accepted proof and strict empty input', async () => {
  assert.deepEqual(parseManualFollowUpStartInput({}), {});
  assert.throws(() => parseManualFollowUpStartInput({ requestId }), /unknown/i);
  const storage = task3Storage();
  const forbidden = await startDealHunterManualFollowUps({ opportunityId, requestId, session: viewer, storage, now: new Date(), dependencies });
  assert.equal(forbidden.status, 403);
  storage.state.request = { ...storage.state.request, metadata: {} };
  const missingLineage = await startDealHunterManualFollowUps({ opportunityId, requestId, session: administrator, storage, now: new Date(), dependencies });
  assert.equal(missingLineage.code, 'initial_approval_authority_missing');
  storage.state.request = baseRequest({ opportunity_id: 'different-opportunity' });
  const wrongOwner = await startDealHunterManualFollowUps({ opportunityId, requestId, session: administrator, storage, now: new Date(), dependencies });
  assert.equal(wrongOwner.success, false);
  assert.equal(storage.state.calls.start, 0);
});

test('Start Follow-Up Sequence atomically enrolls without claim communication activity duplication or provider work', async () => {
  const storage = task3Storage();
  const communicationCount = storage.state.communications.length;
  const result = await startDealHunterManualFollowUps({ opportunityId, requestId, input: {}, session: administrator, storage, now: new Date(), dependencies });
  assert.equal(result.success, true);
  assert.equal(result.followUps.state, 'overdue');
  assert.equal(storage.state.calls.start, 1);
  assert.equal(storage.state.calls.claim, 0);
  assert.equal(storage.state.calls.provider, 0);
  assert.equal(storage.state.communications.length, communicationCount);
  assert.equal(storage.state.request.follow_up_count, 0);
});

test('Start and final executor reject a stale accepted request when a newer canonical request owns the current opportunity', async () => {
  // Break caught: route membership alone can authorize an older accepted
  // conversation after a newer request becomes the canonical current owner.
  const stale = baseRequest({ updated_at: '2026-08-28T18:00:00.000Z' });
  const currentId = 'request-task3-current-owner';
  const currentInitialId = 'initial-communication-task3-current-owner';
  const current = baseRequest({
    id: currentId,
    recipient_email: 'current-broker@example.test',
    updated_at: '2026-09-01T18:00:00.000Z',
    metadata: {
      ...baseRequest().metadata,
      initialCommunicationId: currentInitialId,
    },
  });
  const currentInitial = initialCommunication({
    id: currentInitialId,
    cim_request_id: currentId,
    to_addresses: ['current-broker@example.test'],
  });
  const staleStorage = task3Storage({ request: stale, communications: [initialCommunication(), currentInitial] });
  staleStorage.state.requests = [stale, current];

  const staleStart = await startDealHunterManualFollowUps({
    opportunityId, requestId, session: administrator, storage: staleStorage, now: new Date(), dependencies,
  });
  assert.equal(staleStart.success, false);
  assert.equal(staleStart.code, 'request_not_found');
  assert.equal(staleStorage.state.calls.start, 0);

  const staleMarked = markedRequest({ updated_at: '2026-08-28T19:00:00.000Z' });
  staleStorage.state.request = staleMarked;
  staleStorage.state.requests = [staleMarked, current];
  const stalePreparation = await prepare(staleStorage);
  assert.equal(stalePreparation.success, false);
  assert.equal(stalePreparation.code, 'request_not_found');

  const currentStorage = task3Storage({ request: current, communications: [currentInitial] });
  const currentStart = await startDealHunterManualFollowUps({
    opportunityId, requestId: currentId, session: administrator, storage: currentStorage, now: new Date(), dependencies,
  });
  assert.equal(currentStart.success, true, currentStart.error);

  const approvalStorage = task3Storage({ request: markedRequest() });
  const prepared = await prepare(approvalStorage);
  assert.equal(prepared.success, true, prepared.error);
  approvalStorage.state.requests.push(current);
  let executorCalls = 0;
  const staleApproval = await approveDealHunterManualFollowUp({
    opportunityId,
    requestId,
    preparationToken: prepared.preparationToken,
    approvedProposalDigest: prepared.proposalDigest,
    session: administrator,
    storage: approvalStorage,
    now: new Date(),
    dependencies,
    executeApprovedFollowUp: async () => { executorCalls += 1; },
  });
  assert.equal(staleApproval.success, false);
  assert.equal(staleApproval.code, 'request_not_found');
  assert.equal(executorCalls, 0);

  const finalBoundaryStorage = task3Storage({ request: markedRequest() });
  const finalBoundaryPreparation = await prepare(finalBoundaryStorage);
  assert.equal(finalBoundaryPreparation.success, true, finalBoundaryPreparation.error);
  let finalProviderCalls = 0;
  const finalBoundary = await approveDealHunterManualFollowUp({
    opportunityId,
    requestId,
    preparationToken: finalBoundaryPreparation.preparationToken,
    approvedProposalDigest: finalBoundaryPreparation.proposalDigest,
    session: administrator,
    storage: finalBoundaryStorage,
    now: new Date(),
    dependencies,
    executeApprovedFollowUp: async ({ approvedContext }) => {
      finalBoundaryStorage.state.requests.push(current);
      const stillCurrent = await approvedContext.revalidateCurrentAuthority();
      if (!stillCurrent) return { status: 'locked', request: finalBoundaryStorage.state.request };
      finalProviderCalls += 1;
      return { status: 'sent', request: finalBoundaryStorage.state.request };
    },
  });
  assert.equal(finalBoundary.success, false);
  assert.equal(finalBoundary.code, 'authority_changed');
  assert.equal(finalProviderCalls, 0);
});

test('Start Follow-Up Sequence rejects reply materials pass archive suppression ambiguity active legacy schedule stopped and count five', async (t) => {
  const cases = [
    ['reply', { request: baseRequest({ responded_at: new Date().toISOString(), request_state: 'responded' }) }],
    ['materials', { secureDocuments: [{ id: 'doc-cim', document_type: 'cim', original_name: 'CIM.pdf' }] }],
    ['pass', { dispositions: [{ id: 'pass-1', disposition: 'dismissed' }] }],
    ['archive', { submission: { ...task3Storage().state.submission, status: 'archived' } }],
    ['suppression', { suppression: { id: 'suppression-1', reason: 'complaint' } }],
    ['ambiguity', { request: baseRequest({ status: 'ambiguous', request_state: 'provider_ambiguous', delivery_state: 'ambiguous' }) }],
    ['legacy schedule', { request: baseRequest({ follow_up_state: 'scheduled', next_follow_up_at: dueNow.toISOString() }) }],
    ['stopped', { request: baseRequest({ follow_up_state: 'stopped' }) }],
    ['count five', { request: baseRequest({ follow_up_count: 5 }) }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const storage = task3Storage({ request: overrides.request || baseRequest() });
      Object.assign(storage.state, overrides);
      const result = await startDealHunterManualFollowUps({ opportunityId, requestId, session: administrator, storage, now: new Date(), dependencies });
      assert.equal(result.success, false);
      assert.equal(storage.state.calls.start, 0);
    });
  }
});

test('Stop Follow-Ups requires administrator accepts only bounded reason and permanently invalidates open preparation', async () => {
  assert.deepEqual(parseManualFollowUpStopInput({ reason: '  No longer pursuing  ' }), { reason: 'No longer pursuing' });
  assert.throws(() => parseManualFollowUpStopInput({ reason: 'x'.repeat(241) }), /240/);
  assert.throws(() => parseManualFollowUpStopInput({ reason: 'valid', restart: true }), /unknown/i);
  const storage = task3Storage({ request: markedRequest() });
  const prepared = await prepare(storage);
  assert.ok(prepared.preparationToken);
  const forbidden = await stopDealHunterManualFollowUps({ opportunityId, requestId, reason: '', session: viewer, storage, now: new Date(), dependencies });
  assert.equal(forbidden.status, 403);
  const stopped = await stopDealHunterManualFollowUps({ opportunityId, requestId, reason: 'No longer pursuing', session: administrator, storage, now: new Date(), dependencies });
  assert.equal(stopped.success, true);
  assert.equal(stopped.followUps.state, 'stopped');
  assert.equal(storage.state.request.follow_up_count, 0);
  const stale = await approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: prepared.preparationToken, approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: async () => assert.fail('stopped authority must not execute') });
  assert.equal(stale.success, false);
});

test('Prepare Follow-Up is side-effect-free principal-bound expires in fifteen minutes and returns no authority to viewers', async () => {
  assert.deepEqual(parseManualFollowUpPreparationInput({ greeting: '  Hello Avery,  ' }), { greeting: 'Hello Avery,' });
  assert.throws(() => parseManualFollowUpPreparationInput({ greeting: 'Hello\nAvery,' }), /plain text/i);
  assert.throws(() => parseManualFollowUpPreparationInput({ greeting: '<strong>Hello</strong>' }), /plain text/i);
  assert.throws(() => parseManualFollowUpPreparationInput({ greeting: 'x'.repeat(121) }), /120/);
  const storage = task3Storage({ request: markedRequest() });
  const before = structuredClone(storage.state.request);
  const admin = await prepare(storage);
  assert.equal(admin.success, true);
  const claims = verifySignedPayload(admin.preparationToken, getConfig().admin.sessionSecret);
  assert.equal(claims.typ, 'deal-hunter-manual-follow-up-proposal-v1');
  assert.equal(claims.administratorPrincipalId, administrator.principal_id);
  assert.ok(claims.exp - Date.parse(claims.preparedAt) <= 15 * 60 * 1000);
  assert.equal(claims.proposal.canonicalAuthorityRevision.length, 64);
  assert.equal(claims.proposal.aliasResolutionFingerprint.length, 64);
  assert.deepEqual(storage.state.request, before);
  assert.equal(storage.state.communications.length, 1);
  const shortNow = new Date();
  const shortAuthorityExpiry = new Date(shortNow.getTime() + 5 * 60 * 1000).toISOString();
  const listSourceRows = storage.listDealHunterOpportunitySourceObservations.bind(storage);
  storage.listDealHunterOpportunitySourceObservations = async (...args) => (
    (await listSourceRows(...args)).map((row, index) => (index === 0 ? { ...row, expires_at: shortAuthorityExpiry } : row))
  );
  const shortened = await prepare(storage, { now: shortNow });
  const shortenedClaims = verifySignedPayload(shortened.preparationToken, getConfig().admin.sessionSecret);
  assert.equal(shortenedClaims.exp, Date.parse(shortAuthorityExpiry));
  const preview = await prepareDealHunterManualFollowUp({ opportunityId, requestId, session: viewer, storage, now: new Date(), dependencies });
  assert.equal(preview.previewOnly, true);
  assert.equal(Object.hasOwn(preview, 'preparationToken'), false);
  assert.equal(Object.hasOwn(preview, 'proposalDigest'), false);
  const unauthenticatedViewer = await prepareDealHunterManualFollowUp({ opportunityId, requestId, session: { role: 'viewer' }, storage, now: new Date(), dependencies });
  assert.equal(unauthenticatedViewer.code, 'authenticated_access_required');
});

test('viewer preview ignores or rejects greeting input and advertises no editable message fields', async () => {
  // Break caught: a viewer-supplied greeting can alter the server preview and
  // the response advertises an edit capability the viewer does not own.
  const storage = task3Storage({ request: markedRequest() });
  const defaultPreview = await prepareDealHunterManualFollowUp({
    opportunityId, requestId, session: viewer, storage, now: new Date(), dependencies,
  });
  const customized = await prepareDealHunterManualFollowUp({
    opportunityId, requestId, input: { greeting: 'Forged viewer greeting,' },
    session: viewer, storage, now: new Date(), dependencies,
  });
  assert.equal(customized.success, true, customized.error);
  assert.equal(customized.review.message.greeting, defaultPreview.review.message.greeting);
  assert.equal(customized.review.message.greetingEditable, false);
  assert.equal(Object.hasOwn(customized, 'preparationToken'), false);
  assert.equal(Object.hasOwn(customized, 'proposalDigest'), false);

  const administratorPreview = await prepare(storage, { greeting: 'Administrator greeting,' });
  assert.equal(administratorPreview.review.message.greeting, 'Administrator greeting,');
  assert.equal(administratorPreview.review.message.greetingEditable, true);
});

test('Prepare Follow-Up rejects early terminal ambiguous stopped completed and missing-authority states', async (t) => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cases = [
    ['early', markedRequest({ next_follow_up_at: future }), 'not_due'],
    ['reply', markedRequest({ responded_at: new Date().toISOString(), request_state: 'responded' }), 'blocked'],
    ['ambiguous', markedRequest({ follow_up_state: 'ambiguous', next_follow_up_at: null }), 'outcome_unresolved'],
    ['stopped', markedRequest({ follow_up_state: 'stopped', next_follow_up_at: null }), 'blocked'],
    ['completed', markedRequest({ follow_up_count: 5, follow_up_state: 'completed', next_follow_up_at: null }), 'already_finalized'],
    ['missing marker', baseRequest(), 'approval_required'],
  ];
  for (const [name, request, code] of cases) {
    await t.test(name, async () => {
      const result = await prepare(task3Storage({ request }));
      assert.equal(result.success, false);
      assert.equal(result.code, code);
    });
  }
  await t.test('critical material authority unavailable', async () => {
    const storage = task3Storage({ request: markedRequest() });
    storage.listSecureDocumentsForSubmission = undefined;
    const result = await prepare(storage);
    assert.equal(result.success, false);
    assert.equal(result.code, 'authority_unavailable');
  });
  await t.test('critical event authority unavailable', async () => {
    const storage = task3Storage({ request: markedRequest() });
    storage.listEmailEvents = undefined;
    storage.listEmailEventsByMessageIds = undefined;
    const result = await prepare(storage);
    assert.equal(result.success, false);
    assert.equal(result.code, 'authority_unavailable');
  });
});

test('Prepare Follow-Up exposes pause cadence readiness and delivery blockers without creating authority', async () => {
  const storage = task3Storage({ request: markedRequest({ delivery_state: 'delayed' }) });
  storage.state.safety = { outreach_paused: true, metadata: {} };
  const result = await prepare(storage, {
    dependencies: {
      async getReadiness() { return { outboundConfigured: false, issues: ['Provider unavailable.'] }; },
      async evaluateRecipientPolicy() { return { allowed: false, reason: 'recipient-24-hour-cap', override: null }; },
      evaluateWindow() { return { allowed: true, reason: '' }; },
    },
  });
  assert.equal(result.success, true);
  assert.ok(result.preparationToken, 'safe review still receives fresh administrator authority');
  assert.deepEqual(result.sendBlockers.map(({ code }) => code).sort(), [
    'cim_outreach_paused', 'delivery_delayed', 'provider_not_ready', 'recipient_cadence',
  ]);
  assert.equal(storage.state.calls.claim, 0);
  assert.equal(storage.state.calls.provider, 0);
  const outsideWindow = await prepare(task3Storage({ request: markedRequest() }), {
    dependencies: {
      ...dependencies,
      evaluateWindow() { return { allowed: false, reason: 'weekend' }; },
    },
  });
  assert.equal(outsideWindow.success, true);
  assert.equal(outsideWindow.sendBlockers.some((blocker) => blocker.code === 'weekend'), true);
});

test('Approve Follow-Up accepts only token and digest and independently rejects early send', async () => {
  assert.deepEqual(parseManualFollowUpApprovalInput({ preparationToken: 'x.y', approvedProposalDigest: 'a'.repeat(64) }), { preparationToken: 'x.y', approvedProposalDigest: 'a'.repeat(64) });
  assert.throws(() => parseManualFollowUpApprovalInput({ preparationToken: 'x.y', approvedProposalDigest: 'a'.repeat(64), recipient: 'attacker@example.test' }), /unknown/i);
  const storage = task3Storage({ request: markedRequest() });
  const prepared = await prepare(storage);
  storage.state.request = { ...storage.state.request, next_follow_up_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() };
  let executions = 0;
  const result = await approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: prepared.preparationToken, approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: async () => { executions += 1; } });
  assert.equal(result.success, false);
  assert.equal(result.code, 'not_due');
  assert.equal(executions, 0);

  const pausedStorage = task3Storage({ request: markedRequest() });
  const pausedPreparation = await prepare(pausedStorage);
  const paused = await approveDealHunterManualFollowUp({
    opportunityId,
    requestId,
    preparationToken: pausedPreparation.preparationToken,
    approvedProposalDigest: pausedPreparation.proposalDigest,
    session: administrator,
    storage: pausedStorage,
    now: new Date(),
    dependencies: { ...dependencies, async getPause() { return { paused: true }; } },
    executeApprovedFollowUp: async () => { executions += 1; },
  });
  assert.equal(paused.success, false);
  assert.equal(executions, 0);

  const windowStorage = task3Storage({ request: markedRequest() });
  const windowPreparation = await prepare(windowStorage);
  const outsideWindow = await approveDealHunterManualFollowUp({
    opportunityId,
    requestId,
    preparationToken: windowPreparation.preparationToken,
    approvedProposalDigest: windowPreparation.proposalDigest,
    session: administrator,
    storage: windowStorage,
    now: new Date(),
    dependencies: { ...dependencies, evaluateWindow() { return { allowed: false, reason: 'weekend' }; } },
    executeApprovedFollowUp: async () => { executions += 1; },
  });
  assert.equal(outsideWindow.success, false);
  assert.equal(outsideWindow.code, 'send_blocked');
  assert.equal(executions, 0);
});

test('Approve Follow-Up rejects stale request submission count due recipient copy sender materials reply stop pass archive suppression and delivery authority', async (t) => {
  const mutations = [
    ['canonical identity', (state) => { state.opportunity.identity_version = 'identity-task3-v2'; }],
    ['request', (state) => { state.request.updated_at = new Date().toISOString(); }],
    ['submission', (state) => { state.submission.updated_at = new Date().toISOString(); }],
    ['count', (state) => { state.request.follow_up_count = 1; }],
    ['due', (state) => { state.request.next_follow_up_at = new Date(Date.now() - 60_000).toISOString(); }],
    ['recipient', (state) => { state.request.recipient_email = 'other@example.test'; }],
    ['materials', (state) => { state.secureDocuments = [{ id: 'cim', document_type: 'cim' }]; }],
    ['reply', (state) => { state.request.responded_at = new Date().toISOString(); state.request.request_state = 'responded'; }],
    ['stop', (state) => { state.request.follow_up_state = 'stopped'; state.request.metadata.manualFollowUp.stoppedAt = new Date().toISOString(); }],
    ['pass', (state) => { state.dispositions = [{ id: 'pass', disposition: 'dismissed' }]; }],
    ['archive', (state) => { state.submission.status = 'archived'; }],
    ['suppression', (state) => { state.suppression = { id: 's', reason: 'complaint' }; }],
    ['delivery', (state) => { state.request.delivery_state = 'bounced'; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const storage = task3Storage({ request: markedRequest() });
      const prepared = await prepare(storage);
      mutate(storage.state);
      let executions = 0;
      const result = await approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: prepared.preparationToken, approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: async () => { executions += 1; } });
      assert.equal(result.success, false);
      assert.equal(executions, 0);
    });
  }
});

test('Approve Follow-Up reproduces the exact signed greeting subject text html template communication id and provider key', async () => {
  const storage = task3Storage({ request: markedRequest() });
  const prepared = await prepare(storage, { greeting: 'Hello Avery,' });
  let trusted;
  const approved = await approveDealHunterManualFollowUp({
    opportunityId, requestId, preparationToken: prepared.preparationToken,
    approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies,
    executeApprovedFollowUp: async ({ approvedContext }) => {
      trusted = approvedContext;
      return { status: 'sent', request: storage.state.request, emailResult: { status: 'sent', providerMessageId: 'provider-task3' } };
    },
  });
  assert.equal(approved.success, true);
  assert.equal(trusted.message.greeting, 'Hello Avery,');
  assert.equal(trusted.message.subject, prepared.review.message.subject);
  assert.equal(trusted.message.text, prepared.review.message.body);
  assert.equal(trusted.message.html, prepared.review.message.html);
  assert.equal(trusted.message.templateVersion, prepared.review.message.templateVersion);
  assert.equal(trusted.message.communicationId, prepared.review.communication.id);
  assert.equal(trusted.message.idempotencyKey, prepared.review.communication.providerIdempotencyKey);
  assert.deepEqual(trusted.sender, prepared.review.sender);
  assert.equal(trusted.message.from, `${prepared.review.sender.displayName} <${prepared.review.sender.email}>`);
  assert.equal(Object.hasOwn(trusted, 'preparationToken'), false);
  assert.equal(Object.hasOwn(trusted, 'approvedProposalDigest'), false);
});

test('definitive failure retry prepares exact persisted read-only content and uses a fresh approval', async () => {
  const communicationId = buildManualFollowUpCommunicationId({ requestId, followUpNumber: 1 });
  const first = markedRequest({ follow_up_state: 'failed', status: 'follow_up_failed' });
  first.metadata.manualFollowUp.currentAttempt = { followUpNumber: 1, communicationId, outcome: 'definitive-failure', originalDueAt: first.next_follow_up_at };
  const persisted = initialCommunication({
    id: communicationId, kind: 'deal-hunter-cim-follow-up', delivery_state: 'failed', provider_message_id: null,
    idempotency_key: `deal-hunter-cim-${requestId}-follow-up-1`, to_addresses: ['broker@example.test'],
    subject: 'Persisted subject', body_text: 'Persisted exact retry text', body_html_sanitized: '<p>Persisted exact retry text</p>',
    from_address: 'buyer@example.test', reply_to_address: `cim-${requestId.slice(0, 32)}@example.test`,
    metadata: {
      followUpNumber: 1, greeting: 'Hello Avery,', templateVersion: 'deal-hunter-cim-follow-up-1-v1',
      manualApproval: {
        greeting: 'Hello Avery,', senderDisplayName: 'Mathew Uckele', senderEmail: 'buyer@example.test',
        senderFrom: 'Mathew Uckele <buyer@example.test>', replyTo: `cim-${requestId.slice(0, 32)}@example.test`,
      },
    },
  });
  const storage = task3Storage({ request: first, communications: [initialCommunication(), persisted] });
  const rejectedEdit = await prepare(storage, { greeting: 'Changed greeting,' });
  assert.equal(rejectedEdit.success, false);
  assert.equal(rejectedEdit.code, 'retry_message_immutable');
  const retry = await prepare(storage);
  assert.equal(retry.success, true);
  assert.equal(retry.review.mode, 'exact-retry');
  assert.equal(retry.review.message.body, persisted.body_text);
  assert.equal(retry.review.message.greetingEditable, false);
  const second = await prepare(storage);
  assert.notEqual(retry.preparationToken, second.preparationToken);
});

test('ambiguous follow-up permits status and reconciliation but never retransmission', async () => {
  const request = markedRequest({ follow_up_state: 'ambiguous', status: 'follow_up_failed', next_follow_up_at: null });
  request.metadata.manualFollowUp.currentAttempt = { followUpNumber: 1, communicationId: 'follow-up-one', outcome: 'ambiguous' };
  const storage = task3Storage({ request });
  const result = await prepare(storage);
  assert.equal(result.success, false);
  assert.equal(result.code, 'outcome_unresolved');
  assert.equal(storage.state.calls.provider, 0);
});

test('ambiguity proof requires the communication exact ambiguous timestamp in SQLite and Supabase', async () => {
  const communicationId = buildManualFollowUpCommunicationId({ requestId, followUpNumber: 1 });
  const rows = {
    crm_communications: [{
      id: communicationId,
      cim_request_id: requestId,
      submission_id: submissionId,
      idempotency_key: `deal-hunter-cim-${requestId}-follow-up-1`,
      delivery_state: 'ambiguous',
      delivery_state_at: '2026-09-01T18:00:00.000Z',
      provider: 'resend',
      provider_message_id: null,
    }],
    deal_hunter_cim_requests: [{ id: requestId, submission_id: submissionId }],
    contact_submissions: [{ id: submissionId, updated_at: '2026-09-01T17:00:00.000Z' }],
    crm_email_outbox: [],
  };
  const client = {
    from(table) {
      let filters = [];
      let inserted = null;
      const query = {
        select() { return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        insert(value) { inserted = value; return query; },
        async maybeSingle() {
          return { data: rows[table].find((row) => filters.every(([field, value]) => row[field] === value)) || null, error: null };
        },
        async single() {
          if (!inserted) return { data: null, error: new Error('insert required') };
          const duplicate = rows[table].find((row) => row.communication_id === inserted.communication_id);
          if (duplicate) return { data: null, error: { code: '23505' } };
          rows[table].push(structuredClone(inserted));
          return { data: structuredClone(inserted), error: null };
        },
      };
      return query;
    },
  };
  const { createSupabaseStorage } = await import('../server/storage/supabase.js');
  const storage = createSupabaseStorage(
    { storage: { supabaseUrl: 'https://project.supabase.invalid', supabaseServiceRoleKey: 'service-role-test' } },
    { client },
  );
  const input = {
    requestId,
    submissionId,
    communicationId,
    idempotencyKey: `deal-hunter-cim-${requestId}-follow-up-1`,
    actor: 'task3-admin',
    ambiguousAt: '2026-09-01T18:00:00.000Z',
    error: 'provider outcome unknown',
  };
  const wrongTimestamp = await storage.recordDealHunterManualFollowUpAmbiguity({
    ...input,
    ambiguousAt: '2026-09-01T18:00:01.000Z',
  });
  assert.equal(wrongTimestamp, null);
  assert.equal(rows.crm_email_outbox.length, 0);
  const first = await storage.recordDealHunterManualFollowUpAmbiguity(input);
  const second = await storage.recordDealHunterManualFollowUpAmbiguity(input);
  assert.equal(first.state, 'ambiguous');
  assert.deepEqual(second, first);
  assert.equal(rows.crm_email_outbox.length, 1);
  const mismatched = await storage.recordDealHunterManualFollowUpAmbiguity({ ...input, idempotencyKey: 'wrong-key' });
  assert.equal(mismatched, null);
  const duplicateWrongTimestamp = await storage.recordDealHunterManualFollowUpAmbiguity({
    ...input,
    ambiguousAt: '2026-09-01T18:00:02.000Z',
  });
  assert.equal(duplicateWrongTimestamp, null);
  assert.equal(rows.crm_email_outbox.length, 1);
});

test('accepted follow-up reconciliation increments and schedules exactly once without retransmission', async () => {
  const storage = task3Storage({ request: markedRequest() });
  const prepared = await prepare(storage);
  let contexts = 0;
  const result = await approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: prepared.preparationToken, approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: async ({ approvedContext }) => { contexts += 1; return { status: 'sent', reconciled: true, request: { ...storage.state.request, follow_up_count: 1 }, approvedContext }; } });
  assert.equal(result.success, true);
  assert.equal(result.durableResult.followUps.followUpCount, 1);
  assert.equal(contexts, 1);
  assert.equal(storage.state.calls.provider, 0);
});

test('duplicate approval two administrators and multiple tabs converge on one communication and one provider call', async () => {
  const storage = task3Storage({ request: markedRequest() });
  const adminTwo = { principal_id: 'principal-task3-admin-two', role: 'admin', username: 'task3-admin-two' };
  const first = await prepare(storage);
  const second = await prepareDealHunterManualFollowUp({ opportunityId, requestId, session: adminTwo, storage, now: new Date(), dependencies });
  let winner = false;
  let providerCalls = 0;
  const execute = async () => {
    if (winner) return { status: 'locked', request: storage.state.request };
    winner = true;
    providerCalls += 1;
    storage.state.request = { ...storage.state.request, follow_up_count: 1, follow_up_state: 'scheduled', updated_at: new Date().toISOString() };
    return { status: 'sent', request: storage.state.request };
  };
  await Promise.all([
    approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: first.preparationToken, approvedProposalDigest: first.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: execute }),
    approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: second.preparationToken, approvedProposalDigest: second.proposalDigest, session: adminTwo, storage, now: new Date(), dependencies, executeApprovedFollowUp: execute }),
  ]);
  assert.equal(providerCalls, 1);
});

test('stop reply materials and pass races before final provider authorization yield zero provider calls', async (t) => {
  for (const race of ['stop', 'reply', 'materials', 'pass']) {
    await t.test(race, async () => {
      const storage = task3Storage({ request: markedRequest() });
      const prepared = await prepare(storage);
      if (race === 'stop') storage.state.request.metadata.manualFollowUp.stoppedAt = new Date().toISOString();
      if (race === 'reply') storage.state.request.responded_at = new Date().toISOString();
      if (race === 'materials') storage.state.secureDocuments.push({ id: 'cim', document_type: 'cim' });
      if (race === 'pass') storage.state.dispositions.push({ id: 'pass', disposition: 'dismissed' });
      let providerCalls = 0;
      await approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: prepared.preparationToken, approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: async () => { providerCalls += 1; } });
      assert.equal(providerCalls, 0);
    });
  }
});

test('provider acceptance racing stop or reply counts once but schedules no later touch', async () => {
  const storage = task3Storage({ request: markedRequest() });
  const prepared = await prepare(storage);
  const result = await approveDealHunterManualFollowUp({ opportunityId, requestId, preparationToken: prepared.preparationToken, approvedProposalDigest: prepared.proposalDigest, session: administrator, storage, now: new Date(), dependencies, executeApprovedFollowUp: async () => ({ status: 'sent', request: { ...storage.state.request, follow_up_count: 1, follow_up_state: 'stopped', next_follow_up_at: null, responded_at: new Date().toISOString() } }) });
  assert.equal(result.success, true);
  assert.equal(result.durableResult.followUps.followUpCount, 1);
  assert.equal(result.durableResult.followUps.state, 'stopped');
  assert.equal(result.durableResult.followUps.nextFollowUpAt, '');
});
