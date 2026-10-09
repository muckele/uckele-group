import {
  CONTROLLED_CIM_LIMITED_SMOKE_PROFILE,
  CONTROLLED_CIM_MAILBOX_PROFILE,
  P10B_LIMITED_SMOKE_RECIPIENT,
  P10B_LIMITED_SMOKE_SENDING_DOMAIN,
  validateCimProviderProfileBinding,
} from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { fetchWithTimeout } from '../utils/http.js';
import { createQualificationSupervisor } from './p10bQualificationSupervisor.js';
import { readQualificationLifecycleSnapshot, verifyQualificationLifecycle } from './p10bQualificationLifecycle.js';
import { P10B_QUALIFICATION_WRITER, qualificationReason,
  validateQualificationContract, assertQualificationHardOff } from './p10bQualificationContract.js';
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
import { finalizeAuthorizedCimTransmission, createCimResendReconciliationLookup,
  immutableTransmissionBinding, reconcileCimProviderTransmission } from './pursueCimProvider.js';
import { getPursueCimReleaseReport } from './pursueCimRelease.js';
import { assertP10bControlledMailboxTemplate } from './pursueCimControlledMailboxTemplate.js';

const CONTROLLED_PROFILE = CONTROLLED_CIM_MAILBOX_PROFILE;
const LIMITED_PROFILE = CONTROLLED_CIM_LIMITED_SMOKE_PROFILE;
const MAX_AUTHORIZATION_MS = 15 * 60 * 1000;
const LIMITED_EVIDENCE_FIELDS = Object.freeze({
  p10bComplete: false,
  scenario74Passed: false,
  signedInboundCovered: false,
  reconciliationCovered: false,
  providerTenantIsolated: false,
});

export const P10B_EXECUTION_CONFIRMATION = 'EXECUTE P10B CONTROLLED MAILBOX ONCE';
export const P10B_LIMITED_SMOKE_CONFIRMATION = 'EXECUTE P10B LIMITED OUTBOUND SMOKE ONCE';

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

function normalizedDomain(value) {
  return String(value || '').trim().toLowerCase();
}

function assertProductionNamespaceUnavailable(config) {
  if (config?.delivery?.resendApiKey || config?.delivery?.resendFromEmail
    || config?.delivery?.resendReplyTo || config?.delivery?.resendInboundDomain
    || config?.delivery?.emailWebhookSecret) {
    throw new Error('P10B cannot resolve the production delivery credential namespace');
  }
}

function assertAutomationHardOff(config) {
  if (config?.dealHunter?.cimAutomation?.schedulerEnabled === true
    || config?.dealHunter?.cimFollowUp?.enabled === true) {
    throw new Error('P10B scheduler and follow-up capabilities must remain hard-off');
  }
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
  assertProductionNamespaceUnavailable(config);
  assertAutomationHardOff(config);
  return { profile, recipient: allowedRecipients[0] };
}

function assertHardOffLimitedConfig(config, recipient = '', { execution = false } = {}) {
  const profile = config?.dealHunter?.cimProvider;
  const allowedRecipients = Array.isArray(profile?.allowedRecipients)
    ? profile.allowedRecipients.map(normalizedAddress).filter(Boolean) : [];
  if (config?.isProduction === true || profile?.profile !== LIMITED_PROFILE
    || profile?.mode !== 'controlled-mailbox-limited-smoke' || profile?.provider !== 'resend') {
    throw new Error('P10B limited smoke requires its isolated nonproduction profile');
  }
  if (profile.enabled !== false) throw new Error('P10B limited smoke must start hard-off');
  if (allowedRecipients.length !== 1 || profile.allowedRecipients.length !== 1
    || allowedRecipients[0] !== P10B_LIMITED_SMOKE_RECIPIENT
    || (recipient && normalizedAddress(recipient) !== P10B_LIMITED_SMOKE_RECIPIENT)) {
    throw new Error('P10B limited smoke requires the exact owner recipient');
  }
  if (!profile.resendFromEmail
    || normalizedDomain(normalizedAddress(profile.resendFromEmail).split('@')[1])
      !== P10B_LIMITED_SMOKE_SENDING_DOMAIN
    || normalizedDomain(profile.sendingDomain) !== P10B_LIMITED_SMOKE_SENDING_DOMAIN) {
    throw new Error('P10B limited smoke sender domain is invalid');
  }
  if (profile.resendReplyTo || profile.resendInboundDomain || profile.emailWebhookSecret) {
    throw new Error('P10B limited smoke forbids Reply-To, inbound routing, and webhooks');
  }
  if (profile.reconciliationApiKey) {
    throw new Error('P10B limited smoke forbids reconciliation credentials');
  }
  if (!execution && (profile.resendApiKey || profile.apiKeyPermission
    || profile.apiKeyDomainRestriction)) {
    throw new Error('P10B limited smoke prepare must remain keyless');
  }
  if (execution && (!profile.resendApiKey || profile.apiKeyPermission !== 'sending-access'
    || normalizedDomain(profile.apiKeyDomainRestriction)
      !== P10B_LIMITED_SMOKE_SENDING_DOMAIN)) {
    throw new Error('P10B limited smoke requires a domain-restricted sending key scope');
  }
  assertProductionNamespaceUnavailable(config);
  assertAutomationHardOff(config);
  return { profile, recipient: allowedRecipients[0] };
}

function exactReviewFields(report, providerProfile, initialActivationId, databaseIdentityHash = '',
  implementationHead = '') {
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
  assertP10bControlledMailboxTemplate({ providerProfile, transmission });
  const limited = providerProfile === LIMITED_PROFILE;
  if (limited && !/^[0-9a-f]{64}$/.test(databaseIdentityHash)) {
    throw new Error('P10B limited smoke database identity hash is required');
  }
  if (limited && !/^[0-9a-f]{40}$/.test(implementationHead)) {
    throw new Error('P10B limited smoke implementation head is required');
  }
  return {
    version: limited ? 'p10b-limited-free-smoke-review-v1'
      : 'p10b-controlled-mailbox-review-v1',
    providerProfile,
    ...(limited ? { databaseIdentityHash, implementationHead, ...LIMITED_EVIDENCE_FIELDS } : {}),
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
  databaseIdentityHash = '',
  implementationHead = '',
} = {}) {
  const canonical = exactReviewFields(report, providerProfile, initialActivationId,
    databaseIdentityHash, implementationHead);
  return { ...canonical, digest: sha256(stableCanonicalJson(canonical)) };
}

function validateReviewBinding(review, config, { execution = false } = {}) {
  const profile = review?.providerProfile === LIMITED_PROFILE
    ? assertHardOffLimitedConfig(config, '', { execution })
    : assertHardOffControlledConfig(config);
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

export function resolveP10bSyntheticPreparationInstant({ authorityAt, initialTouch } = {}) {
  const authorityMs = Date.parse(authorityAt || '');
  const dueMs = Date.parse(initialTouch?.due_at || '');
  if (!Number.isFinite(authorityMs) || !Number.isFinite(dueMs)
    || initialTouch?.kind !== 'initial' || initialTouch?.state !== 'scheduled'
    || dueMs < authorityMs) {
    throw new Error('P10B synthetic initial preparation clock is invalid');
  }
  return new Date(dueMs).toISOString();
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
  const providerProfile = config?.dealHunter?.cimProvider?.profile;
  if (![CONTROLLED_PROFILE, LIMITED_PROFILE].includes(providerProfile)) {
    throw new Error('P10B synthetic scenario provider profile is invalid');
  }
  const requiredMethods = [
    'upsertDealHunterOpportunity', 'insertSubmission',
    'allocateDealHunterSourceGeneration', 'writeDealHunterOpportunityScore',
    'reconcileDealHunterCurrentScoreEligibility', 'setDealHunterOpportunityOperatorDecision',
    'recordOwnerDecision', 'appendOpportunityTimezoneRevision',
    'recordCimCapabilityActivation', 'readPursueCimProjection',
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
  const configHash = sha256(stableCanonicalJson({ providerProfile,
    recipientHash: sha256(recipient), schedulerEnabled: false, followUpEnabled: false }));
  const commonActivation = { mode: 'mailbox', policyHash, configHash, actor,
    reason: 'P10B isolated synthetic controlled-mailbox evidence',
    confirmation: 'P10B SYNTHETIC CONTROLLED MAILBOX', providerProfile,
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
  const projection = await storage.readPursueCimProjection({ opportunityId });
  const preparationAt = resolveP10bSyntheticPreparationInstant({
    authorityAt: at,
    initialTouch: projection?.initialTouch,
  });
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
  const prepared = await runDueCimInitialPreparations({ storage, now: preparationAt,
    actor: 'p10b-controlled-mailbox-preparer', configOverride: config });
  if (prepared.length !== 1 || prepared[0].prepared !== true) {
    throw new Error(`P10B synthetic transmission preparation failed: ${JSON.stringify(prepared)}`);
  }
  return { opportunityId, initialActivationId, transmissionId: prepared[0].transmissionId,
    campaignId: enrollment.campaign.id, effectiveNow: preparationAt };
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

export async function prepareP10bLimitedFreeSmoke({
  storage,
  config,
  synthetic,
  actor,
  databaseIdentityHash,
  implementationHead,
  now = new Date().toISOString(),
  services = {},
} = {}) {
  boundedText(actor, 'actor', 200);
  const input = requiredSyntheticInput(synthetic);
  const controlled = assertHardOffLimitedConfig(config, input.recipient);
  if (!/^[0-9a-f]{64}$/.test(databaseIdentityHash || '')
    || !/^[0-9a-f]{40}$/.test(implementationHead || '')) {
    throw new Error('P10B limited smoke database identity and implementation head are required');
  }
  const setupSyntheticScenario = services.setupSyntheticScenario || setupP10bSyntheticScenario;
  const setup = await setupSyntheticScenario({ storage, config, synthetic: input, actor, now });
  const opportunityId = boundedText(setup?.opportunityId, 'opportunity id', 200);
  boundedText(setup?.initialActivationId, 'initial activation id');
  const preparedAt = new Date(setup?.effectiveNow || now).toISOString();
  const getReleaseReport = services.getReleaseReport || getPursueCimReleaseReport;
  const report = await getReleaseReport({ storage, opportunityId, now: preparedAt });
  if (report?.pause?.paused !== true) {
    throw new Error('P10B limited smoke preparation requires the durable central pause');
  }
  const review = buildP10bReviewArtifact(report, { providerProfile: controlled.profile.profile,
    initialActivationId: setup.initialActivationId, databaseIdentityHash, implementationHead });
  validateReviewBinding(review, config);
  return { version: 'p10b-limited-free-smoke-preparation-v1', preparedAt,
    opportunityId, initialActivationId: setup.initialActivationId,
    executionAuthorized: false, ...LIMITED_EVIDENCE_FIELDS, review };
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

function limitedReadinessInstant(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function normalizeLimitedSmokeReadiness(readiness = {}, { now } = {}) {
  const generatedAt = limitedReadinessInstant(readiness.generatedAt);
  const expiresAt = limitedReadinessInstant(readiness.expiresAt);
  const canonical = {
    version: 'cim-provider-readiness-v1',
    limitedEvidenceVersion: 'p10b-limited-free-smoke-readiness-v1',
    provider: String(readiness.provider || '').trim(),
    providerProfile: String(readiness.providerProfile || '').trim(),
    outboundConfigured: readiness.outboundConfigured === true,
    senderConfigured: readiness.senderConfigured === true,
    senderAuthenticationAttested: readiness.senderAuthenticationAttested === true,
    sendingDomainVerified: readiness.sendingDomainVerified === true,
    sendingDomain: normalizedDomain(readiness.sendingDomain),
    apiKeyPermission: String(readiness.apiKeyPermission || '').trim(),
    apiKeyDomainRestriction: normalizedDomain(readiness.apiKeyDomainRestriction),
    suppressionOperational: readiness.suppressionOperational === true,
    webhookConfigured: readiness.webhookConfigured === true,
    requestReplyRoutingVerified: readiness.requestReplyRoutingVerified === true,
    replyTrackingVerified: readiness.replyTrackingVerified === true,
    reconciliationOperational: readiness.reconciliationOperational === true,
    evidenceRevision: String(readiness.evidenceRevision || '').trim(),
    generatedAt,
    expiresAt,
    ...LIMITED_EVIDENCE_FIELDS,
  };
  const blockerPairs = [
    ['limited_readiness_version_invalid',
      readiness.version === 'p10b-limited-free-smoke-readiness-v1'],
    ['profile_mismatch', canonical.provider === 'resend'
      && canonical.providerProfile === LIMITED_PROFILE],
    ['provider_unavailable', canonical.outboundConfigured],
    ['sender_unavailable', canonical.senderConfigured
      && canonical.senderAuthenticationAttested],
    ['limited_smoke_domain_unverified', canonical.sendingDomainVerified
      && canonical.sendingDomain === P10B_LIMITED_SMOKE_SENDING_DOMAIN],
    ['limited_smoke_key_scope_invalid', canonical.apiKeyPermission === 'sending-access'
      && canonical.apiKeyDomainRestriction === P10B_LIMITED_SMOKE_SENDING_DOMAIN],
    ['suppression_unavailable', canonical.suppressionOperational],
    ['limited_smoke_inbound_claim_forbidden', !canonical.webhookConfigured
      && !canonical.requestReplyRoutingVerified && !canonical.replyTrackingVerified],
    ['limited_smoke_reconciliation_claim_forbidden', !canonical.reconciliationOperational],
    ['readiness_evidence_unversioned', Boolean(canonical.evidenceRevision)],
    ['readiness_evidence_time_invalid', Boolean(generatedAt && expiresAt)
      && Date.parse(generatedAt) <= Date.parse(now)
      && Date.parse(expiresAt) > Date.parse(now)],
  ];
  const blockers = blockerPairs.filter(([, passed]) => !passed).map(([code]) => code);
  const authority = { ...canonical, blockers, ready: blockers.length === 0 };
  return { ...authority, authorityDigest: sha256(stableCanonicalJson(authority)) };
}

function redactedEvidence({ review, finalization, cleanup, authorizationId, now, expiresAt,
  readiness, providerProfile = CONTROLLED_PROFILE, databaseIdentityHash = '',
  implementationHead = '', finalizationStarted = false, executionError = null }) {
  const providerResult = finalization?.providerResult || {};
  const providerOutcome = finalization?.outcome?.category
    || (executionError ? 'execution-error' : 'authorization-denied');
  const providerAttempted = providerResult.providerAttempted === true
    && providerResult.providerSeamEntered === true;
  const limited = providerProfile === LIMITED_PROFILE;
  const durableState = String(finalization?.durableResult?.transmission?.state || '');
  const durableAcceptanceRecorded = providerOutcome === 'accepted'
    && durableState === 'accepted' && finalization?.durableResult?.conflict !== true
    && (finalization?.durableResult?.applied === true
      || finalization?.durableResult?.existing === true);
  const outcome = limited && providerOutcome === 'accepted' && !durableAcceptanceRecorded
    ? 'ambiguous' : providerOutcome;
  return {
    version: limited ? 'p10b-limited-free-smoke-evidence-v1'
      : 'p10b-controlled-mailbox-evidence-v1',
    observedAt: new Date(now).toISOString(),
    authorizationExpiresAt: expiresAt,
    providerProfile,
    ...(limited ? { databaseIdentityHash, implementationHead, providerOutcome,
      durableOutcome: durableState || 'unresolved', durableAcceptanceRecorded,
      ...LIMITED_EVIDENCE_FIELDS } : {}),
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
  armedConfig.dealHunter.cimProvider.resendApiKey = '';
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

async function executeP10b({
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
  providerProfile = CONTROLLED_PROFILE,
  expectedConfirmation = P10B_EXECUTION_CONFIRMATION,
  databaseIdentityHash = '',
  implementationHead = '',
  fetcher,
  testHooks,
  services = {},
} = {}) {
  boundedText(actor, 'actor', 200);
  boundedText(opportunityId, 'opportunity id', 200);
  boundedText(initialActivationId, 'initial activation id');
  const limited = providerProfile === LIMITED_PROFILE;
  if (confirmation !== expectedConfirmation) {
    throw new Error(`P10B confirmation must equal ${expectedConfirmation}`);
  }
  if (!/^[0-9a-f]{64}$/.test(reviewDigest || '')) {
    throw new Error('P10B exact review digest is required');
  }
  const expiry = authorizationWindow(now, expiresAt);
  const controlled = limited
    ? assertHardOffLimitedConfig(config, '', { execution: true })
    : assertHardOffControlledConfig(config);
  if (limited && (!/^[0-9a-f]{64}$/.test(databaseIdentityHash || '')
    || !/^[0-9a-f]{40}$/.test(implementationHead || ''))) {
    throw new Error('P10B limited smoke database identity and implementation head are required');
  }
  const readiness = limited
    ? normalizeLimitedSmokeReadiness(providerReadiness, { now })
    : normalizeCimProviderReadiness(providerReadiness, { providerProfile, now });
  if (!readiness.ready || readiness.providerProfile !== providerProfile) {
    throw new Error(`P10B provider readiness is unavailable: ${readiness.blockers.join(',')
      || 'profile_mismatch'}`);
  }
  const getReleaseReport = services.getReleaseReport || getPursueCimReleaseReport;
  const report = await getReleaseReport({ storage, opportunityId, now });
  if (report?.pause?.paused !== true || report?.liveAuthorization) {
    throw new Error('P10B execution requires a paused, unauthorized prepared transmission');
  }
  const review = buildP10bReviewArtifact(report, { providerProfile: controlled.profile.profile,
    initialActivationId, databaseIdentityHash, implementationHead });
  validateReviewBinding(review, config, { execution: true });
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
      providerProfile, expiresAt: expiry, actor,
      reason: `P10B exact reviewed transmission ${reviewDigest}`, now: new Date(now).toISOString() });
    if (issued?.issued !== true || issued.authorization?.maximum_calls !== 1
      || issued.authorization?.id !== authorizationId) {
      throw new Error(`P10B live authorization was not issued: ${issued?.blockedReason || 'conflict'}`);
    }
    armedConfig.dealHunter.cimProvider.enabled = true;
    await setPause({ paused: false, actor,
      reason: `P10B bounded authorization ${sha256(authorizationId)}`, storage });
    const gate = await authorizePrepared({ storage, transmissionId: review.transmission.id,
      authorizationId, writerPath: 'pursue-cim-initial', providerProfile,
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
      authorizationId, writerPath: 'pursue-cim-initial', providerProfile,
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
      now, expiresAt: expiry, readiness, providerProfile, databaseIdentityHash,
      implementationHead, finalizationStarted,
      executionError: executionError || error });
    throw error;
  }
  if (executionError) {
    executionError.p10bEvidence = redactedEvidence({ review, finalization, cleanup,
      authorizationId, now, expiresAt: expiry, readiness, providerProfile,
      databaseIdentityHash, implementationHead, finalizationStarted, executionError });
    throw executionError;
  }
  return { version: limited ? 'p10b-limited-free-smoke-execution-v1'
    : 'p10b-controlled-mailbox-execution-v1',
    evidence: redactedEvidence({ review, finalization, cleanup, authorizationId,
      now, expiresAt: expiry, readiness, providerProfile, databaseIdentityHash,
      implementationHead, finalizationStarted }) };
}

export async function executeP10bControlledMailbox(options = {}) {
  return executeP10b({ ...options, providerProfile: CONTROLLED_PROFILE,
    expectedConfirmation: P10B_EXECUTION_CONFIRMATION });
}

export async function executeP10bLimitedFreeSmoke(options = {}) {
  return executeP10b({ ...options, providerProfile: LIMITED_PROFILE,
    expectedConfirmation: P10B_LIMITED_SMOKE_CONFIRMATION });
}

// Deliberately no CLI/startup registration. The supervisor supplies fresh
// local runtime/budget observations and owns stopping the isolated Machine.
// This permission is not a provider readiness receipt.
export async function executeP10bFirstMailboxQualification({ storage, config,
  opportunityId, initialActivationId, manifest: inputManifest, reviewedDigest,
  supervisorTarget, observe, stopAndVerify, clock = () => new Date(), actor,
  fetcher, readFetcher, testHooks = {}, onBeforeStop, signal, stopTimeoutMs = 30000, lifecyclePollMs = 250 } = {}) {
  const supervisor = createQualificationSupervisor({ target: supervisorTarget, stopAndVerify, clock,
    maximumRuntimeMs: inputManifest?.maximumRuntimeMs, stopTimeoutMs, beforeStop: closeAuthorityAndHandoff });
  const at = () => new Date(clock()).toISOString();
  let manifest;
  let armedConfig;
  let authorizationId;
  let providerCalls = 0;
  let finalization;
  let lifecycle;
  let cleanup = { errors: [] };
  let stop;
  let failure;
  let failureStage = 'validation';
  const cancel = () => { void supervisor.close(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const request = async (url, options, reader) => {
    supervisor.assertActive();
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(supervisor.remaining(), Number(options.timeoutMs) || 10000));
    let timer;
    try {
      return await supervisor.bounded(() => Promise.race([
        (async () => {
          const response = await (reader || fetchWithTimeout)(url, { ...options, timeoutMs,
            signal: AbortSignal.any([controller.signal, supervisor.signal]) });
          const chunks = [];
          let length = 0;
          if (response.body) {
            const bodyReader = response.body.getReader();
            try {
              for (;;) {
                const { done, value } = await bodyReader.read();
                if (done) break;
                length += value.byteLength;
                if (length > 65536 || supervisor.signal.aborted) {
                  void bodyReader.cancel().catch(() => {});
                  throw new Error('Qualification response bounds exceeded');
                }
                chunks.push(value);
              }
            } finally { bodyReader.releaseLock(); }
          } else {
            const bytes = Buffer.from(JSON.stringify(await response.json()));
            if (bytes.length > 65536) throw new Error('Qualification response bounds exceeded');
            chunks.push(bytes);
            length = bytes.length;
          }
          return new Response(Buffer.concat(chunks, length), {
            status: response.status, headers: response.headers });
        })(),
        new Promise((resolve, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Qualification provider timeout'));
        }, timeoutMs); }),
      ]));
    } catch { throw new Error('Qualification provider outcome unknown'); }
    finally { clearTimeout(timer); }
  };
  async function closeAuthorityAndHandoff() {
    if (armedConfig && authorizationId) {
      try {
        // SQLite cleanup is synchronous internally. Bound unexpected injected
        // stalls; a late result never restores execution permission.
        let timer;
        try {
          cleanup = await Promise.race([
            cleanupExecution({ storage, services: {}, authorizationId, initialActivationId,
              actor, now: new Date().toISOString(), armedConfig }),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ errors: ['cleanup_timeout'] }), stopTimeoutMs); }),
          ]);
        } finally { clearTimeout(timer); }
      } catch { cleanup = { errors: ['cleanup_failed'] }; }
    }
    // Close SQLite authority while the Machine is still alive. A host-owned
    // supervisor can retain this bounded candidate over the existing SSH
    // channel before stopping the worker's Machine. It is not a final artifact.
    if (typeof onBeforeStop === 'function') {
      let timer;
      try {
        const proof = lifecycle ? { ...lifecycle, version: 'p10b-lifecycle-proof-candidate-v1',
          lifecycleVerified: false, productionReady: false } : null;
        if (proof) { delete proof.digest; proof.digest = sha256(stableCanonicalJson(proof)); }
        await Promise.race([
          Promise.resolve().then(() => onBeforeStop({ version: 'p10b-pre-stop-candidate-v1',
            manifestDigest: reviewedDigest, providerCalls,
            outcome: finalization?.outcome?.category || 'unknown',
            failureStage: failure ? failureStage : null, cleanup, proof,
            lifecycleVerified: false, productionReady: false })),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Candidate handoff timed out')), stopTimeoutMs); }),
        ]);
      } catch { failure ||= new Error('Qualification candidate handoff failed'); failureStage = 'candidate-handoff'; }
      finally { clearTimeout(timer); }
    }
  }
  try {
    await supervisor.bounded(async () => {
      if (storage?.provider !== 'sqlite' || typeof observe !== 'function'
        || !Number.isSafeInteger(lifecyclePollMs) || lifecyclePollMs < 1 || lifecyclePollMs > 1000) {
        throw new Error('P10B qualification requires SQLite and an explicit supervisor');
      }
      boundedText(actor, 'actor', 200);
      assertQualificationHardOff(config);
      manifest = structuredClone(inputManifest);
      armedConfig = structuredClone(config);
      if (manifest.runtime?.app !== supervisor.target.app
        || manifest.runtime?.machineId !== supervisor.target.machineId) {
        throw new Error('P10B qualification supervisor target mismatch');
      }
      supervisor.bindDeadline(manifest.expiresAt);
      const qualification = { manifest, reviewedDigest, clock,
        assertActive: supervisor.assertActive,
        observe: () => supervisor.bounded(observe) };
      const observed = await qualification.observe();
      const check = validateQualificationContract({ ...qualification, observed, now: at() });
      if (!check.valid) throw new Error(`P10B qualification denied: ${check.reason}`);
      authorizationId = `p10b-q-${reviewedDigest.slice(0, 48)}`;
      const now = at();
      const report = await getPursueCimReleaseReport({ storage, opportunityId, now });
      supervisor.assertActive();
      if (report?.pause?.paused !== true || report?.liveAuthorization
        || report?.transmission?.state !== 'prepared') throw new Error('P10B qualification is not fresh prepared work');
      const review = buildP10bReviewArtifact(report, { providerProfile: CONTROLLED_PROFILE, initialActivationId });
      validateReviewBinding(review, armedConfig, { execution: true });
      if (review.digest !== manifest.reviewDigest || review.transmission.id !== manifest.transmissionId
        || review.transmission.payloadDigest !== manifest.payloadDigest) throw new Error('P10B qualification review binding changed');
      const issued = await storage.issueCimLiveProviderAuthorization({ id: authorizationId,
        activationId: initialActivationId, capability: 'fl04b-initial',
        writerPath: P10B_QUALIFICATION_WRITER, transmissionId: manifest.transmissionId,
        payloadDigest: manifest.payloadDigest, recipientAuthorityDigest: review.recipientAuthority.fingerprint,
        providerProfile: CONTROLLED_PROFILE, actor, reason: qualificationReason(manifest),
        now: manifest.issuedAt, expiresAt: manifest.expiresAt,
        qualification: { manifest, reviewedDigest, observed } });
      supervisor.assertActive();
      if (issued?.issued !== true) throw new Error('P10B qualification permission was not issued');
      const gate = await authorizePreparedCimTransmission({ storage,
        transmissionId: manifest.transmissionId, authorizationId, writerPath: P10B_QUALIFICATION_WRITER,
        providerProfile: CONTROLLED_PROFILE, actor, now: at(), configOverride: armedConfig,
        readCurrentAuthority: readP10bSyntheticCurrentAuthority, qualification });
      supervisor.assertActive();
      if (gate?.authorized !== true) throw new Error('P10B qualification final gate denied execution');
      failureStage = 'outbound';
      const singleFetch = async (url, options) => {
        supervisor.assertActive();
        assertQualificationHardOff(armedConfig);
        const observedNow = await qualification.observe();
        if (!validateQualificationContract({ ...qualification, observed: observedNow, now: at() }).valid
          || providerCalls !== 0 || url !== 'https://api.resend.com/emails' || options.method !== 'POST') {
          throw new Error('P10B qualification provider boundary denied');
        }
        const durable = await storage.readCimFinalGateContext({ transmissionId: manifest.transmissionId, authorizationId, now: at() });
        if (!validateQualificationContract({ ...qualification, observed: observedNow, now: at(), ...durable }).valid
          || durable?.transmission?.state !== 'provider-pending'
          || durable.transmission.invocation_authority_count !== 1
          || !durable.transmission.provider_seam_entered_at || !durable.authorization?.consumed_at
          || durable.qualificationChainCurrent !== true || Number(durable.safety?.outreach_paused) !== 1) {
          throw new Error('P10B qualification durable provider permission changed');
        }
        supervisor.assertActive();
        providerCalls += 1;
        return request(url, options, fetcher);
      };
      finalization = await finalizeAuthorizedCimTransmission({ storage, finalGateResult: gate,
        authorizationId, writerPath: P10B_QUALIFICATION_WRITER, providerProfile: CONTROLLED_PROFILE,
        actor, now: new Date(clock()), configOverride: armedConfig, fetcher: singleFetch, testHooks });
      supervisor.assertActive();
      // Ambiguity is consumed; it does not become retry or qualification proof.
      if (finalization?.outcome?.category !== 'accepted') return;
      failureStage = 'reconciliation-read';
      const context = await storage.readCimFinalGateContext({ transmissionId: manifest.transmissionId, authorizationId });
      const lookup = createCimResendReconciliationLookup({ configOverride: armedConfig, clock,
        fetcher: async (url, options) => {
          const observedNow = await qualification.observe();
          if (!validateQualificationContract({ ...qualification, observed: observedNow, now: at() }).valid
            || url !== 'https://api.resend.com/emails?limit=100' || options.method !== 'GET') {
            throw new Error('Qualification read boundary denied');
          }
          return request(url, options, readFetcher);
        } });
      const binding = immutableTransmissionBinding(context.transmission, CONTROLLED_PROFILE);
      const reconciliation = await lookup({ transmission: context.transmission, binding, providerProfile: CONTROLLED_PROFILE });
      supervisor.assertActive();
      failureStage = 'reconciliation-write';
      const reconciled = await reconcileCimProviderTransmission({ storage, transmission: context.transmission,
        providerProfile: CONTROLLED_PROFILE, readProviderEvidence: async () => reconciliation,
        actor, now: new Date(clock()), configOverride: armedConfig });
      if (!reconciled.resolved || reconciled.outcome !== 'accepted') throw new Error('Qualification reconciliation is not exact');
      failureStage = 'lifecycle-capture';
      await testHooks.beforeLifecycleObservation?.({ manifest, reconciliation });
      for (;;) {
        supervisor.assertActive();
        assertQualificationHardOff(armedConfig);
        const currentObservation = await qualification.observe();
        if (!validateQualificationContract({ ...qualification, observed: currentObservation, now: at() }).valid) {
          throw new Error('Qualification execution binding drifted during lifecycle observation');
        }
        const lifecycleAuthority = await storage.readCimFinalGateContext({ transmissionId: manifest.transmissionId,
          authorizationId, now: at() });
        if (lifecycleAuthority?.qualificationChainCurrent !== true
          || Number(lifecycleAuthority.safety?.outreach_paused) !== 1) {
          throw new Error('Qualification lifecycle permission was revoked');
        }
        const snapshot = await readQualificationLifecycleSnapshot({ storage, manifest });
        supervisor.assertActive();
        if (snapshot) {
          failureStage = 'lifecycle-verification';
          lifecycle = verifyQualificationLifecycle({ manifest, config: armedConfig, snapshot, reconciliation, now: at() });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(lifecyclePollMs, supervisor.remaining())));
      }
    });
  } catch (error) { failure = error; }
  finally { stop = await supervisor.close(); signal?.removeEventListener('abort', cancel); }
  const evidence = { version: 'p10b-first-mailbox-qualification-result-v1',
    manifestDigest: reviewedDigest, ...stop, providerCalls,
    failureStage: failure ? failureStage : null,
    outcome: finalization?.outcome?.category || 'unknown', cleanup,
    lifecycleVerified: Boolean(lifecycle && !failure && stop.stoppedVerified && cleanup.errors.length === 0),
    productionReady: false, reconciliationOnly: Boolean(failure || !stop.stoppedVerified
      || cleanup.errors.length || finalization?.outcome?.category !== 'accepted') };
  if (failure || !stop.stoppedVerified || cleanup.errors.length) {
    const error = new Error(!stop.stoppedVerified ? 'P10B qualification stop is unverified'
      : cleanup.errors.length ? 'P10B qualification permission closure is unverified' : 'P10B qualification execution failed');
    error.p10bEvidence = evidence;
    throw error;
  }
  return { evidence, ...(evidence.lifecycleVerified ? { lifecycle } : {}) };
}

export function buildP10bLimitedSmokePostRunAttestation({
  runEvidenceRaw,
  review,
  actor,
  observedAt,
  keyPermission,
  keyDomainScope,
  keyRevokedAt,
  secretRemovedAt,
  manualReceiptObserved = false,
  manualReceiptObservedAt = '',
} = {}) {
  boundedText(actor, 'attestation actor', 200);
  if (typeof runEvidenceRaw !== 'string' || runEvidenceRaw.length < 2) {
    throw new Error('P10B limited smoke raw run evidence is required');
  }
  let evidence;
  try { evidence = JSON.parse(runEvidenceRaw); }
  catch { throw new Error('P10B limited smoke run evidence must be valid JSON'); }
  const preparationReview = review?.review;
  if (evidence?.version !== 'p10b-limited-free-smoke-evidence-v1'
    || preparationReview?.version !== 'p10b-limited-free-smoke-review-v1'
    || evidence.reviewDigest !== preparationReview.digest
    || evidence.databaseIdentityHash !== preparationReview.databaseIdentityHash
    || evidence.implementationHead !== preparationReview.implementationHead
    || !/^[0-9a-f]{64}$/.test(evidence.authorizationIdHash || '')
    || !/^[0-9a-f]{40}$/.test(evidence.implementationHead || '')
    || typeof evidence.durableAcceptanceRecorded !== 'boolean'
    || Object.entries(LIMITED_EVIDENCE_FIELDS)
      .some(([name, value]) => evidence[name] !== value || preparationReview[name] !== value)) {
    throw new Error('P10B limited smoke evidence binding is invalid');
  }
  const observed = limitedReadinessInstant(observedAt);
  const revoked = limitedReadinessInstant(keyRevokedAt);
  const removed = limitedReadinessInstant(secretRemovedAt);
  const receiptAt = manualReceiptObserved
    ? limitedReadinessInstant(manualReceiptObservedAt) : '';
  if (!observed || !revoked || !removed || Date.parse(revoked) > Date.parse(observed)
    || Date.parse(removed) > Date.parse(observed)
    || (manualReceiptObserved && (!receiptAt || Date.parse(receiptAt) > Date.parse(observed)))
    || (!manualReceiptObserved && manualReceiptObservedAt)) {
    throw new Error('P10B limited smoke post-run attestation timestamps are invalid');
  }
  if (keyPermission !== 'sending-access'
    || normalizedDomain(keyDomainScope) !== P10B_LIMITED_SMOKE_SENDING_DOMAIN) {
    throw new Error('P10B limited smoke key-scope attestation is invalid');
  }
  const cleanup = evidence.cleanup || {};
  const runCleanupComplete = cleanup.hardOffRestored === true
    && cleanup.pauseRestored === true && cleanup.authorizationClosed === true
    && cleanup.activationClosed === true && Array.isArray(cleanup.errors)
    && cleanup.errors.length === 0;
  return {
    version: 'p10b-limited-free-smoke-post-run-attestation-v1',
    observedAt: observed,
    actor: boundedText(actor, 'attestation actor', 200),
    runEvidenceDigest: sha256(runEvidenceRaw),
    reviewDigest: evidence.reviewDigest,
    databaseIdentityHash: evidence.databaseIdentityHash,
    implementationHead: evidence.implementationHead,
    authorizationIdHash: evidence.authorizationIdHash,
    executionObservedAt: evidence.observedAt,
    keyPermissionAttested: keyPermission,
    keyDomainScopeAttested: normalizedDomain(keyDomainScope),
    keyRevokedAt: revoked,
    secretRemovedAt: removed,
    manualReceiptObserved: manualReceiptObserved === true,
    manualReceiptObservedAt: receiptAt,
    manualReceiptObservedBy: manualReceiptObserved ? actor : '',
    manualAttestation: true,
    trustedLifecycleEvidence: false,
    runCleanupComplete,
    limitedSmokeSuccessful: evidence.providerCalls === 1
      && evidence.outcome === 'accepted' && evidence.providerOutcome === 'accepted'
      && evidence.durableOutcome === 'accepted'
      && evidence.durableAcceptanceRecorded === true && runCleanupComplete,
    ...LIMITED_EVIDENCE_FIELDS,
  };
}
