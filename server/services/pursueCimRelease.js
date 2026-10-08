import { sha256, stableCanonicalJson } from '../utils/security.js';

const terminalCampaignStates = new Set([
  'responded', 'materials-received', 'stopped', 'expired',
]);

async function defaultGetPauseStatus(args) {
  const { getCimOutreachPauseStatus } = await import('./cimOpportunityIdentity.js');
  return getCimOutreachPauseStatus(args);
}

function boundedText(value, maximum = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function boundedStoredText(value, maximum = 100000) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function finiteRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function storedAddresses(value) {
  let addresses = value;
  if (typeof addresses === 'string') {
    try { addresses = JSON.parse(addresses); } catch { addresses = []; }
  }
  if (!Array.isArray(addresses)) return [];
  return addresses.filter((address) => typeof address === 'string'
    && address.length >= 3 && address.length <= 320).slice(0, 20);
}

function releaseStatus({ decision, enrollment, campaign, transmission, projectedAt }) {
  if (!decision) return { code: 'not_pursued', reason: '', actionRequired: false };
  if (decision.action !== 'pursue') {
    return { code: decision.action === 'pass' ? 'pass_selected' : 'watch_selected',
      reason: decision.action, actionRequired: false };
  }
  if (transmission?.state === 'provider-pending') {
    return { code: 'provider_pending', reason: 'reconciliation_only', actionRequired: true };
  }
  if (transmission?.state === 'ambiguous') {
    return { code: 'provider_ambiguous', reason: 'reconciliation_only', actionRequired: true };
  }
  if (transmission?.state === 'definitive-failure') {
    return { code: 'provider_definitive_failure',
      reason: boundedText(transmission.provider_result_code, 160), actionRequired: true };
  }
  if (campaign?.state === 'stopped') {
    return { code: 'campaign_stopped', reason: boundedText(campaign.reason_code, 160),
      actionRequired: false };
  }
  if (terminalCampaignStates.has(campaign?.state)) {
    return { code: boundedText(campaign.state, 80).replaceAll('-', '_'),
      reason: boundedText(campaign.reason_code, 160), actionRequired: false };
  }
  if (campaign?.state === 'action-required') {
    return { code: 'action_required', reason: boundedText(campaign.reason_code, 160),
      actionRequired: true };
  }
  const expiry = Date.parse(campaign?.local_expiry_at ?? '');
  if (Number.isFinite(expiry) && expiry <= Date.parse(projectedAt)
    && ['initial-pending', 'active-follow-up'].includes(campaign?.state)) {
    return { code: 'expired', reason: 'campaign_window_elapsed', actionRequired: false };
  }
  if (transmission?.state === 'accepted') {
    return { code: 'provider_accepted',
      reason: boundedText(transmission.provider_result_code, 160), actionRequired: false };
  }
  if (transmission?.release_state === 'awaiting-live-authorization') {
    return { code: 'awaiting_live_authorization',
      reason: boundedText(campaign?.reason_code, 160), actionRequired: true };
  }
  if (transmission?.release_state === 'authorized') {
    return { code: 'authorized', reason: '', actionRequired: false };
  }
  if (transmission?.state === 'prepared') {
    return { code: 'prepared', reason: '', actionRequired: false };
  }
  if (campaign) {
    return { code: boundedText(campaign.state, 80).replaceAll('-', '_') || 'initial_pending',
      reason: boundedText(campaign.reason_code, 160), actionRequired: false };
  }
  if (enrollment?.state === 'action-required') {
    return { code: 'action_required', reason: boundedText(enrollment.reason_code, 160),
      actionRequired: true };
  }
  if (enrollment?.state === 'waiting-on-eligibility') {
    return { code: 'queued', reason: boundedText(enrollment.reason_code, 160),
      actionRequired: true };
  }
  return { code: 'queued', reason: boundedText(enrollment?.reason_code, 160),
    actionRequired: false };
}

function publicTransmission({ transmission, communication, cadenceContext }) {
  if (!transmission) return null;
  const boundCommunication = communication?.id === transmission.communication_id
    ? communication : null;
  const persistedMembership = cadenceContext.members.map((member) => member.membership);
  return {
    id: boundedText(transmission.id, 240),
    state: boundedText(transmission.state, 80),
    releaseState: boundedText(transmission.release_state, 80),
    rowVersion: finiteRevision(transmission.row_version),
    preparationGeneration: finiteRevision(transmission.preparation_generation),
    payloadVersion: boundedText(transmission.payload_version, 120),
    payloadDigest: boundedText(transmission.payload_digest, 64),
    memberDigest: boundedText(transmission.member_digest, 64),
    addressing: {
      from: boundedText(boundCommunication?.from_address ?? transmission.from_address, 320),
      to: storedAddresses(boundCommunication?.to_addresses ?? transmission.to_addresses),
      cc: storedAddresses(boundCommunication?.cc_addresses ?? transmission.cc_addresses),
      bcc: storedAddresses(boundCommunication?.bcc_addresses ?? transmission.bcc_addresses),
      replyTo: boundedText(boundCommunication?.reply_to_address
        ?? transmission.reply_to_address, 320),
    },
    copy: boundCommunication ? {
      subject: boundedStoredText(boundCommunication.subject, 998),
      text: boundedStoredText(boundCommunication.body_text),
      html: boundedStoredText(boundCommunication.body_html_sanitized),
    } : null,
    membership: persistedMembership.map((membership) => ({
      opportunityId: boundedText(membership.opportunity_id, 200),
      campaignId: boundedText(membership.campaign_id, 240),
      touchId: boundedText(membership.touch_id, 240),
      displayOrdinal: finiteRevision(membership.display_ordinal),
      cancelledAt: boundedText(membership.cancelled_at, 80),
      cancellationReason: boundedText(membership.cancellation_reason, 160),
    })),
    createdAt: boundedText(transmission.created_at, 80),
    updatedAt: boundedText(transmission.updated_at, 80),
    providerOutcome: transmission.provider_result_code ? {
      state: boundedText(transmission.state, 80),
      resultCode: boundedText(transmission.provider_result_code, 160),
    } : null,
  };
}

export async function getPursueCimReleaseReport({ storage, opportunityId,
  now = new Date().toISOString(), getPauseStatus = defaultGetPauseStatus } = {}) {
  if (!storage || typeof storage.readPursueCimProjection !== 'function'
    || typeof opportunityId !== 'string' || !opportunityId
    || opportunityId.trim() !== opportunityId || opportunityId.length > 200) {
    throw new Error('Invalid Pursue CIM release report request');
  }
  const projectedAt = new Date(now).toISOString();
  const [projection, opportunity, authority, pause] = await Promise.all([
    storage.readPursueCimProjection({ opportunityId }),
    storage.getCurrentDealHunterOpportunity?.(opportunityId) ?? null,
    storage.readPursuitEnrollmentAuthority?.({ opportunityId, now: projectedAt })
      ?? { timezone: null, activation: null, globalAuthorityRevision: null },
    getPauseStatus({ storage }),
  ]);
  const { decision = null, enrollment = null, campaign = null,
    initialTouch = null, transmission = null } = projection || {};
  if (campaign && campaign.opportunity_id !== opportunityId) {
    throw new Error('Pursue CIM release report campaign binding mismatch');
  }
  const [communication, conversation, cadenceContext, liveAuthorization] = await Promise.all([
    transmission && typeof storage.getCrmCommunication === 'function'
      ? storage.getCrmCommunication(transmission.communication_id) : null,
    campaign?.conversation_id && typeof storage.getPursueCimBrokerConversation === 'function'
      ? storage.getPursueCimBrokerConversation(campaign.conversation_id) : null,
    transmission && typeof storage.readCimCadenceContext === 'function'
      ? storage.readCimCadenceContext({ transmissionId: transmission.id }) : null,
    transmission && typeof storage.getPursueCimLiveProviderAuthorization === 'function'
      ? storage.getPursueCimLiveProviderAuthorization(transmission.id) : null,
  ]);
  if (conversation && (conversation.id !== campaign?.conversation_id
    || conversation.recipient_authority_id !== campaign.recipient_authority_id
    || conversation.recipient_fingerprint !== campaign.recipient_fingerprint)) {
    throw new Error('Pursue CIM release report conversation binding mismatch');
  }
  if (transmission && (!cadenceContext || cadenceContext.transmission?.id !== transmission.id
    || !Array.isArray(cadenceContext.members) || cadenceContext.members.length === 0
    || cadenceContext.members.length > 50
    || cadenceContext.members.some((member) => !member?.membership
      || member.membership.transmission_id !== transmission.id))) {
    throw new Error('Pursue CIM release report membership binding mismatch');
  }
  if (liveAuthorization && (liveAuthorization.transmission_id !== transmission?.id
    || liveAuthorization.payload_digest !== transmission.payload_digest
    || liveAuthorization.recipient_authority_digest !== campaign?.recipient_fingerprint)) {
    throw new Error('Pursue CIM release report authorization binding mismatch');
  }
  const status = releaseStatus({ decision, enrollment, campaign, transmission, projectedAt });
  const activation = authority?.activation || null;
  const timezone = authority?.timezone || null;
  const canStop = Boolean(campaign && status.code !== 'expired'
    && !terminalCampaignStates.has(campaign.state));
  const releasedTransmission = publicTransmission({ transmission, communication, cadenceContext });
  const authorizationStatus = !liveAuthorization ? '' : liveAuthorization.withdrawn_at
    ? 'withdrawn' : liveAuthorization.consumed_at ? 'consumed'
      : Date.parse(liveAuthorization.expires_at) <= Date.parse(projectedAt) ? 'expired' : 'current';
  return {
    projectedAt,
    opportunity: {
      id: opportunityId,
      name: boundedText(opportunity?.canonical_name, 500),
      state: boundedText(opportunity?.status, 80),
    },
    status,
    decision: decision ? {
      action: boundedText(decision.action, 40),
      decidedAt: boundedText(decision.created_at, 80),
    } : null,
    enrollment: enrollment ? {
      state: boundedText(enrollment.state, 80),
      reasonCode: boundedText(enrollment.reason_code, 160),
      createdAt: boundedText(enrollment.created_at, 80),
    } : null,
    campaign: campaign ? {
      id: boundedText(campaign.id, 240),
      generation: finiteRevision(campaign.generation),
      state: boundedText(campaign.state, 80),
      reasonCode: boundedText(campaign.reason_code, 160),
      rowVersion: finiteRevision(campaign.row_version),
      terminalRevision: finiteRevision(campaign.terminal_revision),
      policyVersion: boundedText(campaign.policy_version, 120),
      templateVersion: boundedText(campaign.template_version, 120),
      localExpiryAt: boundedText(campaign.local_expiry_at, 80),
      createdAt: boundedText(campaign.created_at, 80),
    } : null,
    recipientAuthority: campaign ? {
      address: boundedText(conversation?.recipient_address
        ?? releasedTransmission?.addressing?.to?.[0], 320),
      authorityId: boundedText(campaign.recipient_authority_id, 240),
      fingerprint: boundedText(campaign.recipient_fingerprint, 64),
      permissionVersion: boundedText(campaign.permission_version, 240),
      permissionDigest: boundedText(campaign.permission_digest, 64),
      permissionRevision: finiteRevision(campaign.permission_revision),
      permissionScope: boundedText(campaign.permission_scope, 240),
    } : null,
    timezoneAuthority: timezone ? {
      state: boundedText(timezone.state, 40),
      ianaTimezone: boundedText(timezone.iana_timezone, 120),
      revision: finiteRevision(timezone.revision),
      selectedRevision: finiteRevision(campaign?.timezone_revision),
      current: Boolean(campaign && finiteRevision(timezone.revision)
        === finiteRevision(campaign.timezone_revision)),
    } : null,
    initialTouch: initialTouch ? {
      id: boundedText(initialTouch.id, 240),
      state: boundedText(initialTouch.state, 80),
      dueAt: boundedText(initialTouch.due_at, 80),
      dueLocal: boundedText(initialTouch.due_local, 120),
      rowVersion: finiteRevision(initialTouch.row_version),
    } : null,
    transmission: releasedTransmission,
    liveAuthorization: liveAuthorization ? {
      id: boundedText(liveAuthorization.id, 240),
      capability: boundedText(liveAuthorization.capability, 40),
      writerPath: boundedText(liveAuthorization.writer_path, 240),
      status: authorizationStatus,
      issuedAt: boundedText(liveAuthorization.issued_at, 80),
      expiresAt: boundedText(liveAuthorization.expires_at, 80),
      consumedAt: boundedText(liveAuthorization.consumed_at, 80),
      withdrawnAt: boundedText(liveAuthorization.withdrawn_at, 80),
    } : null,
    activation: activation ? {
      id: boundedText(activation.id, 240),
      capability: boundedText(activation.capability, 40),
      mode: boundedText(activation.mode, 40),
      status: boundedText(activation.status, 40),
      expiresAt: boundedText(activation.expires_at, 80),
      matchesCampaign: Boolean(campaign && activation.id === campaign.permission_version),
    } : null,
    pause: {
      paused: Boolean(pause?.paused),
      source: boundedText(pause?.source, 80),
      updatedAt: boundedText(pause?.updatedAt, 80),
    },
    legacySummary: {
      count: finiteRevision(projection?.legacySummary?.count) ?? 0,
      accepted: finiteRevision(projection?.legacySummary?.accepted) ?? 0,
      ambiguous: finiteRevision(projection?.legacySummary?.ambiguous) ?? 0,
    },
    actions: {
      canStop,
      ...(canStop ? {
        campaignId: boundedText(campaign.id, 240),
        expectedRowVersion: finiteRevision(campaign.row_version),
        expectedTerminalRevision: finiteRevision(campaign.terminal_revision),
      } : {}),
    },
  };
}

export async function stopPursueCimCampaign({ storage, opportunityId, campaignId,
  expectedRowVersion, expectedTerminalRevision, idempotencyKey, reason = '', actor,
  now = new Date().toISOString(), getPauseStatus = defaultGetPauseStatus } = {}) {
  const invalid = !storage || typeof storage.appendCimTerminalEvent !== 'function'
    || typeof opportunityId !== 'string' || !opportunityId || opportunityId.length > 200
    || opportunityId.trim() !== opportunityId
    || typeof campaignId !== 'string' || !campaignId || campaignId.length > 240
    || campaignId.trim() !== campaignId
    || !Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 0
    || !Number.isSafeInteger(expectedTerminalRevision) || expectedTerminalRevision < 0
    || typeof idempotencyKey !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)
    || typeof actor !== 'string' || !actor.trim() || actor.length > 200
    || typeof reason !== 'string' || reason.length > 500;
  if (invalid) return { ok: false, status: 400, code: 'invalid_stop_command',
    error: 'A bounded, revision-bound campaign stop command is required.' };
  const projection = await storage.readPursueCimProjection({ opportunityId });
  if (!projection?.campaign || projection.campaign.id !== campaignId
    || projection.campaign.opportunity_id !== opportunityId) {
    return { ok: false, status: 409, code: 'stale_campaign',
      error: 'The selected Pursue campaign is no longer current.' };
  }
  const observedAt = new Date(now).toISOString();
  const normalizedActor = actor.trim();
  const normalizedReason = reason.trim();
  const eventId = `cim-stop:${sha256(idempotencyKey)}`;
  const metadataDigest = sha256(stableCanonicalJson({ opportunityId, campaignId,
    expectedRowVersion, expectedTerminalRevision, idempotencyKey,
    reason: normalizedReason, actor: normalizedActor }));
  const outcome = await storage.appendCimTerminalEvent({ eventId, scope: 'campaign',
    scopeId: campaignId, expectedRevision: expectedTerminalRevision,
    expectedRowVersion, nextState: 'stopped', reasonCode: 'campaign_stopped',
    evidenceType: 'operator-stop', evidenceId: idempotencyKey, metadataDigest,
    actor: normalizedActor, source: 'release-owner-command', observedAt, now: observedAt });
  if (!outcome?.applied && !outcome?.replay) {
    return { ok: false, status: 409, code: 'stale_campaign',
      error: 'Campaign authority changed before the stop was saved.' };
  }
  return { ok: true, status: 200, replay: Boolean(outcome.replay),
    cancelledTouchIds: Array.isArray(outcome.cancelledTouchIds)
      ? outcome.cancelledTouchIds.slice(0, 100) : [],
    report: await getPursueCimReleaseReport({ storage, opportunityId, now: observedAt,
      getPauseStatus }) };
}
