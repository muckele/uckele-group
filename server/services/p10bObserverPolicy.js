import { sha256, stableCanonicalJson } from '../utils/security.js';

const digest = value => sha256(stableCanonicalJson(value));
const iso = value => new Date(value).toISOString();
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;
const closed = (value, keys) => value && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
export const P10B_OBSERVER_POLICY = Object.freeze({ version: 'p10b-observer-v2', nativeTimeoutMs: 700,
  bridgeAllowanceMs: 250, minimumStartIntervalMs: 100, minimumReplyIdleMs: 25,
  maximumMetadataReads: 3011, maximumGapMs: 1000, finalDispatchTailMs: 1000,
  cleanupTimeoutMs: 3000, maximumLogReads: 410 });
const p = P10B_OBSERVER_POLICY;
const failures = new Set(['observer-read-error', 'observer-missed-poll', 'observer-parse-error', 'log-attachment-failed',
  'observer-log-read-error', 'observer-log-missed-poll', 'observer-sampling-error', 'local-reader-exit']);

// One serial reader, with both a start-rate floor and completion-aware idle.
// The limits bound load; actual request AND response gaps still decide proof.
export function startP10bMetadataSampling({ window, sessionDeadline, tick, record, clock, wait }) {
  let aborted = false; let reads = 0; let previous; let normalCompletion = true; let activeStart = null;
  let resolveInitial; const initial = new Promise(resolve => { resolveInitial = resolve; });
  const end = Date.parse(window.stopAt), expiry = Date.parse(sessionDeadline);
  const done = (async () => {
    try {
      while (!aborted) {
        const due = previous ? Math.max(Date.parse(previous.requestedAt) + p.minimumStartIntervalMs,
          Date.parse(previous.at) + p.minimumReplyIdleMs) : clock();
        if (clock() < due) await wait(due - clock());
        if (aborted) break;
        const start = clock();
        if (!Number.isFinite(start) || start < due || start > end + p.finalDispatchTailMs
          || start + p.maximumGapMs + p.cleanupTimeoutMs > expiry || reads >= p.maximumMetadataReads) throw Error();
        reads++;
        activeStart = start;
        const row = await tick(); const resumed = clock(); activeStart = null;
        const requested = Date.parse(row?.requestedAt), response = Date.parse(row?.at);
        // Controls stamp the real request/reply before synchronous publication.
        // Keep those times; publication and promise resumption have their own
        // measured precision budget and must never backdate a later sample.
        if (!row || row.kind !== 'metadata' || !canonicalTime(row.requestedAt) || !canonicalTime(row.at)
          || requested < start || response < requested || resumed < response
          || requested > end + p.finalDispatchTailMs || requested + p.maximumGapMs + p.cleanupTimeoutMs > expiry
          || response - requested > p.nativeTimeoutMs + p.bridgeAllowanceMs || resumed - requested > p.maximumGapMs
          || (previous && (requested - Date.parse(previous.requestedAt) > p.maximumGapMs
            || response - Date.parse(previous.at) > p.maximumGapMs))) throw Error();
        previous = row;
        resolveInitial(row);
        if (requested >= end) break;
      }
      if (aborted || !previous || Date.parse(previous.requestedAt) < end) normalCompletion = false;
    } catch {
      normalCompletion = false; record({ kind: 'observer-sampling-error', at: iso(clock()) });
    } finally { activeStart = null; resolveInitial(null); }
    return { normalCompletion, metadataReads: reads, lastRequestedAt: previous?.requestedAt ?? null, lastResponseAt: previous?.at ?? null };
  })();
  // Install a handler immediately while logs run; awaiting done still propagates publication failures.
  void done.catch(() => {});
  return { initial, done, healthy() {
    const now = clock(), requested = Date.parse(previous?.requestedAt), response = Date.parse(previous?.at);
    // A launched serial read may supply request freshness, never a reply.
    // Intended wake times and delayed event-loop callbacks supply neither.
    const requestFresh = now - requested <= p.maximumGapMs || (activeStart !== null && activeStart >= requested
      && activeStart - requested <= p.maximumGapMs && now >= activeStart && now - activeStart <= p.maximumGapMs);
    return normalCompletion && !aborted && Number.isFinite(now) && now >= requested && now >= response
      && now - response <= p.maximumGapMs && requestFresh;
  }, abort() { aborted = true; } };
}

// Cache the whole attempt, including timeout/uncertainty. A late promise cannot
// upgrade the published result or cause finally to start another cleanup.
export function createP10bObserverCleanup({ processes, native, clock, sessionDeadline, window,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
  let shared;
  return () => {
    if (shared) return shared;
    const started = clock(); const deadline = Math.min(started + p.cleanupTimeoutMs,
      Date.parse(sessionDeadline), Date.parse(window.stopAt) + 30000);
    shared = (async () => {
      let timer;
      const uncertain = { processesReaped: false, nativeReaped: false };
      try {
        const outcome = await Promise.race([
          (async () => {
            let processesReaped = false, nativeReaped = false;
            try { processesReaped = await processes.reap() === true; } catch { /* mandatory native cleanup still follows */ }
            try { nativeReaped = await native.reap() === true; } catch { /* uncertainty is terminal */ }
            return { processesReaped, nativeReaped };
          })(),
          new Promise(resolve => { timer = setTimer(() => resolve(uncertain), Math.max(0, deadline - started)); }),
        ]);
        const finished = clock();
        return { ...outcome, cleanupStartedAt: iso(started), cleanupDeadline: iso(deadline), at: iso(finished),
          normalCompletion: outcome.processesReaped && outcome.nativeReaped && finished >= started && finished <= deadline && deadline > started };
      } finally { clearTimer(timer); }
    })();
    return shared;
  };
}

// This gate validates v2 only. Historical legacy proof is kept by its caller;
// concrete admission must explicitly request this gate and supply its expiry.
export function verifyP10bObserverCompletion(records, { window, sessionDeadline, sessionDigest } = {}) {
  try {
    const headerRows = records.filter(r => r.kind === 'observer-policy');
    const sampleRows = records.filter(r => r.kind === 'observer-sampling-finished');
    const finishRows = records.filter(r => r.kind === 'observer-finished');
    const metadata = records.filter(r => r.kind === 'metadata');
    const logs = records.filter(r => r.kind === 'observer-log-poll');
    if (headerRows.length !== 1 || sampleRows.length !== 1 || finishRows.length !== 1) return false;
    const h = headerRows[0], s = sampleRows[0], f = finishRows[0], last = metadata.at(-1);
    const stop = Date.parse(window.stopAt), expiry = Date.parse(sessionDeadline), sample = Date.parse(s.at), finish = Date.parse(f.at);
    if (!closed(h, 'kind,version,windowDigest,sessionDigest,policyDigest,sessionDeadline,at')
      || !closed(s, 'kind,version,windowDigest,sessionDigest,policyDigest,at,normalCompletion,metadataReads,logReads,lastRequestedAt,lastResponseAt')
      || !closed(f, 'kind,version,windowDigest,sessionDigest,samplingDigest,at,normalCompletion,processesReaped,nativeReaped,cleanupStartedAt,cleanupDeadline')
      || ![h, s, f].every(r => r.version === p.version && r.windowDigest === digest(window) && r.sessionDigest === sessionDigest && canonicalTime(r.at))
      || !/^[a-f0-9]{64}$/.test(sessionDigest) || h.policyDigest !== digest(p) || s.policyDigest !== digest(p) || h.sessionDeadline !== sessionDeadline || !canonicalTime(sessionDeadline)
      || records[0] !== h || records.at(-2) !== s || records.at(-1) !== f
      || Date.parse(h.at) < Date.parse(window.issuedAt) || Date.parse(h.at) > Date.parse(metadata[0]?.requestedAt)
      || s.normalCompletion !== true || f.normalCompletion !== true || f.processesReaped !== true || f.nativeReaped !== true
      || f.samplingDigest !== digest(s) || s.metadataReads !== metadata.length || s.logReads !== logs.length
      || metadata.length < 2 || metadata.length > p.maximumMetadataReads || !logs.length || logs.length > p.maximumLogReads
      || s.lastRequestedAt !== last?.requestedAt || s.lastResponseAt !== last?.at
      || !canonicalTime(f.cleanupStartedAt) || !canonicalTime(f.cleanupDeadline)
      || Date.parse(f.cleanupStartedAt) < sample || finish < Date.parse(f.cleanupStartedAt)
      || Date.parse(f.cleanupDeadline) !== Math.min(Date.parse(f.cleanupStartedAt) + p.cleanupTimeoutMs, expiry, stop + 30000)
      || finish > Date.parse(f.cleanupDeadline) || finish > expiry || finish > stop + 30000
      || Date.parse(last.requestedAt) < stop || Date.parse(last.requestedAt) > stop + p.finalDispatchTailMs
      || metadata.slice(0, -1).some(r => Date.parse(r.requestedAt) >= stop)
      || sample < Date.parse(last.at) || sample - Date.parse(last.requestedAt) > p.maximumGapMs
      || records.some(r => failures.has(r.kind))) return false;
    if (metadata.some((r, i) => !canonicalTime(r.requestedAt) || !canonicalTime(r.at)
      || Date.parse(r.requestedAt) < Date.parse(h.at) || Date.parse(r.at) < Date.parse(r.requestedAt)
      || Date.parse(r.requestedAt) + p.maximumGapMs + p.cleanupTimeoutMs > expiry
      || Date.parse(r.at) > sample || Date.parse(r.at) - Date.parse(r.requestedAt) > p.nativeTimeoutMs + p.bridgeAllowanceMs
      || (i && (Date.parse(r.requestedAt) - Date.parse(metadata[i - 1].requestedAt) < p.minimumStartIntervalMs
        || Date.parse(r.requestedAt) - Date.parse(metadata[i - 1].requestedAt) > p.maximumGapMs
        || Date.parse(r.requestedAt) - Date.parse(metadata[i - 1].at) < p.minimumReplyIdleMs
        || Date.parse(r.at) - Date.parse(metadata[i - 1].at) > p.maximumGapMs)))) return false;
    return logs.every(r => closed(r, 'kind,requestedAt,at,success') && r.success === true
      && canonicalTime(r.requestedAt) && canonicalTime(r.at) && Date.parse(r.requestedAt) >= Date.parse(h.at)
      && Date.parse(r.at) >= Date.parse(r.requestedAt) && Date.parse(r.at) <= sample);
  } catch { return false; }
}
