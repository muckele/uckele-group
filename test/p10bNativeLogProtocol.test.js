import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openP10bNativeLogClient } from '../server/services/p10bNativeMachineClient.js';
import { publicP10bNativeLogFailure } from '../server/services/p10bNativeFailure.js';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';
import { logFixture } from './helpers/p10bLogFixture.js';

function fixture(t, respond, options = {}) {
  const f = logFixture();
  const context = createP10bAppTokenContext({ ...f, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-log-protocol-canary' } });
  const child = new EventEmitter(); child.pid = 8001; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let kills = 0; let writes = 0; let closed = false; let reaped = false;
  child.kill = () => { kills++; if (!closed && !options.hangReap) { closed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); } };
  child.stdin.on('data', bytes => {
    const input = JSON.parse(bytes); writes++;
    queueMicrotask(() => respond(input, child, f));
  });
  t.after(() => { if (closed || writes === 0) reaped = true; context.cleanup({ reaped }); });
  return { ...f, child, context, kills: () => kills, writes: () => writes,
    async open(extra = {}) { return openP10bNativeLogClient({ ...f, executable: process.execPath, configs: [f.phase.config],
      environment: context.environment, spawnProcess: () => child, ...extra }); },
    async cleanup(native) { reaped = await native.reap(); return reaped; } };
}
const ready = child => child.stdout.write('{"version":"p10b-native-log-ready-v1","ready":true}\n');
const response = (id, logs = []) => ({ version: 'p10b-native-log-response-v1', id, ok: true, logs,
  observation: { httpStatus: 200, elapsedMs: 0, dispatched: true } });

test('log-only IPC admits explicit empty and preserves original nanosecond timestamp with split frames', async t => {
  const f = fixture(t, (input, child, data) => {
    if (input.version) { assert.deepEqual(Object.keys(input).sort(), ['approved', 'configs', 'readOnly', 'sessionCanonical', 'sessionDigest', 'version']); ready(child); }
    else { assert.deepEqual(Object.keys(input).sort(), ['id', 'method', 'timeoutMs']); const text = JSON.stringify(response(input.id, input.id === 1 ? [] : [data.row])) + '\n'; child.stdout.write(text.slice(0, 17)); child.stdout.write(text.slice(17)); }
  });
  const native = await f.open();
  assert.deepEqual(await native.client('GET', undefined, 5000), []);
  assert.deepEqual(await native.client('GET', undefined, 700), [f.row]);
  assert.equal(await f.cleanup(native), true);
  assert.equal(await native.reap(), true); assert.equal(f.kills(), 1);
});
for (const mode of ['extra', 'duplicate', 'replayed-id', 'missing-logs', 'null-logs', 'wrong-instance', 'app-text', 'event-duplicate', 'raw-token', 'partial', 'oversize', 'extra-ready', 'unsolicited', 'partial-extra']) {
  test(`log-only IPC rejects unsafe frames and does not reopen: ${mode}`, async t => {
    const f = fixture(t, (input, child, data) => {
      if (input.version) { if (mode === 'extra-ready') child.stdout.write('{"version":"p10b-native-log-ready-v1","ready":true,"extra":1}\n'); else ready(child); return; }
      const frame = response(input.id, [data.row]);
      if (mode === 'extra') frame.raw = 'synthetic-private-body';
      if (mode === 'replayed-id') frame.id--;
      if (mode === 'missing-logs') delete frame.logs;
      if (mode === 'null-logs') frame.logs = null;
      if (mode === 'wrong-instance') frame.logs[0].instance = 'different';
      if (mode === 'app-text') frame.logs[0].message = 'private-application-text';
      if (mode === 'event-duplicate') frame.logs[0].message = frame.logs[0].message.replace('{', '{"code":0,');
      if (mode === 'raw-token') frame.raw = 'synthetic-log-protocol-canary';
      let text = JSON.stringify(frame);
      if (mode === 'duplicate') text = text.replace('{', '{"ok":false,');
      if (mode === 'oversize') text = 'x'.repeat(131073);
      child.stdout.write(text + (mode === 'partial' ? '' : mode === 'unsolicited' ? '\n{}\n' : mode === 'partial-extra' ? '\n{' : '\n'));
      if (mode === 'partial') queueMicrotask(() => child.emit('close', 0, null));
    });
    if (mode === 'extra-ready') { await assert.rejects(f.open(), error => error.reapVerified === true); return; }
    const native = await f.open();
    await assert.rejects(native.client(), error => {
      const facts = publicP10bNativeLogFailure(error); assert.ok(['bridge-protocol', 'bridge-failed'].includes(facts?.code));
      assert.equal(JSON.stringify(error).includes('private'), false); return true;
    });
    const writes = f.writes(); await assert.rejects(native.client()); assert.equal(f.writes(), writes);
    assert.equal(await f.cleanup(native), true);
  });
}
test('overdue response cannot beat delayed timeout callback; 700ms includes IPC validation', async t => {
  let monotonic = 0;
  const f = fixture(t, (input, child) => { if (input.version) ready(child); else { monotonic += 700; child.stdout.write(JSON.stringify(response(input.id)) + '\n'); } });
  const native = await f.open({ monotonicClock: () => monotonic });
  await assert.rejects(native.client(), error => publicP10bNativeLogFailure(error)?.code === 'bridge-timeout');
  assert.equal(await f.cleanup(native), true);
});
test('abort before spawn and during initialization/read closes ownership without new requests', async t => {
  for (const stage of ['before', 'init', 'read']) {
    const controller = new AbortController();
    const f = fixture(t, (input, child) => { if (input.version && stage === 'read') ready(child); else controller.abort(); });
    if (stage === 'before') controller.abort();
    if (stage !== 'read') { await assert.rejects(f.open({ signal: controller.signal })); assert.equal(f.writes(), stage === 'before' ? 0 : 1); continue; }
    const native = await f.open({ signal: controller.signal }); await assert.rejects(native.client()); assert.equal(await f.cleanup(native), true);
  }
});
test('HTTP rejection preserves only closed safe facts and prevents all later dispatch', async t => {
  const f = fixture(t, (input, child) => {
    if (input.version) { ready(child); return; }
    child.stdout.write(JSON.stringify({ version: 'p10b-native-log-response-v1', id: input.id, ok: false, error: 'http-failed',
      observation: { httpStatus: 403, elapsedMs: 7, dispatched: true } }) + '\n');
  });
  const native = await f.open();
  await assert.rejects(native.client(), error => {
    assert.deepEqual(publicP10bNativeLogFailure(error), { version: 'p10b-native-log-failure-v1', code: 'http-failed', timeoutMs: 700,
      httpStatus: 403, elapsedMs: 7, dispatched: true }); return true;
  });
  const writes = f.writes(); await assert.rejects(native.client()); assert.equal(f.writes(), writes); assert.equal(await f.cleanup(native), true);
});
for (const status of [201, 204, 299, 401, 403, 502, 503]) {
  test(`exact-200 log contract retains HTTP failure ${status}`, async t => {
    const f = fixture(t, (input, child) => {
      if (input.version) { ready(child); return; }
      child.stdout.write(JSON.stringify({ version: 'p10b-native-log-response-v1', id: input.id, ok: false, error: 'http-failed',
        observation: { httpStatus: status, elapsedMs: 1, dispatched: true } }) + '\n');
    });
    const native = await f.open();
    await assert.rejects(native.client(), error => publicP10bNativeLogFailure(error)?.httpStatus === status);
    assert.equal(await f.cleanup(native), true);
  });
}
for (const args of [['POST'], ['WAIT'], ['GET', {}], ['GET', undefined, 5001]]) {
  test(`local log authority denial is terminal: ${JSON.stringify(args)}`, async t => {
    const f = fixture(t, (_input, child) => ready(child));
    const native = await f.open();
    await assert.rejects(native.client(...args), error => publicP10bNativeLogFailure(error)?.code === 'request-denied');
    await assert.rejects(native.client()); assert.equal(f.writes(), 1); assert.equal(await f.cleanup(native), true);
  });
}
