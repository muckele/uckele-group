import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const defaultMaximumEntries = 10_000;
const maximumRecordBytes = 64 * 1024;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const recordNamePattern = /^(claim|result)-([a-f0-9]{64})\.json$/;
const temporaryPrefix = '.cim-replay-tmp-';
const temporaryNamePattern = /^\.cim-replay-tmp-(\d+)-[0-9a-f-]+$/;
const slotNamePattern = /^slot-(\d{5})\.json$/;

function currentTime(now) {
  const value = now();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Replay store clock is invalid.');
  return parsed;
}

function validateRoot(root) {
  const value = String(root || '').trim();
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error('Replay store root must be an explicit bounded absolute path.');
  }
  return path.resolve(value);
}

function validateIdentity({ keyId, requestId, requestDigest, expiresAt }) {
  if (!identityPattern.test(String(keyId || '')) || !identityPattern.test(String(requestId || ''))) {
    throw new Error('Replay identity is invalid.');
  }
  if (!digestPattern.test(String(requestDigest || ''))) throw new Error('Replay digest is invalid.');
  const expiry = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(expiry)) throw new Error('Replay expiry is invalid.');
  return expiry;
}

function identityHash(keyId, requestId) {
  return createHash('sha256')
    .update('uckele.cim-scan.v1/replay\0', 'utf8')
    .update(keyId, 'utf8')
    .update('\0', 'utf8')
    .update(requestId, 'utf8')
    .digest('hex');
}

async function syncDirectory(root) {
  const handle = await fsp.open(root, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readCanonicalRecord(file, expectedFields) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumRecordBytes) {
    throw new Error('Replay store contains an invalid record.');
  }
  const wire = await fsp.readFile(file, 'utf8');
  let record;
  try { record = JSON.parse(wire); } catch { throw new Error('Replay store record is malformed.'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || JSON.stringify(record) !== wire
    || Object.keys(record).join(',') !== expectedFields.join(',')) {
    throw new Error('Replay store record is noncanonical.');
  }
  return record;
}

async function readOptionalRecord(file, expectedFields) {
  try {
    return await readCanonicalRecord(file, expectedFields);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertActive({ deadlineAt, signal } = {}) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    const error = new Error('Replay store deadline is invalid or expired.');
    error.code = 'CIM_SCAN_DEADLINE';
    throw error;
  }
  if (!signal || typeof signal.aborted !== 'boolean') {
    throw new Error('Replay store abort signal is required.');
  }
  if (signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Replay store operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function atomicCreate(root, file, value, guard) {
  guard();
  const candidate = path.join(root, `${temporaryPrefix}${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await fsp.open(candidate, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    guard();
    try {
      await fsp.link(candidate, file);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    await syncDirectory(root);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(candidate).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function ensureRoot(root) {
  try {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Replay store root must be a private real directory.');
  }
}

function claimFile(root, hash) {
  return path.join(root, `claim-${hash}.json`);
}

function resultFile(root, hash) {
  return path.join(root, `result-${hash}.json`);
}

function slotFile(root, index) {
  return path.join(root, `slot-${String(index).padStart(5, '0')}.json`);
}

async function existingStatus(root, hash, input, at) {
  const existing = await readOptionalRecord(claimFile(root, hash), [
    'keyId', 'requestId', 'requestDigest', 'expiresAt',
  ]);
  if (!existing) return null;
  if (existing.keyId !== input.keyId || existing.requestId !== input.requestId) {
    throw new Error('Replay store identity hash collision.');
  }
  if (existing.requestDigest !== input.requestDigest) return { status: 'conflict' };
  const result = await readOptionalRecord(resultFile(root, hash), [
    'keyId', 'requestId', 'requestDigest', 'resultExpiresAt', 'resultWire',
  ]);
  if (result) {
    if (result.keyId !== input.keyId || result.requestId !== input.requestId
      || result.requestDigest !== input.requestDigest) {
      throw new Error('Replay store result identity is inconsistent.');
    }
    if (Date.parse(result.resultExpiresAt) > at) {
      return { status: 'replay', resultWire: result.resultWire };
    }
  }
  return { status: 'inflight' };
}

async function removeExactReservation(file, reservationId, guard) {
  const record = await readOptionalRecord(file, [
    'identityHash', 'ownerPid', 'reservationId', 'expiresAt',
  ]);
  if (!record || record.reservationId !== reservationId) return;
  guard();
  await fsp.unlink(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function inspectAndPrune(root, at, guard) {
  const names = (await fsp.readdir(root)).sort();
  const claims = new Map();
  const results = new Set();
  const slots = new Map();
  for (const name of names) {
    const file = path.join(root, name);
    if (name.startsWith(temporaryPrefix)) {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Replay store contains invalid interrupted state.');
      }
      const match = temporaryNamePattern.exec(name);
      if (match && processIsAlive(Number(match[1]))) continue;
      guard();
      await fsp.unlink(file);
      continue;
    }
    const slotMatch = slotNamePattern.exec(name);
    if (slotMatch) {
      slots.set(Number(slotMatch[1]), file);
      continue;
    }
    const match = recordNamePattern.exec(name);
    if (!match) throw new Error('Replay store contains unknown state.');
    if (match[1] === 'result') results.add(match[2]);
    else claims.set(match[2], file);
  }
  for (const hash of results) {
    if (!claims.has(hash)) throw new Error('Replay store contains an orphan result.');
  }
  for (const [hash, file] of claims) {
    const claim = await readCanonicalRecord(file, [
      'keyId', 'requestId', 'requestDigest', 'expiresAt',
    ]);
    validateIdentity(claim);
    if (identityHash(claim.keyId, claim.requestId) !== hash) {
      throw new Error('Replay store claim identity is inconsistent.');
    }
    if (Date.parse(claim.expiresAt) <= at) {
      guard();
      await fsp.unlink(resultFile(root, hash)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      guard();
      await fsp.unlink(file);
      claims.delete(hash);
    }
  }
  const claimedSlots = new Map();
  for (const [index, file] of slots) {
    const slot = await readCanonicalRecord(file, [
      'identityHash', 'ownerPid', 'reservationId', 'expiresAt',
    ]);
    if (!digestPattern.test(slot.identityHash)
      || !Number.isSafeInteger(slot.ownerPid) || slot.ownerPid < 1
      || typeof slot.reservationId !== 'string' || slot.reservationId.length > 64
      || !Number.isFinite(Date.parse(slot.expiresAt))) {
      throw new Error('Replay store slot is invalid.');
    }
    const claimExists = claims.has(slot.identityHash);
    const duplicate = claimExists && claimedSlots.has(slot.identityHash);
    const activeReservation = processIsAlive(slot.ownerPid) && Date.parse(slot.expiresAt) > at;
    const abandoned = !claimExists && !activeReservation;
    if ((duplicate && !activeReservation) || abandoned) {
      guard();
      await fsp.unlink(file);
      slots.delete(index);
      continue;
    }
    if (claimExists) claimedSlots.set(slot.identityHash, index);
  }
  for (const hash of claims.keys()) {
    if (!claimedSlots.has(hash)) throw new Error('Replay store claim has no capacity reservation.');
  }
  await syncDirectory(root);
}

async function reserveSlot({ root, maxEntries, hash, requestExpiry, guard }) {
  for (let index = 0; index < maxEntries; index += 1) {
    const reservationId = randomUUID();
    const record = JSON.stringify({
      identityHash: hash,
      ownerPid: process.pid,
      reservationId,
      expiresAt: new Date(requestExpiry).toISOString(),
    });
    if (await atomicCreate(root, slotFile(root, index), record, guard)) {
      return { file: slotFile(root, index), reservationId };
    }
  }
  return null;
}

export function createFilesystemCimReplayStore({
  root,
  maxEntries = defaultMaximumEntries,
  now = () => new Date(),
} = {}) {
  const replayRoot = validateRoot(root);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > defaultMaximumEntries) {
    throw new Error('Replay store maximum entries is invalid.');
  }
  if (typeof now !== 'function') throw new Error('Replay store clock must be a function.');
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const running = queue.then(operation, operation);
    queue = running.catch(() => {});
    return running;
  };

  return Object.freeze({
    async claim(input = {}) {
      return serialized(async () => {
        const guard = () => assertActive(input);
        guard();
        const requestExpiry = validateIdentity(input);
        const at = currentTime(now);
        guard();
        await ensureRoot(replayRoot);
        await inspectAndPrune(replayRoot, at, guard);
        const hash = identityHash(input.keyId, input.requestId);
        const existing = await existingStatus(replayRoot, hash, input, at);
        if (existing) return existing;
        if (requestExpiry <= at) return { status: 'capacity' };
        const reservation = await reserveSlot({
          root: replayRoot, maxEntries, hash, requestExpiry, guard,
        });
        if (!reservation) {
          const raced = await existingStatus(replayRoot, hash, input, currentTime(now));
          return raced || { status: 'capacity' };
        }
        const record = JSON.stringify({
          keyId: input.keyId,
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          expiresAt: new Date(requestExpiry).toISOString(),
        });
        try {
          const publishGuard = () => {
            guard();
            if (requestExpiry <= currentTime(now)) {
              throw new Error('Replay request expired before its claim was published.');
            }
          };
          if (!await atomicCreate(replayRoot, claimFile(replayRoot, hash), record, publishGuard)) {
            await removeExactReservation(reservation.file, reservation.reservationId, () => {});
            const raced = await existingStatus(replayRoot, hash, input, currentTime(now));
            if (!raced) throw new Error('Replay claim race lost without durable authority.');
            return raced;
          }
          return { status: 'accepted' };
        } catch (error) {
          const published = await readOptionalRecord(claimFile(replayRoot, hash), [
            'keyId', 'requestId', 'requestDigest', 'expiresAt',
          ]).catch(() => null);
          if (!published || published.requestDigest !== input.requestDigest) {
            await removeExactReservation(reservation.file, reservation.reservationId, () => {});
          }
          throw error;
        }
      });
    },

    async complete(input = {}) {
      return serialized(async () => {
        const guard = () => assertActive(input);
        guard();
        validateIdentity({ ...input, expiresAt: new Date(currentTime(now) + 1).toISOString() });
        const at = currentTime(now);
        guard();
        await ensureRoot(replayRoot);
        await inspectAndPrune(replayRoot, at, guard);
        const hash = identityHash(input.keyId, input.requestId);
        const claim = await readOptionalRecord(claimFile(replayRoot, hash), [
          'keyId', 'requestId', 'requestDigest', 'expiresAt',
        ]);
        if (!claim || claim.keyId !== input.keyId || claim.requestId !== input.requestId
          || claim.requestDigest !== input.requestDigest) return false;
        if (await readOptionalRecord(resultFile(replayRoot, hash), [
          'keyId', 'requestId', 'requestDigest', 'resultExpiresAt', 'resultWire',
        ])) return false;
        let result;
        try { result = JSON.parse(input.resultWire); } catch { return false; }
        const resultExpiresAt = Date.parse(result?.expiresAt || '');
        if (result?.keyId !== input.keyId || result?.requestId !== input.requestId
          || result?.requestDigest !== input.requestDigest
          || !Number.isFinite(resultExpiresAt) || resultExpiresAt <= at
          || resultExpiresAt > Date.parse(claim.expiresAt)) return false;
        const record = JSON.stringify({
          keyId: input.keyId,
          requestId: input.requestId,
          requestDigest: input.requestDigest,
          resultExpiresAt: new Date(resultExpiresAt).toISOString(),
          resultWire: input.resultWire,
        });
        return atomicCreate(replayRoot, resultFile(replayRoot, hash), record, guard);
      });
    },
  });
}
