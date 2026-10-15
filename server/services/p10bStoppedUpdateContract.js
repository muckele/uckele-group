import { sha256, stableCanonicalJson } from '../utils/security.js';
import { validateP10bBaselineConfig, P10B_RUNTIME_FLAGS } from './p10bRuntimeOnlyOperator.js';
import { p10bGuestWindow, P10B_GUEST_PROCESSES } from './p10bGuestShutdown.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from './p10bProviderIdentity.js';
import { assertP10bReviewedCheckout, P10B_RETAINED_GUEST_HEAD, P10B_RETAINED_IMAGE } from './p10bOperatorSource.js';
const digest = value => sha256(stableCanonicalJson(value));
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256 = '4e23c99f93c81f53c005b3bedaed9dd1fc9a6b3e7ee15a8b856b4026e96ee87a';
export function createP10bStoppedDiagnosticConfig(session) {
  // This is frozen configuration data only. No runtime packet, permission or
  // guest execution capability is created by this diagnostic.
  const window = p10bGuestWindow({ operation: 'prepare', target: { app: session.app, machineId: session.machineId,
    imageDigest: session.candidateImageDigest }, sourceHead: session.sourceHead,
    databasePath: `/data/p10b-first-mailbox-watchdog-${session.nonce}.sqlite`, runId: `demo-${session.nonce}`,
    ownerPermissionDigest: session.ownerPermissionDigest, guest: { issuedAt: session.startedAt,
      stopAt: new Date(Date.parse(session.startedAt) + 300000).toISOString(), closureGraceMs: 30000, stopReserveMs: 30000 } });
  const config = structuredClone(session.baselineConfig);
  config.image = `registry.fly.io/uckele-group-p10b@${session.candidateImageDigest}`;
  config.env = { ...config.env, ...P10B_RUNTIME_FLAGS, P10B_QUALIFICATION_PHASE: 'prepare',
    SQLITE_PATH: window.databasePath, P10B_GUEST_WINDOW: stableCanonicalJson(window) };
  config.processes = [{ exec: ['node', '-e', 'setInterval(() => {}, 2147483647)'], ignore_app_secrets: true },
    structuredClone(P10B_GUEST_PROCESSES[1])];
  return config;
}
function authentication(s, now) {
  const a = s.authenticationEvidence;
  return only(a, ['version', 'ownerAttested', 'issuanceSucceeded', 'app', 'scope', 'tokenId', 'tokenName', 'revokedAt',
    'issuanceEvidenceId', 'issuanceStartedAt', 'issuanceCompletedAt', 'requestedLifetimeMs', 'expiresAt'])
    && a.version === 'p10b-app-token-issuance-v1' && a.ownerAttested === true && a.issuanceSucceeded === true
    && a.app === s.app && a.scope === 'app-deploy' && a.revokedAt === null
    && typeof a.tokenId === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(a.tokenId)
    && a.tokenName === `p10b-runtime-no-email-${s.nonce}`
    && typeof a.issuanceEvidenceId === 'string' && /^[A-Za-z0-9_.:@-]{1,240}$/.test(a.issuanceEvidenceId)
    && [a.issuanceStartedAt, a.issuanceCompletedAt, a.expiresAt].every(date)
    && Date.parse(a.issuanceStartedAt) <= Date.parse(a.issuanceCompletedAt)
    && Date.parse(a.issuanceCompletedAt) - Date.parse(a.issuanceStartedAt) <= 60000
    && Date.parse(a.issuanceCompletedAt) <= Date.parse(s.startedAt) && Date.parse(a.issuanceCompletedAt) <= now
    && a.requestedLifetimeMs === 7200000
    && Date.parse(a.expiresAt) >= Date.parse(a.issuanceStartedAt) + 7199000
    && Date.parse(a.expiresAt) <= Date.parse(a.issuanceCompletedAt) + 7200000
    && Date.parse(a.expiresAt) >= Date.parse(s.sessionDeadline);
}
export function validateP10bStoppedUpdateSession(s, now = Date.now()) {
  const keys = ['version', 'operation', 'recoveryPolicy', 'app', 'machineId', 'volumeId', 'sourceHead', 'hostSourceHead', 'nonce',
    'baselineConfig', 'baselineImageDigest', 'baselineInstanceId', 'baselineObservedAt', 'candidateImageDigest',
    'diagnosticConfig', 'diagnosticConfigDigest', 'ownerPermissionDigest', 'permissionEvidenceId', 'startedAt', 'sessionDeadline',
    'maximumStarts', 'maximumStartWindowMs', 'qualificationAllowed', 'maximumDiagnosticPosts', 'maximumRestorationPosts',
    'maximumStoppedConfigUpdates', 'requestTimeoutMs', 'maximumObservationMs', 'maximumRunMs', 'maximumLocalBuilds',
    'maximumImagePushes', 'maximumIncrementalUsd', 'productionReady', 'globalAutomationPaused', 'nativeClientSha256',
    'authenticationEvidence', 'configurationEvidence', 'budget', 'flyExecutable', 'namesClientPath', 'namesClientSha256', 'recovery'];
  if (!only(s, keys) || s.version !== 'p10b-stopped-update-session-v2' || s.operation !== 'stopped-update-diagnostic' || s.recoveryPolicy !== 'acknowledged-only-nonrunning-v1'
    || s.app !== 'uckele-group-p10b' || s.machineId !== '0803730bd1d7e8' || s.volumeId !== 'vol_vwnkpex1k3yx9dnv'
    || s.sourceHead !== P10B_RETAINED_GUEST_HEAD || s.candidateImageDigest !== P10B_RETAINED_IMAGE
    || typeof s.hostSourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(s.hostSourceHead) || s.hostSourceHead === s.sourceHead
    || typeof s.nonce !== 'string' || !/^[a-f0-9]{24}$/.test(s.nonce)
    || s.baselineImageDigest !== 'sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629'
    || typeof s.baselineInstanceId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(s.baselineInstanceId)
    || ![s.startedAt, s.sessionDeadline, s.baselineObservedAt].every(date) || !Number.isFinite(now)
    || Date.parse(s.sessionDeadline) - Date.parse(s.startedAt) !== 900000 || now < Date.parse(s.startedAt)
    || now >= Date.parse(s.sessionDeadline) || Date.parse(s.baselineObservedAt) < Date.parse(s.startedAt)
    || Date.parse(s.baselineObservedAt) > now || Date.parse(s.baselineObservedAt) - Date.parse(s.startedAt) > 120000
    || s.maximumStarts !== 0 || s.maximumStartWindowMs !== 0 || s.qualificationAllowed !== false
    || s.maximumDiagnosticPosts !== 1 || s.maximumRestorationPosts !== 1 || s.maximumStoppedConfigUpdates !== 2
    || s.requestTimeoutMs !== 10000 || s.maximumObservationMs !== 10000 || s.maximumRunMs !== 120000
    || s.maximumLocalBuilds !== 0 || s.maximumImagePushes !== 0 || s.maximumIncrementalUsd !== 1
    || s.productionReady !== false || s.globalAutomationPaused !== true || !hex(s.nativeClientSha256)
    || !hex(s.ownerPermissionDigest) || !/^[A-Za-z0-9_.:@-]{1,240}$/.test(s.permissionEvidenceId || '')
    || !authentication(s, now) || !only(s.configurationEvidence, ['version', 'providerIdentity', 'providerIdentityDigest', 'flySecretMetadataDigest', 'verifiedAt'])
    || s.configurationEvidence.version !== 'p10b-isolated-configuration-evidence-v2'
    || s.configurationEvidence.providerIdentityDigest !== p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY)
    || stableCanonicalJson(s.configurationEvidence.providerIdentity) !== stableCanonicalJson(P10B_PROVIDER_IDENTITY)
    || !hex(s.configurationEvidence.flySecretMetadataDigest) || !date(s.configurationEvidence.verifiedAt)
    || now < Date.parse(s.configurationEvidence.verifiedAt) || now - Date.parse(s.configurationEvidence.verifiedAt) > 86400000
    || !only(s.budget, ['priceEvidenceDigest', 'maximumUsdPerSecond', 'fixedIncrementalUsd']) || !hex(s.budget.priceEvidenceDigest)
    || !Number.isFinite(s.budget.maximumUsdPerSecond) || s.budget.maximumUsdPerSecond < 0
    || !Number.isFinite(s.budget.fixedIncrementalUsd) || s.budget.fixedIncrementalUsd < 0
    || s.budget.fixedIncrementalUsd + 120 * s.budget.maximumUsdPerSecond >= 1
    || !only(s.flyExecutable, ['path', 'sha256']) || typeof s.flyExecutable.path !== 'string' || !s.flyExecutable.path.startsWith('/')
    || !hex(s.flyExecutable.sha256) || typeof s.namesClientPath !== 'string' || !s.namesClientPath.startsWith('/') || !hex(s.namesClientSha256)
    || (s.recovery && (!only(s.recovery, ['directory', 'activePath', 'archivePath', 'attemptPath', 'intentPath', 'terminalPath',
      'expectedSha256', 'version', 'packetDigest', 'evidencePath', 'reservedAt']) || !hex(s.recovery.packetDigest)
      || !hex(s.recovery.expectedSha256) || !date(s.recovery.reservedAt)
      || ('version' in s.recovery && s.recovery.version !== 'p10b-machine-owner-v1')
      || ['directory', 'activePath', 'archivePath', 'attemptPath', 'intentPath', 'terminalPath', 'evidencePath']
        .some(key => typeof s.recovery[key] !== 'string' || !s.recovery[key].startsWith('/'))))
    || !hex(s.diagnosticConfigDigest) || digest(s.diagnosticConfig) !== s.diagnosticConfigDigest
    || stableCanonicalJson(s.diagnosticConfig) !== stableCanonicalJson(createP10bStoppedDiagnosticConfig(s))) {
    throw Error('Exact zero-start diagnostic session required');
  }
  validateP10bBaselineConfig(s.baselineConfig, s.baselineImageDigest);
  for (const [name, value] of Object.entries(P10B_RUNTIME_FLAGS)) {
    if (name !== 'P10B_QUALIFICATION_RUNTIME' && s.baselineConfig.env[name] !== value) throw Error('Frozen baseline hard-off or sender identity drift');
  }
  return true;
}
export function assertP10bStoppedUpdateApproval(session, approval, now = Date.now()) {
  validateP10bStoppedUpdateSession(session, now);
  if (!only(approval, ['version', 'approved', 'sessionDigest', 'ownerPermissionDigest', 'sourceHead', 'hostSourceHead',
    'expiresAt', 'recoveryApproved', 'exclusiveAdmissionWriters', 'providerCalls', 'emails'])
    || approval.version !== 'p10b-stopped-update-approval-v2' || approval.approved !== true
    || approval.sessionDigest !== digest(session) || approval.ownerPermissionDigest !== session.ownerPermissionDigest
    || approval.sourceHead !== session.sourceHead || approval.hostSourceHead !== session.hostSourceHead
    || approval.expiresAt !== session.sessionDeadline || approval.recoveryApproved !== true
    || approval.exclusiveAdmissionWriters !== true || approval.providerCalls !== 0 || approval.emails !== 0) {
    throw Error('Exact stopped-update owner approval required');
  }
  return true;
}
export function assertP10bStoppedUpdateHostBinding(session, checkSource = assertP10bReviewedCheckout) {
  if (session.nativeClientSha256 !== P10B_STOPPED_DIAGNOSTIC_NATIVE_SHA256) throw Error('Reviewed diagnostic native executable required');
  checkSource(session.hostSourceHead);
}
const failureCodes = new Set(['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output',
  'bridge-timeout', 'bridge-protocol', 'bridge-failed']);
export function checkedP10bStoppedObservation(observation, code = null) {
  if (!observation || Object.keys(observation).sort().join(',') !== 'dispatched,elapsedMs,httpStatus'
    || !Number.isSafeInteger(observation.elapsedMs) || observation.elapsedMs < 0
    || (observation.httpStatus !== null && (!Number.isInteger(observation.httpStatus) || observation.httpStatus < 100 || observation.httpStatus > 599))
    || (code?.startsWith('bridge-') ? observation.dispatched !== null || observation.httpStatus !== null
      : typeof observation.dispatched !== 'boolean')
    || (observation.httpStatus !== null && observation.dispatched !== true)
    || (code === null && (observation.httpStatus < 200 || observation.httpStatus > 299 || observation.dispatched !== true))
    || (code === 'http-failed' && (observation.httpStatus === null || observation.httpStatus >= 200 && observation.httpStatus <= 299))
    || (code === 'request-denied' && (observation.dispatched !== false || observation.httpStatus !== null))) {
    throw Error('Closed diagnostic observation required');
  }
  return { httpStatus: observation.httpStatus, elapsedMs: observation.elapsedMs, dispatched: observation.dispatched };
}
export function checkedP10bStoppedSettlement(value, version) {
  if (!value || Object.keys(value).sort().join(',') !== 'ok,state,version' || value.ok !== true
    || !['created', 'stopped'].includes(value.state) || !/^[A-Za-z0-9-]{1,80}$/.test(value.version || '')
    || value.version !== version) throw Error('Closed version-bound nonrunning settlement required');
  return { ok: true, state: value.state, version: value.version };
}
function checkedFailure(facts) {
  if (!facts || Object.keys(facts).sort().join(',') !== 'code,method,observation,timeoutMs'
    || !failureCodes.has(facts.code) || !['GET', 'POST', 'WAIT'].includes(facts.method)
    || !Number.isInteger(facts.timeoutMs) || facts.timeoutMs < 1 || facts.timeoutMs > 10000) throw Error('Closed diagnostic failure required');
  return { code: facts.code, method: facts.method, timeoutMs: facts.timeoutMs,
    observation: checkedP10bStoppedObservation(facts.observation, facts.code) };
}
export class P10bStoppedUpdateRequestError extends Error {
  constructor(facts) {
    super('Stopped-update request failed');
    const checked = checkedFailure(facts); Object.freeze(checked.observation);
    Object.defineProperty(this, 'publicFailure', { value: Object.freeze(checked) });
  }
}
export function publicP10bStoppedUpdateFailure(error) {
  if (!(error instanceof P10bStoppedUpdateRequestError)) return null;
  try { return checkedFailure(Object.getOwnPropertyDescriptor(error, 'publicFailure')?.value); }
  catch { return null; }
}
