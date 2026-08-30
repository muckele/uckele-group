import { createHash } from 'node:crypto';

export const CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE = 'canonical-opportunity-merge';
export const CANONICAL_OPPORTUNITY_MERGE_APPROVAL_SCHEMA = 'canonical-opportunity-merge-approval-v1';
export const CANONICAL_OPPORTUNITY_MERGE_PLAN_SCHEMA = 'canonical-opportunity-merge-plan-v2';
export const CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA = 'canonical-opportunity-merge-manifest-v1';
export const CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY_SCHEMA =
  'canonical-opportunity-merge-relationship-inventory-v1';

const exceptionId = '8672a029686c9c6f7a6cdcc42972816127e34a991ae23fd123c262dc9180a571';
const survivorId = 'opp_cd57a315-feaf-4158-a02e-4bdde97a922e';
const supersededId = 'opp_c92d0c73-6a47-4fed-b528-6f310745e448';

export const CANONICAL_OPPORTUNITY_MERGE_CONFIRMATION =
  `MERGE ${supersededId} INTO ${survivorId} FOR EXCEPTION ${exceptionId}`;

function deeplyFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deeplyFreeze(nested);
  return Object.freeze(value);
}

export const CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES = deeplyFreeze({
  BLOCKING_ENTITY_DEPENDENCY: 'BLOCKING_ENTITY_DEPENDENCY',
  REDUNDANT_THROUGH_SCANNED_PARENT: 'REDUNDANT_THROUGH_SCANNED_PARENT',
  PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE: 'PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE',
  EXPLICITLY_IRRELEVANT_EXCLUDED: 'EXPLICITLY_IRRELEVANT_EXCLUDED',
});

export const CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS = deeplyFreeze({
  MATERIAL_SCANNER_PATH: 'material-scanner-path',
  INDEPENDENT_GATE: 'independent-gate',
  APPROVAL_PRECONDITION: 'approval-precondition',
  EXPLICIT_EXCLUSION: 'explicit-exclusion',
});

export const CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE = deeplyFreeze({
  REQUIRED: 'required',
  OPTIONAL_LEGACY: 'optional-legacy',
});

export const CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INDEPENDENT_GATES = deeplyFreeze({
  AUTOMATION_INERT_POLICY_STATE_VERIFICATION: {
    id: 'automation-inert-policy-state-verification',
    safetyModel: 'authorityGrantingOperationalState.stage2Activations',
  },
  PERSISTED_GLOBAL_CIM_OUTREACH_PAUSE: {
    id: 'persisted-global-cim-outreach-pause',
    safetyModel: 'apply-preflight-backup-and-transaction-pause-epoch',
  },
});

const relationshipCandidateNames = new Set([
  'email',
  'in_reply_to',
  'to_addresses',
  'cc_addresses',
  'bcc_addresses',
  'reply_to_address',
  'from_address',
  'metadata',
  'manifest',
  'plan',
  'results',
  'records',
  'row_accounting',
  'files',
  'snapshot',
  'attachment_metadata',
]);

export function isCanonicalOpportunityMergeRelationshipColumn(column = '') {
  const normalized = String(column).trim().toLowerCase();
  if (!normalized || normalized === 'id') return false;
  return relationshipCandidateNames.has(normalized)
    || /(?:_id|_ids|_key|_url|_email|_emails|_reference|_references|_json)$/.test(normalized);
}

function relationshipEntries({
  table,
  columns,
  category,
  scannerPath,
  reason,
  authorityEffect = 'none',
  enforcement = (() => {
    if (/^(?:dependentState|preservedOperationalState|authorityGrantingOperationalState)\./.test(scannerPath)) {
      return CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.MATERIAL_SCANNER_PATH;
    }
    if (/^approvalCore\./.test(scannerPath)) {
      return CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.APPROVAL_PRECONDITION;
    }
    if (/^excluded\./.test(scannerPath)) {
      return CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.EXPLICIT_EXCLUSION;
    }
    return '';
  })(),
  gateId = null,
  schemaPresence = CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.REQUIRED,
}) {
  return columns.map((column) => ({
    table,
    column,
    category,
    scannerPath,
    reason,
    authorityEffect,
    enforcement,
    gateId,
    schemaPresence,
  }));
}

const blockingRelationshipReason =
  'Direct canonical, alias, submission, communication, or serialized-evidence relationship; the named blocking scanner must return zero rows.';
const redundantRelationshipReason =
  'Subordinate relationship data on a parent row already selected in full by the named blocking scanner; a second query would not broaden coverage.';
const excludedRelationshipReason =
  'This field does not establish canonical opportunity identity for the approved incident and is intentionally excluded from entity-dependent matching.';
const coreRelationshipReason =
  'Core repair subject or audit namespace validated by an exact approval, alias, tuple, or manifest precondition instead of dependent-state counting.';
const preservedRelationshipReason =
  'Global or recipient operational state is preserved in place, inspected separately from entity dependents, and never reparented by the merge.';
const automationSettingsIndependentGateReason =
  'Global automation settings are preserved out of band and never reparented; merge safety is enforced by the named automation-inert policy/state gate.';
const cimSafetySettingsIndependentGateReason =
  'Global CIM safety settings are preserved out of band and never reparented; apply safety is enforced by the persisted outreach-pause gate and pause-epoch revalidation.';
const legacyAdminAuthenticationExclusionReason =
  'The preserved legacy magic-link email is authentication audit identity only; it cannot establish acquisition identity and no merge mutation reads or rewrites it.';
const legacyCandidateSourceUrlBlockingReason =
  'A legacy Deal Hunter candidate source URL was durable acquisition identity; the candidate scanner compares its canonical listing identity with the approved listing evidence and requires zero matching rows.';
const legacyCandidateRunRedundancyReason =
  'The legacy candidate run ID identifies only the acquisition run that owns a candidate; whenever that candidate can matter, its row is already selected by the normalized source-URL scanner.';
const linkedProspectSubmissionBlockingReason =
  'A retired prospect discovery can join current CRM state only through submission_id; the linked CRM state scanner selects that discovery whenever its submission is related to the approved canonical pair.';
const linkedProspectParentRedundancyReason =
  'Retired prospect discovery run, provider-source, and website identity cannot independently establish Deal Hunter canonical authority; any CRM-relevant row is already selected through its submission_id by the linked CRM state scanner.';

const relationshipInventoryEntries = [
  ...relationshipEntries({
    table: 'admin_audit_events',
    columns: ['request_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.adminAudit',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'admin_magic_links',
    columns: ['email', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.adminAuthentication',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'admin_magic_links_legacy_v1',
    columns: ['email'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.adminAuthentication',
    reason: legacyAdminAuthenticationExclusionReason,
    schemaPresence: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.OPTIONAL_LEGACY,
  }),
  ...relationshipEntries({
    table: 'admin_onboarding_progress',
    columns: ['principal_id', 'tour_key', 'last_completed_step_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.adminOnboarding',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'admin_sessions',
    columns: ['principal_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.adminAuthentication',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'contact_submissions',
    columns: ['listing_url', 'deal_hunter_opportunity_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.contactSubmissions',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'contact_submissions',
    columns: ['archive_communication_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.contactSubmissions',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'contact_submissions',
    columns: ['email', 'business_website', 'prospectus_url', 'broker_email', 'seller_email'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.contactRecipientAndDocumentIdentity',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_activity_events',
    columns: ['submission_id', 'metadata', 'opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.activityEvents',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_communications',
    columns: ['submission_id', 'deal_key', 'cim_request_id', 'metadata', 'opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.communications',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_communications',
    columns: [
      'provider_message_id', 'source_event_id', 'idempotency_key', 'message_id',
      'in_reply_to', 'references_json', 'parent_communication_id', 'thread_key',
      'recommendation_id', 'outbox_id', 'headers_json', 'reply_to_address',
      'from_address', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'attachment_metadata',
    ],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.communications',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_email_outbox',
    columns: ['communication_id', 'submission_id', 'cim_request_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.followUpState',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_email_outbox',
    columns: ['idempotency_key', 'client_request_key', 'provider_message_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.followUpState',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_follow_up_recommendations',
    columns: ['submission_id', 'cim_request_id', 'triggering_communication_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.followUpState',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'crm_follow_up_recommendations',
    columns: [
      'model_id', 'thread_parent_communication_id', 'evidence_json', 'signals_json',
      'commitments_json', 'questions_json', 'blockers_json', 'safety_flags_json',
    ],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.followUpState',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_automation_settings',
    columns: ['id', 'updated_at', 'paused', 'updated_by', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE,
    scannerPath: null,
    reason: automationSettingsIndependentGateReason,
    authorityEffect: 'mixed-existing-gate',
    enforcement: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.INDEPENDENT_GATE,
    gateId: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INDEPENDENT_GATES
      .AUTOMATION_INERT_POLICY_STATE_VERIFICATION.id,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_candidates',
    columns: ['source_url'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.legacyDealHunterCandidates',
    reason: legacyCandidateSourceUrlBlockingReason,
    schemaPresence: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.OPTIONAL_LEGACY,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_candidates',
    columns: ['run_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.legacyDealHunterCandidates',
    reason: legacyCandidateRunRedundancyReason,
    schemaPresence: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.OPTIONAL_LEGACY,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_opportunity_claims',
    columns: ['opportunity_id', 'request_id', 'recipient_email', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.opportunityClaims',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_recipient_claims',
    columns: ['recipient_email', 'request_id', 'opportunity_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.recipientClaims',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_recipient_overrides',
    columns: ['opportunity_id', 'recipient_email', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.recipientOverrides',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_repair_manifests',
    columns: ['backup_reference', 'manifest', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'approvalCore.manifestNamespace',
    reason: coreRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_requests',
    columns: ['deal_key', 'listing_url', 'submission_id', 'metadata', 'opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.cimRequests',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_requests',
    columns: ['recipient_email', 'provider_message_id', 'reply_to_address', 'retry_of_request_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.cimRequests',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_reviews',
    columns: ['deal_key', 'metadata', 'opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.cimReviews',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_reviews',
    columns: ['original_recipient_email', 'final_recipient_email', 'source_ids'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.cimReviews',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_safety_settings',
    columns: ['id', 'updated_at', 'outreach_paused', 'updated_by', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE,
    scannerPath: null,
    reason: cimSafetySettingsIndependentGateReason,
    authorityEffect: 'mixed-existing-gate',
    enforcement: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.INDEPENDENT_GATE,
    gateId: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INDEPENDENT_GATES
      .PERSISTED_GLOBAL_CIM_OUTREACH_PAUSE.id,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_stage2_activations',
    columns: [
      'id', 'created_at', 'updated_at', 'status', 'mode', 'actor', 'reason',
      'confirmation_phrase', 'policy_hash', 'rule_version', 'source_policy_version',
      'source_policy_hash', 'evidence_checksum', 'evidence_generated_at',
      'backup_reference', 'backup_checksum', 'identity_audit_reference',
      'identity_audit_checksum', 'compliance_reference', 'sender_auth_reference',
      'timezone', 'window_start', 'window_end', 'weekdays_only', 'canary_daily_cap',
      'active_daily_cap', 'recipient_cap_24_hours', 'recipient_cap_30_days',
      'expires_at', 'superseded_at', 'superseded_by', 'metadata',
    ],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE,
    scannerPath: 'authorityGrantingOperationalState.stage2Activations',
    reason: preservedRelationshipReason,
    authorityEffect: 'granting-when-current',
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_stage2_decisions',
    columns: ['opportunity_id', 'deal_key', 'cim_request_id', 'communication_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.stage2Decisions',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_stage2_decisions',
    columns: ['run_id', 'activation_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.stage2Decisions',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_stage2_runs',
    columns: ['metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.stage2Runs',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_stage2_runs',
    columns: ['activation_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.stage2Runs',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_cim_stage2_runs',
    columns: ['run_key'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.stage2RunIdentity',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_crm_imports',
    columns: ['deal_key', 'listing_identity', 'listing_url', 'submission_id', 'metadata', 'opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.crmImports',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_crm_reconciliation_items',
    columns: ['run_id', 'opportunity_id', 'deal_key', 'submission_id', 'planned_changes', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.crmReconciliationItems',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_crm_reconciliation_runs',
    columns: ['plan', 'results', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.crmReconciliationRuns',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_crm_reconciliation_runs',
    columns: ['import_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.crmReconciliationRuns',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_crm_reconciliation_runs',
    columns: ['idempotency_key'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.reconciliationCommandIdentity',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_deal_os_imports',
    columns: ['row_accounting', 'records', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.sourceImportPayloads',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_dispositions',
    columns: ['deal_key', 'submission_id', 'communication_id', 'listing_url', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.dispositions',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_identity_exceptions',
    columns: ['observed_deal_key', 'candidate_opportunity_ids', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.otherIdentityExceptions',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_opportunities',
    columns: ['opportunity_id', 'primary_submission_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'approvalCore.opportunities',
    reason: coreRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_opportunity_aliases',
    columns: ['opportunity_id', 'alias_type', 'alias_value', 'alias_key', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'approvalCore.aliases',
    reason: coreRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_opportunity_facts',
    columns: ['opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.operatorFacts',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_opportunity_source_observations',
    columns: ['opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.sourceObservations',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_opportunity_source_observations',
    columns: ['source_id', 'source_record_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.sourceObservations',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_opportunity_scores',
    columns: ['opportunity_id', 'deal_key', 'listing_url'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.opportunityScores',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_score_evidence',
    columns: ['opportunity_id', 'listing_url'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.scoreEvidence',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_score_evidence',
    columns: ['rule_id', 'source_id', 'source_record_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.scoreEvidence',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_seen_deals',
    columns: ['id', 'external_id', 'listing_url', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.historicalIdentityEvidence',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'deal_hunter_seen_deals',
    columns: ['source_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.sourceDatasetIdentity',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'email_events',
    columns: ['submission_id', 'communication_id', 'metadata', 'opportunity_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.emailEvents',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'email_events',
    columns: ['message_id', 'provider_event_id', 'event_key', 'recipient_email'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.providerAndRecipientEventIdentity',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'email_suppressions',
    columns: [
      'id', 'normalized_email', 'reason', 'source', 'source_event_id',
      'source_communication_id', 'created_at', 'created_by', 'lifted_at',
      'lifted_by', 'lift_reason', 'metadata',
    ],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.PRESERVED_GLOBAL_RECIPIENT_OPERATIONAL_STATE,
    scannerPath: 'preservedOperationalState.emailSuppressions',
    reason: preservedRelationshipReason,
    authorityEffect: 'restrictive',
  }),
  ...relationshipEntries({
    table: 'prospect_discoveries',
    columns: ['submission_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: linkedProspectSubmissionBlockingReason,
    schemaPresence: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.OPTIONAL_LEGACY,
  }),
  ...relationshipEntries({
    table: 'prospect_discoveries',
    columns: ['run_id', 'source_id', 'website_url'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: linkedProspectParentRedundancyReason,
    schemaPresence: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE.OPTIONAL_LEGACY,
  }),
  ...relationshipEntries({
    table: 'scheduled_job_runs',
    columns: ['metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.scheduledJobs',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'scheduled_job_runs',
    columns: ['provider_message_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.scheduledJobs',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'scheduled_job_runs',
    columns: ['job_key'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.scheduledJobIdentity',
    reason: excludedRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'secure_document_cleanup_jobs',
    columns: ['submission_id', 'metadata'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'secure_document_cleanup_jobs',
    columns: ['files'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'secure_documents',
    columns: ['request_id', 'submission_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'secure_documents',
    columns: ['uploaded_by_email'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'secure_upload_requests',
    columns: ['submission_id'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.BLOCKING_ENTITY_DEPENDENCY,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: blockingRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'secure_upload_requests',
    columns: ['email'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.REDUNDANT_THROUGH_SCANNED_PARENT,
    scannerPath: 'dependentState.records.linkedCrmState',
    reason: redundantRelationshipReason,
  }),
  ...relationshipEntries({
    table: 'source_health_snapshots',
    columns: ['snapshot'],
    category: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES.EXPLICITLY_IRRELEVANT_EXCLUDED,
    scannerPath: 'excluded.sourceHealth',
    reason: excludedRelationshipReason,
  }),
].sort((left, right) => (
  left.table.localeCompare(right.table) || left.column.localeCompare(right.column)
));

const relationshipInventoryKeys = relationshipInventoryEntries.map((entry) => `${entry.table}.${entry.column}`);
if (new Set(relationshipInventoryKeys).size !== relationshipInventoryKeys.length) {
  throw new Error('Canonical opportunity merge relationship inventory contains duplicate classifications.');
}

export const CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY = deeplyFreeze({
  schema: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY_SCHEMA,
  entries: relationshipInventoryEntries,
});

export function canonicalOpportunityMergeRelationshipSchemaPresenceByTable(
  entries = CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries,
) {
  if (!Array.isArray(entries)) {
    throw new Error('Canonical opportunity merge relationship inventory entries must be an array.');
  }
  const allowed = new Set(Object.values(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_SCHEMA_PRESENCE));
  const presenceByTable = new Map();
  for (const entry of entries) {
    const label = `${entry?.table || 'unknown'}.${entry?.column || 'unknown'}`;
    if (!allowed.has(entry?.schemaPresence)) {
      throw new Error(`Canonical opportunity merge relationship inventory schema presence is missing or invalid for ${label}.`);
    }
    const existing = presenceByTable.get(entry.table);
    if (existing && existing !== entry.schemaPresence) {
      throw new Error(`Canonical opportunity merge relationship inventory has conflicting schema presence for ${entry.table}.`);
    }
    presenceByTable.set(entry.table, entry.schemaPresence);
  }
  return presenceByTable;
}

function objectPathExists(value, objectPath) {
  let current = value;
  for (const part of String(objectPath || '').split('.').filter(Boolean)) {
    if (
      current === null
      || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return false;
    }
    current = current[part];
  }
  return Boolean(objectPath) && current !== undefined;
}

export function validateCanonicalOpportunityMergeRelationshipInventory({
  entries = CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries,
  inspection = {},
} = {}) {
  if (!Array.isArray(entries)) {
    throw new Error('Canonical opportunity merge relationship inventory entries must be an array.');
  }
  canonicalOpportunityMergeRelationshipSchemaPresenceByTable(entries);
  const knownIndependentGateIds = new Set(
    Object.values(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INDEPENDENT_GATES)
      .map((gate) => gate.id),
  );
  for (const entry of entries) {
    const label = `${entry?.table || 'unknown'}.${entry?.column || 'unknown'}`;
    if (entry?.enforcement === CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.MATERIAL_SCANNER_PATH) {
      if (!entry.scannerPath || !objectPathExists(inspection, entry.scannerPath)) {
        throw new Error(
          `Canonical opportunity merge relationship inventory material scanner path does not resolve for ${label}: ${entry.scannerPath || '(missing)'}.`,
        );
      }
      if (entry.gateId !== null) {
        throw new Error(`Canonical opportunity merge material scanner ${label} must not name an independent gate.`);
      }
      continue;
    }
    if (entry?.enforcement === CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.INDEPENDENT_GATE) {
      if (entry.scannerPath !== null) {
        throw new Error(`Canonical opportunity merge independent gate ${label} must not claim a material scanner path.`);
      }
      if (!knownIndependentGateIds.has(entry.gateId)) {
        throw new Error(`Canonical opportunity merge relationship inventory has an unknown independent gate for ${label}.`);
      }
      continue;
    }
    if (entry?.enforcement === CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.APPROVAL_PRECONDITION) {
      if (!/^approvalCore\.[A-Za-z0-9.]+$/.test(String(entry.scannerPath || '')) || entry.gateId !== null) {
        throw new Error(`Canonical opportunity merge approval precondition classification is invalid for ${label}.`);
      }
      continue;
    }
    if (entry?.enforcement === CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_ENFORCEMENTS.EXPLICIT_EXCLUSION) {
      if (!/^excluded\.[A-Za-z0-9.]+$/.test(String(entry.scannerPath || '')) || entry.gateId !== null) {
        throw new Error(`Canonical opportunity merge explicit exclusion classification is invalid for ${label}.`);
      }
      continue;
    }
    throw new Error(`Canonical opportunity merge relationship inventory enforcement class is missing or invalid for ${label}.`);
  }
  return true;
}

function alias(aliasType, aliasValue, opportunityId) {
  return {
    aliasType,
    aliasValue,
    aliasKey: `${aliasType}:${aliasValue}`,
    opportunityId,
  };
}

const hvacApproval = deeplyFreeze({
  repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
  approvalSchema: CANONICAL_OPPORTUNITY_MERGE_APPROVAL_SCHEMA,
  exceptionId,
  survivorId,
  supersededId,
  expectedOpportunityStatus: 'active',
  expectedExceptionStatus: 'open',
  expectedExceptionReason: 'conflicting-canonical-aliases',
  expectedEvidenceVersion: 'cim-opportunity-v1',
  approvedFacts: {
    canonicalName: 'High Earning HVAC, Plumbing, & Sheet Metal Business and Real Estate!',
    canonicalLocation: 'Las Vegas, Clark, NV, US',
    identityName: 'high earning hvac plumbing and sheet metal business and real estate',
    identityDescriptionLength: 498,
    city: 'las vegas',
    county: 'clark',
    state: 'nv',
    country: 'us',
    askingPrice: 5_000_000,
    revenue: 4_500_000,
    profit: 500_000,
    recipientPresent: true,
    listingIds: ['costar:2542991', 'dealstream:/d/biz-sale/hvac/acarj0'],
    listingUrl: 'https://bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991',
  },
  expectedAliases: [
    alias('deal-key', 'url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx', supersededId),
    alias('listing-url', 'https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx', supersededId),
    alias('source-identity', 'url:us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx', supersededId),
    alias('deal-key', 'url:https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/', survivorId),
    alias('deal-key', 'url:https://www.dealstream.com/d/biz-sale/hvac/acarj0', survivorId),
    alias('fingerprint-v1', '0985c4d3eff0153a0793694edbd20f73682a223d2c37830abbc7dfde77256657', survivorId),
    alias('fingerprint-v1', '388ed3db60b28f9fb0d12b547549e9513846f06c894356f6c72bff7a50ebdd43', survivorId),
    alias('listing-id', 'costar:2542991', survivorId),
    alias('listing-id', 'dealstream:/d/biz-sale/hvac/acarj0', survivorId),
    alias('listing-url', 'https://bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991', survivorId),
    alias('source-identity', 'url:bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991', survivorId),
    alias('source-identity', 'url:dealstream.com/d/biz-sale/hvac/acarj0', survivorId),
  ],
  sourceObservations: [
    {
      sourceRecordId: '21',
      listingUrl: 'https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/',
      durableAliasKeys: [
        'deal-key:url:https://www.bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991/',
        'listing-url:https://bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991',
        'listing-id:costar:2542991',
        'source-identity:url:bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991',
      ],
      identityAliases: [
        'url:bizbuysell.com/business-opportunity/high-earning-hvac-plumbing-and-sheet-metal-business-and-real-estate/2542991',
        'costar:2542991',
      ],
    },
    {
      sourceRecordId: '20',
      listingUrl: 'https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
      durableAliasKeys: [
        'deal-key:url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
        'listing-url:https://us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
        'source-identity:url:us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx',
      ],
      identityAliases: ['url:us.businessesforsale.com/us/hvac-plumbing-sheet-metal-business-and-real-estate.aspx'],
    },
    {
      sourceRecordId: '22',
      listingUrl: 'https://www.dealstream.com/d/biz-sale/hvac/acarj0',
      durableAliasKeys: [
        'deal-key:url:https://www.dealstream.com/d/biz-sale/hvac/acarj0',
        'listing-id:dealstream:/d/biz-sale/hvac/acarj0',
        'source-identity:url:dealstream.com/d/biz-sale/hvac/acarj0',
      ],
      identityAliases: ['url:dealstream.com/d/biz-sale/hvac/acarj0', 'dealstream:/d/biz-sale/hvac/acarj0'],
    },
  ],
});

const approvals = [hvacApproval];

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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

export function canonicalOpportunityMergeRelationshipInventorySummary() {
  const classificationCounts = Object.fromEntries(
    Object.values(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_CATEGORIES)
      .sort()
      .map((category) => [
        category,
        CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries
          .filter((entry) => entry.category === category).length,
      ]),
  );
  return {
    schema: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY_SCHEMA,
    entryCount: CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY.entries.length,
    classificationCounts,
    checksum: sha256(stableCanonicalJson(CANONICAL_OPPORTUNITY_MERGE_RELATIONSHIP_INVENTORY)),
  };
}

function normalizedText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sortedStrings(values = []) {
  return [...new Set(values.map((value) => String(value)))].sort();
}

function sortedAliases(aliases = []) {
  return [...aliases].sort((left, right) => (
    String(left.alias_type || left.aliasType).localeCompare(String(right.alias_type || right.aliasType))
    || String(left.alias_value || left.aliasValue).localeCompare(String(right.alias_value || right.aliasValue))
    || String(left.opportunity_id || left.opportunityId).localeCompare(String(right.opportunity_id || right.opportunityId))
    || String(left.alias_key || left.aliasKey).localeCompare(String(right.alias_key || right.aliasKey))
  ));
}

function sameStringSet(actual, expected) {
  return stableCanonicalJson(sortedStrings(actual)) === stableCanonicalJson(sortedStrings(expected));
}

function validateOpportunity(opportunity, opportunityId, approval) {
  if (!opportunity || opportunity.opportunity_id !== opportunityId) {
    throw new Error(`Canonical opportunity ${opportunityId} is missing.`);
  }
  if (opportunity.status !== approval.expectedOpportunityStatus) {
    throw new Error(`Canonical opportunity ${opportunityId} is not active as approved.`);
  }
  if (opportunity.identity_version !== approval.expectedEvidenceVersion) {
    throw new Error(`Canonical opportunity ${opportunityId} identity version drifted.`);
  }
  if (opportunity.primary_submission_id) {
    throw new Error(`Canonical opportunity ${opportunityId} acquired unexpected CRM state.`);
  }
  if (opportunity.metadata?.canonicalOpportunityMerge || opportunity.metadata?.mergedInto) {
    throw new Error(`Canonical opportunity ${opportunityId} already has supersession metadata.`);
  }
  const facts = approval.approvedFacts;
  const snapshot = opportunity.metadata?.identitySnapshot || {};
  const exactFacts = [
    [opportunity.canonical_name, facts.canonicalName, 'canonical name'],
    [opportunity.canonical_location, facts.canonicalLocation, 'canonical location'],
    [snapshot.name, facts.identityName, 'identity name'],
    [snapshot.city, facts.city, 'city'],
    [snapshot.county, facts.county, 'county'],
    [snapshot.state, facts.state, 'state'],
    [snapshot.country, facts.country, 'country'],
    [snapshot.askingPrice, facts.askingPrice, 'asking price'],
    [snapshot.revenue, facts.revenue, 'revenue'],
    [snapshot.profit, facts.profit, 'profit'],
    [snapshot.listingUrl, facts.listingUrl, 'listing URL'],
  ];
  for (const [actual, expected, label] of exactFacts) {
    if (actual !== expected) throw new Error(`Canonical opportunity ${opportunityId} ${label} drifted from approval.`);
  }
  if (String(snapshot.description || '').length !== facts.identityDescriptionLength) {
    throw new Error(`Canonical opportunity ${opportunityId} description evidence drifted from approval.`);
  }
  if (facts.recipientPresent && (!opportunity.canonical_recipient || !snapshot.recipient)) {
    throw new Error(`Canonical opportunity ${opportunityId} recipient evidence drifted from approval.`);
  }
  if (!sameStringSet(snapshot.listingIds || [], facts.listingIds)) {
    throw new Error(`Canonical opportunity ${opportunityId} listing IDs drifted from approval.`);
  }
}

function validateOpportunityPairCompatibility(survivor, superseded) {
  const survivorSnapshot = survivor?.metadata?.identitySnapshot || {};
  const supersededSnapshot = superseded?.metadata?.identitySnapshot || {};
  const comparisons = [
    [survivor?.canonical_recipient, superseded?.canonical_recipient, 'canonical recipient'],
    [survivorSnapshot.recipient, supersededSnapshot.recipient, 'recipient evidence'],
    [survivorSnapshot.description, supersededSnapshot.description, 'description evidence'],
    [survivorSnapshot.location, supersededSnapshot.location, 'location evidence'],
  ];
  for (const [survivorValue, supersededValue, label] of comparisons) {
    if (survivorValue !== supersededValue) {
      throw new Error(`The approved canonical opportunity pair is no longer compatible: ${label} diverged.`);
    }
  }
  if (!sameStringSet(survivorSnapshot.sourceIds || [], supersededSnapshot.sourceIds || [])) {
    throw new Error('The approved canonical opportunity pair is no longer compatible: source evidence diverged.');
  }
}

function validateException(identityException, approval) {
  if (!identityException || identityException.id !== approval.exceptionId) {
    throw new Error(`Identity exception ${approval.exceptionId} is missing.`);
  }
  if (
    identityException.status !== approval.expectedExceptionStatus
    || identityException.resolved_at
    || identityException.resolved_by
    || identityException.resolution_reason
  ) {
    throw new Error('The approved identity exception is no longer pristine and open.');
  }
  if (identityException.reason !== approval.expectedExceptionReason) {
    throw new Error('The approved identity exception reason drifted.');
  }
  if (identityException.evidence_version !== approval.expectedEvidenceVersion) {
    throw new Error('The approved identity exception evidence version drifted.');
  }
  if (!sameStringSet(identityException.candidate_opportunity_ids || [], [approval.survivorId, approval.supersededId])) {
    throw new Error('The approved identity exception candidate set drifted.');
  }
}

function validateAliases(inspection, approval) {
  const expected = sortedAliases(approval.expectedAliases).map((item) => ({
    aliasType: item.aliasType,
    aliasValue: item.aliasValue,
    aliasKey: item.aliasKey,
    opportunityId: item.opportunityId,
  }));
  const observed = sortedAliases(inspection.aliases).map((item) => ({
    aliasType: item.alias_type,
    aliasValue: item.alias_value,
    aliasKey: item.alias_key,
    opportunityId: item.opportunity_id,
  }));
  if (stableCanonicalJson(observed) !== stableCanonicalJson(expected)) {
    throw new Error('Canonical opportunity alias ownership set drifted from the checked-in approval.');
  }
  const globalRows = Array.isArray(inspection.globalAliasOwnership) ? inspection.globalAliasOwnership : [];
  for (const approvedAlias of approval.expectedAliases) {
    const rows = globalRows.filter((item) => (
      item.alias_type === approvedAlias.aliasType && item.alias_value === approvedAlias.aliasValue
    ));
    if (rows.length !== 1) {
      throw new Error(`Approved alias ${approvedAlias.aliasKey} has missing, duplicate, or third-party ownership.`);
    }
    const [row] = rows;
    if (row.opportunity_id !== approvedAlias.opportunityId || row.alias_key !== approvedAlias.aliasKey) {
      throw new Error(`Approved alias ${approvedAlias.aliasKey} changed owner or identity key.`);
    }
  }
}

function validateManifestNamespace(inspection, approval) {
  const manifestId = canonicalOpportunityMergeManifestId(approval);
  if (inspection.manifestAtId) {
    throw new Error(`Canonical opportunity merge manifest collision at ${manifestId}.`);
  }
  if ((inspection.typedManifests || []).length > 0) {
    throw new Error('A canonical opportunity merge manifest already exists outside the deterministic approval key.');
  }
}

function validateDependentState(dependentState = {}) {
  const nonzero = Object.entries(dependentState.counts || {}).filter(([, count]) => Number(count) !== 0);
  if (nonzero.length > 0) {
    throw new Error(`Canonical opportunity merge found unexpected dependent state: ${nonzero.map(([name]) => name).join(', ')}.`);
  }
}

function validatePreservedOperationalState(preservedOperationalState = {}) {
  const suppressions = preservedOperationalState.emailSuppressions;
  const expectedKeys = [
    'activeCount',
    'authorityEffect',
    'liftedCount',
    'matchedRecipientCount',
    'recipientResolution',
    'totalCount',
  ];
  if (
    !suppressions
    || stableCanonicalJson(Object.keys(suppressions).sort()) !== stableCanonicalJson(expectedKeys)
    || suppressions.recipientResolution !== 'deterministic-approved-pair'
    || suppressions.authorityEffect !== 'restrictive'
  ) {
    throw new Error('Canonical opportunity merge preserved recipient operational state is incomplete or non-count-only.');
  }
  for (const key of ['matchedRecipientCount', 'totalCount', 'activeCount', 'liftedCount']) {
    if (!Number.isInteger(suppressions[key]) || suppressions[key] < 0) {
      throw new Error('Canonical opportunity merge preserved recipient operational counts are invalid.');
    }
  }
  if (
    suppressions.activeCount + suppressions.liftedCount !== suppressions.totalCount
    || suppressions.matchedRecipientCount > suppressions.totalCount
  ) {
    throw new Error('Canonical opportunity merge preserved recipient operational counts are inconsistent.');
  }
}

function validateAuthorityGrantingOperationalState(authorityGrantingOperationalState = {}) {
  const activations = authorityGrantingOperationalState.stage2Activations;
  if (
    !activations
    || !Number.isInteger(activations.totalCount)
    || activations.totalCount < 0
    || !Number.isInteger(activations.activeCount)
    || activations.activeCount < 0
    || activations.activeCount > activations.totalCount
    || activations.authorityEffect !== 'granting'
  ) {
    throw new Error('Canonical opportunity merge authority-granting operational state is incomplete.');
  }
  if (activations.activeCount > 0) {
    throw new Error('Canonical opportunity merge found authority-granting operational state: stage2Activations.');
  }
}

function validateRelationshipInventorySummary(summary = {}) {
  const expected = canonicalOpportunityMergeRelationshipInventorySummary();
  if (stableCanonicalJson(summary) !== stableCanonicalJson(expected)) {
    throw new Error('Canonical opportunity merge relationship inventory summary is stale or incomplete.');
  }
}

export function canonicalOpportunityMergeManifestId(approval) {
  const tuple = {
    repairType: approval.repairType,
    approvalSchema: approval.approvalSchema,
    exceptionId: approval.exceptionId,
    survivorId: approval.survivorId,
    supersededId: approval.supersededId,
  };
  return `canonical-opportunity-merge:v1:${sha256(stableCanonicalJson(tuple))}`;
}

export function canonicalOpportunityMergePlanChecksum(plan) {
  return sha256(stableCanonicalJson(plan));
}

function exactApprovalTuple(approval) {
  return {
    exceptionId: approval.exceptionId,
    survivorId: approval.survivorId,
    supersededId: approval.supersededId,
  };
}

function simplifiedAliasOwnership(aliases = []) {
  return sortedAliases(aliases).map((item) => ({
    aliasType: item.alias_type || item.aliasType,
    aliasValue: item.alias_value || item.aliasValue,
    aliasKey: item.alias_key || item.aliasKey,
    opportunityId: item.opportunity_id || item.opportunityId,
  }));
}

function expectedAliasMoves(approval) {
  return sortedAliases(approval.expectedAliases
    .filter((item) => item.opportunityId === approval.supersededId))
    .map((item) => ({
      aliasKey: item.aliasKey,
      aliasType: item.aliasType,
      aliasValue: item.aliasValue,
      beforeOpportunityId: approval.supersededId,
      afterOpportunityId: approval.survivorId,
    }));
}

export function validateCanonicalOpportunityMergeReplayManifest({
  approval,
  manifest,
  actor,
  reason,
  expectedPlanChecksum,
} = {}) {
  const normalizedActor = normalizedText(actor, 160);
  const normalizedReason = normalizedText(reason, 1000);
  const manifestId = canonicalOpportunityMergeManifestId(approval);
  const body = manifest?.manifest || {};
  const metadata = manifest?.metadata || {};
  const plan = body.plan || {};
  const approvalTuple = exactApprovalTuple(approval);
  const storedTupleMatches = stableCanonicalJson(body.approvalTuple) === stableCanonicalJson(approvalTuple)
    && stableCanonicalJson(plan.approvalTuple) === stableCanonicalJson(approvalTuple);
  if (
    !manifest
    || manifest.id !== manifestId
    || manifest.mode !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || manifest.status !== 'applied'
    || body.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || body.manifestSchema !== CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA
    || body.approvalSchema !== approval.approvalSchema
    || metadata.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || metadata.manifestSchema !== CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA
    || metadata.approvalSchema !== approval.approvalSchema
    || metadata.exceptionId !== approval.exceptionId
    || metadata.survivorId !== approval.survivorId
    || metadata.supersededId !== approval.supersededId
    || !storedTupleMatches
  ) {
    throw new Error(`Canonical opportunity merge manifest collision at ${manifestId}: stored type, schema, or tuple is not the approved repair.`);
  }
  if (!normalizedActor || manifest.actor !== normalizedActor || body.actor !== normalizedActor || plan.actor !== normalizedActor) {
    throw new Error('Canonical opportunity merge manifest actor does not match the requested plan identity.');
  }
  if (normalizedReason.length < 20 || body.reason !== normalizedReason || plan.reason !== normalizedReason) {
    throw new Error('Canonical opportunity merge manifest reason does not match the requested plan identity.');
  }
  if (
    !/^[a-f0-9]{64}$/.test(String(expectedPlanChecksum || ''))
    || manifest.checksum !== expectedPlanChecksum
    || metadata.planChecksum !== expectedPlanChecksum
    || body.planChecksum !== expectedPlanChecksum
    || canonicalOpportunityMergePlanChecksum(plan) !== expectedPlanChecksum
  ) {
    throw new Error('Canonical opportunity merge manifest checksum does not match the requested completed plan.');
  }
  if (
    plan.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || plan.planSchema !== CANONICAL_OPPORTUNITY_MERGE_PLAN_SCHEMA
    || plan.approvalSchema !== approval.approvalSchema
    || plan.manifest?.id !== manifestId
    || plan.manifest?.repairType !== CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE
    || plan.manifest?.manifestSchema !== CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA
  ) {
    throw new Error('Canonical opportunity merge manifest contains an invalid completed plan schema.');
  }
  try {
    validateOpportunity(plan.opportunities?.survivor, approval.survivorId, approval);
    validateOpportunity(plan.opportunities?.superseded, approval.supersededId, approval);
    validateOpportunityPairCompatibility(plan.opportunities?.survivor, plan.opportunities?.superseded);
    validateException(plan.identityException, approval);
    validateAliases({
      aliases: plan.observedAliases,
      globalAliasOwnership: plan.globalAliasOwnership,
    }, approval);
    validateDependentState(plan.dependentState);
    validatePreservedOperationalState(plan.preservedOperationalState);
    validateAuthorityGrantingOperationalState(plan.authorityGrantingOperationalState);
    validateCanonicalOpportunityMergeRelationshipInventory({ inspection: plan });
    validateRelationshipInventorySummary(plan.relationshipInventory);
  } catch (error) {
    throw new Error(`Canonical opportunity merge manifest does not preserve the approved pre-merge evidence: ${error.message}`);
  }
  if (
    stableCanonicalJson(simplifiedAliasOwnership(plan.observedAliases))
      !== stableCanonicalJson(simplifiedAliasOwnership(approval.expectedAliases))
    || stableCanonicalJson(plan.aliasMoves) !== stableCanonicalJson(expectedAliasMoves(approval))
    || stableCanonicalJson(body.aliasMoves) !== stableCanonicalJson(expectedAliasMoves(approval))
    || plan.resolutionSafety?.approvedObservationCount !== approval.sourceObservations.length
    || plan.resolutionSafety?.expectedFinalAliasOwner !== approval.survivorId
    || plan.resolutionSafety?.expectedSupersededAliasCount !== 0
    || plan.mutation?.survivorStatus !== 'active'
    || plan.mutation?.supersededStatus !== 'superseded'
    || plan.mutation?.exceptionStatus !== 'resolved'
  ) {
    throw new Error('Canonical opportunity merge manifest plan does not match the exact checked-in alias move and postconditions.');
  }
  const backupEvidence = body.backupEvidence || {};
  if (
    backupEvidence.provider !== 'sqlite'
    || !String(backupEvidence.path || '').trim()
    || manifest.backup_reference !== backupEvidence.path
    || !String(backupEvidence.manifestId || '').trim()
    || !validDate(backupEvidence.createdAt)
    || !validDate(backupEvidence.verifiedAt)
    || !String(backupEvidence.databaseRelativePath || '').trim()
    || !Number.isInteger(backupEvidence.databaseSizeBytes)
    || backupEvidence.databaseSizeBytes < 0
    || !/^[a-f0-9]{64}$/.test(String(backupEvidence.databaseSha256 || ''))
    || backupEvidence.reviewedPlanChecksum !== expectedPlanChecksum
    || !validDate(backupEvidence.pauseUpdatedAt)
    || Date.parse(backupEvidence.createdAt) < Date.parse(backupEvidence.pauseUpdatedAt)
    || backupEvidence.verification?.databaseCheck !== 'quick_check'
    || backupEvidence.verification?.checksum !== 'sha256'
    || !validDate(body.appliedAt)
    || manifest.created_at !== body.appliedAt
    || manifest.updated_at !== body.appliedAt
  ) {
    throw new Error('Canonical opportunity merge manifest has invalid stored backup or audit evidence.');
  }
  return {
    actor: normalizedActor,
    reason: normalizedReason,
    manifestId,
    planChecksum: expectedPlanChecksum,
    plan,
  };
}

export function buildCanonicalOpportunityMergePlan({ approval, inspection, actor, reason } = {}) {
  const normalizedActor = normalizedText(actor, 160);
  const normalizedReason = normalizedText(reason, 1000);
  if (!normalizedActor) throw new Error('Canonical opportunity merge requires an accountable actor.');
  if (normalizedReason.length < 20) throw new Error('Canonical opportunity merge requires a specific human reason.');
  const opportunityById = new Map((inspection?.opportunities || []).map((item) => [item.opportunity_id, item]));
  const survivor = opportunityById.get(approval.survivorId);
  const superseded = opportunityById.get(approval.supersededId);
  validateOpportunity(survivor, approval.survivorId, approval);
  validateOpportunity(superseded, approval.supersededId, approval);
  validateOpportunityPairCompatibility(survivor, superseded);
  validateException(inspection.identityException, approval);
  validateAliases(inspection, approval);
  validateManifestNamespace(inspection, approval);
  validateDependentState(inspection.dependentState);
  validatePreservedOperationalState(inspection.preservedOperationalState);
  validateAuthorityGrantingOperationalState(inspection.authorityGrantingOperationalState);
  validateCanonicalOpportunityMergeRelationshipInventory({ inspection });

  const manifestId = canonicalOpportunityMergeManifestId(approval);
  const observedAliases = sortedAliases(inspection.aliases);
  const aliasMoves = sortedAliases(approval.expectedAliases
    .filter((item) => item.opportunityId === approval.supersededId))
    .map((item) => ({
      aliasKey: item.aliasKey,
      aliasType: item.aliasType,
      aliasValue: item.aliasValue,
      beforeOpportunityId: approval.supersededId,
      afterOpportunityId: approval.survivorId,
    }));
  const plan = {
    repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
    planSchema: CANONICAL_OPPORTUNITY_MERGE_PLAN_SCHEMA,
    approvalSchema: approval.approvalSchema,
    approvalTuple: exactApprovalTuple(approval),
    actor: normalizedActor,
    reason: normalizedReason,
    opportunities: { survivor, superseded },
    identityException: inspection.identityException,
    observedAliases,
    globalAliasOwnership: sortedAliases(inspection.globalAliasOwnership),
    aliasMoves,
    dependentState: inspection.dependentState,
    preservedOperationalState: inspection.preservedOperationalState,
    authorityGrantingOperationalState: inspection.authorityGrantingOperationalState,
    relationshipInventory: canonicalOpportunityMergeRelationshipInventorySummary(),
    resolutionSafety: {
      approvedObservationCount: approval.sourceObservations.length,
      expectedFinalAliasOwner: approval.survivorId,
      expectedSupersededAliasCount: 0,
      structuralInvariantSatisfied: true,
      blockers: [],
    },
    mutation: {
      survivorStatus: 'active',
      supersededStatus: 'superseded',
      exceptionStatus: 'resolved',
    },
    manifest: {
      id: manifestId,
      repairType: CANONICAL_OPPORTUNITY_MERGE_REPAIR_TYPE,
      manifestSchema: CANONICAL_OPPORTUNITY_MERGE_MANIFEST_SCHEMA,
    },
  };
  return {
    manifestId,
    plan,
    planChecksum: canonicalOpportunityMergePlanChecksum(plan),
    actor: normalizedActor,
    reason: normalizedReason,
  };
}

export function getCanonicalOpportunityMergeApproval({
  exceptionId: requestedExceptionId = '',
  survivorId: requestedSurvivorId = '',
  supersededId: requestedSupersededId = '',
} = {}) {
  const match = approvals.find((approval) => (
    approval.exceptionId === String(requestedExceptionId).trim()
    && approval.survivorId === String(requestedSurvivorId).trim()
    && approval.supersededId === String(requestedSupersededId).trim()
  ));
  if (!match) throw new Error('This is not an approved canonical opportunity merge tuple.');
  return match;
}
