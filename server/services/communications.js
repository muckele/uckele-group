import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { fetchWithTimeout } from '../utils/http.js';
import { commitCrmActivityMutation } from './activity.js';

const directions = new Set(['inbound', 'outbound']);
const channels = new Set(['email', 'phone', 'meeting', 'text', 'note']);
const sources = new Set(['deal-hunter', 'resend-webhook', 'manual', 'secure-documents', 'system']);
const deliveryStates = new Set([
  'not-attempted',
  'accepted',
  'delivered',
  'delayed',
  'bounced',
  'failed',
  'complained',
  'suppressed',
  'development-only',
  'replied',
]);
const contentStates = new Set(['not-applicable', 'pending', 'complete', 'failed', 'legacy-unavailable']);
const deliveryEventStates = {
  sent: 'accepted',
  delivered: 'delivered',
  delayed: 'delayed',
  bounced: 'bounced',
  failed: 'failed',
  complained: 'complained',
  unsubscribed: 'suppressed',
  suppressed: 'suppressed',
  replied: 'replied',
  received: 'replied',
};
const requestDeliveryStates = new Set(['accepted', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed', 'development-only']);
const sameTimestampDeliveryPriority = {
  'not-attempted': 0,
  accepted: 1,
  delayed: 2,
  delivered: 3,
  failed: 4,
  bounced: 5,
  complained: 6,
  suppressed: 7,
  replied: 8,
};
const maxBodyTextLength = 100_000;
const maxBodyHtmlLength = 200_000;
const maxSubjectLength = 500;
const maxAddressCount = 50;
const maxAttachmentCount = 25;
const maxAttachmentMetadataBytes = 64 * 1024;
const maxMetadataBytes = 32 * 1024;
const maxWorkflowWarningLength = 500;
const maxReceivedEmailResponseBytes = 512 * 1024;
const maxReceivedAttachmentResponseBytes = 128 * 1024;
const maxIngestionAttempts = 10;
const ingestionRetryDelayMs = 15 * 60 * 1000;
const ingestionClaimLeaseMs = 5 * 60 * 1000;
const maxListPage = 10_000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const manualWorkflowWarnings = {
  pending: 'Communication logged. The optional CRM workflow update is pending confirmation.',
  conflict: 'Communication logged, but the optional CRM workflow update was not applied because the CRM record changed. Reload the record and apply the workflow change separately.',
  failed: 'Communication logged, but the optional CRM workflow update could not be applied. Reload the record before applying the workflow change separately.',
  marker: 'Communication and CRM workflow were saved, but workflow confirmation could not be attached to the communication. Reload the record to verify the current workflow.',
};

function text(value, maxLength = 1000) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function compactText(value, maxLength = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), maximum));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeIso(value, fallback = '') {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function extractEmail(value) {
  const candidate = compactText(value, 320);
  const address = candidate.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1]?.toLowerCase() || '';
  return emailPattern.test(address) ? address : '';
}

export function normalizeCommunicationAddresses(value, { max = maxAddressCount } = {}) {
  return Array.from(new Set(addressParts(value).map(extractEmail).filter(Boolean))).slice(0, max);
}

function addressParts(value) {
  if (Array.isArray(value)) return value.flatMap(addressParts);
  if (value && typeof value === 'object') {
    return addressParts(value.email || value.address || value.value || value.to);
  }
  return String(value || '').split(/[;,\n]/).map((item) => item.trim()).filter(Boolean);
}

function boundedObject(value, maxBytes = maxMetadataBytes) {
  const normalized = objectValue(value);
  const json = JSON.stringify(normalized);
  return Buffer.byteLength(json, 'utf8') <= maxBytes ? normalized : { truncated: true };
}

function nextVersionTimestamp(previousValue = '') {
  const generated = new Date().toISOString();
  const previousTimestamp = Date.parse(previousValue || '');
  return Number.isFinite(previousTimestamp) && Date.parse(generated) <= previousTimestamp
    ? new Date(previousTimestamp + 1).toISOString()
    : generated;
}

function metadataWithWorkflowUpdate(value, workflowUpdate = null) {
  const metadata = { ...objectValue(value) };
  delete metadata.workflowUpdate;
  if (!workflowUpdate) return boundedObject(metadata);

  const normalizedWorkflowUpdate = {
    state: compactText(workflowUpdate.state, 40) || 'pending',
    requestedStatus: compactText(workflowUpdate.requestedStatus, 40) || null,
    requestedFollowUpState: compactText(workflowUpdate.requestedFollowUpState, 40) || null,
    expectedSubmissionUpdatedAt: normalizeIso(workflowUpdate.expectedSubmissionUpdatedAt, '') || null,
    requestedAt: normalizeIso(workflowUpdate.requestedAt, '') || null,
    completedAt: normalizeIso(workflowUpdate.completedAt, '') || null,
    actor: compactText(workflowUpdate.actor, 160) || 'admin',
    warning: compactText(workflowUpdate.warning, maxWorkflowWarningLength),
  };
  const candidate = { ...metadata, workflowUpdate: normalizedWorkflowUpdate };
  return Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxMetadataBytes
    ? candidate
    : { truncated: true, workflowUpdate: normalizedWorkflowUpdate };
}

async function persistManualWorkflowOutcome({ storage, communication, state, warning = '', actor = 'admin' } = {}) {
  const completedAt = new Date().toISOString();
  const metadata = metadataWithWorkflowUpdate(communication.metadata, {
    ...objectValue(communication.metadata?.workflowUpdate),
    state,
    warning,
    completedAt,
    actor,
  });
  const fallback = {
    ...communication,
    metadata,
    updated_at: completedAt,
    updated_by: compactText(actor, 160) || 'admin',
  };

  try {
    const updated = await storage.updateCrmCommunication(communication.id, {
      metadata,
      updated_at: completedAt,
      updated_by: compactText(actor, 160) || 'admin',
    });
    return { communication: updated || fallback, persisted: Boolean(updated) };
  } catch {
    // The communication itself is already durable. Its initial pending marker
    // remains available after reload if this secondary annotation cannot save.
    return { communication: fallback, persisted: false };
  }
}

function htmlToPlainText(value) {
  return String(value || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function boundedAttachments(attachments) {
  const result = (Array.isArray(attachments) ? attachments : [])
    .slice(0, maxAttachmentCount)
    .map((attachment) => ({
      id: compactText(attachment?.id, 240),
      filename: compactText(attachment?.filename || attachment?.name, 240),
      contentType: compactText(attachment?.content_type || attachment?.contentType, 160),
      contentDisposition: compactText(attachment?.content_disposition || attachment?.contentDisposition, 80),
      contentId: compactText(attachment?.content_id || attachment?.contentId, 240),
      size: Math.max(0, Math.min(Number(attachment?.size) || 0, 1024 * 1024 * 1024)),
    }));
  const json = JSON.stringify(result);
  return Buffer.byteLength(json, 'utf8') <= maxAttachmentMetadataBytes ? result : [];
}

function normalizeCommunicationRecord(input = {}, { strict = false } = {}) {
  const now = new Date().toISOString();
  const direction = directions.has(input.direction) ? input.direction : '';
  const channel = channels.has(input.channel) ? input.channel : '';
  const source = sources.has(input.source) ? input.source : 'system';
  const occurredAt = normalizeIso(input.occurred_at || input.occurredAt, now);
  const bodyText = text(input.body_text ?? input.bodyText, maxBodyTextLength);
  const bodyHtml = text(input.body_html_sanitized ?? input.bodyHtmlSanitized, maxBodyHtmlLength);
  const toAddresses = normalizeCommunicationAddresses(input.to_addresses ?? input.toAddresses);
  const ccAddresses = normalizeCommunicationAddresses(input.cc_addresses ?? input.ccAddresses);
  const bccAddresses = normalizeCommunicationAddresses(input.bcc_addresses ?? input.bccAddresses);

  if (strict && (!direction || !channel)) {
    return { error: 'Direction and channel are required.' };
  }
  if (strict && channel === 'email' && direction === 'outbound' && toAddresses.length === 0) {
    return { error: 'At least one valid recipient is required for an outbound email.' };
  }
  if (strict && !bodyText && !compactText(input.subject, maxSubjectLength)) {
    return { error: 'A subject or communication body is required.' };
  }

  return {
    id: compactText(input.id, 120) || randomUUID(),
    submission_id: compactText(input.submission_id ?? input.submissionId, 120) || null,
    deal_key: compactText(input.deal_key ?? input.dealKey, 1000) || null,
    cim_request_id: compactText(input.cim_request_id ?? input.cimRequestId, 120) || null,
    direction: direction || 'inbound',
    channel: channel || 'email',
    source,
    kind: compactText(input.kind, 80) || null,
    provider: compactText(input.provider, 60) || null,
    provider_message_id: compactText(input.provider_message_id ?? input.providerMessageId, 240) || null,
    source_event_id: compactText(input.source_event_id ?? input.sourceEventId, 240) || null,
    idempotency_key: compactText(input.idempotency_key ?? input.idempotencyKey, 300) || null,
    in_reply_to: compactText(input.in_reply_to ?? input.inReplyTo, 500) || null,
    reply_to_address: extractEmail(input.reply_to_address ?? input.replyToAddress) || null,
    from_address: extractEmail(input.from_address ?? input.fromAddress) || null,
    to_addresses: toAddresses,
    cc_addresses: ccAddresses,
    bcc_addresses: bccAddresses,
    subject: compactText(input.subject, maxSubjectLength) || null,
    body_text: bodyText,
    body_html_sanitized: bodyHtml,
    occurred_at: occurredAt,
    created_at: normalizeIso(input.created_at ?? input.createdAt, now),
    updated_at: normalizeIso(input.updated_at ?? input.updatedAt, now),
    delivery_state: deliveryStates.has(input.delivery_state ?? input.deliveryState)
      ? (input.delivery_state ?? input.deliveryState)
      : 'not-attempted',
    delivery_state_at: normalizeIso(input.delivery_state_at ?? input.deliveryStateAt, '') || null,
    content_state: contentStates.has(input.content_state ?? input.contentState)
      ? (input.content_state ?? input.contentState)
      : 'not-applicable',
    content_attempt_count: Math.max(0, Math.min(Number(input.content_attempt_count ?? input.contentAttemptCount) || 0, maxIngestionAttempts)),
    content_last_error: compactText(input.content_last_error ?? input.contentLastError, 1000) || null,
    content_next_attempt_at: normalizeIso(input.content_next_attempt_at ?? input.contentNextAttemptAt, '') || null,
    attachment_metadata: boundedAttachments(input.attachment_metadata ?? input.attachments),
    assigned_at: normalizeIso(input.assigned_at ?? input.assignedAt, '') || null,
    assigned_by: compactText(input.assigned_by ?? input.assignedBy, 160) || null,
    created_by: compactText(input.created_by ?? input.createdBy, 160) || 'system',
    updated_by: compactText(input.updated_by ?? input.updatedBy, 160) || 'system',
    metadata: boundedObject(input.metadata),
  };
}

export function buildOutboundCommunication({ message = {}, request = {}, submissionId = '', createdBy = 'deal-hunter' } = {}) {
  const config = getConfig();
  return normalizeCommunicationRecord({
    id: message.communicationId || randomUUID(),
    submission_id: submissionId,
    deal_key: request.deal_key,
    cim_request_id: request.id,
    direction: 'outbound',
    channel: 'email',
    source: 'deal-hunter',
    kind: message.kind,
    provider: config.delivery.provider,
    idempotency_key: message.idempotencyKey,
    reply_to_address: message.replyTo,
    from_address: config.delivery.resendFromEmail || config.delivery.fallbackRecipient,
    to_addresses: message.to,
    cc_addresses: message.cc,
    bcc_addresses: message.bcc,
    subject: message.subject,
    body_text: message.text,
    body_html_sanitized: message.html,
    occurred_at: new Date().toISOString(),
    delivery_state: 'not-attempted',
    content_state: 'complete',
    created_by: createdBy,
    updated_by: createdBy,
    metadata: { followUpNumber: Number(message.tracking?.followUpNumber || 0) },
  });
}

export async function createCommunicationWithActivity({ communication, actor = 'system', role = 'system', summary = '' } = {}, storage = getStorage()) {
  const normalized = normalizeCommunicationRecord(communication, { strict: true });
  if (normalized.error) throw new Error(normalized.error);
  if (!normalized.submission_id) return storage.insertCrmCommunication(normalized);

  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'insert_crm_communication',
    payload: { communication: normalized },
    activity: {
      submissionId: normalized.submission_id,
      eventType: 'communication.created',
      summary: summary || `${normalized.direction === 'inbound' ? 'Inbound' : 'Outbound'} ${normalized.channel} communication recorded.`,
      actor,
      role,
      createdAt: normalized.occurred_at,
      metadata: {
        communicationId: normalized.id,
        channel: normalized.channel,
        direction: normalized.direction,
        cimRequestId: normalized.cim_request_id,
      },
    },
  });
  if (!mutation.applied || !mutation.record) throw new Error('Communication could not be saved with its activity record.');
  return mutation.record;
}

export async function listCrmCommunications({ submissionId = '', page = 1, pageSize = 25, before = '', storage = getStorage() } = {}) {
  const id = compactText(submissionId, 120);
  const safePage = boundedPositiveInteger(page, 1, maxListPage);
  const safePageSize = boundedPositiveInteger(pageSize, 25, 100);
  if (!id) return { rows: [], total: 0, page: safePage, pageSize: safePageSize };
  return storage.listCrmCommunications({ submissionId: id, page: safePage, pageSize: safePageSize, before });
}

export async function createManualCommunication({ submissionId = '', input = {}, actor = 'admin', storage = getStorage() } = {}) {
  const submission = await storage.getSubmission(compactText(submissionId, 120));
  if (!submission) return { ok: false, status: 404, error: 'CRM record not found.' };
  const requestedStatus = compactText(input.status, 40).toLowerCase();
  const requestedFollowUpState = compactText(input.followUpState ?? input.follow_up_state, 40).toLowerCase();
  const workflowRequested = Boolean(requestedStatus || requestedFollowUpState);
  const expectedSubmissionUpdatedAt = compactText(submission.updated_at, 80);
  const allowedStatuses = new Set(['new', 'review', 'contacted']);
  const allowedFollowUpStates = new Set(['needs-response', 'scheduled', 'waiting-on-owner', 'completed']);
  if (submission.status === 'archived' && workflowRequested) {
    return { ok: false, status: 400, error: 'Archived CRM records cannot be updated from Log Communication.' };
  }
  if (requestedStatus && !allowedStatuses.has(requestedStatus)) {
    return { ok: false, status: 400, error: 'The requested CRM status update is not allowed from Log Communication.' };
  }
  if (requestedFollowUpState && !allowedFollowUpStates.has(requestedFollowUpState)) {
    return { ok: false, status: 400, error: 'The requested follow-up state is not valid.' };
  }

  const rawBody = input.body_text ?? input.bodyText ?? input.body ?? '';
  const rawAddressLists = [
    input.to_addresses ?? input.toAddresses ?? input.to,
    input.cc_addresses ?? input.ccAddresses ?? input.cc,
    input.bcc_addresses ?? input.bccAddresses ?? input.bcc,
  ];
  if (String(rawBody).length > maxBodyTextLength) {
    return { ok: false, status: 413, error: `Communication body must be ${maxBodyTextLength.toLocaleString()} characters or fewer.` };
  }
  if (rawAddressLists.some((value) => addressParts(value).length > maxAddressCount)) {
    return { ok: false, status: 413, error: `Each recipient field may contain at most ${maxAddressCount} addresses.` };
  }
  if (String(input.subject || '').length > maxSubjectLength) {
    return { ok: false, status: 413, error: `Communication subject must be ${maxSubjectLength} characters or fewer.` };
  }
  const occurredAt = normalizeIso(input.occurred_at ?? input.occurredAt, '');
  if (!occurredAt) {
    return { ok: false, status: 400, error: 'A valid occurrence date and time is required.' };
  }
  const manualParticipants = {
    from: compactText(input.from_address ?? input.fromAddress ?? input.from, 500),
    to: addressParts(input.to_addresses ?? input.toAddresses ?? input.to).slice(0, maxAddressCount).map((value) => compactText(value, 500)),
    cc: addressParts(input.cc_addresses ?? input.ccAddresses ?? input.cc).slice(0, maxAddressCount).map((value) => compactText(value, 500)),
    bcc: addressParts(input.bcc_addresses ?? input.bccAddresses ?? input.bcc).slice(0, maxAddressCount).map((value) => compactText(value, 500)),
  };
  const requestedAt = new Date().toISOString();
  const manualMetadata = { ...objectValue(input.metadata), manualParticipants };

  const normalized = normalizeCommunicationRecord({
    ...input,
    body_text: rawBody,
    // Manual entries are plain text. Never treat caller-supplied HTML as an
    // already-sanitized body merely because the JSON API included that field.
    body_html_sanitized: '',
    occurred_at: occurredAt,
    submission_id: submission.id,
    source: 'manual',
    provider: null,
    delivery_state: input.deliveryState || input.delivery_state || 'not-attempted',
    content_state: 'complete',
    created_by: actor,
    updated_by: actor,
    metadata: metadataWithWorkflowUpdate(manualMetadata, workflowRequested ? {
      state: 'pending',
      requestedStatus,
      requestedFollowUpState,
      expectedSubmissionUpdatedAt,
      requestedAt,
      actor,
      warning: manualWorkflowWarnings.pending,
    } : null),
  }, { strict: true });
  if (normalized.error) return { ok: false, status: 400, error: normalized.error };

  if (normalized.cim_request_id) {
    const request = await storage.getDealHunterCimRequestById?.(normalized.cim_request_id);
    if (!request || request.submission_id !== submission.id) {
      return { ok: false, status: 400, error: 'The selected CIM request is not linked to this CRM record.' };
    }
  }

  let communication = await createCommunicationWithActivity({
    communication: normalized,
    actor,
    role: 'admin',
    summary: `Manual ${normalized.channel} communication logged.`,
  }, storage);

  let updatedSubmission = submission;
  let workflowUpdated = false;
  let workflowWarning = '';
  if (workflowRequested) {
    const now = nextVersionTimestamp(expectedSubmissionUpdatedAt);
    const values = {
      updated_at: now,
      ...(requestedStatus ? {
        status: requestedStatus,
        ...(requestedStatus !== submission.status ? { status_updated_at: now } : {}),
        ...(requestedStatus === 'contacted' ? { last_contacted_at: now } : {}),
      } : {}),
      ...(requestedFollowUpState ? { follow_up_state: requestedFollowUpState } : {}),
    };
    if (!expectedSubmissionUpdatedAt) {
      workflowWarning = manualWorkflowWarnings.conflict;
      ({ communication } = await persistManualWorkflowOutcome({
        storage,
        communication,
        state: 'conflict',
        warning: workflowWarning,
        actor,
      }));
    } else {
      try {
        const mutation = await commitCrmActivityMutation({
          storage,
          operation: 'update_submission',
          payload: { id: submission.id, expectedUpdatedAt: expectedSubmissionUpdatedAt, values },
          activity: {
            submissionId: submission.id,
            eventType: 'communication.workflow-updated',
            summary: 'CRM workflow updated from a manually logged communication.',
            actor,
            role: 'admin',
            metadata: {
              communicationId: communication.id,
              status: requestedStatus || submission.status,
              followUpState: requestedFollowUpState || submission.follow_up_state,
            },
          },
        });
        if (mutation.applied && mutation.record) {
          updatedSubmission = mutation.record;
          workflowUpdated = true;
          const outcome = await persistManualWorkflowOutcome({
            storage,
            communication,
            state: 'applied',
            actor,
          });
          communication = outcome.communication;
          if (!outcome.persisted) {
            workflowWarning = manualWorkflowWarnings.marker;
            communication = {
              ...communication,
              metadata: metadataWithWorkflowUpdate(communication.metadata, {
                ...objectValue(communication.metadata?.workflowUpdate),
                state: 'applied',
                warning: workflowWarning,
                completedAt: new Date().toISOString(),
                actor,
              }),
            };
          }
        } else {
          updatedSubmission = mutation.record || submission;
          workflowWarning = manualWorkflowWarnings.conflict;
          ({ communication } = await persistManualWorkflowOutcome({
            storage,
            communication,
            state: 'conflict',
            warning: workflowWarning,
            actor,
          }));
        }
      } catch {
        workflowWarning = manualWorkflowWarnings.failed;
        ({ communication } = await persistManualWorkflowOutcome({
          storage,
          communication,
          state: 'failed',
          warning: workflowWarning,
          actor,
        }));
      }
    }
  }

  return {
    ok: true,
    status: 201,
    communication,
    submission: updatedSubmission,
    workflowUpdated,
    workflowWarning: compactText(workflowWarning, maxWorkflowWarningLength),
    partialSuccess: Boolean(workflowWarning),
  };
}

async function uniqueSubmissionForContact(storage, email) {
  if (!email || !storage.listSubmissionsByContactEmail) return null;
  const rows = await storage.listSubmissionsByContactEmail(email, { limit: 3, openOnly: true });
  return rows.length === 1 ? rows[0] : null;
}

function requestIdFromInboundRecipient(value) {
  const address = extractEmail(value);
  return address.match(/^cim-([a-z0-9_-]{8,64})@/i)?.[1]?.toLowerCase() || '';
}

async function resolveInboundAssignment(storage, { recipients = [], fromAddress = '', explicitSubmissionId = '' } = {}) {
  for (const recipient of recipients) {
    const alias = extractEmail(recipient);
    const requestToken = requestIdFromInboundRecipient(alias);
    if (!requestToken) continue;
    const request = await storage.getDealHunterCimRequestByReplyToAddress?.(alias, requestToken);
    if (request?.submission_id) {
      return { submissionId: request.submission_id, request, method: 'cim-reply-alias' };
    }
  }

  if (uuidPattern.test(explicitSubmissionId || '')) {
    const submission = await storage.getSubmission(explicitSubmissionId);
    if (submission) return { submissionId: submission.id, request: null, method: 'explicit-submission' };
  }

  const unique = await uniqueSubmissionForContact(storage, fromAddress);
  return unique
    ? { submissionId: unique.id, request: null, method: 'unique-contact-email' }
    : { submissionId: null, request: null, method: 'unassigned' };
}

function receivedEmailUrl(emailId, suffix = '') {
  const id = encodeURIComponent(compactText(emailId, 240));
  return `https://api.resend.com/emails/receiving/${id}${suffix}`;
}

async function readBoundedJson(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Resend received-email response exceeded the allowed size.');
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value?.byteLength || 0;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error('Resend received-email response exceeded the allowed size.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return JSON.parse(buffer.toString('utf8'));
  }

  if (typeof response.text === 'function') {
    const payload = await response.text();
    if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
      throw new Error('Resend received-email response exceeded the allowed size.');
    }
    return JSON.parse(payload);
  }

  const payload = await response.json();
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxBytes) {
    throw new Error('Resend received-email response exceeded the allowed size.');
  }
  return payload;
}

async function fetchReceivedEmail(emailId, { config = getConfig(), fetcher = fetchWithTimeout } = {}) {
  if (!config.delivery.resendApiKey) throw new Error('Resend content retrieval is not configured.');
  const request = async (url, maxBytes) => {
    const response = await fetcher(url, {
      method: 'GET',
      timeoutMs: config.server.outboundRequestTimeoutMs,
      timeoutMessage: 'Resend received-email retrieval timed out.',
      headers: { Authorization: `Bearer ${config.delivery.resendApiKey}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Resend received-email retrieval failed with ${response.status}.`);
    return readBoundedJson(response, maxBytes);
  };
  const email = await request(receivedEmailUrl(emailId), maxReceivedEmailResponseBytes);
  let attachments = Array.isArray(email.attachments) ? email.attachments : [];
  if (attachments.length > 0) {
    try {
      const attachmentResult = await request(receivedEmailUrl(emailId, '/attachments'), maxReceivedAttachmentResponseBytes);
      attachments = Array.isArray(attachmentResult.data) ? attachmentResult.data : attachments;
    } catch {
      // The message body is still useful. Retain bounded attachment metadata from the email response.
    }
  }
  return { email, attachments: boundedAttachments(attachments) };
}

function inboundCommunicationFromWebhook(event, assignment) {
  const metadata = objectValue(event.metadata);
  return normalizeCommunicationRecord({
    id: randomUUID(),
    submission_id: assignment.submissionId,
    deal_key: assignment.request?.deal_key,
    cim_request_id: assignment.request?.id,
    direction: 'inbound',
    channel: 'email',
    source: 'resend-webhook',
    kind: 'broker-reply',
    provider: event.provider || 'resend',
    provider_message_id: metadata.resendEmailId || event.message_id,
    source_event_id: event.provider_event_id,
    from_address: metadata.fromEmail || event.recipient_email,
    to_addresses: metadata.to,
    reply_to_address: metadata.replyTo,
    subject: event.subject,
    occurred_at: event.created_at,
    delivery_state: 'replied',
    delivery_state_at: event.created_at,
    content_state: 'pending',
    content_next_attempt_at: new Date().toISOString(),
    created_by: 'resend-webhook',
    updated_by: 'resend-webhook',
    metadata: { assignmentMethod: assignment.method, emailEventId: event.id },
  });
}

async function markCimResponded(storage, request, communication) {
  if (!request) return null;
  if (request.status === 'responded' || request.request_state === 'responded') return request;
  const occurredAt = communication.occurred_at || new Date().toISOString();
  const updated = {
    ...request,
    updated_at: new Date().toISOString(),
    status: 'responded',
    request_state: 'responded',
    follow_up_state: 'stopped',
    responded_at: occurredAt,
    next_follow_up_at: null,
    last_activity_at: occurredAt,
    metadata: {
      ...(request.metadata || {}),
      responseCommunicationId: communication.id,
      ...(communication.metadata?.responseEmailEventId
        ? { responseEmailEventId: communication.metadata.responseEmailEventId }
        : {}),
    },
  };
  if (!request.submission_id) return storage.upsertDealHunterCimRequest(updated);
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'upsert_deal_hunter_cim_request',
    payload: { request: updated },
    activity: {
      submissionId: request.submission_id,
      eventType: 'cim.response-received',
      summary: 'Broker response received for the CIM request.',
      actor: communication.from_address || 'broker',
      role: 'contact',
      createdAt: occurredAt,
      metadata: {
        cimRequestId: request.id,
        communicationId: communication.id,
        responseEmailEventId: communication.metadata?.responseEmailEventId || '',
      },
    },
  });
  return mutation.record;
}

async function updateInboundContent(storage, communication, received) {
  const email = received.email || {};
  const headers = objectValue(email.headers);
  const plainText = text(email.text || htmlToPlainText(email.html), maxBodyTextLength);
  const now = new Date().toISOString();
  const updates = {
    submission_id: communication.submission_id,
    deal_key: communication.deal_key,
    cim_request_id: communication.cim_request_id,
    provider_message_id: compactText(email.id, 240) || communication.provider_message_id,
    in_reply_to: compactText(headers['in-reply-to'] || headers.in_reply_to, 500) || communication.in_reply_to,
    reply_to_address: normalizeCommunicationAddresses(email.reply_to)[0] || communication.reply_to_address,
    from_address: extractEmail(email.from) || communication.from_address,
    to_addresses: normalizeCommunicationAddresses(email.to).length ? normalizeCommunicationAddresses(email.to) : communication.to_addresses,
    cc_addresses: normalizeCommunicationAddresses(email.cc),
    bcc_addresses: normalizeCommunicationAddresses(email.bcc),
    subject: compactText(email.subject, maxSubjectLength) || communication.subject,
    body_text: plainText,
    body_html_sanitized: '',
    occurred_at: normalizeIso(email.created_at, communication.occurred_at),
    updated_at: now,
    content_state: 'complete',
    content_attempt_count: Number(communication.content_attempt_count || 0) + 1,
    content_last_error: null,
    content_next_attempt_at: null,
    attachment_metadata: received.attachments,
    updated_by: 'resend-ingestion',
    metadata: {
      ...(communication.metadata || {}),
      htmlDiscarded: Boolean(email.html),
      contentRetrievedAt: now,
      attachmentCount: received.attachments.length,
      messageId: compactText(headers['message-id'] || headers.message_id, 500),
      references: compactText(headers.references, 2000),
    },
  };
  return storage.updateCrmCommunication(communication.id, updates);
}

async function markInboundContentFailed(storage, communication) {
  const attempts = Number(communication.content_attempt_count || 0) + 1;
  const now = new Date();
  return storage.updateCrmCommunication(communication.id, {
    updated_at: now.toISOString(),
    content_state: 'failed',
    content_attempt_count: attempts,
    // Provider/storage errors can contain request fragments. Keep the durable
    // operational signal useful without copying sensitive message content.
    content_last_error: 'Received email content retrieval failed.',
    content_next_attempt_at: attempts >= maxIngestionAttempts ? null : new Date(now.getTime() + ingestionRetryDelayMs).toISOString(),
    updated_by: 'resend-ingestion',
  });
}

async function resolveAndAssignInboundCommunication({ storage, communication, received, fallbackRecipients = [] } = {}) {
  if (communication.submission_id) {
    const request = communication.cim_request_id
      ? await storage.getDealHunterCimRequestById?.(communication.cim_request_id)
      : null;
    return {
      communication,
      assignment: {
        submissionId: communication.submission_id,
        request,
        method: communication.metadata?.assignmentMethod || 'existing-communication',
      },
    };
  }

  const fullAssignment = await resolveInboundAssignment(storage, {
    recipients: received?.email?.to || fallbackRecipients,
    fromAddress: extractEmail(received?.email?.from) || communication.from_address,
    explicitSubmissionId: '',
  });
  if (!fullAssignment.submissionId) return { communication, assignment: fullAssignment };

  const assignedAt = new Date().toISOString();
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'assign_crm_communication',
    payload: {
      id: communication.id,
      submissionId: fullAssignment.submissionId,
      dealKey: fullAssignment.request?.deal_key || null,
      cimRequestId: fullAssignment.request?.id || null,
      updatedAt: assignedAt,
      assignedBy: 'resend-ingestion',
      metadata: { ...(communication.metadata || {}), assignmentMethod: fullAssignment.method },
    },
    activity: {
      submissionId: fullAssignment.submissionId,
      eventType: 'communication.assigned',
      summary: 'Inbound broker email safely matched after content retrieval.',
      actor: communication.from_address || 'broker',
      role: 'contact',
      createdAt: communication.occurred_at,
      metadata: { communicationId: communication.id, assignmentMethod: fullAssignment.method },
    },
  });
  if (!mutation.applied) {
    const current = await storage.getCrmCommunication?.(communication.id);
    if (current?.submission_id === fullAssignment.submissionId) {
      return { communication: current, assignment: fullAssignment };
    }
    throw new Error('Inbound communication assignment could not be committed.');
  }

  return { communication: mutation.record, assignment: fullAssignment };
}

export async function ingestResendReceivedEmail({ event, storage = getStorage(), fetcher } = {}) {
  const metadata = objectValue(event?.metadata);
  const providerMessageId = compactText(metadata.resendEmailId || event?.message_id, 240);
  if (!providerMessageId) return { ok: false, accepted: false, error: 'Received email ID is missing.' };

  const recipients = normalizeCommunicationAddresses(metadata.to);
  const assignment = await resolveInboundAssignment(storage, {
    recipients,
    fromAddress: metadata.fromEmail || event.recipient_email,
    explicitSubmissionId: event.submission_id || '',
  });
  let communication = await storage.getCrmCommunicationByProviderMessage?.('resend', providerMessageId, 'inbound');
  if (!communication) {
    const placeholder = inboundCommunicationFromWebhook(event, assignment);
    communication = assignment.submissionId
      ? await createCommunicationWithActivity({
          communication: placeholder,
          actor: placeholder.from_address || 'broker',
          role: 'contact',
          summary: 'Inbound broker email accepted for content retrieval.',
        }, storage)
      : await storage.insertCrmCommunication(placeholder);
  }

  // The signed reply alias is enough to stop outreach safely. Message content
  // retrieval may retry later, but follow-ups must not continue meanwhile.
  await markCimResponded(storage, assignment.request, communication);

  // Resend is at-least-once. Once the content has been durably stored, replaying
  // the webhook must not fetch it again or duplicate CRM activity.
  if (communication.content_state === 'complete') {
    return { ok: true, accepted: true, replayed: true, communication };
  }

  try {
    const received = await fetchReceivedEmail(providerMessageId, { fetcher });
    const resolved = await resolveAndAssignInboundCommunication({
      storage,
      communication,
      received,
      fallbackRecipients: recipients,
    });
    communication = resolved.communication;
    assignment.submissionId = resolved.assignment.submissionId;
    assignment.request = resolved.assignment.request;
    assignment.method = resolved.assignment.method;
    const updated = await updateInboundContent(storage, communication, received);
    await markCimResponded(storage, assignment.request, updated);
    return { ok: true, accepted: true, communication: updated };
  } catch {
    const failed = await markInboundContentFailed(storage, communication);
    return { ok: false, accepted: true, communication: failed, error: 'Received email content is pending retry.' };
  }
}

export async function retryPendingInboundIngestion({ storage = getStorage(), limit = 25, now = new Date(), fetcher } = {}) {
  const dueBefore = now.toISOString();
  const pending = storage.claimCrmCommunicationsPendingIngestion
    ? await storage.claimCrmCommunicationsPendingIngestion({
        dueBefore,
        limit,
        leaseUntil: new Date(now.getTime() + ingestionClaimLeaseMs).toISOString(),
      })
    : await storage.listCrmCommunicationsPendingIngestion({ dueBefore, limit });
  const rows = Array.isArray(pending) ? pending : pending?.rows || [];
  const results = [];
  for (const communication of rows) {
    try {
      const received = await fetchReceivedEmail(communication.provider_message_id, { fetcher });
      const resolved = await resolveAndAssignInboundCommunication({ storage, communication, received });
      const updated = await updateInboundContent(storage, resolved.communication, received);
      await markCimResponded(storage, resolved.assignment.request, updated);
      results.push({ id: communication.id, status: 'complete', communication: updated });
    } catch {
      const updated = await markInboundContentFailed(storage, communication);
      results.push({ id: communication.id, status: 'failed', attempts: updated.content_attempt_count });
    }
  }
  return {
    reviewed: rows.length,
    completed: results.filter((item) => item.status === 'complete').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  };
}

export async function listUnassignedCommunications({ page = 1, pageSize = 25, storage = getStorage() } = {}) {
  const safePage = boundedPositiveInteger(page, 1, maxListPage);
  const safePageSize = boundedPositiveInteger(pageSize, 25, 100);
  const result = await storage.listCrmCommunications({
    unassigned: true,
    direction: 'inbound',
    page: safePage,
    pageSize: safePageSize,
  });
  const rows = [];
  for (const communication of result.rows || []) {
    const candidates = communication.from_address && storage.listSubmissionsByContactEmail
      ? await storage.listSubmissionsByContactEmail(communication.from_address, { limit: 10, openOnly: false })
      : [];
    rows.push({
      id: communication.id,
      occurred_at: communication.occurred_at,
      from_address: communication.from_address,
      to_addresses: Array.isArray(communication.to_addresses) ? communication.to_addresses.slice(0, maxAddressCount) : [],
      subject: text(communication.subject, maxSubjectLength),
      body_preview: text(communication.body_text, 400),
      attachment_count: Math.min(
        maxAttachmentCount,
        Array.isArray(communication.attachment_metadata) ? communication.attachment_metadata.length : 0,
      ),
      candidates: candidates.map((submission) => ({
        id: submission.id,
        company: submission.company || submission.name,
        status: submission.status,
        brokerEmail: submission.broker_email || '',
        sellerEmail: submission.seller_email || '',
      })),
    });
  }
  return { ...result, rows };
}

export async function assignUnassignedCommunication({ communicationId = '', submissionId = '', actor = 'admin', storage = getStorage() } = {}) {
  const communication = await storage.getCrmCommunication(compactText(communicationId, 120));
  if (!communication) return { ok: false, status: 404, error: 'Communication not found.' };
  if (communication.submission_id) return { ok: false, status: 409, error: 'Communication is already assigned.' };
  const submission = await storage.getSubmission(compactText(submissionId, 120));
  if (!submission) return { ok: false, status: 404, error: 'CRM record not found.' };
  const now = new Date().toISOString();
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'assign_crm_communication',
    payload: { id: communication.id, submissionId: submission.id, updatedAt: now, assignedBy: actor },
    activity: {
      submissionId: submission.id,
      eventType: 'communication.assigned',
      summary: 'Unassigned inbound communication linked to this CRM record.',
      actor,
      role: 'admin',
      metadata: { communicationId: communication.id },
    },
  });
  if (!mutation.applied || !mutation.record) return { ok: false, status: 409, error: 'Communication assignment changed before it could be saved.' };
  return { ok: true, status: 200, communication: mutation.record };
}

export async function applyEmailLifecycleToCommunication(event, { storage = getStorage() } = {}) {
  const state = deliveryEventStates[String(event?.event_type || '').toLowerCase().replace(/^email[._-]/, '').replace(/[._]/g, '-')];
  if (!state) return null;
  const tracking = objectValue(event?.metadata?.tracking);
  let communication = event.communication_id || tracking.communicationId
    ? await storage.getCrmCommunication?.(event.communication_id || tracking.communicationId)
    : null;
  if (!communication && event.message_id) {
    communication = await storage.getCrmCommunicationByProviderMessage?.(event.provider, event.message_id, 'outbound');
  }
  if (!communication && tracking.cimRequestId) {
    const matches = await storage.listCrmCommunications?.({ cimRequestId: tracking.cimRequestId, page: 1, pageSize: 10 });
    communication = (matches?.rows || []).find((row) => row.direction === 'outbound') || null;
  }
  if (!communication) return null;

  const eventAt = normalizeIso(event.created_at, new Date().toISOString());
  if (state === 'replied') {
    if (communication.cim_request_id) {
      const request = await storage.getDealHunterCimRequestById?.(communication.cim_request_id);
      if (request && request.request_state !== 'responded') {
        const eventMetadata = objectValue(event.metadata);
        await markCimResponded(storage, request, {
          ...communication,
          occurred_at: eventAt,
          from_address: eventMetadata.fromEmail || event.recipient_email || communication.from_address,
          metadata: {
            ...(communication.metadata || {}),
            responseEmailEventId: event.id || '',
          },
        });
      }
    }
    // A reply is outreach state, not delivery state. Preserve the last actual
    // delivery outcome on the outbound communication.
    return communication;
  }
  const currentAt = Date.parse(communication.delivery_state_at || '');
  const eventAtMs = Date.parse(eventAt);
  if (Number.isFinite(currentAt) && eventAtMs < currentAt) return communication;
  if (
    Number.isFinite(currentAt) &&
    eventAtMs === currentAt &&
    (sameTimestampDeliveryPriority[state] || 0) < (sameTimestampDeliveryPriority[communication.delivery_state] || 0)
  ) return communication;
  if (communication.delivery_state === state && communication.delivery_state_at === eventAt) return communication;

  const updated = await storage.updateCrmCommunication(communication.id, {
    provider_message_id: event.message_id || communication.provider_message_id,
    source_event_id: event.provider_event_id || communication.source_event_id,
    delivery_state: state,
    delivery_state_at: eventAt,
    updated_at: new Date().toISOString(),
    updated_by: 'email-webhook',
  });

  if (updated.cim_request_id && requestDeliveryStates.has(state)) {
    const request = await storage.getDealHunterCimRequestById?.(updated.cim_request_id);
    if (request) {
      const linkedSubmission = request.submission_id && storage.getSubmission
        ? await storage.getSubmission(request.submission_id)
        : null;
      const outreachStopped = linkedSubmission?.status === 'archived'
        || request.request_state === 'stopped'
        || request.follow_up_state === 'stopped';
      const deliveryIssue = ['bounced', 'failed', 'complained', 'suppressed'].includes(state);
      const status = request.request_state === 'responded'
        ? 'responded'
        : outreachStopped
          ? request.status
          : deliveryIssue
          ? 'delivery_issue'
          : state === 'development-only'
            ? 'logged'
            : 'sent';
      const requestState = request.request_state === 'responded'
        ? 'responded'
        : outreachStopped
          ? 'stopped'
          : 'provider_accepted';
      const requestUpdate = {
        ...request,
        updated_at: new Date().toISOString(),
        status,
        request_state: requestState,
        delivery_state: state,
        first_provider_accepted_at: request.first_provider_accepted_at || (state === 'accepted' ? eventAt : null),
        delivered_at: state === 'delivered' ? eventAt : request.delivered_at,
        last_delivery_event_at: eventAt,
        last_activity_at: eventAt,
        follow_up_state: outreachStopped ? 'stopped' : request.follow_up_state,
        next_follow_up_at: deliveryIssue || outreachStopped ? null : request.next_follow_up_at,
        delivery_error: deliveryIssue
          ? `Email ${state}. Verify or correct the recipient before retrying.`
          : '',
      };
      if (request.submission_id) {
        await commitCrmActivityMutation({
          storage,
          operation: 'upsert_deal_hunter_cim_request',
          payload: { request: requestUpdate, preserveStoppedOutreach: true },
          activity: {
            submissionId: request.submission_id,
            eventType: 'cim.delivery-updated',
            summary: `CIM delivery state updated to ${state}.`,
            actor: event.provider || 'email-webhook',
            role: 'system',
            createdAt: eventAt,
            metadata: {
              cimRequestId: request.id,
              communicationId: updated.id,
              emailEventId: event.id || '',
              providerEventId: event.provider_event_id || '',
              deliveryState: state,
            },
          },
        });
      } else {
        await storage.upsertDealHunterCimRequest(requestUpdate);
      }
    }
  }
  return updated;
}

export async function getCommunicationOperationsStatus({ storage = getStorage() } = {}) {
  const [pending, failed, unassigned] = await Promise.all([
    storage.countCrmCommunications?.({ contentStates: ['pending'] }) || 0,
    storage.countCrmCommunications?.({ contentStates: ['failed'] }) || 0,
    storage.countCrmCommunications?.({ unassigned: true, direction: 'inbound' }) || 0,
  ]);
  return { pending: Number(pending || 0), failed: Number(failed || 0), unassigned: Number(unassigned || 0) };
}

export function startInboundCommunicationIngestionScheduler({ scheduleTimer = setInterval, intervalMs = ingestionRetryDelayMs } = {}) {
  const timer = scheduleTimer(() => {
    retryPendingInboundIngestion().catch(() => {
      console.warn('[communications:ingestion] retry failed; inspect Operations for bounded status details.');
    });
  }, intervalMs);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); } };
}

export const communicationLimits = {
  maxAddressCount,
  maxAttachmentCount,
  maxAttachmentMetadataBytes,
  maxBodyHtmlLength,
  maxBodyTextLength,
  maxMetadataBytes,
  maxSubjectLength,
  maxWorkflowWarningLength,
};
