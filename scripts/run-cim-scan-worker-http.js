#!/usr/bin/env node
import { createCimScanWorkerHttpRuntime } from '../server/services/cimScanWorkerHttpRuntime.js';

let runtime;

async function shutdown() {
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  try { await runtime?.close(); } catch { process.exitCode = 1; }
}

try {
  runtime = await createCimScanWorkerHttpRuntime({ now: () => new Date() });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.start();
} catch {
  process.stderr.write('CIM scan HTTPS worker failed closed.\n');
  process.exitCode = 1;
  await shutdown();
}
