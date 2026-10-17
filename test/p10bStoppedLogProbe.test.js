import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stoppedLogProbeFixture, approveStoppedLogProbe } from './helpers/p10bStoppedLogProbeFixture.js';
import { assertP10bStoppedLogProbeApproval, createP10bStoppedLogProbeBudget } from '../server/services/p10bStoppedLogProbeContract.js';
import { runP10bStoppedLogProbe } from '../server/services/p10bStoppedLogProbe.js';
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-probe-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return stoppedLogProbeFixture(directory);
}
test('separate stopped probe authority admits exact zero mutation profile', t => {
  const f = fixture(t); assert.equal(assertP10bStoppedLogProbeApproval(f.probe, f.approval, Date.parse(f.probe.issuedAt)), true);
});
for (const change of ['version', 'maximumStarts', 'maximumStoppedConfigUpdates', 'maximumLogReads', 'app', 'volumeId', 'expiresAt', 'extra', 'baseline']) {
  test(`reject altered or cross-mode stopped probe authority: ${change}`, t => {
    const f = fixture(t); const p = structuredClone(f.probe);
    if (change === 'extra') p.extra = true;
    else if (change === 'baseline') p.baselineConfig.env.P10B_QUALIFICATION_RUNTIME = 'true';
    else if (change === 'expiresAt') p.expiresAt = new Date(Date.parse(p.expiresAt) + 1).toISOString();
    else p[change] = typeof p[change] === 'number' ? p[change] + 1 : 'wrong';
    assert.throws(() => assertP10bStoppedLogProbeApproval(p, approveStoppedLogProbe(p), Date.parse(f.probe.issuedAt)));
  });
}
test('original wall and monotonic budget cannot reset or accept cutoff equality', t => {
  const f = fixture(t); let now = Date.parse(f.probe.issuedAt); let mono = 0;
  const budget = createP10bStoppedLogProbeBudget(f.probe, { clock: () => now, monotonicClock: () => mono });
  assert.equal(budget.active(), true); mono = 27000; now -= 10000; assert.equal(budget.active(), false);
  assert.equal(budget.active(true), false); now = Date.parse(f.probe.issuedAt); assert.equal(budget.active(true), true); mono = 30000; assert.equal(budget.active(true), false);
});
function dependencies(f, overrides = {}) {
  let auths = 0; let spawns = 0; const calls = []; let reaps = 0; let closures = 0;
  return { counts: () => ({ auths, spawns, calls, reaps, closures }),
    options: { ...f, executable: process.execPath, checkSource: head => assert.equal(head, f.probe.hostSourceHead),
      createContext() { auths++; return { environment: {}, cleanup({ reaped }) { assert.equal(reaped, true); closures++; return true; } }; },
      async openClient() { spawns++; return { async step(operation) { calls.push(operation); return operation.startsWith('BASELINE')
        ? { kind: 'baseline', state: 'stopped', instanceId: f.probe.baselineInstanceId, configDigest: f.probe.baselineConfigDigest,
          imageDigest: f.probe.baselineImageDigest, httpStatus: 200, elapsedMs: 0, dispatched: true }
        : { kind: 'log', providerBatchEmpty: operation === 'LOG_FIRST', httpStatus: 200, elapsedMs: 0, dispatched: true }; },
        async reap() { reaps++; return true; } }; }, ...overrides } };
}
test('complete stopped probe consumes nonce before auth and publishes after positive reap and closure', async t => {
  const f = fixture(t); const d = dependencies(f); const result = await runP10bStoppedLogProbe(d.options);
  assert.equal(result.success, true); assert.equal(result.firstProviderBatchEmpty, true); assert.equal(result.steadyProviderBatchEmpty, false);
  assert.deepEqual(d.counts(), { auths: 1, spawns: 1, calls: ['BASELINE_BEFORE', 'LOG_FIRST', 'LOG_STEADY', 'BASELINE_AFTER'], reaps: 1, closures: 1 });
  const files = fs.readdirSync(f.probe.evidenceDirectory); assert.equal(files.length, 2);
  await assert.rejects(runP10bStoppedLogProbe(d.options)); assert.equal(d.counts().auths, 1);
  const changed = structuredClone(f.probe); changed.baselineInstanceId = 'other-instance';
  await assert.rejects(runP10bStoppedLogProbe({ ...d.options, probe: changed, approval: approveStoppedLogProbe(changed) }));
  assert.equal(d.counts().auths, 1); assert.deepEqual(fs.readdirSync(f.probe.evidenceDirectory), files);
});
for (const failAt of [0, 1, 2, 3]) test(`failure at phase ${failAt} stops all later reads and retains intent`, async t => {
  const f = fixture(t); let n = 0; const d = dependencies(f, { async openClient() { return { async step() { if (n++ === failAt) throw Error('private-canary'); return n === 1
    ? { kind: 'baseline', state: 'stopped', instanceId: f.probe.baselineInstanceId, configDigest: f.probe.baselineConfigDigest, imageDigest: f.probe.baselineImageDigest, httpStatus: 200, elapsedMs: 0, dispatched: true }
    : { kind: 'log', providerBatchEmpty: true, httpStatus: 200, elapsedMs: 0, dispatched: true }; }, async reap() { return true; } }; } });
  const result = await runP10bStoppedLogProbe(d.options); assert.equal(result.success, false); assert.equal(n, failAt + 1);
  assert.equal(JSON.stringify(result).includes('private-canary'), false); await assert.rejects(runP10bStoppedLogProbe(d.options));
});
test('uncertain reap holds private context and cannot upgrade terminal success', async t => {
  const f = fixture(t); const d = dependencies(f, { async openClient() { return { async step() { throw Error(); }, async reap() { return false; } }; } });
  const result = await runP10bStoppedLogProbe(d.options); assert.equal(result.success, false); assert.equal(result.reapVerified, false);
  assert.equal(d.counts().closures, 0); await assert.rejects(runP10bStoppedLogProbe(d.options));
});

test('terminal fsync crossing original expiry never leaves durable positive receipt', async t => {
  const f = fixture(t); let now = Date.parse(f.probe.issuedAt); const d = dependencies(f, { clock: () => now });
  const original = fs.fsyncSync; let syncs = 0;
  fs.fsyncSync = fd => { original(fd); if (++syncs === 4) now += 30000; };
  try { const result = await runP10bStoppedLogProbe(d.options); assert.equal(result.success, false); assert.equal(result.publicationVerified, false); }
  finally { fs.fsyncSync = original; }
  const terminal = fs.readdirSync(f.probe.evidenceDirectory).find(name => name.endsWith('-terminal.json'));
  const retained = JSON.parse(fs.readFileSync(path.join(f.probe.evidenceDirectory, terminal)));
  assert.equal(retained.success, false); assert.equal(retained.publicationVerified, false);
});
test('intent fsync failure consumes nonce and never allocates authentication', async t => {
  const f = fixture(t); const d = dependencies(f); const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('private-fsync-canary'); };
  try { await assert.rejects(runP10bStoppedLogProbe(d.options)); } finally { fs.fsyncSync = original; }
  assert.equal(d.counts().auths, 0); await assert.rejects(runP10bStoppedLogProbe(d.options)); assert.equal(d.counts().spawns, 0);
});
test('symlink, broad mode and alternate bound directory fail before authentication', async t => {
  const f = fixture(t); const d = dependencies(f); fs.chmodSync(f.probe.evidenceDirectory, 0o755);
  await assert.rejects(runP10bStoppedLogProbe(d.options)); assert.equal(d.counts().auths, 0);
  fs.chmodSync(f.probe.evidenceDirectory, 0o700);
  const p = { ...f.probe, evidenceDirectory: f.probe.evidenceDirectory + '-alias' }; fs.symlinkSync(f.probe.evidenceDirectory, p.evidenceDirectory);
  t.after(() => fs.unlinkSync(p.evidenceDirectory));
  await assert.rejects(runP10bStoppedLogProbe({ ...d.options, probe: p, approval: approveStoppedLogProbe(p) })); assert.equal(d.counts().auths, 0);
});

test('overdue initialization owns and reaps child before delayed timeout callback', async t => {
  const f = fixture(t); let now = Date.parse(f.probe.issuedAt); let mono = 0; let reaps = 0; let steps = 0;
  const d = dependencies(f, { clock: () => now, monotonicClock: () => mono, async openClient() {
    now += 10001; mono += 10001; return { async step() { steps++; throw Error(); }, async reap() { reaps++; return true; } };
  } });
  const result = await runP10bStoppedLogProbe(d.options); assert.equal(result.success, false); assert.equal(reaps, 1); assert.equal(steps, 0);
  assert.equal(result.reapVerified, true); assert.equal(result.privateContextClosed, true);
});

for (const mode of ['intent-deadline', 'intent-abort']) test(`intent publication must not admit auth after ${mode}`, async t => {
  const f = fixture(t); let now = Date.parse(f.probe.issuedAt); const controller = new AbortController();
  const d = dependencies(f, { clock: () => now, signal: controller.signal }); const original = fs.fsyncSync; let count = 0;
  fs.fsyncSync = fd => { original(fd); if (++count === 2) { if (mode === 'intent-abort') controller.abort(); else now += 27000; } };
  try { const result = await runP10bStoppedLogProbe(d.options); assert.equal(result.success, false); }
  finally { fs.fsyncSync = original; }
  assert.equal(d.counts().auths, 0); assert.equal(d.counts().spawns, 0);
});
test('synchronous first baseline crossing1s fails before later reads despite aggregate time remaining', async t => {
  const f = fixture(t); let now = Date.parse(f.probe.issuedAt); let mono = 0; let steps = 0;
  const d = dependencies(f, { clock: () => now, monotonicClock: () => mono, async openClient() { return {
    step() { steps++; now += 1000; mono += 1000; return { kind: 'baseline', state: 'stopped', instanceId: f.probe.baselineInstanceId,
      configDigest: f.probe.baselineConfigDigest, imageDigest: f.probe.baselineImageDigest, httpStatus: 200, elapsedMs: 0, dispatched: true }; }, async reap() { return true; } }; } });
  const result = await runP10bStoppedLogProbe(d.options); assert.equal(result.success, false); assert.equal(steps, 1); assert.equal(result.reapVerified, true);
});

for (const stage of ['intent', 'terminal']) test(`directory inode drift at ${stage} preserves original evidence and holds success`, async t => {
  const f = fixture(t); const root = f.probe.evidenceDirectory; const retained = root + '-retained'; let drifted = false;
  const drift = () => { if (!drifted) { fs.renameSync(root, retained); fs.mkdirSync(root, { mode: 0o700 }); drifted = true; } };
  t.after(() => { if (drifted) fs.rmSync(retained, { recursive: true, force: true }); });
  const d = dependencies(f, stage === 'terminal' ? { createContext() { return { environment: {}, cleanup() { drift(); return true; } }; } } : {});
  const original = fs.fsyncSync; let count = 0;
  if (stage === 'intent') fs.fsyncSync = fd => { original(fd); if (++count === 2) drift(); };
  try { if (stage === 'intent') await assert.rejects(runP10bStoppedLogProbe(d.options)); else assert.equal((await runP10bStoppedLogProbe(d.options)).success, false); }
  finally { fs.fsyncSync = original; }
  assert.equal(fs.readdirSync(retained).some(name => name.endsWith('-intent.json')), true);
  assert.equal(fs.readdirSync(root).length, 0); if (stage === 'intent') assert.equal(d.counts().auths, 0);
});
