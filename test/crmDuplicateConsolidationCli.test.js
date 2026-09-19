import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  stableCanonicalJson,
} from '../server/repairs/crmDuplicateConsolidation.js';
import {
  parseCrmDuplicateConsolidationArgs,
  runCrmDuplicateConsolidationCli,
} from '../scripts/repair-crm-duplicate-consolidation.js';
import {
  ACTOR,
  REASON,
  RELEASE,
  TOOLING,
  createFixture,
  logicalSnapshot,
  previewFixture,
} from './crmDuplicateConsolidationRepair.test.js';

const cliPath = path.resolve('scripts/repair-crm-duplicate-consolidation.js');
const nodePath = process.env.TASK9_NODE_PATH || process.execPath;

function previewArgs(fixture) {
  return [
    '--actor', ACTOR,
    '--reason', REASON,
    '--execution-release', RELEASE,
    '--tooling-revision', TOOLING,
    '--backup-path', fixture.recoveryCheckpoint.backupPath,
    '--backup-manifest-id', fixture.recoveryCheckpoint.backupManifestId,
    '--backup-sha256', fixture.recoveryCheckpoint.backupSha256,
  ];
}

function checkpointEnvironment(fixture) {
  return {
    CRM_DUPLICATE_CONSOLIDATION_FLY_SNAPSHOT_ID: fixture.recoveryCheckpoint.flySnapshotId,
    CRM_DUPLICATE_CONSOLIDATION_FLY_SNAPSHOT_DIGEST: fixture.recoveryCheckpoint.flySnapshotDigest,
    CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_CREATED_AT: fixture.recoveryCheckpoint.createdAt,
    CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_VERIFIED_AT: fixture.recoveryCheckpoint.verifiedAt,
  };
}

function applyArgs(fixture, artifactPath, artifact) {
  return [
    '--apply',
    ...previewArgs(fixture),
    '--reviewed-manifest', artifactPath,
    '--expected-plan-checksum', artifact.planChecksum,
    '--manifest-id', artifact.manifestId,
    '--confirm', CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  ];
}

test('default CLI preview emits one canonical private JSON artifact on stdout and never mutates', async (t) => {
  const fixture = await createFixture(t);
  fixture.storage.close();
  const before = logicalSnapshot(fixture.sqlitePath);

  const result = spawnSync(nodePath, [cliPath, ...previewArgs(fixture)], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      STORAGE_PROVIDER: 'sqlite',
      SQLITE_PATH: fixture.sqlitePath,
      ...checkpointEnvironment(fixture),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr, '');
  assert.match(result.stderr, /preview mode/i);
  assert.doesNotMatch(result.stderr, /--apply|APPLY-UG-P7-01D/i);
  const artifact = JSON.parse(result.stdout);
  assert.equal(result.stdout, stableCanonicalJson(artifact));
  assert.equal(artifact.mode, 'preview');
  assert.equal(artifact.applied, false);
  assert.deepEqual(artifact.connection, {
    readonly: true,
    fileMustExist: true,
    queryOnly: true,
    consistentReadTransaction: true,
  });
  assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  assert.doesNotMatch(
    result.stdout,
    /private note|private message|private metadata|private-broker@|document path|rawMetadata|password|secret/i,
  );
});

test('CLI accepts only the fixed incident operator flags and rejects arbitrary selectors and actions', () => {
  const forbidden = [
    '--survivor',
    '--survivor-id',
    '--loser',
    '--superseded-id',
    '--opportunity',
    '--opportunity-id',
    '--pair',
    '--pair-list',
    '--reverse',
    '--cleanup',
    '--reconcile',
    '--reconciliation',
    '--send',
    '--sql',
    '--query',
  ];
  for (const flag of forbidden) {
    assert.throws(
      () => parseCrmDuplicateConsolidationArgs([flag, 'arbitrary']),
      /unknown option|unexpected argument/i,
      flag,
    );
  }
});

test('apply requires every reviewed-artifact argument and exact confirmation before writable storage opens', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const artifactPath = path.join(fixture.root, 'reviewed-artifact.json');
  fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
  const complete = applyArgs(fixture, artifactPath, artifact);
  const requiredFlags = [
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
    '--confirm',
  ];

  for (const omitted of requiredFlags) {
    const index = complete.indexOf(omitted);
    const argv = complete.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
    let writableStorageCalls = 0;
    await assert.rejects(
      runCrmDuplicateConsolidationCli({
        argv,
        env: checkpointEnvironment(fixture),
        getConfigFn: () => fixture.config,
        getStorageFn: () => {
          writableStorageCalls += 1;
          throw new Error('writable storage must not open');
        },
      }),
      /requires|provide|exact|missing|invalid/i,
      omitted,
    );
    assert.equal(writableStorageCalls, 0, omitted);
  }

  const wrongConfirmation = [...complete];
  wrongConfirmation[wrongConfirmation.indexOf('--confirm') + 1] = 'not-authorized';
  let writableStorageCalls = 0;
  await assert.rejects(
    runCrmDuplicateConsolidationCli({
      argv: wrongConfirmation,
      env: checkpointEnvironment(fixture),
      getConfigFn: () => fixture.config,
      getStorageFn: () => {
        writableStorageCalls += 1;
        throw new Error('writable storage must not open');
      },
    }),
    /exact confirmation/i,
  );
  assert.equal(writableStorageCalls, 0);
});

test('apply byte-validates the reviewed artifact before opening storage and delegates only fixed authority', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const artifactPath = path.join(fixture.root, 'reviewed-artifact.json');
  fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
  const argv = applyArgs(fixture, artifactPath, artifact);
  const fakeStorage = { provider: 'sqlite', close() {} };
  let writableStorageCalls = 0;
  let delegated;
  const result = await runCrmDuplicateConsolidationCli({
    argv,
    env: checkpointEnvironment(fixture),
    getConfigFn: () => fixture.config,
    getStorageFn: () => {
      writableStorageCalls += 1;
      return fakeStorage;
    },
    applyFn: async (input) => {
      delegated = input;
      return { status: 'repair-required', applied: true, mutationCount: 4 };
    },
  });

  assert.equal(writableStorageCalls, 1);
  assert.deepEqual(result, { status: 'repair-required', applied: true, mutationCount: 4 });
  assert.equal(delegated.storage, fakeStorage);
  assert.equal(delegated.reviewedArtifact, stableCanonicalJson(artifact));
  assert.equal(delegated.expectedPlanChecksum, artifact.planChecksum);
  assert.equal(delegated.expectedManifestId, artifact.manifestId);
  assert.deepEqual(delegated.backup, {
    path: fixture.recoveryCheckpoint.backupPath,
    manifestId: fixture.recoveryCheckpoint.backupManifestId,
    sha256: fixture.recoveryCheckpoint.backupSha256,
    flySnapshotId: fixture.recoveryCheckpoint.flySnapshotId,
    flySnapshotDigest: fixture.recoveryCheckpoint.flySnapshotDigest,
  });
  assert.equal(delegated.confirmation, CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION);

  fs.writeFileSync(artifactPath, `${stableCanonicalJson(artifact)}\n`, { mode: 0o600 });
  writableStorageCalls = 0;
  await assert.rejects(
    runCrmDuplicateConsolidationCli({
      argv,
      env: checkpointEnvironment(fixture),
      getConfigFn: () => fixture.config,
      getStorageFn: () => {
        writableStorageCalls += 1;
        return fakeStorage;
      },
      applyFn: async () => assert.fail('noncanonical artifact must not delegate'),
    }),
    /canonical JSON/i,
  );
  assert.equal(writableStorageCalls, 0);
});

test('package preview command invokes the incident CLI without apply authority', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['crm:duplicate-consolidation'],
    'node scripts/repair-crm-duplicate-consolidation.js',
  );
  assert.doesNotMatch(packageJson.scripts['crm:duplicate-consolidation'], /--apply/);
});
