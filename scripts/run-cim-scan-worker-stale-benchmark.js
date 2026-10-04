#!/usr/bin/env node
import { createCimScanStaleBenchmarkClock } from '../server/services/cimScanWorkerBenchmarkClock.js';
import { createCimScanWorkerHttpRuntime } from '../server/services/cimScanWorkerHttpRuntime.js';

const realNow = () => new Date();
const signatureNow = createCimScanStaleBenchmarkClock({ wallNow: realNow });
let runtime;

async function shutdown() {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  try { await runtime?.close(); } catch { process.exitCode = 1; }
}

try {
  runtime = await createCimScanWorkerHttpRuntime({ now: realNow, signatureNow });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.start();
} catch {
  process.stderr.write('CIM scan stale benchmark worker failed closed.\n');
  process.exitCode = 1;
  await shutdown();
}
