// The mail provider seam for Pursue CIM campaigns (spec §4.3). Two implementations exist:
// gmailCimProvider.js (Gmail REST) and fakeCimProvider.js (tests). Callers depend only on
// the shape documented here.

/**
 * @typedef {'accepted'|'definitive-failure'|'ambiguous'|'quota'|'not-attempted'} CimSendOutcome
 * - accepted: the provider returned an id; the message is sent.
 * - definitive-failure: rejected for good (a non-quota 4xx, or an invalid message caught locally).
 * - ambiguous: timeout, 5xx or lost response; reconcile with findSent before anything else.
 * - quota: rejected before acceptance by a rate or daily limit; nothing was sent.
 * - not-attempted: nothing was sent and the message is not at fault (no connection, revoked or
 *   failed token refresh, or the provider rejected our access: Gmail 401 or 403 access reasons).
 */

/**
 * @typedef {object} CimSendResult
 * @property {CimSendOutcome} outcome
 * @property {string|null} messageId provider message id, only when accepted
 * @property {string|null} threadId provider thread id, only when accepted
 * @property {string|null} rfcMessageId our `<{transmissionId}@{sender domain}>`, null if invalid input
 * @property {string} code `accepted`, `gmail_<status>`, `gmail_403_<quota reason>`, `gmail_timeout`,
 *   `gmail_network_error`, `gmail_response_invalid`, `invalid_message`, or a token code
 *   (`gmail_not_connected`, `gmail_token_invalid`, `gmail_token_refresh_failed`, `gmail_access_denied`).
 */

/**
 * The normalized message returned by listThreadChanges. Header values are strings or null.
 * @typedef {object} CimThreadMessage
 * @property {string} id provider message id
 * @property {string} threadId provider thread id
 * @property {string|null} historyId
 * @property {string|null} internalDate ISO-8601 instant the provider received the message
 * @property {string[]} labelIds e.g. `SENT`, `INBOX`
 * @property {{ from: string|null, messageId: string|null, inReplyTo: string|null,
 *   references: string|null, autoSubmitted: string|null, xAutoreply: string|null,
 *   xAutorespond: string|null, precedence: string|null, contentType: string|null }} headers
 * @property {string|null} [bodyPrefix] first 4096 chars of the text/plain part (null when there is
 *   none); present only when the caller passed `withBodyPrefix: true`. For classification only:
 *   never store it.
 */

/**
 * Provider interface:
 *   name: string
 *   readiness() -> { ready: boolean, reasons: string[] }
 *   send({ transmissionId, to, from, subject, text, html?, threadId?, inReplyTo?, references? })
 *     -> CimSendResult (never throws for provider outcomes)
 *   findSent({ rfcMessageId }) -> { found: true, messageId, threadId } | { found: false }
 *     (throws a code-only error when the search itself fails, so "not found" is never a guess)
 *   listThreadChanges({ checkpoint, threadIds, withBodyPrefix? })
 *     -> { messages: CimThreadMessage[], nextCheckpoint: string|null, checkpointExpired: boolean }
 *     When the checkpoint is missing or expired, `checkpointExpired` is true and `messages` holds
 *     every message of the requested threads; process idempotently by message id.
 *     Throws a code-only error on failure, so the caller never advances its checkpoint.
 *   readMessageId({ messageId }) -> string (optional) the Message-ID header the provider gave
 *     an accepted message, which may differ from ours; throws a code-only error when unread.
 *   readSignature() -> { ok: true, sendAsEmail, html } | { ok: false, code } (optional) the
 *     owner's signature HTML for the configured send-as address, unsanitized ('' when there is
 *     none); never throws. Pursue emails end with it after emailSignatureHtml.js sanitizes it.
 */
export const CIM_MAIL_PROVIDER_METHODS = Object.freeze(['readiness', 'send', 'findSent', 'listThreadChanges']);
export const CIM_SEND_OUTCOMES = Object.freeze(['accepted', 'definitive-failure', 'ambiguous', 'quota',
  'not-attempted']);
export const CIM_THREAD_MESSAGE_HEADERS = Object.freeze({
  from: 'From',
  messageId: 'Message-ID',
  inReplyTo: 'In-Reply-To',
  references: 'References',
  autoSubmitted: 'Auto-Submitted',
  xAutoreply: 'X-Autoreply',
  xAutorespond: 'X-Autorespond',
  precedence: 'Precedence',
  contentType: 'Content-Type',
});
export const CIM_BODY_PREFIX_CHARS = 4096;

const TRANSMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Throws when `provider` lacks a name or any interface method; returns it otherwise. */
export function assertCimMailProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('cim_mail_provider_invalid');
  if (typeof provider.name !== 'string' || !provider.name) throw new Error('cim_mail_provider_invalid: name');
  for (const method of CIM_MAIL_PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') throw new Error(`cim_mail_provider_invalid: ${method}`);
  }
  return provider;
}

/** The lowercased domain of the sender address, or null when it is not a plain hostname. */
export function senderDomain(senderAddress) {
  const address = String(senderAddress ?? '').trim();
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const domain = address.slice(at + 1).toLowerCase();
  return DOMAIN.test(domain) ? domain : null;
}

/** `<{transmissionId}@{sender domain}>`, or null when either part is unsafe in a header. */
export function cimRfcMessageId(transmissionId, senderAddress) {
  const domain = senderDomain(senderAddress);
  if (!domain || typeof transmissionId !== 'string' || !TRANSMISSION_ID.test(transmissionId)) return null;
  return `<${transmissionId}@${domain}>`;
}

/** A send result with the fixed key set; ids are only ever present on `accepted`. */
export function cimSendResult(outcome, { rfcMessageId = null, code, messageId = null, threadId = null }) {
  const accepted = outcome === 'accepted';
  return {
    outcome,
    messageId: accepted ? messageId : null,
    threadId: accepted ? threadId : null,
    rfcMessageId,
    code,
  };
}
