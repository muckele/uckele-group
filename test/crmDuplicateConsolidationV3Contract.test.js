import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
  CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY,
  validateCrmDuplicateConsolidationRowAuthority,
  crmDuplicateConsolidationManifestId,
  CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  canonicalJsonSha256,
} from '../server/repairs/crmDuplicateConsolidation.js';
import { verifyCrmDuplicateConsolidationReviewedArtifact } from '../server/services/crmDuplicateConsolidationRepair.js';
import {
  createFixture,
  syntheticReviewedArtifactFixture,
} from './crmDuplicateConsolidationRepair.test.js';

test('V3 policy is closed, sorted, deeply frozen, and rejects recomputed-policy variants', () => {
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES,
    ['analytics_events', 'contact_rate_limit_events']);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_VOLATILE_ROW_TABLES), true);
  assert.equal(Object.isFrozen(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY), true);
  assert.deepEqual(CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, {
    schema: 'crm-duplicate-consolidation-row-authority-v1',
    policy: 'schema-bound-row-content-excluded',
    excludedRowTables: ['analytics_events', 'contact_rate_limit_events'],
  });
  for (const excludedRowTables of [
    ['contact_rate_limit_events', 'analytics_events'],
    ['analytics_events', 'contact_rate_limit_events', 'email_events'],
    ['analytics_events'],
  ]) {
    assert.throws(() => validateCrmDuplicateConsolidationRowAuthority({
      ...CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, excludedRowTables,
    }), /row.authority.*policy/i);
  }
  assert.throws(() => validateCrmDuplicateConsolidationRowAuthority({
    ...CRM_DUPLICATE_CONSOLIDATION_ROW_AUTHORITY, override: true,
  }), /row.authority.*policy/i);
});

test('V3 namespace changes only versioned repair contracts', () => {
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA, 'crm-duplicate-consolidation-approval-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA, 'crm-duplicate-consolidation-checkpoint-v1');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA, 'crm-duplicate-consolidation-plan-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA, 'crm-duplicate-consolidation-manifest-v3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION, 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.equal(CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION, 'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V3');
  assert.match(crmDuplicateConsolidationManifestId(), /^crm-duplicate-consolidation:v3:[a-f0-9]{64}$/);
});

test('V3 pure validator refuses old or missing policy even with a valid checksum', async (t) => {
  const fixture = await createFixture(t);
  const artifact = await syntheticReviewedArtifactFixture(fixture);
  for (const mutate of [
    (item) => { item.repairVersion = 'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2'; },
    (item) => { delete item.plan.rowAuthority; },
    (item) => { item.plan.rowAuthority.policy = 'unreviewed'; },
  ]) {
    const candidate = structuredClone(artifact);
    mutate(candidate);
    candidate.planChecksum = canonicalJsonSha256(candidate.plan);
    assert.throws(() => verifyCrmDuplicateConsolidationReviewedArtifact({
      artifact: candidate, expectedPlanChecksum: candidate.planChecksum,
      expectedManifestId: candidate.manifestId,
    }), /version|row.authority.*policy/i);
  }
});
