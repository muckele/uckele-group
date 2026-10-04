import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createFlyMachineController,
  createPinnedHttpScanRequestClient,
} from '../server/services/flyMachineOperabilityAdapters.js';

test('concrete Fly controller fences every action through the injected control seam', async () => {
  const commands = [];
  let state = 'stopped';
  let sessionGeneration = null;
  const controller = createFlyMachineController({
    machineId: 'machine-1',
    async control(command) {
      commands.push(command);
      if (command.action === 'inspect') return { state, providerGeneration: 'generation-7', sessionGeneration };
      if (command.action === 'start-if-owned') {
        state = 'started'; sessionGeneration = command.sessionGeneration; return { applied: true };
      }
      if (command.action === 'stop-if-owned') {
        state = 'stopped'; sessionGeneration = null; return { applied: true };
      }
      throw new Error('unexpected action');
    },
  });
  const base = {
    machineId: 'machine-1', sessionGeneration: 'request-1',
    deadlineAt: performance.now() + 1_000, signal: new AbortController().signal,
  };

  assert.deepEqual(await controller.acquireStoppedSession(base), {
    initialState: 'stopped', providerGeneration: 'generation-7',
  });
  await controller.startSession({ ...base, providerGeneration: 'generation-7' });
  assert.equal(await controller.ownsSession({ ...base, providerGeneration: 'generation-7' }), true);
  assert.equal(await controller.stopSessionIfOwned({ ...base, providerGeneration: 'generation-7' }), true);
  assert.deepEqual(commands.map(({ action }) => action), [
    'inspect', 'start-if-owned', 'inspect', 'stop-if-owned',
  ]);
  assert.equal(commands.every(({ machineId }) => machineId === 'machine-1'), true);
});

test('concrete Fly controller refuses a seam without atomic start and stop ownership results', async () => {
  const controller = createFlyMachineController({
    machineId: 'machine-1',
    async control({ action }) {
      if (action === 'inspect') return {
        state: 'stopped', providerGeneration: 'generation-7', sessionGeneration: null,
      };
      return { applied: false };
    },
  });
  const command = {
    machineId: 'machine-1', sessionGeneration: 'request-1', providerGeneration: 'generation-7',
    deadlineAt: performance.now() + 1_000, signal: new AbortController().signal,
  };
  await assert.rejects(controller.startSession(command), /generation|ownership/i);
  assert.equal(await controller.stopSessionIfOwned(command), false);
});

test('concrete Fly controller rejects a reused provider generation owned by another request', async () => {
  const controller = createFlyMachineController({
    machineId: 'machine-1',
    async control() {
      return {
        state: 'started', providerGeneration: 'generation-7', sessionGeneration: 'different-request',
      };
    },
  });
  assert.equal(await controller.ownsSession({
    machineId: 'machine-1', sessionGeneration: 'request-1', providerGeneration: 'generation-7',
    deadlineAt: performance.now() + 1_000, signal: new AbortController().signal,
  }), false);
});

test('pinned HTTP request client admits before opening bytes and caps the exact response', async () => {
  const events = [];
  const chunks = [];
  const requestClient = createPinnedHttpScanRequestClient({
    endpoint: 'https://scanner.internal.example/v1/cim-scan',
    certificatePinSha256: 'a'.repeat(64),
    async openExchange(command) {
      events.push(['open', command.endpoint, command.redirects, command.certificatePinSha256]);
      return {
        async awaitAdmission() { events.push(['admit']); return { status: 100 }; },
        async write(chunk) { events.push(['write']); chunks.push(Buffer.from(chunk)); },
        async finish() {
          events.push(['finish']);
          return { status: 200, body: [Buffer.from('signed-result')] };
        },
        abort() { events.push(['abort']); },
      };
    },
  });
  const requestWire = JSON.stringify({ sizeBytes: 3 });
  const upload = await requestClient.authorize({
    requestWire, redirects: 'error', maxResponseBytes: 64,
    signal: new AbortController().signal, deadlineAt: performance.now() + 1_000,
  });
  let opened = 0;
  const wire = await upload.sendBody({
    openByteStream() { opened += 1; return Readable.from([Buffer.from('abc')]); },
    signal: new AbortController().signal, deadlineAt: performance.now() + 1_000,
    maxResponseBytes: 64,
  });
  assert.equal(wire, 'signed-result');
  assert.equal(opened, 1);
  assert.equal(Buffer.concat(chunks).toString(), 'abc');
  assert.deepEqual(events.map(([event]) => event), ['open', 'admit', 'write', 'finish']);
});

test('pinned HTTP request client requires HTTPS pinning, redirect refusal, and exact upload length', async () => {
  assert.throws(() => createPinnedHttpScanRequestClient({
    endpoint: 'http://scanner.internal/v1/cim-scan', certificatePinSha256: 'a'.repeat(64),
    openExchange() {},
  }), /HTTPS/i);
  const client = createPinnedHttpScanRequestClient({
    endpoint: 'https://scanner.internal/v1/cim-scan', certificatePinSha256: 'a'.repeat(64),
    async openExchange() {
      return {
        async awaitAdmission() { return { status: 100 }; },
        async write() {},
        async finish() { return { status: 200, body: [Buffer.from('ok')] }; },
        abort() {},
      };
    },
  });
  await assert.rejects(client.authorize({
    requestWire: JSON.stringify({ sizeBytes: 1 }), redirects: 'follow', maxResponseBytes: 64,
  }), /redirect/i);
  const upload = await client.authorize({
    requestWire: JSON.stringify({ sizeBytes: 2 }), redirects: 'error', maxResponseBytes: 64,
  });
  await assert.rejects(upload.sendBody({
    openByteStream: () => Readable.from([Buffer.from('x')]), maxResponseBytes: 64,
  }), /length|size/i);
});

test('pinned HTTP request client aborts an admitted exchange when body setup fails', async () => {
  const original = new Error('source-open-failed');
  let aborts = 0;
  const client = createPinnedHttpScanRequestClient({
    endpoint: 'https://scanner.internal/v1/cim-scan', certificatePinSha256: 'a'.repeat(64),
    async openExchange() {
      return {
        async awaitAdmission() { return { status: 100 }; },
        async write() {},
        async finish() { return { status: 200, body: [] }; },
        abort() { aborts += 1; throw new Error('abort-failed'); },
      };
    },
  });
  const upload = await client.authorize({
    requestWire: JSON.stringify({ sizeBytes: 1 }), redirects: 'error', maxResponseBytes: 64,
  });

  await assert.rejects(upload.sendBody({
    openByteStream() { throw original; }, maxResponseBytes: 64,
  }), (error) => error === original);
  assert.equal(aborts, 1);
});

test('pinned HTTP request client aborts a stalled response body at its deadline', async () => {
  let aborts = 0;
  const client = createPinnedHttpScanRequestClient({
    endpoint: 'https://scanner.internal/v1/cim-scan', certificatePinSha256: 'a'.repeat(64),
    async openExchange() {
      return {
        async awaitAdmission() { return { status: 100 }; },
        async write() {},
        async finish() {
          return {
            status: 200,
            body: {
              [Symbol.asyncIterator]() {
                return { next: () => new Promise(() => {}) };
              },
            },
          };
        },
        abort() { aborts += 1; },
      };
    },
  });
  const upload = await client.authorize({
    requestWire: JSON.stringify({ sizeBytes: 0 }), redirects: 'error', maxResponseBytes: 64,
    signal: new AbortController().signal, deadlineAt: performance.now() + 1_000,
  });

  const result = await Promise.race([
    upload.sendBody({
      openByteStream: () => Readable.from([]), maxResponseBytes: 64,
      signal: new AbortController().signal, deadlineAt: performance.now() + 10,
    }).then(() => ({ resolved: true }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 80)),
  ]);
  assert.equal(result.stalled, undefined, 'response body consumption must obey the active deadline');
  assert.match(result.error?.message || '', /deadline|aborted/i);
  assert.equal(aborts, 1);
});

test('pinned HTTP request client redacts response body iterator failures', async () => {
  let aborts = 0;
  const client = createPinnedHttpScanRequestClient({
    endpoint: 'https://scanner.internal/v1/cim-scan', certificatePinSha256: 'a'.repeat(64),
    async openExchange() {
      return {
        async awaitAdmission() { return { status: 100 }; },
        async write() {},
        async finish() {
          return {
            status: 200,
            body: {
              [Symbol.asyncIterator]() {
                return {
                  async next() { throw new Error('raw peer detail should stay private'); },
                };
              },
            },
          };
        },
        abort() { aborts += 1; },
      };
    },
  });
  const upload = await client.authorize({
    requestWire: JSON.stringify({ sizeBytes: 0 }), redirects: 'error', maxResponseBytes: 64,
    signal: new AbortController().signal, deadlineAt: performance.now() + 1_000,
  });

  await assert.rejects(upload.sendBody({
    openByteStream: () => Readable.from([]), maxResponseBytes: 64,
    signal: new AbortController().signal, deadlineAt: performance.now() + 1_000,
  }), (error) => /response.*read/i.test(error.message)
    && !error.message.includes('raw peer detail'));
  assert.equal(aborts, 1);
});
