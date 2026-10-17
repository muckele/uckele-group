import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createP10bStoppedLogProbeTokenContext } from '../server/services/p10bHostAuthentication.js';
import { stoppedLogProbeFixture } from './helpers/p10bStoppedLogProbeFixture.js';
import { runP10bStoppedLogProbe } from '../server/services/p10bStoppedLogProbe.js';
import { openP10bNativeStoppedLogProbeClient } from '../server/services/p10bNativeStoppedLogProbeClient.js';
function assertPrivateProbeHousekeeping(root) {
  const allowed = process.platform === 'darwin' ? ['Library', 'Library/Caches', 'Library/Caches/goimports'] : ['.cache', '.cache/goimports'];
  let markers = 0;
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.uid, process.getuid());
      if (stat.isDirectory()) {
        assert.equal(allowed.includes(path.relative(root, file)), true);
        // Validate before descending: recursive readdir follows symlinks.
        walk(file);
      } else {
        assert.equal(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && directory === root
          && name.startsWith('.p10b-reap-') && name.endsWith('.pending'), true);
        markers++;
      }
    }
  }
  walk(root); assert.equal(markers, 1);
}
test('private-housekeeping inspection rejects a directory symlink before enumerating its target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-probe-housekeeping-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-probe-owned-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.symlinkSync(outside, path.join(root, process.platform === 'darwin' ? 'Library' : '.cache'));
  const read = fs.readdirSync; const visited = [];
  fs.readdirSync = directory => { visited.push(directory); return read(directory); };
  try { assert.throws(() => assertPrivateProbeHousekeeping(root)); } finally { fs.readdirSync = read; }
  assert.deepEqual(visited, [root]);
});
const executable = process.env.P10B_OFFLINE_STOPPED_LOG_PROBE;
for (const mode of ['empty', 'private-only', 'before-target', 'before-region', 'before-started', 'before-instance', 'before-image', 'before-config',
  'after-instance', 'after-config', 'machine-error', 'machine-duplicate', 'first-http', 'steady-http', 'first-error', 'first-errors',
  'missing-data', 'duplicate-data', 'trailing-data', 'redirect', 'reset', 'slow-first', 'slow-steady']) {
  test(`complete isolated stopped probe through native SDK and fake HTTP: ${mode}`, { skip: !executable, timeout: 12000 }, async t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-probe-http-'))); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const f = stoppedLogProbeFixture(directory, executable); const calls = [];
    const server = http.createServer((request, response) => {
      assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, undefined); calls.push(request.url);
      const machine = request.url === '/v1/apps/uckele-group-p10b/machines/0803730bd1d7e8'; const index = calls.length;
      assert.equal(request.url, machine ? '/v1/apps/uckele-group-p10b/machines/0803730bd1d7e8' : '/api/v1/apps/uckele-group-p10b/logs?instance=0803730bd1d7e8&next_token=');
      if (machine) {
        const m = { id: f.probe.machineId, region: 'ewr', state: 'stopped', instance_id: f.probe.baselineInstanceId,
          config: structuredClone(f.probe.baselineConfig), image_ref: { digest: f.probe.baselineImageDigest } };
        if (mode === 'before-target') m.id = 'other'; if (mode === 'before-region') m.region = 'ord'; if (mode === 'before-started') m.state = 'started';
        if (mode === 'before-instance' || mode === 'after-instance' && index === 4) m.instance_id = 'other';
        if (mode === 'before-image') m.image_ref.digest = 'sha256:' + 'a'.repeat(64);
        if (mode === 'before-config' || mode === 'after-config' && index === 4) m.config.env.P10B_QUALIFICATION_RUNTIME = 'true';
        if (mode === 'machine-error') m.errors = false;
        let text = JSON.stringify(m); if (mode === 'machine-duplicate') text = text.replace('"state":', '"state":"stopped","state":');
        response.end(text); return;
      }
      if (mode === 'slow-first' && index === 2 || mode === 'slow-steady' && index === 3) return;
      if (mode === 'first-http' && index === 2 || mode === 'steady-http' && index === 3) { response.writeHead(503); response.end('private-error-canary'); return; }
      if (mode === 'redirect') { response.writeHead(302, { location: '/forbidden-retry' }); response.end(); return; }
      if (mode === 'reset') { response.destroy(); return; }
      response.end(mode === 'first-error' ? '{"data":[],"error":null}' : mode === 'first-errors' ? '{"data":[],"errors":false}'
        : mode === 'missing-data' ? '{}' : mode === 'duplicate-data' ? '{"data":[],"data":[]}' : mode === 'trailing-data' ? '{"data":[]}{}'
          : JSON.stringify({ data: mode === 'private-only' ? [{ attributes: { instance: 'other', message: 'private-application-canary', region: 'ord' } }] : [], meta: { next_token: 'private-cursor-canary' } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const result = await runP10bStoppedLogProbe({ ...f, executable, checkSource: head => assert.equal(head, f.probe.hostSourceHead),
      environment: { FLY_API_TOKEN: 'synthetic-isolated-probe-canary' }, openClient: options => openP10bNativeStoppedLogProbeClient({ ...options,
        args: ['-test.run=^TestOfflineStoppedLogProbeTransport$'], environment: { ...options.environment, P10B_STOPPED_LOG_PROBE_TEST_HTTP_URL: `http://127.0.0.1:${server.address().port}` } }) });
    const positive = ['empty', 'private-only'].includes(mode); assert.equal(result.success, positive);
    assert.equal(result.reapVerified, true); assert.equal(result.privateContextClosed, true); assert.equal(result.starts, 0); assert.equal(result.stoppedConfigUpdates, 0);
    assert.equal(JSON.stringify(result).includes('canary'), false); assert.equal(JSON.stringify(result).includes('logs'), false);
    if (positive) { assert.equal(calls.length, 4); assert.equal(result.firstProviderBatchEmpty, mode === 'empty'); assert.equal(result.steadyProviderBatchEmpty, mode === 'empty'); }
    else assert.equal(calls.length, mode.startsWith('after-') ? 4 : ['steady-http', 'slow-steady'].includes(mode) ? 3 : mode.startsWith('before-') || mode.startsWith('machine-') ? 1 : 2);
    const before = [...calls]; await assert.rejects(runP10bStoppedLogProbe({ ...f, executable, checkSource: head => assert.equal(head, f.probe.hostSourceHead) })); assert.deepEqual(calls, before);
  });
}

test('dedicated production probe initialization confines empty-cache housekeeping with zero requests', {
  skip: !process.env.P10B_OFFLINE_STOPPED_LOG_PROBE_CLIENT, timeout: 15000,
}, async t => {
  const binary = process.env.P10B_OFFLINE_STOPPED_LOG_PROBE_CLIENT;
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-probe-init-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = stoppedLogProbeFixture(directory, binary);
  const context = createP10bStoppedLogProbeTokenContext({ ...f, environment: { HOME: '/nonexistent-normal-home-canary', FLY_API_TOKEN: 'synthetic-production-init-only' } });
  let native; let reaped = false;
  try {
    native = await openP10bNativeStoppedLogProbeClient({ ...f, executable: binary, environment: context.environment });
    assert.equal(context.environment.HOME, context.environment.FLY_CONFIG_DIR);
    assertPrivateProbeHousekeeping(context.environment.FLY_CONFIG_DIR);
    // No step call: initialization has no admitted Machine/log request.
  } catch (error) { reaped = error.reapVerified === true; throw error; }
  finally { if (native) reaped = await native.reap(); assert.equal(reaped, true); context.cleanup({ reaped }); }
});
