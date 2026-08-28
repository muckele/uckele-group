import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
  getCanonicalOpportunityMergeApproval,
} from '../server/repairs/canonicalOpportunityMerge.js';
import { getConfig } from '../server/config.js';
import { verifyBackupBundle } from '../server/services/backups.js';
import { runCanonicalOpportunityMergeRepair } from '../server/services/canonicalOpportunityMergeRepair.js';
import { getStorage } from '../server/storage/index.js';
import { createSqliteCanonicalOpportunityMergeReadOnlyStorage } from '../server/storage/sqlite.js';

const commandName = 'canonical-opportunity-merge-repair';

function required(values, key, flag) {
  const value = String(values[key] || '').trim();
  if (!value) throw new Error(`Provide ${flag}.`);
  return value;
}

function assertSingleOccurrence(args, flag) {
  if (args.filter((value) => value === flag || value.startsWith(`${flag}=`)).length > 1) {
    throw new Error(`Provide ${flag} exactly once.`);
  }
}

export function parseCanonicalOpportunityMergeArgs(args = []) {
  const optionNames = [
    '--apply',
    '--exception-id',
    '--survivor-id',
    '--superseded-id',
    '--actor',
    '--reason',
    '--expected-plan-checksum',
    '--backup',
    '--confirm',
  ];
  for (const optionName of optionNames) assertSingleOccurrence(args, optionName);
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      apply: { type: 'boolean', default: false },
      'exception-id': { type: 'string', default: '' },
      'survivor-id': { type: 'string', default: '' },
      'superseded-id': { type: 'string', default: '' },
      actor: { type: 'string', default: '' },
      reason: { type: 'string', default: '' },
      'expected-plan-checksum': { type: 'string', default: '' },
      backup: { type: 'string', default: '' },
      confirm: { type: 'string', default: '' },
    },
  });
  const parsed = {
    apply: values.apply,
    exceptionId: required(values, 'exception-id', '--exception-id ID'),
    survivorId: required(values, 'survivor-id', '--survivor-id ID'),
    supersededId: required(values, 'superseded-id', '--superseded-id ID'),
    actor: required(values, 'actor', '--actor NAME'),
    reason: required(values, 'reason', '--reason TEXT'),
    expectedPlanChecksum: String(values['expected-plan-checksum'] || '').trim(),
    backupReference: String(values.backup || '').trim(),
    confirmation: String(values.confirm || ''),
  };
  if (!parsed.apply) return parsed;
  if (!parsed.expectedPlanChecksum) {
    throw new Error('Apply requires --expected-plan-checksum CHECKSUM from the reviewed dry run.');
  }
  if (!/^[a-f0-9]{64}$/.test(parsed.expectedPlanChecksum)) {
    throw new Error('Apply requires an exact lowercase 64-character plan checksum.');
  }
  if (!parsed.backupReference) throw new Error('Apply requires --backup PATH.');
  if (!parsed.confirmation) throw new Error('Apply requires --confirm with the exact confirmation phrase.');
  if (parsed.confirmation !== CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION) {
    throw new Error(`Apply requires --confirm "${CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION}".`);
  }
  return parsed;
}

export async function runCanonicalOpportunityMergeCli({
  argv = process.argv.slice(2),
  getConfigFn = getConfig,
  getStorageFn = getStorage,
  createReadOnlyStorageFn = createSqliteCanonicalOpportunityMergeReadOnlyStorage,
  verifyBackupBundleFn = verifyBackupBundle,
  runRepairFn = runCanonicalOpportunityMergeRepair,
} = {}) {
  const options = parseCanonicalOpportunityMergeArgs(argv);
  const config = getConfigFn();
  if (config?.storage?.provider !== 'sqlite') {
    throw new Error('Canonical opportunity merge repair is SQLite-only and refused the active storage provider.');
  }
  getCanonicalOpportunityMergeApproval({
    exceptionId: options.exceptionId,
    survivorId: options.survivorId,
    supersededId: options.supersededId,
  });

  if (!options.apply) {
    const storage = createReadOnlyStorageFn(config);
    try {
      if (storage?.provider !== 'sqlite') {
        throw new Error('Canonical opportunity merge repair is SQLite-only and refused the active storage provider.');
      }
      return await runRepairFn({
        apply: false,
        exceptionId: options.exceptionId,
        survivorId: options.survivorId,
        supersededId: options.supersededId,
        actor: options.actor,
        reason: options.reason,
        confirmation: options.confirmation,
        expectedPlanChecksum: options.expectedPlanChecksum,
        backupVerification: null,
        storage,
      });
    } finally {
      storage?.close?.();
    }
  }

  const backupVerification = await verifyBackupBundleFn(path.resolve(options.backupReference));
  if (!backupVerification?.ok) {
    const errors = Array.isArray(backupVerification?.errors) ? backupVerification.errors.slice(0, 3) : [];
    throw new Error(`Backup verification failed${errors.length ? `: ${errors.join('; ')}` : '.'}`);
  }
  const storage = getStorageFn();
  if (storage?.provider !== 'sqlite') {
    throw new Error('Canonical opportunity merge repair is SQLite-only and refused the active storage provider.');
  }
  return runRepairFn({
    apply: true,
    exceptionId: options.exceptionId,
    survivorId: options.survivorId,
    supersededId: options.supersededId,
    actor: options.actor,
    reason: options.reason,
    confirmation: options.confirmation,
    expectedPlanChecksum: options.expectedPlanChecksum,
    backupVerification,
    storage,
  });
}

async function main() {
  const result = await runCanonicalOpportunityMergeCli();
  console.log(JSON.stringify(result, null, 2));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`[${commandName}] ${error.message}`);
    process.exitCode = 1;
  });
}
