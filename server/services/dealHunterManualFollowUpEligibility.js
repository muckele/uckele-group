import {
  buildManualFollowUpCommunicationId,
  isOperatorApprovedFollowUpRequest,
  MANUAL_FOLLOW_UP_MAXIMUM,
} from './dealHunterManualFollowUpPolicy.js';

const acceptedDeliveryStates = new Set([
  'accepted', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed', 'replied',
]);
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

function email(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() || '';
}

function iso(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function eventType(event) {
  return text(event?.event_type, 80).toLowerCase().replace(/^email[._-]/, '').replace(/[._-]/g, '_');
}

function blocker(code, message) {
  return { code, message };
}

export function manualFollowUpCommunicationNumber(communication = {}) {
  return Number(communication?.metadata?.followUpNumber
    ?? communication?.metadata?.follow_up_number
    ?? communication?.follow_up_number
    ?? communication?.followUpNumber
    ?? 0);
}

export function manualFollowUpCommunicationBelongsToRequest(communication, request) {
  const recipients = (Array.isArray(communication?.to_addresses) ? communication.to_addresses : [communication?.to_addresses])
    .map(email).filter(Boolean);
  return communication?.direction === 'outbound'
    && communication?.cim_request_id === request?.id
    && communication?.submission_id === request?.submission_id
    && recipients.length === 1
    && recipients[0] === email(request?.recipient_email);
}

function hasProviderAcceptanceProof(communication) {
  if (!communication || communication.direction !== 'outbound') return false;
  const state = text(communication.delivery_state, 80).toLowerCase().replaceAll('_', '-');
  const provider = text(communication.provider, 80).toLowerCase();
  const providerId = text(communication.provider_message_id, 240);
  return acceptedDeliveryStates.has(state) && (Boolean(providerId) || provider === 'emailjs');
}

export function findManualFollowUpInitialCommunication(authority = {}) {
  const request = authority.request || {};
  const communications = Array.isArray(authority.communications) ? authority.communications : [];
  const requestedId = text(request.metadata?.initialCommunicationId, 200);
  return communications.find((item) => item.id === requestedId)
    || communications.find((item) => item.cim_request_id === request.id && item.kind === 'deal-hunter-cim-request')
    || null;
}

export function findManualFollowUpCommunication(authority = {}, followUpNumber) {
  const request = authority.request || {};
  const communications = Array.isArray(authority.communications) ? authority.communications : [];
  const expectedId = buildManualFollowUpCommunicationId({ requestId: request.id, followUpNumber });
  return communications.find((item) => item.id === expectedId)
    || communications.find((item) => item.cim_request_id === request.id
      && manualFollowUpCommunicationNumber(item) === followUpNumber)
    || null;
}

function communicationImmutableAcceptedAt(communication) {
  const metadata = objectValue(communication?.metadata);
  const manual = objectValue(metadata.manualFollowUp);
  const immutable = iso(manual.firstProviderAcceptedAt || metadata.firstProviderAcceptedAt);
  if (immutable) return immutable;
  return text(communication?.delivery_state, 80).toLowerCase() === 'accepted'
    ? iso(communication.delivery_state_at || communication.occurred_at || communication.created_at)
    : '';
}

export function manualFollowUpInitialRequestedAt(request = {}) {
  return iso(request.first_requested_at || request.firstRequestedAt || request.requested_at || request.requestedAt || request.created_at || request.createdAt);
}

export function manualFollowUpPreviousAcceptedAt(authority = {}, followUpNumber) {
  const request = authority.request || {};
  if (!Number.isInteger(followUpNumber) || followUpNumber < 1 || followUpNumber > MANUAL_FOLLOW_UP_MAXIMUM) return '';
  if (followUpNumber === 1) {
    const initial = findManualFollowUpInitialCommunication(authority);
    if (!manualFollowUpCommunicationBelongsToRequest(initial, request) || !hasProviderAcceptanceProof(initial)) return '';
    const requestAcceptedAt = iso(request.first_provider_accepted_at || request.providerAcceptedAt);
    return requestAcceptedAt || communicationImmutableAcceptedAt(initial);
  }

  const priorNumber = followUpNumber - 1;
  const prior = findManualFollowUpCommunication(authority, priorNumber);
  if (!manualFollowUpCommunicationBelongsToRequest(prior, request) || !hasProviderAcceptanceProof(prior)) return '';
  const marker = objectValue(objectValue(request.metadata).manualFollowUp);
  const acceptedTouches = Array.isArray(marker.acceptedTouches) ? marker.acceptedTouches : [];
  const ledgerEntries = acceptedTouches.filter((touch) => Number(touch?.followUpNumber ?? touch?.follow_up_number) === priorNumber);
  if (ledgerEntries.length !== 1) return '';
  const ledger = ledgerEntries[0];
  const expectedId = buildManualFollowUpCommunicationId({ requestId: request.id, followUpNumber: priorNumber });
  if (text(ledger.communicationId || ledger.communication_id, 200) !== expectedId || prior.id !== expectedId) return '';
  const ledgerAcceptedAt = iso(ledger.acceptedAt || ledger.accepted_at);
  const communicationAcceptedAt = communicationImmutableAcceptedAt(prior);
  if (!ledgerAcceptedAt || (communicationAcceptedAt && ledgerAcceptedAt !== communicationAcceptedAt)) return '';
  return ledgerAcceptedAt;
}

export async function loadManualFollowUpRequestEvents(storage, request, eventMatchesRequest) {
  const messageIds = [
    request?.provider_message_id,
    ...(Array.isArray(request?.metadata?.providerMessageIds) ? request.metadata.providerMessageIds : []),
  ].map((value) => text(value, 240)).filter(Boolean);
  if (typeof storage?.listEmailEvents !== 'function' && typeof storage?.listEmailEventsByMessageIds !== 'function') {
    return { available: false, events: [] };
  }
  const reads = [];
  if (messageIds.length > 0 && storage.listEmailEventsByMessageIds) reads.push(storage.listEmailEventsByMessageIds(messageIds, 1000));
  if (request?.recipient_email && storage.listEmailEvents) reads.push(storage.listEmailEvents({ recipientEmail: request.recipient_email, limit: 500 }));
  try {
    const events = (await Promise.all(reads)).flat();
    return {
      available: true,
      events: typeof eventMatchesRequest === 'function' ? events.filter((event) => eventMatchesRequest(event, request)) : events,
    };
  } catch {
    return { available: false, events: [] };
  }
}

export function manualFollowUpTerminalAuthority(authority = {}) {
  const request = authority.request || {};
  const marker = objectValue(request.metadata?.manualFollowUp);
  const states = [request.status, request.request_state, request.delivery_state, request.follow_up_state]
    .map((value) => text(value, 80).toLowerCase());
  const events = Array.isArray(authority.events) ? authority.events : [];
  if (authority.replyEvent || request.responded_at || states.includes('responded')
    || events.some((event) => ['received', 'replied'].includes(eventType(event)))) {
    return blocker('reply_received', 'The broker has replied.');
  }
  if (authority.materialsState?.materialsReceived) return blocker('materials_received', 'Acquisition materials have been received.');
  if (authority.materialsState?.advancedBeyondBrokerOutreach) return blocker('advanced_beyond_broker_outreach', 'The opportunity has advanced beyond initial broker-material outreach.');
  if (authority.passed || authority.currentDispositionState === 'dismissed') return blocker('opportunity_passed', 'The opportunity is currently Passed.');
  if (text(authority.submission?.status, 80).toLowerCase() === 'archived') return blocker('crm_archived', 'The linked CRM record is archived.');
  if (authority.suppression || events.some((event) => ['complained', 'complaint', 'unsubscribed', 'opt_out', 'suppressed'].includes(eventType(event)))) {
    return blocker('recipient_suppressed', 'The durable recipient is globally suppressed.');
  }
  const initialDeliveryState = text(findManualFollowUpInitialCommunication(authority)?.delivery_state, 80).toLowerCase();
  if (!isOperatorApprovedFollowUpRequest(request) && terminalDeliveryStates.has(initialDeliveryState)) {
    return blocker('terminal_delivery', 'The durable initial conversation has a terminal delivery state.');
  }
  if (!isOperatorApprovedFollowUpRequest(request)
    && terminalDeliveryStates.has(text(request.delivery_state, 80).toLowerCase())) {
    return blocker('terminal_delivery', 'The durable recipient has a terminal delivery state.');
  }
  if (marker.stoppedAt || marker.stopped_at || request.follow_up_state === 'stopped') {
    return blocker('manual_follow_up_stopped', 'Manual follow-ups were stopped.');
  }
  return null;
}

export function manualFollowUpHasAmbiguity(authority = {}) {
  const request = authority.request || {};
  const values = [request.status, request.request_state, request.delivery_state, request.follow_up_state]
    .map((value) => text(value, 80).toLowerCase());
  const count = Number(request.follow_up_count ?? request.followUpCount ?? 0);
  const current = Number.isInteger(count) ? findManualFollowUpCommunication(authority, count + 1) : null;
  return values.some((value) => ambiguousStates.has(value))
    || ambiguousStates.has(text(current?.delivery_state, 80).toLowerCase());
}

function result(code, message, failureCode = code, failureStatus = 409) {
  return {
    eligible: false,
    blockers: [blocker(code, message)],
    failure: { code: failureCode, status: failureStatus, message },
    acceptedAt: '',
  };
}

export function evaluateManualFollowUpStartEligibility(authority = {}) {
  const request = authority.request;
  if (!request) return result('request_not_current', 'The canonical CIM request is not current.', 'request_not_found', 404);
  if (authority.routeCurrent === false) {
    return result('request_not_current', 'The canonical CIM request is not current.', 'request_not_found', 404);
  }
  if (authority.authorityAvailable === false) {
    return result('follow_up_authority_unavailable', 'Current follow-up authority could not be verified.', 'authority_unavailable', 503);
  }
  const terminal = authority.terminal || manualFollowUpTerminalAuthority(authority);
  if (terminal) return result(terminal.code, terminal.message, 'blocked');
  if (authority.ambiguous ?? manualFollowUpHasAmbiguity(authority)) {
    return result('outcome_unresolved', 'The current provider outcome must be reconciled before follow-ups can be enrolled.');
  }
  const rawCount = Object.hasOwn(request, 'follow_up_count') ? request.follow_up_count : request.followUpCount;
  const count = rawCount === null || rawCount === undefined ? 0 : rawCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MANUAL_FOLLOW_UP_MAXIMUM) {
    return result('follow_up_authority_invalid', 'Manual follow-up count authority is invalid.', 'authority_unavailable', 503);
  }
  if (count >= MANUAL_FOLLOW_UP_MAXIMUM || request.follow_up_state === 'completed') {
    return result('follow_up_complete', 'The follow-up sequence is already complete.', 'already_finalized');
  }
  const marker = objectValue(request.metadata?.manualFollowUp);
  const followUpState = text(request.follow_up_state || request.followUpState, 80).toLowerCase();
  if (isOperatorApprovedFollowUpRequest(request)) {
    return result('sequence_already_active', 'This request is already enrolled in human-approved follow-ups.', 'sequence_already_active');
  }
  if (Object.keys(marker).length > 0 || count > 0 || request.next_follow_up_at || request.nextFollowUpAt
    || !['', 'not-scheduled'].includes(followUpState)) {
    return result('existing_follow_up_lifecycle', 'An incompatible follow-up lifecycle already owns this request.', 'sequence_already_active');
  }
  const manualApproval = objectValue(request.metadata?.manualApproval);
  if (manualApproval.intent !== 'manual_stage_1' || manualApproval.followUpPolicy !== 'none') {
    return result('initial_approval_authority_missing', 'Only an accepted Phase 2 manual request can start this sequence.');
  }
  const acceptedAt = manualFollowUpPreviousAcceptedAt(authority, 1);
  if (!acceptedAt) {
    return result('accepted_proof_missing', 'Durable provider acceptance proof is required before enrollment.');
  }
  return { eligible: true, blockers: [], failure: null, acceptedAt };
}
