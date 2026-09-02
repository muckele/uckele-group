import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import {
  safeCompareText,
  sha256,
  signPayload,
  stableCanonicalJson,
  verifySignedPayload,
} from '../utils/security.js';
import { evaluateCimFollowUpWindow, getCimOutreachPauseStatus, evaluateCimRecipientPolicy } from './cimOpportunityIdentity.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import {
  executeDealHunterCimFollowUpRequest,
  eventMatchesCimRequest,
  reconcileDealHunterApprovedFollowUp,
} from './dealHunter.js';
import {
  buildManualFollowUpCommunicationId,
  buildManualFollowUpMarker,
  getManualFollowUpNumber,
  isOperatorApprovedFollowUpRequest,
  nextManualFollowUpAt,
  projectManualFollowUpState,
} from './dealHunterManualFollowUpPolicy.js';
import { buildDealHunterCimFollowUpEmail } from './delivery.js';
import { getEmailReadiness } from './emailReadiness.js';

export const MANUAL_FOLLOW_UP_PREPARATION_TYPE = 'deal-hunter-manual-follow-up-proposal-v1';

const preparationLifetimeMs = 15 * 60 * 1000;
const replyEventTypes = new Set(['received', 'replied']);
const terminalDeliveryStates = new Set(['bounced', 'failed', 'complained', 'suppressed']);
const ambiguousStates = new Set(['ambiguous', 'unknown', 'provider_unknown', 'provider_ambiguous', 'follow_up_ambiguous']);

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, maximum = 500) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function strictText(value, maximum, label, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid.`);
  const hasUnsafeCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127 || character === '<' || character === '>';
  });
  const normalized = value.replace(/\s+/g, ' ').trim();
  if ((!optional && !normalized) || normalized.length > maximum || hasUnsafeCharacter) {
    throw new TypeError(`${label} must be ${optional ? 'optional ' : ''}plain text of at most ${maximum} characters.`);
  }
  return normalized;
}

function email(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() || '';
}

function formattedSender(sender = {}) {
  const address = email(sender.email);
  const displayName = text(sender.displayName, 120);
  return displayName && address ? `${displayName} <${address}>` : address;
}

function iso(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function normalizeNow(value) {
  const now = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (Number.isNaN(now.getTime())) throw new TypeError('A valid manual follow-up time is required.');
  return now;
}

function strictObject(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} is invalid.`);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`Unknown ${label} field: ${unknown}.`);
}

export function parseManualFollowUpStartInput(input = {}) {
  strictObject(input, new Set(), 'manual follow-up Start input');
  return {};
}

export function parseManualFollowUpStopInput(input = {}) {
  strictObject(input, new Set(['reason']), 'manual follow-up Stop input');
  return Object.hasOwn(input, 'reason')
    ? { reason: strictText(input.reason, 240, 'The Stop reason', { optional: true }) }
    : {};
}

export function parseManualFollowUpPreparationInput(input = {}) {
  strictObject(input, new Set(['greeting']), 'manual follow-up preparation input');
  return Object.hasOwn(input, 'greeting')
    ? { greeting: strictText(input.greeting, 120, 'The greeting') }
    : {};
}

export function parseManualFollowUpApprovalInput(input = {}) {
  strictObject(input, new Set(['preparationToken', 'approvedProposalDigest']), 'manual follow-up approval input');
  if (typeof input.preparationToken !== 'string' || !input.preparationToken.trim() || input.preparationToken.length > 20000) {
    throw new TypeError('A valid manual follow-up preparation token is required.');
  }
  if (typeof input.approvedProposalDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(input.approvedProposalDigest)) {
    throw new TypeError('A valid manual follow-up proposal digest is required.');
  }
  return {
    preparationToken: input.preparationToken.trim(),
    approvedProposalDigest: input.approvedProposalDigest.toLowerCase(),
  };
}

function isAdministrator(session) {
  return session?.role === 'admin' && Boolean(text(session?.principal_id, 300));
}

function publicFailure(code, error, status = 409, extras = {}) {
  return { success: false, status, code, error, ...extras };
}

function activity({ request, actor, eventType, summary, createdAt, metadata = {} }) {
  return {
    id: randomUUID(),
    submission_id: request.submission_id,
    opportunity_id: request.opportunity_id,
    created_at: createdAt,
    actor: actor || 'admin',
    role: 'admin',
    event_type: eventType,
    summary,
    metadata: { cimRequestId: request.id, ...metadata },
  };
}

function communicationFollowUpNumber(communication = {}) {
  return Number(communication?.metadata?.followUpNumber ?? communication?.metadata?.follow_up_number ?? 0);
}

function communicationVersion(communication) {
  if (!communication) return null;
  return {
    id: text(communication.id, 200),
    submissionId: text(communication.submission_id, 200),
    requestId: text(communication.cim_request_id, 200),
    direction: text(communication.direction, 40),
    kind: text(communication.kind, 120),
    followUpNumber: communicationFollowUpNumber(communication),
    idempotencyKey: text(communication.idempotency_key, 300),
    from: text(communication.from_address, 500),
    to: (Array.isArray(communication.to_addresses) ? communication.to_addresses : [communication.to_addresses])
      .map(email).filter(Boolean),
    replyTo: email(communication.reply_to_address),
    deliveryState: text(communication.delivery_state, 80).toLowerCase(),
    providerMessageId: text(communication.provider_message_id, 240),
    occurredAt: iso(communication.occurred_at),
    updatedAt: iso(communication.updated_at || communication.created_at),
    subjectHash: sha256(String(communication.subject || '')),
    textHash: sha256(String(communication.body_text || '')),
    htmlHash: sha256(String(communication.body_html_sanitized || '')),
  };
}

function communicationBelongsToConversation(communication, request) {
  const recipients = (Array.isArray(communication?.to_addresses) ? communication.to_addresses : [communication?.to_addresses])
    .map(email).filter(Boolean);
  return communication?.direction === 'outbound'
    && communication?.cim_request_id === request?.id
    && communication?.submission_id === request?.submission_id
    && recipients.length === 1
    && recipients[0] === email(request?.recipient_email);
}

function acceptedCommunicationProof(communication) {
  if (!communication || communication.direction !== 'outbound') return null;
  const state = text(communication.delivery_state, 80).toLowerCase().replaceAll('_', '-');
  const provider = text(communication.provider, 80).toLowerCase();
  const providerId = text(communication.provider_message_id, 240);
  const accepted = ['accepted', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed', 'replied'].includes(state)
    && (Boolean(providerId) || provider === 'emailjs');
  if (!accepted) return null;
  return {
    acceptedAt: iso(communication.delivery_state_at || communication.updated_at || communication.occurred_at || communication.created_at),
    state,
  };
}

function eventType(event) {
  return text(event?.event_type, 80).toLowerCase().replace(/^email[._-]/, '').replace(/[._-]/g, '_');
}

async function loadRequestEvents(storage, request) {
  const messageIds = [
    request.provider_message_id,
    ...(Array.isArray(request.metadata?.providerMessageIds) ? request.metadata.providerMessageIds : []),
  ].map((value) => text(value, 240)).filter(Boolean);
  const batches = [];
  if (typeof storage.listEmailEvents !== 'function' && typeof storage.listEmailEventsByMessageIds !== 'function') {
    return { available: false, events: [] };
  }
  if (messageIds.length > 0 && storage.listEmailEventsByMessageIds) batches.push(storage.listEmailEventsByMessageIds(messageIds, 1000));
  if (request.recipient_email && storage.listEmailEvents) batches.push(storage.listEmailEvents({ recipientEmail: request.recipient_email, limit: 500 }));
  try {
    return { available: true, events: (await Promise.all(batches)).flat().filter((event) => eventMatchesCimRequest(event, request)) };
  } catch {
    return { available: false, events: [] };
  }
}

function defaultGreeting(authority) {
  const name = text(authority.request?.metadata?.brokerName || authority.submission?.broker_name, 120).split(' ')[0];
  return name ? `Hello ${name},` : 'Hello,';
}

function findInitialCommunication(authority) {
  const requestedId = text(authority.request?.metadata?.initialCommunicationId, 200);
  return authority.communications.find((item) => item.id === requestedId)
    || authority.communications.find((item) => item.cim_request_id === authority.request.id && item.kind === 'deal-hunter-cim-request')
    || null;
}

function findFollowUpCommunication(authority, followUpNumber) {
  const expectedId = buildManualFollowUpCommunicationId({ requestId: authority.request.id, followUpNumber });
  return authority.communications.find((item) => item.id === expectedId)
    || authority.communications.find((item) => item.cim_request_id === authority.request.id && communicationFollowUpNumber(item) === followUpNumber)
    || null;
}

function authorityTerminal(authority) {
  const request = authority.request;
  const marker = objectValue(request?.metadata?.manualFollowUp);
  const states = [request?.status, request?.request_state, request?.delivery_state, request?.follow_up_state]
    .map((value) => text(value, 80).toLowerCase());
  if (authority.replyEvent || request?.responded_at || states.includes('responded')) return { code: 'reply_received', message: 'The broker has replied.' };
  if (authority.materialsState?.materialsReceived) return { code: 'materials_received', message: 'Acquisition materials have been received.' };
  if (authority.materialsState?.advancedBeyondBrokerOutreach) return { code: 'advanced_beyond_broker_outreach', message: 'The opportunity has advanced beyond initial broker-material outreach.' };
  if (authority.passed) return { code: 'opportunity_passed', message: 'The opportunity is currently Passed.' };
  if (text(authority.submission?.status, 80).toLowerCase() === 'archived') return { code: 'crm_archived', message: 'The linked CRM record is archived.' };
  if (authority.suppression) return { code: 'recipient_suppressed', message: 'The durable recipient is globally suppressed.' };
  const initialDeliveryState = text(findInitialCommunication(authority)?.delivery_state, 80).toLowerCase();
  if (!isOperatorApprovedFollowUpRequest(request) && terminalDeliveryStates.has(initialDeliveryState)) {
    return { code: 'terminal_delivery', message: 'The durable initial conversation has a terminal delivery state.' };
  }
  if (terminalDeliveryStates.has(text(request?.delivery_state, 80).toLowerCase())) return { code: 'terminal_delivery', message: 'The durable recipient has a terminal delivery state.' };
  if (marker.stoppedAt || marker.stopped_at || request?.follow_up_state === 'stopped') return { code: 'manual_follow_up_stopped', message: 'Manual follow-ups were stopped.' };
  return null;
}

function hasAmbiguity(authority) {
  const request = authority.request;
  const values = [request?.status, request?.request_state, request?.delivery_state, request?.follow_up_state]
    .map((value) => text(value, 80).toLowerCase());
  const number = getManualFollowUpNumber(request);
  const communication = number ? findFollowUpCommunication(authority, number) : null;
  return values.some((value) => ambiguousStates.has(value))
    || ambiguousStates.has(text(communication?.delivery_state, 80).toLowerCase());
}

function requestBelongsToRoute(authority, opportunityId, requestId) {
  return Boolean(
    authority.request
    && authority.request.id === requestId
    && authority.request.opportunity_id === opportunityId
    && authority.submission
    && authority.request.submission_id === authority.submission.id
    && authority.opportunity?.primary_submission_id === authority.submission.id,
  );
}

export async function loadDealHunterManualFollowUpAuthority({
  opportunityId = '',
  requestId = '',
  storage = getStorage(),
  now = new Date(),
  dependencies = {},
} = {}) {
  const at = normalizeNow(now);
  const canonicalOpportunityId = text(opportunityId, 200);
  const canonicalRequestId = text(requestId, 200);
  const brokerAuthority = await loadBrokerMaterialsAuthority({ opportunityId: canonicalOpportunityId, storage, now: at });
  const requests = Array.isArray(brokerAuthority.requests) ? brokerAuthority.requests : [];
  const request = requests.find((candidate) => candidate?.id === canonicalRequestId)
    || await storage.getDealHunterCimRequestById?.(canonicalRequestId)
    || null;
  const submission = request?.submission_id === brokerAuthority.submission?.id
    ? brokerAuthority.submission
    : request?.submission_id
      ? await storage.getSubmission?.(request.submission_id)
      : null;
  const communications = (Array.isArray(brokerAuthority.communications) ? brokerAuthority.communications : [])
    .filter((item) => !request || item.cim_request_id === request.id);
  if (request && communications.length === 0 && storage.listCrmCommunications) {
    const page = await storage.listCrmCommunications({ submissionId: request.submission_id, page: 1, pageSize: 100 });
    communications.push(...(page?.rows || []).filter((item) => item.cim_request_id === request.id));
  }
  const eventAuthority = request ? await loadRequestEvents(storage, request) : { available: true, events: [] };
  const events = eventAuthority.events;
  const replyEvent = events.find((event) => replyEventTypes.has(eventType(event))) || null;
  const dispositions = Array.isArray(brokerAuthority.dispositions) ? brokerAuthority.dispositions : [];
  const passed = brokerAuthority.currentDispositionState === 'dismissed';
  const suppression = request?.recipient_email
    ? await storage.getActiveEmailSuppression?.(request.recipient_email) || null
    : null;
  const recipientClaim = request?.recipient_email
    ? await storage.getDealHunterCimRecipientClaim?.(request.recipient_email) || null
    : null;
  const getPause = dependencies.getPause || getCimOutreachPauseStatus;
  const getReadiness = dependencies.getReadiness || getEmailReadiness;
  const evaluateRecipient = dependencies.evaluateRecipientPolicy || evaluateCimRecipientPolicy;
  const evaluateWindow = dependencies.evaluateWindow || evaluateCimFollowUpWindow;
  const [pause, readiness, recipientPolicy] = request ? await Promise.all([
    getPause({ storage, config: getConfig() }),
    getReadiness({ storage, config: getConfig() }),
    evaluateRecipient({ recipientEmail: request.recipient_email, opportunityId: canonicalOpportunityId, storage, config: getConfig(), now: at }),
  ]) : [{ paused: false }, { outboundConfigured: false, issues: ['Request authority is unavailable.'] }, { allowed: false, reason: 'invalid-recipient' }];
  const authority = {
    ...brokerAuthority,
    opportunityId: canonicalOpportunityId,
    requestId: canonicalRequestId,
    request,
    submission,
    communications,
    events,
    eventAuthorityAvailable: eventAuthority.available,
    suppressionAuthorityAvailable: !request || typeof storage.getActiveEmailSuppression === 'function',
    recipientClaimAuthorityAvailable: !request || typeof storage.getDealHunterCimRecipientClaim === 'function',
    replyEvent,
    dispositions,
    passed,
    suppression,
    recipientClaim,
    pause,
    readiness,
    recipientPolicy,
    sendWindow: evaluateWindow({
      now: at,
      settings: {
        ...(getConfig().dealHunter?.cimFollowUp || {}),
        weekdaysOnly: true,
        timezone: 'America/Los_Angeles',
      },
    }),
    now: at,
  };
  authority.terminal = request ? authorityTerminal(authority) : null;
  authority.ambiguous = request ? hasAmbiguity(authority) : false;
  return authority;
}

function criticalAuthorityUnavailable(authority) {
  return authority.authorityStatus === 503
    || authority.materialsAuthorityAvailable === false
    || authority.communicationsAuthorityAvailable === false
    || authority.eventAuthorityAvailable === false
    || authority.suppressionAuthorityAvailable === false
    || authority.recipientClaimAuthorityAvailable === false;
}

function currentSendBlockers(authority) {
  const blockers = [];
  if (authority.pause?.paused || authority.safety?.outreach_paused) blockers.push({ code: 'cim_outreach_paused', message: 'Deal Hunter CIM outreach is globally paused.' });
  if (!authority.readiness?.outboundConfigured) blockers.push({ code: 'provider_not_ready', message: text(authority.readiness?.issues?.[0], 500) || 'The outbound provider is not ready.' });
  if (!authority.recipientPolicy?.allowed || authority.recipientPolicy?.override?.id) blockers.push({ code: 'recipient_cadence', message: 'The durable recipient is blocked by the current CIM cadence policy.' });
  if (text(authority.request?.delivery_state, 80).toLowerCase() === 'delayed') blockers.push({ code: 'delivery_delayed', message: 'The preceding message is delayed; wait for authoritative delivery state.' });
  const recipientClaimExpiry = Date.parse(authority.recipientClaim?.expires_at || authority.recipientClaim?.expiresAt || '');
  if (authority.recipientClaim && (!Number.isFinite(recipientClaimExpiry) || recipientClaimExpiry > authority.now.getTime())) {
    blockers.push({ code: 'recipient_send_in_progress', message: 'Another CIM transmission currently holds this recipient.' });
  }
  if (authority.sendWindow && !authority.sendWindow.allowed) blockers.push({ code: authority.sendWindow.reason || 'outside_send_window', message: 'Follow-up transmission is outside the approved weekday send window.' });
  const seen = new Set();
  return blockers.filter(({ code }) => !seen.has(code) && seen.add(code));
}

function projection(authority, extra = {}) {
  return projectManualFollowUpState({
    request: authority.request || {},
    communications: authority.communications,
    authority: {
      terminalReason: authority.terminal?.code || '',
      preparationBlockers: extra.preparationBlockers || [],
      sendBlockers: extra.sendBlockers || currentSendBlockers(authority),
    },
    now: authority.now,
  });
}

function routeFailure() {
  return publicFailure('request_not_found', 'The canonical CIM request does not belong to this opportunity.', 404);
}

function enrollmentFailure(authority) {
  const request = authority.request;
  if (authority.terminal) return publicFailure('blocked', authority.terminal.message);
  if (authority.ambiguous) return publicFailure('outcome_unresolved', 'The current provider outcome must be reconciled before follow-ups can be enrolled.');
  if (request.follow_up_count >= 5) return publicFailure('already_finalized', 'The follow-up sequence is already complete.');
  if (request.metadata?.manualFollowUp || request.next_follow_up_at || !['', 'not-scheduled'].includes(request.follow_up_state || '')) {
    return publicFailure('sequence_already_active', 'This request already has follow-up lifecycle authority.');
  }
  const manualApproval = objectValue(request.metadata?.manualApproval);
  if (manualApproval.intent !== 'manual_stage_1' || manualApproval.followUpPolicy !== 'none') {
    return publicFailure('initial_approval_authority_missing', 'Only an accepted Phase 2 manual request can start this sequence.');
  }
  const initial = findInitialCommunication(authority);
  const previous = Number(request.follow_up_count || 0) > 0
    ? findFollowUpCommunication(authority, Number(request.follow_up_count))
    : initial;
  if (!communicationBelongsToConversation(previous, request) || !acceptedCommunicationProof(previous)) {
    return publicFailure('accepted_proof_missing', 'Durable provider acceptance proof is required before enrollment.');
  }
  return null;
}

export async function startDealHunterManualFollowUps({
  opportunityId = '', requestId = '', input = {}, session = {}, storage = getStorage(), now = new Date(), dependencies = {},
} = {}) {
  try { parseManualFollowUpStartInput(input); } catch (error) { return publicFailure('invalid_start_input', error.message, 400); }
  if (!isAdministrator(session)) return publicFailure('administrator_required', 'Administrator access is required.', 403);
  const authority = await loadDealHunterManualFollowUpAuthority({ opportunityId, requestId, storage, now, dependencies });
  if (!requestBelongsToRoute(authority, text(opportunityId, 200), text(requestId, 200))) return routeFailure(authority);
  if (criticalAuthorityUnavailable(authority)) return publicFailure('authority_unavailable', 'Current follow-up authority could not be verified.', 503);
  const blocked = enrollmentFailure(authority);
  if (blocked) return blocked;
  const count = Number(authority.request.follow_up_count || 0);
  const previous = count > 0 ? findFollowUpCommunication(authority, count) : findInitialCommunication(authority);
  const acceptedAt = acceptedCommunicationProof(previous).acceptedAt;
  const nextFollowUpAt = nextManualFollowUpAt(acceptedAt);
  if (!nextFollowUpAt) return publicFailure('accepted_proof_missing', 'The preceding acceptance time is invalid.');
  const enrolledAt = authority.now.toISOString();
  const marker = buildManualFollowUpMarker({ enrolledAt, enrolledBy: session.username || session.principal_id });
  const result = await storage.startDealHunterManualFollowUps({
    requestId: authority.request.id,
    expectedRequestUpdatedAt: authority.request.updated_at,
    expectedSubmissionId: authority.submission.id,
    expectedSubmissionUpdatedAt: authority.submission.updated_at,
    marker,
    nextFollowUpAt,
    activity: activity({
      request: authority.request,
      actor: session.username || session.principal_id,
      eventType: 'cim.manual-follow-ups-enrolled',
      summary: 'Administrator enrolled the accepted CIM request in human-approved follow-ups.',
      createdAt: enrolledAt,
      metadata: { nextFollowUpAt },
    }),
  });
  if (!result?.applied) return publicFailure('authority_changed', 'Current request authority changed before enrollment.', 409);
  const current = { ...authority, request: result.request, now: authority.now };
  return { success: true, status: 200, canonicalOpportunityId: authority.opportunityId, requestId: authority.request.id, followUps: projection(current) };
}

export async function stopDealHunterManualFollowUps({
  opportunityId = '', requestId = '', reason, input, session = {}, storage = getStorage(), now = new Date(), dependencies = {},
} = {}) {
  let parsed;
  try { parsed = parseManualFollowUpStopInput(input ?? (reason === undefined ? {} : { reason })); } catch (error) { return publicFailure('invalid_stop_input', error.message, 400); }
  if (!isAdministrator(session)) return publicFailure('administrator_required', 'Administrator access is required.', 403);
  const authority = await loadDealHunterManualFollowUpAuthority({ opportunityId, requestId, storage, now, dependencies });
  if (!requestBelongsToRoute(authority, text(opportunityId, 200), text(requestId, 200))) return routeFailure(authority);
  if (!isOperatorApprovedFollowUpRequest(authority.request)) return publicFailure('approval_required', 'This request is not enrolled in manual follow-ups.');
  if (authority.request.follow_up_state === 'completed' || Number(authority.request.follow_up_count) >= 5) return publicFailure('already_finalized', 'The follow-up sequence is complete.');
  if (authority.request.follow_up_state === 'stopped' || authority.request.metadata?.manualFollowUp?.stoppedAt) {
    return { success: true, status: 200, canonicalOpportunityId: authority.opportunityId, requestId: authority.request.id, followUps: projection(authority) };
  }
  const stoppedAt = authority.now.toISOString();
  const actor = session.username || session.principal_id;
  const result = await storage.stopDealHunterManualFollowUps({
    requestId: authority.request.id,
    expectedRequestUpdatedAt: authority.request.updated_at,
    expectedSubmissionId: authority.submission.id,
    expectedSubmissionUpdatedAt: authority.submission.updated_at,
    stoppedAt,
    stoppedBy: actor,
    reason: parsed.reason || '',
    activity: activity({
      request: authority.request,
      actor,
      eventType: 'cim.manual-follow-ups-stopped',
      summary: 'Administrator permanently stopped human-approved follow-ups.',
      createdAt: stoppedAt,
      metadata: { reason: parsed.reason || '' },
    }),
  });
  if (!result?.applied && !result?.alreadyFinalized) return publicFailure('authority_changed', 'Current request authority changed before Stop could be applied.');
  const current = { ...authority, request: result.request || authority.request, now: authority.now };
  return { success: true, status: 200, canonicalOpportunityId: authority.opportunityId, requestId: authority.request.id, followUps: projection(current) };
}

function exactRetryMessage(authority, communication, followUpNumber) {
  return {
    templateVersion: text(communication.metadata?.templateVersion, 160),
    greeting: text(communication.metadata?.manualApproval?.greeting || communication.metadata?.greeting, 120),
    communicationId: communication.id,
    kind: communication.kind,
    idempotencyKey: communication.idempotency_key,
    to: communication.to_addresses,
    replyTo: communication.reply_to_address,
    subject: communication.subject,
    text: communication.body_text,
    html: communication.body_html_sanitized,
    tags: Array.isArray(communication.metadata?.providerTags)
      ? communication.metadata.providerTags.map((tag) => ({ name: text(tag?.name, 80), value: text(tag?.value, 250) }))
        .filter((tag) => tag.name && tag.value)
      : [],
    tracking: {
      source: 'deal-hunter-cim-follow-up',
      dealKey: authority.request.deal_key,
      opportunityId: authority.request.opportunity_id,
      dealName: authority.request.deal_name,
      cimRequestId: authority.request.id,
      submissionId: authority.request.submission_id,
      communicationId: communication.id,
      followUpNumber,
      requestedBy: authority.request.requested_by || '',
    },
  };
}

function proposalForAuthority(authority, { greeting } = {}) {
  const request = authority.request;
  const followUpNumber = getManualFollowUpNumber(request);
  if (!followUpNumber) return null;
  const communicationId = buildManualFollowUpCommunicationId({ requestId: request.id, followUpNumber });
  const currentCommunication = findFollowUpCommunication(authority, followUpNumber);
  const retry = projection(authority).retryEligible;
  let message;
  if (retry) {
    if (!currentCommunication || currentCommunication.id !== communicationId || !['failed', 'bounced', 'complained', 'suppressed'].includes(text(currentCommunication.delivery_state, 80).toLowerCase())) return null;
    message = exactRetryMessage(authority, currentCommunication, followUpNumber);
  } else {
    message = buildDealHunterCimFollowUpEmail({
      to: request.recipient_email,
      request,
      followUpNumber,
      requestedBy: request.requested_by || '',
      communicationId,
      manualFollowUp: { greeting: greeting || defaultGreeting(authority) },
    });
    message = {
      ...message,
      text: String(message.text || '').replace(/\r\n/g, '\n').trim(),
      html: String(message.html || '').replace(/\r\n/g, '\n').trim(),
    };
  }
  const config = getConfig();
  const persistedApproval = objectValue(currentCommunication?.metadata?.manualApproval);
  const sender = retry
    ? {
        displayName: text(persistedApproval.senderDisplayName, 120),
        email: email(persistedApproval.senderEmail),
        replyTo: email(persistedApproval.replyTo),
        from: text(persistedApproval.senderFrom, 500),
      }
    : {
        displayName: text(config.workflow?.defaultAssignee, 120) || 'Mathew Uckele',
        email: email(config.delivery?.resendFromEmail || config.delivery?.fallbackRecipient),
        replyTo: email(message.replyTo),
        from: '',
      };
  if (!sender.from) sender.from = formattedSender(sender);
  if (retry && (
    !sender.displayName
    || !sender.email
    || sender.from !== formattedSender(sender)
    || sender.replyTo !== email(message.replyTo)
    || email(currentCommunication?.from_address) !== sender.email
  )) return null;
  const marker = objectValue(request.metadata?.manualFollowUp);
  const initial = findInitialCommunication(authority);
  const previous = followUpNumber === 1 ? initial : findFollowUpCommunication(authority, followUpNumber - 1);
  const material = {
    canonicalOpportunityId: authority.opportunityId,
    canonicalDealKey: text(authority.score?.deal_key || request.deal_key, 1000),
    canonicalAuthorityRevision: text(authority.authorityRevision, 80),
    aliasResolutionFingerprint: text(authority.aliasResolutionFingerprint, 80),
    requiredAuthorityExpiresAt: iso(authority.requiredAuthorityExpiresAt),
    requestId: request.id,
    requestUpdatedAt: iso(request.updated_at),
    submissionId: authority.submission.id,
    submissionUpdatedAt: iso(authority.submission.updated_at),
    marker: {
      version: text(marker.version, 120), mode: text(marker.mode, 120), cadencePolicy: text(marker.cadencePolicy, 160),
      maximumFollowUps: marker.maximumFollowUps, stoppedAt: iso(marker.stoppedAt || marker.stopped_at),
    },
    followUpCount: Number(request.follow_up_count),
    followUpNumber,
    nextFollowUpAt: iso(request.next_follow_up_at),
    dueEligible: authority.now.getTime() >= Date.parse(request.next_follow_up_at || ''),
    recipientEmail: email(request.recipient_email),
    initialCommunication: communicationVersion(initial),
    previousCommunication: communicationVersion(previous),
    currentCommunication: communicationVersion(currentCommunication),
    requestAuthority: {
      status: text(request.status, 80), requestState: text(request.request_state, 80),
      deliveryState: text(request.delivery_state, 80), followUpState: text(request.follow_up_state, 80),
      respondedAt: iso(request.responded_at),
    },
    terminalAuthority: {
      replyEvent: authority.replyEvent ? { id: text(authority.replyEvent.id, 200), createdAt: iso(authority.replyEvent.created_at) } : null,
      materials: authority.materialsState || {},
      passed: authority.passed,
      archived: text(authority.submission.status, 80).toLowerCase() === 'archived',
      suppressed: Boolean(authority.suppression),
      safety: { paused: Boolean(authority.pause?.paused || authority.safety?.outreach_paused) },
    },
    safetyAuthorityDigest: sha256(stableCanonicalJson({
      pause: Boolean(authority.pause?.paused || authority.safety?.outreach_paused),
      readiness: {
        outboundConfigured: Boolean(authority.readiness?.outboundConfigured),
        provider: text(authority.readiness?.provider, 80),
        issues: (Array.isArray(authority.readiness?.issues) ? authority.readiness.issues : []).map((item) => text(item, 500)),
      },
      recipientPolicy: {
        allowed: Boolean(authority.recipientPolicy?.allowed),
        reason: text(authority.recipientPolicy?.reason, 120),
        touches24Hours: Number(authority.recipientPolicy?.touches24Hours || 0),
        touches30Days: Number(authority.recipientPolicy?.touches30Days || 0),
        cap24Hours: Number(authority.recipientPolicy?.cap24Hours || 0),
        cap30Days: Number(authority.recipientPolicy?.cap30Days || 0),
        overridePresent: Boolean(authority.recipientPolicy?.override?.id),
      },
      recipientClaim: authority.recipientClaim
        ? { present: true, expiresAt: iso(authority.recipientClaim.expires_at || authority.recipientClaim.expiresAt) }
        : { present: false, expiresAt: '' },
      sendWindow: {
        allowed: authority.sendWindow ? Boolean(authority.sendWindow.allowed) : true,
        reason: text(authority.sendWindow?.reason, 120),
      },
    })),
    sender,
    operation: retry ? 'exact-retry' : 'first-attempt',
    message: {
      greeting: text(message.greeting || message.metadata?.greeting, 120),
      subject: message.subject,
      text: message.text,
      html: message.html,
      templateVersion: message.templateVersion,
    },
    communication: {
      id: communicationId,
      providerIdempotencyKey: message.idempotencyKey,
    },
  };
  return { material, message, sender, currentCommunication, retry };
}

function reviewForProposal(authority, proposal) {
  return {
    mode: proposal.retry ? 'exact-retry' : 'first-attempt',
    followUpNumber: proposal.material.followUpNumber,
    dueAt: proposal.material.nextFollowUpAt,
    recipient: { email: proposal.material.recipientEmail, displayName: text(authority.request.metadata?.brokerName, 160) },
    sender: proposal.sender,
    message: {
      greeting: proposal.material.message.greeting,
      greetingEditable: !proposal.retry,
      subject: proposal.material.message.subject,
      body: proposal.material.message.text,
      html: proposal.material.message.html,
      templateVersion: proposal.material.message.templateVersion,
    },
    communication: proposal.material.communication,
  };
}

export async function prepareDealHunterManualFollowUp({
  opportunityId = '', requestId = '', greeting, input, session = {}, storage = getStorage(), now = new Date(), dependencies = {},
} = {}) {
  let parsed;
  try { parsed = parseManualFollowUpPreparationInput(input ?? (greeting === undefined ? {} : { greeting })); } catch (error) { return publicFailure('invalid_preparation_input', error.message, 400); }
  if (!['admin', 'viewer'].includes(session?.role) || !text(session?.principal_id, 300)) {
    return publicFailure('authenticated_access_required', 'Authenticated admin access is required.', 403);
  }
  const authority = await loadDealHunterManualFollowUpAuthority({ opportunityId, requestId, storage, now, dependencies });
  if (!requestBelongsToRoute(authority, text(opportunityId, 200), text(requestId, 200))) return routeFailure(authority);
  if (criticalAuthorityUnavailable(authority)) return publicFailure('authority_unavailable', 'Current follow-up authority could not be verified.', 503);
  if (!isOperatorApprovedFollowUpRequest(authority.request)) return publicFailure('approval_required', 'This request is not enrolled in human-approved follow-ups.');
  if (Number(authority.request.follow_up_count) >= 5 || authority.request.follow_up_state === 'completed') return publicFailure('already_finalized', 'The follow-up sequence is already complete.');
  if (authority.ambiguous) return publicFailure('outcome_unresolved', 'The provider outcome is unresolved. Check status; retransmission is prohibited.');
  if (authority.terminal) return publicFailure('blocked', authority.terminal.message);
  if (!iso(authority.request.next_follow_up_at) || authority.now.getTime() < Date.parse(authority.request.next_follow_up_at)) {
    return publicFailure('not_due', 'This follow-up is not due yet.');
  }
  const state = projection(authority);
  if (!['due', 'overdue', 'retry'].includes(state.state)) return publicFailure('blocked', 'This follow-up is not eligible for review.');
  if (state.retryEligible && Object.hasOwn(parsed, 'greeting')) return publicFailure('retry_message_immutable', 'A retry must use the exact persisted communication.');
  const proposal = proposalForAuthority(authority, { greeting: parsed.greeting });
  if (!proposal) return publicFailure('preparation_authority_missing', 'Exact communication authority is unavailable.');
  const review = reviewForProposal(authority, proposal);
  const sendBlockers = currentSendBlockers(authority);
  if (session.role !== 'admin') {
    return { success: true, status: 200, previewOnly: true, review, followUps: projection(authority, { sendBlockers }), sendBlockers };
  }
  const preparedAt = authority.now.toISOString();
  const maximumExpiry = authority.now.getTime() + preparationLifetimeMs;
  const authorityExpiry = Date.parse(authority.requiredAuthorityExpiresAt || '');
  const expiry = Number.isFinite(authorityExpiry) && authorityExpiry > authority.now.getTime()
    ? Math.min(maximumExpiry, authorityExpiry)
    : maximumExpiry;
  const proposalDigest = sha256(stableCanonicalJson(proposal.material));
  const claims = {
    typ: MANUAL_FOLLOW_UP_PREPARATION_TYPE,
    version: 1,
    administratorPrincipalId: text(session.principal_id, 300),
    canonicalOpportunityId: authority.opportunityId,
    requestId: authority.request.id,
    proposal: proposal.material,
    proposalDigest,
    nonce: randomUUID(),
    preparedAt,
    exp: expiry,
  };
  return {
    success: true,
    status: 200,
    previewOnly: false,
    preparationToken: signPayload(claims, getConfig().admin.sessionSecret),
    proposalDigest,
    preparedAt,
    expiresAt: new Date(expiry).toISOString(),
    review,
    followUps: projection(authority, { sendBlockers }),
    sendBlockers,
  };
}

function decodeAuthenticPreparation(token, secret, now) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { claims: null, expired: false };
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { claims: null, expired: false };
    if (!safeCompareText(signPayload(claims, secret), String(token))) return { claims: null, expired: false };
    if (!Number.isFinite(claims.exp) || claims.exp <= now.getTime()) return { claims: null, expired: true };
    return { claims: verifySignedPayload(token, secret), expired: false };
  } catch {
    return { claims: null, expired: false };
  }
}

function durableResult(authority, request, now) {
  const current = { ...authority, request, now };
  return {
    requestId: request?.id || authority.request?.id || '',
    followUps: projection(current),
  };
}

export async function approveDealHunterManualFollowUp({
  opportunityId = '', requestId = '', preparationToken, approvedProposalDigest, input,
  session = {}, storage = getStorage(), now = new Date(), dependencies = {},
  executeApprovedFollowUp = executeDealHunterCimFollowUpRequest,
} = {}) {
  let parsed;
  try { parsed = parseManualFollowUpApprovalInput(input ?? { preparationToken, approvedProposalDigest }); } catch (error) { return publicFailure('invalid_approval_input', error.message, 400); }
  if (!isAdministrator(session)) return publicFailure('administrator_required', 'Administrator access is required.', 403);
  const at = normalizeNow(now);
  const verified = decodeAuthenticPreparation(parsed.preparationToken, getConfig().admin.sessionSecret, at);
  if (verified.expired) return publicFailure('preparation_stale', 'The manual follow-up preparation expired. Prepare it again.');
  const claims = verified.claims;
  if (claims?.typ !== MANUAL_FOLLOW_UP_PREPARATION_TYPE || claims.version !== 1 || !claims.proposal || typeof claims.proposal !== 'object' || Array.isArray(claims.proposal)) {
    return publicFailure('invalid_preparation', 'The manual follow-up preparation is invalid.', 400);
  }
  const canonicalOpportunityId = text(opportunityId, 200);
  const canonicalRequestId = text(requestId, 200);
  if (!safeCompareText(claims.canonicalOpportunityId, canonicalOpportunityId)
    || !safeCompareText(claims.requestId, canonicalRequestId)
    || !safeCompareText(claims.proposal.canonicalOpportunityId, canonicalOpportunityId)
    || !safeCompareText(claims.proposal.requestId, canonicalRequestId)) {
    return publicFailure('preparation_mismatch', 'The preparation does not match this canonical route.');
  }
  if (!safeCompareText(claims.administratorPrincipalId, text(session.principal_id, 300))) {
    return publicFailure('preparation_mismatch', 'The preparation belongs to a different administrator.', 403);
  }
  let recomputedDigest;
  try { recomputedDigest = sha256(stableCanonicalJson(claims.proposal)); } catch { return publicFailure('invalid_preparation', 'The manual follow-up preparation is invalid.', 400); }
  if (!safeCompareText(claims.proposalDigest, parsed.approvedProposalDigest)
    || !safeCompareText(recomputedDigest, parsed.approvedProposalDigest)) {
    return publicFailure('proposal_digest_mismatch', 'The approved proposal digest does not match the signed preparation.');
  }
  const authority = await loadDealHunterManualFollowUpAuthority({ opportunityId: canonicalOpportunityId, requestId: canonicalRequestId, storage, now: at, dependencies });
  if (!requestBelongsToRoute(authority, canonicalOpportunityId, canonicalRequestId)) return routeFailure(authority);
  if (!isOperatorApprovedFollowUpRequest(authority.request)) return publicFailure('approval_required', 'This request is not enrolled in human-approved follow-ups.');
  const reconciliation = await reconcileDealHunterApprovedFollowUp({
    storage,
    request: authority.request,
    actor: session.username || session.principal_id,
  });
  if (reconciliation?.status === 'sent') {
    return {
      success: true,
      status: 200,
      code: '',
      canonicalOpportunityId,
      requestId: canonicalRequestId,
      durableResult: durableResult(authority, reconciliation.request || authority.request, at),
      error: '',
    };
  }
  if (reconciliation) {
    return publicFailure('outcome_unresolved', 'Provider acceptance is durable, but follow-up reconciliation is still pending.', 503, {
      canonicalOpportunityId,
      requestId: canonicalRequestId,
      durableResult: durableResult(authority, reconciliation.request || authority.request, at),
    });
  }
  if (criticalAuthorityUnavailable(authority)) return publicFailure('authority_unavailable', 'Current follow-up authority could not be verified.', 503);
  if (authority.ambiguous) return publicFailure('outcome_unresolved', 'The provider outcome is unresolved. Check status; retransmission is prohibited.');
  if (authority.terminal) return publicFailure('blocked', authority.terminal.message);
  if (!iso(authority.request.next_follow_up_at) || at.getTime() < Date.parse(authority.request.next_follow_up_at)) return publicFailure('not_due', 'This follow-up is not due yet.');
  const blockers = currentSendBlockers(authority);
  if (blockers.length > 0) return publicFailure('send_blocked', blockers[0].message, 409, { sendBlockers: blockers, followUps: projection(authority, { sendBlockers: blockers }) });
  const proposal = proposalForAuthority(authority, { greeting: claims.proposal.message?.greeting });
  if (!proposal || !safeCompareText(stableCanonicalJson(proposal.material), stableCanonicalJson(claims.proposal))) {
    return publicFailure('preparation_stale', 'Current follow-up authority changed. Prepare and review it again.');
  }
  const approvedContext = {
    type: 'deal-hunter-manual-follow-up-approved-context-v1',
    canonicalOpportunityId,
    canonicalDealKey: proposal.material.canonicalDealKey,
    requestId: canonicalRequestId,
    expectedRequestUpdatedAt: authority.request.updated_at,
    expectedSubmissionId: authority.submission.id,
    expectedSubmissionUpdatedAt: authority.submission.updated_at,
    expectedFollowUpCount: proposal.material.followUpCount,
    followUpNumber: proposal.material.followUpNumber,
    expectedNextFollowUpAt: proposal.material.nextFollowUpAt,
    actor: session.username || session.principal_id,
    sender: proposal.sender,
    message: {
      ...proposal.message,
      from: proposal.sender.from,
      manualApprovalAudit: {
        version: 1,
        greeting: proposal.material.message.greeting,
        approvedBy: session.username || session.principal_id,
        followUpNumber: proposal.material.followUpNumber,
        senderDisplayName: proposal.sender.displayName,
        senderEmail: proposal.sender.email,
        senderFrom: proposal.sender.from,
        replyTo: proposal.sender.replyTo,
      },
    },
  };
  const execution = await executeApprovedFollowUp({ storage, request: authority.request, now: at, approvedContext, dependencies });
  if (!execution || ['approval-required', 'invalid-approved-context'].includes(execution.status)) {
    return publicFailure('execution_rejected', 'The trusted approved follow-up context was rejected.');
  }
  const request = execution.request || await storage.getDealHunterCimRequestById?.(canonicalRequestId) || authority.request;
  const failure = {
    failed: { status: 502, code: 'provider_failed' },
    ambiguous: { status: 503, code: 'outcome_unresolved' },
    deferred: { status: 409, code: 'send_blocked' },
    locked: { status: 409, code: 'authority_changed' },
    stopped: { status: 409, code: 'blocked' },
    responded: { status: 409, code: 'blocked' },
  }[execution.status];
  const publicError = {
    failed: 'The provider did not accept the approved follow-up. A fresh review is required before an exact retry.',
    ambiguous: 'The provider outcome is unresolved. Check current status; retransmission is prohibited.',
    deferred: 'Current safety authority blocks transmission. The original due time was preserved.',
    locked: 'Current follow-up authority changed before transmission.',
    stopped: 'Current terminal authority stopped the follow-up before transmission.',
    responded: 'The broker has replied, so the follow-up was not transmitted.',
  }[execution.status] || '';
  return {
    success: !failure,
    status: failure?.status || 200,
    code: failure?.code || '',
    canonicalOpportunityId,
    requestId: canonicalRequestId,
    durableResult: durableResult(authority, request, at),
    error: publicError,
  };
}
