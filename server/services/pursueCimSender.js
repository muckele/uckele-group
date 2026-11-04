// The scheduled Pursue sender (spec 2026-11-03 §5). One run, in a fixed order:
//   1. readiness: not ready sends nothing;
//   2. the day-28 expiry sweep;
//   3. sends whose provider seam was entered but never recorded an outcome are reconciled
//      through Gmail's own Sent mail (findSent), never sent again (Review Focus 3);
//   4. initial emails inside their campaign's weekday 08:00-17:00 local window;
//   5. due follow-ups.
// Sends go one at a time: prepare, issue the one-time authorization (only while Live sending
// is on), the final gate, then Gmail, then finalize or reconcile. A touch whose claim lapsed is
// picked up again (Ruling L); nothing that may have reached Gmail is ever prepared or sent again.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { cimProviderUsesGmail, getConfig } from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { loadBrokerMaterialsAuthority } from './dealHunterBrokerMaterials.js';
import { ownerBusinessDate } from './dealHunterFreshInboxPolicy.js';
import { createGmailCimProvider } from './gmailCimProvider.js';
import { orchestratePursuitEnrollment } from './pursueCimEnrollment.js';
import { authorizePreparedCimTransmission } from './pursueCimFinalGate.js';
import { buildPursueFollowUpPayload, loadPursueFollowUpAuthority } from './pursueCimFollowUpHooks.js';
import { runCimFollowUpPreparation } from './pursueCimFollowUpPreparation.js';
import { prepareDueCimInitialTouch } from './pursueCimInitialPreparation.js';
import {
  createCimGmailReconciliationLookup,
  finalizeAuthorizedCimTransmission,
  reconcileCimProviderTransmission,
} from './pursueCimProvider.js';
import { readPursueCimProviderReadiness } from './pursueCimReadiness.js';

export const PURSUE_CIM_SENDER_ACTOR = 'pursue-cim-sender';
export const PURSUE_CIM_SENDER_QUOTA_JOB_NAME = 'pursue-cim-sender-quota';
const CLAIM_LEASE_MS = 4 * 60 * 1000;
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
// A seam entered this recently may belong to a send still in flight in another process.
const RECONCILE_GRACE_MS = 10 * 60 * 1000;
const LIST_LIMIT = 100;
const WINDOW_START_MINUTE = 8 * 60;
const WINDOW_END_MINUTE = 17 * 60;
// Gate refusals that mean nothing else can be sent this run either.
const RUN_STOPPING_GATE_REFUSALS = new Set(['provider_readiness_unavailable', 'central_pause',
  'contact_rule_off', 'capability_inactive', 'profile_mismatch']);
const CODE = /^[a-z][a-z0-9_]{0,79}$/;

const digest = (value) => sha256(stableCanonicalJson(value));

function errorCode(error, fallback) {
  const candidate = typeof error?.code === 'string' ? error.code : String(error?.message ?? '');
  return CODE.test(candidate) ? candidate : fallback;
}

function isoInstant(value) {
  const at = new Date(value ?? Number.NaN);
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid Pursue sender instant');
  return at;
}

/** The campaign-local weekday send window (spec §5.2), the same rule the final gate applies. */
export function pursueSendWindow(at, timezone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return !['Sat', 'Sun'].includes(parts.weekday)
      && minute >= WINDOW_START_MINUTE && minute < WINDOW_END_MINUTE;
  } catch {
    return false;
  }
}

function quotaJobKey(businessDate) {
  return `pursue-cim-sender:provider-quota:${businessDate}`;
}

async function quotaMarked(storage, at) {
  if (typeof storage?.getScheduledJob !== 'function') return false;
  const job = await storage.getScheduledJob(quotaJobKey(ownerBusinessDate(at)));
  return Boolean(job);
}

// Gmail refused before acceptance for quota: no more sends this owner business day (§5.6).
async function markQuota(storage, at, actor) {
  const businessDate = ownerBusinessDate(at);
  const jobKey = quotaJobKey(businessDate);
  const claimToken = randomUUID();
  const nowIso = at.toISOString();
  const claim = await storage.claimScheduledJob({ jobKey, jobName: PURSUE_CIM_SENDER_QUOTA_JOB_NAME,
    triggeredBy: actor, claimToken, nowIso, metadata: { businessDate, reason: 'provider_quota' } });
  if (!(claim.applied ?? claim.claimed)) return;
  await storage.transitionScheduledJob({ jobKey, claimToken, expectedStatuses: ['pending'],
    status: 'completed', nowIso, completedAt: nowIso, metadataPatch: { stoppedFor: 'provider_quota' } });
}

/**
 * Moves every campaign past its day-28 local expiry to `expired` through the terminal-event
 * path, which cancels its scheduled touches and prepared transmissions (spec §5.4). Returns
 * how many campaigns it expired.
 */
export async function sweepExpiredPursueCampaigns({ storage, now = new Date(),
  actor = PURSUE_CIM_SENDER_ACTOR, limit = 100 } = {}) {
  if (typeof storage?.listExpiredCimCampaigns !== 'function'
    || typeof storage?.appendCimTerminalEvent !== 'function') {
    throw new Error('CIM expiry storage is unavailable');
  }
  const at = isoInstant(now).toISOString();
  let expired = 0;
  for (const campaign of await storage.listExpiredCimCampaigns({ now: at, limit })) {
    const localExpiryAt = new Date(campaign.local_expiry_at).toISOString();
    const evidence = { type: 'pursue-cim-campaign-expiry-v1', campaignId: campaign.id,
      localExpiryAt };
    try {
      const result = await storage.appendCimTerminalEvent({
        eventId: digest(evidence), scope: 'campaign', scopeId: campaign.id,
        expectedRevision: Number(campaign.terminal_revision),
        expectedRowVersion: Number(campaign.row_version),
        nextState: 'expired', reasonCode: 'campaign_expired', evidenceType: 'campaign-expiry',
        evidenceId: `campaign-expiry:${campaign.id}`.slice(0, 240),
        metadataDigest: digest(evidence), actor, source: PURSUE_CIM_SENDER_ACTOR,
        observedAt: localExpiryAt, now: at,
      });
      if (result?.applied) expired += 1;
    } catch {
      // One campaign's conflict never stops the sweep; the next run tries it again.
    }
  }
  return expired;
}

/**
 * Step 3 of a run (Review Focus 3): a transmission whose provider seam was entered more than
 * ten minutes ago and that never recorded an outcome may or may not be in Gmail. It is looked up
 * by its own Message-ID in the owner's Sent mail: found is reconciled as accepted; not found is
 * finalized ambiguous, which moves the campaign to provider-ambiguous for the owner. It is never
 * sent again. A failed lookup leaves it for the next run.
 */
export async function reconcileUnrecordedPursueSends({ storage, mailProvider, providerProfile,
  now, clock, actor = PURSUE_CIM_SENDER_ACTOR, config, graceMs = RECONCILE_GRACE_MS,
  limit = 50 } = {}) {
  const outcome = { reconciled: 0, ambiguous: 0, skipped: {} };
  const skip = (reason) => { outcome.skipped[reason] = (outcome.skipped[reason] || 0) + 1; };
  if (typeof storage?.listCimProviderPendingTransmissions !== 'function') return outcome;
  const instant = () => isoInstant(clock ? clock() : now ?? new Date());
  const enteredBefore = new Date(instant().getTime() - graceMs).toISOString();
  for (const transmission of await storage.listCimProviderPendingTransmissions({
    enteredBefore, limit })) {
    try {
      const authorization = await storage.getPursueCimLiveProviderAuthorization(transmission.id);
      if (!providerProfile || authorization?.provider_profile !== providerProfile) continue;
      const at = instant();
      const reconciled = await reconcileCimProviderTransmission({ storage, transmission,
        readProviderEvidence: createCimGmailReconciliationLookup({ mailProvider,
          clock: () => at }),
        providerProfile, actor, now: at, configOverride: config });
      if (reconciled.resolved && reconciled.outcome === 'accepted') {
        outcome.reconciled += 1;
        continue;
      }
      if (reconciled.durableResult) {
        if (reconciled.outcome === 'ambiguous') outcome.ambiguous += 1;
        else skip('reconcile_conflict');
        continue;
      }
      // Not in the owner's Sent mail: the owner decides (spec §5.7); nothing is retried.
      const finalAt = instant().toISOString();
      const result = await storage.finalizeCimTransmission({
        transmissionId: transmission.id, payloadDigest: transmission.payload_digest,
        expectedRowVersion: Number(transmission.row_version), outcome: 'ambiguous',
        provider: 'gmail', providerMessageId: null,
        providerResultCode: 'gmail_send_unrecorded', observedAt: finalAt,
        actor, now: finalAt, cadence: null });
      if (result?.applied || result?.existing) outcome.ambiguous += 1;
      else skip('reconcile_conflict');
    } catch (error) {
      skip(errorCode(error, 'reconcile_failed'));
    }
  }
  return outcome;
}

/**
 * Re-evaluates enrollments waiting on eligibility under the current contact rule and contact
 * options, after a successful Sheet sync (spec §5.5). An enrollment whose owner picked a
 * specific contact keeps waiting: only the owner's own click carries that choice.
 */
export async function reevaluateWaitingPursuitEnrollments({ storage, now = new Date(),
  actor = 'pursue-cim-enrollment-reevaluation', readSourceHealth, limit = 100 } = {}) {
  const counts = { enrolled: 0, stillWaiting: 0, actionRequired: 0 };
  if (typeof storage?.listWaitingPursuitEnrollments !== 'function') return counts;
  const at = isoInstant(now);
  for (const { enrollment, decision } of await storage.listWaitingPursuitEnrollments({ limit })) {
    if (!decision || decision.selected_contact_reference_digest) {
      counts.stillWaiting += 1;
      continue;
    }
    let state = enrollment.state;
    try {
      const result = await orchestratePursuitEnrollment({ storage,
        opportunityId: enrollment.opportunity_id, enrollment, decision, actor, now: at,
        ...(readSourceHealth ? { readSourceHealth } : {}) });
      state = result.enrollment?.state ?? state;
    } catch {
      state = enrollment.state;
    }
    if (state === 'campaign-created') counts.enrolled += 1;
    else if (state === 'action-required') counts.actionRequired += 1;
    else counts.stillWaiting += 1;
  }
  return counts;
}

/**
 * One sender run. Returns `{ sentInitial, sentFollowUps, expired, reconciled, skipped, failed,
 * ambiguous, stoppedFor? }`; `stoppedFor` is 'provider_quota' or 'not_ready'.
 *
 * `clock` returns the current instant on every call; each gate attempt reads its own instant.
 * The authority readers are injectable for tests and default to the production readers.
 */
export async function runPursueCimSender({ storage, mailProvider, now, clock, config,
  actor = PURSUE_CIM_SENDER_ACTOR,
  loadMemberAuthority,
  readCurrentAuthority,
  loadInitialAuthority = loadBrokerMaterialsAuthority,
  buildFollowUpPayload = buildPursueFollowUpPayload } = {}) {
  if (!storage) throw new Error('Pursue sender storage is unavailable');
  const resolvedConfig = config || getConfig();
  const instant = () => isoInstant(clock ? clock() : now ?? new Date());
  const summary = { sentInitial: 0, sentFollowUps: 0, expired: 0, reconciled: 0, skipped: {},
    failed: 0, ambiguous: 0 };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };
  const stop = (stoppedFor, reason) => {
    if (reason) skip(reason);
    summary.stoppedFor = stoppedFor;
    return summary;
  };

  const profile = resolvedConfig?.dealHunter?.cimProvider;
  if (!cimProviderUsesGmail(resolvedConfig) || profile?.enabled !== true || !profile.profile) {
    return stop('not_ready', 'provider_not_gmail');
  }
  const providerProfile = profile.profile;
  const provider = mailProvider || createGmailCimProvider({ storage, config: resolvedConfig });
  const readProviderReadiness = ({ storage: gateStorage, now: gateNow }) =>
    readPursueCimProviderReadiness({ storage: gateStorage, providerProfile, now: gateNow,
      mailProvider: provider, config: resolvedConfig });

  // 1. Readiness.
  const readiness = await readProviderReadiness({ storage, now: instant() });
  if (!readiness.ready) {
    summary.notReadyReasons = [...readiness.reasons];
    return stop('not_ready');
  }

  // 2. Day-28 expiry.
  summary.expired = await sweepExpiredPursueCampaigns({ storage, now: instant(), actor });

  // 3. Sends that entered the provider seam and never recorded an outcome.
  await reconcileUnrecordedSends();

  if (await quotaMarked(storage, instant())) {
    skip('provider_quota_wait');
    return summary;
  }

  const chain = await currentChain();
  // A recovered or due touch whose claim lapsed with a prepared transmission (Ruling L).
  for (const row of await storage.listLapsedCimPreparedTouches({
    now: instant().toISOString(), limit: LIST_LIMIT })) {
    const outcome = await recoverLapsedPreparation(row);
    if (outcome) return outcome;
  }
  // 4. Initial emails.
  for (const candidate of await storage.listDueCimInitialTouches({
    now: instant().toISOString(), limit: LIST_LIMIT })) {
    const outcome = await sendDueInitial(candidate);
    if (outcome) return outcome;
  }
  // 5. Follow-ups.
  for (const candidate of await storage.listDueCimFollowUpTouches({
    now: instant().toISOString(), limit: LIST_LIMIT })) {
    const outcome = await sendDueFollowUp(candidate);
    if (outcome) return outcome;
  }
  return summary;

  async function currentChain() {
    const rows = typeof storage.listCurrentCimCapabilityActivations === 'function'
      ? await storage.listCurrentCimCapabilityActivations() : [];
    const byCapability = new Map(rows.map((row) => [row.capability, row]));
    const usable = (capability) => {
      const row = byCapability.get(capability);
      return row?.provider_profile === providerProfile ? row : null;
    };
    return { initial: usable('fl04b-initial'), followUp: usable('fl04c-followup') };
  }

  async function timezoneOf(touchId) {
    const authority = await storage.readCimFollowUpAuthority({ touchId,
      now: instant().toISOString() });
    return authority?.timezone?.iana_timezone || '';
  }

  // Inside the campaign's weekday 08:00-17:00 local window. A follow-up due earlier the same
  // local day goes out that day; one missed past its day goes out at the next weekday window,
  // once (the next touch is scheduled from its acceptance, so nothing doubles up).
  async function inWindow(touchId) {
    const timezone = await timezoneOf(touchId);
    return Boolean(timezone) && pursueSendWindow(instant(), timezone);
  }

  async function liveSendingOn() {
    const controls = await storage.getPursueSendControls();
    return controls?.liveSending?.enabled === true;
  }

  async function reconcileUnrecordedSends() {
    const outcome = await reconcileUnrecordedPursueSends({ storage, mailProvider: provider,
      providerProfile, clock: instant, actor, config: resolvedConfig });
    summary.reconciled += outcome.reconciled;
    summary.ambiguous += outcome.ambiguous;
    for (const [reason, value] of Object.entries(outcome.skipped)) {
      summary.skipped[reason] = (summary.skipped[reason] || 0) + value;
    }
  }

  async function issueAuthorization({ transmission, capability, writerPath, activation,
    recipientFingerprint }) {
    const at = instant();
    const issued = await storage.issueCimLiveProviderAuthorization({
      id: `pursue-cim-sender-${digest({ transmissionId: transmission.id,
        at: at.toISOString() }).slice(0, 40)}`,
      activationId: activation.id, capability, writerPath, transmissionId: transmission.id,
      payloadDigest: transmission.payload_digest, recipientAuthorityDigest: recipientFingerprint,
      providerProfile, expiresAt: new Date(at.getTime() + AUTHORIZATION_TTL_MS).toISOString(),
      actor, reason: 'Pursue sender: one send while Live sending is on', now: at.toISOString(),
    });
    if (issued.issued) return { authorization: issued.authorization };
    const existing = issued.authorization;
    if (issued.blockedReason === 'authorization_exists' && existing
      && existing.activation_id === activation.id && existing.capability === capability
      && existing.provider_profile === providerProfile
      && existing.payload_digest === transmission.payload_digest
      && Date.parse(existing.expires_at) > instant().getTime() + 60_000) {
      return { authorization: existing };
    }
    return { reason: issued.blockedReason || 'authorization_unavailable' };
  }

  /** Authorizes, gates and sends one prepared transmission. Returns a stop summary or null. */
  async function sendPrepared({ transmission, kind, activation, recipientFingerprint }) {
    const followUp = kind !== 'initial';
    const capability = followUp ? 'fl04c-followup' : 'fl04b-initial';
    const writerPath = followUp ? 'pursue-cim-follow-up' : 'pursue-cim-initial';
    if (!(await liveSendingOn())) return stop('not_ready', 'live_sending_off');
    const { authorization, reason } = await issueAuthorization({ transmission, capability,
      writerPath, activation, recipientFingerprint });
    if (!authorization) {
      skip(reason);
      return reason === 'capability_inactive' ? stop('not_ready') : null;
    }
    const gate = await authorizePreparedCimTransmission({ storage,
      transmissionId: transmission.id, authorizationId: authorization.id, writerPath,
      providerProfile, actor, now: instant().toISOString(), loadMemberAuthority,
      readCurrentAuthority, readProviderReadiness, configOverride: resolvedConfig });
    if (!gate.authorized) {
      skip(gate.blockedReason || 'final_gate_refused');
      return RUN_STOPPING_GATE_REFUSALS.has(gate.blockedReason) ? stop('not_ready') : null;
    }
    let result;
    try {
      result = await finalizeAuthorizedCimTransmission({ storage, finalGateResult: gate,
        authorizationId: authorization.id, writerPath, providerProfile, actor,
        now: instant(), configOverride: resolvedConfig, mailProvider: provider,
        // The provider outcome is observed on the sender's own clock (its acceptance instant
        // schedules the next follow-up).
        testHooks: { providerOutcomeObservedAt: () => instant() } });
    } catch (error) {
      // The send may have reached Gmail; step 3 of a later run reconciles it through findSent.
      skip(errorCode(error, 'send_outcome_unrecorded'));
      return null;
    }
    const { category, providerResultCode } = result.outcome ?? {};
    if (category === 'accepted') {
      if (followUp) summary.sentFollowUps += 1;
      else summary.sentInitial += 1;
      return null;
    }
    if (category === 'definitive-failure') {
      summary.failed += 1;
      return null;
    }
    if (category === 'ambiguous') {
      summary.ambiguous += 1;
      return null;
    }
    if (category === 'unsent') {
      if (providerResultCode === 'provider_quota') {
        await markQuota(storage, instant(), actor);
        return stop('provider_quota', 'provider_quota');
      }
      return stop('not_ready', providerResultCode || 'provider_not_attempted');
    }
    skip('provider_pending');
    return null;
  }

  async function recoverLapsedPreparation(row) {
    const followUp = row.kind !== 'initial';
    const activation = followUp ? chain.followUp : chain.initial;
    if (!activation) return stop('not_ready', 'capability_inactive');
    if (!(await inWindow(row.touch_id))) {
      skip('outside_send_window');
      return null;
    }
    if (!(await liveSendingOn())) return stop('not_ready', 'live_sending_off');
    const claimTokenDigest = randomClaimDigest();
    const claimAt = instant();
    const claimExpiresAt = new Date(claimAt.getTime() + CLAIM_LEASE_MS).toISOString();
    const renewal = followUp
      ? await storage.renewReservedCimFollowUp({ transmissionId: row.transmission_id,
        touchId: row.touch_id, activationId: activation.id,
        recipientFingerprint: row.recipient_fingerprint, claimTokenDigest, claimOwner: actor,
        claimExpiresAt, expectedRowVersion: Number(row.row_version), actor })
      : await storage.renewLapsedCimInitialClaim({ touchId: row.touch_id,
        transmissionId: row.transmission_id, expectedRowVersion: Number(row.row_version),
        claimTokenDigest, claimOwner: actor, claimExpiresAt, actor,
        now: claimAt.toISOString() });
    if (!(renewal.renewed || renewal.existing) || !renewal.transmission) {
      skip(renewal.blockedReason || 'renewal_refused');
      return null;
    }
    return sendPrepared({ transmission: renewal.transmission, kind: row.kind, activation,
      recipientFingerprint: row.recipient_fingerprint });
  }

  async function sendDueInitial(candidate) {
    if (!chain.initial) return stop('not_ready', 'capability_inactive');
    if (!(await inWindow(candidate.touch_id))) {
      skip('outside_send_window');
      return null;
    }
    if (!(await liveSendingOn())) return stop('not_ready', 'live_sending_off');
    let prepared;
    try {
      prepared = await prepareDueCimInitialTouch({ storage, candidate, clock: instant,
        actor, loadAuthority: loadInitialAuthority, configOverride: resolvedConfig });
    } catch (error) {
      skip(errorCode(error, 'preparation_failed'));
      return null;
    }
    if (!prepared.transmission || prepared.transmission.state !== 'prepared') {
      skip(preparationSkip(prepared));
      return null;
    }
    return sendPrepared({ transmission: prepared.transmission, kind: 'initial',
      activation: chain.initial, recipientFingerprint: candidate.campaign_recipient_fingerprint });
  }

  async function sendDueFollowUp(candidate) {
    if (!chain.followUp || chain.followUp.id !== candidate.activation_id) {
      return stop('not_ready', 'capability_inactive');
    }
    if (!(await inWindow(candidate.touch_id))) {
      skip('outside_send_window');
      return null;
    }
    if (!(await liveSendingOn())) return stop('not_ready', 'live_sending_off');
    let prepared;
    try {
      prepared = await runCimFollowUpPreparation({ storage, candidate, clock: instant, actor,
        claimTokenDigest: randomClaimDigest(),
        loadAuthority: (input) => loadPursueFollowUpAuthority({ ...input, config: resolvedConfig,
          ...(loadMemberAuthority ? { loadMemberAuthority } : {}) }),
        buildPayload: (input) => buildFollowUpPayload({ ...input, config: resolvedConfig }) });
    } catch (error) {
      // A touch left claimed here is picked up again once its claim lapses (Ruling L).
      skip(errorCode(error, 'preparation_failed'));
      return null;
    }
    if (!(prepared.prepared || prepared.existing) || prepared.transmission?.state !== 'prepared') {
      skip(prepared.blockedReason || (prepared.capacityDeferred ? 'capacity_deferred'
        : 'preparation_refused'));
      return null;
    }
    return sendPrepared({ transmission: prepared.transmission, kind: candidate.kind,
      activation: chain.followUp, recipientFingerprint: candidate.recipient_fingerprint });
  }
}

function randomClaimDigest() {
  return createHash('sha256').update(randomBytes(32).toString('hex')).digest('hex');
}

function preparationSkip(prepared) {
  if (prepared.constructionFailed) return 'preparation_failed';
  if (prepared.staleAuthority) return 'authority_changed';
  if (prepared.terminal) return 'terminal_authority_changed';
  if (prepared.payloadConflict) return 'payload_conflict';
  if (prepared.claimed === false) return 'claim_refused';
  return 'preparation_refused';
}
