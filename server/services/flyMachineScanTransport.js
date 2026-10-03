import { performance } from 'node:perf_hooks';
import { CIM_SCAN_PROTOCOL_LIMITS } from './cimScanProtocol.js';

const maximumLeaseMs = 4 * 60 * 1000;
const maximumStartupMs = 60_000;
const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function validateDependencies({ machineId, machineController, requestClient } = {}) {
  if (!boundedIdentityPattern.test(String(machineId || ''))) {
    throw new Error('An explicit bounded Machine identity is required.');
  }
  const controllerMethods = ['acquireStoppedSession', 'startSession', 'ownsSession', 'stopSessionIfOwned'];
  if (!machineController || controllerMethods.some((method) => typeof machineController[method] !== 'function')) {
    throw new Error('An injected generation-fenced Machine controller is required.');
  }
  if (!requestClient || typeof requestClient.authorize !== 'function') {
    throw new Error('An injected two-phase request client is required.');
  }
}

function leaseBudget(leaseExpiresAt) {
  const expiry = Date.parse(String(leaseExpiresAt || ''));
  const remaining = expiry - Date.now();
  if (!Number.isFinite(expiry) || remaining <= 0 || remaining > maximumLeaseMs) {
    throw new Error('Machine scan lease is invalid or expired.');
  }
  return remaining;
}

async function beforeDeadline(operation, { deadlineAt, controller, onTimeout } = {}) {
  const remaining = Math.ceil(deadlineAt - performance.now());
  if (remaining <= 0) {
    const error = new Error('Machine scan transport exceeded its lease deadline.');
    controller?.abort(error);
    try { onTimeout?.(); } catch { /* deadline result remains authoritative */ }
    throw error;
  }
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Machine scan transport exceeded its lease deadline.');
      controller?.abort(error);
      try { onTimeout?.(); } catch { /* deadline result remains authoritative */ }
      reject(error);
    }, remaining);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createFlyMachineScanTransport(options = {}) {
  validateDependencies(options);
  const { machineId, machineController, requestClient } = options;
  return Object.freeze({
    async run({ requestWire, requestId, leaseExpiresAt, openByteStream } = {}) {
      if (typeof requestWire !== 'string' || !requestWire) throw new Error('Signed scan request is required.');
      if (!boundedIdentityPattern.test(String(requestId || ''))) throw new Error('Scan session generation is invalid.');
      if (typeof openByteStream !== 'function') throw new Error('A lazy attachment stream factory is required.');
      const controller = new AbortController();
      const budget = leaseBudget(leaseExpiresAt);
      const leaseDeadlineAt = performance.now() + budget;
      const shutdownReserveMs = Math.min(5_000, Math.max(20, Math.floor(budget / 4)));
      const workDeadlineAt = leaseDeadlineAt - shutdownReserveMs;
      const startupDeadlineAt = Math.min(workDeadlineAt, performance.now() + maximumStartupMs);
      let upload = null;
      let session = null;
      let resultWire;
      let stopConfirmed = false;
      const command = (deadlineAt = workDeadlineAt, signal = controller.signal) => ({
        machineId,
        sessionGeneration: requestId,
        providerGeneration: session?.providerGeneration,
        deadlineAt,
        signal,
      });
      const runWork = (operation) => beforeDeadline(operation, {
        deadlineAt: workDeadlineAt,
        controller,
        onTimeout: () => upload?.abort?.(),
      });
      const runStartup = (operation) => beforeDeadline(operation, {
        deadlineAt: startupDeadlineAt,
        controller,
        onTimeout: () => upload?.abort?.(),
      });
      try {
        session = await runStartup(() => machineController.acquireStoppedSession({
          machineId,
          sessionGeneration: requestId,
          deadlineAt: startupDeadlineAt,
          signal: controller.signal,
        }));
        if (!session || session.initialState !== 'stopped' || !boundedIdentityPattern.test(String(session.providerGeneration || ''))) {
          throw new Error('Machine did not provide a stopped generation-fenced session.');
        }
        await runStartup(() => machineController.startSession(command(startupDeadlineAt)));
        if (await runStartup(() => machineController.ownsSession(command(startupDeadlineAt))) !== true) {
          throw new Error('Machine session generation ownership was lost before admission.');
        }
        upload = await runWork(() => requestClient.authorize({
          ...command(), requestWire, redirects: 'error',
          maxResponseBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
        }));
        if (!upload || typeof upload.sendBody !== 'function') {
          throw new Error('Worker admission did not return an upload handle.');
        }
        if (await runWork(() => machineController.ownsSession(command())) !== true) {
          throw new Error('Machine session generation ownership was lost after admission.');
        }
        resultWire = await runWork(() => upload.sendBody({
          openByteStream,
          deadlineAt: workDeadlineAt,
          signal: controller.signal,
          maxResponseBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
        }));
        if (typeof resultWire !== 'string'
          || Buffer.byteLength(resultWire, 'utf8') > CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes) {
          throw new Error('Machine scan response exceeds the bounded envelope size.');
        }
      } finally {
        const shutdownController = new AbortController();
        const shutdownCommand = () => command(leaseDeadlineAt, shutdownController.signal);
        const runShutdown = (operation) => beforeDeadline(operation, {
          deadlineAt: leaseDeadlineAt,
          controller: shutdownController,
        });
        if (session && await runShutdown(() => machineController.ownsSession(shutdownCommand())).catch(() => false)) {
          stopConfirmed = await runShutdown(
            () => machineController.stopSessionIfOwned(shutdownCommand()),
          ).catch(() => false);
        }
      }
      return { resultWire, stopConfirmed };
    },
  });
}
