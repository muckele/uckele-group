import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';

import { getConfig } from '../server/config.js';
import {
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
  stableCanonicalJson,
  validateCrmDuplicateConsolidationCheckpointEvidence,
} from '../server/repairs/crmDuplicateConsolidation.js';
import {
  applyCrmDuplicateConsolidation,
  previewCrmDuplicateConsolidation,
  verifyCrmDuplicateConsolidationReviewedArtifact,
} from '../server/services/crmDuplicateConsolidationRepair.js';
import { getStorage } from '../server/storage/index.js';
import { createSqliteCrmDuplicateConsolidationReadOnlyStorage } from '../server/storage/sqlite.js';

const commandName = 'crm-duplicate-consolidation';
const sha256Pattern = /^[a-f0-9]{64}$/;
const toolingRevisionPattern = /^[a-f0-9]{40,64}$/;
const checkpointEvidenceMaximumBytes = 64 * 1024;

function assertSingleOccurrence(args, flag) {
  const count = args.filter((value) => value === flag || value.startsWith(`${flag}=`)).length;
  if (count > 1) throw new Error(`Provide ${flag} exactly once.`);
}

function required(values, key, flag) {
  const value = String(values[key] || '').trim();
  if (!value) throw new Error(`Provide ${flag}.`);
  return value;
}

function requireSha256(value, flag) {
  if (!sha256Pattern.test(value)) {
    throw new Error(`${flag} requires an exact lowercase 64-character SHA-256 value.`);
  }
}

export function parseCrmDuplicateConsolidationArgs(args = []) {
  const acceptedFlags = [
    '--apply',
    '--actor',
    '--reason',
    '--execution-release',
    '--tooling-revision',
    '--reviewed-manifest',
    '--expected-plan-checksum',
    '--manifest-id',
    '--backup-path',
    '--backup-manifest-id',
    '--backup-sha256',
    '--checkpoint-evidence',
    '--confirm',
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
      'reviewed-manifest': { type: 'string', default: '' },
      'expected-plan-checksum': { type: 'string', default: '' },
      'manifest-id': { type: 'string', default: '' },
      'backup-path': { type: 'string', default: '' },
      'backup-manifest-id': { type: 'string', default: '' },
      'backup-sha256': { type: 'string', default: '' },
      'checkpoint-evidence': { type: 'string', default: '' },
      confirm: { type: 'string', default: '' },
    },
  });

  const parsed = {
    apply: values.apply,
    actor: required(values, 'actor', '--actor NAME'),
    reason: required(values, 'reason', '--reason TEXT'),
    executionRelease: required(values, 'execution-release', '--execution-release RELEASE'),
    toolingRevision: required(values, 'tooling-revision', '--tooling-revision REVISION'),
    reviewedManifestPath: String(values['reviewed-manifest'] || '').trim(),
    expectedPlanChecksum: String(values['expected-plan-checksum'] || '').trim(),
    manifestId: String(values['manifest-id'] || '').trim(),
    backupPath: path.resolve(required(values, 'backup-path', '--backup-path PATH')),
    backupManifestId: required(values, 'backup-manifest-id', '--backup-manifest-id ID'),
    backupSha256: String(values['backup-sha256'] || ''),
    checkpointEvidencePath: path.resolve(required(
      values,
      'checkpoint-evidence',
      '--checkpoint-evidence PATH',
    )),
    confirmation: String(values.confirm || ''),
  };
  if (parsed.reason.length < 20) throw new Error('--reason requires at least 20 characters.');
  if (!toolingRevisionPattern.test(parsed.toolingRevision)) {
    throw new Error('--tooling-revision requires an exact lowercase 40- to 64-character SHA.');
  }
  requireSha256(parsed.backupSha256, '--backup-sha256');

  if (!parsed.apply) return parsed;
  if (!parsed.reviewedManifestPath) throw new Error('Apply requires --reviewed-manifest PATH.');
  if (!parsed.expectedPlanChecksum) {
    throw new Error('Apply requires --expected-plan-checksum SHA256.');
  }
  requireSha256(parsed.expectedPlanChecksum, '--expected-plan-checksum');
  if (!parsed.manifestId) throw new Error('Apply requires --manifest-id ID.');
  if (!parsed.confirmation) throw new Error('Apply requires --confirm TEXT.');
  return parsed;
}

function loadAndValidateCheckpointEvidence(options) {
  let pathStats;
  try {
    pathStats = fs.statSync(options.checkpointEvidencePath);
  } catch (error) {
    throw new Error(`Checkpoint evidence could not be read or does not exist: ${error.message}`);
  }
  if (!pathStats.isFile()) {
    throw new Error('Checkpoint evidence path must identify a regular file.');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      options.checkpointEvidencePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(`Checkpoint evidence could not be read or does not exist: ${error.message}`);
  }
  let bytes;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Checkpoint evidence path must identify a regular file.');
    if (stats.size === 0) throw new Error('Checkpoint evidence file is empty.');
    if (stats.size > checkpointEvidenceMaximumBytes) {
      throw new Error('Checkpoint evidence file is too large; maximum size is 64 KiB.');
    }
    bytes = fs.readFileSync(descriptor);
    if (bytes.length === 0) throw new Error('Checkpoint evidence file is empty.');
    if (bytes.length > checkpointEvidenceMaximumBytes) {
      throw new Error('Checkpoint evidence file is too large; maximum size is 64 KiB.');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Checkpoint evidence file is not valid UTF-8.');
  }
  let evidence;
  try {
    evidence = JSON.parse(source);
  } catch {
    throw new Error('Checkpoint evidence file is not valid JSON.');
  }
  return validateCrmDuplicateConsolidationCheckpointEvidence({
    evidence,
    expectedExecutionRelease: options.executionRelease,
    expectedToolingRevision: options.toolingRevision,
    expectedBackup: {
      path: options.backupPath,
      manifestId: options.backupManifestId,
      sha256: options.backupSha256,
    },
  });
}

function loadAndVerifyReviewedArtifact(options, suppliedCheckpointEvidence) {
  const artifactPath = path.resolve(options.reviewedManifestPath);
  let artifactBytes;
  try {
    artifactBytes = fs.readFileSync(artifactPath, 'utf8');
  } catch (error) {
    throw new Error(`Reviewed manifest could not be read: ${error.message}`);
  }
  const artifact = verifyCrmDuplicateConsolidationReviewedArtifact({
    artifact: artifactBytes,
    expectedPlanChecksum: options.expectedPlanChecksum,
    expectedManifestId: options.manifestId,
  });
  const reviewedCheckpointEvidence = validateCrmDuplicateConsolidationCheckpointEvidence({
    evidence: {
      schema: CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
      checkpoint: {
        ...artifact.plan.recoveryCheckpoint,
        backupPath: artifact.recoveryCheckpointPath,
      },
    },
    expectedExecutionRelease: artifact.plan.execution?.release,
    expectedToolingRevision: artifact.plan.execution?.toolingRevision,
  });
  if (reviewedCheckpointEvidence.digest !== suppliedCheckpointEvidence.digest
    || reviewedCheckpointEvidence.canonicalJson !== suppliedCheckpointEvidence.canonicalJson) {
    throw new Error('Reviewed artifact checkpoint evidence does not exactly match the supplied evidence.');
  }
  if (artifact.plan.actor !== options.actor) {
    throw new Error('Apply requires --actor to match the reviewed manifest exactly.');
  }
  if (artifact.plan.reason !== options.reason) {
    throw new Error('Apply requires --reason to match the reviewed manifest exactly.');
  }
  if (artifact.plan.execution?.release !== options.executionRelease
    || artifact.plan.recoveryCheckpoint?.flyRelease !== options.executionRelease) {
    throw new Error('Apply requires --execution-release to match the reviewed manifest exactly.');
  }
  if (artifact.plan.execution?.toolingRevision !== options.toolingRevision) {
    throw new Error('Apply requires --tooling-revision to match the reviewed manifest exactly.');
  }
  if (artifact.recoveryCheckpointPath !== options.backupPath) {
    throw new Error('Apply requires --backup-path to match the reviewed manifest exactly.');
  }
  if (artifact.plan.recoveryCheckpoint?.backupManifestId !== options.backupManifestId) {
    throw new Error('Apply requires --backup-manifest-id to match the reviewed manifest exactly.');
  }
  if (artifact.plan.recoveryCheckpoint?.backupSha256 !== options.backupSha256) {
    throw new Error('Apply requires --backup-sha256 to match the reviewed manifest exactly.');
  }
  return { artifact, artifactBytes };
}

export async function runCrmDuplicateConsolidationCli({
  argv = process.argv.slice(2),
  getConfigFn = getConfig,
  getStorageFn = getStorage,
  createReadOnlyStorageFn = createSqliteCrmDuplicateConsolidationReadOnlyStorage,
  previewFn = previewCrmDuplicateConsolidation,
  applyFn = applyCrmDuplicateConsolidation,
} = {}) {
  const options = parseCrmDuplicateConsolidationArgs(argv);
  const checkpointEvidence = loadAndValidateCheckpointEvidence(options);
  const reviewed = options.apply
    ? loadAndVerifyReviewedArtifact(options, checkpointEvidence)
    : null;
  if (options.apply && options.confirmation !== CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION) {
    throw new Error(`Apply requires exact confirmation ${CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION}.`);
  }
  const config = getConfigFn();
  if (config?.storage?.provider !== 'sqlite') {
    throw new Error('CRM duplicate consolidation is SQLite-only and refused the active storage provider.');
  }

  if (!options.apply) {
    const storage = createReadOnlyStorageFn(config);
    try {
      const result = await previewFn({
        storage,
        actor: options.actor,
        reason: options.reason,
        executionRelease: options.executionRelease,
        toolingRevision: options.toolingRevision,
        recoveryCheckpoint: checkpointEvidence.checkpoint,
      });
      return {
        ...result,
        checkpointEvidence: {
          schema: CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
          digest: checkpointEvidence.digest,
        },
      };
    } finally {
      storage?.close?.();
    }
  }

  const { artifactBytes } = reviewed;
  const backup = {
    path: checkpointEvidence.checkpoint.backupPath,
    manifestId: checkpointEvidence.checkpoint.backupManifestId,
    sha256: checkpointEvidence.checkpoint.backupSha256,
    flySnapshotId: checkpointEvidence.checkpoint.flySnapshotId,
    flySnapshotDigest: checkpointEvidence.checkpoint.flySnapshotDigest,
  };
  const storage = getStorageFn();
  try {
    if (storage?.provider !== 'sqlite') {
      throw new Error('CRM duplicate consolidation is SQLite-only and refused writable storage.');
    }
    return await applyFn({
      apply: true,
      storage,
      reviewedArtifact: artifactBytes,
      expectedPlanChecksum: options.expectedPlanChecksum,
      expectedManifestId: options.manifestId,
      backup,
      actor: options.actor,
      reason: options.reason,
      executionRelease: options.executionRelease,
      toolingRevision: options.toolingRevision,
      confirmation: options.confirmation,
    });
  } finally {
    storage?.close?.();
  }
}

async function main() {
  const isPreview = !process.argv.slice(2).includes('--apply');
  const result = await runCrmDuplicateConsolidationCli();
  if (isPreview) {
    process.stderr.write(`[${commandName}] preview mode completed with zero business mutation\n`);
  } else {
    process.stderr.write(`[${commandName}] separately authorized operation completed\n`);
  }
  process.stdout.write(stableCanonicalJson(result));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`[${commandName}] ${error.message}\n`);
    process.exitCode = 1;
  });
}
