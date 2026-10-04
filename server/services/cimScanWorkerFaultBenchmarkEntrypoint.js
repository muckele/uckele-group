import { createCimScanWorkerHttpComposition } from './cimScanComposition.js';
import { createCimScanWorkerHttpRuntime } from './cimScanWorkerHttpRuntime.js';
import { createCimScanWorkerFaultBenchmarkRunTask } from './cimScanWorkerFaultBenchmark.js';

export async function runCimScanWorkerFaultBenchmarkEntrypoint({
  mode,
  now = () => new Date(),
  createRuntime = createCimScanWorkerHttpRuntime,
  terminateProcess,
} = {}) {
  if (typeof now !== 'function' || typeof createRuntime !== 'function') {
    throw new Error('CIM scan fault benchmark runtime dependencies are required.');
  }
  const runTask = createCimScanWorkerFaultBenchmarkRunTask({
    mode,
    ...(terminateProcess === undefined ? {} : { terminateProcess }),
  });
  return createRuntime({
    now,
    createWorkerComposition(options) {
      return createCimScanWorkerHttpComposition({ ...options, runTask });
    },
  });
}
