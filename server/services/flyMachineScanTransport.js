import { performance } from 'node:perf_hooks';
import { CIM_SCAN_PROTOCOL_LIMITS } from './cimScanProtocol.js';
import { isScannerPreconnectionRefusedError } from './nodePinnedHttpsExchange.js';

const maximumLeaseMs = 4 * 60 * 1000;
const maximumStartupMs = 60_000;
const maximumStartupAttempts = 17;
const initialRetryDelayMs = 250;
const maximumRetryDelayMs = 5_000;
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

async function beforeDeadline(operation, {
  deadlineAt,
  controller,
  monotonicNow = () => performance.now(),
  onTimeout,
} = {}) {
  const remaining = Math.ceil(deadlineAt - monotonicNow());
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

function startupRetryDelay(attempt) {
  return Math.min(initialRetryDelayMs * (2 ** (attempt - 1)), maximumRetryDelayMs);
}

function defaultWaitBeforeRetry({ delayMs, signal } = {}) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || !signal
    || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function' || signal.aborted) {
    return Promise.reject(new Error('Machine scan startup retry was aborted.'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Machine scan startup retry was aborted.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createFlyMachineScanTransport(options = {}) {
  validateDependencies(options);
  const { machineId, machineController, requestClient } = options;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const waitBeforeRetry = options.waitBeforeRetry ?? defaultWaitBeforeRetry;
  if (typeof monotonicNow !== 'function') throw new Error('An injected monotonic clock is required.');
  if (typeof waitBeforeRetry !== 'function') throw new Error('An injected startup retry wait is required.');
  return Object.freeze({
    async run({ requestWire, requestId, leaseExpiresAt, openByteStream } = {}) {
      if (typeof requestWire !== 'string' || !requestWire) throw new Error('Signed scan request is required.');
      if (!boundedIdentityPattern.test(String(requestId || ''))) throw new Error('Scan session generation is invalid.');
      if (typeof openByteStream !== 'function') throw new Error('A lazy attachment stream factory is required.');
      const controller = new AbortController();
      const budget = leaseBudget(leaseExpiresAt);
      const leaseDeadlineAt = monotonicNow() + budget;
      const shutdownReserveMs = Math.min(5_000, Math.max(20, Math.floor(budget / 4)));
      const workDeadlineAt = leaseDeadlineAt - shutdownReserveMs;
      const startupDeadlineAt = Math.min(workDeadlineAt, monotonicNow() + maximumStartupMs);
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
        monotonicNow,
        onTimeout: () => upload?.abort?.(),
      });
      const runStartup = (operation) => beforeDeadline(operation, {
        deadlineAt: startupDeadlineAt,
        controller,
        monotonicNow,
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
        for (let attempt = 1; attempt <= maximumStartupAttempts; attempt += 1) {
          if (await runStartup(() => machineController.ownsSession(command(startupDeadlineAt))) !== true) {
            throw new Error('Machine session generation ownership was lost before admission.');
          }
          try {
            upload = await runStartup(() => requestClient.authorize({
              ...command(startupDeadlineAt), requestWire, redirects: 'error',
              maxResponseBytes: CIM_SCAN_PROTOCOL_LIMITS.maxEnvelopeBytes,
            }));
            break;
          } catch (error) {
            if (!isScannerPreconnectionRefusedError(error) || attempt === maximumStartupAttempts) {
              throw error;
            }
            const delayMs = startupRetryDelay(attempt);
            if (startupDeadlineAt - monotonicNow() <= delayMs) {
              throw new Error('Machine scan transport exceeded its startup deadline.');
            }
            await runStartup(() => waitBeforeRetry({
              delayMs,
              deadlineAt: startupDeadlineAt,
              signal: controller.signal,
            }));
          }
        }
        if (!upload || typeof upload.sendBody !== 'function') {
          throw new Error('Worker admission did not return an upload handle.');
        }
        try {
          if (await runWork(() => machineController.ownsSession(command())) !== true) {
            throw new Error('Machine session generation ownership was lost after admission.');
          }
        } catch (error) {
          try { upload.abort?.(error); } catch { /* ownership failure remains authoritative */ }
          throw error;
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
          monotonicNow,
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
