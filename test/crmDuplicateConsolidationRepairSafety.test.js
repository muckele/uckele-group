import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION } from '../server/repairs/crmDuplicateConsolidation.js';
import { applyCrmDuplicateConsolidation } from '../server/services/crmDuplicateConsolidationRepair.js';
import { createSqliteCrmDuplicateConsolidationReadOnlyStorage } from '../server/storage/sqlite.js';
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
  rawDatabase,
  syntheticReviewedArtifactFixture,
} from './crmDuplicateConsolidationRepair.test.js';

const referenceSchemaPath = new URL('./fixtures/crmDuplicateConsolidationReferenceSchema.sql', import.meta.url);
const sqliteSourcePath = new URL('../server/storage/sqlite.js', import.meta.url);

test('V3 apply authority compares the live authoritative digest inside the immediate transaction', () => {
  const source = fs.readFileSync(sqliteSourcePath, 'utf8');
  const apply = source.slice(source.indexOf('async applyCrmDuplicateConsolidation({'));
  const transaction = apply.slice(apply.indexOf('const transaction = database.transaction(() => {'),
    apply.indexOf('const receiptManifest = {'));
  assert.match(transaction, /assertCrmDuplicateConsolidationRuntimeSafetyAuthorityMatches\(/);
  assert.match(transaction, /const inspection = inspectCrmDuplicateConsolidationState\(database,/);
  assert.match(transaction, /inspection\.database\.authorityLogicalDigest !== artifact\.plan\.database\.authorityLogicalDigest/);
  assert.doesNotMatch(transaction, /inspection\.database\.logicalDigest/);
  assert.match(transaction, /inspection\.schema\.digest !== artifact\.plan\.schema\.digest/);
  assert.match(transaction, /stableCrmDuplicateConsolidationJson\(inspection\.rawRows\)/);
  assert.ok(transaction.indexOf('assertCrmDuplicateConsolidationRuntimeSafetyAuthorityMatches(')
    < transaction.indexOf('const existingReceipt = '));
  assert.ok(transaction.indexOf('const inspection = inspectCrmDuplicateConsolidationState(database,')
    > transaction.indexOf('if (existingReceipt) {'));
});

test('V3 apply authority synthetic public fixture refuses fixed Berlin without repair writes', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  rawDatabase(fixture.sqlitePath, (database) => {
    database.prepare(`INSERT INTO analytics_events (id, created_at, event_name, path)
      VALUES ('v3-apply-negative', ?, 'page_view', '/negative')`).run(NOW);
  });
  const before = logicalSnapshot(fixture.sqlitePath);
  const inspection = await inspectFixture(fixture);
  assert.ok(inspection.blockers.some((blocker) => /berlin-superseded-deal-key-digest-drift/i.test(blocker)));
  await assert.rejects(applyCrmDuplicateConsolidation(applyInput(fixture, artifact)), (error) => {
    assert.equal(error?.code, 'CRM_DUPLICATE_CONSOLIDATION_REFUSED');
    return true;
  });
  assert.deepEqual(logicalSnapshot(fixture.sqlitePath), before);
});

async function refusedPreview(fixture) {
  const storage = createSqliteCrmDuplicateConsolidationReadOnlyStorage(fixture.config, {
    environment: {},
  });
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

async function inspectFixture(fixture) {
  const storage = createSqliteCrmDuplicateConsolidationReadOnlyStorage(fixture.config, {
    environment: {},
  });
  try {
    return await storage.inspectCrmDuplicateConsolidation();
  } finally {
    storage.close();
  }
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
      metadata.dealHunter.raw['Annual Profit'] = '$1';
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
    ['active-writer', (database) => database.prepare("UPDATE deal_hunter_automation_settings SET paused = 0 WHERE id = 'cim-initial-outreach'").run()],
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
        const inspection = await inspectFixture(fixture);
        assert.equal(inspection.blockers.some((blocker) => /cim-request/i.test(blocker)), false);
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
  const inspection = await inspectFixture(fixture);
  assert.equal(inspection.blockers.some((blocker) => /nonterminal-loser-outbox/i.test(blocker)), false);
  assert.ok(inspection.relationshipInventory.some((entry) => (
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

  const inspection = await inspectFixture(fixture);
  const expectedTextColumnCount = rawDatabase(fixture.sqlitePath, (database) => database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().reduce((count, table) => (
    count + (['analytics_events', 'contact_rate_limit_events'].includes(table.name) ? 0 : database.pragma(`table_info(${JSON.stringify(table.name)})`)
      .filter((column) => /TEXT/i.test(String(column.type))).length
    )
  ), 0), { readonly: true });
  assert.equal(inspection.relationshipInventory.length, expectedTextColumnCount);
  const auditPath = inspection.relationshipInventory.find((entry) => (
    entry.table === 'admin_audit_events' && entry.column === 'path'
  ));
  assert.equal(auditPath.classification, 'retained-with-provenance');
  assert.equal(auditPath.matchedRowCount, 1);
  assert.equal(auditPath.matchedIdentifierCount, knownIdentifiers.length + 1);
  const historicalManifest = inspection.relationshipInventory.find((entry) => (
    entry.table === 'deal_hunter_cim_repair_manifests' && entry.column === 'manifest'
  ));
  assert.ok(historicalManifest.policies.includes('retained-historical-receipt'));
  const importId = inspection.relationshipInventory.find((entry) => (
    entry.table === 'deal_hunter_crm_imports' && entry.column === 'id'
  ));
  assert.ok(importId.policies.includes('mutated-berlin-import-only'));
  assert.ok(importId.policies.includes('retained-preserved-import'));
  assert.match(inspection.referenceIdentifiers.digest, /^[a-f0-9]{64}$/);
  assert.equal(inspection.referenceIdentifiers.approvedCount, knownIdentifiers.length);
  assert.ok(inspection.referenceIdentifiers.totalCount > knownIdentifiers.length);
  assert.doesNotMatch(JSON.stringify(inspection.relationshipInventory), /private@|private note|private message/i);
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
  assert.ok(error.blockers.includes('unclassified positive incident reference: unexpected_live_authority.payload'),
    JSON.stringify(error.blockers));
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
  const inspection = await inspectFixture(fixture);
  const payload = inspection.relationshipInventory.find((entry) => (
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
  const inspection = await inspectFixture(fixture);
  assert.deepEqual(inspection.schema.requiredObjects.map((entry) => entry.name), requiredNames.slice().sort());
  assert.ok(inspection.schema.requiredObjects.every((entry) => /^[a-f0-9]{64}$/.test(entry.sqlDigest)));

  await t.test('missing before preview', async (subtest) => {
    const scoped = await createFixture(subtest);
    rawDatabase(scoped.sqlitePath, (database) => (
      database.exec('DROP TRIGGER trg_crm_submission_supersessions_reverse_only')
    ));
    const error = await refusedPreview(scoped);
    assert.ok(error.blockers.some((blocker) => /required.*trigger|schema.*object/i.test(blocker)));
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
      const artifact = await syntheticReviewedArtifactFixture(fixture);
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

test('V3 service accepts authority-only backup verification shape before apply gate', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  const storage = {
    provider: 'sqlite',
    getCrmDuplicateConsolidationConfigAuthority: () => fixture.storage.getCrmDuplicateConsolidationConfigAuthority(),
    verifyCrmDuplicateConsolidationBackupPlan: async () => ({
      planChecksum: artifact.planChecksum,
      databaseAuthorityLogicalDigest: artifact.plan.database.authorityLogicalDigest,
    }),
  };
  const input = {
    apply: true,
    storage,
    reviewedArtifact: artifact,
    expectedPlanChecksum: artifact.planChecksum,
    expectedManifestId: artifact.manifestId,
    backup: {
      path: fixture.recoveryCheckpoint.backupPath,
      manifestId: fixture.recoveryCheckpoint.backupManifestId,
      sha256: fixture.recoveryCheckpoint.backupSha256,
      flySnapshotId: fixture.recoveryCheckpoint.flySnapshotId,
      flySnapshotDigest: fixture.recoveryCheckpoint.flySnapshotDigest,
    },
    actor: ACTOR,
    reason: REASON,
    executionRelease: RELEASE,
    toolingRevision: TOOLING,
    confirmation: CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
    now: new Date(NOW),
  };
  await assert.rejects(applyCrmDuplicateConsolidation(input), (error) => {
    assert.deepEqual(error.blockers, ['apply-unavailable']);
    return true;
  });
  storage.verifyCrmDuplicateConsolidationBackupPlan = async () => ({
    planChecksum: artifact.planChecksum,
  });
  await assert.rejects(applyCrmDuplicateConsolidation(input), (error) => {
    assert.deepEqual(error.blockers, ['backup-plan-mismatch']);
    return true;
  });
});
