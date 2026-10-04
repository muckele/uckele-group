const leaseTtlSeconds = 240;
const maximumLeaseMs = leaseTtlSeconds * 1_000;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;

function requireIdentity(value, label) {
  if (!identityPattern.test(String(value || ''))) throw new Error(`${label} is invalid.`);
  return String(value);
}

function requireCommand(command, machineId, { providerGeneration = false } = {}) {
  if (command?.machineId !== machineId) throw new Error('Fly Machine identity does not match the controller.');
  const sessionGeneration = requireIdentity(command?.sessionGeneration, 'Fly session generation');
  if (providerGeneration) requireIdentity(command?.providerGeneration, 'Fly provider generation');
  if (!Number.isFinite(command?.deadlineAt)) throw new Error('Fly control deadline is invalid.');
  if (!command?.signal || typeof command.signal.aborted !== 'boolean') {
    throw new Error('Fly control abort signal is required.');
  }
  if (command.signal.aborted) throw new Error('Fly control operation was aborted.');
  return sessionGeneration;
}

function requireDependencies({
  machineId, expectedImageDigest, apiClient, wallNowMs, monotonicNow,
} = {}) {
  const exactMachineId = requireIdentity(machineId, 'Fly Machine identity');
  if (!imageDigestPattern.test(String(expectedImageDigest || ''))) {
    throw new Error('Expected Fly Machine image digest is invalid.');
  }
  const methods = ['inspect', 'acquireLease', 'releaseLease', 'start', 'wait', 'stop'];
  if (!apiClient || methods.some((method) => typeof apiClient[method] !== 'function')) {
    throw new Error('An injected Fly Machines API client is required.');
  }
  if (typeof wallNowMs !== 'function' || typeof monotonicNow !== 'function') {
    throw new Error('Injected wall and monotonic clocks are required.');
  }
  return { exactMachineId, expectedImageDigest };
}

function waitSeconds(deadlineAt, monotonicNow) {
  const remaining = deadlineAt - monotonicNow();
  if (remaining <= 0) throw new Error('Fly Machine lease expired before the operation.');
  return Math.max(1, Math.min(300, Math.floor(remaining / 1_000)));
}

function recoveryDeadline(deadlineAt, monotonicNow) {
  const now = monotonicNow();
  const remaining = deadlineAt - now;
  if (remaining <= 2) throw new Error('Fly Machine lease expired before start recovery.');
  return now + Math.floor(remaining / 2);
}

export function createFlyMachineLeaseController(options = {}) {
  const { apiClient, wallNowMs, monotonicNow } = options;
  const { exactMachineId: machineId, expectedImageDigest } = requireDependencies(options);
  let acquisitionAttempted = false;
  let session = null;

  function activeSession(command) {
    const sessionGeneration = requireCommand(command, machineId, { providerGeneration: true });
    if (!session || session.released || session.lost
      || session.sessionGeneration !== sessionGeneration
      || session.nonce !== command.providerGeneration) {
      return null;
    }
    if (monotonicNow() >= session.providerDeadlineAt) {
      session.lost = true;
      return null;
    }
    return session;
  }

  function apiCommand(command, ownedSession = session) {
    const deadlineAt = ownedSession
      ? Math.min(command.deadlineAt, ownedSession.providerDeadlineAt)
      : command.deadlineAt;
    if (deadlineAt <= monotonicNow()) throw new Error('Fly Machine lease expired before the operation.');
    return { deadlineAt, signal: command.signal };
  }

  async function inspectOwned(command, ownedSession) {
    const inspected = await apiClient.inspect(apiCommand(command, ownedSession));
    if (inspected?.machineId !== machineId || inspected.imageDigest !== expectedImageDigest
      || inspected.leaseNonce !== ownedSession.nonce) {
      ownedSession.lost = true;
      return null;
    }
    return inspected;
  }

  return Object.freeze({
    async acquireStoppedSession(command = {}) {
      const sessionGeneration = requireCommand(command, machineId);
      if (acquisitionAttempted) {
        throw new Error('Fly Machine lease reacquisition is disabled for this controller session.');
      }
      acquisitionAttempted = true;
      const initial = await apiClient.inspect(apiCommand(command, null));
      if (initial?.machineId !== machineId || initial.imageDigest !== expectedImageDigest
        || initial.state !== 'stopped' || initial.leaseNonce !== null) {
        throw new Error('Fly Machine is not initially stopped and unleased.');
      }
      const lease = await apiClient.acquireLease({
        ...apiCommand(command, null),
        ttlSeconds: leaseTtlSeconds,
        description: `ug-cim-scan:${sessionGeneration}`,
      });
      const nonce = requireIdentity(lease?.nonce, 'Fly Machine lease nonce');
      const expiresAtMs = Number(lease?.expiresAt) * 1_000;
      const remainingMs = expiresAtMs - wallNowMs();
      if (!Number.isSafeInteger(lease?.expiresAt) || remainingMs <= 0) {
        throw new Error('Fly Machine lease was already expired when acquired.');
      }
      session = {
        sessionGeneration,
        nonce,
        providerDeadlineAt: monotonicNow() + Math.min(remainingMs, maximumLeaseMs),
        startedInstanceId: null,
        startAttempted: false,
        startMutationIssued: false,
        startConfirmed: false,
        stopAttempted: false,
        lost: false,
        released: false,
      };
      const confirmed = await inspectOwned(command, session);
      if (!confirmed || confirmed.state !== 'stopped') {
        session.lost = true;
        throw new Error('Fly Machine stopped lease ownership could not be confirmed.');
      }
      return Object.freeze({ initialState: 'stopped', providerGeneration: nonce });
    },

    async startSession(command = {}) {
      const owned = activeSession(command);
      if (!owned) throw new Error('Fly Machine lease ownership was lost before start.');
      if (owned.startAttempted) throw new Error('Fly Machine start is limited to one attempt per lease.');
      owned.startAttempted = true;
      const before = await inspectOwned(command, owned);
      if (!before || before.state !== 'stopped') {
        throw new Error('Fly Machine lease ownership or stopped state was lost before start.');
      }
      const bounded = apiCommand(command, owned);
      owned.startMutationIssued = true;
      await apiClient.start({ ...bounded, leaseNonce: owned.nonce });
      const timeoutSeconds = waitSeconds(bounded.deadlineAt, monotonicNow);
      await apiClient.wait({
        ...apiCommand(command, owned),
        leaseNonce: owned.nonce,
        state: 'started',
        timeoutSeconds,
      });
      const confirmed = await inspectOwned(command, owned);
      if (!confirmed || confirmed.state !== 'started') {
        throw new Error('Fly Machine started lease ownership could not be confirmed.');
      }
      owned.startedInstanceId = requireIdentity(confirmed.instanceId, 'Fly Machine started instance');
      owned.startConfirmed = true;
    },

    async ownsSession(command = {}) {
      const owned = activeSession(command);
      if (!owned) return false;
      const inspected = await inspectOwned(command, owned);
      if (!inspected) return false;
      if (!owned.startedInstanceId && inspected.state === 'started') {
        owned.startedInstanceId = requireIdentity(inspected.instanceId, 'Fly Machine started instance');
        owned.startConfirmed = true;
      }
      return !owned.startedInstanceId || inspected.instanceId === owned.startedInstanceId;
    },

    async stopSessionIfOwned(command = {}) {
      const owned = activeSession(command);
      if (!owned || owned.stopAttempted) return false;
      owned.stopAttempted = true;
      const before = await inspectOwned(command, owned);
      if (!before) return false;
      let current = before;
      if (!owned.startedInstanceId && current.state === 'started') {
        owned.startedInstanceId = requireIdentity(current.instanceId, 'Fly Machine started instance');
        owned.startConfirmed = true;
      }
      if (!owned.startedInstanceId && owned.startMutationIssued && !owned.startConfirmed) {
        const bounded = apiCommand(command, owned);
        const startedDeadlineAt = recoveryDeadline(bounded.deadlineAt, monotonicNow);
        try {
          await apiClient.wait({
            ...bounded,
            deadlineAt: startedDeadlineAt,
            leaseNonce: owned.nonce,
            state: 'started',
            timeoutSeconds: waitSeconds(startedDeadlineAt, monotonicNow),
          });
        } catch {
          // The reserved half of the deadline is still available for one nonce-fenced stop.
        }
        current = await inspectOwned(command, owned);
        if (!current) return false;
        if (current.state === 'started') {
          owned.startedInstanceId = requireIdentity(current.instanceId, 'Fly Machine started instance');
          owned.startConfirmed = true;
        } else {
          const ambiguous = apiCommand(command, owned);
          await apiClient.stop({
            ...ambiguous,
            leaseNonce: owned.nonce,
            stopSignal: 'SIGINT',
            timeoutSeconds: waitSeconds(ambiguous.deadlineAt, monotonicNow),
          });
          return false;
        }
      }
      if (current.state === 'stopped' && !owned.startedInstanceId) {
        await apiClient.releaseLease({
          ...apiCommand(command, owned), leaseNonce: owned.nonce,
        });
        owned.released = true;
        return true;
      }
      if (current.state === 'stopped' && current.instanceId === owned.startedInstanceId) {
        await apiClient.releaseLease({
          ...apiCommand(command, owned), leaseNonce: owned.nonce,
        });
        owned.released = true;
        return true;
      }
      if (current.state !== 'started' || current.instanceId !== owned.startedInstanceId) return false;
      const bounded = apiCommand(command, owned);
      const timeoutSeconds = waitSeconds(bounded.deadlineAt, monotonicNow);
      await apiClient.stop({
        ...bounded,
        leaseNonce: owned.nonce,
        stopSignal: 'SIGINT',
        timeoutSeconds,
      });
      await apiClient.wait({
        ...apiCommand(command, owned),
        leaseNonce: owned.nonce,
        instanceId: owned.startedInstanceId,
        state: 'stopped',
        timeoutSeconds,
      });
      const stopped = await inspectOwned(command, owned);
      if (!stopped || stopped.state !== 'stopped'
        || stopped.instanceId !== owned.startedInstanceId) return false;
      await apiClient.releaseLease({
        ...apiCommand(command, owned), leaseNonce: owned.nonce,
      });
      owned.released = true;
      return true;
    },
  });
}
