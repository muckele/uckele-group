import fs from 'node:fs';
import { stoppedDiagnosticFixture, diagnosticDigest } from './p10bStoppedDiagnosticFixture.js';
import { createP10bRuntimePhase } from '../../server/services/p10bRuntimeOnlyOperator.js';
import { sha256 } from '../../server/utils/security.js';
export function logFixture(executable = process.execPath) {
  const { session: original } = stoppedDiagnosticFixture(Date.now() - 1000);
  const keys = ['app', 'machineId', 'volumeId', 'sourceHead', 'hostSourceHead', 'nonce', 'candidateImageDigest', 'baselineImageDigest',
    'baselineConfig', 'ownerPermissionDigest', 'permissionEvidenceId', 'startedAt', 'productionReady', 'globalAutomationPaused',
    'configurationEvidence', 'budget', 'authenticationEvidence', 'namesClientPath', 'namesClientSha256', 'flyExecutable'];
  const session = Object.fromEntries(keys.map(key => [key, original[key]]));
  Object.assign(session, { version: 'p10b-no-email-session-v1', sessionDeadline: new Date(Date.parse(session.startedAt) + 3600000).toISOString(),
    maximumStarts: 2, maximumStartWindowMs: 300000, maximumStoppedConfigUpdates: 3, maximumIncrementalUsd: 1,
    maximumLocalBuilds: 1, maximumImagePushes: 1, nativeClientSha256: sha256(fs.readFileSync(executable)) });
  const approval = { version: 'p10b-no-email-approval-v1', approved: true, sessionDigest: diagnosticDigest(session),
    ownerPermissionDigest: session.ownerPermissionDigest, sourceHead: session.sourceHead, hostSourceHead: session.hostSourceHead,
    expiresAt: session.sessionDeadline, recoveryApproved: true, exclusiveAdmissionWriters: true, providerCalls: 0, emails: 0 };
  const phase = createP10bRuntimePhase(session, 'demo', Date.parse(session.startedAt));
  const row = { timestamp: `${session.startedAt.slice(0, -1)}123456Z`, instance: session.machineId, region: 'ewr',
    message: 'P10B_GUARDIAN_CHILD_EXIT ' + JSON.stringify({ version: 'p10b-guardian-child-exit-v1', windowDigest: diagnosticDigest(phase.window),
      productionReady: false, bindingVerified: true, code: 0, signal: null, spawnFailed: false, guardianPid: 51, parentPid: 50,
      parentStartedAt: session.startedAt, exitedAt: phase.window.stopAt, readyDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), startDigest: 'c'.repeat(64) }) };
  return { session, approval, phase, row };
}
