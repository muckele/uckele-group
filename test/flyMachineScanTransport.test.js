import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlyMachineScanTransport } from '../server/services/flyMachineScanTransport.js';

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
