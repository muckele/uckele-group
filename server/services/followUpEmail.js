import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { sendPreparedMessage } from './delivery.js';
import { hasVerifiedFollowUpReply } from './emailReadiness.js';

const maxSubjectLength = 300;
const maxBodyLength = 20_000;
const maxHeaderReferences = 20;
const maxReferencesLength = 2_000;
const previewConfirmationTtlMs = 15 * 60 * 1_000;
const requestTokenPattern = /^[A-Za-z0-9_-]{16,200}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const terminalOutboxStates = new Set(['accepted', 'ambiguous', 'permanent_failed', 'cancelled']);

function text(value = '', maxLength = 1_000) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

function compactText(value = '', maxLength = 1_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function extractEmail(value = '') {
  const normalized = compactText(value, 320);
  return (normalized.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]
    || normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    || '').toLowerCase();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function plainTextHtml(value = '') {
  return text(value, maxBodyLength + 2_000)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('');
}

function formatFromAddress(name, email) {
  const safeName = compactText(name, 120).replace(/[<>\r\n]/g, '');
  return safeName ? `${safeName} <${email}>` : email;
}

function subjectRoot(value = '') {
  return compactText(value, maxSubjectLength).replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
}

function normalizeMessageId(value = '') {
  const normalized = compactText(value, 500);
  if (!normalized) return '';
  return normalized.startsWith('<') && normalized.endsWith('>') ? normalized : '';
}

function boundedReferences(values = []) {
  const seen = new Set();
  const references = [];
  for (const value of values.flat()) {
    const normalized = normalizeMessageId(value);
    if (!normalized || seen.has(normalized)) continue;
    if (references.join(' ').length + normalized.length + 1 > maxReferencesLength) break;
    seen.add(normalized);
    references.push(normalized);
    if (references.length >= maxHeaderReferences) break;
  }
  return references;
}

function configuredFooter(config) {
  const company = compactText(config.brand?.companyName || config.followUp?.senderName || 'Uckele Group', 160);
  const address = compactText(config.followUp?.physicalPostalAddress, 320);
  const optOut = config.followUp?.optOutBaseUrl
    ? `To stop acquisition outreach, use ${compactText(config.followUp.optOutBaseUrl, 1_000)}`
    : 'To stop acquisition outreach, reply with “unsubscribe” or “stop”.';
  return [company, address, optOut].filter(Boolean).join('\n');
}

export function buildFollowUpEmailContent({ bodyText = '', config = getConfig() } = {}) {
  const body = text(bodyText, maxBodyLength);
  const footer = configuredFooter(config);
  const finalText = `${body}\n\n--\n${footer}`;
  return {
    bodyText: finalText,
    bodyHtmlSanitized: plainTextHtml(finalText),
    complianceFooter: footer,
  };
}

function configuredAddress(value) {
  const address = extractEmail(value);
  return emailPattern.test(address) ? address : '';
}

export function getFollowUpEmailReadiness(config = getConfig()) {
  const blockers = [];
  if (!config.followUp?.emailEnabled) blockers.push('disabled');
  if (config.delivery?.provider !== 'resend') blockers.push('provider');
  if (!config.delivery?.resendApiKey) blockers.push('provider-credentials');
  const sender = configuredAddress(config.followUp?.senderEmail);
  const providerSender = configuredAddress(config.delivery?.resendFromEmail);
  const replyTo = configuredAddress(config.followUp?.replyTo);
  const providerReplyTo = configuredAddress(config.delivery?.resendReplyTo);
  const inboundDomain = compactText(config.delivery?.resendInboundDomain, 255).toLowerCase().replace(/^@/, '');
  if (!sender) blockers.push('sender');
  if (!replyTo) blockers.push('reply-to');
  if (sender && providerSender && sender !== providerSender) blockers.push('sender-alignment');
  if (replyTo && providerReplyTo && replyTo !== providerReplyTo) blockers.push('reply-to-alignment');
  if (replyTo && inboundDomain && replyTo.split('@')[1] !== inboundDomain) blockers.push('reply-domain-alignment');
  if (!config.delivery?.emailWebhookSecret) blockers.push('webhook');
  if (!compactText(config.delivery?.resendInboundDomain, 255)) blockers.push('receiving-domain');
  if (!compactText(config.followUp?.physicalPostalAddress, 320)) blockers.push('postal-address');
  if (!config.followUp?.replyOptOutEnabled && !compactText(config.followUp?.optOutBaseUrl, 1_000)) blockers.push('opt-out');
  if (config.followUp?.requireSignedPreview !== false && String(config.admin?.sessionSecret || '').length < 16) blockers.push('preview-signing');
  return {
    enabled: Boolean(config.followUp?.emailEnabled),
    ready: blockers.length === 0,
    blockers,
  };
}

function contactEmails(submission = {}) {
  return Array.from(new Set([
    submission.email,
    submission.broker_email,
    submission.seller_email,
    ...(Array.isArray(submission.contact_emails) ? submission.contact_emails : []),
  ].map(extractEmail).filter(Boolean)));
}

function localClockParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function insideSendWindow(now, config) {
  const parts = localClockParts(now, config.followUp.timezone);
  if (config.followUp.weekdaysOnly && ['Sat', 'Sun'].includes(parts.weekday)) return false;
  const current = `${parts.hour}:${parts.minute}`;
  return current >= config.followUp.sendWindowStart && current <= config.followUp.sendWindowEnd;
}

function safeErrorMessage(category) {
  const messages = {
    ambiguous: 'The provider result is ambiguous. Do not submit another email; review this command for reconciliation.',
    retryable: 'The provider temporarily rejected the command. Retry only the existing outbox item.',
    permanent: 'The provider rejected this email. The failed immutable copy remains in the CRM audit history.',
  };
  return messages[category] || messages.permanent;
}

function classifyProviderFailure(error = '') {
  const normalized = String(error || '').toLowerCase();
  if (/timed out|timeout|aborted|socket|network|connection reset|fetch failed/.test(normalized)) return 'ambiguous';
  if (/\b429\b|\b5\d\d\b|temporar|rate limit|unavailable/.test(normalized)) return 'retryable';
  return 'permanent';
}

function policyFailure(status, code, error, details = {}) {
  return { ok: false, status, code, error, ...details };
}

function normalizedNextFollowUpState(input = {}) {
  return ['needs-response', 'scheduled', 'waiting-on-owner', 'completed'].includes(input.nextFollowUpState)
    ? input.nextFollowUpState
    : 'waiting-on-owner';
}

function normalizedNextActionAt(input = {}) {
  return input.nextActionAt && Number.isFinite(Date.parse(input.nextActionAt))
    ? new Date(input.nextActionAt).toISOString()
    : null;
}

function previewConfirmationPayload({ submission, preview, input, actor }) {
  return JSON.stringify({
    version: 'crm-follow-up-preview-v1',
    submissionId: submission.id,
    expectedSubmissionVersion: submission.updated_at,
    actor: compactText(actor, 160),
    confirmationExpiresAt: preview.confirmationExpiresAt,
    from: preview.from,
    to: preview.to,
    replyTo: preview.replyTo,
    subject: preview.subject,
    bodyText: preview.bodyText,
    bodyHtmlSanitized: preview.bodyHtmlSanitized,
    headers: preview.headers,
    parentCommunicationId: preview.parentCommunicationId,
    threadKey: preview.threadKey,
    latestCommunicationId: preview.latestCommunicationId,
    latestCommunicationUpdatedAt: preview.latestCommunicationUpdatedAt,
    recipientOverride: preview.recipientOverride,
    nextFollowUpState: normalizedNextFollowUpState(input),
    nextActionAt: normalizedNextActionAt(input),
    recommendationId: compactText(input.recommendationId, 160) || null,
    cimRequestId: compactText(input.cimRequestId, 160) || null,
    dealKey: compactText(input.dealKey, 500) || null,
    manualTakeoverAcknowledged: input.manualTakeoverAcknowledged === true,
  });
}

function signPreviewConfirmation({ submission, preview, input, actor, config }) {
  const secret = String(config.admin?.sessionSecret || '');
  if (!secret) return '';
  return createHmac('sha256', secret)
    .update(previewConfirmationPayload({ submission, preview, input, actor }))
    .digest('base64url');
}

function previewConfirmationMatches(provided, expected) {
  const left = Buffer.from(String(provided || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function loadReplyContext({ storage, submission, recipient, parentCommunicationId }) {
  if (!parentCommunicationId) return { parent: null, subject: '', inReplyTo: '', references: [], threadKey: '' };
  const parent = await storage.getCrmCommunication(compactText(parentCommunicationId, 160));
  if (!parent || parent.submission_id !== submission.id || parent.channel !== 'email') {
    return policyFailure(422, 'invalid-thread-parent', 'The selected reply parent does not belong to this CRM email thread.');
  }
  const participants = new Set([
    extractEmail(parent.from_address),
    ...(parent.to_addresses || []).map(extractEmail),
    ...(parent.cc_addresses || []).map(extractEmail),
  ].filter(Boolean));
  if (!participants.has(recipient)) {
    return policyFailure(422, 'recipient-thread-mismatch', 'The recipient is not a participant in the selected email thread.');
  }
  const inReplyTo = normalizeMessageId(parent.message_id);
  if (!inReplyTo) {
    return policyFailure(422, 'threading-unavailable', 'This message has no verified RFC Message-ID, so a real threaded reply cannot be guaranteed. Compose a new message instead.');
  }
  const references = boundedReferences([parent.references_json || [], parent.in_reply_to || '', inReplyTo]);
  const root = subjectRoot(parent.subject);
  if (!root) return policyFailure(422, 'thread-subject-unavailable', 'The selected thread has no usable subject.');
  return {
    parent,
    subject: `Re: ${root}`,
    inReplyTo,
    references,
    threadKey: parent.thread_key || `${submission.id}:${recipient}`,
  };
}

export async function previewCrmFollowUpEmail({
  submissionId = '', actor = 'admin', input = {}, storage = getStorage(), config = getConfig(), now = new Date(),
} = {}) {
  const readiness = getFollowUpEmailReadiness(config);
  if (!readiness.ready) {
    return policyFailure(readiness.enabled ? 503 : 422, readiness.enabled ? 'email-unready' : 'email-disabled',
      readiness.enabled ? 'CRM follow-up email is not operationally ready.' : 'CRM follow-up email is disabled.', { readiness });
  }
  if (typeof storage.getActiveEmailSuppression !== 'function'
    || typeof storage.countCrmFollowUpSends !== 'function'
    || typeof storage.listCrmEmailOutbox !== 'function') {
    return policyFailure(503, 'suppression-readiness-unavailable', 'The global suppression and cap controls are unavailable. CRM follow-up email remains blocked.');
  }
  if (config.followUp?.requireVerifiedReply) {
    if (typeof storage.listEmailEvents !== 'function') {
      return policyFailure(503, 'reply-readiness-unavailable', 'Inbound reply readiness could not be verified. CRM follow-up email remains blocked.');
    }
    let readinessEvents;
    try {
      readinessEvents = await storage.listEmailEvents({ limit: 500 });
    } catch {
      return policyFailure(503, 'reply-readiness-unavailable', 'Inbound reply readiness could not be verified. CRM follow-up email remains blocked.');
    }
    if (!hasVerifiedFollowUpReply(readinessEvents)) {
      return policyFailure(503, 'reply-tracking-unverified', 'Complete the controlled inbound reply test before enabling CRM follow-up email.');
    }
  }
  const submission = await storage.getSubmission(compactText(submissionId, 160));
  if (!submission) return policyFailure(404, 'submission-not-found', 'CRM record not found.');
  if (['archived', 'spam'].includes(String(submission.status || '').toLowerCase())) {
    return policyFailure(422, `submission-${submission.status}`, 'Archived or spam CRM records cannot receive follow-up email.');
  }
  if (submission.follow_up_state === 'completed') {
    return policyFailure(422, 'follow-up-completed', 'Completed follow-ups must be reopened before sending email.');
  }
  const expectedVersion = compactText(input.expectedSubmissionVersion || input.expected_updated_at, 80);
  if (!expectedVersion || expectedVersion !== submission.updated_at) {
    return policyFailure(409, 'stale-submission', 'The CRM record changed. Refresh before confirming this email.', { submission });
  }
  if (!insideSendWindow(now, config)) {
    return policyFailure(422, 'outside-send-window', 'The configured CRM follow-up send window is currently closed.');
  }

  const recipient = extractEmail(input.recipient || input.to);
  if (!emailPattern.test(recipient)) return policyFailure(422, 'invalid-recipient', 'A valid single recipient is required.');
  if ((input.cc && String(input.cc).trim()) || (input.bcc && String(input.bcc).trim())) {
    return policyFailure(422, 'hidden-recipients-not-supported', 'CRM follow-up email supports one visible recipient and no CC or BCC in version one.');
  }
  const parentCommunicationId = compactText(input.parentCommunicationId, 160);
  const replyContext = await loadReplyContext({ storage, submission, recipient, parentCommunicationId });
  if (replyContext.ok === false) return replyContext;
  const knownContacts = contactEmails(submission);
  const latestSafeInboundSender = replyContext.parent?.direction === 'inbound'
    ? extractEmail(replyContext.parent.from_address)
    : '';
  const recipientIsKnown = knownContacts.includes(recipient) || latestSafeInboundSender === recipient;
  if (!recipientIsKnown && !(input.confirmRecipientOverride === true && compactText(input.recipientOverrideReason, 500))) {
    return policyFailure(422, 'recipient-override-required', 'This address is not a validated CRM contact. Confirm and explain the audited recipient correction before sending.');
  }

  const suppression = await storage.getActiveEmailSuppression?.(recipient);
  if (suppression) {
    return policyFailure(422, 'recipient-suppressed', 'This address is globally suppressed from outreach.', {
      suppression: { reason: suppression.reason, created_at: suppression.created_at },
    });
  }
  const recentCommunications = await storage.listCrmCommunications({ submissionId: submission.id, page: 1, pageSize: 100 });
  const unresolvedDeliveryIssue = (recentCommunications.rows || []).find((communication) => {
    const acceptedAt = Date.parse(communication.delivery_state_at || communication.occurred_at || '');
    const acceptanceOverdue = communication.delivery_state === 'accepted'
      && Number.isFinite(acceptedAt)
      && now.getTime() - acceptedAt >= 24 * 60 * 60 * 1_000;
    return communication.direction === 'outbound'
      && (communication.to_addresses || []).map(extractEmail).includes(recipient)
      && (acceptanceOverdue || ['delayed', 'bounced', 'failed', 'complained', 'suppressed'].includes(communication.delivery_state));
  });
  if (unresolvedDeliveryIssue) {
    return policyFailure(422, 'delivery-risk', 'Resolve the latest delivery problem before emailing this address again.', {
      communicationId: unresolvedDeliveryIssue.id,
      deliveryState: unresolvedDeliveryIssue.delivery_state,
    });
  }

  const activeCommands = await storage.listCrmEmailOutbox({
    submissionId: submission.id,
    states: ['queued', 'sending', 'ambiguous', 'retryable_failed'],
    limit: 100,
  });
  if (activeCommands.length > 0) {
    return policyFailure(409, 'existing-email-command', 'Reconcile the existing queued, retryable, sending, or ambiguous email command before creating another one.', {
      outbox: { id: activeCommands[0].id, state: activeCommands[0].state },
    });
  }

  const dailySince = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const recipientSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
  const [dailyCount, recipientCount, touchCount] = await Promise.all([
    storage.countCrmFollowUpSends?.({ since: dailySince }) || 0,
    storage.countCrmFollowUpSends?.({ recipient, since: recipientSince }) || 0,
    storage.countCrmFollowUpSends?.({ recipient }) || 0,
  ]);
  if (dailyCount >= config.followUp.dailyCap) {
    return policyFailure(422, 'daily-cap', 'The CRM follow-up daily cap has been reached.');
  }
  if (recipientCount >= config.followUp.recipientRollingCap) {
    return policyFailure(422, 'recipient-cap', 'The rolling cap for this recipient has been reached.');
  }
  if (!replyContext.parent && touchCount >= (config.followUp.maxTouches || 3)) {
    return policyFailure(422, 'maximum-follow-up-touches-reached', 'The configured maximum number of follow-up touches has been reached.');
  }
  const latestPriorFollowUp = (recentCommunications.rows || []).find((communication) =>
    communication.direction === 'outbound'
    && communication.kind === 'crm-follow-up'
    && (communication.to_addresses || []).map(extractEmail).includes(recipient)
    && !['failed', 'bounced', 'complained', 'suppressed', 'not-attempted'].includes(communication.delivery_state));
  if (!replyContext.parent && latestPriorFollowUp) {
    const cadence = Array.isArray(config.followUp.cadenceHours) && config.followUp.cadenceHours.length > 0
      ? config.followUp.cadenceHours
      : [48, 72, 96];
    const requiredHours = Number(cadence[Math.min(Math.max(0, touchCount - 1), cadence.length - 1)] || cadence.at(-1) || 48);
    const latestAt = Date.parse(latestPriorFollowUp.occurred_at || latestPriorFollowUp.created_at || '');
    const nextAllowedAt = Number.isFinite(latestAt) ? latestAt + requiredHours * 60 * 60 * 1_000 : 0;
    if (nextAllowedAt > now.getTime()) {
      return policyFailure(422, 'follow-up-cadence', 'The configured recipient cadence has not elapsed.', {
        nextAllowedAt: new Date(nextAllowedAt).toISOString(),
      });
    }
  }

  const requestedSubject = compactText(input.subject, maxSubjectLength);
  if (!replyContext.parent && /^(?:re|fw|fwd)\s*:/i.test(requestedSubject)) {
    return policyFailure(422, 'deceptive-subject-prefix', 'A new email cannot use a reply or forward subject prefix.');
  }
  const subject = replyContext.parent ? replyContext.subject : requestedSubject;
  if (!subject) return policyFailure(422, 'missing-subject', 'An email subject is required.');
  const rawBody = text(input.bodyText || input.body, maxBodyLength);
  if (!rawBody) return policyFailure(422, 'missing-body', 'An email body is required.');
  if (String(input.bodyText || input.body || '').length > maxBodyLength) {
    return policyFailure(422, 'body-too-long', `The email body must be ${maxBodyLength.toLocaleString()} characters or fewer.`);
  }
  const content = buildFollowUpEmailContent({ bodyText: rawBody, config });
  const senderEmail = configuredAddress(config.followUp.senderEmail);
  const replyTo = configuredAddress(config.followUp.replyTo);
  const headers = replyContext.parent
    ? { 'In-Reply-To': replyContext.inReplyTo, References: replyContext.references.join(' ') }
    : {};
  const preview = {
    from: formatFromAddress(config.followUp.senderName, senderEmail),
    to: recipient,
    replyTo,
    subject,
    bodyText: content.bodyText,
    bodyHtmlSanitized: content.bodyHtmlSanitized,
    headers,
    references: replyContext.references,
    inReplyTo: replyContext.inReplyTo || null,
    parentCommunicationId: replyContext.parent?.id || null,
    threadKey: replyContext.threadKey || `${submission.id}:${recipient}`,
    latestCommunicationId: recentCommunications.rows?.[0]?.id || null,
    latestCommunicationUpdatedAt: recentCommunications.rows?.[0]?.updated_at || null,
    recipientOverride: recipientIsKnown ? null : {
      confirmed: true,
      reason: compactText(input.recipientOverrideReason, 500),
    },
    complianceFooter: content.complianceFooter,
  };
  if (config.followUp?.requireSignedPreview !== false) {
    const providedExpiry = Date.parse(input.previewConfirmationExpiresAt || '');
    if (input.previewConfirmationExpiresAt && !Number.isFinite(providedExpiry)) {
      return policyFailure(422, 'preview-confirmation-invalid', 'The exact-preview confirmation expiry is invalid. Preview the email again.');
    }
    const expiresAt = Number.isFinite(providedExpiry)
      ? providedExpiry
      : now.getTime() + previewConfirmationTtlMs;
    if (expiresAt <= now.getTime()) {
      return policyFailure(422, 'preview-confirmation-expired', 'The exact email preview expired. Preview and review it again.');
    }
    if (expiresAt > now.getTime() + previewConfirmationTtlMs + 1_000) {
      return policyFailure(422, 'preview-confirmation-invalid', 'The exact-preview confirmation expiry is outside the allowed window.');
    }
    preview.confirmationExpiresAt = new Date(expiresAt).toISOString();
  } else {
    preview.confirmationExpiresAt = null;
  }
  preview.confirmationToken = config.followUp?.requireSignedPreview === false
    ? ''
    : signPreviewConfirmation({ submission, preview, input, actor, config });
  return {
    ok: true,
    status: 200,
    submission,
    preview,
    readiness,
  };
}

function sameInstant(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

async function revalidateClaimedOutbox({ outbox, communication, storage, config, now }) {
  const readiness = getFollowUpEmailReadiness(config);
  if (!readiness.ready) {
    return policyFailure(readiness.enabled ? 503 : 422, readiness.enabled ? 'email-unready' : 'email-disabled',
      readiness.enabled ? 'CRM follow-up email is no longer operationally ready.' : 'CRM follow-up email was disabled before provider transmission.');
  }
  if (typeof storage.getActiveEmailSuppression !== 'function'
    || typeof storage.countCrmFollowUpSends !== 'function'
    || typeof storage.listCrmEmailOutbox !== 'function') {
    return policyFailure(503, 'suppression-readiness-unavailable', 'The global suppression and cap controls became unavailable before provider transmission.');
  }
  if (config.followUp?.requireVerifiedReply) {
    if (typeof storage.listEmailEvents !== 'function') {
      return policyFailure(503, 'reply-readiness-unavailable', 'Inbound reply readiness could not be verified before provider transmission.');
    }
    try {
      const events = await storage.listEmailEvents({ limit: 500 });
      if (!hasVerifiedFollowUpReply(events || [])) {
        return policyFailure(503, 'reply-tracking-unverified', 'Inbound reply readiness is no longer verified.');
      }
    } catch {
      return policyFailure(503, 'reply-readiness-unavailable', 'Inbound reply readiness could not be verified before provider transmission.');
    }
  }
  const submission = await storage.getSubmission(outbox.submission_id);
  if (!submission) return policyFailure(404, 'submission-not-found', 'The CRM record no longer exists.');
  const status = String(submission.status || '').toLowerCase();
  if (['archived', 'spam'].includes(status)) {
    return policyFailure(422, `submission-${status}`, 'The CRM record became archived or spam before provider transmission.');
  }
  if (submission.follow_up_state === 'completed') {
    return policyFailure(422, 'follow-up-completed', 'The follow-up was completed before provider transmission.');
  }
  if (!sameInstant(submission.updated_at, outbox.created_at)) {
    return policyFailure(409, 'stale-submission', 'The CRM record changed after confirmation and before provider transmission.', { submission });
  }
  if (!insideSendWindow(now, config)) {
    return policyFailure(422, 'outside-send-window', 'The configured CRM follow-up send window closed before provider transmission.');
  }

  const recipient = extractEmail(communication.to_addresses?.[0]);
  if (!emailPattern.test(recipient) || communication.to_addresses?.length !== 1
    || communication.cc_addresses?.length || communication.bcc_addresses?.length) {
    return policyFailure(422, 'invalid-recipient', 'The immutable email command no longer satisfies the one-recipient policy.');
  }
  const suppression = await storage.getActiveEmailSuppression(recipient);
  if (suppression) {
    return policyFailure(422, 'recipient-suppressed', 'This address became globally suppressed before provider transmission.', {
      suppression: { reason: suppression.reason, created_at: suppression.created_at },
    });
  }

  const [communications, activeCommands] = await Promise.all([
    storage.listCrmCommunications({ submissionId: submission.id, page: 1, pageSize: 100 }),
    storage.listCrmEmailOutbox({
      submissionId: submission.id,
      states: ['queued', 'sending', 'ambiguous', 'retryable_failed'],
      limit: 100,
    }),
  ]);
  const otherActiveCommand = activeCommands.find((candidate) => candidate.id !== outbox.id);
  if (otherActiveCommand) {
    return policyFailure(409, 'existing-email-command', 'Another unresolved email command now exists for this CRM record.', {
      outbox: { id: otherActiveCommand.id, state: otherActiveCommand.state },
    });
  }
  const priorCommunications = (communications.rows || []).filter((candidate) => candidate.id !== communication.id);
  const reviewedLatestId = outbox.metadata?.reviewedLatestCommunicationId || null;
  const reviewedLatestUpdatedAt = outbox.metadata?.reviewedLatestCommunicationUpdatedAt || null;
  const currentLatest = priorCommunications[0] || null;
  if ((currentLatest?.id || null) !== reviewedLatestId
    || (currentLatest && reviewedLatestUpdatedAt && !sameInstant(currentLatest.updated_at, reviewedLatestUpdatedAt))) {
    return policyFailure(409, 'conversation-changed', 'The email conversation changed after preview. Review the current chronology and create a new command.');
  }
  const unresolvedDeliveryIssue = priorCommunications.find((candidate) => {
    const acceptedAt = Date.parse(candidate.delivery_state_at || candidate.occurred_at || '');
    const acceptanceOverdue = candidate.delivery_state === 'accepted'
      && Number.isFinite(acceptedAt)
      && now.getTime() - acceptedAt >= 24 * 60 * 60 * 1_000;
    return candidate.direction === 'outbound'
      && (candidate.to_addresses || []).map(extractEmail).includes(recipient)
      && (acceptanceOverdue || ['delayed', 'bounced', 'failed', 'complained', 'suppressed'].includes(candidate.delivery_state));
  });
  if (unresolvedDeliveryIssue) {
    return policyFailure(422, 'delivery-risk', 'A delivery problem appeared before provider transmission.', {
      communicationId: unresolvedDeliveryIssue.id,
      deliveryState: unresolvedDeliveryIssue.delivery_state,
    });
  }

  const dailySince = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const recipientSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
  const [dailyCount, recipientCount, touchCount] = await Promise.all([
    storage.countCrmFollowUpSends({ since: dailySince }),
    storage.countCrmFollowUpSends({ recipient, since: recipientSince }),
    storage.countCrmFollowUpSends({ recipient }),
  ]);
  if (dailyCount > config.followUp.dailyCap) {
    return policyFailure(422, 'daily-cap', 'The CRM follow-up daily cap was exceeded before provider transmission.');
  }
  if (recipientCount > config.followUp.recipientRollingCap) {
    return policyFailure(422, 'recipient-cap', 'The rolling recipient cap was exceeded before provider transmission.');
  }
  if (!communication.parent_communication_id && touchCount > (config.followUp.maxTouches || 3)) {
    return policyFailure(422, 'maximum-follow-up-touches-reached', 'The maximum follow-up touch count was exceeded before provider transmission.');
  }
  if (!communication.parent_communication_id) {
    const latestPriorFollowUp = priorCommunications.find((candidate) =>
      candidate.direction === 'outbound'
      && candidate.kind === 'crm-follow-up'
      && (candidate.to_addresses || []).map(extractEmail).includes(recipient)
      && !['failed', 'bounced', 'complained', 'suppressed', 'not-attempted'].includes(candidate.delivery_state));
    if (latestPriorFollowUp) {
      const cadence = Array.isArray(config.followUp.cadenceHours) && config.followUp.cadenceHours.length > 0
        ? config.followUp.cadenceHours
        : [48, 72, 96];
      const priorTouchCount = Math.max(0, touchCount - 1);
      const requiredHours = Number(cadence[Math.min(Math.max(0, priorTouchCount - 1), cadence.length - 1)] || cadence.at(-1) || 48);
      const latestAt = Date.parse(latestPriorFollowUp.occurred_at || latestPriorFollowUp.created_at || '');
      if (Number.isFinite(latestAt) && latestAt + requiredHours * 60 * 60 * 1_000 > now.getTime()) {
        return policyFailure(422, 'follow-up-cadence', 'The configured recipient cadence no longer permits provider transmission.');
      }
    }
  }
  return { ok: true, submission };
}

async function cancelClaimForPolicy({ storage, outbox, claimToken, communication, policy, now }) {
  const cancelledAt = now.toISOString();
  const cancelled = await storage.finishCrmEmailOutboxClaim(outbox.id, claimToken, {
    state: 'cancelled',
    failed_at: cancelledAt,
    last_error_category: 'policy',
    last_error_message: policy.error,
    updated_at: cancelledAt,
    metadata: {
      ...(outbox.metadata || {}),
      providerAccepted: false,
      cancellationCode: policy.code,
    },
  });
  const current = cancelled || await storage.getCrmEmailOutbox(outbox.id);
  try {
    await storage.insertCrmActivityEvent?.({
      id: randomUUID(), submission_id: outbox.submission_id, created_at: cancelledAt,
      actor: outbox.actor, role: 'admin', event_type: 'follow-up.email.cancelled',
      summary: 'CRM follow-up email cancelled by a pre-transmission safety check.',
      metadata: { communicationId: communication.id, outboxId: outbox.id, reason: policy.code },
    });
  } catch {
    // The immutable queued activity and cancelled outbox remain authoritative.
  }
  return { ...policy, outbox: current, communication, providerAccepted: false };
}

export async function processCrmEmailOutbox({
  outboxId = '', storage = getStorage(), sender = sendPreparedMessage, config = getConfig(), now = new Date(),
} = {}) {
  let outbox = await storage.getCrmEmailOutbox(outboxId);
  if (!outbox) return policyFailure(404, 'outbox-not-found', 'CRM email command not found.');
  const communication = await storage.getCrmCommunication(outbox.communication_id);
  if (!communication) return policyFailure(503, 'communication-missing', 'The immutable CRM email copy is unavailable.');
  if (terminalOutboxStates.has(outbox.state)) {
    return { ok: outbox.state === 'accepted', status: 200, replayed: true, outbox, communication };
  }

  const claimToken = randomUUID();
  const claimedAt = now.toISOString();
  const claim = await storage.claimCrmEmailOutbox({
    id: outbox.id,
    claimToken,
    claimedAt,
    claimExpiresAt: new Date(now.getTime() + 5 * 60 * 1_000).toISOString(),
  });
  if (!claim.claimed) {
    return policyFailure(409, 'outbox-in-progress', 'This email command is already being processed.', { outbox: claim.outbox });
  }
  outbox = claim.outbox;
  const policy = await revalidateClaimedOutbox({ outbox, communication, storage, config, now });
  if (!policy.ok) {
    return cancelClaimForPolicy({ storage, outbox, claimToken, communication, policy, now });
  }
  const prepared = {
    kind: 'crm-follow-up',
    communicationId: communication.id,
    idempotencyKey: outbox.idempotency_key,
    from: communication.from_address,
    to: communication.to_addresses,
    replyTo: communication.reply_to_address,
    subject: communication.subject,
    text: communication.body_text,
    html: communication.body_html_sanitized,
    headers: communication.headers_json,
    tags: [
      { name: 'submission_id', value: communication.submission_id },
      { name: 'communication_id', value: communication.id },
      ...(communication.cim_request_id ? [{ name: 'cim_request_id', value: communication.cim_request_id }] : []),
    ],
    tracking: {
      submissionId: communication.submission_id,
      communicationId: communication.id,
      cimRequestId: communication.cim_request_id || '',
    },
  };

  let providerResult;
  let thrownError = '';
  try {
    providerResult = await sender(prepared);
  } catch (error) {
    thrownError = error?.message || 'Provider request failed.';
    providerResult = { status: 'failed', error: thrownError, providerMessageId: '' };
  }
  const completedAt = new Date().toISOString();
  if (providerResult?.status === 'sent') {
    const acceptedOutbox = await storage.finishCrmEmailOutboxClaim(outbox.id, claimToken, {
      state: 'accepted',
      provider: 'resend',
      provider_message_id: compactText(providerResult.providerMessageId, 240) || null,
      accepted_at: completedAt,
      updated_at: completedAt,
      last_error_category: null,
      last_error_message: null,
      metadata: { ...(outbox.metadata || {}), providerAccepted: true },
    });
    if (!acceptedOutbox) {
      const currentOutbox = await storage.getCrmEmailOutbox(outbox.id);
      if (currentOutbox?.state === 'accepted') {
        return { ok: true, status: 200, replayed: true, outbox: currentOutbox, communication, providerAccepted: true };
      }
      return policyFailure(202, 'outbox-claim-lost', 'Provider acceptance needs reconciliation because this worker lost its durable claim.', {
        outbox: currentOutbox,
        communication,
        providerAccepted: true,
      });
    }
    outbox = acceptedOutbox;
    let updatedCommunication = communication;
    let reconciliationRequired = false;
    try {
      updatedCommunication = await storage.updateCrmCommunication(communication.id, {
        provider: 'resend',
        provider_message_id: compactText(providerResult.providerMessageId, 240) || null,
        delivery_state: 'accepted',
        delivery_state_at: completedAt,
        updated_at: completedAt,
        updated_by: 'follow-up-outbox',
      });
    } catch {
      reconciliationRequired = true;
    }
    let submission = null;
    if (storage.updateSubmissionIfCurrent) {
      submission = await storage.updateSubmissionIfCurrent(outbox.submission_id, outbox.created_at, {
        updated_at: completedAt,
        follow_up_state: outbox.intended_follow_up_state || 'waiting-on-owner',
        next_action_at: outbox.intended_next_action_at || null,
        last_contacted_at: completedAt,
      });
    }
    await storage.supersedeCrmFollowUpRecommendations?.(outbox.submission_id, completedAt);
    try {
      await storage.insertCrmActivityEvent?.({
        id: randomUUID(), submission_id: outbox.submission_id, created_at: completedAt,
        actor: outbox.actor, role: 'admin', event_type: 'follow-up.email.accepted',
        summary: 'CRM follow-up email accepted by the provider.',
        metadata: { communicationId: communication.id, outboxId: outbox.id, workflowTransitionApplied: Boolean(submission) },
      });
    } catch {
      // The immutable queued audit entry and accepted outbox remain authoritative.
    }
    return {
      ok: true,
      status: 200,
      outbox,
      communication: updatedCommunication,
      submission,
      providerAccepted: true,
      reconciliationRequired,
    };
  }

  const failureCategory = classifyProviderFailure(thrownError || providerResult?.error);
  const state = failureCategory === 'ambiguous'
    ? 'ambiguous'
    : failureCategory === 'retryable'
      ? 'retryable_failed'
      : 'permanent_failed';
  const failedOutbox = await storage.finishCrmEmailOutboxClaim(outbox.id, claimToken, {
    state,
    ...(state === 'ambiguous' ? { ambiguous_at: completedAt } : { failed_at: completedAt }),
    ...(state === 'retryable_failed' ? { next_attempt_at: new Date(Date.parse(completedAt) + 15 * 60 * 1_000).toISOString() } : {}),
    last_error_category: failureCategory,
    last_error_message: safeErrorMessage(failureCategory),
    updated_at: completedAt,
    metadata: { ...(outbox.metadata || {}), providerAccepted: false },
  });
  if (!failedOutbox) {
    const currentOutbox = await storage.getCrmEmailOutbox(outbox.id);
    return policyFailure(409, 'outbox-claim-lost', 'This worker lost its durable claim while recording the provider failure.', {
      outbox: currentOutbox,
      communication,
      providerAccepted: false,
    });
  }
  outbox = failedOutbox;
  let updatedCommunication = communication;
  if (state !== 'ambiguous') {
    updatedCommunication = await storage.updateCrmCommunication(communication.id, {
      delivery_state: 'failed',
      delivery_state_at: completedAt,
      updated_at: completedAt,
      updated_by: 'follow-up-outbox',
    });
  }
  return policyFailure(state === 'ambiguous' ? 202 : 502, `provider-${failureCategory}`, safeErrorMessage(failureCategory), {
    outbox,
    communication: updatedCommunication,
    providerAccepted: false,
  });
}

export async function sendCrmFollowUpEmail({
  submissionId = '', actor = 'admin', input = {}, storage = getStorage(), sender = sendPreparedMessage,
  config = getConfig(), now = new Date(), processImmediately = true,
} = {}) {
  const clientToken = compactText(input.clientRequestToken || input.client_request_token, 200);
  if (!requestTokenPattern.test(clientToken)) {
    return policyFailure(422, 'invalid-client-token', 'A unique 16–200 character confirmation token is required.');
  }
  const scopedSubmissionId = compactText(submissionId, 160);
  const scopedActor = compactText(actor, 160);
  const existingCommand = await storage.getCrmEmailOutboxByClientRequestKey?.(
    `${scopedSubmissionId}:${scopedActor}:${clientToken}`,
  );
  if (existingCommand) {
    if (!processImmediately) {
      return {
        ok: true,
        status: 202,
        queued: !terminalOutboxStates.has(existingCommand.state),
        replayed: true,
        outbox: existingCommand,
        communication: await storage.getCrmCommunication(existingCommand.communication_id),
      };
    }
    const replay = await processCrmEmailOutbox({
      outboxId: existingCommand.id,
      storage,
      sender,
      config,
      now,
    });
    return { ...replay, replayedCommand: true };
  }
  const previewResult = await previewCrmFollowUpEmail({ submissionId, actor: scopedActor, input, storage, config, now });
  if (!previewResult.ok) return previewResult;
  const { submission, preview } = previewResult;
  if (config.followUp?.requireSignedPreview !== false
    && !previewConfirmationMatches(input.previewConfirmationToken, preview.confirmationToken)) {
    return policyFailure(422, 'preview-confirmation-invalid', 'Preview and confirm this exact email and CRM action before queuing it.');
  }
  const nowIso = now.toISOString();
  const createdAt = Date.parse(nowIso) <= Date.parse(submission.updated_at || '')
    ? new Date(Date.parse(submission.updated_at) + 1).toISOString()
    : nowIso;
  const communicationId = randomUUID();
  const outboxId = randomUUID();
  const idempotencyKey = `crm-follow-up-${outboxId}`;
  const clientRequestKey = `${submission.id}:${compactText(actor, 160)}:${clientToken}`;
  const manualTakeoverCimRequestId = compactText(input.cimRequestId, 160);
  if (manualTakeoverCimRequestId && input.manualTakeoverAcknowledged !== true) {
    return policyFailure(422, 'manual-takeover-acknowledgement-required', 'Confirm that this manual email will stop the linked Deal Hunter follow-up sequence.');
  }
  const communication = {
    id: communicationId,
    submission_id: submission.id,
    deal_key: compactText(input.dealKey, 500) || null,
    cim_request_id: manualTakeoverCimRequestId || null,
    direction: 'outbound', channel: 'email', source: 'manual', kind: 'crm-follow-up',
    provider: 'resend', provider_message_id: null, source_event_id: null, idempotency_key: idempotencyKey,
    message_id: null, in_reply_to: preview.inReplyTo, references_json: preview.references,
    parent_communication_id: preview.parentCommunicationId, thread_key: preview.threadKey,
    legacy_content_unavailable: false, content_redaction_state: 'sanitized',
    recommendation_id: compactText(input.recommendationId, 160) || null, outbox_id: outboxId,
    headers_json: preview.headers, reply_to_address: preview.replyTo, from_address: preview.from,
    to_addresses: [preview.to], cc_addresses: [], bcc_addresses: [], subject: preview.subject,
    body_text: preview.bodyText, body_html_sanitized: preview.bodyHtmlSanitized,
    occurred_at: createdAt, created_at: createdAt, updated_at: createdAt,
    delivery_state: 'not-attempted', delivery_state_at: null, content_state: 'complete',
    content_attempt_count: 0, content_last_error: null, content_next_attempt_at: null,
    attachment_metadata: [], assigned_at: createdAt, assigned_by: actor, created_by: actor, updated_by: actor,
    metadata: {
      recipientOverride: preview.recipientOverride,
      complianceFooterApplied: true,
      realThreadedReply: Boolean(preview.inReplyTo),
      manualTakeover: Boolean(manualTakeoverCimRequestId),
    },
  };
  const intendedFollowUpState = normalizedNextFollowUpState(input);
  const intendedNextActionAt = normalizedNextActionAt(input);
  let recommendationDecision = null;
  const recommendationId = compactText(input.recommendationId, 160);
  if (recommendationId && typeof storage.getCrmFollowUpRecommendation === 'function') {
    const recommendation = await storage.getCrmFollowUpRecommendation(recommendationId);
    if (recommendation?.submission_id === submission.id && recommendation.status === 'current') {
      const reviewedBody = text(input.bodyText || input.body, maxBodyLength);
      recommendationDecision = compactText(recommendation.draft_subject, maxSubjectLength) === preview.subject
        && text(recommendation.draft_body_text, maxBodyLength) === reviewedBody
        ? 'accepted'
        : 'edited_and_accepted';
    }
  }
  const outbox = {
    id: outboxId, communication_id: communicationId, submission_id: submission.id,
    cim_request_id: manualTakeoverCimRequestId || null, idempotency_key: idempotencyKey,
    client_request_key: clientRequestKey, state: 'queued', provider: 'resend', provider_message_id: null,
    attempt_count: 0, next_attempt_at: createdAt, claim_token: null, claimed_at: null,
    claim_expires_at: null, accepted_at: null, failed_at: null, ambiguous_at: null,
    last_error_category: null, last_error_message: null, expected_submission_version: submission.updated_at,
    actor, intended_follow_up_state: intendedFollowUpState, intended_next_action_at: intendedNextActionAt,
    created_at: createdAt, updated_at: createdAt,
    metadata: {
      manualTakeover: Boolean(manualTakeoverCimRequestId),
      recommendationDecision,
      reviewedLatestCommunicationId: preview.latestCommunicationId,
      reviewedLatestCommunicationUpdatedAt: preview.latestCommunicationUpdatedAt,
      previewConfirmationExpiresAt: preview.confirmationExpiresAt,
    },
  };
  let command;
  try {
    command = await storage.createCrmEmailCommand({
      communication,
      outbox,
      expectedSubmissionVersion: submission.updated_at,
      manualTakeoverCimRequestId,
      activity: {
        id: randomUUID(), submission_id: submission.id, created_at: createdAt, actor, role: 'admin',
        event_type: 'follow-up.email.queued',
        summary: 'CRM follow-up email queued for provider transmission.',
        metadata: {
          communicationId, outboxId, realThreadedReply: Boolean(preview.inReplyTo),
          manualTakeover: Boolean(manualTakeoverCimRequestId), recipientOverride: preview.recipientOverride,
        },
      },
    });
  } catch {
    return policyFailure(503, 'command-persistence-failed', 'The email was not sent because its immutable CRM command could not be saved.');
  }
  if (!command.applied && command.reason !== 'duplicate-client-request') {
    const status = ['stale-submission', 'cim-send-in-progress'].includes(command.reason) ? 409 : 422;
    return policyFailure(status, command.reason, 'The email command conflicts with newer CRM or Deal Hunter state.', { submission: command.submission });
  }
  if (!processImmediately) {
    return { ok: true, status: 202, queued: true, replayed: !command.applied, ...command };
  }
  const processed = await processCrmEmailOutbox({ outboxId: command.outbox.id, storage, sender, config, now });
  return { ...processed, replayedCommand: !command.applied };
}
