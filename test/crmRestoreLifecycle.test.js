import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { restoreLead } from '../server/services/leadLifecycle.js';
import { restoreProtectedTables, stoppedRestoreAuthoritySql } from './fixtures/crmRestoreStoppedAuthority.js';

const at = '2026-10-18T10:00:00.000Z';
const submissionId = '11111111-1111-4111-8111-111111111111';

async function fixture(t, { linked = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl02-restore-'));
  const sqlitePath = path.join(root, 'fixture.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath } });
  const db = new Database(sqlitePath);
  t.after(() => { db.close(); storage.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO contact_submissions
    (id, created_at, updated_at, status, delivery_provider, delivery_status, crm_status,
     source, ip_hash, name, email, message, archived_at, archive_reason, archive_note,
     follow_up_state, next_action_at, metadata)
    VALUES (?, ?, ?, 'archived', 'console', 'not-sent', 'not-synced', 'fl02-synthetic',
     'synthetic', 'Synthetic Archived Lead', 'broker@example.test', 'Synthetic', ?,
     'Original owner reason', 'Retained exact decision note', 'completed', NULL, ?)`)
    .run(submissionId, at, at, at, JSON.stringify(linked ? { acquisitionCommand: {
      pipelineStage: 'passed', passReason: 'Original owner reason', fitFeedback: 'false-positive',
      updatedAt: at, updatedBy: 'owner',
    }, preservedNote: 'Keep unrelated metadata' } : {}));
  const result = { storage, db, restore: (extra = {}) => restoreLead({ storage, submissionId,
    status: 'review', expectedUpdatedAt: at, actor: 'fixture-owner', ...extra }) };
  if (!linked) return result;
  await storage.upsertDealHunterOpportunity({ opportunity_id: 'canonical-restore', created_at: at, updated_at: at,
    canonical_name: 'Synthetic Archived Lead', canonical_location: null, canonical_recipient: null,
    primary_submission_id: submissionId, identity_version: 'fl02-fixture', status: 'active', metadata: {} });
  await storage.upsertDealHunterOpportunityAlias({ id: 'restore-alias', opportunity_id: 'canonical-restore',
    alias_type: 'deal-key', alias_value: 'restore-deal', alias_key: 'deal-key:restore-deal',
    source: 'fl02-synthetic', first_observed_at: at, last_observed_at: at, evidence_version: 'synthetic',
    resolution_method: 'exact-deal-key', confidence_state: 'exact', resolved_by: 'fixture', metadata: {} });
  await storage.upsertDealHunterDisposition({ id: 'restore-pass', deal_key: 'restore-deal', submission_id: submissionId,
    deal_name: 'Synthetic Archived Lead', created_at: at, updated_at: at, disposition: 'dismissed',
    reason: 'Original owner reason', note: 'Retained exact decision note', dismissed_at: at,
    dismissed_by: 'owner', created_by: 'owner', updated_by: 'owner', metadata: {} });
  return result;
}

test('CRM Restore atomically clears linked canonical Pass while retaining history and stopped outreach', async (t) => {
  const { storage, restore } = await fixture(t);
  const result = await restore();
  assert.equal(result.ok, true);
  assert.equal(result.submission.status, 'review');
  assert.equal(result.submission.follow_up_state, 'completed');
  assert.equal(result.submission.next_action_at, null);
  const disposition = await storage.getDealHunterDisposition({ dealKey: 'restore-deal' });
  assert.equal(disposition.disposition, 'restored');
  assert.equal(disposition.reason, 'Original owner reason');
  assert.equal(disposition.note, 'Retained exact decision note');
  assert.equal(disposition.dismissed_at, at);
  assert.equal(disposition.id, 'restore-pass');
  assert.equal(result.submission.archive_reason, 'Original owner reason');
  assert.equal(result.submission.archive_note, 'Retained exact decision note');
  assert.equal(result.submission.metadata.preservedNote, 'Keep unrelated metadata');
  assert.equal(result.submission.metadata.acquisitionCommand.pipelineStage, undefined);
  assert.equal(result.submission.metadata.acquisitionCommand.passReason, undefined);
  const events = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
  assert.equal(events.filter((event) => event.event_type === 'submission.restored').length, 1);
  assert.deepEqual(events[0].metadata.restoredDispositionIds, ['restore-pass']);
  assert.equal(events[0].metadata.previousAcquisitionCommand.pipelineStage, 'passed');
});

test('repeated and stale restores conflict without appending another activity', async (t) => {
  const { storage, restore } = await fixture(t);
  assert.equal((await restore({ expectedUpdatedAt: '2026-10-17T10:00:00.000Z' })).status, 409);
  assert.equal((await restore()).ok, true);
  assert.equal((await restore()).status, 409);
  const events = await storage.listCrmActivityEvents({ submissionId, limit: 100 });
  assert.equal(events.length, 1);
});

test('restore clears only a Pass projection with proven matching finite timestamps', async (t) => {
  for (const [commandAt, dismissedAt, cleared] of [
    [null, null, false], ['unrelated-date', at, false],
    ['2026-10-18T10:00:00.123001Z', '2026-10-18T10:00:00.123999Z', false],
    ['2026-02-30T10:00:00.000Z', '2026-02-30T10:00:00.000Z', false],
    ['2026-10-18T24:00:00.000Z', '2026-10-19T00:00:00.000Z', false],
    ['2026-10-18T05:00:00.000-05:00', at, true],
  ]) {
    const { db, restore } = await fixture(t);
    db.prepare(`UPDATE contact_submissions SET metadata=json_set(metadata,
      '$.acquisitionCommand.updatedAt', ?, '$.diligenceDecision', 'independent-pass') WHERE id=?`)
      .run(commandAt, submissionId);
    db.prepare('UPDATE deal_hunter_dispositions SET dismissed_at=?').run(dismissedAt);
    const result = await restore();
    assert.equal(result.ok, true);
    assert.equal(result.submission.metadata.acquisitionCommand.pipelineStage, cleared ? undefined : 'passed');
    assert.equal(result.submission.metadata.diligenceDecision, 'independent-pass');
  }
});

test('standalone CRM restore preserves the existing closed status set and no schedule', async (t) => {
  for (const status of ['sourced', 'new', 'review', 'contacted']) {
    const { restore } = await fixture(t, { linked: false });
    const result = await restore({ status });
    assert.equal(result.ok, true);
    assert.equal(result.submission.status, status);
    assert.equal(result.submission.next_action_at, null);
    assert.equal(result.submission.follow_up_state, 'completed');
  }
});

test('restore audit failure rolls back both CRM and canonical disposition', async (t) => {
  const { storage, db, restore } = await fixture(t);
  db.exec(`CREATE TRIGGER reject_restore_audit BEFORE INSERT ON crm_activity_events
    WHEN NEW.event_type = 'submission.restored' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  await assert.rejects(restore(), /synthetic audit failure/);
  assert.equal((await storage.getSubmission(submissionId)).status, 'archived');
  assert.equal((await storage.getDealHunterDisposition({ dealKey: 'restore-deal' })).disposition, 'dismissed');
  assert.equal((await storage.listCrmActivityEvents({ submissionId })).length, 0);
});

for (const [label, change] of [
  ['orphan direct claim', (db) => db.prepare('UPDATE contact_submissions SET deal_hunter_opportunity_id = ? WHERE id = ?').run('missing-canonical', submissionId)],
  ['conflicting metadata claim', (db) => db.prepare(`UPDATE contact_submissions SET metadata = json_set(metadata, '$.dealHunter.opportunityId', 'foreign') WHERE id = ?`).run(submissionId)],
  ['unknown retained metadata key', (db) => db.prepare(`UPDATE contact_submissions SET metadata = json_set(metadata, '$.dealHunter.dealKey', 'missing-key') WHERE id = ?`).run(submissionId)],
  ['nonstring retained metadata key', (db) => db.prepare(`UPDATE contact_submissions SET metadata = json_set(metadata, '$.dealHunter.dealKey', 17) WHERE id = ?`).run(submissionId)],
  ['superseded canonical', (db) => db.prepare("UPDATE deal_hunter_opportunities SET status = 'superseded' WHERE opportunity_id = 'canonical-restore'").run()],
  ['missing durable key ownership', (db) => db.prepare('DELETE FROM deal_hunter_opportunity_aliases WHERE id = ?').run('restore-alias')],
  ['foreign disposition submission', (db) => db.prepare('UPDATE deal_hunter_dispositions SET submission_id = ? WHERE id = ?').run('22222222-2222-4222-8222-222222222222', 'restore-pass')],
]) {
  test(`restore rejects ${label} without partial writes`, async (t) => {
    const { storage, db, restore } = await fixture(t);
    change(db);
    const result = await restore();
    assert.equal(result.status, 409);
    assert.equal((await storage.getSubmission(submissionId)).status, 'archived');
    assert.equal((await storage.getDealHunterDisposition({ dealKey: 'restore-deal' })).disposition, 'dismissed');
    assert.equal((await storage.listCrmActivityEvents({ submissionId })).length, 0);
  });
}

test('restore revalidates a primary reassignment between service read and atomic mutation', async (t) => {
  const { storage, db, restore } = await fixture(t);
  const racingStorage = { ...storage, async mutateWithCrmActivity(mutation) {
    db.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
      .run(null, 'canonical-restore');
    return storage.mutateWithCrmActivity(mutation);
  } };
  assert.equal((await restore({ storage: racingStorage })).status, 409);
  assert.equal((await storage.getSubmission(submissionId)).status, 'archived');
});

test('restore preserves opt-out, permission, terminal campaign, enrollment and cap counters byte-for-byte', async (t) => {
  const { db, restore } = await fixture(t);
  db.exec(stoppedRestoreAuthoritySql(submissionId, 'canonical-restore'));
  const snapshot = () => Object.fromEntries(restoreProtectedTables.map((table) => [table,
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const before = snapshot();
  assert.equal((await restore()).ok, true);
  assert.deepEqual(snapshot(), before);
});

test('multiple retained aliases restore together without current score eligibility or source health', async (t) => {
  const { storage, db, restore } = await fixture(t);
  await storage.upsertDealHunterOpportunityAlias({ id: 'restore-alias-old', opportunity_id: 'canonical-restore',
    alias_type: 'deal-key', alias_value: 'old-source-key', alias_key: 'deal-key:old-source-key',
    source: 'historical-source', first_observed_at: at, last_observed_at: at, evidence_version: 'synthetic',
    resolution_method: 'exact-deal-key', confidence_state: 'exact', resolved_by: 'fixture', metadata: {} });
  await storage.upsertDealHunterDisposition({ id: 'historical-pass', deal_key: 'old-source-key', submission_id: null,
    deal_name: 'Old source name', created_at: at, updated_at: at, disposition: 'dismissed',
    reason: 'Historical reason', note: 'Retain historical detail', dismissed_at: at,
    dismissed_by: 'owner', created_by: 'owner', updated_by: 'owner', metadata: {} });
  assert.equal(db.prepare('SELECT count(*) AS n FROM deal_hunter_opportunity_scores').get().n, 0);
  assert.equal((await restore()).ok, true);
  assert.deepEqual(db.prepare('SELECT id,disposition FROM deal_hunter_dispositions ORDER BY id').all(), [
    { id: 'historical-pass', disposition: 'restored' }, { id: 'restore-pass', disposition: 'restored' },
  ]);
});

test('restore refuses multiple primaries and a raced alias reassignment', async (t) => {
  for (const kind of ['second-primary', 'moved-alias']) {
    const { storage, db, restore } = await fixture(t);
    await storage.upsertDealHunterOpportunity({ opportunity_id: 'foreign', created_at: at, updated_at: at,
      canonical_name: 'Different business', canonical_location: null, canonical_recipient: null,
      primary_submission_id: kind === 'second-primary' ? submissionId : null,
      identity_version: 'fixture', status: 'active', metadata: {} });
    const racing = { ...storage, async mutateWithCrmActivity(mutation) {
      if (kind === 'moved-alias') db.prepare('UPDATE deal_hunter_opportunity_aliases SET opportunity_id = ? WHERE id = ?')
        .run('foreign', 'restore-alias');
      return storage.mutateWithCrmActivity(mutation);
    } };
    assert.equal((await restore({ storage: racing })).status, 409);
    assert.equal((await storage.getSubmission(submissionId)).status, 'archived');
  }
});

test('restore reconciles retained CRM deal keys with exact canonical ownership', async (t) => {
  for (const foreign of [false, true]) {
    const { storage, db, restore } = await fixture(t);
    await storage.upsertDealHunterOpportunity({ opportunity_id: 'foreign', created_at: at, updated_at: at,
      canonical_name: 'Different business', primary_submission_id: null, identity_version: 'fixture', status: 'active', metadata: {} });
    db.prepare(`UPDATE contact_submissions SET metadata = json_set(metadata, '$.dealHunter.dealKey', 'restore-deal') WHERE id = ?`).run(submissionId);
    if (foreign) {
      await storage.upsertDealHunterOpportunityAlias({ id: 'foreign-key', opportunity_id: 'foreign',
        alias_type: 'deal-key', alias_value: 'foreign-key', alias_key: 'deal-key:foreign-key',
        source: 'synthetic', first_observed_at: at, last_observed_at: at, evidence_version: 'synthetic',
        resolution_method: 'exact-deal-key', confidence_state: 'exact', resolved_by: 'fixture', metadata: {} });
      db.prepare(`UPDATE contact_submissions SET metadata = json_set(metadata, '$.dealHunter.dealKey', 'foreign-key') WHERE id = ?`).run(submissionId);
    }
    assert.equal((await restore()).status, foreign ? 409 : 200);
    assert.equal((await storage.getSubmission(submissionId)).status, foreign ? 'archived' : 'review');
    assert.equal((await storage.listCrmActivityEvents({ submissionId })).length, foreign ? 0 : 1);
  }
});

test('non-owner service restore and forged atomic activity/payload are rejected without writes', async (t) => {
  const { storage, restore } = await fixture(t);
  assert.equal((await restore({ role: 'viewer' })).status, 403);
  for (const change of [{ status: 'spam' }, { permissionOverride: true }]) {
    await assert.rejects(storage.mutateWithCrmActivity({ operation: 'restore_submission',
      payload: { id: submissionId, expectedUpdatedAt: at, status: 'review', ...change },
      activity: { id: 'fixture-forged', submission_id: submissionId, event_type: 'submission.restored',
        actor: 'fixture-owner', role: 'admin', created_at: at, summary: 'Synthetic restore', metadata: {} },
    }), /Invalid atomic CRM restore authority/);
  }
  assert.equal((await storage.getSubmission(submissionId)).status, 'archived');
});
