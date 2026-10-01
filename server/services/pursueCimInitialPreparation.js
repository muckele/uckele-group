import { createHash, randomBytes } from 'node:crypto';

import {
  getCimProviderDeliveryConfig,
  getConfig,
  validateCimProviderProfileBinding,
} from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import {
  buildCimReplyToAddress,
  buildDealHunterCimRequestEmail,
  normalizeResendTags,
} from './delivery.js';

const leaseMilliseconds = 5 * 60 * 1000;

function recipientFingerprint(opportunityId, recipient) {
  if (!recipient.provenanceFingerprint || !recipient.contactAuthorityRevision) return '';
  return sha256(stableCanonicalJson({ opportunityId, emailHash: sha256(recipient.email),
    provenanceFingerprint: recipient.provenanceFingerprint,
    contactAuthorityRevision: recipient.contactAuthorityRevision }));
}

function proposal(candidate, authority, recipient, config) {
  const deliveryConfig = getCimProviderDeliveryConfig(config);
  const fromAddress = deliveryConfig.delivery.resendFromEmail
    || deliveryConfig.delivery.fallbackRecipient;
  if (!fromAddress || !recipient.email) throw new Error('CIM sender or recipient unavailable');
  const field = (name) => authority.sourceRows.find((row) => row.field === name)?.value || '';
  const message = buildDealHunterCimRequestEmail({
    to: recipient.email,
    deal: {
      opportunityId: candidate.opportunity_id,
      dealKey: authority.score?.deal_key || '',
      name: authority.opportunity?.canonical_name || authority.score?.name || '',
      industry: field('industry'),
      location: authority.opportunity?.canonical_location || '',
      listingUrl: field('listing_url') || authority.score?.listing_url || '',
      brokerName: recipient.displayName,
      score: authority.score?.fit_score,
    },
    requestedBy: 'pursue-cim-autopilot',
    cimRequestId: candidate.touch_id,
    submissionId: candidate.crm_submission_id,
    manualStage1: { greeting: recipient.firstName ? `Hi ${recipient.firstName},` : 'Hello,' },
    configOverride: deliveryConfig,
  });
  const tags = normalizeResendTags([
    ...message.tags,
    { name: 'cim_conversation_id', value: candidate.conversation_id },
    { name: 'cim_touch_id', value: candidate.touch_id },
  ])
    .map(({ name, value }) => `${name}=${value}`);
  if (tags.some((tag) => tag.length > 120)) throw new Error('CIM tag exceeds storage bound');
  const payload = {
    payloadVersion: message.templateVersion,
    fromAddress,
    toAddresses: [recipient.email], ccAddresses: [], bccAddresses: [],
    replyToAddress: buildCimReplyToAddress({
      requestId: candidate.conversation_id,
      replyTo: message.replyTo,
    }),
    subject: message.subject,
    bodyText: message.text,
    bodyHtmlSanitized: message.html,
    tags,
  };
  const profileBinding = validateCimProviderProfileBinding(config, {
    providerProfile: config.dealHunter?.cimProvider?.profile,
    fromAddress: payload.fromAddress,
    toAddresses: payload.toAddresses,
    ccAddresses: payload.ccAddresses,
    bccAddresses: payload.bccAddresses,
    replyToAddress: payload.replyToAddress,
  });
  if (!profileBinding.ok) {
    throw new Error(`CIM provider profile invalid: ${profileBinding.blockers.join(',')}`);
  }
  return payload;
}

export async function runDueCimInitialPreparations({ storage, now, clock, limit = 25,
  actor = 'pursue-cim-initial-preparer', loadAuthority = loadBrokerMaterialsAuthority,
  configOverride } = {}) {
  if (!storage?.listDueCimInitialTouches || !storage?.claimDueCimTouch
    || !storage?.prepareCimTransmission) throw new Error('CIM storage transitions unavailable');
  const instant = () => {
    const at = new Date(clock ? clock() : now ?? new Date());
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid CIM preparation instant');
    return at;
  };
  const candidates = await storage.listDueCimInitialTouches({
    now: instant().toISOString(), limit });
  const config = configOverride || getConfig();
  const outcomes = [];
  for (const candidate of candidates) {
    if (candidate.kind !== 'initial') throw new Error('Non-initial CIM touch reached Package 5');
    const rawClaimToken = randomBytes(32).toString('hex');
    const claimTokenDigest = createHash('sha256').update(rawClaimToken).digest('hex');
    const claimAt = instant();
    const claim = await storage.claimDueCimTouch({
      touchId: candidate.touch_id,
      expectedRowVersion: Number(candidate.row_version),
      expectedCampaignTerminalRevision: Number(candidate.campaign_terminal_revision),
      expectedConversationTerminalRevision: Number(candidate.conversation_terminal_revision),
      claimTokenDigest, claimOwner: actor,
      claimExpiresAt: new Date(claimAt.getTime() + leaseMilliseconds).toISOString(),
      now: claimAt.toISOString(),
    });
    if (!claim.claimed || claim.touch?.kind !== 'initial') {
      outcomes.push({ touchId: candidate.touch_id, claimed: false,
        staleAuthority: claim.staleAuthority, terminal: claim.terminal,
        conflict: claim.conflict, prepared: false });
      continue;
    }
    try {
      const authority = await loadAuthority({ opportunityId: candidate.opportunity_id,
        storage, now: instant() });
      const recipients = authority.recipientOptions?.filter((item) =>
        item.email === candidate.recipient_address) || [];
      const recipient = recipients.length === 1 ? recipients[0] : null;
      const fingerprint = recipient && recipientFingerprint(candidate.opportunity_id, recipient);
      if (authority.submission?.id !== candidate.crm_submission_id
        || authority.preparationBlockers?.length || !recipient
        || !fingerprint || fingerprint !== candidate.campaign_recipient_fingerprint
        || fingerprint !== candidate.conversation_recipient_fingerprint) {
        outcomes.push({ touchId: candidate.touch_id, claimed: true,
          prepared: false, staleAuthority: true });
        continue;
      }
      const payload = proposal(candidate, authority, recipient, config);
      const result = await storage.prepareCimTransmission({
        touchIds: [candidate.touch_id], claimTokenDigest,
        expectedCampaignTerminalRevision: Number(candidate.campaign_terminal_revision),
        expectedConversationTerminalRevision: Number(candidate.conversation_terminal_revision),
        preparationGeneration: 1, ...payload, actor, now: instant().toISOString(),
      });
      outcomes.push({ touchId: candidate.touch_id, prepared: result.prepared,
        existing: result.existing, payloadConflict: result.payloadConflict,
        terminal: result.terminal, transmissionId: result.transmission?.id ?? null });
    } catch (error) {
      outcomes.push({ touchId: candidate.touch_id, claimed: true,
        prepared: false, constructionFailed: true, reason: error.message });
    }
  }
  return outcomes;
}
