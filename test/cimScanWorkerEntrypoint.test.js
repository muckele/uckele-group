import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadCimScanWorkerConfig,
  runCimScanWorkerEntrypoint,
} from '../server/services/cimScanWorkerEntrypoint.js';

test('worker configuration is one-shot and ClamAV is Unix-socket-only', () => {
  const base = {
    CIM_SCAN_KEY_ID: 'key-1',
    CIM_SCAN_KEY_FILE: '/run/secrets/cim-scan-key',
    CIM_SCAN_REQUEST_FILE: '/run/task/request.json',
    CIM_SCAN_ATTACHMENT_FILE: '/run/task/attachment.bin',
    CIM_SCAN_REPLAY_ROOT: '/data/cim-scan-replay',
    CIM_SCAN_EPHEMERAL_ROOT: '/run/cim-scan-tasks',
    CLAMAV_UNIX_SOCKET: '/run/clamav/clamd.sock',
  };
  assert.deepEqual(loadCimScanWorkerConfig(base), {
    keyId: 'key-1', keyFile: base.CIM_SCAN_KEY_FILE,
    requestFile: base.CIM_SCAN_REQUEST_FILE, attachmentFile: base.CIM_SCAN_ATTACHMENT_FILE,
    replayRoot: base.CIM_SCAN_REPLAY_ROOT, ephemeralRoot: base.CIM_SCAN_EPHEMERAL_ROOT,
    clamavSocketPath: base.CLAMAV_UNIX_SOCKET,
  });
  assert.throws(() => loadCimScanWorkerConfig({ ...base, CLAMAV_HOST: '127.0.0.1' }), /TCP|host/i);
  assert.throws(() => loadCimScanWorkerConfig({ ...base, CLAMAV_PORT: '3310' }), /TCP|port/i);
  assert.throws(() => loadCimScanWorkerConfig({ ...base, CLAMAV_UNIX_SOCKET: 'clamd.sock' }), /absolute/i);
});

test('worker entrypoint loads private inputs and leaves attachment opening lazy', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-cim-entrypoint-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const files = {
    keyFile: path.join(root, 'key'), requestFile: path.join(root, 'request.json'),
    attachmentFile: path.join(root, 'attachment.bin'), replayRoot: path.join(root, 'replay'),
    ephemeralRoot: path.join(root, 'tasks'), clamavSocketPath: path.join(root, 'clamd.sock'),
  };
  await fsp.writeFile(files.keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  await fsp.writeFile(files.requestFile, '{"synthetic":true}', { mode: 0o600 });
  await fsp.writeFile(files.attachmentFile, 'abc', { mode: 0o600 });
  let observed;
  const output = [];
  await runCimScanWorkerEntrypoint({
    config: { keyId: 'key-1', ...files },
    createScanner: ({ socketPath }) => ({ socketPath }),
    createReplayStore: ({ root: replayRoot }) => ({ replayRoot }),
    async runTask(options) {
      observed = options;
      assert.equal(options.requestWire, '{"synthetic":true}');
      assert.equal(options.scanner.socketPath, files.clamavSocketPath);
      assert.equal(options.replayStore.replayRoot, files.replayRoot);
      const chunks = [];
      for await (const chunk of options.openByteStream()) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), 'abc');
      return 'signed-result-wire';
    },
    writeResult(value) { output.push(value); },
  });
  assert.equal(typeof observed.keyResolver, 'function');
  assert.equal(observed.keyResolver('key-1').length, 32);
  assert.equal(observed.keyResolver('other'), null);
  assert.deepEqual(output, ['signed-result-wire']);
});

test('scanner package keeps the official source tag but requires unresolved immutable digests', async () => {
  const dockerfile = await fsp.readFile('containers/cim-scan-worker/Containerfile', 'utf8');
  const clamConfig = await fsp.readFile('containers/cim-scan-worker/clamd.conf', 'utf8');
  const sourceLock = JSON.parse(await fsp.readFile('containers/cim-scan-worker/source-lock.json', 'utf8'));
  assert.match(dockerfile, /^ARG NODE_BASE_DIGEST\nARG CLAMAV_BASE_DIGEST\nFROM node:22-alpine@\$\{NODE_BASE_DIGEST\}/);
  assert.match(dockerfile, /FROM clamav\/clamav:1\.4\.6_base@\$\{CLAMAV_BASE_DIGEST\}/);
  assert.doesNotMatch(dockerfile, /ARG (?:CLAMAV|NODE)_BASE_DIGEST=/);
  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(clamConfig, /^LocalSocket \/run\/clamav\/clamd\.sock$/m);
  assert.doesNotMatch(clamConfig, /^\s*(?:TCPAddr|TCPSocket)\b/m);
  assert.equal(sourceLock.status, 'blocked-pending-authoritative-digests');
  assert.deepEqual(sourceLock.clamav, {
    repository: 'clamav/clamav', tag: '1.4.6_base', digest: null,
  });
  assert.equal(sourceLock.nodeRuntime.digest, null);
  assert.equal(sourceLock.dependencyLock, 'package-lock.json');
});
