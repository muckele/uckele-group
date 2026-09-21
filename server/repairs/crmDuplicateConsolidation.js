import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY,
  isCanonicalOpportunityMergeRelationshipColumn,
} from './canonicalOpportunityMerge.js';
import { dealHunterListingMarketplaceAliases } from '../services/dealHunterListingIdentity.js';

export const CRM_DUPLICATE_CONSOLIDATION_REPAIR_VERSION =
  'UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2';
export const CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE = 'crm-duplicate-consolidation';
export const CRM_DUPLICATE_CONSOLIDATION_APPROVAL_SCHEMA =
  'crm-duplicate-consolidation-approval-v1';
export const CRM_DUPLICATE_CONSOLIDATION_PLAN_SCHEMA =
  'crm-duplicate-consolidation-plan-v2';
export const CRM_DUPLICATE_CONSOLIDATION_MANIFEST_SCHEMA =
  'crm-duplicate-consolidation-manifest-v2';
export const CRM_DUPLICATE_CONSOLIDATION_CONFIRMATION =
  'APPLY-UG-P7-01D-CRM-DUPLICATE-CONSOLIDATION-V2';
export const CRM_DUPLICATE_CONSOLIDATION_CHECKPOINT_SCHEMA =
  'crm-duplicate-consolidation-checkpoint-v1';
export const CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA =
  'crm-duplicate-consolidation-runtime-config-v1';
export const CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA =
  'crm-duplicate-consolidation-runtime-safety-v1';
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

const crmDuplicateConsolidationConfigFacts = Object.freeze([
  Object.freeze({
    sourceId: 'dealHunter.cimFollowUp.enabled',
    environmentVariable: 'DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED',
    read(config) {
      return config?.dealHunter?.cimFollowUp?.enabled;
    },
  }),
  Object.freeze({
    sourceId: 'dealHunter.cimAutomation.schedulerEnabled',
    environmentVariable: 'DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED',
    read(config) {
      return config?.dealHunter?.cimAutomation?.schedulerEnabled;
    },
  }),
]);

const crmDuplicateConsolidationTrueTokens = new Set(['1', 'true', 'yes', 'on']);
const crmDuplicateConsolidationFalseTokens = new Set(['0', 'false', 'no', 'off']);

export function selectCrmDuplicateConsolidationConfigAuthority({
  config,
  environment = process.env,
} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('CRM duplicate consolidation runtime configuration is incomplete.');
  }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('CRM duplicate consolidation raw environment representation is incomplete.');
  }
  const facts = crmDuplicateConsolidationConfigFacts.map((definition) => {
    const effective = definition.read(config);
    if (typeof effective !== 'boolean') {
      throw new Error(`CRM duplicate consolidation ${definition.sourceId} must be a complete boolean.`);
    }
    const hasRaw = Object.hasOwn(environment, definition.environmentVariable)
      && environment[definition.environmentVariable] !== undefined;
    const raw = hasRaw ? environment[definition.environmentVariable] : undefined;
    if (hasRaw && typeof raw !== 'string') {
      throw new Error(`CRM duplicate consolidation malformed explicit value for ${definition.environmentVariable}.`);
    }
    const token = hasRaw ? raw.trim().toLowerCase() : null;
    let rawState = 'default-absent';
    let lexicalValue = false;
    if (hasRaw && token === '') {
      rawState = 'default-empty';
    } else if (hasRaw && crmDuplicateConsolidationTrueTokens.has(token)) {
      rawState = 'explicit-true';
      lexicalValue = true;
    } else if (hasRaw && crmDuplicateConsolidationFalseTokens.has(token)) {
      rawState = 'explicit-false';
    } else if (hasRaw) {
      throw new Error(`CRM duplicate consolidation malformed explicit value for ${definition.environmentVariable}.`);
    }
    if (lexicalValue !== effective) {
      throw new Error(`CRM duplicate consolidation ${definition.environmentVariable} disagrees with ${definition.sourceId}.`);
    }
    if (effective !== false) {
      throw new Error(`CRM duplicate consolidation ${definition.sourceId} must be false.`);
    }
    return {
      sourceKind: 'effective-config',
      sourceId: definition.sourceId,
      environmentVariable: definition.environmentVariable,
      value: false,
      rawState,
      rawToken: token,
    };
  });
  const authority = {
    schema: CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA,
    facts,
  };
  return deeplyFreeze({
    ...authority,
    digest: canonicalJsonSha256(authority),
  });
}

export function validateCrmDuplicateConsolidationConfigAuthority(authority) {
  exactObjectKeys(authority, ['schema', 'facts', 'digest'], 'CRM duplicate consolidation config authority');
  if (authority.schema !== CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA) {
    throw new Error('CRM duplicate consolidation config authority schema is invalid.');
  }
  if (!Array.isArray(authority.facts)
    || authority.facts.length !== crmDuplicateConsolidationConfigFacts.length) {
    throw new Error('CRM duplicate consolidation config authority facts are incomplete.');
  }
  const facts = authority.facts.map((fact, index) => {
    exactObjectKeys(
      fact,
      ['sourceKind', 'sourceId', 'environmentVariable', 'value', 'rawState', 'rawToken'],
      `CRM duplicate consolidation config authority fact ${index}`,
    );
    const definition = crmDuplicateConsolidationConfigFacts[index];
    if (fact.sourceKind !== 'effective-config'
      || fact.sourceId !== definition.sourceId
      || fact.environmentVariable !== definition.environmentVariable
      || fact.value !== false
      || !['default-absent', 'default-empty', 'explicit-false'].includes(fact.rawState)
      || (fact.rawState === 'default-absent' && fact.rawToken !== null)
      || (fact.rawState === 'default-empty' && fact.rawToken !== '')
      || (fact.rawState === 'explicit-false'
        && !crmDuplicateConsolidationFalseTokens.has(fact.rawToken))) {
      throw new Error(`CRM duplicate consolidation config authority fact ${definition.sourceId} is invalid.`);
    }
    return { ...fact };
  });
  const normalized = {
    schema: CRM_DUPLICATE_CONSOLIDATION_CONFIG_AUTHORITY_SCHEMA,
    facts,
  };
  const digest = canonicalJsonSha256(normalized);
  if (authority.digest !== digest) {
    throw new Error('CRM duplicate consolidation config authority digest is invalid.');
  }
  return deeplyFreeze({ ...normalized, digest });
}

const crmDuplicateConsolidationDurableSafetyFacts = Object.freeze([
  Object.freeze({
    sourceId: 'deal_hunter_cim_safety_settings/global/outreach_paused',
    rowId: 'global',
    valueColumn: 'outreach_paused',
  }),
  Object.freeze({
    sourceId: 'deal_hunter_automation_settings/cim-initial-outreach/paused',
    rowId: 'cim-initial-outreach',
    valueColumn: 'paused',
  }),
]);

export function buildCrmDuplicateConsolidationRuntimeSafetyAuthority({
  configAuthority,
  cimSafetyRow,
  automationRow,
} = {}) {
  const config = validateCrmDuplicateConsolidationConfigAuthority(configAuthority);
  const rows = [cimSafetyRow, automationRow];
  const durable = crmDuplicateConsolidationDurableSafetyFacts.map((definition, index) => {
    const row = rows[index];
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== definition.rowId) {
      throw new Error(`CRM duplicate consolidation requires durable row ${definition.sourceId}.`);
    }
    const rawValue = row[definition.valueColumn];
    if (rawValue !== true && rawValue !== 1) {
      throw new Error(`CRM duplicate consolidation ${definition.sourceId} must be true.`);
    }
    return {
      sourceKind: 'sqlite-row',
      sourceId: definition.sourceId,
      value: true,
      rawRowDigest: canonicalJsonSha256(row),
    };
  });
  const authority = {
    schema: CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA,
    config,
    durable,
  };
  return deeplyFreeze({
    ...authority,
    digest: canonicalJsonSha256(authority),
  });
}

export function validateCrmDuplicateConsolidationRuntimeSafetyAuthority(authority) {
  exactObjectKeys(
    authority,
    ['schema', 'config', 'durable', 'digest'],
    'CRM duplicate consolidation runtime safety authority',
  );
  if (authority.schema !== CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA) {
    throw new Error('CRM duplicate consolidation runtime safety authority schema is invalid.');
  }
  const config = validateCrmDuplicateConsolidationConfigAuthority(authority.config);
  if (!Array.isArray(authority.durable)
    || authority.durable.length !== crmDuplicateConsolidationDurableSafetyFacts.length) {
    throw new Error('CRM duplicate consolidation runtime safety durable facts are incomplete.');
  }
  const durable = authority.durable.map((fact, index) => {
    exactObjectKeys(
      fact,
      ['sourceKind', 'sourceId', 'value', 'rawRowDigest'],
      `CRM duplicate consolidation runtime safety durable fact ${index}`,
    );
    const definition = crmDuplicateConsolidationDurableSafetyFacts[index];
    if (fact.sourceKind !== 'sqlite-row'
      || fact.sourceId !== definition.sourceId
      || fact.value !== true
      || !/^[a-f0-9]{64}$/.test(String(fact.rawRowDigest || ''))) {
      throw new Error(`CRM duplicate consolidation runtime safety fact ${definition.sourceId} is invalid.`);
    }
    return { ...fact };
  });
  const normalized = {
    schema: CRM_DUPLICATE_CONSOLIDATION_RUNTIME_SAFETY_SCHEMA,
    config,
    durable,
  };
  const digest = canonicalJsonSha256(normalized);
  if (authority.digest !== digest) {
    throw new Error('CRM duplicate consolidation runtime safety authority digest is invalid.');
  }
  return deeplyFreeze({ ...normalized, digest });
}

export function assertCrmDuplicateConsolidationConfigAuthorityMatches(current, reviewed) {
  const checkedCurrent = validateCrmDuplicateConsolidationConfigAuthority(current);
  const checkedReviewed = validateCrmDuplicateConsolidationConfigAuthority(reviewed);
  if (stableCanonicalJson(checkedCurrent) !== stableCanonicalJson(checkedReviewed)) {
    throw new Error('CRM duplicate consolidation current configuration authority differs from reviewed configuration authority.');
  }
  return checkedCurrent;
}

export function assertCrmDuplicateConsolidationRuntimeSafetyAuthorityMatches(current, reviewed) {
  const checkedCurrent = validateCrmDuplicateConsolidationRuntimeSafetyAuthority(current);
  const checkedReviewed = validateCrmDuplicateConsolidationRuntimeSafetyAuthority(reviewed);
  if (stableCanonicalJson(checkedCurrent) !== stableCanonicalJson(checkedReviewed)) {
    throw new Error('CRM duplicate consolidation current four-source authority differs from reviewed four-source authority.');
  }
  return checkedCurrent;
}

export function crmDuplicateConsolidationRawStringMatchesSha256(value, expectedDigest) {
  return typeof value === 'string'
    && value.length > 0
    && /^[a-f0-9]{64}$/.test(String(expectedDigest || ''))
    && createHash('sha256').update(value, 'utf8').digest('hex') === expectedDigest;
}

function crmDuplicateConsolidationMarketplaceIdentity(value, label, blockers) {
  if (typeof value !== 'string' || !value.trim()) {
    blockers.push(`${label} must be a nonempty string.`);
    return [];
  }
  const candidate = value.trim();
  if (/^costar:\d+$/.test(candidate)) return [candidate];
  const identities = dealHunterListingMarketplaceAliases(candidate);
  if (identities.length === 0) blockers.push(`unsupported or malformed ${label} marketplace evidence.`);
  return identities;
}

export function inspectCrmDuplicateConsolidationMarketplaceIdentity({
  listingUrl,
  listingAliases,
  identityAliases,
  expectedIdentity,
  allowAllAbsent = false,
} = {}) {
  const blockers = [];
  const identities = [];
  const hasListingUrl = listingUrl !== undefined && listingUrl !== null && listingUrl !== '';
  if (hasListingUrl) {
    identities.push(...crmDuplicateConsolidationMarketplaceIdentity(
      listingUrl,
      'primary listing URL',
      blockers,
    ));
  } else if (listingUrl !== undefined && listingUrl !== null && listingUrl !== '') {
    blockers.push('primary listing URL is malformed.');
  }
  for (const [name, values] of [
    ['listingAliases', listingAliases],
    ['identityAliases', identityAliases],
  ]) {
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      blockers.push(`${name} must be an array when present.`);
      continue;
    }
    for (const value of values) {
      identities.push(...crmDuplicateConsolidationMarketplaceIdentity(
        value,
        `${name} entry`,
        blockers,
      ));
    }
  }
  const unique = [...new Set(identities)].sort();
  if (unique.length === 0) {
    if (!allowAllAbsent || hasListingUrl
      || (Array.isArray(listingAliases) && listingAliases.length > 0)
      || (Array.isArray(identityAliases) && identityAliases.length > 0)) {
      blockers.push('approved marketplace identity evidence is missing.');
    }
  } else if (unique.length > 1) {
    blockers.push('conflicting marketplace identities were supplied.');
  } else if (unique[0] !== expectedIdentity) {
    blockers.push('unexpected marketplace identity was supplied.');
  }
  return {
    identities: unique,
    valid: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
  };
}

function parsedCrmDuplicateConsolidationMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function crmDuplicateConsolidationFinancialEvidenceMatches(row, pair) {
  const metadata = parsedCrmDuplicateConsolidationMetadata(row?.metadata);
  const raw = metadata?.dealHunter?.raw;
  const annualProfit = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw[pair?.financialLabel]
    : undefined;
  const valuesMatch = row?.asking_price === pair?.askingPrice
    && row?.ttm_revenue === pair?.revenue
    && row?.ttm_ebitda === pair?.financialValue;
  if (typeof annualProfit !== 'string' || annualProfit !== pair?.financialValue) {
    return { valid: false, blocker: 'financial-label-or-source-value-drift' };
  }
  return valuesMatch
    ? { valid: true, blocker: null }
    : { valid: false, blocker: 'financial-projection-value-drift' };
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
  supersededDealKeySha256: '3d9a1bfb64efd766a7bc3dd8c584a7fc0aab58a74cbcbd377893ed42bd65f733',
  supersededSource: {
    sourceId: 'sheet-0',
    sourceMode: 'csv',
    externalId: '18',
  },
};

const berlinImport = {
  id: '508bcba0790b928551ab62282d5dcf894ba825886919daa6f54b7cd9b8ae0ea8',
  beforeSubmissionId: berlin.supersededSubmissionId,
  afterSubmissionId: berlin.survivorSubmissionId,
  opportunityId: null,
  dealKeySha256: berlin.supersededDealKeySha256,
  sourceId: 'sheet-0',
  sourceMode: 'csv',
};

const berlinCanonicalImport = {
  id: '4e2075ca935de95f09a80bdcdc51ac513c9ab5864f384d20f7ad123f139357ad',
  submissionId: berlin.survivorSubmissionId,
  opportunityId: berlin.opportunityId,
  listingIdentity: berlin.listingIdentity,
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
  berlinCanonicalImport,
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
    berlinCanonicalImport: CRM_DUPLICATE_CONSOLIDATION_DESCRIPTOR.berlinCanonicalImport,
  };
}

export function crmDuplicateConsolidationManifestId() {
  return `${CRM_DUPLICATE_CONSOLIDATION_REPAIR_TYPE}:v2:${canonicalJsonSha256(crmDuplicateConsolidationApprovalTuple())}`;
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
  const runtimeSafetyAuthority = validateCrmDuplicateConsolidationRuntimeSafetyAuthority(
    inspection.runtimeSafetyAuthority,
  );
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
    runtimeSafetyAuthority,
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
  validateCrmDuplicateConsolidationRuntimeSafetyAuthority(
    artifact.plan?.runtimeSafetyAuthority,
  );
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
