import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { validateP10bBaselineConfig, P10B_RUNTIME_FLAGS } from './p10bRuntimeOnlyOperator.js';
export const P10B_STOPPED_LOG_PROBE_STEPS = Object.freeze(['BASELINE_BEFORE', 'LOG_FIRST', 'LOG_STEADY', 'BASELINE_AFTER']);
export const P10B_STOPPED_LOG_PROBE_BUDGETS = Object.freeze([1000, 5000, 700, 1000]);
export const exactProbeKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function assertP10bStoppedLogProbeApproval(p, a, now = Date.now()) {
  const keys = ['version', 'operation', 'app', 'machineId', 'volumeId', 'hostSourceHead', 'nativeClientSha256', 'nonce', 'issuedAt', 'expiresAt',
    'evidenceDirectory', 'baselineConfig', 'baselineConfigDigest', 'baselineImageDigest', 'baselineInstanceId', 'maximumStarts',
    'maximumStoppedConfigUpdates', 'maximumMachineReads', 'maximumLogReads', 'aggregateTimeoutMs', 'cleanupReserveMs', 'firstLogTimeoutMs',
    'steadyLogTimeoutMs', 'machineTimeoutMs', 'productionReady', 'qualificationAllowed', 'globalAutomationPaused', 'providerCalls', 'emails'];
  if (!exactProbeKeys(p, keys) || p.version !== 'p10b-stopped-log-probe-v1' || p.operation !== 'stopped-log-probe'
    || p.app !== 'uckele-group-p10b' || p.machineId !== '0803730bd1d7e8' || p.volumeId !== 'vol_vwnkpex1k3yx9dnv'
    || !/^[a-f0-9]{40}$/.test(p.hostSourceHead) || !/^[a-f0-9]{64}$/.test(p.nativeClientSha256) || !/^[a-f0-9]{24}$/.test(p.nonce)
    || !canonicalTime(p.issuedAt) || !canonicalTime(p.expiresAt) || Date.parse(p.expiresAt) - Date.parse(p.issuedAt) !== 30000
    || !Number.isFinite(now) || now < Date.parse(p.issuedAt) || now >= Date.parse(p.expiresAt) - 3000
    || typeof p.evidenceDirectory !== 'string' || p.evidenceDirectory.length > 1024 || !path.isAbsolute(p.evidenceDirectory)
    || path.normalize(p.evidenceDirectory) !== p.evidenceDirectory || !/^\/[A-Za-z0-9_./ -]+$/.test(p.evidenceDirectory)
    || p.baselineImageDigest !== 'sha256:24e681ab519b1a083c5f1081ba8a85a677aabcc42125df5937172feca255e629'
    || typeof p.baselineInstanceId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(p.baselineInstanceId) || p.baselineConfigDigest !== sha256(stableCanonicalJson(p.baselineConfig))
    || p.maximumStarts !== 0 || p.maximumStoppedConfigUpdates !== 0 || p.maximumMachineReads !== 2 || p.maximumLogReads !== 2
    || p.aggregateTimeoutMs !== 30000 || p.cleanupReserveMs !== 3000 || p.firstLogTimeoutMs !== 5000 || p.steadyLogTimeoutMs !== 700
    || p.machineTimeoutMs !== 1000 || p.productionReady !== false || p.qualificationAllowed !== false || p.globalAutomationPaused !== true
    || p.providerCalls !== 0 || p.emails !== 0) throw Error('Exact stopped log probe authority required');
  validateP10bBaselineConfig(p.baselineConfig, p.baselineImageDigest);
  if (['P10B_GUEST_WINDOW', 'P10B_QUALIFICATION_PHASE', 'P10B_QUALIFICATION_RUNTIME'].some(k => Object.hasOwn(p.baselineConfig.env, k))
    || Object.entries(P10B_RUNTIME_FLAGS).some(([k, v]) => k !== 'P10B_QUALIFICATION_RUNTIME' && p.baselineConfig.env[k] !== v)) {
    throw Error('Retained hard-off stopped baseline required');
  }
  if (!exactProbeKeys(a, ['version', 'approved', 'probeDigest', 'hostSourceHead', 'nativeClientSha256', 'expiresAt', 'approvedAt'])
    || a.version !== 'p10b-stopped-log-probe-approval-v1' || a.approved !== true || a.probeDigest !== sha256(stableCanonicalJson(p))
    || a.hostSourceHead !== p.hostSourceHead || a.nativeClientSha256 !== p.nativeClientSha256 || a.expiresAt !== p.expiresAt
    || !canonicalTime(a.approvedAt) || Date.parse(a.approvedAt) < Date.parse(p.issuedAt) || Date.parse(a.approvedAt) > now) {
    throw Error('Separate exact stopped log probe approval required');
  }
  return true;
}
// Anchor before validation, durable intent, allocation and spawn. Wall rollback
// cannot replenish the once-anchored monotonic budget.
export function createP10bStoppedLogProbeBudget(probe, { clock = Date.now, monotonicClock = () => performance.now() } = {}) {
  const began = clock(); const mono = monotonicClock(); const end = Date.parse(probe?.expiresAt);
  const remaining = Math.min(30000, end - began);
  return { active(cleanup = false) { return clock() >= Date.parse(probe?.issuedAt) && clock() < end - (cleanup ? 0 : 3000)
    && monotonicClock() - mono < remaining - (cleanup ? 0 : 3000); },
    remaining(cleanup = false) { return Math.max(0, Math.min(end - clock(), remaining - (monotonicClock() - mono)) - (cleanup ? 0 : 3000)); } };
}
export function checkedP10bStoppedLogObservation(value, operation, probe) {
  const baseline = operation.startsWith('BASELINE'); const limit = P10B_STOPPED_LOG_PROBE_BUDGETS[P10B_STOPPED_LOG_PROBE_STEPS.indexOf(operation)];
  if (!exactProbeKeys(value, baseline ? ['kind', 'state', 'instanceId', 'configDigest', 'imageDigest', 'httpStatus', 'elapsedMs', 'dispatched']
    : ['kind', 'providerBatchEmpty', 'httpStatus', 'elapsedMs', 'dispatched']) || value.httpStatus !== 200 || value.dispatched !== true
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs >= limit
    || (baseline ? value.kind !== 'baseline' || value.state !== 'stopped' || value.instanceId !== probe.baselineInstanceId
      || value.configDigest !== probe.baselineConfigDigest || value.imageDigest !== probe.baselineImageDigest
      : value.kind !== 'log' || typeof value.providerBatchEmpty !== 'boolean')) throw Error('Stopped probe projection denied');
  return structuredClone(value);
}
