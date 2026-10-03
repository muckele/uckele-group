import path from 'node:path';
import { performance } from 'node:perf_hooks';

const commandInstream = Buffer.from('zINSTREAM\0', 'utf8');
const commandVersion = Buffer.from('zVERSION\0', 'utf8');
const maximumChunkBytes = 64 * 1024;
const maximumResponseBytes = 4 * 1024;

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

function validateFactoryOptions(options) {
  if (options?.host !== undefined || options?.port !== undefined) {
    throw new Error('ClamAV TCP configuration is unsupported.');
  }
  const socketPath = String(options?.socketPath || '');
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('ClamAV requires an absolute Unix socket path.');
  }
  if (typeof options?.connectUnix !== 'function') {
    throw new Error('An injected Unix socket connector is required.');
  }
  return socketPath;
}

function peerIdentity(session) {
  const value = String(session?.peerIdentity || '');
  if (!value || value.length > 160 || hasControlCharacter(value)) {
    session?.destroy?.();
    throw new Error('Unix socket connector did not provide a stable peer identity.');
  }
  return value;
}

function boundedDeadlineMs(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 90_000) {
    throw new Error('ClamAV deadline must be a bounded positive integer.');
  }
  return value;
}

function deadlineGuard(deadlineAt, session, promise) {
  const remaining = Math.max(0, deadlineAt - performance.now());
  if (remaining <= 0) {
    session?.destroy?.();
    return Promise.reject(new Error('ClamAV operation exceeded its deadline.'));
  }
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        session?.destroy?.();
        reject(new Error('ClamAV operation exceeded its deadline.'));
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function openSession(connectUnix, socketPath, deadlineAt) {
  let timer;
  let timedOut = false;
  const controller = new AbortController();
  const remaining = Math.max(0, deadlineAt - performance.now());
  if (remaining <= 0) throw new Error('ClamAV operation exceeded its deadline.');
  const connecting = Promise.resolve(connectUnix({ socketPath, signal: controller.signal }))
    .then((session) => {
      if (timedOut) session?.destroy?.();
      return session;
    });
  try {
    return await Promise.race([
      connecting,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('ClamAV operation exceeded its deadline.'));
          reject(new Error('ClamAV operation exceeded its deadline.'));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function write(session, chunk, deadlineAt) {
  if (!session || typeof session.write !== 'function' || typeof session.read !== 'function'
    || typeof session.destroy !== 'function') {
    session?.destroy?.();
    throw new Error('Unix socket connector returned an invalid session.');
  }
  await deadlineGuard(deadlineAt, session, session.write(chunk));
}

async function readBoundedResponse(session, deadlineAt) {
  const iterator = session.read()[Symbol.asyncIterator]();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await deadlineGuard(deadlineAt, session, iterator.next());
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      size += chunk.length;
      if (size > maximumResponseBytes) throw new Error('ClamAV response exceeds the maximum size.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    session.destroy();
    if (typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {});
    throw error;
  }
}

function parseTerminalResponse(buffer) {
  const firstNul = buffer.indexOf(0);
  if (firstNul < 0 || firstNul !== buffer.length - 1 || buffer.indexOf(0, firstNul + 1) >= 0) {
    return { outcome: 'ambiguous', reasonCode: 'scanner_response_ambiguous' };
  }
  const value = buffer.subarray(0, -1).toString('utf8');
  if (value === 'stream: OK') return { outcome: 'clean', reasonCode: 'clean' };
  if (value.startsWith('stream: ') && value.endsWith(' FOUND')) {
    const name = value.slice('stream: '.length, -' FOUND'.length);
    if (!name || name.length > 512 || hasControlCharacter(name)) {
      return { outcome: 'ambiguous', reasonCode: 'scanner_response_ambiguous' };
    }
    return { outcome: 'unsafe', reasonCode: 'malware_found' };
  }
  if (value.startsWith('stream: ') && value.endsWith(' ERROR')) {
    const error = value.slice('stream: '.length, -' ERROR'.length);
    if (!error || error.length > 512 || hasControlCharacter(error)) {
      return { outcome: 'ambiguous', reasonCode: 'scanner_response_ambiguous' };
    }
    return { outcome: 'unavailable', reasonCode: 'scanner_error' };
  }
  return { outcome: 'ambiguous', reasonCode: 'scanner_response_ambiguous' };
}

function parseVersionResponse(buffer) {
  const firstNul = buffer.indexOf(0);
  if (firstNul < 0 || firstNul !== buffer.length - 1) throw new Error('ClamAV VERSION response is ambiguous.');
  const value = buffer.subarray(0, -1).toString('utf8');
  if (!value.startsWith('ClamAV ') || hasControlCharacter(value)) {
    throw new Error('ClamAV VERSION response is invalid.');
  }
  const [engineVersion, signatureVersion, signatureTimestamp, ...extra] = value.slice('ClamAV '.length).split('/');
  if (extra.length > 0 || !engineVersion || engineVersion.length > 80
    || !/^[0-9]{1,20}$/.test(signatureVersion || '')
    || !signatureTimestamp || signatureTimestamp.length > 80) {
    throw new Error('ClamAV VERSION response is invalid.');
  }
  const signatureUpdatedAt = new Date(signatureTimestamp);
  if (!Number.isFinite(signatureUpdatedAt.getTime())) throw new Error('ClamAV signature timestamp is invalid.');
  return {
    healthy: true,
    daemonId: `ClamAV ${engineVersion}`,
    engineVersion,
    signatureVersion,
    signatureUpdatedAt: signatureUpdatedAt.toISOString(),
  };
}

export function createClamavUnixSocketScanner(options = {}) {
  const socketPath = validateFactoryOptions(options);
  const { connectUnix } = options;
  return Object.freeze({
    async health({ deadlineMs = 5_000 } = {}) {
      const deadlineAt = performance.now() + boundedDeadlineMs(deadlineMs);
      const session = await openSession(connectUnix, socketPath, deadlineAt);
      try {
        const daemonId = peerIdentity(session);
        await write(session, commandVersion, deadlineAt);
        const result = {
          ...parseVersionResponse(await readBoundedResponse(session, deadlineAt)),
          daemonId,
        };
        session.destroy();
        return result;
      } catch (error) {
        session.destroy();
        throw error;
      }
    },

    async scan({ byteStream, maxBytes, deadlineMs = 90_000 } = {}) {
      if (!byteStream || typeof byteStream[Symbol.asyncIterator] !== 'function') {
        throw new Error('ClamAV scan requires an async byte stream.');
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
        throw new Error('ClamAV maximum bytes is invalid.');
      }
      const deadlineAt = performance.now() + boundedDeadlineMs(deadlineMs);
      const session = await openSession(connectUnix, socketPath, deadlineAt);
      const daemonId = peerIdentity(session);
      const iterator = byteStream[Symbol.asyncIterator]();
      let size = 0;
      try {
        await write(session, commandInstream, deadlineAt);
        while (true) {
          const next = await deadlineGuard(deadlineAt, session, iterator.next());
          if (next.done) break;
          const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
          if (chunk.length === 0) continue;
          if (chunk.length > maximumChunkBytes) {
            for (let offset = 0; offset < chunk.length; offset += maximumChunkBytes) {
              const part = chunk.subarray(offset, Math.min(chunk.length, offset + maximumChunkBytes));
              if (part.length > maxBytes - size) throw new Error('ClamAV stream exceeds maximum bytes.');
              size += part.length;
              const length = Buffer.alloc(4);
              length.writeUInt32BE(part.length);
              await write(session, Buffer.concat([length, part]), deadlineAt);
            }
          } else {
            if (chunk.length > maxBytes - size) throw new Error('ClamAV stream exceeds maximum bytes.');
            size += chunk.length;
            const length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length);
            await write(session, Buffer.concat([length, chunk]), deadlineAt);
          }
        }
        await write(session, Buffer.alloc(4), deadlineAt);
        const result = {
          ...parseTerminalResponse(await readBoundedResponse(session, deadlineAt)),
          daemonId,
        };
        session.destroy();
        return result;
      } catch (error) {
        session.destroy();
        if (typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {});
        throw error;
      }
    },
  });
}
