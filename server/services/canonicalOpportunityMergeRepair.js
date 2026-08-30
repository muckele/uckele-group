import path from 'node:path';
import {
  CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION,
  getCanonicalOpportunityMergeApproval,
} from '../repairs/canonicalOpportunityMerge.js';
import { verifyBackupBundle } from './backups.js';

function normalizedText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function verifiedBackupSummary(verification, requestedBundlePath) {
  const manifest = verification?.manifest;
  const database = manifest?.database;
  const verificationMetadata = manifest?.verification;
  const valid = verification?.ok === true
    && verification?.current === true
    && verification?.legacy === false
    && verification?.classification === 'current'
    && Array.isArray(verification.errors)
    && verification.errors.length === 0
    && typeof verification.path === 'string'
    && verification.path === requestedBundlePath
    && manifest?.version === 2
    && manifest?.provider === 'sqlite'
    && typeof manifest.id === 'string'
    && manifest.id.trim()
    && validDate(manifest.createdAt)
    && typeof database?.relativePath === 'string'
    && database.relativePath.trim()
    && Number.isInteger(database.sizeBytes)
    && database.sizeBytes >= 0
    && /^[a-f0-9]{64}$/i.test(String(database.sha256 || ''))
    && validDate(verificationMetadata?.verifiedAt)
    && Date.parse(verificationMetadata.verifiedAt) >= Date.parse(manifest.createdAt)
    && verificationMetadata?.databaseCheck === 'quick_check'
    && verificationMetadata?.checksum === 'sha256';
  if (!valid) {
    const details = [];
    if (verification?.path !== requestedBundlePath) {
      details.push('verified bundle path does not match the requested backup path');
    }
    if (Array.isArray(verification?.errors)) details.push(...verification.errors.slice(0, 3));
    throw new Error(
      `Apply refused: verified SQLite backup evidence is required${details.length ? `: ${details.join('; ')}` : '.'}`,
    );
  }
  return {
    path: verification.path,
    manifestId: manifest.id,
    createdAt: manifest.createdAt,
    verifiedAt: verificationMetadata.verifiedAt,
    databaseRelativePath: database.relativePath,
    databaseSizeBytes: database.sizeBytes,
    databaseSha256: database.sha256.toLowerCase(),
    provider: 'sqlite',
    verification: {
      databaseCheck: 'quick_check',
      checksum: 'sha256',
    },
  };
}

export async function runCanonicalOpportunityMergeRepair({
  apply = false,
  exceptionId = '',
  survivorId = '',
  supersededId = '',
  actor = '',
  reason = '',
  confirmation = '',
  expectedPlanChecksum = '',
  backupPath = '',
  storage = null,
  now = new Date(),
} = {}) {
  if (!storage) {
    throw new Error('Canonical opportunity merge repair requires explicitly supplied storage; automatic storage startup is disabled.');
  }
  if (storage?.provider !== 'sqlite') {
    throw new Error('Canonical opportunity merge repair is SQLite-only and refused the active storage provider.');
  }
  const approval = getCanonicalOpportunityMergeApproval({ exceptionId, survivorId, supersededId });
  if (!storage.inspectDealHunterCanonicalOpportunityMerge) {
    throw new Error('SQLite canonical opportunity merge inspection is unavailable.');
  }
  const normalizedActor = normalizedText(actor, 160);
  const normalizedReason = normalizedText(reason, 1000);
  if (!normalizedActor) throw new Error('Canonical opportunity merge requires an accountable actor.');
  if (normalizedReason.length < 20) throw new Error('Canonical opportunity merge requires a specific human reason.');
  if (apply) {
    if (confirmation !== CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION) {
      throw new Error(`Apply refused: pass the exact confirmation phrase ${CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(expectedPlanChecksum || ''))) {
      throw new Error('Apply refused: an exact 64-character dry-run plan checksum is required.');
    }
    if (typeof backupPath !== 'string' || !backupPath.trim()) {
      throw new Error('Apply refused: verified SQLite backup evidence is required.');
    }
    const requestedBundlePath = path.resolve(backupPath);
    const backupVerification = await verifyBackupBundle(requestedBundlePath);
    const backupEvidence = verifiedBackupSummary(backupVerification, requestedBundlePath);
    const pause = await storage.getDealHunterCimSafetySettings?.();
    if (!pause?.outreach_paused) {
      throw new Error('Apply refused: global Deal Hunter CIM outreach must already be paused.');
    }
    if (!storage.verifyDealHunterCanonicalOpportunityMergeBackupPlan) {
      throw new Error('Apply refused: SQLite backup-to-plan verification is unavailable.');
    }
    const backupPlan = await storage.verifyDealHunterCanonicalOpportunityMergeBackupPlan({
      approval,
      actor: normalizedActor,
      reason: normalizedReason,
      backupEvidence,
      expectedPlanChecksum,
    });
    if (backupPlan?.planChecksum !== expectedPlanChecksum) {
      throw new Error('Apply refused: the verified SQLite backup does not reproduce the exact reviewed plan checksum.');
    }
    if (
      backupPlan?.pauseUpdatedAt !== pause.updated_at
      || Date.parse(backupEvidence.createdAt) < Date.parse(pause.updated_at)
    ) {
      throw new Error('Apply refused: the verified SQLite backup does not contain the active outreach-pause epoch.');
    }
    backupEvidence.reviewedPlanChecksum = backupPlan.planChecksum;
    backupEvidence.pauseUpdatedAt = backupPlan.pauseUpdatedAt;
    if (!storage.applyDealHunterCanonicalOpportunityMerge) {
      throw new Error('Atomic SQLite canonical opportunity merge storage is unavailable.');
    }
    return storage.applyDealHunterCanonicalOpportunityMerge({
      approval,
      actor: normalizedActor,
      reason: normalizedReason,
      confirmation,
      expectedPlanChecksum,
      backupEvidence,
      nowIso: now.toISOString(),
    });
  }
  const inspected = await storage.inspectDealHunterCanonicalOpportunityMerge({
    approval,
    actor: normalizedActor,
    reason: normalizedReason,
  });
  return {
    ok: true,
    mode: 'dry-run',
    applied: false,
    applyBlocked: false,
    applyBlockers: [],
    generatedAt: now.toISOString(),
    approval: {
      repairType: approval.repairType,
      approvalSchema: approval.approvalSchema,
      exceptionId: approval.exceptionId,
      survivorId: approval.survivorId,
      supersededId: approval.supersededId,
    },
    ...inspected,
  };
}
