import { runOnDemandScanTask } from './cimScanWorker.js';

export const CIM_SCAN_WORKER_FAULT_MODES = Object.freeze([
  'after-copy-crash',
  'after-scan-crash',
  'cleanup-refusal',
]);

function defaultTerminateProcess() {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('Benchmark worker process termination did not exit.');
}

export function createCimScanWorkerFaultBenchmarkRunTask({
  mode,
  terminateProcess = defaultTerminateProcess,
} = {}) {
  if (!CIM_SCAN_WORKER_FAULT_MODES.includes(mode)) {
    throw new Error('One exact CIM scan benchmark fault mode is required.');
  }
  if (typeof terminateProcess !== 'function') {
    throw new Error('CIM scan benchmark process terminator is required.');
  }
  const terminate = () => terminateProcess();
  return (options = {}) => runOnDemandScanTask({
    ...options,
    ...(mode === 'after-copy-crash' ? { afterCopy: terminate } : {}),
    ...(mode === 'after-scan-crash' ? { afterScan: terminate } : {}),
    ...(mode === 'cleanup-refusal'
      ? { cleanupOwnedTask: async () => Object.freeze({ cleaned: false }) }
      : {}),
  });
}
