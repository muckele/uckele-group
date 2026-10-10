import { sha256, stableCanonicalJson } from '../utils/security.js';
import { P10B_GUARDIAN_EXIT_PREFIX } from './p10bGuardianParent.js';
const digest = value => sha256(stableCanonicalJson(value));
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const eventKeys = 'bindingVerified,code,exitedAt,guardianPid,parentPid,parentStartedAt,productionReady,readyDigest,receiptDigest,signal,spawnFailed,startDigest,version,windowDigest';
export function normalizeP10bPlatformTime(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
  if (!match) return null;
  const normalized = `${match[1]}.${(match[2] || '').padEnd(3, '0').slice(0, 3)}Z`;
  return canonicalTime(normalized) ? normalized : null;
}

// Application logs are discarded. Even a guardian-looking log must satisfy
// the complete closed schema before any message bytes are retained.
export function sanitizeP10bGuardianLog(row, window) {
  const message = row?.message ?? row?.msg; const timestamp = normalizeP10bPlatformTime(row?.timestamp ?? row?.time);
  if (row?.instance !== window.machineId || row.region !== 'ewr' || !timestamp
    || typeof message !== 'string' || !message.startsWith(P10B_GUARDIAN_EXIT_PREFIX) || message.length > 2000) return null;
  try {
    const v = JSON.parse(message.slice(P10B_GUARDIAN_EXIT_PREFIX.length));
    if (Object.keys(v).sort().join(',') !== eventKeys || v.version !== 'p10b-guardian-child-exit-v1'
      || v.windowDigest !== digest(window) || v.productionReady !== false || v.bindingVerified !== true
      || v.code !== 0 || v.signal !== null || v.spawnFailed !== false
      || ![v.guardianPid, v.parentPid].every(pid => Number.isSafeInteger(pid) && pid > 1)
      || !canonicalTime(v.exitedAt) || !canonicalTime(v.parentStartedAt)
      || ![v.readyDigest, v.receiptDigest, v.startDigest].every(h => /^[a-f0-9]{64}$/.test(h))) return null;
    return { kind: 'platform-log', timestamp, message: P10B_GUARDIAN_EXIT_PREFIX + JSON.stringify(v), machineId: row.instance, region: 'ewr' };
  } catch { return null; }
}

export function createP10bObserverControls({ phase, machine, client, record, clock = () => Date.now() }) {
  let busy = false; let ended = false; let attached = false; let pending;
  const tick = () => {
    if (ended) return Promise.resolve();
    if (busy) { record({ kind: 'observer-missed-poll', at: new Date(clock()).toISOString() }); return Promise.resolve(); }
    busy = true; const requestedAt = new Date(clock()).toISOString();
    pending = (async () => {
      try {
        const m = await client('GET', undefined, 700);
        if (m.id !== machine.id || m.instance_id !== machine.instance_id || m.image_ref?.digest !== phase.window.imageDigest
          || m.region !== 'ewr' || digest(m.config) !== digest(phase.config)) throw Error('Observer target changed');
        record({ kind: 'metadata', requestedAt, at: new Date(clock()).toISOString(), state: m.state,
          imageDigest: m.image_ref.digest, instanceId: m.instance_id, events: m.events || [] });
        if (!attached && m.state === 'stopped') attached = true;
      } catch { record({ kind: 'observer-read-error', at: new Date(clock()).toISOString() }); }
      finally { busy = false; }
    })();
    return pending;
  };
  return { tick, attached: () => attached,
    log(row) { const safe = sanitizeP10bGuardianLog(row, phase.window); if (safe) record(safe); },
    async finish({ normalCompletion, reap }) {
      if (ended) throw Error('Observer completion replay'); ended = true;
      if (pending) await pending;
      const reaped = await reap();
      record({ kind: 'observer-finished', at: new Date(clock()).toISOString(), normalCompletion: normalCompletion === true && reaped === true });
      return reaped === true;
    } };
}
