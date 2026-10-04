import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlyMachineLeaseController as createControllerSubject } from '../server/services/flyMachineLeaseController.js';

const expectedImageDigest = `sha256:${'a'.repeat(64)}`;

function createFlyMachineLeaseController(options) {
  return createControllerSubject({ expectedImageDigest, ...options });
}

function command(overrides = {}) {
  return {
    machineId: 'machine-1',
    sessionGeneration: 'request-1',
    deadlineAt: 500_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function harness({ leaseExpiresAt = 1_700_000_180 } = {}) {
  const calls = [];
  let state = 'stopped';
  let leaseNonce = null;
  let instanceId = 'instance-before-start';
  let imageDigest = expectedImageDigest;
  const apiClient = {
    async inspect(options) {
      calls.push(['inspect', options]);
      return {
        machineId: 'machine-1', state, instanceId, leaseNonce,
        privateIp: 'fdaa::7', imageDigest,
      };
    },
    async acquireLease(options) {
      calls.push(['acquireLease', options]);
      leaseNonce = 'nonce-1';
      return {
        nonce: leaseNonce, expiresAt: leaseExpiresAt, owner: 'service-account',
        description: options.description, version: 'lease-version-1',
      };
    },
    async start(options) {
      calls.push(['start', options]);
      state = 'started';
      instanceId = 'instance-after-start';
      return { previousState: 'stopped', migrated: false, newHost: null };
    },
    async wait(options) {
      calls.push(['wait', options]);
      return { ok: true };
    },
    async stop(options) {
      calls.push(['stop', options]);
      state = 'stopped';
      return { ok: true };
    },
    async releaseLease(options) {
      calls.push(['releaseLease', options]);
      leaseNonce = null;
      return { ok: true };
    },
  };
  return {
    apiClient,
    calls,
    replaceLease(nonce = 'nonce-other-owner') { leaseNonce = nonce; },
    setMachine(next = {}) {
      if (Object.hasOwn(next, 'state')) state = next.state;
      if (Object.hasOwn(next, 'instanceId')) instanceId = next.instanceId;
      if (Object.hasOwn(next, 'leaseNonce')) leaseNonce = next.leaseNonce;
      if (Object.hasOwn(next, 'imageDigest')) imageDigest = next.imageDigest;
    },
  };
}

test('lease controller refuses image drift before and after lease acquisition without starting', async () => {
  const beforeLease = harness();
  beforeLease.setMachine({ imageDigest: `sha256:${'b'.repeat(64)}` });
  const first = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: beforeLease.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await assert.rejects(first.acquireStoppedSession(command({ deadlineAt: 160_000 })), /image|stopped/i);
  assert.equal(beforeLease.calls.some(([name]) => name === 'acquireLease'), false);

  const underLease = harness();
  const originalAcquire = underLease.apiClient.acquireLease;
  underLease.apiClient.acquireLease = async (options) => {
    const lease = await originalAcquire(options);
    underLease.setMachine({ imageDigest: `sha256:${'c'.repeat(64)}` });
    return lease;
  };
  const second = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: underLease.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await assert.rejects(second.acquireStoppedSession(command({ deadlineAt: 160_000 })), /ownership|stopped/i);
  assert.equal(underLease.calls.some(([name]) => name === 'start'), false);
});

test('lease controller owns one 240-second non-renewing Machine session through stop and release', async () => {
  const fixture = harness();
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1',
    apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000,
    monotonicNow: () => 100_000,
  });

  const session = await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  assert.deepEqual(session, { initialState: 'stopped', providerGeneration: 'nonce-1' });
  await controller.startSession(command({ providerGeneration: 'nonce-1', deadlineAt: 250_000 }));
  assert.equal(await controller.ownsSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), true);
  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), true);

  assert.deepEqual(fixture.calls.map(([name]) => name), [
    'inspect', 'acquireLease', 'inspect',
    'inspect', 'start', 'wait', 'inspect',
    'inspect',
    'inspect', 'stop', 'wait', 'inspect', 'releaseLease',
  ]);
  const acquire = fixture.calls.find(([name]) => name === 'acquireLease')[1];
  assert.equal(acquire.ttlSeconds, 240);
  assert.equal(acquire.description, 'ug-cim-scan:request-1');
  const startedWait = fixture.calls.find(([name, options]) => (
    name === 'wait' && options.state === 'started'
  ))[1];
  assert.equal(startedWait.instanceId, undefined);
  for (const [name, options] of fixture.calls) {
    if (['start', 'stop', 'wait', 'releaseLease'].includes(name)) {
      assert.equal(options.leaseNonce, 'nonce-1');
    }
    assert.ok(options.deadlineAt <= 250_000);
  }
});

test('lease controller derives its provider deadline from returned expires_at and each durable deadline', async () => {
  const fixture = harness({ leaseExpiresAt: 1_700_000_120 });
  let wall = 1_700_000_000_000;
  let monotonic = 100_000;
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => wall, monotonicNow: () => monotonic,
  });

  await controller.acquireStoppedSession(command({ deadlineAt: 150_000 }));
  monotonic = 101_000;
  wall += 1_000;
  await controller.startSession(command({ providerGeneration: 'nonce-1', deadlineAt: 300_000 }));

  const postLeaseCalls = fixture.calls.slice(3);
  assert.equal(postLeaseCalls.length > 0, true);
  assert.equal(postLeaseCalls.every(([, options]) => options.deadlineAt <= 220_000), true,
    'returned 120-second expires_at, mapped at acquisition, must cap later commands');

  fixture.calls.length = 0;
  assert.equal(await controller.ownsSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 140_000,
  })), true);
  assert.equal(fixture.calls.every(([, options]) => options.deadlineAt <= 140_000), true,
    'the caller durable deadline remains authoritative when earlier');
});

test('lease controller performs no mutation after its lease expires and never reacquires automatically', async () => {
  const fixture = harness({ leaseExpiresAt: 1_700_000_010 });
  let wall = 1_700_000_000_000;
  let monotonic = 100_000;
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => wall, monotonicNow: () => monotonic,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 130_000 }));
  wall += 11_000;
  monotonic += 11_000;

  assert.equal(await controller.ownsSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 130_000,
  })), false);
  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 130_000,
  })), false);
  await assert.rejects(controller.acquireStoppedSession(command({ deadlineAt: 130_000 })),
    /reacquire|session|lease/i);
  assert.equal(fixture.calls.filter(([name]) => name === 'acquireLease').length, 1);
  assert.equal(fixture.calls.some(([name]) => ['start', 'stop', 'releaseLease'].includes(name)), false);
});

test('lease controller refuses a replaced nonce before start or stop and does not release it', async () => {
  const fixture = harness();
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  fixture.replaceLease();

  await assert.rejects(controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 160_000,
  })), /ownership|lease/i);
  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 160_000,
  })), false);
  assert.equal(fixture.calls.some(([name]) => ['start', 'stop', 'releaseLease'].includes(name)), false);
});

test('lease controller makes one stop attempt and preserves ambiguity without releasing', async () => {
  const fixture = harness();
  fixture.apiClient.stop = async (options) => {
    fixture.calls.push(['stop', options]);
    throw new Error('synthetic response loss');
  };
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  await controller.startSession(command({ providerGeneration: 'nonce-1', deadlineAt: 250_000 }));

  await assert.rejects(controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), /stop|failed|response/i);
  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), false);
  assert.equal(fixture.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'releaseLease'), false);
});

test('lease controller recovers the exact started instance after an ambiguous start response', async () => {
  const fixture = harness();
  fixture.apiClient.start = async (options) => {
    fixture.calls.push(['start', options]);
    fixture.setMachine({ state: 'started', instanceId: 'instance-after-ambiguous-start' });
    throw new Error('synthetic start response loss');
  };
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  await assert.rejects(controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), /start|response/i);

  assert.equal(await controller.ownsSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), true);
  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), true);
  assert.equal(fixture.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'releaseLease'), true);
});

test('lease controller permits only one concurrent start attempt', async () => {
  const fixture = harness();
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  const first = controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  }));
  await assert.rejects(controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), /one attempt|start/i);
  await first;
  assert.equal(fixture.calls.filter(([name]) => name === 'start').length, 1);
});

test('lease controller bounds recovery of an accepted start before it becomes visible', async () => {
  const fixture = harness();
  let monotonic = 100_000;
  fixture.apiClient.start = async (options) => {
    fixture.calls.push(['start', options]);
    throw new Error('synthetic start response loss');
  };
  fixture.apiClient.wait = async (options) => {
    fixture.calls.push(['wait', options]);
    if (options.state === 'started') {
      monotonic = options.deadlineAt - 1_000;
      fixture.setMachine({ state: 'started', instanceId: 'instance-after-delayed-start' });
    }
    return { ok: true };
  };
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => monotonic,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  await assert.rejects(controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), /start|response/i);

  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), true);
  const recoveryWait = fixture.calls.find(([name, options]) => (
    name === 'wait' && options.state === 'started'
  ));
  assert.ok(recoveryWait, 'ambiguous start must be awaited under the owned lease before cleanup');
  assert.equal(recoveryWait[1].instanceId, undefined);
  const stop = fixture.calls.find(([name]) => name === 'stop');
  assert.ok(recoveryWait[1].deadlineAt < stop[1].deadlineAt,
    'start visibility recovery must preserve a later stop budget');
  assert.equal(fixture.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'releaseLease'), true);
});

test('lease controller spends its reserved stop attempt after start visibility times out', async () => {
  const fixture = harness();
  let monotonic = 100_000;
  fixture.apiClient.start = async (options) => {
    fixture.calls.push(['start', options]);
    throw new Error('synthetic start response loss');
  };
  fixture.apiClient.wait = async (options) => {
    fixture.calls.push(['wait', options]);
    if (options.state === 'started') {
      monotonic = options.deadlineAt;
      throw new Error('synthetic start visibility timeout');
    }
    return { ok: true };
  };
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => monotonic,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  await assert.rejects(controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), /start|response/i);

  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), false);
  const recoveryWait = fixture.calls.find(([name, options]) => (
    name === 'wait' && options.state === 'started'
  ));
  const stop = fixture.calls.find(([name]) => name === 'stop');
  assert.ok(stop, 'a nonce-fenced stop must still be attempted after visibility times out');
  assert.ok(recoveryWait[1].deadlineAt < stop[1].deadlineAt,
    'the visibility wait must preserve time for the stop attempt');
  assert.equal(fixture.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'releaseLease'), false,
    'an unobserved start must preserve the lease ambiguity');
});

test('lease controller preserves the owned lease for cleanup after a post-wait state mismatch', async () => {
  const fixture = harness();
  fixture.apiClient.wait = async (options) => {
    fixture.calls.push(['wait', options]);
    if (options.state === 'started') fixture.setMachine({ state: 'stopped' });
    return { ok: true };
  };
  const controller = createFlyMachineLeaseController({
    machineId: 'machine-1', apiClient: fixture.apiClient,
    wallNowMs: () => 1_700_000_000_000, monotonicNow: () => 100_000,
  });
  await controller.acquireStoppedSession(command({ deadlineAt: 160_000 }));
  await assert.rejects(controller.startSession(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), /started|ownership|confirm/i);

  assert.equal(await controller.stopSessionIfOwned(command({
    providerGeneration: 'nonce-1', deadlineAt: 250_000,
  })), false);
  assert.equal(fixture.calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(fixture.calls.some(([name]) => name === 'releaseLease'), false);
});
