import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSqliteStorage } from '../server/storage/sqlite.js';
import { encryptRefreshToken } from '../server/services/gmailTokenCrypto.js';
import { assertCimMailProvider } from '../server/services/cimMailProvider.js';
import { GMAIL_REQUEST_TIMEOUT_MS, createGmailCimProvider } from '../server/services/gmailCimProvider.js';
import { buildRfc5322Message } from '../server/services/rfc5322.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_TOKEN = '1//refresh-token-secret-value';
const ACCESS_TOKEN = 'ya29.access-token-secret-value';
const CLIENT_SECRET = 'client-secret-value';
const SECRETS = [REFRESH_TOKEN, ACCESS_TOKEN, CLIENT_SECRET];
const at = '2026-11-03T15:00:00.000Z';
const METADATA_HEADERS = ['From', 'Message-ID', 'In-Reply-To', 'References', 'Auto-Submitted',
  'X-Autoreply', 'X-Autorespond', 'Precedence', 'Content-Type'];

function makeConfig(overrides = {}) {
  return {
    server: { origin: 'https://app.uckele.test', outboundRequestTimeoutMs: 1000 },
    dealHunter: {
      gmail: {
        clientId: 'client-id.apps.googleusercontent.com',
        clientSecret: CLIENT_SECRET,
        senderAddress: 'Owner@Domain.com',
        tokenKey: randomBytes(32).toString('base64'),
        ...overrides,
      },
    },
  };
}

function openStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-gmail-cim-provider-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'gmail.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

async function connect(storage, config, { emailAddress = 'owner@domain.com', tokenOkAt = null } = {}) {
  await storage.saveGmailConnection({
    emailAddress,
    refreshTokenCiphertext: encryptRefreshToken(REFRESH_TOKEN, config.dealHunter.gmail.tokenKey),
    grantedScopes: ['https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly'],
    historyCheckpoint: '100',
    connectedBy: 'admin',
    now: '2026-11-03T12:00:00.000Z',
  });
  if (tokenOkAt) await storage.recordGmailTokenCheck({ ok: true, now: tokenOkAt });
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A Google stand-in: the token endpoint plus a per-test Gmail route table, recording every call. */
function fakeGoogle(route = () => undefined, { refresh = 'ok' } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const call = { url: new URL(String(url)), method: init.method || 'GET', headers: init.headers || {},
      body: init.body, signal: init.signal };
    calls.push(call);
    if (String(url) === TOKEN_URL) {
      if (refresh === 'invalid_grant') {
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      if (refresh === 'network') throw new TypeError('fetch failed');
      if (refresh === '503') return json(503, { error: 'backend_error' });
      return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    }
    const response = await route(call);
    if (response === undefined) throw new Error(`unexpected fetch ${url}`);
    return response;
  };
  return { fetcher, calls, gmailCalls: () => calls.filter((call) => String(call.url) !== TOKEN_URL) };
}

function provider({ storage, config, google }) {
  return createGmailCimProvider({ storage, config, fetcher: google.fetcher, now: () => new Date(at) });
}

function decodeRaw(raw) {
  assert.match(raw, /^[A-Za-z0-9_-]+$/, 'raw is base64url without padding');
  return Buffer.from(raw, 'base64url').toString('utf8');
}

/** Splits an RFC 5322 message into unfolded header lines. */
function headerLines(message) {
  const head = message.slice(0, message.indexOf('\r\n\r\n'));
  assert.doesNotMatch(head.replace(/\r\n/g, ''), /[\r\n]/, 'no bare CR or LF in the header block');
  return head.replace(/\r\n[ \t]/g, ' ').split('\r\n');
}

function header(message, name) {
  const prefix = `${name.toLowerCase()}:`;
  const lines = headerLines(message).filter((line) => line.toLowerCase().startsWith(prefix));
  return lines.map((line) => line.slice(prefix.length).trim());
}

function decodeEncodedWords(value) {
  return value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\s*/g,
    (_, data) => Buffer.from(data, 'base64').toString('utf8')).trim();
}

function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, 'no secret leaks');
}

const followUp = {
  transmissionId: 'tx-follow-1',
  to: { name: 'Broker Bob', address: 'bob@brokerage.com' },
  from: { name: 'Matt Uckele', address: 'owner@domain.com' },
  subject: 'Re: Acme Widgets',
  text: 'Hello again.',
  html: '<p>Hello again.</p>',
  threadId: '18c0ffee12345678',
  inReplyTo: '<tx-initial-1@domain.com>',
  references: ['<tx-initial-1@domain.com>'],
};

test('provider satisfies the CIM mail provider interface and is named gmail', (t) => {
  const storage = openStorage(t);
  const gmail = provider({ storage, config: makeConfig(), google: fakeGoogle() });
  assert.equal(assertCimMailProvider(gmail), gmail);
  assert.equal(gmail.name, 'gmail');
  assert.throws(() => assertCimMailProvider({ ...gmail, findSent: undefined }), /findSent/);
  assert.throws(() => assertCimMailProvider(null), /cim_mail_provider_invalid/);
});

test('send posts base64url raw with threadId for follow-ups and our Message-ID header', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  const google = fakeGoogle((call) => {
    if (call.url.href === `${API}/messages/send`) return json(200, { id: 'msg-200', threadId: followUp.threadId });
    return undefined;
  });
  const result = await provider({ storage, config, google }).send(followUp);

  assert.deepEqual(result, { outcome: 'accepted', messageId: 'msg-200', threadId: followUp.threadId,
    rfcMessageId: '<tx-follow-1@domain.com>', code: 'accepted' });
  assertNoSecrets(result);
  const [send] = google.gmailCalls();
  assert.equal(send.method, 'POST');
  assert.equal(send.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(send.headers['Content-Type'], 'application/json');
  assert.ok(send.signal instanceof AbortSignal);
  const body = JSON.parse(send.body);
  assert.deepEqual(Object.keys(body).sort(), ['raw', 'threadId']);
  assert.equal(body.threadId, followUp.threadId);
  const message = decodeRaw(body.raw);
  assert.deepEqual(header(message, 'Message-ID'), ['<tx-follow-1@domain.com>']);
  assert.deepEqual(header(message, 'In-Reply-To'), ['<tx-initial-1@domain.com>']);
  assert.deepEqual(header(message, 'References'), ['<tx-initial-1@domain.com>']);
  assert.deepEqual(header(message, 'From'), ['"Matt Uckele" <owner@domain.com>']);
  assert.deepEqual(header(message, 'To'), ['"Broker Bob" <bob@brokerage.com>']);
  assert.deepEqual(header(message, 'Subject'), ['Re: Acme Widgets']);
  assert.deepEqual(header(message, 'Date'), ['Tue, 03 Nov 2026 15:00:00 +0000']);
  assert.deepEqual(header(message, 'MIME-Version'), ['1.0']);
  assert.match(header(message, 'Content-Type')[0], /^multipart\/alternative; boundary="[^"]+"$/);
  const boundary = header(message, 'Content-Type')[0].match(/boundary="([^"]+)"/)[1];
  const parts = message.split(`--${boundary}`);
  assert.equal(parts.length, 4, 'preamble, two parts, closing delimiter');
  assert.ok(parts[3].startsWith('--'));
  const decodePart = (part) => Buffer.from(part.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64')
    .toString('utf8');
  assert.match(parts[1], /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64/);
  assert.equal(decodePart(parts[1]), 'Hello again.');
  assert.match(parts[2], /Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64/);
  assert.equal(decodePart(parts[2]), '<p>Hello again.</p>');

  const initialGoogle = fakeGoogle((call) => (call.url.pathname.endsWith('/messages/send')
    ? json(200, { id: 'msg-201', threadId: 'thread-new' }) : undefined));
  const initial = await provider({ storage, config, google: initialGoogle }).send({
    transmissionId: 'tx-initial-1', to: 'bob@brokerage.com', from: 'owner@domain.com',
    subject: 'Acme Widgets', text: 'Hello.',
  });
  assert.equal(initial.outcome, 'accepted');
  assert.equal(initial.threadId, 'thread-new');
  const initialBody = JSON.parse(initialGoogle.gmailCalls()[0].body);
  assert.deepEqual(Object.keys(initialBody), ['raw']);
  const initialMessage = decodeRaw(initialBody.raw);
  assert.deepEqual(header(initialMessage, 'Message-ID'), ['<tx-initial-1@domain.com>']);
  assert.deepEqual(header(initialMessage, 'In-Reply-To'), []);
  assert.deepEqual(header(initialMessage, 'References'), []);
  assert.deepEqual(header(initialMessage, 'Content-Type'), ['text/plain; charset=UTF-8']);
});

test('each status maps to the documented outcome', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  assert.equal(GMAIL_REQUEST_TIMEOUT_MS, 30_000);
  const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const cases = [
    [() => json(200, { id: 'msg-1', threadId: 'thread-1' }), 'accepted', 'accepted'],
    [() => json(400, { error: { code: 400, message: 'Invalid To header' } }), 'definitive-failure', 'gmail_400'],
    [() => json(404, { error: { code: 404, message: 'Requested entity was not found.' } }),
      'definitive-failure', 'gmail_404'],
    [() => json(403, { error: { code: 403, errors: [{ reason: 'forbidden' }] } }),
      'definitive-failure', 'gmail_403'],
    [() => json(429, { error: { code: 429, message: 'Too many requests' } }), 'quota', 'gmail_429'],
    [() => json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }),
      'not-attempted', 'gmail_token_invalid'],
    [() => json(403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }),
      'not-attempted', 'gmail_access_denied'],
    [() => json(403, { error: { code: 403, errors: [{ reason: 'authError' }] } }),
      'not-attempted', 'gmail_access_denied'],
    [() => json(403, { error: { code: 403, errors: [{ reason: 'domainPolicy' }] } }),
      'definitive-failure', 'gmail_403'],
    [() => json(500, { error: { code: 500, message: 'Backend Error' } }), 'ambiguous', 'gmail_500'],
    [() => json(503, { error: { code: 503 } }), 'ambiguous', 'gmail_503'],
    [() => new Response('<html>bad gateway</html>', { status: 502 }), 'ambiguous', 'gmail_502'],
    [() => json(200, { threadId: 'thread-1' }), 'ambiguous', 'gmail_response_invalid'],
    [() => new Response('not json', { status: 200 }), 'ambiguous', 'gmail_response_invalid'],
    [() => { throw new TypeError('fetch failed'); }, 'ambiguous', 'gmail_network_error'],
    [() => { throw timeoutError; }, 'ambiguous', 'gmail_timeout'],
  ];
  for (const [respond, outcome, code] of cases) {
    const google = fakeGoogle((call) => (call.url.pathname.endsWith('/messages/send') ? respond() : undefined));
    const result = await provider({ storage, config, google }).send({ ...followUp, threadId: undefined });
    assert.equal(result.outcome, outcome, code);
    assert.equal(result.code, code);
    assert.equal(result.rfcMessageId, '<tx-follow-1@domain.com>');
    if (outcome !== 'accepted') {
      assert.equal(result.messageId, null);
      assert.equal(result.threadId, null);
    }
    assertNoSecrets(result);
    assert.doesNotMatch(JSON.stringify(result), /Backend Error|bad gateway|Invalid To header|Invalid Credentials/);
  }
});

test('quota reasons map to quota, access reasons to not-attempted, other 403 to definitive-failure', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  const cases = [
    ['rateLimitExceeded', 'quota', 'gmail_403_rateLimitExceeded'],
    ['userRateLimitExceeded', 'quota', 'gmail_403_userRateLimitExceeded'],
    ['dailyLimitExceeded', 'quota', 'gmail_403_dailyLimitExceeded'],
    ['insufficientPermissions', 'not-attempted', 'gmail_access_denied'],
    ['authError', 'not-attempted', 'gmail_access_denied'],
    ['domainPolicy', 'definitive-failure', 'gmail_403'],
    [null, 'definitive-failure', 'gmail_403'],
  ];
  for (const [reason, outcome, code] of cases) {
    const body = { error: { code: 403, message: 'denied', errors: reason ? [{ domain: 'usageLimits', reason }] : [] } };
    const google = fakeGoogle((call) => (call.url.pathname.endsWith('/messages/send') ? json(403, body) : undefined));
    const result = await provider({ storage, config, google }).send(followUp);
    assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome, code }, String(reason));
  }
});

test('findSent finds by rfc822msgid and returns threadId', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  const google = fakeGoogle((call) => {
    if (call.url.pathname === '/gmail/v1/users/me/messages') {
      const q = call.url.searchParams.get('q');
      if (q === 'rfc822msgid:tx-follow-1@domain.com') {
        return json(200, { messages: [{ id: 'msg-found', threadId: 'ignored-list-thread' }], resultSizeEstimate: 1 });
      }
      return json(200, { resultSizeEstimate: 0 });
    }
    if (call.url.pathname === '/gmail/v1/users/me/messages/msg-found') {
      return json(200, { id: 'msg-found', threadId: 'thread-found' });
    }
    return undefined;
  });
  const gmail = provider({ storage, config, google });

  const found = await gmail.findSent({ rfcMessageId: '<tx-follow-1@domain.com>' });
  assert.deepEqual(found, { found: true, messageId: 'msg-found', threadId: 'thread-found' });
  const [search, get] = google.gmailCalls();
  assert.equal(search.method, 'GET');
  assert.equal(search.url.searchParams.get('includeSpamTrash'), 'false');
  assert.equal(search.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(get.url.searchParams.get('format'), 'minimal');

  assert.deepEqual(await gmail.findSent({ rfcMessageId: '<tx-missing@domain.com>' }), { found: false });

  const failing = fakeGoogle(() => json(500, { error: { message: 'Backend Error' } }));
  await assert.rejects(provider({ storage, config, google: failing }).findSent({
    rfcMessageId: '<tx-follow-1@domain.com>' }), (error) => {
    assert.equal(error.code, 'gmail_find_failed');
    assert.equal(error.message, 'gmail_find_failed');
    return true;
  });
  await assert.rejects(gmail.findSent({ rfcMessageId: 'tx\r\nBcc: x' }), { code: 'invalid_message' });
});

function gmailMessage(id, threadId, headers, extra = {}) {
  return {
    id, threadId, historyId: '205', internalDate: String(Date.parse('2026-11-03T14:30:00.000Z')),
    labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
    ...extra,
  };
}

test('listThreadChanges reads history filtered to threads with metadata headers, body prefix on request', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  const longBody = `${'a'.repeat(4090)}stop and more`;
  const google = fakeGoogle((call) => {
    const { pathname, searchParams } = call.url;
    if (pathname === '/gmail/v1/users/me/history') {
      if (!searchParams.get('pageToken')) {
        return json(200, { historyId: '210', nextPageToken: 'page-2', history: [
          { id: '201', messagesAdded: [{ message: { id: 'm-reply', threadId: 'thread-a' } }] },
          { id: '202', messagesAdded: [{ message: { id: 'm-other', threadId: 'thread-unrelated' } }] },
        ] });
      }
      return json(200, { historyId: '212', history: [
        { id: '203', messagesAdded: [{ message: { id: 'm-reply', threadId: 'thread-a' } }] },
        { id: '204', messagesAdded: [{ message: { id: 'm-gone', threadId: 'thread-b' } }] },
      ] });
    }
    if (pathname === '/gmail/v1/users/me/messages/m-reply') {
      if (searchParams.get('format') === 'full') {
        return json(200, gmailMessage('m-reply', 'thread-a', {}, { payload: { mimeType: 'multipart/alternative',
          headers: [], parts: [
            { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64url') } },
            { mimeType: 'text/plain', body: { data: Buffer.from(longBody).toString('base64url') } },
          ] } }));
      }
      return json(200, gmailMessage('m-reply', 'thread-a', {
        from: 'Broker Bob <bob@brokerage.com>', 'Message-ID': '<reply-1@brokerage.com>',
        'In-Reply-To': '<tx-initial-1@domain.com>', References: '<tx-initial-1@domain.com>',
        'Content-Type': 'text/plain; charset=UTF-8', Precedence: 'bulk',
      }));
    }
    if (pathname === '/gmail/v1/users/me/messages/m-gone') return json(404, { error: { code: 404 } });
    return undefined;
  });
  const gmail = provider({ storage, config, google });

  const result = await gmail.listThreadChanges({ checkpoint: '200', threadIds: ['thread-a', 'thread-b'] });
  assert.deepEqual(result, {
    checkpointExpired: false,
    nextCheckpoint: '212',
    messages: [{
      id: 'm-reply', threadId: 'thread-a', historyId: '205', internalDate: '2026-11-03T14:30:00.000Z',
      labelIds: ['INBOX'],
      headers: {
        from: 'Broker Bob <bob@brokerage.com>', messageId: '<reply-1@brokerage.com>',
        inReplyTo: '<tx-initial-1@domain.com>', references: '<tx-initial-1@domain.com>',
        autoSubmitted: null, xAutoreply: null, xAutorespond: null, precedence: 'bulk',
        contentType: 'text/plain; charset=UTF-8',
      },
    }],
  });
  const calls = google.gmailCalls();
  const historyCall = calls[0];
  assert.equal(historyCall.url.searchParams.get('startHistoryId'), '200');
  assert.equal(historyCall.url.searchParams.get('historyTypes'), 'messageAdded');
  const metadataCall = calls.find((call) => call.url.pathname.endsWith('/m-reply'));
  assert.equal(metadataCall.url.searchParams.get('format'), 'metadata');
  assert.deepEqual(metadataCall.url.searchParams.getAll('metadataHeaders'), METADATA_HEADERS);
  assert.equal(calls.some((call) => call.url.searchParams.get('format') === 'full'), false);
  assert.equal(calls.some((call) => call.url.pathname.endsWith('/m-other')), false);

  const withBody = await gmail.listThreadChanges({ checkpoint: '200', threadIds: ['thread-a'], withBodyPrefix: true });
  assert.equal(withBody.messages.length, 1);
  assert.equal(withBody.messages[0].bodyPrefix, longBody.slice(0, 4096));
  assert.equal(withBody.messages[0].bodyPrefix.length, 4096);
  assert.equal(withBody.messages[0].headers.messageId, '<reply-1@brokerage.com>');
});

test('history 404 sets checkpointExpired', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  const google = fakeGoogle((call) => {
    const { pathname, searchParams } = call.url;
    if (pathname === '/gmail/v1/users/me/history') return json(404, { error: { code: 404, message: 'Not Found' } });
    if (pathname === '/gmail/v1/users/me/profile') return json(200, { emailAddress: 'owner@domain.com', historyId: '900' });
    if (pathname === '/gmail/v1/users/me/threads/thread-a') {
      assert.equal(searchParams.get('format'), 'metadata');
      assert.deepEqual(searchParams.getAll('metadataHeaders'), METADATA_HEADERS);
      return json(200, { id: 'thread-a', messages: [
        gmailMessage('m-ours', 'thread-a', { From: 'owner@domain.com', 'Message-ID': '<tx-initial-1@domain.com>' }),
        gmailMessage('m-reply', 'thread-a', { From: 'bob@brokerage.com', 'Message-ID': '<reply-1@brokerage.com>' }),
      ] });
    }
    if (pathname === '/gmail/v1/users/me/threads/thread-gone') return json(404, { error: { code: 404 } });
    return undefined;
  });

  const result = await provider({ storage, config, google }).listThreadChanges({
    checkpoint: '1', threadIds: ['thread-a', 'thread-gone'] });
  assert.equal(result.checkpointExpired, true);
  assert.equal(result.nextCheckpoint, '900');
  assert.deepEqual(result.messages.map((message) => [message.id, message.headers.messageId]),
    [['m-ours', '<tx-initial-1@domain.com>'], ['m-reply', '<reply-1@brokerage.com>']]);
  const paths = google.gmailCalls().map((call) => call.url.pathname);
  assert.ok(paths.indexOf('/gmail/v1/users/me/profile') < paths.indexOf('/gmail/v1/users/me/threads/thread-a'),
    'the new checkpoint is read before the threads so nothing is missed');

  const broken = fakeGoogle(() => json(500, { error: { message: 'Backend Error' } }));
  await assert.rejects(provider({ storage, config, google: broken }).listThreadChanges({
    checkpoint: '1', threadIds: ['thread-a'] }), { message: 'gmail_history_failed' });
});

test('invalid_grant makes readiness report gmail_token_invalid and send returns not-attempted without calling messages.send', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config, { tokenOkAt: '2026-11-03T14:59:00.000Z' });
  const google = fakeGoogle((call) => (call.url.pathname.endsWith('/messages/send')
    ? json(200, { id: 'never', threadId: 'never' }) : undefined), { refresh: 'invalid_grant' });
  const gmail = provider({ storage, config, google });

  const result = await gmail.send(followUp);
  assert.deepEqual(result, { outcome: 'not-attempted', messageId: null, threadId: null,
    rfcMessageId: '<tx-follow-1@domain.com>', code: 'gmail_token_invalid' });
  assert.equal(google.gmailCalls().length, 0, 'messages.send was never called');
  assert.equal((await storage.getGmailConnection()).last_error_code, 'gmail_token_invalid');

  const readiness = await gmail.readiness();
  assert.deepEqual(readiness, { ready: false, reasons: ['gmail_token_invalid'] });
  assertNoSecrets(readiness);
  assertNoSecrets(result);
  assert.equal(google.gmailCalls().length, 0);
});

test('send is not-attempted when the token refresh fails or Gmail is not connected', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  const route = (call) => (call.url.pathname.endsWith('/messages/send') ? json(200, { id: 'x', threadId: 'y' }) : undefined);

  const notConnected = fakeGoogle(route);
  assert.deepEqual(await provider({ storage, config, google: notConnected }).send(followUp), {
    outcome: 'not-attempted', messageId: null, threadId: null, rfcMessageId: '<tx-follow-1@domain.com>',
    code: 'gmail_not_connected' });
  assert.equal(notConnected.calls.length, 0);

  await connect(storage, config);
  for (const refresh of ['network', '503']) {
    const google = fakeGoogle(route, { refresh });
    const result = await provider({ storage, config, google }).send(followUp);
    assert.deepEqual([result.outcome, result.code], ['not-attempted', 'gmail_token_refresh_failed'], refresh);
    assert.equal(google.gmailCalls().length, 0);
  }

  const unconfigured = makeConfig({ senderAddress: '' });
  const google = fakeGoogle(route);
  const result = await provider({ storage, config: unconfigured, google }).send(followUp);
  assert.deepEqual([result.outcome, result.code], ['not-attempted', 'gmail_not_connected']);
  assert.equal(google.calls.length, 0);
});

test('readiness reports connection, address and token reasons', async (t) => {
  const storage = openStorage(t);
  const config = makeConfig();
  const google = fakeGoogle();
  const gmail = provider({ storage, config, google });
  assert.deepEqual(await gmail.readiness(), { ready: false, reasons: ['gmail_not_connected'] });

  await connect(storage, config, { emailAddress: 'OWNER@domain.com', tokenOkAt: '2026-11-03T14:50:00.000Z' });
  assert.deepEqual(await gmail.readiness(), { ready: true, reasons: [] }, 'address match ignores case');
  assert.equal(google.calls.length, 0, 'a token check within 15 minutes is reused');

  await storage.recordGmailTokenCheck({ ok: true, now: '2026-11-03T14:40:00.000Z' });
  assert.deepEqual(await gmail.readiness(), { ready: true, reasons: [] });
  assert.equal(google.calls.length, 1, 'an older check refreshes now');
  assert.equal((await storage.getGmailConnection()).last_token_ok_at, at);

  await storage.recordGmailTokenCheck({ ok: true, now: '2026-11-03T14:00:00.000Z' });
  const failing = provider({ storage, config, google: fakeGoogle(undefined, { refresh: 'network' }) });
  assert.deepEqual(await failing.readiness(), { ready: false, reasons: ['gmail_token_refresh_failed'] });

  await connect(storage, config, { emailAddress: 'someone-else@domain.com', tokenOkAt: at });
  assert.deepEqual(await gmail.readiness(), { ready: false, reasons: ['gmail_address_mismatch'] });
});

test('subject and display names with non-ASCII are RFC 2047 encoded; CR, LF, <, > in names or subject cannot add a header', async (t) => {
  const subject = 'Café Größe — 東京 Holdings, Inc.\r\nBcc: evil@attacker.com';
  const message = buildRfc5322Message({
    from: { name: 'Matt "The Owner" Uckele', address: 'owner@domain.com' },
    to: { name: 'José <evil@attacker.com>\r\nBcc: evil@attacker.com', address: 'jose@brokerage.com' },
    subject,
    text: 'Body\nwith a line',
    messageId: '<tx-1@domain.com>',
    date: new Date(at),
  });
  const lines = headerLines(message);
  assert.deepEqual(lines.map((line) => line.split(':')[0]),
    ['From', 'To', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
  assert.equal(lines.some((line) => /^bcc:/i.test(line)), false);
  for (const line of message.slice(0, message.indexOf('\r\n\r\n')).split('\r\n')) {
    assert.ok(line.length <= 78, `header line folded: ${line}`);
    assert.match(line, /^[\x20-\x7e]*$/, 'header lines are printable ASCII');
  }

  const [encodedSubject] = header(message, 'Subject');
  assert.match(encodedSubject, /^=\?UTF-8\?B\?/);
  assert.equal(decodeEncodedWords(encodedSubject), 'Café Größe — 東京 Holdings, Inc. Bcc: evil@attacker.com');
  assert.deepEqual(header(message, 'From'), ['"Matt The Owner Uckele" <owner@domain.com>']);
  const [to] = header(message, 'To');
  assert.match(to, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)* <jose@brokerage\.com>$/);
  assert.equal(decodeEncodedWords(to.replace(/ <jose@brokerage\.com>$/, '')),
    'José evil@attacker.com Bcc: evil@attacker.com');

  const ascii = buildRfc5322Message({ from: 'owner@domain.com', to: 'bob@brokerage.com',
    subject: 'Acme <Widgets>\u0000\u001b\nX-Injected: yes', text: 'Hi', messageId: '<tx-2@domain.com>' });
  assert.deepEqual(header(ascii, 'Subject'), ['Acme <Widgets> X-Injected: yes']);
  assert.deepEqual(header(ascii, 'X-Injected'), []);

  const base = { from: 'owner@domain.com', to: 'bob@brokerage.com', subject: 'S', text: 'T',
    messageId: '<tx-3@domain.com>' };
  for (const bad of [
    { to: 'bob@brokerage.com\r\nBcc: evil@attacker.com' },
    { to: { name: 'Bob', address: 'bob@brokerage.com>' } },
    { from: '<owner@domain.com>' },
    { messageId: '<tx-3@domain.com>\r\nBcc: evil@attacker.com' },
    { inReplyTo: '<a@b.com> <c@d.com>' },
    { references: ['<a@b.com>', 'x\r\nBcc: evil@attacker.com'] },
    { text: '' },
  ]) {
    assert.throws(() => buildRfc5322Message({ ...base, ...bad }), { code: 'invalid_message' }, JSON.stringify(bad));
  }

  const storage = openStorage(t);
  const config = makeConfig();
  await connect(storage, config);
  const google = fakeGoogle((call) => (call.url.pathname.endsWith('/messages/send')
    ? json(200, { id: 'm', threadId: 't' }) : undefined));
  const gmail = provider({ storage, config, google });
  const injected = await gmail.send({ ...followUp, to: 'bob@brokerage.com\r\nBcc: evil@attacker.com' });
  assert.deepEqual([injected.outcome, injected.code], ['definitive-failure', 'invalid_message']);
  const badTransmission = await gmail.send({ ...followUp, transmissionId: 'tx>\r\nBcc: x' });
  assert.deepEqual([badTransmission.outcome, badTransmission.code, badTransmission.rfcMessageId],
    ['definitive-failure', 'invalid_message', null]);
  const badThread = await gmail.send({ ...followUp, threadId: 'thread\r\n' });
  assert.deepEqual([badThread.outcome, badThread.code], ['definitive-failure', 'invalid_message']);
  assert.equal(google.calls.length, 0, 'nothing reaches Google for an invalid message');

  const sent = await gmail.send({ ...followUp, subject, to: { name: 'José', address: 'jose@brokerage.com' } });
  assert.equal(sent.outcome, 'accepted');
  const raw = decodeRaw(JSON.parse(google.gmailCalls()[0].body).raw);
  assert.equal(decodeEncodedWords(header(raw, 'Subject')[0]),
    'Café Größe — 東京 Holdings, Inc. Bcc: evil@attacker.com');
  assert.deepEqual(header(raw, 'Bcc'), []);
});
