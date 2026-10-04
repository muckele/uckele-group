import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createFlyMachinesApiClient } from '../server/services/flyMachinesApiClient.js';

function command(overrides = {}) {
  return {
    deadlineAt: performance.now() + 1_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('Fly Machines API client inspects one exact Machine with explicit credentials', async () => {
  const calls = [];
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        id: 'machine-1',
        state: 'stopped',
        instance_id: 'instance-7',
        nonce: null,
        private_ip: 'fdaa::7',
        image_ref: { digest: `sha256:${'a'.repeat(64)}` },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(await client.inspect(command()), {
    machineId: 'machine-1',
    state: 'stopped',
    instanceId: 'instance-7',
    leaseNonce: null,
    privateIp: 'fdaa::7',
    imageDigest: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.machines.dev/v1/apps/ug-scanner/machines/machine-1');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-secret-token');
});

test('Fly Machines API client exposes lease acquire and release without choosing lease policy', async () => {
  const calls = [];
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (options.method === 'POST') {
        return new Response(JSON.stringify({
          status: 'success',
          data: {
            nonce: 'nonce-1', expires_at: 1_800_000_000,
            owner: 'service-account', description: 'ug:test:req-1', version: 'lease-version-1',
          },
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ status: 'success', data: { ok: true } }), { status: 200 });
    },
  });

  assert.deepEqual(await client.acquireLease(command({
    ttlSeconds: 120,
    description: 'ug:test:req-1',
  })), {
    nonce: 'nonce-1',
    expiresAt: 1_800_000_000,
    owner: 'service-account',
    description: 'ug:test:req-1',
    version: 'lease-version-1',
  });
  assert.deepEqual(await client.releaseLease(command({ leaseNonce: 'nonce-1' })), { ok: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.machines.dev/v1/apps/ug-scanner/machines/machine-1/lease');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    ttl: 120,
    description: 'ug:test:req-1',
  });
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].options.headers['fly-machine-lease-nonce'], 'nonce-1');
});

test('Fly Machines API client starts waits and stops only with explicit lease and timing inputs', async () => {
  const calls = [];
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.endsWith('/start')) {
        return new Response(JSON.stringify({
          previous_state: 'stopped', migrated: false, new_host: '',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.deepEqual(await client.start(command({ leaseNonce: 'nonce-1' })), {
    previousState: 'stopped', migrated: false, newHost: null,
  });
  assert.deepEqual(await client.wait(command({
    leaseNonce: 'nonce-1', instanceId: 'instance-7', state: 'started', timeoutSeconds: 20,
  })), { ok: true });
  assert.deepEqual(await client.stop(command({
    leaseNonce: 'nonce-1', stopSignal: 'SIGINT', timeoutSeconds: 15,
  })), { ok: true });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.machines.dev/v1/apps/ug-scanner/machines/machine-1/start');
  assert.equal(calls[1].url,
    'https://api.machines.dev/v1/apps/ug-scanner/machines/machine-1/wait?state=started&instance_id=instance-7&timeout=20');
  assert.equal(calls[2].url, 'https://api.machines.dev/v1/apps/ug-scanner/machines/machine-1/stop');
  assert.deepEqual(JSON.parse(calls[2].options.body), { signal: 'SIGINT', timeout: '15' });
  assert.equal(calls.every(({ options }) => options.headers['fly-machine-lease-nonce'] === 'nonce-1'), true);
});

test('Fly Machines API client waits for started without guessing an instance identity', async () => {
  let requestedUrl;
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl(url) {
      requestedUrl = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.deepEqual(await client.wait(command({
    leaseNonce: 'nonce-1', state: 'started', timeoutSeconds: 20,
  })), { ok: true });
  assert.equal(requestedUrl,
    'https://api.machines.dev/v1/apps/ug-scanner/machines/machine-1/wait?state=started&timeout=20');
});

test('Fly Machines API client stops reading and aborts an oversized streamed response', async () => {
  let streamClosed = false;
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 5,
    async fetchImpl() {
      return {
        status: 200,
        body: (async function* body() {
          try {
            yield Buffer.from('1234');
            yield Buffer.from('56');
            yield Buffer.from('must-not-be-read');
          } finally {
            streamClosed = true;
          }
        }()),
        async text() { throw new Error('unbounded text read'); },
      };
    },
  });

  await assert.rejects(client.inspect(command()), /response.*cap/i);
  assert.equal(streamClosed, true);
});

test('Fly Machines API client bounds deadlines during response streaming', async () => {
  let requestSignal;
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl(_url, options) {
      requestSignal = options.signal;
      return {
        status: 200,
        body: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise((resolve, reject) => {
                  requestSignal.addEventListener('abort', () => reject(new Error('raw transport abort')), { once: true });
                });
              },
            };
          },
        },
      };
    },
  });

  await assert.rejects(client.inspect(command({
    deadlineAt: performance.now() + 10,
  })), (error) => /deadline|aborted/i.test(error.message)
    && !error.message.includes('raw transport abort'));
  assert.equal(requestSignal.aborted, true);
});

test('Fly Machines API client makes one redacted request and never retries provider failures', async () => {
  const secret = 'do-not-disclose-this-token';
  let calls = 0;
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: secret,
    maxResponseBytes: 4_096,
    async fetchImpl() {
      calls += 1;
      throw new Error(`provider echoed ${secret}`);
    },
  });

  await assert.rejects(client.inspect(command()), (error) => {
    assert.equal(String(error).includes(secret), false);
    return /request failed/i.test(error.message);
  });
  assert.equal(calls, 1);
});

test('Fly Machines API client aborts and cancels a non-success response without reading its body', async () => {
  let requestSignal;
  let bodyReads = 0;
  let bodyCancels = 0;
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl(_url, options) {
      requestSignal = options.signal;
      return {
        status: 503,
        body: {
          async cancel() { bodyCancels += 1; },
          [Symbol.asyncIterator]() {
            bodyReads += 1;
            return { next: () => new Promise(() => {}) };
          },
        },
      };
    },
  });

  await assert.rejects(client.inspect(command()), /inspect.*not successful/i);
  assert.equal(requestSignal.aborted, true);
  assert.equal(bodyCancels, 1);
  assert.equal(bodyReads, 0);
});

test('Fly Machines API client import has no network or environment side effects', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected network'); };
  try {
    await import(`../server/services/flyMachinesApiClient.js?side-effect-check=${Date.now()}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.throws(() => createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
  }), /injected.*transport/i);
});

test('Fly Machines API client rejects a malformed abort signal before transport access', async () => {
  let calls = 0;
  const client = createFlyMachinesApiClient({
    apiBaseUrl: 'https://api.machines.dev',
    appName: 'ug-scanner',
    machineId: 'machine-1',
    accessToken: 'test-secret-token',
    maxResponseBytes: 4_096,
    async fetchImpl() { calls += 1; throw new Error('must not run'); },
  });

  await assert.rejects(client.inspect({
    deadlineAt: performance.now() + 1_000,
    signal: { aborted: false },
  }), /abort signal/i);
  assert.equal(calls, 0);
});
