import { sha256, stableCanonicalJson } from '../utils/security.js';
import { once } from 'node:events';

const digest = value => sha256(stableCanonicalJson(value));
const machineId = '0803730bd1d7e8';

// An operator wrapper must check both child termination and retained evidence.
// Printing the child's exit code alone must never turn failed prep into exit 0.
export function assertP10bPreparationTerminal({ code, signal, result } = {}) {
  const preparation = result?.preparation; const shutdown = preparation?.guestShutdown;
  if (code !== 0 || signal !== null || result?.version !== 'p10b-host-result-v1'
    || result.operation !== 'prepare' || result.success !== true || result.failureStage !== null
    || result.stoppedVerified !== true || result.processReaped !== true
    || result.stopUncertain !== false || result.startUncertain !== false
    || result.productionReady !== false || result.lifecycleVerified !== false
    || preparation?.providerCalls !== 0 || preparation.productionReady !== false
    || preparation.ingressClosed !== true || preparation.sqliteClosed !== true
    || shutdown?.handoffVerified !== true || shutdown.cleanupUncertain !== false || shutdown.failure !== false
    || shutdown.authorityClosed !== true || shutdown.ingressClosed !== true || shutdown.workerSqliteClosed !== true) {
    throw Error('Preparation terminal failed; retain child and host evidence');
  }
  return true;
}

export async function awaitP10bPreparationChild({ child, readResult, onExit } = {}) {
  let terminal;
  try { const [code, signal] = await once(child, 'close'); terminal = { code, signal }; }
  catch { throw Error('Preparation terminal failed; child could not complete'); }
  await onExit(terminal);
  let result;
  try { result = await readResult(); }
  catch { throw Error('Preparation terminal failed; host result unavailable'); }
  assertP10bPreparationTerminal({ ...terminal, result });
  return result;
}

// Boundary-injected extraction of the existing runtime-only update controls.
// Importing this module performs no authentication, I/O or external operation.
export function createP10bRuntimeOnlyControl({ session, evidence, clock = () => Date.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const start = Date.parse(session?.startedAt); const deadline = Date.parse(session?.sessionDeadline);
  if (session?.app !== 'uckele-group-p10b' || session.machineId !== machineId
    || !Number.isFinite(start) || !Number.isFinite(deadline) || deadline - start > 3600000 || deadline <= start
    || session.maximumStarts !== 2 || session.maximumStartWindowMs !== 300000 || session.maximumIncrementalUsd !== 1
    || session.maximumStoppedConfigUpdates !== 3 || session.productionReady !== false || session.globalAutomationPaused !== true
    || !/^[a-f0-9]{64}$/.test(session.ownerPermissionDigest || '')
    || !/^sha256:[a-f0-9]{64}$/.test(session.candidateImageDigest || '')
    || !/^sha256:[a-f0-9]{64}$/.test(session.baselineImageDigest || '')) throw Error('Frozen runtime session invalid');
  function assertTime(reserve = 0, now = clock()) {
    if (evidence.has('p10b-runtime-only-session-closure.json')) throw Error('Frozen runtime attempt is closed');
    if (!Number.isFinite(now) || !Number.isFinite(reserve) || reserve < 0
      || now < start || now + reserve >= deadline) throw Error('Frozen session cutoff');
  }
  function assertStopped(machine, expectedConfig) {
    const expectedDigest = expectedConfig.image?.split('@')[1];
    if (machine.id !== machineId || machine.state !== 'stopped' || machine.region !== 'ewr' || !machine.instance_id
      || stableCanonicalJson(machine.config) !== stableCanonicalJson(expectedConfig)
      || (expectedDigest && machine.image_ref?.digest !== expectedDigest)) throw Error('Exact stopped full configuration changed');
  }
  function assertWindow(window, now = clock()) {
    assertTime(330000, now);
    if (Date.parse(window.issuedAt) > now || now - Date.parse(window.issuedAt) > 60000
      || Date.parse(window.stopAt) - Date.parse(window.issuedAt) !== 300000
      || Date.parse(window.stopAt) >= deadline) throw Error('Frozen five-minute start window');
  }
  async function readUpdatedStopped(client, expectedConfig, instanceId, readbackDeadline,
    { previous, onReadback = () => {} } = {}) {
    do {
      assertTime();
      const remaining = readbackDeadline - clock();
      if (remaining <= 0) throw Error('Stopped update readback timed out');
      const checked = await client('GET', undefined, Math.min(1000, remaining));
      onReadback({ at: new Date(clock()).toISOString(), id: checked.id, state: checked.state,
        instanceId: checked.instance_id, imageDigest: checked.image_ref?.digest, configDigest: digest(checked.config || null) });
      if (clock() >= readbackDeadline) throw Error('Stopped update readback timed out');
      const next = checked.id === machineId && checked.instance_id === instanceId
        && stableCanonicalJson(checked.config) === stableCanonicalJson(expectedConfig)
        && checked.image_ref?.digest === expectedConfig.image?.split('@')[1] && ['created', 'stopped'].includes(checked.state);
      const prior = previous && checked.id === machineId && checked.instance_id === previous.instance_id
        && stableCanonicalJson(checked.config) === stableCanonicalJson(previous.config)
        && checked.image_ref?.digest === previous.image_ref?.digest && ['stopped', 'replacing'].includes(checked.state);
      if (!next && !prior) throw Error('Updated instance or configuration changed during stopped readback');
      if (next && checked.state === 'stopped') {
        assertStopped(checked, expectedConfig);
        if (clock() >= readbackDeadline) throw Error('Stopped update readback timed out');
        assertTime();
        return checked;
      }
      await wait(Math.min(100, Math.max(1, readbackDeadline - clock())));
    } while (clock() < readbackDeadline);
    throw Error('Stopped update readback timed out');
  }
  async function guardedUpdate(client, expectedConfig, nextConfig, label) {
    assertTime(label === 'rollback' ? 30000 : 360000);
    if (!['demo', 'prepare', 'rollback'].includes(label)) throw Error('Update not admitted');
    const used = ['demo', 'prepare', 'rollback'].filter(value => evidence.has(`p10b-runtime-only-update-${value}-intent.json`));
    if (used.includes(label) || used.length >= 3) throw Error('Update replay forbidden');
    if (label === 'prepare' && (!evidence.has('p10b-runtime-only-demo-proof.json')
      || evidence.read('p10b-runtime-only-demo-proof.json')?.success !== true)) throw Error('Guardian timing proof required');
    const current = await client(); assertStopped(current, expectedConfig);
    if (nextConfig.restart?.policy !== 'no' || nextConfig.guest?.memory_mb !== 512 || nextConfig.guest?.cpus !== 1
      || nextConfig.guest?.cpu_kind !== 'shared' || nextConfig.mounts?.length !== 1
      || nextConfig.mounts[0].volume !== 'vol_vwnkpex1k3yx9dnv' || nextConfig.mounts[0].path !== '/data'
      || !Array.isArray(nextConfig.services) || nextConfig.services.length !== 1
      || nextConfig.services.some(service => service.autostart !== false || service.autostop !== false || service.internal_port !== 8787)) {
      throw Error('Frozen capacity or shutdown settings changed');
    }
    evidence.write(`p10b-runtime-only-update-${label}-intent.json`, { at: new Date(clock()).toISOString(),
      currentVersion: current.instance_id, configDigest: digest(nextConfig), skip_launch: true });
    const updated = await client('POST', { config: nextConfig, skip_launch: true, current_version: current.instance_id });
    evidence.write(`p10b-runtime-only-update-${label}-response.json`, updated);
    const readbacks = [];
    try {
      const checked = await readUpdatedStopped(client, nextConfig, updated.instance_id, Math.min(clock() + 10000, deadline),
        { previous: current, onReadback: value => readbacks.push(value) });
      evidence.write(`p10b-runtime-only-update-${label}-verified.json`, checked);
      return checked;
    } finally { evidence.write(`p10b-runtime-only-update-${label}-readback.json`, readbacks); }
  }
  async function restoreBaseline(client, baselineConfig, knownConfigs) {
    assertTime(30000);
    const current = await client();
    if (current.state !== 'stopped') throw Error('Cannot restore without certain stopped state');
    const alreadyBaseline = stableCanonicalJson(current.config) === stableCanonicalJson(baselineConfig)
      && current.image_ref?.digest === session.baselineImageDigest;
    const expected = knownConfigs.find(config => stableCanonicalJson(current.config) === stableCanonicalJson(config));
    if (!alreadyBaseline && (!expected || current.image_ref?.digest !== session.candidateImageDigest)) {
      throw Error('Rollback refuses unknown concurrent configuration');
    }
    if (!alreadyBaseline) await guardedUpdate(client, expected, baselineConfig, 'rollback');
    else assertStopped(current, baselineConfig);
    const restored = { at: new Date(clock()).toISOString(), state: 'stopped', baselineImageDigest: session.baselineImageDigest,
      fullConfigRestored: true, alreadyBaseline, productionReady: false, globalAutomationPaused: true };
    evidence.write('p10b-runtime-only-restored.json', restored);
    return restored;
  }
  return { assertTime, assertStopped, assertWindow, readUpdatedStopped, guardedUpdate, restoreBaseline };
}
