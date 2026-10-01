import { createHash } from 'node:crypto';

import {
  calculateCampaignExpiry,
  calculateNextCimSlot,
  CIM_CAMPAIGN_POLICY_VERSION,
} from './cimCampaignPolicy.js';

function digest(...parts) {
  const framed = parts.map((part) => {
    const value = JSON.stringify(part);
    return [Buffer.byteLength(value), value];
  });
  return createHash('sha256').update(JSON.stringify(framed)).digest('hex');
}

function instant(value, name) {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) throw new Error(`Valid ${name} is required for CIM cadence`);
  return new Date(parsed).toISOString();
}

function revision(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Valid ${name} is required for CIM cadence`);
  }
  return parsed;
}

function expiryDerivation(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('Invalid CIM expiry derivation'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid CIM expiry derivation');
  }
  return value;
}

function nextKind(kind) {
  return ({ initial: 'follow-up-1', 'follow-up-1': 'follow-up-2',
    'follow-up-2': 'follow-up-3', 'follow-up-3': 'weekday-follow-up',
    'weekday-follow-up': 'weekday-follow-up' })[kind] ?? '';
}

function assertCurrentTouch(touch) {
  const expectedOrdinal = { initial: 0, 'follow-up-1': 1, 'follow-up-2': 2,
    'follow-up-3': 3 }[touch.kind];
  if (!nextKind(touch.kind)
    || (expectedOrdinal !== undefined && revision(touch.ordinal, 'touch ordinal') !== expectedOrdinal)
    || (touch.kind !== 'weekday-follow-up' && touch.logical_slot !== touch.kind)
    || (touch.kind === 'weekday-follow-up'
      && (!/^weekday:\d{4}-\d{2}-\d{2}$/.test(touch.logical_slot)
        || revision(touch.ordinal, 'touch ordinal') < 4))) {
    throw new Error('Invalid current CIM cadence touch');
  }
}

export function deriveAcceptedCimCadence(context, observedAt) {
  const acceptedAt = instant(observedAt, 'provider-observed acceptance instant');
  const transmission = context?.transmission;
  const activeMembers = (context?.members ?? []).filter((member) =>
    member?.membership?.cancelled_at == null);
  if (!transmission?.id || activeMembers.length !== 1) {
    throw new Error('Exact single-member CIM cadence context is required');
  }
  const [{ membership, touch, campaign, timezone }] = activeMembers;
  if (!touch || !campaign || !timezone
    || membership.transmission_id !== transmission.id
    || membership.touch_id !== touch.id || membership.campaign_id !== campaign.id
    || touch.campaign_id !== campaign.id || touch.opportunity_id !== campaign.opportunity_id) {
    throw new Error('CIM cadence context is not durably bound');
  }
  if (campaign.policy_version !== CIM_CAMPAIGN_POLICY_VERSION) {
    throw new Error('Unknown CIM cadence policy');
  }
  const timezoneRevision = revision(campaign.timezone_revision, 'campaign timezone revision');
  if (revision(touch.timezone_revision, 'touch timezone revision') !== timezoneRevision
    || revision(timezone.revision, 'timezone authority revision') !== timezoneRevision
    || timezone.opportunity_id !== campaign.opportunity_id
    || typeof timezone.iana_timezone !== 'string') {
    throw new Error('CIM cadence timezone authority changed');
  }
  assertCurrentTouch(touch);
  const campaignTerminalRevision = revision(campaign.terminal_revision,
    'campaign terminal revision');
  if (campaignTerminalRevision !== revision(transmission.campaign_terminal_revision,
    'transmission campaign terminal revision')
    || !['initial-pending', 'active-follow-up', 'provider-ambiguous'].includes(campaign.state)) {
    return null;
  }

  let initialAcceptedAt;
  let localExpiryAt;
  let derivation;
  if (touch.kind === 'initial') {
    initialAcceptedAt = campaign.initial_accepted_at
      ? instant(campaign.initial_accepted_at, 'initial accepted instant') : acceptedAt;
    if (campaign.local_expiry_at) {
      localExpiryAt = instant(campaign.local_expiry_at, 'campaign expiry');
      derivation = expiryDerivation(campaign.expiry_derivation);
    } else {
      derivation = calculateCampaignExpiry(initialAcceptedAt, timezone.iana_timezone);
      localExpiryAt = derivation.expiresAt;
    }
  } else {
    initialAcceptedAt = instant(campaign.initial_accepted_at, 'initial accepted instant');
    localExpiryAt = instant(campaign.local_expiry_at, 'campaign expiry');
    derivation = expiryDerivation(campaign.expiry_derivation);
  }
  const kind = nextKind(touch.kind);
  const slot = calculateNextCimSlot({ policyVersion: campaign.policy_version,
    timezone: timezone.iana_timezone, kind, priorAcceptedAt: acceptedAt,
    priorOutcome: 'accepted', expiryAt: localExpiryAt });
  const nextTouch = slot ? {
    id: digest('cim-touch:v1', campaign.id, slot.slotKey, campaign.policy_version),
    logicalSlot: slot.slotKey,
    kind: slot.kind,
    ordinal: revision(touch.ordinal, 'touch ordinal') + 1,
    rawDueAt: slot.rawDueAt,
    dueAt: slot.dueAt,
    dueLocal: slot.dueLocal,
    timezoneRevision,
    cadencePolicyVersion: campaign.policy_version,
  } : null;
  return {
    campaignId: campaign.id,
    touchId: touch.id,
    expectedCampaignRowVersion: revision(campaign.row_version, 'campaign row version'),
    expectedCampaignTerminalRevision: campaignTerminalRevision,
    expectedTouchRowVersion: revision(touch.row_version, 'touch row version'),
    acceptedAt,
    initialAcceptedAt,
    localExpiryAt,
    expiryDerivation: derivation,
    nextTouch,
  };
}
