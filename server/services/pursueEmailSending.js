// The Operations "Email sending" card (spec 2026-11-03 §9): one status read and one audited
// control write behind GET/POST /api/admin/deal-hunter/email-sending.
//
// The status never carries token material: the Gmail part is projected from four connection
// fields, and Job history rows are reduced to their status, instants, counts and codes.
import { PRODUCTION_GMAIL_CIM_PROVIDER_PROFILE, cimProviderUsesGmail } from '../config.js';
import { createGmailCimProvider } from './gmailCimProvider.js';
import { CONTACT_POLICY_VERSION, contactPolicyDigest } from './pursueCimContactPolicy.js';
import { readPursueCimProviderReadiness } from './pursueCimReadiness.js';
import {
  pursueSignatureView,
  readPursueEmailSignature,
  refreshPursueEmailSignature,
  usablePursueSignature,
} from './pursueEmailSignature.js';
import { PURSUE_CIM_REPLY_POLLER_JOB_NAME, readPursueReplyPollerHold } from './pursueCimReplyPoller.js';
import { PURSUE_CIM_SENDER_JOB_NAME } from './pursueCimSenderScheduler.js';
import {
  pursueCimWordingDigest,
  pursueSignatureComplete,
  renderPursueCimWordingPreview,
} from './pursueCimTemplates.js';
import {
  PURSUE_GMAIL_CAPABILITY_POLICY,
  pursueGmailCapabilitiesInSync,
  syncPursueGmailCapabilities,
} from './pursueGmailCapabilities.js';

export const EMAIL_SENDING_CONTROL_KEYS = Object.freeze(['live_sending', 'contact_rule', 'wording_approval']);

const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const SENDER_COUNTS = ['sentInitial', 'sentFollowUps', 'expired', 'reconciled', 'released', 'failed', 'ambiguous'];
const POLLER_COUNTS = ['processed', 'responded', 'ownerReplied', 'bounced', 'autoReplies', 'stopped', 'pending',
  'failed'];

function codeOrNull(value) {
  return typeof value === 'string' && CODE.test(value) ? value : null;
}

function instantOrNull(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The provider profile Live sending applies to: the configured CIM profile when it sends
 * through Gmail (production-gmail-v1, or controlled-mailbox-v1 with the gmail mailbox provider
 * for the owner's controlled test, Ruling S), else production-gmail-v1.
 */
export function activeGmailProviderProfile(config) {
  const profile = config?.dealHunter?.cimProvider;
  return cimProviderUsesGmail(config) && profile?.profile ? profile.profile
    : PRODUCTION_GMAIL_CIM_PROVIDER_PROFILE;
}

/** True when the server is configured to send Pursue email through Gmail at all. */
function gmailSendingConfigured(config) {
  return cimProviderUsesGmail(config) && config?.dealHunter?.cimProvider?.enabled === true;
}

async function capabilitiesInSync({ storage, enabled, providerProfile, now }) {
  try {
    return await pursueGmailCapabilitiesInSync({ storage, enabled, providerProfile, now });
  } catch {
    return false;
  }
}

function controlView(control = {}) {
  return {
    enabled: control.enabled === true,
    policyVersion: control.policyVersion ?? null,
    changedAt: control.changedAt ?? null,
    changedBy: control.changedBy ?? null,
    revision: Number(control.revision) || 0,
  };
}

/** A Job history row reduced to what the card shows: never keys, claim tokens or free text. */
function projectRun(row, countNames) {
  if (!row) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata : {};
  const counts = Object.fromEntries(countNames.map((name) => [name,
    Math.max(0, Math.trunc(Number(metadata[name]) || 0))]));
  const notReadyReasons = Array.isArray(metadata.notReadyReasons)
    ? metadata.notReadyReasons.map(codeOrNull).filter(Boolean) : [];
  return {
    status: codeOrNull(String(row.status ?? '').replace(/-/g, '_')) ?? 'unknown',
    updatedAt: instantOrNull(row.updated_at),
    completedAt: instantOrNull(row.completed_at),
    counts,
    stoppedFor: codeOrNull(metadata.stoppedFor),
    notReadyReasons,
    error: codeOrNull(row.last_error) ?? codeOrNull(metadata.error),
  };
}

/** The durable CIM outreach pause, read as the final gate reads it: no setting is paused. */
// The pause Gmail sending obeys: the control saved in Operations. DEAL_HUNTER_CIM_OUTREACH_PAUSED in
// fly.toml keeps the older send paths shut and isn't consulted here. Missing or unreadable reads as
// paused, matching the final check in pursueCimSqliteTransitions.js.
export async function readCentralPause(storage) {
  try {
    const settings = await storage.getDealHunterCimSafetySettings?.();
    if (!settings) return { paused: true, source: 'settings-unavailable', updatedAt: '' };
    const paused = Boolean(settings.outreach_paused);
    return { paused, source: paused ? 'operations-control' : '', updatedAt: settings.updated_at || '' };
  } catch {
    return { paused: true, source: 'settings-unavailable', updatedAt: '' };
  }
}

async function centralPauseOn(storage) {
  return (await readCentralPause(storage)).paused;
}

async function latestRun(storage, jobName, countNames) {
  if (typeof storage?.listScheduledJobs !== 'function') return null;
  const [row] = await storage.listScheduledJobs({ limit: 1, jobName });
  return projectRun(row && row.job_name === jobName ? row : null, countNames);
}

function senderNameSet(config) {
  return String(config?.dealHunter?.sender?.name ?? '').trim() !== '';
}

/**
 * The owner-facing sentence for signature_incomplete: what is missing, in plain words.
 * `view` is the card's signature view.
 */
export function signatureIncompleteSentence(view, config) {
  const nameMissing = !senderNameSet(config);
  if (view?.loaded && !view.empty) {
    return 'Your name for the From line (DEAL_HUNTER_SENDER_NAME) is missing from settings.';
  }
  const signature = view?.loaded
    ? 'Your Gmail signature is empty. Add one in Gmail, then refresh it from Gmail.'
    : "Your Gmail signature hasn't been loaded yet. Refresh it from Gmail.";
  return nameMissing
    ? `${signature} Your name for the From line (DEAL_HUNTER_SENDER_NAME) is also missing from settings.`
    : signature;
}

/**
 * Reads the card's status. `includePreview` adds the rendered wording (administrators only).
 * Readiness may refresh the Gmail token through `fetcher` when the last check is stale.
 */
export async function getEmailSendingStatus({ storage, config, now = new Date(), fetcher, includePreview = false }) {
  const sender = config?.dealHunter?.sender ?? {};
  const signatureSnapshot = await readPursueEmailSignature(storage);
  const signature = usablePursueSignature(signatureSnapshot, config);
  const signatureView = pursueSignatureView(signatureSnapshot, config);
  const [connection, controls] = await Promise.all([storage.getGmailConnection(), storage.getPursueSendControls()]);
  const providerProfile = activeGmailProviderProfile(config);
  const readiness = await readPursueCimProviderReadiness({
    storage,
    config,
    now,
    providerProfile,
    mailProvider: createGmailCimProvider({ storage, config, now, ...(fetcher ? { fetcher } : {}) }),
  });
  // Readiness may have just refreshed the token; show the connection as it is now.
  const gmailRow = connection ? (await storage.getGmailConnection()) ?? connection : null;
  const wordingApproval = controls.wordingApproval ?? {};
  const approved = wordingApproval.enabled === true;
  const liveSending = controlView(controls.liveSending);
  const inSync = await capabilitiesInSync({ storage, enabled: liveSending.enabled, providerProfile,
    now: new Date(now).toISOString() });
  // The card's readiness adds what the sender would also stop on: Gmail sending not configured
  // on the server, or a Live sending control whose capability chain was not applied. "Ready to
  // send." also needs the sender switched on, reply checking switched on and run recently (or
  // follow-ups are held), and no central CIM outreach pause (Ruling U).
  const reasons = [...readiness.reasons];
  if (!gmailSendingConfigured(config)) reasons.push('provider_not_gmail');
  if (!inSync) reasons.push('live_sending_not_applied');
  if (config?.dealHunter?.pursueSender?.enabled !== true) reasons.push('sender_off');
  const replyHold = await readPursueReplyPollerHold({ storage, config, now });
  if (replyHold) reasons.push(replyHold);
  if (await centralPauseOn(storage)) reasons.push('central_pause');
  const [senderRun, replyPoller] = await Promise.all([
    latestRun(storage, PURSUE_CIM_SENDER_JOB_NAME, SENDER_COUNTS),
    latestRun(storage, PURSUE_CIM_REPLY_POLLER_JOB_NAME, POLLER_COUNTS),
  ]);
  return {
    gmail: {
      connected: Boolean(gmailRow),
      emailAddress: gmailRow?.email_address ?? null,
      lastTokenOkAt: gmailRow?.last_token_ok_at ?? null,
      lastErrorCode: codeOrNull(gmailRow?.last_error_code),
    },
    wording: {
      approvedDigest: approved ? wordingApproval.valueDigest ?? null : null,
      currentDigest: pursueCimWordingDigest(sender, signature),
      approvedAt: approved ? wordingApproval.changedAt ?? null : null,
      approvedBy: approved ? wordingApproval.changedBy ?? null : null,
      revision: Number(wordingApproval.revision) || 0,
      signatureComplete: pursueSignatureComplete(sender, signature),
      ...(includePreview ? { preview: renderPursueCimWordingPreview(signature) } : {}),
    },
    signature: { ...signatureView, senderNameSet: senderNameSet(config) },
    contactRule: controlView(controls.contactRule),
    liveSending: { ...liveSending, providerProfile, capabilitiesInSync: inSync },
    readiness: { ready: readiness.ready === true && reasons.length === 0, reasons },
    lastRuns: { sender: senderRun, replyPoller },
  };
}

function refusal(status, code, error) {
  return { ok: false, status, code, error };
}

/** Validates a control change request body. Returns the command or a 400 refusal. */
export function parseEmailSendingControlRequest(body) {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!EMAIL_SENDING_CONTROL_KEYS.includes(value.controlKey)) {
    return refusal(400, 'invalid_control', 'Choose live_sending, contact_rule or wording_approval.');
  }
  if (typeof value.enabled !== 'boolean') return refusal(400, 'invalid_control', 'enabled must be true or false.');
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    return refusal(400, 'invalid_control', 'expectedRevision must be the revision you loaded.');
  }
  const reason = value.reason ?? '';
  if (typeof reason !== 'string' || reason.length > 500) {
    return refusal(400, 'invalid_control', 'reason must be text of at most 500 characters.');
  }
  // Optional: the wording digest the card showed. Approving refuses when it is no longer the
  // current one (the Gmail signature was refreshed since the card loaded).
  const expectedWordingDigest = value.expectedWordingDigest ?? null;
  if (expectedWordingDigest !== null
    && (typeof expectedWordingDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedWordingDigest))) {
    return refusal(400, 'invalid_control', 'expectedWordingDigest must be the wording version you loaded.');
  }
  return { ok: true, controlKey: value.controlKey, enabled: value.enabled,
    expectedRevision: value.expectedRevision, reason: reason.trim(), expectedWordingDigest };
}

/**
 * Applies one owner control change. The wording digest is always the server's current digest
 * (any client value is ignored). Live sending syncs the Gmail capability chain after the write
 * (on: record it; off: withdraw it and release prepared sends). A failed sync leaves the
 * control written and returns `live_sending_sync_failed`. Both outcomes are safe (a partial
 * chain stops the sender with capability_inactive; off is gated by readiness), and the sync is
 * idempotent, so repeating the same change at the new revision ("Try again") repairs it.
 */
export async function changeEmailSendingControl({ storage, config, command, actor, now = new Date() }) {
  const at = new Date(now).toISOString();
  const sender = config?.dealHunter?.sender ?? {};
  const write = { controlKey: command.controlKey, enabled: command.enabled,
    expectedRevision: command.expectedRevision, actor, reason: command.reason, now: at,
    valueDigest: null, policyVersion: null };
  if (command.controlKey === 'wording_approval' && command.enabled) {
    // The approved digest binds the signature stored now: the one the card's preview showed.
    const snapshot = await readPursueEmailSignature(storage);
    const signature = usablePursueSignature(snapshot, config);
    if (!pursueSignatureComplete(sender, signature)) {
      return refusal(409, 'signature_incomplete',
        signatureIncompleteSentence(pursueSignatureView(snapshot, config), config));
    }
    write.valueDigest = pursueCimWordingDigest(sender, signature);
    if (command.expectedWordingDigest && command.expectedWordingDigest !== write.valueDigest) {
      return refusal(409, 'wording_changed',
        'The wording or your Gmail signature changed since the card loaded. Review the preview and approve again.');
    }
  }
  if (command.controlKey === 'contact_rule') {
    write.policyVersion = CONTACT_POLICY_VERSION;
    write.valueDigest = contactPolicyDigest();
  }
  if (command.controlKey === 'live_sending') write.policyVersion = PURSUE_GMAIL_CAPABILITY_POLICY;

  let control;
  try {
    control = await storage.setPursueSendControl(write);
  } catch (error) {
    if (error?.code === 'send_control_conflict') {
      return refusal(409, 'send_control_conflict',
        'This setting changed since the card loaded. Review the latest state and try again.');
    }
    throw error;
  }
  if (command.controlKey === 'live_sending') {
    const providerProfile = activeGmailProviderProfile(config);
    // On records the chain under the active Gmail profile. Off withdraws it there and under
    // production-gmail-v1 (the release of prepared sends runs on every off, Ruling T).
    const profiles = command.enabled ? [providerProfile]
      : [...new Set([providerProfile, PRODUCTION_GMAIL_CIM_PROVIDER_PROFILE])];
    try {
      for (const profile of profiles) {
        await syncPursueGmailCapabilities({ storage, enabled: command.enabled, actor, now: at,
          providerProfile: profile });
      }
    } catch {
      return { ...refusal(500, 'live_sending_sync_failed', command.enabled
        ? 'Live sending was saved as on, but its sending permissions were not fully recorded, so nothing will send yet. Use Try again to finish.'
        : 'Live sending is off, so nothing will send. Some sending permissions were not withdrawn yet. Use Try again to finish.'),
      control: { ...controlView(control), providerProfile, capabilitiesInSync: false } };
    }
    return { ok: true, status: 200, control: { ...controlView(control), providerProfile,
      capabilitiesInSync: await capabilitiesInSync({ storage, enabled: command.enabled,
        providerProfile, now: at }) } };
  }
  return { ok: true, status: 200, control: controlView(control) };
}

/**
 * The owner's "Refresh from Gmail": reads the signature from Gmail and stores the snapshot (a
 * failure keeps the stored one and records its code), then returns the card's status.
 */
export async function refreshEmailSendingSignature({ storage, config, now = new Date(), fetcher,
  includePreview = false, logger }) {
  const refresh = await refreshPursueEmailSignature({ storage, config, now, source: 'owner',
    ...(fetcher ? { fetcher } : {}), ...(logger ? { logger } : {}) });
  const emailSending = await getEmailSendingStatus({ storage, config, now, includePreview,
    ...(fetcher ? { fetcher } : {}) });
  return { ok: refresh.ok, code: refresh.code ?? null, emailSending };
}
