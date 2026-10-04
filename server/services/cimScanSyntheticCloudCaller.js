import https from 'node:https';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { CIM_SCAN_PROTOCOL_LIMITS } from './cimScanProtocol.js';
import { createFlyCimScannerComposition } from './cimScanComposition.js';

const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const generatedChunkBytes = 64 * 1024;

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

function requiredIdentity(value, label, pattern = identityPattern) {
  const parsed = String(value || '');
  if (!pattern.test(parsed)) throw new Error(`${label} is invalid or required.`);
  return parsed;
}

function absolutePath(value, label) {
  const parsed = String(value || '').trim();
  if (!path.isAbsolute(parsed) || path.resolve(parsed) === path.parse(path.resolve(parsed)).root) {
    throw new Error(`${label} must be an explicit bounded absolute path.`);
  }
  return path.resolve(parsed);
}

function exactApiBaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Fly API base URL is invalid or required.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/') {
    throw new Error('Fly API base URL must be one exact HTTPS origin.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function loadCimScanSyntheticCallerConfig(environment = process.env) {
  const certificatePinSha256 = String(environment.CIM_SCAN_CERTIFICATE_PIN_SHA256 || '');
  if (!digestPattern.test(certificatePinSha256)) {
    throw new Error('Scanner certificate pin is invalid or required.');
  }
  return Object.freeze({
    machineId: requiredIdentity(environment.CIM_SCAN_FLY_MACHINE_ID,
      'Fly Machine identity', dnsLabelPattern),
    appName: requiredIdentity(environment.CIM_SCAN_FLY_APP_NAME,
      'Fly application identity', dnsLabelPattern),
    apiBaseUrl: exactApiBaseUrl(environment.CIM_SCAN_FLY_API_BASE_URL),
    accessTokenFile: absolutePath(environment.CIM_SCAN_FLY_TOKEN_FILE, 'Fly token file'),
    caFile: absolutePath(environment.CIM_SCAN_CA_FILE, 'Scanner CA file'),
    certificatePinSha256,
    keyId: requiredIdentity(environment.CIM_SCAN_KEY_ID, 'Protocol key id'),
    keyFile: absolutePath(environment.CIM_SCAN_KEY_FILE, 'Protocol key file'),
    jobOwner: requiredIdentity(environment.CIM_SCAN_JOB_OWNER, 'Synthetic job owner'),
  });
}

export function createPinnedNodeHttpsRequestImpl({
  ca,
  requestImpl = (url, options, respond) => https.request(url, options, respond),
} = {}) {
  const caBytes = Buffer.isBuffer(ca) ? ca : ca instanceof Uint8Array ? Buffer.from(ca) : null;
  if (!caBytes || caBytes.length === 0) throw new Error('One explicit scanner CA certificate is required.');
  if (typeof requestImpl !== 'function') throw new Error('An injected Node HTTPS request function is required.');
  return function requestWithPinnedCa(url, options, respond) {
    if (options?.rejectUnauthorized !== true || options?.minVersion !== 'TLSv1.2'
      || typeof options?.servername !== 'string' || !options.servername
      || typeof options?.checkServerIdentity !== 'function') {
      throw new Error('Scanner HTTPS verification options are incomplete.');
    }
    return requestImpl(url, {
      ...options,
      ca: caBytes,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    }, respond);
  };
}

async function readBoundedFile(file, {
  maximumBytes,
  minimumBytes = 1,
  privateFile = false,
} = {}) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimumBytes || stat.size > maximumBytes
    || (privateFile && (stat.mode & 0o077) !== 0)) {
    throw new Error('Synthetic caller input is not a bounded regular file with required permissions.');
  }
  return fsp.readFile(file);
}

export async function createSyntheticCloudScannerFactory({
  config = loadCimScanSyntheticCallerConfig(),
  readFile = readBoundedFile,
  fetchImpl = globalThis.fetch,
  requestImpl = (url, options, respond) => https.request(url, options, respond),
  wallNowMs = () => Date.now(),
  monotonicNow = () => performance.now(),
  now = () => new Date(),
  composeScanner = createFlyCimScannerComposition,
} = {}) {
  for (const [value, label] of [
    [readFile, 'file reader'], [fetchImpl, 'Fly API transport'], [requestImpl, 'HTTPS request'],
    [wallNowMs, 'wall clock'], [monotonicNow, 'monotonic clock'], [now, 'protocol clock'],
    [composeScanner, 'scanner composition'],
  ]) {
    if (typeof value !== 'function') throw new Error(`Synthetic caller ${label} is required.`);
  }
  const [tokenBytes, ca, keyValue] = await Promise.all([
    readFile(config.accessTokenFile, { maximumBytes: 4 * 1024, privateFile: true }),
    readFile(config.caFile, { maximumBytes: 64 * 1024 }),
    readFile(config.keyFile, { maximumBytes: 4 * 1024, minimumBytes: 32, privateFile: true }),
  ]);
  const accessToken = Buffer.from(tokenBytes).toString('utf8').trim();
  if (!accessToken || accessToken.length > 4 * 1024 || hasControlCharacter(accessToken)) {
    throw new Error('Synthetic caller Fly token is invalid.');
  }
  const key = Buffer.from(keyValue);
  if (key.length < 32) throw new Error('Synthetic caller protocol key is too short.');
  const pinnedRequestImpl = createPinnedNodeHttpsRequestImpl({ ca, requestImpl });
  return function createFreshScannerComposition() {
    const composition = composeScanner({
      machineId: config.machineId,
      appName: config.appName,
      port: 8443,
      apiBaseUrl: config.apiBaseUrl,
      accessToken,
      apiMaxResponseBytes: 16 * 1024,
      fetchImpl,
      wallNowMs,
      monotonicNow,
      certificatePinSha256: config.certificatePinSha256,
      requestImpl: pinnedRequestImpl,
      keyId: config.keyId,
      keyResolver: (candidate) => candidate === config.keyId ? key : null,
      now,
    });
    if (!composition?.scanner || typeof composition.scanner.scan !== 'function') {
      throw new Error('Synthetic caller scanner composition is invalid.');
    }
    return composition;
  };
}

function generatedDigest(sizeBytes, fillByte) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < sizeBytes; offset += generatedChunkBytes) {
    hash.update(Buffer.alloc(Math.min(generatedChunkBytes, sizeBytes - offset), fillByte));
  }
  return hash.digest('hex');
}

export function createGeneratedSyntheticScanJob({
  name,
  sizeBytes,
  requestId,
  intakeId,
  jobOwner,
  now,
} = {}) {
  if (typeof name !== 'string' || !name || name.length > 80) {
    throw new Error('Synthetic scan job name is invalid.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1
    || sizeBytes > CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes) {
    throw new Error('Synthetic scan job size is invalid.');
  }
  if (typeof now !== 'function') throw new Error('Synthetic scan job clock is required.');
  const issuedAt = now();
  const issued = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  if (!Number.isFinite(issued.getTime())) throw new Error('Synthetic scan job clock is invalid.');
  const fillByte = createHash('sha256').update(name, 'utf8').digest()[0];
  let opens = 0;
  return Object.freeze({
    name,
    claim: Object.freeze({
      requestId,
      intakeId,
      attempt: 1,
      jobOwner: requiredIdentity(jobOwner, 'Synthetic job owner'),
      leaseExpiresAt: new Date(issued.getTime() + 3 * 60 * 1_000).toISOString(),
    }),
    sha256: generatedDigest(sizeBytes, fillByte),
    sizeBytes,
    mimeType: 'application/pdf',
    openCount: () => opens,
    openByteStream() {
      if (opens !== 0) throw new Error('Synthetic scan bytes may be opened only once.');
      opens += 1;
      return Readable.from((async function* generatedBytes() {
        for (let offset = 0; offset < sizeBytes; offset += generatedChunkBytes) {
          yield Buffer.alloc(Math.min(generatedChunkBytes, sizeBytes - offset), fillByte);
        }
      }()));
    },
  });
}

export async function runGeneratedSyntheticScanJobs({ jobs, createScannerComposition } = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 8) {
    throw new Error('One to eight generated synthetic scan jobs are required.');
  }
  if (typeof createScannerComposition !== 'function') {
    throw new Error('A fresh scanner composition factory is required.');
  }
  const results = [];
  for (const job of jobs) {
    const composition = createScannerComposition();
    if (!composition?.scanner || typeof composition.scanner.scan !== 'function') {
      throw new Error('Synthetic caller scanner composition is invalid.');
    }
    const result = await composition.scanner.scan({
      claim: job.claim,
      sha256: job.sha256,
      sizeBytes: job.sizeBytes,
      mimeType: job.mimeType,
      openByteStream: job.openByteStream,
    });
    results.push(Object.freeze({ name: job.name, result }));
  }
  return Object.freeze(results);
}
