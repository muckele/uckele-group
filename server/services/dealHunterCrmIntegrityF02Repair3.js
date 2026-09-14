import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_APPROVAL_SCHEMA,
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_AUTHORITY,
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_CONFIRMATION,
  DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_RECEIPT_SCHEMA,
  createDealHunterCrmIntegrityF02Repair3ApprovalManifest,
  deterministicDealHunterCrmIntegrityF02Repair3Checksum,
  fingerprintDealHunterCrmIntegrityF02Repair3RawRow,
  fingerprintDealHunterCrmIntegrityF02Repair3ContextOpportunity,
} from '../repairs/dealHunterCrmIntegrityF02Repair3.js';
import { auditDealHunterCrmIntegrity } from './dealHunter.js';
import { verifyBackupBundle } from './backups.js';

const targetTables = ['contact_submissions', 'deal_hunter_crm_imports'];
const requiredColumns = {
  contact_submissions: [
    'id', 'created_at', 'updated_at', 'status', 'source', 'company',
    'deal_hunter_opportunity_id', 'metadata',
  ],
  deal_hunter_crm_imports: [
    'id', 'created_at', 'updated_at', 'status', 'submission_id',
    'opportunity_id', 'metadata',
  ],
  deal_hunter_opportunities: [
    'opportunity_id', 'created_at', 'updated_at', 'primary_submission_id', 'metadata',
  ],
};

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeSubmission(row) {
  return row ? {
    ...row,
    metadata: parseJson(row.metadata, {}),
    spam_reasons: parseJson(row.spam_reasons, []),
    tags: parseJson(row.tags, []),
  } : null;
}

function normalizeMetadataRow(row) {
  return row ? { ...row, metadata: parseJson(row.metadata, {}) } : null;
}

function createAuditStorage(database) {
  return {
    provider: 'sqlite',
    async listDealHunterCrmImports({ limit = 100000 } = {}) {
      return database.prepare(`
        SELECT * FROM deal_hunter_crm_imports
        ORDER BY updated_at DESC, id
        LIMIT ?
      `).all(limit).map(normalizeMetadataRow);
    },
    async listDealHunterOpportunities({ limit = 100000 } = {}) {
      return database.prepare(`
        SELECT * FROM deal_hunter_opportunities
        ORDER BY updated_at DESC, opportunity_id
        LIMIT ?
      `).all(limit).map(normalizeMetadataRow);
    },
    async getDealHunterCanonicalCrmOwnershipHealth() {
      const collisions = database.prepare(`
        SELECT opportunity_id, COUNT(*) AS record_count
        FROM deal_hunter_crm_imports
        WHERE opportunity_id IS NOT NULL AND opportunity_id <> ''
        GROUP BY opportunity_id
        HAVING COUNT(*) > 1
        ORDER BY opportunity_id
      `).all();
      return {
        healthy: collisions.length === 0,
        collisions: collisions.map((row) => ({
          opportunityId: row.opportunity_id,
          recordCount: Number(row.record_count),
        })),
      };
    },
    async listDealHunterLinkedSubmissions({ limit = 100000 } = {}) {
      return database.prepare(`
        SELECT * FROM contact_submissions
        WHERE (deal_hunter_opportunity_id IS NOT NULL AND deal_hunter_opportunity_id <> '')
           OR source = 'deal-hunter-daily-review'
           OR COALESCE(json_extract(metadata, '$.dealHunter.opportunityId'), '') <> ''
           OR json_extract(metadata, '$.dealHunter.managed') IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit).map(normalizeSubmission);
    },
    async listSubmissionsByIds(ids = [], { limit = 100000 } = {}) {
      const selected = [...new Set(ids.filter(Boolean))].slice(0, limit);
      if (selected.length === 0) return [];
      const rows = [];
      for (let offset = 0; offset < selected.length; offset += 500) {
        const batch = selected.slice(offset, offset + 500);
        rows.push(...database.prepare(`
          SELECT * FROM contact_submissions
          WHERE id IN (${batch.map(() => '?').join(', ')})
        `).all(...batch));
      }
      return rows.map(normalizeSubmission);
    },
  };
}

function projectAudit(audit) {
  return {
    ok: audit.ok,
    safeToReconcile: audit.safeToReconcile,
    counts: { ...audit.counts },
  };
}

function validateSchema(database) {
  const blockers = [];
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const exists = database.prepare(`
      SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?
    `).get(table);
    if (!exists) {
      blockers.push(`SCHEMA_TABLE_MISSING:${table}`);
      continue;
    }
    const actual = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const column of columns) {
      if (!actual.has(column)) blockers.push(`SCHEMA_COLUMN_MISSING:${table}.${column}`);
    }
  }
  return blockers;
}

function targetTriggerBlockers(database) {
  const triggers = database.prepare(`
    SELECT name, tbl_name
    FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name IN (?, ?)
    ORDER BY name
  `).all(...targetTables);
  return triggers.map((trigger) => `UNSUPPORTED_TARGET_TRIGGER:${trigger.tbl_name}:${trigger.name}`);
}

function selectAuthorityRows(database, authority) {
  const {
    collision,
    backlink,
    managedName,
    reviewedUnrelatedOpportunity,
  } = authority.relationships;
  const byId = (table, id) => database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const backlinkImports = database.prepare(`
    SELECT * FROM deal_hunter_crm_imports
    WHERE opportunity_id = ? AND submission_id = ?
    ORDER BY id
  `).all(backlink.opportunityId, backlink.submissionId);
  return {
    rows: {
      legacyCollisionImport: byId('deal_hunter_crm_imports', collision.legacyImportId),
      retainedUrlImport: byId('deal_hunter_crm_imports', collision.retainedImportId),
      collisionOpportunity: database.prepare(`
        SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?
      `).get(collision.opportunityId),
      collisionSubmission: byId('contact_submissions', collision.sharedSubmissionId),
      backlinkOpportunity: database.prepare(`
        SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?
      `).get(backlink.opportunityId),
      backlinkImport: backlinkImports.length === 1 ? backlinkImports[0] : null,
      backlinkSubmission: byId('contact_submissions', backlink.submissionId),
      nameMismatchSubmission: byId('contact_submissions', managedName.submissionId),
      reviewedUnrelatedOpportunity: database.prepare(`
        SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?
      `).get(reviewedUnrelatedOpportunity.opportunityId),
    },
    backlinkImportCount: backlinkImports.length,
    reviewedUnrelatedImportCount: database.prepare(`
      SELECT COUNT(*) AS count FROM deal_hunter_crm_imports WHERE opportunity_id = ?
    `).get(reviewedUnrelatedOpportunity.opportunityId).count,
  };
}

function mutationRowLabel(mutation) {
  if (mutation.table === 'deal_hunter_crm_imports') return 'legacyCollisionImport';
  if (mutation.field === 'deal_hunter_opportunity_id') return 'backlinkSubmission';
  return 'nameMismatchSubmission';
}

function mutationValueState(rows, authority) {
  const matchesBefore = [];
  const matchesAfter = [];
  for (const mutation of authority.mutations) {
    const row = rows[mutationRowLabel(mutation)];
    matchesBefore.push(Boolean(row) && Object.is(row[mutation.field], mutation.before));
    matchesAfter.push(Boolean(row) && Object.is(row[mutation.field], mutation.after));
  }
  if (matchesBefore.every(Boolean)) return 'before';
  if (matchesAfter.every(Boolean)) return 'after';
  return 'mixed';
}

function authorityFingerprintBlockers(rows, authority, valueState) {
  const blockers = [];
  const mutationByLabel = new Map(authority.mutations.map((mutation) => [mutationRowLabel(mutation), mutation]));
  for (const [label, expected] of Object.entries(authority.rowFingerprints)) {
    const current = rows[label];
    if (!current) {
      blockers.push(`AUTHORITY_ROW_MISSING:${label}`);
      continue;
    }
    const fingerprintInput = { ...current };
    const mutation = mutationByLabel.get(label);
    if (valueState === 'after' && mutation) fingerprintInput[mutation.field] = mutation.before;
    if (fingerprintDealHunterCrmIntegrityF02Repair3RawRow(fingerprintInput) !== expected) {
      blockers.push(`AUTHORITY_FINGERPRINT_MISMATCH:${label}`);
    }
  }
  // Hard-coded context labels only: no mutation target can use this projection.
  // This exclusion does not apply to the all-table digest or receipt raw hashes.
  for (const label of ['collisionOpportunity', 'reviewedUnrelatedOpportunity']) {
    const current = rows[label];
    if (!current) {
      blockers.push(`AUTHORITY_ROW_MISSING:${label}`);
    } else if (fingerprintDealHunterCrmIntegrityF02Repair3ContextOpportunity(current)
      !== authority.contextOpportunityFingerprints[label]) {
      blockers.push(`CONTEXT_PROJECTION_FINGERPRINT_MISMATCH:${label}`);
    }
  }
  return blockers;
}

function normalizedOwnerId(value) {
  return String(value || '').trim();
}

// Repair3-only incident predicate. The generic audit remains unchanged: this
// helper binds its supported direct-or-metadata declared-owner semantics while
// explicitly refusing a conflict, a different owner, or no declared owner.
export function evaluateDealHunterCrmIntegrityF02Repair3DeclaredOwner({
  directOpportunityId,
  metadataOpportunityId,
  expectedOpportunityId,
}) {
  const direct = normalizedOwnerId(directOpportunityId);
  const metadata = normalizedOwnerId(metadataOpportunityId);
  const expected = normalizedOwnerId(expectedOpportunityId);
  if (direct && metadata && direct !== metadata) {
    return { ok: false, blocker: 'COLLISION_DECLARED_OWNER_CONFLICT' };
  }
  const declaredOpportunityId = direct || metadata;
  if (!declaredOpportunityId) {
    return { ok: false, blocker: 'COLLISION_DECLARED_OWNER_MISSING' };
  }
  if (declaredOpportunityId !== expected) {
    return { ok: false, blocker: 'COLLISION_DECLARED_OWNER_MISMATCH' };
  }
  return { ok: true, declaredOpportunityId };
}

function relationshipBlockers(database, rows, authority, valueState, selected) {
  const blockers = [];
  const {
    collision,
    backlink,
    managedName,
    reviewedUnrelatedOpportunity,
  } = authority.relationships;
  const collisionImports = database.prepare(`
    SELECT id, submission_id FROM deal_hunter_crm_imports
    WHERE opportunity_id = ? ORDER BY id
  `).all(collision.opportunityId);
  const expectedCollisionIds = valueState === 'before'
    ? [...collision.claimantImportIds].sort()
    : [collision.retainedImportId];
  if (collisionImports.length !== (valueState === 'before' ? 2 : 1)) {
    blockers.push('COLLISION_IMPORT_COUNT_MISMATCH');
  }
  if (JSON.stringify(collisionImports.map((row) => row.id).sort())
    !== JSON.stringify(expectedCollisionIds)) {
    blockers.push('COLLISION_IMPORT_AUTHORITY_MISMATCH');
  }
  const retained = rows.retainedUrlImport;
  const legacy = rows.legacyCollisionImport;
  if (retained?.opportunity_id !== collision.opportunityId
    || retained?.submission_id !== collision.sharedSubmissionId
    || legacy?.submission_id !== collision.sharedSubmissionId) {
    blockers.push('COLLISION_RELATIONSHIP_MISMATCH');
  }
  if (valueState === 'after' && legacy?.opportunity_id !== null) {
    blockers.push('LEGACY_IMPORT_CLAIM_NOT_RELEASED');
  }
  if (rows.collisionOpportunity?.primary_submission_id !== collision.expectedPrimarySubmissionId) {
    blockers.push('COLLISION_PRIMARY_RELATIONSHIP_MISMATCH');
  }
  const collisionMetadata = parseJson(rows.collisionSubmission?.metadata, {});
  const declaredOwner = evaluateDealHunterCrmIntegrityF02Repair3DeclaredOwner({
    directOpportunityId: rows.collisionSubmission?.deal_hunter_opportunity_id,
    metadataOpportunityId: collisionMetadata?.dealHunter?.opportunityId,
    expectedOpportunityId: collision.opportunityId,
  });
  if (!declaredOwner.ok) {
    blockers.push(declaredOwner.blocker);
  }

  if (rows.backlinkOpportunity?.primary_submission_id !== backlink.submissionId) {
    blockers.push('BACKLINK_PRIMARY_RELATIONSHIP_MISMATCH');
  }
  const backlinkMetadata = parseJson(rows.backlinkSubmission?.metadata, {});
  if (String(backlinkMetadata?.dealHunter?.opportunityId || '') !== '') {
    blockers.push('BACKLINK_METADATA_OWNER_UNEXPECTED');
  }
  if (rows.backlinkImport?.opportunity_id !== backlink.opportunityId
    || rows.backlinkImport?.submission_id !== backlink.submissionId) {
    blockers.push('BACKLINK_IMPORT_RELATIONSHIP_MISMATCH');
  }

  const managedMetadata = parseJson(rows.nameMismatchSubmission?.metadata, {});
  const rawName = managedMetadata?.dealHunter?.raw?.['Business Name']
    || managedMetadata?.dealHunter?.raw?.Name
    || managedMetadata?.dealHunter?.name
    || '';
  if (managedMetadata?.dealHunter?.managed !== true
    || String(rawName).trim() !== managedName.authoritativeCompany) {
    blockers.push('MANAGED_NAME_AUTHORITY_MISMATCH');
  }

  const unrelatedMetadata = parseJson(rows.reviewedUnrelatedOpportunity?.metadata, {});
  const unrelatedListingIds = unrelatedMetadata?.identitySnapshot?.listingIds;
  if (rows.reviewedUnrelatedOpportunity?.canonical_name !== reviewedUnrelatedOpportunity.canonicalName
    || rows.reviewedUnrelatedOpportunity?.primary_submission_id
      !== reviewedUnrelatedOpportunity.primarySubmissionId
    || !Array.isArray(unrelatedListingIds)
    || !unrelatedListingIds.includes(reviewedUnrelatedOpportunity.listingId)) {
    blockers.push('REVIEWED_UNRELATED_OPPORTUNITY_RELATIONSHIP_MISMATCH');
  }
  if (selected.reviewedUnrelatedImportCount !== reviewedUnrelatedOpportunity.importCount) {
    blockers.push('REVIEWED_UNRELATED_OPPORTUNITY_IMPORT_COUNT_MISMATCH');
  }
  return blockers;
}

function auditBlockers(audit, expected) {
  const blockers = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = key === 'ok' || key === 'safeToReconcile' ? audit[key] : audit.counts[key];
    if (actual !== expectedValue) blockers.push(`AUDIT_GUARD_MISMATCH:${key}`);
  }
  return blockers;
}

function maskedLogicalDatabaseDigest(database, authority) {
  const mutationByTableAndId = new Map(authority.mutations.map((mutation) => [
    `${mutation.table}\u0000${mutation.id}`,
    mutation,
  ]));
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  const contents = [];
  for (const table of tables) {
    const rows = database.prepare(`SELECT * FROM ${table}`).all().map((row) => {
      const identity = row.id ?? row.opportunity_id;
      const mutation = mutationByTableAndId.get(`${table}\u0000${identity}`);
      if (!mutation) return row;
      return { ...row, [mutation.field]: '__F02_REPAIR3_AUTHORIZED_CELL__' };
    });
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    contents.push({ table, rows });
  }
  return deterministicDealHunterCrmIntegrityF02Repair3Checksum(contents);
}

function actualFingerprints(rows) {
  return Object.fromEntries(Object.entries(rows).map(([label, row]) => [
    label,
    row ? fingerprintDealHunterCrmIntegrityF02Repair3RawRow(row) : '',
  ]));
}

function receiptMatches(receipt, manifest, postStateFingerprints) {
  if (!receipt || receipt.schema !== DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_RECEIPT_SCHEMA) return false;
  const { receiptChecksum, ...receiptBody } = receipt;
  if (!/^[a-f0-9]{64}$/.test(String(receiptChecksum || ''))) return false;
  if (deterministicDealHunterCrmIntegrityF02Repair3Checksum(receiptBody) !== receiptChecksum) return false;
  return receipt.incident === manifest.plan.incident
    && receipt.planChecksum === manifest.planChecksum
    && receipt.executionRelease === manifest.plan.execution.release
    && receipt.toolingRevision === manifest.plan.execution.toolingRevision
    && deterministicDealHunterCrmIntegrityF02Repair3Checksum(receipt.afterFingerprints)
      === deterministicDealHunterCrmIntegrityF02Repair3Checksum(postStateFingerprints);
}

async function analyzeOpenDatabase(database, {
  authority,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  generatedAt,
  receipt,
}) {
  const blockers = [...validateSchema(database), ...targetTriggerBlockers(database)];
  if (blockers.length > 0) return { status: 'refused', blockers };

  const selected = selectAuthorityRows(database, authority);
  if (selected.backlinkImportCount !== 1) blockers.push('BACKLINK_IMPORT_COUNT_MISMATCH');
  const valueState = mutationValueState(selected.rows, authority);
  if (valueState === 'mixed') blockers.push('MIXED_OR_PARTIAL_REPAIR_STATE');
  blockers.push(...authorityFingerprintBlockers(selected.rows, authority, valueState));
  if (valueState !== 'mixed') {
    blockers.push(...relationshipBlockers(database, selected.rows, authority, valueState, selected));
  }

  const audit = projectAudit(await auditDealHunterCrmIntegrity({ storage: createAuditStorage(database) }));
  if (valueState !== 'mixed') {
    blockers.push(...auditBlockers(
      audit,
      valueState === 'before' ? authority.expectedAuditBefore : authority.expectedAuditAfter,
    ));
  }
  const maskedLogicalDigest = maskedLogicalDatabaseDigest(database, authority);
  const approvalManifest = createDealHunterCrmIntegrityF02Repair3ApprovalManifest({
    actor,
    reason,
    executionRelease,
    toolingRevision,
    authority,
    generatedAt,
    preflight: { maskedLogicalDigest },
  });
  if (blockers.length > 0) {
    return { status: 'refused', blockers, audit, approvalManifest, maskedLogicalDigest, rows: selected.rows };
  }
  const postStateFingerprints = actualFingerprints(selected.rows);
  const status = valueState === 'before'
    ? 'repair-required'
    : receiptMatches(receipt, approvalManifest, postStateFingerprints)
      ? 'verified-prior-apply'
      : 'already-satisfied';
  return {
    status,
    blockers: [],
    audit,
    approvalManifest,
    maskedLogicalDigest,
    rows: selected.rows,
    preStateFingerprints: actualFingerprints(selected.rows),
    postStateFingerprints,
  };
}

function refusedResult(blockers, connection = null) {
  return {
    status: 'refused',
    mode: 'dry-run',
    applied: false,
    blockers,
    ...(connection ? { connection } : {}),
  };
}

export async function inspectDealHunterCrmIntegrityF02Repair3({
  databasePath,
  provider = 'sqlite',
  authority = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_AUTHORITY,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  generatedAt = new Date().toISOString(),
  receipt = null,
} = {}) {
  if (provider !== 'sqlite') return refusedResult(['STORAGE_PROVIDER_NOT_SQLITE']);
  const resolvedPath = path.resolve(String(databasePath || ''));
  let database;
  try {
    database = new Database(resolvedPath, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    const queryOnly = Number(database.pragma('query_only', { simple: true })) === 1;
    const connection = { readonly: true, fileMustExist: true, queryOnly };
    if (!queryOnly) return refusedResult(['QUERY_ONLY_NOT_ENABLED'], connection);
    const analysis = await analyzeOpenDatabase(database, {
      authority,
      actor,
      reason,
      executionRelease,
      toolingRevision,
      generatedAt,
      receipt,
    });
    return {
      status: analysis.status,
      mode: 'dry-run',
      applied: false,
      blockers: analysis.blockers,
      connection,
      ...(analysis.audit ? { audit: analysis.audit } : {}),
      ...(analysis.approvalManifest ? {
        approvalManifest: analysis.approvalManifest,
        planChecksum: analysis.approvalManifest.planChecksum,
        fingerprints: {
          before: analysis.preStateFingerprints || authority.rowFingerprints,
          after: analysis.postStateFingerprints || {},
        },
      } : {}),
    };
  } catch (error) {
    if (/must contain|revision|generation time/i.test(error.message)) throw error;
    return refusedResult(['NONINITIALIZING_INSPECTION_FAILED']);
  } finally {
    database?.close();
  }
}

function assertReviewedManifest({
  reviewedManifest,
  expectedPlanChecksum,
  authority,
  actor,
  reason,
  executionRelease,
  toolingRevision,
}) {
  if (!reviewedManifest || reviewedManifest.schema !== DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_APPROVAL_SCHEMA) {
    throw new Error('Apply refused: a reviewed F-02 Repair3 approval manifest is required.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(expectedPlanChecksum || ''))) {
    throw new Error('Apply refused: an exact lowercase plan checksum is required.');
  }
  if (reviewedManifest.planChecksum !== expectedPlanChecksum
    || deterministicDealHunterCrmIntegrityF02Repair3Checksum(reviewedManifest.plan) !== expectedPlanChecksum) {
    throw new Error('Apply refused: reviewed manifest checksum mismatch.');
  }
  const expected = createDealHunterCrmIntegrityF02Repair3ApprovalManifest({
    actor,
    reason,
    executionRelease,
    toolingRevision,
    authority,
    generatedAt: reviewedManifest.generatedAt,
    preflight: reviewedManifest.plan?.preflight,
  });
  if (expected.planChecksum !== expectedPlanChecksum) {
    throw new Error('Apply refused: execution identity or approval inputs do not match the reviewed manifest checksum.');
  }
  return expected;
}

async function verifyBackupEvidence({
  backupPath,
  reviewedManifest,
  authority,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  testHooks,
}) {
  if (!String(backupPath || '').trim()) {
    throw new Error('Apply refused: a verified current-format backup is required.');
  }
  const resolvedBackupPath = path.resolve(backupPath);
  const verification = await verifyBackupBundle(resolvedBackupPath);
  if (verification?.ok !== true
    || verification?.current !== true
    || verification?.legacy !== false
    || verification?.classification !== 'current'
    || verification?.manifest?.version !== 2
    || verification?.manifest?.provider !== 'sqlite') {
    const detail = Array.isArray(verification?.errors) ? verification.errors.slice(0, 2).join('; ') : '';
    throw new Error(`Apply refused: backup verification did not certify current-format SQLite evidence${detail ? `: ${detail}` : ''}.`);
  }
  if (Date.parse(verification.manifest.createdAt) < Date.parse(reviewedManifest.generatedAt)) {
    throw new Error('Apply refused: backup evidence predates the reviewed preflight and is stale.');
  }
  const snapshotPath = path.resolve(resolvedBackupPath, verification.manifest.database.relativePath);
  if (!snapshotPath.startsWith(`${resolvedBackupPath}${path.sep}`)) {
    throw new Error('Apply refused: backup database path escaped the verified bundle.');
  }
  testHooks?.afterBackupVerification?.({ snapshotPath });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(`${snapshotPath}${suffix}`)) {
      throw new Error('Apply refused: verified backup snapshot gained an unmanifested SQLite sidecar.');
    }
  }
  const before = fs.statSync(snapshotPath, { bigint: true });
  const snapshotBytes = fs.readFileSync(snapshotPath);
  const after = fs.statSync(snapshotPath, { bigint: true });
  const stableFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
  if (!before.isFile()
    || stableFields.some((field) => before[field] !== after[field])
    || snapshotBytes.length !== verification.manifest.database.sizeBytes
    || createHash('sha256').update(snapshotBytes).digest('hex') !== verification.manifest.database.sha256) {
    throw new Error('Apply refused: backup snapshot changed after verification or no longer matches its checksum.');
  }
  const database = new Database(snapshotBytes, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    if (database.readonly !== true
      || Number(database.pragma('query_only', { simple: true })) !== 1) {
      throw new Error('Apply refused: backup snapshot could not be restricted to query-only inspection.');
    }
    const foreignKeyRows = database.pragma('foreign_key_check');
    if (foreignKeyRows.length > 0) {
      throw new Error('Apply refused: backup snapshot failed foreign-key verification.');
    }
    const analysis = await analyzeOpenDatabase(database, {
      authority,
      actor,
      reason,
      executionRelease,
      toolingRevision,
      generatedAt: reviewedManifest.generatedAt,
      receipt: null,
    });
    if (analysis.status !== 'repair-required'
      || analysis.approvalManifest?.planChecksum !== reviewedManifest.planChecksum) {
      throw new Error('Apply refused: backup snapshot does not reproduce the reviewed preflight state and digest.');
    }
  } finally {
    database.close();
  }
  return {
    manifestId: verification.manifest.id,
    createdAt: verification.manifest.createdAt,
    databaseSha256: verification.manifest.database.sha256,
  };
}

function createReceipt({ manifest, backup, beforeFingerprints, afterFingerprints, audit, completedAt }) {
  const body = {
    schema: DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_RECEIPT_SCHEMA,
    incident: manifest.plan.incident,
    planChecksum: manifest.planChecksum,
    executionRelease: manifest.plan.execution.release,
    toolingRevision: manifest.plan.execution.toolingRevision,
    backup,
    beforeFingerprints,
    afterFingerprints,
    mutationCount: 3,
    auditCounts: audit.counts,
    completedAt,
  };
  return {
    ...body,
    receiptChecksum: deterministicDealHunterCrmIntegrityF02Repair3Checksum(body),
  };
}

export async function applyDealHunterCrmIntegrityF02Repair3({
  databasePath,
  provider = 'sqlite',
  authority = DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_AUTHORITY,
  actor,
  reason,
  executionRelease,
  toolingRevision,
  reviewedManifest,
  expectedPlanChecksum,
  confirmation,
  backupPath,
  completedAt = new Date().toISOString(),
  receipt = null,
  testHooks = null,
} = {}) {
  if (provider !== 'sqlite') throw new Error('Apply refused: storage provider is not SQLite.');
  if (confirmation !== DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_CONFIRMATION) {
    throw new Error(`Apply refused: confirmation must be ${DEAL_HUNTER_CRM_INTEGRITY_F02_REPAIR3_CONFIRMATION}.`);
  }
  if (!Number.isFinite(Date.parse(completedAt))) throw new Error('Apply refused: completion time is invalid.');
  const manifest = assertReviewedManifest({
    reviewedManifest,
    expectedPlanChecksum,
    authority,
    actor,
    reason,
    executionRelease,
    toolingRevision,
  });
  const backup = await verifyBackupEvidence({
    backupPath,
    reviewedManifest: manifest,
    authority,
    actor,
    reason,
    executionRelease,
    toolingRevision,
    testHooks,
  });

  const database = new Database(path.resolve(String(databasePath || '')), { fileMustExist: true });
  let transactionOpen = false;
  try {
    database.pragma('foreign_keys = ON');
    if (Number(database.pragma('foreign_keys', { simple: true })) !== 1) {
      throw new Error('Apply refused: SQLite foreign-key enforcement could not be enabled before the transaction.');
    }
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const before = await analyzeOpenDatabase(database, {
      authority,
      actor,
      reason,
      executionRelease,
      toolingRevision,
      generatedAt: manifest.generatedAt,
      receipt,
    });
    if (before.approvalManifest?.planChecksum !== manifest.planChecksum) {
      throw new Error('Apply refused: live database no longer reproduces the reviewed preflight digest.');
    }
    if (before.status === 'already-satisfied' || before.status === 'verified-prior-apply') {
      const foreignKeyRows = database.pragma('foreign_key_check');
      if (foreignKeyRows.length > 0) {
        throw new Error('Apply refused: SQLite foreign-key check failed before the zero-write result.');
      }
      database.exec('ROLLBACK');
      transactionOpen = false;
      return {
        status: before.status,
        mode: 'apply',
        applied: false,
        mutationCount: 0,
        planChecksum: manifest.planChecksum,
        audit: before.audit,
      };
    }
    if (before.status !== 'repair-required') {
      throw new Error(`Apply refused: live preflight failed (${before.blockers.join(', ')}).`);
    }
    const digestBefore = before.maskedLogicalDigest;
    for (let index = 0; index < authority.mutations.length; index += 1) {
      const mutationNumber = index + 1;
      const mutation = authority.mutations[index];
      if (testHooks?.forceCasConflictAt === mutationNumber) {
        const identityColumn = mutation.table === 'deal_hunter_opportunities' ? 'opportunity_id' : 'id';
        database.prepare(`UPDATE ${mutation.table} SET ${mutation.field} = ? WHERE ${identityColumn} = ?`)
          .run('__F02_REPAIR3_TEST_CAS_CONFLICT__', mutation.id);
      }
      const identityColumn = mutation.table === 'deal_hunter_opportunities' ? 'opportunity_id' : 'id';
      const update = database.prepare(`
        UPDATE ${mutation.table}
        SET ${mutation.field} = ?
        WHERE ${identityColumn} = ? AND ${mutation.field} IS ?
      `).run(mutation.after, mutation.id, mutation.before);
      if (update.changes !== 1) {
        throw new Error(`Apply refused: compare-and-set mutation ${mutationNumber} did not change exactly one row.`);
      }
      if (testHooks?.failAfterMutation === mutationNumber) {
        throw new Error(`Injected failure after mutation ${mutationNumber}.`);
      }
    }

    const after = await analyzeOpenDatabase(database, {
      authority,
      actor,
      reason,
      executionRelease,
      toolingRevision,
      generatedAt: manifest.generatedAt,
      receipt: null,
    });
    if (after.status !== 'already-satisfied'
      || testHooks?.forcePostconditionAuditFailure === true) {
      throw new Error(`Apply refused: postcondition audit failed (${after.blockers.join(', ')}).`);
    }
    if (after.maskedLogicalDigest !== digestBefore) {
      throw new Error('Apply refused: masked logical preservation digest changed.');
    }
    const foreignKeyRows = testHooks?.forceForeignKeyCheckFailure === true
      ? [{ table: 'injected-test-violation' }]
      : database.pragma('foreign_key_check');
    if (foreignKeyRows.length > 0) {
      throw new Error('Apply refused: SQLite foreign-key check failed before commit.');
    }
    const executionReceipt = createReceipt({
      manifest,
      backup,
      beforeFingerprints: actualFingerprints(before.rows),
      afterFingerprints: after.postStateFingerprints,
      audit: after.audit,
      completedAt,
    });
    database.exec('COMMIT');
    transactionOpen = false;
    return {
      status: 'applied',
      mode: 'apply',
      applied: true,
      mutationCount: 3,
      planChecksum: manifest.planChecksum,
      audit: after.audit,
      preservation: {
        maskedLogicalDigestBefore: digestBefore,
        maskedLogicalDigestAfter: after.maskedLogicalDigest,
      },
      foreignKeyCheck: { ok: true, violations: 0 },
      receipt: executionReceipt,
    };
  } catch (error) {
    if (transactionOpen) {
      database.exec('ROLLBACK');
      transactionOpen = false;
    }
    throw error;
  } finally {
    database.close();
  }
}
