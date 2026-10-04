import { createHash, timingSafeEqual } from 'node:crypto';
import { checkServerIdentity as checkTlsServerIdentity } from 'node:tls';

const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const privateWorkerPort = 8443;

export class ScannerPreconnectionRefusedError extends Error {
  constructor() {
    super('Scanner HTTPS listener refused a preconnection attempt.');
    this.name = 'ScannerPreconnectionRefusedError';
  }
}

export class ScannerWorkerDeadlineError extends Error {
  constructor() {
    super('Scanner worker exceeded its authenticated deadline after body admission.');
    this.name = 'ScannerWorkerDeadlineError';
  }
}

export function isScannerPreconnectionRefusedError(error) {
  return error instanceof ScannerPreconnectionRefusedError;
}

export function isScannerWorkerDeadlineError(error) {
  return error instanceof ScannerWorkerDeadlineError;
}

function requireLabel(value, label) {
  if (!dnsLabelPattern.test(String(value || ''))) throw new Error(`${label} is invalid.`);
  return String(value);
}

function requireOperation({ signal, deadlineAt } = {}, monotonicNow) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= monotonicNow()) {
    throw new Error('Scanner HTTPS deadline is invalid or expired.');
  }
  if (!signal || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    throw new Error('Scanner HTTPS abort signal is required.');
  }
  if (signal.aborted) throw new Error('Scanner HTTPS operation was aborted.');
  return { signal, deadlineAt };
}

function requirePort(value) {
  if (value !== privateWorkerPort) {
    throw new Error(`Scanner HTTPS port must be ${privateWorkerPort}.`);
  }
  return String(value);
}

function requireEndpoint(value, expectedHostname, expectedPort) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error('Scanner HTTPS endpoint is invalid.'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== expectedHostname
    || endpoint.pathname !== '/v1/cim-scan' || endpoint.username || endpoint.password
    || endpoint.port !== expectedPort || endpoint.search || endpoint.hash) {
    throw new Error('Scanner HTTPS exchange requires one exact Machine endpoint.');
  }
  return endpoint;
}

function verifyIdentity(expectedHostname, expectedPin, hostname, certificate) {
  if (hostname !== expectedHostname) return new Error('Scanner TLS hostname identity did not match.');
  const hostnameError = checkTlsServerIdentity(hostname, certificate);
  if (hostnameError) return new Error('Scanner TLS hostname identity did not match.');
  if (!Buffer.isBuffer(certificate?.pubkey)) {
    return new Error('Scanner TLS SPKI identity was unavailable.');
  }
  const actual = createHash('sha256').update(certificate.pubkey).digest();
  const expected = Buffer.from(expectedPin, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return new Error('Scanner TLS SPKI pin did not match.');
  }
  return undefined;
}

export function createNodePinnedHttpsExchange({
  machineId,
  appName,
  port,
  monotonicNow,
  requestImpl,
} = {}) {
  const exactMachineId = requireLabel(machineId, 'Fly Machine DNS identity');
  const exactAppName = requireLabel(appName, 'Fly application DNS identity');
  const expectedHostname = `${exactMachineId}.vm.${exactAppName}.internal`;
  const expectedPort = requirePort(port);
  if (typeof monotonicNow !== 'function') throw new Error('An injected monotonic clock is required.');
  if (typeof requestImpl !== 'function') throw new Error('An injected HTTPS request implementation is required.');

  return async function openExchange(command = {}) {
    requireOperation(command, monotonicNow);
    if (command.method !== 'POST' || command.redirects !== 'error') {
      throw new Error('Scanner HTTPS exchange requires one non-redirecting POST request.');
    }
    if (!digestPattern.test(String(command.certificatePinSha256 || ''))) {
      throw new Error('Scanner HTTPS exchange requires one explicit SPKI SHA-256 pin.');
    }
    const endpoint = requireEndpoint(command.endpoint, expectedHostname, expectedPort);
    if (!command.headers || typeof command.headers !== 'object') {
      throw new Error('Scanner HTTPS headers are required.');
    }

    let request;
    let response = null;
    let admitted = false;
    let tcpConnected = false;
    let tlsEstablished = false;
    let aborted = false;
    let finished = false;
    let rootAbortAttached = false;
    let admissionResolved = false;
    let resolveAdmission;
    let resolveResponse;
    const admissionResult = new Promise((resolve) => { resolveAdmission = resolve; });
    const responseResult = new Promise((resolve) => { resolveResponse = resolve; });

    function settleFailure(error) {
      const failure = error?.code === 'ECONNREFUSED' && !tcpConnected && !tlsEstablished
        && !response && !admitted
        ? new ScannerPreconnectionRefusedError()
        : new Error('Scanner HTTPS exchange failed.');
      if (!admissionResolved) {
        admissionResolved = true;
        resolveAdmission({ failed: true, error: failure });
      }
      resolveResponse({ failed: true, error: failure });
    }

    function detachRootAbort() {
      if (!rootAbortAttached) return;
      rootAbortAttached = false;
      command.signal.removeEventListener('abort', abortRequest);
    }

    function abortRequest(error) {
      if (aborted) return;
      aborted = true;
      detachRootAbort();
      try { response?.destroy?.(); } catch { /* preserve bounded local failure */ }
      try { request?.destroy?.(); } catch { /* preserve bounded local failure */ }
      settleFailure(error);
    }

    function waitBounded(result, operation = {}) {
      const { signal, deadlineAt } = requireOperation(operation, monotonicNow);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          callback(value);
        };
        const fail = () => {
          abortRequest();
          finish(reject, new Error('Scanner HTTPS operation was aborted or exceeded its deadline.'));
        };
        const onAbort = () => fail();
        const timer = setTimeout(fail, Math.max(1, Math.ceil(deadlineAt - monotonicNow())));
        signal.addEventListener('abort', onAbort, { once: true });
        result.then((value) => {
          if (value?.failed) {
            finish(reject, isScannerPreconnectionRefusedError(value.error)
              ? value.error : new Error('Scanner HTTPS exchange failed.'));
          } else {
            finish(resolve, value);
          }
        }, () => finish(reject, new Error('Scanner HTTPS exchange failed.')));
      });
    }

    try {
      request = requestImpl(endpoint, {
        method: 'POST',
        headers: command.headers,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        servername: expectedHostname,
        signal: command.signal,
        checkServerIdentity(hostname, certificate) {
          return verifyIdentity(expectedHostname, command.certificatePinSha256, hostname, certificate);
        },
      }, (incoming) => {
        tcpConnected = true;
        tlsEstablished = true;
        response = incoming;
        resolveResponse({ response: incoming });
        if (!admissionResolved) {
          admissionResolved = true;
          detachRootAbort();
          resolveAdmission({ status: incoming?.statusCode, body: incoming });
        }
      });
    } catch {
      throw new Error('Scanner HTTPS exchange could not be opened.');
    }
    if (!request || typeof request.once !== 'function' || typeof request.on !== 'function'
      || typeof request.flushHeaders !== 'function' || typeof request.write !== 'function'
      || typeof request.end !== 'function' || typeof request.destroy !== 'function') {
      abortRequest();
      throw new Error('Injected HTTPS request implementation returned an invalid request.');
    }
    request.once('socket', (socket) => {
      if (!socket || typeof socket.once !== 'function') {
        tcpConnected = true;
        return;
      }
      socket.once('connect', () => { tcpConnected = true; });
      socket.once('secureConnect', () => {
        tcpConnected = true;
        tlsEstablished = true;
      });
    });
    request.once('continue', () => {
      if (admissionResolved) return;
      tcpConnected = true;
      tlsEstablished = true;
      admitted = true;
      admissionResolved = true;
      resolveAdmission({ status: 100 });
    });
    request.on('error', abortRequest);
    command.signal.addEventListener('abort', abortRequest, { once: true });
    rootAbortAttached = true;
    if (response && !admitted) detachRootAbort();
    try { request.flushHeaders(); } catch {
      abortRequest();
      throw new Error('Scanner HTTPS exchange could not send its headers.');
    }

    return Object.freeze({
      async awaitAdmission(operation = {}) {
        return await waitBounded(admissionResult, operation);
      },

      async write(chunk, operation = {}) {
        requireOperation(operation, monotonicNow);
        if (admitted && response?.statusCode === 408 && !finished && !aborted) {
          throw new ScannerWorkerDeadlineError();
        }
        if (!admitted || response || finished || aborted) {
          throw new Error('Scanner HTTPS exchange is not admitted for body data.');
        }
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
          throw new Error('Scanner HTTPS body chunk is invalid.');
        }
        const result = new Promise((resolve) => {
          try {
            request.write(chunk, (error) => resolve(error ? { failed: true } : { written: true }));
          } catch { resolve({ failed: true }); }
        });
        await waitBounded(result, operation);
      },

      async finish(operation = {}) {
        if (!admitted || finished || aborted) {
          throw new Error('Scanner HTTPS exchange cannot be finished in its current state.');
        }
        finished = true;
        try { request.end(); } catch {
          abortRequest();
          throw new Error('Scanner HTTPS exchange could not finish its request.');
        }
        const result = await waitBounded(responseResult, operation);
        if (!Number.isSafeInteger(result.response?.statusCode)) {
          abortRequest();
          throw new Error('Scanner HTTPS response status was invalid.');
        }
        detachRootAbort();
        return Object.freeze({ status: result.response.statusCode, body: result.response });
      },

      abort() { abortRequest(); },
    });
  };
}
