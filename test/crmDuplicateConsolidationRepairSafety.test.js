import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { applyCrmDuplicateConsolidation } from '../server/services/crmDuplicateConsolidationRepair.js';
import { createSqliteCrmDuplicateConsolidationReadOnlyStorage } from '../server/storage/sqlite.js';
import {
  ACTOR,
  BERLIN,
  BERLIN_IMPORT_ID,
  NOW,
  POOLER,
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

test('preview retains terminal loser CIM and outbox provenance without treating it as active work', async (t) => {
  const fixture = await createFixture(t);
  rawDatabase(fixture.sqlitePath, (database) => {
    database.prepare(`
      INSERT INTO deal_hunter_cim_requests (
        id, created_at, updated_at, deal_key, recipient_email, status,
        follow_up_count, attempt_count, submission_id, request_state,
        delivery_state, follow_up_state, next_follow_up_at, metadata
      ) VALUES ('terminal-loser-cim', ?, ?, 'terminal-fixture', 'fixture@invalid.example',
        'sent', 3, 1, ?, 'provider_accepted', 'accepted', 'completed', NULL, '{}')
    `).run(NOW, NOW, BERLIN.supersededSubmissionId);
    database.prepare(`
      INSERT INTO crm_email_outbox (
        id, communication_id, submission_id, idempotency_key, client_request_key, state, provider,
        attempt_count, expected_submission_version, actor, intended_follow_up_state,
        created_at, updated_at, metadata
      ) VALUES ('terminal-loser-outbox', 'missing-terminal-communication', ?,
        'terminal-loser-outbox', 'terminal-loser-outbox-client', 'permanent_failed',
        'fixture', 1, ?, ?, 'needs-response', ?, ?, '{}')
    `).run(BERLIN.supersededSubmissionId, NOW, ACTOR, NOW, NOW);
  });
  const artifact = await previewFixture(fixture);
  assert.deepEqual(artifact.blockers, []);
  assert.ok(artifact.plan.relationshipInventory.some((entry) => (
    entry.table === 'deal_hunter_cim_requests'
      && entry.column === 'submission_id'
      && entry.matchedRowCount === 1
  )));
  assert.ok(artifact.plan.relationshipInventory.some((entry) => (
    entry.table === 'crm_email_outbox'
      && entry.column === 'submission_id'
      && entry.matchedRowCount === 1
  )));
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
    database.exec('DROP TRIGGER trg_crm_duplicate_consolidation_receipt_no_update');
    database.prepare(`
      UPDATE deal_hunter_cim_repair_manifests
      SET manifest = ' ' || manifest
      WHERE id = ?
    `).run(artifact.manifestId);
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
      WHERE id = 'pooler-legacy-import'
    `).run()],
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
