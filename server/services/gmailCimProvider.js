// The Gmail implementation of the CIM mail provider (spec §4.3, §5.6, §5.7, §6).
// Every Google call goes through the injected `fetcher`. Results and thrown errors carry
// only codes: never the access token, the refresh token, or a Google response body.
import {
  CIM_BODY_PREFIX_CHARS,
  CIM_THREAD_MESSAGE_HEADERS,
  cimRfcMessageId,
  cimSendResult,
} from './cimMailProvider.js';
import { getGmailAccessToken, gmailError } from './gmailConnection.js';
import { RFC_MESSAGE_ID, buildRfc5322Message } from './rfc5322.js';

export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_CHECK_REUSE_MS = 15 * 60 * 1000;
const QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);
// A 403 for these reasons rejects our access, not the message: nothing was sent.
const ACCESS_DENIED_REASONS = new Set(['insufficientPermissions', 'authError']);
const TOKEN_CODES = new Set(['gmail_not_connected', 'gmail_token_invalid', 'gmail_token_refresh_failed']);
const GMAIL_ID = /^[A-Za-z0-9_-]{1,240}$/;
const MAX_HISTORY_PAGES = 100;
const METADATA_HEADERS = Object.values(CIM_THREAD_MESSAGE_HEADERS);

const defaultFetcher = (...args) => globalThis.fetch(...args);

/** Token failures keep their code; anything unexpected (e.g. an unusable key) is not connected. */
function tokenFailureCode(error) {
  return TOKEN_CODES.has(error?.code) ? error.code : 'gmail_not_connected';
}

/** One Gmail REST call. Never throws: a transport failure comes back as `{ transport }`. */
async function gmailRequest(fetcher, accessToken, url, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetcher(String(url), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GMAIL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { status: 0, ok: false, body: null, transport: timedOut ? 'gmail_timeout' : 'gmail_network_error' };
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, body: parsed, transport: null };
}

function errorReasons(body) {
  const errors = Array.isArray(body?.error?.errors) ? body.error.errors : [];
  return errors.map((entry) => entry?.reason).filter((reason) => typeof reason === 'string');
}

/**
 * Maps a messages.send response to the §5.7 outcome table. Auth rejections (401, or 403 for an
 * access reason) are not-attempted: the message was never sent and is not at fault (Ruling G).
 */
function sendOutcome(response) {
  if (response.transport) return { outcome: 'ambiguous', code: response.transport };
  const { status, body } = response;
  if (status >= 200 && status < 300) {
    const messageId = body?.id;
    const threadId = body?.threadId;
    if (typeof messageId === 'string' && GMAIL_ID.test(messageId)
      && typeof threadId === 'string' && GMAIL_ID.test(threadId)) {
      return { outcome: 'accepted', code: 'accepted', messageId, threadId };
    }
    return { outcome: 'ambiguous', code: 'gmail_response_invalid' };
  }
  if (status === 429) return { outcome: 'quota', code: 'gmail_429' };
  if (status === 401) return { outcome: 'not-attempted', code: 'gmail_token_invalid' };
  if (status === 403) {
    const reasons = errorReasons(body);
    const quota = reasons.find((reason) => QUOTA_REASONS.has(reason));
    if (quota) return { outcome: 'quota', code: `gmail_403_${quota}` };
    if (reasons.some((reason) => ACCESS_DENIED_REASONS.has(reason))) {
      return { outcome: 'not-attempted', code: 'gmail_access_denied' };
    }
    return { outcome: 'definitive-failure', code: 'gmail_403' };
  }
  if (status >= 400 && status < 500) return { outcome: 'definitive-failure', code: `gmail_${status}` };
  return { outcome: 'ambiguous', code: `gmail_${status}` };
}

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  const match = (Array.isArray(headers) ? headers : [])
    .find((header) => String(header?.name ?? '').toLowerCase() === wanted);
  return typeof match?.value === 'string' ? match.value : null;
}

function isoFromMillis(value) {
  const millis = Number(value);
  return value !== undefined && value !== null && Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** The first text/plain part with inline data, depth-first. */
function plainTextData(part) {
  if (!part || typeof part !== 'object') return null;
  if (String(part.mimeType ?? '').toLowerCase() === 'text/plain' && typeof part.body?.data === 'string') {
    return part.body.data;
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const data = plainTextData(child);
    if (data !== null) return data;
  }
  return null;
}

function normalizeMessage(raw, bodyPrefix) {
  const headers = {};
  for (const [key, name] of Object.entries(CIM_THREAD_MESSAGE_HEADERS)) {
    headers[key] = headerValue(raw?.payload?.headers, name);
  }
  const message = {
    id: raw.id,
    threadId: raw.threadId,
    historyId: raw.historyId === undefined || raw.historyId === null ? null : String(raw.historyId),
    internalDate: isoFromMillis(raw.internalDate),
    labelIds: Array.isArray(raw.labelIds) ? raw.labelIds.filter((label) => typeof label === 'string') : [],
    headers,
  };
  if (bodyPrefix !== undefined) message.bodyPrefix = bodyPrefix;
  return message;
}

function metadataUrl(path) {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set('format', 'metadata');
  for (const name of METADATA_HEADERS) url.searchParams.append('metadataHeaders', name);
  return url;
}

/**
 * @param {object} options
 * @param {object} options.storage needs getGmailConnection and recordGmailTokenCheck
 * @param {object} options.config reads config.dealHunter.gmail
 * @param {Function} [options.fetcher] defaults to global fetch
 * @param {Function|Date|string} [options.now] a clock function, or a fixed instant
 */
export function createGmailCimProvider({ storage, config, fetcher = defaultFetcher, now } = {}) {
  const clock = typeof now === 'function' ? now : () => (now === undefined ? new Date() : new Date(now));
  const senderAddress = () => String(config?.dealHunter?.gmail?.senderAddress ?? '').trim();

  const accessToken = () => getGmailAccessToken({ storage, config, now: clock(), fetcher });

  async function readMessage(token, id, withBodyPrefix, initial) {
    let raw = initial;
    if (!raw) {
      const response = await gmailRequest(fetcher, token, metadataUrl(`messages/${encodeURIComponent(id)}`));
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw gmailError('gmail_message_read_failed');
      raw = response.body;
    }
    if (typeof raw?.id !== 'string' || typeof raw?.threadId !== 'string') {
      throw gmailError('gmail_message_read_failed');
    }
    if (!withBodyPrefix) return normalizeMessage(raw);
    const fullUrl = new URL(`${API}/messages/${encodeURIComponent(raw.id)}`);
    fullUrl.searchParams.set('format', 'full');
    const full = await gmailRequest(fetcher, token, fullUrl);
    if (full.status === 404) return null;
    if (!full.ok || !full.body) throw gmailError('gmail_message_read_failed');
    const data = plainTextData(full.body.payload);
    const prefix = data === null ? null
      : Buffer.from(data, 'base64url').toString('utf8').slice(0, CIM_BODY_PREFIX_CHARS);
    return normalizeMessage(raw, prefix);
  }

  /** Checkpoint missing or expired: read the new checkpoint first, then every wanted thread. */
  async function readWholeThreads(token, threadIds, withBodyPrefix) {
    const profile = await gmailRequest(fetcher, token, `${API}/profile`);
    const historyId = profile.body?.historyId;
    if (!profile.ok || historyId === undefined || historyId === null) throw gmailError('gmail_history_failed');
    const messages = [];
    for (const threadId of threadIds) {
      const response = await gmailRequest(fetcher, token, metadataUrl(`threads/${encodeURIComponent(threadId)}`));
      if (response.status === 404) continue;
      if (!response.ok || !response.body) throw gmailError('gmail_history_failed');
      for (const raw of Array.isArray(response.body.messages) ? response.body.messages : []) {
        const message = await readMessage(token, raw?.id, withBodyPrefix, raw);
        if (message) messages.push(message);
      }
    }
    return { messages, nextCheckpoint: String(historyId), checkpointExpired: true };
  }

  return {
    name: 'gmail',

    /** Gmail-level readiness only: gmail_not_connected, gmail_address_mismatch, token codes. */
    async readiness() {
      const connection = await storage.getGmailConnection();
      const sender = senderAddress();
      if (!connection || !sender) return { ready: false, reasons: ['gmail_not_connected'] };
      const reasons = [];
      if (String(connection.email_address ?? '').trim().toLowerCase() !== sender.toLowerCase()) {
        reasons.push('gmail_address_mismatch');
      }
      const lastOk = Date.parse(connection.last_token_ok_at ?? '');
      const recentlyOk = !connection.last_error_code && Number.isFinite(lastOk)
        && clock().getTime() - lastOk <= TOKEN_CHECK_REUSE_MS;
      if (!recentlyOk) {
        try {
          await accessToken();
        } catch (error) {
          reasons.push(tokenFailureCode(error));
        }
      }
      return { ready: reasons.length === 0, reasons };
    },

    /**
     * The owner's Gmail signature for the configured send-as address
     * (users.settings.sendAs.get, which the gmail.readonly scope already allows). Never throws:
     * `{ ok: true, sendAsEmail, html }` (html is '' when Gmail has no signature) or
     * `{ ok: false, code }` with a code only, never a Google response body.
     */
    async readSignature() {
      const sender = senderAddress();
      if (!sender) return { ok: false, code: 'gmail_not_connected' };
      let token;
      try {
        token = await accessToken();
      } catch (error) {
        return { ok: false, code: tokenFailureCode(error) };
      }
      const response = await gmailRequest(fetcher, token,
        `${API}/settings/sendAs/${encodeURIComponent(sender)}`);
      if (response.transport) return { ok: false, code: response.transport };
      const { status, body } = response;
      if (status === 401) return { ok: false, code: 'gmail_token_invalid' };
      if (status === 403) {
        const reasons = errorReasons(body);
        const quota = reasons.find((reason) => QUOTA_REASONS.has(reason));
        // Snake case, so the code survives the code pattern storage and logs accept.
        if (quota) {
          return { ok: false, code: `gmail_403_${quota.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}` };
        }
        return { ok: false, code: reasons.some((reason) => ACCESS_DENIED_REASONS.has(reason))
          ? 'gmail_access_denied' : 'gmail_403' };
      }
      if (status === 404) return { ok: false, code: 'gmail_send_as_not_found' };
      if (status < 200 || status >= 300) return { ok: false, code: `gmail_${status}` };
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (body.signature !== undefined && body.signature !== null && typeof body.signature !== 'string')) {
        return { ok: false, code: 'gmail_response_invalid' };
      }
      const sendAsEmail = typeof body.sendAsEmail === 'string' ? body.sendAsEmail.trim() : sender;
      if (sendAsEmail.toLowerCase() !== sender.toLowerCase()) {
        return { ok: false, code: 'gmail_send_as_mismatch' };
      }
      return { ok: true, sendAsEmail, html: typeof body.signature === 'string' ? body.signature : '' };
    },

    async send({ transmissionId, to, from, subject, text, html, threadId, inReplyTo, references } = {}) {
      const sender = senderAddress();
      if (!sender) return cimSendResult('not-attempted', { code: 'gmail_not_connected' });
      const rfcMessageId = cimRfcMessageId(transmissionId, sender);
      const invalid = () => cimSendResult('definitive-failure', { rfcMessageId, code: 'invalid_message' });
      if (!rfcMessageId) return invalid();
      const hasThread = threadId !== undefined && threadId !== null && threadId !== '';
      if (hasThread && (typeof threadId !== 'string' || !GMAIL_ID.test(threadId))) return invalid();
      let raw;
      try {
        raw = buildRfc5322Message({ from, to, subject, text, html, messageId: rfcMessageId, inReplyTo,
          references, date: clock() });
      } catch (error) {
        if (error?.code === 'invalid_message') return invalid();
        throw error;
      }

      let token;
      try {
        token = await accessToken();
      } catch (error) {
        return cimSendResult('not-attempted', { rfcMessageId, code: tokenFailureCode(error) });
      }
      const body = { raw: Buffer.from(raw, 'utf8').toString('base64url') };
      if (hasThread) body.threadId = threadId;
      const response = await gmailRequest(fetcher, token, `${API}/messages/send`, { method: 'POST', body });
      const { outcome, ...rest } = sendOutcome(response);
      return cimSendResult(outcome, { rfcMessageId, ...rest });
    },

    async findSent({ rfcMessageId } = {}) {
      if (typeof rfcMessageId !== 'string' || !RFC_MESSAGE_ID.test(rfcMessageId)) {
        throw gmailError('invalid_message');
      }
      const token = await accessToken();
      const search = new URL(`${API}/messages`);
      search.searchParams.set('q', `rfc822msgid:${rfcMessageId.slice(1, -1)}`);
      search.searchParams.set('includeSpamTrash', 'false');
      const listed = await gmailRequest(fetcher, token, search);
      if (!listed.ok || !listed.body) throw gmailError('gmail_find_failed');
      const first = Array.isArray(listed.body.messages) ? listed.body.messages[0] : null;
      if (!first) return { found: false };
      if (typeof first.id !== 'string' || !GMAIL_ID.test(first.id)) throw gmailError('gmail_find_failed');

      const getUrl = new URL(`${API}/messages/${encodeURIComponent(first.id)}`);
      getUrl.searchParams.set('format', 'minimal');
      const message = await gmailRequest(fetcher, token, getUrl);
      const threadId = message.body?.threadId;
      if (!message.ok || typeof threadId !== 'string' || !GMAIL_ID.test(threadId)) {
        throw gmailError('gmail_find_failed');
      }
      return { found: true, messageId: first.id, threadId };
    },

    /**
     * The Message-ID header Gmail gave a sent message (it may replace ours). Throws a coded
     * error when it cannot be read; the caller then keeps our own Message-ID.
     */
    async readMessageId({ messageId } = {}) {
      if (typeof messageId !== 'string' || !GMAIL_ID.test(messageId)) throw gmailError('invalid_message');
      const token = await accessToken();
      const url = new URL(`${API}/messages/${encodeURIComponent(messageId)}`);
      url.searchParams.set('format', 'metadata');
      url.searchParams.set('metadataHeaders', 'Message-ID');
      const response = await gmailRequest(fetcher, token, url);
      if (!response.ok || !response.body) throw gmailError('gmail_message_read_failed');
      const value = String(headerValue(response.body.payload?.headers, 'Message-ID') ?? '').trim();
      if (!RFC_MESSAGE_ID.test(value) || value.length > 998) throw gmailError('gmail_message_read_failed');
      return value;
    },

    async listThreadChanges({ checkpoint, threadIds = [], withBodyPrefix = false } = {}) {
      const wanted = [...new Set((Array.isArray(threadIds) ? threadIds : [])
        .filter((id) => typeof id === 'string' && GMAIL_ID.test(id)))];
      const wantedSet = new Set(wanted);
      const token = await accessToken();
      const start = checkpoint === undefined || checkpoint === null ? '' : String(checkpoint).trim();
      if (!/^\d+$/.test(start)) return readWholeThreads(token, wanted, withBodyPrefix);

      const added = new Map();
      let nextCheckpoint = start;
      let pageToken = null;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_HISTORY_PAGES) throw gmailError('gmail_history_failed');
        const url = new URL(`${API}/history`);
        url.searchParams.set('startHistoryId', start);
        url.searchParams.set('historyTypes', 'messageAdded');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const response = await gmailRequest(fetcher, token, url);
        if (response.status === 404) return readWholeThreads(token, wanted, withBodyPrefix);
        if (!response.ok || !response.body) throw gmailError('gmail_history_failed');
        for (const record of Array.isArray(response.body.history) ? response.body.history : []) {
          for (const entry of Array.isArray(record?.messagesAdded) ? record.messagesAdded : []) {
            const id = entry?.message?.id;
            if (typeof id === 'string' && GMAIL_ID.test(id) && wantedSet.has(entry.message.threadId)) {
              added.set(id, true);
            }
          }
        }
        if (response.body.historyId !== undefined && response.body.historyId !== null) {
          nextCheckpoint = String(response.body.historyId);
        }
        pageToken = typeof response.body.nextPageToken === 'string' ? response.body.nextPageToken : null;
        if (!pageToken) break;
      }

      const messages = [];
      for (const id of added.keys()) {
        const message = await readMessage(token, id, withBodyPrefix);
        if (message) messages.push(message);
      }
      return { messages, nextCheckpoint, checkpointExpired: false };
    },
  };
}
