import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION } from '../server/repairs/crmDuplicateConsolidation.js';
import { applyCrmDuplicateConsolidation } from '../server/services/crmDuplicateConsolidationRepair.js';
import {
  createSqliteCrmDuplicateConsolidationReadOnlyStorage,
  createSqliteStorage,
} from '../server/storage/sqlite.js';
import {
  ACTOR,
  BERLIN,
  BERLIN_CANONICAL_IMPORT_ID,
  BERLIN_IMPORT_ID,
  NOW,
  POOLER,
  POOLER_IMPORT_IDS,
  REASON,
  RELEASE,
  TOOLING,
  applyInput,
  createFixture,
  logicalSnapshot,
  previewFixture,
  rawDatabase,
} from './crmDuplicateConsolidationRepair.test.js';

const referenceSchemaPath = new URL('./fixtures/crmDuplicateConsolidationReferenceSchema.sql', import.meta.url);

async function refusedPreview(fixture) {
  const storage = createSqliteCrmDuplicateConsolidationReadOnlyStorage(fixture.config);
  try {
    try {
      await import('../server/services/crmDuplicateConsolidationRepair.js').then(({ previewCrmDuplicateConsolidation }) => (
        previewCrmDuplicateConsolidation({
          storage,
          actor: ACTOR,
          reason: REASON,
          executionRelease: RELEASE,
          toolingRevision: TOOLING,
          recoveryCheckpoint: fixture.recoveryCheckpoint,
        })
      ));
      assert.fail('preview should have refused');
    } catch (error) {
      assert.equal(error?.code, 'CRM_DUPLICATE_CONSOLIDATION_REFUSED');
      assert.equal(Array.isArray(error.blockers), true);
      assert.ok(error.blockers.length > 0);
      return error;
    }
  } finally {
    storage.close();
  }
}

function backupEvidence(fixture) {
  return {
    path: fixture.recoveryCheckpoint.backupPath,
    manifestId: fixture.recoveryCheckpoint.backupManifestId,
    sha256: fixture.recoveryCheckpoint.backupSha256,
    flySnapshotId: fixture.recoveryCheckpoint.flySnapshotId,
    flySnapshotDigest: fixture.recoveryCheckpoint.flySnapshotDigest,
  };
}

function directStorageApplyInput(fixture, artifact, backupVerification, overrides = {}) {
  return {
    artifact,
    backup: backupEvidence(fixture),
    confirmation: CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
    backupVerification,
    actor: ACTOR,
    reason: REASON,
    executionRelease: RELEASE,
    toolingRevision: TOOLING,
    nowIso: NOW,
    ...overrides,
  };
}

test('preview blocks unknown relationship-like columns and tables from the checked-in schema probe', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (database) => {
    database.exec(fs.readFileSync(referenceSchemaPath, 'utf8'));
    database.prepare(`
      INSERT INTO crm_duplicate_consolidation_unknown_references
        (id, submission_id, opportunity_id, metadata)
      VALUES ('unknown', ?, ?, '{}')
    `).run(POOLER.supersededSubmissionId, POOLER.opportunityId);
  });
  const error = await refusedPreview(fixture);
  assert.ok(error.blockers.some((blocker) => /unclassified.*future_submission_id/i.test(blocker)));
  assert.ok(error.blockers.some((blocker) => /unclassified.*unknown_references/i.test(blocker)));
});

test('preview fails closed on tuple, primary, owner, listing, and financial provenance drift', async (t) => {
  const cases = [
    ['primary', (database) => database.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
      .run(POOLER.supersededSubmissionId, POOLER.opportunityId)],
    ['owner', (database) => database.prepare('UPDATE contact_submissions SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ dealHunter: { opportunityId: 'wrong' } }), POOLER.survivorSubmissionId)],
    ['listing', (database) => database.prepare('UPDATE contact_submissions SET listing_url = ? WHERE id = ?')
      .run('https://example.invalid/not-reviewed', POOLER.survivorSubmissionId)],
    ['financial label', (database) => {
      const row = database.prepare('SELECT metadata FROM contact_submissions WHERE id = ?').get(BERLIN.survivorSubmissionId);
      const metadata = JSON.parse(row.metadata);
      metadata.dealHunter.financialProvenance.originalLabel = 'EBITDA';
      database.prepare('UPDATE contact_submissions SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(metadata), BERLIN.survivorSubmissionId);
    }],
    ['financial value', (database) => database.prepare('UPDATE contact_submissions SET ttm_ebitda = ? WHERE id = ?')
      .run('$1', BERLIN.supersededSubmissionId)],
    ['Berlin import tuple', (database) => database.prepare('UPDATE deal_hunter_crm_imports SET opportunity_id = ? WHERE id = ?')
      .run('unexpected-opportunity', BERLIN_IMPORT_ID)],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      rawDatabase(fixture.sqlitePath, mutate);
      const error = await refusedPreview(fixture);
      assert.ok(error.blockers.some((blocker) => new RegExp(name.split(' ')[0], 'i').test(blocker)), JSON.stringify(error.blockers));
    });
  }
});

test('preview blocks active writers, unsafe outbound controls, and every nonterminal loser dependency class', async (t) => {
  const cases = [
    ['active-writer', (database) => database.prepare("UPDATE deal_hunter_automation_settings SET paused = 0 WHERE id = 'global'").run()],
    ['unsafe-outbound', (database) => database.prepare("UPDATE deal_hunter_cim_safety_settings SET outreach_paused = 0 WHERE id = 'global'").run()],
    ['communication', (database) => database.prepare(`
      INSERT INTO crm_communications (
        id, submission_id, deal_key, direction, channel, source, to_addresses,
        body_text, occurred_at, created_at, updated_at, delivery_state, content_state, metadata
      ) VALUES ('loser-communication', ?, 'fixture', 'outbound', 'email', 'fixture', '[]', '', ?, ?, ?, 'pending', 'available', '{}')
    `).run(POOLER.supersededSubmissionId, NOW, NOW, NOW)],
    ['outbox', (database) => database.prepare(`
      INSERT INTO crm_email_outbox (
        id, communication_id, submission_id, idempotency_key, client_request_key, state, provider,
        attempt_count, expected_submission_version, actor, intended_follow_up_state,
        created_at, updated_at, metadata
      ) VALUES ('loser-outbox', 'missing-communication', ?, 'loser-outbox', 'loser-outbox-client',
        'pending', 'fixture', 0, ?, ?, 'needs-response', ?, ?, '{}')
    `).run(POOLER.supersededSubmissionId, NOW, ACTOR, NOW, NOW)],
    ['cim', (database) => database.prepare(`
      INSERT INTO deal_hunter_cim_requests (
        id, created_at, updated_at, deal_key, recipient_email, status,
        follow_up_count, attempt_count, submission_id, request_state,
        delivery_state, follow_up_state, metadata
      ) VALUES ('loser-cim', ?, ?, 'fixture-cim', 'fixture@invalid.example', 'pending', 0, 0, ?, 'pending', 'pending', 'pending', '{}')
    `).run(NOW, NOW, BERLIN.supersededSubmissionId)],
    ['recommendation', (database) => database.prepare(`
      INSERT INTO crm_follow_up_recommendations (
        id, submission_id, input_fingerprint, engine_version, rules_version,
        status, conversation_state, intent, action_type, created_at, metadata
      ) VALUES ('loser-recommendation', ?, 'fingerprint', 'engine', 'rules', 'current', 'awaiting-reply', 'follow-up', 'email', ?, '{}')
    `).run(POOLER.supersededSubmissionId, NOW)],
    ['upload', (database) => database.prepare(`
      INSERT INTO secure_upload_requests (
        id, submission_id, created_at, updated_at, email, contact_name,
        requested_by, status, expires_at, nda_required, requested_documents,
        upload_batch_count
      ) VALUES ('loser-upload', ?, ?, ?, 'private@invalid.example', 'Private', ?, 'open', '2027-01-01T00:00:00.000Z', 0, '[]', 0)
    `).run(BERLIN.supersededSubmissionId, NOW, NOW, ACTOR)],
    ['reconciliation', (database) => {
      database.prepare(`
        INSERT INTO deal_hunter_crm_reconciliation_runs (
          id, created_at, updated_at, import_id, mode, plan_digest,
          idempotency_key, status, counts, plan, results, metadata
        ) VALUES ('loser-recon-run', ?, ?, 'fixture', 'apply', 'digest', 'loser-recon', 'running', '{}', '{}', '{}', '{}')
      `).run(NOW, NOW);
      database.prepare(`
        INSERT INTO deal_hunter_crm_reconciliation_items (
          id, run_id, opportunity_id, deal_key, action, status,
          submission_id, source_row_numbers, planned_changes, created_at, updated_at, metadata
        ) VALUES ('loser-recon-item', 'loser-recon-run', ?, 'fixture', 'update', 'planned', ?, '[]', '{}', ?, ?, '{}')
      `).run(BERLIN.opportunityId, BERLIN.supersededSubmissionId, NOW, NOW);
    }],
    ['cleanup', (database) => database.prepare(`
      INSERT INTO secure_document_cleanup_jobs (
        id, submission_id, created_at, updated_at, status, files, attempt_count, metadata
      ) VALUES ('loser-cleanup', ?, ?, ?, 'cleanup-pending', '[]', 0, '{}')
    `).run(POOLER.supersededSubmissionId, NOW, NOW)],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      rawDatabase(fixture.sqlitePath, mutate);
      const error = await refusedPreview(fixture);
      assert.ok(error.blockers.some((blocker) => new RegExp(name, 'i').test(blocker)), JSON.stringify(error.blockers));
    });
  }
});

test('preview blocks every loser CIM request but only nonterminal survivor CIM work', async (t) => {
  for (const [name, submissionId, state, shouldBlock] of [
    ['terminal loser', BERLIN.supersededSubmissionId, 'terminal', true],
    ['nonterminal survivor', BERLIN.survivorSubmissionId, 'nonterminal', true],
    ['terminal survivor', BERLIN.survivorSubmissionId, 'terminal', false],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      rawDatabase(fixture.sqlitePath, (database) => database.prepare(`
        INSERT INTO deal_hunter_cim_requests (
          id, created_at, updated_at, deal_key, recipient_email, status,
          follow_up_count, attempt_count, submission_id, request_state,
          delivery_state, follow_up_state, next_follow_up_at, metadata
        ) VALUES (?, ?, ?, ?, 'fixture@invalid.example', ?, ?, 1, ?, ?, ?, ?, NULL, '{}')
      `).run(
        `cim-${name.replaceAll(' ', '-')}`,
        NOW,
        NOW,
        `fixture-${name}`,
        state === 'terminal' ? 'sent' : 'pending',
        state === 'terminal' ? 3 : 0,
        submissionId,
        state === 'terminal' ? 'provider_accepted' : 'pending',
        state === 'terminal' ? 'accepted' : 'pending',
        state === 'terminal' ? 'completed' : 'pending',
      ));
      if (shouldBlock) {
        const error = await refusedPreview(fixture);
        assert.ok(error.blockers.some((blocker) => /cim-request/i.test(blocker)));
      } else {
        const artifact = await previewFixture(fixture);
        assert.deepEqual(artifact.blockers, []);
      }
    });
  }
});

test('preview retains terminal loser outbox provenance without treating it as active work', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    INSERT INTO crm_email_outbox (
      id, communication_id, submission_id, idempotency_key, client_request_key, state, provider,
      attempt_count, expected_submission_version, actor, intended_follow_up_state,
      created_at, updated_at, metadata
    ) VALUES ('terminal-loser-outbox', 'missing-terminal-communication', ?,
      'terminal-loser-outbox', 'terminal-loser-outbox-client', 'permanent_failed',
      'fixture', 1, ?, ?, 'needs-response', ?, ?, '{}')
  `).run(BERLIN.supersededSubmissionId, NOW, ACTOR, NOW, NOW));
  const artifact = await previewFixture(fixture);
  assert.deepEqual(artifact.blockers, []);
  assert.ok(artifact.plan.relationshipInventory.some((entry) => (
    entry.table === 'crm_email_outbox'
      && entry.column === 'submission_id'
      && entry.matchedRowCount === 1
  )));
});

test('preview blocks every persisted current Stage 2 activation regardless of mode', async (t) => {
  for (const mode of ['off', 'shadow', 'canary', 'active']) {
    await t.test(mode, async (subtest) => {
      const fixture = await createFixture(subtest);
      await fixture.storage.createCimStage2Activation({
        id: `task-8-current-${mode}-stage2`, created_at: NOW, updated_at: NOW,
        mode, actor: ACTOR, reason: `Current ${mode} Stage 2 authority must block repair.`,
        confirmation_phrase: `ACTIVATE CIM STAGE 2 ${mode.toUpperCase()}`, policy_hash: 'policy',
        rule_version: 'rules', source_policy_version: 'source-v1', source_policy_hash: 'source-hash',
        evidence_checksum: '1'.repeat(64), evidence_generated_at: NOW,
        backup_reference: 'stage2-backup', backup_checksum: '2'.repeat(64),
        identity_audit_reference: 'stage2-identity', identity_audit_checksum: '3'.repeat(64),
        compliance_reference: 'stage2-compliance', sender_auth_reference: 'stage2-sender',
        timezone: 'America/Los_Angeles', window_start: '08:00', window_end: '17:00',
        weekdays_only: true, canary_daily_cap: 1, active_daily_cap: 3,
        recipient_cap_24_hours: 1, recipient_cap_30_days: 4,
        expires_at: '2027-01-01T00:00:00.000Z', metadata: { automaticTransmissionAuthorized: true },
      });
      const error = await refusedPreview(fixture);
      assert.ok(error.blockers.includes('active-stage2-activation'));
    });
  }
});

test('preview inventories every application TEXT column with all approved and scoped identity tokens', async (t) => {
  const fixture = await createFixture(t);
  const knownIdentifiers = [
    POOLER.opportunityId, POOLER.survivorSubmissionId, POOLER.supersededSubmissionId,
    BERLIN.opportunityId, BERLIN.survivorSubmissionId, BERLIN.supersededSubmissionId,
    POOLER.listingIdentity, BERLIN.listingIdentity,
    'b272125b030c6d097808fa82126b6afa0799fda456fc3465be51a0f0cea7a52e',
    'aba23259c8a36685199482500aff468493221c0ff844966c2f6b9c148d72ad01',
    '49e8541d-3463-44e9-b032-02563b47317f',
    'a169ba9c-6b96-41f1-a18b-5c8521ebdc54',
    ...POOLER_IMPORT_IDS,
    '42fefa5e5de8bba6676bf97ccb49a2c5364a469dc6da57b4af6ff9087141bede',
    BERLIN_CANONICAL_IMPORT_ID,
    BERLIN_IMPORT_ID,
  ];
  const scopedEvidenceAlias = 'fixture:pooler-approved-evidence-alias';
  rawDatabase(fixture.sqlitePath, (database) => {
    const submissionRow = database.prepare('SELECT metadata FROM contact_submissions WHERE id = ?')
      .get(POOLER.survivorSubmissionId);
    const metadata = JSON.parse(submissionRow.metadata);
    metadata.dealHunter.evidenceAliases = [scopedEvidenceAlias];
    database.prepare('UPDATE contact_submissions SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), POOLER.survivorSubmissionId);
    database.prepare(`
      INSERT INTO admin_audit_events (
        id, created_at, actor, role, method, path, status_code, metadata
      ) VALUES ('task-8-reference-audit', ?, ?, 'admin', 'GET', ?, 200, '{}')
    `).run(NOW, ACTOR, `/admin/crm/${[...knownIdentifiers, scopedEvidenceAlias].join('/')}`);
    database.prepare(`
      INSERT INTO deal_hunter_cim_repair_manifests (
        id, created_at, updated_at, mode, status, actor, checksum, manifest, metadata
      ) VALUES ('task-8-historical-receipt', ?, ?, 'historical-fixture', 'applied', ?,
        'historical', ?, '{}')
    `).run(NOW, NOW, ACTOR, JSON.stringify({ submissionId: POOLER.supersededSubmissionId }));
  });

  const artifact = await previewFixture(fixture);
  const expectedTextColumnCount = rawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().reduce((count, table) => (
    count + database.pragma(`table_info(${JSON.stringify(table.name)})`)
      .filter((column) => /TEXT/i.test(String(column.type))).length
  ), 0), { readonly: true });
  assert.equal(artifact.plan.relationshipInventory.length, expectedTextColumnCount);
  const auditPath = artifact.plan.relationshipInventory.find((entry) => (
    entry.table === 'admin_audit_events' && entry.column === 'path'
  ));
  assert.equal(auditPath.classification, 'retained-with-provenance');
  assert.equal(auditPath.matchedRowCount, 1);
  assert.equal(auditPath.matchedIdentifierCount, knownIdentifiers.length + 1);
  const historicalManifest = artifact.plan.relationshipInventory.find((entry) => (
    entry.table === 'deal_hunter_cim_repair_manifests' && entry.column === 'manifest'
  ));
  assert.ok(historicalManifest.policies.includes('retained-historical-receipt'));
  const importId = artifact.plan.relationshipInventory.find((entry) => (
    entry.table === 'deal_hunter_crm_imports' && entry.column === 'id'
  ));
  assert.ok(importId.policies.includes('mutated-berlin-import-only'));
  assert.ok(importId.policies.includes('retained-preserved-import'));
  assert.match(artifact.plan.referenceIdentifiers.digest, /^[a-f0-9]{64}$/);
  assert.equal(artifact.plan.referenceIdentifiers.approvedCount, knownIdentifiers.length);
  assert.ok(artifact.plan.referenceIdentifiers.totalCount > knownIdentifiers.length);
  assert.doesNotMatch(JSON.stringify(artifact.plan.relationshipInventory), /private@|private note|private message/i);
});

test('preview blocks a positive incident reference in an unapproved TEXT authority surface', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      CREATE TABLE unexpected_live_authority (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        note TEXT NOT NULL
      )
    `);
    database.prepare(`
      INSERT INTO unexpected_live_authority (id, payload, note)
      VALUES ('unexpected-authority', ?, 'no incident reference here')
    `).run(JSON.stringify({ submissionId: POOLER.supersededSubmissionId }));
  });
  const error = await refusedPreview(fixture);
  assert.ok(error.blockers.some((blocker) => (
    /unclassified.*positive.*reference/i.test(blocker)
      && /unexpected_live_authority\.payload/i.test(blocker)
  )), JSON.stringify(error.blockers));
});

test('preview scans an unknown TEXT column with no incident reference without approving the surface', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (database) => {
    database.exec(`
      CREATE TABLE unexpected_reference_free_text (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `);
    database.prepare(`
      INSERT INTO unexpected_reference_free_text (id, payload)
      VALUES ('unrelated', '{"scope":"unrelated"}')
    `).run();
  });
  const artifact = await previewFixture(fixture);
  const payload = artifact.plan.relationshipInventory.find((entry) => (
    entry.table === 'unexpected_reference_free_text' && entry.column === 'payload'
  ));
  assert.equal(payload.classification, 'scanned-no-incident-reference');
  assert.equal(payload.matchedRowCount, 0);
  assert.deepEqual(payload.policies, ['scanned-no-incident-reference']);
});

test('plan binds every required supersession index and trigger and refuses schema-object drift', async (t) => {
  const requiredNames = [
    'idx_crm_submission_supersessions_survivor',
    'idx_crm_submission_supersessions_opportunity',
    'uq_crm_submission_supersessions_active_loser',
    'trg_crm_duplicate_consolidation_receipt_no_update',
    'trg_crm_duplicate_consolidation_receipt_no_delete',
    'trg_crm_submission_supersessions_validate_insert',
    'trg_crm_submission_supersessions_no_active_chain_insert',
    'trg_crm_submission_supersessions_no_active_chain_update',
    'trg_crm_submission_supersessions_immutable_update',
    'trg_crm_submission_supersessions_reverse_only',
    'trg_crm_submission_supersessions_no_delete',
    'trg_crm_submission_supersessions_guard_contact_owner_update',
    'trg_crm_submission_supersessions_guard_opportunity_update',
    'trg_deal_hunter_opportunities_reject_superseded_primary_insert',
    'trg_deal_hunter_opportunities_reject_superseded_primary_update',
    'trg_crm_submission_supersessions_guard_contact_delete',
    'trg_crm_submission_supersessions_guard_opportunity_delete',
  ];
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  assert.deepEqual(artifact.plan.schema.requiredObjects.map((entry) => entry.name), requiredNames.slice().sort());
  assert.ok(artifact.plan.schema.requiredObjects.every((entry) => /^[a-f0-9]{64}$/.test(entry.sqlDigest)));

  for (const [name, mutate] of [
    ['drop index', (database) => database.exec('DROP INDEX uq_crm_submission_supersessions_active_loser')],
    ['drop reversal guard', (database) => (
      database.exec('DROP TRIGGER trg_crm_submission_supersessions_reverse_only')
    )],
    ['alter trigger', (database) => database.exec(`
      DROP TRIGGER trg_crm_submission_supersessions_reverse_only;
      CREATE TRIGGER trg_crm_submission_supersessions_reverse_only
      BEFORE UPDATE ON crm_submission_supersessions BEGIN SELECT 1; END;
    `)],
  ]) {
    await t.test(name, async (subtest) => {
      const scoped = await createFixture(subtest);
      const reviewed = await previewFixture(scoped);
      rawDatabase(scoped.sqlitePath, mutate);
      const before = logicalSnapshot(scoped.sqlitePath);
      await assert.rejects(
        applyCrmDuplicateConsolidation(applyInput(scoped, reviewed)),
        /schema|required.*object|trigger|index|drift/i,
      );
      assert.deepEqual(logicalSnapshot(scoped.sqlitePath), before);
    });
  }

  await t.test('missing before preview', async (subtest) => {
    const scoped = await createFixture(subtest);
    rawDatabase(scoped.sqlitePath, (database) => (
      database.exec('DROP TRIGGER trg_crm_submission_supersessions_reverse_only')
    ));
    const error = await refusedPreview(scoped);
    assert.ok(error.blockers.some((blocker) => /required.*trigger|schema.*object/i.test(blocker)));
  });

  await t.test('postcondition rollback', async (subtest) => {
    const scoped = await createFixture(subtest);
    const reviewed = await previewFixture(scoped);
    const before = logicalSnapshot(scoped.sqlitePath);
    await assert.rejects(
      applyCrmDuplicateConsolidation(applyInput(scoped, reviewed, {
        testHooks: { dropReversalGuardBeforePostconditions: true },
      })),
      /postcondition|required.*object|schema/i,
    );
    assert.deepEqual(logicalSnapshot(scoped.sqlitePath), before);
    assert.equal(rawDatabase(scoped.sqlitePath, (database) => Boolean(database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'trigger'
        AND name = 'trg_crm_submission_supersessions_reverse_only'
    `).get()), { readonly: true }), true);
  });
});

test('SQLite apply sink independently rejects missing confirmation and forged backup verification', async (t) => {
  for (const [name, authority] of [
    ['no confirmation', { confirmation: undefined, backupVerification: undefined }],
    ['forged verification', {
      confirmation: CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
      backupVerification: { ok: true, planChecksum: 'forged' },
    }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      const artifact = await previewFixture(fixture);
      const before = logicalSnapshot(fixture.sqlitePath);
      await assert.rejects(fixture.storage.applyCrmDuplicateConsolidation({
        artifact,
        backup: {
          path: '/not/a/verified/backup',
          manifestId: fixture.recoveryCheckpoint.backupManifestId,
          sha256: fixture.recoveryCheckpoint.backupSha256,
          flySnapshotId: fixture.recoveryCheckpoint.flySnapshotId,
          flySnapshotDigest: fixture.recoveryCheckpoint.flySnapshotDigest,
        },
        actor: ACTOR,
        reason: REASON,
        executionRelease: RELEASE,
        toolingRevision: TOOLING,
        nowIso: NOW,
        ...authority,
      }), /confirmation|verified backup|verification evidence/i);
      assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
    });
  }
});

test('SQLite backup authority is instance-bound, single-use, fresh, and exactly rebound', async (t) => {
  await t.test('cross-instance', async (subtest) => {
    const fixture = await createFixture(subtest);
    const artifact = await previewFixture(fixture);
    const verification = await fixture.storage.verifyCrmDuplicateConsolidationBackupPlan({
      artifact,
      backup: backupEvidence(fixture),
    });
    const otherStorage = createSqliteStorage(fixture.config);
    subtest.after(() => otherStorage.close());
    const before = logicalSnapshot(fixture.sqlitePath);
    await assert.rejects(
      otherStorage.applyCrmDuplicateConsolidation(
        directStorageApplyInput(fixture, artifact, verification),
      ),
      /non-forgeable|verified backup|verification evidence/i,
    );
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  });

  await t.test('single-use', async (subtest) => {
    const fixture = await createFixture(subtest);
    const artifact = await previewFixture(fixture);
    const verification = await fixture.storage.verifyCrmDuplicateConsolidationBackupPlan({
      artifact,
      backup: backupEvidence(fixture),
    });
    const first = await fixture.storage.applyCrmDuplicateConsolidation(
      directStorageApplyInput(fixture, artifact, verification),
    );
    assert.equal(first.applied, true);
    const afterFirst = logicalSnapshot(fixture.sqlitePath);
    await assert.rejects(
      fixture.storage.applyCrmDuplicateConsolidation(
        directStorageApplyInput(fixture, artifact, verification),
      ),
      /non-forgeable|verified backup|verification evidence/i,
    );
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), afterFirst);
  });

  await t.test('expiry', async (subtest) => {
    const fixture = await createFixture(subtest);
    const artifact = await previewFixture(fixture);
    const verification = await fixture.storage.verifyCrmDuplicateConsolidationBackupPlan({
      artifact,
      backup: backupEvidence(fixture),
    });
    const before = logicalSnapshot(fixture.sqlitePath);
    const actualNow = Date.now;
    Date.now = () => actualNow() + (5 * 60 * 1000) + 1;
    try {
      await assert.rejects(
        fixture.storage.applyCrmDuplicateConsolidation(
          directStorageApplyInput(fixture, artifact, verification),
        ),
        /stale|different authority/i,
      );
    } finally {
      Date.now = actualNow;
    }
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  });

  await t.test('changed backup file', async (subtest) => {
    const fixture = await createFixture(subtest);
    const artifact = await previewFixture(fixture);
    const verification = await fixture.storage.verifyCrmDuplicateConsolidationBackupPlan({
      artifact,
      backup: backupEvidence(fixture),
    });
    const before = logicalSnapshot(fixture.sqlitePath);
    fs.appendFileSync(fixture.backupPath, Buffer.from([0]));
    await assert.rejects(
      fixture.storage.applyCrmDuplicateConsolidation(
        directStorageApplyInput(fixture, artifact, verification),
      ),
      /backup.*changed|evidence changed/i,
    );
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  });

  for (const [name, rebind] of [
    ['artifact', (fixture, artifact) => ({
      artifact: { ...structuredClone(artifact), recoveryCheckpointPath: `${artifact.recoveryCheckpointPath}.other` },
    })],
    ['backup', (fixture) => ({
      backup: { ...backupEvidence(fixture), manifestId: 'different-backup-manifest' },
    })],
  ]) {
    await t.test(`${name} rebinding`, async (subtest) => {
      const fixture = await createFixture(subtest);
      const artifact = await previewFixture(fixture);
      const verification = await fixture.storage.verifyCrmDuplicateConsolidationBackupPlan({
        artifact,
        backup: backupEvidence(fixture),
      });
      const before = logicalSnapshot(fixture.sqlitePath);
      await assert.rejects(
        fixture.storage.applyCrmDuplicateConsolidation(directStorageApplyInput(
          fixture,
          artifact,
          verification,
          rebind(fixture, artifact),
        )),
        /bound to different authority|stale/i,
      );
      assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
    });
  }
});

test('apply refuses any raw-row drift after review and rolls back without mutation', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  rawDatabase(fixture.sqlitePath, (database) => database.prepare('UPDATE contact_submissions SET company = ? WHERE id = ?')
    .run('Drifted private company', POOLER.supersededSubmissionId));
  const before = logicalSnapshot(fixture.sqlitePath);
  let refusal;
  await assert.rejects(
    applyCrmDuplicateConsolidation(applyInput(fixture, artifact)).catch((error) => {
      refusal = error;
      throw error;
    }),
    /drift|checksum|reviewed plan|raw-row/i,
  );
  assert.equal(refusal?.code, 'CRM_DUPLICATE_CONSOLIDATION_REFUSED');
  assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
});

test('failure after each write and during postconditions rolls back all four writes', async (t) => {
  for (const point of [1, 2, 3, 4, 'postconditions']) {
    await t.test(`failure ${point}`, async (subtest) => {
      const fixture = await createFixture(subtest);
      const artifact = await previewFixture(fixture);
      const before = logicalSnapshot(fixture.sqlitePath);
      const testHooks = point === 'postconditions'
        ? { forcePostconditionFailure: true }
        : { failAfterWrite: point };
      await assert.rejects(
        applyCrmDuplicateConsolidation(applyInput(fixture, artifact, { testHooks })),
        /injected|postcondition/i,
      );
      assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
    });
  }
});

test('stale Berlin CAS, receipt collision, independently satisfied, and partial states refuse', async (t) => {
  await t.test('stale CAS', async (subtest) => {
    const fixture = await createFixture(subtest);
    const artifact = await previewFixture(fixture);
    const before = logicalSnapshot(fixture.sqlitePath);
    await assert.rejects(
      applyCrmDuplicateConsolidation(applyInput(fixture, artifact, { testHooks: { forceBerlinCasConflict: true } })),
      /Berlin.*compare-and-set|CAS/i,
    );
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  });

  await t.test('receipt collision', async (subtest) => {
    const fixture = await createFixture(subtest);
    const artifact = await previewFixture(fixture);
    rawDatabase(fixture.sqlitePath, (database) => database.prepare(`
      INSERT INTO deal_hunter_cim_repair_manifests (
        id, created_at, updated_at, mode, status, actor, backup_reference,
        checksum, manifest, metadata
      ) VALUES (?, ?, ?, 'crm-duplicate-consolidation', 'applied', ?, ?, ?, '{}', '{}')
    `).run(artifact.manifestId, NOW, NOW, ACTOR, fixture.backupPath, artifact.planChecksum));
    const before = logicalSnapshot(fixture.sqlitePath);
    await assert.rejects(applyCrmDuplicateConsolidation(applyInput(fixture, artifact)), /collision|receipt/i);
    assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
  });

  for (const [name, mutate] of [
    ['independently satisfied', (database, artifact) => {
      database.exec('PRAGMA foreign_keys = OFF');
      database.exec('DROP TRIGGER trg_crm_submission_supersessions_validate_insert');
      for (const pair of [POOLER, BERLIN]) {
        database.prepare(`
          INSERT INTO crm_submission_supersessions (
            id, created_at, updated_at, status, survivor_submission_id,
            superseded_submission_id, opportunity_id, reason_code, reason_text,
            approved_by, approved_at, actor, repair_version, repair_manifest_id,
            repair_digest, metadata
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', 'forged',
            'forged', ?, 'forged', 'forged', ?, ?, '{}')
        `).run(`forged-${pair.key}`, NOW, NOW, pair.survivorSubmissionId,
          pair.supersededSubmissionId, pair.opportunityId, NOW, artifact.manifestId, artifact.planChecksum);
      }
      database.prepare('UPDATE deal_hunter_crm_imports SET submission_id = ? WHERE id = ?')
        .run(BERLIN.survivorSubmissionId, BERLIN_IMPORT_ID);
      database.exec('PRAGMA foreign_keys = ON');
    }],
    ['partial', (database) => database.prepare('UPDATE deal_hunter_crm_imports SET submission_id = ? WHERE id = ?')
      .run(BERLIN.survivorSubmissionId, BERLIN_IMPORT_ID)],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      const artifact = await previewFixture(fixture);
      rawDatabase(fixture.sqlitePath, (database) => mutate(database, artifact));
      const before = logicalSnapshot(fixture.sqlitePath);
      await assert.rejects(applyCrmDuplicateConsolidation(applyInput(fixture, artifact)), /satisfied|partial|receipt|drift/i);
      assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
    });
  }
});

test('logical reversal uses a distinct protected receipt and preserves the original apply receipt byte-for-byte', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
  const before = logicalSnapshot(fixture.sqlitePath);
  const original = before.deal_hunter_cim_repair_manifests.find((row) => row.id === artifact.manifestId);
  const relation = before.crm_submission_supersessions[0];
  const reversalId = `${artifact.manifestId}:reverse:test`;
  rawDatabase(fixture.sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_cim_repair_manifests (
        id, created_at, updated_at, mode, status, actor, backup_reference,
        checksum, manifest, metadata
      ) VALUES (?, ?, ?, 'crm-duplicate-consolidation', 'applied', ?, ?, ?, ?, '{}')
    `).run(
      reversalId, NOW, NOW, ACTOR, fixture.backupPath, relation.repair_digest,
      JSON.stringify({
        schema: 'crm-duplicate-consolidation-reversal-manifest-v1',
        operation: 'reverse',
        relationId: relation.id,
        applyManifestId: artifact.manifestId,
        repairDigest: relation.repair_digest,
        survivorSubmissionId: relation.survivor_submission_id,
        supersededSubmissionId: relation.superseded_submission_id,
        opportunityId: relation.opportunity_id,
      }),
    );
    database.prepare(`
      UPDATE crm_submission_supersessions
      SET status = 'reversed', updated_at = ?, reversed_at = ?, reversed_by = ?,
        reversal_reason = ?, reversal_manifest_id = ?
      WHERE id = ?
    `).run(NOW, NOW, ACTOR, 'Separately reviewed test reversal.', reversalId, relation.id);
  });
  const after = logicalSnapshot(fixture.sqlitePath);
  assert.deepEqual(after.deal_hunter_cim_repair_manifests.find((row) => row.id === artifact.manifestId), original);
  assert.equal(after.deal_hunter_cim_repair_manifests.find((row) => row.id === reversalId).mode, 'crm-duplicate-consolidation');
  assert.equal(after.crm_submission_supersessions.find((row) => row.id === relation.id).reversal_manifest_id, reversalId);
});

test('replay rejects a receipt whose stored JSON bytes are not the exact canonical insert bytes', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await previewFixture(fixture);
  await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
  rawDatabase(fixture.sqlitePath, (database) => {
    const receiptGuardSql = database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'trigger'
        AND name = 'trg_crm_duplicate_consolidation_receipt_no_update'
    `).get().sql;
    database.exec('DROP TRIGGER trg_crm_duplicate_consolidation_receipt_no_update');
    database.prepare(`
      UPDATE deal_hunter_cim_repair_manifests
      SET manifest = ' ' || manifest
      WHERE id = ?
    `).run(artifact.manifestId);
    database.exec(receiptGuardSql);
  });
  await assert.rejects(
    applyCrmDuplicateConsolidation(applyInput(fixture, artifact)),
    (error) => error?.code === 'CRM_DUPLICATE_CONSOLIDATION_REFUSED'
      && /canonical bytes|receipt/i.test(error.message),
  );
});

test('replay rejects exact-relation and unrelated allowed-table drift', async (t) => {
  for (const [name, mutate] of [
    ['relation', (database, artifact) => {
      database.exec('DROP TRIGGER trg_crm_submission_supersessions_immutable_update');
      database.prepare(`
        UPDATE crm_submission_supersessions SET actor = 'tampered'
        WHERE repair_manifest_id = ? AND status = 'active'
      `).run(artifact.manifestId);
    }],
    ['unrelated import', (database) => database.prepare(`
      UPDATE deal_hunter_crm_imports SET metadata = '{"tampered":true}'
      WHERE id = ?
    `).run(POOLER_IMPORT_IDS[0])],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      const artifact = await previewFixture(fixture);
      await applyCrmDuplicateConsolidation(applyInput(fixture, artifact));
      rawDatabase(fixture.sqlitePath, (database) => mutate(database, artifact));
      await assert.rejects(
        applyCrmDuplicateConsolidation(applyInput(fixture, artifact)),
        (error) => error?.code === 'CRM_DUPLICATE_CONSOLIDATION_REFUSED'
          && /drift|partial|conflict|state/i.test(error.message),
      );
    });
  }
});
