import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  createNodePinnedHttpsExchange,
  isScannerPreconnectionRefusedError,
  isScannerWorkerDeadlineError,
} from '../server/services/nodePinnedHttpsExchange.js';

class FakeRequest extends EventEmitter {
  constructor(events, respond) {
    super();
    this.events = events;
    this.respond = respond;
    this.destroyed = false;
  }

  flushHeaders() { this.events.push(['flush']); }

  write(chunk, callback) {
    this.events.push(['write', Buffer.from(chunk).toString('utf8')]);
    callback();
    return true;
  }

  end() {
    this.events.push(['end']);
    this.respond({
      statusCode: 200,
      body: 'signed-result',
      async *[Symbol.asyncIterator]() { yield Buffer.from(this.body); },
      destroy: () => { this.events.push(['response-destroy']); },
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.push(['destroy']);
  }
}

function setup() {
  const events = [];
  let requestOptions;
  let requestUrl;
  let request;
  const openExchange = createNodePinnedHttpsExchange({
    machineId: 'machine-1',
    appName: 'ug-scanner',
    port: 8443,
    monotonicNow: () => performance.now(),
    requestImpl(url, options, respond) {
      requestUrl = url;
      requestOptions = options;
      request = new FakeRequest(events, respond);
      return request;
    },
  });
  return {
    events,
    openExchange,
    request: () => request,
    requestOptions: () => requestOptions,
    requestUrl: () => requestUrl,
  };
}

function exchangeCommand(pin, overrides = {}) {
  return {
    endpoint: 'https://machine-1.vm.ug-scanner.internal:8443/v1/cim-scan',
    method: 'POST',
    redirects: 'error',
    certificatePinSha256: pin,
    headers: Object.freeze({
      'content-type': 'application/octet-stream',
      'content-length': '3',
      expect: '100-continue',
      'x-cim-scan-request': 'request-envelope',
    }),
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
    ...overrides,
  };
}

test('HTTPS exchange pins one exact Machine hostname, SNI, and SPKI identity', async () => {
  const fixture = setup();
  const publicKey = Buffer.from('synthetic-spki-der');
  const pin = createHash('sha256').update(publicKey).digest('hex');
  const exchange = await fixture.openExchange(exchangeCommand(pin));

  assert.equal(fixture.requestUrl().toString(),
    'https://machine-1.vm.ug-scanner.internal:8443/v1/cim-scan');
  assert.equal(fixture.requestOptions().servername, 'machine-1.vm.ug-scanner.internal');
  assert.equal(fixture.requestOptions().rejectUnauthorized, true);
  assert.equal(fixture.requestOptions().minVersion, 'TLSv1.2');
  assert.equal(fixture.requestOptions().checkServerIdentity(
    'machine-1.vm.ug-scanner.internal',
    { subjectaltname: 'DNS:machine-1.vm.ug-scanner.internal', pubkey: publicKey },
  ), undefined);
  assert.match(fixture.requestOptions().checkServerIdentity(
    'machine-1.vm.ug-scanner.internal',
    { subjectaltname: 'DNS:machine-1.vm.ug-scanner.internal', pubkey: Buffer.from('wrong') },
  ).message, /pin|identity/i);
  assert.match(fixture.requestOptions().checkServerIdentity(
    'other.vm.ug-scanner.internal',
    { subjectaltname: 'DNS:machine-1.vm.ug-scanner.internal', pubkey: publicKey },
  ).message, /identity|hostname|name/i);
  exchange.abort();
});

test('HTTPS exchange waits for admission before writing the bounded body', async () => {
  const fixture = setup();
  const pin = createHash('sha256').update(Buffer.from('key')).digest('hex');
  const exchange = await fixture.openExchange(exchangeCommand(pin));
  assert.deepEqual(fixture.events, [['flush']]);

  const admission = exchange.awaitAdmission({
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  });
  assert.equal(fixture.events.some(([name]) => name === 'write'), false);
  fixture.request().emit('continue');
  assert.deepEqual(await admission, { status: 100 });

  await exchange.write(Buffer.from('abc'), {
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  });
  const response = await exchange.finish({
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  });
  assert.equal(response.status, 200);
  assert.equal(Buffer.concat([...(await Array.fromAsync(response.body))]).toString(), 'signed-result');
  assert.deepEqual(fixture.events.map(([name]) => name), ['flush', 'write', 'end']);
});

test('HTTPS exchange returns an early final status without admitting or writing a body', async () => {
  const fixture = setup();
  const pin = 'a'.repeat(64);
  const exchange = await fixture.openExchange(exchangeCommand(pin));
  const admission = exchange.awaitAdmission({
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  });
  const incoming = { statusCode: 403, destroy() {} };
  fixture.request().respond(incoming);
  assert.deepEqual(await admission, { status: 403, body: incoming });
  assert.equal(fixture.events.some(([name]) => name === 'write'), false);
  exchange.abort();
});

test('HTTPS exchange types only an exact post-admission worker deadline response', async () => {
  for (const statusCode of [408, 500]) {
    const fixture = setup();
    const exchange = await fixture.openExchange(exchangeCommand('a'.repeat(64)));
    const admission = exchange.awaitAdmission({
      signal: new AbortController().signal,
      deadlineAt: performance.now() + 1_000,
    });
    fixture.request().emit('continue');
    assert.deepEqual(await admission, { status: 100 });
    fixture.request().respond({ statusCode, destroy() {} });
    await assert.rejects(exchange.write(Buffer.from('x'), {
      signal: new AbortController().signal,
      deadlineAt: performance.now() + 1_000,
    }), (error) => isScannerWorkerDeadlineError(error) === (statusCode === 408));
  }
});

test('HTTPS exchange rejects alternate endpoints before transport access', async () => {
  const fixture = setup();
  for (const endpoint of [
    'https://ug-scanner.internal/v1/cim-scan',
    'https://other.vm.ug-scanner.internal/v1/cim-scan',
    'https://machine-1.vm.ug-scanner.internal/other',
    'https://machine-1.vm.ug-scanner.internal/v1/cim-scan',
    'https://machine-1.vm.ug-scanner.internal:443/v1/cim-scan',
    'https://machine-1.vm.ug-scanner.internal:444/v1/cim-scan',
    'http://machine-1.vm.ug-scanner.internal/v1/cim-scan',
  ]) {
    await assert.rejects(fixture.openExchange(exchangeCommand('a'.repeat(64), { endpoint })),
      /exact|endpoint|Machine/i);
  }
  assert.equal(fixture.request(), undefined);
});

test('HTTPS exchange aborts stalled admission at the exact local deadline with redacted errors', async () => {
  const fixture = setup();
  const exchange = await fixture.openExchange(exchangeCommand('a'.repeat(64)));
  await assert.rejects(exchange.awaitAdmission({
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 10,
  }), (error) => /deadline|aborted/i.test(error.message)
    && !error.message.includes('synthetic-spki'));
  assert.equal(fixture.request().destroyed, true);
  assert.equal(fixture.events.filter(([name]) => name === 'destroy').length, 1);
});

test('HTTPS exchange makes an admitted request unusable after a transport error', async () => {
  const fixture = setup();
  const exchange = await fixture.openExchange(exchangeCommand('a'.repeat(64)));
  const admission = exchange.awaitAdmission({
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  });
  fixture.request().emit('continue');
  assert.deepEqual(await admission, { status: 100 });
  fixture.request().emit('error', new Error('raw transport detail'));

  await assert.rejects(exchange.write(Buffer.from('abc'), {
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  }), (error) => /not admitted|failed|current state/i.test(error.message)
    && !error.message.includes('raw transport detail'));
  assert.equal(fixture.events.some(([name]) => name === 'write'), false);
  assert.equal(fixture.events.filter(([name]) => name === 'destroy').length, 1);
});

test('HTTPS exchange marks only a refused TCP preconnection as retryable readiness', async () => {
  const fixture = setup();
  const exchange = await fixture.openExchange(exchangeCommand('a'.repeat(64)));
  const admission = exchange.awaitAdmission({
    signal: new AbortController().signal,
    deadlineAt: performance.now() + 1_000,
  });
  const refused = Object.assign(new Error('raw refused detail'), { code: 'ECONNREFUSED' });
  fixture.request().emit('error', refused);
  await assert.rejects(admission, (error) => isScannerPreconnectionRefusedError(error)
    && !error.message.includes('raw refused detail'));
  assert.deepEqual(fixture.events.map(([name]) => name), ['flush', 'destroy']);
});

test('HTTPS exchange never marks connected, TLS, certificate, or ambiguous failures retryable', async () => {
  for (const scenario of [
    { socketEvents: ['connect'], code: 'ECONNREFUSED' },
    { socketEvents: ['connect', 'secureConnect'], code: 'ECONNREFUSED' },
    { socketEvents: [], code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    { socketEvents: [], code: 'ECONNRESET' },
  ]) {
    const fixture = setup();
    const exchange = await fixture.openExchange(exchangeCommand('a'.repeat(64)));
    const admission = exchange.awaitAdmission({
      signal: new AbortController().signal,
      deadlineAt: performance.now() + 1_000,
    });
    const socket = new EventEmitter();
    fixture.request().emit('socket', socket);
    for (const event of scenario.socketEvents) socket.emit(event);
    fixture.request().emit('error', Object.assign(new Error('raw transport detail'), {
      code: scenario.code,
    }));
    await assert.rejects(admission, (error) => !isScannerPreconnectionRefusedError(error)
      && /exchange failed/i.test(error.message)
      && !error.message.includes('raw transport detail'));
  }
});

test('HTTPS exchange import and construction have no network side effects or default transport', async () => {
  let calls = 0;
  assert.throws(() => createNodePinnedHttpsExchange({
    machineId: 'machine-1', appName: 'ug-scanner',
    port: 8443,
    monotonicNow: () => performance.now(),
  }), /injected.*request/i);
  assert.throws(() => createNodePinnedHttpsExchange({
    machineId: 'machine-1', appName: 'ug-scanner',
    monotonicNow: () => performance.now(),
    requestImpl() {},
  }), /port/i);
  assert.throws(() => createNodePinnedHttpsExchange({
    machineId: 'machine-1', appName: 'ug-scanner', port: 443,
    monotonicNow: () => performance.now(),
    requestImpl() {},
  }), /port/i);
  const openExchange = createNodePinnedHttpsExchange({
    machineId: 'machine-1', appName: 'ug-scanner',
    port: 8443,
    monotonicNow: () => performance.now(),
    requestImpl() { calls += 1; throw new Error('must not be called during construction'); },
  });
  assert.equal(typeof openExchange, 'function');
  assert.equal(calls, 0);
});
