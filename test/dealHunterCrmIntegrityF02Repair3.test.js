import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY,
  deterministicDealHunterCrmIntegrityF02Repair2Checksum,
  fingerprintDealHunterCrmIntegrityF02Repair2RawRow,
} from '../server/repairs/dealHunterCrmIntegrityF02Repair2.js';

const attestation = JSON.parse(fs.readFileSync(
  new URL('./fixtures/dealHunterCrmIntegrityF02Repair3DiagnosticAttestation.json', import.meta.url), 'utf8',
));

// Bounded historical evidence stays hash-only. Synthetic raw rows mirror its
// SELECT-star column order and timestamp pairs; they are not production raw rows.
function historicalPair(observation) {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE opportunities (
      opportunity_id TEXT, created_at TEXT, updated_at TEXT, canonical_name TEXT,
      canonical_recipient TEXT, canonical_location TEXT, primary_submission_id TEXT,
      identity_version TEXT, status TEXT, metadata TEXT
    )`);
    database.prepare('INSERT INTO opportunities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      observation.opportunityId, '2026-09-12T10:00:00.000Z', observation.historicalUpdatedAt,
      'Synthetic context name', null, 'Synthetic location', null, 'cim-opportunity-v1', 'active',
      '{ "identitySnapshot": {"listingIds":["costar:2552696"],"sourceIds":["synthetic-source"]}, "lastObservedDealKey":"synthetic-deal", "lastObservedListingUrl":"https://example.test/listing" }',
    );
    const historical = database.prepare('SELECT * FROM opportunities').get();
    database.prepare('UPDATE opportunities SET updated_at = ?').run(observation.laterUpdatedAt);
    return { historical, later: database.prepare('SELECT * FROM opportunities').get() };
  } finally {
    database.close();
  }
}

test('Repair2 synthetic characterization reproduces the attested timestamp-only drift shape', () => {
  const { attestationChecksum, ...body } = attestation;
  assert.equal(deterministicDealHunterCrmIntegrityF02Repair2Checksum(body), attestationChecksum);
  assert.equal(attestationChecksum, 'f8eb391f4dcefc1d3c9cae70618e3bb36a949d30c368b6cbb78b1efcd0209802');
  for (const [label, observation] of Object.entries(attestation.observations)) {
    assert.equal(observation.historicalRawFingerprint, DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints[label]);
    assert.notEqual(observation.historicalRawFingerprint, observation.laterRawFingerprint);
    assert.deepEqual(observation.changedFields, ['updated_at']);
    const { historical, later } = historicalPair(observation);
    assert.deepEqual(Object.keys(historical), attestation.provenance.rawSelectStarColumnOrder);
    assert.deepEqual(Object.keys(historical).filter((key) => historical[key] !== later[key]), ['updated_at']);
    assert.notEqual(fingerprintDealHunterCrmIntegrityF02Repair2RawRow(historical), fingerprintDealHunterCrmIntegrityF02Repair2RawRow(later));
  }
});

test('bounded attestation records actual-helper validation on all four authorized historical rows', async () => {
  const { DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_AUTHORITY: authority } = await import('../server/repairs/dealHunterCrmIntegrityF02Repair3.js');
  const validation = attestation.historicalHelperValidation;
  assert.ok(validation, 'Actual-helper historical validation must be attested separately from synthetic RED');
  assert.equal(validation.phase, 'post-implementation-historical-validation');
  assert.equal(validation.result, 'PASS');
  assert.equal(validation.rawRowCount, 4);
  assert.equal(validation.rawRowsRetained, false);
  assert.deepEqual(validation.backupConnection, { readonly: true, fileMustExist: true, queryOnly: true });
  assert.deepEqual(validation.helpers, [
    'server/repairs/dealHunterCrmIntegrityF02.js#fingerprintDealHunterCrmIntegrityF02RawRow',
    'server/repairs/dealHunterCrmIntegrityF02Repair2.js#fingerprintDealHunterCrmIntegrityF02Repair2RawRow',
    'server/repairs/dealHunterCrmIntegrityF02Repair3.js#projectDealHunterCrmIntegrityF02Repair3ContextOpportunity',
    'server/repairs/dealHunterCrmIntegrityF02Repair3.js#fingerprintDealHunterCrmIntegrityF02Repair3ContextOpportunity',
  ]);
  assert.equal(authority.evidence.supersession.repair2ContextDrift.attestationChecksum, attestation.attestationChecksum);
  assert.deepEqual(Object.keys(validation.results), ['collisionOpportunity', 'reviewedUnrelatedOpportunity']);
  for (const [label, observed] of Object.entries(validation.results)) {
    const evidence = attestation.observations[label];
    assert.equal(observed.selectStarColumnOrderMatches, true);
    assert.deepEqual(observed.changedFields, ['updated_at']);
    assert.equal(observed.rawMetadataBytesEqual, true);
    assert.equal(observed.historicalRawMatchesRepair2Authority, true);
    assert.equal(observed.laterRawDiffersFromRepair2Authority, true);
    assert.notEqual(evidence.historicalRawFingerprint, evidence.laterRawFingerprint);
    assert.equal(observed.historicalProjectionFingerprint, evidence.contextProjectionFingerprint);
    assert.equal(observed.laterProjectionFingerprint, evidence.contextProjectionFingerprint);
    assert.equal(observed.historicalProjectionFingerprint, authority.contextOpportunityFingerprints[label]);
  }
});

test('Repair3 projection excludes only updated_at and preserves every other raw field for both contexts', async (t) => {
  const contract = await import('../server/repairs/dealHunterCrmIntegrityF02Repair3.js').catch(() => ({}));
  assert.equal(typeof contract.projectDealHunterCrmIntegrityF02Repair3ContextOpportunity, 'function', 'Repair3 projection must exist');
  const project = contract.projectDealHunterCrmIntegrityF02Repair3ContextOpportunity;
  const fingerprint = contract.fingerprintDealHunterCrmIntegrityF02Repair3ContextOpportunity;
  for (const [label, observation] of Object.entries(attestation.observations)) {
    await t.test(label, () => {
      const { historical, later } = historicalPair(observation);
      const original = structuredClone(historical);
      const expected = { ...historical };
      delete expected.updated_at;
      assert.deepEqual(project(historical), expected);
      assert.deepEqual(Object.keys(project(historical)), attestation.provenance.rawSelectStarColumnOrder.filter((key) => key !== 'updated_at'));
      assert.equal(JSON.stringify(project(historical)), JSON.stringify(expected));
      assert.equal(project(historical).metadata, historical.metadata);
      assert.deepEqual(historical, original);
      assert.equal(fingerprint(historical), fingerprint(later));
      assert.equal(fingerprint(historical), fingerprint(historicalPair(observation).historical));
      for (const field of Object.keys(expected)) {
        const changed = { ...later, [field]: `${later[field]}-changed` };
        assert.notEqual(fingerprint(historical), fingerprint(changed), `${label}.${field} remains protected`);
      }
      assert.notEqual(fingerprint(historical), fingerprint({ ...later, future_column: 'also protected' }));
      // Even a JSON formatting-only change is authority drift.
      assert.notEqual(fingerprint(historical), fingerprint({ ...later, metadata: JSON.stringify(JSON.parse(later.metadata)) }));
      for (const field of ['listingIds', 'sourceIds', 'lastObservedDealKey', 'lastObservedListingUrl']) {
        const metadata = JSON.parse(later.metadata);
        if (field === 'listingIds' || field === 'sourceIds') metadata.identitySnapshot[field] = ['changed'];
        else metadata[field] = 'changed';
        assert.notEqual(fingerprint(historical), fingerprint({ ...later, metadata: JSON.stringify(metadata) }), field);
      }
      assert.equal(contract.DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_AUTHORITY.contextOpportunityFingerprints[label], observation.contextProjectionFingerprint);
    });
  }
});
