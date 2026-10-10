import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
const digest = value => sha256(stableCanonicalJson(value));
const at = Date.parse('2026-10-10T12:00:00.000Z');
const window = { version: 'p10b-guest-window-v1', app: 'uckele-group-p10b', machineId: '0803730bd1d7e8',
  sourceHead: '1'.repeat(40), imageDigest: `sha256:${'a'.repeat(64)}`, phase: 'prepare',
  databasePath: '/data/p10b-first-mailbox-observer-offline.sqlite', runBinding: 'c'.repeat(64),
  issuedAt: new Date(at).toISOString(), stopAt: new Date(at + 300000).toISOString(),
  closureGraceMs: 30000, stopReserveMs: 30000 };
const readiness = { sourceHead: window.sourceHead, guardianAlive: true, parentAlive: true,
  guardianParentStart: { version: 'p10b-guardian-parent-start-v1', windowDigest: digest(window), pid: 648,
    startedAt: new Date(at + 4000).toISOString() },
  guardianStart: { windowDigest: digest(window), pid: 649, startedAt: new Date(at + 5000).toISOString() },
  guardianReady: { windowDigest: digest(window), pid: 649 } };
function fixture() {
  const exitedAt = new Date(at + 240000).toISOString();
  const record = { version: 'p10b-guardian-child-exit-v1', windowDigest: digest(window), parentPid: 648,
    guardianPid: 649, parentStartedAt: readiness.guardianParentStart.startedAt, code: 0, signal: null,
    spawnFailed: false, exitedAt, bindingVerified: true, startDigest: digest(readiness.guardianStart),
    readyDigest: digest(readiness.guardianReady), receiptDigest: 'b'.repeat(64), productionReady: false };
  const records = Array.from({ length: 409 }, (_, i) => {
    const requested = at + i * 750, response = requested + 100;
    return { kind: 'metadata', requestedAt: new Date(requested).toISOString(), at: new Date(response).toISOString(),
      state: response < at + 241000 ? 'started' : 'stopped', imageDigest: window.imageDigest, instanceId: 'candidate-v1',
      events: response < at + 241000 ? [] : [{ type: 'exit', status: 'stopped', request: { exit_event: {
        requested_stop: false, restarting: false, guest_exit_code: 0, guest_signal: -1, guest_error: '',
        exit_code: 0, signal: -1, error: '', oom_killed: false, exited_at: new Date(at + 240900).toISOString() } } }] };
  });
  records.push({ kind: 'platform-log', timestamp: new Date(at + 240010).toISOString(),
    machineId: window.machineId, region: 'ewr', message: 'P10B_GUARDIAN_CHILD_EXIT ' + JSON.stringify(record) },
  { kind: 'observer-finished', at: new Date(at + 306750).toISOString(), normalCompletion: true });
  return { records, record };
}
const load = async () => {
  const service = await import('../server/services/p10bRuntimeObservation.js').catch(() => null);
  assert.equal(typeof service?.proveP10bGuardianStop, 'function', 'Reaped exact-PID stop proof is absent');
  return service;
};
test('bound reaped exact-PID exit plus continuous exact-instance stopped trace proves shutdown', async () => {
  const { proveP10bGuardianStop } = await load(); const { records } = fixture();
  const proof = proveP10bGuardianStop(records, { window, readiness, killedAt: at + 10000, expectedInstanceId: 'candidate-v1' });
  assert.equal(proof.success, true); assert.equal(proof.guardianPid, 649);
  assert.equal(proof.exitSource, 'guardian-parent-os-exit'); assert.ok(proof.stopLatencyMs <= 30000);
});

const prove = (records, ready = readiness, options = {}) => load().then(({ proveP10bGuardianStop }) =>
  proveP10bGuardianStop(records, { window, readiness: ready, killedAt: at + 10000,
    expectedInstanceId: 'candidate-v1', ...options }));
const replaceExit = (f, change) => {
  change(f.record);
  f.records.find(row => row.kind === 'platform-log').message = 'P10B_GUARDIAN_CHILD_EXIT ' + JSON.stringify(f.record);
};

test('actual platform init code0 with no exiting PID cannot substitute for OS-reaped provenance', async () => {
  const f = fixture();
  f.records.find(row => row.kind === 'platform-log').message = 'Main child exited normally with code: 0';
  const proof = await prove(f.records);
  assert.equal(proof.success, false); assert.equal(proof.exitRecordCount, 0); assert.equal(proof.exitedAt, null);
});

test('duplicate, conflicting, malformed or absent exit records fail closed', async t => {
  for (const variant of ['duplicate', 'conflict', 'malformed', 'absent']) await t.test(variant, async () => {
    const f = fixture(); const row = f.records.find(row => row.kind === 'platform-log');
    if (variant === 'duplicate') f.records.push({ ...row });
    if (variant === 'conflict') f.records.push({ ...row, message: row.message.replace('"code":0', '"code":7') });
    if (variant === 'malformed') row.message = 'P10B_GUARDIAN_CHILD_EXIT {broken';
    if (variant === 'absent') f.records.splice(f.records.indexOf(row), 1);
    assert.equal((await prove(f.records)).success, false);
  });
});

test('unbound, stale, wrong-PID, nonzero, signalled or forged-schema exit is rejected', async t => {
  const cases = { wrongPid: r => { r.guardianPid++; }, wrongParent: r => { r.parentPid++; },
    nonzero: r => { r.code = 7; }, signal: r => { r.code = null; r.signal = 'SIGTERM'; },
    spawn: r => { r.spawnFailed = true; }, unbound: r => { r.bindingVerified = false; },
    window: r => { r.windowDigest = '0'.repeat(64); }, start: r => { r.startDigest = '0'.repeat(64); },
    ready: r => { r.readyDigest = '0'.repeat(64); }, receipt: r => { r.receiptDigest = null; },
    stale: r => { r.exitedAt = new Date(at - 1).toISOString(); },
    reserve: r => { r.exitedAt = new Date(at + 270001).toISOString(); },
    malformedDate: r => { r.exitedAt = 'not-a-time'; }, schema: r => { r.extra = true; },
    production: r => { r.productionReady = true; } };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); replaceExit(f, change); assert.equal((await prove(f.records)).success, false);
  });
});

test('dead parent, source drift or missing instance cannot pass admission provenance', async t => {
  for (const variant of ['deadParent', 'deadGuardian', 'source', 'instance']) await t.test(variant, async () => {
    const f = fixture(); const ready = structuredClone(readiness);
    if (variant === 'deadParent') ready.parentAlive = false;
    if (variant === 'deadGuardian') ready.guardianAlive = false;
    if (variant === 'source') ready.sourceHead = '2'.repeat(40);
    assert.equal((await prove(f.records, ready, variant === 'instance' ? { expectedInstanceId: undefined } : {})).success, false);
  });
});

test('requested stop, OOM, nonzero platform exit, restart and observer uncertainty remain disqualifying', async t => {
  const cases = { requested: e => { e.requested_stop = true; }, oom: e => { e.oom_killed = true; },
    nonzero: e => { e.guest_exit_code = 1; }, signal: e => { e.signal = 15; },
    restarting: e => { e.restarting = true; }, error: e => { e.guest_error = 'failure'; } };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); for (const row of f.records) if (row.events?.length) change(row.events[0].request.exit_event);
    assert.equal((await prove(f.records)).success, false);
  });
  for (const kind of ['observer-read-error', 'observer-missed-poll', 'observer-parse-error', 'log-attachment-failed']) {
    const f = fixture(); f.records.push({ kind }); assert.equal((await prove(f.records)).success, false);
  }
  const restarted = fixture(); restarted.records.filter(row => row.kind === 'metadata').at(-1).state = 'started';
  assert.equal((await prove(restarted.records)).unexpectedRestart, true);
});

test('the1000ms request and response boundaries stay inclusive and1001ms fails', async t => {
  for (const kind of ['request', 'response']) for (const gap of [1000, 1001]) await t.test(`${kind}-${gap}`, async () => {
    const f = fixture(); const rows = f.records.filter(row => row.kind === 'metadata');
    if (kind === 'request') {
      // Keep responses fixed and sufficiently late to isolate the request gap.
      for (const row of rows) row.at = new Date(Date.parse(row.at) + 300).toISOString();
      rows[10].requestedAt = new Date(Date.parse(rows[10].requestedAt) + gap - 750).toISOString();
    } else rows[10].at = new Date(Date.parse(rows[10].at) + gap - 750).toISOString();
    const proof = await prove(f.records); assert.equal(proof.success, gap === 1000);
    assert.equal(kind === 'request' ? proof.maximumMetadataPollGapMs : proof.maximumMetadataResponseGapMs, gap);
  });
});

test('stopping after the30second convergence budget or fixed cutoff never qualifies', async t => {
  for (const stoppedAfter of [270000, 300000]) await t.test(String(stoppedAfter), async () => {
    const f = fixture(); for (const row of f.records) if (row.kind === 'metadata') {
      row.state = Date.parse(row.at) < at + stoppedAfter ? 'started' : 'stopped';
      if (row.state === 'stopped' && !row.events.length) throw Error('Fixture stop lacks platform event');
    }
    assert.equal((await prove(f.records)).success, false);
  });
});

test('pretty objects survive bytewise UTF8 transport, nested structures and escaped strings', async () => {
  const { createJsonObjectFramer } = await load();
  const expected = [{ instance: window.machineId, message: 'Main child exited normally with code: 0',
    nested: [{ message: '雪😀 {escaped} "quote" \\' }] }, { message: 'second' }];
  const bytes = Buffer.from(expected.map(value => JSON.stringify(value, null, 2)).join('\n\n'));
  const observed = []; const framer = createJsonObjectFramer(value => observed.push(value));
  for (const byte of bytes) framer.write(Buffer.from([byte]));
  framer.finish(); assert.deepEqual(observed, expected);
  assert.equal(bytes.toString().split('\n').filter(line => { try { JSON.parse(line); return true; } catch { return false; } }).length, 0);
});

test('invalid, oversized, truncated transport fails once without releasing partial objects', async () => {
  const { createJsonObjectFramer } = await load();
  for (const text of ['not-json', '[]', '{"a":nope}', '{"long":"12345678901234567890"}']) {
    const observed = []; const framer = createJsonObjectFramer(value => observed.push(value), { maximumBytes: 20 });
    assert.throws(() => framer.write(text)); assert.deepEqual(observed, []);
    assert.throws(() => framer.write('{}'), /already failed/);
  }
  const framer = createJsonObjectFramer(() => assert.fail('No partial object callback'));
  framer.write('{"message":"unfinished'); assert.throws(() => framer.finish(), /Incomplete/);
});

test('cadence reproduces the old1001ms first-request gap and removes its systematic initial-read delay', async () => {
  const { startObserverCadence } = await load();
  const firstRequest = Date.parse('2026-10-10T04:02:02.678Z');
  const firstResponse = Date.parse('2026-10-10T04:02:02.926Z');
  const secondRequest = Date.parse('2026-10-10T04:02:03.679Z');
  assert.equal(firstResponse - firstRequest, 248); assert.equal(secondRequest - firstRequest, 1001);
  assert.equal(secondRequest - firstRequest, 248 + 750 + 3);
  let now = 0, callback, resolveInitial; const requests = [];
  const first = new Promise(resolve => { resolveInitial = resolve; });
  const tick = () => { requests.push(now); return requests.length === 1 ? first : Promise.resolve(); };
  const { timer, initial } = startObserverCadence(tick, { setInterval(fn, ms) {
    assert.equal(now, 0); assert.equal(requests.length, 0); assert.equal(ms, 750); callback = fn; return 'timer'; } });
  assert.equal(timer, 'timer'); now = 248; resolveInitial(); await initial; now = 750; await callback();
  assert.deepEqual(requests, [0, 750]);
});
