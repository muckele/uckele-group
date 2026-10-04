#!/usr/bin/env node
import { runCimScanWorkerFaultBenchmarkEntrypoint } from '../server/services/cimScanWorkerFaultBenchmarkEntrypoint.js';

let runtime;

async function shutdown() {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  try { await runtime?.close(); } catch { process.exitCode = 1; }
}

try {
  runtime = await runCimScanWorkerFaultBenchmarkEntrypoint({ mode: 'cleanup-refusal' });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.start();
} catch {
  process.stderr.write('CIM scan cleanup-refusal benchmark worker failed closed.\n');
  process.exitCode = 1;
  await shutdown();
}
