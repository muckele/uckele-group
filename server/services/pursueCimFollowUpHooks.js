// Production `loadAuthority` and `buildPayload` hooks for `runCimFollowUpPreparation`
// (spec 2026-11-03 §5.2, §8.1). A follow-up goes out from the owner's Gmail mailbox in the
// initial's thread, as `Re: <initial subject>`, replying to the initial's RFC Message-ID.
import {
  cimProviderUsesGmail,
  getCimProviderDeliveryConfig,
  getConfig,
  validateCimProviderProfileBinding,
} from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import {
  calculateNextCimSlot,
  SUPPORTED_CIM_CADENCE_POLICY_VERSIONS,
} from './cimCampaignPolicy.js';
import { cimRfcMessageId } from './cimMailProvider.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import { normalizeResendTags } from './delivery.js';
import { nextCimTouchKind } from './pursueCimCadence.js';
import { PURSUE_FOLLOW_UP_PAYLOAD_VERSION } from './pursueCimFinalGate.js';
import { PURSUE_CIM_IN_REPLY_TO_TAG } from './pursueCimProvider.js';
import { readUsablePursueSignature } from './pursueEmailSignature.js';
import { PURSUE_CIM_WORDING_TAG, pursueCimWordingDigest, renderPursueCimEmail } from './pursueCimTemplates.js';
import { RFC_MESSAGE_ID } from './rfc5322.js';

const MAX_TAG_LENGTH = 120;
// Broker-materials blockers that mean the materials and recipient state is unknown, so the
// follow-up's stop signals cannot be read.
const UNAVAILABLE_AUTHORITY = new Set(['broker_materials_authority_unavailable',
  'canonical_authority_unavailable']);

function isoInstant(value) {
  const parsed = new Date(value ?? Number.NaN);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid CIM follow-up instant');
  return parsed.toISOString();
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The same recipient fingerprint the campaign was enrolled under and the final gate derives.
function recipientFingerprint(opportunityId, option) {
  if (!option?.email || !option.provenanceFingerprint || !option.contactAuthorityRevision) return '';
  return sha256(stableCanonicalJson({ opportunityId, emailHash: sha256(option.email),
    provenanceFingerprint: option.provenanceFingerprint,
    contactAuthorityRevision: option.contactAuthorityRevision }));
}

function gmailSenderAddress(config) {
  return cimProviderUsesGmail(config)
    ? String(getCimProviderDeliveryConfig(config).delivery?.gmailSenderAddress || '').trim() : '';
}

// The initial's RFC Message-ID the follow-up replies to, or null when there is none.
/**
 * The initial's Message-ID to reply to: the one Gmail actually gave it when that was read back
 * and stored (Gmail may replace ours), else our own `<{transmissionId}@{sender domain}>`.
 */
function initialMessageId(initial) {
  if (!initial?.transmissionId || !initial.subject) return null;
  const stored = typeof initial.messageId === 'string' ? initial.messageId.trim() : '';
  return stored && RFC_MESSAGE_ID.test(stored) ? stored
    : cimRfcMessageId(initial.transmissionId, initial.fromAddress);
}

/**
 * The campaign's stamped cadence, validated the way `deriveAcceptedCimCadence` validates it
 * before scheduling the next touch: same policy, a supported cadence version, a send time, and
 * a derivation bound to the campaign's initial acceptance and expiry. Throws
 * `pursue_follow_up_cadence_unavailable` otherwise.
 */
function followUpCadence({ touch, campaign, timezone }) {
  const unavailable = () => new Error('pursue_follow_up_cadence_unavailable');
  const derivation = jsonObject(campaign?.expiry_derivation);
  const kind = nextCimTouchKind(touch?.kind);
  const same = (left, right) => {
    const a = Date.parse(left ?? '');
    return Number.isFinite(a) && a === Date.parse(right ?? '');
  };
  if (!kind || !timezone?.iana_timezone || !campaign?.local_expiry_at
    || !campaign.initial_accepted_at
    || derivation.policyVersion !== campaign.policy_version
    || !SUPPORTED_CIM_CADENCE_POLICY_VERSIONS.includes(derivation.cadencePolicyVersion)
    || typeof derivation.sendTime !== 'string'
    || !same(derivation.sourceAcceptedAt, campaign.initial_accepted_at)
    || !same(derivation.expiresAt, campaign.local_expiry_at)) throw unavailable();
  return { kind, derivation };
}

/**
 * Reads the authority `runCimFollowUpPreparation` checks before and after its claim. Durable
 * records come from `storage.readCimFollowUpAuthority`; the recipient and the materials state
 * come from the broker-materials authority (`loadMemberAuthority`, the same reader the final
 * gate uses). Returns null (the runner stops with authority_unavailable, before claiming) when
 * the touch does not exist, that authority is unavailable, or anything `buildPayload` would
 * reject is already known: no Gmail sender, no usable Gmail signature snapshot, no accepted
 * initial or no safe Message-ID to reply to, or a campaign cadence that cannot say whether this
 * follow-up is the Final one.
 */
export async function loadPursueFollowUpAuthority({ candidate, storage, now,
  loadMemberAuthority = loadBrokerMaterialsAuthority, config: configOverride } = {}) {
  if (typeof storage?.readCimFollowUpAuthority !== 'function') {
    throw new Error('CIM follow-up authority storage unavailable');
  }
  const at = isoInstant(now);
  const config = configOverride || getConfig();
  if (!gmailSenderAddress(config)) return null;
  if (!(await readUsablePursueSignature({ storage, config }))) return null;
  const durable = await storage.readCimFollowUpAuthority({ touchId: candidate?.touch_id, now: at });
  if (!durable?.touch || !initialMessageId(durable.initial)) return null;
  const ordinal = Number(durable.touch.ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return null;
  try {
    isFinalPursueFollowUp({ authority: durable, now: at });
  } catch {
    return null;
  }
  const opportunityId = durable.touch.opportunity_id;
  let broker;
  try {
    broker = await loadMemberAuthority({ opportunityId, storage, now: new Date(at) });
  } catch {
    return null;
  }
  if (!broker || broker.materialsAuthorityAvailable === false
    || (broker.preparationBlockers ?? []).some((item) => UNAVAILABLE_AUTHORITY.has(item?.code))) {
    return null;
  }
  const address = lower(durable.conversation?.recipient_address);
  const options = (broker.recipientOptions ?? []).filter((option) => lower(option?.email) === address);
  const option = address && options.length === 1 ? options[0] : null;
  const signals = durable.signals ?? {};
  return {
    touch: durable.touch,
    campaign: durable.campaign,
    conversation: durable.conversation,
    opportunity: durable.opportunity,
    crmOwnership: durable.crmOwnership,
    crmSubmission: durable.crmSubmission,
    timezone: durable.timezone,
    activation: durable.activation,
    initial: durable.initial ?? null,
    recipient: {
      address: option?.email ?? '',
      fingerprint: recipientFingerprint(opportunityId, option),
      firstName: option?.firstName ?? '',
      displayName: option?.displayName ?? '',
    },
    terminal: {
      replyReceived: signals.replyReceived === true,
      materialsReceived: broker.materialsState?.materialsReceived === true,
      advancedDiligence: broker.materialsState?.advancedBeyondBrokerOutreach === true,
      suppressed: signals.suppressed === true || Boolean(broker.suppression),
      unsafeDelivery: signals.unsafeDelivery === true,
      providerPending: signals.providerPending === true,
      providerAmbiguous: signals.providerAmbiguous === true,
    },
  };
}

/**
 * True when this follow-up is the campaign's last: the touch after it, scheduled from an
 * acceptance now under the campaign's stamped cadence, would land at or after its expiry.
 */
export function isFinalPursueFollowUp({ authority, now }) {
  const { campaign, timezone } = authority ?? {};
  const { kind, derivation } = followUpCadence(authority ?? {});
  let following;
  try {
    following = calculateNextCimSlot({ policyVersion: campaign.policy_version,
      cadencePolicyVersion: derivation.cadencePolicyVersion, timezone: timezone.iana_timezone,
      kind, priorAcceptedAt: isoInstant(now), priorOutcome: 'accepted',
      expiryAt: isoInstant(campaign.local_expiry_at), sendTime: derivation.sendTime });
  } catch {
    throw new Error('pursue_follow_up_cadence_unavailable');
  }
  return following === null;
}

/**
 * Builds the follow-up message `runCimFollowUpPreparation` prepares: the Pursue follow-up
 * template (variant by ordinal, or Final), from and reply-to the configured Gmail mailbox,
 * to the conversation's recipient, with the initial's RFC Message-ID as the In-Reply-To tag
 * that the Gmail dispatch reads. Throws a coded error when there is nothing to reply to.
 */
export async function buildPursueFollowUpPayload({ authority, now, storage,
  config: configOverride } = {}) {
  // Defensive: loadPursueFollowUpAuthority already returns null for each of these, so the
  // runner stops before claiming the touch.
  const config = configOverride || getConfig();
  if (!cimProviderUsesGmail(config)) throw new Error('pursue_follow_up_requires_gmail');
  const fromAddress = gmailSenderAddress(config);
  const { touch, conversation, opportunity, initial, recipient } = authority ?? {};
  const inReplyTo = initialMessageId(initial);
  if (!inReplyTo) throw new Error('pursue_follow_up_initial_unavailable');
  const toAddress = conversation?.recipient_address ?? '';
  const followUpNumber = Number(touch?.ordinal);
  if (!fromAddress || !toAddress || !Number.isSafeInteger(followUpNumber) || followUpNumber < 1) {
    throw new Error('CIM sender or recipient unavailable');
  }
  // Never prepared unsigned: the stored Gmail signature ends the email.
  const signature = await readUsablePursueSignature({ storage, config });
  if (!signature) throw new Error('signature_incomplete');
  const isFinal = isFinalPursueFollowUp({ authority, now });
  const rendered = renderPursueCimEmail({ kind: 'follow-up', followUpNumber, isFinal,
    deal: { name: opportunity?.canonical_name || '',
      brokerName: recipient?.firstName || recipient?.displayName || '' },
    signature, initialSubject: initial.subject });
  // The Message-ID keeps its `<`, `@` and `>`, so it is added after the Resend-safe tags.
  const tags = [...normalizeResendTags([
    { name: 'cim_conversation_id', value: conversation.id },
    { name: 'cim_touch_id', value: touch.id },
    { name: 'cim_template', value: rendered.templateVersion },
    { name: PURSUE_CIM_WORDING_TAG, value: pursueCimWordingDigest(config.dealHunter?.sender, signature) },
  ]).map(({ name, value }) => `${name}=${value}`), `${PURSUE_CIM_IN_REPLY_TO_TAG}=${inReplyTo}`];
  if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new Error('CIM tag exceeds storage bound');
  }
  const payload = {
    payloadVersion: PURSUE_FOLLOW_UP_PAYLOAD_VERSION,
    fromAddress,
    toAddresses: [toAddress], ccAddresses: [], bccAddresses: [],
    replyToAddress: fromAddress,
    subject: rendered.subject,
    bodyText: rendered.text,
    bodyHtmlSanitized: rendered.html,
    tags,
  };
  const binding = validateCimProviderProfileBinding(config, {
    providerProfile: config.dealHunter?.cimProvider?.profile,
    fromAddress: payload.fromAddress, toAddresses: payload.toAddresses,
    ccAddresses: payload.ccAddresses, bccAddresses: payload.bccAddresses,
    replyToAddress: payload.replyToAddress,
  });
  if (!binding.ok) throw new Error(`CIM provider profile invalid: ${binding.blockers.join(',')}`);
  return { ...payload, inReplyTo, references: [inReplyTo], isFinal, variant: rendered.variant };
}
