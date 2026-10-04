import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlyMachineScanTransport,
  hasExactOwnedStopProof,
} from '../server/services/flyMachineScanTransport.js';
import { ScannerPreconnectionRefusedError } from '../server/services/nodePinnedHttpsExchange.js';

function harness({ authorized = true, owns = true, stopConfirmed = true } = {}) {
  const events = [];
  const machineController = {
    async acquireStoppedSession(command) {
      events.push(['acquire', command.sessionGeneration]);
      return { providerGeneration: 'provider-generation-7', initialState: 'stopped' };
    },
    async startSession(command) { events.push(['start', command.providerGeneration]); },
    async ownsSession(command) { events.push(['owns', command.providerGeneration]); return owns; },
    async stopSessionIfOwned(command) {
      events.push(['stop', command.providerGeneration]);
      return stopConfirmed;
    },
  };
  const requestClient = {
    async authorize(command) {
      events.push(['authorize', command.redirects]);
      if (!authorized) throw new Error('admission rejected');
      return {
        async sendBody({ openByteStream }) {
          events.push(['open-body']);
          for await (const _chunk of openByteStream()) { /* synthetic */ }
          return 'synthetic-result-wire';
        },
        abort() { events.push(['abort']); },
      };
    },
  };
  return { events, machineController, requestClient };
}

test('Fly transport requires injected dependencies and has no credential or network defaults', () => {
  assert.throws(() => createFlyMachineScanTransport(), /explicit|injected/i);
  assert.throws(() => createFlyMachineScanTransport({
    machineId: '', machineController: {}, requestClient: {},
  }), /machine identity/i);
});

test('Fly transport admits before opening bytes and stops its exact generation', async () => {
  const fixture = harness();
  let opened = 0;
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  const result = await transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream() { opened += 1; return (async function* () { yield Buffer.from('x'); })(); },
  });
  assert.deepEqual(result, { resultWire: 'synthetic-result-wire', stopConfirmed: true });
  assert.equal(opened, 1);
  assert.deepEqual(fixture.events.map(([name]) => name), [
    'acquire', 'start', 'owns', 'authorize', 'owns', 'open-body', 'owns', 'stop',
  ]);
});

test('Fly transport never opens bytes when worker admission fails and still fences stop', async () => {
  const fixture = harness({ authorized: false });
  let opened = 0;
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream() { opened += 1; return (async function* () {})(); },
  }), /admission rejected/i);
  assert.equal(opened, 0);
  assert.equal(fixture.events.some(([name]) => name === 'stop'), true);
});

test('Fly transport attaches non-enumerable exact owned-stop proof to a failed exchange', async () => {
  for (const stopConfirmed of [true, false]) {
    const fixture = harness({ authorized: false, stopConfirmed });
    const transport = createFlyMachineScanTransport({
      machineId: 'synthetic-machine-1',
      machineController: fixture.machineController,
      requestClient: fixture.requestClient,
    });
    let failure;
    await assert.rejects(transport.run({
      requestWire: '{}',
      requestId: '41111111-1111-4111-8111-111111111111',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      openByteStream: () => (async function* () {})(),
    }), (error) => { failure = error; return true; });
    assert.equal(hasExactOwnedStopProof(failure), stopConfirmed);
    assert.equal(Object.keys(failure).includes('ownedStopConfirmed'), false);
    assert.equal(JSON.stringify(failure), '{}');
  }
});

test('Fly transport non-owner cannot send bytes or stop a newer generation', async () => {
  const fixture = harness({ owns: false });
  let opened = 0;
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream() { opened += 1; return (async function* () {})(); },
  }), /ownership|generation/i);
  assert.equal(opened, 0);
  assert.equal(fixture.events.some(([name]) => name === 'stop'), false);
});

test('Fly transport rechecks generation ownership after admission before opening bytes', async () => {
  const fixture = harness();
  let ownershipChecks = 0;
  fixture.machineController.ownsSession = async (command) => {
    fixture.events.push(['owns', command.providerGeneration]);
    ownershipChecks += 1;
    return ownershipChecks === 1;
  };
  let opened = 0;
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream() { opened += 1; return (async function* () {})(); },
  }), /ownership|generation/i);
  assert.equal(opened, 0);
  assert.equal(fixture.events.some(([name]) => name === 'abort'), true);
  assert.equal(fixture.events.some(([name]) => name === 'stop'), false);
});

test('Fly transport aborts an admitted upload when its ownership recheck fails', async () => {
  const fixture = harness();
  let ownershipChecks = 0;
  fixture.machineController.ownsSession = async (command) => {
    fixture.events.push(['owns', command.providerGeneration]);
    ownershipChecks += 1;
    if (ownershipChecks === 2) throw new Error('synthetic ownership inspection failure');
    return true;
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /ownership inspection failure/i);
  assert.equal(fixture.events.some(([name]) => name === 'abort'), true);
  assert.equal(fixture.events.some(([name]) => name === 'open-body'), false);
});

test('Fly transport reports stop uncertainty separately from an obtained result', async () => {
  const fixture = harness({ stopConfirmed: false });
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  const result = await transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream: () => (async function* () {})(),
  });
  assert.deepEqual(result, { resultWire: 'synthetic-result-wire', stopConfirmed: false });
});

test('Fly transport preserves ownership and stop guards for an early replay without opening bytes', async () => {
  const fixture = harness();
  let opened = 0;
  fixture.requestClient.authorize = async () => ({
    async sendBody() { return 'synthetic-replay-wire'; },
    abort() { fixture.events.push(['abort']); },
  });
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  const result = await transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream() { opened += 1; return (async function* () {})(); },
  });
  assert.deepEqual(result, { resultWire: 'synthetic-replay-wire', stopConfirmed: true });
  assert.equal(opened, 0);
  assert.deepEqual(fixture.events.map(([name]) => name), [
    'acquire', 'start', 'owns', 'owns', 'owns', 'stop',
  ]);
});

test('Fly transport rejects a hung operation within the lease and preserves a bounded stop window', async () => {
  const fixture = harness();
  fixture.requestClient.authorize = async () => new Promise(() => {});
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  const startedAt = performance.now();
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 80).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /deadline/i);
  assert.ok(performance.now() - startedAt < 500, 'deadline must be enforced locally');
  assert.equal(fixture.events.some(([name]) => name === 'stop'), true);
});

test('Fly transport deadline remains authoritative when upload abort throws', async () => {
  const fixture = harness();
  fixture.requestClient.authorize = async () => ({
    async sendBody() { return new Promise(() => {}); },
    abort() { throw new Error('synthetic abort failure'); },
  });
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 80).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /deadline/i);
});

test('Fly transport caps startup at 60 seconds and rejects an oversized response envelope', async () => {
  const fixture = harness();
  let startupDeadlineAt;
  fixture.machineController.acquireStoppedSession = async (command) => {
    startupDeadlineAt = command.deadlineAt;
    return { providerGeneration: 'provider-generation-7', initialState: 'stopped' };
  };
  fixture.requestClient.authorize = async (command) => {
    assert.equal(command.maxResponseBytes, 16 * 1024);
    return {
      async sendBody(bodyCommand) {
        assert.equal(bodyCommand.maxResponseBytes, 16 * 1024);
        return 'x'.repeat(16 * 1024 + 1);
      },
      abort() {},
    };
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
  });
  const startedAt = performance.now();
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /response.*bounded|envelope size/i);
  assert.ok(startupDeadlineAt - startedAt <= 60_100);
});

test('Fly transport retries refused preconnections with bounded backoff and ownership before every attempt', async () => {
  const fixture = harness();
  const delays = [];
  let attempts = 0;
  let opened = 0;
  fixture.requestClient.authorize = async () => {
    fixture.events.push(['authorize']);
    attempts += 1;
    if (attempts < 3) throw new ScannerPreconnectionRefusedError();
    return {
      async sendBody({ openByteStream }) {
        fixture.events.push(['open-body']);
        opened += 1;
        for await (const _chunk of openByteStream()) { /* synthetic */ }
        return 'synthetic-result-wire';
      },
      abort() { fixture.events.push(['abort']); },
    };
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
    async waitBeforeRetry({ delayMs, signal, deadlineAt }) {
      assert.equal(signal.aborted, false);
      assert.ok(Number.isFinite(deadlineAt));
      delays.push(delayMs);
      fixture.events.push(['delay', delayMs]);
    },
  });
  const result = await transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream: () => (async function* () { yield Buffer.from('x'); })(),
  });
  assert.deepEqual(result, { resultWire: 'synthetic-result-wire', stopConfirmed: true });
  assert.equal(opened, 1);
  assert.deepEqual(delays, [250, 500]);
  assert.deepEqual(fixture.events.map(([name]) => name), [
    'acquire', 'start',
    'owns', 'authorize', 'delay',
    'owns', 'authorize', 'delay',
    'owns', 'authorize',
    'owns', 'open-body', 'owns', 'stop',
  ]);
});

test('Fly transport stops retrying before a second request when ownership changes', async () => {
  const fixture = harness();
  let checks = 0;
  let authorizations = 0;
  fixture.machineController.ownsSession = async (command) => {
    fixture.events.push(['owns', command.providerGeneration]);
    checks += 1;
    return checks === 1;
  };
  fixture.requestClient.authorize = async () => {
    authorizations += 1;
    throw new ScannerPreconnectionRefusedError();
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
    async waitBeforeRetry() {},
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /ownership|generation/i);
  assert.equal(authorizations, 1);
  assert.equal(fixture.events.some(([name]) => name === 'open-body'), false);
  assert.equal(fixture.events.some(([name]) => name === 'stop'), false);
});

test('Fly transport refuses a retry whose backoff would consume the startup deadline', async () => {
  const fixture = harness();
  let monotonicMs = 0;
  let authorizations = 0;
  let delays = 0;
  fixture.requestClient.authorize = async () => {
    authorizations += 1;
    throw new ScannerPreconnectionRefusedError();
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
    monotonicNow: () => monotonicMs,
    async waitBeforeRetry() { delays += 1; monotonicMs += 250; },
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 270).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /startup|deadline/i);
  assert.equal(authorizations, 1);
  assert.equal(delays, 0);
  assert.equal(fixture.events.some(([name]) => name === 'open-body'), false);
});

test('Fly transport caps refused preconnections at a finite attempt count', async () => {
  const fixture = harness();
  let attempts = 0;
  const delays = [];
  fixture.requestClient.authorize = async () => {
    attempts += 1;
    throw new ScannerPreconnectionRefusedError();
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
    async waitBeforeRetry({ delayMs }) { delays.push(delayMs); },
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), (error) => error instanceof ScannerPreconnectionRefusedError);
  assert.equal(attempts, 17);
  assert.deepEqual(delays, [
    250, 500, 1_000, 2_000, 4_000,
    5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
  ]);
  assert.equal(fixture.events.some(([name]) => name === 'open-body'), false);
});

test('Fly transport aborts a stalled retry wait and still stops its owned generation', async () => {
  const fixture = harness();
  let retryAborted = false;
  fixture.requestClient.authorize = async () => { throw new ScannerPreconnectionRefusedError(); };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
    waitBeforeRetry: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        retryAborted = true;
        reject(new Error('synthetic retry abort'));
      }, { once: true });
    }),
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 400).toISOString(),
    openByteStream: () => (async function* () {})(),
  }), /deadline/i);
  assert.equal(retryAborted, true);
  assert.equal(fixture.events.some(([name]) => name === 'open-body'), false);
  assert.equal(fixture.events.some(([name]) => name === 'stop'), true);
});

test('Fly transport never retries certificate, authorization, or ambiguous failures', async () => {
  for (const failure of [
    new Error('certificate verification failed'),
    new Error('worker authorization rejected'),
    Object.assign(new Error('ambiguous connection reset'), { code: 'ECONNRESET' }),
  ]) {
    const fixture = harness();
    let attempts = 0;
    let delays = 0;
    fixture.requestClient.authorize = async () => { attempts += 1; throw failure; };
    const transport = createFlyMachineScanTransport({
      machineId: 'synthetic-machine-1',
      machineController: fixture.machineController,
      requestClient: fixture.requestClient,
      async waitBeforeRetry() { delays += 1; },
    });
    await assert.rejects(transport.run({
      requestWire: '{}',
      requestId: '41111111-1111-4111-8111-111111111111',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      openByteStream: () => (async function* () {})(),
    }), failure);
    assert.equal(attempts, 1);
    assert.equal(delays, 0);
    assert.equal(fixture.events.some(([name]) => name === 'open-body'), false);
  }
});

test('Fly transport never retries or reopens bytes after admission succeeds', async () => {
  const fixture = harness();
  let attempts = 0;
  let opened = 0;
  fixture.requestClient.authorize = async () => {
    attempts += 1;
    if (attempts === 1) throw new ScannerPreconnectionRefusedError();
    return {
      async sendBody({ openByteStream }) {
        opened += 1;
        for await (const _chunk of openByteStream()) { /* synthetic */ }
        throw new Error('ambiguous post-admission failure');
      },
      abort() {},
    };
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1',
    machineController: fixture.machineController,
    requestClient: fixture.requestClient,
    async waitBeforeRetry() {},
  });
  await assert.rejects(transport.run({
    requestWire: '{}',
    requestId: '41111111-1111-4111-8111-111111111111',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    openByteStream: () => (async function* () { yield Buffer.from('x'); })(),
  }), /ambiguous post-admission/i);
  assert.equal(attempts, 2);
  assert.equal(opened, 1);
});
