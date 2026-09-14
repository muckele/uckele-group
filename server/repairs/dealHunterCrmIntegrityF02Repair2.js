import {
  deterministicDealHunterCrmIntegrityF02Checksum,
  fingerprintDealHunterCrmIntegrityF02RawRow,
} from './dealHunterCrmIntegrityF02.js';

export const DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_INCIDENT = 'UG-P6-CLOSURE-F02-REPAIR2';
export const DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION =
  'APPLY-DEAL-HUNTER-CRM-INTEGRITY-F02-REPAIR2';
export const DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_PLAN_SCHEMA =
  'deal-hunter-crm-integrity-f02-repair2-plan-v1';
export const DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_APPROVAL_SCHEMA =
  'deal-hunter-crm-integrity-f02-repair2-approval-v1';
export const DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_RECEIPT_SCHEMA =
  'deal-hunter-crm-integrity-f02-repair2-receipt-v1';

function deeplyFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deeplyFreeze(nested);
  return Object.freeze(value);
}

export const deterministicDealHunterCrmIntegrityF02Repair2Checksum =
  deterministicDealHunterCrmIntegrityF02Checksum;

// This deliberately hashes the raw SELECT * object as returned by SQLite.
// Property insertion order is schema-column order and is part of the incident
// evidence contract. Do not normalize or canonicalize this object.
export const fingerprintDealHunterCrmIntegrityF02Repair2RawRow =
  fingerprintDealHunterCrmIntegrityF02RawRow;

const legacyCollisionImportId =
  'cde045b6667a459bb28891af4ee2ab4374f51620581522462349142efb1e7e31';
const retainedUrlImportId =
  'fa231f927904b40a3ef6fd762f37b7830e9aab92c013d39ed740f51e3c84bfd0';
const collisionOpportunityId = 'opp_683681c2-bd49-4c46-be4f-6d969143d907';
const collisionSubmissionId = 'daa9ea12-786f-4769-b702-d9309525c455';
const backlinkOpportunityId = 'opp_repair_6b75b5d5c825431d2bea921450f50c37';
const backlinkSubmissionId = '1245f55a-9496-4628-9cbe-d23e53b791a1';
const nameMismatchSubmissionId = '8e910798-9ac4-4d10-9c0f-9402feb9403a';
const reviewedUnrelatedOpportunityId = 'opp_5ae93328-11e3-49de-b3f1-d28d4e76242e';

const authority = {
  incident: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_INCIDENT,
  evidence: {
    release: '122',
    revision: '9fcfe65505348421373242aa304caefb4b30396b',
    supersession: {
      incident: 'UG-P6-CLOSURE-F02',
      opportunityCount: {
        before: 475,
        after: 476,
        reviewedAddition: reviewedUnrelatedOpportunityId,
        workflow: 'september-13-daily-digest-full-backfill-canonicalization',
      },
      collisionOpportunityFingerprint: {
        before: 'f8f3b6cd79a33551f0579642ddcd3a2691ad90e3b5c46afb95cc1eac0fc2d838',
        after: 'a538b0ecd23b17a00a20bd6499de6ec922ec7aaeed4311aa84521c5eb668743e',
        changedFields: ['updated_at'],
      },
      v1DeclaredOwnerContract: {
        submissionId: collisionSubmissionId,
        submissionFingerprint: '6b811304f09d44b3737f73b2a479654c4a5c4b45fee4b5e2b6e67542eb674082',
        directOpportunityId: null,
        metadataOpportunityId: collisionOpportunityId,
        defect: 'v1-required-direct-owner-despite-pinned-metadata-only-row',
      },
    },
  },
  mutations: [
    {
      table: 'deal_hunter_crm_imports',
      id: legacyCollisionImportId,
      field: 'opportunity_id',
      before: collisionOpportunityId,
      after: null,
    },
    {
      table: 'contact_submissions',
      id: backlinkSubmissionId,
      field: 'deal_hunter_opportunity_id',
      before: null,
      after: backlinkOpportunityId,
    },
    {
      table: 'contact_submissions',
      id: nameMismatchSubmissionId,
      field: 'company',
      before: 'Profitable Senior Independence Support With Virtual Family Connection For Sale',
      after: 'Lawn And Landscape Maintenance Company For Sale',
    },
  ],
  relationships: {
    collision: {
      opportunityId: collisionOpportunityId,
      legacyImportId: legacyCollisionImportId,
      retainedImportId: retainedUrlImportId,
      claimantImportIds: [legacyCollisionImportId, retainedUrlImportId],
      sharedSubmissionId: collisionSubmissionId,
      expectedPrimarySubmissionId: collisionSubmissionId,
      declaredOwnerSemantics: 'direct-or-metadata-with-no-conflict',
    },
    backlink: {
      opportunityId: backlinkOpportunityId,
      submissionId: backlinkSubmissionId,
      importLookup: 'unique-opportunity-and-submission',
      preserveMetadataOpportunityId: true,
    },
    managedName: {
      submissionId: nameMismatchSubmissionId,
      managed: true,
      authoritativeCompany: 'Lawn And Landscape Maintenance Company For Sale',
    },
    reviewedUnrelatedOpportunity: {
      opportunityId: reviewedUnrelatedOpportunityId,
      canonicalName: 'Brake Specialty Shop',
      listingId: 'costar:2552696',
      primarySubmissionId: null,
      importCount: 0,
    },
  },
  rowFingerprints: {
    legacyCollisionImport: '0650ae104b7123bd94f76772bcd4895c6a9ac088443ac3b37b3f33ee4897ae84',
    retainedUrlImport: '1bd7c9013ddde6041c30d28eaa4ef639f4c75cd1c617af1ba2e1d2f788ab14a7',
    collisionOpportunity: 'a538b0ecd23b17a00a20bd6499de6ec922ec7aaeed4311aa84521c5eb668743e',
    collisionSubmission: '6b811304f09d44b3737f73b2a479654c4a5c4b45fee4b5e2b6e67542eb674082',
    backlinkOpportunity: '96b8ece1fa5d119d6bf3112b5bb66b889150231d1336f67497b80455e89ea085',
    backlinkImport: '02237700a1692403da586dda0be4a9cbfc7c3f3c40b687b980918f6ea226c686',
    backlinkSubmission: '26ec1bfe5f32520155f637c006a6d80474c877a58b5ccf34633a7c8e93ec0cb8',
    nameMismatchSubmission: '1c8faf10be0c0b3aa5146473f2c571253eef2cbcc33495835132ec1b137916cf',
    reviewedUnrelatedOpportunity: '7049798420b1a7bb5a6f027a5cbed6a707fa25a96599a754b56ddea47d3053e8',
  },
  expectedAuditBefore: {
    imports: 32,
    opportunities: 476,
    auditedSubmissions: 30,
    ownershipCollisions: 1,
    duplicatePrimaries: 0,
    identityMismatches: 0,
    nameMismatches: 1,
    tombstoneActive: 0,
    missingLinks: 1,
    ok: false,
    safeToReconcile: false,
  },
  expectedAuditAfter: {
    imports: 32,
    opportunities: 476,
    auditedSubmissions: 30,
    ownershipCollisions: 0,
    duplicatePrimaries: 0,
    identityMismatches: 0,
    nameMismatches: 0,
    tombstoneActive: 0,
    missingLinks: 0,
    ok: true,
    safeToReconcile: true,
  },
};

export const DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY = deeplyFreeze(authority);

function boundedText(value, label, { min = 1, max = 1000 } = {}) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${label} must contain between ${min} and ${max} characters.`);
  }
  return normalized;
}

export function createDealHunterCrmIntegrityF02Repair2ApprovalManifest({
  actor,
  reason,
  executionRelease,
  toolingRevision,
  authority: selectedAuthority = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY,
  generatedAt = new Date().toISOString(),
  preflight = {},
} = {}) {
  const normalizedActor = boundedText(actor, 'Actor', { max: 160 });
  const normalizedReason = boundedText(reason, 'Reason', { min: 20, max: 1000 });
  const normalizedExecutionRelease = boundedText(executionRelease, 'Execution release', { max: 160 });
  const normalizedToolingRevision = String(toolingRevision || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedToolingRevision)) {
    throw new Error('Tooling revision must be an exact lowercase 40-character Git revision.');
  }
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('Approval manifest requires a valid generation time.');
  }

  const plan = {
    schema: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_PLAN_SCHEMA,
    incident: selectedAuthority.incident,
    evidence: selectedAuthority.evidence,
    execution: {
      release: normalizedExecutionRelease,
      toolingRevision: normalizedToolingRevision,
    },
    actor: normalizedActor,
    reason: normalizedReason,
    mutations: selectedAuthority.mutations,
    authority: {
      relationships: selectedAuthority.relationships,
      rowFingerprints: selectedAuthority.rowFingerprints,
    },
    globalGuards: selectedAuthority.expectedAuditBefore,
    postconditions: selectedAuthority.expectedAuditAfter,
    preflight,
    requiredConfirmation: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_CONFIRMATION,
    requiredPreconditions: [
      'sqlite-existing-file-only',
      'schema-and-trigger-contract-valid',
      'exact-authority-fingerprints-match',
      'exact-global-audit-guards-match',
      'current-format-backup-reproduces-reviewed-preflight',
      'foreign-keys-enabled-before-begin-immediate',
      'three-one-row-compare-and-set-updates',
      'masked-logical-digest-preserved',
      'foreign-key-check-clean-before-commit',
    ],
  };
  const planChecksum = deterministicDealHunterCrmIntegrityF02Repair2Checksum(plan);
  return deeplyFreeze({
    schema: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_APPROVAL_SCHEMA,
    generatedAt,
    plan,
    planChecksum,
  });
}

// Internal test seam. It can replace only evidence fingerprints; mutation
// targets, values, relationships, guards, and CLI selection remain fixed.
export function createDealHunterCrmIntegrityF02Repair2TestAuthority(rowFingerprints) {
  const expectedKeys = Object.keys(DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY.rowFingerprints).sort();
  const actualKeys = Object.keys(rowFingerprints || {}).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('Synthetic F-02 Repair2 authority requires exactly the nine diagnostic fingerprint labels.');
  }
  for (const fingerprint of Object.values(rowFingerprints)) {
    if (!/^[a-f0-9]{64}$/.test(String(fingerprint || ''))) {
      throw new Error('Synthetic F-02 Repair2 authority fingerprints must be lowercase SHA-256 values.');
    }
  }
  return deeplyFreeze({
    ...DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR2_AUTHORITY,
    rowFingerprints: { ...rowFingerprints },
  });
}
