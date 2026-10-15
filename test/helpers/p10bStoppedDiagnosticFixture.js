import process from 'node:process';
import fs from 'node:fs';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from '../../server/services/p10bProviderIdentity.js';
const retained = JSON.parse(fs.readFileSync(new URL('../fixtures/p10bStoppedUpdateContract.json', import.meta.url)));
export const diagnosticDigest = value => sha256(stableCanonicalJson(value));
export function stoppedDiagnosticFixture(now = Date.now() - 1000) {
  const nonce = '103e41746bf89e7e2dec9c5d';
  const owner = 'a4e029275a8bd7d1b2f7b2d947e887ce7c07de6efc219b6f1474abe1fcebad4e';
  const config = structuredClone(retained.config);
  const window = JSON.parse(config.env.P10B_GUEST_WINDOW);
  window.issuedAt = new Date(now).toISOString(); window.stopAt = new Date(now + 300000).toISOString();
  window.runBinding = diagnosticDigest({ identity: `demo-${nonce}`, ownerPermissionDigest: owner });
  config.env.P10B_GUEST_WINDOW = stableCanonicalJson(window);
  const session = { version: 'p10b-stopped-update-session-v1', operation: 'stopped-update-diagnostic',
    app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', volumeId: 'vol_vwnkpex1k3yx9dnv',
    sourceHead: 'c4944a46ac362cdcd002e077d5533b4b0843b1d0', hostSourceHead: '2'.repeat(40), nonce,
    baselineConfig: structuredClone(retained.baseline), baselineImageDigest: retained.baseline.image.split('@')[1],
    baselineInstanceId: retained.currentVersion, baselineObservedAt: new Date(now).toISOString(),
    candidateImageDigest: config.image.split('@')[1], diagnosticConfig: config, diagnosticConfigDigest: diagnosticDigest(config),
    ownerPermissionDigest: owner, permissionEvidenceId: `offline:${nonce}`,
    startedAt: new Date(now).toISOString(), sessionDeadline: new Date(now + 900000).toISOString(),
    maximumStarts: 0, maximumStartWindowMs: 0, qualificationAllowed: false,
    maximumDiagnosticPosts: 1, maximumRestorationPosts: 1, maximumStoppedConfigUpdates: 2,
    requestTimeoutMs: 10000, maximumObservationMs: 10000, maximumRunMs: 120000,
    maximumLocalBuilds: 0, maximumImagePushes: 0, maximumIncrementalUsd: 1,
    productionReady: false, globalAutomationPaused: true, nativeClientSha256: 'd'.repeat(64),
    flyExecutable: { path: process.execPath, sha256: sha256(fs.readFileSync(process.execPath)) },
    authenticationEvidence: { version: 'p10b-app-token-issuance-v1', ownerAttested: true, issuanceSucceeded: true,
      app: 'uckele-group-p10b', scope: 'app-deploy', tokenId: 'offline-public-id', revokedAt: null,
      tokenName: `p10b-runtime-no-email-${nonce}`, issuanceEvidenceId: `offline:${nonce}`,
      issuanceStartedAt: new Date(now - 2000).toISOString(), issuanceCompletedAt: new Date(now - 1500).toISOString(),
      requestedLifetimeMs: 7200000, expiresAt: new Date(now + 7198000).toISOString() },
    configurationEvidence: { version: 'p10b-isolated-configuration-evidence-v2', providerIdentity: P10B_PROVIDER_IDENTITY,
      providerIdentityDigest: p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY), flySecretMetadataDigest: diagnosticDigest([]), verifiedAt: new Date(now).toISOString() },
    budget: { priceEvidenceDigest: 'f'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.8 },
    namesClientPath: '/offline/names', namesClientSha256: 'e'.repeat(64) };
  return { session, approval: { version: 'p10b-stopped-update-approval-v1', approved: true, sessionDigest: diagnosticDigest(session),
    ownerPermissionDigest: owner, sourceHead: session.sourceHead, hostSourceHead: session.hostSourceHead,
    expiresAt: session.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 } };
}
