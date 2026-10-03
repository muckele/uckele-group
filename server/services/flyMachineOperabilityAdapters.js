import { CIM_SCAN_PROTOCOL_LIMITS } from './cimScanProtocol.js';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function assertIdentity(value, label) {
  if (!identityPattern.test(String(value || ''))) throw new Error(`${label} is invalid.`);
}

function assertCommand(command, machineId, { providerGeneration = false } = {}) {
  if (command?.machineId !== machineId) throw new Error('Fly Machine identity does not match the controller.');
  assertIdentity(command?.sessionGeneration, 'Fly session generation');
  if (providerGeneration) assertIdentity(command?.providerGeneration, 'Fly provider generation');
  if (!Number.isFinite(command?.deadlineAt) || command.deadlineAt <= performance.now()) {
    throw new Error('Fly control deadline is invalid or expired.');
  }
  if (!command?.signal || typeof command.signal.aborted !== 'boolean') {
    throw new Error('Fly control abort signal is required.');
  }
}

function validateInspection(value, machineId) {
  if (!value || value.machineId && value.machineId !== machineId) {
    throw new Error('Fly control inspection returned the wrong Machine.');
  }
  if (!['stopped', 'started'].includes(value.state)) throw new Error('Fly Machine state is ambiguous.');
  assertIdentity(value.providerGeneration, 'Fly provider generation');
  if (value.sessionGeneration !== null) {
    assertIdentity(value.sessionGeneration, 'Fly session generation owner');
  }
  return value;
}

export function createFlyMachineController({ machineId, control } = {}) {
  assertIdentity(machineId, 'Fly Machine identity');
  if (typeof control !== 'function') throw new Error('An injected Fly control seam is required.');
  return Object.freeze({
    async acquireStoppedSession(command = {}) {
      assertCommand(command, machineId);
      const inspected = validateInspection(await control({
        action: 'inspect', machineId, sessionGeneration: command.sessionGeneration,
        deadlineAt: command.deadlineAt, signal: command.signal,
      }), machineId);
      if (inspected.state !== 'stopped' || inspected.sessionGeneration !== null) {
        throw new Error('Fly Machine is not initially stopped and unowned.');
      }
      return { initialState: 'stopped', providerGeneration: inspected.providerGeneration };
    },

    async startSession(command = {}) {
      assertCommand(command, machineId, { providerGeneration: true });
      const result = await control({
        action: 'start-if-owned', machineId,
        sessionGeneration: command.sessionGeneration,
        providerGeneration: command.providerGeneration,
        deadlineAt: command.deadlineAt, signal: command.signal,
      });
      if (result?.applied !== true) throw new Error('Fly Machine generation ownership was not proven for start.');
    },

    async ownsSession(command = {}) {
      assertCommand(command, machineId, { providerGeneration: true });
      const inspected = validateInspection(await control({
        action: 'inspect', machineId, sessionGeneration: command.sessionGeneration,
        providerGeneration: command.providerGeneration,
        deadlineAt: command.deadlineAt, signal: command.signal,
      }), machineId);
      return inspected.providerGeneration === command.providerGeneration
        && inspected.sessionGeneration === command.sessionGeneration;
    },

    async stopSessionIfOwned(command = {}) {
      assertCommand(command, machineId, { providerGeneration: true });
      const result = await control({
        action: 'stop-if-owned', machineId,
        sessionGeneration: command.sessionGeneration,
        providerGeneration: command.providerGeneration,
        deadlineAt: command.deadlineAt, signal: command.signal,
      });
      return result?.applied === true;
    },
  });
}

function validateEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('Scanner HTTPS endpoint is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
    || parsed.search || parsed.pathname !== '/v1/cim-scan') {
    throw new Error('Scanner request client requires one exact HTTPS endpoint.');
  }
  return parsed.toString();
}

function parseRequestSize(requestWire) {
  if (typeof requestWire !== 'string'
    || Buffer.byteLength(requestWire, 'utf8') > CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes) {
    throw new Error('Scanner request envelope is invalid.');
  }
  let request;
  try { request = JSON.parse(requestWire); } catch { throw new Error('Scanner request envelope is invalid.'); }
  if (!Number.isSafeInteger(request?.sizeBytes) || request.sizeBytes < 0
    || request.sizeBytes > CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes) {
    throw new Error('Scanner request attachment size is invalid.');
  }
  return request.sizeBytes;
}

async function readResponseBody(body, maximum) {
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const value = Buffer.from(body);
    if (value.length > maximum) throw new Error('Scanner response exceeds the configured cap.');
    return value.toString('utf8');
  }
  if (!body || typeof body[Symbol.iterator] !== 'function'
    && typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('Scanner HTTP response body is invalid.');
  }
  const chunks = [];
  let size = 0;
  for await (const value of body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maximum) throw new Error('Scanner response exceeds the configured cap.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function abortExchange(exchange, reason) {
  try { exchange?.abort?.(reason); } catch { /* preserve the authoritative failure */ }
}

export function createPinnedHttpScanRequestClient({
  endpoint,
  certificatePinSha256,
  openExchange,
} = {}) {
  const exactEndpoint = validateEndpoint(endpoint);
  if (!digestPattern.test(String(certificatePinSha256 || ''))) {
    throw new Error('Scanner certificate pin must be an explicit SHA-256 digest.');
  }
  if (typeof openExchange !== 'function') throw new Error('An injected HTTP exchange seam is required.');

  return Object.freeze({
    async authorize({
      requestWire,
      redirects,
      maxResponseBytes,
      signal,
      deadlineAt,
    } = {}) {
      if (redirects !== 'error') throw new Error('Scanner redirects must be refused.');
      if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
        || maxResponseBytes > CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes) {
        throw new Error('Scanner response cap is invalid.');
      }
      const sizeBytes = parseRequestSize(requestWire);
      const exchange = await openExchange({
        endpoint: exactEndpoint,
        method: 'POST',
        redirects: 'error',
        certificatePinSha256,
        headers: Object.freeze({
          'content-type': 'application/octet-stream',
          'content-length': String(sizeBytes),
          expect: '100-continue',
          'x-cim-scan-request': Buffer.from(requestWire, 'utf8').toString('base64url'),
        }),
        signal,
        deadlineAt,
      });
      if (!exchange || typeof exchange.awaitAdmission !== 'function'
        || typeof exchange.write !== 'function' || typeof exchange.finish !== 'function'
        || typeof exchange.abort !== 'function') {
        abortExchange(exchange);
        throw new Error('Scanner HTTP exchange seam is invalid.');
      }
      let admission;
      try {
        admission = await exchange.awaitAdmission({ signal, deadlineAt });
      } catch (error) {
        abortExchange(exchange, error);
        throw error;
      }
      if (admission?.status !== 100) {
        abortExchange(exchange);
        throw new Error('Scanner worker did not admit the request before its body.');
      }
      let bodyOpened = false;
      return Object.freeze({
        abort(reason) { abortExchange(exchange, reason); },
        async sendBody({ openByteStream, maxResponseBytes: bodyCap, signal: bodySignal, deadlineAt: bodyDeadline } = {}) {
          if (bodyOpened) throw new Error('Scanner upload handle is single-use.');
          bodyOpened = true;
          let stream;
          let sent = 0;
          try {
            if (typeof openByteStream !== 'function') throw new Error('Scanner body factory is required.');
            if (bodyCap !== maxResponseBytes) throw new Error('Scanner response cap changed after admission.');
            stream = openByteStream();
            if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
              throw new Error('Scanner attachment stream is invalid.');
            }
            for await (const value of stream) {
              const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
              if (chunk.length > sizeBytes - sent) throw new Error('Scanner attachment exceeds its authenticated size.');
              sent += chunk.length;
              await exchange.write(chunk, { signal: bodySignal, deadlineAt: bodyDeadline });
            }
            if (sent !== sizeBytes) throw new Error('Scanner attachment length does not match its authenticated size.');
            const response = await exchange.finish({ signal: bodySignal, deadlineAt: bodyDeadline });
            if ([301, 302, 303, 307, 308].includes(response?.status)) {
              throw new Error('Scanner HTTP redirect was refused.');
            }
            if (response?.status !== 200) throw new Error('Scanner HTTP response was not successful.');
            return await readResponseBody(response.body, maxResponseBytes);
          } catch (error) {
            abortExchange(exchange, error);
            try { stream?.destroy?.(error); } catch { /* preserve the authoritative failure */ }
            throw error;
          }
        },
      });
    },
  });
}
