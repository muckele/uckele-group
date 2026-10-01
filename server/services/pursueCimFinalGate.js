import { randomBytes } from 'node:crypto';

import { getConfig, validateCimProviderProfileBinding } from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { evaluateAcquisitionMaterialsState } from './acquisitionMaterials.js';
import { readCimCurrentAuthority as readCurrentCimAuthority } from './cimCampaignSafety.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import { getEmailReadiness } from './emailReadiness.js';
import { CIM_CAMPAIGN_POLICY_VERSION } from './cimCampaignPolicy.js';

const READINESS_VERSION = 'cim-provider-readiness-v1';
const SOURCE_AUTHORITY_VERSION = 'cim-source-health-authority-v1';
const INITIAL_PAYLOAD_VERSION = 'deal-hunter-cim-manual-stage1-v1';
const INITIAL_BATCHING_POLICY_VERSION = 'batching-off-v1';

function text(value, maximum = 240) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : '';
}

function instant(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function digest(value) {
  return sha256(stableCanonicalJson(value));
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function sourceAuthorityEvidence(authority, globalAuthorityRevision) {
  const sourceRows = Array.isArray(authority?.sourceRows) ? authority.sourceRows : [];
  const sourceStates = Array.isArray(authority?.sourceStates) ? authority.sourceStates : [];
  const identityExceptions = Array.isArray(authority?.identityExceptions)
    ? authority.identityExceptions : [];
  const blockers = sortedUnique(Array.isArray(authority?.blockers) ? authority.blockers.map(String) : []);
  const canonical = {
    version: SOURCE_AUTHORITY_VERSION,
    opportunityId: text(authority?.opportunityId, 200),
    globalAuthorityRevision: Number(globalAuthorityRevision),
    opportunity: {
      status: text(authority?.opportunity?.status, 80),
      identityVersion: text(authority?.opportunity?.identity_version, 120),
      campaignAuthorityRevision: Number(authority?.opportunity?.campaign_authority_revision),
      discoveryState: text(authority?.opportunity?.discovery_state, 80),
      discoveryRevision: Number(authority?.opportunity?.discovery_revision),
      materialRevision: Number(authority?.opportunity?.material_revision),
    },
    sourceRows: sourceRows.map((row) => ({
      id: text(row.id), sourceId: text(row.source_id ?? row.sourceId, 160),
      sourceRecordId: text(row.source_record_id ?? row.sourceRecordId, 200),
      acceptedAt: instant(row.accepted_at ?? row.acceptedAt),
      evidenceId: text(row.accepted_evidence_id ?? row.acceptedEvidenceId),
    })).sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right))),
    sourceStates: sourceStates.map((state) => ({
      sourceId: text(state.source_id ?? state.sourceId, 160),
      acceptedGeneration: Number(state.accepted_generation ?? state.acceptedGeneration),
      acceptedDigest: text(state.accepted_digest ?? state.acceptedDigest, 64),
      acceptedAt: instant(state.accepted_at ?? state.acceptedAt),
      projectionState: text(state.projection_state ?? state.projectionState, 80),
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    identityExceptionIds: identityExceptions.map((item) => text(item.id)).filter(Boolean).sort(),
    sourceHealth: {
      healthy: authority?.sourceHealth?.healthy === true,
      requiredSources: sortedUnique((authority?.sourceHealth?.requiredSources
        ?? authority?.sourceHealth?.required_sources ?? []).map(String)),
      issueCodes: sortedUnique((authority?.sourceHealth?.issues ?? []).map((issue) =>
        text(typeof issue === 'string' ? issue : issue?.code, 160))),
    },
    blockers,
  };
  const evidence = { ...canonical,
    ready: authority?.blocked === false && blockers.length === 0
      && canonical.opportunity.status === 'active'
      && canonical.sourceRows.length > 0
      && canonical.sourceHealth.healthy
      && canonical.sourceStates.every((state) => state.projectionState === 'accepted')
      && canonical.identityExceptionIds.length === 0 };
  return { ...evidence, authorityDigest: digest(evidence) };
}

export function normalizeCimProviderReadiness(readiness = {}, {
  providerProfile, now = new Date().toISOString(),
} = {}) {
  const generatedAt = instant(readiness.generatedAt) || instant(now);
  const expiresAt = instant(readiness.expiresAt) || generatedAt;
  const normalized = {
    version: READINESS_VERSION,
    provider: text(readiness.provider, 80),
    providerProfile: text(readiness.providerProfile ?? providerProfile, 120),
    outboundConfigured: readiness.outboundConfigured === true,
    senderConfigured: readiness.senderConfigured === true
      || Boolean(text(readiness.fromAddress, 320)),
    senderAuthenticationAttested: readiness.senderAuthenticationAttested === true,
    webhookConfigured: readiness.webhookConfigured === true,
    requestReplyRoutingVerified: readiness.requestReplyRoutingVerified === true,
    replyTrackingVerified: readiness.replyTrackingVerified === true,
    suppressionOperational: readiness.suppressionOperational === true,
    reconciliationOperational: readiness.reconciliationOperational === true,
    evidenceRevision: text(readiness.evidenceRevision, 240),
    generatedAt,
    expiresAt,
  };
  const blockerPairs = [
    ['provider_unavailable', normalized.provider === 'resend' && normalized.outboundConfigured],
    ['sender_unavailable', normalized.senderConfigured && normalized.senderAuthenticationAttested],
    ['signed_webhook_unavailable', normalized.webhookConfigured],
    ['request_reply_routing_unverified', normalized.requestReplyRoutingVerified
      && normalized.replyTrackingVerified],
    ['suppression_unavailable', normalized.suppressionOperational],
    ['reconciliation_unavailable', normalized.reconciliationOperational],
    ['readiness_evidence_unversioned', Boolean(normalized.evidenceRevision)],
    ['readiness_evidence_expired', Boolean(normalized.expiresAt)
      && Date.parse(normalized.expiresAt) > Date.parse(now)],
  ];
  const blockers = blockerPairs.filter(([, passed]) => !passed).map(([code]) => code);
  const authority = { ...normalized, blockers, ready: blockers.length === 0 };
  return { ...authority, authorityDigest: digest(authority) };
}

async function defaultProviderReadiness({ storage, providerProfile, now }) {
  const email = await getEmailReadiness({ storage });
  return normalizeCimProviderReadiness({ ...email,
    providerProfile,
    senderConfigured: Boolean(email.fromAddress || email.outboundConfigured),
    senderAuthenticationAttested: false,
    requestReplyRoutingVerified: false,
    reconciliationOperational: false,
    evidenceRevision: '', generatedAt: now, expiresAt: now,
  }, { providerProfile, now });
}

function materialAuthorityEvidence(authority) {
  const materials = authority?.materialsState ?? evaluateAcquisitionMaterialsState({});
  const canonical = {
    materialsReceived: materials?.materialsReceived === true,
    advancedBeyondBrokerOutreach: materials?.advancedBeyondBrokerOutreach === true,
    evidenceCodes: sortedUnique((materials?.evidenceCodes ?? []).map(String)),
    preparationBlockerCodes: sortedUnique((authority?.preparationBlockers ?? [])
      .map((item) => text(item?.code, 160))),
    suppressionPresent: Boolean(authority?.suppression),
    terminalReason: text(authority?.terminalReason, 160),
    priorRequestPresent: Boolean(authority?.existingRequest || authority?.opportunityClaim),
    pursued: authority?.pursued === true,
    disposition: text(authority?.currentDispositionState, 80),
  };
  return { ...canonical, authorityDigest: digest(canonical) };
}

function recipientAuthorityEvidence(authority, opportunityId, recipientAddress) {
  const recipient = (authority?.recipientOptions ?? []).find((candidate) =>
    String(candidate?.email ?? '').toLowerCase() === String(recipientAddress ?? '').toLowerCase());
  const canonical = {
    opportunityId,
    addressDigest: sha256(String(recipient?.email ?? '').toLowerCase()),
    provenanceFingerprint: text(recipient?.provenanceFingerprint, 64),
    permissionProvenanceFingerprint: text(recipient?.permissionProvenanceFingerprint, 64),
    contactAuthorityRevision: text(recipient?.contactAuthorityRevision, 64),
  };
  const derivedRecipientFingerprint = canonical.provenanceFingerprint
    && canonical.contactAuthorityRevision && recipient?.email
    ? sha256(stableCanonicalJson({ opportunityId,
      emailHash: sha256(recipient.email),
      provenanceFingerprint: canonical.provenanceFingerprint,
      contactAuthorityRevision: canonical.contactAuthorityRevision })) : '';
  const evidence = { ...canonical, derivedRecipientFingerprint,
    present: Boolean(recipient?.email) };
  return { ...evidence, authorityDigest: digest(evidence) };
}

function durableSnapshot(context) {
  const transmission = context.transmission ?? {};
  const conversation = context.conversation ?? {};
  const communication = context.communication ?? {};
  const outbox = context.outbox ?? {};
  return {
    transmission: {
      id: transmission.id, state: transmission.state, releaseState: transmission.release_state,
      rowVersion: Number(transmission.row_version), invocationAuthorityCount:
        Number(transmission.invocation_authority_count), payloadDigest: transmission.payload_digest,
      memberDigest: transmission.member_digest,
      preparationGeneration: Number(transmission.preparation_generation),
      payloadVersion: transmission.payload_version, conversationId: transmission.conversation_id,
      communicationId: transmission.communication_id, outboxId: transmission.outbox_id,
      providerSeamEntered: Boolean(transmission.provider_seam_entered_at),
    },
    conversation: {
      id: conversation.id, state: conversation.state,
      terminalRevision: Number(conversation.terminal_revision), rowVersion: Number(conversation.row_version),
      recipientAuthorityId: conversation.recipient_authority_id,
      recipientFingerprint: conversation.recipient_fingerprint,
      recipientAddressDigest: sha256(String(conversation.recipient_address ?? '').toLowerCase()),
      senderPolicyVersion: conversation.sender_policy_version,
      replyPolicyVersion: conversation.reply_policy_version,
      batchingPolicyVersion: conversation.batching_policy_version,
    },
    authorization: context.authorization,
    activation: context.activation,
    safety: context.safety,
    globalAuthorityRevision: Number(context.globalAuthorityRevision),
    communication: {
      id: communication.id, outboxId: communication.outbox_id,
      deliveryState: communication.delivery_state, direction: communication.direction,
      channel: communication.channel, source: communication.source, kind: communication.kind,
      threadId: text(communication.thread_key, 500),
      fromAddressDigest: sha256(communication.from_address ?? ''),
      toAddressDigests: (communication.to_addresses ?? []).map((value) => sha256(String(value).toLowerCase())),
      ccAddressDigests: (communication.cc_addresses ?? []).map((value) => sha256(String(value).toLowerCase())),
      bccAddressDigests: (communication.bcc_addresses ?? []).map((value) => sha256(String(value).toLowerCase())),
      replyToAddressDigest: sha256(communication.reply_to_address ?? ''),
      subjectDigest: sha256(communication.subject ?? ''),
      bodyTextDigest: communication.body_text_digest,
      bodyHtmlDigest: communication.body_html_digest,
      tags: communication.tags ?? [],
    },
    outbox,
  };
}

function failure(reason, reconciliationOnly = false) {
  return { authorized: false, blockedReason: reason, transmission: null,
    boundaryNonceDigest: null, reconciliationOnly };
}

export async function authorizePreparedCimTransmission({
  storage, transmissionId, authorizationId, writerPath, providerProfile, actor,
  now = new Date().toISOString(),
  loadMemberAuthority = loadBrokerMaterialsAuthority,
  readCurrentAuthority = readCurrentCimAuthority,
  readProviderReadiness = defaultProviderReadiness,
  configOverride,
} = {}) {
  if (!storage?.readCimFinalGateContext || !storage?.authorizeCimProviderPending) {
    throw new Error('CIM final-gate storage authority is unavailable');
  }
  const gateInstant = instant(now);
  if (!gateInstant) throw new Error('Invalid CIM final-gate instant');
  const context = await storage.readCimFinalGateContext({ transmissionId, authorizationId,
    writerPath, providerProfile, now: gateInstant });
  if (!context?.transmission || !Array.isArray(context.members) || context.members.length < 1) {
    return failure('lifecycle_conflict');
  }
  const config = configOverride || getConfig();
  if (context.authorization?.provider_profile !== providerProfile
    || context.activation?.provider_profile !== providerProfile) {
    return failure('profile_mismatch');
  }
  const profileBinding = validateCimProviderProfileBinding(config, {
    providerProfile,
    fromAddress: context.communication?.from_address,
    toAddresses: context.communication?.to_addresses,
    ccAddresses: context.communication?.cc_addresses,
    bccAddresses: context.communication?.bcc_addresses,
    replyToAddress: context.communication?.reply_to_address,
  });
  if (!profileBinding.ok) return failure(profileBinding.blockers[0] || 'profile_mismatch');
  const unknownTransmissionPolicy = context.transmission.payload_version !== INITIAL_PAYLOAD_VERSION
    || context.conversation?.sender_policy_version !== CIM_CAMPAIGN_POLICY_VERSION
    || context.conversation?.reply_policy_version !== CIM_CAMPAIGN_POLICY_VERSION
    || context.conversation?.batching_policy_version !== INITIAL_BATCHING_POLICY_VERSION;
  const unknownPolicyCampaigns = [...new Map(context.members
    .filter((member) => unknownTransmissionPolicy
      || member?.campaign?.policy_version !== CIM_CAMPAIGN_POLICY_VERSION
      || member?.campaign?.template_version !== CIM_CAMPAIGN_POLICY_VERSION
      || member?.campaign?.permission_version !== context.activation?.prerequisite_activation_id)
    .map((member) => [member.campaign?.id, member.campaign])).values()]
    .filter((campaign) => campaign?.id);
  if (unknownPolicyCampaigns.length > 0) {
    if (typeof storage.appendCimTerminalEvent !== 'function') {
      return failure('unknown_policy_version');
    }
    for (let campaign of unknownPolicyCampaigns) {
      const evidence = {
        campaignId: campaign.id,
        policyVersion: String(campaign.policy_version ?? ''),
        templateVersion: String(campaign.template_version ?? ''),
        payloadVersion: String(context.transmission.payload_version ?? ''),
        senderPolicyVersion: String(context.conversation?.sender_policy_version ?? ''),
        replyPolicyVersion: String(context.conversation?.reply_policy_version ?? ''),
        batchingPolicyVersion: String(context.conversation?.batching_policy_version ?? ''),
        permissionVersion: String(campaign.permission_version ?? ''),
        permissionActivationId: String(context.activation?.prerequisite_activation_id ?? ''),
        transmissionId: context.transmission.id,
      };
      let projected = false;
      for (let attempt = 0; attempt < 2 && !projected; attempt += 1) {
        try {
          const terminal = await storage.appendCimTerminalEvent({
            eventId: digest({ type: 'unknown-cim-policy', ...evidence }),
            scope: 'campaign', scopeId: campaign.id,
            expectedRevision: Number(campaign.terminal_revision),
            expectedRowVersion: Number(campaign.row_version),
            nextState: 'action-required', reasonCode: 'unknown_policy_version',
            evidenceType: 'unknown-policy-version',
            evidenceId: digest(evidence), metadataDigest: digest(evidence),
            actor, source: 'pursue-cim-final-gate', observedAt: gateInstant, now: gateInstant,
          });
          projected = terminal?.applied === true || terminal?.replay === true;
        } catch {
          projected = false;
        }
        if (!projected) {
          const refreshed = await storage.readCimFinalGateContext({ transmissionId,
            authorizationId, writerPath, providerProfile, now: gateInstant });
          const current = refreshed?.members?.find((member) =>
            member?.campaign?.id === campaign.id)?.campaign;
          if (current?.state === 'action-required'
            && current?.reason_code === 'unknown_policy_version') projected = true;
          else if (current) campaign = current;
        }
      }
      if (!projected) return failure('unknown_policy_version');
    }
    return failure('unknown_policy_version');
  }
  const readinessInput = await readProviderReadiness({ storage, providerProfile, now: gateInstant,
    context });
  const readiness = readinessInput?.authorityDigest && typeof readinessInput.ready === 'boolean'
    ? readinessInput
    : normalizeCimProviderReadiness(readinessInput, { providerProfile, now: gateInstant });
  const members = [];
  for (const member of context.members) {
    const opportunityId = member.opportunity?.opportunity_id ?? member.membership?.opportunity_id;
    let brokerAuthority;
    let currentAuthority;
    try {
      [brokerAuthority, currentAuthority] = await Promise.all([
        loadMemberAuthority({ opportunityId, storage, now: new Date(gateInstant) }),
        readCurrentAuthority({ storage, opportunityId }),
      ]);
    } catch {
      brokerAuthority = {};
      currentAuthority = { opportunityId, blocked: true,
        blockers: ['source-authority-unavailable'], sourceRows: [], sourceStates: [],
        identityExceptions: [], sourceHealth: { healthy: false, issues: ['unavailable'] } };
    }
    members.push({
      membership: member.membership,
      touch: member.touch,
      campaign: member.campaign,
      decision: member.decision,
      enrollment: member.enrollment,
      opportunity: member.opportunity,
      timezone: member.timezone,
      crmOwnership: member.crmOwnership,
      crmSubmission: member.crmSubmission,
      recipientAuthority: recipientAuthorityEvidence(brokerAuthority, opportunityId,
        context.conversation?.recipient_address),
      materialsAuthority: materialAuthorityEvidence(brokerAuthority),
      sourceAuthority: sourceAuthorityEvidence(currentAuthority,
        context.globalAuthorityRevision),
    });
  }
  const authoritySnapshot = {
    version: 'cim-final-gate-authority-v1', gateInstant,
    ...durableSnapshot(context), readiness, members,
  };
  const finalGateAuthorityDigest = digest(authoritySnapshot);
  const boundaryNonce = randomBytes(32).toString('base64url');
  const boundaryNonceDigest = sha256(boundaryNonce);
  const campaignRevisions = sortedUnique(members.map((member) =>
    String(member.campaign?.terminal_revision ?? ''))).map(Number);
  const claimDigests = sortedUnique(members.map((member) => member.touch?.claim_token_digest));
  const command = {
    transmissionId, authorizationId, writerPath, providerProfile,
    expectedRowVersion: Number(context.transmission.row_version),
    expectedCampaignTerminalRevision: campaignRevisions.length === 1 ? campaignRevisions[0] : -1,
    expectedConversationTerminalRevision: Number(context.conversation?.terminal_revision),
    claimTokenDigest: claimDigests.length === 1 ? claimDigests[0] : '',
    expectedGlobalAuthorityRevision: Number(context.globalAuthorityRevision),
    finalGateAuthorityDigest, boundaryNonceDigest, authoritySnapshot,
    actor, now: gateInstant,
  };
  let outcome;
  try {
    outcome = await storage.authorizeCimProviderPending(command);
  } catch {
    return failure('authorization_outcome_unknown', true);
  }
  if (!outcome?.authorized) {
    const blockedReason = outcome?.blockedReason || 'lifecycle_conflict';
    return { ...failure(blockedReason, blockedReason === 'already_provider_pending'),
      transmission: outcome?.transmission ?? null };
  }
  if (outcome.boundaryNonceDigest !== boundaryNonceDigest
    || outcome.transmission?.state !== 'provider-pending'
    || outcome.transmission?.final_gate_authority_digest !== finalGateAuthorityDigest
    || Number(outcome.transmission?.invocation_authority_count) !== 1) {
    return failure('authorization_outcome_unknown', true);
  }
  return { ...outcome, reconciliationOnly: false, boundaryNonce };
}
