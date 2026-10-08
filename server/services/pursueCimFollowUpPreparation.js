const FOLLOW_UP_LEASE_MS = 5 * 60 * 1000;

function result(blockedReason, extra = {}) {
  return { prepared: false, blockedReason, transmission: null, reservation: null, ...extra };
}

function authorityBlock(authority, candidate, at) {
  if (!authority || typeof authority !== 'object') return 'authority_unavailable';
  const { touch, campaign, conversation, opportunity, crmOwnership, crmSubmission,
    recipient, terminal, activation } = authority;
  if (!touch || !campaign || !conversation || !opportunity || !crmOwnership
    || !crmSubmission || !recipient || !terminal || !activation) return 'authority_unavailable';
  if (campaign.local_expiry_at && Date.parse(campaign.local_expiry_at) <= Date.parse(at)) {
    return 'campaign_expired';
  }
  for (const [field, reason] of [
    ['replyReceived', 'reply_received'], ['materialsReceived', 'materials_received'],
    ['advancedDiligence', 'advanced_diligence'], ['suppressed', 'recipient_suppressed'],
    ['unsafeDelivery', 'unsafe_delivery'], ['providerPending', 'provider_pending'],
    ['providerAmbiguous', 'provider_ambiguous'],
  ]) if (terminal[field]) return reason;
  const fingerprints = [candidate.recipient_fingerprint, campaign.recipient_fingerprint,
    conversation.recipient_fingerprint, recipient.fingerprint];
  if (!fingerprints[0] || fingerprints.some((value) => value !== fingerprints[0])) {
    return 'recipient_changed';
  }
  if (touch.id !== candidate.touch_id || touch.campaign_id !== candidate.campaign_id
    || touch.opportunity_id !== candidate.opportunity_id
    || campaign.id !== candidate.campaign_id
    || campaign.conversation_id !== candidate.conversation_id
    || campaign.opportunity_id !== candidate.opportunity_id
    || conversation.id !== candidate.conversation_id
    || opportunity.opportunity_id !== candidate.opportunity_id
    || campaign.crm_submission_id !== candidate.crm_submission_id
    || crmSubmission.id !== candidate.crm_submission_id
    || crmSubmission.deal_hunter_opportunity_id !== candidate.opportunity_id
    || crmSubmission.archived_at || crmOwnership.submission_id !== candidate.crm_submission_id) {
    return 'authority_changed';
  }
  if (conversation.recipient_address !== candidate.recipient_address
    || recipient.address !== candidate.recipient_address) return 'recipient_changed';
  if (campaign.state !== 'active-follow-up' || conversation.state !== 'open'
    || opportunity.status !== 'active' || touch.kind === 'initial'
    || !['scheduled', 'claimed'].includes(touch.state)) return 'authority_changed';
  if (activation.id !== candidate.activation_id || activation.capability !== 'fl04c-followup'
    || activation.status !== 'current' || activation.mode !== 'active'
    || (activation.expires_at && Date.parse(activation.expires_at) <= Date.parse(at))) {
    return 'capability_inactive';
  }
  return null;
}

export async function runCimFollowUpPreparation({ storage, candidate, now, clock,
  actor = 'pursue-cim-follow-up-preparer', claimTokenDigest, loadAuthority,
  buildPayload } = {}) {
  if (typeof storage?.claimDueCimTouch !== 'function'
    || typeof storage?.prepareReservedCimFollowUp !== 'function') {
    throw new Error('CIM follow-up storage transitions unavailable');
  }
  if (!candidate || typeof loadAuthority !== 'function' || typeof buildPayload !== 'function'
    || !/^[0-9a-f]{64}$/.test(claimTokenDigest || '')) {
    throw new Error('Invalid CIM follow-up preparation input');
  }
  const instant = () => {
    const value = new Date(clock ? clock() : now ?? new Date());
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid CIM follow-up instant');
    return value.toISOString();
  };
  const beforeAt = instant();
  const before = await loadAuthority({ candidate, storage, now: beforeAt });
  const beforeBlock = authorityBlock(before, candidate, beforeAt);
  if (beforeBlock) return result(beforeBlock);
  const claimAt = instant();
  const claim = await storage.claimDueCimTouch({
    touchId: candidate.touch_id,
    expectedRowVersion: Number(candidate.row_version),
    expectedCampaignTerminalRevision: Number(candidate.campaign_terminal_revision),
    expectedConversationTerminalRevision: Number(candidate.conversation_terminal_revision),
    claimTokenDigest, claimOwner: actor,
    claimExpiresAt: new Date(Date.parse(claimAt) + FOLLOW_UP_LEASE_MS).toISOString(),
    now: claimAt,
  });
  if (!claim?.claimed) {
    return result(claim?.terminal ? 'terminal_authority_changed'
      : claim?.staleAuthority ? 'authority_changed' : 'concurrent_winner', { claim });
  }
  const afterAt = instant();
  const after = await loadAuthority({ candidate, storage, now: afterAt });
  const afterBlock = authorityBlock(after, candidate, afterAt);
  if (afterBlock) return result(afterBlock, { claim });
  const payload = await buildPayload({ candidate, authority: after, storage, now: afterAt });
  if (!payload || typeof payload !== 'object') throw new Error('Invalid follow-up payload');
  const message = Object.fromEntries(['payloadVersion', 'fromAddress', 'toAddresses',
    'ccAddresses', 'bccAddresses', 'replyToAddress', 'subject', 'bodyText',
    'bodyHtmlSanitized', 'tags'].map((field) => [field, payload[field]]));
  const prepared = await storage.prepareReservedCimFollowUp({
    activationId: candidate.activation_id,
    claimOwner: actor,
    recipientFingerprint: candidate.recipient_fingerprint,
    touchIds: [candidate.touch_id], claimTokenDigest,
    expectedCampaignTerminalRevision: Number(candidate.campaign_terminal_revision),
    expectedConversationTerminalRevision: Number(candidate.conversation_terminal_revision),
    ...message, preparationGeneration: 1, actor,
  });
  return {
    prepared: prepared.prepared === true,
    existing: prepared.existing === true,
    capacityDeferred: prepared.capacityDeferred === true,
    payloadConflict: prepared.payloadConflict === true,
    terminal: prepared.terminal === true,
    blockedReason: prepared.blockedReason ?? null,
    transmission: prepared.transmission ?? null,
    reservation: prepared.reservation ?? null,
    claim,
  };
}
