import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stoppedLogProbeFixture } from './helpers/p10bStoppedLogProbeFixture.js';
import { openP10bNativeStoppedLogProbeClient } from '../server/services/p10bNativeStoppedLogProbeClient.js';
import { createP10bStoppedLogProbeTokenContext } from '../server/services/p10bHostAuthentication.js';
const ready = { type: 'ready', version: 'p10b-stopped-log-probe-v1' };
function fixture(t, respond, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-probe-ipc-'))); const f = stoppedLogProbeFixture(directory);
  const context = createP10bStoppedLogProbeTokenContext({ ...f, environment: { FLY_API_TOKEN: 'synthetic-probe-private-canary' } });
  const child = new EventEmitter(); child.pid = 9001; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let closed = false; let writes = 0; let kills = 0;
  child.kill = () => { kills++; if (!closed && !options.hang) { closed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); } };
  child.stdin.on('data', data => { writes++; const frame = JSON.parse(data); queueMicrotask(() => respond(frame, child, f)); });
  t.after(() => { if (!options.hang && !options.hold) context.cleanup({ reaped: true }); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...f, context, child, writes: () => writes, kills: () => kills,
    open: extra => openP10bNativeStoppedLogProbeClient({ ...f, executable: process.execPath, environment: context.environment, spawnProcess: () => child, ...extra }) };
}
function response(input, f) {
  return { type: 'success', id: input.id, observation: input.operation.startsWith('BASELINE')
    ? { kind: 'baseline', state: 'stopped', instanceId: f.probe.baselineInstanceId, configDigest: f.probe.baselineConfigDigest, imageDigest: f.probe.baselineImageDigest, httpStatus: 200, elapsedMs: 0, dispatched: true }
    : { kind: 'log', providerBatchEmpty: false, httpStatus: 200, elapsedMs: 0, dispatched: true } };
}
const send = (child, value) => child.stdout.write(`${JSON.stringify(value)}\n`);
test('probe IPC executes only four fixed steps, discards no private fields and reaps once', async t => {
  const f = fixture(t, (input, child, data) => send(child, input.probe ? ready : response(input, data)));
  assert.equal(f.context.environment.HOME, f.context.environment.FLY_CONFIG_DIR); assert.equal(JSON.stringify(f.context), '{}');
  const native = await f.open();
  for (const step of ['BASELINE_BEFORE', 'LOG_FIRST', 'LOG_STEADY', 'BASELINE_AFTER']) await native.step(step);
  await assert.rejects(native.step('LOG_FIRST')); assert.equal(f.writes(), 5);
  assert.equal(await native.reap(), true); assert.equal(await native.reap(), true);
});
for (const mode of ['duplicate', 'extra', 'private-row', 'wrong-baseline', 'wrong-id', 'unsolicited', 'partial-extra', 'error', 'token']) {
  test(`probe IPC poisons unsafe response: ${mode}`, async t => {
    const f = fixture(t, (input, child, data) => {
      if (input.probe) { send(child, ready); return; }
      const value = response(input, data);
      if (mode === 'extra') value.extra = true;
      if (mode === 'private-row') value.observation.logs = ['private-canary'];
      if (mode === 'wrong-baseline') value.observation.instanceId = 'other';
      if (mode === 'wrong-id') value.id++;
      if (mode === 'token') value.extra = 'synthetic-probe-private-canary';
      if (mode === 'error') { send(child, { type: 'error', id: input.id, code: 'http-failed' }); return; }
      let text = JSON.stringify(value); if (mode === 'duplicate') text = text.replace('{', '{"id":1,');
      child.stdout.write(text + (mode === 'unsolicited' ? '\n{}\n' : mode === 'partial-extra' ? '\n{' : '\n'));
    });
    const native = await f.open(); await assert.rejects(native.step('BASELINE_BEFORE'));
    const count = f.writes(); await assert.rejects(native.step('LOG_FIRST')); assert.equal(f.writes(), count); assert.equal(await native.reap(), true);
  });
}
test('delayed timer cannot admit exact per-step deadline and no next read dispatches', async t => {
  let mono = 0; const f = fixture(t, (input, child, data) => { if (input.probe) send(child, ready); else { mono += 1000; send(child, response(input, data)); } });
  const native = await f.open({ monotonicClock: () => mono }); await assert.rejects(native.step('BASELINE_BEFORE'));
  await assert.rejects(native.step('LOG_FIRST')); assert.equal(f.writes(), 2); assert.equal(await native.reap(), true);
});
test('cancellation before spawn and during initialization remains owned and closed', async t => {
  const controller = new AbortController(); const f = fixture(t, () => controller.abort());
  controller.abort(); await assert.rejects(f.open({ signal: controller.signal })); assert.equal(f.writes(), 0);
  const next = new AbortController(); const g = fixture(t, () => next.abort());
  await assert.rejects(g.open({ signal: next.signal }), error => error.reapVerified === true); assert.equal(g.writes(), 1);
});

test('overdue owned reap remains cached false even if close beats delayed timeout callback', async t => {
  let mono = 0; const f = fixture(t, (input, child, data) => send(child, input.probe ? ready : response(input, data)), { hold: true });
  const native = await f.open({ monotonicClock: () => mono }); const kill = f.child.kill;
  f.child.kill = () => { mono += 1000; kill(); };
  assert.equal(await native.reap(), false); assert.equal(await native.reap(), false);
  assert.equal(fs.readdirSync(f.context.environment.FLY_CONFIG_DIR).some(name => name.startsWith('.p10b-reap-')), true);
});
