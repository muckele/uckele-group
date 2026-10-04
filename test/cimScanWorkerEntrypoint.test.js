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

test('scanner package locks official sources for linux/amd64', async () => {
  const dockerfile = await fsp.readFile('containers/cim-scan-worker/Containerfile', 'utf8');
  const clamConfig = await fsp.readFile('containers/cim-scan-worker/clamd.conf', 'utf8');
  const sourceLock = JSON.parse(await fsp.readFile('containers/cim-scan-worker/source-lock.json', 'utf8'));
  assert.match(dockerfile, /^ARG NODE_BASE_DIGEST=sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402\nARG CLAMAV_BASE_DIGEST=sha256:90effb795234e6a93b070310a4bab5a58d93d94b9a077a09ce2229947679782b\nFROM node:22-alpine@\$\{NODE_BASE_DIGEST\}/);
  assert.match(dockerfile, /FROM clamav\/clamav:1\.4\.6_base@\$\{CLAMAV_BASE_DIGEST\}/);
  assert.match(dockerfile, /COPY package\.json package-lock\.json/);
  const runLines = dockerfile.split('\n').filter((line) => line.startsWith('RUN '));
  const npmRun = dockerfile.match(/^RUN [\s\S]*?(?=\n\nFROM )/m)?.[0];
  assert.equal(runLines.length, 1);
  assert.ok(npmRun);
  assert.doesNotMatch(dockerfile, /^RUN --network=/m);
  assert.match(npmRun, /env -i/);
  assert.match(npmRun, /npm_config_userconfig=\/tmp\/uckele-npm-config\/user\.npmrc/);
  assert.match(npmRun, /npm_config_globalconfig=\/tmp\/uckele-npm-config\/global\.npmrc/);
  assert.match(npmRun, /npm_config_foreground_scripts=true/);
  assert.match(npmRun, /npm_config_loglevel=silly/);
  assert.match(npmRun, /npm_config_timing=true/);
  assert.match(npmRun, /npm ci --omit=dev/);
  assert.equal((dockerfile.match(/npm ci --omit=dev/g) ?? []).length, 1);
  assert.doesNotMatch(dockerfile, /^RUN chmod\b/m);
  for (const entrypoint of [
    'http-entrypoint.sh', 'stale-benchmark-entrypoint.sh', 'entrypoint.sh',
  ]) {
    assert.match(dockerfile, new RegExp(`^COPY --chmod=0555 .*${entrypoint} `, 'm'));
  }
  assert.match(dockerfile,
    /COPY server\/services\/cimScanWorkerAdmission\.js \/opt\/uckele\/server\/services\/cimScanWorkerAdmission\.js/);
  assert.match(clamConfig, /^LocalSocket \/run\/clamav\/clamd\.sock$/m);
  assert.doesNotMatch(clamConfig, /^\s*(?:TCPAddr|TCPSocket)\b/m);
  assert.equal(sourceLock.status, 'locked');
  assert.equal(sourceLock.platform, 'linux/amd64');
  assert.deepEqual(sourceLock.clamav, {
    repository: 'clamav/clamav', tag: '1.4.6_base',
    digest: 'sha256:90effb795234e6a93b070310a4bab5a58d93d94b9a077a09ce2229947679782b',
    platformDigest: 'sha256:58d9b21b5694a1f5b3a136e4f2e4fc6b463fce88635737e16f8cb9ee9455a199',
  });
  assert.deepEqual(sourceLock.nodeRuntime, {
    repository: 'node', tag: '22-alpine',
    digest: 'sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402',
    platformDigest: 'sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8',
  });
  assert.equal(sourceLock.dependencyLock, 'package-lock.json');
});

test('scanner package has explicit HTTP-worker and synthetic-caller targets without production startup', async () => {
  const dockerfile = await fsp.readFile('containers/cim-scan-worker/Containerfile', 'utf8');
  const callerStage = dockerfile.match(/FROM node-runtime AS cim-scan-synthetic-caller[\s\S]*?(?=\nFROM )/)?.[0];
  const baseStage = dockerfile.match(/FROM clamav\/clamav:[^\n]+ AS cim-scan-worker-base[\s\S]*?(?=\nFROM )/)?.[0];
  const normalStage = dockerfile.match(/FROM cim-scan-worker-base AS cim-scan-http-worker[\s\S]*?(?=\nFROM )/)?.[0];
  const staleStage = dockerfile.match(/FROM cim-scan-worker-base AS cim-scan-stale-benchmark-worker[\s\S]*?(?=\nFROM )/)?.[0];
  assert.ok(callerStage);
  assert.ok(baseStage);
  assert.ok(normalStage);
  assert.ok(staleStage);
  assert.match(dockerfile, /FROM clamav\/clamav:1\.4\.6_base@\$\{CLAMAV_BASE_DIGEST\} AS cim-scan-worker-base/);
  assert.match(dockerfile, /FROM cim-scan-worker-base AS cim-scan-http-worker/);
  assert.match(dockerfile,
    /COPY server\/services\/cimScanWorkerHttpRuntime\.js \/opt\/uckele\/server\/services\/cimScanWorkerHttpRuntime\.js/);
  assert.match(dockerfile,
    /COPY scripts\/run-cim-scan-worker-http\.js \/opt\/uckele\/scripts\/run-cim-scan-worker-http\.js/);
  assert.match(normalStage,
    /ENTRYPOINT \["\/usr\/local\/bin\/uckele-cim-scan-http-entrypoint"\]/);
  assert.doesNotMatch(baseStage, /cimScanWorkerBenchmarkClock|stale-benchmark/);
  assert.doesNotMatch(normalStage, /cimScanWorkerBenchmarkClock|stale-benchmark/);
  assert.match(staleStage,
    /COPY server\/services\/cimScanWorkerBenchmarkClock\.js \/opt\/uckele\/server\/services\/cimScanWorkerBenchmarkClock\.js/);
  assert.match(staleStage,
    /COPY scripts\/run-cim-scan-worker-stale-benchmark\.js \/opt\/uckele\/scripts\/run-cim-scan-worker-stale-benchmark\.js/);
  assert.match(staleStage,
    /COPY --chmod=0555 containers\/cim-scan-worker\/stale-benchmark-entrypoint\.sh \/usr\/local\/bin\/uckele-cim-scan-stale-benchmark-entrypoint/);
  assert.match(staleStage,
    /ENTRYPOINT \["\/usr\/local\/bin\/uckele-cim-scan-stale-benchmark-entrypoint"\]/);
  assert.match(dockerfile, /FROM node-runtime AS cim-scan-synthetic-caller/);
  assert.doesNotMatch(callerStage, /cimScanWorkerBenchmarkClock/);
  assert.match(dockerfile,
    /ENTRYPOINT \["node", "scripts\/run-cim-scan-cloud-synthetic\.js"\]/);
  assert.match(dockerfile, /FROM cim-scan-worker-base AS cim-scan-one-shot[\s\S]*ENTRYPOINT \["\/usr\/local\/bin\/uckele-cim-scan-entrypoint"\]\s*$/);
  assert.doesNotMatch(dockerfile, /COPY server\/(?:index|app)\.js/);
});
