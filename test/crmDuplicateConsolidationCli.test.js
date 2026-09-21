import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJsonSha256,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  stableCanonicalJson,
} from '../server/repairs/crmDuplicateConsolidation.js';
import * as consolidationContract from '../server/repairs/crmDuplicateConsolidation.js';
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
import { createSqliteStorage } from '../server/storage/sqlite.js';

const cliPath = path.resolve('scripts/repair-crm-duplicate-consolidation.js');
const nodePath = process.env.TASK9_NODE_PATH || process.execPath;
const CHECKPOINT_SCHEMA = 'crm-duplicate-consolidation-checkpoint-v1';
const CHECKPOINT_FIELDS = [
  'backupPath',
  'backupManifestId',
  'backupSha256',
  'backupProvider',
  'backupStatus',
  'backupQuickCheck',
  'backupForeignKeyViolationCount',
  'flySnapshotId',
  'flySnapshotDigest',
  'flySnapshotStatus',
  'flyRelease',
  'toolingRevision',
  'createdAt',
  'verifiedAt',
];

function checkpointEnvelope(fixture, checkpointOverrides = {}) {
  return {
    schema: CHECKPOINT_SCHEMA,
    checkpoint: {
      ...fixture.recoveryCheckpoint,
      ...checkpointOverrides,
    },
  };
}

function writeCheckpointEvidence(fixture, {
  envelope = checkpointEnvelope(fixture),
  name = `checkpoint-${Math.random().toString(16).slice(2)}.json`,
  bytes = null,
} = {}) {
  const evidencePath = path.join(fixture.root, name);
  fs.writeFileSync(
    evidencePath,
    bytes ?? JSON.stringify(envelope, null, 2),
    { mode: 0o600 },
  );
  return evidencePath;
}

function previewArgs(fixture, checkpointEvidencePath = writeCheckpointEvidence(fixture)) {
  return [
    '--actor', ACTOR,
    '--reason', REASON,
    '--execution-release', RELEASE,
    '--tooling-revision', TOOLING,
    '--backup-path', fixture.recoveryCheckpoint.backupPath,
    '--backup-manifest-id', fixture.recoveryCheckpoint.backupManifestId,
    '--backup-sha256', fixture.recoveryCheckpoint.backupSha256,
    '--checkpoint-evidence', checkpointEvidencePath,
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

function applyArgs(
  fixture,
  artifactPath,
  artifact,
  checkpointEvidencePath = writeCheckpointEvidence(fixture),
) {
  return [
    '--apply',
    ...previewArgs(fixture, checkpointEvidencePath),
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
      CRM_DUPLICATE_CONSOLIDATION_FLY_SNAPSHOT_ID: 'legacy-env-must-be-ignored',
      CRM_DUPLICATE_CONSOLIDATION_FLY_SNAPSHOT_DIGEST: '0'.repeat(64),
      CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_CREATED_AT: '1999-01-01T00:00:00.000Z',
      CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_VERIFIED_AT: '1999-01-01T00:00:00.000Z',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stderr, '');
  assert.match(result.stderr, /preview mode/i);
  assert.doesNotMatch(result.stderr, /--apply|APPLY-UG-P7-01D/i);
  const artifact = JSON.parse(result.stdout);
  assert.equal(result.stdout, stableCanonicalJson(artifact));
  assert.match(createHash('sha256').update(result.stdout).digest('hex'), /^[a-f0-9]{64}$/);
  assert.equal(artifact.mode, 'preview');
  assert.equal(artifact.applied, false);
  assert.deepEqual(artifact.checkpointEvidence, {
    schema: CHECKPOINT_SCHEMA,
    digest: canonicalJsonSha256(checkpointEnvelope(fixture)),
  });
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
    '--checkpoint-path',
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
    '--checkpoint-evidence',
    '--confirm',
  ];

  for (const omitted of requiredFlags) {
    const index = complete.indexOf(omitted);
    const argv = complete.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
    let writableStorageCalls = 0;
    await assert.rejects(
      runCrmDuplicateConsolidationCli({
        argv,
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

test('every non-database apply assertion mismatch refuses before writable storage opens', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const artifactPath = path.join(fixture.root, 'reviewed-assertions.json');
  fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
  const mutations = [
    ['--actor', 'different-operator'],
    ['--reason', 'A different owner-reviewed reason with enough detail.'],
    ['--execution-release', 'different-release'],
    ['--tooling-revision', 'f'.repeat(40)],
    ['--backup-path', path.join(fixture.root, 'different-backup.sqlite')],
    ['--backup-manifest-id', 'different-backup-manifest'],
    ['--backup-sha256', 'd'.repeat(64)],
    ['--expected-plan-checksum', 'e'.repeat(64)],
    ['--manifest-id', 'different-manifest'],
    ['--confirm', 'not-authorized'],
  ];
  for (const [flag, replacement] of mutations) {
    await t.test(flag, async () => {
      const argv = applyArgs(fixture, artifactPath, artifact);
      argv[argv.indexOf(flag) + 1] = replacement;
      let writableStorageOpenCount = 0;
      await assert.rejects(
        runCrmDuplicateConsolidationCli({
          argv,
          getConfigFn: () => fixture.config,
          getStorageFn: () => {
            writableStorageOpenCount += 1;
            return { provider: 'sqlite', close() {} };
          },
        }),
        /match|mismatch|checkpoint|checksum|manifest|confirmation|evidence/i,
      );
      assert.equal(writableStorageOpenCount, 0);
    });
  }
});

test('package preview command invokes the incident CLI without apply authority', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['crm:duplicate-consolidation'],
    'node scripts/repair-crm-duplicate-consolidation.js',
  );
  assert.doesNotMatch(packageJson.scripts['crm:duplicate-consolidation'], /--apply/);
});

test('shared checkpoint validator covers the exact complete leaf set', () => {
  assert.equal(
    typeof consolidationContract.validateCrmDuplicateConsolidationCheckpointEvidence,
    'function',
  );
  assert.deepEqual(
    [...consolidationContract.CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_FIELDS],
    CHECKPOINT_FIELDS,
  );
});

test('checkpoint envelope rejects wrong containers, schema, and unknown keys', async (t) => {
  const fixture = await createFixture(t);
  const validate = consolidationContract.validateCrmDuplicateConsolidationCheckpointEvidence;
  const cases = [
    ['null envelope', null],
    ['array envelope', []],
    ['wrong envelope type', 'checkpoint'],
    ['wrong schema', { ...checkpointEnvelope(fixture), schema: 'wrong-v1' }],
    ['unknown top-level key', { ...checkpointEnvelope(fixture), extra: true }],
    ['checkpoint null', { schema: CHECKPOINT_SCHEMA, checkpoint: null }],
    ['checkpoint array', { schema: CHECKPOINT_SCHEMA, checkpoint: [] }],
    ['checkpoint wrong type', { schema: CHECKPOINT_SCHEMA, checkpoint: 'checkpoint' }],
    ['unknown checkpoint key', {
      ...checkpointEnvelope(fixture),
      checkpoint: { ...fixture.recoveryCheckpoint, extra: true },
    }],
  ];
  for (const [name, evidence] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validate({
          evidence,
          expectedExecutionRelease: RELEASE,
          expectedToolingRevision: TOOLING,
        }),
        /checkpoint|schema|key/i,
      );
    });
  }
});

test('every required checkpoint leaf rejects missing, wrong-type, empty, and malformed values', async (t) => {
  const fixture = await createFixture(t);
  const validate = consolidationContract.validateCrmDuplicateConsolidationCheckpointEvidence;
  const malformed = {
    backupPath: 'relative.sqlite',
    backupManifestId: 'contains whitespace',
    backupSha256: 'A'.repeat(64),
    backupProvider: 'supabase',
    backupStatus: 'pending',
    backupQuickCheck: 'corrupt',
    backupForeignKeyViolationCount: 1,
    flySnapshotId: 'contains whitespace',
    flySnapshotDigest: 'g'.repeat(64),
    flySnapshotStatus: 'pending',
    flyRelease: 'contains whitespace',
    toolingRevision: 'A'.repeat(40),
    createdAt: '2026-09-19T17:00:00Z',
    verifiedAt: 'not-a-date',
  };
  const stringFields = new Set(CHECKPOINT_FIELDS.filter((field) => (
    field !== 'backupForeignKeyViolationCount'
  )));

  for (const field of CHECKPOINT_FIELDS) {
    await t.test(field, async (fieldTest) => {
      const without = checkpointEnvelope(fixture);
      delete without.checkpoint[field];
      await fieldTest.test('missing', () => {
        assert.throws(
          () => validate({
            evidence: without,
            expectedExecutionRelease: RELEASE,
            expectedToolingRevision: TOOLING,
          }),
          new RegExp(field, 'i'),
        );
      });

      await fieldTest.test('wrong type', () => {
        assert.throws(
          () => validate({
            evidence: checkpointEnvelope(fixture, {
              [field]: field === 'backupForeignKeyViolationCount' ? '0' : 7,
            }),
            expectedExecutionRelease: RELEASE,
            expectedToolingRevision: TOOLING,
          }),
          new RegExp(field, 'i'),
        );
      });

      if (stringFields.has(field)) {
        await fieldTest.test('empty', () => {
          assert.throws(
            () => validate({
              evidence: checkpointEnvelope(fixture, { [field]: '   ' }),
              expectedExecutionRelease: RELEASE,
              expectedToolingRevision: TOOLING,
            }),
            new RegExp(field, 'i'),
          );
        });
      }

      await fieldTest.test('malformed', () => {
        assert.throws(
          () => validate({
            evidence: checkpointEnvelope(fixture, { [field]: malformed[field] }),
            expectedExecutionRelease: RELEASE,
            expectedToolingRevision: TOOLING,
          }),
          new RegExp(field, 'i'),
        );
      });
    });
  }
});

test('checkpoint timestamps are canonical UTC and ordered without a TTL', async (t) => {
  const fixture = await createFixture(t);
  const validate = consolidationContract.validateCrmDuplicateConsolidationCheckpointEvidence;
  const cases = [
    ['noncanonical offset', { createdAt: '2026-09-19T10:00:00.000-07:00' }],
    ['missing milliseconds', { verifiedAt: '2026-09-19T17:00:00Z' }],
    ['invalid date', { createdAt: '2026-02-30T17:00:00.000Z' }],
    ['wrong ordering', {
      createdAt: '2026-09-19T17:00:01.000Z',
      verifiedAt: '2026-09-19T17:00:00.000Z',
    }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => validate({
          evidence: checkpointEnvelope(fixture, overrides),
          expectedExecutionRelease: RELEASE,
          expectedToolingRevision: TOOLING,
        }),
        /createdAt|verifiedAt|timestamp|order/i,
      );
    });
  }
});

test('checkpoint canonicalization accepts whitespace and property order and binds a stable digest', async (t) => {
  const fixture = await createFixture(t);
  const validate = consolidationContract.validateCrmDuplicateConsolidationCheckpointEvidence;
  const evidence = checkpointEnvelope(fixture);
  const first = validate({
    evidence,
    expectedExecutionRelease: RELEASE,
    expectedToolingRevision: TOOLING,
  });
  const reversedCheckpoint = Object.fromEntries(Object.entries(evidence.checkpoint).reverse());
  const second = validate({
    evidence: JSON.parse(JSON.stringify({ checkpoint: reversedCheckpoint, schema: evidence.schema }, null, 4)),
    expectedExecutionRelease: RELEASE,
    expectedToolingRevision: TOOLING,
  });
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test('checkpoint evidence file failures refuse before writable storage construction', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const artifactPath = path.join(fixture.root, 'reviewed-artifact.json');
  fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
  const validEvidencePath = writeCheckpointEvidence(fixture);
  const directoryPath = path.join(fixture.root, 'checkpoint-directory');
  fs.mkdirSync(directoryPath);
  const cases = [
    ['missing file', path.join(fixture.root, 'missing.json'), /checkpoint.*(exist|read)/i],
    ['directory', directoryPath, /regular file/i],
    ['empty file', writeCheckpointEvidence(fixture, { name: 'empty.json', bytes: '' }), /empty/i],
    ['oversized file', writeCheckpointEvidence(fixture, {
      name: 'oversized.json', bytes: Buffer.alloc((64 * 1024) + 1, 0x20),
    }), /64 KiB|too large/i],
    ['invalid UTF-8', writeCheckpointEvidence(fixture, {
      name: 'invalid-utf8.json', bytes: Buffer.from([0xc3, 0x28]),
    }), /UTF-8/i],
    ['invalid JSON', writeCheckpointEvidence(fixture, {
      name: 'invalid-json.json', bytes: '{invalid',
    }), /JSON/i],
    ['wrong schema', writeCheckpointEvidence(fixture, {
      name: 'wrong-schema.json', envelope: { ...checkpointEnvelope(fixture), schema: 'wrong' },
    }), /schema/i],
    ['unknown top-level key', writeCheckpointEvidence(fixture, {
      name: 'unknown-key.json', envelope: { ...checkpointEnvelope(fixture), extra: true },
    }), /key/i],
    ['checkpoint null', writeCheckpointEvidence(fixture, {
      name: 'null.json', envelope: { schema: CHECKPOINT_SCHEMA, checkpoint: null },
    }), /checkpoint/i],
    ['checkpoint array', writeCheckpointEvidence(fixture, {
      name: 'array.json', envelope: { schema: CHECKPOINT_SCHEMA, checkpoint: [] },
    }), /checkpoint/i],
    ['checkpoint wrong type', writeCheckpointEvidence(fixture, {
      name: 'wrong-type.json', envelope: { schema: CHECKPOINT_SCHEMA, checkpoint: 'wrong' },
    }), /checkpoint/i],
  ];
  assert.equal(fs.existsSync(validEvidencePath), true);
  for (const [name, evidencePath, errorPattern] of cases) {
    await t.test(name, async () => {
      let writableStorageOpenCount = 0;
      await assert.rejects(
        runCrmDuplicateConsolidationCli({
          argv: applyArgs(fixture, artifactPath, artifact, evidencePath),
          getConfigFn: () => fixture.config,
          getStorageFn: () => {
            writableStorageOpenCount += 1;
            throw new Error('writable storage must not open');
          },
        }),
        errorPattern,
      );
      assert.equal(writableStorageOpenCount, 0);
    });
  }
});

test('legacy checkpoint environment values are ignored and cannot replace required evidence', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const artifactPath = path.join(fixture.root, 'reviewed-artifact.json');
  fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
  const argv = applyArgs(fixture, artifactPath, artifact);
  const checkpointIndex = argv.indexOf('--checkpoint-evidence');
  argv.splice(checkpointIndex, 2);
  let writableStorageOpenCount = 0;
  await assert.rejects(
    runCrmDuplicateConsolidationCli({
      argv,
      env: checkpointEnvironment(fixture),
      getConfigFn: () => fixture.config,
      getStorageFn: () => {
        writableStorageOpenCount += 1;
        return { provider: 'sqlite', close() {} };
      },
      applyFn: async () => assert.fail('legacy environment must not authorize apply'),
    }),
    /checkpoint-evidence/i,
  );
  assert.equal(writableStorageOpenCount, 0);
});

test('canonical malformed reviewed checkpoint refuses before writable construction', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const malformed = structuredClone(artifact);
  malformed.plan.recoveryCheckpoint.createdAt = 'not-a-canonical-timestamp';
  malformed.planChecksum = canonicalJsonSha256(malformed.plan);
  const artifactPath = path.join(fixture.root, 'malformed-reviewed-artifact.json');
  fs.writeFileSync(artifactPath, stableCanonicalJson(malformed), { mode: 0o600 });
  let writableStorageOpenCount = 0;
  await assert.rejects(
    runCrmDuplicateConsolidationCli({
      argv: applyArgs(fixture, artifactPath, malformed),
      getConfigFn: () => fixture.config,
      getStorageFn: () => {
        writableStorageOpenCount += 1;
        return { provider: 'sqlite', close() {} };
      },
      applyFn: async () => {
        throw new Error('malformed checkpoint reached apply delegate');
      },
    }),
    /checkpoint|createdAt|checkpoint-evidence/i,
  );
  assert.equal(writableStorageOpenCount, 0);
});

test('all malformed or mismatched reviewed-artifact checkpoint paths keep writable opens at zero', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const evidencePath = writeCheckpointEvidence(fixture);
  const cases = [
    ['missing checkpoint leaf', (candidate) => {
      delete candidate.plan.recoveryCheckpoint.flySnapshotStatus;
    }, /flySnapshotStatus|checkpoint/i],
    ['malformed checkpoint hash', (candidate) => {
      candidate.plan.recoveryCheckpoint.flySnapshotDigest = 'bad';
    }, /flySnapshotDigest|checkpoint/i],
    ['wrong manifest ID', (candidate) => {
      candidate.manifestId = 'wrong-manifest';
    }, /manifest/i],
    ['wrong release binding', (candidate) => {
      candidate.plan.recoveryCheckpoint.flyRelease = 'different-release';
    }, /release|checkpoint/i],
    ['wrong tooling binding', (candidate) => {
      candidate.plan.recoveryCheckpoint.toolingRevision = 'f'.repeat(40);
    }, /tooling|checkpoint/i],
  ];
  for (const [name, mutate, errorPattern] of cases) {
    await t.test(name, async () => {
      const candidate = structuredClone(artifact);
      mutate(candidate);
      candidate.planChecksum = canonicalJsonSha256(candidate.plan);
      const artifactPath = path.join(fixture.root, `${name.replaceAll(' ', '-')}.json`);
      fs.writeFileSync(artifactPath, stableCanonicalJson(candidate), { mode: 0o600 });
      let writableStorageOpenCount = 0;
      await assert.rejects(
        runCrmDuplicateConsolidationCli({
          argv: applyArgs(fixture, artifactPath, candidate, evidencePath),
          getConfigFn: () => fixture.config,
          getStorageFn: () => {
            writableStorageOpenCount += 1;
            return { provider: 'sqlite', close() {} };
          },
          applyFn: async () => assert.fail('malformed artifact must not delegate'),
        }),
        errorPattern,
      );
      assert.equal(writableStorageOpenCount, 0);
    });
  }

  await t.test('checkpoint evidence disagrees with reviewed artifact', async () => {
    const mismatchedEvidencePath = writeCheckpointEvidence(fixture, {
      name: 'mismatched-evidence.json',
      envelope: checkpointEnvelope(fixture, { flySnapshotId: 'different-snapshot' }),
    });
    const artifactPath = path.join(fixture.root, 'valid-reviewed-artifact.json');
    fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
    let writableStorageOpenCount = 0;
    await assert.rejects(
      runCrmDuplicateConsolidationCli({
        argv: applyArgs(fixture, artifactPath, artifact, mismatchedEvidencePath),
        getConfigFn: () => fixture.config,
        getStorageFn: () => {
          writableStorageOpenCount += 1;
          return { provider: 'sqlite', close() {} };
        },
      }),
      /checkpoint.*(match|agree)|evidence/i,
    );
    assert.equal(writableStorageOpenCount, 0);
  });
});

test('valid checkpoint evidence permits disposable apply and exact zero-write replay at the intended boundary', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  const artifactPath = path.join(fixture.root, 'reviewed-artifact.json');
  const evidencePath = writeCheckpointEvidence(fixture);
  fs.writeFileSync(artifactPath, stableCanonicalJson(artifact), { mode: 0o600 });
  fixture.storage.close();
  let writableStorageOpenCount = 0;
  const input = {
    argv: applyArgs(fixture, artifactPath, artifact, evidencePath),
    getConfigFn: () => fixture.config,
    getStorageFn: () => {
      writableStorageOpenCount += 1;
      return createSqliteStorage(fixture.config);
    },
  };
  const first = await runCrmDuplicateConsolidationCli(input);
  const afterFirst = logicalSnapshot(fixture.sqlitePath);
  const replay = await runCrmDuplicateConsolidationCli(input);
  assert.equal(writableStorageOpenCount, 2);
  assert.equal(first.status, 'repair-required');
  assert.equal(first.applied, true);
  assert.equal(first.mutationCount, 4);
  assert.equal(replay.status, 'verified-prior-apply');
  assert.equal(replay.applied, false);
  assert.equal(replay.mutationCount, 0);
  assert.deepEqual(logicalSnapshot(fixture.sqlitePath), afterFirst);
});
