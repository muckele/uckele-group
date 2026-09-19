import {
  buildCrmDuplicateConsolidationPlan,
  CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION,
  CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
  CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
  stableCanonicalJson,
  validateCrmDuplicateConsolidationArtifact,
} from '../repairs/crmDuplicateConsolidation.js';

export const CRM_DUPLICATE_CONSOLIDATION_REFUSED = 'CRM_DUPLICATE_CONSOLIDATION_REFUSED';

export class CrmDuplicateConsolidationRefusedError extends Error {
  constructor(message, blockers = []) {
    super(message);
    this.name = 'CrmDuplicateConsolidationRefusedError';
    this.code = CRM_DUPLICATE_CONSOLIDATION_REFUSED;
    this.status = 409;
    this.blockers = [...new Set(blockers.map(String))].sort().slice(0, 100);
  }
}

function refuse(message, blockers = []) {
  throw new CrmDuplicateConsolidationRefusedError(message, blockers);
}

function normalizedText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseArtifact(artifact) {
  if (Buffer.isBuffer(artifact)) return parseArtifact(artifact.toString('utf8'));
  if (typeof artifact === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(artifact);
    } catch {
      refuse('Reviewed CRM duplicate consolidation artifact is not valid JSON.', ['artifact-invalid-json']);
    }
    if (artifact !== stableCanonicalJson(parsed)) {
      refuse('Reviewed CRM duplicate consolidation artifact bytes are not canonical JSON.', ['artifact-not-canonical']);
    }
    return parsed;
  }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    refuse('Reviewed CRM duplicate consolidation artifact is required.', ['artifact-missing']);
  }
  return structuredClone(artifact);
}

function checkedOperatorFacts({ actor, reason, executionRelease, toolingRevision }) {
  const checked = {
    actor: normalizedText(actor, 160),
    reason: normalizedText(reason, 1000),
    executionRelease: normalizedText(executionRelease, 160),
    toolingRevision: normalizedText(toolingRevision, 160),
  };
  if (!checked.actor) refuse('CRM duplicate consolidation actor is required.', ['actor-missing']);
  if (checked.reason.length < 20) refuse('CRM duplicate consolidation reason is too short.', ['reason-invalid']);
  if (!checked.executionRelease) refuse('CRM duplicate consolidation execution release is required.', ['release-missing']);
  if (!/^[a-f0-9]{40,64}$/.test(checked.toolingRevision)) {
    refuse('CRM duplicate consolidation tooling revision must be an exact lowercase SHA.', ['tooling-revision-invalid']);
  }
  return checked;
}

function checkedRecoveryCheckpoint(checkpoint) {
  const value = checkpoint && typeof checkpoint === 'object' ? structuredClone(checkpoint) : null;
  if (!value
    || !String(value.backupPath || '').trim()
    || !String(value.backupManifestId || '').trim()
    || !/^[a-f0-9]{64}$/.test(String(value.backupSha256 || ''))
    || !String(value.flySnapshotId || '').trim()
    || !/^[a-f0-9]{64}$/.test(String(value.flySnapshotDigest || ''))
    || !String(value.flyRelease || '').trim()
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.verifiedAt))) {
    refuse('CRM duplicate consolidation requires a complete reviewed recovery checkpoint.', ['recovery-checkpoint-invalid']);
  }
  return value;
}

export function verifyCrmDuplicateConsolidationReviewedArtifact({
  artifact,
  expectedPlanChecksum,
  expectedManifestId,
} = {}) {
  const parsed = parseArtifact(artifact);
  try {
    return validateCrmDuplicateConsolidationArtifact({
      artifact: parsed,
      expectedPlanChecksum,
      expectedManifestId,
    });
  } catch (error) {
    refuse(error.message, ['reviewed-artifact-mismatch']);
  }
}

export async function previewCrmDuplicateConsolidation({
  storage,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  recoveryCheckpoint,
} = {}) {
  if (!storage) refuse('CRM duplicate consolidation preview requires explicit storage.', ['storage-missing']);
  if (storage.provider !== 'sqlite') refuse('CRM duplicate consolidation is SQLite-only.', ['storage-provider-not-sqlite']);
  if (typeof storage.inspectCrmDuplicateConsolidation !== 'function') {
    refuse('SQLite CRM duplicate consolidation inspection is unavailable.', ['inspection-unavailable']);
  }
  const facts = checkedOperatorFacts({ actor, reason, executionRelease, toolingRevision });
  const checkpoint = checkedRecoveryCheckpoint(recoveryCheckpoint);
  let inspection;
  try {
    inspection = await storage.inspectCrmDuplicateConsolidation();
  } catch (error) {
    if (error?.code === CRM_DUPLICATE_CONSOLIDATION_REFUSED) throw error;
    refuse(`CRM duplicate consolidation inspection failed: ${error.message}`, ['inspection-failed']);
  }
  if (inspection?.blockers?.length) {
    refuse(
      `CRM duplicate consolidation preview found blocking state: ${inspection.blockers.join('; ')}.`,
      inspection.blockers,
    );
  }
  let planned;
  try {
    planned = buildCrmDuplicateConsolidationPlan({
      inspection,
      actor: facts.actor,
      reason: facts.reason,
      executionRelease: facts.executionRelease,
      toolingRevision: facts.toolingRevision,
      recoveryCheckpoint: checkpoint,
    });
  } catch (error) {
    refuse(error.message, error.blockers || ['plan-invalid']);
  }
  return {
    status: 'repair-required',
    mode: 'preview',
    applied: false,
    blockers: [],
    repairType: CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE,
    repairVersion: CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION,
    approvalSchema: CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA,
    planSchema: CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA,
    manifestSchema: CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA,
    manifestId: planned.manifestId,
    planChecksum: planned.planChecksum,
    recoveryCheckpointPath: checkpoint.backupPath,
    connection: inspection.connection,
    plan: planned.plan,
  };
}

function checkedBackup(backup, checkpoint, reviewedPath) {
  const value = backup && typeof backup === 'object' ? {
    path: String(backup.path || '').trim(),
    manifestId: String(backup.manifestId || '').trim(),
    sha256: String(backup.sha256 || ''),
    flySnapshotId: String(backup.flySnapshotId || '').trim(),
    flySnapshotDigest: String(backup.flySnapshotDigest || ''),
  } : null;
  if (!value?.path) refuse('Apply refused: exact backup path is required.', ['backup-path-invalid']);
  if (value.manifestId !== checkpoint.backupManifestId) {
    refuse('Apply refused: backup manifest does not match the reviewed artifact.', ['backup-manifest-mismatch']);
  }
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || value.sha256 !== checkpoint.backupSha256) {
    refuse('Apply refused: backup SHA does not match the reviewed artifact.', ['backup-sha-mismatch']);
  }
  if (value.path !== reviewedPath) {
    refuse('Apply refused: backup path does not match the reviewed artifact.', ['backup-path-mismatch']);
  }
  if (value.flySnapshotId !== checkpoint.flySnapshotId
    || value.flySnapshotDigest !== checkpoint.flySnapshotDigest) {
    refuse('Apply refused: Fly snapshot evidence does not match the reviewed artifact.', ['fly-snapshot-mismatch']);
  }
  return value;
}

export async function applyCrmDuplicateConsolidation({
  apply = false,
  storage,
  reviewedArtifact,
  expectedPlanChecksum,
  expectedManifestId,
  backup,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  confirmation,
  now = new Date(),
  testHooks = null,
} = {}) {
  if (apply !== true) refuse('Apply refused: explicit apply flag is required.', ['apply-flag-missing']);
  if (!storage) refuse('Apply refused: explicit storage is required.', ['storage-missing']);
  if (storage.provider !== 'sqlite') refuse('Apply refused: storage provider is not SQLite.', ['storage-provider-not-sqlite']);
  if (confirmation !== CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION) {
    refuse('Apply refused: exact confirmation text is required.', ['confirmation-mismatch']);
  }
  const artifact = verifyCrmDuplicateConsolidationReviewedArtifact({
    artifact: reviewedArtifact,
    expectedPlanChecksum,
    expectedManifestId,
  });
  const facts = checkedOperatorFacts({ actor, reason, executionRelease, toolingRevision });
  if (artifact.plan.actor !== facts.actor) refuse('Apply refused: actor differs from reviewed artifact.', ['actor-mismatch']);
  if (artifact.plan.reason !== facts.reason) refuse('Apply refused: reason differs from reviewed artifact.', ['reason-mismatch']);
  if (artifact.plan.execution?.release !== facts.executionRelease
    || artifact.plan.recoveryCheckpoint?.flyRelease !== facts.executionRelease) {
    refuse('Apply refused: execution release differs from reviewed artifact.', ['release-mismatch']);
  }
  if (artifact.plan.execution?.toolingRevision !== facts.toolingRevision) {
    refuse('Apply refused: tooling revision differs from reviewed artifact.', ['tooling-revision-mismatch']);
  }
  const checkedBackupEvidence = checkedBackup(
    backup,
    artifact.plan.recoveryCheckpoint,
    artifact.recoveryCheckpointPath,
  );
  if (typeof storage.verifyCrmDuplicateConsolidationBackupPlan !== 'function') {
    refuse('Apply refused: SQLite backup-to-plan verification is unavailable.', ['backup-verification-unavailable']);
  }
  let verification;
  try {
    verification = await storage.verifyCrmDuplicateConsolidationBackupPlan({
      artifact,
      backup: checkedBackupEvidence,
    });
  } catch (error) {
    if (error?.code === CRM_DUPLICATE_CONSOLIDATION_REFUSED) throw error;
    refuse(`Apply refused: backup verification failed: ${error.message}`, ['backup-verification-failed']);
  }
  if (verification?.planChecksum !== expectedPlanChecksum
    || verification?.databaseLogicalDigest !== artifact.plan.database.logicalDigest) {
    refuse('Apply refused: backup does not reproduce the reviewed plan.', ['backup-plan-mismatch']);
  }
  if (typeof storage.applyCrmDuplicateConsolidation !== 'function') {
    refuse('Apply refused: atomic SQLite consolidation is unavailable.', ['apply-unavailable']);
  }
  const nowIso = now instanceof Date ? now.toISOString() : String(now || '');
  if (!Number.isFinite(Date.parse(nowIso))) refuse('Apply refused: audit timestamp is invalid.', ['timestamp-invalid']);
  try {
    const result = await storage.applyCrmDuplicateConsolidation({
      artifact,
      backup: checkedBackupEvidence,
      actor: facts.actor,
      reason: facts.reason,
      executionRelease: facts.executionRelease,
      toolingRevision: facts.toolingRevision,
      nowIso,
      testHooks,
    });
    if (!['repair-required', 'verified-prior-apply'].includes(result?.status)) {
      refuse('Apply refused: storage returned an unsupported incident state.', ['unexpected-apply-state']);
    }
    return result;
  } catch (error) {
    if (error?.code === CRM_DUPLICATE_CONSOLIDATION_REFUSED) throw error;
    refuse(`Apply refused: ${error.message}`, ['atomic-apply-refused']);
  }
}
