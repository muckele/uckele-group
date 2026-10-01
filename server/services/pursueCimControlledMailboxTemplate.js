import {
  CONTROLLED_CIM_LIMITED_SMOKE_PROFILE,
  CONTROLLED_CIM_MAILBOX_PROFILE,
  P10B_LIMITED_SMOKE_RECIPIENT,
  P10B_LIMITED_SMOKE_SENDING_DOMAIN,
} from '../config.js';
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
export const P10B_LIMITED_SMOKE_TEMPLATE_VERSION = 'p10b-limited-free-smoke-test-v1';
export const P10B_LIMITED_SMOKE_SUBJECT = 'P10B limited outbound-only smoke test';
export const P10B_LIMITED_SMOKE_TEXT = [
  'Hello,',
  '',
  'This is a controlled, synthetic outbound-only smoke test for Uckele Group. It is not a request concerning a real business or transaction. No reply is requested or monitored.',
  '',
  'Best,',
  'Uckele Group',
].join('\n');
export const P10B_LIMITED_SMOKE_HTML = '<!doctype html><html><body><p>Hello,</p><p>This is a controlled, synthetic outbound-only smoke test for Uckele Group. It is not a request concerning a real business or transaction. No reply is requested or monitored.</p><p>Best,</p><p>Uckele Group</p></body></html>';

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
  return ['controlled-mailbox', 'controlled-mailbox-limited-smoke'].includes(profile?.mode)
    || profile?.profile === CONTROLLED_CIM_MAILBOX_PROFILE
    || profile?.profile === CONTROLLED_CIM_LIMITED_SMOKE_PROFILE
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
  const limited = profile?.profile === CONTROLLED_CIM_LIMITED_SMOKE_PROFILE;
  const inboundDomain = String(profile?.resendInboundDomain || '').trim().toLowerCase();
  if (config?.isProduction === true || profile?.enabled !== false
    || ![CONTROLLED_CIM_MAILBOX_PROFILE, CONTROLLED_CIM_LIMITED_SMOKE_PROFILE]
      .includes(profile?.profile)
    || !['controlled-mailbox', 'controlled-mailbox-limited-smoke'].includes(profile?.mode)
    || profile?.provider !== 'resend') {
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
  if (limited) {
    const sendingDomain = String(profile?.sendingDomain || '').trim().toLowerCase();
    if (allowed[0] !== P10B_LIMITED_SMOKE_RECIPIENT
      || sendingDomain !== P10B_LIMITED_SMOKE_SENDING_DOMAIN
      || domain(profile.resendFromEmail) !== sendingDomain
      || address(deliveryConfig?.delivery?.resendFromEmail) !== address(profile.resendFromEmail)
      || profile.resendReplyTo || deliveryConfig?.delivery?.resendReplyTo
      || profile.resendInboundDomain || deliveryConfig?.delivery?.resendInboundDomain
      || profile.emailWebhookSecret || deliveryConfig?.delivery?.emailWebhookSecret
      || profile.reconciliationApiKey) {
      throw new Error('P10B limited smoke no-reply envelope is invalid');
    }
    return;
  }
  if (!inboundDomain || domain(profile.resendFromEmail) !== inboundDomain
    || domain(profile.resendReplyTo) !== inboundDomain
    || address(deliveryConfig?.delivery?.resendFromEmail) !== address(profile.resendFromEmail)
    || domain(deliveryConfig?.delivery?.resendReplyTo) !== inboundDomain) {
    throw new Error('P10B controlled mailbox domain is invalid');
  }
}

export function assertP10bControlledMailboxTemplate({ providerProfile, transmission } = {}) {
  if (![CONTROLLED_CIM_MAILBOX_PROFILE, CONTROLLED_CIM_LIMITED_SMOKE_PROFILE]
    .includes(providerProfile)) {
    throw new Error('P10B controlled mailbox profile is invalid');
  }
  const expected = providerProfile === CONTROLLED_CIM_LIMITED_SMOKE_PROFILE
    ? { version: P10B_LIMITED_SMOKE_TEMPLATE_VERSION, subject: P10B_LIMITED_SMOKE_SUBJECT,
      text: P10B_LIMITED_SMOKE_TEXT, html: P10B_LIMITED_SMOKE_HTML }
    : { version: P10B_CONTROLLED_MAILBOX_TEMPLATE_VERSION,
      subject: P10B_CONTROLLED_MAILBOX_SUBJECT, text: P10B_CONTROLLED_MAILBOX_TEXT,
      html: P10B_CONTROLLED_MAILBOX_HTML };
  if (transmission?.payloadVersion !== expected.version
    || transmission?.copy?.subject !== expected.subject
    || transmission?.copy?.text !== expected.text
    || transmission?.copy?.html !== expected.html
    || (providerProfile === CONTROLLED_CIM_LIMITED_SMOKE_PROFILE
      && transmission?.addressing?.replyTo)) {
    throw new Error('P10B controlled mailbox template is invalid');
  }
}

export function isP10bControlledMailboxTemplate({ providerProfile, transmission } = {}) {
  try {
    assertP10bControlledMailboxTemplate({ providerProfile, transmission });
    return true;
  } catch {
    return false;
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
  const limited = config?.dealHunter?.cimProvider?.profile
    === CONTROLLED_CIM_LIMITED_SMOKE_PROFILE;
  const selected = limited
    ? { version: P10B_LIMITED_SMOKE_TEMPLATE_VERSION, subject: P10B_LIMITED_SMOKE_SUBJECT,
      text: P10B_LIMITED_SMOKE_TEXT, html: P10B_LIMITED_SMOKE_HTML }
    : { version: P10B_CONTROLLED_MAILBOX_TEMPLATE_VERSION,
      subject: P10B_CONTROLLED_MAILBOX_SUBJECT, text: P10B_CONTROLLED_MAILBOX_TEXT,
      html: P10B_CONTROLLED_MAILBOX_HTML };
  return {
    templateVersion: selected.version,
    kind: 'deal-hunter-cim-request',
    idempotencyKey: buildCimEmailIdempotencyKey({ requestId: candidate.touch_id }),
    to: recipient.email,
    replyTo: limited ? '' : buildCimReplyToAddress({ requestId: candidate.touch_id,
      replyTo: deliveryConfig.delivery.resendReplyTo }),
    subject: selected.subject,
    headline: selected.subject,
    text: selected.text,
    html: selected.html,
    tags: [
      { name: 'source', value: 'deal-hunter-cim-request' },
      { name: 'deal_key', value: authority.score?.deal_key || '' },
      { name: 'opportunity_id', value: candidate.opportunity_id },
      { name: 'cim_request_id', value: candidate.touch_id },
      { name: 'submission_id', value: candidate.crm_submission_id },
    ],
  };
}
