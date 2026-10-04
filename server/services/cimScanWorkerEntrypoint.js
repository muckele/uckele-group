import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { constants } from 'node:fs';
import { CIM_SCAN_PROTOCOL_LIMITS } from './cimScanProtocol.js';
import { runOnDemandScanTask } from './cimScanWorker.js';
import { createClamavUnixSocketScanner } from './clamavUnixSocketScanner.js';
import { createFilesystemCimReplayStore } from './filesystemCimReplayStore.js';
import { createSingleCimScanAdmission } from './cimScanWorkerAdmission.js';

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function absolutePath(value, label) {
  const parsed = String(value || '').trim();
  if (!path.isAbsolute(parsed) || path.resolve(parsed) === path.parse(path.resolve(parsed)).root) {
    throw new Error(`${label} must be an explicit bounded absolute path.`);
  }
  return path.resolve(parsed);
}

export function loadCimScanWorkerConfig(environment = process.env) {
  if (environment.CLAMAV_HOST !== undefined || environment.CLAMAV_PORT !== undefined
    || environment.CLAMD_HOST !== undefined || environment.CLAMD_PORT !== undefined) {
    throw new Error('ClamAV TCP host and port configuration is forbidden.');
  }
  const keyId = String(environment.CIM_SCAN_KEY_ID || '');
  if (!identityPattern.test(keyId)) throw new Error('Worker key id is invalid.');
  return Object.freeze({
    keyId,
    keyFile: absolutePath(environment.CIM_SCAN_KEY_FILE, 'Worker key file'),
    requestFile: absolutePath(environment.CIM_SCAN_REQUEST_FILE, 'Worker request file'),
    attachmentFile: absolutePath(environment.CIM_SCAN_ATTACHMENT_FILE, 'Worker attachment file'),
    replayRoot: absolutePath(environment.CIM_SCAN_REPLAY_ROOT, 'Worker replay root'),
    ephemeralRoot: absolutePath(environment.CIM_SCAN_EPHEMERAL_ROOT, 'Worker ephemeral root'),
    clamavSocketPath: absolutePath(environment.CLAMAV_UNIX_SOCKET, 'ClamAV Unix socket'),
  });
}

async function readPrivateFile(file, { maximumBytes, minimumBytes = 1 } = {}) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || stat.size < minimumBytes || stat.size > maximumBytes) {
    throw new Error('Worker input file is not a bounded private regular file.');
  }
  return fsp.readFile(file);
}

function connectSocket({ socketPath, signal }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const abort = () => socket.destroy(signal.reason || new Error('Unix socket connection aborted.'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      signal?.removeEventListener('abort', abort);
      resolve(socket);
    });
  });
}

export function createNodeClamavUnixConnector({
  lstat = fsp.lstat,
  connect = connectSocket,
} = {}) {
  if (typeof lstat !== 'function' || typeof connect !== 'function') {
    throw new Error('Unix connector filesystem and connection seams are required.');
  }
  return async function connectUnix({ socketPath, signal } = {}) {
    const before = await lstat(socketPath);
    if (!before.isSocket() || before.isSymbolicLink()) throw new Error('ClamAV endpoint is not a real Unix socket.');
    const socket = await connect({ socketPath, signal });
    try {
      const after = await lstat(socketPath);
      if (!after.isSocket() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error('ClamAV Unix socket identity changed during connection.');
      }
      return {
        peerIdentity: `unix-socket:${after.dev}:${after.ino}`,
        write(chunk) {
          return new Promise((resolve, reject) => {
            socket.write(chunk, (error) => error ? reject(error) : resolve());
          });
        },
        read() { return socket; },
        destroy() { socket.destroy(); },
      };
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}

export async function runCimScanWorkerEntrypoint({
  config = loadCimScanWorkerConfig(),
  createReplayStore = createFilesystemCimReplayStore,
  createScanner = ({ socketPath }) => createClamavUnixSocketScanner({
    socketPath,
    connectUnix: createNodeClamavUnixConnector(),
  }),
  runTask = runOnDemandScanTask,
  writeResult = (value) => process.stdout.write(`${value}\n`),
} = {}) {
  const key = await readPrivateFile(config.keyFile, { maximumBytes: 4 * 1024, minimumBytes: 32 });
  const requestWire = (await readPrivateFile(config.requestFile, {
    maximumBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
  })).toString('utf8');
  const attachmentStat = await fsp.lstat(config.attachmentFile);
  if (!attachmentStat.isFile() || attachmentStat.isSymbolicLink()
    || (attachmentStat.mode & 0o077) !== 0
    || attachmentStat.size > CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes) {
    throw new Error('Worker attachment input is not a bounded private regular file.');
  }
  const attachmentHandle = await fsp.open(
    config.attachmentFile,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let opened = false;
  try {
    const resultWire = await runTask({
      requestWire,
      openByteStream() {
        if (opened) throw new Error('Worker attachment input may be opened only once.');
        opened = true;
        return attachmentHandle.createReadStream({ autoClose: false });
      },
      keyResolver: (candidate) => candidate === config.keyId ? key : null,
      replayStore: createReplayStore({ root: config.replayRoot }),
      admission: createSingleCimScanAdmission(),
      ephemeralRoot: config.ephemeralRoot,
      scanner: createScanner({ socketPath: config.clamavSocketPath }),
    });
    writeResult(resultWire);
  } finally {
    await attachmentHandle.close();
  }
}
