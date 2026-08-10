import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getFollowUpEmailReadiness } from './followUpEmail.js';
import { hasVerifiedFollowUpReply } from './emailReadiness.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function compactText(value = '', maxLength = 1_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeEmail(value = '') {
  return (compactText(value, 320).match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]
    || compactText(value, 320).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    || '').toLowerCase();
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function contactRecipients(submission = {}, communications = []) {
  const recipients = [
    { email: normalizeEmail(submission.email), label: compactText(submission.name, 160), source: 'primary-contact' },
    { email: normalizeEmail(submission.broker_email), label: compactText(submission.broker_name, 160), source: 'broker' },
    { email: normalizeEmail(submission.seller_email), label: compactText(submission.seller_name, 160), source: 'seller' },
  ].filter((recipient) => emailPattern.test(recipient.email));
  const latestInbound = communications.find((communication) => communication.direction === 'inbound');
  const inboundEmail = normalizeEmail(latestInbound?.from_address);
  if (emailPattern.test(inboundEmail)) {
    recipients.push({ email: inboundEmail, label: 'Latest inbound sender', source: 'latest-inbound' });
  }
  const seen = new Set();
  return recipients.filter((recipient) => {
    if (seen.has(recipient.email)) return false;
    seen.add(recipient.email);
    return true;
  });
}

function safeCommunication(communication = {}) {
  return {
    id: communication.id,
    submission_id: communication.submission_id,
    deal_key: communication.deal_key,
    cim_request_id: communication.cim_request_id,
    recommendation_id: communication.recommendation_id,
    outbox_id: communication.outbox_id,
    direction: communication.direction,
    channel: communication.channel,
    source: communication.source,
    kind: communication.kind,
    provider: communication.provider,
    provider_message_id: communication.provider_message_id,
    message_id: communication.message_id,
    in_reply_to: communication.in_reply_to,
    references_json: communication.references_json || [],
    parent_communication_id: communication.parent_communication_id,
    thread_key: communication.thread_key,
    legacy_content_unavailable: Boolean(communication.legacy_content_unavailable),
    content_redaction_state: communication.content_redaction_state,
    content_state: communication.content_state,
    content_attempt_count: Number(communication.content_attempt_count || 0),
    content_last_error: compactText(communication.content_last_error, 500),
    reply_to_address: communication.reply_to_address,
    from_address: communication.from_address,
    to_addresses: communication.to_addresses || [],
    cc_addresses: communication.cc_addresses || [],
    bcc_addresses: communication.bcc_addresses || [],
    subject: communication.subject,
    body_text: communication.body_text,
    body_html_sanitized: communication.body_html_sanitized,
    headers_json: communication.headers_json || {},
    attachment_metadata: communication.attachment_metadata || [],
    delivery_state: communication.delivery_state,
    delivery_state_at: communication.delivery_state_at,
    occurred_at: communication.occurred_at,
    created_at: communication.created_at,
    updated_at: communication.updated_at,
    created_by: communication.created_by,
  };
}

function safeOutbox(outbox = {}) {
  return {
    id: outbox.id,
    communication_id: outbox.communication_id,
    submission_id: outbox.submission_id,
    cim_request_id: outbox.cim_request_id,
    state: outbox.state,
    provider: outbox.provider,
    provider_message_id: outbox.provider_message_id,
    attempt_count: Number(outbox.attempt_count || 0),
    next_attempt_at: outbox.next_attempt_at,
    accepted_at: outbox.accepted_at,
    failed_at: outbox.failed_at,
    ambiguous_at: outbox.ambiguous_at,
    last_error_category: outbox.last_error_category,
    last_error_message: outbox.last_error_message,
    actor: outbox.actor,
    intended_follow_up_state: outbox.intended_follow_up_state,
    intended_next_action_at: outbox.intended_next_action_at,
    created_at: outbox.created_at,
    updated_at: outbox.updated_at,
  };
}

function safeDocument(document = {}) {
  return {
    id: document.id,
    request_id: document.request_id,
    original_name: compactText(document.original_name || document.name || document.filename, 300),
    content_type: compactText(document.content_type || document.mime_type, 160),
    size: Math.max(0, Number(document.size || document.size_bytes || 0)),
    created_at: document.created_at,
  };
}

function safeDealHunterContext(submission = {}, request = null) {
  const metadata = submission.metadata?.dealHunter && typeof submission.metadata.dealHunter === 'object'
    ? submission.metadata.dealHunter
    : {};
  return {
    linked: Boolean(request || metadata.dealKey || metadata.score),
    dealKey: compactText(request?.deal_key || metadata.dealKey, 500),
    score: Number.isFinite(Number(metadata.score)) ? Number(metadata.score) : null,
    scoreVersion: compactText(metadata.scoreVersion, 120),
    strengths: Array.isArray(metadata.strengths) ? metadata.strengths.slice(0, 10).map((item) => compactText(item, 500)) : [],
    concerns: Array.isArray(metadata.concerns) ? metadata.concerns.slice(0, 10).map((item) => compactText(item, 500)) : [],
    unansweredQuestions: Array.isArray(metadata.unansweredQuestions)
      ? metadata.unansweredQuestions.slice(0, 10).map((item) => compactText(item, 500))
      : [],
    sourceFreshAt: compactText(metadata.sourceFreshAt || metadata.lastSeenAt, 80),
    listingClaimsUnverified: true,
    cimRequest: request ? {
      id: request.id,
      status: request.status,
      request_state: request.request_state,
      delivery_state: request.delivery_state,
      reply_state: request.reply_state,
      follow_up_state: request.follow_up_state,
      follow_up_count: Number(request.follow_up_count || 0),
      next_follow_up_at: request.next_follow_up_at,
      recipient_email: request.recipient_email,
      updated_at: request.updated_at,
    } : null,
  };
}

function safeSubmission(submission = {}) {
  const { metadata: _metadata, message: _message, notes: _notes, ...rest } = submission;
  return rest;
}

export async function getCrmFollowUpContext({
  submissionId = '', storage = getStorage(), config = getConfig(), communicationPage = 1, communicationPageSize = 50,
} = {}) {
  const id = compactText(submissionId, 160);
  if (!id) return { ok: false, status: 400, error: 'A CRM record ID is required.' };
  const submission = await storage.getSubmission(id);
  if (!submission) return { ok: false, status: 404, error: 'CRM record not found.' };
  const safePage = Math.max(1, Math.min(Math.trunc(Number(communicationPage) || 1), 10_000));
  const safePageSize = Math.max(1, Math.min(Math.trunc(Number(communicationPageSize) || 50), 100));
  const [communicationResult, documents, cimRequest, storedRecommendation, outbox] = await Promise.all([
    storage.listCrmCommunications({ submissionId: id, page: safePage, pageSize: safePageSize }),
    storage.listSecureDocumentsForSubmission?.(id) || [],
    storage.getLatestDealHunterCimRequestForSubmission?.(id) || null,
    storage.getCurrentCrmFollowUpRecommendation?.(id) || null,
    storage.listCrmEmailOutbox?.({ submissionId: id, limit: 25 }) || [],
  ]);
  const recommendation = storedRecommendation
    && (!storedRecommendation.expires_at || Date.parse(storedRecommendation.expires_at) > Date.now())
    ? storedRecommendation
    : null;
  const newestFirst = communicationResult?.rows || [];
  const recipients = contactRecipients(submission, newestFirst);
  const suppressions = (await Promise.all(
    recipients.map((recipient) => storage.getActiveEmailSuppression?.(recipient.email)),
  )).filter(Boolean);
  const emailPolicy = getFollowUpEmailReadiness(config);
  if (config.followUp?.requireVerifiedReply) {
    let verifiedReply = false;
    try {
      const readinessEvents = await storage.listEmailEvents?.({ limit: 500 });
      verifiedReply = hasVerifiedFollowUpReply(readinessEvents || []);
    } catch {
      verifiedReply = false;
    }
    if (!verifiedReply) {
      emailPolicy.ready = false;
      emailPolicy.blockers = Array.from(new Set([...emailPolicy.blockers, 'reply-tracking-unverified']));
    }
  }
  return {
    ok: true,
    status: 200,
    context: {
      submission: safeSubmission(submission),
      communications: [...newestFirst].reverse().map(safeCommunication),
      communicationPage: safePage,
      communicationPageSize: safePageSize,
      communicationTotal: Number(communicationResult?.total || 0),
      documents: documents.map(safeDocument),
      dealHunter: safeDealHunterContext(submission, cimRequest),
      recommendation,
      outbox: outbox.map(safeOutbox),
      recipients,
      suppressions: suppressions.map((suppression) => ({
        id: suppression.id,
        normalized_email: suppression.normalized_email,
        reason: suppression.reason,
        source: suppression.source,
        created_at: suppression.created_at,
        created_by: suppression.created_by,
      })),
      policy: {
        email: emailPolicy,
        sender: {
          from: compactText(config.followUp?.senderName, 120) && normalizeEmail(config.followUp?.senderEmail)
            ? `${compactText(config.followUp.senderName, 120)} <${normalizeEmail(config.followUp.senderEmail)}>`
            : normalizeEmail(config.followUp?.senderEmail),
          replyTo: normalizeEmail(config.followUp?.replyTo),
        },
        ai: {
          enabled: Boolean(config.followUp?.aiEnabled),
          ready: Boolean(config.followUp?.aiEnabled && config.followUp?.aiModel && config.followUp?.aiApiKeyConfigured),
          optional: true,
        },
        timezone: config.followUp?.timezone,
        sendWindowStart: config.followUp?.sendWindowStart,
        sendWindowEnd: config.followUp?.sendWindowEnd,
        weekdaysOnly: Boolean(config.followUp?.weekdaysOnly),
        dailyCap: config.followUp?.dailyCap,
        recipientRollingCap: config.followUp?.recipientRollingCap,
        maxTouches: config.followUp?.maxTouches,
      },
    },
  };
}

export async function getCrmFollowUpOutboxResult({ submissionId = '', outboxId = '', storage = getStorage() } = {}) {
  const outbox = await storage.getCrmEmailOutbox(compactText(outboxId, 160));
  if (!outbox || outbox.submission_id !== compactText(submissionId, 160)) {
    return { ok: false, status: 404, error: 'CRM email command not found.' };
  }
  const communication = await storage.getCrmCommunication(outbox.communication_id);
  return {
    ok: true,
    status: 200,
    outbox: safeOutbox(outbox),
    communication: communication ? safeCommunication(communication) : null,
  };
}

export async function dismissCrmFollowUpRecommendation({
  submissionId = '', recommendationId = '', expectedSubmissionVersion = '', actor = 'admin', storage = getStorage(),
} = {}) {
  const submission = await storage.getSubmission(compactText(submissionId, 160));
  if (!submission) return { ok: false, status: 404, error: 'CRM record not found.' };
  if (!expectedSubmissionVersion || expectedSubmissionVersion !== submission.updated_at) {
    return { ok: false, status: 409, error: 'The CRM record changed. Refresh before dismissing this recommendation.', submission };
  }
  const recommendation = await storage.getCrmFollowUpRecommendation(compactText(recommendationId, 160));
  if (!recommendation || recommendation.submission_id !== submission.id || recommendation.status !== 'current') {
    return { ok: false, status: 409, error: 'This recommendation is no longer current.' };
  }
  const actedOnAt = new Date().toISOString();
  const updated = await storage.updateCrmFollowUpRecommendation(recommendation.id, {
    status: 'dismissed',
    acted_on_at: actedOnAt,
    acted_on_by: compactText(actor, 160),
    outcome: 'dismissed',
  });
  await storage.insertCrmActivityEvent?.({
    id: randomUUID(),
    submission_id: submission.id,
    created_at: actedOnAt,
    actor: compactText(actor, 160),
    role: 'admin',
    event_type: 'follow-up.recommendation.dismissed',
    summary: 'CRM follow-up recommendation dismissed.',
    metadata: { recommendationId: recommendation.id },
  });
  return { ok: true, status: 200, recommendation: updated, submission };
}

function submissionEmails(submission = {}) {
  return unique([submission.email, submission.broker_email, submission.seller_email].map(normalizeEmail));
}

export async function createAdminEmailSuppression({
  submissionId = '', email = '', reason = '', confirmed = false, overrideReason = '', actor = 'admin',
  storage = getStorage(),
} = {}) {
  const submission = await storage.getSubmission(compactText(submissionId, 160));
  if (!submission) return { ok: false, status: 404, error: 'CRM record not found.' };
  const normalizedEmail = normalizeEmail(email);
  const normalizedReason = compactText(reason, 500);
  if (!emailPattern.test(normalizedEmail)) return { ok: false, status: 422, error: 'A valid email address is required.' };
  if (!confirmed || !normalizedReason) {
    return { ok: false, status: 422, error: 'Explicit confirmation and an audited suppression reason are required.' };
  }
  const isKnown = submissionEmails(submission).includes(normalizedEmail);
  if (!isKnown && !compactText(overrideReason, 500)) {
    return { ok: false, status: 422, error: 'Explain why this non-contact address should be suppressed for this CRM record.' };
  }
  const createdAt = new Date().toISOString();
  const suppression = await storage.upsertEmailSuppression({
    id: randomUUID(),
    normalized_email: normalizedEmail,
    reason: 'admin-block',
    source: 'admin',
    source_event_id: null,
    source_communication_id: null,
    created_at: createdAt,
    created_by: compactText(actor, 160),
    lifted_at: null,
    lifted_by: null,
    lift_reason: null,
    metadata: {
      submissionId: submission.id,
      reason: normalizedReason,
      overrideReason: isKnown ? null : compactText(overrideReason, 500),
    },
  });
  await storage.supersedeCrmFollowUpRecommendations?.(submission.id, createdAt);
  await storage.insertCrmActivityEvent?.({
    id: randomUUID(), submission_id: submission.id, created_at: createdAt,
    actor: compactText(actor, 160), role: 'admin', event_type: 'follow-up.suppression.created',
    summary: 'Global email suppression created by an administrator.',
    metadata: { email: normalizedEmail, suppressionId: suppression.id, reason: normalizedReason },
  });
  return { ok: true, status: 201, suppression, submission };
}

export async function liftAdminEmailSuppression({
  submissionId = '', email = '', liftReason = '', confirmed = false, actor = 'admin', storage = getStorage(),
} = {}) {
  const submission = await storage.getSubmission(compactText(submissionId, 160));
  if (!submission) return { ok: false, status: 404, error: 'CRM record not found.' };
  const normalizedEmail = normalizeEmail(email);
  const normalizedReason = compactText(liftReason, 500);
  if (!emailPattern.test(normalizedEmail)) return { ok: false, status: 422, error: 'A valid email address is required.' };
  if (!confirmed || !normalizedReason) {
    return { ok: false, status: 422, error: 'Explicit confirmation and an audited lift reason are required.' };
  }
  const active = await storage.getActiveEmailSuppression(normalizedEmail);
  if (!active) return { ok: false, status: 404, error: 'No active suppression exists for this address.' };
  const liftedAt = new Date().toISOString();
  const suppression = await storage.liftEmailSuppression(normalizedEmail, {
    liftedAt,
    liftedBy: compactText(actor, 160),
    liftReason: normalizedReason,
  });
  await storage.supersedeCrmFollowUpRecommendations?.(submission.id, liftedAt);
  await storage.insertCrmActivityEvent?.({
    id: randomUUID(), submission_id: submission.id, created_at: liftedAt,
    actor: compactText(actor, 160), role: 'admin', event_type: 'follow-up.suppression.lifted',
    summary: 'Global email suppression lifted by an administrator.',
    metadata: { email: normalizedEmail, suppressionId: active.id, liftReason: normalizedReason },
  });
  return { ok: true, status: 200, suppression, submission };
}
