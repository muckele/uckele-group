#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  createGeneratedSyntheticScanJob,
  createSyntheticCloudScannerFactory,
  loadCimScanSyntheticCallerConfig,
  runGeneratedSyntheticScanJobs,
} from '../server/services/cimScanSyntheticCloudCaller.js';

const scenarios = Object.freeze({
  'clean-1k': 1_024,
  'clean-8m': 8 * 1024 * 1024,
  'stale-1k': 1_024,
});

async function main() {
  const scenario = process.argv[2];
  const sizeBytes = scenarios[scenario];
  if (!sizeBytes || process.argv.length !== 3) {
    throw new Error('One exact synthetic scenario is required.');
  }
  const config = loadCimScanSyntheticCallerConfig();
  const now = () => new Date();
  const createScannerComposition = await createSyntheticCloudScannerFactory({ config, now });
  const [completed] = await runGeneratedSyntheticScanJobs({
    jobs: [createGeneratedSyntheticScanJob({
      name: scenario,
      sizeBytes,
      requestId: randomUUID(),
      intakeId: randomUUID(),
      jobOwner: config.jobOwner,
      now,
    })],
    createScannerComposition,
  });
  process.stdout.write(`${JSON.stringify({
    scenario: completed.name,
    outcome: completed.result.outcome,
    reasonCode: completed.result.reasonCode,
  })}\n`);
}

main().catch(() => {
  process.stderr.write('Synthetic CIM cloud caller failed closed.\n');
  process.exitCode = 1;
});
