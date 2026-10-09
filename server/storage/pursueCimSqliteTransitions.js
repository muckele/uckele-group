import { createHash } from 'node:crypto';

import { sha256, stableCanonicalJson } from '../utils/security.js';
import { buildCimProviderPayloadDigest } from '../utils/cimProviderPayload.js';
import { evaluateAcquisitionMaterialsState } from '../services/acquisitionMaterials.js';
import { deriveAcceptedCimCadence } from '../services/pursueCimCadence.js';
import { cimFollowUpCapacityWindow } from '../services/pursueCimFollowUpCapacity.js';
import { P10B_QUALIFICATION_WRITER, qualificationReason,
  validateQualificationContract } from '../services/p10bQualificationContract.js';

const cimWriterCapabilities = new Map([
  [P10B_QUALIFICATION_WRITER, 'fl04b-initial'],
  ['pursue-cim-initial', 'fl04b-initial'],
  ['pursue-cim-autopilot-initial', 'fl04b-initial'],
  ['pursue-cim-follow-up', 'fl04c-followup'],
  ['pursue-cim-autopilot-follow-up', 'fl04c-followup'],
  ['pursue-cim-batch', 'fl04c-batch'],
  ['pursue-cim-autopilot-batch', 'fl04c-batch'],
]);

function qualificationBound(database, qualification, { transmission, authorization, now }) {
  if (!transmission || !qualification
    || database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions').get().count !== 1
    || database.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_cim_live_provider_authorizations
      WHERE writer_path = ?`).get(P10B_QUALIFICATION_WRITER).count > 1) return false;
  const communication = database.prepare('SELECT * FROM crm_communications WHERE id = ?')
    .get(transmission.communication_id);
  const activation = currentActivationChain(database, 'fl04b-initial', now);
  const enrollment = activation ? database.prepare(`SELECT * FROM deal_hunter_cim_capability_activations
    WHERE id = ?`).get(activation.prerequisite_activation_id) : null;
  if (activation?.prerequisite_evidence_hash !== qualification.manifest?.ownerPermissionDigest
    || enrollment?.prerequisite_evidence_hash !== qualification.manifest?.ownerPermissionDigest) return false;
  return Boolean(communication && validateQualificationContract({ ...qualification,
    transmission, communication, authorization, now }).valid);
}

function qualificationInboundAuthority(database, command) {
  try {
    const now = requiredInstant(command.now);
    const authorizations = database.prepare(`SELECT * FROM deal_hunter_cim_live_provider_authorizations
      WHERE writer_path=?`).all(P10B_QUALIFICATION_WRITER);
    const authorization = authorizations[0];
    const transmission = authorization && database.prepare(`SELECT * FROM deal_hunter_cim_transmissions
      WHERE id=?`).get(authorization.transmission_id);
    const pause = database.prepare("SELECT * FROM deal_hunter_cim_safety_settings WHERE id='global'").get();
    const from = 'P10B Sender <sender@p10b-e2e.uckelegroup.com>';
    const owner = 'mathew@uckelegroup.com';
    if (authorizations.length !== 1 || !authorization.consumed_at || authorization.withdrawn_at
      || authorization.provider_profile !== 'controlled-mailbox-v1'
      || authorization.maximum_calls !== 1 || authorization.issued_at > now || authorization.expires_at <= now
      || !/^p10b-first-mailbox-qualification-v1:[0-9a-f]{64}$/.test(authorization.reason || '')
      || currentActivationChain(database, 'fl04b-initial', now)?.id !== authorization.activation_id
      || pause?.outreach_paused !== 1 || transmission?.state !== 'accepted'
      || transmission.provider !== 'resend' || transmission.invocation_authority_count !== 1
      || transmission.payload_digest !== authorization.payload_digest || transmission.from_address !== from
      || stableCanonicalJson(JSON.parse(transmission.to_addresses)) !== stableCanonicalJson([owner])
      || transmission.cc_addresses !== '[]' || transmission.bcc_addresses !== '[]'
      || !/^cim-[a-z0-9-]{1,32}@p10b-e2e\.uckelegroup\.com$/.test(transmission.reply_to_address)
      || database.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions').get().count !== 1
      || (command.authorizationId && command.authorizationId !== authorization.id)) return { allowed: false };
    if (command.type === 'email.delivered') {
      return { allowed: command.from === from && command.providerMessageId === transmission.provider_message_id
        && stableCanonicalJson(command.to) === stableCanonicalJson([owner]), authorizationId: authorization.id };
    }
    if (command.type !== 'email.received' || command.from !== owner
      || stableCanonicalJson(command.to) !== stableCanonicalJson([transmission.reply_to_address])) return { allowed: false };
    const attempts = database.prepare(`SELECT * FROM crm_communications
      WHERE direction='inbound' AND content_attempt_count>0`).all();
    if (attempts.length > 1 || (attempts.length === 1
      && (attempts[0].provider !== 'resend' || attempts[0].provider_message_id !== command.providerMessageId
        || (command.providerEventId && attempts[0].source_event_id !== command.providerEventId)
        || (command.communicationId && attempts[0].id !== command.communicationId)))) return { allowed: false };
    return { allowed: true, authorizationId: authorization.id, attempted: attempts.length === 1 };
  } catch { return { allowed: false }; }
}
const pursueCimContainmentFindingCodes = new Set([
  'duplicate_provider_identity', 'missing_durable_authority', 'multiple_active_campaigns',
  'duplicate_accepted_touch', 'active_identity_ambiguity', 'unexpected_legacy_invocation',
  'terminal_evidence_before_provider_call', 'invalid_claimed_timezone',
  'expired_activation_attempt', 'missing_live_envelope',
  'inbound_or_reconciliation_readiness_loss', 'shadow_provider_call',
]);
const pursueCimBoundaryRejectionCodes = new Set([
  'cim-provider-seam-unauthorized', 'cim-provider-work-mismatch',
  'cim-provider-seam-already-entered', 'cim-provider-writer-path-mismatch',
  'cim-provider-profile-mismatch', 'cim-provider-nonce-invalid',
  'cim-provider-payload-mismatch',
]);

function digest(...parts) {
  const framed = parts.map((part) => {
    const value = JSON.stringify(part);
    return [Buffer.byteLength(value), value];
  });
  return createHash('sha256').update(JSON.stringify(framed)).digest('hex');
}

function canonicalDigest(value) {
  return sha256(stableCanonicalJson(value));
}

function authorityDigestMatches(authority) {
  if (!authority || typeof authority !== 'object'
    || !/^[0-9a-f]{64}$/.test(authority.authorityDigest ?? '')) return false;
  const { authorityDigest, ...canonical } = authority;
  return canonicalDigest(canonical) === authorityDigest;
}

function brokerAuthorityBlockedReason(authority) {
  const blockers = Array.isArray(authority?.preparationBlockerCodes)
    ? authority.preparationBlockerCodes : [];
  if (authority?.priorRequestPresent
    || blockers.some((code) => ['existing_request', 'existing_request_claim'].includes(code))) {
    return 'lifecycle_conflict';
  }
  if (authority?.pursued !== true || authority?.disposition === 'dismissed'
    || blockers.some((code) => ['pursue_not_current', 'not_pursued',
      'opportunity_passed'].includes(code))) return 'owner_intent_changed';
  if (authority?.suppressionPresent
    || blockers.some((code) => code === 'recipient_suppressed')) return 'recipient_suppressed';
  if (authority?.materialsReceived || authority?.advancedBeyondBrokerOutreach
    || blockers.some((code) => ['materials_received', 'already_received'].includes(code))) {
    return 'materials_received';
  }
  if (authority?.terminalReason) return 'terminal_authority_changed';
  return blockers.length > 0 ? 'source_authority_unavailable' : null;
}

function safeCanonicalDigest(value) {
  try { return canonicalDigest(value); } catch { return ''; }
}

function requiredText(value, name, maximum = 240) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new Error(`${name} must be bounded, non-empty, and unpadded`);
  }
  return value;
}

function requiredProvider(value) {
  if (value !== 'resend') throw new Error('Provider outcome must use the approved Resend adapter');
  return value;
}

function requiredProviderMessageId(value) {
  const identity = requiredText(value, 'providerMessageId');
  if (!/^[A-Za-z0-9_.:@-]+$/.test(identity)) throw new Error('Invalid providerMessageId');
  return identity;
}

function requiredRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function requiredInstant(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('now must be an ISO instant');
  return value;
}

function canonicalInstant(value) {
  return new Date(requiredInstant(value)).toISOString();
}

function boundedInboundEvidenceList(value, name, maximum = 50, itemMaximum = 500) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} must be a bounded array`);
  }
  const normalized = value.map((item) => requiredText(item, name, itemMaximum));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${name} must not contain duplicates`);
  }
  return normalized;
}

function cadenceContext(database, transmissionId) {
  const transmission = database.prepare(`SELECT * FROM deal_hunter_cim_transmissions
    WHERE id = ?`).get(transmissionId) ?? null;
  if (!transmission) return null;
  const rows = database.prepare(`
    SELECT m.transmission_id, m.touch_id, m.opportunity_id, m.campaign_id,
      m.display_ordinal, m.cancelled_at, m.cancellation_reason
    FROM deal_hunter_cim_transmission_touches m
    WHERE m.transmission_id = ? ORDER BY m.touch_id
  `).all(transmissionId);
  const members = rows.map((membership) => {
    const touch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
      WHERE id = ?`).get(membership.touch_id) ?? null;
    const campaign = database.prepare(`SELECT * FROM deal_hunter_cim_campaigns
      WHERE id = ?`).get(membership.campaign_id) ?? null;
    const timezone = campaign ? database.prepare(`SELECT *
      FROM deal_hunter_opportunity_timezone_revisions
      WHERE opportunity_id = ? AND revision = ?`).get(
      campaign.opportunity_id, campaign.timezone_revision) ?? null : null;
    return { membership, touch, campaign, timezone };
  });
  let nextTouch = null;
  if (transmission.state === 'accepted' && members.length === 1 && members[0].touch) {
    nextTouch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
      WHERE campaign_id = ? AND ordinal = ? ORDER BY id LIMIT 1`).get(
      members[0].touch.campaign_id, members[0].touch.ordinal + 1) ?? null;
  }
  return { transmission, members, nextTouch };
}

function withinLocalSendWindow(now, timezone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
    const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
    return !['Sat', 'Sun'].includes(parts.weekday)
      && minuteOfDay >= 8 * 60 && minuteOfDay < 17 * 60;
  } catch {
    return false;
  }
}

function appendAudit(database, event) {
  const conflict = event.ignore ? 'OR IGNORE ' : '';
  database.prepare(`
    INSERT ${conflict}INTO deal_hunter_cim_audit_events (
      id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
      transmission_id, activation_id, authorization_id, prior_state, next_state,
      reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata
    ) VALUES (
      @id, @eventType, @opportunityId, @campaignId, @conversationId, @touchId,
      @transmissionId, @activationId, @authorizationId, @priorState, @nextState,
      @reasonCode, @authorityDigest, @payloadDigest, @actor, @source, @occurredAt, @metadata
    )
  `).run({
    id: event.id ?? digest('cim-audit:v1', event.eventType, event.authorityId),
    eventType: event.eventType,
    opportunityId: event.opportunityId ?? null,
    campaignId: event.campaignId ?? null,
    conversationId: event.conversationId ?? null,
    touchId: event.touchId ?? null,
    transmissionId: event.transmissionId ?? null,
    activationId: event.activationId ?? null,
    authorizationId: event.authorizationId ?? null,
    priorState: event.priorState ?? null,
    nextState: event.nextState ?? null,
    reasonCode: event.reasonCode ?? null,
    authorityDigest: event.authorityDigest ?? null,
    payloadDigest: event.payloadDigest ?? null,
    actor: event.actor,
    source: event.source ?? 'sqlite-transition',
    occurredAt: event.occurredAt,
    metadata: JSON.stringify(event.metadata ?? {}),
  });
}

function cancelPreparedTransmission(database, transmission, { now, reasonCode, actor,
  preserveClaim = false }) {
  if (!['prepared', 'final-gate-blocked'].includes(transmission.state)
    || transmission.invocation_authority_count !== 0) return false;
  const members = database.prepare(`
    SELECT m.touch_id, m.campaign_id, m.opportunity_id, t.row_version
    FROM deal_hunter_cim_transmission_touches m
    JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
    WHERE m.transmission_id = ? AND m.cancelled_at IS NULL
  `).all(transmission.id);
  for (const member of members) {
    database.prepare(`
      UPDATE deal_hunter_cim_transmission_touches SET cancelled_at = ?, cancellation_reason = ?
      WHERE transmission_id = ? AND touch_id = ? AND cancelled_at IS NULL
    `).run(now, reasonCode, transmission.id, member.touch_id);
    database.prepare(`
      UPDATE deal_hunter_cim_campaign_touches SET transmission_id = NULL,
        state = ?, terminal_reason = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND transmission_id = ? AND row_version = ?
    `).run(preserveClaim ? 'claimed' : 'cancelled-before-provider',
      preserveClaim ? null : reasonCode, now, member.touch_id, transmission.id, member.row_version);
    appendAudit(database, { eventType: 'transmission-membership-cancelled',
      authorityId: `${transmission.id}:${member.touch_id}`, opportunityId: member.opportunity_id,
      campaignId: member.campaign_id, touchId: member.touch_id, transmissionId: transmission.id,
      priorState: 'active', nextState: 'cancelled', reasonCode, actor, occurredAt: now });
  }
  database.prepare(`UPDATE deal_hunter_cim_transmissions SET state = 'cancelled-before-provider',
    row_version = row_version + 1, updated_at = ? WHERE id = ? AND state IN ('prepared', 'final-gate-blocked')
    AND invocation_authority_count = 0`).run(now, transmission.id);
  database.prepare(`UPDATE crm_email_outbox SET state = 'cancelled', updated_at = ?
    WHERE id = ? AND state IN ('prepared', 'final-gate-blocked')`).run(now, transmission.outbox_id);
  const authorizations = database.prepare(`SELECT id FROM deal_hunter_cim_live_provider_authorizations
    WHERE transmission_id = ? AND consumed_at IS NULL AND withdrawn_at IS NULL`).all(transmission.id);
  for (const authorization of authorizations) {
    database.prepare(`UPDATE deal_hunter_cim_live_provider_authorizations SET withdrawn_at = ?
      WHERE id = ? AND consumed_at IS NULL AND withdrawn_at IS NULL`).run(now, authorization.id);
    appendAudit(database, { eventType: 'authorization-withdrawn', authorityId: authorization.id,
      transmissionId: transmission.id, authorizationId: authorization.id, priorState: 'issued',
      nextState: 'withdrawn', reasonCode, actor, occurredAt: now });
  }
  appendAudit(database, { eventType: 'transmission-cancelled', authorityId: transmission.id,
    transmissionId: transmission.id, priorState: transmission.state,
    nextState: 'cancelled-before-provider', reasonCode, actor, occurredAt: now });
  return true;
}

const activationPredecessor = Object.freeze({
  'fl04a-safety': null,
  'fl04b-enrollment': 'fl04a-safety',
  'fl04b-initial': 'fl04b-enrollment',
  'fl04c-followup': 'fl04b-initial',
  'fl04c-batch': 'fl04c-followup',
});

function currentActivationChain(database, capability, now) {
  const activation = database.prepare(`
    SELECT * FROM deal_hunter_cim_capability_activations
    WHERE capability = ? AND status = 'current'
  `).get(capability);
  if (!activation || ['off', 'shadow'].includes(activation.mode)
    || (activation.expires_at && activation.expires_at <= now)) return null;
  const predecessor = activationPredecessor[capability];
  if (!predecessor) return activation;
  const parent = currentActivationChain(database, predecessor, now);
  return parent && activation.prerequisite_activation_id === parent.id
    && activation.prerequisite_evidence_id && activation.prerequisite_evidence_hash
    ? activation : null;
}

const campaignTransitions = Object.freeze({
  queued: ['waiting-on-eligibility', 'initial-pending', 'action-required', 'stopped'],
  'waiting-on-eligibility': ['queued', 'initial-pending', 'action-required', 'stopped'],
  'initial-pending': ['active-follow-up', 'action-required', 'responded',
    'materials-received', 'stopped', 'provider-ambiguous'],
  'active-follow-up': ['active-follow-up', 'action-required', 'responded',
    'materials-received', 'stopped', 'expired', 'provider-ambiguous'],
  'action-required': ['queued', 'waiting-on-eligibility', 'initial-pending',
    'action-required', 'responded', 'materials-received', 'stopped'],
  'provider-ambiguous': ['action-required', 'responded', 'materials-received', 'stopped'],
  responded: [], 'materials-received': [], stopped: [], expired: [],
});

const conversationTransitions = Object.freeze({
  open: ['reply-review-required', 'responded', 'stopped', 'provider-ambiguous', 'closed'],
  'reply-review-required': ['responded', 'stopped', 'open'],
  'provider-ambiguous': [],
  responded: [], stopped: [], closed: [],
});

function deterministicUuid(...parts) {
  const value = digest(...parts);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function createPursueCimSqliteTransitions(database, {
  applyPass, readCrmMatchAuthorityFingerprint, executionClock,
} = {}) {
  const executionInstant = () => {
    const instant = new Date(executionClock ? executionClock() : Date.now());
    if (!Number.isFinite(instant.getTime())) throw new Error('Invalid CIM execution clock');
    return instant.toISOString();
  };
  const transitions = {
    async readPursuitEnrollmentAuthority({ opportunityId, now }) {
      const id = requiredText(opportunityId, 'opportunityId', 200);
      const at = requiredInstant(now);
      return {
        timezone: database.prepare(`SELECT * FROM deal_hunter_opportunity_timezone_revisions
          WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1`).get(id) ?? null,
        activation: currentActivationChain(database, 'fl04b-enrollment', at),
        globalAuthorityRevision: database.prepare(`SELECT revision FROM deal_hunter_cim_global_authority
          WHERE id = 'global'`).get()?.revision,
      };
    },
    async getPursueCimBrokerConversation(id) {
      const conversationId = requiredText(id, 'conversationId');
      return database.prepare(`SELECT * FROM deal_hunter_broker_conversations
        WHERE id = ?`).get(conversationId) ?? null;
    },
    async getPursueCimLiveProviderAuthorization(transmissionId) {
      const id = requiredText(transmissionId, 'transmissionId');
      return database.prepare(`SELECT * FROM deal_hunter_cim_live_provider_authorizations
        WHERE transmission_id = ? ORDER BY issued_at DESC, id DESC LIMIT 1`).get(id) ?? null;
    },
    async withdrawCimCapabilityActivation(command) {
      const id = requiredText(command.id, 'id');
      const actor = requiredText(command.actor, 'actor', 200);
      const reason = requiredText(command.reason, 'reason', 160);
      const now = requiredInstant(command.now);
      return database.transaction(() => {
        const activation = database.prepare('SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?').get(id);
        if (!activation) return { applied: false, replay: false, conflict: true, activation: null };
        if (activation.status === 'withdrawn') return { applied: false, replay: true, conflict: false, activation };
        if (activation.status !== 'current') return { applied: false, replay: false, conflict: true, activation };
        database.prepare(`UPDATE deal_hunter_cim_capability_activations SET status = 'withdrawn',
          withdrawn_at = ?, updated_at = ? WHERE id = ? AND status = 'current'`).run(now, now, id);
        appendAudit(database, { eventType: 'capability-withdrawn', authorityId: id,
          activationId: id, priorState: 'current', nextState: 'withdrawn', reasonCode: reason,
          actor, occurredAt: now });
        return { applied: true, replay: false, conflict: false,
          activation: database.prepare('SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?').get(id) };
      }).immediate();
    },
    async withdrawCimLiveProviderAuthorization(command) {
      const id = requiredText(command.id, 'id');
      const actor = requiredText(command.actor, 'actor', 200);
      const reason = requiredText(command.reason, 'reason', 160);
      const now = requiredInstant(command.now);
      return database.transaction(() => {
        const authorization = database.prepare('SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?').get(id);
        if (!authorization) return { applied: false, replay: false, conflict: true, authorization: null };
        if (authorization.withdrawn_at) return { applied: false, replay: true, conflict: false, authorization };
        if (authorization.consumed_at || authorization.expires_at <= now) {
          return { applied: false, replay: false, conflict: true, authorization };
        }
        const transmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?')
          .get(authorization.transmission_id);
        if (!cancelPreparedTransmission(database, transmission, { now, reasonCode: reason, actor })) {
          return { applied: false, replay: false, conflict: true, authorization };
        }
        return { applied: true, replay: false, conflict: false,
          authorization: database.prepare('SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?').get(id) };
      }).immediate();
    },
    async readPursueCimProjection({ opportunityId }) {
      requiredText(opportunityId, 'opportunityId', 200);
      const decision = database.prepare(`
        SELECT * FROM deal_hunter_owner_decision_events WHERE opportunity_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(opportunityId) ?? null;
      const enrollment = database.prepare(`
        SELECT * FROM deal_hunter_pursuit_enrollments WHERE opportunity_id = ?
          AND state <> 'superseded' ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(opportunityId) ?? null;
      const campaign = database.prepare(`
        SELECT * FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?
        ORDER BY generation DESC LIMIT 1
      `).get(opportunityId) ?? null;
      const initialTouch = campaign ? database.prepare(`
        SELECT * FROM deal_hunter_cim_campaign_touches
        WHERE campaign_id = ? AND logical_slot = 'initial'
      `).get(campaign.id) ?? null : null;
      const transmission = campaign ? database.prepare(`
        SELECT tr.* FROM deal_hunter_cim_transmissions tr
        JOIN deal_hunter_cim_transmission_touches m ON m.transmission_id = tr.id
        JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
        WHERE t.campaign_id = ? ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1
      `).get(campaign.id) ?? null : null;
      const legacySummary = database.prepare(`
        SELECT COUNT(*) AS count,
          SUM(CASE WHEN delivery_state = 'accepted' THEN 1 ELSE 0 END) AS accepted,
          SUM(CASE WHEN delivery_state = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous
        FROM deal_hunter_cim_requests WHERE opportunity_id = ?
      `).get(opportunityId);
      return { decision, enrollment, campaign, initialTouch, transmission,
        legacySummary: { count: legacySummary.count, accepted: legacySummary.accepted ?? 0,
          ambiguous: legacySummary.ambiguous ?? 0 }, actions: [] };
    },
    async resolvePursueCimInboundEvidence(command = {}) {
      const replyToAddresses = boundedInboundEvidenceList(
        command.replyToAddresses, 'replyToAddresses', 20, 320);
      const provider = requiredProvider(command.provider);
      const providerMessageIds = boundedInboundEvidenceList(
        command.providerMessageIds, 'providerMessageIds', 20, 240);
      const rfcMessageIds = boundedInboundEvidenceList(
        command.rfcMessageIds, 'rfcMessageIds', 50, 500);
      const taggedTouchIds = boundedInboundEvidenceList(
        command.taggedTouchIds, 'taggedTouchIds', 50, 240);
      const taggedConversationId = command.taggedConversationId
        ? requiredText(command.taggedConversationId, 'taggedConversationId') : '';
      const taggedTransmissionId = command.taggedTransmissionId
        ? requiredText(command.taggedTransmissionId, 'taggedTransmissionId') : '';
      const candidates = new Map();
      let invalidProtectedEvidence = false;
      const addCandidate = (row, method) => {
        if (!row?.conversation_id) return;
        const current = candidates.get(row.conversation_id) || {
          conversationId: row.conversation_id, transmission: null, methods: new Set(),
        };
        current.methods.add(method);
        if (row.transmission_id && (!current.transmission
          || row.transmission_id === taggedTransmissionId)) {
          current.transmission = database.prepare(`SELECT *
            FROM deal_hunter_cim_transmissions WHERE id = ?`).get(row.transmission_id) ?? null;
        }
        candidates.set(row.conversation_id, current);
      };
      for (const address of replyToAddresses) {
        for (const row of database.prepare(`
          SELECT id AS transmission_id, conversation_id
          FROM deal_hunter_cim_transmissions WHERE lower(reply_to_address) = lower(?)
          ORDER BY updated_at DESC, id DESC
        `).all(address)) addCandidate(row, 'reply-alias');
      }
      for (const providerMessageId of providerMessageIds) {
        for (const row of database.prepare(`
          SELECT id AS transmission_id, conversation_id
          FROM deal_hunter_cim_transmissions
          WHERE provider = ? AND provider_message_id = ?
          ORDER BY updated_at DESC, id DESC
        `).all(provider, providerMessageId)) addCandidate(row, 'provider-message');
      }
      for (const messageId of rfcMessageIds) {
        for (const row of database.prepare(`
          SELECT tr.id AS transmission_id, tr.conversation_id
          FROM crm_communications AS communication
          JOIN deal_hunter_cim_transmissions AS tr
            ON tr.communication_id = communication.id
          WHERE communication.message_id = ?
          ORDER BY tr.updated_at DESC, tr.id DESC
        `).all(messageId)) addCandidate(row, 'rfc-thread');
      }
      if (taggedTransmissionId) {
        const row = database.prepare(`SELECT id AS transmission_id, conversation_id
          FROM deal_hunter_cim_transmissions WHERE id = ?`).get(taggedTransmissionId);
        if (row) addCandidate(row, 'protected-tag');
        else invalidProtectedEvidence = true;
      }
      if (taggedConversationId) {
        const row = database.prepare(`SELECT id AS conversation_id
          FROM deal_hunter_broker_conversations WHERE id = ?`).get(taggedConversationId);
        if (row) addCandidate(row, 'protected-tag');
        else invalidProtectedEvidence = true;
      }
      if (taggedTouchIds.length > 0) {
        const placeholders = taggedTouchIds.map(() => '?').join(',');
        const rows = database.prepare(`
          SELECT t.id AS touch_id, c.conversation_id
          FROM deal_hunter_cim_campaign_touches AS t
          JOIN deal_hunter_cim_campaigns AS c ON c.id = t.campaign_id
          WHERE t.id IN (${placeholders}) ORDER BY t.id
        `).all(...taggedTouchIds);
        if (rows.length !== taggedTouchIds.length) invalidProtectedEvidence = true;
        for (const row of rows) addCandidate(row, 'protected-tag');
      }
      if (candidates.size > 50) {
        throw new Error('Pursue CIM inbound evidence exceeds the bounded candidate set');
      }
      const candidateConversations = Array.from(candidates.keys()).sort()
        .map((conversationId) => database.prepare(`SELECT *
          FROM deal_hunter_broker_conversations WHERE id = ?`).get(conversationId) ?? null)
        .filter(Boolean);
      if (invalidProtectedEvidence || candidates.size > 1) {
        return { exact: false, ambiguous: true, method: 'conflicting-exact-evidence',
          conversation: null, transmission: null, campaignIds: [], touchIds: [],
          candidateConversations };
      }
      if (candidates.size === 0) {
        return { exact: false, ambiguous: false, method: 'none', conversation: null,
          transmission: null, campaignIds: [], touchIds: [], candidateConversations: [] };
      }
      const candidate = candidates.values().next().value;
      const conversation = database.prepare(`SELECT * FROM deal_hunter_broker_conversations
        WHERE id = ?`).get(candidate.conversationId) ?? null;
      if (!conversation) {
        return { exact: false, ambiguous: true, method: 'conflicting-exact-evidence',
          conversation: null, transmission: null, campaignIds: [], touchIds: [],
          candidateConversations: [] };
      }
      const campaignIds = database.prepare(`SELECT id FROM deal_hunter_cim_campaigns
        WHERE conversation_id = ? ORDER BY id`).all(conversation.id).map(({ id }) => id);
      const touchIds = database.prepare(`
        SELECT t.id FROM deal_hunter_cim_campaign_touches AS t
        JOIN deal_hunter_cim_campaigns AS c ON c.id = t.campaign_id
        WHERE c.conversation_id = ? ORDER BY t.id
      `).all(conversation.id).map(({ id }) => id);
      const methodOrder = ['reply-alias', 'provider-message', 'rfc-thread', 'protected-tag'];
      const method = methodOrder.find((value) => candidate.methods.has(value)) || 'protected-tag';
      return { exact: true, ambiguous: false, method, conversation,
        transmission: candidate.transmission, campaignIds, touchIds,
        candidateConversations: [] };
    },
    async readCimQualificationTerminalEvidence({ conversationId, providerEventId } = {}) {
      if (!conversationId || !providerEventId) return null;
      return database.prepare(`SELECT * FROM deal_hunter_cim_terminal_events
        WHERE scope = 'conversation' AND scope_id = ? AND evidence_id = ?
          AND reason_code = 'reply_received' ORDER BY revision DESC LIMIT 1`)
        .get(requiredText(conversationId, 'conversationId'), requiredText(providerEventId, 'providerEventId')) ?? null;
    },
    readCimQualificationInboundAuthority(command) {
      return qualificationInboundAuthority(database, command);
    },
    async claimCimQualificationInboundRead(command) {
      return database.transaction(() => {
        const authority = qualificationInboundAuthority(database, command);
        if (!authority.allowed || authority.attempted) return { claimed: false };
        const result = database.prepare(`UPDATE crm_communications SET content_attempt_count=1,
          content_next_attempt_at=NULL WHERE id=? AND direction='inbound' AND provider='resend'
          AND provider_message_id=? AND source_event_id=? AND content_attempt_count=0`)
          .run(command.communicationId, command.providerMessageId, command.providerEventId);
        return { claimed: result.changes === 1, authorizationId: authority.authorizationId };
      }).immediate();
    },
    async readCimCadenceContext({ transmissionId } = {}) {
      return cadenceContext(database, requiredText(transmissionId, 'transmissionId'));
    },
    async reconcileCimTransmission(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const payloadDigest = requiredText(command.payloadDigest, 'payloadDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(payloadDigest)) throw new Error('Invalid reconciliation payload digest');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const outcomeState = requiredText(command.outcome, 'outcome', 40);
      if (!['accepted', 'definitive-failure', 'ambiguous'].includes(outcomeState)) {
        throw new Error('Reconciliation requires a bounded provider outcome');
      }
      const provider = requiredProvider(command.provider);
      const providerMessageId = command.providerMessageId ?? null;
      if (outcomeState === 'accepted') requiredProviderMessageId(providerMessageId);
      else if (providerMessageId !== null) requiredProviderMessageId(providerMessageId);
      if (outcomeState === 'ambiguous' && providerMessageId !== null) {
        throw new Error('Ambiguous reconciliation cannot select a provider identity');
      }
      const providerResultCode = requiredText(command.providerResultCode, 'providerResultCode', 160);
      const evidenceType = requiredText(command.evidenceType, 'evidenceType', 120);
      const evidenceId = requiredText(command.evidenceId, 'evidenceId');
      const evidenceDigest = requiredText(command.evidenceDigest, 'evidenceDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) throw new Error('Invalid reconciliation evidence digest');
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      const observedAt = canonicalInstant(command.observedAt ?? command.now);
      const providerIdentities = command.providerIdentities ?? [];
      if (!Array.isArray(providerIdentities) || providerIdentities.length > 20) {
        throw new Error('Provider reconciliation identities must be a bounded array');
      }
      const normalizedIdentities = providerIdentities.map((identity) => {
        if (!identity || typeof identity !== 'object' || Array.isArray(identity)
          || Object.keys(identity).sort().join(',')
            !== 'evidenceDigest,evidenceId,provider,providerMessageId'
          || identity.provider !== 'resend') {
          throw new Error('Invalid provider identity conflict evidence');
        }
        const providerMessageId = requiredProviderMessageId(identity?.providerMessageId);
        const evidenceId = requiredText(identity?.evidenceId, 'providerIdentity.evidenceId');
        const evidenceDigest = requiredText(identity?.evidenceDigest,
          'providerIdentity.evidenceDigest', 64);
        if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) {
          throw new Error('Invalid provider identity evidence digest');
        }
        return { providerMessageId, evidenceId, evidenceDigest };
      }).sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right)));
      const evidencePayloadDigest = canonicalDigest({ providerMessageId, observedAt,
        providerIdentities: normalizedIdentities });
      if (normalizedIdentities.length > 0
        && (outcomeState !== 'ambiguous'
          || new Set(normalizedIdentities.map(({ providerMessageId }) => providerMessageId)).size < 2)) {
        throw new Error('Provider identity evidence requires a multiple-ID ambiguity');
      }
      const result = (flags, transmission = null, nextTouch = null) => ({ applied: false,
        unchanged: false, conflict: false, ...flags, transmission, nextTouch });
      return database.transaction(() => {
        const transmission = database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId);
        if (!transmission) return result({ conflict: true });
        if (transmission.payload_digest !== payloadDigest) {
          return result({ conflict: true }, transmission);
        }
        const evidenceAuthorityId = `${transmissionId}:${evidenceType}:${evidenceId}`;
        const evidenceAuditId = digest('cim-audit:v1',
          'transmission-reconciled', evidenceAuthorityId);
        const priorEvidence = database.prepare(`
          SELECT * FROM deal_hunter_cim_audit_events WHERE id = ?
        `).get(evidenceAuditId);
        if (priorEvidence) {
          const unchanged = priorEvidence.transmission_id === transmissionId
            && priorEvidence.authority_digest === evidenceDigest
            && priorEvidence.source === evidenceType
            && priorEvidence.next_state === outcomeState
            && priorEvidence.reason_code === providerResultCode
            && priorEvidence.payload_digest === evidencePayloadDigest;
          return result({ unchanged, conflict: !unchanged }, transmission,
            unchanged && transmission.state === 'accepted'
              ? cadenceContext(database, transmissionId)?.nextTouch ?? null : null);
        }
        const appendEvidence = (priorState, nextState) => {
          appendAudit(database, { eventType: 'transmission-reconciled',
            authorityId: evidenceAuthorityId,
            conversationId: transmission.conversation_id, transmissionId,
            priorState, nextState, reasonCode: providerResultCode,
            authorityDigest: evidenceDigest,
            payloadDigest: evidencePayloadDigest,
            actor, source: evidenceType, occurredAt: observedAt });
          for (const identity of normalizedIdentities) {
            appendAudit(database, { eventType: 'provider-identity-conflict',
              authorityId: `${evidenceAuthorityId}:${identity.evidenceId}`,
              conversationId: transmission.conversation_id, transmissionId,
              priorState, nextState: 'ambiguous', reasonCode: 'multiple_provider_ids',
              authorityDigest: identity.evidenceDigest,
              payloadDigest: sha256(identity.providerMessageId), actor,
              source: evidenceType, occurredAt: observedAt });
          }
        };
        if (['accepted', 'definitive-failure'].includes(transmission.state)) {
          const unchanged = transmission.state === outcomeState && transmission.provider === provider
            && transmission.provider_message_id === providerMessageId;
          if (unchanged) appendEvidence(transmission.state, transmission.state);
          return result({ unchanged, conflict: !unchanged }, transmission,
            unchanged && transmission.state === 'accepted'
              ? cadenceContext(database, transmissionId)?.nextTouch ?? null : null);
        }
        if (transmission.state === 'ambiguous' && outcomeState === 'ambiguous'
          && transmission.provider === provider
          && transmission.provider_message_id === null) {
          appendEvidence('ambiguous', 'ambiguous');
          return result({ unchanged: true }, transmission);
        }
        if (!['provider-pending', 'ambiguous'].includes(transmission.state)
          || transmission.row_version !== expectedRowVersion
          || transmission.invocation_authority_count !== 1
          || (transmission.provider && transmission.provider !== provider)) {
          return result({ conflict: true }, transmission);
        }
        const members = database.prepare(`
          SELECT t.*, c.state AS campaign_state, c.terminal_revision AS campaign_terminal_revision,
            c.row_version AS campaign_row_version, c.timezone_revision AS campaign_timezone_revision
          FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
          JOIN deal_hunter_cim_campaigns c ON c.id = m.campaign_id
          WHERE m.transmission_id = ? AND m.cancelled_at IS NULL ORDER BY t.id
        `).all(transmissionId);
        if (!members.length || members.some((member) =>
          !['provider-pending', 'ambiguous'].includes(member.state))) {
          return result({ conflict: true }, transmission);
        }
        const shouldAdvance = members.length === 1
          && members[0].campaign_terminal_revision === transmission.campaign_terminal_revision
          && ['provider-ambiguous', 'initial-pending', 'active-follow-up'].includes(members[0].campaign_state);
        const expectedCadence = outcomeState === 'accepted' && shouldAdvance
          ? deriveAcceptedCimCadence(cadenceContext(database, transmissionId), observedAt) : null;
        if (stableCanonicalJson(command.cadence ?? null) !== stableCanonicalJson(expectedCadence)) {
          throw new Error('Accepted CIM reconciliation cadence does not match durable authority');
        }
        let nextTouch = null;
        database.prepare(`
          UPDATE deal_hunter_cim_transmissions SET state = ?, provider = ?,
            provider_message_id = ?, provider_result_code = ?, updated_at = ?,
            row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND state IN ('provider-pending', 'ambiguous')
        `).run(outcomeState, provider, providerMessageId, providerResultCode,
          now, transmissionId, expectedRowVersion);
        for (const member of members) {
          database.prepare(`
            UPDATE deal_hunter_cim_campaign_touches SET state = ?, outcome_code = ?,
              updated_at = ?, row_version = row_version + 1
            WHERE id = ? AND row_version = ? AND state IN ('provider-pending', 'ambiguous')
          `).run(outcomeState, providerResultCode, now, member.id, member.row_version);
          appendAudit(database, { eventType: 'touch-reconciled',
            authorityId: `${member.id}:${member.row_version + 1}`,
            opportunityId: member.opportunity_id, campaignId: member.campaign_id,
            touchId: member.id, transmissionId, priorState: member.state,
            nextState: outcomeState, authorityDigest: evidenceDigest, actor, occurredAt: now });
          if (shouldAdvance) {
            const campaignNextState = outcomeState === 'accepted' ? 'active-follow-up'
              : outcomeState === 'definitive-failure' ? 'action-required' : 'provider-ambiguous';
            database.prepare(`
              UPDATE deal_hunter_cim_campaigns SET state = ?, reason_code = ?,
                initial_accepted_at = COALESCE(initial_accepted_at, ?),
                local_expiry_at = COALESCE(local_expiry_at, ?),
                expiry_derivation = CASE WHEN initial_accepted_at IS NULL AND ? = 'accepted'
                  THEN ? ELSE expiry_derivation END,
                updated_at = ?, row_version = row_version + 1
              WHERE id = ? AND row_version = ? AND terminal_revision = ?
            `).run(campaignNextState,
              outcomeState === 'definitive-failure' ? 'provider_definitive_failure'
                : outcomeState === 'ambiguous' ? 'provider_ambiguous' : null,
              outcomeState === 'accepted' ? observedAt : null,
              outcomeState === 'accepted' ? expectedCadence?.localExpiryAt ?? null : null,
              outcomeState,
              outcomeState === 'accepted'
                ? stableCanonicalJson(expectedCadence?.expiryDerivation ?? {}) : '{}',
              now, member.campaign_id, member.campaign_row_version,
              member.campaign_terminal_revision);
            appendAudit(database, { eventType: 'campaign-transition',
              authorityId: `${member.campaign_id}:${member.campaign_row_version + 1}`,
              opportunityId: member.opportunity_id, campaignId: member.campaign_id,
              priorState: member.campaign_state, nextState: campaignNextState,
              authorityDigest: evidenceDigest, actor, occurredAt: now });
            if (outcomeState === 'accepted' && expectedCadence?.nextTouch) {
              const next = expectedCadence.nextTouch;
              database.prepare(`
                INSERT INTO deal_hunter_cim_campaign_touches (
                  id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
                  due_at, due_local, timezone_revision, state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
              `).run(next.id, member.campaign_id, member.opportunity_id,
                next.logicalSlot, next.kind, next.ordinal, next.dueAt, next.dueLocal,
                next.timezoneRevision, now, now);
              nextTouch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
                WHERE id = ?`).get(next.id);
              appendAudit(database, { eventType: 'touch-created', authorityId: next.id,
                opportunityId: member.opportunity_id, campaignId: member.campaign_id,
                touchId: next.id, nextState: 'scheduled', actor, occurredAt: now });
            }
          }
        }
        if (outcomeState === 'ambiguous') {
          const conversation = database.prepare(`
            SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
          `).get(transmission.conversation_id);
          if (conversation?.state === 'open') {
            database.prepare(`
              UPDATE deal_hunter_broker_conversations SET state = 'provider-ambiguous',
                terminal_revision = terminal_revision + 1, row_version = row_version + 1,
                updated_at = ? WHERE id = ? AND state = 'open' AND row_version = ?
            `).run(now, conversation.id, conversation.row_version);
            appendAudit(database, { eventType: 'conversation-provider-ambiguous',
              authorityId: `${conversation.id}:${conversation.terminal_revision + 1}`,
              conversationId: conversation.id, transmissionId,
              priorState: 'open', nextState: 'provider-ambiguous',
              reasonCode: 'provider_ambiguous', authorityDigest: evidenceDigest,
              actor, source: evidenceType, occurredAt: observedAt });
          }
        }
        const unresolved = database.prepare(`
          SELECT COUNT(*) AS count FROM deal_hunter_cim_transmissions
          WHERE conversation_id = ? AND id <> ? AND state IN ('provider-pending', 'ambiguous')
        `).get(transmission.conversation_id, transmissionId).count;
        const conversation = database.prepare(`
          SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
        `).get(transmission.conversation_id);
        if (outcomeState !== 'ambiguous'
          && conversation?.state === 'provider-ambiguous' && unresolved === 0) {
          database.prepare(`
            UPDATE deal_hunter_broker_conversations SET state = 'open',
              terminal_revision = terminal_revision + 1, row_version = row_version + 1,
              updated_at = ? WHERE id = ? AND state = 'provider-ambiguous' AND row_version = ?
          `).run(now, conversation.id, conversation.row_version);
          appendAudit(database, { eventType: 'conversation-provider-reconciled',
            authorityId: `${conversation.id}:${conversation.terminal_revision + 1}`,
            conversationId: conversation.id, priorState: 'provider-ambiguous',
            nextState: 'open', authorityDigest: evidenceDigest, actor,
            source: evidenceType, occurredAt: now });
        }
        const deliveryState = outcomeState === 'definitive-failure' ? 'failed' : outcomeState;
        database.prepare(`
          UPDATE crm_communications SET provider = ?, provider_message_id = ?,
            delivery_state = ?, delivery_state_at = ?, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, observedAt, now,
          transmission.communication_id);
        database.prepare(`
          UPDATE crm_email_outbox SET provider = ?, provider_message_id = ?,
            state = ?, attempt_count = 1, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, now, transmission.outbox_id);
        appendEvidence(transmission.state, outcomeState);
        return result({ applied: true }, database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId), nextTouch);
      }).immediate();
    },
    async finalizeCimTransmission(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const payloadDigest = requiredText(command.payloadDigest, 'payloadDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(payloadDigest)) throw new Error('Invalid finalization payload digest');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const outcomeState = requiredText(command.outcome, 'outcome', 40);
      if (!['accepted', 'definitive-failure', 'ambiguous'].includes(outcomeState)) {
        throw new Error('Invalid provider finalization outcome');
      }
      const provider = requiredProvider(command.provider);
      const providerMessageId = command.providerMessageId ?? null;
      if (outcomeState === 'accepted') requiredProviderMessageId(providerMessageId);
      else if (providerMessageId !== null) requiredProviderMessageId(providerMessageId);
      const providerResultCode = requiredText(command.providerResultCode, 'providerResultCode', 160);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      const observedAt = canonicalInstant(command.observedAt ?? command.now);
      const outcome = (flags, transmission = null, nextTouch = null) => ({ applied: false,
        existing: false, conflict: false, ...flags, transmission, nextTouch });
      return database.transaction(() => {
        const transmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?')
          .get(transmissionId);
        if (!transmission) return outcome({ conflict: true });
        if (transmission.payload_digest !== payloadDigest) {
          return outcome({ conflict: true }, transmission, null);
        }
        if (['accepted', 'definitive-failure', 'ambiguous'].includes(transmission.state)) {
          const existing = transmission.state === outcomeState && transmission.provider === provider
            && transmission.provider_message_id === providerMessageId
            && transmission.provider_result_code === providerResultCode;
          return outcome({ existing, conflict: !existing }, transmission,
            existing && transmission.state === 'accepted'
              ? cadenceContext(database, transmissionId)?.nextTouch ?? null : null);
        }
        if (transmission.state !== 'provider-pending'
          || transmission.row_version !== expectedRowVersion
          || transmission.invocation_authority_count !== 1
          || !transmission.provider_seam_entered_at) return outcome({ conflict: true }, transmission);
        const members = database.prepare(`
          SELECT t.*, c.state AS campaign_state, c.terminal_revision AS campaign_terminal_revision,
            c.row_version AS campaign_row_version, c.timezone_revision AS campaign_timezone_revision,
            c.conversation_id AS campaign_conversation_id
          FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
          JOIN deal_hunter_cim_campaigns c ON c.id = m.campaign_id
          WHERE m.transmission_id = ? AND m.cancelled_at IS NULL ORDER BY t.id
        `).all(transmissionId);
        if (!members.length || members.some((member) => member.state !== 'provider-pending')) {
          return outcome({ conflict: true }, transmission);
        }
        const shouldAdvance = members.length === 1
          && members[0].campaign_terminal_revision === transmission.campaign_terminal_revision
          && ['initial-pending', 'active-follow-up'].includes(members[0].campaign_state);
        const expectedCadence = outcomeState === 'accepted' && shouldAdvance
          ? deriveAcceptedCimCadence(cadenceContext(database, transmissionId), observedAt) : null;
        if (stableCanonicalJson(command.cadence ?? null) !== stableCanonicalJson(expectedCadence)) {
          throw new Error('Accepted CIM finalization cadence does not match durable authority');
        }
        let nextTouch = null;
        const nextState = outcomeState === 'accepted' ? 'active-follow-up'
          : outcomeState === 'definitive-failure' ? 'action-required' : 'provider-ambiguous';
        database.prepare(`
          UPDATE deal_hunter_cim_transmissions SET state = ?, provider = ?,
            provider_message_id = ?, provider_result_code = ?,
            row_version = row_version + 1, updated_at = ?
          WHERE id = ? AND state = 'provider-pending' AND row_version = ?
        `).run(outcomeState, provider, providerMessageId, providerResultCode,
          now, transmissionId, expectedRowVersion);
        for (const member of members) {
          database.prepare(`
            UPDATE deal_hunter_cim_campaign_touches SET state = ?, outcome_code = ?,
              row_version = row_version + 1, updated_at = ?
            WHERE id = ? AND state = 'provider-pending' AND row_version = ?
          `).run(outcomeState, providerResultCode, now, member.id, member.row_version);
          appendAudit(database, { eventType: 'touch-finalized',
            authorityId: `${member.id}:${member.row_version + 1}`,
            opportunityId: member.opportunity_id, campaignId: member.campaign_id,
            conversationId: member.campaign_conversation_id, touchId: member.id,
            transmissionId, priorState: 'provider-pending', nextState: outcomeState,
            actor, occurredAt: now });
          if (member.campaign_terminal_revision !== transmission.campaign_terminal_revision
            || !['initial-pending', 'active-follow-up'].includes(member.campaign_state)) continue;
          database.prepare(`
            UPDATE deal_hunter_cim_campaigns SET state = ?, reason_code = ?,
              initial_accepted_at = COALESCE(initial_accepted_at, ?),
              local_expiry_at = COALESCE(local_expiry_at, ?),
              expiry_derivation = CASE WHEN initial_accepted_at IS NULL AND ? = 'accepted'
                THEN ? ELSE expiry_derivation END,
              row_version = row_version + 1, updated_at = ?
            WHERE id = ? AND row_version = ? AND terminal_revision = ?
          `).run(nextState,
            outcomeState === 'definitive-failure' ? 'provider_definitive_failure'
              : outcomeState === 'ambiguous' ? 'provider_ambiguous' : null,
            outcomeState === 'accepted' ? observedAt : null,
            outcomeState === 'accepted' ? expectedCadence?.localExpiryAt ?? null : null,
            outcomeState,
            outcomeState === 'accepted'
              ? stableCanonicalJson(expectedCadence?.expiryDerivation ?? {}) : '{}',
            now, member.campaign_id, member.campaign_row_version,
            member.campaign_terminal_revision);
          appendAudit(database, { eventType: 'campaign-transition',
            authorityId: `${member.campaign_id}:${member.campaign_row_version + 1}`,
            opportunityId: member.opportunity_id, campaignId: member.campaign_id,
            priorState: member.campaign_state, nextState, actor, occurredAt: now });
          if (outcomeState === 'accepted' && expectedCadence?.nextTouch) {
            const next = expectedCadence.nextTouch;
            database.prepare(`
              INSERT INTO deal_hunter_cim_campaign_touches (
                id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
                due_at, due_local, timezone_revision, state, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
            `).run(next.id, member.campaign_id, member.opportunity_id,
              next.logicalSlot, next.kind, next.ordinal, next.dueAt, next.dueLocal,
              next.timezoneRevision, now, now);
            nextTouch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
              WHERE id = ?`).get(next.id);
            appendAudit(database, { eventType: 'touch-created', authorityId: next.id,
              opportunityId: member.opportunity_id, campaignId: member.campaign_id,
              touchId: next.id, nextState: 'scheduled', actor, occurredAt: now });
          }
        }
        if (outcomeState === 'ambiguous') {
          const conversation = database.prepare(`
            SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
          `).get(transmission.conversation_id);
          if (conversation?.state === 'open') {
            database.prepare(`
              UPDATE deal_hunter_broker_conversations SET state = 'provider-ambiguous',
                terminal_revision = terminal_revision + 1, row_version = row_version + 1,
                updated_at = ? WHERE id = ? AND state = 'open' AND row_version = ?
            `).run(now, conversation.id, conversation.row_version);
            appendAudit(database, { eventType: 'conversation-provider-ambiguous',
              authorityId: `${conversation.id}:${conversation.terminal_revision + 1}`,
              conversationId: conversation.id, transmissionId,
              priorState: 'open', nextState: 'provider-ambiguous',
              reasonCode: 'provider_ambiguous', payloadDigest: transmission.payload_digest,
              actor, occurredAt: now });
          }
        }
        const deliveryState = outcomeState === 'definitive-failure' ? 'failed' : outcomeState;
        database.prepare(`
          UPDATE crm_communications SET provider = ?, provider_message_id = ?,
            delivery_state = ?, delivery_state_at = ?, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, observedAt, now,
          transmission.communication_id);
        database.prepare(`
          UPDATE crm_email_outbox SET provider = ?, provider_message_id = ?,
            state = ?, attempt_count = 1, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, now, transmission.outbox_id);
        appendAudit(database, { eventType: 'transmission-finalized', authorityId: transmissionId,
          conversationId: transmission.conversation_id, transmissionId,
          priorState: 'provider-pending', nextState: outcomeState,
          payloadDigest: transmission.payload_digest, actor, occurredAt: observedAt });
        return outcome({ applied: true }, database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId), nextTouch);
      }).immediate();
    },
    async readCimFinalGateContext(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const authorizationId = requiredText(command.authorizationId, 'authorizationId');
      const transmission = database.prepare(`
        SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
      `).get(transmissionId) ?? null;
      if (!transmission) return null;
      const conversation = database.prepare(`
        SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
      `).get(transmission.conversation_id) ?? null;
      const authorization = database.prepare(`
        SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?
      `).get(authorizationId) ?? null;
      const activation = authorization ? database.prepare(`
        SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?
      `).get(authorization.activation_id) ?? null : null;
      const safety = database.prepare(`
        SELECT * FROM deal_hunter_cim_safety_settings WHERE id = 'global'
      `).get() ?? null;
      const globalAuthorityRevision = database.prepare(`
        SELECT revision FROM deal_hunter_cim_global_authority WHERE id = 'global'
      `).get()?.revision ?? null;
      const communicationRow = database.prepare(`
        SELECT * FROM crm_communications WHERE id = ?
      `).get(transmission.communication_id) ?? null;
      const outboxRow = database.prepare(`
        SELECT * FROM crm_email_outbox WHERE id = ?
      `).get(transmission.outbox_id) ?? null;
      const parseJson = (value, fallback) => {
        try { return JSON.parse(value ?? '') ?? fallback; } catch { return fallback; }
      };
      const communicationMetadata = parseJson(communicationRow?.metadata, {});
      const outboxMetadata = parseJson(outboxRow?.metadata, {});
      const communication = communicationRow ? {
        ...communicationRow,
        to_addresses: parseJson(communicationRow.to_addresses, []),
        cc_addresses: parseJson(communicationRow.cc_addresses, []),
        bcc_addresses: parseJson(communicationRow.bcc_addresses, []),
        tags: Array.isArray(communicationMetadata.tags) ? communicationMetadata.tags : [],
        body_text_digest: createHash('sha256').update(communicationRow.body_text ?? '').digest('hex'),
        body_html_digest: createHash('sha256').update(
          communicationRow.body_html_sanitized ?? '').digest('hex'),
      } : null;
      const outbox = outboxRow ? { ...outboxRow,
        retry_policy: outboxMetadata.retryPolicy ?? null } : null;
      const rows = database.prepare(`
        SELECT m.transmission_id, m.touch_id, m.opportunity_id, m.campaign_id,
          m.display_ordinal, m.cancelled_at, m.cancellation_reason
        FROM deal_hunter_cim_transmission_touches m
        WHERE m.transmission_id = ? ORDER BY m.touch_id
      `).all(transmissionId);
      const members = rows.map((membership) => {
        const touch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
          WHERE id = ?`).get(membership.touch_id) ?? null;
        const campaign = database.prepare(`SELECT * FROM deal_hunter_cim_campaigns
          WHERE id = ?`).get(membership.campaign_id) ?? null;
        const decision = campaign ? database.prepare(`SELECT * FROM deal_hunter_owner_decision_events
          WHERE id = ?`).get(campaign.decision_event_id) ?? null : null;
        const enrollment = campaign ? database.prepare(`SELECT * FROM deal_hunter_pursuit_enrollments
          WHERE id = ?`).get(campaign.enrollment_id) ?? null : null;
        const opportunity = database.prepare(`SELECT * FROM deal_hunter_opportunities
          WHERE opportunity_id = ?`).get(membership.opportunity_id) ?? null;
        const timezone = database.prepare(`SELECT * FROM deal_hunter_opportunity_timezone_revisions
          WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1`)
          .get(membership.opportunity_id) ?? null;
        const crmOwnership = database.prepare(`SELECT revision, submission_id
          FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = ?
          ORDER BY revision DESC LIMIT 1`).get(membership.opportunity_id) ?? null;
        const crmSubmission = campaign?.crm_submission_id ? database.prepare(`
          SELECT * FROM contact_submissions WHERE id = ?
        `).get(campaign.crm_submission_id) ?? null : null;
        return { membership, touch, campaign, decision, enrollment, opportunity,
          timezone, crmOwnership, crmSubmission };
      });
      const qualificationChainCurrent = authorization?.writer_path === P10B_QUALIFICATION_WRITER
        && currentActivationChain(database, 'fl04b-initial', requiredInstant(command.now
          ?? new Date().toISOString()))?.id === authorization.activation_id;
      return { transmission, conversation, authorization, activation, safety, qualificationChainCurrent,
        globalAuthorityRevision, communication, outbox, members };
    },
    async enterCimProviderSeam(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const authorizationId = requiredText(command.authorizationId, 'authorizationId');
      const writerPath = requiredText(command.writerPath, 'writerPath');
      const providerProfile = requiredText(command.providerProfile, 'providerProfile', 120);
      const capability = requiredText(command.capability, 'capability', 40);
      const payloadDigest = requiredText(command.payloadDigest, 'payloadDigest', 64);
      const boundaryNonceDigest = requiredText(command.boundaryNonceDigest, 'boundaryNonceDigest', 64);
      if (![payloadDigest, boundaryNonceDigest].every((value) => /^[0-9a-f]{64}$/.test(value))) {
        throw new Error('Invalid provider seam digest');
      }
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      return database.transaction(() => {
        const transmission = database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId);
        const authorization = database.prepare(`
          SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?
        `).get(authorizationId);
        const pause = database.prepare(`
          SELECT outreach_paused FROM deal_hunter_cim_safety_settings WHERE id = 'global'
        `).get();
        const activation = authorization
          ? database.prepare(`SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?`)
            .get(authorization.activation_id)
          : null;
        const communication = transmission
          ? database.prepare(`SELECT * FROM crm_communications WHERE id = ?`)
            .get(transmission.communication_id)
          : null;
        const outbox = transmission
          ? database.prepare(`SELECT * FROM crm_email_outbox WHERE id = ?`)
            .get(transmission.outbox_id)
          : null;
        const memberKinds = transmission ? database.prepare(`
          SELECT t.kind FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
          WHERE m.transmission_id = ? AND m.cancelled_at IS NULL ORDER BY t.id
        `).all(transmissionId).map(({ kind }) => kind) : [];
        const capabilityMatchesWork = capability === 'fl04c-batch'
          ? memberKinds.length > 1
          : memberKinds.length === 1 && (capability === 'fl04b-initial'
            ? memberKinds[0] === 'initial' : memberKinds[0] !== 'initial');
        const valid = transmission?.state === 'provider-pending'
          && transmission.invocation_authority_count === 1
          && transmission.payload_digest === payloadDigest
          && transmission.boundary_nonce_digest === boundaryNonceDigest
          && authorization?.transmission_id === transmissionId
          && authorization.writer_path === writerPath
          && authorization.provider_profile === providerProfile
          && authorization.capability === capability
          && authorization.payload_digest === payloadDigest
          && authorization.maximum_calls === 1
          && authorization.consumed_at && !authorization.withdrawn_at
          && Date.parse(authorization.expires_at) > Date.parse(now)
          && cimWriterCapabilities.get(writerPath) === capability
          && activation?.provider_profile === providerProfile
          && currentActivationChain(database, capability, now)?.id === authorization.activation_id
          && capabilityMatchesWork
          && communication?.id === transmission.communication_id
          && communication.delivery_state === 'provider-pending'
          && outbox?.id === transmission.outbox_id
          && outbox.communication_id === communication.id
          && outbox.state === 'provider-pending';
        if (!valid) return { entered: false, alreadyEntered: false, unauthorized: true };
        if (transmission.provider_seam_entered_at) {
          return { entered: false, alreadyEntered: true, unauthorized: false };
        }
        const qualification = writerPath === P10B_QUALIFICATION_WRITER;
        if (!pause || pause.outreach_paused !== (qualification ? 1 : 0)
          || (qualification && !qualificationBound(database, command.qualification,
            { transmission, authorization, now }))
          || transmission.row_version !== expectedRowVersion) {
          return { entered: false, alreadyEntered: false, unauthorized: true };
        }
        const changed = database.prepare(`
          UPDATE deal_hunter_cim_transmissions
          SET provider_seam_entered_at = ?, updated_at = ?, row_version = row_version + 1
          WHERE id = ? AND state = 'provider-pending' AND provider_seam_entered_at IS NULL
            AND boundary_nonce_digest = ? AND row_version = ?
        `).run(now, now, transmissionId, boundaryNonceDigest, expectedRowVersion).changes;
        if (changed !== 1) return { entered: false, alreadyEntered: false, unauthorized: true };
        appendAudit(database, { eventType: 'provider-seam-entered', authorityId: transmissionId,
          transmissionId, authorizationId, nextState: 'entered', actor, occurredAt: now });
        return { entered: true, alreadyEntered: false, unauthorized: false };
      }).immediate();
    },
    async recordCimProviderBoundaryRejection(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const authorizationId = requiredText(command.authorizationId, 'authorizationId');
      const reasonCode = requiredText(command.reasonCode, 'reasonCode', 160);
      const actor = requiredText(command.actor, 'actor', 200);
      const expectedRowVersion = requiredRevision(command.expectedRowVersion,
        'expectedRowVersion');
      const now = requiredInstant(command.now);
      if (!pursueCimBoundaryRejectionCodes.has(reasonCode)
        || typeof command.reconciliationOnly !== 'boolean') {
        throw new Error('Invalid CIM provider boundary rejection');
      }
      return database.transaction(() => {
        const authorization = database.prepare(`SELECT transmission_id
          FROM deal_hunter_cim_live_provider_authorizations WHERE id=?`).get(authorizationId);
        if (authorization?.transmission_id !== transmissionId) {
          throw new Error('Invalid CIM provider boundary rejection authority');
        }
        const id = digest('cim-boundary-rejected:v1', transmissionId, authorizationId,
          reasonCode, expectedRowVersion);
        if (database.prepare(`SELECT 1 FROM deal_hunter_cim_audit_events WHERE id=?`).get(id)) {
          return { applied: false, replay: true };
        }
        appendAudit(database, { id, eventType: 'provider-boundary-rejected',
          authorityId: id, transmissionId, authorizationId, reasonCode,
          actor, source: 'provider-boundary-observer', occurredAt: now,
          metadata: { reconciliationOnly: command.reconciliationOnly,
            expectedRowVersion } });
        return { applied: true, replay: false };
      }).immediate();
    },
    async authorizeCimProviderPending(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const authorizationId = requiredText(command.authorizationId, 'authorizationId');
      const writerPath = requiredText(command.writerPath, 'writerPath');
      const providerProfile = requiredText(command.providerProfile, 'providerProfile', 120);
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const expectedCampaignTerminalRevision = requiredRevision(
        command.expectedCampaignTerminalRevision, 'expectedCampaignTerminalRevision');
      const expectedConversationTerminalRevision = requiredRevision(
        command.expectedConversationTerminalRevision, 'expectedConversationTerminalRevision');
      const expectedGlobalAuthorityRevision = requiredRevision(
        command.expectedGlobalAuthorityRevision, 'expectedGlobalAuthorityRevision');
      const claimTokenDigest = requiredText(command.claimTokenDigest, 'claimTokenDigest', 64);
      const finalGateAuthorityDigest = requiredText(command.finalGateAuthorityDigest,
        'finalGateAuthorityDigest', 64);
      const boundaryNonceDigest = requiredText(command.boundaryNonceDigest, 'boundaryNonceDigest', 64);
      if (![claimTokenDigest, finalGateAuthorityDigest, boundaryNonceDigest]
        .every((value) => /^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid provider-pending digest');
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      const authoritySnapshot = command.authoritySnapshot;
      const snapshotDigest = safeCanonicalDigest(authoritySnapshot);
      const snapshotMembers = Array.isArray(authoritySnapshot?.members)
        ? authoritySnapshot.members : [];
      return database.transaction(() => {
        const transmission = database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId);
        const blocked = (blockedReason) => {
          if (transmission) appendAudit(database, { eventType: 'final-gate-blocked',
            ignore: true,
            id: digest('cim-final-gate-block:v1', transmission.id, transmission.row_version,
              blockedReason, finalGateAuthorityDigest),
            authorityId: transmission.id, conversationId: transmission.conversation_id,
            transmissionId: transmission.id,
            priorState: transmission.state, nextState: transmission.state,
            reasonCode: blockedReason, authorityDigest: finalGateAuthorityDigest,
            payloadDigest: transmission.payload_digest, actor, occurredAt: now });
          return { authorized: false, blockedReason,
            transmission: transmission ?? null, boundaryNonceDigest: null };
        };
        if (!transmission) return blocked('lifecycle_conflict');
        if (transmission.state === 'cancelled-before-provider') {
          const terminal = database.prepare(`SELECT event.reason_code
            FROM deal_hunter_cim_terminal_events event
            JOIN deal_hunter_cim_transmission_touches member
              ON member.campaign_id = event.campaign_id
            WHERE member.transmission_id = ? AND event.scope = 'campaign'
            ORDER BY event.revision DESC, event.created_at DESC, event.id DESC LIMIT 1`)
            .get(transmission.id);
          const terminalReason = terminal?.reason_code;
          const blockedReason = ['materials_received', 'advanced_beyond_broker_outreach']
            .includes(terminalReason) ? 'materials_received'
            : terminalReason === 'recipient_suppressed' ? 'recipient_suppressed'
              : terminalReason === 'identity_ambiguous' ? 'identity_authority_changed'
                : ['crm_archived', 'crm_superseded'].includes(terminalReason) ? 'crm_owner_changed'
                  : ['watch-selected', 'pass-selected'].includes(terminalReason)
                    ? 'owner_intent_changed' : 'terminal_authority_changed';
          return blocked(blockedReason);
        }
        if (transmission.state !== 'prepared' || transmission.invocation_authority_count !== 0) {
          return blocked('already_provider_pending');
        }
        if (transmission.provider_seam_entered_at || transmission.provider
          || transmission.provider_message_id || transmission.provider_result_code
          || transmission.boundary_nonce_digest || transmission.final_gate_authority_digest
          || transmission.release_state !== 'ordinary') return blocked('lifecycle_conflict');
        if (transmission.row_version !== expectedRowVersion) return blocked('stale_authority');
        if (!authoritySnapshot || authoritySnapshot.version !== 'cim-final-gate-authority-v1'
          || authoritySnapshot.gateInstant !== now || snapshotDigest !== finalGateAuthorityDigest
          || snapshotMembers.length < 1) return blocked('lifecycle_conflict');
        if (authoritySnapshot.transmission?.id !== transmission.id
          || authoritySnapshot.transmission?.state !== transmission.state
          || authoritySnapshot.transmission?.releaseState !== transmission.release_state
          || authoritySnapshot.transmission?.rowVersion !== transmission.row_version
          || authoritySnapshot.transmission?.payloadDigest !== transmission.payload_digest
          || authoritySnapshot.transmission?.preparationGeneration
            !== transmission.preparation_generation
          || authoritySnapshot.transmission?.payloadVersion !== transmission.payload_version
          || authoritySnapshot.transmission?.communicationId !== transmission.communication_id
          || authoritySnapshot.transmission?.outboxId !== transmission.outbox_id) {
          return blocked('lifecycle_conflict');
        }
        const readiness = authoritySnapshot.readiness;
        const qualification = writerPath === P10B_QUALIFICATION_WRITER;
        if (qualification ? readiness?.version !== 'p10b-qualification-permission-v1'
          || !qualificationBound(database, readiness, { transmission, now })
          : !authorityDigestMatches(readiness) || readiness.ready !== true
          || readiness.version !== 'cim-provider-readiness-v1'
          || readiness.providerProfile !== providerProfile
          || Date.parse(readiness.expiresAt) <= Date.parse(now)) {
          return blocked('provider_readiness_unavailable');
        }
        const globalAuthorityRevision = database.prepare(`
          SELECT revision FROM deal_hunter_cim_global_authority WHERE id = 'global'
        `).get()?.revision;
        if (globalAuthorityRevision !== expectedGlobalAuthorityRevision
          || Number(authoritySnapshot.globalAuthorityRevision) !== globalAuthorityRevision) {
          return blocked('freshness_changed');
        }
        const pause = database.prepare(`
          SELECT outreach_paused FROM deal_hunter_cim_safety_settings WHERE id = 'global'
        `).get();
        if (!pause || pause.outreach_paused !== (qualification ? 1 : 0)) return blocked('central_pause');
        const authorization = database.prepare(`
          SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?
        `).get(authorizationId);
        if (!authorization || authorization.transmission_id !== transmissionId
          || authorization.writer_path !== writerPath
          || authorization.provider_profile !== providerProfile
          || authorization.payload_digest !== transmission.payload_digest
          || authorization.consumed_at || authorization.withdrawn_at
          || authorization.maximum_calls !== 1
          || Date.parse(authorization.expires_at) <= Date.parse(now)) {
          return blocked('live_authorization_invalid');
        }
        if (qualification && !qualificationBound(database, readiness,
          { transmission, authorization, now })) return blocked('live_authorization_invalid');
        if (authoritySnapshot.authorization?.id !== authorization.id
          || authoritySnapshot.authorization?.activation_id !== authorization.activation_id
          || authoritySnapshot.authorization?.payload_digest !== authorization.payload_digest
          || authoritySnapshot.authorization?.recipient_authority_digest
            !== authorization.recipient_authority_digest) return blocked('live_authorization_invalid');
        const activation = currentActivationChain(database, authorization.capability, now);
        if (!activation || activation.id !== authorization.activation_id
          || activation.provider_profile !== providerProfile) return blocked('capability_inactive');
        if (authorization.capability !== 'fl04b-initial'
          || authoritySnapshot.activation?.id !== activation.id
          || authoritySnapshot.activation?.policy_hash !== activation.policy_hash
          || authoritySnapshot.activation?.config_hash !== activation.config_hash) {
          return blocked('capability_inactive');
        }
        const conversation = database.prepare(`
          SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
        `).get(transmission.conversation_id);
        if (!conversation || conversation.state !== 'open'
          || conversation.terminal_revision !== expectedConversationTerminalRevision) {
          return blocked('terminal_authority_changed');
        }
        if (conversation.batching_policy_version !== 'batching-off-v1'
          || authoritySnapshot.conversation?.batchingPolicyVersion
            !== conversation.batching_policy_version) return blocked('unknown_policy_version');
        if (authoritySnapshot.conversation?.id !== conversation.id
          || authoritySnapshot.conversation?.rowVersion !== conversation.row_version
          || authoritySnapshot.conversation?.recipientAuthorityId !== conversation.recipient_authority_id
          || authoritySnapshot.conversation?.recipientFingerprint !== conversation.recipient_fingerprint
          || authoritySnapshot.conversation?.recipientAddressDigest
            !== sha256(String(conversation.recipient_address).toLowerCase())
          || authoritySnapshot.conversation?.senderPolicyVersion !== conversation.sender_policy_version
          || authoritySnapshot.conversation?.replyPolicyVersion !== conversation.reply_policy_version) {
          return blocked('recipient_authority_changed');
        }
        const members = database.prepare(`
          SELECT t.*, c.state AS campaign_state, c.terminal_revision AS campaign_terminal_revision,
            c.timezone_revision AS campaign_timezone_revision, c.discovery_revision AS campaign_discovery_revision,
            c.material_revision AS campaign_material_revision, c.recipient_fingerprint,
            c.crm_submission_id, c.policy_version, c.template_version, c.local_expiry_at
          FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
          JOIN deal_hunter_cim_campaigns c ON c.id = m.campaign_id
          WHERE m.transmission_id = ? AND m.cancelled_at IS NULL ORDER BY t.id
        `).all(transmissionId);
        if (!members.length) return blocked('membership_changed');
        if (members.some((member) =>
          !['initial-pending', 'active-follow-up'].includes(member.campaign_state)
          || member.campaign_terminal_revision !== expectedCampaignTerminalRevision)) {
          return blocked('terminal_authority_changed');
        }
        const memberIds = members.map(({ id }) => id).sort();
        const snapshotMemberIds = snapshotMembers.map((member) => member.touch?.id).sort();
        if (members.length !== snapshotMembers.length
          || new Set(memberIds).size !== memberIds.length
          || JSON.stringify(memberIds) !== JSON.stringify(snapshotMemberIds)
          || transmission.member_digest !== digest('cim-members:v1', memberIds)
          || authoritySnapshot.transmission?.memberDigest !== transmission.member_digest) {
          return blocked('membership_changed');
        }
        if (members.some((member) => member.state !== 'claimed'
          || member.claim_token_digest !== claimTokenDigest
          || member.transmission_id !== transmissionId
          || member.kind !== 'initial' || member.logical_slot !== 'initial' || member.ordinal !== 0
          || !member.claim_expires_at
          || Date.parse(member.claim_expires_at) <= Date.parse(now)
          || Date.parse(member.due_at) > Date.parse(now))) return blocked('lifecycle_conflict');
        if (members.some((member) => member.recipient_fingerprint !== authorization.recipient_authority_digest)
          || conversation.recipient_fingerprint !== authorization.recipient_authority_digest) {
          return blocked('recipient_authority_changed');
        }
        for (const member of members) {
          const expectedMember = snapshotMembers.find((item) => item.touch?.id === member.id);
          const campaign = database.prepare(`
            SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?
          `).get(member.campaign_id);
          if (campaign?.permission_version !== activation.prerequisite_activation_id
            || expectedMember?.campaign?.permission_version !== campaign?.permission_version) {
            return blocked('unknown_policy_version');
          }
          if (!expectedMember || !campaign || campaign.generation !== 1
            || campaign.policy_version !== 'deal-hunter-cim-autopilot-v1'
            || campaign.state !== 'initial-pending' || campaign.terminal_reason
            || campaign.conversation_id !== transmission.conversation_id
            || campaign.crm_submission_id !== expectedMember.campaign?.crm_submission_id
            || campaign.row_version !== expectedMember.campaign?.row_version
            || member.row_version !== expectedMember.touch?.row_version
            || member.timezone_revision !== campaign.timezone_revision) {
            return blocked('lifecycle_conflict');
          }
          const recipientAuthority = expectedMember.recipientAuthority;
          if (!authorityDigestMatches(recipientAuthority) || recipientAuthority.present !== true
            || recipientAuthority.addressDigest
              !== sha256(String(conversation.recipient_address).toLowerCase())
            || recipientAuthority.derivedRecipientFingerprint !== campaign.recipient_fingerprint
            || campaign.recipient_fingerprint !== authorization.recipient_authority_digest) {
            return blocked('recipient_authority_changed');
          }
          if (activation.permission_basis_digest !== campaign.permission_digest
            || activation.permission_revision !== campaign.permission_revision
            || activation.cohort_digest !== campaign.permission_scope
            || expectedMember.campaign?.permission_digest !== campaign.permission_digest
            || expectedMember.campaign?.permission_revision !== campaign.permission_revision
            || expectedMember.campaign?.permission_scope !== campaign.permission_scope) {
            return blocked('permission_changed');
          }
          const latestDecision = database.prepare(`
            SELECT * FROM deal_hunter_owner_decision_events WHERE opportunity_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 1
          `).get(member.opportunity_id);
          const currentEnrollment = database.prepare(`
            SELECT * FROM deal_hunter_pursuit_enrollments
            WHERE opportunity_id = ? AND state <> 'superseded' LIMIT 1
          `).get(member.opportunity_id);
          if (!latestDecision || latestDecision.id !== campaign.decision_event_id
            || latestDecision.action !== 'pursue'
            || expectedMember.decision?.id !== latestDecision.id
            || !currentEnrollment || currentEnrollment.id !== campaign.enrollment_id
            || currentEnrollment.decision_event_id !== latestDecision.id
            || currentEnrollment.state !== 'campaign-created'
            || expectedMember.enrollment?.row_version !== currentEnrollment.row_version) {
            return blocked('owner_intent_changed');
          }
          const opportunity = database.prepare(`
            SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?
          `).get(member.opportunity_id);
          const sourceAuthority = expectedMember.sourceAuthority;
          if (!opportunity || opportunity.status !== 'active') {
            return blocked('identity_authority_changed');
          }
          if (!authorityDigestMatches(sourceAuthority) || sourceAuthority.ready !== true
            || sourceAuthority.opportunityId !== opportunity.opportunity_id
            || Number(sourceAuthority.globalAuthorityRevision) !== globalAuthorityRevision
            || Number(sourceAuthority.opportunity?.campaignAuthorityRevision)
              !== opportunity.campaign_authority_revision) {
            return blocked('source_authority_unavailable');
          }
          if (opportunity.discovery_state === 'pending'
            || opportunity.discovery_revision !== member.campaign_discovery_revision
            || opportunity.material_revision !== member.campaign_material_revision
            || Number(sourceAuthority.opportunity?.discoveryRevision) !== opportunity.discovery_revision
            || Number(sourceAuthority.opportunity?.materialRevision) !== opportunity.material_revision) {
            return blocked('freshness_changed');
          }
          const currentSourceRows = database.prepare(`
            SELECT COUNT(*) AS n FROM deal_hunter_opportunity_source_observations
            WHERE opportunity_id = ? AND accepted_at IS NOT NULL
          `).get(member.opportunity_id)?.n ?? 0;
          const badSourceStates = database.prepare(`
            SELECT COUNT(*) AS n FROM deal_hunter_source_freshness_state
            WHERE projection_state <> 'accepted'
          `).get()?.n ?? 0;
          if (currentSourceRows < 1 || badSourceStates > 0) {
            return blocked('source_authority_unavailable');
          }
          const openIdentityExceptions = database.prepare(`
            SELECT candidate_opportunity_ids FROM deal_hunter_identity_exceptions
            WHERE status = 'open'
          `).all().some((row) => {
            try { return JSON.parse(row.candidate_opportunity_ids).includes(member.opportunity_id); }
            catch { return true; }
          });
          if (openIdentityExceptions) return blocked('identity_authority_changed');
          const materialsAuthority = expectedMember.materialsAuthority;
          if (!authorityDigestMatches(materialsAuthority)) return blocked('source_authority_unavailable');
          const brokerBlock = brokerAuthorityBlockedReason(materialsAuthority);
          if (brokerBlock) return blocked(brokerBlock);
          const priorRequest = database.prepare(`SELECT 1 FROM deal_hunter_cim_requests
            WHERE opportunity_id = ? OR deal_key IN (SELECT deal_key
              FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?) LIMIT 1`)
            .get(member.opportunity_id, member.opportunity_id);
          const priorClaim = database.prepare(`SELECT 1 FROM deal_hunter_cim_opportunity_claims
            WHERE opportunity_id = ? LIMIT 1`).get(member.opportunity_id);
          if (priorRequest || priorClaim) return blocked('lifecycle_conflict');
          const crmOwner = database.prepare(`
            SELECT * FROM contact_submissions WHERE id = ?
          `).get(member.crm_submission_id);
          let submissionMetadata = {};
          try { submissionMetadata = JSON.parse(crmOwner?.metadata || '{}'); }
          catch { return blocked('materials_received'); }
          const secureDocuments = database.prepare(`SELECT * FROM secure_documents
            WHERE submission_id = ? ORDER BY created_at, id`).all(campaign.crm_submission_id);
          const latestUploadRequest = database.prepare(`SELECT * FROM secure_upload_requests
            WHERE submission_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
            .get(campaign.crm_submission_id) ?? null;
          let normalizedUploadRequest = null;
          if (latestUploadRequest) {
            try {
              const requestedDocuments = JSON.parse(latestUploadRequest.requested_documents || '[]');
              if (!Array.isArray(requestedDocuments)) return blocked('materials_received');
              normalizedUploadRequest = {
                ...latestUploadRequest,
                requested_documents: requestedDocuments,
              };
            } catch {
              return blocked('materials_received');
            }
          }
          const currentMaterials = evaluateAcquisitionMaterialsState({
            submission: { ...crmOwner, metadata: submissionMetadata },
            secureDocuments,
            latestUploadRequest: normalizedUploadRequest,
          });
          if (currentMaterials.materialsReceived || currentMaterials.advancedBeyondBrokerOutreach) {
            return blocked('materials_received');
          }
          const timezone = database.prepare(`
            SELECT revision, state, iana_timezone FROM deal_hunter_opportunity_timezone_revisions
            WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1
          `).get(member.opportunity_id);
          if (!timezone || timezone.revision !== member.campaign_timezone_revision
            || !['verified', 'derived'].includes(timezone.state)) return blocked('timezone_changed');
          if (!timezone.iana_timezone || !withinLocalSendWindow(now, timezone.iana_timezone)) {
            return blocked('outside_send_window');
          }
          const currentCrmOwnership = database.prepare(`
            SELECT revision, submission_id FROM deal_hunter_crm_ownership_revisions
            WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1
          `).get(member.opportunity_id);
          const activeSupersession = database.prepare(`
            SELECT 1 FROM crm_submission_supersessions
            WHERE superseded_submission_id = ? AND status = 'active' LIMIT 1
          `).get(member.crm_submission_id);
          if (!crmOwner || crmOwner.archived_at
            || crmOwner.deal_hunter_opportunity_id !== member.opportunity_id
            || opportunity.primary_submission_id !== member.crm_submission_id
            || currentCrmOwnership?.submission_id !== member.crm_submission_id
            || currentCrmOwnership?.revision !== campaign.crm_ownership_revision
            || expectedMember.crmOwnership?.revision !== currentCrmOwnership?.revision
            || activeSupersession) {
            return blocked('crm_owner_changed');
          }
          if (member.local_expiry_at && Date.parse(member.local_expiry_at) <= Date.parse(now)) {
            return blocked('expired');
          }
        }
        const reply = database.prepare(`
          SELECT 1 FROM crm_communications
          WHERE direction = 'inbound' AND (
            thread_key = ? OR submission_id IN (
              SELECT crm_submission_id FROM deal_hunter_cim_campaigns c
              JOIN deal_hunter_cim_transmission_touches m ON m.campaign_id = c.id
              WHERE m.transmission_id = ? AND m.cancelled_at IS NULL
            )
          ) LIMIT 1
        `).get(conversation.rfc_thread_key, transmissionId);
        if (reply) return blocked('reply_received');
        const suppression = database.prepare(`
          SELECT 1 FROM email_suppressions
          WHERE normalized_email = lower(?) AND lifted_at IS NULL
        `).get(conversation.recipient_address);
        const adverseDelivery = database.prepare(`
          SELECT 1 FROM email_events WHERE lower(recipient_email) = lower(?)
            AND event_type IN ('complained', 'complaint', 'bounced', 'hard_bounce',
              'unsubscribe', 'unsubscribed', 'opt_out') LIMIT 1
        `).get(conversation.recipient_address);
        if (suppression || adverseDelivery) return blocked('recipient_suppressed');
        const communication = database.prepare('SELECT * FROM crm_communications WHERE id = ?')
          .get(transmission.communication_id);
        const outbox = database.prepare('SELECT * FROM crm_email_outbox WHERE id = ?')
          .get(transmission.outbox_id);
        if (!communication || communication.outbox_id !== transmission.outbox_id
          || communication.delivery_state !== 'not-attempted'
          || communication.direction !== 'outbound' || communication.channel !== 'email'
          || communication.source !== 'pursue-cim-autopilot'
          || communication.kind !== 'cim-initial'
          || communication.thread_key !== conversation.rfc_thread_key
          || communication.from_address !== transmission.from_address
          || communication.to_addresses !== transmission.to_addresses
          || communication.cc_addresses !== transmission.cc_addresses
          || communication.bcc_addresses !== transmission.bcc_addresses
          || communication.reply_to_address !== transmission.reply_to_address
          || communication.subject !== transmission.subject) return blocked('communication_changed');
        if (!outbox || outbox.communication_id !== transmission.communication_id
          || outbox.id !== transmission.outbox_id || outbox.state !== 'prepared'
          || outbox.attempt_count !== 0 || outbox.claim_token || outbox.claimed_at
          || outbox.claim_expires_at || outbox.provider || outbox.provider_message_id
          || outbox.next_attempt_at || outbox.last_error_category || outbox.last_error_message) {
          return blocked('outbox_changed');
        }
        const metadata = JSON.parse(communication.metadata || '{}');
        const outboxMetadata = JSON.parse(outbox.metadata || '{}');
        const communicationAuthority = authoritySnapshot.communication;
        if (communicationAuthority?.id !== communication.id
          || communicationAuthority?.outboxId !== communication.outbox_id
          || communicationAuthority?.threadId !== communication.thread_key
          || communicationAuthority?.fromAddressDigest !== sha256(communication.from_address ?? '')
          || communicationAuthority?.replyToAddressDigest !== sha256(communication.reply_to_address ?? '')
          || communicationAuthority?.subjectDigest !== sha256(communication.subject ?? '')
          || communicationAuthority?.bodyTextDigest !== sha256(communication.body_text ?? '')
          || communicationAuthority?.bodyHtmlDigest !== sha256(communication.body_html_sanitized ?? '')
          || JSON.stringify(communicationAuthority?.tags ?? []) !== JSON.stringify(metadata.tags ?? [])) {
          return blocked('communication_changed');
        }
        if (authoritySnapshot.outbox?.id !== outbox.id
          || authoritySnapshot.outbox?.updated_at !== outbox.updated_at
          || authoritySnapshot.outbox?.retry_policy !== outboxMetadata.retryPolicy
          || outboxMetadata.transmissionId !== transmission.id
          || outboxMetadata.retryPolicy !== 'reconcile-only-after-provider-pending') {
          return blocked('outbox_changed');
        }
        const payloadDigest = buildCimProviderPayloadDigest({
          message: {
            from: communication.from_address,
            to: JSON.parse(communication.to_addresses),
            cc: JSON.parse(communication.cc_addresses),
            bcc: JSON.parse(communication.bcc_addresses),
            replyTo: communication.reply_to_address,
            subject: communication.subject,
            text: communication.body_text,
            html: communication.body_html_sanitized,
            tags: metadata.tags,
          },
          touchIds: members.map(({ id }) => id),
          templateVersions: members.map(({ template_version: version }) => version),
          payloadVersion: transmission.payload_version,
        });
        if (payloadDigest !== transmission.payload_digest) return blocked('payload_changed');
        const transmissionChanged = database.prepare(`
          UPDATE deal_hunter_cim_transmissions SET state = 'provider-pending',
            release_state = 'authorized', final_gate_authority_digest = ?,
            campaign_terminal_revision = ?, conversation_terminal_revision = ?,
            invocation_authority_count = 1, provider_invocation_authorized_at = ?,
            boundary_nonce_digest = ?, row_version = row_version + 1, updated_at = ?
          WHERE id = ? AND state = 'prepared' AND invocation_authority_count = 0
            AND row_version = ?
        `).run(finalGateAuthorityDigest, expectedCampaignTerminalRevision,
          expectedConversationTerminalRevision, now, boundaryNonceDigest, now,
          transmissionId, expectedRowVersion).changes;
        if (transmissionChanged !== 1) throw new Error('CIM final-gate transmission CAS failed');
        for (const member of members) {
          const touchChanged = database.prepare(`
          UPDATE deal_hunter_cim_campaign_touches SET state = 'provider-pending',
            row_version = row_version + 1, updated_at = ?
          WHERE id = ? AND state = 'claimed' AND transmission_id = ?
        `).run(now, member.id, transmissionId).changes;
          if (touchChanged !== 1) throw new Error('CIM final-gate touch CAS failed');
        }
        const authorizationChanged = database.prepare(`
          UPDATE deal_hunter_cim_live_provider_authorizations SET consumed_at = ?
          WHERE id = ? AND consumed_at IS NULL AND withdrawn_at IS NULL
        `).run(now, authorizationId).changes;
        if (authorizationChanged !== 1) throw new Error('CIM final-gate authorization CAS failed');
        const communicationChanged = database.prepare(`
          UPDATE crm_communications SET delivery_state = 'provider-pending',
            delivery_state_at = ?, updated_at = ?
          WHERE id = ? AND delivery_state = 'not-attempted'
        `).run(now, now, transmission.communication_id).changes;
        if (communicationChanged !== 1) throw new Error('CIM final-gate communication CAS failed');
        const outboxChanged = database.prepare(`
          UPDATE crm_email_outbox SET state = 'provider-pending', updated_at = ?
          WHERE id = ? AND state = 'prepared' AND attempt_count = 0
        `).run(now, transmission.outbox_id).changes;
        if (outboxChanged !== 1) throw new Error('CIM final-gate outbox CAS failed');
        appendAudit(database, { eventType: 'final-gate-authorized', authorityId: transmissionId,
          conversationId: transmission.conversation_id, transmissionId,
          authorityDigest: finalGateAuthorityDigest, actor, occurredAt: now });
        appendAudit(database, { eventType: 'provider-pending', authorityId: transmissionId,
          conversationId: transmission.conversation_id, transmissionId,
          priorState: 'prepared', nextState: 'provider-pending',
          authorityDigest: finalGateAuthorityDigest, actor, occurredAt: now });
        appendAudit(database, { eventType: 'live-authorization-consumed', authorityId: authorizationId,
          transmissionId, authorizationId, priorState: 'issued', nextState: 'consumed',
          actor, occurredAt: now });
        return { authorized: true, blockedReason: null,
          transmission: database.prepare(`
            SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
          `).get(transmissionId), boundaryNonceDigest };
      }).immediate();
    },
    async issueCimLiveProviderAuthorization(command) {
      const id = requiredText(command.id, 'id');
      const activationId = requiredText(command.activationId, 'activationId');
      const capability = requiredText(command.capability, 'capability', 40);
      const writerPath = requiredText(command.writerPath, 'writerPath');
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const payloadDigest = requiredText(command.payloadDigest, 'payloadDigest', 64);
      const recipientAuthorityDigest = requiredText(command.recipientAuthorityDigest,
        'recipientAuthorityDigest', 64);
      if (![payloadDigest, recipientAuthorityDigest].every((value) => /^[0-9a-f]{64}$/.test(value))) {
        throw new Error('Invalid authorization digest');
      }
      const providerProfile = requiredText(command.providerProfile, 'providerProfile', 120);
      const actor = requiredText(command.actor, 'actor', 200);
      const reason = requiredText(command.reason, 'reason', 1000);
      const now = requiredInstant(command.now);
      const expiresAt = requiredInstant(command.expiresAt);
      if (Date.parse(expiresAt) <= Date.parse(now)) throw new Error('Authorization already expired');
      const outcome = (flags, authorization = null) => ({ issued: false, replay: false,
        conflict: false, blockedReason: null, ...flags, authorization });
      return database.transaction(() => {
        const existing = database.prepare(`
          SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?
        `).get(id);
        if (existing) {
          const replay = existing.activation_id === activationId && existing.capability === capability
            && existing.writer_path === writerPath && existing.transmission_id === transmissionId
            && existing.payload_digest === payloadDigest
            && existing.recipient_authority_digest === recipientAuthorityDigest
            && existing.provider_profile === providerProfile && existing.expires_at === expiresAt
            && (writerPath !== P10B_QUALIFICATION_WRITER
              || (existing.reason === reason && existing.actor === actor && existing.issued_at === now));
          return outcome({ replay, conflict: !replay }, existing);
        }
        const current = database.prepare(`
          SELECT * FROM deal_hunter_cim_live_provider_authorizations
          WHERE transmission_id = ? AND writer_path = ?
            AND consumed_at IS NULL AND withdrawn_at IS NULL
        `).get(transmissionId, writerPath);
        if (current) return outcome({ blockedReason: 'authorization_exists' }, current);
        const activation = currentActivationChain(database, capability, now);
        if (!activation || activation.id !== activationId
          || activation.provider_profile !== providerProfile) {
          return outcome({ blockedReason: 'capability_inactive' });
        }
        const transmission = database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId);
        if (!transmission || transmission.state !== 'prepared'
          || transmission.payload_digest !== payloadDigest) {
          return outcome({ blockedReason: 'transmission_invalid' });
        }
        if (writerPath === P10B_QUALIFICATION_WRITER
          && (capability !== 'fl04b-initial' || providerProfile !== 'controlled-mailbox-v1'
            || reason !== qualificationReason(command.qualification?.manifest)
            || command.qualification?.manifest?.issuedAt !== now
            || command.qualification?.manifest?.expiresAt !== expiresAt
            || !qualificationBound(database, command.qualification, { transmission, now }))) {
          return outcome({ blockedReason: 'live_authorization_invalid' });
        }
        const members = database.prepare(`
          SELECT c.recipient_fingerprint, t.kind
          FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_campaigns c ON c.id = m.campaign_id
          JOIN deal_hunter_cim_campaign_touches t ON t.id = m.touch_id
          WHERE m.transmission_id = ? AND m.cancelled_at IS NULL
        `).all(transmissionId);
        if (!members.length || members.some((member) =>
          member.recipient_fingerprint !== recipientAuthorityDigest
          || (member.kind === 'initial' && capability !== 'fl04b-initial')
          || (member.kind !== 'initial' && capability === 'fl04b-initial'))) {
          return outcome({ blockedReason: 'recipient_authority_changed' });
        }
        database.prepare(`
          INSERT INTO deal_hunter_cim_live_provider_authorizations (
            id, activation_id, capability, writer_path, transmission_id,
            payload_digest, recipient_authority_digest, provider_profile,
            maximum_calls, issued_at, expires_at, actor, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(id, activationId, capability, writerPath, transmissionId,
          payloadDigest, recipientAuthorityDigest, providerProfile, now, expiresAt,
          actor, reason);
        appendAudit(database, { eventType: 'live-authorization-issued', authorityId: id,
          transmissionId, activationId, authorizationId: id, nextState: 'issued',
          payloadDigest, actor, occurredAt: now });
        return outcome({ issued: true }, database.prepare(`
          SELECT * FROM deal_hunter_cim_live_provider_authorizations WHERE id = ?
        `).get(id));
      }).immediate();
    },
    prepareReservedCimFollowUp(command) {
      const activationId = requiredText(command.activationId, 'activationId');
      const claimOwner = requiredText(command.claimOwner, 'claimOwner', 200);
      const recipientFingerprint = requiredText(command.recipientFingerprint,
        'recipientFingerprint', 64);
      if (!/^[0-9a-f]{64}$/.test(recipientFingerprint)
        || !Array.isArray(command.touchIds) || command.touchIds.length !== 1) {
        throw new Error('Invalid follow-up reservation binding');
      }
      const touchId = requiredText(command.touchIds[0], 'touchId');
      const claimTokenDigest = requiredText(command.claimTokenDigest, 'claimTokenDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(claimTokenDigest)) throw new Error('Invalid claim token digest');
      const outcome = (flags = {}, transmission = null, reservation = null) => ({
        prepared: false, existing: false, capacityDeferred: false,
        payloadConflict: false, terminal: false, blockedReason: null,
        ...flags, transmission, reservation,
      });
      return database.transaction(() => {
        const now = executionInstant();
        database.prepare(`UPDATE deal_hunter_cim_capacity_reservations
          SET state='expired', expired_at=?, row_version=row_version+1
          WHERE state='reserved' AND expires_at <= ?`).run(now, now);
        const touch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
          WHERE id=?`).get(touchId);
        const campaign = touch && database.prepare(`SELECT * FROM deal_hunter_cim_campaigns
          WHERE id=?`).get(touch.campaign_id);
        const conversation = campaign && database.prepare(`SELECT *
          FROM deal_hunter_broker_conversations WHERE id=?`).get(campaign.conversation_id);
        const activation = currentActivationChain(database, 'fl04c-followup', now);
        const blocked = (blockedReason) => outcome({ terminal: true, blockedReason });
        if (!touch || !campaign || !conversation || activation?.id !== activationId
          || activation.status !== 'current' || activation.mode !== 'active') {
          return blocked('capability_inactive');
        }
        if (touch.kind === 'initial' || touch.campaign_id !== campaign.id
          || touch.opportunity_id !== campaign.opportunity_id
          || campaign.state !== 'active-follow-up' || conversation.state !== 'open'
          || campaign.conversation_id !== conversation.id
          || campaign.recipient_fingerprint !== recipientFingerprint
          || conversation.recipient_fingerprint !== recipientFingerprint
          || campaign.terminal_revision !== command.expectedCampaignTerminalRevision
          || conversation.terminal_revision !== command.expectedConversationTerminalRevision
          || (campaign.local_expiry_at && campaign.local_expiry_at <= now)) {
          return blocked('recipient_authority_changed');
        }
        if (conversation.recipient_address !== command.toAddresses?.[0]
          || touch.state !== 'claimed' || touch.claim_token_digest !== claimTokenDigest
          || touch.claim_owner !== claimOwner || !touch.claim_expires_at
          || touch.claim_expires_at <= now) return blocked('claim_expired');
        if (Date.parse(touch.claim_expires_at) > Date.parse(now) + 5 * 60 * 1000) {
          return blocked('claim_expiry_invalid');
        }
        if (database.prepare(`SELECT 1 FROM email_suppressions
          WHERE normalized_email=lower(?) AND lifted_at IS NULL LIMIT 1`)
          .get(conversation.recipient_address)
          || database.prepare(`SELECT 1 FROM email_events WHERE lower(recipient_email)=lower(?)
            AND event_type IN ('complained','complaint','bounced','hard_bounce',
              'unsubscribe','unsubscribed','opt_out') LIMIT 1`)
            .get(conversation.recipient_address)) return blocked('recipient_suppressed');
        if (database.prepare(`SELECT 1 FROM crm_communications
          WHERE direction='inbound' AND (thread_key=? OR submission_id=?) LIMIT 1`)
          .get(conversation.rfc_thread_key, campaign.crm_submission_id)) return blocked('reply_received');
        const active = database.prepare(`SELECT r.id AS reservation_id,
            tr.preparation_generation
          FROM deal_hunter_cim_capacity_reservations r
          JOIN deal_hunter_cim_transmissions tr ON tr.id=r.transmission_id
          WHERE r.touch_id=? AND r.state='reserved' LIMIT 1`).get(touchId);
        if (active) {
          if (command.preparationGeneration !== active.preparation_generation) {
            return outcome({ payloadConflict: true, blockedReason: 'payload_conflict' },
              database.prepare(`SELECT tr.* FROM deal_hunter_cim_capacity_reservations r
                JOIN deal_hunter_cim_transmissions tr ON tr.id=r.transmission_id
                WHERE r.id=?`).get(active.reservation_id),
              database.prepare(`SELECT * FROM deal_hunter_cim_capacity_reservations
                WHERE id=?`).get(active.reservation_id));
          }
          const prepared = transitions.prepareCimTransmissionSync({ ...command, now,
            preparationGeneration: command.preparationGeneration });
          return outcome({ existing: prepared.existing,
            payloadConflict: prepared.payloadConflict,
            terminal: prepared.terminal,
            blockedReason: prepared.terminal ? 'terminal_authority_changed'
              : prepared.payloadConflict ? 'payload_conflict' : null },
          prepared.transmission, database.prepare(`SELECT *
            FROM deal_hunter_cim_capacity_reservations WHERE id=?`).get(active.reservation_id));
        }
        const priorTransmission = database.prepare(`SELECT tr.*
          FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_transmissions tr ON tr.id=m.transmission_id
          WHERE m.touch_id=? AND m.cancelled_at IS NULL LIMIT 1`).get(touchId);
        if (priorTransmission) return outcome({ terminal: true,
          blockedReason: 'reservation_renewal_required' }, priorTransmission);
        if (command.preparationGeneration !== 1) return outcome({ payloadConflict: true,
          blockedReason: 'preparation_generation_invalid' });
        const window = cimFollowUpCapacityWindow(now);
        const addressDigest = sha256(conversation.recipient_address.trim().toLowerCase());
        const dailyCount = database.prepare(`SELECT COUNT(*) AS count
          FROM deal_hunter_cim_capacity_reservations WHERE capacity_date=? AND
          (state='consumed' OR (state='reserved' AND expires_at>?))`)
          .get(window.capacityDate, now).count;
        if (!Number.isSafeInteger(activation.daily_cap) || activation.daily_cap < 1
          || dailyCount >= activation.daily_cap) {
          return outcome({ capacityDeferred: true, blockedReason: 'daily_capacity' });
        }
        const recipientCount = database.prepare(`SELECT COUNT(*) AS count
          FROM deal_hunter_cim_capacity_reservations WHERE recipient_address_digest=?
          AND recipient_window_expires_at>? AND state IN ('reserved','consumed')`)
          .get(addressDigest, now).count;
        if (!Number.isSafeInteger(activation.recipient_cap) || activation.recipient_cap < 1
          || recipientCount >= activation.recipient_cap) {
          return outcome({ capacityDeferred: true, blockedReason: 'recipient_capacity' });
        }
        const campaignReservation = database.prepare(`SELECT 1
          FROM deal_hunter_cim_capacity_reservations
          WHERE campaign_id=? AND state='reserved' LIMIT 1`).get(campaign.id);
        if (campaignReservation) return outcome({ capacityDeferred: true,
          blockedReason: 'campaign_capacity' });
        const prepared = transitions.prepareCimTransmissionSync({ ...command, now });
        if (!prepared.prepared) return outcome({ existing: prepared.existing,
          payloadConflict: prepared.payloadConflict, terminal: prepared.terminal,
          blockedReason: prepared.terminal ? 'terminal_authority_changed' : null },
        prepared.transmission);
        const expiresAt = new Date(Math.min(Date.parse(touch.claim_expires_at),
          Date.parse(window.nextMidnight))).toISOString();
        if (expiresAt <= now) throw new Error('Invalid capacity reservation lifetime');
        const reservationId = digest('cim-follow-up-capacity:v1', prepared.transmission.id,
          claimTokenDigest, window.capacityDate);
        database.prepare(`INSERT INTO deal_hunter_cim_capacity_reservations (
          id, activation_id, transmission_id, touch_id, campaign_id, conversation_id,
          recipient_fingerprint, recipient_address_digest, capacity_date,
          claim_token_digest, state, reserved_at, expires_at,
          recipient_window_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
          .run(reservationId, activation.id, prepared.transmission.id, touch.id,
            campaign.id, conversation.id, recipientFingerprint, addressDigest,
            window.capacityDate, claimTokenDigest, now, expiresAt,
            window.recipientWindowExpiresAt);
        const reservation = database.prepare(`SELECT *
          FROM deal_hunter_cim_capacity_reservations WHERE id=?`).get(reservationId);
        appendAudit(database, { eventType: 'follow-up-capacity-reserved',
          authorityId: reservationId, opportunityId: touch.opportunity_id,
          campaignId: campaign.id, conversationId: conversation.id, touchId,
          transmissionId: prepared.transmission.id, activationId: activation.id,
          nextState: 'reserved', actor: command.actor, occurredAt: now });
        return outcome({ prepared: true }, prepared.transmission, reservation);
      }).immediate();
    },
    renewReservedCimFollowUp(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const touchId = requiredText(command.touchId, 'touchId');
      const activationId = requiredText(command.activationId, 'activationId');
      const recipientFingerprint = requiredText(command.recipientFingerprint,
        'recipientFingerprint', 64);
      const claimTokenDigest = requiredText(command.claimTokenDigest, 'claimTokenDigest', 64);
      const claimOwner = requiredText(command.claimOwner, 'claimOwner', 200);
      const claimExpiresAt = canonicalInstant(command.claimExpiresAt);
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      if (![recipientFingerprint, claimTokenDigest].every((value) => /^[0-9a-f]{64}$/.test(value))) {
        throw new Error('Invalid follow-up renewal binding');
      }
      const outcome = (flags = {}, transmission = null, reservation = null) => ({
        renewed: false, existing: false, capacityDeferred: false, terminal: false,
        blockedReason: null, ...flags, transmission, reservation,
      });
      return database.transaction(() => {
        const now = executionInstant();
        database.prepare(`UPDATE deal_hunter_cim_capacity_reservations
          SET state='expired', expired_at=?, row_version=row_version+1
          WHERE state='reserved' AND expires_at <= ?`).run(now, now);
        const transmission = database.prepare(`SELECT * FROM deal_hunter_cim_transmissions
          WHERE id=?`).get(transmissionId);
        const touch = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
          WHERE id=?`).get(touchId);
        const campaign = touch && database.prepare(`SELECT * FROM deal_hunter_cim_campaigns
          WHERE id=?`).get(touch.campaign_id);
        const conversation = campaign && database.prepare(`SELECT *
          FROM deal_hunter_broker_conversations WHERE id=?`).get(campaign.conversation_id);
        const activation = currentActivationChain(database, 'fl04c-followup', now);
        const window = cimFollowUpCapacityWindow(now);
        const reservationId = digest('cim-follow-up-capacity:v1', transmissionId,
          claimTokenDigest, window.capacityDate);
        const addressDigest = conversation
          ? sha256(conversation.recipient_address.trim().toLowerCase()) : '';
        const replay = database.prepare(`SELECT * FROM deal_hunter_cim_capacity_reservations
          WHERE id=?`).get(reservationId);
        if (replay) {
          if (!transmission || transmission.state !== 'prepared'
            || transmission.invocation_authority_count !== 0 || !touch || !campaign || !conversation
            || touch.transmission_id !== transmission.id || touch.state !== 'claimed'
            || touch.claim_token_digest !== claimTokenDigest || touch.claim_owner !== claimOwner
            || touch.claim_expires_at !== claimExpiresAt || touch.claim_expires_at <= now
            || campaign.state !== 'active-follow-up' || conversation.state !== 'open'
            || activation?.id !== activationId
            || campaign.recipient_fingerprint !== recipientFingerprint
            || conversation.recipient_fingerprint !== recipientFingerprint
            || (campaign.local_expiry_at && campaign.local_expiry_at <= now)
            || replay.state !== 'reserved' || replay.activation_id !== activationId
            || replay.transmission_id !== transmission.id || replay.touch_id !== touch.id
            || replay.campaign_id !== campaign.id || replay.conversation_id !== conversation.id
            || replay.recipient_fingerprint !== recipientFingerprint
            || replay.recipient_address_digest !== addressDigest
            || replay.claim_token_digest !== claimTokenDigest || replay.expires_at <= now) {
            return outcome({ terminal: true, blockedReason: 'renewal_authority_changed' },
              transmission, replay);
          }
          return outcome({ existing: true }, transmission, replay);
        }
        if (!transmission || transmission.state !== 'prepared'
          || transmission.invocation_authority_count !== 0 || !touch || !campaign || !conversation
          || touch.transmission_id !== transmission.id || touch.row_version !== expectedRowVersion
          || touch.state !== 'claimed' || touch.claim_expires_at > now
          || campaign.state !== 'active-follow-up'
          || conversation.state !== 'open' || activation?.id !== activationId
          || campaign.recipient_fingerprint !== recipientFingerprint
          || conversation.recipient_fingerprint !== recipientFingerprint
          || (campaign.local_expiry_at && campaign.local_expiry_at <= now)
          || claimExpiresAt <= now || Date.parse(claimExpiresAt) > Date.parse(now) + 5 * 60 * 1000) {
          return outcome({ terminal: true, blockedReason: 'renewal_authority_changed' }, transmission);
        }
        const prior = database.prepare(`SELECT * FROM deal_hunter_cim_capacity_reservations
          WHERE transmission_id=? ORDER BY reserved_at DESC, id DESC LIMIT 1`).get(transmission.id);
        if (!prior || prior.state !== 'expired'
          || prior.activation_id !== activationId || prior.touch_id !== touch.id
          || prior.campaign_id !== campaign.id || prior.conversation_id !== conversation.id
          || prior.recipient_fingerprint !== recipientFingerprint
          || prior.recipient_address_digest !== addressDigest) {
          return outcome({ terminal: true, blockedReason: 'renewal_not_permitted' }, transmission);
        }
        if (!Number.isSafeInteger(activation.daily_cap) || activation.daily_cap < 1
          || !Number.isSafeInteger(activation.recipient_cap) || activation.recipient_cap < 1) {
          return outcome({ terminal: true, blockedReason: 'renewal_authority_changed' }, transmission);
        }
        const dailyCount = database.prepare(`SELECT COUNT(*) AS count
          FROM deal_hunter_cim_capacity_reservations WHERE capacity_date=? AND
          (state='consumed' OR (state='reserved' AND expires_at>?))`)
          .get(window.capacityDate, now).count;
        if (dailyCount >= activation.daily_cap) return outcome({ capacityDeferred: true,
          blockedReason: 'daily_capacity' }, transmission);
        const recipientCount = database.prepare(`SELECT COUNT(*) AS count
          FROM deal_hunter_cim_capacity_reservations WHERE recipient_address_digest=?
          AND recipient_window_expires_at>? AND state IN ('reserved','consumed')`)
          .get(addressDigest, now).count;
        if (recipientCount >= activation.recipient_cap) return outcome({ capacityDeferred: true,
          blockedReason: 'recipient_capacity' }, transmission);
        const campaignReservation = database.prepare(`SELECT 1
          FROM deal_hunter_cim_capacity_reservations
          WHERE campaign_id=? AND state='reserved' LIMIT 1`).get(campaign.id);
        if (campaignReservation) return outcome({ capacityDeferred: true,
          blockedReason: 'campaign_capacity' }, transmission);
        const expiresAt = new Date(Math.min(Date.parse(claimExpiresAt),
          Date.parse(window.nextMidnight))).toISOString();
        const updated = database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET
          claim_token_digest=?, claim_owner=?, claimed_at=?, claim_expires_at=?,
          row_version=row_version+1, updated_at=? WHERE id=? AND row_version=?
          AND transmission_id=? AND state='claimed'`)
          .run(claimTokenDigest, claimOwner, now, claimExpiresAt, now, touch.id,
            expectedRowVersion, transmission.id);
        if (updated.changes !== 1) throw new Error('Follow-up renewal lost touch authority');
        database.prepare(`INSERT INTO deal_hunter_cim_capacity_reservations (
          id, activation_id, transmission_id, touch_id, campaign_id, conversation_id,
          recipient_fingerprint, recipient_address_digest, capacity_date,
          claim_token_digest, state, reserved_at, expires_at, recipient_window_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
          .run(reservationId, activation.id, transmission.id, touch.id, campaign.id,
            conversation.id, recipientFingerprint, addressDigest, window.capacityDate,
            claimTokenDigest, now, expiresAt, window.recipientWindowExpiresAt);
        const reservation = database.prepare(`SELECT *
          FROM deal_hunter_cim_capacity_reservations WHERE id=?`).get(reservationId);
        appendAudit(database, { eventType: 'follow-up-capacity-renewed',
          authorityId: reservationId, opportunityId: touch.opportunity_id,
          campaignId: campaign.id, conversationId: conversation.id, touchId,
          transmissionId: transmission.id, activationId: activation.id,
          priorState: 'expired', nextState: 'reserved', actor: command.actor,
          occurredAt: now });
        return outcome({ renewed: true }, transmission, reservation);
      }).immediate();
    },
    prepareCimTransmissionSync(command) {
      if (!Array.isArray(command.touchIds) || command.touchIds.length < 1
        || command.touchIds.length > 50 || new Set(command.touchIds).size !== command.touchIds.length) {
        throw new Error('Invalid transmission membership');
      }
      const touchIds = command.touchIds.map((id) => requiredText(id, 'touchId')).sort();
      const claimTokenDigest = requiredText(command.claimTokenDigest, 'claimTokenDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(claimTokenDigest)) throw new Error('Invalid claim token digest');
      const expectedCampaignTerminalRevision = requiredRevision(
        command.expectedCampaignTerminalRevision, 'expectedCampaignTerminalRevision');
      const expectedConversationTerminalRevision = requiredRevision(
        command.expectedConversationTerminalRevision, 'expectedConversationTerminalRevision');
      const preparationGeneration = requiredRevision(command.preparationGeneration, 'preparationGeneration');
      if (preparationGeneration < 1) throw new Error('Preparation generation must be positive');
      const payloadVersion = requiredText(command.payloadVersion, 'payloadVersion', 120);
      const fromAddress = requiredText(command.fromAddress, 'fromAddress', 320);
      const replyToAddress = command.replyToAddress === ''
        && payloadVersion === 'p10b-limited-free-smoke-test-v1'
        ? '' : requiredText(command.replyToAddress, 'replyToAddress', 320);
      const subject = requiredText(command.subject, 'subject', 998);
      const bodyText = requiredText(command.bodyText, 'bodyText', 100000);
      const bodyHtmlSanitized = requiredText(command.bodyHtmlSanitized, 'bodyHtmlSanitized', 100000);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = canonicalInstant(command.now);
      const addresses = {};
      for (const key of ['toAddresses', 'ccAddresses', 'bccAddresses']) {
        if (!Array.isArray(command[key]) || command[key].length > 20) throw new Error(`Invalid ${key}`);
        addresses[key] = command[key].map((value) => requiredText(value, key, 320));
      }
      if (addresses.toAddresses.length !== 1 || !Array.isArray(command.tags)
        || command.tags.length > 30 || command.tags.some((tag) =>
          typeof tag !== 'string' || tag.length < 1 || tag.length > 120)) {
        throw new Error('Invalid transmission recipient or tags');
      }
      const result = (flags, transmission = null) => ({ prepared: false, existing: false,
        payloadConflict: false, terminal: false, ...flags, transmission });
      return database.transaction(() => {
        const touches = touchIds.map((id) => database.prepare(`
          SELECT * FROM deal_hunter_cim_campaign_touches WHERE id = ?
        `).get(id));
        if (touches.some((touch) => !touch)) return result({ terminal: true });
        const campaigns = touches.map((touch) => database.prepare(`
          SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?
        `).get(touch.campaign_id));
        if (campaigns.some((campaign, index) => !campaign
          || touches[index].campaign_id !== campaign.id
          || touches[index].opportunity_id !== campaign.opportunity_id)) {
          return result({ terminal: true });
        }
        const conversationId = campaigns[0].conversation_id;
        const conversation = database.prepare(`
          SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
        `).get(conversationId);
        const capability = touchIds.length > 1 ? 'fl04c-batch'
          : touches[0].kind === 'initial' ? 'fl04b-initial' : 'fl04c-followup';
        const payloadDigest = buildCimProviderPayloadDigest({
          message: {
            from: fromAddress,
            to: addresses.toAddresses,
            cc: addresses.ccAddresses,
            bcc: addresses.bccAddresses,
            replyTo: replyToAddress,
            subject,
            text: bodyText,
            html: bodyHtmlSanitized,
            tags: command.tags,
          },
          touchIds,
          templateVersions: campaigns.map((campaign) => campaign.template_version),
          payloadVersion,
        });
        const currentMembership = database.prepare(`
          SELECT t.* FROM deal_hunter_cim_transmission_touches m
          JOIN deal_hunter_cim_transmissions t ON t.id = m.transmission_id
          WHERE m.touch_id = ? AND m.cancelled_at IS NULL
        `).get(touchIds[0]);
        if (currentMembership) {
          const allMembers = database.prepare(`
            SELECT touch_id FROM deal_hunter_cim_transmission_touches
            WHERE transmission_id = ? AND cancelled_at IS NULL ORDER BY touch_id
          `).all(currentMembership.id).map(({ touch_id: id }) => id);
          if (JSON.stringify(allMembers) !== JSON.stringify(touchIds)) {
            return result({ payloadConflict: true }, currentMembership);
          }
          if (currentMembership.payload_digest === payloadDigest) {
            return result({ existing: preparationGeneration === currentMembership.preparation_generation,
              payloadConflict: preparationGeneration !== currentMembership.preparation_generation }, currentMembership);
          }
          if (preparationGeneration !== currentMembership.preparation_generation + 1) {
            return result({ payloadConflict: true }, currentMembership);
          }
          const crmOwner = database.prepare(`SELECT s.id FROM contact_submissions AS s
            JOIN deal_hunter_opportunities AS o ON o.opportunity_id = s.deal_hunter_opportunity_id
            WHERE s.id = ? AND s.deal_hunter_opportunity_id = ?
              AND s.archived_at IS NULL AND o.primary_submission_id = s.id
          `).get(campaigns[0].crm_submission_id, campaigns[0].opportunity_id);
          if (!currentActivationChain(database, capability, now) || !conversation
            || conversation.state !== 'open'
            || conversation.terminal_revision !== expectedConversationTerminalRevision
            || conversation.recipient_address !== addresses.toAddresses[0]
            || !crmOwner
            || campaigns.some((campaign) => campaign.conversation_id !== conversationId
              || campaign.terminal_revision !== expectedCampaignTerminalRevision
              || !['initial-pending', 'active-follow-up'].includes(campaign.state)
              || (touches[0].kind === 'initial' && (campaign.state !== 'initial-pending'
                || campaign.generation !== 1
                || campaign.policy_version !== 'deal-hunter-cim-autopilot-v1'))
              || (campaign.local_expiry_at && Date.parse(campaign.local_expiry_at) <= Date.parse(now)))
            || touches.some((touch) => (touch.kind === 'initial'
              && (touch.logical_slot !== 'initial' || touch.ordinal !== 0))
              || touch.state !== 'claimed'
              || touch.claim_token_digest !== claimTokenDigest
              || !touch.claim_expires_at
              || Date.parse(touch.claim_expires_at) <= Date.parse(now)
              || touch.transmission_id !== currentMembership.id)) {
            return result({ terminal: true }, currentMembership);
          }
          if (!cancelPreparedTransmission(database, currentMembership,
            { now, reasonCode: 'prepared-payload-changed', actor, preserveClaim: true })) {
            return result({ payloadConflict: true }, currentMembership);
          }
          for (const touch of touches) touch.transmission_id = null;
        }
        if (!currentActivationChain(database, capability, now)
          || !conversation || conversation.state !== 'open'
          || conversation.terminal_revision !== expectedConversationTerminalRevision
          || conversation.recipient_address !== addresses.toAddresses[0]
          || campaigns.some((campaign) => campaign.conversation_id !== conversationId
            || campaign.terminal_revision !== expectedCampaignTerminalRevision
            || !['initial-pending', 'active-follow-up'].includes(campaign.state)
            || (touches[0].kind === 'initial' && (campaign.state !== 'initial-pending'
              || campaign.generation !== 1
              || campaign.policy_version !== 'deal-hunter-cim-autopilot-v1'))
            || !campaign.crm_submission_id
            || (campaign.local_expiry_at && Date.parse(campaign.local_expiry_at) <= Date.parse(now)))
          || touches.some((touch) => (touch.kind === 'initial'
            && (touch.logical_slot !== 'initial' || touch.ordinal !== 0))
            || touch.state !== 'claimed'
            || touch.claim_token_digest !== claimTokenDigest || touch.transmission_id
            || !touch.claim_expires_at
            || Date.parse(touch.claim_expires_at) <= Date.parse(now))) {
          return result({ terminal: true });
        }
        const crmOwner = database.prepare(`
          SELECT * FROM contact_submissions WHERE id = ?
        `).get(campaigns[0].crm_submission_id);
        const currentOpportunity = database.prepare(`
          SELECT primary_submission_id FROM deal_hunter_opportunities WHERE opportunity_id = ?
        `).get(campaigns[0].opportunity_id);
        if (!crmOwner || crmOwner.deal_hunter_opportunity_id !== campaigns[0].opportunity_id
          || crmOwner.archived_at
          || currentOpportunity?.primary_submission_id !== crmOwner.id) {
          return result({ terminal: true });
        }
        const memberDigest = digest('cim-members:v1', touchIds);
        const transmissionId = digest('cim-transmission:v1', campaigns[0].policy_version,
          conversation.recipient_fingerprint, touchIds, preparationGeneration,
          payloadVersion, payloadDigest);
        const communicationId = digest('crm-communication:cim-autopilot:v1', transmissionId);
        const outboxId = digest('crm-outbox:cim-autopilot:v1', transmissionId);
        const providerKey = digest('cim-provider:v1', transmissionId, payloadDigest);
        const metadata = JSON.stringify({ transmissionId, conversationId,
          campaignIds: campaigns.map(({ id }) => id), touchIds, memberDigest,
          tags: command.tags, retryPolicy: 'reconcile-only-after-provider-pending' });
        database.prepare(`
          INSERT INTO crm_communications (
            id, submission_id, opportunity_id, direction, channel, source, kind,
            idempotency_key, outbox_id, thread_key, from_address, to_addresses,
            cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
            body_html_sanitized, occurred_at, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, 'outbound', 'email', 'pursue-cim-autopilot', ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(communicationId, crmOwner.id, campaigns[0].opportunity_id,
          touches[0].kind === 'initial' ? 'cim-initial' : 'cim-follow-up',
          communicationId, outboxId, conversation.rfc_thread_key, fromAddress,
          JSON.stringify(addresses.toAddresses), JSON.stringify(addresses.ccAddresses),
          JSON.stringify(addresses.bccAddresses), replyToAddress, subject, bodyText,
          bodyHtmlSanitized, now, now, now, metadata);
        database.prepare(`
          INSERT INTO crm_email_outbox (
            id, communication_id, submission_id, idempotency_key, client_request_key,
            state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata
          ) VALUES (?, ?, ?, ?, ?, 'prepared', 0, ?, ?, ?, ?, ?)
        `).run(outboxId, communicationId, crmOwner.id, outboxId,
          digest('cim-client-request:v1', transmissionId), crmOwner.updated_at,
          actor, now, now, metadata);
        database.prepare(`
          INSERT INTO deal_hunter_cim_transmissions (
            id, conversation_id, member_digest, preparation_generation, payload_version,
            payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
            reply_to_address, subject, provider_idempotency_key, communication_id,
            outbox_id, state, release_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'ordinary', ?, ?)
        `).run(transmissionId, conversationId, memberDigest, preparationGeneration,
          payloadVersion, payloadDigest, fromAddress, JSON.stringify(addresses.toAddresses),
          JSON.stringify(addresses.ccAddresses), JSON.stringify(addresses.bccAddresses),
          replyToAddress, subject, providerKey, communicationId, outboxId, now, now);
        for (const [index, touch] of touches.entries()) {
          database.prepare(`
            INSERT INTO deal_hunter_cim_transmission_touches (
              transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(transmissionId, touch.id, touch.opportunity_id, touch.campaign_id, index + 1, now);
          database.prepare(`
            UPDATE deal_hunter_cim_campaign_touches SET transmission_id = ?,
              row_version = row_version + 1, updated_at = ?
            WHERE id = ? AND state = 'claimed' AND claim_token_digest = ?
              AND transmission_id IS NULL
          `).run(transmissionId, now, touch.id, claimTokenDigest);
          appendAudit(database, { eventType: 'transmission-membership', authorityId: `${transmissionId}:${touch.id}`,
            opportunityId: touch.opportunity_id, campaignId: touch.campaign_id,
            conversationId, touchId: touch.id, transmissionId,
            nextState: 'active', actor, occurredAt: now });
        }
        appendAudit(database, { eventType: 'transmission-prepared', authorityId: transmissionId,
          opportunityId: campaigns[0].opportunity_id, conversationId, transmissionId,
          nextState: 'prepared', payloadDigest, actor, occurredAt: now });
        return result({ prepared: true }, database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId));
      }).immediate();
    },
    async prepareCimTransmission(command) {
      return transitions.prepareCimTransmissionSync(command);
    },
    async readCimOutreachCounters() {
      const counts = {};
      for (const [key, table, where] of [
        ['ownerDecisions', 'deal_hunter_owner_decision_events', ''],
        ['enrollments', 'deal_hunter_pursuit_enrollments', ''],
        ['campaigns', 'deal_hunter_cim_campaigns', ''],
        ['touches', 'deal_hunter_cim_campaign_touches', ''],
        ['transmissions', 'deal_hunter_cim_transmissions', ''],
        ['memberships', 'deal_hunter_cim_transmission_touches', ''],
        ['crmOutbound', 'crm_communications', "WHERE direction = 'outbound'"],
        ['outbox', 'crm_email_outbox', ''],
        ['providerAuthorizations', 'deal_hunter_cim_live_provider_authorizations', ''],
        ['providerPending', 'deal_hunter_cim_transmissions', "WHERE state = 'provider-pending'"],
        ['providerSeamEntries', 'deal_hunter_cim_transmissions', 'WHERE provider_seam_entered_at IS NOT NULL'],
      ]) {
        counts[key] = database.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n;
      }
      return counts;
    },
    async readPursueCimOperationsSnapshot({ now, limit = 100 } = {}) {
      const at = canonicalInstant(now);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Invalid Pursue CIM operations limit');
      }
      const counts = await transitions.readCimOutreachCounters();
      const grouped = (table, column, where = '') => Object.fromEntries(database.prepare(`
        SELECT COALESCE(${column}, 'unspecified') AS key, COUNT(*) AS count
        FROM ${table} ${where} GROUP BY COALESCE(${column}, 'unspecified')
        ORDER BY key LIMIT 101
      `).all().slice(0, 100).map((row) => [row.key, row.count]));
      const reasonGrouped = (table, where = '') => grouped(table, 'reason_code', where);
      const safety = database.prepare(`SELECT * FROM deal_hunter_cim_safety_settings
        WHERE id = 'global'`).get() ?? null;
      const paused = safety ? Number(safety.outreach_paused) === 1 : true;
      const providerPending = database.prepare(`SELECT COUNT(*) AS count,
        MIN(updated_at) AS oldest_at FROM deal_hunter_cim_transmissions
        WHERE state IN ('provider-pending', 'ambiguous')`).get();
      const activation = database.prepare(`SELECT COUNT(*) AS current,
        SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
        MIN(CASE WHEN expires_at > ? THEN expires_at END) AS nearest_expiry_at
        FROM deal_hunter_cim_capability_activations WHERE status = 'current'`).get(at, at);
      const legacy = database.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN request_state IN ('pending', 'ready') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN delivery_state IN ('ambiguous', 'unknown') THEN 1 ELSE 0 END) AS ambiguous,
        SUM(CASE WHEN last_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS writer_invocations
        FROM deal_hunter_cim_requests`).get();
      const oldestAt = providerPending.oldest_at ?? '';
      const scalar = (sql, ...parameters) => Number(database.prepare(sql).get(...parameters)?.count || 0);
      const writerPathCounts = Object.fromEntries(database.prepare(`
        SELECT 'accepted:' || a.writer_path AS key, COUNT(DISTINCT e.id) AS count
        FROM deal_hunter_cim_audit_events e
        JOIN deal_hunter_cim_live_provider_authorizations a
          ON a.id=e.authorization_id
        WHERE e.event_type='provider-seam-entered' GROUP BY a.writer_path
        UNION ALL
        SELECT 'rejected:' || a.writer_path, COUNT(DISTINCT e.id)
        FROM deal_hunter_cim_audit_events e
        JOIN deal_hunter_cim_live_provider_authorizations a
          ON a.id=e.authorization_id
        WHERE e.event_type='provider-boundary-rejected' GROUP BY a.writer_path
        ORDER BY key LIMIT 100`).all().map((row) => [row.key, row.count]));
      const missingAuthority = scalar(`SELECT COUNT(*) AS count
        FROM deal_hunter_cim_transmissions tr
        LEFT JOIN crm_communications c ON c.id = tr.communication_id
        LEFT JOIN crm_email_outbox o ON o.id = tr.outbox_id
        WHERE tr.provider_seam_entered_at IS NOT NULL AND (
          c.id IS NULL OR o.id IS NULL OR tr.final_gate_authority_digest IS NULL
          OR NOT EXISTS (SELECT 1 FROM deal_hunter_cim_live_provider_authorizations a
            WHERE a.transmission_id = tr.id AND a.consumed_at IS NOT NULL))`);
      const duplicateAcceptedTouches = scalar(`SELECT COUNT(*) AS count FROM (
        SELECT m.touch_id FROM deal_hunter_cim_transmission_touches m
        JOIN deal_hunter_cim_transmissions tr ON tr.id = m.transmission_id
        WHERE tr.state = 'accepted' AND m.cancelled_at IS NULL
        GROUP BY m.touch_id HAVING COUNT(*) > 1)`);
      const multipleActiveCampaigns = scalar(`SELECT COUNT(*) AS count FROM (
        SELECT opportunity_id FROM deal_hunter_cim_campaigns WHERE state IN (
          'queued','waiting-on-eligibility','initial-pending','active-follow-up',
          'action-required','provider-ambiguous') GROUP BY opportunity_id HAVING COUNT(*) > 1)`);
      const activeIdentityAmbiguities = scalar(`SELECT COUNT(DISTINCT c.id) AS count
        FROM deal_hunter_cim_campaigns c JOIN deal_hunter_identity_exceptions e
          ON e.status = 'open' AND EXISTS (
            SELECT 1 FROM json_each(e.candidate_opportunity_ids)
            WHERE json_each.value = c.opportunity_id)
        WHERE c.state IN ('queued','waiting-on-eligibility','initial-pending',
          'active-follow-up','action-required','provider-ambiguous')`);
      const invalidClaimedTimezones = scalar(`SELECT COUNT(*) AS count
        FROM deal_hunter_cim_campaign_touches t
        LEFT JOIN deal_hunter_opportunity_timezone_revisions z
          ON z.opportunity_id = t.opportunity_id AND z.revision = t.timezone_revision
        WHERE t.state = 'claimed' AND (z.opportunity_id IS NULL
          OR z.state NOT IN ('verified','derived') OR z.iana_timezone IS NULL)`);
      const terminalBeforeProvider = scalar(`SELECT COUNT(DISTINCT tr.id) AS count
        FROM deal_hunter_cim_transmissions tr
        JOIN deal_hunter_cim_transmission_touches m ON m.transmission_id = tr.id
        JOIN deal_hunter_cim_audit_events provider_pending
          ON provider_pending.transmission_id = tr.id
          AND provider_pending.event_type = 'provider-pending'
        JOIN deal_hunter_cim_terminal_events e ON
          (e.campaign_id = m.campaign_id OR e.conversation_id = tr.conversation_id)
        WHERE tr.provider_seam_entered_at IS NOT NULL
          AND e.created_at <= provider_pending.occurred_at
          AND e.reason_code IN ('reply_received','materials_received',
            'advanced_beyond_broker_outreach')`);
      const shadowRows = database.prepare(`SELECT * FROM (
        SELECT id AS subject_id, 'would-enroll' AS kind, state, reason_code,
          NULL AS payload_digest, created_at AS sort_at
        FROM deal_hunter_pursuit_enrollments
        WHERE state IN ('queued','waiting-on-eligibility')
        UNION ALL
        SELECT id, 'would-claim', state, terminal_reason, NULL, due_at
        FROM deal_hunter_cim_campaign_touches
        WHERE kind='initial' AND state IN ('scheduled','claimed') AND due_at <= ?
        UNION ALL
        SELECT id, 'would-send', state, NULL, payload_digest, created_at
        FROM deal_hunter_cim_transmissions
        WHERE state='prepared' AND provider_seam_entered_at IS NULL
      ) candidates ORDER BY sort_at, kind, subject_id LIMIT ?`).all(at, limit);
      const shadowCandidates = shadowRows.map((candidate) => {
        if (paused) return { kind: candidate.kind, subjectId: candidate.subject_id,
          eligible: false, reason: 'central_outreach_pause' };
        const capability = candidate.kind === 'would-enroll'
          ? 'fl04b-enrollment' : 'fl04b-initial';
        const currentActivation = currentActivationChain(database, capability, at);
        if (!currentActivation) return { kind: candidate.kind, subjectId: candidate.subject_id,
          eligible: false, reason: 'capability_inactive' };
        if (candidate.kind === 'would-enroll' && candidate.state !== 'queued') {
          return { kind: candidate.kind, subjectId: candidate.subject_id,
            eligible: false, reason: candidate.reason_code || 'enrollment_waiting' };
        }
        if (candidate.kind === 'would-claim' && candidate.state !== 'scheduled') {
          return { kind: candidate.kind, subjectId: candidate.subject_id,
            eligible: false, reason: 'already_claimed' };
        }
        if (candidate.kind === 'would-send') {
          const authorization = database.prepare(`SELECT 1
            FROM deal_hunter_cim_live_provider_authorizations
            WHERE transmission_id=? AND activation_id=? AND capability='fl04b-initial'
              AND payload_digest=? AND maximum_calls=1 AND consumed_at IS NULL
              AND withdrawn_at IS NULL AND expires_at > ? LIMIT 1`).get(
            candidate.subject_id, currentActivation.id, candidate.payload_digest, at);
          if (!authorization) return { kind: candidate.kind, subjectId: candidate.subject_id,
            eligible: false, reason: 'exact_live_authorization_missing' };
          return { kind: candidate.kind, subjectId: candidate.subject_id,
            eligible: false, reason: 'final_gate_readiness_unproven' };
        }
        return { kind: candidate.kind, subjectId: candidate.subject_id,
          eligible: true, reason: 'ready' };
      });
      return {
        counts,
        stateCounts: {
          enrollments: grouped('deal_hunter_pursuit_enrollments', 'state'),
          campaigns: grouped('deal_hunter_cim_campaigns', 'state'),
          touches: grouped('deal_hunter_cim_campaign_touches', 'state'),
          transmissions: grouped('deal_hunter_cim_transmissions', 'state'),
          conversations: grouped('deal_hunter_broker_conversations', 'state'),
        },
        reasonCounts: {
          enrollments: reasonGrouped('deal_hunter_pursuit_enrollments'),
          campaigns: reasonGrouped('deal_hunter_cim_campaigns'),
          touches: grouped('deal_hunter_cim_campaign_touches', 'terminal_reason'),
          gateBlocks: reasonGrouped('deal_hunter_cim_audit_events',
            "WHERE event_type = 'final-gate-blocked'"),
        },
        providerPending: { count: providerPending.count, oldestAt,
          oldestAgeSeconds: oldestAt ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(oldestAt)) / 1000)) : 0 },
        activations: { current: activation.current, expired: activation.expired ?? 0,
          nearestExpiryAt: activation.nearest_expiry_at ?? '',
          modes: grouped('deal_hunter_cim_capability_activations', 'mode', "WHERE status = 'current'") },
        legacy: { total: legacy.total, active: legacy.active ?? 0,
          ambiguous: legacy.ambiguous ?? 0, writerInvocations: legacy.writer_invocations ?? 0,
          classifications: grouped('deal_hunter_cim_requests', 'delivery_state') },
        boundary: {
          accepts: scalar(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
            WHERE event_type = 'provider-seam-entered'`),
          rejects: scalar(`SELECT COUNT(*) AS count FROM deal_hunter_cim_audit_events
            WHERE event_type = 'provider-boundary-rejected'`),
          byWriterPath: writerPathCounts,
        },
        invariants: {
          duplicateProviderIdentities: scalar(`SELECT COUNT(*) AS count
            FROM deal_hunter_cim_audit_events WHERE event_type = 'provider-identity-conflict'`),
          missingDurableAuthority: missingAuthority,
          multipleActiveCampaigns,
          duplicateAcceptedTouches,
          activeIdentityAmbiguities,
          unexpectedLegacyInvocations: scalar(`SELECT COUNT(*) AS count
            FROM deal_hunter_cim_requests
            WHERE last_attempt_at IS NOT NULL AND last_attempt_at >= (
              SELECT MIN(created_at) FROM deal_hunter_cim_capability_activations
              WHERE status='current' AND mode NOT IN ('off','shadow'))`),
          replyOrMaterialsBeforeGateProviderCalls: terminalBeforeProvider,
          invalidClaimedTimezones,
          expiredActivationAttempts: scalar(`SELECT COUNT(*) AS count
            FROM deal_hunter_cim_audit_events WHERE event_type='final-gate-blocked'
              AND reason_code='capability_inactive'`),
          missingEnvelopeAttempts: scalar(`SELECT COUNT(*) AS count
            FROM deal_hunter_cim_audit_events WHERE event_type='final-gate-blocked'
              AND reason_code IN ('live_authorization_missing','live_authorization_invalid',
                'authorization_missing','authorization_expired')`),
          readinessLoss: scalar(`SELECT COUNT(*) AS count
            FROM deal_hunter_cim_audit_events WHERE event_type='final-gate-blocked'
              AND reason_code='provider_readiness_unavailable'`),
          shadowProviderCalls: scalar(`SELECT COUNT(*) AS count
            FROM deal_hunter_cim_audit_events WHERE event_type='shadow-provider-call'`),
        },
        pause: { paused, source: safety ? 'operations-control' : 'fail-closed-default' },
        shadowCandidates,
      };
    },
    async applyPursueCimAutomaticContainment(command = {}) {
      const findingId = requiredText(command.findingId, 'findingId', 64);
      const evidenceDigest = requiredText(command.evidenceDigest, 'evidenceDigest', 64);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = canonicalInstant(command.now);
      if (!/^[0-9a-f]{64}$/.test(findingId) || !/^[0-9a-f]{64}$/.test(evidenceDigest)
        || !Array.isArray(command.findingCodes) || command.findingCodes.length < 1
        || command.findingCodes.length > 20) {
        throw new Error('Invalid Pursue CIM containment command');
      }
      const findingCodes = command.findingCodes.map((code) => requiredText(code,
        'findingCode', 160)).sort();
      if (new Set(findingCodes).size !== findingCodes.length
        || stableCanonicalJson(findingCodes) !== stableCanonicalJson(command.findingCodes)
        || findingCodes.some((code) => !pursueCimContainmentFindingCodes.has(code))) {
        throw new Error('Invalid Pursue CIM containment findings');
      }
      const auditId = `cim-containment:${findingId}`;
      return database.transaction(() => {
        const replay = Boolean(database.prepare(`SELECT 1 FROM deal_hunter_cim_audit_events
          WHERE id = ?`).get(auditId));
        const alreadySafe = database.prepare(`SELECT outreach_paused = 1 AS paused,
          NOT EXISTS (SELECT 1 FROM deal_hunter_cim_capability_activations
            WHERE status='current') AS activations_withdrawn,
          NOT EXISTS (SELECT 1 FROM deal_hunter_cim_live_provider_authorizations
            WHERE consumed_at IS NULL AND withdrawn_at IS NULL) AS authorizations_withdrawn
          FROM deal_hunter_cim_safety_settings WHERE id='global'`).get();
        if (replay && alreadySafe?.paused && alreadySafe.activations_withdrawn
          && alreadySafe.authorizations_withdrawn) {
          return { applied: false, replay: true, paused: true,
            withdrawnActivations: 0, withdrawnAuthorizations: 0 };
        }
        const currentSafety = database.prepare(`SELECT * FROM deal_hunter_cim_safety_settings
          WHERE id='global'`).get() ?? null;
        let metadata = {};
        try { metadata = JSON.parse(currentSafety?.metadata || '{}'); } catch { metadata = {}; }
        database.prepare(`INSERT INTO deal_hunter_cim_safety_settings
          (id, updated_at, outreach_paused, updated_by, metadata)
          VALUES ('global', ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,
            outreach_paused=1, updated_by=excluded.updated_by, metadata=excluded.metadata`)
          .run(now, actor, JSON.stringify({ ...metadata, p9Containment: {
            findingId, evidenceDigest, findingCodes, occurredAt: now } }));
        const activations = database.prepare(`SELECT id FROM deal_hunter_cim_capability_activations
          WHERE status='current' ORDER BY id`).all();
        for (const activation of activations) {
          database.prepare(`UPDATE deal_hunter_cim_capability_activations
            SET status='withdrawn', withdrawn_at=?, updated_at=?
            WHERE id=? AND status='current'`).run(now, now, activation.id);
          appendAudit(database, { eventType: 'capability-withdrawn',
            authorityId: `p9:${findingId}:${activation.id}`, activationId: activation.id,
            priorState: 'current', nextState: 'withdrawn',
            reasonCode: 'automatic_containment', actor, source: 'p9-auto-containment',
            occurredAt: now, authorityDigest: evidenceDigest });
        }
        const authorizations = database.prepare(`SELECT id, transmission_id
          FROM deal_hunter_cim_live_provider_authorizations
          WHERE consumed_at IS NULL AND withdrawn_at IS NULL ORDER BY id`).all();
        for (const authorization of authorizations) {
          database.prepare(`UPDATE deal_hunter_cim_live_provider_authorizations
            SET withdrawn_at=? WHERE id=? AND consumed_at IS NULL AND withdrawn_at IS NULL`)
            .run(now, authorization.id);
          appendAudit(database, { eventType: 'authorization-withdrawn',
            authorityId: `p9:${findingId}:${authorization.id}`,
            transmissionId: authorization.transmission_id,
            authorizationId: authorization.id, priorState: 'issued', nextState: 'withdrawn',
            reasonCode: 'automatic_containment', actor, source: 'p9-auto-containment',
            occurredAt: now, authorityDigest: evidenceDigest });
        }
        appendAudit(database, { id: replay
          ? digest('cim-containment-reasserted:v1', findingId, now) : auditId,
        eventType: replay ? 'automatic-containment-reasserted' : 'automatic-containment',
          authorityId: findingId, reasonCode: 'high_severity_invariant',
          authorityDigest: evidenceDigest, actor, source: 'p9-auto-containment',
          occurredAt: now, metadata: { findingCodes,
            withdrawnActivations: activations.length,
            withdrawnAuthorizations: authorizations.length } });
        return { applied: !replay, replay, paused: true,
          withdrawnActivations: activations.length,
          withdrawnAuthorizations: authorizations.length };
      }).immediate();
    },
    async listCimSafetyEvents({ safetyRunId }) {
      const runId = requiredText(safetyRunId, 'safetyRunId');
      const events = database.prepare(`SELECT * FROM deal_hunter_cim_safety_events
        WHERE safety_run_id = ? ORDER BY created_at, id LIMIT 10001`).all(runId);
      if (events.length > 10000) throw new Error('CIM safety run exceeds the bounded read.');
      return events;
    },
    async appendCimSafetyEvents(run) {
      const safetyRunId = requiredText(run.safetyRunId, 'safetyRunId');
      const sourceType = requiredText(run.sourceType, 'sourceType', 120);
      if (['sheet-import', 'deal-os-import'].includes(sourceType)) {
        throw new Error('Admitted import safety events require their source commit');
      }
      const sourceRunId = requiredText(run.sourceRunId, 'sourceRunId');
      const now = requiredInstant(run.now);
      if (!Array.isArray(run.events) || run.events.length > 10000) throw new Error('Invalid safety event batch');
      return database.transaction(() => {
        let emitted = 0;
        let existing = 0;
        for (const event of run.events) {
          const opportunityId = requiredText(event.opportunityId, 'opportunityId', 200);
          const canonicalRevision = requiredRevision(event.canonicalRevision, 'canonicalRevision');
          const identityExceptionRevision = requiredRevision(event.identityExceptionRevision,
            'identityExceptionRevision');
          const eventType = requiredText(event.eventType, 'eventType', 160);
          const evidenceId = requiredText(event.evidenceId, 'evidenceId');
          const id = digest('cim-safety:v1', safetyRunId, opportunityId, eventType, evidenceId);
          const prior = database.prepare('SELECT * FROM deal_hunter_cim_safety_events WHERE id = ?').get(id);
          if (prior) {
            if (prior.source_type !== sourceType || prior.source_run_id !== sourceRunId
              || prior.canonical_revision !== canonicalRevision
              || prior.identity_exception_revision !== identityExceptionRevision) {
              return { emitted: 0, existing, conflict: true };
            }
            existing += 1;
            continue;
          }
          database.prepare(`
            INSERT INTO deal_hunter_cim_safety_events (
              id, safety_run_id, opportunity_id, source_type, source_run_id,
              canonical_revision, identity_exception_revision, event_type, evidence_id,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(id, safetyRunId, opportunityId, sourceType, sourceRunId,
            canonicalRevision, identityExceptionRevision, eventType, evidenceId, now, now);
          appendAudit(database, { eventType: 'safety-emitted', authorityId: id,
            opportunityId, nextState: 'pending', actor: sourceType, source: sourceRunId,
            occurredAt: now });
          emitted += 1;
        }
        return { emitted, existing, conflict: false };
      }).immediate();
    },
    async consumeCimSafetyEvents(command) {
      const safetyRunId = requiredText(command.safetyRunId, 'safetyRunId');
      const limit = Number(command.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid safety limit');
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      return database.transaction(() => {
        const pending = database.prepare(`
          SELECT * FROM deal_hunter_cim_safety_events
          WHERE safety_run_id = ? AND status = 'pending'
          ORDER BY created_at, id LIMIT ?
        `).all(safetyRunId, limit);
        for (const event of pending) {
          const active = database.prepare(`
            SELECT * FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?
              AND state IN ('queued', 'waiting-on-eligibility', 'initial-pending',
                'active-follow-up', 'action-required', 'provider-ambiguous')
          `).get(event.opportunity_id);
          if (active) {
            const disposition = command.outcomes?.[event.id];
            if (disposition === 'no-op'
              && ['source-record-unchanged', 'source-record-superseded']
                .includes(event.event_type.split('#')[0])) {
              database.prepare(`UPDATE deal_hunter_cim_safety_events SET status = 'no-op',
                outcome_evidence_id = ?, consumed_at = ?, updated_at = ?
                WHERE id = ? AND status = 'pending'`).run(event.id, now, now, event.id);
              appendAudit(database, { eventType: 'safety-consumed', authorityId: event.id,
                opportunityId: event.opportunity_id, campaignId: active.id,
                priorState: 'pending', nextState: 'no-op', actor, occurredAt: now });
              continue;
            }
            if (!['stopped', 'review-required'].includes(disposition)
              || !currentActivationChain(database, 'fl04a-safety', now)) continue;
            const nextState = disposition === 'stopped' ? 'stopped' : 'action-required';
            if (!campaignTransitions[active.state]?.includes(nextState)) continue;
            const terminalEventId = digest('cim-terminal:safety:v1', event.id, active.id);
            const reasonCode = event.event_type;
            const prepared = database.prepare(`
              SELECT DISTINCT tr.* FROM deal_hunter_cim_transmissions tr
              JOIN deal_hunter_cim_transmission_touches m ON m.transmission_id = tr.id
              WHERE m.campaign_id = ? AND m.cancelled_at IS NULL
                AND tr.state IN ('prepared', 'final-gate-blocked')
            `).all(active.id);
            for (const transmission of prepared) {
              cancelPreparedTransmission(database, transmission, { now, reasonCode, actor });
            }
            const touches = database.prepare(`
              SELECT * FROM deal_hunter_cim_campaign_touches WHERE campaign_id = ?
                AND state IN ('scheduled', 'claimed') AND transmission_id IS NULL
            `).all(active.id);
            for (const touch of touches) {
              database.prepare(`
                UPDATE deal_hunter_cim_campaign_touches SET state = 'cancelled-before-provider',
                  terminal_reason = ?, updated_at = ?, row_version = row_version + 1
                WHERE id = ? AND row_version = ?
              `).run(reasonCode, now, touch.id, touch.row_version);
              appendAudit(database, { eventType: 'touch-cancelled',
                authorityId: `${touch.id}:${touch.row_version + 1}`,
                opportunityId: event.opportunity_id, campaignId: active.id, touchId: touch.id,
                priorState: touch.state, nextState: 'cancelled-before-provider',
                reasonCode, actor, occurredAt: now });
            }
            database.prepare(`
              UPDATE deal_hunter_cim_campaigns SET state = ?, reason_code = ?,
                terminal_revision = terminal_revision + 1, row_version = row_version + 1,
                updated_at = ? WHERE id = ? AND row_version = ? AND terminal_revision = ?
            `).run(nextState, reasonCode, now, active.id, active.row_version,
              active.terminal_revision);
            database.prepare(`
              INSERT INTO deal_hunter_cim_terminal_events (
                id, scope, scope_id, campaign_id, revision, reason_code, evidence_type,
                evidence_id, observed_at, actor, source, metadata_digest, created_at
              ) VALUES (?, 'campaign', ?, ?, ?, ?, 'safety-event', ?, ?, ?, 'safety-consumer', ?, ?)
            `).run(terminalEventId, active.id, active.id, active.terminal_revision + 1,
              reasonCode, event.id, now, actor, digest('safety-terminal:v1', event.id), now);
            database.prepare(`
              UPDATE deal_hunter_cim_safety_events SET status = ?, outcome_evidence_id = ?,
                outcome_revision = ?, consumed_at = ?, updated_at = ?
              WHERE id = ? AND status = 'pending'
            `).run(disposition, terminalEventId, active.terminal_revision + 1, now, now, event.id);
            appendAudit(database, { eventType: 'terminal-transition', authorityId: terminalEventId,
              opportunityId: event.opportunity_id, campaignId: active.id,
              priorState: active.state, nextState, reasonCode, actor, occurredAt: now });
            appendAudit(database, { eventType: 'safety-consumed', authorityId: event.id,
              opportunityId: event.opportunity_id, campaignId: active.id,
              priorState: 'pending', nextState: disposition, actor, occurredAt: now });
            continue;
          }
          database.prepare(`
            UPDATE deal_hunter_cim_safety_events SET status = 'no-op',
              outcome_evidence_id = ?, consumed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
          `).run(event.id, now, now, event.id);
          appendAudit(database, { eventType: 'safety-consumed', authorityId: event.id,
            opportunityId: event.opportunity_id, priorState: 'pending', nextState: 'no-op',
            actor, occurredAt: now });
        }
        const counts = database.prepare(`
          SELECT status, COUNT(*) AS count FROM deal_hunter_cim_safety_events
          WHERE safety_run_id = ? GROUP BY status
        `).all(safetyRunId);
        const byStatus = Object.fromEntries(counts.map(({ status, count }) => [status, count]));
        return { stopped: byStatus.stopped ?? 0, reviewRequired: byStatus['review-required'] ?? 0,
          noOp: byStatus['no-op'] ?? 0, pending: byStatus.pending ?? 0 };
      }).immediate();
    },
    convergeCimTerminalAuthority(command) {
      const opportunityIds = Array.isArray(command.opportunityIds)
        ? command.opportunityIds.map((value) => requiredText(value, 'opportunityId', 200)) : [];
      const opportunityId = command.opportunityId
        ? requiredText(command.opportunityId, 'opportunityId', 200) : '';
      if (opportunityId) opportunityIds.push(opportunityId);
      const submissionId = command.submissionId
        ? requiredText(command.submissionId, 'submissionId', 120) : '';
      const recipientEmail = command.recipientEmail
        ? requiredText(command.recipientEmail, 'recipientEmail', 320).toLowerCase() : '';
      const communicationId = command.communicationId
        ? requiredText(command.communicationId, 'communicationId', 120) : '';
      if (opportunityIds.length > 50 || new Set(opportunityIds).size !== opportunityIds.length
        || [opportunityIds.length > 0, Boolean(submissionId), Boolean(recipientEmail),
          Boolean(communicationId)].filter(Boolean).length !== 1) {
        throw new Error('Terminal convergence requires one bounded authority selector');
      }
      const evidenceType = requiredText(command.evidenceType, 'evidenceType', 120);
      const evidenceId = requiredText(command.evidenceId, 'evidenceId');
      const actor = requiredText(command.actor, 'actor', 200);
      const source = requiredText(command.source, 'source', 120);
      const observedAt = requiredInstant(command.observedAt);
      const now = requiredInstant(command.now);
      const requestedReason = command.evaluateMaterialsState === true
        ? '' : requiredText(command.reasonCode, 'reasonCode', 160);
      return database.transaction(() => {
        let campaigns;
        if (opportunityIds.length > 0) {
          campaigns = database.prepare(`SELECT * FROM deal_hunter_cim_campaigns
            WHERE opportunity_id IN (${opportunityIds.map(() => '?').join(',')})
              AND state IN ('queued','waiting-on-eligibility','initial-pending',
                'active-follow-up','action-required','provider-ambiguous') ORDER BY id`).all(...opportunityIds);
        } else if (submissionId) {
          campaigns = database.prepare(`SELECT * FROM deal_hunter_cim_campaigns
            WHERE crm_submission_id = ? AND state IN ('queued','waiting-on-eligibility',
              'initial-pending','active-follow-up','action-required','provider-ambiguous')
            ORDER BY id`).all(submissionId);
        } else if (recipientEmail) {
          campaigns = database.prepare(`SELECT campaign.* FROM deal_hunter_cim_campaigns campaign
            JOIN deal_hunter_broker_conversations conversation
              ON conversation.id = campaign.conversation_id
            WHERE lower(conversation.recipient_address) = ?
              AND campaign.state IN ('queued','waiting-on-eligibility','initial-pending',
                'active-follow-up','action-required','provider-ambiguous') ORDER BY campaign.id`).all(recipientEmail);
        } else {
          campaigns = database.prepare(`SELECT DISTINCT campaign.*
            FROM deal_hunter_cim_campaigns campaign
            JOIN deal_hunter_cim_transmission_touches member ON member.campaign_id = campaign.id
            JOIN deal_hunter_cim_transmissions transmission
              ON transmission.id = member.transmission_id
            WHERE transmission.communication_id = ?
              AND campaign.state IN ('queued','waiting-on-eligibility','initial-pending',
                'active-follow-up','action-required','provider-ambiguous')
            ORDER BY campaign.id`).all(communicationId);
        }
        const outcomes = [];
        for (const campaign of campaigns) {
          let reasonCode = requestedReason;
          if (command.evaluateMaterialsState === true) {
            const submission = database.prepare('SELECT * FROM contact_submissions WHERE id = ?')
              .get(campaign.crm_submission_id);
            let metadata = {};
            try { metadata = JSON.parse(submission?.metadata || '{}'); } catch { metadata = {}; }
            const secureDocuments = database.prepare(`SELECT * FROM secure_documents
              WHERE submission_id = ? ORDER BY created_at, id`).all(campaign.crm_submission_id);
            const latestUploadRequest = database.prepare(`SELECT * FROM secure_upload_requests
              WHERE submission_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
              .get(campaign.crm_submission_id) ?? null;
            const materials = evaluateAcquisitionMaterialsState({
              submission: submission ? { ...submission, metadata } : {},
              secureDocuments,
              latestUploadRequest: latestUploadRequest ? {
                ...latestUploadRequest,
                requested_documents: (() => {
                  try { return JSON.parse(latestUploadRequest.requested_documents || '[]'); }
                  catch { return []; }
                })(),
              } : null,
            });
            if (!materials.materialsReceived && !materials.advancedBeyondBrokerOutreach) continue;
            reasonCode = materials.advancedBeyondBrokerOutreach
              ? 'advanced_beyond_broker_outreach' : 'materials_received';
          }
          const nextState = reasonCode === 'identity_ambiguous' ? 'action-required'
            : ['materials_received', 'advanced_beyond_broker_outreach'].includes(reasonCode)
              && campaignTransitions[campaign.state]?.includes('materials-received')
              ? 'materials-received' : 'stopped';
          const eventId = digest('terminal-writer-event:v1', evidenceType, evidenceId,
            campaign.id, reasonCode);
          const outcome = transitions.appendCimTerminalEvent({ eventId, scope: 'campaign',
            scopeId: campaign.id, expectedRevision: campaign.terminal_revision,
            expectedRowVersion: campaign.row_version, nextState, reasonCode, evidenceType,
            evidenceId, metadataDigest: digest('terminal-writer-metadata:v1', evidenceType,
              evidenceId, reasonCode, campaign.id), actor, source, observedAt, now });
          if (outcome.conflict) throw new Error('Concurrent Pursue CIM terminal convergence');
          outcomes.push({ campaignId: campaign.id, eventId, reasonCode, ...outcome });
        }
        return { applied: outcomes.some((outcome) => outcome.applied), outcomes };
      }).immediate();
    },
    appendCimTerminalEvent(command) {
      const eventId = requiredText(command.eventId, 'eventId');
      const scope = requiredText(command.scope, 'scope', 20);
      if (!['campaign', 'conversation'].includes(scope)) throw new Error('Invalid terminal scope');
      const scopeId = requiredText(command.scopeId, 'scopeId');
      const expectedRevision = requiredRevision(command.expectedRevision, 'expectedRevision');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const nextState = requiredText(command.nextState, 'nextState', 120);
      const reasonCode = requiredText(command.reasonCode, 'reasonCode', 160);
      const evidenceType = requiredText(command.evidenceType, 'evidenceType', 120);
      const evidenceId = requiredText(command.evidenceId, 'evidenceId');
      const metadataDigest = requiredText(command.metadataDigest, 'metadataDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(metadataDigest)) throw new Error('Invalid terminal metadata digest');
      const actor = requiredText(command.actor, 'actor', 200);
      const source = requiredText(command.source, 'source', 120);
      const observedAt = requiredInstant(command.observedAt);
      const now = requiredInstant(command.now);
      const outcome = (flags, campaignRevision = null, conversationRevision = null,
        cancelledTouchIds = []) => ({ applied: false, replay: false, conflict: false,
        ...flags, campaignRevision, conversationRevision, cancelledTouchIds });
      return database.transaction(() => {
        if (command.qualificationGuard && !qualificationInboundAuthority(database, command.qualificationGuard).allowed) {
          throw new Error('Qualification inbound terminal permission closed');
        }
        const existing = database.prepare('SELECT * FROM deal_hunter_cim_terminal_events WHERE id = ?').get(eventId);
        if (existing) {
          const replay = existing.scope === scope && existing.scope_id === scopeId
            && existing.reason_code === reasonCode && existing.evidence_type === evidenceType
            && existing.evidence_id === evidenceId && existing.metadata_digest === metadataDigest;
          return outcome({ replay, conflict: !replay },
            scope === 'campaign' ? existing.revision : null,
            scope === 'conversation' ? existing.revision : null);
        }
        const table = scope === 'campaign' ? 'deal_hunter_cim_campaigns' : 'deal_hunter_broker_conversations';
        const current = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(scopeId);
        const legal = scope === 'campaign' ? campaignTransitions : conversationTransitions;
        if (!current || current.terminal_revision !== expectedRevision
          || current.row_version !== expectedRowVersion
          || !legal[current.state]?.includes(nextState)
          || (current.state === 'action-required'
            && ['queued', 'waiting-on-eligibility', 'initial-pending'].includes(nextState)
            && !command.preProviderResolution)) {
          return outcome({ conflict: true },
            scope === 'campaign' ? current?.terminal_revision ?? null : null,
            scope === 'conversation' ? current?.terminal_revision ?? null : null);
        }
        const cancelledTouchIds = [];
        const campaignIds = scope === 'campaign' ? [scopeId]
          : database.prepare(`
            SELECT id FROM deal_hunter_cim_campaigns WHERE conversation_id = ?
              AND state IN ('queued', 'waiting-on-eligibility', 'initial-pending',
                'active-follow-up', 'action-required', 'provider-ambiguous')
          `).all(scopeId).map(({ id }) => id);
        const inFlight = campaignIds.flatMap((campaignId) => database.prepare(`
          SELECT transmission.id AS transmission_id, MIN(touch.id) AS touch_id,
            campaign.opportunity_id, campaign.conversation_id
          FROM deal_hunter_cim_campaign_touches touch
          JOIN deal_hunter_cim_campaigns campaign ON campaign.id = touch.campaign_id
          JOIN deal_hunter_cim_transmission_touches member ON member.touch_id = touch.id
            AND member.cancelled_at IS NULL
          JOIN deal_hunter_cim_transmissions transmission
            ON transmission.id = member.transmission_id
          WHERE touch.campaign_id = ? AND touch.state = 'provider-pending'
            AND transmission.state = 'provider-pending'
          GROUP BY transmission.id, campaign.opportunity_id, campaign.conversation_id
          ORDER BY transmission.id
        `).all(campaignId).map((row) => ({ ...row, campaign_id: campaignId })));
        for (const campaignId of campaignIds) {
          const prepared = database.prepare(`
            SELECT DISTINCT tr.* FROM deal_hunter_cim_transmissions tr
            JOIN deal_hunter_cim_transmission_touches m ON m.transmission_id = tr.id
            WHERE m.campaign_id = ? AND m.cancelled_at IS NULL
              AND tr.state IN ('prepared', 'final-gate-blocked')
          `).all(campaignId);
          for (const transmission of prepared) {
            const memberIds = database.prepare(`SELECT touch_id FROM deal_hunter_cim_transmission_touches
              WHERE transmission_id = ? AND cancelled_at IS NULL`).all(transmission.id)
              .map(({ touch_id: id }) => id);
            if (cancelPreparedTransmission(database, transmission, { now, reasonCode, actor })) {
              cancelledTouchIds.push(...memberIds);
            }
          }
          const touches = database.prepare(`
            SELECT * FROM deal_hunter_cim_campaign_touches WHERE campaign_id = ?
              AND state IN ('scheduled', 'claimed') AND transmission_id IS NULL
          `).all(campaignId);
          for (const touch of touches) {
            database.prepare(`
              UPDATE deal_hunter_cim_campaign_touches SET state = 'cancelled-before-provider',
                terminal_reason = ?, updated_at = ?, row_version = row_version + 1
              WHERE id = ? AND row_version = ?
            `).run(reasonCode, now, touch.id, touch.row_version);
            cancelledTouchIds.push(touch.id);
            appendAudit(database, { eventType: 'touch-cancelled', authorityId: `${touch.id}:${touch.row_version + 1}`,
              opportunityId: touch.opportunity_id, campaignId, touchId: touch.id,
              priorState: touch.state, nextState: 'cancelled-before-provider', reasonCode,
              actor, source, occurredAt: now });
          }
          if (scope === 'conversation') {
            const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
              .get(campaignId);
            const desiredState = nextState === 'responded' ? 'responded'
              : nextState === 'reply-review-required' ? 'action-required'
                : nextState === 'provider-ambiguous' ? 'provider-ambiguous' : 'stopped';
            const campaignState = campaignTransitions[campaign.state]?.includes(desiredState)
              ? desiredState : campaignTransitions[campaign.state]?.includes('action-required')
                ? 'action-required' : campaign.state;
            database.prepare(`UPDATE deal_hunter_cim_campaigns SET state = ?, reason_code = ?,
              terminal_revision = terminal_revision + 1, row_version = row_version + 1,
              updated_at = ? WHERE id = ? AND row_version = ? AND terminal_revision = ?`)
              .run(campaignState, reasonCode, now, campaignId,
                campaign.row_version, campaign.terminal_revision);
            const campaignEventId = digest('conversation-campaign-terminal:v1', eventId, campaignId);
            database.prepare(`INSERT INTO deal_hunter_cim_terminal_events (
              id, scope, scope_id, campaign_id, revision, reason_code,
              evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at
            ) VALUES (?, 'campaign', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(campaignEventId, campaignId, campaignId, campaign.terminal_revision + 1,
                reasonCode, evidenceType, evidenceId, observedAt, actor, source, metadataDigest, now);
            appendAudit(database, { eventType: 'terminal-transition', authorityId: campaignEventId,
              opportunityId: campaign.opportunity_id, campaignId, conversationId: scopeId,
              priorState: campaign.state, nextState: campaignState, reasonCode,
              actor, source, occurredAt: now });
          }
        }
        database.prepare(`
          UPDATE ${table} SET state = ?, terminal_revision = terminal_revision + 1,
            row_version = row_version + 1, updated_at = ?
            ${scope === 'campaign' ? ', reason_code = ?' : ''}
          WHERE id = ? AND terminal_revision = ? AND row_version = ?
        `).run(...(scope === 'campaign'
          ? [nextState, now, reasonCode, scopeId, expectedRevision, expectedRowVersion]
          : [nextState, now, scopeId, expectedRevision, expectedRowVersion]));
        database.prepare(`
          INSERT INTO deal_hunter_cim_terminal_events (
            id, scope, scope_id, campaign_id, conversation_id, revision, reason_code,
            evidence_type, evidence_id, observed_at, actor, source, metadata_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(eventId, scope, scopeId, scope === 'campaign' ? scopeId : null,
          scope === 'conversation' ? scopeId : null, expectedRevision + 1, reasonCode,
          evidenceType, evidenceId, observedAt, actor, source, metadataDigest, now);
        appendAudit(database, { eventType: 'terminal-transition', authorityId: eventId,
          campaignId: scope === 'campaign' ? scopeId : null,
          conversationId: scope === 'conversation' ? scopeId : null,
          opportunityId: scope === 'campaign' ? current.opportunity_id : null,
          priorState: current.state, nextState, reasonCode, actor, source, occurredAt: now });
        for (const race of inFlight) {
          appendAudit(database, { eventType: 'terminal-in-flight-race',
            authorityId: `${eventId}:${race.campaign_id}:${race.transmission_id}`,
            opportunityId: race.opportunity_id, campaignId: race.campaign_id,
            conversationId: race.conversation_id, touchId: race.touch_id,
            transmissionId: race.transmission_id, priorState: 'provider-pending',
            nextState, reasonCode, actor, source, occurredAt: now, ignore: true });
        }
        return outcome({ applied: true }, scope === 'campaign' ? expectedRevision + 1 : null,
          scope === 'conversation' ? expectedRevision + 1 : null, cancelledTouchIds.sort());
      }).immediate();
    },
    appendCimAmbiguousReplyReview(commands) {
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > 50) {
        throw new Error('Ambiguous reply containment requires a bounded command array');
      }
      const scopeIds = commands.map((command) => requiredText(command?.scopeId, 'scopeId'));
      if (new Set(scopeIds).size !== scopeIds.length
        || scopeIds.some((scopeId, index) => index > 0 && scopeIds[index - 1] >= scopeId)) {
        throw new Error('Ambiguous reply containment commands must be unique and sorted');
      }
      return database.transaction(() => {
        for (const command of commands) {
          if (command.scope !== 'conversation'
            || command.nextState !== 'reply-review-required'
            || command.reasonCode !== 'ambiguous_reply_evidence') {
            throw new Error('Invalid ambiguous reply containment command');
          }
          const current = database.prepare(`SELECT * FROM deal_hunter_broker_conversations
            WHERE id = ?`).get(command.scopeId);
          const existing = database.prepare(`SELECT id FROM deal_hunter_cim_terminal_events
            WHERE id = ?`).get(requiredText(command.eventId, 'eventId'));
          if (existing || !current || current.state !== 'open'
            || current.terminal_revision !== command.expectedRevision
            || current.row_version !== command.expectedRowVersion) {
            return { applied: false, replay: false, conflict: true,
              conversationIds: scopeIds, cancelledTouchIds: [] };
          }
        }
        const outcomes = commands.map((command) => transitions.appendCimTerminalEvent(command));
        if (outcomes.some((outcome) => outcome.conflict)) {
          throw new Error('Atomic ambiguous reply containment conflicted after validation');
        }
        return {
          applied: outcomes.some((outcome) => outcome.applied),
          replay: outcomes.every((outcome) => outcome.replay),
          conflict: false,
          conversationIds: scopeIds,
          cancelledTouchIds: Array.from(new Set(outcomes.flatMap(
            (outcome) => outcome.cancelledTouchIds || []))).sort(),
        };
      }).immediate();
    },
    async claimDueCimTouch(command) {
      const touchId = requiredText(command.touchId, 'touchId');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const expectedCampaignTerminalRevision = requiredRevision(
        command.expectedCampaignTerminalRevision, 'expectedCampaignTerminalRevision');
      const expectedConversationTerminalRevision = requiredRevision(
        command.expectedConversationTerminalRevision, 'expectedConversationTerminalRevision');
      const claimTokenDigest = requiredText(command.claimTokenDigest, 'claimTokenDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(claimTokenDigest)) throw new Error('Invalid claim token digest');
      const claimOwner = requiredText(command.claimOwner, 'claimOwner', 200);
      const claimExpiresAt = canonicalInstant(command.claimExpiresAt);
      const now = canonicalInstant(command.now);
      const result = (flags, touch) => ({ claimed: false, alreadyOwned: false,
        staleAuthority: false, terminal: false, conflict: false, ...flags, touch });
      return database.transaction(() => {
        const touch = database.prepare('SELECT * FROM deal_hunter_cim_campaign_touches WHERE id = ?').get(touchId);
        if (!touch) return result({ conflict: true }, null);
        const campaign = database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?')
          .get(touch.campaign_id);
        const conversation = database.prepare('SELECT * FROM deal_hunter_broker_conversations WHERE id = ?')
          .get(campaign.conversation_id);
        if (campaign.terminal_revision !== expectedCampaignTerminalRevision
          || conversation.terminal_revision !== expectedConversationTerminalRevision
          || touch.timezone_revision !== campaign.timezone_revision) {
          return result({ staleAuthority: true }, touch);
        }
        if (touch.opportunity_id !== campaign.opportunity_id) {
          return result({ terminal: true }, touch);
        }
        if (!['initial-pending', 'active-follow-up'].includes(campaign.state)
          || (touch.kind === 'initial' && (campaign.state !== 'initial-pending'
            || campaign.generation !== 1
            || campaign.policy_version !== 'deal-hunter-cim-autopilot-v1'
            || touch.logical_slot !== 'initial' || touch.ordinal !== 0))
          || conversation.state !== 'open'
          || (campaign.local_expiry_at && Date.parse(campaign.local_expiry_at) <= Date.parse(now))
          || ['provider-pending', 'accepted', 'definitive-failure', 'ambiguous',
            'cancelled-before-provider'].includes(touch.state)) {
          return result({ terminal: true }, touch);
        }
        const requiredCapability = touch.kind === 'initial' ? 'fl04b-initial' : 'fl04c-followup';
        if (!currentActivationChain(database, requiredCapability, now)) {
          return result({ staleAuthority: true }, touch);
        }
        if (touch.transmission_id) return result({ conflict: true }, touch);
        if (database.prepare(`SELECT 1 FROM deal_hunter_cim_transmission_touches
          WHERE touch_id = ? LIMIT 1`).get(touchId)) {
          return result({ conflict: true }, touch);
        }
        if (touch.state === 'claimed' && touch.claim_token_digest === claimTokenDigest
          && touch.claim_owner === claimOwner) {
          return result(touch.claim_expires_at && Date.parse(touch.claim_expires_at) > Date.parse(now)
            ? { alreadyOwned: true } : { conflict: true }, touch);
        }
        if (touch.state === 'claimed' && (!touch.claim_expires_at
          || Date.parse(touch.claim_expires_at) > Date.parse(now))) {
          return result({ conflict: true }, touch);
        }
        if (touch.row_version !== expectedRowVersion) return result({ staleAuthority: true }, touch);
        if (Date.parse(touch.due_at) > Date.parse(now)
          || Date.parse(claimExpiresAt) <= Date.parse(now)) {
          return result({ conflict: true }, touch);
        }
        database.prepare(`
          UPDATE deal_hunter_cim_campaign_touches SET state = 'claimed',
            claim_token_digest = ?, claim_owner = ?, claimed_at = ?, claim_expires_at = ?,
            updated_at = ?, row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND state IN ('scheduled', 'claimed')
        `).run(claimTokenDigest, claimOwner, now, claimExpiresAt, now, touchId,
          expectedRowVersion);
        appendAudit(database, { eventType: 'touch-claimed',
          authorityId: `${touchId}:${expectedRowVersion + 1}`, opportunityId: touch.opportunity_id,
          campaignId: campaign.id, conversationId: conversation.id, touchId,
          priorState: touch.state, nextState: 'claimed', actor: claimOwner, occurredAt: now });
        return result({ claimed: true }, database.prepare('SELECT * FROM deal_hunter_cim_campaign_touches WHERE id = ?')
          .get(touchId));
      }).immediate();
    },
    async listDueCimInitialTouches({ now, limit = 25 } = {}) {
      const at = canonicalInstant(now);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Invalid due touch limit');
      }
      if (!currentActivationChain(database, 'fl04b-initial', at)) return [];
      return database.prepare(`
        SELECT t.id AS touch_id, t.campaign_id, t.opportunity_id, t.kind,
          t.state, t.due_at, t.row_version, t.claim_expires_at,
          c.conversation_id, c.terminal_revision AS campaign_terminal_revision,
          v.terminal_revision AS conversation_terminal_revision,
          c.crm_submission_id, c.recipient_fingerprint AS campaign_recipient_fingerprint,
          v.recipient_fingerprint AS conversation_recipient_fingerprint,
          v.recipient_address
        FROM deal_hunter_cim_campaign_touches AS t
        JOIN deal_hunter_cim_campaigns AS c ON c.id = t.campaign_id
        JOIN deal_hunter_broker_conversations AS v ON v.id = c.conversation_id
        WHERE t.kind = 'initial' AND t.logical_slot = 'initial' AND t.ordinal = 0
          AND c.generation = 1 AND c.policy_version = 'deal-hunter-cim-autopilot-v1'
          AND c.state = 'initial-pending' AND v.state = 'open'
          AND t.opportunity_id = c.opportunity_id
          AND t.due_at <= ? AND (c.local_expiry_at IS NULL OR c.local_expiry_at > ?)
          AND t.transmission_id IS NULL
          AND (t.state = 'scheduled' OR (t.state = 'claimed'
            AND t.claim_expires_at IS NOT NULL AND t.claim_expires_at <= ?))
          AND t.timezone_revision = c.timezone_revision
        ORDER BY t.due_at, t.id
        LIMIT ?
      `).all(at, at, at, limit);
    },
    async recordCimCapabilityActivation(command) {
      const id = requiredText(command.id, 'id');
      const capability = requiredText(command.capability, 'capability', 40);
      const mode = requiredText(command.mode, 'mode', 20);
      if (!Object.hasOwn(activationPredecessor, capability) ||
        !['off', 'shadow', 'mailbox', 'canary', 'active'].includes(mode)) {
        throw new Error('Invalid capability activation');
      }
      const policyHash = requiredText(command.policyHash, 'policyHash', 64);
      const configHash = requiredText(command.configHash, 'configHash', 64);
      const actor = requiredText(command.actor, 'actor', 200);
      const reason = requiredText(command.reason, 'reason', 1000);
      const confirmation = requiredText(command.confirmation, 'confirmation');
      const providerProfile = requiredText(command.providerProfile, 'providerProfile', 120);
      const now = requiredInstant(command.now);
      const expiresAt = command.expiresAt ?? null;
      if (expiresAt !== null) requiredInstant(expiresAt);
      const prerequisiteActivationId = command.prerequisiteActivationId ?? null;
      const prerequisiteEvidenceId = command.prerequisiteEvidenceId ?? null;
      const prerequisiteEvidenceHash = command.prerequisiteEvidenceHash ?? null;
      if ([policyHash, configHash, prerequisiteEvidenceHash, command.cohortDigest,
        command.permissionBasisDigest].filter((value) => value != null)
        .some((value) => !/^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid activation digest');
      if (activationPredecessor[capability]) {
        requiredText(prerequisiteActivationId, 'prerequisiteActivationId');
        requiredText(prerequisiteEvidenceId, 'prerequisiteEvidenceId');
        requiredText(prerequisiteEvidenceHash, 'prerequisiteEvidenceHash', 64);
      } else if (prerequisiteActivationId || prerequisiteEvidenceId || prerequisiteEvidenceHash) {
        throw new Error('Root activation cannot name a prerequisite');
      }
      const fields = [capability, mode, prerequisiteActivationId, prerequisiteEvidenceId,
        prerequisiteEvidenceHash, policyHash, configHash, command.cohortDigest ?? null,
        command.permissionBasisDigest ?? null, command.permissionRevision ?? null,
        actor, reason, confirmation, expiresAt, command.dailyCap ?? null,
        command.recipientCap ?? null, providerProfile, now];
      return database.transaction(() => {
        const existing = database.prepare('SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?').get(id);
        if (existing) {
          const persisted = [existing.capability, existing.mode, existing.prerequisite_activation_id,
            existing.prerequisite_evidence_id, existing.prerequisite_evidence_hash,
            existing.policy_hash, existing.config_hash, existing.cohort_digest,
            existing.permission_basis_digest, existing.permission_revision, existing.actor,
            existing.reason, existing.confirmation, existing.expires_at, existing.daily_cap,
            existing.recipient_cap, existing.provider_profile, existing.created_at];
          const replay = JSON.stringify(persisted) === JSON.stringify(fields);
          return { applied: false, replay, conflict: !replay, blockedReason: null, activation: existing };
        }
        const prerequisiteCapability = activationPredecessor[capability];
        if (prerequisiteCapability) {
          const prerequisite = database.prepare(`
            SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?
          `).get(prerequisiteActivationId);
          if (!prerequisite || prerequisite.capability !== prerequisiteCapability
            || prerequisite.status !== 'current' || prerequisite.mode === 'off'
            || (prerequisite.expires_at && prerequisite.expires_at <= now)) {
            return { applied: false, replay: false, conflict: false,
              blockedReason: 'prerequisite_missing', activation: null };
          }
        }
        const current = database.prepare(`
          SELECT * FROM deal_hunter_cim_capability_activations
          WHERE capability = ? AND status = 'current'
        `).get(capability);
        if (current) database.prepare(`
          UPDATE deal_hunter_cim_capability_activations
          SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE id = ? AND status = 'current'
        `).run(now, now, current.id);
        database.prepare(`
          INSERT INTO deal_hunter_cim_capability_activations (
            id, capability, mode, status, prerequisite_activation_id,
            prerequisite_evidence_id, prerequisite_evidence_hash, policy_hash,
            config_hash, cohort_digest, permission_basis_digest, permission_revision,
            actor, reason, confirmation, expires_at, daily_cap, recipient_cap,
            provider_profile, created_at, updated_at
          ) VALUES (?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, capability, mode, prerequisiteActivationId, prerequisiteEvidenceId,
          prerequisiteEvidenceHash, policyHash, configHash, command.cohortDigest ?? null,
          command.permissionBasisDigest ?? null, command.permissionRevision ?? null,
          actor, reason, confirmation, expiresAt, command.dailyCap ?? null,
          command.recipientCap ?? null, providerProfile, now, now);
        appendAudit(database, { eventType: 'capability-activation', authorityId: id,
          activationId: id, priorState: current?.status ?? null, nextState: 'current', actor,
          occurredAt: now });
        return { applied: true, replay: false, conflict: false, blockedReason: null,
          activation: database.prepare('SELECT * FROM deal_hunter_cim_capability_activations WHERE id = ?').get(id) };
      }).immediate();
    },
    async materializePursuitCampaign(command) {
      const opportunityId = requiredText(command.opportunityId, 'opportunityId', 200);
      const enrollmentId = requiredText(command.enrollmentId, 'enrollmentId');
      const expectedEnrollmentRowVersion = requiredRevision(command.expectedEnrollmentRowVersion, 'expectedEnrollmentRowVersion');
      const generation = requiredRevision(command.generation, 'generation');
      const policyVersion = requiredText(command.policyVersion, 'policyVersion', 120);
      const templateVersion = requiredText(command.templateVersion, 'templateVersion', 120);
      const permissionVersion = requiredText(command.permissionVersion, 'permissionVersion', 120);
      const permissionScope = requiredText(command.permissionScope, 'permissionScope');
      const recipientAuthorityId = requiredText(command.recipientAuthorityId, 'recipientAuthorityId');
      const recipientAddress = requiredText(command.recipientAddress, 'recipientAddress', 320);
      const senderPolicyVersion = requiredText(command.senderPolicyVersion, 'senderPolicyVersion', 120);
      const replyPolicyVersion = requiredText(command.replyPolicyVersion, 'replyPolicyVersion', 120);
      const rfcThreadKey = requiredText(command.rfcThreadKey, 'rfcThreadKey', 500);
      const batchingPolicyVersion = requiredText(command.batchingPolicyVersion, 'batchingPolicyVersion', 120);
      const cadencePolicyVersion = requiredText(command.cadencePolicyVersion, 'cadencePolicyVersion', 120);
      const dueAt = requiredInstant(command.dueAt);
      const dueLocal = requiredText(command.dueLocal, 'dueLocal', 120);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      for (const name of ['templateDigest', 'permissionDigest', 'recipientFingerprint',
        'replyAliasTokenDigest', 'freshnessAuthorityDigest', 'policyHash']) {
        if (!/^[0-9a-f]{64}$/.test(command[name])) throw new Error(`Invalid ${name}`);
      }
      for (const name of ['permissionRevision', 'canonicalRevision', 'crmOwnershipRevision',
        'campaignAuthorityRevision', 'globalAuthorityRevision',
        'expectedDiscoveryRevision', 'expectedMaterialRevision', 'timezoneRevision']) {
        requiredRevision(command[name], name);
      }
      const campaignId = digest('cim-campaign:v1', opportunityId, generation, policyVersion);
      const conversationId = digest('cim-conversation:v1', command.recipientFingerprint, senderPolicyVersion);
      const touchId = digest('cim-touch:v1', campaignId, 'initial', cadencePolicyVersion);
      return database.transaction(() => {
        const current = database.prepare(`
          SELECT * FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?
          ORDER BY generation DESC LIMIT 1
        `).get(opportunityId);
        if (current) {
          const same = current.id === campaignId && current.enrollment_id === enrollmentId
            && current.template_digest === command.templateDigest
            && current.permission_digest === command.permissionDigest
            && current.recipient_fingerprint === command.recipientFingerprint
            && current.timezone_revision === command.timezoneRevision;
          const owner = database.prepare(`SELECT revision, submission_id
            FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = ?
            ORDER BY revision DESC LIMIT 1`).get(opportunityId);
          const opportunity = database.prepare(`SELECT * FROM deal_hunter_opportunities
            WHERE opportunity_id = ?`).get(opportunityId);
          const crm = command.crmSubmissionId ? database.prepare(`SELECT * FROM contact_submissions
            WHERE id = ?`).get(command.crmSubmissionId) : null;
          const score = database.prepare(`SELECT * FROM deal_hunter_opportunity_scores
            WHERE opportunity_id = ?`).get(opportunityId);
          const activation = currentActivationChain(database, 'fl04b-enrollment', now);
          const global = database.prepare(`SELECT revision FROM deal_hunter_cim_global_authority
            WHERE id = 'global'`).get();
          const timezone = database.prepare(`SELECT * FROM deal_hunter_opportunity_timezone_revisions
            WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1`).get(opportunityId);
          const enrollment = database.prepare(`SELECT * FROM deal_hunter_pursuit_enrollments
            WHERE id = ?`).get(enrollmentId);
          const decision = enrollment && database.prepare(`SELECT * FROM deal_hunter_owner_decision_events
            WHERE id = ?`).get(enrollment.decision_event_id);
          let metadataOwner;
          try { metadataOwner = JSON.parse(crm?.metadata || '{}')?.dealHunter?.opportunityId; }
          catch { metadataOwner = 'invalid'; }
          const authorityStillCurrent = owner?.revision === command.crmOwnershipRevision
            && owner?.submission_id === command.crmSubmissionId
            && opportunity?.primary_submission_id === command.crmSubmissionId
            && opportunity?.status === 'active' && crm?.deal_hunter_opportunity_id === opportunityId
            && !crm?.archived_at && !['archived', 'spam'].includes(crm?.status)
            && (crm?.broker_email ?? null) === command.crmBrokerEmail
            && (!metadataOwner || metadataOwner === opportunityId)
            && !database.prepare(`SELECT 1 FROM crm_submission_supersessions
              WHERE superseded_submission_id = ? AND status = 'active' LIMIT 1`).get(crm?.id)
            && command.crmMatchAuthorityFingerprint === readCrmMatchAuthorityFingerprint?.()
            && opportunity.campaign_authority_revision === command.campaignAuthorityRevision
            && opportunity.discovery_revision === command.expectedDiscoveryRevision
            && opportunity.material_revision === command.expectedMaterialRevision
            && global?.revision === command.globalAuthorityRevision
            && score?.operator_priority === 'high' && Boolean(score.reviewed_at)
            && !score.should_remove && Boolean(score.current_triage_eligible)
            && (score.reviewed_semantic_digest
              ? score.reviewed_semantic_digest === score.semantic_digest
              : !score.reviewed_fingerprint || score.reviewed_fingerprint === score.score_fingerprint)
            && activation?.id === permissionVersion
            && activation.permission_basis_digest === command.permissionDigest
            && activation.permission_revision === command.permissionRevision
            && activation.cohort_digest === permissionScope
            && activation.policy_hash === command.policyHash
            && timezone?.revision === command.timezoneRevision
            && ['verified', 'derived'].includes(timezone?.state)
            && enrollment?.state === 'campaign-created'
            && enrollment.opportunity_id === opportunityId && decision?.action === 'pursue'
            && !database.prepare(`SELECT 1 FROM deal_hunter_source_freshness_state
              WHERE projection_state IN ('pending', 'deferred', 'superseded') LIMIT 1`).get()
            && !database.prepare(`SELECT 1 FROM deal_hunter_identity_exceptions
              WHERE status = 'open' LIMIT 1`).get()
            && !database.prepare(`SELECT 1 FROM deal_hunter_cim_requests
              WHERE opportunity_id = ? OR deal_key IN (SELECT deal_key
                FROM deal_hunter_opportunity_scores WHERE opportunity_id = ?) LIMIT 1`)
              .get(opportunityId, opportunityId)
            && !database.prepare(`SELECT 1 FROM deal_hunter_cim_opportunity_claims
              WHERE opportunity_id = ? LIMIT 1`).get(opportunityId)
            && !database.prepare(`SELECT 1 FROM email_suppressions
              WHERE normalized_email = lower(?) AND lifted_at IS NULL LIMIT 1`).get(recipientAddress)
            && !crm.prospectus_url
            && !database.prepare(`SELECT 1 FROM secure_documents
              WHERE submission_id = ? LIMIT 1`).get(crm.id)
            && !database.prepare(`SELECT 1 FROM secure_upload_requests
              WHERE submission_id = ? AND status IN ('completed', 'documents-received') LIMIT 1`).get(crm.id)
            && !database.prepare(`SELECT 1 FROM crm_communications
              WHERE submission_id = ? AND direction = 'inbound' LIMIT 1`).get(crm.id);
          return { applied: false, existing: same && authorityStillCurrent,
            actionRequired: !same || !authorityStillCurrent,
            campaign: current, initialTouch: database.prepare(`
              SELECT * FROM deal_hunter_cim_campaign_touches
              WHERE campaign_id = ? AND logical_slot = 'initial'
            `).get(current.id) ?? null };
        }
        if (generation !== 1) return { applied: false, existing: false, actionRequired: true,
          campaign: null, initialTouch: null };
        const enrollment = database.prepare('SELECT * FROM deal_hunter_pursuit_enrollments WHERE id = ?')
          .get(enrollmentId);
        const decision = enrollment && database.prepare('SELECT * FROM deal_hunter_owner_decision_events WHERE id = ?')
          .get(enrollment.decision_event_id);
        const opportunity = database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?')
          .get(opportunityId);
        const timezone = database.prepare(`
          SELECT * FROM deal_hunter_opportunity_timezone_revisions
          WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1
        `).get(opportunityId);
        const priorOutreach = database.prepare(`
          SELECT 1 FROM deal_hunter_cim_requests WHERE opportunity_id = ?
            OR deal_key IN (SELECT deal_key FROM deal_hunter_opportunity_scores
              WHERE opportunity_id = ?)
          LIMIT 1
        `).get(opportunityId, opportunityId);
        const priorClaim = database.prepare(`SELECT 1 FROM deal_hunter_cim_opportunity_claims
          WHERE opportunity_id = ? LIMIT 1`).get(opportunityId);
        const suppressed = database.prepare(`SELECT 1 FROM email_suppressions
          WHERE normalized_email = lower(?) AND lifted_at IS NULL LIMIT 1`).get(recipientAddress);
        const crmOwner = command.crmSubmissionId ? database.prepare(`
          SELECT * FROM contact_submissions WHERE id = ?
        `).get(command.crmSubmissionId) : null;
        const currentScore = database.prepare(`SELECT * FROM deal_hunter_opportunity_scores
          WHERE opportunity_id = ?`).get(opportunityId);
        const ownership = database.prepare(`SELECT revision, submission_id
          FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = ?
          ORDER BY revision DESC LIMIT 1`).get(opportunityId);
        const activation = currentActivationChain(database, 'fl04b-enrollment', now);
        const globalAuthority = database.prepare(`SELECT revision FROM deal_hunter_cim_global_authority
          WHERE id = 'global'`).get();
        if (!activation || activation.id !== permissionVersion
          || activation.permission_basis_digest !== command.permissionDigest
          || activation.permission_revision !== command.permissionRevision
          || activation.cohort_digest !== permissionScope
          || activation.policy_hash !== command.policyHash
          || !enrollment || enrollment.opportunity_id !== opportunityId
          || !['queued', 'waiting-on-eligibility'].includes(enrollment.state)
          || enrollment.row_version !== expectedEnrollmentRowVersion
          || !decision || decision.action !== 'pursue'
          || !currentScore || currentScore.operator_priority !== 'high'
          || !currentScore.reviewed_at || currentScore.should_remove
          || !currentScore.current_triage_eligible
          || (currentScore.reviewed_semantic_digest
            ? currentScore.reviewed_semantic_digest !== currentScore.semantic_digest
            : Boolean(currentScore.reviewed_fingerprint)
              && currentScore.reviewed_fingerprint !== currentScore.score_fingerprint)
          || !opportunity || opportunity.status !== 'active'
          || ownership?.revision !== command.crmOwnershipRevision
          || ownership?.submission_id !== command.crmSubmissionId
          || !command.crmMatchAuthorityFingerprint
          || command.crmMatchAuthorityFingerprint !== readCrmMatchAuthorityFingerprint?.()
          || opportunity.campaign_authority_revision !== command.campaignAuthorityRevision
          || globalAuthority?.revision !== command.globalAuthorityRevision
          || database.prepare(`SELECT 1 FROM deal_hunter_source_freshness_state
            WHERE projection_state IN ('pending', 'deferred', 'superseded') LIMIT 1`).get()
          || database.prepare(`SELECT 1 FROM deal_hunter_identity_exceptions
            WHERE status = 'open' LIMIT 1`).get()
          || opportunity.discovery_revision !== command.expectedDiscoveryRevision
          || opportunity.material_revision !== command.expectedMaterialRevision
          || timezone?.revision !== command.timezoneRevision
          || !['verified', 'derived'].includes(timezone.state)
          || !crmOwner || crmOwner.deal_hunter_opportunity_id !== opportunityId
          || crmOwner.archived_at || opportunity.primary_submission_id !== crmOwner.id
          || ['archived', 'spam'].includes(crmOwner.status)
          || (crmOwner.broker_email ?? null) !== command.crmBrokerEmail
          || (database.prepare(`SELECT 1 FROM crm_submission_supersessions
            WHERE superseded_submission_id = ? AND status = 'active' LIMIT 1`)
            .get(crmOwner.id))
          || (() => {
            try {
              const metadataOwner = JSON.parse(crmOwner.metadata || '{}')?.dealHunter?.opportunityId;
              return Boolean(metadataOwner && metadataOwner !== opportunityId);
            } catch { return true; }
          })()
          || priorOutreach || priorClaim || suppressed
          || crmOwner.prospectus_url
          || database.prepare(`SELECT 1 FROM secure_documents WHERE submission_id = ? LIMIT 1`)
            .get(crmOwner.id)
          || database.prepare(`SELECT 1 FROM secure_upload_requests WHERE submission_id = ?
            AND status IN ('completed', 'documents-received') LIMIT 1`).get(crmOwner.id)
          || database.prepare(`SELECT 1 FROM crm_communications WHERE submission_id = ?
            AND direction = 'inbound' LIMIT 1`).get(crmOwner.id)) {
          return { applied: false, existing: false, actionRequired: true,
            campaign: null, initialTouch: null };
        }
        const conversation = database.prepare('SELECT * FROM deal_hunter_broker_conversations WHERE id = ?')
          .get(conversationId);
        if (conversation && (conversation.recipient_authority_id !== recipientAuthorityId
          || conversation.recipient_address !== recipientAddress
          || conversation.recipient_fingerprint !== command.recipientFingerprint
          || conversation.state !== 'open')) {
          return { applied: false, existing: false, actionRequired: true,
            campaign: null, initialTouch: null };
        }
        if (!conversation) database.prepare(`
          INSERT INTO deal_hunter_broker_conversations (
            id, recipient_authority_id, recipient_fingerprint, recipient_address,
            sender_policy_version, reply_policy_version, reply_alias_token_digest,
            rfc_thread_key, state, batching_policy_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
        `).run(conversationId, recipientAuthorityId, command.recipientFingerprint, recipientAddress,
          senderPolicyVersion, replyPolicyVersion, command.replyAliasTokenDigest,
          rfcThreadKey, batchingPolicyVersion, now, now);
        database.prepare(`
          INSERT INTO deal_hunter_cim_campaigns (
            id, opportunity_id, generation, enrollment_id, decision_event_id, policy_version,
            template_version, template_digest, permission_version, permission_digest,
            permission_revision, permission_scope, canonical_revision, crm_submission_id,
            crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
            freshness_authority_digest, discovery_revision, material_revision,
            timezone_revision, conversation_id, state, reason_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'initial-pending', 'awaiting-window', ?, ?)
        `).run(campaignId, opportunityId, generation, enrollmentId, decision.id, policyVersion,
          templateVersion, command.templateDigest, permissionVersion, command.permissionDigest,
          command.permissionRevision, permissionScope, command.canonicalRevision,
          command.crmSubmissionId ?? null, command.crmOwnershipRevision, recipientAuthorityId,
          command.recipientFingerprint, command.freshnessAuthorityDigest,
          command.expectedDiscoveryRevision, command.expectedMaterialRevision,
          command.timezoneRevision, conversationId, now, now);
        database.prepare(`
          INSERT INTO deal_hunter_cim_campaign_touches (
            id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
            due_at, due_local, timezone_revision, state, created_at, updated_at
          ) VALUES (?, ?, ?, 'initial', 'initial', 0, ?, ?, ?, 'scheduled', ?, ?)
        `).run(touchId, campaignId, opportunityId, dueAt, dueLocal, command.timezoneRevision, now, now);
        database.prepare(`
          UPDATE deal_hunter_pursuit_enrollments SET state = 'campaign-created',
            reason_code = NULL, updated_at = ?, row_version = row_version + 1
          WHERE id = ? AND row_version = ?
        `).run(now, enrollmentId, expectedEnrollmentRowVersion);
        appendAudit(database, { eventType: 'campaign-allocated', authorityId: campaignId,
          opportunityId, campaignId, conversationId, nextState: 'initial-pending', actor, occurredAt: now });
        appendAudit(database, { eventType: 'touch-created', authorityId: touchId,
          opportunityId, campaignId, conversationId, touchId, nextState: 'scheduled', actor, occurredAt: now });
        appendAudit(database, { eventType: 'enrollment-transition', authorityId: `${enrollmentId}:${expectedEnrollmentRowVersion + 1}`,
          opportunityId, priorState: enrollment.state, nextState: 'campaign-created', actor, occurredAt: now });
        return { applied: true, existing: false, actionRequired: false,
          campaign: database.prepare('SELECT * FROM deal_hunter_cim_campaigns WHERE id = ?').get(campaignId),
          initialTouch: database.prepare('SELECT * FROM deal_hunter_cim_campaign_touches WHERE id = ?').get(touchId) };
      }).immediate();
    },
    async transitionPursuitEnrollment(command) {
      const enrollmentId = requiredText(command.enrollmentId, 'enrollmentId');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const nextState = requiredText(command.nextState, 'nextState', 40);
      const reasonCode = command.reasonCode === undefined || command.reasonCode === null
        ? null : requiredText(command.reasonCode, 'reasonCode', 160);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      const allowed = {
        queued: ['waiting-on-eligibility', 'campaign-created', 'action-required', 'superseded'],
        'waiting-on-eligibility': ['queued', 'campaign-created', 'action-required', 'superseded'],
        'campaign-created': ['superseded'],
        'action-required': ['superseded'],
        superseded: [],
      };
      return database.transaction(() => {
        const current = database.prepare('SELECT * FROM deal_hunter_pursuit_enrollments WHERE id = ?')
          .get(enrollmentId);
        if (!current) return { applied: false, staleRevision: false, conflict: true, enrollment: null };
        if (current.row_version !== expectedRowVersion) {
          return { applied: false, staleRevision: true, conflict: false, enrollment: current };
        }
        if (!allowed[current.state].includes(nextState)
          || (nextState === 'superseded' && !command.terminalAuthorityId)) {
          return { applied: false, staleRevision: false, conflict: true, enrollment: current };
        }
        database.prepare(`
          UPDATE deal_hunter_pursuit_enrollments
          SET state = ?, reason_code = ?, updated_at = ?, row_version = row_version + 1
          WHERE id = ? AND row_version = ? AND state = ?
        `).run(nextState, reasonCode, now, enrollmentId, expectedRowVersion, current.state);
        appendAudit(database, { eventType: 'enrollment-transition',
          authorityId: `${enrollmentId}:${expectedRowVersion + 1}`,
          opportunityId: current.opportunity_id, priorState: current.state, nextState,
          reasonCode, actor, occurredAt: now });
        return { applied: true, staleRevision: false, conflict: false,
          enrollment: database.prepare('SELECT * FROM deal_hunter_pursuit_enrollments WHERE id = ?')
            .get(enrollmentId) };
      }).immediate();
    },
    async appendOpportunityTimezoneRevision(command) {
      const opportunityId = requiredText(command.opportunityId, 'opportunityId', 200);
      const idempotencyKey = requiredText(command.idempotencyKey, 'idempotencyKey');
      const expectedPriorRevision = requiredRevision(command.expectedPriorRevision, 'expectedPriorRevision');
      const state = requiredText(command.state, 'state', 20);
      if (!['verified', 'derived', 'missing', 'ambiguous'].includes(state)) throw new Error('Invalid timezone state');
      const ianaTimezone = command.ianaTimezone ?? null;
      if (['verified', 'derived'].includes(state)) {
        requiredText(ianaTimezone, 'ianaTimezone', 120);
        try { new Intl.DateTimeFormat('en-US', { timeZone: ianaTimezone }); } catch {
          throw new Error('Invalid IANA timezone');
        }
      } else if (ianaTimezone !== null) {
        throw new Error('Missing or ambiguous timezone cannot have an IANA timezone');
      }
      const evidenceType = requiredText(command.evidenceType, 'evidenceType', 120);
      const evidenceId = requiredText(command.evidenceId, 'evidenceId');
      const evidenceDigest = requiredText(command.evidenceDigest, 'evidenceDigest', 64);
      const resolverVersion = requiredText(command.resolverVersion, 'resolverVersion', 120);
      const datasetDigest = requiredText(command.datasetDigest, 'datasetDigest', 64);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      if (![evidenceDigest, datasetDigest].every((value) => /^[0-9a-f]{64}$/.test(value))) {
        throw new Error('Invalid timezone evidence digest');
      }
      const requestDigest = digest('timezone-request:v1', opportunityId, expectedPriorRevision,
        state, ianaTimezone, evidenceType, evidenceId, evidenceDigest, resolverVersion, datasetDigest,
        idempotencyKey);
      const auditId = digest('cim-audit:v1', 'timezone-revision', idempotencyKey);
      return database.transaction(() => {
        const priorAudit = database.prepare('SELECT * FROM deal_hunter_cim_audit_events WHERE id = ?').get(auditId);
        if (priorAudit) {
          const timezoneRevision = database.prepare(`
            SELECT * FROM deal_hunter_opportunity_timezone_revisions
            WHERE opportunity_id = ? AND revision = ?
          `).get(opportunityId, expectedPriorRevision + 1) ?? null;
          return { applied: false, replay: priorAudit.authority_digest === requestDigest,
            staleRevision: priorAudit.authority_digest !== requestDigest, timezoneRevision };
        }
        const currentOpportunity = database.prepare(`
          SELECT status FROM deal_hunter_opportunities WHERE opportunity_id = ?
        `).get(opportunityId);
        if (!currentOpportunity || currentOpportunity.status !== 'active') {
          const latest = database.prepare(`
            SELECT * FROM deal_hunter_opportunity_timezone_revisions
            WHERE opportunity_id = ? ORDER BY revision DESC LIMIT 1
          `).get(opportunityId) ?? null;
          return { applied: false, replay: false, staleRevision: true, timezoneRevision: latest };
        }
        const current = database.prepare(`
          SELECT COALESCE(MAX(revision), 0) AS revision FROM deal_hunter_opportunity_timezone_revisions
          WHERE opportunity_id = ?
        `).get(opportunityId).revision;
        if (current !== expectedPriorRevision) {
          return { applied: false, replay: false, staleRevision: true,
            timezoneRevision: database.prepare(`
              SELECT * FROM deal_hunter_opportunity_timezone_revisions
              WHERE opportunity_id = ? AND revision = ?
            `).get(opportunityId, current) ?? null };
        }
        database.prepare(`
          INSERT INTO deal_hunter_opportunity_timezone_revisions (
            opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
            evidence_digest, resolver_version, dataset_digest, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(opportunityId, current + 1, state, ianaTimezone, evidenceType, evidenceId,
          evidenceDigest, resolverVersion, datasetDigest, actor, now);
        appendAudit(database, { id: auditId, eventType: 'timezone-revision',
          opportunityId, nextState: state, authorityDigest: requestDigest, actor, occurredAt: now });
        return { applied: true, replay: false, staleRevision: false,
          timezoneRevision: database.prepare(`
            SELECT * FROM deal_hunter_opportunity_timezone_revisions
            WHERE opportunity_id = ? AND revision = ?
          `).get(opportunityId, current + 1) };
      }).immediate();
    },
    async recordOwnerDecision(command) {
      const opportunityId = requiredText(command.opportunityId, 'opportunityId', 200);
      const action = requiredText(command.action, 'action', 20);
      if (!['pursue', 'watch', 'pass'].includes(action)) throw new Error('Invalid owner action');
      const idempotencyKey = requiredText(command.idempotencyKey, 'idempotencyKey');
      const actor = requiredText(command.actor, 'actor', 200);
      const policyVersion = requiredText(command.policyVersion, 'policyVersion', 120);
      const now = requiredInstant(command.now);
      const expectedDiscoveryRevision = requiredRevision(command.expectedDiscoveryRevision, 'expectedDiscoveryRevision');
      const expectedMaterialRevision = requiredRevision(command.expectedMaterialRevision, 'expectedMaterialRevision');
      const selectedContactReferenceDigest = command.selectedContactReferenceDigest ?? null;
      const reason = action === 'pass' ? requiredText(command.reason, 'reason', 160) : null;
      const note = action === 'pass' ? (command.note ?? '') : '';
      const submissionId = action === 'pass' ? (command.submissionId ?? '') : '';
      if (typeof note !== 'string' || note.length > 2000 || typeof submissionId !== 'string'
        || submissionId.length > 120 || submissionId.trim() !== submissionId) {
        throw new Error('Invalid Pass note or submission context');
      }
      if (selectedContactReferenceDigest !== null && !/^[0-9a-f]{64}$/.test(selectedContactReferenceDigest)) {
        throw new Error('Invalid selected contact reference digest');
      }
      const requestDigest = digest('owner-decision-request:v1', action, opportunityId,
        expectedDiscoveryRevision, expectedMaterialRevision, selectedContactReferenceDigest,
        actor, policyVersion, reason, note, submissionId, idempotencyKey);
      return database.transaction(() => {
        const existing = database.prepare('SELECT * FROM deal_hunter_owner_decision_events WHERE idempotency_key = ?')
          .get(idempotencyKey);
        if (existing) {
          const enrollment = database.prepare('SELECT * FROM deal_hunter_pursuit_enrollments WHERE decision_event_id = ?')
            .get(existing.id) ?? null;
          return { applied: false, replay: existing.request_digest === requestDigest,
            conflict: existing.request_digest !== requestDigest, decision: existing, enrollment };
        }
        const opportunity = database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?')
          .get(opportunityId);
        if (!opportunity || opportunity.status !== 'active'
          || opportunity.discovery_revision !== expectedDiscoveryRevision
          || opportunity.material_revision !== expectedMaterialRevision) {
          return { applied: false, replay: false, conflict: true, reason: 'stale_revision',
            decision: null, enrollment: null };
        }
        const score = database.prepare(`
          SELECT * FROM deal_hunter_opportunity_scores
          WHERE opportunity_id = ? AND current_triage_eligible = 1 AND should_remove = 0
        `).get(opportunityId);
        if (action !== 'pursue' && (!score || (action === 'pass' && !score.deal_key))) {
          return { applied: false, replay: false, conflict: true, reason: 'not-actionable',
            decision: null, enrollment: null };
        }
        const disposition = score?.deal_key ? database.prepare(`SELECT disposition FROM deal_hunter_dispositions
          WHERE deal_key = ?`).get(score.deal_key) : null;
        if (disposition?.disposition === 'dismissed') {
          return { applied: false, replay: false, conflict: true, reason: 'already-passed',
            decision: null, enrollment: null };
        }
        const current = database.prepare(`
          SELECT e.*, d.id AS current_decision_id FROM deal_hunter_pursuit_enrollments e
          JOIN deal_hunter_owner_decision_events d ON d.id = e.decision_event_id
          WHERE e.opportunity_id = ? AND e.state <> 'superseded'
        `).get(opportunityId);
        const priorDecision = current && database.prepare(`SELECT * FROM deal_hunter_owner_decision_events
          WHERE id = ?`).get(current.current_decision_id);
        const retryChoice = action === 'pursue' && current
          && (current.state === 'action-required'
            || (['queued', 'waiting-on-eligibility'].includes(current.state)
              && selectedContactReferenceDigest
              && selectedContactReferenceDigest !== priorDecision?.selected_contact_reference_digest));
        if (current && action === 'pursue' && !retryChoice) {
          return { applied: false, replay: false, conflict: false,
            decision: priorDecision, enrollment: current };
        }
        const decisionId = digest('owner-decision:v1', idempotencyKey);
        const enrollmentId = digest('pursuit-enrollment:v1', decisionId);
        if (retryChoice) {
          database.prepare(`UPDATE deal_hunter_pursuit_enrollments
            SET state = 'superseded', reason_code = 'pursue-retried',
              row_version = row_version + 1, updated_at = ?
            WHERE id = ? AND state = ?`).run(now, current.id, current.state);
          appendAudit(database, { eventType: 'enrollment-transition',
            authorityId: `${current.id}:${current.row_version + 1}`,
            opportunityId, priorState: current.state, nextState: 'superseded',
            reasonCode: 'pursue-retried', actor, occurredAt: now });
        }
        let passResult = null;
        if (action === 'pass') {
          if (typeof applyPass !== 'function') throw new Error('Atomic Pass authority is unavailable');
          passResult = applyPass({ opportunityId, submissionId, reason, note, actor,
            expectedDiscoveryRevision, expectedMaterialRevision, occurredAt: now,
            dispositionId: deterministicUuid('owner-pass-disposition:v1', decisionId),
            archiveActivityId: deterministicUuid('owner-pass-archive:v1', decisionId),
            triageActivityId: deterministicUuid('owner-pass-triage:v1', decisionId) });
          if (!passResult.applied) {
            return { applied: false, replay: false, conflict: true,
              reason: passResult.reason, decision: null, enrollment: null };
          }
        }
        database.prepare(`
          INSERT INTO deal_hunter_owner_decision_events (
            id, idempotency_key, request_digest, opportunity_id, action, actor,
            expected_discovery_revision, expected_material_revision,
            observed_discovery_revision, observed_material_revision,
            selected_contact_reference_digest, policy_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(decisionId, idempotencyKey, requestDigest, opportunityId, action, actor,
          expectedDiscoveryRevision, expectedMaterialRevision,
          opportunity.discovery_revision, opportunity.material_revision,
          selectedContactReferenceDigest, policyVersion, now);
        if (action !== 'pursue') {
          transitions.convergeCimTerminalAuthority({ opportunityId,
            reasonCode: `${action}-selected`, evidenceType: 'owner-decision',
            evidenceId: decisionId, actor, source: 'owner-decision-transaction',
            observedAt: now, now });
          if (current) database.prepare(`
            UPDATE deal_hunter_pursuit_enrollments SET state = 'superseded',
              reason_code = ?, row_version = row_version + 1, updated_at = ?
            WHERE id = ? AND state <> 'superseded'
          `).run(`${action}-selected`, now, current.id);
          const campaigns = database.prepare(`
            SELECT * FROM deal_hunter_cim_campaigns WHERE opportunity_id = ?
              AND state IN ('queued', 'waiting-on-eligibility', 'initial-pending',
                'active-follow-up', 'action-required', 'provider-ambiguous')
          `).all(opportunityId);
          for (const campaign of campaigns) {
            const transmissions = database.prepare(`
              SELECT DISTINCT tr.* FROM deal_hunter_cim_transmissions tr
              JOIN deal_hunter_cim_transmission_touches m ON m.transmission_id = tr.id
              WHERE m.campaign_id = ? AND m.cancelled_at IS NULL
                AND tr.state IN ('prepared', 'final-gate-blocked')
            `).all(campaign.id);
            for (const transmission of transmissions) {
              cancelPreparedTransmission(database, transmission,
                { now, reasonCode: `${action}-selected`, actor });
            }
            const cancellable = database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
              WHERE campaign_id = ? AND state IN ('scheduled', 'claimed') AND transmission_id IS NULL`)
              .all(campaign.id);
            for (const touch of cancellable) {
              database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET state = 'cancelled-before-provider',
                terminal_reason = ?, row_version = row_version + 1, updated_at = ?
                WHERE id = ? AND row_version = ?`)
                .run(`${action}-selected`, now, touch.id, touch.row_version);
              appendAudit(database, { eventType: 'touch-cancelled',
                authorityId: `${touch.id}:${touch.row_version + 1}`,
                opportunityId, campaignId: campaign.id, touchId: touch.id,
                priorState: touch.state, nextState: 'cancelled-before-provider',
                reasonCode: `${action}-selected`, actor, occurredAt: now });
            }
            database.prepare(`UPDATE deal_hunter_cim_campaigns SET state = 'stopped',
              reason_code = ?, terminal_revision = terminal_revision + 1,
              row_version = row_version + 1, updated_at = ? WHERE id = ?`)
              .run(`${action}-selected`, now, campaign.id);
            const terminalId = digest('owner-terminal:v1', decisionId, campaign.id);
            database.prepare(`INSERT INTO deal_hunter_cim_terminal_events (
              id, scope, scope_id, campaign_id, revision, reason_code, evidence_type,
              evidence_id, observed_at, actor, source, metadata_digest, created_at
            ) VALUES (?, 'campaign', ?, ?, ?, ?, 'owner-decision', ?, ?, ?, 'sqlite-transition', ?, ?)`)
              .run(terminalId, campaign.id, campaign.id, campaign.terminal_revision + 1,
                `${action}-selected`, decisionId, now, actor, requestDigest, now);
            appendAudit(database, { eventType: 'terminal-transition', authorityId: terminalId,
              opportunityId, campaignId: campaign.id, priorState: campaign.state,
              nextState: 'stopped', reasonCode: `${action}-selected`, actor, occurredAt: now });
          }
          if (action === 'watch') database.prepare(`UPDATE deal_hunter_opportunity_scores SET operator_priority = ?,
            reviewed_at = ?, reviewed_by = ?, reviewed_fingerprint = score_fingerprint,
            reviewed_semantic_digest = semantic_digest, reviewed_discovery_revision = ?,
            reviewed_material_revision = ?, operator_updated_at = ? WHERE opportunity_id = ?`)
            .run('watch', now, actor,
              expectedDiscoveryRevision, expectedMaterialRevision, now, opportunityId);
          appendAudit(database, { eventType: 'owner-decision', authorityId: decisionId,
            opportunityId, nextState: action, authorityDigest: requestDigest, actor, occurredAt: now });
          return { applied: true, replay: false, conflict: false,
            decision: database.prepare('SELECT * FROM deal_hunter_owner_decision_events WHERE id = ?').get(decisionId),
            enrollment: null, ...(passResult ? { passResult } : {}) };
        }
        database.prepare(`
          INSERT INTO deal_hunter_pursuit_enrollments (
            id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', 'awaiting-orchestration', ?, ?, ?)
        `).run(enrollmentId, decisionId, opportunityId,
          digest('enrollment-authority:v1', decisionId, opportunity.discovery_revision,
            opportunity.material_revision), now, now);
        appendAudit(database, { eventType: 'owner-decision', authorityId: decisionId,
          opportunityId, nextState: action, authorityDigest: requestDigest, actor, occurredAt: now });
        if (score) database.prepare(`UPDATE deal_hunter_opportunity_scores SET operator_priority = 'high',
          reviewed_at = ?, reviewed_by = ?, reviewed_fingerprint = score_fingerprint,
          reviewed_semantic_digest = semantic_digest, reviewed_discovery_revision = ?,
          reviewed_material_revision = ?, operator_updated_at = ? WHERE opportunity_id = ?`)
          .run(now, actor, expectedDiscoveryRevision, expectedMaterialRevision, now, opportunityId);
        return {
          applied: true, replay: false, conflict: false,
          decision: database.prepare('SELECT * FROM deal_hunter_owner_decision_events WHERE id = ?').get(decisionId),
          enrollment: database.prepare('SELECT * FROM deal_hunter_pursuit_enrollments WHERE id = ?').get(enrollmentId),
        };
      }).immediate();
    },
  };
  Object.defineProperty(transitions, 'prepareCimTransmissionSync', { enumerable: false });
  return transitions;
}
