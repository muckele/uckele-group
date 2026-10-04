import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createCimScanWorkerHttpRuntime,
  loadCimScanWorkerHttpConfig,
} from '../server/services/cimScanWorkerHttpRuntime.js';

const environment = Object.freeze({
  CIM_SCAN_KEY_ID: 'synthetic-key-1',
  CIM_SCAN_KEY_FILE: '/run/secrets/cim-scan-protocol-key',
  CIM_SCAN_TLS_CERT_FILE: '/run/secrets/cim-scan-tls-cert',
  CIM_SCAN_TLS_KEY_FILE: '/run/secrets/cim-scan-tls-key',
  CIM_SCAN_REPLAY_ROOT: '/data/replay',
  CIM_SCAN_EPHEMERAL_ROOT: '/run/cim-scan-tasks',
  CLAMAV_UNIX_SOCKET: '/run/clamav/clamd.sock',
});

class FakeHttpsServer extends EventEmitter {
  constructor(options, requestListener) {
    super();
    this.options = options;
    this.requestListener = requestListener;
    this.listenCalls = [];
    this.closeCalls = 0;
  }

  listen(port, host, callback) {
    this.listenCalls.push({ port, host });
    callback();
  }

  close(callback) {
    this.closeCalls += 1;
    callback();
  }
}

test('HTTP worker runtime configuration requires every explicit path and forbids TCP or clock activation', () => {
  assert.deepEqual(loadCimScanWorkerHttpConfig(environment), {
    keyId: environment.CIM_SCAN_KEY_ID,
    keyFile: environment.CIM_SCAN_KEY_FILE,
    tlsCertFile: environment.CIM_SCAN_TLS_CERT_FILE,
    tlsKeyFile: environment.CIM_SCAN_TLS_KEY_FILE,
    replayRoot: environment.CIM_SCAN_REPLAY_ROOT,
    ephemeralRoot: environment.CIM_SCAN_EPHEMERAL_ROOT,
    clamavSocketPath: environment.CLAMAV_UNIX_SOCKET,
  });
  for (const field of [
    'CIM_SCAN_KEY_FILE', 'CIM_SCAN_TLS_CERT_FILE', 'CIM_SCAN_TLS_KEY_FILE',
    'CIM_SCAN_REPLAY_ROOT', 'CIM_SCAN_EPHEMERAL_ROOT', 'CLAMAV_UNIX_SOCKET',
  ]) {
    assert.throws(() => loadCimScanWorkerHttpConfig({ ...environment, [field]: undefined }),
      /absolute|path/i, field);
  }
  assert.throws(() => loadCimScanWorkerHttpConfig({ ...environment, CLAMAV_HOST: '127.0.0.1' }),
    /TCP/i);
  assert.throws(() => loadCimScanWorkerHttpConfig({ ...environment, CLAMAV_PORT: '3310' }),
    /TCP/i);
  assert.throws(() => loadCimScanWorkerHttpConfig({
    ...environment, CIM_SCAN_BENCHMARK_CLOCK_OFFSET_MS: '90000000',
  }), /clock|benchmark/i);
  for (const field of [
    'CIM_SCAN_BENCHMARK_FAULT_MODE',
    'CIM_SCAN_BENCHMARK_AFTER_COPY',
    'CIM_SCAN_BENCHMARK_AFTER_SCAN',
    'CIM_SCAN_BENCHMARK_CLEANUP_REFUSAL',
  ]) {
    assert.throws(() => loadCimScanWorkerHttpConfig({ ...environment, [field]: '1' }),
      /benchmark/i, field);
  }
});

test('HTTP worker runtime builds one TLS composition and binds only private port 8443', async () => {
  const reads = [];
  const servers = [];
  let compositionCalls = 0;
  let handled = 0;
  const protocolNow = () => new Date('2026-10-03T12:00:00.000Z');
  const signatureNow = () => new Date('2026-10-04T13:00:00.000Z');
  const runtime = await createCimScanWorkerHttpRuntime({
    config: loadCimScanWorkerHttpConfig(environment),
    now: protocolNow,
    signatureNow,
    async readFile(file, options) {
      reads.push({ file, options });
      if (file === environment.CIM_SCAN_KEY_FILE) return Buffer.alloc(32, 7);
      return Buffer.from(file.includes('cert') ? 'synthetic-cert' : 'synthetic-private-key');
    },
    createHttpsServer(options, requestListener) {
      const server = new FakeHttpsServer(options, requestListener);
      servers.push(server);
      return server;
    },
    createReplayStore: ({ root }) => ({ root, claim() {}, complete() {} }),
    createScanner: ({ socketPath }) => ({ socketPath, health() {}, scan() {} }),
    createWorkerComposition(options) {
      compositionCalls += 1;
      assert.equal(options.replayStore.root, environment.CIM_SCAN_REPLAY_ROOT);
      assert.equal(options.scanner.socketPath, environment.CLAMAV_UNIX_SOCKET);
      assert.equal(options.keyResolver('synthetic-key-1').length, 32);
      assert.equal(options.keyResolver('other'), null);
      assert.equal(options.now, protocolNow);
      assert.equal(options.signatureNow, signatureNow);
      return { async handleCheckContinue() { handled += 1; } };
    },
  });

  assert.equal(compositionCalls, 1);
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0].options, {
    key: Buffer.from('synthetic-private-key'),
    cert: Buffer.from('synthetic-cert'),
    minVersion: 'TLSv1.2',
    maxHeaderSize: 32 * 1024,
  });
  assert.equal(servers[0].headersTimeout, 15_000);
  assert.equal(servers[0].requestTimeout, 95_000);
  assert.equal(servers[0].keepAliveTimeout, 1_000);
  assert.equal(servers[0].maxRequestsPerSocket, 1);
  assert.deepEqual(reads.map(({ file }) => file), [
    environment.CIM_SCAN_KEY_FILE,
    environment.CIM_SCAN_TLS_CERT_FILE,
    environment.CIM_SCAN_TLS_KEY_FILE,
  ]);

  await runtime.start();
  assert.deepEqual(servers[0].listenCalls, [{ port: 8443, host: 'fly-local-6pn' }]);
  servers[0].emit('checkContinue', {}, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, 1);

  let status;
  let ended = false;
  let destroyed = false;
  servers[0].requestListener({ destroy() { destroyed = true; } }, {
    writeHead(value, headers) { status = { value, headers }; },
    end() { ended = true; },
  });
  assert.deepEqual(status, {
    value: 417,
    headers: { 'cache-control': 'no-store', connection: 'close', 'content-length': '0' },
  });
  assert.equal(ended, true);
  assert.equal(destroyed, true);

  let clientDestroyed = false;
  servers[0].emit('clientError', new Error('secret detail'), { destroy() { clientDestroyed = true; } });
  assert.equal(clientDestroyed, true);
  await runtime.close();
  assert.equal(servers[0].closeCalls, 1);
});

test('HTTP worker runtime construction is inert and start is single-use', async () => {
  let listenCalls = 0;
  const runtime = await createCimScanWorkerHttpRuntime({
    config: loadCimScanWorkerHttpConfig(environment),
    now: () => new Date(),
    async readFile(file) {
      return file === environment.CIM_SCAN_KEY_FILE ? Buffer.alloc(32, 1) : Buffer.from('fixture');
    },
    createHttpsServer() {
      const server = new FakeHttpsServer({}, () => {});
      server.listen = (_port, _host, callback) => { listenCalls += 1; callback(); };
      return server;
    },
    createReplayStore: () => ({ claim() {}, complete() {} }),
    createScanner: () => ({ health() {}, scan() {} }),
    createWorkerComposition: () => ({ async handleCheckContinue() {} }),
  });
  assert.equal(listenCalls, 0);
  await runtime.start();
  await assert.rejects(runtime.start(), /once|started/i);
  assert.equal(listenCalls, 1);
});
