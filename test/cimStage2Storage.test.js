import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

async function temporaryDatabase(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sqlitePath = path.join(directory, 'stage2.sqlite');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return sqlitePath;
}

test('production-shaped SQLite review evidence migrates additively and restart is idempotent', async (t) => {
  const sqlitePath = await temporaryDatabase(t, 'uckele-cim-stage2-migration-');
  const legacy = new Database(sqlitePath);
  legacy.exec(`
    CREATE TABLE deal_hunter_cim_reviews (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      deal_key TEXT NOT NULL,
      decision TEXT NOT NULL,
      pass_reason TEXT,
      original_recipient_email TEXT,
      final_recipient_email TEXT,
      recipient_edited INTEGER NOT NULL DEFAULT 0,
      score INTEGER,
      actor TEXT,
      automation_stage INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO deal_hunter_cim_reviews (
      id, created_at, deal_key, decision, pass_reason, original_recipient_email,
      final_recipient_email, recipient_edited, score, actor, automation_stage, metadata
    ) VALUES (
      'historical-review', '2026-08-01T12:00:00.000Z', 'legacy-deal-key', 'approved', '',
      'historical@example.test', 'historical@example.test', 0, 95, 'historical-admin', 1,
      '{"source":"approval-queue","retained":true}'
    );
  `);
  legacy.close();

  const first = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  assert.equal((await first.checkCimStage2Storage()).ok, true);
  first.close();

  const second = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  assert.equal((await second.checkCimStage2Storage()).ok, true);
  second.close();

  const migrated = new Database(sqlitePath, { readonly: true });
  const row = migrated.prepare("SELECT * FROM deal_hunter_cim_reviews WHERE id = 'historical-review'").get();
  const reviewColumns = migrated.prepare('PRAGMA table_info(deal_hunter_cim_reviews)').all().map((column) => column.name);
  const stage2Tables = migrated.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'deal_hunter_cim_stage2_%'
    ORDER BY name
  `).all().map((item) => item.name);
  migrated.close();

  assert.equal(row.deal_key, 'legacy-deal-key');
  assert.equal(row.decision, 'approved');
  assert.equal(row.original_recipient_email, 'historical@example.test');
  assert.equal(row.metadata, '{"source":"approval-queue","retained":true}');
  assert.equal(row.opportunity_id, null);
  assert.equal(row.rule_version, null);
  assert.equal(row.source_ids, '[]');
  assert.ok(reviewColumns.includes('evidence_version'));
  assert.deepEqual(stage2Tables, [
    'deal_hunter_cim_stage2_activations',
    'deal_hunter_cim_stage2_decisions',
    'deal_hunter_cim_stage2_runs',
  ]);
});

test('SQLite Stage 2 run and decision claims are durable, exclusive, and capacity-conservative', async (t) => {
  const sqlitePath = await temporaryDatabase(t, 'uckele-cim-stage2-claims-');
  const storage = createSqliteStorage({ storage: { sqlitePath }, protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const createdAt = '2026-08-12T16:00:00.000Z';
  const run = {
    id: 'stage2-run-1',
    run_key: 'stage2:2026-08-12:canary:policy',
    created_at: createdAt,
    updated_at: createdAt,
    pacific_business_date: '2026-08-12',
    mode: 'canary',
    status: 'running',
    triggered_by: 'test-admin',
    policy_hash: 'a'.repeat(64),
    rule_version: 'rules-v1',
    source_policy_hash: 'b'.repeat(64),
    activation_id: 'activation-1',
    metadata: {},
  };
  const firstRunClaim = await storage.claimCimStage2Run(run);
  const secondRunClaim = await storage.claimCimStage2Run({ ...run, id: 'stage2-run-2' });
  assert.equal(firstRunClaim.claimed, true);
  assert.equal(secondRunClaim.claimed, false);
  assert.equal(secondRunClaim.run.id, run.id);

  await storage.insertCimStage2Decisions([{
    id: 'stage2-decision-1',
    run_id: run.id,
    created_at: createdAt,
    updated_at: createdAt,
    opportunity_id: 'opportunity-1',
    deal_key: 'deal-1',
    decision_state: 'eligible',
    policy_hash: run.policy_hash,
    rule_version: run.rule_version,
    source_policy_hash: run.source_policy_hash,
    activation_id: run.activation_id,
    snapshot_digest: 'c'.repeat(64),
    recipient_hash: 'd'.repeat(64),
    source_snapshot_digest: 'e'.repeat(64),
    reasons: [],
    metadata: {},
  }]);
  await storage.insertCimStage2Decisions([2, 3].map((number) => ({
    id: `stage2-decision-${number}`,
    run_id: run.id,
    created_at: `2026-08-12T16:00:0${number}.000Z`,
    updated_at: `2026-08-12T16:00:0${number}.000Z`,
    opportunity_id: `opportunity-${number}`,
    deal_key: `deal-${number}`,
    decision_state: 'blocked',
    policy_hash: run.policy_hash,
    rule_version: run.rule_version,
    source_policy_hash: run.source_policy_hash,
    activation_id: run.activation_id,
    snapshot_digest: String(number).repeat(64),
    recipient_hash: String(number + 1).repeat(64),
    source_snapshot_digest: String(number + 2).repeat(64),
    reasons: ['fixture-block'],
    metadata: {},
  })));
  const firstDecisionPage = await storage.listCimStage2Decisions({ runId: run.id, limit: 2, offset: 0 });
  const secondDecisionPage = await storage.listCimStage2Decisions({ runId: run.id, limit: 2, offset: 2 });
  assert.deepEqual(firstDecisionPage.map((decision) => decision.id), ['stage2-decision-3', 'stage2-decision-2']);
  assert.deepEqual(secondDecisionPage.map((decision) => decision.id), ['stage2-decision-1']);
  const firstDecisionClaim = await storage.claimCimStage2Decision({
    id: 'stage2-decision-1', claimToken: 'claim-1', claimedAt: createdAt, activationId: run.activation_id,
  });
  const secondDecisionClaim = await storage.claimCimStage2Decision({
    id: 'stage2-decision-1', claimToken: 'claim-2', claimedAt: createdAt, activationId: run.activation_id,
  });
  assert.equal(firstDecisionClaim.claimed, true);
  assert.equal(secondDecisionClaim.claimed, false);
  assert.equal(await storage.countCimStage2Capacity({ pacificBusinessDate: '2026-08-12' }), 1);

  const attempting = await storage.transitionCimStage2Decision({
    id: 'stage2-decision-1', expectedStates: ['claimed'], state: 'attempting', updates: {},
  });
  const staleTransition = await storage.transitionCimStage2Decision({
    id: 'stage2-decision-1', expectedStates: ['claimed'], state: 'accepted', updates: {},
  });
  const ambiguous = await storage.transitionCimStage2Decision({
    id: 'stage2-decision-1', expectedStates: ['attempting'], state: 'ambiguous',
    updates: { provider_state: 'ambiguous' },
  });
  assert.equal(attempting.applied, true);
  assert.equal(staleTransition.applied, false);
  assert.equal(ambiguous.applied, true);
  assert.equal(await storage.countCimStage2Capacity({ pacificBusinessDate: '2026-08-12' }), 1);
});
