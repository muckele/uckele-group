#!/usr/bin/env node
import { runCimScanWorkerEntrypoint } from '../server/services/cimScanWorkerEntrypoint.js';

runCimScanWorkerEntrypoint().catch(() => {
  process.stderr.write('CIM scan worker failed closed.\n');
  process.exitCode = 1;
});
