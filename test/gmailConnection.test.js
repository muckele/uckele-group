import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSqliteStorage } from '../server/storage/sqlite.js';
import { decryptRefreshToken, encryptRefreshToken } from '../server/services/gmailTokenCrypto.js';
import {
  buildGmailConnectUrl,
  completeGmailConnect,
  disconnectGmail,
  getGmailAccessToken,
} from '../server/services/gmailConnection.js';

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CALLBACK_PATH = '/api/admin/deal-hunter/gmail/callback';
const REFRESH_TOKEN = '1//refresh-token-secret-value';
const ACCESS_TOKEN = 'ya29.access-token-secret-value';
const CLIENT_SECRET = 'client-secret-value';
const at = '2026-11-03T15:00:00.000Z';

function makeConfig(overrides = {}) {
  return {
    server: { origin: 'https://app.uckele.test', outboundRequestTimeoutMs: 1000 },
    dealHunter: {
      gmail: {
        clientId: 'client-id.apps.googleusercontent.com',
        clientSecret: CLIENT_SECRET,
        senderAddress: 'owner@domain.com',
        tokenKey: randomBytes(32).toString('base64'),
        ...overrides,
      },
    },
  };
}

function openStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-gmail-connection-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'gmail.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A Google stand-in: token exchange, refresh, profile and revoke, recording every call. */
function fakeGoogle({
  scope = `${SEND_SCOPE} ${READ_SCOPE}`,
  emailAddress = 'owner@domain.com',
  historyId = '987654',
  refreshError = null,
  revokeStatus = 200,
} = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const body = init.body ? new URLSearchParams(String(init.body)) : null;
    calls.push({ url: String(url), method: init.method || 'GET', body, headers: init.headers || {} });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      if (body.get('grant_type') === 'authorization_code') {
        return json(200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, scope,
          expires_in: 3599, token_type: 'Bearer' });
      }
      if (refreshError) return json(400, { error: refreshError, error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599, scope, token_type: 'Bearer' });
    }
    if (String(url) === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
      return json(200, { emailAddress, historyId, messagesTotal: 1, threadsTotal: 1 });
    }
    if (String(url) === 'https://oauth2.googleapis.com/revoke') {
      return revokeStatus === 'throw' ? Promise.reject(new TypeError('fetch failed'))
        : json(revokeStatus, revokeStatus === 200 ? {} : { error: 'invalid_token' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetcher, calls };
}

async function connect(storage, config, google, { actor = 'admin', now = at } = {}) {
  const { state } = buildGmailConnectUrl({ config, actor, now });
  return completeGmailConnect({ storage, config, code: 'auth-code', state, actor, now, fetcher: google.fetcher });
}

test('encrypt/decrypt round-trips and tampering throws gmail_token_key_invalid', () => {
  const key = randomBytes(32).toString('base64');
  const ciphertext = encryptRefreshToken(REFRESH_TOKEN, key);
  assert.match(ciphertext, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.ok(!ciphertext.includes(REFRESH_TOKEN));
  assert.notEqual(encryptRefreshToken(REFRESH_TOKEN, key), ciphertext, 'a fresh IV each time');
  assert.equal(decryptRefreshToken(ciphertext, key), REFRESH_TOKEN);

  const [version, iv, tag, body] = ciphertext.split('.');
  const flipped = Buffer.from(body, 'base64');
  flipped[0] ^= 1;
  const tampered = [version, iv, tag, flipped.toString('base64')].join('.');
  const otherKey = randomBytes(32).toString('base64');
  const shortKey = randomBytes(16).toString('base64');
  for (const [value, keyBase64] of [[tampered, key], [ciphertext, otherKey], [ciphertext, shortKey],
    ['v2.aaaa.bbbb.cccc', key], ['not-a-ciphertext', key], [ciphertext, '']]) {
    assert.throws(() => decryptRefreshToken(value, keyBase64),
      (error) => error.code === 'gmail_token_key_invalid' && error.message === 'gmail_token_key_invalid');
  }
  assert.throws(() => encryptRefreshToken(REFRESH_TOKEN, shortKey), { code: 'gmail_token_key_invalid' });
});

test('connect URL requests offline access, consent prompt, both scopes, and the callback path', () => {
  const config = makeConfig();
  const { url, state } = buildGmailConnectUrl({ config, actor: 'admin', now: at });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), 'client-id.apps.googleusercontent.com');
  assert.equal(parsed.searchParams.get('redirect_uri'), `https://app.uckele.test${CALLBACK_PATH}`);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
  assert.deepEqual(parsed.searchParams.get('scope').split(' ').sort(), [READ_SCOPE, SEND_SCOPE].sort());
  assert.equal(parsed.searchParams.get('state'), state);
  assert.ok(!url.includes(CLIENT_SECRET), 'the client secret never leaves the server');
  assert.ok(!url.includes(config.dealHunter.gmail.tokenKey));
});

test('callback rejects reused, expired, and forged state with gmail_state_invalid', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  const google = fakeGoogle();
  const isStateInvalid = (error) => error.code === 'gmail_state_invalid';

  const { state } = buildGmailConnectUrl({ config, actor: 'admin', now: at });
  await completeGmailConnect({ storage, config, code: 'auth-code', state, actor: 'admin', now: at,
    fetcher: google.fetcher });
  await assert.rejects(completeGmailConnect({ storage, config, code: 'auth-code', state, actor: 'admin',
    now: at, fetcher: google.fetcher }), isStateInvalid, 'reused');

  const stale = buildGmailConnectUrl({ config, actor: 'admin', now: at }).state;
  await assert.rejects(completeGmailConnect({ storage, config, code: 'auth-code', state: stale,
    actor: 'admin', now: '2026-11-03T15:10:01.000Z', fetcher: google.fetcher }), isStateInvalid, 'expired');

  const fresh = buildGmailConnectUrl({ config, actor: 'admin', now: at }).state;
  const [payload, signature] = fresh.split('.');
  const otherKeyState = buildGmailConnectUrl({ config: makeConfig(), actor: 'admin', now: at }).state;
  const forged = [
    `${payload}.${signature.slice(0, -2)}AA`,
    `${Buffer.from(JSON.stringify({ nonce: 'x', actor: 'admin', issuedAt: at })).toString('base64url')}.${signature}`,
    otherKeyState,
    'garbage',
    '',
  ];
  for (const candidate of forged) {
    await assert.rejects(completeGmailConnect({ storage, config, code: 'auth-code', state: candidate,
      actor: 'admin', now: at, fetcher: google.fetcher }), isStateInvalid, `forged: ${candidate}`);
  }
  await assert.rejects(completeGmailConnect({ storage, config, code: 'auth-code', state: fresh,
    actor: 'someone-else', now: at, fetcher: google.fetcher }), isStateInvalid, 'issued to another actor');
  assert.equal(google.calls.filter((call) => call.body?.get('grant_type') === 'authorization_code').length, 1,
    'no rejected state reaches Google');
});

test('callback rejects a different mailbox with gmail_address_mismatch', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await assert.rejects(connect(storage, config, fakeGoogle({ emailAddress: 'someone@domain.com' })),
    (error) => error.code === 'gmail_address_mismatch');
  assert.equal(await storage.getGmailConnection(), null);

  const result = await connect(storage, config, fakeGoogle({ emailAddress: 'Owner@Domain.com' }));
  assert.equal(result.emailAddress, 'Owner@Domain.com');
  assert.equal(result.connectedAt, at);
});

test('callback rejects missing gmail.readonly with gmail_scope_missing', async (t) => {
  const storage = openStorage(t);
  await assert.rejects(connect(storage, makeConfig(), fakeGoogle({ scope: SEND_SCOPE })),
    (error) => error.code === 'gmail_scope_missing');
  assert.equal(await storage.getGmailConnection(), null);
});

test('callback stores ciphertext and the profile historyId, never plaintext', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  const google = fakeGoogle({ historyId: '424242' });
  const result = await connect(storage, config, google);
  assert.deepEqual(result, { emailAddress: 'owner@domain.com', connectedAt: at });

  const exchange = google.calls.find((call) => call.body?.get('grant_type') === 'authorization_code');
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.body.get('code'), 'auth-code');
  assert.equal(exchange.body.get('redirect_uri'), `https://app.uckele.test${CALLBACK_PATH}`);
  const profile = google.calls.find((call) => call.url.endsWith('/users/me/profile'));
  assert.equal(profile.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);

  const row = await storage.getGmailConnection();
  assert.equal(row.email_address, 'owner@domain.com');
  assert.equal(row.history_checkpoint, '424242');
  assert.deepEqual([...row.granted_scopes].sort(), [READ_SCOPE, SEND_SCOPE].sort());
  assert.equal(row.connected_by, 'admin');
  assert.ok(!JSON.stringify(row).includes(REFRESH_TOKEN));
  assert.ok(!JSON.stringify(row).includes(ACCESS_TOKEN));
  assert.equal(decryptRefreshToken(row.refresh_token_ciphertext, config.dealHunter.gmail.tokenKey), REFRESH_TOKEN);
});

test('access token refresh records a good check and returns the token', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config, fakeGoogle());
  const google = fakeGoogle();
  const later = '2026-11-03T16:00:00.000Z';
  assert.equal(await getGmailAccessToken({ storage, config, now: later, fetcher: google.fetcher }), ACCESS_TOKEN);
  const refresh = google.calls[0];
  assert.equal(refresh.url, 'https://oauth2.googleapis.com/token');
  assert.equal(refresh.body.get('grant_type'), 'refresh_token');
  assert.equal(refresh.body.get('refresh_token'), REFRESH_TOKEN);
  const row = await storage.getGmailConnection();
  assert.equal(row.last_token_ok_at, later);
  assert.equal(row.last_error_code, null);
});

test('invalid_grant on refresh throws gmail_token_invalid and records the failed check', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config, fakeGoogle());
  const google = fakeGoogle({ refreshError: 'invalid_grant' });
  await assert.rejects(getGmailAccessToken({ storage, config, now: at, fetcher: google.fetcher }),
    (error) => error.code === 'gmail_token_invalid' && error.message === 'gmail_token_invalid');
  assert.equal((await storage.getGmailConnection()).last_error_code, 'gmail_token_invalid');

  const empty = openStorage(t);
  await assert.rejects(getGmailAccessToken({ storage: empty, config, now: at, fetcher: google.fetcher }),
    (error) => error.code === 'gmail_not_connected');
});

test('disconnect revokes at Google best-effort and still revokes locally when Google errors', async (t) => {
  const later = '2026-11-03T17:00:00.000Z';
  for (const revokeStatus of [200, 500, 'throw']) {
    const storage = openStorage(t);
    const config = makeConfig();
    await connect(storage, config, fakeGoogle());
    const google = fakeGoogle({ revokeStatus });
    const result = await disconnectGmail({ storage, config, actor: 'admin', now: later, fetcher: google.fetcher });
    assert.deepEqual(result, { revokedAt: later }, String(revokeStatus));
    const revoke = google.calls.find((call) => call.url === 'https://oauth2.googleapis.com/revoke');
    assert.equal(revoke.method, 'POST');
    assert.equal(revoke.body.get('token'), REFRESH_TOKEN);
    assert.equal(await storage.getGmailConnection(), null, String(revokeStatus));
  }
});
