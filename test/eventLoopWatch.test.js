import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createEventLoopWatch, routeLabel } from '../server/utils/eventLoopWatch.js';

function fakeLogger() {
  const lines = [];
  return { lines, warn: (line) => lines.push(line) };
}

function fakeResponse(statusCode = 200) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.writableFinished = true;
  return response;
}

function harness(overrides = {}) {
  let clock = 1_000;
  let cpuMicros = 0;
  const logger = fakeLogger();
  const watch = createEventLoopWatch({
    logger,
    stallThresholdMs: 2_000,
    slowRequestMs: 2_000,
    tickMs: 500,
    now: () => clock,
    cpuUsage: () => ({ user: cpuMicros, system: 0 }),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...overrides,
  });
  return {
    logger,
    watch,
    advance: (ms, cpuMs = 0) => { clock += ms; cpuMicros += cpuMs * 1_000; },
  };
}

function handled(watch, { method = 'GET', baseUrl = '', path = '/api/admin/thing', status = 200 } = {}) {
  const request = { method, baseUrl, route: { path } };
  const response = fakeResponse(status);
  watch.middleware(request, response, () => {});
  return { request, response };
}

test('routeLabel uses the route pattern, never the real URL or query', () => {
  const label = routeLabel({
    method: 'POST',
    baseUrl: '/api/admin',
    originalUrl: '/api/admin/verify/secret-token?email=owner@example.test',
    route: { path: '/verify/:token' },
  });
  assert.equal(label, 'POST /api/admin/verify/:token');
  assert.equal(routeLabel({ method: 'GET', originalUrl: '/secret-token' }), 'GET (no route)');
});

test('routeLabel keeps a label short and on one line', () => {
  const label = routeLabel({ method: 'GET', route: { path: `/a\nb/${'x'.repeat(400)}` } });
  assert.equal(label.includes('\n'), false);
  assert.ok(label.length <= 164);
});

test('an on-time tick logs nothing', () => {
  const { logger, watch, advance } = harness();
  advance(500);
  watch.tick();
  advance(2_400);
  watch.tick();
  assert.deepEqual(logger.lines, []);
});

test('a stall logs how long, CPU used, and the request still running', () => {
  const { logger, watch, advance } = harness();
  handled(watch, { method: 'POST', baseUrl: '/api/admin', path: '/deal-hunter/triage/:opportunityId/action' });
  advance(6_500, 6_100);
  watch.tick();
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /^\[event-loop-stall\] blockedMs=6000 cpuMs=6100 /);
  assert.match(logger.lines[0], /active=POST \/api\/admin\/deal-hunter\/triage\/:opportunityId\/action/);
  assert.match(logger.lines[0], /finished=none$/);
});

test('a stall caused by a request that finished during the stall still names it', () => {
  const { logger, watch, advance } = harness();
  const { response } = handled(watch, { path: '/api/admin/deal-hunter/triage' });
  advance(6_500, 6_000);
  response.emit('close');
  watch.tick();
  assert.match(logger.lines.at(-1), /active=none finished=GET \/api\/admin\/deal-hunter\/triage:6500ms$/);
});

test('a stall with no request and almost no CPU reads as outside the app', () => {
  const { logger, watch, advance } = harness();
  advance(8_000, 10);
  watch.tick();
  assert.match(logger.lines[0], /blockedMs=7500 cpuMs=10 active=none finished=none$/);
});

test('a request finished before the stall is not blamed for it', () => {
  const { logger, watch, advance } = harness();
  const { response } = handled(watch);
  advance(100);
  response.emit('close');
  advance(400);
  watch.tick();
  advance(6_500);
  watch.tick();
  assert.match(logger.lines.at(-1), /finished=none$/);
});

test('slow requests are logged with status, fast ones are not', () => {
  const { logger, watch, advance } = harness();
  const fast = handled(watch, { path: '/fast' });
  advance(1_999);
  fast.response.emit('close');
  assert.deepEqual(logger.lines, []);
  const slow = handled(watch, { path: '/slow', status: 503 });
  advance(2_000);
  slow.response.emit('close');
  assert.deepEqual(logger.lines, ['[slow-request] GET /slow status=503 durationMs=2000']);
});

test('a client that disconnects early is marked, and only logged once', () => {
  const { logger, watch, advance } = harness();
  const { response } = handled(watch, { path: '/gone' });
  response.writableFinished = false;
  advance(3_000);
  response.emit('close');
  response.emit('close');
  assert.deepEqual(logger.lines, ['[slow-request] GET /gone status=200 durationMs=3000 aborted']);
});

test('active and finished lists are bounded in the log line', () => {
  const { logger, watch, advance } = harness();
  for (let index = 0; index < 40; index += 1) handled(watch, { path: `/route-${index}` });
  advance(6_500);
  watch.tick();
  const active = logger.lines.at(-1).match(/active=(.*) finished=/)[1].split(',');
  assert.equal(active.filter((label) => label.startsWith('GET ')).length, 5);
  assert.equal(active.at(-1), '+35 more');
});

test('middleware always continues and tracks nothing after close', () => {
  const { logger, watch, advance } = harness();
  let continued = 0;
  const response = fakeResponse();
  watch.middleware({ method: 'GET', route: { path: '/x' } }, response, () => { continued += 1; });
  assert.equal(continued, 1);
  response.emit('close');
  advance(6_500);
  watch.tick();
  assert.match(logger.lines.at(-1), /active=none/);
});

test('start is idempotent, unrefs its timer, and stop clears it', () => {
  const started = [];
  const cleared = [];
  let unrefs = 0;
  const { watch } = harness({
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() { unrefs += 1; } }; started.push(timer); return timer; },
    clearTimer: (timer) => cleared.push(timer),
  });
  const first = watch.start();
  watch.start();
  assert.equal(started.length, 1);
  assert.equal(started[0].ms, 500);
  assert.equal(unrefs, 1);
  first.stop();
  assert.deepEqual(cleared, [started[0]]);
  watch.stop();
  assert.equal(cleared.length, 1);
});

test('a failing logger never reaches the request or the timer', () => {
  const { watch, advance } = harness({ logger: { warn() { throw new Error('logger down'); } } });
  const { response } = handled(watch);
  advance(6_500);
  assert.doesNotThrow(() => watch.tick());
  assert.doesNotThrow(() => response.emit('close'));
});

test('the real timer notices a real block of the event loop', async () => {
  const logger = fakeLogger();
  const watch = createEventLoopWatch({ logger, stallThresholdMs: 150, slowRequestMs: 10_000, tickMs: 20 });
  const handle = watch.start();
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  const until = Date.now() + 300;
  while (Date.now() < until) { /* block the loop on purpose */ }
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  handle.stop();
  assert.equal(logger.lines.length, 1);
  const [, blockedMs, cpuMs] = logger.lines[0].match(/blockedMs=(\d+) cpuMs=(\d+)/);
  assert.ok(Number(blockedMs) >= 150);
  assert.ok(Number(cpuMs) >= 100);
});
