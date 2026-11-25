// An in-memory CIM mail provider for tests (spec §4.3). It validates messages exactly like the
// Gmail provider, records what reached the "mailbox", simulates every send outcome, and keeps a
// history counter so listThreadChanges behaves like Gmail's history (our sends included).
import {
  CIM_BODY_PREFIX_CHARS,
  CIM_SEND_OUTCOMES,
  CIM_THREAD_MESSAGE_HEADERS,
  cimRfcMessageId,
  cimSendResult,
} from './cimMailProvider.js';
import { RFC_MESSAGE_ID, buildRfc5322Message, formatMailboxHeader } from './rfc5322.js';

// The signature the fake mailbox reports until a test sets another (placeholder values only).
export const FAKE_CIM_SIGNATURE_HTML = '<div dir="ltr"><b>Pat Example</b><br>Example Holdings LLC<br>'
  + '<a href="mailto:pat@example.com">pat@example.com</a></div>';

const DEFAULT_FAILURE_CODES = Object.freeze({
  'definitive-failure': 'gmail_400',
  ambiguous: 'gmail_timeout',
  quota: 'gmail_429',
  'not-attempted': 'gmail_token_invalid',
});

function invalidMessage() {
  const error = new Error('invalid_message');
  error.code = 'invalid_message';
  return error;
}

/**
 * @param {object} [options]
 * @param {Function|Date|string} [options.now] a clock function, or a fixed instant
 * @param {string} [options.senderAddress] the mailbox address; its domain names our Message-IDs
 * @param {string} [options.name]
 * @returns provider & { sent[], attempts[], injectReply(threadId, message), failNext(outcome, opts?),
 *   quotaNext(), expireCheckpointNext(), setReadinessReasons(reasons), rewriteMessageIds(),
 *   failReadMessageIdNext(), setSignature(html), failSignatureNext(code), signatureReads }
 */
export function createFakeCimProvider({ now, senderAddress = 'owner@domain.com', name = 'fake' } = {}) {
  const clock = typeof now === 'function' ? now : () => (now === undefined ? new Date() : new Date(now));
  const instant = () => new Date(clock()).toISOString();
  const sent = [];
  const attempts = [];
  const mailbox = [];
  const pendingFailures = [];
  let sequence = 0;
  let historyCounter = 0;
  let expireNext = false;
  let readinessReasons = [];
  // Gmail may replace a client Message-ID with its own; when on, every accepted send gets one.
  let rewriteDomain = null;
  let failReadNext = false;
  let signatureHtml = FAKE_CIM_SIGNATURE_HTML;
  const signatureFailures = [];
  const signatureReads = [];

  function addToMailbox(message) {
    historyCounter += 1;
    const headers = {};
    for (const key of Object.keys(CIM_THREAD_MESSAGE_HEADERS)) headers[key] = message.headers?.[key] ?? null;
    const stored = {
      id: message.id,
      threadId: message.threadId,
      historyId: String(historyCounter),
      internalDate: message.internalDate ?? instant(),
      labelIds: Array.isArray(message.labelIds) ? [...message.labelIds] : ['INBOX'],
      headers,
      bodyPrefix: typeof message.bodyPrefix === 'string' ? message.bodyPrefix.slice(0, CIM_BODY_PREFIX_CHARS) : null,
    };
    mailbox.push(stored);
    return stored;
  }

  function copyMessage(stored, withBodyPrefix) {
    const { bodyPrefix, ...rest } = stored;
    const message = { ...rest, labelIds: [...rest.labelIds], headers: { ...rest.headers } };
    if (withBodyPrefix) message.bodyPrefix = bodyPrefix;
    return message;
  }

  return {
    name,
    sent,
    attempts,

    signatureReads,

    async readiness() {
      return { ready: readinessReasons.length === 0, reasons: [...readinessReasons] };
    },

    async readSignature() {
      signatureReads.push(instant());
      const code = signatureFailures.shift();
      if (code) return { ok: false, code };
      return { ok: true, sendAsEmail: senderAddress, html: signatureHtml };
    },

    async send(input = {}) {
      const { transmissionId, to, from, subject, text, html, threadId, inReplyTo, references } = input;
      const rfcMessageId = cimRfcMessageId(transmissionId, senderAddress);
      const at = instant();
      const finish = (outcome, details) => {
        const result = cimSendResult(outcome, { rfcMessageId, ...details });
        attempts.push({ transmissionId, rfcMessageId, outcome: result.outcome, code: result.code, at });
        return result;
      };
      try {
        if (!rfcMessageId) throw invalidMessage();
        buildRfc5322Message({ from, to, subject, text, html, messageId: rfcMessageId, inReplyTo, references });
      } catch (error) {
        if (error?.code !== 'invalid_message') throw error;
        return finish('definitive-failure', { code: 'invalid_message' });
      }

      const failure = pendingFailures.shift();
      if (failure && !failure.delivered) return finish(failure.outcome, { code: failure.code });

      sequence += 1;
      const messageId = `fake-msg-${sequence}`;
      const thread = threadId || `fake-thread-${sequence}`;
      const referenceList = Array.isArray(references) ? references : (references ? [references] : []);
      // The Message-ID the sent message actually carries in the mailbox.
      const headerMessageId = rewriteDomain ? `<gmail-rewritten-${sequence}@${rewriteDomain}>` : rfcMessageId;
      sent.push({ transmissionId, to, from, subject, text, html: html ?? null, threadId: thread,
        inReplyTo: inReplyTo ?? null, references: referenceList, rfcMessageId: headerMessageId,
        requestedRfcMessageId: rfcMessageId, messageId, sentAt: at });
      addToMailbox({
        id: messageId,
        threadId: thread,
        internalDate: at,
        labelIds: ['SENT'],
        headers: {
          from: formatMailboxHeader(from),
          messageId: headerMessageId,
          inReplyTo: inReplyTo ?? null,
          references: referenceList.length ? referenceList.join(' ') : null,
          contentType: html ? 'multipart/alternative' : 'text/plain; charset=UTF-8',
        },
        bodyPrefix: text,
      });
      if (failure) return finish(failure.outcome, { code: failure.code });
      return finish('accepted', { code: 'accepted', messageId, threadId: thread });
    },

    async findSent({ rfcMessageId } = {}) {
      if (typeof rfcMessageId !== 'string' || !RFC_MESSAGE_ID.test(rfcMessageId)) throw invalidMessage();
      const match = sent.find((record) => record.rfcMessageId === rfcMessageId);
      return match ? { found: true, messageId: match.messageId, threadId: match.threadId } : { found: false };
    },

    /** The Message-ID header of a message in the mailbox, by its Gmail id. */
    async readMessageId({ messageId } = {}) {
      if (failReadNext) {
        failReadNext = false;
        const error = new Error('gmail_message_read_failed');
        error.code = 'gmail_message_read_failed';
        throw error;
      }
      const stored = mailbox.find((message) => message.id === messageId);
      if (!stored?.headers?.messageId) {
        const error = new Error('gmail_message_read_failed');
        error.code = 'gmail_message_read_failed';
        throw error;
      }
      return stored.headers.messageId;
    },

    async listThreadChanges({ checkpoint, threadIds = [], withBodyPrefix = false } = {}) {
      const wanted = new Set(Array.isArray(threadIds) ? threadIds : []);
      const start = checkpoint === undefined || checkpoint === null ? '' : String(checkpoint);
      const expired = expireNext || !/^\d+$/.test(start);
      expireNext = false;
      const messages = mailbox
        .filter((stored) => wanted.has(stored.threadId))
        .filter((stored) => expired || Number(stored.historyId) > Number(start))
        .map((stored) => copyMessage(stored, withBodyPrefix));
      return { messages, nextCheckpoint: String(historyCounter), checkpointExpired: expired };
    },

    /** Adds a message from someone else to a thread; `message` takes the CimThreadMessage shape. */
    injectReply(threadId, message = {}) {
      sequence += 1;
      const stored = addToMailbox({
        ...message,
        id: message.id ?? `fake-msg-${sequence}`,
        threadId,
        headers: { messageId: `<fake-reply-${sequence}@fake.invalid>`, ...message.headers },
      });
      return copyMessage(stored, true);
    },

    /** The next send returns `outcome`; `delivered: true` (ambiguous only) still reaches the mailbox. */
    failNext(outcome, { code, delivered = false } = {}) {
      if (!CIM_SEND_OUTCOMES.includes(outcome) || outcome === 'accepted') {
        throw new Error(`fake provider: unknown outcome ${outcome}`);
      }
      if (delivered && outcome !== 'ambiguous') throw new Error('fake provider: only ambiguous can be delivered');
      pendingFailures.push({ outcome, code: code ?? DEFAULT_FAILURE_CODES[outcome], delivered });
    },

    quotaNext() {
      pendingFailures.push({ outcome: 'quota', code: DEFAULT_FAILURE_CODES.quota, delivered: false });
    },

    /** The next listThreadChanges reports an expired checkpoint and returns whole threads. */
    expireCheckpointNext() {
      expireNext = true;
    },

    /** From now on Gmail gives every accepted send its own Message-ID (as `domain` ids). */
    rewriteMessageIds({ domain = 'mail.gmail.com' } = {}) {
      rewriteDomain = domain;
    },

    /** The next readMessageId fails. */
    failReadMessageIdNext() {
      failReadNext = true;
    },

    /** The signature HTML the mailbox reports from now on ('' for none). */
    setSignature(html) {
      signatureHtml = String(html ?? '');
    },

    /** The next readSignature fails with `code`. */
    failSignatureNext(code = 'gmail_timeout') {
      signatureFailures.push(code);
    },

    setReadinessReasons(reasons = []) {
      readinessReasons = [...reasons];
    },
  };
}
