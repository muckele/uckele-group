import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY,
} from '../server/repairs/dealHunterCrmIntegrityF02.js';
import {
  deterministicDealHunterCrmIntegrityF02Repair2Checksum,
} from '../server/repairs/dealHunterCrmIntegrityF02Repair2.js';
import {
  inspectDealHunterCrmIntegrityF02Repair,
} from '../server/services/dealHunterCrmIntegrityF02Repair.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';

const collisionOpportunityId = 'opp_683681c2-bd49-4c46-be4f-6d969143d907';
const collisionSubmissionId = 'daa9ea12-786f-4769-b702-d9309525c455';
const reviewedUnrelatedOpportunityId = 'opp_5ae93328-11e3-49de-b3f1-d28d4e76242e';

const diagnosticAttestation = JSON.parse(fs.readFileSync(
  new URL('./fixtures/dealHunterCrmIntegrityF02Repair2DiagnosticAttestation.json', import.meta.url),
  'utf8',
));
const historicalCollisionSubmissionEvidence =
  diagnosticAttestation.collisionSubmissionObservation;

const execution = {
  actor: 'Owner Reviewer',
  reason: 'Repair the three reviewed F-02 CRM integrity defects with Repair2.',
  executionRelease: 'release-123',
  toolingRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

function fixtureConfig(root) {
  return {
    storage: { provider: 'sqlite', sqlitePath: path.join(root, 'fixture.sqlite') },
    secureDocuments: { storageDir: path.join(root, 'secure-documents') },
    protection: { rateLimitRetentionMs: 0 },
    backup: {
      enabled: true,
      directory: path.join(root, 'backups'),
      retentionDays: 30,
      retentionCount: 5,
      time: '03:30',
      timezone: 'America/Los_Angeles',
      checkIntervalMs: 900000,
    },
  };
}

function insertSubmission(database, {
  id,
  company,
  opportunityId = null,
  metadata = {},
  source = 'deal-hunter-daily-review',
  index = 0,
}) {
  database.prepare(`
    INSERT INTO contact_submissions (
      id, created_at, updated_at, status, spam_score, spam_reasons,
      delivery_provider, delivery_status, crm_status, source, ip_hash,
      name, email, company, message, deal_hunter_opportunity_id, metadata
    ) VALUES (?, ?, ?, 'new', 0, '[]', 'fixture', 'not-sent', 'not-synced', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    '2026-09-12T10:00:00.000Z',
    '2026-09-12T10:00:00.000Z',
    source,
    `hash-${index}`,
    `Fixture Contact ${index}`,
    `fixture-${index}@example.test`,
    company,
    `Synthetic fixture message ${index}`,
    opportunityId,
    JSON.stringify(metadata),
  );
}

function insertOpportunity(database, {
  opportunityId,
  primarySubmissionId = null,
  index = 0,
  createdAt = '2026-09-12T10:00:00.000Z',
  updatedAt = '2026-09-12T10:00:00.000Z',
  canonicalName = `Fixture Opportunity ${index}`,
  canonicalLocation = null,
  metadata = {},
}) {
  database.prepare(`
    INSERT INTO deal_hunter_opportunities (
      opportunity_id, created_at, updated_at, canonical_name,
      canonical_recipient, canonical_location, primary_submission_id,
      identity_version, status, metadata
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'fixture-v1', 'active', ?)
  `).run(
    opportunityId,
    createdAt,
    updatedAt,
    canonicalName,
    canonicalLocation,
    primarySubmissionId,
    JSON.stringify(metadata),
  );
}

function insertImport(database, {
  id,
  opportunityId,
  submissionId = null,
  index = 0,
}) {
  database.prepare(`
    INSERT INTO deal_hunter_crm_imports (
      id, created_at, updated_at, deal_key, listing_identity, listing_url,
      submission_id, status, source_name, metadata, opportunity_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'current', 'fixture-source', '{}', ?)
  `).run(
    id,
    '2026-09-12T10:00:00.000Z',
    '2026-09-12T10:00:00.000Z',
    `fixture-deal-${index}`,
    `fixture-listing-${index}`,
    `https://fixture.example.test/listing/${index}`,
    submissionId,
    opportunityId,
  );
}

function rawFingerprint(row) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

function rawRow(database, table, field, value) {
  return database.prepare(`SELECT * FROM ${table} WHERE ${field} = ?`).get(value);
}

async function createProductionDerivedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-f02-repair2-'));
  const config = fixtureConfig(root);
  const storage = createSqliteStorage(config);
  storage.close();
  const database = new Database(config.storage.sqlitePath, { fileMustExist: true });
  const { collision, backlink, managedName } = DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.relationships;
  try {
    database.exec('DROP INDEX IF EXISTS idx_deal_hunter_crm_imports_unique_opportunity');

    insertSubmission(database, {
      id: collision.sharedSubmissionId,
      company: '20+ Year HVAC Company w/ strong earnings and track record',
      opportunityId: historicalCollisionSubmissionEvidence.directOpportunityId,
      metadata: {
        dealHunter: {
          managed: true,
          opportunityId: historicalCollisionSubmissionEvidence.metadataOpportunityId,
          raw: { Name: '20+ Year HVAC Company w/ strong earnings and track record' },
        },
      },
      index: 1,
    });
    insertSubmission(database, {
      id: backlink.submissionId,
      company: 'Established Los Angeles Auto Body Shop, Strong Reputation, Price Drop',
      metadata: {
        dealHunter: {
          managed: true,
          raw: { Name: 'Established Los Angeles Auto Body Shop, Strong Reputation, Price Drop' },
        },
      },
      index: 2,
    });
    insertSubmission(database, {
      id: managedName.submissionId,
      company: DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.mutations[2].before,
      metadata: {
        dealHunter: {
          managed: true,
          raw: { Name: managedName.authoritativeCompany },
        },
      },
      index: 3,
    });
    for (let index = 0; index < 27; index += 1) {
      const opportunityId = `opp_fixture_healthy_${index}`;
      const submissionId = `fixture-healthy-submission-${index}`;
      insertSubmission(database, {
        id: submissionId,
        company: `Healthy Fixture Company ${index}`,
        opportunityId,
        metadata: {
          dealHunter: {
            managed: true,
            opportunityId,
            raw: { Name: `Healthy Fixture Company ${index}` },
          },
        },
        index: index + 10,
      });
    }

    insertOpportunity(database, {
      opportunityId: collision.opportunityId,
      primarySubmissionId: collision.sharedSubmissionId,
      index: 1,
      createdAt: '2026-08-12T21:05:27.631Z',
      updatedAt: diagnosticAttestation.collisionOpportunityObservation.currentUpdatedAt,
      canonicalName: '20+ Year HVAC Company w/ strong earnings and track record',
      canonicalLocation: 'Pooler, Chatham, GA, US',
    });
    insertOpportunity(database, {
      opportunityId: backlink.opportunityId,
      primarySubmissionId: backlink.submissionId,
      index: 2,
    });
    for (let index = 0; index < 27; index += 1) {
      insertOpportunity(database, {
        opportunityId: `opp_fixture_healthy_${index}`,
        primarySubmissionId: `fixture-healthy-submission-${index}`,
        index: index + 10,
      });
    }
    for (let index = 0; index < 446; index += 1) {
      insertOpportunity(database, {
        opportunityId: `opp_fixture_unclaimed_${index}`,
        index: index + 100,
      });
    }
    insertOpportunity(database, {
      opportunityId: reviewedUnrelatedOpportunityId,
      createdAt: '2026-09-13T15:00:39.752Z',
      updatedAt: '2026-09-13T19:29:59.123Z',
      canonicalName: 'Brake Specialty Shop',
      canonicalLocation: 'Bridgeport, CT, US',
      metadata: {
        identitySnapshot: {
          name: 'brake specialty shop',
          listingIds: ['costar:2552696'],
        },
      },
      index: 999,
    });

    insertImport(database, {
      id: collision.legacyImportId,
      opportunityId: collision.opportunityId,
      submissionId: collision.sharedSubmissionId,
      index: 1,
    });
    insertImport(database, {
      id: collision.retainedImportId,
      opportunityId: collision.opportunityId,
      submissionId: collision.sharedSubmissionId,
      index: 2,
    });
    insertImport(database, {
      id: 'fixture-backlink-authority-import',
      opportunityId: backlink.opportunityId,
      submissionId: backlink.submissionId,
      index: 3,
    });
    insertImport(database, {
      id: 'fixture-name-import',
      opportunityId: null,
      submissionId: managedName.submissionId,
      index: 4,
    });
    for (let index = 0; index < 27; index += 1) {
      insertImport(database, {
        id: `fixture-healthy-import-${index}`,
        opportunityId: `opp_fixture_healthy_${index}`,
        submissionId: `fixture-healthy-submission-${index}`,
        index: index + 10,
      });
    }
    insertImport(database, {
      id: 'fixture-unclaimed-import',
      opportunityId: 'opp_fixture_unclaimed_0',
      index: 100,
    });

    database.pragma('wal_checkpoint(TRUNCATE)');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, config, databasePath: config.storage.sqlitePath };
  } finally {
    database.close();
  }
}

test('F-02 v1 pins the metadata-only production fingerprint but rejects that same owner shape', async (t) => {
  const { attestationChecksum, ...attestedEvidence } = diagnosticAttestation;
  assert.equal(
    deterministicDealHunterCrmIntegrityF02Repair2Checksum(attestedEvidence),
    attestationChecksum,
  );
  assert.equal(
    diagnosticAttestation.provenance.observationContract,
    'Each raw SELECT-star fingerprint and its bounded relationship projection came from the same read-only row observation.',
  );
  assert.equal(
    DEAL_HUNTER_CRM_INTEGRITY_F02_AUTHORITY.rowFingerprints.collisionSubmission,
    historicalCollisionSubmissionEvidence.rawFingerprint,
  );
  assert.equal(historicalCollisionSubmissionEvidence.directOpportunityId, null);
  assert.equal(
    historicalCollisionSubmissionEvidence.metadataOpportunityId,
    collisionOpportunityId,
  );

  const fixture = await createProductionDerivedFixture(t);
  const fixtureDatabase = new Database(fixture.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const collisionSubmission = rawRow(
      fixtureDatabase,
      'contact_submissions',
      'id',
      collisionSubmissionId,
    );
    assert.equal(collisionSubmission.deal_hunter_opportunity_id, null);
    assert.equal(
      JSON.parse(collisionSubmission.metadata).dealHunter.opportunityId,
      collisionOpportunityId,
    );
  } finally {
    fixtureDatabase.close();
  }
  const result = await inspectDealHunterCrmIntegrityF02Repair({
    databasePath: fixture.databasePath,
    provider: 'sqlite',
    generatedAt: '2026-09-14T01:00:00.000Z',
    ...execution,
  });

  assert.equal(result.status, 'refused');
  assert.equal(result.blockers.includes('COLLISION_PRIMARY_RELATIONSHIP_MISMATCH'), true);
  assert.equal(result.audit.counts.identityMismatches, 0);
  assert.equal(result.audit.counts.missingLinks, 1);
});

test('F-02 Repair2 accepts the production-derived metadata-only owner shape in dry-run', async (t) => {
  const fixture = await createProductionDerivedFixture(t);
  const repair2Contract = await import('../server/repairs/dealHunterCrmIntegrityF02Repair2.js');
  const repair2Service = await import('../server/services/dealHunterCrmIntegrityF02Repair2.js');
  const database = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  let authority;
  try {
    const { collision, backlink, managedName, reviewedUnrelatedOpportunity } =
      repair2Contract.DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.relationships;
    const backlinkImport = database.prepare(`
      SELECT * FROM deal_hunter_crm_imports
      WHERE opportunity_id = ? AND submission_id = ?
    `).get(backlink.opportunityId, backlink.submissionId);
    authority = repair2Contract.createDealHunterCrmIntegrityF02Repair2TestAuthority({
      legacyCollisionImport: rawFingerprint(rawRow(
        database, 'deal_hunter_crm_imports', 'id', collision.legacyImportId,
      )),
      retainedUrlImport: rawFingerprint(rawRow(
        database, 'deal_hunter_crm_imports', 'id', collision.retainedImportId,
      )),
      collisionOpportunity: rawFingerprint(rawRow(
        database, 'deal_hunter_opportunities', 'opportunity_id', collision.opportunityId,
      )),
      collisionSubmission: rawFingerprint(rawRow(
        database, 'contact_submissions', 'id', collision.sharedSubmissionId,
      )),
      backlinkOpportunity: rawFingerprint(rawRow(
        database, 'deal_hunter_opportunities', 'opportunity_id', backlink.opportunityId,
      )),
      backlinkImport: rawFingerprint(backlinkImport),
      backlinkSubmission: rawFingerprint(rawRow(
        database, 'contact_submissions', 'id', backlink.submissionId,
      )),
      nameMismatchSubmission: rawFingerprint(rawRow(
        database, 'contact_submissions', 'id', managedName.submissionId,
      )),
      reviewedUnrelatedOpportunity: rawFingerprint(rawRow(
        database,
        'deal_hunter_opportunities',
        'opportunity_id',
        reviewedUnrelatedOpportunity.opportunityId,
      )),
    });
  } finally {
    database.close();
  }

  const result = await repair2Service.inspectDealHunterCrmIntegrityF02Repair2({
    databasePath: fixture.databasePath,
    provider: 'sqlite',
    authority,
    generatedAt: '2026-09-14T01:00:00.000Z',
    ...execution,
  });

  assert.equal(result.status, 'repair-required');
  assert.equal(result.applied, false);
  assert.deepEqual(result.blockers, []);
});
