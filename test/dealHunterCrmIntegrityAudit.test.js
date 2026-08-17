import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const { auditDealHunterCrmIntegrity } = await import('../server/services/dealHunter.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { createSqliteStorage } = await import('../server/storage/sqlite.js');

// Forces the exhaustive whole-CRM read the audit used before the narrow lookups
// existed, so both paths can be compared on identical data.
function withoutNarrowLookups(storage) {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'listDealHunterLinkedSubmissions' || property === 'listSubmissionsByIds') return undefined;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function seedBrokenCrm(storage) {
  const now = new Date().toISOString();
  const seed = await createManualSubmission(
    { name: 'Seed Owner', email: 'seed@example.test', company: 'Seed Co', message: 'seed record for the integrity audit fixture' },
    'admin',
    { storage },
  );
  assert.equal(seed.ok, true, JSON.stringify(seed.errors));
  const template = await storage.getSubmission(seed.submission.id);

  const insert = async (overrides) => {
    const id = randomUUID();
    await storage.insertSubmission({ ...template, id, ...overrides });
    return id;
  };
  const opportunity = async (opportunityId, primarySubmissionId) => storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId,
    created_at: now,
    updated_at: now,
    canonical_name: opportunityId,
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: primarySubmissionId,
    identity_version: 'audit-fixture-v1',
    status: 'active',
    metadata: {},
  });

  // Unrelated CRM traffic the audit must ignore entirely.
  for (let index = 0; index < 25; index += 1) {
    await insert({ company: `Unrelated Record ${index}`, source: 'contact-form', deal_hunter_opportunity_id: null, metadata: {} });
  }

  // A healthy managed record.
  const healthyId = await insert({
    company: 'Healthy Managed Co',
    source: 'deal-hunter-daily-review',
    deal_hunter_opportunity_id: 'opp_healthy',
    metadata: { dealHunter: { managed: true, opportunityId: 'opp_healthy', raw: { 'Business Name': 'Healthy Managed Co' } } },
  });
  await opportunity('opp_healthy', healthyId);

  // Direct column and metadata disagree about the canonical owner.
  const mismatchedId = await insert({
    company: 'Mismatched Owner Co',
    source: 'deal-hunter-daily-review',
    deal_hunter_opportunity_id: 'opp_mismatch_direct',
    metadata: { dealHunter: { managed: true, opportunityId: 'opp_mismatch_metadata', raw: { 'Business Name': 'Mismatched Owner Co' } } },
  });
  await opportunity('opp_mismatch_direct', mismatchedId);

  // Linked only through metadata, the way records were linked before the direct
  // column existed. The narrow read must still find these.
  const legacyLinkedId = await insert({
    company: 'Legacy Metadata Linked Co',
    source: 'referral-partner',
    deal_hunter_opportunity_id: null,
    metadata: { dealHunter: { managed: true, opportunityId: 'opp_legacy', raw: { 'Business Name': 'A Completely Different Source Name' } } },
  });

  // A second claimant on the legacy opportunity, producing duplicate primaries.
  await opportunity('opp_legacy', legacyLinkedId);
  await insert({
    company: 'Second Legacy Claimant Co',
    source: 'contact-form',
    deal_hunter_opportunity_id: null,
    metadata: { dealHunter: { opportunityId: 'opp_legacy' } },
  });

  // A tombstoned import pointing at a still-active record that carries no Deal
  // Hunter link at all: only the claimed-id fetch can reach this one.
  const unlinkedTombstonedId = await insert({
    company: 'Tombstoned But Active Co',
    source: 'contact-form',
    status: 'new',
    deal_hunter_opportunity_id: null,
    metadata: {},
  });
  await storage.claimDealHunterCrmImport({
    id: 'import-tombstoned',
    created_at: now,
    updated_at: now,
    deal_key: 'deal-tombstoned',
    listing_identity: 'listing-tombstoned',
    listing_url: 'https://broker.example.test/tombstoned',
    opportunity_id: 'opp_tombstoned',
    source_name: 'audit-fixture',
    submission_id: unlinkedTombstonedId,
    status: 'crm-deleted',
    metadata: {},
  }, { pendingCutoff: now });

  // An opportunity whose primary submission has no matching link back.
  const orphanPrimaryId = await insert({
    company: 'Orphan Primary Co',
    source: 'contact-form',
    deal_hunter_opportunity_id: null,
    metadata: {},
  });
  await opportunity('opp_orphan_primary', orphanPrimaryId);

  return { healthyId, mismatchedId, legacyLinkedId, unlinkedTombstonedId, orphanPrimaryId };
}

test('the narrow audit read reports exactly what the exhaustive read reports', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-integrity-audit-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'audit.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const seeded = await seedBrokenCrm(storage);

  const narrow = await auditDealHunterCrmIntegrity({ storage });
  const exhaustive = await auditDealHunterCrmIntegrity({ storage: withoutNarrowLookups(storage) });

  // Every finding the whole-CRM scan produces must still be produced, and no
  // extra ones invented, or the optimization would have changed the verdict.
  // Compared unsorted: the report is expected to be deterministic on its own.
  assert.deepEqual(narrow.findings, exhaustive.findings);
  assert.deepEqual(narrow.findings, (await auditDealHunterCrmIntegrity({ storage })).findings);
  assert.equal(narrow.ok, exhaustive.ok);
  assert.equal(narrow.safeToReconcile, exhaustive.safeToReconcile);
  for (const key of ['duplicatePrimaries', 'identityMismatches', 'nameMismatches', 'tombstoneActive', 'missingLinks', 'ownershipCollisions']) {
    assert.equal(narrow.counts[key], exhaustive.counts[key], `count drift for ${key}`);
  }

  // The seeded breakage is genuinely detected rather than both paths agreeing on
  // an empty result.
  assert.equal(narrow.ok, false);
  assert.equal(narrow.safeToReconcile, false);
  assert.equal(narrow.counts.identityMismatches, 1);
  assert.equal(narrow.findings.identityMismatches[0].submissionId, seeded.mismatchedId);
  assert.equal(narrow.counts.duplicatePrimaries, 1);
  assert.equal(narrow.counts.nameMismatches, 1);
  assert.equal(narrow.findings.nameMismatches[0].submissionId, seeded.legacyLinkedId);
  assert.equal(narrow.counts.tombstoneActive, 1);
  assert.equal(narrow.findings.tombstoneActive[0].submissionId, seeded.unlinkedTombstonedId);
  assert.equal(narrow.findings.missingLinks.some((item) => item.submissionId === seeded.orphanPrimaryId), true);

  // 25 unrelated CRM records exist but none of them are pulled into the audit.
  assert.equal(narrow.counts.auditedSubmissions < exhaustive.counts.auditedSubmissions, true);
  assert.equal(narrow.counts.auditedSubmissions <= 6, true, `narrow read examined ${narrow.counts.auditedSubmissions} records`);
});

test('a clean CRM audits clean through the narrow read', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-crm-integrity-clean-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'audit.sqlite') } });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  const seed = await createManualSubmission(
    { name: 'Seed Owner', email: 'seed@example.test', company: 'Clean Managed Co', message: 'seed record for the clean audit fixture' },
    'admin',
    { storage },
  );
  const template = await storage.getSubmission(seed.submission.id);
  const submissionId = randomUUID();
  await storage.insertSubmission({
    ...template,
    id: submissionId,
    company: 'Clean Managed Co',
    source: 'deal-hunter-daily-review',
    deal_hunter_opportunity_id: 'opp_clean',
    metadata: { dealHunter: { managed: true, opportunityId: 'opp_clean', raw: { 'Business Name': 'Clean Managed Co' } } },
  });
  await storage.upsertDealHunterOpportunity({
    opportunity_id: 'opp_clean',
    created_at: now,
    updated_at: now,
    canonical_name: 'Clean Managed Co',
    canonical_recipient: null,
    canonical_location: null,
    primary_submission_id: submissionId,
    identity_version: 'audit-fixture-v1',
    status: 'active',
    metadata: {},
  });

  const audit = await auditDealHunterCrmIntegrity({ storage });
  assert.equal(audit.ok, true, JSON.stringify(audit.findings));
  assert.equal(audit.safeToReconcile, true);
  assert.equal(audit.counts.auditedSubmissions, 1);
});
