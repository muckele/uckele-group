// The capability chain behind Live sending (Ruling K, spec §5.3).
//
// Every Pursue send goes through the activation chain fl04a-safety -> fl04b-enrollment ->
// fl04b-initial -> fl04c-followup, under one provider profile. Before Gmail sending the chain
// was recorded by hand by the P10B harness; now Live sending is the owner's single switch:
// turning it on records the production-gmail-v1 chain and turning it off withdraws it. Both
// go through the existing audited activation transitions.
//
// The fl04b-enrollment link carries no per-recipient permission (no permission basis or
// cohort digest). Campaigns enrolled under the standing contact rule are authorized by the
// rule itself (Ruling H), which the final gate checks; the link only keeps the chain whole.
import { PRODUCTION_GMAIL_CIM_PROVIDER_PROFILE } from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { CONTACT_POLICY_VERSION } from './pursueCimContactPolicy.js';

export const PURSUE_GMAIL_CAPABILITY_CHAIN = Object.freeze([
  'fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup',
]);
export const PURSUE_GMAIL_CAPABILITY_POLICY = 'pursue-gmail-live-sending-v1';
// Follow-up capacity under Live sending. Gmail's own quota is the real limit (spec §5.6);
// these only bound a runaway loop. One follow-up per recipient address per day is the
// cadence's own pace (every 2 business days), with room for a broker on several listings.
export const PURSUE_GMAIL_FOLLOW_UP_DAILY_CAP = 500;
export const PURSUE_GMAIL_FOLLOW_UP_RECIPIENT_CAP = 3;

const digest = (value) => sha256(stableCanonicalJson(value));

function requiredInstant(value) {
  const at = new Date(value ?? Number.NaN);
  if (!Number.isFinite(at.getTime())) throw new Error('Live sending capability sync needs an instant');
  return at.toISOString();
}

function intact(row, parent, providerProfile, now) {
  return Boolean(row) && row.status === 'current' && row.mode === 'active'
    && row.provider_profile === providerProfile
    && (!row.expires_at || Date.parse(row.expires_at) > Date.parse(now))
    && (parent ? row.prerequisite_activation_id === parent.id
      && Boolean(row.prerequisite_evidence_id) && Boolean(row.prerequisite_evidence_hash)
      : !row.prerequisite_activation_id);
}

/**
 * Records (enabled) or withdraws (disabled) the production-gmail-v1 capability chain.
 * Turning on keeps every link that is already current and correctly chained under the profile
 * and records new links from the first one that is not; turning off withdraws every current
 * link under the profile, child first. Returns `{ applied, activations?, withdrawn? }`.
 */
export async function syncPursueGmailCapabilities({ storage, enabled, actor, now,
  providerProfile = PRODUCTION_GMAIL_CIM_PROVIDER_PROFILE } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Live sending capability sync needs enabled');
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) {
    throw new Error('Live sending capability sync needs an actor');
  }
  const at = requiredInstant(now);
  if (typeof storage?.listCurrentCimCapabilityActivations !== 'function'
    || typeof storage?.recordCimCapabilityActivation !== 'function'
    || typeof storage?.withdrawCimCapabilityActivation !== 'function') {
    throw new Error('CIM capability storage is unavailable');
  }
  const current = new Map((await storage.listCurrentCimCapabilityActivations())
    .map((row) => [row.capability, row]));

  if (!enabled) {
    const withdrawn = [];
    for (const capability of [...PURSUE_GMAIL_CAPABILITY_CHAIN].reverse()) {
      const row = current.get(capability);
      if (!row || row.provider_profile !== providerProfile) continue;
      const result = await storage.withdrawCimCapabilityActivation({ id: row.id, actor: actor.trim(),
        reason: 'live_sending_off', now: at });
      if (result.applied) withdrawn.push(row.id);
    }
    return { applied: withdrawn.length > 0, withdrawn };
  }

  const activations = {};
  let parent = null;
  let applied = false;
  let rebuilding = false;
  for (const capability of PURSUE_GMAIL_CAPABILITY_CHAIN) {
    const existing = current.get(capability);
    if (!rebuilding && intact(existing, parent, providerProfile, at)) {
      activations[capability] = existing;
      parent = existing;
      continue;
    }
    rebuilding = true;
    const id = `pursue-gmail-${capability}-${digest({ capability, at,
      parent: parent?.id ?? null, providerProfile }).slice(0, 24)}`;
    const result = await storage.recordCimCapabilityActivation({
      id, capability, mode: 'active',
      policyHash: digest({ policy: PURSUE_GMAIL_CAPABILITY_POLICY, capability,
        contactPolicy: CONTACT_POLICY_VERSION }),
      configHash: digest({ policy: PURSUE_GMAIL_CAPABILITY_POLICY, providerProfile }),
      actor: actor.trim(), reason: 'live_sending_on', confirmation: 'live-sending-on',
      providerProfile, now: at,
      ...(parent ? { prerequisiteActivationId: parent.id,
        prerequisiteEvidenceId: `live-sending:${parent.id}`,
        prerequisiteEvidenceHash: digest({ policy: PURSUE_GMAIL_CAPABILITY_POLICY,
          prerequisite: parent.id, capability }) } : {}),
      ...(capability === 'fl04c-followup' ? { dailyCap: PURSUE_GMAIL_FOLLOW_UP_DAILY_CAP,
        recipientCap: PURSUE_GMAIL_FOLLOW_UP_RECIPIENT_CAP } : {}),
    });
    if (!(result.applied || result.replay) || !result.activation) {
      throw new Error(`Live sending capability ${capability} was not recorded`);
    }
    applied = applied || result.applied;
    activations[capability] = result.activation;
    parent = result.activation;
  }
  return { applied, activations };
}
