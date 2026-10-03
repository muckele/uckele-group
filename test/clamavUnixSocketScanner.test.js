import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClamavUnixSocketScanner,
} from '../server/services/clamavUnixSocketScanner.js';

function connectorFixture(responses) {
  const sessions = [];
  return {
    sessions,
    async connectUnix({ socketPath }) {
      const written = [];
      let destroyed = false;
      const response = responses[sessions.length];
      const session = {
        socketPath,
        peerIdentity: 'unix-socket-inode:synthetic-1',
        written,
        get destroyed() { return destroyed; },
        async write(chunk) { written.push(Buffer.from(chunk)); },
        async *read() {
          for (const chunk of response || []) yield Buffer.from(chunk);
        },
        destroy() { destroyed = true; },
      };
      sessions.push(session);
      return session;
    },
  };
}

async function* chunks(...values) {
  for (const value of values) yield Buffer.from(value);
}

test('ClamAV adapter accepts only an absolute Unix socket and has no TCP API', () => {
  const connector = connectorFixture([]);
  assert.throws(
    () => createClamavUnixSocketScanner({ socketPath: '127.0.0.1:3310', connectUnix: connector.connectUnix }),
    /absolute Unix socket/i,
  );
  assert.throws(
    () => createClamavUnixSocketScanner({ socketPath: '/run/clamav/clamd.sock', host: '127.0.0.1', connectUnix: connector.connectUnix }),
    /TCP|unsupported/i,
  );
});

test('ClamAV adapter writes exact zINSTREAM frames and maps clean response', async () => {
  const connector = connectorFixture([[Buffer.from('stream: OK\0')]]);
  const scanner = createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock',
    connectUnix: connector.connectUnix,
  });
  const result = await scanner.scan({
    byteStream: chunks('ab', 'c'),
    maxBytes: 10,
    deadlineMs: 1_000,
  });
  assert.deepEqual(result, {
    outcome: 'clean', reasonCode: 'clean', daemonId: 'unix-socket-inode:synthetic-1',
  });
  assert.equal(connector.sessions.length, 1);
  const frame = Buffer.concat(connector.sessions[0].written);
  assert.equal(frame.subarray(0, 10).toString(), 'zINSTREAM\0');
  assert.equal(frame.readUInt32BE(10), 2);
  assert.equal(frame.subarray(14, 16).toString(), 'ab');
  assert.equal(frame.readUInt32BE(16), 1);
  assert.equal(frame.subarray(20, 21).toString(), 'c');
  assert.equal(frame.readUInt32BE(21), 0);
  assert.equal(connector.sessions[0].destroyed, true);
});

test('ClamAV adapter maps fragmented FOUND, ERROR, and malformed results fail closed', async () => {
  const foundConnector = connectorFixture([[
    Buffer.from('stream: EICAR'), Buffer.from('-Synthetic FOUND\0'),
  ]]);
  const found = await createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock', connectUnix: foundConnector.connectUnix,
  }).scan({ byteStream: chunks('x'), maxBytes: 2, deadlineMs: 1_000 });
  assert.deepEqual(found, {
    outcome: 'unsafe', reasonCode: 'malware_found', daemonId: 'unix-socket-inode:synthetic-1',
  });

  const errorConnector = connectorFixture([[Buffer.from('stream: synthetic failure ERROR\0')]]);
  const unavailable = await createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock', connectUnix: errorConnector.connectUnix,
  }).scan({ byteStream: chunks('x'), maxBytes: 2, deadlineMs: 1_000 });
  assert.deepEqual(unavailable, {
    outcome: 'unavailable', reasonCode: 'scanner_error', daemonId: 'unix-socket-inode:synthetic-1',
  });

  for (const response of [
    [Buffer.from('stream: OK')],
    [Buffer.from('other: OK\0')],
    [Buffer.from('stream: OK\0stream: OK\0')],
    [Buffer.from('stream: MAYBE\0')],
  ]) {
    const connector = connectorFixture([response]);
    const result = await createClamavUnixSocketScanner({
      socketPath: '/run/clamav/clamd.sock', connectUnix: connector.connectUnix,
    }).scan({ byteStream: chunks('x'), maxBytes: 2, deadlineMs: 1_000 });
    assert.deepEqual(result, {
      outcome: 'ambiguous', reasonCode: 'scanner_response_ambiguous',
      daemonId: 'unix-socket-inode:synthetic-1',
    });
  }
});

test('ClamAV adapter destroys socket on byte/response cap and timeout', async () => {
  const byteConnector = connectorFixture([[Buffer.from('stream: OK\0')]]);
  const byteScanner = createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock', connectUnix: byteConnector.connectUnix,
  });
  await assert.rejects(
    byteScanner.scan({ byteStream: chunks('abc'), maxBytes: 2, deadlineMs: 1_000 }),
    /maximum bytes/i,
  );
  assert.equal(byteConnector.sessions[0].destroyed, true);

  const responseConnector = connectorFixture([[Buffer.alloc(4097, 65)]]);
  const responseScanner = createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock', connectUnix: responseConnector.connectUnix,
  });
  await assert.rejects(
    responseScanner.scan({ byteStream: chunks('x'), maxBytes: 2, deadlineMs: 1_000 }),
    /response.*maximum/i,
  );
  assert.equal(responseConnector.sessions[0].destroyed, true);

  let destroyed = false;
  const timeoutScanner = createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock',
    async connectUnix() {
      return {
        peerIdentity: 'unix-socket-inode:synthetic-timeout',
        async write() {},
        read() {
          return {
            [Symbol.asyncIterator]() { return this; },
            next() { return new Promise(() => {}); },
          };
        },
        destroy() { destroyed = true; },
      };
    },
  });
  await assert.rejects(
    timeoutScanner.scan({ byteStream: chunks('x'), maxBytes: 2, deadlineMs: 10 }),
    /deadline/i,
  );
  assert.equal(destroyed, true);
});

test('ClamAV adapter aborts a timed-out connect and destroys a late session', async () => {
  let signal;
  let destroyed = false;
  const scanner = createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock',
    async connectUnix(command) {
      signal = command.signal;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        peerIdentity: 'unix-socket-inode:synthetic-late',
        async write() {},
        async *read() {},
        destroy() { destroyed = true; },
      };
    },
  });
  await assert.rejects(
    scanner.health({ deadlineMs: 10 }),
    /deadline/i,
  );
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(destroyed, true);
});

test('ClamAV health snapshot is parsed from the same Unix-only adapter', async () => {
  const connector = connectorFixture([[
    Buffer.from('ClamAV 1.4.3/27831/2026-10-03T11:55:00.000Z\0'),
  ]]);
  const health = await createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock', connectUnix: connector.connectUnix,
  }).health({ deadlineMs: 1_000 });
  assert.deepEqual(health, {
    healthy: true,
    daemonId: 'unix-socket-inode:synthetic-1',
    engineVersion: '1.4.3',
    signatureVersion: '27831',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
  });
  assert.equal(Buffer.concat(connector.sessions[0].written).toString(), 'zVERSION\0');
  assert.equal(connector.sessions[0].destroyed, true);
});
