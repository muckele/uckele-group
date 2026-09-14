import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getConfig } from '../server/config.js';
import { DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION } from '../server/repairs/dealHunterCrmIntegrityF02Repair2.js';
import {
  applyDealHunterCrmIntegrityF02Repair2,
  inspectDealHunterCrmIntegrityF02Repair2,
} from '../server/services/dealHunterCrmIntegrityF02Repair2.js';

const commandName = 'deal-hunter-crm-integrity-f02-repair2';

function assertSingleOccurrence(args, flag) {
  const count = args.filter((value) => value === flag || value.startsWith(`${flag}=`)).length;
  if (count > 1) throw new Error(`Provide ${flag} exactly once.`);
}

function required(values, key, flag) {
  const value = String(values[key] || '').trim();
  if (!value) throw new Error(`Provide ${flag}.`);
  return value;
}

export function parseDealHunterCrmIntegrityF02Repair2Args(args = []) {
  const acceptedFlags = [
    '--apply',
    '--actor',
    '--reason',
    '--execution-release',
    '--tooling-revision',
    '--expected-plan-checksum',
    '--reviewed-manifest',
    '--backup',
    '--confirm',
    '--prior-receipt',
  ];
  for (const flag of acceptedFlags) assertSingleOccurrence(args, flag);
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      apply: { type: 'boolean', default: false },
      actor: { type: 'string', default: '' },
      reason: { type: 'string', default: '' },
      'execution-release': { type: 'string', default: '' },
      'tooling-revision': { type: 'string', default: '' },
      'expected-plan-checksum': { type: 'string', default: '' },
      'reviewed-manifest': { type: 'string', default: '' },
      backup: { type: 'string', default: '' },
      confirm: { type: 'string', default: '' },
      'prior-receipt': { type: 'string', default: '' },
    },
  });
  const parsed = {
    apply: values.apply,
    actor: required(values, 'actor', '--actor NAME'),
    reason: required(values, 'reason', '--reason TEXT'),
    executionRelease: required(values, 'execution-release', '--execution-release RELEASE'),
    toolingRevision: required(values, 'tooling-revision', '--tooling-revision REVISION'),
    expectedPlanChecksum: String(values['expected-plan-checksum'] || '').trim(),
    reviewedManifestPath: String(values['reviewed-manifest'] || '').trim(),
    backupPath: String(values.backup || '').trim(),
    confirmation: String(values.confirm || ''),
    priorReceiptPath: String(values['prior-receipt'] || '').trim(),
  };
  if (!parsed.apply) return parsed;
  if (!/^[a-f0-9]{64}$/.test(parsed.expectedPlanChecksum)) {
    throw new Error('Apply requires --expected-plan-checksum with the exact reviewed lowercase SHA-256 value.');
  }
  if (!parsed.reviewedManifestPath) {
    throw new Error('Apply requires --reviewed-manifest PATH.');
  }
  if (!parsed.backupPath) throw new Error('Apply requires --backup PATH.');
  if (parsed.confirmation !== DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION) {
    throw new Error(`Apply requires --confirm ${DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION}.`);
  }
  return parsed;
}

function readJsonArtifact(reference, label) {
  if (!reference) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(reference), 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be loaded as JSON: ${error.message}`);
  }
}

export async function runDealHunterCrmIntegrityF02Repair2Cli({
  argv = process.argv.slice(2),
  getConfigFn = getConfig,
  authority,
  generatedAt,
  completedAt,
} = {}) {
  const options = parseDealHunterCrmIntegrityF02Repair2Args(argv);
  const config = getConfigFn();
  const provider = config?.storage?.provider || '';
  const databasePath = config?.storage?.sqlitePath || '';
  const receiptArtifact = readJsonArtifact(options.priorReceiptPath, 'Prior execution receipt');
  const receipt = receiptArtifact?.receipt || receiptArtifact;
  const common = {
    databasePath,
    provider,
    actor: options.actor,
    reason: options.reason,
    executionRelease: options.executionRelease,
    toolingRevision: options.toolingRevision,
    receipt,
    ...(authority ? { authority } : {}),
  };
  if (!options.apply) {
    return inspectDealHunterCrmIntegrityF02Repair2({
      ...common,
      ...(generatedAt ? { generatedAt } : {}),
    });
  }
  const reviewedArtifact = readJsonArtifact(options.reviewedManifestPath, 'Reviewed approval manifest');
  return applyDealHunterCrmIntegrityF02Repair2({
    ...common,
    reviewedManifest: reviewedArtifact?.approvalManifest || reviewedArtifact,
    expectedPlanChecksum: options.expectedPlanChecksum,
    confirmation: options.confirmation,
    backupPath: path.resolve(options.backupPath),
    ...(completedAt ? { completedAt } : {}),
  });
}

async function main() {
  const result = await runDealHunterCrmIntegrityF02Repair2Cli();
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'refused') process.exitCode = 2;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`[${commandName}] ${error.message}`);
    process.exitCode = 1;
  });
}
