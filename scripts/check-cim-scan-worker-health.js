#!/usr/bin/env node
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ping = Buffer.from('zPING\0', 'utf8');
const pong = Buffer.from('PONG\0', 'utf8');

function validateOptions({ socketPath, timeoutMs, lstat }) {
  const resolved = String(socketPath || '');
  if (!path.isAbsolute(resolved) || resolved.includes('\0')) {
    throw new Error('ClamAV healthcheck requires an absolute Unix socket path.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error('ClamAV healthcheck timeout is invalid.');
  }
  if (typeof lstat !== 'function') {
    throw new Error('ClamAV healthcheck lstat implementation is invalid.');
  }
  return resolved;
}

export async function checkClamavUnixSocketHealth({
  socketPath = '/run/clamav/clamd.sock',
  timeoutMs = 2_000,
  lstat = fsp.lstat,
} = {}) {
  const endpoint = validateOptions({ socketPath, timeoutMs, lstat });
  const before = await lstat(endpoint);
  if (!before.isSocket() || before.isSymbolicLink()) {
    throw new Error('ClamAV health endpoint is not a real Unix socket.');
  }

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('ClamAV healthcheck exceeded its deadline.'));
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    }

    socket.once('error', finish);
    socket.once('connect', async () => {
      try {
        const after = await lstat(endpoint);
        if (!after.isSocket() || after.isSymbolicLink()
          || before.dev !== after.dev || before.ino !== after.ino) {
          throw new Error('ClamAV health socket identity changed during connection.');
        }
        socket.write(ping);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > pong.length) {
        finish(new Error('ClamAV health response exceeds exact PONG.'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('end', () => {
      const response = Buffer.concat(chunks);
      if (!response.equals(pong)) {
        finish(new Error('ClamAV health response is not exact PONG.'));
        return;
      }
      finish();
    });
    socket.once('close', () => {
      if (!settled) finish(new Error('ClamAV health socket closed without exact PONG.'));
    });
  });
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  checkClamavUnixSocketHealth({
    socketPath: process.env.CLAMAV_UNIX_SOCKET || '/run/clamav/clamd.sock',
  }).catch(() => {
    process.stderr.write('CIM scan worker healthcheck failed.\n');
    process.exitCode = 1;
  });
}
