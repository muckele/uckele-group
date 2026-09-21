import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY,
  isCanonicalOpportunityMergeRelationshipColumn,
} from './canonicalOpportunityMerge.js';

export const CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION =
  'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1';
export const CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE = 'crm-duplicate-consolidation';
export const CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA =
  'crm-duplicate-consolidation-approval-v1';
export const CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA =
  'crm-duplicate-consolidation-plan-v1';
export const CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA =
  'crm-duplicate-consolidation-manifest-v1';
export const CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION =
  'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V1';
export const CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA =
  'crm-duplicate-consolidation-checkpoint-v1';
export const CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_FIELDS = Object.freeze([
  'backupPath',
  'backupManifestId',
  'backupSha256',
  'backupProvider',
  'backupStatus',
  'backupQuickCheck',
  'backupForeignKeyViolationCount',
  'flySnapshotId',
  'flySnapshotDigest',
  'flySnapshotStatus',
  'flyRelease',
  'toolingRevision',
  'createdAt',
  'verifiedAt',
]);

const checkpointTopLevelFields = Object.freeze(['schema', 'checkpoint']);
const checkpointSha256Pattern = /^[a-f0-9]{64}$/;
const checkpointToolingRevisionPattern = /^[a-f0-9]{40,64}$/;
const checkpointIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const checkpointReleasePattern = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/;

function deeplyFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deeplyFreeze(nested);
  return Object.freeze(value);
}

export function stableCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableCanonicalJson(value[key])}`
    )).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalJsonSha256(value) {
  return sha256Hex(stableCanonicalJson(value));
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableCanonicalJson(actual) !== stableCanonicalJson(wanted)) {
    const missing = wanted.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !wanted.includes(key));
    const details = [
      ...missing.map((key) => `missing ${key}`),
      ...unknown.map((key) => `unknown key ${key}`),
    ].join(', ');
    throw new Error(`${label} has invalid keys${details ? `: ${details}` : ''}.`);
  }
}

function checkpointString(checkpoint, field, maximum, pattern = null) {
  const value = checkpoint[field];
  if (typeof value !== 'string') throw new Error(`Checkpoint ${field} must be a string.`);
  if (!value || value.trim() !== value) {
    throw new Error(`Checkpoint ${field} must be non-empty without surrounding whitespace.`);
  }
  if (value.length > maximum) throw new Error(`Checkpoint ${field} exceeds ${maximum} characters.`);
  if (pattern && !pattern.test(value)) throw new Error(`Checkpoint ${field} is malformed.`);
  return value;
}

function canonicalCheckpointTimestamp(checkpoint, field) {
  const value = checkpointString(checkpoint, field, 24);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`Checkpoint ${field} must be a canonical UTC timestamp with milliseconds.`);
  }
  return value;
}

export function validateCrmDuplicateConsolidationCheckpointEvidence({
  evidence,
  expectedExecutionRelease,
  expectedToolingRevision,
  expectedBackup,
} = {}) {
  exactObjectKeys(evidence, checkpointTopLevelFields, 'Checkpoint evidence envelope');
  if (evidence.schema !== CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA) {
    throw new Error('Checkpoint evidence schema is invalid.');
  }
  exactObjectKeys(
    evidence.checkpoint,
    CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_FIELDS,
    'Checkpoint',
  );
  const checkpoint = evidence.checkpoint;
  const normalized = {
    backupPath: checkpointString(checkpoint, 'backupPath', 4096),
    backupManifestId: checkpointString(
      checkpoint,
      'backupManifestId',
      200,
      checkpointIdentifierPattern,
    ),
    backupSha256: checkpointString(checkpoint, 'backupSha256', 64, checkpointSha256Pattern),
    backupProvider: checkpointString(checkpoint, 'backupProvider', 32),
    backupStatus: checkpointString(checkpoint, 'backupStatus', 32),
    backupQuickCheck: checkpointString(checkpoint, 'backupQuickCheck', 32),
    backupForeignKeyViolationCount: checkpoint.backupForeignKeyViolationCount,
    flySnapshotId: checkpointString(
      checkpoint,
      'flySnapshotId',
      200,
      checkpointIdentifierPattern,
    ),
    flySnapshotDigest: checkpointString(
      checkpoint,
      'flySnapshotDigest',
      64,
      checkpointSha256Pattern,
    ),
    flySnapshotStatus: checkpointString(checkpoint, 'flySnapshotStatus', 32),
    flyRelease: checkpointString(checkpoint, 'flyRelease', 160, checkpointReleasePattern),
    toolingRevision: checkpointString(
      checkpoint,
      'toolingRevision',
      64,
      checkpointToolingRevisionPattern,
    ),
    createdAt: canonicalCheckpointTimestamp(checkpoint, 'createdAt'),
    verifiedAt: canonicalCheckpointTimestamp(checkpoint, 'verifiedAt'),
  };
  if (!path.isAbsolute(normalized.backupPath)) {
    throw new Error('Checkpoint backupPath must be absolute.');
  }
  if (normalized.backupProvider !== 'sqlite') {
    throw new Error('Checkpoint backupProvider must be sqlite.');
  }
  if (normalized.backupStatus !== 'verified') {
    throw new Error('Checkpoint backupStatus must be verified.');
  }
  if (normalized.backupQuickCheck !== 'ok') {
    throw new Error('Checkpoint backupQuickCheck must be ok.');
  }
  if (!Number.isInteger(normalized.backupForeignKeyViolationCount)
    || normalized.backupForeignKeyViolationCount !== 0) {
    throw new Error('Checkpoint backupForeignKeyViolationCount must be the integer zero.');
  }
  if (normalized.flySnapshotStatus !== 'created') {
    throw new Error('Checkpoint flySnapshotStatus must be created.');
  }
  if (normalized.createdAt > normalized.verifiedAt) {
    throw new Error('Checkpoint createdAt must not be after verifiedAt.');
  }
  if (expectedExecutionRelease !== undefined
    && normalized.flyRelease !== expectedExecutionRelease) {
    throw new Error('Checkpoint flyRelease does not match the execution release.');
  }
  if (expectedToolingRevision !== undefined
    && normalized.toolingRevision !== expectedToolingRevision) {
    throw new Error('Checkpoint toolingRevision does not match the execution tooling revision.');
  }
  if (expectedBackup !== undefined) {
    if (!expectedBackup || typeof expectedBackup !== 'object' || Array.isArray(expectedBackup)) {
      throw new Error('Checkpoint expected backup facts are invalid.');
    }
    if (normalized.backupPath !== expectedBackup.path) {
      throw new Error('Checkpoint backupPath does not match the operator backup path.');
    }
    if (normalized.backupManifestId !== expectedBackup.manifestId) {
      throw new Error('Checkpoint backupManifestId does not match the operator backup manifest.');
    }
    if (normalized.backupSha256 !== expectedBackup.sha256) {
      throw new Error('Checkpoint backupSha256 does not match the operator backup digest.');
    }
  }
  const normalizedEvidence = {
    schema: CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
    checkpoint: normalized,
  };
  const canonicalJson = stableCanonicalJson(normalizedEvidence);
  return {
    evidence: normalizedEvidence,
    checkpoint: normalized,
    canonicalJson,
    digest: sha256Hex(canonicalJson),
  };
}

const pooler = {
  key: 'pooler',
  opportunityId: 'opp_683681c2-bd49-4c46-be4f-6d969143d907',
  survivorSubmissionId: 'daa9ea12-786f-4769-b702-d9309525c455',
  supersededSubmissionId: 'b36a4b33-d35c-4e8d-b6c3-b6301030a92b',
  listingIdentity: 'costar:2516010',
  askingPrice: '$1,580,000',
  revenue: '$3,535,760',
  financialLabel: 'Annual Profit',
  financialValue: '$535,397',
};

const berlin = {
  key: 'berlin',
  opportunityId: 'opp_9b18427d-5fb5-4f92-be31-d92b810061b3',
  survivorSubmissionId: '0f5f3f23-d8e9-4e7f-b22b-d3ac7a0dd1da',
  supersededSubmissionId: '8cbd1ed9-eb02-4a30-b62e-4694d4b8afd3',
  listingIdentity: 'costar:2436873',
  askingPrice: '$1,400,000',
  revenue: '$3,535,760',
  financialLabel: 'Annual Profit',
  financialValue: '$490,070',
};

const berlinImport = {
  id: '508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8',
  beforeSubmissionId: berlin.supersededSubmissionId,
  afterSubmissionId: berlin.survivorSubmissionId,
  opportunityId: null,
};

export const CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR = deeplyFreeze({
  repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
  approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  planSchema: CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  confirmation: CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  approvedBy: 'Uckele Group owner-reviewed CRM duplicate consolidation',
  approvedAt: '2026-09-17T00:00:00.000Z',
  pairs: [pooler, berlin],
  berlinImport,
});

export const CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER = deeplyFreeze([
  { table: 'crm_submission_supersessions', operation: 'insert', key: 'pooler' },
  { table: 'crm_submission_supersessions', operation: 'insert', key: 'berlin' },
  { table: 'deal_hunter_crm_imports', operation: 'update', key: berlinImport.id },
  { table: 'deal_hunter_cim_repair_manifests', operation: 'insert', key: 'manifest' },
]);

const knownRelationshipColumns = new Set(
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries
    .map((entry) => `${entry.table}.${entry.column}`),
);

const retainedReferenceTables = new Set([
  'admin_audit_events',
  'contact_submissions',
  'crm_activity_events',
  'crm_communications',
  'crm_email_outbox',
  'crm_follow_up_recommendations',
  'deal_hunter_cim_opportunity_claims',
  'deal_hunter_cim_recipient_claims',
  'deal_hunter_cim_recipient_overrides',
  'deal_hunter_cim_requests',
  'deal_hunter_cim_reviews',
  'deal_hunter_cim_stage2_decisions',
  'deal_hunter_cim_stage2_runs',
  'deal_hunter_crm_reconciliation_items',
  'deal_hunter_crm_reconciliation_runs',
  'deal_hunter_deal_os_imports',
  'deal_hunter_dispositions',
  'deal_hunter_identity_exceptions',
  'deal_hunter_opportunities',
  'deal_hunter_opportunity_aliases',
  'deal_hunter_opportunity_facts',
  'deal_hunter_opportunity_scores',
  'deal_hunter_opportunity_source_observations',
  'deal_hunter_score_evidence',
  'deal_hunter_seen_deals',
  'email_events',
  'scheduled_job_runs',
  'secure_document_cleanup_jobs',
  'secure_documents',
  'secure_upload_requests',
]);

export function isCrmDuplicateConsolidationRelationshipColumn(column = '') {
  return isCanonicalOpportunityMergeRelationshipColumn(column);
}

export function classifyCrmDuplicateConsolidationReference({ table = '', column = '' } = {}) {
  const key = `${table}.${column}`;
  if (!knownRelationshipColumns.has(key)) return null;
  if (table === 'crm_submission_supersessions') return 'mutated-approved-relation';
  if (table === 'deal_hunter_crm_imports' && ['submission_id', 'metadata'].includes(column)) {
    return 'mutated-berlin-import-only';
  }
  if (retainedReferenceTables.has(table)) return 'retained-with-provenance';
  return 'explicitly-irrelevant';
}

export function classifyCrmDuplicateConsolidationTextReference({ table = '', column = '' } = {}) {
  const explicitColumnClassification = classifyCrmDuplicateConsolidationReference({ table, column });
  if (explicitColumnClassification) return explicitColumnClassification;
  if (retainedReferenceTables.has(table)) return 'retained-with-provenance';
  if (table === 'deal_hunter_cim_repair_manifests') return 'retained-historical-receipt';
  if (table === 'deal_hunter_crm_imports') return 'approved-import-preservation-matrix';
  if (table === 'crm_submission_supersessions') return 'mutated-approved-relation';
  return null;
}

export function findCrmDuplicateConsolidationUnclassifiedSchema(schema = []) {
  const blockers = [];
  for (const table of schema) {
    for (const column of table.columns || []) {
      if (!isCrmDuplicateConsolidationRelationshipColumn(column.name)) continue;
      if (!classifyCrmDuplicateConsolidationReference({ table: table.name, column: column.name })) {
        blockers.push(`unclassified relationship schema: ${table.name}.${column.name}`);
      }
    }
  }
  return blockers.sort();
}

export function crmDuplicateConsolidationApprovalTuple() {
  return {
    repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
    approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
    repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
    pairs: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs,
    berlinImport: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinImport,
  };
}

export function crmDuplicateConsolidationManifestId() {
  return `${CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE}:v1:${canonicalJsonSha256(crmDuplicateConsolidationApprovalTuple())}`;
}

export function crmDuplicateConsolidationRelationId(pair) {
  const approved = CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.pairs.find((item) => item.key === pair?.key);
  if (!approved || stableCanonicalJson(approved) !== stableCanonicalJson(pair)) {
    throw new Error('CRM duplicate consolidation relation requires one exact approved pair.');
  }
  return `crm-submission-supersession:v1:${canonicalJsonSha256({
    opportunityId: approved.opportunityId,
    survivorSubmissionId: approved.survivorSubmissionId,
    supersededSubmissionId: approved.supersededSubmissionId,
  })}`;
}

export function getCrmDuplicateConsolidationDescriptor(input) {
  if (input !== undefined && input !== null && Object.keys(input).length > 0) {
    throw new Error('The fixed CRM duplicate consolidation incident does not accept runtime pair IDs or selectors.');
  }
  return CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR;
}

function normalizeOperatorText(value, maximum) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function exactDescriptor(value) {
  return stableCanonicalJson(value) === stableCanonicalJson(crmDuplicateConsolidationApprovalTuple());
}

export function buildCrmDuplicateConsolidationPlan({
  inspection,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  recoveryCheckpoint,
} = {}) {
  const normalizedActor = normalizeOperatorText(actor, 160);
  const normalizedReason = normalizeOperatorText(reason, 1000);
  const normalizedRelease = normalizeOperatorText(executionRelease, 160);
  const normalizedTooling = normalizeOperatorText(toolingRevision, 160);
  if (!normalizedActor) throw new Error('CRM duplicate consolidation requires an accountable actor.');
  if (normalizedReason.length < 20) throw new Error('CRM duplicate consolidation requires a specific reason.');
  if (!normalizedRelease) throw new Error('CRM duplicate consolidation requires an execution release.');
  if (!/^[a-f0-9]{40,64}$/.test(normalizedTooling)) {
    throw new Error('CRM duplicate consolidation requires an exact lowercase tooling revision SHA.');
  }
  if (!inspection || inspection.provider !== 'sqlite') {
    throw new Error('CRM duplicate consolidation requires a complete SQLite inspection.');
  }
  if (inspection.blockers?.length) {
    const error = new Error(`CRM duplicate consolidation inspection refused: ${inspection.blockers.join('; ')}`);
    error.blockers = [...inspection.blockers];
    throw error;
  }
  const checkedRecovery = validateCrmDuplicateConsolidationCheckpointEvidence({
    evidence: {
      schema: CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
      checkpoint: recoveryCheckpoint,
    },
    expectedExecutionRelease: normalizedRelease,
    expectedToolingRevision: normalizedTooling,
  });
  const recoveryReferences = structuredClone(checkedRecovery.checkpoint);
  delete recoveryReferences.backupPath;
  const plan = {
    repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
    repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
    approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
    planSchema: CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
    manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
    approval: crmDuplicateConsolidationApprovalTuple(),
    actor: normalizedActor,
    reason: normalizedReason,
    execution: {
      release: normalizedRelease,
      toolingRevision: normalizedTooling,
    },
    recoveryCheckpoint: recoveryReferences,
    database: inspection.database,
    schema: inspection.schema,
    relationshipInventory: inspection.relationshipInventory,
    referenceIdentifiers: inspection.referenceIdentifiers,
    tableDigests: inspection.tableDigests,
    rawRows: inspection.rawRows,
    safety: inspection.safety,
    currentState: inspection.currentState,
    expectedMutationLedger: CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER,
  };
  return {
    manifestId: crmDuplicateConsolidationManifestId(),
    plan,
    planChecksum: canonicalJsonSha256(plan),
  };
}

export function validateCrmDuplicateConsolidationArtifact({
  artifact,
  expectedPlanChecksum,
  expectedManifestId,
} = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('Reviewed CRM duplicate consolidation artifact is required.');
  }
  if (!String(artifact.recoveryCheckpointPath || '').trim()
    || Object.hasOwn(artifact.plan?.recoveryCheckpoint || {}, 'backupPath')) {
    throw new Error('Reviewed CRM duplicate consolidation backup path must be outside the checksummed plan.');
  }
  validateCrmDuplicateConsolidationCheckpointEvidence({
    evidence: {
      schema: CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA,
      checkpoint: {
        ...artifact.plan?.recoveryCheckpoint,
        backupPath: artifact.recoveryCheckpointPath,
      },
    },
    expectedExecutionRelease: artifact.plan?.execution?.release,
    expectedToolingRevision: artifact.plan?.execution?.toolingRevision,
  });
  const manifestId = crmDuplicateConsolidationManifestId();
  if (artifact.manifestId !== expectedManifestId || artifact.manifestId !== manifestId) {
    throw new Error('Reviewed CRM duplicate consolidation manifest ID does not match the fixed incident.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(expectedPlanChecksum || ''))
    || artifact.planChecksum !== expectedPlanChecksum
    || canonicalJsonSha256(artifact.plan) !== expectedPlanChecksum) {
    throw new Error('Reviewed CRM duplicate consolidation checksum does not match canonical plan bytes.');
  }
  if (artifact.repairType !== CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE
    || artifact.repairVersion !== CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION
    || artifact.approvalSchema !== CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA
    || artifact.planSchema !== CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA
    || artifact.manifestSchema !== CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA
    || artifact.plan?.planSchema !== CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA
    || artifact.plan?.manifestSchema !== CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA) {
    throw new Error('Reviewed CRM duplicate consolidation schema or repair version is invalid.');
  }
  if (!exactDescriptor(artifact.plan?.approval)) {
    throw new Error('Reviewed CRM duplicate consolidation tuple is not the exact approved incident.');
  }
  if (stableCanonicalJson(artifact.plan?.expectedMutationLedger)
    !== stableCanonicalJson(CRM_DUPLICATE_CONSOLIDATION_EXPECTED_MUTATION_LEDGER)) {
    throw new Error('Reviewed CRM duplicate consolidation mutation ledger is invalid.');
  }
  return artifact;
}

export function validateCrmDuplicateConsolidationReceipt({
  row,
  rawRow,
  artifact,
  actor,
  reason,
  backup,
  appliedState,
} = {}) {
  if (!row || !rawRow || row.id !== artifact.manifestId
    || row.mode !== CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE
    || row.status !== 'applied'
    || row.actor !== actor
    || row.backup_reference !== backup.path
    || row.checksum !== artifact.planChecksum
    || row.created_at !== row.updated_at) {
    throw new Error('CRM duplicate consolidation receipt collision or stored-field mismatch.');
  }
  const expectedManifest = {
    repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
    repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
    manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
    approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
    manifestId: artifact.manifestId,
    planChecksum: artifact.planChecksum,
    actor,
    reason,
    backup,
    artifact,
    appliedAt: row.created_at,
    mutationCount: 4,
  };
  const expectedMetadata = {
    repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
    repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
    manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
    approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
    planChecksum: artifact.planChecksum,
    pairKeys: ['pooler', 'berlin'],
    berlinPriorSubmissionId: BERLIN_IMPORT_BEFORE_ID,
  };
  if (stableCanonicalJson(row.manifest) !== stableCanonicalJson(expectedManifest)
    || stableCanonicalJson(row.metadata) !== stableCanonicalJson(expectedMetadata)
    || rawRow.manifest !== stableCanonicalJson(expectedManifest)
    || rawRow.metadata !== stableCanonicalJson(expectedMetadata)) {
    throw new Error('CRM duplicate consolidation receipt collision or canonical bytes mismatch.');
  }
  if (appliedState?.valid !== true) {
    throw new Error('CRM duplicate consolidation receipt exists without the exact completed state.');
  }
  return { manifest: expectedManifest, metadata: expectedMetadata };
}

const BERLIN_IMPORT_BEFORE_ID = berlin.supersededSubmissionId;
