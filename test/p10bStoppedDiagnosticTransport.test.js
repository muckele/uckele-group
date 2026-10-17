import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';
import { openP10bStoppedUpdateClient } from '../server/services/p10bNativeMachineClient.js';
import { runP10bStoppedUpdateDiagnostic } from '../server/services/p10bStoppedUpdateDiagnostic.js';
import { stoppedDiagnosticFixture } from './helpers/p10bStoppedDiagnosticFixture.js';
const executable = process.env.P10B_OFFLINE_STOPPED_DIAGNOSTIC;
const digest = value => sha256(stableCanonicalJson(value));
const modes = ['delayed-success', 'created-success', 'replacing-ack', 'http-rejection', 'stale-version',
  'timeout-late-visible', 'timeout-late-after-cutoff', 'connection-loss-visible', 'unusable-response-visible',
  'wrong-settlement-version', 'failed-settlement', 'running-settlement', 'current-version-drift', 'uncertain-restoration', 'bad-ack-image', 'bad-readback-image', 'restoration-settlement-mismatch'];
for (const mode of modes) {
  test(`actual controller, native policy and official SDK with loopback fake HTTP: ${mode}`, { skip: !executable, timeout: 35000 }, async t => {
    const { session, approval } = stoppedDiagnosticFixture();
    session.nativeClientSha256 = sha256(fs.readFileSync(executable)); approval.sessionDigest = digest(session);
    let config = structuredClone(session.baselineConfig); let instance = session.baselineInstanceId; let state = 'stopped';
    let posts = 0; let waits = 0; let started = false; let lateCommitted = false; const timers = new Set();
    const machine = () => ({ id: session.machineId, region: 'ewr', state, instance_id: instance, config,
      image_ref: { digest: config.image.split('@')[1] }, arbitraryPrivateField: 'synthetic-private-success-canary' });
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
        const endpoint = `/v1/apps/${session.app}/machines/${session.machineId}`;
        if (url.pathname === `${endpoint}/wait`) {
          waits++; assert.equal(request.method, 'GET'); assert.equal(url.searchParams.get('state'), 'settled');
          assert.equal(url.searchParams.get('version'), instance); assert.equal(url.searchParams.get('timeout'), '9');
          assert.equal([...url.searchParams.keys()].sort().join(','), 'state,timeout,version');
          if (state === 'replacing') state = 'created';
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ok: true, state: mode === 'failed-settlement' ? 'failed' : mode === 'running-settlement' ? 'started' : state,
            version: mode === 'wrong-settlement-version' || mode === 'restoration-settlement-mismatch' && posts === 2 ? 'wrong-version' : instance, event_id: 'synthetic-private-event-canary' }));
          if (mode === 'current-version-drift') instance = 'unacknowledged-current-version';
          return;
        }
        assert.equal(request.url, endpoint); assert.ok(['GET', 'POST'].includes(request.method));
        if (request.method === 'POST') {
          posts++; assert.ok(posts <= 2); const chunks = []; for await (const part of request) chunks.push(part);
          const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.skip_launch, true);
          assert.equal(body.current_version, instance);
          assert.deepEqual(body.config, posts === 1 ? session.diagnosticConfig : session.baselineConfig);
          if (posts === 1 && ['http-rejection', 'stale-version'].includes(mode)) {
            response.writeHead(mode === 'stale-version' ? 409 : 422, { 'X-Private-Test': 'synthetic-private-header-canary' });
            response.end('{"error":"synthetic-private-response-canary"}'); return;
          }
          if (posts === 1 && mode.startsWith('timeout-')) {
            const timer = setTimeout(() => {
              config = body.config; instance = 'late-accepted-version'; lateCommitted = true; timers.delete(timer);
              if (!response.destroyed) response.destroy();
            }, mode === 'timeout-late-visible' ? 10200 : 21000);
            timers.add(timer); return;
          }
          if (posts === 1 && mode === 'delayed-success') await wait(1100);
          config = body.config; instance = `accepted-version-${posts}`;
          state = mode === 'created-success' ? 'created' : mode === 'replacing-ack' && posts === 1 ? 'replacing' : 'stopped';
          if (posts === 1 && mode === 'connection-loss-visible' || posts === 2 && mode === 'uncertain-restoration') { response.destroy(); return; }
          if (posts === 1 && mode === 'unusable-response-visible') { response.writeHead(200); response.end('{bad-private-canary'); return; }
        }
        const value = machine();
        if (mode === 'bad-ack-image' && request.method === 'POST' || mode === 'bad-readback-image' && request.method === 'GET' && waits > 0) value.image_ref.digest = `sha256:${'a'.repeat(64)}`;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
      } catch { started = true; response.writeHead(500); response.end('synthetic-private-handler-canary'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const context = createP10bAppTokenContext({ session, approval, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-owner-input-canary' } });
    let native; let reaped = false;
    t.after(async () => { if (native) reaped = await native.reap(); assert.equal(reaped, true); context.cleanup({ reaped }); });
    const records = new Map(); const evidence = { has: name => records.has(name), write(name, value) {
      assert.equal(records.has(name), false); records.set(name, structuredClone(value));
    } };
    const result = await runP10bStoppedUpdateDiagnostic({ session, approval, evidence, assertAdmission: () => true,
      createClient: async () => {
        native = await openP10bStoppedUpdateClient({ executable, args: ['-test.run=^TestOfflineStoppedDiagnosticTransport$'],
          session, approval, configs: [session.baselineConfig, session.diagnosticConfig], recoveryVerified: true,
          environment: { ...context.environment, P10B_DIAGNOSTIC_TEST_HTTP_URL: `http://127.0.0.1:${server.address().port}` } });
        return native;
      } });
    reaped = result.nativeReapVerified; assert.equal(reaped, true); assert.equal(started, false);
    assert.equal(result.primary.method, 'POST'); assert.equal(result.primary.timeoutMs, 10000);
    assert.equal(result.primary.observation.dispatched, true);
    assert.equal(JSON.stringify([...records.values()]).includes('canary'), false);
    if (['delayed-success', 'created-success', 'replacing-ack'].includes(mode)) {
      assert.equal(result.primary.observation.httpStatus, 200); assert.equal(result.success, true);
      assert.equal(result.restored, true); assert.equal(posts, 2); assert.equal(waits, 2);
    } else {
      assert.equal(result.success, false); assert.equal(result.restored, false); assert.equal(result.mutationUncertain, true);
      assert.equal(posts, ['uncertain-restoration', 'restoration-settlement-mismatch'].includes(mode) ? 2 : 1);
      if (mode === 'bad-ack-image') assert.equal(result.primary.code, 'invalid-output');
      if (mode === 'http-rejection' || mode === 'stale-version') {
        assert.equal(result.primary.code, 'http-failed'); assert.equal(result.primary.observation.httpStatus, mode === 'stale-version' ? 409 : 422);
      }
      if (mode.startsWith('timeout-')) {
        assert.equal(result.primary.code, 'timed-out'); assert.equal(result.primary.observation.httpStatus, null);
        assert.ok(result.primary.observation.elapsedMs >= 9900);
        // Parent-owned fake API survives local native reap and private cleanup.
        context.cleanup({ reaped });
        assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), false);
        for (let i = 0; i < 120 && !lateCommitted; i++) await wait(100);
        assert.equal(lateCommitted, true); assert.deepEqual(config, session.diagnosticConfig);
        assert.equal(posts, 1); assert.equal(result.mutationUncertain, true);
      }
      if (['http-rejection', 'stale-version', 'timeout-late-visible', 'timeout-late-after-cutoff', 'connection-loss-visible', 'unusable-response-visible', 'bad-ack-image'].includes(mode)) assert.equal(waits, 0);
    }
    await assert.rejects(runP10bStoppedUpdateDiagnostic({ session, approval, evidence, assertAdmission: () => true,
      createClient: () => { throw Error('replay must not open'); } }));
  });
}
