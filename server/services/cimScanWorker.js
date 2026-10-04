import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CIM_SCAN_PROTOCOL_LIMITS,
  createSignedScanResult,
  parseAndVerifyScanRequest,
  parseAndVerifyScanResult,
} from './cimScanProtocol.js';

const maximumOrphanEntries = 100;
const resultLifetimeMs = 2 * 60 * 1000;
const markerDomain = 'uckele.cim-scan.v1/task-owner';

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Worker clock is invalid.');
  return date;
}

function resolveKey(keyResolver, keyId) {
  const value = keyResolver?.(keyId);
  const key = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : null;
  if (!key || key.length < 32) throw new Error('Worker authentication key is unavailable.');
  return key;
}

function markerPayload(request) {
  return {
    keyId: request.keyId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    expiresAt: request.expiresAt,
  };
}

function markerMac(payload, key) {
  return createHmac('sha256', key)
    .update(markerDomain, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
}

function createMarker(request, key) {
  const payload = markerPayload(request);
  return JSON.stringify({ ...payload, mac: markerMac(payload, key) });
}

function verifyMarker(wire, keyResolver) {
  let marker;
  try { marker = JSON.parse(wire); } catch { throw new Error('Worker orphan marker is invalid.'); }
  const fields = ['keyId', 'requestId', 'requestDigest', 'expiresAt', 'mac'];
  if (!marker || typeof marker !== 'object' || JSON.stringify(marker) !== wire
    || Object.keys(marker).sort().join(',') !== fields.sort().join(',')) {
    throw new Error('Worker orphan marker is noncanonical.');
  }
  const { mac, ...payload } = marker;
  const expected = markerMac(payload, resolveKey(keyResolver, marker.keyId));
  const actualBytes = Buffer.from(String(mac || ''), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Worker orphan ownership marker failed authentication.');
  }
  return marker;
}

function assertBeneath(realRoot, realCandidate) {
  if (realCandidate === realRoot || !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Worker task path escapes its ephemeral root.');
  }
}

async function ensureEphemeralRoot(ephemeralRoot) {
  const configured = String(ephemeralRoot || '').trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('Worker ephemeral root must be an explicit absolute path.');
  }
  const root = path.resolve(configured);
  if (root === path.parse(root).root) throw new Error('Worker ephemeral root is overly broad.');
  try {
    await fsp.lstat(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Worker ephemeral root must be a real directory.');
  if ((stat.mode & 0o077) !== 0) throw new Error('Worker ephemeral root permissions are not private.');
  return { root, realRoot: await fsp.realpath(root) };
}

async function defaultCleanupOwnedTask({ root, realRoot, taskPath, request, keyResolver }) {
  const taskStat = await fsp.lstat(taskPath);
  if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) throw new Error('Worker task directory ownership is invalid.');
  assertBeneath(realRoot, await fsp.realpath(taskPath));
  const names = (await fsp.readdir(taskPath)).sort();
  if (names.some((name) => !['attachment.bin', 'owner.json'].includes(name))) {
    throw new Error('Worker task directory contains an unowned entry.');
  }
  const markerPath = path.join(taskPath, 'owner.json');
  const markerStat = await fsp.lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Worker owner marker is invalid.');
  const marker = verifyMarker(await fsp.readFile(markerPath, 'utf8'), keyResolver);
  if (marker.requestId !== request.requestId || marker.requestDigest !== request.requestDigest) {
    throw new Error('Worker owner marker does not match the authenticated request.');
  }
  const attachmentPath = path.join(taskPath, 'attachment.bin');
  try {
    const attachmentStat = await fsp.lstat(attachmentPath);
    if (!attachmentStat.isFile() || attachmentStat.isSymbolicLink()) {
      throw new Error('Worker attachment copy is not an owned regular file.');
    }
    assertBeneath(realRoot, await fsp.realpath(attachmentPath));
    await fsp.unlink(attachmentPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.unlink(markerPath);
  await fsp.rmdir(taskPath);
  if (path.dirname(taskPath) !== root) throw new Error('Worker task directory parent changed unexpectedly.');
  return { cleaned: true };
}

async function inspectOrphans({ root, realRoot, keyResolver, now }) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  if (entries.length > maximumOrphanEntries) throw new Error('Worker ephemeral root has excessive orphan state.');
  for (const entry of entries) {
    if (!entry.name.startsWith('task-') || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Worker ephemeral root contains unknown orphan state.');
    }
    const taskPath = path.join(root, entry.name);
    assertBeneath(realRoot, await fsp.realpath(taskPath));
    const markerPath = path.join(taskPath, 'owner.json');
    let marker;
    try {
      const markerStat = await fsp.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('invalid');
      marker = verifyMarker(await fsp.readFile(markerPath, 'utf8'), keyResolver);
    } catch {
      throw new Error('Worker orphan state cannot be authenticated.');
    }
    if (Date.parse(marker.expiresAt) > now.getTime()) {
      throw new Error('Worker has an unexpired in-flight orphan task.');
    }
    await defaultCleanupOwnedTask({
      root, realRoot, taskPath,
      request: { requestId: marker.requestId, requestDigest: marker.requestDigest },
      keyResolver,
    });
  }
}

function initialDeadlineMs(request, current) {
  return Math.max(1, Math.min(
    request.maxDurationMs,
    Date.parse(request.expiresAt) - current.getTime(),
    Date.parse(request.leaseExpiresAt) - current.getTime(),
  ));
}

function workerDeadlineError(message = 'Worker task exceeded its shared deadline.') {
  const error = new Error(message);
  error.code = 'CIM_SCAN_DEADLINE';
  return error;
}

function isWorkerDeadlineError(error) {
  return error?.code === 'CIM_SCAN_DEADLINE';
}

function remainingDeadlineMs(deadlineAt) {
  const remaining = Math.floor(deadlineAt - performance.now());
  if (remaining < 1) throw workerDeadlineError();
  return remaining;
}

async function beforeWorkerDeadline(operation, {
  deadlineAt,
  controller,
  onTimeout,
  onLateResolution,
} = {}) {
  const remaining = remainingDeadlineMs(deadlineAt);
  let timedOut = false;
  let timer;
  const pending = Promise.resolve().then(operation).then((value) => {
    if (timedOut) {
      try { onLateResolution?.(value); } catch { /* deadline result remains authoritative */ }
    }
    return value;
  });
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = workerDeadlineError();
      controller?.abort(error);
      try { onTimeout?.(error); } catch { /* deadline result remains authoritative */ }
      reject(error);
    }, remaining);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeTaskCopy({
  request,
  taskPath,
  openByteStream,
  deadlineAt,
  controller,
}) {
  const attachmentPath = path.join(taskPath, 'attachment.bin');
  const hash = createHash('sha256');
  let size = 0;
  const remaining = remainingDeadlineMs(deadlineAt);
  const source = openByteStream();
  if (!source || typeof source[Symbol.asyncIterator] !== 'function'
    || typeof source.destroy !== 'function') {
    throw new Error('Worker attachment source must be an abortable async byte stream.');
  }
  const validator = new Transform({
    transform(value, _encoding, callback) {
      try {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (chunk.length > request.maxBytes - size || chunk.length > request.sizeBytes - size) {
          throw new Error('Worker attachment exceeds its authenticated size.');
        }
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
  });
  const destination = fs.createWriteStream(attachmentPath, {
    flags: 'wx',
    mode: 0o600,
    flush: true,
  });
  const deadlineError = workerDeadlineError('Worker attachment stream exceeded its deadline.');
  const timer = setTimeout(() => controller.abort(deadlineError), remaining);
  try {
    await pipeline(source, validator, destination, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === deadlineError) throw deadlineError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { attachmentPath, size, sha256: hash.digest('hex') };
}

function validHealth(health, current) {
  const signatureTime = Date.parse(health?.signatureUpdatedAt || '');
  return health?.healthy === true
    && typeof health.daemonId === 'string' && health.daemonId.length > 0
    && typeof health.engineVersion === 'string' && health.engineVersion.length > 0
    && typeof health.signatureVersion === 'string' && health.signatureVersion.length > 0
    && Number.isFinite(signatureTime)
    && signatureTime <= current.getTime()
    && current.getTime() - signatureTime <= CIM_SCAN_PROTOCOL_LIMITS.maxSignatureAgeMs;
}

function sameHealth(left, right) {
  return left?.healthy === true && right?.healthy === true
    && left.daemonId === right.daemonId
    && left.engineVersion === right.engineVersion
    && left.signatureVersion === right.signatureVersion
    && left.signatureUpdatedAt === right.signatureUpdatedAt;
}

function resultExpiry(request, scannedAt) {
  return new Date(Math.min(
    Date.parse(request.expiresAt),
    Date.parse(request.leaseExpiresAt),
    scannedAt.getTime() + resultLifetimeMs,
  )).toISOString();
}

function scannerByteStream(attachmentPath) {
  return fs.createReadStream(attachmentPath);
}

export async function runOnDemandScanTask({
  requestWire,
  openByteStream,
  admitRequest,
  requireAttachment = false,
  keyResolver,
  replayStore,
  admission,
  ephemeralRoot,
  scanner,
  now = () => new Date(),
  signatureNow = now,
  cleanupOwnedTask = defaultCleanupOwnedTask,
} = {}) {
  const current = nowDate(now);
  const signatureCurrent = nowDate(signatureNow);
  if (typeof requireAttachment !== 'boolean') {
    throw new Error('Worker attachment requirement is invalid.');
  }
  const request = parseAndVerifyScanRequest(requestWire, { keyResolver, now: current });
  const deadlineAt = performance.now() + initialDeadlineMs(request, current);
  const controller = new AbortController();
  const runBounded = (operation, options = {}) => beforeWorkerDeadline(operation, {
    deadlineAt, controller, ...options,
  });
  if (!replayStore || typeof replayStore.claim !== 'function' || typeof replayStore.complete !== 'function') {
    throw new Error('Worker replay authority is required.');
  }
  if (!admission || typeof admission.acquire !== 'function') throw new Error('Worker admission authority is required.');
  const release = await runBounded(
    () => admission.acquire(request.requestId, { deadlineAt, signal: controller.signal }),
    { onLateResolution: (lateRelease) => lateRelease?.() },
  );
  if (typeof release !== 'function') throw new Error('Worker is already processing another task.');
  try {
    const replay = await runBounded(() => replayStore.claim({
      keyId: request.keyId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      expiresAt: request.expiresAt,
      deadlineAt,
      signal: controller.signal,
    }));
    if (replay.status === 'replay') {
      parseAndVerifyScanResult(replay.resultWire, {
        request,
        keyResolver,
        now: nowDate(now),
      });
      return replay.resultWire;
    }
    if (replay.status === 'conflict') throw new Error('Worker replay identity conflicts with another request.');
    if (replay.status === 'inflight') throw new Error('Worker replay outcome is ambiguous and still in flight.');
    if (replay.status !== 'accepted') throw new Error('Worker replay capacity is unavailable.');
    if (admitRequest !== undefined) {
      if (typeof admitRequest !== 'function') throw new Error('Worker request admission seam is invalid.');
      await runBounded(() => admitRequest({
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        deadlineAt,
        signal: controller.signal,
      }));
    }

    const { root, realRoot } = await runBounded(() => ensureEphemeralRoot(ephemeralRoot));
    await runBounded(() => inspectOrphans({ root, realRoot, keyResolver, now: current }));
    if (!scanner || typeof scanner.health !== 'function' || typeof scanner.scan !== 'function') {
      throw new Error('Worker scanner adapter is unavailable.');
    }

    let preHealth;
    try {
      preHealth = await runBounded(
        () => scanner.health({ deadlineMs: remainingDeadlineMs(deadlineAt), signal: controller.signal }),
      );
    }
    catch { preHealth = null; }
    let staged = { outcome: 'unavailable', reasonCode: 'scanner_unavailable' };
    let cleanupStatus = 'cleaned';
    let taskPath = null;
    const scannerHealthy = validHealth(preHealth, signatureCurrent);
    if (!scannerHealthy) {
      staged = { outcome: 'unavailable', reasonCode: 'stale_signatures' };
      preHealth = {
        daemonId: 'unavailable', engineVersion: 'unavailable', signatureVersion: 'unavailable',
        signatureUpdatedAt: current.toISOString(),
      };
    }
    if (scannerHealthy || requireAttachment) {
      taskPath = path.join(root, `task-${request.requestId}`);
      await runBounded(() => fsp.mkdir(taskPath, { mode: 0o700 }));
      const markerPath = path.join(taskPath, 'owner.json');
      await runBounded(() => fsp.writeFile(markerPath, createMarker(request, resolveKey(keyResolver, request.keyId)), {
        mode: 0o600, flag: 'wx',
      }));
      try {
        const identity = await writeTaskCopy({
          request, taskPath, openByteStream, deadlineAt, controller,
        });
        if (identity.size !== request.sizeBytes || identity.sha256 !== request.sha256) {
          staged = { outcome: 'ambiguous', reasonCode: 'attachment_identity_mismatch' };
        } else if (scannerHealthy) {
          let receivedScannerResult = false;
          try {
            staged = await runBounded(() => scanner.scan({
              byteStream: scannerByteStream(identity.attachmentPath),
              maxBytes: request.maxBytes,
              deadlineMs: remainingDeadlineMs(deadlineAt),
              signal: controller.signal,
            }));
            receivedScannerResult = true;
          } catch {
            staged = { outcome: 'unavailable', reasonCode: 'scanner_unavailable' };
          }
          let postHealth;
          try {
            postHealth = await runBounded(
              () => scanner.health({ deadlineMs: remainingDeadlineMs(deadlineAt), signal: controller.signal }),
            );
          }
          catch { postHealth = null; }
          if (receivedScannerResult && staged.daemonId !== preHealth.daemonId) {
            staged = { outcome: staged.outcome === 'unsafe' ? 'unsafe' : 'ambiguous',
              reasonCode: staged.outcome === 'unsafe' ? 'malware_found' : 'scanner_identity_changed' };
          }
          if (!sameHealth(preHealth, postHealth)) {
            staged = { outcome: staged.outcome === 'unsafe' ? 'unsafe' : 'ambiguous',
              reasonCode: staged.outcome === 'unsafe' ? 'malware_found' : 'signature_evidence_changed' };
          }
        }
      } catch {
        staged = { outcome: 'ambiguous', reasonCode: 'attachment_identity_mismatch' };
      }
    }

    if (taskPath) {
      try {
        const cleaned = await runBounded(
          () => cleanupOwnedTask({ root, realRoot, taskPath, request, keyResolver }),
        );
        cleanupStatus = cleaned?.cleaned === true ? 'cleaned' : 'retained';
      } catch (error) {
        if (isWorkerDeadlineError(error)
          || isWorkerDeadlineError(controller.signal.reason)) {
          throw isWorkerDeadlineError(error) ? error : controller.signal.reason;
        }
        cleanupStatus = 'retained';
      }
      if (cleanupStatus !== 'cleaned' && staged.outcome === 'clean') {
        staged = { outcome: 'ambiguous', reasonCode: 'cleanup_uncertain' };
      }
    }

    remainingDeadlineMs(deadlineAt);
    const scannedAt = nowDate(now);
    const resultWire = createSignedScanResult({
      request,
      outcome: staged.outcome,
      reasonCode: staged.reasonCode,
      engineVersion: preHealth.engineVersion,
      signatureVersion: preHealth.signatureVersion,
      signatureUpdatedAt: preHealth.signatureUpdatedAt,
      scannedAt: scannedAt.toISOString(),
      expiresAt: resultExpiry(request, scannedAt),
      cleanupStatus,
    }, { keyResolver });
    const completed = await runBounded(() => replayStore.complete({
      keyId: request.keyId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      resultWire,
      deadlineAt,
      signal: controller.signal,
    }));
    if (!completed) throw new Error('Worker replay completion lost ownership.');
    return resultWire;
  } finally {
    release();
  }
}
