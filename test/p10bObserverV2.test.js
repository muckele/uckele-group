import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

const digest = value => sha256(stableCanonicalJson(value));
const at = Date.parse('2026-10-12T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const window = { issuedAt: iso(at), stopAt: iso(at + 300000) };
const sessionDigest = 'f'.repeat(64);
const sessionDeadline = iso(at + 330000);
const load = () => import('../server/services/p10bObserverPolicy.js');

function virtualClock() {
  let now = at; const queue = [];
  return { clock: () => now, advance(ms) { now += ms; }, wait(ms) { return new Promise(resolve => queue.push({ at: now + ms, resolve })); },
    async run(promise) {
      let done = false; let result; let error;
      promise.then(v => { result = v; done = true; }, e => { error = e; done = true; });
      while (!done) {
        await new Promise(setImmediate);
        queue.sort((a, b) => a.at - b.at); const next = queue.shift();
        if (!next) { assert.equal(done, true, 'virtual scheduling stalled'); break; }
        now = Math.max(now, next.at); next.resolve();
      }
      if (error) throw error; return result;
    } };
}

async function schedule(latency, changes = {}) {
  const { startP10bMetadataSampling } = await load(); const v = virtualClock(); const rows = [];
  let calls = 0, busy = 0, maximumBusy = 0;
  const sampler = startP10bMetadataSampling({ window: changes.window || window, sessionDeadline: changes.sessionDeadline || sessionDeadline,
    clock: v.clock, wait: ms => v.wait(ms + (changes.wakeDelay || 0)),
    async tick() { v.advance(changes.beforeRequestMs || 0); const requestedAt = v.clock(); maximumBusy = Math.max(maximumBusy, ++busy);
      await v.wait(typeof latency === 'function' ? latency(calls++) : latency); busy--;
      const row = { kind: 'metadata', requestedAt: iso(requestedAt), at: iso(v.clock()) }; rows.push(row);
      v.advance(changes.publicationMs || 0); return row; },
    record: row => rows.push(row) });
  const result = await v.run(sampler.done); return { result, rows, maximumBusy };
}

test('serial v2 sampler keeps700ms native budget elsewhere and caps zero-latency load at10 starts/sec', async () => {
  const { P10B_OBSERVER_POLICY: p } = await load();
  assert.equal(p.nativeTimeoutMs, 700); assert.equal(p.bridgeAllowanceMs, 250);
  const f = await schedule(0); const rows = f.rows.filter(r => r.kind === 'metadata');
  assert.equal(f.maximumBusy, 1); assert.equal(f.result.normalCompletion, true);
  assert.equal(rows.length, 3001); assert.ok(rows.length <= p.maximumMetadataReads);
  assert.equal(rows.at(-1).requestedAt, window.stopAt);
  assert.ok(rows.slice(1).every((r, i) => Date.parse(r.requestedAt) - Date.parse(rows[i].requestedAt) >= 100));
});

test('near-timeout949ms reads place a final post-cutoff request within1000ms without overlapping', async () => {
  const f = await schedule(949); const rows = f.rows.filter(r => r.kind === 'metadata');
  assert.equal(f.result.normalCompletion, true); assert.equal(f.maximumBusy, 1);
  const last = Date.parse(rows.at(-1).requestedAt);
  assert.ok(last >= Date.parse(window.stopAt) && last <= Date.parse(window.stopAt) + 1000);
  assert.ok(rows.slice(1).every((r, i) => Date.parse(r.at) - Date.parse(rows[i].at) <= 1000));
});

test('actual reply stamps survive1ms publication and request setup delay without retimestamping', async () => {
  const f = await schedule(100, { publicationMs: 1, beforeRequestMs: 1 });
  assert.equal(f.result.normalCompletion, true);
  const rows = f.rows.filter(r => r.kind === 'metadata');
  assert.equal(rows[0].requestedAt, iso(at + 1)); assert.equal(rows[0].at, iso(at + 101));
  for (const publicationMs of [25, 26, 51]) assert.equal((await schedule(949, { publicationMs })).result.normalCompletion, true);
  assert.equal((await schedule(949, { publicationMs: 52 })).result.normalCompletion, false);
});

function receipts(p, cleanupMs = 1000) {
  const metadata = Array.from({ length: 3001 }, (_, i) => ({ kind: 'metadata', requestedAt: iso(at + i * 100), at: iso(at + i * 100) }));
  const policy = { kind: 'observer-policy', version: p.version, windowDigest: digest(window), sessionDigest, policyDigest: digest(p), sessionDeadline, at: iso(at) };
  const poll = { kind: 'observer-log-poll', requestedAt: iso(at), at: iso(at), success: true };
  const sampling = { kind: 'observer-sampling-finished', version: p.version, windowDigest: digest(window), sessionDigest, policyDigest: digest(p),
    at: window.stopAt, normalCompletion: true, metadataReads: metadata.length, logReads: 1,
    lastRequestedAt: metadata.at(-1).requestedAt, lastResponseAt: metadata.at(-1).at };
  const cleanupStartedAt = Date.parse(sampling.at);
  const finished = { kind: 'observer-finished', version: p.version, windowDigest: digest(window), sessionDigest, samplingDigest: digest(sampling),
    at: iso(cleanupStartedAt + cleanupMs), normalCompletion: true, processesReaped: true, nativeReaped: true,
    cleanupStartedAt: iso(cleanupStartedAt), cleanupDeadline: iso(cleanupStartedAt + 3000) };
  return [policy, ...metadata, poll, sampling, finished];
}

test('v2 separates sampling precision from positive bounded cleanup, including52ms and3000ms', async () => {
  const { P10B_OBSERVER_POLICY: p, verifyP10bObserverCompletion: verify } = await load();
  for (const cleanupMs of [52, 1000, 3000]) assert.equal(verify(receipts(p, cleanupMs), { window, sessionDeadline, sessionDigest }), true);
  assert.equal(verify(receipts(p, 3001), { window, sessionDeadline, sessionDigest }), false);
});

test('v2 closed receipts reject missing/replayed/tampered/order/count/rate/cleanup/expiry evidence', async t => {
  const { P10B_OBSERVER_POLICY: p, verifyP10bObserverCompletion: verify } = await load();
  const changes = {
    missing: r => r.splice(-2, 1), duplicate: r => r.push({ ...r.at(-1) }),
    legacy: r => { delete r.at(-1).version; }, schema: r => { r.at(-1).extra = true; },
    window: r => { r[0].windowDigest = '0'.repeat(64); }, policy: r => { r[0].policyDigest = '0'.repeat(64); },
    session: r => { r[0].sessionDeadline = iso(at + 340000); },
    crossSession: r => { r[0].sessionDigest = 'a'.repeat(64); },
    counts: r => { r.at(-2).metadataReads++; r.at(-1).samplingDigest = digest(r.at(-2)); },
    rate: r => { r[2].requestedAt = iso(at + 99); },
    responseGap: r => { r[10].at = iso(Date.parse(r[9].at) + 1001); },
    nativeDuration: r => { r[10].at = iso(Date.parse(r[10].requestedAt) + 951); },
    postSample: r => r.splice(-1, 0, { kind: 'metadata', requestedAt: window.stopAt, at: window.stopAt }),
    noFinal: r => { r[3001].requestedAt = iso(at + 299999); },
    processUncertain: r => { r.at(-1).processesReaped = false; }, nativeUncertain: r => { r.at(-1).nativeReaped = false; },
    cleanupBackdated: r => { r.at(-1).cleanupStartedAt = iso(at + 299999); },
    timeoutUpgrade: r => { r.at(-1).normalCompletion = false; },
    deadline: r => { r.at(-1).cleanupDeadline = iso(at + 304000); },
    error: r => r.splice(-2, 0, { kind: 'observer-log-read-error', at: window.stopAt }),
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const rows = receipts(p); change(rows); assert.equal(verify(rows, { window, sessionDeadline, sessionDigest }), false);
  });
  assert.equal(verify(receipts(p), { window, sessionDeadline: iso(at + 300999), sessionDigest }), false);
});

test('zero then950ms call remains a1050ms response-gap failure despite bounded scheduling', async () => {
  const f = await schedule(i => i === 0 ? 0 : 950);
  assert.equal(f.result.normalCompletion, false);
  assert.ok(f.rows.some(r => r.kind === 'observer-sampling-error'));
});

test('read cap, late wakes, session reserve and over-budget native reads fail without extra dispatch', async () => {
  const { P10B_OBSERVER_POLICY: p } = await load();
  const cap = await schedule(0, { window: { ...window, stopAt: iso(at + 301100) } });
  assert.equal(cap.result.normalCompletion, false); assert.equal(cap.result.metadataReads, p.maximumMetadataReads);
  assert.equal(cap.rows.filter(r => r.kind === 'metadata').length, p.maximumMetadataReads);
  for (const change of [{ wakeDelay: 1001 }, { sessionDeadline: iso(at + 303999) }]) {
    assert.equal((await schedule(100, change)).result.normalCompletion, false);
  }
  assert.equal((await schedule(951)).result.normalCompletion, false);
});

test('cleanup timeout remains sticky and the shared promise never reaps twice', async () => {
  const { createP10bObserverCleanup } = await load(); let processCalls = 0, nativeCalls = 0, timeout;
  let resolve; const pending = new Promise(r => { resolve = r; });
  const cleanup = createP10bObserverCleanup({ clock: () => at, sessionDeadline, window,
    processes: { reap: () => { processCalls++; return pending; } }, native: { reap: async () => { nativeCalls++; return true; } },
    setTimer(fn, ms) { assert.equal(ms, 3000); timeout = fn; return 1; }, clearTimer() {} });
  const first = cleanup(); assert.equal(cleanup(), first); timeout();
  const result = await first; assert.equal(result.processesReaped, false); assert.equal(result.nativeReaped, false);
  resolve(true); await new Promise(setImmediate); assert.equal(cleanup(), first);
  assert.equal(processCalls, 1); assert.equal(nativeCalls, 1); assert.equal((await cleanup()).normalCompletion, false);
});
