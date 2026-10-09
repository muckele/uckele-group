const owners = new Set();

// The trusted supervisor target is supplied independently of the untrusted
// manifest. Ownership transfers only after this constructor succeeds. A
// rejected duplicate never stops the existing owner's Machine.
export function createQualificationSupervisor({ target, stopAndVerify, clock,
  maximumRuntimeMs = 900000, stopTimeoutMs = 30000 } = {}) {
  if (target?.app !== 'uckele-group-p10b' || !/^[0-9a-f]{14}$/.test(target?.machineId || '')
    || typeof stopAndVerify !== 'function' || typeof clock !== 'function'
    || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 30000) {
    throw new Error('Explicit isolated supervisor ownership is required');
  }
  const binding = Object.freeze({ app: target.app, machineId: target.machineId });
  const key = `${binding.app}:${binding.machineId}`;
  if (owners.has(key)) throw new Error('P10B qualification already has a supervisor');
  owners.add(key);
  const duration = Number.isSafeInteger(maximumRuntimeMs) && maximumRuntimeMs > 0
    ? Math.min(900000, maximumRuntimeMs) : 900000;
  const wallDeadline = Date.now() + duration;
  let permissionDeadline = Infinity;
  let active = true;
  let stopPromise;
  let watchdog;
  const abortController = new AbortController();
  const remaining = () => Math.max(0, Math.min(wallDeadline - Date.now(),
    permissionDeadline - Date.parse(new Date(clock()).toISOString())));
  const assertActive = () => {
    if (!active || remaining() <= 0) throw new Error('P10B qualification deadline reached');
  };
  const close = () => {
    active = false;
    abortController.abort();
    clearTimeout(watchdog);
    if (!stopPromise) stopPromise = (async () => {
      let timer;
      let receipt;
      try {
        receipt = await Promise.race([
          Promise.resolve().then(() => stopAndVerify(binding)),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), stopTimeoutMs); }),
        ]);
      } catch { receipt = null; }
      finally { clearTimeout(timer); }
      const stopped = receipt?.stopped === true && receipt.app === binding.app
        && receipt.machineId === binding.machineId;
      // Retain admission after uncertainty; this process cannot retry it.
      if (stopped) owners.delete(key);
      return { stoppedVerified: stopped, stopUncertain: !stopped };
    })();
    return stopPromise;
  };
  watchdog = setTimeout(() => { void close(); }, duration);
  const bounded = async (task) => {
    assertActive();
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => { assertActive(); return task(); }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => { void close(); reject(new Error('P10B qualification deadline reached')); },
            Math.max(1, remaining()));
        }),
      ]);
      assertActive();
      return value;
    } finally { clearTimeout(timer); }
  };
  return { target: binding, signal: abortController.signal, assertActive, remaining, bounded, close,
    bindDeadline(expiresAt) {
      permissionDeadline = Date.parse(expiresAt);
      if (!Number.isFinite(permissionDeadline)) throw new Error('Invalid qualification deadline');
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { void close(); }, Math.max(1, remaining()));
      assertActive();
    } };
}
