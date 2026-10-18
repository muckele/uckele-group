import { p10bStoppedUpdateReport } from './p10bStoppedUpdateReport.js';
import { performance } from 'node:perf_hooks';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bStoppedUpdateApproval, checkedP10bStoppedObservation, checkedP10bStoppedSettlement, publicP10bStoppedUpdateFailure } from './p10bStoppedUpdateContract.js';
const digest = value => sha256(stableCanonicalJson(value));
const same = (a, b) => stableCanonicalJson(a) === stableCanonicalJson(b);
const nonrunning = m => ['created', 'stopped'].includes(m.state);
// This controller has no start/observer/qualification boundary. The native
// mode independently gates acknowledgement, settlement and the two exact writes.
export async function runP10bStoppedUpdateDiagnostic({ session, approval, evidence, createClient,
  assertAdmission, clock = Date.now, runDeadline = Math.min(clock() + 120000, Date.parse(session.sessionDeadline)) }) {
  assertP10bStoppedUpdateApproval(session, approval, clock());
  if (typeof assertAdmission !== 'function' || assertAdmission() !== true || !Number.isFinite(runDeadline)
    || runDeadline > clock() + 120000 || runDeadline > Date.parse(session.sessionDeadline)) throw Error('Diagnostic admission required');
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-stopped-update-intent.json')
    || evidence.has('p10b-stopped-update-closure.json')) throw Error('Diagnostic held or consumed');
  const requireTime = (reserve = 0) => { if (clock() + reserve >= runDeadline || clock() < Date.parse(session.startedAt)) throw Error('Diagnostic cutoff reached'); };
  requireTime(40000);
  evidence.write('p10b-stopped-update-intent.json', { at: new Date(clock()).toISOString(), sessionDigest: digest(session),
    maximumDiagnosticPosts: 1, maximumRestorationPosts: 1, maximumStarts: 0, skip_launch: true, runDeadline: new Date(runDeadline).toISOString() });
  let native; let primary = null; let restoration = null; let baselineObserved = false; let mutationSettled = false;
  let restored = false; let attempted = false; let nativeReapVerified = false; let stage = 'native-initialization';
  let failureStage = null; let sequence = 0; let failure = null; let lastObservation = null;
  const machine = value => {
    if (!value || Object.keys(value).some(k => !['id', 'region', 'state', 'instance_id', 'config', 'image_ref', 'events'].includes(k))
      || value.id !== session.machineId || value.region !== 'ewr' || !/^[A-Za-z0-9-]{1,80}$/.test(value.instance_id || '')
      || !['stopped', 'created', 'replacing'].includes(value.state)
      || (!same(value.config, session.baselineConfig) && !same(value.config, session.diagnosticConfig))
      || value.image_ref?.digest !== value.config.image.split('@')[1]) throw Error('Diagnostic public Machine drift');
    return value;
  };
  const admit = () => { if (assertAdmission() !== true) throw Error('Diagnostic admission withdrawn'); requireTime(); };
  const observe = async (label, end = runDeadline) => {
    requireTime(); admit();
    if (clock() >= end) throw Error('Observation cutoff reached');
    const result = await native.client('GET', undefined, Math.min(1000, end - clock(), runDeadline - clock()));
    requireTime(); admit();
    if (clock() >= end) throw Error('Observation cutoff reached');
    const m = machine(result.machine); const observation = checkedP10bStoppedObservation(result.observation);
    evidence.write(`p10b-stopped-update-observation-${++sequence}.json`, { label, at: new Date(clock()).toISOString(),
      instanceId: m.instance_id, state: m.state, imageDigest: m.image_ref.digest, configDigest: digest(m.config),
      configuration: m.config, observation });
    lastObservation = { at: new Date(clock()).toISOString(), state: m.state,
      configurationRole: same(m.config, session.baselineConfig) ? 'baseline' : 'diagnostic' };
    if (nonrunning(m) && same(m.config, session.baselineConfig)) baselineObserved = true;
    return m;
  };
  const write = async (config, current, label) => {
    admit(); requireTime(label === 'diagnostic' ? 40000 : 20000);
    evidence.write(`p10b-stopped-update-${label}-intent.json`, { at: new Date(clock()).toISOString(),
      currentVersion: current.instance_id, configDigest: digest(config), skip_launch: true, timeoutMs: 10000 });
    admit(); requireTime(label === 'diagnostic' ? 40000 : 20000);
    const start = performance.now(); const startedAt = clock();
    let outcome;
    try {
      const response = await native.client('POST', { config, current_version: current.instance_id, skip_launch: true }, 10000);
      const acknowledged = machine(response.machine);
      requireTime(); admit();
      const observation = checkedP10bStoppedObservation(response.observation);
      if (clock() - startedAt >= 10000 || observation.elapsedMs >= 10000
        || acknowledged.instance_id === current.instance_id || acknowledged.instance_id === session.baselineInstanceId || !same(acknowledged.config, config)) throw Error('Unusable update acknowledgement');
      outcome = { code: null, method: 'POST', timeoutMs: 10000, observation, acknowledgedVersion: acknowledged.instance_id };
    } catch (error) {
      outcome = publicP10bStoppedUpdateFailure(error) || { code: 'bridge-failed', method: 'POST', timeoutMs: 10000,
        observation: { httpStatus: null, elapsedMs: Math.max(0, Math.round(performance.now() - start)), dispatched: null } };
    }
    evidence.write(`p10b-stopped-update-${label}-outcome.json`, outcome);
    return outcome;
  };
  const settledReadback = async (outcome, config, label) => {
    const end = Math.min(clock() + 10000, runDeadline - 20000);
    const timeoutMs = Math.min(9000, end - clock() - 1);
    requireTime(); admit();
    if (timeoutMs < 1000) throw Error('Settlement cutoff reached');
    const started = performance.now();
    try {
      const response = await native.client('WAIT', { version: outcome.acknowledgedVersion }, timeoutMs);
      requireTime(); admit();
      const settlement = checkedP10bStoppedSettlement(response.settlement, outcome.acknowledgedVersion);
      const observation = checkedP10bStoppedObservation(response.observation);
      if (clock() >= end || observation.elapsedMs >= timeoutMs) throw Error('Exact acknowledged settlement required');
      evidence.write(`p10b-stopped-update-${label}-settlement.json`, { version: settlement.version, state: settlement.state, observation });
    } catch (error) {
      failure = publicP10bStoppedUpdateFailure(error);
      evidence.write(`p10b-stopped-update-${label}-settlement-failure.json`, failure || {
        code: 'bridge-failed', method: 'WAIT', timeoutMs, observation: { httpStatus: null,
          elapsedMs: Math.max(0, Math.round(performance.now() - started)), dispatched: null } });
      throw Error('Acknowledged settlement unverified');
    }
    const current = await observe(label, end);
    requireTime(); admit();
    if (clock() >= end || current.instance_id !== outcome.acknowledgedVersion
      || !nonrunning(current) || !same(current.config, config)) throw Error('Acknowledged current version changed');
    return current;
  };
  try {
    native = await createClient(); stage = 'before-observation';
    const before = await observe('before');
    if (before.state !== 'stopped' || before.instance_id !== session.baselineInstanceId || !same(before.config, session.baselineConfig)) throw Error('Frozen stopped baseline changed');
    stage = 'diagnostic-write'; attempted = true;
    primary = await write(session.diagnosticConfig, before, 'diagnostic');
    // An uncertain primary outcome permanently withholds automatic restoration.
    // Neither later visibility nor a wait/lease is a fence for an ambiguous POST.
    if (primary.code === null) {
      stage = 'diagnostic-settlement';
      const accepted = await settledReadback(primary, session.diagnosticConfig, 'after');
      stage = 'conditional-restoration';
      restoration = await write(session.baselineConfig, accepted, 'restoration');
      if (restoration.code === null) {
        stage = 'restoration-settlement';
        await settledReadback(restoration, session.baselineConfig, 'restoration');
        restored = true; mutationSettled = true;
      }
    } else if (primary.observation.dispatched === false && baselineObserved) mutationSettled = true;
    if (!mutationSettled) { failureStage = stage; failure ||= restoration?.code ? restoration : primary?.code ? primary : null; }
    else if (primary.code !== null) { failureStage = 'diagnostic-write'; failure = primary; }
  } catch (error) { failureStage ||= stage; failure ||= publicP10bStoppedUpdateFailure(error); }
  finally {
    if (native) { try { nativeReapVerified = await native.reap() === true; } catch { nativeReapVerified = false; } }
    if (!nativeReapVerified) failureStage ||= 'native-reap-unverified';
  }
  const result = { version: 'p10b-stopped-update-closure-v2', operation: 'stopped-update-diagnostic', closedAt: new Date(clock()).toISOString(),
    sessionDigest: digest(session), recoveryPolicy: session.recoveryPolicy, primary, restoration, baselineObserved, mutationSettled,
    mutationUncertain: attempted && !mutationSettled, restored, nativeReapVerified, failureStage,
    success: !failureStage && restored && nativeReapVerified, maximumStarts: 0,
    qualificationAllowed: false, providerCalls: 0, emails: 0, productionReady: false, globalAutomationPaused: true };
  result.lastObservation = lastObservation;
  result.operatorReport = p10bStoppedUpdateReport({ sessionDigest: result.sessionDigest, success: result.success,
    failedStep: result.failureStage, failure, lastObservation, mutationUncertain: result.mutationUncertain,
    restored, clientsClosed: nativeReapVerified });
  evidence.write('p10b-stopped-update-closure.json', result);
  return result;
}
