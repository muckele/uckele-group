import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';

import { createManualSubmission } from '../server/services/submissions.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URLS = 'https://example.test/crm-match-authority.csv';
process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED = 'false';
process.env.ADMIN_SESSION_SECRET = 'crm-match-authority-binding-test-secret';

const today = new Date().toISOString().slice(0, 10);
const authoritySourceCsv = [
  'Business Name,Industry,State,Date Added,Profit,Revenue,Asking Price,Broker Name,Broker Company,Broker Contact,Broker Email,Listing URL,Description',
  `"Authority HVAC Services","Commercial HVAC maintenance","GA","${today}","$450,000","$1,800,000","$1,400,000","Erin Broker","Coastal Business Brokers","912-555-0199","erin@example.com","https://example.test/listing/authority-hvac","Recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available."`,
].join('\n');

const originalFetch = globalThis.fetch;
let nonSourceFetchCount = 0;
globalThis.fetch = async (url, _options) => {
  if (String(url) === process.env.DEAL_HUNTER_SHEET_CSV_URLS) {
    return new Response(authoritySourceCsv, {
      status: 200,
      headers: { 'Content-Type': 'text/csv' },
    });
  }
  nonSourceFetchCount += 1;
  return new Response('not found', { status: 404 });
};
after(() => {
  globalThis.fetch = originalFetch;
});

function sharedSqliteStorages(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-match-authority-'));
  const config = {
    storage: { sqlitePath: path.join(directory, 'authority.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  };
  const storages = [createSqliteStorage(config), createSqliteStorage(config)];
  storages.sqlitePath = config.storage.sqlitePath;
  t.after(() => {
    for (const storage of storages) storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storages;
}

const supersessionDigest = 'a'.repeat(64);

function withRawDatabase(sqlitePath, callback) {
  const database = new Database(sqlitePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

async function seedActiveSupersession(storage, sqlitePath, {
  id = 'relation-loser-survivor',
  opportunityId = 'opp-supersession',
  survivorCompany = 'Canonical Survivor',
  survivorListingUrl = 'https://example.test/listing/canonical-survivor',
  loserCompany = 'Historical Loser',
  loserListingUrl = 'https://example.test/listing/historical-loser',
  approvedBy = 'owner@example.test',
  repairDigest = supersessionDigest,
} = {}) {
  await seedOpportunity(storage, opportunityId);
  const survivor = await seedSubmission(storage, {
    company: survivorCompany,
    listingUrl: survivorListingUrl,
    opportunityId,
  });
  const loser = await seedSubmission(storage, {
    company: loserCompany,
    listingUrl: loserListingUrl,
    opportunityId: '',
  });
  const timestamp = '2026-09-16T08:10:00.000Z';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: '2026-09-16T08:00:00.000Z',
    updated_at: timestamp,
    canonical_name: `Authority ${opportunityId}`,
    canonical_recipient: null,
    canonical_location: 'Pooler, GA',
    primary_submission_id: survivor.id,
    identity_version: 'crm-match-authority-test-v1',
    status: 'active',
    metadata: {},
  });
  const manifestId = `manifest-${id}`;
  await storage.upsertDealHunterCimRepairManifest({
    id: manifestId,
    created_at: timestamp,
    updated_at: timestamp,
    mode: 'crm-duplicate-consolidation',
    status: 'applied',
    actor: 'authority-test',
    backup_reference: 'disposable-test-database',
    checksum: repairDigest,
    manifest: { schema: 'crm-duplicate-consolidation-plan-v1' },
    metadata: {},
  });
  insertSupersessionRow(sqlitePath, {
    id,
    timestamp,
    survivorId: survivor.id,
    loserId: loser.id,
    opportunityId,
    approvedBy,
    manifestId,
    repairDigest,
  });
  return { id, opportunityId, survivor, loser, manifestId, timestamp };
}

function insertSupersessionRow(sqlitePath, {
  id,
  timestamp,
  survivorId,
  loserId,
  opportunityId,
  approvedBy = 'owner@example.test',
  manifestId,
  repairDigest = supersessionDigest,
}) {
  return withRawDatabase(sqlitePath, (database) => database.prepare(`
    INSERT INTO crm_submission_supersessions (
      id, created_at, updated_at, status, survivor_submission_id,
      superseded_submission_id, opportunity_id, reason_code, reason_text,
      approved_by, approved_at, actor, repair_version, repair_manifest_id,
      repair_digest, reversed_at, reversed_by, reversal_reason,
      reversal_manifest_id, metadata
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, 'confirmed-duplicate', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
  `).run(
    id, timestamp, timestamp, survivorId, loserId, opportunityId,
    'Reviewed duplicate CRM representation.', approvedBy, timestamp,
    'authority-test', 'crm-duplicate-consolidation-v1', manifestId,
    repairDigest, JSON.stringify({ fixture: id }),
  ));
}

async function reverseActiveSupersession(storage, sqlitePath, relation) {
  const reversedAt = '2026-09-16T08:20:00.000Z';
  const reversalManifestId = `reversal-${relation.id}`;
  await storage.upsertDealHunterCimRepairManifest({
    id: reversalManifestId,
    created_at: reversedAt,
    updated_at: reversedAt,
    mode: 'crm-duplicate-consolidation',
    status: 'applied',
    actor: 'authority-test-reviewer',
    backup_reference: 'disposable-test-database',
    checksum: supersessionDigest,
    manifest: {
      schema: 'crm-duplicate-consolidation-reversal-manifest-v1',
      operation: 'reverse',
      relationId: relation.id,
      applyManifestId: relation.manifestId,
      repairDigest: supersessionDigest,
      survivorSubmissionId: relation.survivor.id,
      supersededSubmissionId: relation.loser.id,
      opportunityId: relation.opportunityId,
    },
    metadata: {},
  });
  withRawDatabase(sqlitePath, (database) => database.prepare(`
    UPDATE crm_submission_supersessions
    SET status = 'reversed', updated_at = ?, reversed_at = ?, reversed_by = ?,
      reversal_reason = ?, reversal_manifest_id = ?
    WHERE id = ?
  `).run(
    reversedAt, reversedAt, 'authority-test-reviewer',
    'Reviewed test reversal.', reversalManifestId, relation.id,
  ));
}

async function seedOpportunity(storage, opportunityId = 'opp-authority') {
  const timestamp = '2026-09-16T08:00:00.000Z';
  return storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: timestamp,
    updated_at: timestamp,
    canonical_name: `Authority ${opportunityId}`,
    canonical_recipient: null,
    canonical_location: 'Pooler, GA',
    primary_submission_id: null,
    identity_version: 'crm-match-authority-test-v1',
    status: 'active',
    metadata: {},
  });
}

async function seedSubmission(storage, {
  company = 'Authority HVAC Services',
  listingUrl = 'https://example.test/listing/authority-hvac',
  opportunityId = 'opp-authority',
} = {}) {
  const created = await createManualSubmission({
    company,
    listing_url: listingUrl,
    status: 'review',
  }, 'crm-match-authority-test', { storage });
  assert.equal(created.ok, true, JSON.stringify(created.errors || []));
  return storage.updateSubmission(created.submission.id, {
    metadata: {
      dealHunter: {
        opportunityId,
        listingAliases: [listingUrl],
      },
    },
  });
}

async function assertUnlinked(storage, opportunityId, submissionId) {
  const submission = await storage.getSubmission(submissionId);
  const opportunity = await storage.getDealHunterOpportunity(opportunityId);
  assert.equal(submission.deal_hunter_opportunity_id, null);
  assert.equal(opportunity.primary_submission_id, null);
}

function dealOsAuthorityCsv() {
  return [
    'Listing ID,Business Name,State,Earnings,Revenue,Asking Price,Years Established,Industry,Description,View Listing URL',
    'DOS-AUTH-1,Authority HVAC Services,GA,$450000,$1800000,$1400000,12,Commercial HVAC,"Recurring maintenance contracts service agreements scheduled maintenance field technicians compliance repair management in place SBA eligible seller financing",https://example.test/listing/authority-hvac',
  ].join('\n');
}

test('SQLite CRM match authority read is complete, deterministic, bounded, and internally consistent across two connections', async (t) => {
  const [reader, writer] = sharedSqliteStorages(t);
  assert.equal(reader.linkDealHunterCrmSubmission, undefined);
  await seedOpportunity(reader);
  const first = await seedSubmission(reader);

  const initial = await reader.readDealHunterCrmMatchAuthority({ limit: 5000 });
  assert.equal(initial.complete, true);
  assert.equal(initial.revisionVersion, 'deal-hunter-crm-match-authority-v2');
  assert.equal(initial.count, 1);
  assert.equal(initial.submissionCount, 1);
  assert.equal(initial.supersessionCount, 0);
  assert.deepEqual(initial.supersessions, []);
  assert.deepEqual(initial.rows.map((row) => row.id), [first.id]);
  assert.match(initial.revision, /^[a-f0-9]{64}$/);

  const secondPromise = seedSubmission(writer, {
    company: 'Authority Plumbing Services',
    listingUrl: 'https://example.test/listing/authority-plumbing',
  });
  const concurrentReadPromise = reader.readDealHunterCrmMatchAuthority({ limit: 5000 });
  const [second, concurrentRead] = await Promise.all([secondPromise, concurrentReadPromise]);

  assert.equal(concurrentRead.complete, true);
  assert.equal(concurrentRead.rows.length, concurrentRead.count);
  assert.equal(new Set(concurrentRead.rows.map((row) => row.id)).size, concurrentRead.count);
  assert.deepEqual(
    concurrentRead.rows.map((row) => row.id),
    [...concurrentRead.rows.map((row) => row.id)].sort(),
  );
  assert.ok([1, 2].includes(concurrentRead.count));

  const settled = await reader.readDealHunterCrmMatchAuthority({ limit: 5000 });
  assert.equal(settled.complete, true);
  assert.equal(settled.count, 2);
  assert.deepEqual(settled.rows.map((row) => row.id), [first.id, second.id].sort());
  assert.notEqual(settled.revision, initial.revision);

  const updateRaceReads = [];
  await Promise.all([
    (async () => {
      for (let index = 0; index < 6; index += 1) {
        await writer.updateSubmission(first.id, { company: `Authority HVAC Services ${index}` });
        await new Promise((resolve) => setImmediate(resolve));
      }
    })(),
    (async () => {
      for (let index = 0; index < 6; index += 1) {
        updateRaceReads.push(await reader.readDealHunterCrmMatchAuthority({ limit: 5000 }));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })(),
  ]);
  for (const snapshot of updateRaceReads) {
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.count, 2);
    assert.equal(snapshot.rows.length, snapshot.count);
    assert.deepEqual(snapshot.rows.map((row) => row.id), [first.id, second.id].sort());
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  }
  const updateSettled = await reader.readDealHunterCrmMatchAuthority({ limit: 5000 });
  assert.equal(updateSettled.rows.find((row) => row.id === first.id).company, 'Authority HVAC Services 5');
  assert.notEqual(updateSettled.revision, settled.revision);

  const bounded = await reader.readDealHunterCrmMatchAuthority({ limit: 1 });
  assert.equal(bounded.complete, false);
  assert.equal(bounded.count, null);
  assert.deepEqual(bounded.rows, []);
  assert.equal(bounded.revision, null);
});

test('SQLite CRM match authority v2 binds the complete ordered active supersession projection and independent bounds', async (t) => {
  const storages = sharedSqliteStorages(t);
  const [reader] = storages;
  const first = await seedActiveSupersession(reader, storages.sqlitePath, {
    id: 'relation-z',
    opportunityId: 'opp-z',
    approvedBy: 'z-owner@example.test',
  });
  const beforeSecond = await reader.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 5000 });
  assert.equal(beforeSecond.complete, true);
  assert.equal(beforeSecond.submissionCount, 2);
  assert.equal(beforeSecond.supersessionCount, 1);
  assert.deepEqual(beforeSecond.supersessions.map((relation) => relation.id), ['relation-z']);
  assert.equal(beforeSecond.supersessions[0].approvedBy, 'z-owner@example.test');
  assert.equal(beforeSecond.supersessions[0].repairDigest, supersessionDigest);

  withRawDatabase(storages.sqlitePath, (database) => {
    database.exec('DROP TRIGGER trg_crm_submission_supersessions_immutable_update');
    database.prepare(`
      UPDATE crm_submission_supersessions SET approved_by = ? WHERE id = ?
    `).run('changed-owner@example.test', first.id);
  });
  const approvalChanged = await reader.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 5000 });
  assert.notEqual(approvalChanged.revision, beforeSecond.revision);
  withRawDatabase(storages.sqlitePath, (database) => database.prepare(`
    UPDATE crm_submission_supersessions SET repair_digest = ? WHERE id = ?
  `).run('c'.repeat(64), first.id));
  const digestChanged = await reader.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 5000 });
  assert.notEqual(digestChanged.revision, approvalChanged.revision);
  withRawDatabase(storages.sqlitePath, (database) => database.prepare(`
    UPDATE crm_submission_supersessions
    SET repair_digest = ?, reason_text = ?, metadata = ?
    WHERE id = ?
  `).run(
    supersessionDigest,
    'Changed reviewed tuple text.',
    '{"fixture":"relation-z", "byteSensitive":true}',
    first.id,
  ));
  const tupleAndMetadataChanged = await reader.readDealHunterCrmMatchAuthority({
    limit: 5000,
    supersessionLimit: 5000,
  });
  assert.notEqual(tupleAndMetadataChanged.revision, digestChanged.revision);

  await seedActiveSupersession(reader, storages.sqlitePath, {
    id: 'relation-a',
    opportunityId: 'opp-a',
    approvedBy: 'a-owner@example.test',
    repairDigest: 'b'.repeat(64),
  });
  const withSecond = await reader.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 5000 });
  assert.equal(withSecond.complete, true);
  assert.equal(withSecond.submissionCount, 4);
  assert.equal(withSecond.supersessionCount, 2);
  assert.deepEqual(withSecond.supersessions.map((relation) => relation.id), ['relation-a', 'relation-z']);
  assert.notEqual(withSecond.revision, beforeSecond.revision);

  const contactBound = await reader.readDealHunterCrmMatchAuthority({ limit: 3, supersessionLimit: 5000 });
  assert.equal(contactBound.complete, false);
  assert.equal(contactBound.revision, null);
  const supersessionBound = await reader.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 1 });
  assert.equal(supersessionBound.complete, false);
  assert.equal(supersessionBound.revision, null);

  await reverseActiveSupersession(reader, storages.sqlitePath, first);
  const afterReversal = await reader.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 5000 });
  assert.equal(afterReversal.complete, true);
  assert.equal(afterReversal.supersessionCount, 1);
  assert.deepEqual(afterReversal.supersessions.map((relation) => relation.id), ['relation-a']);
  assert.notEqual(afterReversal.revision, withSecond.revision);
});

test('SQLite CRM match authority refuses rather than hashing a 5,000-row contact prefix', async (t) => {
  const storages = sharedSqliteStorages(t);
  const [storage] = storages;
  withRawDatabase(storages.sqlitePath, (database) => database.exec(`
    WITH RECURSIVE sequence(value) AS (
      VALUES(1)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 5001
    )
    INSERT INTO contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message, metadata
    )
    SELECT
      printf('bounded-contact-%05d', value),
      '2026-09-16T08:00:00.000Z', '2026-09-16T08:00:00.000Z', 'review',
      'manual', 'not-applicable', 'not-applicable', 'authority-bound-test', '',
      printf('Bounded contact %05d', value),
      printf('bounded-%05d@example.test', value),
      'Complete-set authority bound fixture.', '{}'
    FROM sequence;
  `));

  const authority = await storage.readDealHunterCrmMatchAuthority({
    limit: 5000,
    supersessionLimit: 5000,
  });
  assert.equal(authority.complete, false);
  assert.equal(authority.submissionCount, null);
  assert.equal(authority.supersessionCount, null);
  assert.deepEqual(authority.rows, []);
  assert.equal(authority.revision, null);
});

test('SQLite CRM match authority independently refuses a 5,001st active supersession', async (t) => {
  const storages = sharedSqliteStorages(t);
  const [storage] = storages;
  withRawDatabase(storages.sqlitePath, (database) => {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER trg_crm_submission_supersessions_validate_insert;
      DROP TRIGGER trg_crm_submission_supersessions_no_active_chain_insert;
      WITH RECURSIVE sequence(value) AS (
        VALUES(1)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 5001
      )
      INSERT INTO crm_submission_supersessions (
        id, created_at, updated_at, status, survivor_submission_id,
        superseded_submission_id, opportunity_id, reason_code, reason_text,
        approved_by, approved_at, actor, repair_version, repair_manifest_id,
        repair_digest, metadata
      )
      SELECT
        printf('bounded-relation-%05d', value),
        '2026-09-16T08:00:00.000Z', '2026-09-16T08:00:00.000Z', 'active',
        printf('bounded-survivor-%05d', value),
        printf('bounded-loser-%05d', value),
        printf('bounded-opportunity-%05d', value),
        'confirmed-duplicate', 'Complete-set authority bound fixture.',
        'owner@example.test', '2026-09-16T08:00:00.000Z', 'authority-test',
        'crm-duplicate-consolidation-v1', printf('bounded-manifest-%05d', value),
        '${supersessionDigest}', '{}'
      FROM sequence;
    `);
  });

  const authority = await storage.readDealHunterCrmMatchAuthority({
    limit: 5000,
    supersessionLimit: 5000,
  });
  assert.equal(authority.complete, false);
  assert.equal(authority.submissionCount, null);
  assert.equal(authority.supersessionCount, null);
  assert.deepEqual(authority.supersessions, []);
  assert.equal(authority.revision, null);
});

test('SQLite final linkage rejects an active loser directly and links its unchanged survivor control', async (t) => {
  const storages = sharedSqliteStorages(t);
  const [storage] = storages;
  const relation = await seedActiveSupersession(storage, storages.sqlitePath);
  const authority = await storage.readDealHunterCrmMatchAuthority({ limit: 5000, supersessionLimit: 5000 });

  await assert.rejects(
    storage.linkDealHunterCrmSubmissionIfAuthorityCurrent({
      opportunityId: relation.opportunityId,
      submissionId: relation.loser.id,
      expectedAuthorityRevision: authority.revision,
    }),
    (error) => error?.code === 'CRM_SUBMISSION_SUPERSEDED'
      && error?.survivorSubmissionId === relation.survivor.id,
  );
  assert.equal((await storage.getSubmission(relation.loser.id)).deal_hunter_opportunity_id, null);

  const linked = await storage.linkDealHunterCrmSubmissionIfAuthorityCurrent({
    opportunityId: relation.opportunityId,
    submissionId: relation.survivor.id,
    expectedAuthorityRevision: authority.revision,
  });
  assert.equal(linked.primary_submission_id, relation.survivor.id);
  assert.equal((await storage.getSubmission(relation.survivor.id)).deal_hunter_opportunity_id, relation.opportunityId);
});

test('Supabase CRM match authority paths fail closed without querying or linking', async () => {
  const client = {
    from(table) { assert.fail(`fail-closed authority path queried ${table}`); },
    async rpc(name) { assert.fail(`fail-closed authority path called RPC ${name}`); },
  };
  const storage = createSupabaseStorage({ storage: {} }, { client });
  assert.equal(storage.linkDealHunterCrmSubmission, undefined);
  const expected = (error) => error?.code === 'CRM_MATCH_LOOKUP_INCOMPLETE'
    && error?.status === 503
    && error?.cause?.code === 'CRM_SUPERSESSION_UNAVAILABLE'
    && error?.candidateIds?.length === 0
    && error?.evidenceCategories?.includes('lookup-incomplete')
    && error?.evidenceCategories?.includes('provider-unsupported');
  await assert.rejects(storage.readDealHunterCrmMatchAuthority({ limit: 5000 }), expected);
  await assert.rejects(storage.linkDealHunterCrmSubmissionIfAuthorityCurrent({
    opportunityId: 'opp-authority',
    submissionId: 'submission-authority',
    expectedAuthorityRevision: 'a'.repeat(64),
  }), expected);
});

test('SQLite conditional CRM linkage rejects metadata, lifecycle, candidate-set, and unrelated authority drift without partial linkage', async (t) => {
  await t.test('conflicting metadata ownership', async (t) => {
    const [reviewer, writer] = sharedSqliteStorages(t);
    await seedOpportunity(reviewer);
    await seedOpportunity(reviewer, 'opp-other');
    const selected = await seedSubmission(reviewer);
    const authority = await reviewer.readDealHunterCrmMatchAuthority({ limit: 5000 });

    await writer.updateSubmission(selected.id, {
      metadata: { dealHunter: { opportunityId: 'opp-other' } },
    });

    await assert.rejects(
      reviewer.linkDealHunterCrmSubmissionIfAuthorityCurrent({
        opportunityId: 'opp-authority',
        submissionId: selected.id,
        expectedAuthorityRevision: authority.revision,
        updatedAt: '2026-09-16T08:30:00.000Z',
      }),
      (error) => error?.code === 'CRM_MATCH_AUTHORITY_STALE'
        && error.evidenceCategories?.includes('authority-stale'),
    );
    await assertUnlinked(reviewer, 'opp-authority', selected.id);
  });

  await t.test('selected record becomes inactive', async (t) => {
    const [reviewer, writer] = sharedSqliteStorages(t);
    await seedOpportunity(reviewer);
    const selected = await seedSubmission(reviewer);
    const authority = await reviewer.readDealHunterCrmMatchAuthority({ limit: 5000 });

    await writer.updateSubmission(selected.id, {
      status: 'archived',
      archived_at: '2026-09-16T08:20:00.000Z',
      archived_by: 'authority-test',
    });

    await assert.rejects(
      reviewer.linkDealHunterCrmSubmissionIfAuthorityCurrent({
        opportunityId: 'opp-authority',
        submissionId: selected.id,
        expectedAuthorityRevision: authority.revision,
      }),
      (error) => error?.code === 'CRM_MATCH_AUTHORITY_STALE',
    );
    await assertUnlinked(reviewer, 'opp-authority', selected.id);
  });

  await t.test('another equally supported candidate appears', async (t) => {
    const [reviewer, writer] = sharedSqliteStorages(t);
    await seedOpportunity(reviewer);
    const selected = await seedSubmission(reviewer);
    const authority = await reviewer.readDealHunterCrmMatchAuthority({ limit: 5000 });

    await seedSubmission(writer);

    await assert.rejects(
      reviewer.linkDealHunterCrmSubmissionIfAuthorityCurrent({
        opportunityId: 'opp-authority',
        submissionId: selected.id,
        expectedAuthorityRevision: authority.revision,
      }),
      (error) => error?.code === 'CRM_MATCH_AUTHORITY_STALE',
    );
    await assertUnlinked(reviewer, 'opp-authority', selected.id);
  });

  await t.test('unchanged authority links exactly once', async (t) => {
    const [reviewer] = sharedSqliteStorages(t);
    await seedOpportunity(reviewer);
    const selected = await seedSubmission(reviewer);
    const authority = await reviewer.readDealHunterCrmMatchAuthority({ limit: 5000 });

    const linked = await reviewer.linkDealHunterCrmSubmissionIfAuthorityCurrent({
      opportunityId: 'opp-authority',
      submissionId: selected.id,
      expectedAuthorityRevision: authority.revision,
      updatedAt: '2026-09-16T08:30:00.000Z',
    });

    assert.equal(linked.primary_submission_id, selected.id);
    assert.equal((await reviewer.getSubmission(selected.id)).deal_hunter_opportunity_id, 'opp-authority');
  });

  await t.test('unrelated CRM mutation invalidates the reviewed revision and a fresh review succeeds', async (t) => {
    const [reviewer, writer] = sharedSqliteStorages(t);
    await seedOpportunity(reviewer);
    const selected = await seedSubmission(reviewer);
    const unrelated = await seedSubmission(reviewer, {
      company: 'Unrelated Machine Shop',
      listingUrl: 'https://example.test/listing/unrelated-machine-shop',
      opportunityId: '',
    });
    const staleAuthority = await reviewer.readDealHunterCrmMatchAuthority({ limit: 5000 });

    await writer.updateSubmission(unrelated.id, { company: 'Renamed Unrelated Machine Shop' });

    await assert.rejects(
      reviewer.linkDealHunterCrmSubmissionIfAuthorityCurrent({
        opportunityId: 'opp-authority',
        submissionId: selected.id,
        expectedAuthorityRevision: staleAuthority.revision,
      }),
      (error) => error?.code === 'CRM_MATCH_AUTHORITY_STALE',
    );
    await assertUnlinked(reviewer, 'opp-authority', selected.id);

    const freshAuthority = await reviewer.readDealHunterCrmMatchAuthority({ limit: 5000 });
    assert.notEqual(freshAuthority.revision, staleAuthority.revision);
    const linked = await reviewer.linkDealHunterCrmSubmissionIfAuthorityCurrent({
      opportunityId: 'opp-authority',
      submissionId: selected.id,
      expectedAuthorityRevision: freshAuthority.revision,
    });
    assert.equal(linked.primary_submission_id, selected.id);
  });
});

test('high-fit sync binds the real SQLite link to its last complete CRM match authority review', async (t) => {
  const [storage, writer] = sharedSqliteStorages(t);
  const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const reviewed = await reviewDailyDeals({ storage });
  assert.equal(reviewed.qualified.length, 1);
  const [deal] = reviewed.qualified;
  assert.ok(deal.opportunityId);
  await seedOpportunity(storage, 'opp-other');
  const selected = await seedSubmission(storage, { opportunityId: deal.opportunityId });

  let authorityReads = 0;
  let mutationApplied = false;
  const instrumentedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'readDealHunterCrmMatchAuthority') {
        return async (...args) => {
          const authority = await target.readDealHunterCrmMatchAuthority(...args);
          authorityReads += 1;
          if (authorityReads === 2) {
            await writer.updateSubmission(selected.id, {
              metadata: { dealHunter: { opportunityId: 'opp-other' } },
            });
            mutationApplied = true;
          }
          return authority;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys: reviewed.qualified.map((item) => item.dealKey),
    requestedBy: 'authority-test',
    storage: instrumentedStorage,
  });

  assert.equal(mutationApplied, true, 'the metadata writer runs after the final service authority read');
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'CRM_MATCH_AUTHORITY_STALE');
  assert.equal(result.crmSync.results[0].code, 'CRM_MATCH_AUTHORITY_STALE');
  const after = await storage.getSubmission(selected.id);
  assert.equal(after.deal_hunter_opportunity_id, null);
  assert.equal(after.company, 'Authority HVAC Services');
  assert.equal((await storage.getDealHunterOpportunity(deal.opportunityId)).primary_submission_id, null);
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ limit: 100 })).rows.length, 0);
  assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);
});

for (const authorityMutation of ['insert', 'reverse']) {
  test(`high-fit sync refuses when an active supersession ${authorityMutation} occurs after the final service lookup`, async (t) => {
    const storages = sharedSqliteStorages(t);
    const [storage, writer] = storages;
    const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
    const unrelated = await seedActiveSupersession(storage, storages.sqlitePath, {
      id: `unrelated-${authorityMutation}`,
      opportunityId: `opp-unrelated-${authorityMutation}`,
      survivorCompany: `Unrelated ${authorityMutation} survivor`,
      survivorListingUrl: `https://example.test/unrelated-${authorityMutation}-survivor`,
      loserCompany: `Unrelated ${authorityMutation} loser`,
      loserListingUrl: `https://example.test/unrelated-${authorityMutation}-loser`,
    });
    if (authorityMutation === 'insert') {
      await reverseActiveSupersession(storage, storages.sqlitePath, unrelated);
    }

    const reviewed = await reviewDailyDeals({ storage });
    const [deal] = reviewed.qualified;
    const selected = await seedSubmission(storage, { opportunityId: deal.opportunityId });
    nonSourceFetchCount = 0;
    let authorityReads = 0;
    let concurrentMutationApplied = false;
    const instrumentedStorage = new Proxy(storage, {
      get(target, property) {
        if (property === 'readDealHunterCrmMatchAuthority') {
          return async (...args) => {
            const authority = await target.readDealHunterCrmMatchAuthority(...args);
            authorityReads += 1;
            if (authorityReads === 2) {
              if (authorityMutation === 'insert') {
                insertSupersessionRow(storages.sqlitePath, {
                  id: `${unrelated.id}-replacement`,
                  timestamp: '2026-09-16T08:25:00.000Z',
                  survivorId: unrelated.survivor.id,
                  loserId: unrelated.loser.id,
                  opportunityId: unrelated.opportunityId,
                  manifestId: unrelated.manifestId,
                });
              } else {
                await reverseActiveSupersession(writer, storages.sqlitePath, unrelated);
              }
              concurrentMutationApplied = true;
            }
            return authority;
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await syncDealHunterHighFitsToCrm({
      confirmation: 'SYNC HIGH FITS',
      expectedDealKeys: reviewed.qualified.map((item) => item.dealKey),
      requestedBy: 'authority-test',
      storage: instrumentedStorage,
    });

    assert.equal(concurrentMutationApplied, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CRM_MATCH_AUTHORITY_STALE');
    const selectedAfter = await storage.getSubmission(selected.id);
    assert.equal(selectedAfter.deal_hunter_opportunity_id, null);
    assert.equal(selectedAfter.company, 'Authority HVAC Services');
    assert.equal((await storage.getDealHunterOpportunity(deal.opportunityId)).primary_submission_id, null);
    const importsAfter = await storage.listDealHunterCrmImports({ limit: 100 });
    assert.equal(importsAfter.length, 1, 'only the explicitly permitted failed import-claim bookkeeping remains');
    assert.equal(importsAfter[0].status, 'failed');
    assert.equal(importsAfter[0].submission_id, '');
    assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
    assert.equal((await storage.listCrmCommunications({ limit: 100 })).rows.length, 0);
    assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);
    assert.equal((await storage.listEmailEvents({ limit: 100 })).length, 0);
    assert.equal(nonSourceFetchCount, 0, 'no provider or other non-source HTTP request is attempted');
  });
}

test('unchanged high-fit authority performs exactly one conditional link and one CRM update', async (t) => {
  const [storage] = sharedSqliteStorages(t);
  const { reviewDailyDeals, syncDealHunterHighFitsToCrm } = await import('../server/services/dealHunter.js');
  const reviewed = await reviewDailyDeals({ storage });
  const [deal] = reviewed.qualified;
  const selected = await seedSubmission(storage, { opportunityId: deal.opportunityId });
  let conditionalLinks = 0;
  let submissionUpdates = 0;
  const instrumentedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'linkDealHunterCrmSubmissionIfAuthorityCurrent') {
        return async (...args) => {
          conditionalLinks += 1;
          return target.linkDealHunterCrmSubmissionIfAuthorityCurrent(...args);
        };
      }
      if (property === 'mutateWithCrmActivity') {
        return async (input) => {
          if (input?.operation === 'update_submission') submissionUpdates += 1;
          return target.mutateWithCrmActivity(input);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const result = await syncDealHunterHighFitsToCrm({
    confirmation: 'SYNC HIGH FITS',
    expectedDealKeys: reviewed.qualified.map((item) => item.dealKey),
    requestedBy: 'authority-test',
    storage: instrumentedStorage,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(conditionalLinks, 1);
  assert.equal(submissionUpdates, 1);
  assert.equal((await storage.getSubmission(selected.id)).deal_hunter_opportunity_id, deal.opportunityId);
  assert.equal((await storage.getDealHunterOpportunity(deal.opportunityId)).primary_submission_id, selected.id);
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ limit: 100 })).rows.length, 0);
  assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);
});

test('reconciliation refuses linkage when archiveLead invalidates the selected row after the final match review', async (t) => {
  const [storage, writer] = sharedSqliteStorages(t);
  const { archiveLead } = await import('../server/services/leadLifecycle.js');
  const {
    executeDealOsCrmReconciliation,
    importDealOsExport,
    previewDealOsCrmReconciliation,
  } = await import('../server/services/dealHunter.js');
  const now = new Date();
  const imported = await importDealOsExport({
    fileBuffer: Buffer.from(dealOsAuthorityCsv()),
    fileName: 'crm-match-authority-archive.csv',
    exportedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    scope: 'saved-search',
    coverageLabel: 'CRM match authority archive race fixture',
    expectedRowCount: 1,
    importedBy: 'authority-test',
    storage,
    now,
  });
  assert.equal(imported.ok, true);
  const discovery = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'authority-test',
    storage,
  });
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  const opportunityId = discovery.expectedOpportunityIds[0];
  const selected = await seedSubmission(storage, { opportunityId });
  const preview = await previewDealOsCrmReconciliation({
    importId: imported.import.id,
    requestedBy: 'authority-test',
    storage,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));

  let claimed = false;
  let archivedAfterFinalReview = false;
  const instrumentedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'claimDealHunterCrmImport') {
        return async (...args) => {
          const claim = await target.claimDealHunterCrmImport(...args);
          claimed = Boolean(claim.claimed);
          return claim;
        };
      }
      if (property === 'readDealHunterCrmMatchAuthority') {
        return async (...args) => {
          const authority = await target.readDealHunterCrmMatchAuthority(...args);
          if (claimed && !archivedAfterFinalReview) {
            const archived = await archiveLead({
              submissionId: selected.id,
              reason: 'other',
              note: 'Deterministic CRM match authority race fixture.',
              actor: 'authority-test-writer',
              storage: writer,
            });
            assert.equal(archived.ok, true, JSON.stringify(archived));
            archivedAfterFinalReview = true;
          }
          return authority;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const result = await executeDealOsCrmReconciliation({
    importId: imported.import.id,
    planDigest: preview.planDigest,
    previewGeneratedAt: preview.generatedAt,
    expectedOpportunityIds: preview.expectedOpportunityIds,
    confirmation: preview.confirmationRequired,
    requestedBy: 'authority-test',
    storage: instrumentedStorage,
  });

  assert.equal(archivedAfterFinalReview, true, 'archiveLead runs after the final service authority read');
  assert.equal(result.ok, false);
  assert.equal(result.status, 207);
  assert.equal(result.resultCounts.failed, 1);
  assert.equal(result.run.status, 'completed-with-errors');
  assert.equal(result.run.results.items[0].code, 'CRM_MATCH_AUTHORITY_STALE');
  const durableItems = await storage.listDealHunterCrmReconciliationItems(result.run.id, { limit: 100 });
  assert.equal(durableItems[0].status, 'failed');
  assert.match(durableItems[0].error, /authority changed/i);
  const after = await storage.getSubmission(selected.id);
  assert.equal(after.status, 'archived');
  assert.equal(after.company, 'Authority HVAC Services');
  assert.equal(after.deal_hunter_opportunity_id, null);
  assert.equal((await storage.getDealHunterOpportunity(opportunityId)).primary_submission_id, null);
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ limit: 100 })).rows.length, 0);
  assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);
  assert.equal((await storage.listEmailEvents({ limit: 100 })).length, 0);
});

test('direct CIM retains a newly created row but refuses link and outbound when createManualSubmission adds an equal candidate after review', async (t) => {
  const [storage, writer] = sharedSqliteStorages(t);
  const { reviewDailyDeals, sendDealHunterCimRequest } = await import('../server/services/dealHunter.js');
  nonSourceFetchCount = 0;
  const reviewed = await reviewDailyDeals({ storage });
  assert.equal(reviewed.qualified.length, 1);
  const [deal] = reviewed.qualified;
  assert.equal(deal.cimRequest.canRequest, true, JSON.stringify(deal.cimRequest));

  let competingWriterRan = false;
  const instrumentedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'readDealHunterCrmMatchAuthority') {
        return async (...args) => {
          const authority = await target.readDealHunterCrmMatchAuthority(...args);
          if (!competingWriterRan
            && authority.count === 1
            && authority.rows[0]?.company === 'Authority HVAC Services') {
            const competing = await createManualSubmission({
              company: 'Authority HVAC Services',
              listing_url: 'https://example.test/listing/authority-hvac',
              status: 'review',
            }, 'authority-test-competing-writer', { storage: writer });
            assert.equal(competing.ok, true, JSON.stringify(competing.errors || []));
            competingWriterRan = true;
          }
          return authority;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const result = await sendDealHunterCimRequest({
    dealKey: deal.dealKey,
    snapshotToken: deal.cimRequest.snapshotToken,
    requestedBy: 'authority-test',
    storage: instrumentedStorage,
  });

  assert.equal(competingWriterRan, true, 'createManualSubmission runs after the created-row authority read');
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'CRM_MATCH_AUTHORITY_STALE');
  const submissions = await storage.listSubmissions({ status: 'all', page: 1, limit: 100 });
  assert.equal(submissions.rows.length, 2, 'both the retained attempted row and competing writer row remain reviewable');
  assert.ok(submissions.rows.every((submission) => submission.deal_hunter_opportunity_id === null));
  assert.equal((await storage.getDealHunterOpportunity(deal.opportunityId)).primary_submission_id, null);
  const imports = await storage.listDealHunterCrmImports({ limit: 100 });
  assert.equal(imports.length, 1);
  assert.equal(imports[0].status, 'failed');
  assert.equal((await storage.listDealHunterCimRequests({ limit: 100 })).length, 0);
  assert.equal((await storage.listCrmCommunications({ limit: 100 })).rows.length, 0);
  assert.equal((await storage.listCrmEmailOutbox({ limit: 100 })).length, 0);
  assert.equal((await storage.listEmailEvents({ limit: 100 })).length, 0);
  assert.equal(nonSourceFetchCount, 0, 'no provider or other non-source HTTP request is attempted');
});
