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
  expectedImageDigest,
  appName,
  port,
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
  resultNow = now,
  requestMaxDurationMs = 90_000,
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
    expectedImageDigest,
    apiClient,
    wallNowMs,
    monotonicNow,
  });
  const openExchange = createNodePinnedHttpsExchange({
    machineId,
    appName,
    port,
    monotonicNow,
    requestImpl,
  });
  const requestClient = createPinnedHttpScanRequestClient({
    endpoint: `https://${machineId}.vm.${appName}.internal:${port}/v1/cim-scan`,
    certificatePinSha256,
    openExchange,
  });
  const transport = createFlyMachineScanTransport({
    machineId,
    machineController,
    requestClient,
    monotonicNow,
  });
  const scanner = createOnDemandScannerAdapter({
    keyId,
    keyResolver,
    transport,
    now,
    resultNow,
    requestMaxDurationMs,
  });
  return Object.freeze({ scanner });
}

export function createCimScanWorkerHttpComposition({
  keyResolver,
  replayStore,
  ephemeralRoot,
  scanner,
  now,
  signatureNow = now,
  runTask,
} = {}) {
  const handleCheckContinue = createCimScanWorkerCheckContinueHandler({
    keyResolver,
    replayStore,
    admission: createSingleCimScanAdmission(),
    ephemeralRoot,
    scanner,
    now,
    signatureNow,
    ...(runTask === undefined ? {} : { runTask }),
  });
  return Object.freeze({ handleCheckContinue });
}
