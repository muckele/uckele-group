import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EMAIL_SIGNATURE_MAX_INPUT_CHARS } from '../server/services/emailSignatureHtml.js';
import { createFakeCimProvider } from '../server/services/fakeCimProvider.js';
import {
  pursueSignatureView,
  refreshPursueEmailSignature,
  usablePursueSignature,
} from '../server/services/pursueEmailSignature.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sha256 } from '../server/utils/security.js';
import { GMAIL_SIGNATURE_FIXTURE_HTML, GMAIL_SIGNATURE_FIXTURE_TEXT } from './fixtures/gmailSignatureFixture.js';

const SENDER = 'pat@example.com';
const at = '2026-11-13T15:00:00.000Z';
const later = '2026-11-13T16:00:00.000Z';
const config = { dealHunter: { gmail: { senderAddress: 'Pat@Example.com' }, sender: { name: 'Pat Example' } } };

function sqliteStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-signature-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'storage.sqlite') },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  return storage;
}

function capturingLogger() {
  const lines = [];
  return { lines, warn: (...args) => lines.push(JSON.stringify(args)) };
}

test('a refresh stores the sanitized signature, its text and digest', async (t) => {
  const storage = sqliteStorage(t);
  const mailProvider = createFakeCimProvider({ senderAddress: SENDER });
  mailProvider.setSignature(GMAIL_SIGNATURE_FIXTURE_HTML);
  const logger = capturingLogger();
  const result = await refreshPursueEmailSignature({ storage, config, now: at, mailProvider, logger });
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.equal(result.changed, true);
  const stored = await storage.getGmailSignature();
  assert.equal(stored.sendAsEmail, SENDER);
  assert.equal(stored.fetchedAt, at);
  assert.equal(stored.text, GMAIL_SIGNATURE_FIXTURE_TEXT);
  assert.equal(stored.digest, sha256(stored.html));
  assert.ok(!stored.html.includes('onclick'));
  assert.ok(stored.html.includes('<a href="mailto:pat@example.com">'));
  assert.deepEqual(result.signature, stored);
  assert.equal(logger.lines.length, 0);

  // The same signature again is not a change.
  const again = await refreshPursueEmailSignature({ storage, config, now: later, mailProvider, logger });
  assert.equal(again.changed, false);
  assert.deepEqual(usablePursueSignature(await storage.getGmailSignature(), config),
    { html: stored.html, text: stored.text, digest: stored.digest });
});

test('a failed refresh keeps the stored signature, records the code and logs one line', async (t) => {
  const storage = sqliteStorage(t);
  const mailProvider = createFakeCimProvider({ senderAddress: SENDER });
  await refreshPursueEmailSignature({ storage, config, now: at, mailProvider, logger: capturingLogger() });
  const before = await storage.getGmailSignature();

  const failures = [
    [() => mailProvider.failSignatureNext('gmail_503'), 'gmail_503'],
    [() => mailProvider.failSignatureNext('Not A Code'), 'gmail_signature_read_failed'],
    [() => { mailProvider.readSignature = async () => { throw new Error('refresh-token-SECRET'); }; },
      'gmail_signature_read_failed'],
  ];
  for (const [arrange, code] of failures) {
    arrange();
    const logger = capturingLogger();
    const result = await refreshPursueEmailSignature({ storage, config, now: later, mailProvider, logger,
      source: 'test' });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    const after = await storage.getGmailSignature();
    assert.deepEqual({ ...after, lastAttemptAt: before.lastAttemptAt, lastErrorCode: null }, before);
    assert.equal(after.lastErrorCode, code);
    assert.equal(after.lastAttemptAt, later);
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], new RegExp(code));
    assert.doesNotMatch(logger.lines[0], /SECRET/);
  }
});

test('a refresh never throws, even when storage fails', async (t) => {
  const storage = sqliteStorage(t);
  const failing = new Proxy(storage, { get(target, name) {
    if (name === 'recordGmailSignatureRefresh' || name === 'getGmailSignature') {
      return async () => { throw new Error('database unavailable'); };
    }
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const logger = capturingLogger();
  const result = await refreshPursueEmailSignature({ storage: failing, config, now: at,
    mailProvider: createFakeCimProvider({ senderAddress: SENDER }), logger });
  assert.deepEqual(result, { ok: false, code: 'gmail_signature_store_failed', signature: null });
  assert.equal(logger.lines.length, 1);
});

test('an oversized signature is stored empty with a clear code, which blocks sending', async (t) => {
  const storage = sqliteStorage(t);
  const mailProvider = createFakeCimProvider({ senderAddress: SENDER });
  mailProvider.setSignature(`<div>${'x'.repeat(EMAIL_SIGNATURE_MAX_INPUT_CHARS)}</div>`);
  const logger = capturingLogger();
  const result = await refreshPursueEmailSignature({ storage, config, now: at, mailProvider, logger });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'gmail_signature_too_large');
  const stored = await storage.getGmailSignature();
  assert.equal(stored.html, '');
  assert.equal(stored.lastErrorCode, 'gmail_signature_too_large');
  assert.equal(usablePursueSignature(stored, config), null);
  assert.deepEqual(pursueSignatureView(stored, config), { loaded: true, empty: true, fetchedAt: at,
    sendAsEmail: SENDER, lastAttemptAt: at, lastErrorCode: 'gmail_signature_too_large' });
  assert.equal(logger.lines.length, 1);
});

test('the view and the usable signature only count a snapshot read for the configured address', () => {
  const snapshot = { loaded: true, sendAsEmail: 'pat@example.com', html: '<b>Pat</b>', text: 'Pat',
    digest: sha256('<b>Pat</b>'), fetchedAt: at, lastAttemptAt: at, lastErrorCode: null };
  assert.ok(usablePursueSignature(snapshot, config));
  const other = { dealHunter: { gmail: { senderAddress: 'someone@example.com' } } };
  assert.equal(usablePursueSignature(snapshot, other), null);
  assert.deepEqual(pursueSignatureView(snapshot, other), { loaded: false, empty: false, fetchedAt: null,
    sendAsEmail: null, lastAttemptAt: at, lastErrorCode: null });
  assert.deepEqual(pursueSignatureView(null, config), { loaded: false, empty: false, fetchedAt: null,
    sendAsEmail: null, lastAttemptAt: null, lastErrorCode: null });
  assert.equal(usablePursueSignature({ ...snapshot, loaded: false }, config), null);
});
