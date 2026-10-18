import fs from 'node:fs';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';
export function stoppedLogProbeFixture(directory, executable = process.execPath, now = Date.now()) {
  const baselineConfig = JSON.parse(fs.readFileSync(new URL('../fixtures/p10bObservedBaselineShape.json', import.meta.url)));
  const probe = { version: 'p10b-stopped-log-probe-v1', operation: 'stopped-log-probe', app: 'uckele-group-p10b',
    machineId: '0803730bd1d7e8', volumeId: 'vol_vwnkpex1k3yx9dnv', hostSourceHead: 'a'.repeat(40),
    nativeClientSha256: sha256(fs.readFileSync(executable)), nonce: 'b'.repeat(24), issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(), evidenceDirectory: directory, baselineConfig,
    baselineConfigDigest: sha256(stableCanonicalJson(baselineConfig)),
    baselineImageDigest: 'sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629', baselineInstanceId: 'baseline-instance',
    maximumStarts: 0, maximumStoppedConfigUpdates: 0, maximumMachineReads: 2, maximumLogReads: 2,
    aggregateTimeoutMs: 30000, cleanupReserveMs: 3000, firstLogTimeoutMs: 5000, steadyLogTimeoutMs: 700, machineTimeoutMs: 1000,
    productionReady: false, qualificationAllowed: false, globalAutomationPaused: true, providerCalls: 0, emails: 0 };
  return { probe, approval: approveStoppedLogProbe(probe, now) };
}
export function approveStoppedLogProbe(probe, now = Date.parse(probe.issuedAt)) {
  return { version: 'p10b-stopped-log-probe-approval-v1', approved: true, probeDigest: sha256(stableCanonicalJson(probe)),
    hostSourceHead: probe.hostSourceHead, nativeClientSha256: probe.nativeClientSha256, expiresAt: probe.expiresAt,
    approvedAt: new Date(now).toISOString() };
}
