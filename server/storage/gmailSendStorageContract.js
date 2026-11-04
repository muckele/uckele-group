// Input validation and row shapes shared by the SQLite and Supabase adapters for the
// Gmail connection, the Pursue send controls and the conversation Gmail thread.
// Validation messages name the field only, never its value, so a refresh token can
// never reach an error message.

export const PURSUE_SEND_CONTROL_KEYS = Object.freeze({
  live_sending: 'liveSending',
  contact_rule: 'contactRule',
  wording_approval: 'wordingApproval',
});

// Codes a provider-pending transmission may be released under (Ruling D): Gmail refused it
// before acceptance (quota) or nothing reached Gmail (a not-attempted outcome, Ruling E).
export const CIM_PROVIDER_RELEASE_CODES = Object.freeze(['provider_quota', 'gmail_token_invalid',
  'gmail_token_refresh_failed', 'gmail_not_connected', 'gmail_access_denied',
  'provider_seam_not_entered']);
// Ruling M: a provider-pending transmission whose provider seam was never entered cannot have
// reached the provider (the seam is durable before any provider call). It is released under
// this code once its authorization was consumed at least this long ago.
export const CIM_PROVIDER_SEAM_NOT_ENTERED = 'provider_seam_not_entered';
export const CIM_PROVIDER_SEAM_NOT_ENTERED_GRACE_MS = 10 * 60 * 1000;
// The membership cancellation reason a release records; it is the only cancelled membership
// that does not block the touch from being claimed again.
export const CIM_PROVIDER_RELEASE_CANCELLATION = 'provider-unsent-release';

export const SEND_CONTROL_AUDIT_EVENT = 'send-control-changed';
export const SEND_CONTROL_AUDIT_SOURCE = 'pursue-send-controls';

// The Task 2 token format: v1.<iv b64>.<tag b64>.<ciphertext b64>.
const ciphertextPattern = /^v1\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+\.[A-Za-z0-9+/_=-]+$/;
const checkpointPattern = /^[0-9]{1,30}$/;
const errorCodePattern = /^[a-z0-9_]{1,80}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const threadIdPattern = /^[A-Za-z0-9_-]{1,240}$/;

function invalid(name) {
  return new Error(`Invalid ${name}`);
}

function text(value, name, maximum, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
    || value.trim() !== value) throw invalid(name);
  return value;
}

function instant(value, name = 'now') {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid(name);
  return new Date(value).toISOString();
}

function checkpoint(value, name = 'historyCheckpoint') {
  if (value === null || value === undefined) return null;
  const normalized = Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof normalized !== 'string' || !checkpointPattern.test(normalized)) throw invalid(name);
  return normalized;
}

function optionalInstant(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

export function sendControlConflictError() {
  const error = new Error('send_control_conflict');
  error.code = 'send_control_conflict';
  return error;
}

export function validateSaveGmailConnection(command = {}) {
  const { grantedScopes } = command;
  if (!Array.isArray(grantedScopes) || grantedScopes.length > 20
    || grantedScopes.some((scope) => typeof scope !== 'string' || scope.length < 1
      || scope.length > 200 || /\s/.test(scope))) throw invalid('grantedScopes');
  const refreshTokenCiphertext = command.refreshTokenCiphertext;
  if (typeof refreshTokenCiphertext !== 'string' || refreshTokenCiphertext.length > 8192
    || !ciphertextPattern.test(refreshTokenCiphertext)) throw invalid('refreshTokenCiphertext');
  return {
    emailAddress: text(command.emailAddress, 'emailAddress', 320, 3),
    refreshTokenCiphertext,
    grantedScopes: [...grantedScopes],
    historyCheckpoint: checkpoint(command.historyCheckpoint),
    connectedBy: text(command.connectedBy, 'connectedBy', 200),
    now: instant(command.now),
  };
}

export function validateRevokeGmailConnection(command = {}) {
  return { revokedBy: text(command.revokedBy, 'revokedBy', 200), now: instant(command.now) };
}

export function validateGmailTokenCheck(command = {}) {
  if (typeof command.ok !== 'boolean') throw invalid('ok');
  if (command.ok) return { ok: true, errorCode: null, now: instant(command.now) };
  if (typeof command.errorCode !== 'string' || !errorCodePattern.test(command.errorCode)) {
    throw invalid('errorCode');
  }
  return { ok: false, errorCode: command.errorCode, now: instant(command.now) };
}

export function validateGmailCheckpointUpdate(command = {}) {
  const next = checkpoint(command.next);
  if (next === null) throw invalid('historyCheckpoint');
  return { expected: checkpoint(command.expected), next, now: instant(command.now) };
}

export function validateSetPursueSendControl(command = {}) {
  const controlKey = command.controlKey;
  if (!Object.hasOwn(PURSUE_SEND_CONTROL_KEYS, controlKey)) throw invalid('controlKey');
  if (typeof command.enabled !== 'boolean') throw invalid('enabled');
  const valueDigest = command.valueDigest ?? null;
  if (valueDigest !== null && (typeof valueDigest !== 'string' || !digestPattern.test(valueDigest))) {
    throw invalid('valueDigest');
  }
  // Approving wording records the approved digest; readiness compares against it.
  if (controlKey === 'wording_approval' && command.enabled && valueDigest === null) {
    throw invalid('valueDigest');
  }
  const policyVersion = command.policyVersion ?? null;
  if (policyVersion !== null) text(policyVersion, 'policyVersion', 120);
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw invalid('expectedRevision');
  }
  const reason = command.reason ?? '';
  if (typeof reason !== 'string' || reason.length > 500) throw invalid('reason');
  return { controlKey, enabled: command.enabled, valueDigest, policyVersion,
    expectedRevision: command.expectedRevision, actor: text(command.actor, 'actor', 200),
    reason, now: instant(command.now) };
}

export function validateConversationGmailThread(command = {}) {
  const gmailThreadId = command.gmailThreadId;
  if (typeof gmailThreadId !== 'string' || !threadIdPattern.test(gmailThreadId)) {
    throw invalid('gmailThreadId');
  }
  return { conversationId: text(command.conversationId, 'conversationId', 240), gmailThreadId,
    now: instant(command.now) };
}

// An RFC 5322 Message-ID as rfc5322.js accepts it.
const rfcMessageIdPattern = /^<[!-;=?-~]+@[!-;=?-~]+>$/;

/** The Message-ID Gmail actually gave an accepted transmission's sent message. */
export function validateCimCommunicationMessageId(command = {}) {
  const messageId = command.messageId;
  if (typeof messageId !== 'string' || messageId.length > 998 || !rfcMessageIdPattern.test(messageId)) {
    throw invalid('messageId');
  }
  return { transmissionId: text(command.transmissionId, 'transmissionId', 240), messageId,
    now: instant(command.now) };
}

/** One connection row in the same shape from both adapters; scopes are an array. */
export function normalizeGmailConnectionRow(row) {
  if (!row) return null;
  const scopes = typeof row.granted_scopes === 'string'
    ? JSON.parse(row.granted_scopes) : row.granted_scopes;
  return {
    id: row.id,
    email_address: row.email_address,
    refresh_token_ciphertext: row.refresh_token_ciphertext,
    granted_scopes: Array.isArray(scopes) ? scopes : [],
    connected_at: optionalInstant(row.connected_at),
    connected_by: row.connected_by,
    revoked_at: optionalInstant(row.revoked_at),
    revoked_by: row.revoked_by ?? null,
    history_checkpoint: row.history_checkpoint ?? null,
    last_token_ok_at: optionalInstant(row.last_token_ok_at),
    last_error_code: row.last_error_code ?? null,
  };
}

export function normalizeSendControlRow(row) {
  if (!row) {
    return { enabled: false, valueDigest: null, policyVersion: null, changedAt: null,
      changedBy: null, revision: 0 };
  }
  return {
    enabled: row.enabled === true || row.enabled === 1,
    valueDigest: row.value_digest ?? null,
    policyVersion: row.policy_version ?? null,
    changedAt: optionalInstant(row.changed_at),
    changedBy: row.changed_by ?? null,
    revision: Number(row.revision),
  };
}

/** Every control, defaulting to off at revision 0 when it was never set. */
export function normalizeSendControlRows(rows = []) {
  const byKey = new Map(rows.map((row) => [row.control_key, row]));
  return Object.fromEntries(Object.entries(PURSUE_SEND_CONTROL_KEYS)
    .map(([key, name]) => [name, normalizeSendControlRow(byKey.get(key))]));
}

export function normalizeOpenGmailConversationRow(row) {
  return { conversationId: row.conversation_id, gmailThreadId: row.gmail_thread_id,
    campaignId: row.campaign_id ?? null, recipientFingerprint: row.recipient_fingerprint };
}

export function validateCimProviderRelease(command = {}) {
  const payloadDigest = command.payloadDigest;
  if (typeof payloadDigest !== 'string' || !digestPattern.test(payloadDigest)) {
    throw invalid('payloadDigest');
  }
  if (!Number.isSafeInteger(command.expectedRowVersion) || command.expectedRowVersion < 0) {
    throw invalid('expectedRowVersion');
  }
  if (command.provider !== 'gmail') throw invalid('provider');
  if (!CIM_PROVIDER_RELEASE_CODES.includes(command.providerResultCode)) {
    throw invalid('providerResultCode');
  }
  return {
    transmissionId: text(command.transmissionId, 'transmissionId', 240),
    payloadDigest,
    expectedRowVersion: command.expectedRowVersion,
    provider: 'gmail',
    providerResultCode: command.providerResultCode,
    actor: text(command.actor, 'actor', 200),
    now: instant(command.now),
  };
}

// The reply poller's processed-message log (spec §6): only the classification, the Gmail ids,
// a fingerprint of the From address, timestamps and whether its effect has been applied. It is
// written before the effect (applied = false) and settled after it, so a crash in between leaves
// a pending row that the next poll (or the sender, before any send) applies again. Never a body,
// subject or snippet.
export const GMAIL_REPLY_CLASSIFICATIONS = Object.freeze(['ours', 'owner', 'bounce', 'auto-reply',
  'stop', 'reply']);
const gmailIdPattern = /^[A-Za-z0-9_-]{1,240}$/;
const MAX_REPLY_LOOKUP = 500;
const MAX_CONVERSATION_LOOKUP = 500;

function gmailId(value, name) {
  if (typeof value !== 'string' || !gmailIdPattern.test(value)) throw invalid(name);
  return value;
}

function uniqueList(value, name, maximum, item) {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(name);
  const items = value.map((entry) => item(entry, name));
  if (new Set(items).size !== items.length) throw invalid(name);
  return items;
}

export function validateGmailReplyMessage(command = {}) {
  if (!GMAIL_REPLY_CLASSIFICATIONS.includes(command.classification)) throw invalid('classification');
  const fromFingerprint = command.fromFingerprint ?? null;
  if (fromFingerprint !== null && (typeof fromFingerprint !== 'string'
    || !digestPattern.test(fromFingerprint))) throw invalid('fromFingerprint');
  const messageAt = command.messageAt === null || command.messageAt === undefined
    ? null : instant(command.messageAt, 'messageAt');
  if (typeof command.applied !== 'boolean') throw invalid('applied');
  return {
    gmailMessageId: gmailId(command.gmailMessageId, 'gmailMessageId'),
    gmailThreadId: gmailId(command.gmailThreadId, 'gmailThreadId'),
    conversationId: text(command.conversationId, 'conversationId', 240),
    classification: command.classification,
    fromFingerprint,
    messageAt,
    applied: command.applied,
    now: instant(command.now),
  };
}

export function validateGmailPendingReplyLookup(command = {}) {
  const limit = command.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid('limit');
  return { limit };
}

export function validateGmailReplyMessageLookup(command = {}) {
  return { gmailMessageIds: uniqueList(command.gmailMessageIds, 'gmailMessageIds',
    MAX_REPLY_LOOKUP, gmailId) };
}

export function validateGmailSentIdentityLookup(command = {}) {
  return { conversationIds: uniqueList(command.conversationIds, 'conversationIds',
    MAX_CONVERSATION_LOOKUP, (value, name) => text(value, name, 240)) };
}

export function normalizeGmailReplyMessageRow(row) {
  return {
    gmailMessageId: row.gmail_message_id,
    gmailThreadId: row.gmail_thread_id,
    conversationId: row.conversation_id,
    classification: row.classification,
    fromFingerprint: row.from_fingerprint ?? null,
    messageAt: optionalInstant(row.message_at),
    processedAt: optionalInstant(row.processed_at),
    applied: row.applied === true || row.applied === 1,
  };
}

/** One transmission of a polled conversation: what makes a thread message "ours". */
export function normalizeGmailSentIdentityRow(row) {
  return {
    conversationId: row.conversation_id,
    transmissionId: row.transmission_id,
    fromAddress: row.from_address ?? null,
    providerMessageId: row.provider === 'gmail' ? row.provider_message_id ?? null : null,
    rfcMessageId: row.rfc_message_id ?? null,
  };
}
