import { CONTROLLED_CIM_MAILBOX_PROFILE } from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import {
  buildCimEmailIdempotencyKey,
  buildCimReplyToAddress,
} from './delivery.js';

export const P10B_CONTROLLED_MAILBOX_TEMPLATE_VERSION = 'p10b-controlled-mailbox-test-v1';
export const P10B_CONTROLLED_MAILBOX_SUBJECT = 'P10B controlled mailbox lifecycle test';
export const P10B_CONTROLLED_MAILBOX_TEXT = [
  'Hello,',
  '',
  'This is a controlled, synthetic end-to-end mailbox test for Uckele Group. It is not a request concerning a real business or transaction. Please reply so the authorized test can verify inbound routing and reconciliation.',
  '',
  'Best,',
  'Uckele Group',
].join('\n');
export const P10B_CONTROLLED_MAILBOX_HTML = '<!doctype html><html><body><p>Hello,</p><p>This is a controlled, synthetic end-to-end mailbox test for Uckele Group. It is not a request concerning a real business or transaction. Please reply so the authorized test can verify inbound routing and reconciliation.</p><p>Best,</p><p>Uckele Group</p></body></html>';

function address(value) {
  const candidate = String(value || '').trim();
  const match = candidate.match(/^(?:[^<>\r\n,;]+\s)?<([^<>\s@,;]+@[^<>\s@,;]+\.[^<>\s@,;]+)>$/)
    || candidate.match(/^([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)$/);
  return String(match?.[1] || match?.[0] || '').toLowerCase();
}

function domain(value) {
  return address(value).split('@')[1] || '';
}

function metadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function syntheticOpportunityId(runId) {
  if (typeof runId !== 'string' || runId.trim() !== runId
    || runId.length < 1 || runId.length > 120) return '';
  return `p10b-${sha256(stableCanonicalJson({
    type: 'p10b-opportunity-v1', runId,
  })).slice(0, 40)}`;
}

function hasP10bMarker(candidate, authority) {
  return String(candidate?.opportunity_id || '').startsWith('p10b-')
    || authority?.opportunity?.metadata?.p10bSynthetic === true
    || authority?.submission?.metadata?.p10bSynthetic === true
    || authority?.submission?.source === 'p10b-controlled-mailbox'
    || authority?.score?.engine_version === 'p10b-synthetic-v1';
}

export function requiresP10bControlledMailboxTemplate({ candidate, authority, config } = {}) {
  const profile = config?.dealHunter?.cimProvider;
  return profile?.mode === 'controlled-mailbox'
    || profile?.profile === CONTROLLED_CIM_MAILBOX_PROFILE
    || hasP10bMarker(candidate, authority);
}

function assertSyntheticAuthority(candidate, authority) {
  const opportunityId = String(candidate?.opportunity_id || '');
  const opportunityMetadata = metadata(authority?.opportunity?.metadata);
  const submissionMetadata = metadata(authority?.submission?.metadata);
  const exactSynthetic = opportunityId === syntheticOpportunityId(opportunityMetadata.runId)
    && authority?.opportunityId === opportunityId
    && authority?.opportunity?.opportunity_id === opportunityId
    && authority?.opportunity?.identity_version === 'p10b-synthetic-v1'
    && authority?.opportunity?.canonical_name === 'P10B Controlled Mailbox Test'
    && opportunityMetadata.p10bSynthetic === true
    && authority?.submission?.source === 'p10b-controlled-mailbox'
    && submissionMetadata.p10bSynthetic === true
    && authority?.score?.engine_version === 'p10b-synthetic-v1'
    && authority?.score?.rules_version === 'p10b-synthetic-v1'
    && authority?.score?.profile_version === 'p10b-synthetic-v1'
    && authority?.score?.completeness_policy_version === 'p10b-synthetic-v1';
  if (!exactSynthetic) throw new Error('P10B synthetic opportunity authority is required');
}

export function isP10bControlledMailboxSyntheticMember(member) {
  const opportunityId = String(member?.membership?.opportunity_id || '');
  const opportunity = member?.opportunity;
  const submission = member?.crmSubmission;
  const opportunityMetadata = metadata(opportunity?.metadata);
  const submissionMetadata = metadata(submission?.metadata);
  return opportunityId === syntheticOpportunityId(opportunityMetadata.runId)
    && member?.touch?.opportunity_id === opportunityId
    && member?.campaign?.opportunity_id === opportunityId
    && opportunity?.opportunity_id === opportunityId
    && opportunity?.identity_version === 'p10b-synthetic-v1'
    && opportunity?.canonical_name === 'P10B Controlled Mailbox Test'
    && opportunityMetadata.p10bSynthetic === true
    && Boolean(submission?.id)
    && opportunity?.primary_submission_id === submission.id
    && member?.campaign?.crm_submission_id === submission.id
    && member?.crmOwnership?.submission_id === submission.id
    && submission?.deal_hunter_opportunity_id === opportunityId
    && submission?.source === 'p10b-controlled-mailbox'
    && submissionMetadata.p10bSynthetic === true;
}

function assertControlledProfile(config, deliveryConfig, recipient) {
  const profile = config?.dealHunter?.cimProvider;
  const allowed = Array.isArray(profile?.allowedRecipients)
    ? profile.allowedRecipients.map(address).filter(Boolean) : [];
  const inboundDomain = String(profile?.resendInboundDomain || '').trim().toLowerCase();
  if (config?.isProduction === true || profile?.enabled !== false
    || profile?.profile !== CONTROLLED_CIM_MAILBOX_PROFILE
    || profile?.mode !== 'controlled-mailbox' || profile?.provider !== 'resend') {
    throw new Error('P10B controlled mailbox profile is required');
  }
  if (config?.delivery?.resendApiKey || config?.delivery?.resendFromEmail
    || config?.delivery?.resendReplyTo || config?.delivery?.resendInboundDomain
    || config?.delivery?.emailWebhookSecret) {
    throw new Error('P10B production delivery namespace must be unavailable');
  }
  if (allowed.length !== 1 || profile.allowedRecipients.length !== 1
    || address(recipient?.email) !== allowed[0]) {
    throw new Error('P10B controlled mailbox recipient is invalid');
  }
  if (!inboundDomain || domain(profile.resendFromEmail) !== inboundDomain
    || domain(profile.resendReplyTo) !== inboundDomain
    || address(deliveryConfig?.delivery?.resendFromEmail) !== address(profile.resendFromEmail)
    || domain(deliveryConfig?.delivery?.resendReplyTo) !== inboundDomain) {
    throw new Error('P10B controlled mailbox domain is invalid');
  }
}

export function assertP10bControlledMailboxTemplate({ providerProfile, transmission } = {}) {
  if (providerProfile !== CONTROLLED_CIM_MAILBOX_PROFILE) {
    throw new Error('P10B controlled mailbox profile is invalid');
  }
  if (transmission?.payloadVersion !== P10B_CONTROLLED_MAILBOX_TEMPLATE_VERSION
    || transmission?.copy?.subject !== P10B_CONTROLLED_MAILBOX_SUBJECT
    || transmission?.copy?.text !== P10B_CONTROLLED_MAILBOX_TEXT
    || transmission?.copy?.html !== P10B_CONTROLLED_MAILBOX_HTML) {
    throw new Error('P10B controlled mailbox template is invalid');
  }
}

export function buildP10bControlledMailboxTestEmail({
  candidate,
  authority,
  recipient,
  config,
  deliveryConfig,
} = {}) {
  assertSyntheticAuthority(candidate, authority);
  assertControlledProfile(config, deliveryConfig, recipient);
  return {
    templateVersion: P10B_CONTROLLED_MAILBOX_TEMPLATE_VERSION,
    kind: 'deal-hunter-cim-request',
    idempotencyKey: buildCimEmailIdempotencyKey({ requestId: candidate.touch_id }),
    to: recipient.email,
    replyTo: buildCimReplyToAddress({ requestId: candidate.touch_id,
      replyTo: deliveryConfig.delivery.resendReplyTo }),
    subject: P10B_CONTROLLED_MAILBOX_SUBJECT,
    headline: P10B_CONTROLLED_MAILBOX_SUBJECT,
    text: P10B_CONTROLLED_MAILBOX_TEXT,
    html: P10B_CONTROLLED_MAILBOX_HTML,
    tags: [
      { name: 'source', value: 'deal-hunter-cim-request' },
      { name: 'deal_key', value: authority.score?.deal_key || '' },
      { name: 'opportunity_id', value: candidate.opportunity_id },
      { name: 'cim_request_id', value: candidate.touch_id },
      { name: 'submission_id', value: candidate.crm_submission_id },
    ],
  };
}
