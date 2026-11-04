import { getCimProviderReconciliationConfig, getConfig } from '../config.js';
import { fetchWithTimeout } from '../utils/http.js';
import { createCimProviderBoundaryAuthorization } from './cimProviderBoundary.js';
import { cimRfcMessageId } from './cimMailProvider.js';
import { deriveAcceptedCimCadence } from './pursueCimCadence.js';
import { sendPreparedMessage } from './delivery.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { CIM_PROVIDER_RELEASE_CODES } from '../storage/gmailSendStorageContract.js';

// Reconciliation proof may come from the provider a transmission was sent through.
const reconciliationProviders = new Set(['resend', 'gmail']);
// A follow-up's In-Reply-To: the follow-up payload carries the initial's RFC Message-ID as
// this tag, so threading is part of the digest-bound durable payload.
export const PURSUE_CIM_IN_REPLY_TO_TAG = 'cim_in_reply_to';

const reconciliationEvidenceTypes = new Set([
  'persisted-provider-result',
  'provider-read',
  'signed-provider-event',
]);

function boundedProviderMessageId(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 240) {
    return '';
  }
  return /^[A-Za-z0-9_.:@-]+$/.test(value) ? value : '';
}

function boundedResultCode(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 ? normalized : fallback;
}

export function normalizeCimProviderOutcome(result = {}) {
  const reportedProvider = typeof result.provider === 'string' && result.provider.trim()
    ? result.provider.trim().slice(0, 80) : '';
  const provider = reportedProvider || 'unknown';
  const resultCode = boundedResultCode(result.errorCategory,
    result.status === 'sent' ? 'accepted' : 'provider-outcome-unknown');
  const attempted = result.providerAttempted === true && result.providerSeamEntered === true;
  if (!attempted) {
    return { category: 'pending', provider, providerMessageId: null,
      providerResultCode: resultCode };
  }

  const rawIds = [result.providerMessageId,
    ...(Array.isArray(result.providerMessageIds) ? result.providerMessageIds : [])]
    .filter((value) => value !== undefined && value !== null && value !== '');
  const identities = rawIds.map(boundedProviderMessageId);
  const coherentIdentity = identities.length > 0
    && identities.every(Boolean) && new Set(identities).size === 1 ? identities[0] : '';
  if (result.status === 'sent' && reportedProvider === 'resend' && coherentIdentity) {
    return { category: 'accepted', provider, providerMessageId: coherentIdentity,
      providerResultCode: 'accepted' };
  }
  if (reportedProvider === 'gmail') {
    if (result.status === 'sent' && coherentIdentity) {
      return { category: 'accepted', provider, providerMessageId: coherentIdentity,
        providerResultCode: 'accepted' };
    }
    // Quota, or nothing reached Gmail: never accepted, so the touch is released (Ruling D).
    if (result.status === 'failed' && result.providerUnsent === true && rawIds.length === 0
      && CIM_PROVIDER_RELEASE_CODES.includes(result.errorCategory)) {
      return { category: 'unsent', provider, providerMessageId: null,
        providerResultCode: result.errorCategory };
    }
    if (result.status === 'failed' && result.definitiveFailure === true
      && result.providerUnsent !== true && rawIds.length === 0) {
      return { category: 'definitive-failure', provider, providerMessageId: null,
        providerResultCode: boundedResultCode(result.errorCategory, 'gmail-nonacceptance') };
    }
  }
  if (reportedProvider === 'resend' && result.status === 'failed' && result.definitiveFailure === true
    && result.errorCategory === 'provider-nonacceptance' && rawIds.length === 0) {
    return { category: 'definitive-failure', provider, providerMessageId: null,
      providerResultCode: 'provider-nonacceptance' };
  }
  const identityResultCode = result.status === 'sent'
    ? rawIds.length > 1 && new Set(identities.filter(Boolean)).size > 1
      ? 'conflicting-provider-id' : 'missing-provider-id'
    : resultCode;
  return { category: 'ambiguous', provider, providerMessageId: null,
    providerResultCode: identityResultCode };
}

function denied() {
  return {
    status: 'failed',
    error: 'The durable CIM provider work could not be reconstructed.',
    errorCategory: 'cim-provider-work-mismatch',
    definitiveFailure: true,
    providerMessageId: '',
  };
}

function configuredCadenceSendTime(configOverride) {
  const configured = configOverride?.dealHunter?.cimAutomation?.sendWindowStart;
  return configured ?? getConfig().dealHunter?.cimAutomation?.sendWindowStart ?? '08:00';
}

async function acceptedCadence(storage, transmissionId, observedAt, configOverride) {
  if (typeof storage?.readCimCadenceContext !== 'function') {
    throw new Error('Durable CIM cadence context is unavailable');
  }
  const context = await storage.readCimCadenceContext({ transmissionId });
  return deriveAcceptedCimCadence(context, observedAt,
    { sendTime: configuredCadenceSendTime(configOverride) });
}

// This is the only new-transmission orchestration entry. It accepts the
// same-process P6A result, reconstructs the provider message from durable
// records, and delegates the actual enforcement and adapter call to the
// private delivery.sendMessage boundary.
function taggedValue(tags, name) {
  const prefix = `${name}=`;
  const match = (Array.isArray(tags) ? tags : [])
    .find((tag) => typeof tag === 'string' && tag.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

// A Gmail follow-up goes into the conversation's Gmail thread, replying to the initial's
// Message-ID. Both come from durable records; the send refuses a follow-up missing either.
function gmailThreading(durable, communication) {
  if (communication.kind !== 'cim-follow-up') return {};
  const inReplyTo = taggedValue(communication.tags, PURSUE_CIM_IN_REPLY_TO_TAG);
  return {
    gmailThreadId: typeof durable?.conversation?.gmail_thread_id === 'string'
      ? durable.conversation.gmail_thread_id : '',
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : [],
  };
}

/**
 * `mailProvider` (optional) is the CIM mail provider. It is used only when the selected profile
 * sends through Gmail (production-gmail-v1, or controlled-mailbox-v1 with provider gmail); the
 * Resend paths ignore it and are unchanged.
 */
export async function sendAuthorizedCimTransmission({
  storage,
  finalGateResult,
  authorizationId,
  writerPath,
  providerProfile,
  actor,
  now = new Date(),
  configOverride,
  fetcher,
  mailProvider,
  testHooks = {},
} = {}) {
  if (typeof storage?.readCimFinalGateContext !== 'function') return denied();
  const boundaryAuthorization = createCimProviderBoundaryAuthorization({
    finalGateResult, authorizationId, writerPath, providerProfile, actor,
  });
  let durable;
  try {
    durable = await storage.readCimFinalGateContext({
      transmissionId: boundaryAuthorization.transmissionId,
      authorizationId: boundaryAuthorization.authorizationId,
      writerPath: boundaryAuthorization.writerPath,
      providerProfile: boundaryAuthorization.providerProfile,
      now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    });
  } catch {
    return denied();
  }
  const transmission = durable?.transmission;
  const communication = durable?.communication;
  const outbox = durable?.outbox;
  if (!transmission || !communication || !outbox) return denied();
  const message = Object.freeze({
    kind: communication.kind,
    transmissionId: transmission.id,
    communicationId: communication.id,
    outboxId: outbox.id,
    idempotencyKey: transmission.provider_idempotency_key,
    from: communication.from_address,
    to: communication.to_addresses,
    cc: communication.cc_addresses,
    bcc: communication.bcc_addresses,
    replyTo: communication.reply_to_address,
    subject: communication.subject,
    text: communication.body_text,
    html: communication.body_html_sanitized,
    tags: communication.tags,
    ...(mailProvider ? gmailThreading(durable, communication) : {}),
  });
  return sendPreparedMessage(message, {
    storage,
    cimProviderAuthorization: boundaryAuthorization,
    now,
    configOverride,
    fetcher,
    testHooks,
    ...(mailProvider ? { cimMailProvider: mailProvider } : {}),
  });
}

// On acceptance through Gmail, the conversation remembers its Gmail thread for follow-ups and
// reply detection. A different thread already stored is never overwritten: the conflict is
// reported by code only, and the accepted touch stays finalized because the email went out.
async function storeGmailThread(storage, { conversationId, gmailThreadId, now }) {
  if (!conversationId || typeof gmailThreadId !== 'string' || !gmailThreadId
    || typeof storage?.setCimConversationGmailThread !== 'function') return null;
  try {
    const result = await storage.setCimConversationGmailThread({ conversationId, gmailThreadId,
      now: now instanceof Date ? now.toISOString() : new Date(now).toISOString() });
    if (result?.conflict) {
      console.warn('[pursue-cim] gmail_thread_conflict: the conversation keeps its stored Gmail thread');
    }
    return { applied: result?.applied === true, replay: result?.replay === true,
      conflict: result?.conflict === true };
  } catch {
    console.warn('[pursue-cim] gmail_thread_store_failed');
    return { applied: false, replay: false, conflict: false, failed: true };
  }
}

export async function finalizeAuthorizedCimTransmission({
  storage,
  finalGateResult,
  authorizationId,
  writerPath,
  providerProfile,
  actor,
  now = new Date(),
  configOverride,
  fetcher,
  mailProvider,
  sendAuthorized = sendAuthorizedCimTransmission,
  testHooks = {},
} = {}) {
  const providerResult = await sendAuthorized({ storage, finalGateResult, authorizationId,
    writerPath, providerProfile, actor, now, configOverride, fetcher, testHooks,
    ...(mailProvider ? { mailProvider } : {}) });
  await testHooks.afterProviderResult?.({ providerResult, finalGateResult });
  const outcome = normalizeCimProviderOutcome(providerResult);
  if (outcome.category === 'pending') {
    if (typeof storage?.readCimFinalGateContext === 'function') {
      try {
        const durable = await storage.readCimFinalGateContext({
          transmissionId: finalGateResult?.transmission?.id,
          authorizationId, writerPath, providerProfile,
          now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
        });
        const terminal = durable?.transmission;
        if (['accepted', 'definitive-failure', 'ambiguous'].includes(terminal?.state)) {
          let nextTouch = null;
          if (terminal.state === 'accepted'
            && typeof storage?.readCimCadenceContext === 'function') {
            try {
              nextTouch = (await storage.readCimCadenceContext({ transmissionId: terminal.id }))
                ?.nextTouch ?? null;
            } catch {
              nextTouch = null;
            }
          }
          return { providerResult, outcome: { category: terminal.state,
            provider: terminal.provider, providerMessageId: terminal.provider_message_id,
            providerResultCode: terminal.provider_result_code },
          durableResult: { applied: false, existing: true, conflict: false,
            transmission: terminal, nextTouch } };
        }
      } catch {
        // A read failure cannot authorize a retry or invent a terminal outcome.
      }
    }
    return { providerResult, outcome, durableResult: null };
  }
  const transmission = finalGateResult?.transmission;
  const expectedRowVersion = Number.isSafeInteger(providerResult.providerFinalizationRowVersion)
    ? providerResult.providerFinalizationRowVersion
    : Number.isSafeInteger(transmission?.row_version) ? transmission.row_version + 1 : null;
  if (outcome.category === 'unsent') {
    if (!transmission?.id || !Number.isSafeInteger(expectedRowVersion)
      || typeof storage?.releaseCimProviderPendingUnsent !== 'function') {
      throw new Error('The unsent provider result cannot be bound to a durable release.');
    }
    const durableResult = await storage.releaseCimProviderPendingUnsent({
      transmissionId: transmission.id,
      payloadDigest: transmission.payload_digest,
      expectedRowVersion,
      provider: outcome.provider,
      providerResultCode: outcome.providerResultCode,
      actor,
      now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    });
    return { providerResult, outcome, durableResult };
  }
  if (!transmission?.id || !Number.isSafeInteger(expectedRowVersion)
    || typeof storage?.finalizeCimTransmission !== 'function') {
    throw new Error('The provider result cannot be bound to durable CIM finalization.');
  }
  if (outcome.category === 'ambiguous' && outcome.provider === 'gmail'
    && typeof mailProvider?.findSent === 'function') {
    // Spec §5.7: an unsure Gmail send is searched for by its own Message-ID before anything
    // else. Found means accepted; not found (or a failed search) is recorded as ambiguous.
    const reconciled = await reconcileUnsureGmailSend({ storage, transmission, authorizationId,
      writerPath, providerProfile, actor, now, configOverride, mailProvider });
    if (reconciled) return { providerResult, ...reconciled };
  }
  const observedAt = new Date(providerResult.providerOutcomeObservedAt).toISOString();
  const command = {
    transmissionId: transmission.id,
    payloadDigest: transmission.payload_digest,
    expectedRowVersion,
    outcome: outcome.category,
    provider: outcome.provider,
    providerMessageId: outcome.providerMessageId,
    providerResultCode: outcome.providerResultCode,
    observedAt,
    actor,
    now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    cadence: outcome.category === 'accepted'
      ? await acceptedCadence(storage, transmission.id, observedAt, configOverride) : null,
  };
  await testHooks.beforeFinalization?.({ command, providerResult, outcome });
  const durableResult = await storage.finalizeCimTransmission(command);
  await testHooks.afterFinalization?.({ command, providerResult, outcome, durableResult });
  const gmailThread = outcome.category === 'accepted' && outcome.provider === 'gmail'
    && (durableResult?.applied || durableResult?.existing)
    ? await storeGmailThread(storage, { conversationId: transmission.conversation_id,
      gmailThreadId: providerResult.providerThreadId, now })
    : undefined;
  return { providerResult, outcome, durableResult, ...(gmailThread ? { gmailThread } : {}) };
}

async function reconcileUnsureGmailSend({ storage, transmission, authorizationId, writerPath,
  providerProfile, actor, now, configOverride, mailProvider }) {
  try {
    const durable = await storage.readCimFinalGateContext({ transmissionId: transmission.id,
      authorizationId, writerPath, providerProfile,
      now: now instanceof Date ? now.toISOString() : new Date(now).toISOString() });
    const current = durable?.transmission;
    if (current?.state !== 'provider-pending') return null;
    const reconciled = await reconcileCimProviderTransmission({ storage, transmission: current,
      readProviderEvidence: createCimGmailReconciliationLookup({ mailProvider,
        clock: () => new Date(now) }),
      providerProfile, actor, now, configOverride });
    if (!reconciled.resolved || reconciled.outcome !== 'accepted') return null;
    return {
      outcome: { category: 'accepted', provider: 'gmail',
        providerMessageId: reconciled.durableResult?.transmission?.provider_message_id ?? null,
        providerResultCode: 'reconciled-accepted' },
      durableResult: reconciled.durableResult,
      reconciled: true,
      ...(reconciled.gmailThread ? { gmailThread: reconciled.gmailThread } : {}),
    };
  } catch {
    return null;
  }
}

function requiredEvidenceText(value, name, maximum) {
  if (typeof value !== 'string' || value.trim() !== value
    || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must be bounded, non-empty, and unpadded`);
  }
  return value;
}

function normalizeReconciliationEvidence(evidence = {}) {
  const type = requiredEvidenceText(evidence.type, 'evidence.type', 120);
  if (!reconciliationEvidenceTypes.has(type)) {
    throw new Error('Unsupported CIM provider reconciliation evidence type');
  }
  const id = requiredEvidenceText(evidence.id, 'evidence.id', 240);
  const digest = requiredEvidenceText(evidence.digest, 'evidence.digest', 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid reconciliation evidence digest');
  const observedAt = new Date(evidence.observedAt).toISOString();
  return { type, id, digest, observedAt };
}

function normalizedAddresses(value, name) {
  let candidate = value;
  if (typeof value === 'string') {
    try { candidate = JSON.parse(value); } catch { candidate = null; }
  }
  if (!Array.isArray(candidate) || candidate.length > 20
    || candidate.some((item) => typeof item !== 'string' || item.trim() !== item
      || item.length < 1 || item.length > 320)) {
    throw new Error(`Invalid immutable transmission ${name}`);
  }
  return [...candidate];
}

function immutableTransmissionBinding(transmission, providerProfile = '') {
  const binding = {
    transmissionId: requiredEvidenceText(transmission?.id, 'transmission.id', 240),
    payloadDigest: requiredEvidenceText(transmission?.payload_digest,
      'transmission.payload_digest', 64),
    providerIdempotencyKey: requiredEvidenceText(transmission?.provider_idempotency_key,
      'transmission.provider_idempotency_key', 256),
    fromAddress: requiredEvidenceText(transmission?.from_address, 'transmission.from_address', 320),
    toAddresses: normalizedAddresses(transmission?.to_addresses, 'to_addresses'),
    ccAddresses: normalizedAddresses(transmission?.cc_addresses ?? [], 'cc_addresses'),
    bccAddresses: normalizedAddresses(transmission?.bcc_addresses ?? [], 'bcc_addresses'),
    replyToAddress: requiredEvidenceText(transmission?.reply_to_address,
      'transmission.reply_to_address', 320),
    subject: requiredEvidenceText(transmission?.subject, 'transmission.subject', 998),
  };
  return providerProfile
    ? { ...binding, providerProfile: requiredEvidenceText(providerProfile, 'providerProfile', 120) }
    : binding;
}

function normalizeProviderProof(proof, expectedBinding, providerProfile = '') {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  const evidence = normalizeReconciliationEvidence({ type: proof.type, id: proof.id,
    digest: '0'.repeat(64), observedAt: proof.observedAt });
  if (!reconciliationProviders.has(proof.provider)) {
    throw new Error('Reconciliation proof must come from Resend or Gmail');
  }
  if (providerProfile && proof.providerProfile !== providerProfile) {
    throw new Error('Reconciliation proof does not match the provider profile');
  }
  if (!['accepted', 'definitive-failure', 'unresolved', 'ambiguous'].includes(proof.outcome)) {
    throw new Error('Invalid reconciliation proof outcome');
  }
  const suppliedBinding = proof.binding;
  if (!suppliedBinding || stableCanonicalJson(suppliedBinding) !== stableCanonicalJson(expectedBinding)) {
    throw new Error('Reconciliation proof does not match the immutable transmission');
  }
  const candidates = normalizeProviderCandidates(proof.candidates ?? [], proof.provider);
  const canonical = { version: 'cim-provider-reconciliation-evidence-v1',
    type: evidence.type, id: evidence.id, provider: proof.provider, outcome: proof.outcome,
    ...(providerProfile ? { providerProfile } : {}),
    observedAt: evidence.observedAt, binding: expectedBinding, candidates };
  return { ...canonical, digest: sha256(stableCanonicalJson(canonical)) };
}

function canonicalProviderAddresses(value) {
  const values = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim().toLowerCase()).sort();
}

// Resend's sent-email list is a read-only reconciliation authority. The helper
// deliberately performs one bounded read and matches every envelope field the
// list endpoint exposes; absence is never treated as rejection.
export function createCimResendReconciliationLookup({ listSentEmails, clock = () => new Date(),
  configOverride, fetcher } = {}) {
  let reader = listSentEmails;
  const authority = configOverride ? getCimProviderReconciliationConfig(configOverride) : null;
  if (typeof reader !== 'function' && configOverride) {
    reader = async ({ limit }) => {
      if (!authority.apiKey || authority.provider !== 'resend') {
        throw new Error('CIM reconciliation profile is not configured');
      }
      const url = `https://api.resend.com/emails?limit=${limit}`;
      const options = { method: 'GET', headers: { Authorization: `Bearer ${authority.apiKey}`,
        Accept: 'application/json' } };
      const response = typeof fetcher === 'function'
        ? await fetcher(url, options)
        : await fetchWithTimeout(url, { ...options,
          timeoutMs: configOverride.server?.outboundRequestTimeoutMs || 10_000,
          timeoutMessage: 'Resend reconciliation read timed out.' });
      if (!response.ok) throw new Error(`Resend reconciliation read failed with ${response.status}`);
      return response.json();
    };
  }
  if (typeof reader !== 'function') {
    throw new Error('A read-only Resend sent-email reader is required');
  }
  return async ({ transmission, binding, providerProfile = '' } = {}) => {
    if (authority?.providerProfile && providerProfile !== authority.providerProfile) {
      throw new Error('Reconciliation request does not match the configured provider profile');
    }
    const expected = immutableTransmissionBinding(transmission, providerProfile);
    if (stableCanonicalJson(binding) !== stableCanonicalJson(expected)) {
      throw new Error('Resend lookup does not match the immutable transmission');
    }
    const observedAt = new Date(clock()).toISOString();
    const seamAt = Date.parse(transmission.provider_seam_entered_at ?? '');
    if (!Number.isFinite(seamAt)) throw new Error('Durable provider seam time is required');
    const response = await reader({ limit: 100 });
    const rows = Array.isArray(response?.data) ? response.data : [];
    if (rows.length > 100) throw new Error('Resend reconciliation read exceeded its bound');
    const matches = rows.filter((row) => {
      const createdAt = Date.parse(row?.created_at ?? '');
      return boundedProviderMessageId(row?.id)
        && Number.isFinite(createdAt) && createdAt >= seamAt - 5 * 60_000
        && createdAt <= Date.parse(observedAt) + 60_000
        && String(row.from ?? '').trim().toLowerCase() === expected.fromAddress.toLowerCase()
        && stableCanonicalJson(canonicalProviderAddresses(row.to))
          === stableCanonicalJson(canonicalProviderAddresses(expected.toAddresses))
        && stableCanonicalJson(canonicalProviderAddresses(row.cc))
          === stableCanonicalJson(canonicalProviderAddresses(expected.ccAddresses))
        && stableCanonicalJson(canonicalProviderAddresses(row.bcc))
          === stableCanonicalJson(canonicalProviderAddresses(expected.bccAddresses))
        && String(row.reply_to ?? '').trim().toLowerCase() === expected.replyToAddress.toLowerCase()
        && row.subject === expected.subject;
    });
    const candidates = matches.map((row) => ({ provider: 'resend',
      providerMessageId: row.id, evidenceId: `resend-email:${row.id}` }));
    return { type: 'provider-read',
      id: `resend-list:${sha256(stableCanonicalJson({ observedAt, candidates }))}`,
      provider: 'resend', ...(providerProfile ? { providerProfile } : {}),
      outcome: new Set(candidates.map((item) => item.providerMessageId)).size > 1
        ? 'ambiguous' : candidates.length === 1 ? 'accepted' : 'unresolved',
      observedAt, binding: expected, candidates };
  };
}

function normalizeProviderCandidates(candidates, provider = 'resend') {
  if (!Array.isArray(candidates) || candidates.length > 20) {
    throw new Error('Provider reconciliation candidates must be a bounded array');
  }
  return candidates.map((candidate, index) => {
    if (candidate?.provider !== provider) {
      throw new Error('Provider reconciliation candidates must come from the proof provider');
    }
    const providerMessageId = boundedProviderMessageId(candidate.providerMessageId);
    if (!providerMessageId) throw new Error('Invalid reconciliation provider identity');
    const evidenceId = requiredEvidenceText(candidate.evidenceId ?? `candidate-${index + 1}`,
      'candidate.evidenceId', 240);
    return {
      provider,
      providerMessageId,
      evidenceId,
      evidenceDigest: sha256(stableCanonicalJson({ provider, providerMessageId,
        evidenceId })),
    };
  });
}

/**
 * The Gmail reconciliation reader for reconcileCimProviderTransmission (spec §5.7): searches
 * the owner's mailbox for our own `<{transmissionId}@{sender domain}>` Message-ID through
 * `mailProvider.findSent`. Found is acceptance; not found is unresolved, never rejection. A
 * failed search throws, so nothing is inferred from it.
 */
export function createCimGmailReconciliationLookup({ mailProvider, clock = () => new Date() } = {}) {
  if (typeof mailProvider?.findSent !== 'function') {
    throw new Error('A Gmail mail provider with findSent is required');
  }
  return async ({ transmission, binding, providerProfile = '' } = {}) => {
    const expected = immutableTransmissionBinding(transmission, providerProfile);
    if (stableCanonicalJson(binding) !== stableCanonicalJson(expected)) {
      throw new Error('Gmail lookup does not match the immutable transmission');
    }
    const rfcMessageId = cimRfcMessageId(transmission.id, expected.fromAddress);
    if (!rfcMessageId) throw new Error('Gmail lookup has no valid Message-ID');
    const observedAt = new Date(clock()).toISOString();
    const found = await mailProvider.findSent({ rfcMessageId });
    const candidates = found?.found === true && boundedProviderMessageId(found.messageId)
      ? [{ provider: 'gmail', providerMessageId: found.messageId,
        evidenceId: `gmail-message:${found.messageId}`,
        threadId: typeof found.threadId === 'string' ? found.threadId : null }]
      : [];
    return { type: 'provider-read',
      id: `gmail-rfc822msgid:${sha256(stableCanonicalJson({ observedAt, rfcMessageId,
        candidates: candidates.map(({ providerMessageId }) => providerMessageId) }))}`,
      provider: 'gmail', ...(providerProfile ? { providerProfile } : {}),
      outcome: candidates.length === 1 ? 'accepted' : 'unresolved',
      observedAt, binding: expected, candidates,
      gmailThreadId: candidates[0]?.threadId ?? null };
  };
}

// Reconciliation is deliberately read-only at the provider boundary. It can
// inspect bounded provider evidence and update the same immutable transmission,
// but it has no path to send or reconstruct invocation authority.
export async function reconcileCimProviderTransmission({
  storage,
  transmission,
  readProviderEvidence = async () => null,
  providerProfile = '',
  actor,
  now = new Date(),
  configOverride,
} = {}) {
  if (!transmission?.id || !/^[0-9a-f]{64}$/.test(transmission.payload_digest ?? '')
    || !Number.isSafeInteger(transmission.row_version)
    || !['provider-pending', 'ambiguous', 'accepted', 'definitive-failure']
      .includes(transmission.state)
    || transmission.invocation_authority_count !== 1
    || typeof storage?.reconcileCimTransmission !== 'function') {
    throw new Error('Exact durable CIM transmission context is required for reconciliation');
  }
  const binding = immutableTransmissionBinding(transmission, providerProfile);
  const proof = await readProviderEvidence({
    transmission: Object.freeze({ ...transmission }), binding: Object.freeze({ ...binding }),
    providerProfile,
  });
  const exactEvidence = normalizeProviderProof(proof, binding, providerProfile);
  if (!exactEvidence) {
    return { resolved: false, reconciliationOnly: true, providerCalls: 0,
      outcome: transmission.state, durableResult: null };
  }
  const candidates = exactEvidence.candidates;
  const distinctIds = [...new Set(candidates.map(({ providerMessageId }) => providerMessageId))];
  let outcome;
  let providerMessageId = null;
  let providerResultCode;
  if (distinctIds.length > 1 || exactEvidence.outcome === 'ambiguous') {
    outcome = 'ambiguous';
    providerResultCode = 'multiple-provider-identities';
  } else if (distinctIds.length === 1 && exactEvidence.outcome === 'accepted') {
    outcome = 'accepted';
    [providerMessageId] = distinctIds;
    providerResultCode = 'reconciled-accepted';
  } else if (distinctIds.length === 0 && exactEvidence.outcome === 'definitive-failure') {
    outcome = 'definitive-failure';
    providerResultCode = 'reconciled-provider-nonacceptance';
  } else {
    return { resolved: false, reconciliationOnly: true, providerCalls: 0,
      outcome: transmission.state, durableResult: null };
  }
  const durableResult = await storage.reconcileCimTransmission({
    transmissionId: transmission.id,
    payloadDigest: transmission.payload_digest,
    expectedRowVersion: transmission.row_version,
    outcome,
    provider: exactEvidence.provider,
    providerMessageId,
    providerResultCode,
    evidenceType: exactEvidence.type,
    evidenceId: exactEvidence.id,
    evidenceDigest: exactEvidence.digest,
    observedAt: exactEvidence.observedAt,
    providerIdentities: distinctIds.length > 1 ? candidates : [],
    actor,
    now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    cadence: outcome === 'accepted'
      ? await acceptedCadence(storage, transmission.id, exactEvidence.observedAt,
        configOverride) : null,
  });
  const gmailThread = outcome === 'accepted' && exactEvidence.provider === 'gmail'
    && (durableResult?.applied || durableResult?.unchanged)
    ? await storeGmailThread(storage, { conversationId: transmission.conversation_id,
      gmailThreadId: proof?.gmailThreadId, now })
    : undefined;
  return { resolved: outcome !== 'ambiguous' && !durableResult.conflict,
    reconciliationOnly: outcome === 'ambiguous', providerCalls: 0,
    outcome, durableResult, ...(gmailThread ? { gmailThread } : {}) };
}
