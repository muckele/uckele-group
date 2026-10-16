import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from '../server/services/p10bProviderIdentity.js';
import { createP10bRuntimePhase, runP10bNoEmailOperator } from '../server/services/p10bRuntimeOnlyOperator.js';
import { openP10bNativeMachineClient } from '../server/services/p10bNativeMachineClient.js';
import { publicP10bNativeFailure } from '../server/services/p10bNativeFailure.js';
import { createP10bAppTokenContext, reserveP10bLocalReap } from '../server/services/p10bHostAuthentication.js';
import { recoverP10bAdmissionReservation, verifyP10bAdmissionArchive } from '../server/services/p10bAdmissionRecovery.js';
const executable = process.env.P10B_OFFLINE_GUARDIAN_TRANSPORT;
const digest = value => sha256(stableCanonicalJson(value));
function fixture() {
  const now = Date.now() - 1000; const baselineConfig = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bObservedBaselineShape.json', import.meta.url)));
  const session = { version: 'p10b-guardian-only-session-v1', operation: 'guardian-only', qualificationAllowed: false,
    recoveryPolicy: 'acknowledged-only-stopped-runtime-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', volumeId: 'vol_vwnkpex1k3yx9dnv',
    sourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', hostSourceHead: '2'.repeat(40), nonce: 'c'.repeat(24),
    baselineConfig, baselineImageDigest: baselineConfig.image.split('@')[1], baselineInstanceId: 'baseline-instance', baselineObservedAt: new Date(now).toISOString(),
    candidateImageDigest: 'sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc',
    ownerPermissionDigest: 'd'.repeat(64), permissionEvidenceId: 'offline:synthetic', startedAt: new Date(now).toISOString(), sessionDeadline: new Date(now + 3600000).toISOString(),
    maximumStarts: 1, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 2, maximumIncrementalUsd: 1,
    maximumLocalBuilds: 0, maximumImagePushes: 0, productionReady: false, globalAutomationPaused: true,
    nativeClientSha256: sha256(fs.readFileSync(executable)), flyExecutable: { path: process.execPath, sha256: sha256(fs.readFileSync(process.execPath)) },
    namesClientPath: '/offline/names', namesClientSha256: 'a'.repeat(64),
    authenticationEvidence: { version: 'p10b-app-token-issuance-v1', ownerAttested: true, issuanceSucceeded: true,
      app: 'uckele-group-p10b', scope: 'app-deploy', tokenId: 'offline-public-id', revokedAt: null,
      tokenName: `p10b-runtime-no-email-${'c'.repeat(24)}`, issuanceEvidenceId: 'offline:synthetic',
      issuanceStartedAt: new Date(now - 1000).toISOString(), issuanceCompletedAt: new Date(now - 500).toISOString(),
      requestedLifetimeMs: 7200000, expiresAt: new Date(now + 7199000).toISOString() },
    configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2', providerIdentity: P10B_PROVIDER_IDENTITY,
      providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY), flySecretMetadataDigest: digest([]), verifiedAt: new Date(now).toISOString() },
    budget: { priceEvidenceDigest: 'f'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 } };
  const record = { version: 'p10b-machine-owner-v1', packetDigest: '4'.repeat(64), evidencePath: '/synthetic/prior', reservedAt: new Date(now - 10000).toISOString() };
  const bytes = JSON.stringify(record); const directory = '/synthetic/admission';
  session.recovery = { ...record, directory, activePath: `${directory}/${session.machineId}.active.json`,
    archivePath: `${directory}/${session.machineId}.active.json.archived-uncertain-${session.nonce}.json`,
    attemptPath: `${directory}/${record.packetDigest}.attempt.json`, intentPath: '/synthetic/p10b-recovery-intent.json', terminalPath: '/synthetic/p10b-recovery-terminal.json', expectedSha256: sha256(bytes) };
  const item = { bytes, inode: '42', device: '7', mode: 384, owner: 501, mtime: 100, regular: true, symlink: false };
  const files = new Map([[session.recovery.activePath, item], [session.recovery.attemptPath, { ...item, bytes: 'retained-attempt', inode: '43' }]]);
  const filesystem = { statDirectory: () => ({ ownerControlled: true, symlink: false }), read: p => files.get(p).bytes,
    stat: p => files.get(p), exists: p => files.has(p), writeExclusive(p, v) { assert.equal(files.has(p), false); files.set(p, { ...item, bytes: JSON.stringify(v) }); },
    linkExclusive(a, b) { assert.equal(files.has(b), false); files.set(b, files.get(a)); }, syncFile() {}, syncDirectoryOf() {}, unlinkActive: p => files.delete(p) };
  const baseline = { id: session.machineId, region: 'ewr', state: 'stopped', instance_id: session.baselineInstanceId, config: baselineConfig, image_ref: { digest: session.baselineImageDigest } };
  const approval = { version: 'p10b-guardian-only-approval-v1', approved: true, sessionDigest: digest(session), ownerPermissionDigest: session.ownerPermissionDigest,
    sourceHead: session.sourceHead, hostSourceHead: session.hostSourceHead, expiresAt: session.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  const recovered = recoverP10bAdmissionReservation({ session, approval, baseline,
    independentBaseline: { machineDigest: digest(baseline), independent: true, observedAt: new Date(now).toISOString() }, filesystem, operatorPid: 5010 });
  const inspect = () => ({ activeAbsent: !files.has(session.recovery.activePath), archiveSha256: sha256(files.get(session.recovery.archivePath).bytes),
    archiveDevice: '7', archiveInode: '42', attemptSha256: sha256(files.get(session.recovery.attemptPath).bytes) });
  const verification = verifyP10bAdmissionArchive({ session, recovery: recovered, inspect, verifierPid: 5011 });
  return { session, approval, baseline, recovery: { ...recovered, verification }, inspect };
}
// Exercise the recovery/observer bootstrap before the mutation-policy service.
// The existing Go fixture runs the real readOnly initialization, request builder
// and response projection; only its HTTP transport points at this local server.
for (const mode of ['success', 'http-401', 'http-403', 'timeout', 'connection-loss', 'invalid-output']) {
  test(`guardian read-only recovery through native service and fake HTTP: ${mode}`, { skip: !executable, timeout: 10000 }, async t => {
    const { session, approval, baseline } = fixture(); let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      assert.equal(request.method, 'GET');
      assert.equal(request.url, `/v1/apps/${session.app}/machines/${session.machineId}`);
      assert.equal(request.headers.authorization, undefined);
      if (mode === 'timeout') return;
      if (mode === 'connection-loss') { response.destroy(); return; }
      if (mode.startsWith('http-')) response.writeHead(Number(mode.slice(5)));
      response.end(mode === 'success' ? JSON.stringify({ ...baseline, privateUnknownField: 'synthetic-private-response-canary' })
        : mode === 'invalid-output' ? '[]' : 'synthetic-private-response-canary');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const context = createP10bAppTokenContext({ session, approval,
      environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-readonly-input-canary' } });
    let native;
    try {
      native = await openP10bNativeMachineClient({ executable, args: ['-test.run=^TestOfflineGuardianTransport$'], session, approval,
        configs: [session.baselineConfig], readOnly: true,
        environment: { ...context.environment, P10B_GUARDIAN_TEST_HTTP_URL: `http://127.0.0.1:${server.address().port}` } });
      // Neither read-only permission nor its one-second GET bound is widened.
      await assert.rejects(native.client('POST', {}, 10000));
      await assert.rejects(native.client('GET', undefined, 1001));
      assert.equal(requests, 0);
      if (mode === 'success') assert.deepEqual(await native.client(), { ...baseline, events: [] });
      else await assert.rejects(native.client(), error => {
        assert.deepEqual(publicP10bNativeFailure(error), { version: 'p10b-native-request-failure-v1', method: 'GET', timeoutMs: 1000,
          code: mode.startsWith('http-') ? 'http-failed' : mode === 'timeout' ? 'timed-out'
            : mode === 'connection-loss' ? 'request-failed' : 'invalid-output' });
        assert.equal(JSON.stringify(error).includes('canary'), false); return true;
      });
      assert.equal(requests, 1);
    } finally {
      const reaped = native ? await native.reap() : false;
      assert.equal(reaped, true); assert.equal(context.assertReaped(), true);
      assert.equal(context.cleanup({ reaped }), true);
      assert.equal(fs.existsSync(context.environment.FLY_CONFIG_DIR), false);
    }
  });
}
for (const mode of ['success', 'connection-loss-after-commit', 'timeout-after-dispatch', 'wrong-wait', 'wrong-readback', 'stop-unverified', 'reap-unverified', 'restoration-loss']) {
  test(`guardian operator through native policy and official SDK uses only fake HTTP: ${mode}`, { skip: !executable, timeout: 20000 }, async t => {
    const f = fixture(); const { session, approval } = f; let remote = structuredClone(f.baseline);
    let posts = 0, waits = 0, starts = 0, preparations = 0, invalidRequests = 0; const timers = new Set();
    const phase = createP10bRuntimePhase(session, 'demo');
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1'); const endpoint = `/v1/apps/${session.app}/machines/${session.machineId}`;
        assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
        if (url.pathname === endpoint + '/wait') {
          waits++; assert.equal(request.method, 'GET'); assert.equal(url.searchParams.get('version'), remote.instance_id);
          assert.equal(url.searchParams.get('state'), 'settled'); assert.equal(url.searchParams.get('timeout'), '9');
          response.end(JSON.stringify({ ok: true, state: 'stopped', version: mode === 'wrong-wait' ? 'wrong-version' : remote.instance_id })); return;
        }
        assert.equal(request.url, endpoint); assert.ok(['GET', 'POST'].includes(request.method));
        if (request.method === 'POST') {
          posts++; assert.ok(posts <= 2); const chunks = []; for await (const c of request) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.skip_launch, true); assert.equal(body.current_version, remote.instance_id);
          assert.deepEqual(body.config, posts === 1 ? phase.config : session.baselineConfig);
          remote = { ...remote, config: body.config, instance_id: `ack-${posts}`, image_ref: { digest: body.config.image.split('@')[1] } };
          if (mode === 'connection-loss-after-commit' && posts === 1 || mode === 'restoration-loss' && posts === 2) { response.destroy(); return; }
          if (mode === 'timeout-after-dispatch' && posts === 1) {
            const timer = setTimeout(() => { response.destroy(); timers.delete(timer); }, 10500); timers.add(timer); return;
          }
        }
        const value = structuredClone(remote);
        if (mode === 'wrong-readback' && request.method === 'GET' && waits) value.instance_id = 'unknown';
        response.end(JSON.stringify({ ...value, privateUnknownField: 'synthetic-private-response-canary' }));
      } catch { invalidRequests++; response.writeHead(500); response.end('synthetic-private-error-canary'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const context = createP10bAppTokenContext({ session, approval, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-input-canary' } });
    const records = new Map(); const evidence = { has: n => records.has(n), read: n => records.get(n), write(n, v) { assert.equal(records.has(n), false); records.set(n, v); } };
    let native; let other;
    const options = { session, approval, clock: () => Date.parse(phase.window.issuedAt), evidence, recovery: f.recovery, inspectRecovery: f.inspect,
      verifyPrivateReap: lease => context.assertPhaseReaped(lease),
      createBoundaries: async () => {
        native = await openP10bNativeMachineClient({ executable, args: ['-test.run=^TestOfflineGuardianTransport$'], session, approval,
          configs: [session.baselineConfig, phase.config], recoveryVerified: true,
          environment: { ...context.environment, P10B_GUARDIAN_TEST_HTTP_URL: `http://127.0.0.1:${server.address().port}` } });
        return { client: native.client, startObserver: async ({ machine }) => ({ attached: true, separateSession: true, instanceId: machine.instance_id, imageDigest: session.candidateImageDigest }),
          demonstrate: async ({ phase: actual }) => { starts++; assert.deepEqual(actual.config, phase.config); remote.state = 'stopped';
            return { success: true, windowDigest: digest(actual.window), observerSurvived: true, primaryTerminationVerified: true,
              stopLatencyMs: 1600, maximumMetadataPollGapMs: 750, maximumMetadataResponseGapMs: 800, normalMachineExit: true,
              observerContinuous: true, unexpectedRestart: false, exitRecordCount: 1 }; },
          runPreparation: async () => { preparations++; throw Error('Preparation forbidden'); },
          settle: async () => mode !== 'stop-unverified',
          reapForRestoration: async () => { if (mode === 'reap-unverified') other = reserveP10bLocalReap(context.environment); return true; },
          restorationLease: () => native.transportLease, reap: native.reap, close: native.close };
      } };
    try {
      if (mode === 'success') {
        const result = await runP10bNoEmailOperator(options); assert.equal(result.success, true); assert.equal(result.restored, true);
        assert.equal(result.qualificationAllowed, false); assert.equal(posts, 2); assert.equal(waits, 2); assert.equal(starts, 1);
        assert.deepEqual(remote.config, session.baselineConfig);
      } else {
        await assert.rejects(runP10bNoEmailOperator(options)); const closure = evidence.read('p10b-runtime-only-session-closure.json');
        assert.equal(closure.success, false); assert.equal(closure.restored, false);
        assert.equal(posts, mode === 'restoration-loss' ? 2 : 1);
        assert.equal(starts, ['stop-unverified', 'reap-unverified', 'restoration-loss'].includes(mode) ? 1 : 0);
        if (!['stop-unverified', 'reap-unverified'].includes(mode)) assert.equal(closure.mutationUncertain, true);
      }
      assert.equal(preparations, 0); assert.equal(invalidRequests, 0); assert.equal(evidence.has('p10b-runtime-only-prepare-packet.json'), false);
      assert.equal(JSON.stringify([...records.values()]).includes('canary'), false);
      await assert.rejects(runP10bNoEmailOperator(options));
    } finally { if (native) assert.equal(await native.close(), true); other?.retire(true); assert.equal(context.assertReaped(), true); context.cleanup({ reaped: true }); }
  });
}
