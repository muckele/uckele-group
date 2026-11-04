// Connect, disconnect and refresh the owner's Gmail mailbox (spec §4.1-4.2).
// Every Google call goes through the injected `fetcher`. Every error thrown here
// carries only a code as its message: no token, secret, key or Google response text.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decodeGmailTokenKey, decryptRefreshToken, encryptRefreshToken } from './gmailTokenCrypto.js';

export const GMAIL_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
]);
export const GMAIL_CALLBACK_PATH = '/api/admin/deal-hunter/gmail/callback';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_CLOCK_SKEW_MS = 60 * 1000;
const FORM_HEADERS = Object.freeze({ 'Content-Type': 'application/x-www-form-urlencoded' });
// Token refusals that only the owner can fix (reconnect, or correct the OAuth client):
// a revoked or expired grant, or a client Google no longer accepts for this token.
const TOKEN_INVALID_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

// Single-use state nonces, kept in memory: a restart only forces the owner to click again.
const pendingStateNonces = new Map();

const defaultFetcher = (...args) => globalThis.fetch(...args);

export function gmailError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function instant(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

function gmailSettings(config, failureCode) {
  const gmail = config?.dealHunter?.gmail || {};
  const origin = String(config?.server?.origin || '').replace(/\/+$/, '');
  if (!gmail.clientId || !gmail.clientSecret || !gmail.senderAddress || !gmail.tokenKey || !origin) {
    throw gmailError(failureCode);
  }
  return { ...gmail, redirectUri: `${origin}${GMAIL_CALLBACK_PATH}` };
}

function signState(payload, key) {
  return createHmac('sha256', key).update(`gmail-oauth-state-v1.${payload}`).digest('base64url');
}

function pruneStateNonces(nowMs) {
  for (const [nonce, expiresAt] of pendingStateNonces) {
    if (expiresAt <= nowMs) pendingStateNonces.delete(nonce);
  }
}

/** Verifies the HMAC, the 10-minute window, the issuing actor, and consumes the nonce. */
function consumeState(state, { key, actor, now }) {
  const invalid = () => gmailError('gmail_state_invalid');
  const parts = typeof state === 'string' ? state.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();
  const expected = Buffer.from(signState(parts[0], key));
  const provided = Buffer.from(parts[1]);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalid();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const nowMs = Date.parse(now);
  const issuedMs = Date.parse(payload?.issuedAt);
  const nonce = payload?.nonce;
  if (typeof nonce !== 'string' || !pendingStateNonces.has(nonce)) throw invalid();
  const nonceExpiresAt = pendingStateNonces.get(nonce);
  pendingStateNonces.delete(nonce);
  if (!Number.isFinite(issuedMs) || nowMs - issuedMs > STATE_TTL_MS || nowMs >= nonceExpiresAt
    || issuedMs - nowMs > STATE_CLOCK_SKEW_MS || payload.actor !== actor) {
    throw invalid();
  }
}

/** Calls Google and parses JSON; a network failure becomes `failureCode` without its message. */
async function callGoogle(fetcher, url, init, config, failureCode) {
  const timeoutMs = Number(config?.server?.outboundRequestTimeoutMs) || 10_000;
  let response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw gmailError(failureCode);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, body };
}

export function buildGmailConnectUrl({ config, actor, now = new Date() }) {
  const gmail = gmailSettings(config, 'gmail_connect_failed');
  const key = decodeGmailTokenKey(gmail.tokenKey);
  const issuedAt = instant(now);
  const nowMs = Date.parse(issuedAt);
  pruneStateNonces(nowMs);
  const nonce = randomBytes(24).toString('base64url');
  pendingStateNonces.set(nonce, nowMs + STATE_TTL_MS);
  const payload = Buffer.from(JSON.stringify({ nonce, actor, issuedAt })).toString('base64url');
  const state = `${payload}.${signState(payload, key)}`;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: gmail.clientId,
    redirect_uri: gmail.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    login_hint: gmail.senderAddress,
    state,
  }).toString();
  return { url: url.toString(), state };
}

export async function completeGmailConnect({
  storage, config, code, state, actor, now = new Date(), fetcher = defaultFetcher,
}) {
  const at = instant(now);
  const gmail = gmailSettings(config, 'gmail_connect_failed');
  consumeState(state, { key: decodeGmailTokenKey(gmail.tokenKey), actor, now: at });
  if (typeof code !== 'string' || !code) throw gmailError('gmail_connect_failed');

  const token = await callGoogle(fetcher, TOKEN_URL, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({
      code,
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
      redirect_uri: gmail.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  }, config, 'gmail_connect_failed');
  const accessToken = token.body?.access_token;
  const refreshToken = token.body?.refresh_token;
  if (!token.ok || typeof accessToken !== 'string' || !accessToken
    || typeof refreshToken !== 'string' || !refreshToken) {
    throw gmailError('gmail_connect_failed');
  }

  const profile = await callGoogle(fetcher, PROFILE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  }, config, 'gmail_connect_failed');
  const emailAddress = profile.body?.emailAddress;
  if (!profile.ok || typeof emailAddress !== 'string' || !emailAddress) {
    throw gmailError('gmail_connect_failed');
  }
  if (emailAddress.trim().toLowerCase() !== String(gmail.senderAddress).trim().toLowerCase()) {
    throw gmailError('gmail_address_mismatch');
  }
  const grantedScopes = String(token.body?.scope || '').split(/\s+/).filter(Boolean);
  if (!GMAIL_SCOPES.every((scope) => grantedScopes.includes(scope))) {
    throw gmailError('gmail_scope_missing');
  }

  const row = await storage.saveGmailConnection({
    emailAddress: emailAddress.trim(),
    refreshTokenCiphertext: encryptRefreshToken(refreshToken, gmail.tokenKey),
    grantedScopes,
    historyCheckpoint: profile.body?.historyId ?? null,
    connectedBy: actor,
    now: at,
  });
  await storage.recordGmailTokenCheck({ ok: true, now: at });
  return { emailAddress: row.email_address, connectedAt: row.connected_at };
}

/** Revokes at Google (best effort), then always marks the local connection revoked. */
export async function disconnectGmail({ storage, config, actor, now = new Date(), fetcher = defaultFetcher }) {
  const at = instant(now);
  const connection = await storage.getGmailConnection();
  if (connection) {
    try {
      const refreshToken = decryptRefreshToken(connection.refresh_token_ciphertext,
        config?.dealHunter?.gmail?.tokenKey);
      await callGoogle(fetcher, REVOKE_URL, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: new URLSearchParams({ token: refreshToken }).toString(),
      }, config, 'gmail_revoke_failed');
    } catch {
      // Best effort: the owner can also remove access in their Google account.
    }
  }
  const row = await storage.revokeGmailConnection({ revokedBy: actor, now: at });
  return { revokedAt: row?.revoked_at ?? null };
}

/** Exchanges the stored refresh token for an access token and records the check. */
export async function getGmailAccessToken({ storage, config, now = new Date(), fetcher = defaultFetcher }) {
  const at = instant(now);
  const gmail = gmailSettings(config, 'gmail_not_connected');
  const connection = await storage.getGmailConnection();
  if (!connection) throw gmailError('gmail_not_connected');
  const refreshToken = decryptRefreshToken(connection.refresh_token_ciphertext, gmail.tokenKey);

  const result = await callGoogle(fetcher, TOKEN_URL, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: new URLSearchParams({
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  }, config, 'gmail_token_refresh_failed');
  if (TOKEN_INVALID_ERRORS.has(result.body?.error)) {
    await storage.recordGmailTokenCheck({ ok: false, errorCode: 'gmail_token_invalid', now: at });
    throw gmailError('gmail_token_invalid');
  }
  const accessToken = result.body?.access_token;
  if (!result.ok || typeof accessToken !== 'string' || !accessToken) {
    throw gmailError('gmail_token_refresh_failed');
  }
  await storage.recordGmailTokenCheck({ ok: true, now: at });
  return accessToken;
}
