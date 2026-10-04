import {
  CIM_SCAN_PROTOCOL_LIMITS,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from './cimScanProtocol.js';
import { runOnDemandScanTask } from './cimScanWorker.js';
import { PassThrough } from 'node:stream';

const exactPath = '/v1/cim-scan';
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

function headerValue(headers, name) {
  const value = headers?.[name];
  if (typeof value !== 'string' || !value) throw new Error(`Worker ${name} header is invalid.`);
  return value;
}

function decodeRequestWire(value) {
  if (!base64UrlPattern.test(value)
    || value.length > Math.ceil(CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes * 4 / 3)) {
    throw new Error('Worker scan request header is invalid.');
  }
  const bytes = Buffer.from(value, 'base64url');
  const wire = bytes.toString('utf8');
  if (bytes.toString('base64url') !== value || !Buffer.from(wire, 'utf8').equals(bytes)
    || bytes.length > CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes) {
    throw new Error('Worker scan request header is invalid.');
  }
  return wire;
}

function validateHttpRequest(request) {
  if (!request || request.method !== 'POST' || request.url !== exactPath) {
    throw new Error('Worker scan endpoint requires one exact request target.');
  }
  if (headerValue(request.headers, 'expect').toLowerCase() !== '100-continue') {
    throw new Error('Worker scan endpoint requires explicit body admission.');
  }
  if (headerValue(request.headers, 'content-type').toLowerCase() !== 'application/octet-stream') {
    throw new Error('Worker scan content type is invalid.');
  }
  if (request.headers?.['transfer-encoding'] !== undefined) {
    throw new Error('Worker scan transfer encoding is forbidden.');
  }
  const contentLength = headerValue(request.headers, 'content-length');
  if (!/^[1-9][0-9]*$/.test(contentLength)) {
    throw new Error('Worker scan content length is invalid.');
  }
  const sizeBytes = Number(contentLength);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes) {
    throw new Error('Worker scan content length is outside its allowed range.');
  }
  if (typeof request[Symbol.asyncIterator] !== 'function' || typeof request.destroy !== 'function'
    || typeof request.pipe !== 'function' || typeof request.unpipe !== 'function'
    || typeof request.pause !== 'function' || typeof request.once !== 'function'
    || typeof request.removeListener !== 'function') {
    throw new Error('Worker scan request body is not an abortable byte stream.');
  }
  return {
    requestWire: decodeRequestWire(headerValue(request.headers, 'x-cim-scan-request')),
    sizeBytes,
  };
}

function validateResponse(response) {
  if (!response || typeof response.writeContinue !== 'function'
    || typeof response.writeHead !== 'function' || typeof response.end !== 'function') {
    throw new Error('Worker scan response seam is invalid.');
  }
}

function writeResponse(response, status, body = '') {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(status, Object.freeze({
    'cache-control': 'no-store',
    'content-length': String(bytes.length),
    ...(status === 200 ? { 'content-type': 'application/json; charset=utf-8' } : { connection: 'close' }),
  }));
  response.end(bytes);
}

function responsePreservingRequestBody(request) {
  const body = new PassThrough();
  const onRequestError = () => body.destroy(new Error('Worker request body failed.'));
  const detach = () => {
    request.unpipe?.(body);
    request.pause?.();
    request.removeListener?.('error', onRequestError);
  };
  request.once?.('error', onRequestError);
  body.once('close', detach);
  request.pipe(body);
  return body;
}

function closeRequestAfterResponse(request, response) {
  const close = () => {
    try { request.destroy(); } catch { /* response status remains authoritative */ }
  };
  if (typeof response.once === 'function') {
    try { response.once('finish', close); } catch { queueMicrotask(close); }
  } else queueMicrotask(close);
}

export function createCimScanWorkerCheckContinueHandler({
  keyResolver,
  replayStore,
  admission,
  ephemeralRoot,
  scanner,
  now,
  signatureNow = now,
  runTask = runOnDemandScanTask,
} = {}) {
  if (typeof keyResolver !== 'function') throw new Error('Worker protocol key resolver is required.');
  if (!replayStore || typeof replayStore.claim !== 'function' || typeof replayStore.complete !== 'function') {
    throw new Error('Worker replay authority is required.');
  }
  if (!admission || typeof admission.acquire !== 'function') {
    throw new Error('Worker process admission authority is required.');
  }
  if (typeof ephemeralRoot !== 'string' || !ephemeralRoot) {
    throw new Error('Worker ephemeral root is required.');
  }
  if (!scanner || typeof scanner.health !== 'function' || typeof scanner.scan !== 'function') {
    throw new Error('Worker scanner adapter is required.');
  }
  if (typeof now !== 'function') throw new Error('Worker clock is required.');
  if (typeof signatureNow !== 'function') throw new Error('Worker signature clock is required.');
  if (typeof runTask !== 'function') throw new Error('Worker task runner is required.');

  return async function handleCheckContinue(request, response) {
    validateResponse(response);
    let continued = false;
    let opened = false;
    try {
      const httpRequest = validateHttpRequest(request);
      const verifiedRequest = parseAndVerifyScanRequest(httpRequest.requestWire, {
        keyResolver,
        now: now(),
      });
      if (httpRequest.sizeBytes !== verifiedRequest.sizeBytes) {
        throw new Error('Worker scan content length does not match its authenticated request.');
      }
      const resultWire = await runTask({
        requestWire: httpRequest.requestWire,
        keyResolver,
        replayStore,
        admission,
        ephemeralRoot,
        scanner,
        now,
        signatureNow,
        requireAttachment: true,
        admitRequest() {
          if (continued) throw new Error('Worker request was admitted more than once.');
          response.writeContinue();
          continued = true;
        },
        openByteStream() {
          if (!continued) throw new Error('Worker request body opened before admission.');
          if (opened) throw new Error('Worker request body opened more than once.');
          opened = true;
          return responsePreservingRequestBody(request);
        },
      });
      parseAndVerifyScanResult(resultWire, {
        request: verifiedRequest,
        keyResolver,
        now: now(),
      });
      writeResponse(response, 200, resultWire);
    } catch (error) {
      const status = error?.code === 'CIM_SCAN_REPLAY_CONFLICT' && !continued
        ? 409 : error?.code === 'CIM_SCAN_DEADLINE' && continued ? 408 : continued ? 500 : 400;
      if (continued) closeRequestAfterResponse(request, response);
      try { writeResponse(response, status); } catch {
        try { response.destroy?.(); } catch { /* preserve a closed fail-safe response */ }
        try { request.destroy(); } catch { /* preserve a closed fail-safe response */ }
      }
    }
  };
}
