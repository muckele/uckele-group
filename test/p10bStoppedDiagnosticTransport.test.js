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
for (const mode of ['delayed-success', 'http-rejection', 'timeout-late-visible', 'timeout-late-after-cutoff']) {
  test(`actual stopped-only controller, native protocol and official SDK with loopback fake HTTP: ${mode}`, { skip: !executable, timeout: 35000 }, async t => {
    const { session, approval } = stoppedDiagnosticFixture();
    session.nativeClientSha256 = sha256(fs.readFileSync(executable)); approval.sessionDigest = digest(session);
    let config = structuredClone(session.baselineConfig); let instance = session.baselineInstanceId;
    let posts = 0; let started = false; let lateCommitted = false; const timers = new Set();
    const server = http.createServer(async (request, response) => {
      try {
        assert.equal(request.url, `/v1/apps/${session.app}/machines/${session.machineId}`);
        assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
        assert.ok(['GET', 'POST'].includes(request.method));
        if (request.method === 'POST') {
          posts++; assert.ok(posts <= 2); const chunks = []; for await (const part of request) chunks.push(part);
          const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.skip_launch, true);
          assert.equal(body.current_version, instance);
          assert.deepEqual(body.config, posts === 1 ? session.diagnosticConfig : session.baselineConfig);
          if (posts === 1 && mode === 'http-rejection') {
            response.writeHead(422, { 'X-Private-Test': 'synthetic-private-header-canary' });
            response.end('{"error":"synthetic-private-response-canary"}'); return;
          }
          if (posts === 1 && mode.startsWith('timeout-')) {
            const timer = setTimeout(() => {
              config = body.config; instance = 'late-accepted-version'; lateCommitted = true; timers.delete(timer);
              if (!response.destroyed) response.destroy();
            }, mode === 'timeout-late-visible' ? 10200 : 21000);
            timers.add(timer); return;
          }
          if (posts === 1) await wait(1100);
          config = body.config; instance = `accepted-version-${posts}`;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: session.machineId, region: 'ewr', state: started ? 'started' : 'stopped',
          instance_id: instance, config, image_ref: { digest: config.image.split('@')[1] },
          arbitraryPrivateField: 'synthetic-private-success-canary' }));
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
    if (mode === 'delayed-success') {
      assert.equal(result.primary.observation.httpStatus, 200); assert.ok(result.primary.observation.elapsedMs >= 1000);
      assert.equal(result.success, true); assert.equal(result.restored, true); assert.equal(posts, 2);
    } else if (mode === 'http-rejection') {
      assert.equal(result.primary.code, 'http-failed'); assert.equal(result.primary.observation.httpStatus, 422);
      assert.equal(result.mutationUncertain, true); assert.equal(result.restored, false); assert.equal(posts, 1);
    } else {
      assert.equal(result.primary.code, 'timed-out'); assert.equal(result.primary.observation.httpStatus, null);
      assert.ok(result.primary.observation.elapsedMs >= 9900);
      if (mode === 'timeout-late-visible') { assert.equal(lateCommitted, true); assert.equal(result.restored, true); assert.equal(result.mutationUncertain, false); assert.equal(posts, 2); }
      else {
        assert.equal(result.mutationUncertain, true); assert.equal(result.baselineObserved, true); assert.equal(result.restored, false); assert.equal(posts, 1);
        // The parent fake API survives local native reap. A remote commit can
        // appear after bounded old-baseline observation and private cleanup.
        context.cleanup({ reaped });
        for (let i = 0; i < 30 && !lateCommitted; i++) await wait(100);
        assert.equal(lateCommitted, true); assert.deepEqual(config, session.diagnosticConfig);
      }
    }
    await assert.rejects(runP10bStoppedUpdateDiagnostic({ session, approval, evidence, assertAdmission: () => true,
      createClient: () => { throw Error('replay must not open'); } }));
  });
}
