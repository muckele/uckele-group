import https from 'node:https';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCimScanWorkerHttpComposition } from './cimScanComposition.js';
import { createClamavUnixSocketScanner } from './clamavUnixSocketScanner.js';
import { createFilesystemCimReplayStore } from './filesystemCimReplayStore.js';
import { createNodeClamavUnixConnector } from './cimScanWorkerEntrypoint.js';

const listenHost = 'fly-local-6pn';
const listenPort = 8443;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function absolutePath(value, label) {
  const parsed = String(value || '').trim();
  if (!path.isAbsolute(parsed) || path.resolve(parsed) === path.parse(path.resolve(parsed)).root) {
    throw new Error(`${label} must be an explicit bounded absolute path.`);
  }
  return path.resolve(parsed);
}

export function loadCimScanWorkerHttpConfig(environment = process.env) {
  if (environment.CLAMAV_HOST !== undefined || environment.CLAMAV_PORT !== undefined
    || environment.CLAMD_HOST !== undefined || environment.CLAMD_PORT !== undefined) {
    throw new Error('ClamAV TCP configuration is forbidden.');
  }
  if (environment.CIM_SCAN_BENCHMARK_CLOCK_OFFSET_MS !== undefined) {
    throw new Error('Benchmark clock configuration is forbidden in the normal worker runtime.');
  }
  const keyId = String(environment.CIM_SCAN_KEY_ID || '');
  if (!identityPattern.test(keyId)) throw new Error('Worker key id is invalid.');
  return Object.freeze({
    keyId,
    keyFile: absolutePath(environment.CIM_SCAN_KEY_FILE, 'Worker key file path'),
    tlsCertFile: absolutePath(environment.CIM_SCAN_TLS_CERT_FILE, 'Worker TLS certificate path'),
    tlsKeyFile: absolutePath(environment.CIM_SCAN_TLS_KEY_FILE, 'Worker TLS key path'),
    replayRoot: absolutePath(environment.CIM_SCAN_REPLAY_ROOT, 'Worker replay root path'),
    ephemeralRoot: absolutePath(environment.CIM_SCAN_EPHEMERAL_ROOT, 'Worker ephemeral root path'),
    clamavSocketPath: absolutePath(environment.CLAMAV_UNIX_SOCKET, 'ClamAV Unix socket path'),
  });
}

async function readBoundedFile(file, {
  maximumBytes,
  minimumBytes = 1,
  privateFile = false,
} = {}) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimumBytes || stat.size > maximumBytes
    || (privateFile && (stat.mode & 0o077) !== 0)) {
    throw new Error('Worker runtime input is not a bounded regular file with required permissions.');
  }
  return fsp.readFile(file);
}

function rejectOrdinaryRequest(request, response) {
  try {
    response.writeHead(417, Object.freeze({
      'cache-control': 'no-store',
      connection: 'close',
      'content-length': '0',
    }));
    response.end();
  } finally {
    try { request.destroy(); } catch { /* preserve fail-closed rejection */ }
  }
}

function destroyPeer(_error, peer) {
  try { peer?.destroy?.(); } catch { /* preserve fail-closed transport teardown */ }
}

function requireFactory(value, label) {
  if (typeof value !== 'function') throw new Error(`${label} is required.`);
  return value;
}

export async function createCimScanWorkerHttpRuntime({
  config = loadCimScanWorkerHttpConfig(),
  now,
  signatureNow = now,
  readFile = readBoundedFile,
  createHttpsServer = (options, listener) => https.createServer(options, listener),
  createReplayStore = createFilesystemCimReplayStore,
  createScanner = ({ socketPath }) => createClamavUnixSocketScanner({
    socketPath,
    connectUnix: createNodeClamavUnixConnector(),
  }),
  createWorkerComposition = createCimScanWorkerHttpComposition,
} = {}) {
  if (typeof now !== 'function') throw new Error('Worker runtime clock is required.');
  if (typeof signatureNow !== 'function') throw new Error('Worker runtime signature clock is required.');
  requireFactory(readFile, 'Worker runtime file reader');
  requireFactory(createHttpsServer, 'Worker HTTPS server factory');
  requireFactory(createReplayStore, 'Worker replay-store factory');
  requireFactory(createScanner, 'Worker scanner factory');
  requireFactory(createWorkerComposition, 'Worker composition factory');

  const [key, cert, tlsKey] = await Promise.all([
    readFile(config.keyFile, { maximumBytes: 4 * 1024, minimumBytes: 32, privateFile: true }),
    readFile(config.tlsCertFile, { maximumBytes: 64 * 1024 }),
    readFile(config.tlsKeyFile, { maximumBytes: 16 * 1024, privateFile: true }),
  ]);
  const keyBytes = Buffer.from(key);
  if (keyBytes.length < 32) throw new Error('Worker protocol key is too short.');
  const replayStore = createReplayStore({ root: config.replayRoot });
  const scanner = createScanner({ socketPath: config.clamavSocketPath });
  const worker = createWorkerComposition({
    keyResolver: (candidate) => candidate === config.keyId ? keyBytes : null,
    replayStore,
    ephemeralRoot: config.ephemeralRoot,
    scanner,
    now,
    signatureNow,
  });
  if (!worker || typeof worker.handleCheckContinue !== 'function') {
    throw new Error('Worker HTTPS composition is invalid.');
  }

  const server = createHttpsServer({
    key: Buffer.from(tlsKey),
    cert: Buffer.from(cert),
    minVersion: 'TLSv1.2',
    maxHeaderSize: 32 * 1024,
  }, rejectOrdinaryRequest);
  if (!server || typeof server.on !== 'function' || typeof server.once !== 'function'
    || typeof server.listen !== 'function' || typeof server.close !== 'function') {
    throw new Error('Worker HTTPS server factory returned an invalid server.');
  }
  server.headersTimeout = 15_000;
  server.requestTimeout = 95_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;
  server.on('checkContinue', (request, response) => {
    Promise.resolve(worker.handleCheckContinue(request, response)).catch(() => {
      try { response?.destroy?.(); } catch { /* preserve fail-closed handler teardown */ }
      try { request?.destroy?.(); } catch { /* preserve fail-closed handler teardown */ }
    });
  });
  server.on('clientError', destroyPeer);
  server.on('tlsClientError', destroyPeer);

  let started = false;
  let closed = false;
  return Object.freeze({
    async start() {
      if (started) throw new Error('Worker HTTPS runtime may be started only once.');
      if (closed) throw new Error('Worker HTTPS runtime is already closed.');
      started = true;
      await new Promise((resolve, reject) => {
        const onError = () => reject(new Error('Worker HTTPS listener failed to start.'));
        server.once('error', onError);
        server.listen(listenPort, listenHost, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!started) return;
      await new Promise((resolve) => server.close(resolve));
    },
  });
}
