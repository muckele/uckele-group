import { createFlyMachineLeaseController } from './flyMachineLeaseController.js';
import { createPinnedHttpScanRequestClient } from './flyMachineOperabilityAdapters.js';
import { createFlyMachineScanTransport } from './flyMachineScanTransport.js';
import { createFlyMachinesApiClient } from './flyMachinesApiClient.js';
import { createNodePinnedHttpsExchange } from './nodePinnedHttpsExchange.js';
import { createOnDemandScannerAdapter } from './onDemandCimScanner.js';
import { createCimScanWorkerCheckContinueHandler } from './cimScanWorkerHttp.js';
import { createSingleCimScanAdmission } from './cimScanWorkerAdmission.js';

export function createFlyCimScannerComposition({
  machineId,
  appName,
  apiBaseUrl,
  accessToken,
  apiMaxResponseBytes,
  fetchImpl,
  wallNowMs,
  monotonicNow,
  certificatePinSha256,
  requestImpl,
  keyId,
  keyResolver,
  now,
} = {}) {
  if (typeof now !== 'function') throw new Error('An explicit scanner clock is required.');
  const apiClient = createFlyMachinesApiClient({
    apiBaseUrl,
    appName,
    machineId,
    accessToken,
    maxResponseBytes: apiMaxResponseBytes,
    fetchImpl,
  });
  const machineController = createFlyMachineLeaseController({
    machineId,
    apiClient,
    wallNowMs,
    monotonicNow,
  });
  const openExchange = createNodePinnedHttpsExchange({
    machineId,
    appName,
    monotonicNow,
    requestImpl,
  });
  const requestClient = createPinnedHttpScanRequestClient({
    endpoint: `https://${machineId}.vm.${appName}.internal/v1/cim-scan`,
    certificatePinSha256,
    openExchange,
  });
  const transport = createFlyMachineScanTransport({
    machineId,
    machineController,
    requestClient,
  });
  const scanner = createOnDemandScannerAdapter({
    keyId,
    keyResolver,
    transport,
    now,
  });
  return Object.freeze({ scanner });
}

export function createCimScanWorkerHttpComposition({
  keyResolver,
  replayStore,
  ephemeralRoot,
  scanner,
  now,
  runTask,
} = {}) {
  const handleCheckContinue = createCimScanWorkerCheckContinueHandler({
    keyResolver,
    replayStore,
    admission: createSingleCimScanAdmission(),
    ephemeralRoot,
    scanner,
    now,
    ...(runTask === undefined ? {} : { runTask }),
  });
  return Object.freeze({ handleCheckContinue });
}
