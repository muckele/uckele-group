import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from '../server/services/p10bProviderIdentity.js';
import { createP10bRuntimePhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { createP10bRuntimeOnlyControl } from '../server/services/p10bRuntimeOnlyControl.js';
import { openP10bNativeMachineClient } from '../server/services/p10bNativeMachineClient.js';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/p10bStoppedUpdateContract.json', import.meta.url)));
const digest = value => sha256(stableCanonicalJson(value));
const executable = process.env.P10B_OFFLINE_UPDATE_TRANSPORT;
function session(now) {
  return { version: 'p10b-no-email-session-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', volumeId: 'vol_vwnkpex1k3yx9dnv',
    sourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', hostSourceHead: '2'.repeat(40), nonce: '103e41746bf89e7e2dec9c5d',
    baselineConfig: fixture.baseline, baselineImageDigest: fixture.baseline.image.split('@')[1], candidateImageDigest: fixture.config.image.split('@')[1],
    ownerPermissionDigest: 'a4e029275a8bd7d1b2f7b2d947e887ce7c07de6efc219b6f1474abe1fcebad4e', permissionEvidenceId: 'offline:synthetic',
    startedAt: new Date(now).toISOString(), sessionDeadline: new Date(now + 3600000).toISOString(),
    maximumStarts: 2, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 3, maximumIncrementalUsd: 1,
    maximumLocalBuilds: 1, maximumImagePushes: 1, productionReady: false, globalAutomationPaused: true,
    nativeClientSha256: sha256(fs.readFileSync(executable)), flyExecutable: { path: process.execPath, sha256: sha256(fs.readFileSync(process.execPath)) },
    namesClientPath: '/offline/public-client', namesClientSha256: 'a'.repeat(64),
    authenticationEvidence: { version: 'p10b-app-token-issuance-v1', ownerAttested: true, issuanceSucceeded: true,
      app: 'uckele-group-p10b', scope: 'app-deploy', tokenId: 'offline-public-id', revokedAt: null,
      tokenName: 'p10b-runtime-no-email-103e41746bf89e7e2dec9c5d', issuanceEvidenceId: 'offline:synthetic',
      issuanceStartedAt: new Date(now - 1000).toISOString(), issuanceCompletedAt: new Date(now - 500).toISOString(),
      requestedLifetimeMs: 7200000, expiresAt: new Date(now + 7199000).toISOString() },
    configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2', providerIdentity: P10B_PROVIDER_IDENTITY,
      providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY), flySecretMetadataDigest: digest([]), verifiedAt: new Date(now).toISOString() },
    budget: { priceEvidenceDigest: 'f'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 } };
}
for (const mode of ['delayed-success', 'http-rejection', 'timeout']) {
  test(`real stopped-update control, stdio service and SDK use only fake HTTP: ${mode}`, { skip: !executable }, async t => {
    const s = session(Date.now() - 1000);
    const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: digest(s), ownerPermissionDigest: s.ownerPermissionDigest,
      sourceHead: s.sourceHead, hostSourceHead: s.hostSourceHead, expiresAt: s.sessionDeadline,
      recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
    const phase = createP10bRuntimePhase(s, 'demo');
    // Only synthetic clock fields differ from the retained public failed config.
    const comparable = structuredClone(phase.config);
    const retainedWindow = JSON.parse(fixture.config.env.P10B_GUEST_WINDOW);
    const retimedWindow = JSON.parse(comparable.env.P10B_GUEST_WINDOW);
    retimedWindow.issuedAt = retainedWindow.issuedAt; retimedWindow.stopAt = retainedWindow.stopAt;
    assert.deepEqual(retimedWindow, retainedWindow);
    comparable.env.P10B_GUEST_WINDOW = stableCanonicalJson(retimedWindow);
    assert.deepEqual(comparable, fixture.config); assert.equal(digest(fixture.config), fixture.configDigest);
    const records = new Map(); const evidence = { has: name => records.has(name), read: name => records.get(name),
      write(name, value) { assert.equal(records.has(name), false); records.set(name, value); } };
    const context = createP10bAppTokenContext({ session: s, approval,
      environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-private-credential-canary' } });
    let native; let reaped = false;
    t.after(async () => { if (native) reaped = await native.reap(); assert.equal(reaped, true); context.cleanup({ reaped }); });
    native = await openP10bNativeMachineClient({ executable, args: ['-test.run=^TestOfflineUpdateTransport$'], session: s, approval,
      configs: [s.baselineConfig, phase.config], recoveryVerified: true,
      environment: { ...context.environment, P10B_TEST_HTTP_MODE: mode } });
    const control = createP10bRuntimeOnlyControl({ session: s, evidence });
    if (mode === 'delayed-success') {
      const machine = await control.guardedUpdate(native.client, s.baselineConfig, phase.config, 'demo');
      assert.equal(machine.state, 'stopped'); assert.deepEqual(machine.config, phase.config);
      assert.equal(records.has('p10b-runtime-only-update-demo-verified.json'), true);
    } else {
      await assert.rejects(control.guardedUpdate(native.client, s.baselineConfig, phase.config, 'demo'), error => {
        assert.deepEqual(error.publicFailure, { version: 'p10b-native-request-failure-v1', code: mode === 'timeout' ? 'timed-out' : 'http-failed',
          method: 'POST', timeoutMs: 10000 });
        assert.equal(JSON.stringify(error.publicFailure).includes('canary'), false); return true;
      });
      assert.equal(records.has('p10b-runtime-only-update-demo-response.json'), false);
      assert.equal(records.has('p10b-runtime-only-demo-start-intent.json'), false);
    }
    await assert.rejects(control.guardedUpdate(native.client, s.baselineConfig, phase.config, 'demo'), /replay/);
    assert.equal(records.has('p10b-runtime-only-update-demo-intent.json'), true);
    reaped = await native.close(); assert.equal(reaped, true);
  });
}
