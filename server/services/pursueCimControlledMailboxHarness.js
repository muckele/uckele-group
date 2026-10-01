import { validateCimProviderProfileBinding } from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { setCimOutreachPaused } from './cimOpportunityIdentity.js';
import { readCimCurrentAuthority } from './cimCampaignSafety.js';
import { buildOpportunitySourceObservationSnapshot } from './dealHunterOpportunityFacts.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from './dealHunterSourceSnapshotAdmission.js';
import {
  orchestratePursuitEnrollment,
  pursuitPermissionBasisDigest,
  pursuitPermissionCohortDigest,
} from './pursueCimEnrollment.js';
import {
  authorizePreparedCimTransmission,
  normalizeCimProviderReadiness,
} from './pursueCimFinalGate.js';
import { runDueCimInitialPreparations } from './pursueCimInitialPreparation.js';
import { finalizeAuthorizedCimTransmission } from './pursueCimProvider.js';
import { getPursueCimReleaseReport } from './pursueCimRelease.js';

const CONTROLLED_PROFILE = 'controlled-mailbox-v1';
const MAX_AUTHORIZATION_MS = 15 * 60 * 1000;

export const P10B_EXECUTION_CONFIRMATION = 'EXECUTE P10B CONTROLLED MAILBOX ONCE';

function boundedText(value, name, maximum = 240) {
  if (typeof value !== 'string' || value.trim() !== value
    || value.length < 1 || value.length > maximum) {
    throw new Error(`P10B ${name} must be bounded and non-empty`);
  }
  return value;
}

function normalizedAddress(value) {
  const candidate = String(value || '').trim();
  const match = candidate.match(/^(?:[^<>\r\n,;]+\s)?<([^<>\s@,;]+@[^<>\s@,;]+\.[^<>\s@,;]+)>$/)
    || candidate.match(/^([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)$/);
  return String(match?.[1] || match?.[0] || '').toLowerCase();
}

function assertHardOffControlledConfig(config, recipient = '') {
  const profile = config?.dealHunter?.cimProvider;
  const allowedRecipients = Array.isArray(profile?.allowedRecipients)
    ? profile.allowedRecipients.map(normalizedAddress).filter(Boolean) : [];
  if (config?.isProduction === true || profile?.profile !== CONTROLLED_PROFILE
    || profile?.mode !== 'controlled-mailbox' || profile?.provider !== 'resend') {
    throw new Error('P10B requires the isolated controlled mailbox profile');
  }
  if (profile.enabled !== false) throw new Error('P10B must start with the provider hard-off');
  if (allowedRecipients.length !== 1 || profile.allowedRecipients.length !== 1) {
    throw new Error('P10B requires exactly one controlled mailbox recipient');
  }
  if (recipient && normalizedAddress(recipient) !== allowedRecipients[0]) {
    throw new Error('P10B synthetic recipient does not match the controlled mailbox allowlist');
  }
  if (!profile.resendApiKey || !profile.resendFromEmail || !profile.resendReplyTo
    || !profile.resendInboundDomain || !profile.emailWebhookSecret
    || !profile.reconciliationApiKey) {
    throw new Error('P10B controlled mailbox credentials and routing are incomplete');
  }
  if (config?.delivery?.resendApiKey || config?.delivery?.resendFromEmail
    || config?.delivery?.resendReplyTo || config?.delivery?.resendInboundDomain
    || config?.delivery?.emailWebhookSecret) {
    throw new Error('P10B cannot resolve the production delivery credential namespace');
  }
  if (config?.dealHunter?.cimAutomation?.schedulerEnabled === true
    || config?.dealHunter?.cimFollowUp?.enabled === true) {
    throw new Error('P10B scheduler and follow-up capabilities must remain hard-off');
  }
  return { profile, recipient: allowedRecipients[0] };
}

function exactReviewFields(report, providerProfile, initialActivationId) {
  const transmission = report?.transmission;
  const campaign = report?.campaign;
  const recipientAuthority = report?.recipientAuthority;
  if (!report?.opportunity?.id || !campaign?.id || !transmission?.id
    || transmission.state !== 'prepared' || transmission.providerOutcome
    || !/^[0-9a-f]{64}$/.test(transmission.payloadDigest || '')
    || !/^[0-9a-f]{64}$/.test(transmission.memberDigest || '')
    || !Array.isArray(transmission.membership) || transmission.membership.length !== 1
    || !recipientAuthority?.fingerprint || !transmission.copy
    || !Array.isArray(transmission.addressing?.to)
    || transmission.addressing.to.length !== 1
    || transmission.addressing.cc?.length || transmission.addressing.bcc?.length) {
    throw new Error('P10B exact prepared transmission is unavailable for review');
  }
  return {
    version: 'p10b-controlled-mailbox-review-v1',
    providerProfile,
    initialActivationId: boundedText(initialActivationId, 'initial activation id'),
    opportunity: {
      id: report.opportunity.id,
      name: report.opportunity.name,
    },
    campaign: {
      id: campaign.id,
      generation: campaign.generation,
      policyVersion: campaign.policyVersion,
      templateVersion: campaign.templateVersion,
    },
    recipientAuthority: {
      address: recipientAuthority.address,
      authorityId: recipientAuthority.authorityId,
      fingerprint: recipientAuthority.fingerprint,
      permissionVersion: recipientAuthority.permissionVersion,
      permissionDigest: recipientAuthority.permissionDigest,
      permissionRevision: recipientAuthority.permissionRevision,
      permissionScope: recipientAuthority.permissionScope,
    },
    transmission: {
      id: transmission.id,
      state: transmission.state,
      releaseState: transmission.releaseState,
      rowVersion: transmission.rowVersion,
      preparationGeneration: transmission.preparationGeneration,
      payloadVersion: transmission.payloadVersion,
      payloadDigest: transmission.payloadDigest,
      memberDigest: transmission.memberDigest,
      addressing: transmission.addressing,
      copy: transmission.copy,
      membership: transmission.membership,
    },
  };
}

export function buildP10bReviewArtifact(report, {
  providerProfile = CONTROLLED_PROFILE,
  initialActivationId,
} = {}) {
  const canonical = exactReviewFields(report, providerProfile, initialActivationId);
  return { ...canonical, digest: sha256(stableCanonicalJson(canonical)) };
}

function validateReviewBinding(review, config) {
  const profile = assertHardOffControlledConfig(config);
  const binding = validateCimProviderProfileBinding(config, {
    providerProfile: profile.profile.profile,
    fromAddress: review.transmission.addressing.from,
    toAddresses: review.transmission.addressing.to,
    ccAddresses: review.transmission.addressing.cc,
    bccAddresses: review.transmission.addressing.bcc,
    replyToAddress: review.transmission.addressing.replyTo,
  });
  if (!binding.ok) throw new Error(`P10B review binding failed: ${binding.blockers.join(',')}`);
  return profile;
}

function requiredSyntheticInput(synthetic = {}) {
  boundedText(synthetic.runId, 'run id', 120);
  boundedText(synthetic.recipient, 'recipient', 320);
  boundedText(synthetic.permissionEvidenceId, 'permission evidence id', 240);
  if (!/^[0-9a-f]{64}$/.test(synthetic.permissionEvidenceHash || '')) {
    throw new Error('P10B permission evidence hash must be a SHA-256 digest');
  }
  return synthetic;
}

function syntheticSubmission({ id, opportunityId, recipient, displayName, now }) {
  return {
    id, created_at: now, updated_at: now, status: 'open', spam_score: 0,
    spam_reasons: [], delivery_provider: 'none', delivery_status: 'not-attempted',
    delivery_error: null, crm_status: 'active', crm_error: null,
    source: 'p10b-controlled-mailbox', ip_hash: 'p10b-synthetic', user_agent: '',
    name: displayName, email: recipient, phone: '', company: 'P10B Synthetic Test', role: '',
    message: 'Synthetic controlled-mailbox lifecycle evidence only.', status_updated_at: now,
    listing_url: '', business_website: '', prospectus_url: '', asking_price: '',
    ttm_revenue: '', ttm_ebitda: '', ebitda_multiple: '', net_margin: '', business_age: '',
    sba_eligible: 'unknown', broker_name: displayName, broker_email: recipient,
    broker_phone: '', seller_name: '', seller_email: '', seller_phone: '',
    lead_type: 'broker', priority: 'normal', tags: ['p10b-synthetic'], assigned_to: '',
    notes: 'P10B synthetic controlled mailbox record.', follow_up_state: 'needs-response',
    next_action_at: null, last_contacted_at: null,
    deal_hunter_opportunity_id: opportunityId, metadata: { p10bSynthetic: true },
  };
}

function setupDigest(label, runId) {
  return sha256(stableCanonicalJson({ type: `p10b-${label}-v1`, runId }));
}

async function readP10bSyntheticSourceHealth(storage) {
  const states = await storage.listDealHunterSourceFreshnessStates();
  const accepted = Array.isArray(states) && states.length > 0
    && states.every((state) => state.projection_state === 'accepted'
      && state.accepted_run_id && state.accepted_at);
  const requiredSources = accepted
    ? [...new Set(states.map((state) => state.source_id).filter(Boolean))].sort() : [];
  return { healthy: accepted && requiredSources.includes('sheet-0'),
    requiredSources, issues: accepted ? [] : [{ code: 'p10b-source-authority-unavailable' }] };
}

export async function setupP10bSyntheticScenario({
  storage,
  config,
  synthetic,
  actor,
  now,
} = {}) {
  const requiredMethods = [
    'upsertDealHunterOpportunity', 'insertSubmission',
    'allocateDealHunterSourceGeneration', 'writeDealHunterOpportunityScore',
    'reconcileDealHunterCurrentScoreEligibility', 'setDealHunterOpportunityOperatorDecision',
    'recordOwnerDecision', 'appendOpportunityTimezoneRevision',
    'recordCimCapabilityActivation',
  ];
  if (requiredMethods.some((name) => typeof storage?.[name] !== 'function')) {
    throw new Error('P10B public synthetic storage authorities are unavailable');
  }
  let at = new Date(now).toISOString();
  const runId = synthetic.runId;
  const recipient = normalizedAddress(synthetic.recipient);
  const displayName = boundedText(synthetic.recipientDisplayName || 'Controlled Mailbox Owner',
    'recipient display name', 120);
  const opportunityId = `p10b-${setupDigest('opportunity', runId).slice(0, 40)}`;
  const submissionId = `p10b-${setupDigest('submission', runId).slice(0, 40)}`;
  const sourceRunId = `p10b-${setupDigest('source-run', runId).slice(0, 40)}`;
  const sourceRecordId = `external:${runId}`;
  const dealKey = `p10b:${setupDigest('deal-key', runId).slice(0, 32)}`;
  const listingUrl = `https://p10b.invalid/${encodeURIComponent(runId)}`;
  const deal = {
    sourceId: 'sheet-0', sourceName: 'P10B Synthetic Sheet', stableExternalId: true,
    id: runId, dealKey, name: 'P10B Controlled Mailbox Test',
    listingUrl, location: 'Boston, MA', brokerName: displayName, brokerEmail: recipient,
    industry: 'Synthetic service business', score: 100, dateAdded: at,
  };
  await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId,
    created_at: at, updated_at: at, canonical_name: deal.name,
    canonical_recipient: recipient, canonical_location: deal.location,
    primary_submission_id: null, identity_version: 'p10b-synthetic-v1',
    status: 'active', metadata: { p10bSynthetic: true, runId } });
  await storage.insertSubmission(syntheticSubmission({ id: submissionId, opportunityId,
    recipient, displayName, now: at }));
  const opportunity = await storage.getCurrentDealHunterOpportunity(opportunityId);
  await storage.upsertDealHunterOpportunity({ ...opportunity, updated_at: at,
    primary_submission_id: submissionId });
  const snapshot = buildOpportunitySourceObservationSnapshot({ opportunityId, deal, now: at });
  if (!snapshot || snapshot.source_record_id !== sourceRecordId) {
    throw new Error('P10B synthetic source snapshot identity is invalid');
  }
  const sourceRun = await storage.allocateDealHunterSourceGeneration({
    sourceId: 'sheet-0', runId: sourceRunId,
  });
  const sourceResult = await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({ storage,
    reviewMode: 'full-backfill',
    sourceResult: { source: { id: 'sheet-0', required: true, fetched: true,
      sourceRowCount: 1, rowCount: 1, coverageLimitReached: false }, deals: [deal] },
    records: [snapshot], run: sourceRun });
  if (!sourceResult.reconciled || sourceResult.identityExceptionsPending !== 0) {
    throw new Error('P10B synthetic source authority was not admitted');
  }
  const acceptedAt = Date.parse(sourceResult.safetyAsOf || '');
  if (Number.isFinite(acceptedAt) && acceptedAt >= Date.parse(at)) {
    at = new Date(acceptedAt + 1).toISOString();
  }
  const scoreFingerprint = setupDigest('score', runId);
  const semanticDigest = setupDigest('score-semantic', runId);
  await storage.writeDealHunterOpportunityScore({ opportunity_id: opportunityId, scored_at: at,
    deal_key: dealKey, name: deal.name, state: 'MA', listing_url: listingUrl,
    fit_score: 100, score_status: 'high-fit', confidence: 'high', completeness_score: 100,
    contradiction_count: 0, missing_evidence_count: 0, should_remove: false,
    high_fit: true, gate_count: 0, score_fingerprint: scoreFingerprint,
    semantic_digest: semanticDigest, engine_version: 'p10b-synthetic-v1',
    rules_version: 'p10b-synthetic-v1', profile_version: 'p10b-synthetic-v1',
    completeness_policy_version: 'p10b-synthetic-v1', dimensions: [], gates: [],
    applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {} }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  const current = await storage.getCurrentDealHunterOpportunity(opportunityId);
  await storage.setDealHunterOpportunityOperatorDecision({ opportunityId, priority: 'high',
    reviewed: true, reviewedAt: at, reviewedBy: actor,
    reviewedFingerprint: scoreFingerprint, reviewedSemanticDigest: semanticDigest,
    expectedDiscoveryRevision: Number(current.discovery_revision),
    expectedMaterialRevision: Number(current.material_revision), updatedAt: at });
  const decision = await storage.recordOwnerDecision({ opportunityId, action: 'pursue',
    idempotencyKey: `p10b-owner-${setupDigest('owner-decision', runId).slice(0, 40)}`,
    actor, policyVersion: 'owner-decision-v1', now: at,
    expectedDiscoveryRevision: Number(current.discovery_revision),
    expectedMaterialRevision: Number(current.material_revision) });
  if (!decision?.decision || !decision?.enrollment) {
    throw new Error('P10B synthetic Pursue decision was not persisted');
  }
  const timezone = await storage.appendOpportunityTimezoneRevision({ opportunityId,
    expectedPriorRevision: 0,
    idempotencyKey: `p10b-timezone-${setupDigest('timezone', runId).slice(0, 40)}`,
    state: 'verified', ianaTimezone: 'America/Los_Angeles', evidenceType: 'operator-verified',
    evidenceId: `p10b-timezone-${runId}`, evidenceDigest: setupDigest('timezone-evidence', runId),
    resolverVersion: 'explicit-v1', datasetDigest: setupDigest('timezone-dataset', runId),
    actor, now: at });
  if (!timezone?.applied && !timezone?.replay) {
    throw new Error('P10B synthetic timezone authority was not persisted');
  }
  const authority = await loadBrokerMaterialsAuthority({ storage, opportunityId,
    now: new Date(at) });
  const recipients = authority.recipientOptions.filter((item) =>
    normalizedAddress(item.email) === recipient);
  if (recipients.length !== 1) throw new Error('P10B synthetic recipient authority is not unique');
  const selectedRecipient = recipients[0];
  const policyHash = setupDigest('campaign-policy', runId);
  const configHash = sha256(stableCanonicalJson({ providerProfile: CONTROLLED_PROFILE,
    recipientHash: sha256(recipient), schedulerEnabled: false, followUpEnabled: false }));
  const commonActivation = { mode: 'mailbox', policyHash, configHash, actor,
    reason: 'P10B isolated synthetic controlled-mailbox evidence',
    confirmation: 'P10B SYNTHETIC CONTROLLED MAILBOX', providerProfile: CONTROLLED_PROFILE,
    now: at };
  const safetyActivationId = `p10b-${setupDigest('safety-activation', runId).slice(0, 40)}`;
  const enrollmentActivationId = `p10b-${setupDigest('enrollment-activation', runId).slice(0, 40)}`;
  const initialActivationId = `p10b-${setupDigest('initial-activation', runId).slice(0, 40)}`;
  const safetyActivation = await storage.recordCimCapabilityActivation({ ...commonActivation,
    id: safetyActivationId, capability: 'fl04a-safety' });
  if (!safetyActivation?.applied && !safetyActivation?.replay) {
    throw new Error('P10B safety activation was not persisted');
  }
  const enrollmentActivation = await storage.recordCimCapabilityActivation({ ...commonActivation,
    id: enrollmentActivationId, capability: 'fl04b-enrollment',
    prerequisiteActivationId: safetyActivationId,
    prerequisiteEvidenceId: synthetic.permissionEvidenceId,
    prerequisiteEvidenceHash: synthetic.permissionEvidenceHash,
    permissionBasisDigest: pursuitPermissionBasisDigest(authority, selectedRecipient),
    cohortDigest: pursuitPermissionCohortDigest(authority, selectedRecipient),
    permissionRevision: 1 });
  if (!enrollmentActivation?.applied && !enrollmentActivation?.replay) {
    throw new Error('P10B contact-permission activation was not persisted');
  }
  const enrollment = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor, now: new Date(at),
    readSourceHealth: readP10bSyntheticSourceHealth });
  if (!enrollment?.campaign || enrollment.enrollment?.state !== 'campaign-created') {
    throw new Error(`P10B synthetic campaign allocation failed: ${enrollment?.enrollment?.reason_code || 'unknown'}`);
  }
  const initialActivation = await storage.recordCimCapabilityActivation({ ...commonActivation,
    id: initialActivationId, capability: 'fl04b-initial',
    prerequisiteActivationId: enrollmentActivationId,
    prerequisiteEvidenceId: `p10b-preparation:${synthetic.permissionEvidenceId}`,
    prerequisiteEvidenceHash: synthetic.permissionEvidenceHash,
    permissionBasisDigest: enrollmentActivation.activation.permission_basis_digest,
    cohortDigest: enrollmentActivation.activation.cohort_digest,
    permissionRevision: Number(enrollmentActivation.activation.permission_revision) });
  if (!initialActivation?.applied && !initialActivation?.replay) {
    throw new Error('P10B initial capability activation was not persisted');
  }
  await setCimOutreachPaused({ paused: true, actor,
    reason: `P10B prepare-only hold ${sha256(runId)}`, storage });
  const prepared = await runDueCimInitialPreparations({ storage, now: at,
    actor: 'p10b-controlled-mailbox-preparer', configOverride: config });
  if (prepared.length !== 1 || prepared[0].prepared !== true) {
    throw new Error(`P10B synthetic transmission preparation failed: ${JSON.stringify(prepared)}`);
  }
  return { opportunityId, initialActivationId, transmissionId: prepared[0].transmissionId,
    campaignId: enrollment.campaign.id, effectiveNow: at };
}

export async function prepareP10bControlledMailbox({
  storage,
  config,
  synthetic,
  actor,
  now = new Date().toISOString(),
  services = {},
} = {}) {
  boundedText(actor, 'actor', 200);
  const input = requiredSyntheticInput(synthetic);
  const controlled = assertHardOffControlledConfig(config, input.recipient);
  const setupSyntheticScenario = services.setupSyntheticScenario || setupP10bSyntheticScenario;
  const setup = await setupSyntheticScenario({ storage, config, synthetic: input, actor, now });
  const opportunityId = boundedText(setup?.opportunityId, 'opportunity id', 200);
  boundedText(setup?.initialActivationId, 'initial activation id');
  const preparedAt = new Date(setup?.effectiveNow || now).toISOString();
  const getReleaseReport = services.getReleaseReport || getPursueCimReleaseReport;
  const report = await getReleaseReport({ storage, opportunityId, now: preparedAt });
  if (report?.pause?.paused !== true) {
    throw new Error('P10B preparation requires the durable central pause');
  }
  const review = buildP10bReviewArtifact(report, { providerProfile: controlled.profile.profile,
    initialActivationId: setup.initialActivationId });
  validateReviewBinding(review, config);
  return { version: 'p10b-controlled-mailbox-preparation-v1', preparedAt,
    opportunityId, initialActivationId: setup.initialActivationId,
    executionAuthorized: false, review };
}

function authorizationWindow(now, expiresAt) {
  const nowMs = Date.parse(now);
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs)
    || expiryMs <= nowMs || expiryMs - nowMs > MAX_AUTHORIZATION_MS) {
    throw new Error('P10B authorization expiry must be within the next 15 minutes');
  }
  return new Date(expiryMs).toISOString();
}

async function readP10bSyntheticCurrentAuthority({ storage, opportunityId }) {
  return readCimCurrentAuthority({ storage, opportunityId,
    readSourceHealth: readP10bSyntheticSourceHealth });
}

function redactedEvidence({ review, finalization, cleanup, authorizationId, now, expiresAt,
  readiness, finalizationStarted = false, executionError = null }) {
  const providerResult = finalization?.providerResult || {};
  const outcome = finalization?.outcome?.category || (executionError ? 'execution-error' : 'authorization-denied');
  const providerAttempted = providerResult.providerAttempted === true
    && providerResult.providerSeamEntered === true;
  return {
    version: 'p10b-controlled-mailbox-evidence-v1',
    observedAt: new Date(now).toISOString(),
    authorizationExpiresAt: expiresAt,
    providerProfile: CONTROLLED_PROFILE,
    opportunityIdHash: sha256(review.opportunity.id),
    campaignIdHash: sha256(review.campaign.id),
    transmissionIdHash: sha256(review.transmission.id),
    reviewDigest: review.digest,
    readinessDigest: readiness.authorityDigest,
    readinessEvidenceRevisionHash: sha256(readiness.evidenceRevision),
    payloadDigest: review.transmission.payloadDigest,
    memberDigest: review.transmission.memberDigest,
    recipientAddressHash: sha256(normalizedAddress(review.recipientAuthority.address)),
    subjectDigest: sha256(review.transmission.copy.subject),
    bodyTextDigest: sha256(review.transmission.copy.text),
    bodyHtmlDigest: sha256(review.transmission.copy.html),
    authorizationIdHash: sha256(authorizationId),
    providerMessageIdHash: providerResult.providerMessageId
      ? sha256(providerResult.providerMessageId) : '',
    providerCalls: executionError && finalizationStarted && !finalization
      ? null : providerAttempted ? 1 : 0,
    productionProfileCalls: 0,
    outcome,
    reconciliationOnly: ['ambiguous', 'pending', 'execution-error'].includes(outcome),
    cleanup,
  };
}

async function cleanupExecution({ storage, services, authorizationId, initialActivationId,
  actor, now, armedConfig }) {
  armedConfig.dealHunter.cimProvider.enabled = false;
  const cleanup = { hardOffRestored: true, pauseRestored: false,
    authorizationClosed: false, authorizationWithdrawn: false,
    activationClosed: false, activationWithdrawn: false, errors: [] };
  const setPause = services.setPause || setCimOutreachPaused;
  try {
    await setPause({ paused: true, actor, reason: 'P10B bounded execution complete', storage });
    cleanup.pauseRestored = true;
  } catch {
    cleanup.errors.push('pause_restore_failed');
  }
  if (authorizationId && typeof storage?.withdrawCimLiveProviderAuthorization === 'function') {
    try {
      const result = await storage.withdrawCimLiveProviderAuthorization({ id: authorizationId,
        actor, reason: 'p10b-window-closed', now });
      cleanup.authorizationWithdrawn = result?.applied === true || result?.replay === true;
      const absent = result?.conflict === true && result?.authorization === null;
      cleanup.authorizationClosed = cleanup.authorizationWithdrawn
        || absent || Boolean(result?.authorization?.consumed_at
          || result?.authorization?.withdrawn_at
          || (result?.authorization?.expires_at
            && Date.parse(result.authorization.expires_at) <= Date.parse(now)));
      if (!cleanup.authorizationClosed) cleanup.errors.push('authorization_close_unproven');
    } catch {
      cleanup.errors.push('authorization_close_failed');
    }
  } else if (authorizationId) cleanup.errors.push('authorization_close_unavailable');
  if (initialActivationId && typeof storage?.withdrawCimCapabilityActivation === 'function') {
    try {
      const result = await storage.withdrawCimCapabilityActivation({ id: initialActivationId,
        actor, reason: 'p10b-window-closed', now });
      cleanup.activationWithdrawn = result?.applied === true || result?.replay === true
        || result?.activation?.status === 'withdrawn';
      const absent = result?.conflict === true && result?.activation === null;
      cleanup.activationClosed = cleanup.activationWithdrawn || absent
        || (result?.activation?.status && result.activation.status !== 'current')
        || Boolean(result?.activation?.expires_at
          && Date.parse(result.activation.expires_at) <= Date.parse(now));
      if (!cleanup.activationClosed) cleanup.errors.push('activation_close_unproven');
    } catch {
      cleanup.errors.push('activation_withdrawal_failed');
    }
  } else if (initialActivationId) cleanup.errors.push('activation_close_unavailable');
  return cleanup;
}

export async function executeP10bControlledMailbox({
  storage,
  config,
  opportunityId,
  initialActivationId,
  reviewDigest,
  confirmation,
  expiresAt,
  actor,
  now = new Date().toISOString(),
  providerReadiness,
  fetcher,
  testHooks,
  services = {},
} = {}) {
  boundedText(actor, 'actor', 200);
  boundedText(opportunityId, 'opportunity id', 200);
  boundedText(initialActivationId, 'initial activation id');
  if (confirmation !== P10B_EXECUTION_CONFIRMATION) {
    throw new Error(`P10B confirmation must equal ${P10B_EXECUTION_CONFIRMATION}`);
  }
  if (!/^[0-9a-f]{64}$/.test(reviewDigest || '')) {
    throw new Error('P10B exact review digest is required');
  }
  const expiry = authorizationWindow(now, expiresAt);
  const controlled = assertHardOffControlledConfig(config);
  const readiness = normalizeCimProviderReadiness(providerReadiness, {
    providerProfile: CONTROLLED_PROFILE, now,
  });
  if (!readiness.ready || readiness.providerProfile !== CONTROLLED_PROFILE) {
    throw new Error(`P10B provider readiness is unavailable: ${readiness.blockers.join(',')
      || 'profile_mismatch'}`);
  }
  const getReleaseReport = services.getReleaseReport || getPursueCimReleaseReport;
  const report = await getReleaseReport({ storage, opportunityId, now });
  if (report?.pause?.paused !== true || report?.liveAuthorization) {
    throw new Error('P10B execution requires a paused, unauthorized prepared transmission');
  }
  const review = buildP10bReviewArtifact(report, { providerProfile: controlled.profile.profile,
    initialActivationId });
  validateReviewBinding(review, config);
  if (review.digest !== reviewDigest) throw new Error('P10B review digest does not match durable state');
  const authorizationId = `p10b-${sha256(stableCanonicalJson({ transmissionId: review.transmission.id,
    reviewDigest, expiresAt: expiry, actor })).slice(0, 48)}`;
  if (typeof storage?.issueCimLiveProviderAuthorization !== 'function') {
    throw new Error('P10B live authorization storage is unavailable');
  }
  if (typeof storage?.withdrawCimLiveProviderAuthorization !== 'function'
    || typeof storage?.withdrawCimCapabilityActivation !== 'function'
    || (typeof services.setPause !== 'function'
      && typeof storage?.upsertDealHunterCimSafetySettings !== 'function')) {
    throw new Error('P10B cleanup storage is unavailable');
  }
  const armedConfig = structuredClone(config);
  const setPause = services.setPause || setCimOutreachPaused;
  const authorizePrepared = services.authorizePrepared || authorizePreparedCimTransmission;
  const finalizeAuthorized = services.finalizeAuthorized || finalizeAuthorizedCimTransmission;
  let finalization;
  let finalizationStarted = false;
  let cleanup;
  let executionError;
  try {
    const issued = await storage.issueCimLiveProviderAuthorization({ id: authorizationId,
      activationId: initialActivationId, capability: 'fl04b-initial',
      writerPath: 'pursue-cim-initial', transmissionId: review.transmission.id,
      payloadDigest: review.transmission.payloadDigest,
      recipientAuthorityDigest: review.recipientAuthority.fingerprint,
      providerProfile: CONTROLLED_PROFILE, expiresAt: expiry, actor,
      reason: `P10B exact reviewed transmission ${reviewDigest}`, now: new Date(now).toISOString() });
    if (issued?.issued !== true || issued.authorization?.maximum_calls !== 1
      || issued.authorization?.id !== authorizationId) {
      throw new Error(`P10B live authorization was not issued: ${issued?.blockedReason || 'conflict'}`);
    }
    armedConfig.dealHunter.cimProvider.enabled = true;
    await setPause({ paused: false, actor,
      reason: `P10B bounded authorization ${sha256(authorizationId)}`, storage });
    const gate = await authorizePrepared({ storage, transmissionId: review.transmission.id,
      authorizationId, writerPath: 'pursue-cim-initial', providerProfile: CONTROLLED_PROFILE,
      actor, now: new Date(now).toISOString(), configOverride: armedConfig,
      readCurrentAuthority: readP10bSyntheticCurrentAuthority,
      readProviderReadiness: async () => readiness });
    if (gate?.authorized !== true) {
      const error = new Error(`P10B final gate denied execution: ${gate?.blockedReason || 'unknown'}`);
      error.code = 'P10B_FINAL_GATE_DENIED';
      throw error;
    }
    finalizationStarted = true;
    finalization = await finalizeAuthorized({ storage, finalGateResult: gate,
      authorizationId, writerPath: 'pursue-cim-initial', providerProfile: CONTROLLED_PROFILE,
      actor, now: new Date(now), configOverride: armedConfig, fetcher, testHooks });
  } catch (error) {
    executionError = error;
  } finally {
    cleanup = await cleanupExecution({ storage, services, authorizationId, initialActivationId,
      actor, now: new Date(now).toISOString(), armedConfig });
  }
  if (cleanup.errors.length > 0) {
    const error = new Error(`P10B hard-off restoration failed: ${cleanup.errors.join(';')}`);
    error.code = 'P10B_CLEANUP_FAILED';
    error.cause = executionError;
    error.p10bEvidence = redactedEvidence({ review, finalization, cleanup, authorizationId,
      now, expiresAt: expiry, readiness, finalizationStarted,
      executionError: executionError || error });
    throw error;
  }
  if (executionError) {
    executionError.p10bEvidence = redactedEvidence({ review, finalization, cleanup,
      authorizationId, now, expiresAt: expiry, readiness, finalizationStarted, executionError });
    throw executionError;
  }
  return { version: 'p10b-controlled-mailbox-execution-v1',
    evidence: redactedEvidence({ review, finalization, cleanup, authorizationId,
      now, expiresAt: expiry, readiness, finalizationStarted }) };
}
