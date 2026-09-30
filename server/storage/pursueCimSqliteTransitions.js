import { createHash } from 'node:crypto';

function digest(...parts) {
  const framed = parts.map((part) => {
    const value = JSON.stringify(part);
    return [Buffer.byteLength(value), value];
  });
  return createHash('sha256').update(JSON.stringify(framed)).digest('hex');
}

function requiredText(value, name, maximum = 240) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new Error(`${name} must be bounded, non-empty, and unpadded`);
  }
  return value;
}

function requiredRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function requiredInstant(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('now must be an ISO instant');
  return value;
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
  database.prepare(`
    INSERT INTO deal_hunter_cim_audit_events (
      id, event_type, opportunity_id, campaign_id, conversation_id, touch_id,
      transmission_id, activation_id, authorization_id, prior_state, next_state,
      reason_code, authority_digest, payload_digest, actor, source, occurred_at, metadata
    ) VALUES (
      @id, @eventType, @opportunityId, @campaignId, @conversationId, @touchId,
      @transmissionId, @activationId, @authorizationId, @priorState, @nextState,
      @reasonCode, @authorityDigest, @payloadDigest, @actor, @source, @occurredAt, '{}'
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
    'responded', 'materials-received', 'stopped'],
  'provider-ambiguous': [],
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

export function createPursueCimSqliteTransitions(database, { applyPass, readCrmMatchAuthorityFingerprint } = {}) {
  return {
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
    async reconcileCimTransmission(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const outcomeState = requiredText(command.outcome, 'outcome', 40);
      if (!['accepted', 'definitive-failure'].includes(outcomeState)) {
        throw new Error('Reconciliation requires an exact terminal provider outcome');
      }
      const provider = requiredText(command.provider, 'provider', 80);
      const providerMessageId = command.providerMessageId ?? null;
      if (outcomeState === 'accepted') requiredText(providerMessageId, 'providerMessageId');
      const providerResultCode = requiredText(command.providerResultCode, 'providerResultCode', 160);
      const evidenceType = requiredText(command.evidenceType, 'evidenceType', 120);
      const evidenceId = requiredText(command.evidenceId, 'evidenceId');
      const evidenceDigest = requiredText(command.evidenceDigest, 'evidenceDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) throw new Error('Invalid reconciliation evidence digest');
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      const result = (flags, transmission = null) => ({ applied: false, unchanged: false,
        conflict: false, ...flags, transmission });
      return database.transaction(() => {
        const transmission = database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId);
        if (!transmission) return result({ conflict: true });
        if (['accepted', 'definitive-failure'].includes(transmission.state)) {
          const unchanged = transmission.state === outcomeState && transmission.provider === provider
            && transmission.provider_message_id === providerMessageId
            && transmission.provider_result_code === providerResultCode;
          return result({ unchanged, conflict: !unchanged }, transmission);
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
        if (shouldAdvance && outcomeState === 'accepted' && members[0].kind === 'initial') {
          const next = command.nextTouch;
          if (!next || next.logicalSlot !== 'follow-up-1' || next.kind !== 'follow-up-1'
            || next.ordinal !== 1) throw new Error('Accepted initial reconciliation requires next slot');
          requiredInstant(next.dueAt);
          requiredText(next.dueLocal, 'dueLocal', 120);
          requiredText(next.cadencePolicyVersion, 'cadencePolicyVersion', 120);
          requiredInstant(command.localExpiryAt);
          if (!command.expiryDerivation || JSON.stringify(command.expiryDerivation).length > 1000) {
            throw new Error('Invalid expiry derivation');
          }
        }
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
            const campaignNextState = outcomeState === 'accepted' ? 'active-follow-up' : 'action-required';
            database.prepare(`
              UPDATE deal_hunter_cim_campaigns SET state = ?, reason_code = ?,
                initial_accepted_at = COALESCE(initial_accepted_at, ?),
                local_expiry_at = COALESCE(local_expiry_at, ?),
                expiry_derivation = CASE WHEN initial_accepted_at IS NULL THEN ? ELSE expiry_derivation END,
                updated_at = ?, row_version = row_version + 1
              WHERE id = ? AND row_version = ? AND terminal_revision = ?
            `).run(campaignNextState,
              outcomeState === 'definitive-failure' ? 'provider_definitive_failure' : null,
              outcomeState === 'accepted' ? now : null,
              outcomeState === 'accepted' ? command.localExpiryAt ?? null : null,
              outcomeState === 'accepted' ? JSON.stringify(command.expiryDerivation ?? {}) : '{}',
              now, member.campaign_id, member.campaign_row_version,
              member.campaign_terminal_revision);
            appendAudit(database, { eventType: 'campaign-transition',
              authorityId: `${member.campaign_id}:${member.campaign_row_version + 1}`,
              opportunityId: member.opportunity_id, campaignId: member.campaign_id,
              priorState: member.campaign_state, nextState: campaignNextState,
              authorityDigest: evidenceDigest, actor, occurredAt: now });
            if (outcomeState === 'accepted' && member.kind === 'initial') {
              const next = command.nextTouch;
              const nextTouchId = digest('cim-touch:v1', member.campaign_id,
                next.logicalSlot, next.cadencePolicyVersion);
              database.prepare(`
                INSERT INTO deal_hunter_cim_campaign_touches (
                  id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
                  due_at, due_local, timezone_revision, state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
              `).run(nextTouchId, member.campaign_id, member.opportunity_id,
                next.logicalSlot, next.kind, next.ordinal, next.dueAt, next.dueLocal,
                member.campaign_timezone_revision, now, now);
              appendAudit(database, { eventType: 'touch-created', authorityId: nextTouchId,
                opportunityId: member.opportunity_id, campaignId: member.campaign_id,
                touchId: nextTouchId, nextState: 'scheduled', actor, occurredAt: now });
            }
          }
        }
        const deliveryState = outcomeState === 'definitive-failure' ? 'failed' : 'accepted';
        database.prepare(`
          UPDATE crm_communications SET provider = ?, provider_message_id = ?,
            delivery_state = ?, delivery_state_at = ?, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, now, now, transmission.communication_id);
        database.prepare(`
          UPDATE crm_email_outbox SET provider = ?, provider_message_id = ?,
            state = ?, attempt_count = 1, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, now, transmission.outbox_id);
        appendAudit(database, { eventType: 'transmission-reconciled',
          authorityId: `${transmissionId}:${evidenceType}:${evidenceId}`,
          conversationId: transmission.conversation_id, transmissionId,
          priorState: transmission.state, nextState: outcomeState,
          authorityDigest: evidenceDigest, actor, source: evidenceType, occurredAt: now });
        return result({ applied: true }, database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId));
      }).immediate();
    },
    async finalizeCimTransmission(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const expectedRowVersion = requiredRevision(command.expectedRowVersion, 'expectedRowVersion');
      const outcomeState = requiredText(command.outcome, 'outcome', 40);
      if (!['accepted', 'definitive-failure', 'ambiguous'].includes(outcomeState)) {
        throw new Error('Invalid provider finalization outcome');
      }
      const provider = requiredText(command.provider, 'provider', 80);
      const providerMessageId = command.providerMessageId ?? null;
      if (outcomeState === 'accepted') requiredText(providerMessageId, 'providerMessageId');
      else if (providerMessageId !== null) requiredText(providerMessageId, 'providerMessageId');
      const providerResultCode = requiredText(command.providerResultCode, 'providerResultCode', 160);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      const outcome = (flags, transmission = null, nextTouch = null) => ({ applied: false,
        existing: false, conflict: false, ...flags, transmission, nextTouch });
      return database.transaction(() => {
        const transmission = database.prepare('SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?')
          .get(transmissionId);
        if (!transmission) return outcome({ conflict: true });
        if (['accepted', 'definitive-failure', 'ambiguous'].includes(transmission.state)) {
          const existing = transmission.state === outcomeState && transmission.provider === provider
            && transmission.provider_message_id === providerMessageId
            && transmission.provider_result_code === providerResultCode;
          const nextTouch = existing ? database.prepare(`
            SELECT * FROM deal_hunter_cim_campaign_touches
            WHERE campaign_id IN (
              SELECT campaign_id FROM deal_hunter_cim_transmission_touches WHERE transmission_id = ?
            ) AND ordinal = 1 ORDER BY id LIMIT 1
          `).get(transmissionId) ?? null : null;
          return outcome({ existing, conflict: !existing }, transmission, nextTouch);
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
        const nextState = outcomeState === 'accepted' ? 'active-follow-up'
          : outcomeState === 'definitive-failure' ? 'action-required' : 'provider-ambiguous';
        let nextTouch = null;
        if (outcomeState === 'accepted' && members.length === 1
          && members[0].campaign_state === 'initial-pending'
          && members[0].campaign_terminal_revision === transmission.campaign_terminal_revision) {
          if (!command.nextTouch) throw new Error('Accepted initial finalization requires next slot');
          const next = command.nextTouch;
          const logicalSlot = requiredText(next.logicalSlot, 'logicalSlot', 160);
          const kind = requiredText(next.kind, 'kind', 40);
          if (logicalSlot !== 'follow-up-1' || kind !== 'follow-up-1' || next.ordinal !== 1) {
            throw new Error('Invalid first follow-up slot');
          }
          requiredInstant(next.dueAt);
          requiredText(next.dueLocal, 'dueLocal', 120);
          requiredText(next.cadencePolicyVersion, 'cadencePolicyVersion', 120);
          requiredInstant(command.localExpiryAt);
          if (!command.expiryDerivation || JSON.stringify(command.expiryDerivation).length > 1000) {
            throw new Error('Invalid expiry derivation');
          }
        }
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
              expiry_derivation = CASE WHEN initial_accepted_at IS NULL THEN ? ELSE expiry_derivation END,
              row_version = row_version + 1, updated_at = ?
            WHERE id = ? AND row_version = ? AND terminal_revision = ?
          `).run(nextState,
            outcomeState === 'definitive-failure' ? 'provider_definitive_failure'
              : outcomeState === 'ambiguous' ? 'provider_ambiguous' : null,
            outcomeState === 'accepted' ? now : null,
            outcomeState === 'accepted' ? command.localExpiryAt ?? null : null,
            outcomeState === 'accepted' ? JSON.stringify(command.expiryDerivation ?? {}) : '{}',
            now, member.campaign_id, member.campaign_row_version,
            member.campaign_terminal_revision);
          appendAudit(database, { eventType: 'campaign-transition',
            authorityId: `${member.campaign_id}:${member.campaign_row_version + 1}`,
            opportunityId: member.opportunity_id, campaignId: member.campaign_id,
            priorState: member.campaign_state, nextState, actor, occurredAt: now });
          if (outcomeState === 'accepted' && member.kind === 'initial') {
            const next = command.nextTouch;
            const nextTouchId = digest('cim-touch:v1', member.campaign_id,
              next.logicalSlot, next.cadencePolicyVersion);
            database.prepare(`
              INSERT INTO deal_hunter_cim_campaign_touches (
                id, campaign_id, opportunity_id, logical_slot, kind, ordinal,
                due_at, due_local, timezone_revision, state, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
            `).run(nextTouchId, member.campaign_id, member.opportunity_id,
              next.logicalSlot, next.kind, next.ordinal, next.dueAt, next.dueLocal,
              member.campaign_timezone_revision, now, now);
            appendAudit(database, { eventType: 'touch-created', authorityId: nextTouchId,
              opportunityId: member.opportunity_id, campaignId: member.campaign_id,
              touchId: nextTouchId, nextState: 'scheduled', actor, occurredAt: now });
            nextTouch = database.prepare('SELECT * FROM deal_hunter_cim_campaign_touches WHERE id = ?')
              .get(nextTouchId);
          }
        }
        const deliveryState = outcomeState === 'definitive-failure' ? 'failed' : outcomeState;
        database.prepare(`
          UPDATE crm_communications SET provider = ?, provider_message_id = ?,
            delivery_state = ?, delivery_state_at = ?, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, now, now, transmission.communication_id);
        database.prepare(`
          UPDATE crm_email_outbox SET provider = ?, provider_message_id = ?,
            state = ?, attempt_count = 1, updated_at = ? WHERE id = ?
        `).run(provider, providerMessageId, deliveryState, now, transmission.outbox_id);
        appendAudit(database, { eventType: 'transmission-finalized', authorityId: transmissionId,
          conversationId: transmission.conversation_id, transmissionId,
          priorState: 'provider-pending', nextState: outcomeState,
          payloadDigest: transmission.payload_digest, actor, occurredAt: now });
        return outcome({ applied: true }, database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId), nextTouch);
      }).immediate();
    },
    async enterCimProviderSeam(command) {
      const transmissionId = requiredText(command.transmissionId, 'transmissionId');
      const authorizationId = requiredText(command.authorizationId, 'authorizationId');
      const writerPath = requiredText(command.writerPath, 'writerPath');
      const providerProfile = requiredText(command.providerProfile, 'providerProfile', 120);
      const boundaryNonceDigest = requiredText(command.boundaryNonceDigest, 'boundaryNonceDigest', 64);
      if (!/^[0-9a-f]{64}$/.test(boundaryNonceDigest)) throw new Error('Invalid boundary nonce digest');
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
        const valid = transmission?.state === 'provider-pending'
          && transmission.invocation_authority_count === 1
          && transmission.boundary_nonce_digest === boundaryNonceDigest
          && authorization?.transmission_id === transmissionId
          && authorization.writer_path === writerPath
          && authorization.provider_profile === providerProfile
          && authorization.consumed_at && !authorization.withdrawn_at
          && currentActivationChain(database, authorization.capability, now)?.id === authorization.activation_id;
        if (!valid) return { entered: false, alreadyEntered: false, unauthorized: true };
        if (transmission.provider_seam_entered_at) {
          return { entered: false, alreadyEntered: true, unauthorized: false };
        }
        if (!pause || pause.outreach_paused !== 0 || transmission.row_version !== expectedRowVersion) {
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
      const claimTokenDigest = requiredText(command.claimTokenDigest, 'claimTokenDigest', 64);
      const finalGateAuthorityDigest = requiredText(command.finalGateAuthorityDigest,
        'finalGateAuthorityDigest', 64);
      const boundaryNonceDigest = requiredText(command.boundaryNonceDigest, 'boundaryNonceDigest', 64);
      if (![claimTokenDigest, finalGateAuthorityDigest, boundaryNonceDigest]
        .every((value) => /^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid provider-pending digest');
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
      return database.transaction(() => {
        const transmission = database.prepare(`
          SELECT * FROM deal_hunter_cim_transmissions WHERE id = ?
        `).get(transmissionId);
        const blocked = (blockedReason) => ({ authorized: false, blockedReason,
          transmission: transmission ?? null, boundaryNonceDigest: null });
        if (!transmission) return blocked('lifecycle_conflict');
        if (transmission.state !== 'prepared' || transmission.invocation_authority_count !== 0) {
          return blocked('already_provider_pending');
        }
        if (transmission.row_version !== expectedRowVersion) return blocked('stale_authority');
        const pause = database.prepare(`
          SELECT outreach_paused FROM deal_hunter_cim_safety_settings WHERE id = 'global'
        `).get();
        if (!pause || pause.outreach_paused !== 0) return blocked('central_pause');
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
        const activation = currentActivationChain(database, authorization.capability, now);
        if (!activation || activation.id !== authorization.activation_id
          || activation.provider_profile !== providerProfile) return blocked('capability_inactive');
        const conversation = database.prepare(`
          SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
        `).get(transmission.conversation_id);
        if (!conversation || conversation.state !== 'open'
          || conversation.terminal_revision !== expectedConversationTerminalRevision) {
          return blocked('terminal_authority_changed');
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
        if (!members.length || members.some((member) =>
          !['initial-pending', 'active-follow-up'].includes(member.campaign_state)
          || member.campaign_terminal_revision !== expectedCampaignTerminalRevision)) {
          return blocked('terminal_authority_changed');
        }
        if (members.some((member) => member.state !== 'claimed'
          || member.claim_token_digest !== claimTokenDigest
          || member.transmission_id !== transmissionId
          || !member.claim_expires_at
          || Date.parse(member.claim_expires_at) <= Date.parse(now)
          || Date.parse(member.due_at) > Date.parse(now))) return blocked('lifecycle_conflict');
        if (members.some((member) => member.recipient_fingerprint !== authorization.recipient_authority_digest)
          || conversation.recipient_fingerprint !== authorization.recipient_authority_digest) {
          return blocked('recipient_authority_changed');
        }
        for (const member of members) {
          const opportunity = database.prepare(`
            SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?
          `).get(member.opportunity_id);
          if (!opportunity || opportunity.status !== 'active'
            || opportunity.discovery_revision !== member.campaign_discovery_revision
            || opportunity.material_revision !== member.campaign_material_revision) {
            return blocked('freshness_changed');
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
          const crmOwner = database.prepare(`
            SELECT * FROM contact_submissions WHERE id = ?
          `).get(member.crm_submission_id);
          if (!crmOwner || crmOwner.archived_at
            || crmOwner.deal_hunter_opportunity_id !== member.opportunity_id) {
            return blocked('crm_owner_changed');
          }
          if (member.local_expiry_at && Date.parse(member.local_expiry_at) <= Date.parse(now)) {
            return blocked('expired');
          }
        }
        const suppression = database.prepare(`
          SELECT 1 FROM email_suppressions
          WHERE normalized_email = lower(?) AND lifted_at IS NULL
        `).get(conversation.recipient_address);
        if (suppression) return blocked('recipient_suppressed');
        const communication = database.prepare('SELECT * FROM crm_communications WHERE id = ?')
          .get(transmission.communication_id);
        const outbox = database.prepare('SELECT * FROM crm_email_outbox WHERE id = ?')
          .get(transmission.outbox_id);
        if (!communication || communication.outbox_id !== transmission.outbox_id
          || communication.delivery_state !== 'not-attempted') return blocked('communication_changed');
        if (!outbox || outbox.communication_id !== transmission.communication_id
          || outbox.state !== 'prepared' || outbox.attempt_count !== 0) return blocked('outbox_changed');
        const metadata = JSON.parse(communication.metadata || '{}');
        const payloadDigest = digest('cim-payload:v1', communication.from_address,
          JSON.parse(communication.to_addresses), JSON.parse(communication.cc_addresses),
          JSON.parse(communication.bcc_addresses), communication.reply_to_address,
          communication.subject, communication.body_text, communication.body_html_sanitized,
          metadata.tags, members.map(({ id }) => id), members.map(({ template_version }) => template_version),
          transmission.payload_version);
        if (payloadDigest !== transmission.payload_digest) return blocked('payload_changed');
        database.prepare(`
          UPDATE deal_hunter_cim_transmissions SET state = 'provider-pending',
            release_state = 'authorized', final_gate_authority_digest = ?,
            campaign_terminal_revision = ?, conversation_terminal_revision = ?,
            invocation_authority_count = 1, provider_invocation_authorized_at = ?,
            boundary_nonce_digest = ?, row_version = row_version + 1, updated_at = ?
          WHERE id = ? AND state = 'prepared' AND invocation_authority_count = 0
            AND row_version = ?
        `).run(finalGateAuthorityDigest, expectedCampaignTerminalRevision,
          expectedConversationTerminalRevision, now, boundaryNonceDigest, now,
          transmissionId, expectedRowVersion);
        for (const member of members) database.prepare(`
          UPDATE deal_hunter_cim_campaign_touches SET state = 'provider-pending',
            row_version = row_version + 1, updated_at = ?
          WHERE id = ? AND state = 'claimed' AND transmission_id = ?
        `).run(now, member.id, transmissionId);
        database.prepare(`
          UPDATE deal_hunter_cim_live_provider_authorizations SET consumed_at = ?
          WHERE id = ? AND consumed_at IS NULL AND withdrawn_at IS NULL
        `).run(now, authorizationId);
        database.prepare(`
          UPDATE crm_communications SET delivery_state = 'provider-pending',
            delivery_state_at = ?, updated_at = ? WHERE id = ?
        `).run(now, now, transmission.communication_id);
        database.prepare(`
          UPDATE crm_email_outbox SET state = 'provider-pending', updated_at = ? WHERE id = ?
        `).run(now, transmission.outbox_id);
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
            && existing.provider_profile === providerProfile && existing.expires_at === expiresAt;
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
    async prepareCimTransmission(command) {
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
      const replyToAddress = requiredText(command.replyToAddress, 'replyToAddress', 320);
      const subject = requiredText(command.subject, 'subject', 998);
      const bodyText = requiredText(command.bodyText, 'bodyText', 100000);
      const bodyHtmlSanitized = requiredText(command.bodyHtmlSanitized, 'bodyHtmlSanitized', 100000);
      const actor = requiredText(command.actor, 'actor', 200);
      const now = requiredInstant(command.now);
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
        const conversationId = campaigns[0].conversation_id;
        const conversation = database.prepare(`
          SELECT * FROM deal_hunter_broker_conversations WHERE id = ?
        `).get(conversationId);
        const payloadDigest = digest('cim-payload:v1', fromAddress, addresses.toAddresses,
          addresses.ccAddresses, addresses.bccAddresses, replyToAddress, subject,
          bodyText, bodyHtmlSanitized, command.tags, touchIds,
          campaigns.map((campaign) => campaign.template_version), payloadVersion);
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
          if (preparationGeneration !== currentMembership.preparation_generation + 1
            || !cancelPreparedTransmission(database, currentMembership,
              { now, reasonCode: 'prepared-payload-changed', actor, preserveClaim: true })) {
            return result({ payloadConflict: true }, currentMembership);
          }
          for (const touch of touches) touch.transmission_id = null;
        }
        const capability = touchIds.length > 1 ? 'fl04c-batch'
          : touches[0].kind === 'initial' ? 'fl04b-initial' : 'fl04c-followup';
        if (!currentActivationChain(database, capability, now)
          || !conversation || conversation.state !== 'open'
          || conversation.terminal_revision !== expectedConversationTerminalRevision
          || conversation.recipient_address !== addresses.toAddresses[0]
          || campaigns.some((campaign) => campaign.conversation_id !== conversationId
            || campaign.terminal_revision !== expectedCampaignTerminalRevision
            || !['initial-pending', 'active-follow-up'].includes(campaign.state)
            || !campaign.crm_submission_id
            || (campaign.local_expiry_at && Date.parse(campaign.local_expiry_at) <= Date.parse(now)))
          || touches.some((touch) => touch.state !== 'claimed'
            || touch.claim_token_digest !== claimTokenDigest || touch.transmission_id)) {
          return result({ terminal: true });
        }
        const crmOwner = database.prepare(`
          SELECT * FROM contact_submissions WHERE id = ?
        `).get(campaigns[0].crm_submission_id);
        if (!crmOwner || crmOwner.deal_hunter_opportunity_id !== campaigns[0].opportunity_id
          || crmOwner.archived_at) return result({ terminal: true });
        const memberDigest = digest('cim-members:v1', touchIds);
        const transmissionId = digest('cim-transmission:v1', campaigns[0].policy_version,
          conversation.recipient_fingerprint, touchIds, preparationGeneration,
          payloadVersion, payloadDigest);
        const communicationId = digest('crm-communication:cim-autopilot:v1', transmissionId);
        const outboxId = digest('crm-outbox:cim-autopilot:v1', transmissionId);
        const providerKey = digest('cim-provider:v1', transmissionId, payloadDigest);
        const metadata = JSON.stringify({ transmissionId, campaignIds: campaigns.map(({ id }) => id),
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
    async appendCimTerminalEvent(command) {
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
          || (current.state === 'provider-ambiguous' && !command.reconciliationEvidenceId)
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
        return outcome({ applied: true }, scope === 'campaign' ? expectedRevision + 1 : null,
          scope === 'conversation' ? expectedRevision + 1 : null, cancelledTouchIds.sort());
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
      const claimExpiresAt = requiredInstant(command.claimExpiresAt);
      const now = requiredInstant(command.now);
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
        if (!['initial-pending', 'active-follow-up'].includes(campaign.state)
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
        if (touch.state === 'claimed' && touch.claim_token_digest === claimTokenDigest
          && touch.claim_owner === claimOwner) return result({ alreadyOwned: true }, touch);
        if (touch.state === 'claimed' && (!touch.claim_expires_at
          || Date.parse(touch.claim_expires_at) > Date.parse(now))) {
          return result({ conflict: true }, touch);
        }
        if (touch.row_version !== expectedRowVersion) return result({ staleAuthority: true }, touch);
        if (Date.parse(touch.due_at) > Date.parse(now)
          || Date.parse(claimExpiresAt) <= Date.parse(now) || touch.transmission_id) {
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
}
