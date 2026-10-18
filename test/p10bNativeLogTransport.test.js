import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openP10bNativeLogClient, openP10bNativeMachineClient } from '../server/services/p10bNativeMachineClient.js';
import { publicP10bNativeLogFailure } from '../server/services/p10bNativeFailure.js';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';
import { logFixture } from './helpers/p10bLogFixture.js';
const executable = process.env.P10B_OFFLINE_LOG_TRANSPORT;
test('production log-only initialization has no config or network side effects', { skip: !process.env.P10B_OFFLINE_NATIVE_CLIENT, timeout: 15000 }, async t => {
  const production = process.env.P10B_OFFLINE_NATIVE_CLIENT;
  const f = logFixture(production); const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-log-denied-home-'));
  fs.mkdirSync(path.join(home, '.fly')); fs.writeFileSync(path.join(home, '.fly', 'config.yml'), 'synthetic-malformed-config-canary: [');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const context = createP10bAppTokenContext({ ...f, environment: { PATH: '/usr/bin:/bin', HOME: home, FLY_API_TOKEN: 'synthetic-pure-log-init-canary' } });
  let native; let reaped = false;
  try {
    native = await openP10bNativeLogClient({ ...f, executable: production, configs: [f.phase.config], environment: context.environment,
      spawnProcess(file, args, options) {
        if (process.platform !== 'darwin' || process.env.P10B_LOG_DENY_HOME !== '1') return spawn(file, args, options);
        const profile = `(version 1) (allow default) (deny network*) (deny file-read* (subpath ${JSON.stringify(home)})) (deny file-read* (subpath "/Users/Matt"))`;
        return spawn('/usr/bin/sandbox-exec', ['-p', profile, file, ...args], options);
      } });
    // Initialization only. Never invoke client(): no HTTP request is admitted.
    assert.equal(fs.existsSync(path.join(context.environment.FLY_CONFIG_DIR, 'flyctl.config.lock')), false);
  } catch (error) { reaped = error.reapVerified === true; throw error; }
  finally { if (native) reaped = await native.reap(); assert.equal(reaped, true); context.cleanup({ reaped }); }
});
const provider = rows => JSON.stringify({ data: rows.map(attributes => ({ type: 'logs', attributes })), meta: { next_token: 'synthetic-private-cursor' } });
async function listen(t, handler) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
for (const mode of ['empty', 'app-only', 'guardian', 'http-201', 'http-204', 'http-401', 'http-403', 'http-502', 'http-503',
  'redirect', 'error-document', 'errors-document', 'missing-data', 'null-data', 'duplicate', 'trailing', 'malformed', 'oversize', 'connection-loss', 'slow-headers', 'slow-body']) {
  test(`single log GET through real native stdio and SDK with fake HTTP: ${mode}`, { skip: !executable, timeout: 10000 }, async t => {
    const f = logFixture(executable); let requests = 0;
    const endpoint = await listen(t, (request, response) => {
      requests++; assert.equal(request.method, 'GET');
      assert.equal(request.url, `/api/v1/apps/${f.session.app}/logs?instance=${f.session.machineId}&next_token=`);
      assert.equal(request.headers.authorization, undefined);
      if (mode === 'slow-headers') return;
      if (mode === 'slow-body') { response.writeHead(200); response.write('{"data":['); return; }
      if (mode === 'connection-loss') { response.destroy(); return; }
      if (mode === 'redirect') { response.writeHead(302, { location: '/forbidden-second-request' }); response.end('private-error-canary'); return; }
      if (mode.startsWith('http-')) { response.writeHead(Number(mode.slice(5))); response.end('private-error-canary'); return; }
      response.end(mode === 'empty' ? provider([]) : mode === 'app-only' ? provider([{ ...f.row, message: 'private-application-canary' }])
        : mode === 'guardian' ? provider([{ ...f.row, message: 'private-application-canary' }, f.row])
          : mode === 'error-document' ? '{"data":[],"error":"private-error-canary"}' : mode === 'errors-document' ? '{"data":[],"errors":[]}'
            : mode === 'missing-data' ? '{}' : mode === 'null-data' ? '{"data":null}' : mode === 'duplicate' ? '{"data":[],"data":[]}'
            : mode === 'trailing' ? '{"data":[]}{}' : mode === 'oversize' ? 'x'.repeat(131073) : '{');
    });
    const context = createP10bAppTokenContext({ ...f, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-log-native-canary' } });
    let native; let reaped = false;
    try {
      native = await openP10bNativeLogClient({ ...f, executable, args: ['-test.run=^TestOfflineLogTransport$'], configs: [f.phase.config],
        environment: { ...context.environment, P10B_LOG_TEST_HTTP_URL: endpoint } });
      if (['empty', 'app-only', 'guardian'].includes(mode)) {
        const rows = await native.client(); assert.equal(rows.length, mode === 'guardian' ? 1 : 0);
        if (rows.length) { assert.equal(rows[0].timestamp, f.row.timestamp); assert.equal(JSON.stringify(rows).includes('private-application-canary'), false); }
      } else {
        await assert.rejects(native.client(), error => {
          const facts = publicP10bNativeLogFailure(error);
          if (mode.startsWith('slow-')) assert.ok(['timed-out', 'bridge-timeout'].includes(facts?.code));
          else assert.equal(facts?.code, mode.startsWith('http-') || mode === 'redirect' ? 'http-failed'
            : mode === 'connection-loss' ? 'request-failed' : mode === 'oversize' ? 'output-bound' : 'invalid-output');
          if (mode.startsWith('http-')) assert.equal(facts.httpStatus, Number(mode.slice(5)));
          assert.equal(JSON.stringify(error).includes('canary'), false); return true;
        });
        await assert.rejects(native.client());
      }
      assert.equal(requests, 1);
    } finally { if (native) reaped = await native.reap(); assert.equal(reaped, true); context.cleanup({ reaped }); }
  });
}

test('slow log HTTP does not serialize independent native metadata reads', { skip: !executable, timeout: 10000 }, async t => {
  const f = logFixture(executable); let logRequests = 0; let metadataRequests = 0;
  const endpoint = await listen(t, (request, response) => {
    if (request.url.startsWith('/api/v1/')) { logRequests++; setTimeout(() => response.end(provider([])), 450); return; }
    metadataRequests++;
    response.end(JSON.stringify({ id: f.session.machineId, region: 'ewr', state: 'stopped', instance_id: 'synthetic-instance',
      config: f.phase.config, image_ref: { digest: f.session.candidateImageDigest } }));
  });
  const context = createP10bAppTokenContext({ ...f, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-parallel-reader-canary' } });
  let metadata; let logs;
  try {
    metadata = await openP10bNativeMachineClient({ ...f, executable, args: ['-test.run=^TestOfflineGuardianTransport$'], readOnly: true,
      configs: [f.phase.config], environment: { ...context.environment, P10B_GUARDIAN_TEST_HTTP_URL: endpoint } });
    logs = await openP10bNativeLogClient({ ...f, executable, args: ['-test.run=^TestOfflineLogTransport$'],
      configs: [f.phase.config], environment: { ...context.environment, P10B_LOG_TEST_HTTP_URL: endpoint } });
    assert.notEqual(metadata.pid, logs.pid);
    let logDone = false; const logRead = logs.client().then(rows => { logDone = true; return rows; });
    for (let i = 0; i < 8; i++) assert.equal((await metadata.client('GET', undefined, 700)).id, f.session.machineId);
    assert.equal(logDone, false); assert.equal(metadataRequests, 8); assert.deepEqual(await logRead, []); assert.equal(logRequests, 1);
  } finally {
    const results = await Promise.all([metadata?.reap(), logs?.reap()]);
    assert.equal(results.every(value => value === true), true); context.cleanup({ reaped: true });
  }
});
