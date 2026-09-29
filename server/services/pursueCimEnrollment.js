import { sha256, stableCanonicalJson } from '../utils/security.js';
import { readCimCurrentAuthority } from './cimCampaignSafety.js';
import { calculateNextCimSlot, CIM_CAMPAIGN_POLICY_VERSION } from './cimCampaignPolicy.js';
import {
  loadBrokerMaterialsAuthority,
  resolveBrokerMaterialsRecipientContactRef,
} from './dealHunterBrokerMaterials.js';
import { ensureDealHunterSubmissionForCim } from './dealHunter.js';
import { validateIanaTimezone } from './opportunityTimezone.js';

const digest = (value) => sha256(stableCanonicalJson(value));
const options = (authority) => authority.recipientOptions.map(({ recipientContactRef,
  displayName, email, provenance, provenanceLabel, primary }) => ({ recipientContactRef,
  displayName, email, provenance, provenanceLabel, primary }));

export function pursuitPermissionBasisDigest(authority, recipient) {
  return digest({ type: 'p8-00-recipient-basis-v1', opportunityId: authority.opportunityId,
    recipientIdentityHash: sha256(recipient.email),
    provenanceFingerprint: recipient.permissionProvenanceFingerprint });
}

export function pursuitPermissionCohortDigest(authority, recipient) {
  return digest({ type: 'p8-00-one-recipient-cohort-v1', opportunityId: authority.opportunityId,
    recipientIdentityHash: sha256(recipient.email) });
}

function freshnessDigest(snapshot) {
  return digest({ type: 'p4b-freshness-authority-v1',
    opportunityId: snapshot.opportunityId,
    discoveryRevision: snapshot.opportunity?.discovery_revision,
    materialRevision: snapshot.opportunity?.material_revision,
    identityVersion: snapshot.opportunity?.identity_version,
    sourceRows: snapshot.sourceRows, sourceStates: snapshot.sourceStates,
    identityExceptions: snapshot.identityExceptions, sourceHealth: snapshot.sourceHealth });
}

function selectRecipient(authority, reference, now) {
  if (reference) {
    const selected = resolveBrokerMaterialsRecipientContactRef(authority, reference, now);
    return selected ? { selected } : { reason: 'recipient_changed' };
  }
  if (authority.recipientOptions.length === 0) return { reason: 'recipient_missing' };
  if (authority.recipientOptions.length === 1) return { selected: authority.recipientOptions[0] };
  const primaries = authority.recipientOptions.filter((item) => item.primary);
  return primaries.length === 1 ? { selected: primaries[0] }
    : { reason: 'recipient_ambiguous' };
}

function terminalReason(authority) {
  const blockers = new Set(authority.preparationBlockers.map((item) => item.code));
  if (blockers.has('required_source_authority_unavailable')) return 'current_authority_unavailable';
  if (blockers.has('opportunity_not_actionable') || blockers.has('opportunity_passed')
    || blockers.has('pursue_not_current') || blockers.has('not_pursued')) return 'owner_intent_changed';
  if (!authority.materialsAuthorityAvailable || !authority.communicationsAuthorityAvailable
    || !authority.eventAuthorityAvailable || !authority.suppressionAuthorityAvailable) {
    return 'current_authority_unavailable';
  }
  if (authority.materialsState?.materialsReceived
    || authority.materialsState?.advancedBeyondBrokerOutreach) return 'materials_received';
  if (authority.suppression) return 'recipient_suppressed';
  if (authority.terminalReason) return 'provider_ambiguous';
  if (authority.existingRequest) {
    if (authority.existingRequest.providerAcceptedAt) return 'prior_provider_accepted';
    if (['ambiguous', 'unknown'].includes(authority.existingRequest.deliveryState)) return 'provider_ambiguous';
    return 'prior_request_pending';
  }
  if (authority.opportunityClaim) return 'prior_request_pending';
  if (!authority.pursued || authority.currentDispositionState === 'dismissed') return 'owner_intent_changed';
  if (authority.preparationBlockers.some((item) => item.code === 'crm_owner_archived')) return 'crm_archived';
  return '';
}

function dealForCrm(authority, recipient) {
  const field = (name) => authority.sourceRows.find((row) => row.field === name)?.value || '';
  const source = authority.sourceRows[0] || {};
  return { opportunityId: authority.opportunityId, dealKey: authority.score?.deal_key || '',
    name: authority.opportunity.canonical_name || authority.score?.name || '',
    listingUrl: field('listing_url') || authority.score?.listing_url || '',
    location: authority.opportunity.canonical_location || '',
    sourceId: source.source_id || '', sourceName: source.source_name || '',
    sourceMode: 'canonical', id: source.source_record_id || '',
    score: Number(authority.score?.fit_score || 0),
    brokerName: recipient.displayName, brokerEmail: recipient.email,
    listingAliases: authority.aliases?.filter((item) => item.alias_type === 'listing-url')
      .map((item) => item.alias_value) || [],
    dealKeyAliases: authority.aliases?.filter((item) => item.alias_type === 'deal-key')
      .map((item) => item.alias_value) || [] };
}

function crmReason(error) {
  if (error?.code === 'CRM_MATCH_AMBIGUOUS') return 'crm_ambiguous';
  if (error?.code === 'CRM_MATCH_RECORD_INACTIVE') return 'crm_archived';
  if (error?.code === 'CRM_SUBMISSION_SUPERSEDED'
    || error?.evidenceCategories?.includes('supersession-conflict')) return 'crm_superseded';
  return 'crm_missing';
}

export async function orchestratePursuitEnrollment({ storage, opportunityId, enrollment,
  decision, recipientContactRef, actor, now = new Date(), readSourceHealth } = {}) {
  if (!enrollment || !['queued', 'waiting-on-eligibility'].includes(enrollment.state)
    || typeof storage?.transitionPursuitEnrollment !== 'function') {
    return { enrollment, recipientOptions: [] };
  }
  const at = new Date(now);
  let authority;
  let reason = '';
  let nextState = 'action-required';
  let phase = 'authority';
  try {
    authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now: at });
    if (authority.preparationBlockers.some((item) =>
      ['broker_materials_authority_unavailable', 'canonical_authority_unavailable'].includes(item.code))) {
      reason = 'current_authority_unavailable'; nextState = 'waiting-on-eligibility';
    } else {
      const choice = selectRecipient(authority, recipientContactRef, at);
      reason = choice.reason || '';
      if (!reason && decision?.selected_contact_reference_digest
        && sha256(recipientContactRef || '') !== decision.selected_contact_reference_digest) {
        reason = 'recipient_changed';
      }
      if (!reason) reason = terminalReason(authority);
      if (!reason) {
        const current = await readCimCurrentAuthority({ storage, opportunityId,
          ...(readSourceHealth ? { readSourceHealth } : {}) });
        if (current.blocked) {
          reason = current.blockers.includes('identity-exception-open')
            ? 'identity_ambiguous' : 'current_authority_unavailable';
          if (reason === 'current_authority_unavailable') nextState = 'waiting-on-eligibility';
        } else {
          const recipient = choice.selected;
          if (await storage.getActiveEmailSuppression(recipient.email)) reason = 'recipient_suppressed';
          const envelope = await storage.readPursuitEnrollmentAuthority({ opportunityId,
            now: at.toISOString() });
          const timezone = envelope.timezone;
          if (!reason && (!timezone || !['verified', 'derived'].includes(timezone.state)
            || !validateIanaTimezone(timezone.iana_timezone))) {
            reason = timezone?.state === 'ambiguous' ? 'timezone_ambiguous' : 'timezone_missing';
          }
          const activation = envelope.activation;
          if (!reason && !activation) {
            reason = 'contact_permission_missing'; nextState = 'waiting-on-eligibility';
          }
          if (!reason && activation.permission_basis_digest !== pursuitPermissionBasisDigest(authority, recipient)) {
            reason = 'contact_permission_changed';
          }
          if (!reason && activation.cohort_digest !== pursuitPermissionCohortDigest(authority, recipient)) {
            reason = 'contact_permission_outside_cohort';
          }
          if (!reason && (!Number.isSafeInteger(Number(activation.permission_revision))
            || Number(activation.permission_revision) < 1)) reason = 'contact_permission_missing';
          if (!reason) {
            let crm;
            phase = 'crm';
            try { crm = await ensureDealHunterSubmissionForCim(storage,
              dealForCrm(authority, recipient), actor); }
            catch (error) { reason = crmReason(error); }
            if (!reason && crm?.id) {
              const freshAuthority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now: at });
              const freshRecipient = freshAuthority.recipientOptions.find((item) =>
                item.email === recipient.email
                && item.permissionProvenanceFingerprint === recipient.permissionProvenanceFingerprint);
              const internallyLinkedCrm = !authority.submission?.id
                && freshAuthority.submission?.id === crm.id;
              if (!freshRecipient || (recipientContactRef && !internallyLinkedCrm
                && !resolveBrokerMaterialsRecipientContactRef(freshAuthority, recipientContactRef, at))) {
                reason = 'recipient_changed';
              } else {
                const fresh = await readCimCurrentAuthority({ storage, opportunityId,
                  ...(readSourceHealth ? { readSourceHealth } : {}) });
                if (fresh.blocked || freshnessDigest(fresh) !== freshnessDigest(current)) {
                  reason = 'current_authority_unavailable'; nextState = 'waiting-on-eligibility';
                } else {
                  const ownership = await storage.readCanonicalCrmOwnershipRevision(opportunityId);
                  const crmMatchAuthorityFingerprint =
                    await storage.readPursuitCrmMatchAuthorityFingerprint();
                  if (!ownership || ownership.submission_id !== crm.id
                    || fresh.opportunity.primary_submission_id !== crm.id
                    || !crmMatchAuthorityFingerprint) {
                    reason = 'current_authority_unavailable';
                    nextState = 'waiting-on-eligibility';
                  }
                  if (!reason) {
                  const slot = calculateNextCimSlot({ policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
                    timezone: timezone.iana_timezone, kind: 'initial', readyAt: at.toISOString() });
                  const recipientFingerprint = digest({ opportunityId, emailHash: sha256(freshRecipient.email),
                    provenanceFingerprint: freshRecipient.provenanceFingerprint,
                    contactAuthorityRevision: freshRecipient.contactAuthorityRevision });
                  phase = 'allocation';
                  const allocation = await storage.materializePursuitCampaign({
                    opportunityId, enrollmentId: enrollment.id,
                    expectedEnrollmentRowVersion: enrollment.row_version, generation: 1,
                    policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
                    templateVersion: CIM_CAMPAIGN_POLICY_VERSION,
                    templateDigest: digest({ opportunityId, recipientFingerprint,
                      policyVersion: CIM_CAMPAIGN_POLICY_VERSION }),
                    permissionVersion: activation.id,
                    permissionDigest: activation.permission_basis_digest,
                    permissionRevision: Number(activation.permission_revision),
                    permissionScope: activation.cohort_digest, policyHash: activation.policy_hash,
                    canonicalRevision: Number(fresh.opportunity.discovery_revision),
                    crmSubmissionId: crm.id,
                    crmOwnershipRevision: Number(ownership.revision),
                    crmBrokerEmail: freshAuthority.submission?.broker_email ?? null,
                    crmMatchAuthorityFingerprint,
                    campaignAuthorityRevision: Number(fresh.opportunity.campaign_authority_revision),
                    globalAuthorityRevision: Number(envelope.globalAuthorityRevision),
                    recipientAuthorityId: recipientFingerprint,
                    recipientFingerprint, recipientAddress: recipient.email,
                    senderPolicyVersion: CIM_CAMPAIGN_POLICY_VERSION,
                    replyPolicyVersion: CIM_CAMPAIGN_POLICY_VERSION,
                    replyAliasTokenDigest: digest({ opportunityId, recipientFingerprint, type: 'reply-alias-v1' }),
                    rfcThreadKey: digest({ opportunityId, type: 'rfc-thread-v1' }),
                    batchingPolicyVersion: 'batching-off-v1',
                    freshnessAuthorityDigest: freshnessDigest(fresh),
                    expectedDiscoveryRevision: Number(fresh.opportunity.discovery_revision),
                    expectedMaterialRevision: Number(fresh.opportunity.material_revision),
                    timezoneRevision: Number(timezone.revision),
                    cadencePolicyVersion: CIM_CAMPAIGN_POLICY_VERSION,
                    dueAt: slot.dueAt, dueLocal: slot.dueLocal, actor, now: at.toISOString(),
                  });
                  if (allocation.applied || allocation.existing) {
                    return { enrollment: { ...enrollment, state: 'campaign-created' },
                      campaign: allocation.campaign, recipientOptions: options(freshAuthority) };
                  }
                  reason = 'current_authority_unavailable';
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    reason = phase === 'allocation' ? 'allocation_failed' : 'current_authority_unavailable';
    nextState = phase === 'allocation' ? 'action-required' : 'waiting-on-eligibility';
  }
  const transition = await storage.transitionPursuitEnrollment({ enrollmentId: enrollment.id,
    expectedRowVersion: enrollment.row_version, nextState,
    reasonCode: reason || 'current_authority_unavailable', actor, now: at.toISOString() });
  return { enrollment: transition.enrollment || enrollment,
    recipientOptions: authority ? options(authority) : [] };
}
