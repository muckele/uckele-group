import { performance } from 'node:perf_hooks';
import { setTimeout as waitDefault } from 'node:timers/promises';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bStoppedUpdateApproval, checkedP10bStoppedObservation, publicP10bStoppedUpdateFailure } from './p10bStoppedUpdateContract.js';
const digest = value => sha256(stableCanonicalJson(value));
const same = (a, b) => stableCanonicalJson(a) === stableCanonicalJson(b);
// This controller has no start/observer/qualification boundary. The native
// mode independently restricts the same two exact stopped-only writes.
export async function runP10bStoppedUpdateDiagnostic({ session, approval, evidence, createClient,
  assertAdmission, clock = Date.now, wait = waitDefault, runDeadline = Math.min(clock() + 120000, Date.parse(session.sessionDeadline)) }) {
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
  let failureStage = null; let sequence = 0;
  const machine = value => {
    if (!value || Object.keys(value).some(k => !['id', 'region', 'state', 'instance_id', 'config', 'image_ref', 'events'].includes(k))
      || value.id !== session.machineId || value.region !== 'ewr' || !/^[A-Za-z0-9-]{1,80}$/.test(value.instance_id || '')
      || !['stopped', 'created', 'replacing'].includes(value.state)
      || (!same(value.config, session.baselineConfig) && !same(value.config, session.diagnosticConfig))
      || value.image_ref?.digest !== value.config.image.split('@')[1]) throw Error('Diagnostic public Machine drift');
    return value;
  };
  const admit = () => { if (assertAdmission() !== true) throw Error('Diagnostic admission withdrawn'); };
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
    if (m.state === 'stopped' && same(m.config, session.baselineConfig)) baselineObserved = true;
    return m;
  };
  const write = async (config, current, label) => {
    requireTime(label === 'diagnostic' ? 40000 : 20000); admit();
    evidence.write(`p10b-stopped-update-${label}-intent.json`, { at: new Date(clock()).toISOString(),
      currentVersion: current.instance_id, configDigest: digest(config), skip_launch: true, timeoutMs: 10000 });
    requireTime(label === 'diagnostic' ? 40000 : 20000); admit();
    const start = performance.now();
    let outcome;
    try {
      const response = await native.client('POST', { config, current_version: current.instance_id, skip_launch: true }, 10000);
      machine(response.machine);
      outcome = { code: null, method: 'POST', timeoutMs: 10000, observation: checkedP10bStoppedObservation(response.observation) };
    } catch (error) {
      outcome = publicP10bStoppedUpdateFailure(error) || { code: 'bridge-failed', method: 'POST', timeoutMs: 10000,
        observation: { httpStatus: null, elapsedMs: Math.max(0, Math.round(performance.now() - start)), dispatched: null } };
    }
    evidence.write(`p10b-stopped-update-${label}-outcome.json`, outcome);
    return outcome;
  };
  const find = async (label, accept) => {
    const end = Math.min(clock() + 10000, runDeadline - 20000);
    do {
      const current = await observe(label, end);
      requireTime(); admit();
      if (clock() >= end) break;
      if (accept(current)) return current;
      if (clock() >= end) break;
      await wait(Math.min(250, end - clock()));
    } while (clock() < end);
    return null;
  };
  try {
    native = await createClient(); stage = 'before-observation';
    const before = await observe('before');
    if (before.state !== 'stopped' || before.instance_id !== session.baselineInstanceId || !same(before.config, session.baselineConfig)) throw Error('Frozen stopped baseline changed');
    stage = 'diagnostic-write'; attempted = true;
    primary = await write(session.diagnosticConfig, before, 'diagnostic');
    stage = 'after-observation';
    const accepted = await find('after', m => m.state === 'stopped' && m.instance_id !== before.instance_id && same(m.config, session.diagnosticConfig));
    if (accepted) {
      stage = 'conditional-restoration';
      // Only an exact observed stopped diagnostic version authorizes this
      // separately budgeted baseline CAS. No replay of the diagnostic write.
      restoration = await write(session.baselineConfig, accepted, 'restoration');
      stage = 'restoration-observation';
      const checked = await find('restoration', m => m.state === 'stopped'
        && m.instance_id !== accepted.instance_id && same(m.config, session.baselineConfig));
      if (checked && restoration.code === null) { restored = true; mutationSettled = true; }
    } else if (primary.observation.dispatched === false && baselineObserved) mutationSettled = true;
    if (!mutationSettled) failureStage = 'mutation-settlement-unverified';
    else if (primary.code !== null) failureStage = 'diagnostic-request-failed';
  } catch { failureStage ||= stage; }
  finally {
    if (native) { try { nativeReapVerified = await native.reap() === true; } catch { nativeReapVerified = false; } }
    if (!nativeReapVerified) failureStage ||= 'native-reap-unverified';
  }
  const result = { version: 'p10b-stopped-update-closure-v1', operation: 'stopped-update-diagnostic', closedAt: new Date(clock()).toISOString(),
    sessionDigest: digest(session), primary, restoration, baselineObserved, mutationSettled,
    mutationUncertain: attempted && !mutationSettled, restored, nativeReapVerified, failureStage,
    success: !failureStage && restored && nativeReapVerified, maximumStarts: 0,
    qualificationAllowed: false, providerCalls: 0, emails: 0, productionReady: false, globalAutomationPaused: true };
  evidence.write('p10b-stopped-update-closure.json', result);
  return result;
}
