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
 * link under the profile, child first, then releases every prepared, never-authorized
 * transmission (Ruling N). Turning on also runs that release before it records any link, so
 * an off whose release failed never strands a prepared follow-up.
 * Returns `{ applied, activations? , withdrawn?, released? }`.
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
    || typeof storage?.withdrawCimCapabilityActivation !== 'function'
    || typeof storage?.releasePreparedCimTransmissions !== 'function') {
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
    // Ruling N: a prepared transmission is bound to the withdrawn chain (a follow-up's
    // reservation can only be renewed under the same activation), so it could never be sent
    // under the chain the next "on" records. Each is cancelled before the provider and its
    // touch returns to scheduled, to be prepared again under the new chain.
    // Ruling T: the release runs on every off, not only when a link was withdrawn now. It is
    // idempotent, so an off whose release failed after its withdraw is finished by a retry.
    const { released } = await storage.releasePreparedCimTransmissions({
      reasonCode: 'live_sending_off', actor: actor.trim(), now: at });
    return { applied: withdrawn.length > 0 || released > 0, withdrawn, released };
  }

  const activations = {};
  let parent = null;
  let applied = false;
  let rebuilding = false;
  let released;
  for (const capability of PURSUE_GMAIL_CAPABILITY_CHAIN) {
    const existing = current.get(capability);
    if (!rebuilding && intact(existing, parent, providerProfile, at)) {
      activations[capability] = existing;
      parent = existing;
      continue;
    }
    if (!rebuilding) {
      // A prepared transmission left by an off whose release failed is bound to the withdrawn
      // chain and could never be sent under the one recorded now, so the release runs before
      // every (re)recording. It only touches never-authorized prepared sends and is
      // idempotent; a recording that fails after it is retried with the chain still broken,
      // so the release runs again then.
      ({ released } = await storage.releasePreparedCimTransmissions({
        reasonCode: 'live_sending_on', actor: actor.trim(), now: at }));
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
  return { applied: applied || released > 0, activations,
    ...(released === undefined ? {} : { released }) };
}

/**
 * Whether the capability chain under `providerProfile` matches the Live sending control: on
 * needs the whole chain current and correctly linked; off needs no chain link current. A
 * mismatch is what a Live sending change that failed after its control write leaves behind.
 */
export async function pursueGmailCapabilitiesInSync({ storage, enabled, now,
  providerProfile = PRODUCTION_GMAIL_CIM_PROVIDER_PROFILE } = {}) {
  const at = requiredInstant(now);
  if (typeof storage?.listCurrentCimCapabilityActivations !== 'function') return false;
  const current = new Map((await storage.listCurrentCimCapabilityActivations())
    .map((row) => [row.capability, row]));
  if (!enabled) {
    return PURSUE_GMAIL_CAPABILITY_CHAIN.every((capability) =>
      current.get(capability)?.provider_profile !== providerProfile);
  }
  let parent = null;
  for (const capability of PURSUE_GMAIL_CAPABILITY_CHAIN) {
    const row = current.get(capability);
    if (!intact(row, parent, providerProfile, at)) return false;
    parent = row;
  }
  return true;
}
