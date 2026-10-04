#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  createSyntheticCloudScannerFactory,
  loadCimScanSyntheticCallerConfig,
} from '../server/services/cimScanSyntheticCloudCaller.js';
import {
  CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS,
  runCimScanCloudBenchmarkScenario,
} from '../server/services/cimScanCloudBenchmark.js';

async function main() {
  const scenario = process.argv[2];
  if (!CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS.includes(scenario) || process.argv.length !== 3) {
    throw new Error('One exact synthetic scenario is required.');
  }
  const config = loadCimScanSyntheticCallerConfig();
  const now = () => new Date();
  const createScannerComposition = await createSyntheticCloudScannerFactory({ config, now });
  const completed = await runCimScanCloudBenchmarkScenario({
    scenario,
    jobOwner: config.jobOwner,
    createScannerComposition,
    createUuid: randomUUID,
    now,
  });
  process.stdout.write(`${JSON.stringify(completed)}\n`);
}

main().catch(() => {
  process.stderr.write('Synthetic CIM cloud caller failed closed.\n');
  process.exitCode = 1;
});
