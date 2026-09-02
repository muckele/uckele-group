import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import {
  safeCompareText,
  sha256,
  signPayload,
  stableCanonicalJson,
  verifySignedPayload,
} from '../utils/security.js';
import { evaluateCimRecipientPolicy, getCimOutreachPauseStatus } from './cimOpportunityIdentity.js';
import { buildDealHunterCimRequestEmail } from './delivery.js';
import { getEmailReadiness } from './emailReadiness.js';
import { evaluateAcquisitionMaterialsState } from './acquisitionMaterials.js';
import { firstStrictDetailAuthorityTimestamp } from './detailAuthorityTimestamp.js';
import {
  isOperatorApprovedFollowUpRequest,
  projectManualFollowUpState,
} from './dealHunterManualFollowUpPolicy.js';
import {
  buildDealHunterCimRequestId,
  evaluateDealHunterCimEligibility,
  executeApprovedDealHunterCimRequest,
} from './dealHunter.js';

export const BROKER_MATERIALS_TEMPLATE_VERSION = 'deal-hunter-cim-manual-stage1-v1';

const preparationLifetimeMs = 15 * 60 * 1000;
const contactReferenceType = 'deal-hunter-broker-contact-reference';
const preparationType = 'deal-hunter-broker-materials-preparation';
const requestStatuses = new Set(['pending', 'sent', 'logged', 'failed', 'ambiguous', 'responded', 'delivery_issue', 'follow_up_failed', 'follow_up_pending', 'follow_up_ambiguous']);
const requestStates = new Set(['not_requested', 'ready', 'claimed', 'pending', 'provider_accepted', 'provider_unknown', 'provider_ambiguous', 'development_only', 'failed', 'responded', 'stopped']);
const deliveryStates = new Set(['not-attempted', 'pending', 'accepted', 'sent', 'delivered', 'delayed', 'bounced', 'failed', 'complained', 'suppressed', 'unknown', 'ambiguous', 'development-only', 'responded']);
const followUpStates = new Set(['not-scheduled', 'scheduled', 'pending', 'sent', 'failed', 'ambiguous', 'stopped', 'completed']);

function text(value, maximum = 500) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function email(value) {
  return text(value, 320).toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email(value));
}

function iso(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function currentTimestamp(row = {}) {
  return iso(row.updated_at || row.updatedAt || row.observed_at || row.observedAt || row.created_at || row.createdAt);
}

function blocker(code, message) {
  return { code, message };
}

function vocabulary(value, allowed) {
  const normalized = text(value, 80).toLowerCase();
  return allowed.has(normalized) ? normalized : '';
}

function uniqueBlockers(blockers = []) {
  const seen = new Set();
  return blockers.filter((item) => item?.code && !seen.has(item.code) && seen.add(item.code));
}

function normalizedNow(now) {
  const value = now instanceof Date ? new Date(now) : new Date(now || Date.now());
  if (Number.isNaN(value.getTime())) throw new TypeError('A valid preparation time is required.');
  return value;
}

function parseGreeting(value) {
  if (typeof value !== 'string') throw new TypeError('The greeting is invalid.');
  const hasUnsafeCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127 || character === '<' || character === '>';
  });
  const greeting = value.trim();
  if (!greeting || greeting.length > 120 || hasUnsafeCharacter) {
    throw new TypeError('The greeting must be one plain text line of at most 120 characters.');
  }
  return greeting;
}

export function parseBrokerMaterialsPreparationInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('The Broker Materials preparation input is invalid.');
  }
  const allowed = new Set(['recipientContactRef', 'greeting']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`Unknown Broker Materials preparation field: ${unknown[0]}.`);
  const result = {};
  if (Object.hasOwn(input, 'recipientContactRef') && input.recipientContactRef !== undefined) {
    if (typeof input.recipientContactRef !== 'string' || !input.recipientContactRef.trim() || input.recipientContactRef.length > 2000) {
      throw new TypeError('The recipient contact reference is invalid.');
    }
    result.recipientContactRef = input.recipientContactRef.trim();
  }
  if (Object.hasOwn(input, 'greeting') && input.greeting !== undefined) result.greeting = parseGreeting(input.greeting);
  return result;
}

export function parseBrokerMaterialsApprovalInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('The Broker Materials approval input is invalid.');
  }
  const allowed = new Set(['preparationToken', 'approvedProposalDigest']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`Unknown Broker Materials approval field: ${unknown[0]}.`);
  if (typeof input.preparationToken !== 'string' || !input.preparationToken.trim() || input.preparationToken.length > 20000) {
    throw new TypeError('A valid Broker Materials preparation token is required.');
  }
  if (typeof input.approvedProposalDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(input.approvedProposalDigest)) {
    throw new TypeError('A valid Broker Materials proposal digest is required.');
  }
  return {
    preparationToken: input.preparationToken.trim(),
    approvedProposalDigest: input.approvedProposalDigest.toLowerCase(),
  };
}

function sourceContactCandidates(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const sourceId = text(row?.source_id || row?.sourceId, 200);
    const sourceRecordId = text(row?.source_record_id || row?.sourceRecordId, 200);
    if (!sourceId || !sourceRecordId) continue;
    const key = `${sourceId}\u0000${sourceRecordId}`;
    const group = groups.get(key) || { rows: [], values: new Map() };
    group.rows.push(row);
    const field = text(row?.field, 80).toLowerCase();
    const value = text(row?.value, 4000);
    if (field && value && !group.values.has(field)) group.values.set(field, value);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(({ rows: groupRows, values }) => {
    const brokerEmail = email(values.get('broker_email'));
    if (!validEmail(brokerEmail)) return [];
    const emailRow = groupRows.find((row) => text(row?.field, 80).toLowerCase() === 'broker_email') || groupRows[0];
    const identity = {
      sourceId: text(emailRow.source_id || emailRow.sourceId, 200),
      sourceRecordId: text(emailRow.source_record_id || emailRow.sourceRecordId, 200),
      field: 'broker_email',
      rowId: text(emailRow.id, 200),
      updatedAt: currentTimestamp(emailRow),
    };
    return [{
      email: brokerEmail,
      displayName: text(values.get('broker_name'), 300),
      firstName: text(values.get('broker_first_name') || emailRow?.metadata?.firstName, 120),
      provenance: 'structured_source',
      provenanceLabel: text(emailRow.source_name || emailRow.sourceName, 160) || 'Trusted source',
      primary: Boolean(emailRow.primary || emailRow.is_primary || emailRow.metadata?.primary),
      identity,
    }];
  });
}

function crmContactCandidates(submission) {
  if (!submission || text(submission.status, 80).toLowerCase() === 'archived') return [];
  const dealHunter = submission.metadata?.dealHunter && typeof submission.metadata.dealHunter === 'object'
    ? submission.metadata.dealHunter
    : {};
  const brokerEmail = email(submission.broker_email || submission.brokerEmail || dealHunter.broker_email || dealHunter.brokerEmail);
  if (!validEmail(brokerEmail)) return [];
  return [{
    email: brokerEmail,
    displayName: text(submission.broker_name || submission.brokerName || dealHunter.broker_name || dealHunter.brokerName, 300),
    firstName: text(submission.broker_first_name || submission.brokerFirstName || dealHunter.broker_first_name || dealHunter.brokerFirstName, 120),
    provenance: 'crm',
    provenanceLabel: 'Linked CRM',
    primary: Boolean(submission.broker_primary || submission.brokerPrimary || dealHunter.brokerPrimary || dealHunter.broker_primary),
    identity: { submissionId: text(submission.id, 200), field: 'broker_email', updatedAt: currentTimestamp(submission) },
  }];
}

function operatorContactCandidates(facts = []) {
  const current = facts.filter((fact) => text(fact?.field, 80).toLowerCase() === 'broker_email').sort((left, right) => (
    (Date.parse(currentTimestamp(right)) || 0) - (Date.parse(currentTimestamp(left)) || 0)
    || text(right?.id, 200).localeCompare(text(left?.id, 200))
  ))[0];
  if (!current || current.verified !== true) return [];
  const brokerEmail = email(current.value);
  if (!validEmail(brokerEmail)) return [];
  return [{
    email: brokerEmail,
    displayName: '',
    firstName: '',
    provenance: 'operator_verified',
    provenanceLabel: 'Verified operator fact',
    primary: false,
    identity: { factId: text(current.id, 200), field: 'broker_email', updatedAt: currentTimestamp(current) },
  }];
}

function issueContactOptions({ opportunityId, contacts, secret }) {
  const byEmail = new Map();
  for (const contact of contacts) {
    const current = byEmail.get(contact.email) || [];
    current.push(contact);
    byEmail.set(contact.email, current);
  }
  return [...byEmail.entries()].map(([recipientEmail, provenances]) => {
    const sorted = [...provenances].sort((left, right) => (
      left.provenance.localeCompare(right.provenance)
      || stableCanonicalJson(left.identity).localeCompare(stableCanonicalJson(right.identity))
    ));
    const primary = sorted.find((item) => item.primary) || sorted[0];
    const provenanceFingerprint = sha256(stableCanonicalJson(sorted.map((item) => ({ provenance: item.provenance, identity: item.identity }))));
    const contactAuthorityRevision = sha256(stableCanonicalJson({ recipientEmail, provenances: sorted.map((item) => item.identity) }));
    const recipientContactRef = signPayload({
      typ: contactReferenceType,
      version: 1,
      canonicalOpportunityId: opportunityId,
      provenanceFingerprint,
      contactAuthorityRevision,
      recipientIdentityHash: sha256(`${opportunityId}:${recipientEmail}`),
    }, secret);
    return {
      recipientContactRef,
      email: recipientEmail,
      displayName: primary.displayName,
      firstName: primary.firstName,
      provenance: primary.provenance,
      provenanceLabel: primary.provenanceLabel,
      provenances: sorted.map((item) => ({ provenance: item.provenance, label: item.provenanceLabel })),
      primary: sorted.some((item) => item.primary),
      provenanceFingerprint,
      contactAuthorityRevision,
    };
  }).sort((left, right) => left.email.localeCompare(right.email) || left.provenance.localeCompare(right.provenance));
}

function projectExistingRequest(records = [], {
  now = new Date(),
  terminalReason = '',
  materialsAuthorityAvailable = true,
  communications = [],
} = {}) {
  const request = [...records].filter((item) => item?.id).sort((left, right) => (
    (Date.parse(right.first_requested_at || right.firstRequestedAt || right.created_at || right.createdAt || '') || 0)
    - (Date.parse(left.first_requested_at || left.firstRequestedAt || left.created_at || left.createdAt || '') || 0)
    || String(left.id).localeCompare(String(right.id))
  ))[0];
  if (!request) return null;
  const status = vocabulary(request.status, requestStatuses);
  const deliveryState = vocabulary(request.delivery_state || request.deliveryState, deliveryStates);
  const providerAcceptedAt = iso(request.first_provider_accepted_at || request.providerAcceptedAt);
  const preAcceptanceFailure = status === 'failed' && !providerAcceptedAt && !['accepted', 'delivered', 'bounced', 'complained', 'suppressed'].includes(deliveryState);
  const deliveryIssue = status === 'delivery_issue' || ['bounced', 'complained', 'suppressed'].includes(deliveryState);
  const materialsAuthorityUnavailable = !terminalReason
    && !materialsAuthorityAvailable
    && isOperatorApprovedFollowUpRequest(request);
  const followUps = projectManualFollowUpState({
    request,
    communications,
    authority: {
      terminalReason: materialsAuthorityUnavailable ? 'materials-authority-unavailable' : terminalReason,
      preparationBlockers: materialsAuthorityUnavailable
        ? [blocker('materials-authority-unavailable', 'Acquisition materials authority could not be verified.')]
        : [],
    },
    now,
  });
  return {
    id: text(request.id, 200),
    status,
    requestState: vocabulary(request.request_state || request.requestState, requestStates),
    deliveryState,
    followUpState: vocabulary(request.follow_up_state || request.followUpState, followUpStates),
    recipient: {
      email: email(request.recipient_email || request.recipient?.email),
      displayName: text(request.recipient_name || request.broker_name || request.recipient?.displayName, 300),
    },
    subject: text(request.subject, 500),
    createdAt: iso(request.created_at || request.createdAt),
    updatedAt: iso(request.updated_at || request.updatedAt),
    requestedAt: iso(request.first_requested_at || request.requested_at || request.requestedAt),
    providerAcceptedAt,
    deliveredAt: iso(request.delivered_at || request.deliveredAt),
    respondedAt: iso(request.responded_at || request.respondedAt),
    errorSummary: safeRequestErrorSummary({ status, deliveryState }),
    ...(followUps.enrolled ? { followUps } : {}),
    canRetry: preAcceptanceFailure,
    canCorrectRecipient: deliveryIssue,
    retryRoute: preAcceptanceFailure ? `/api/admin/deal-hunter/cim-requests/${encodeURIComponent(request.id)}/retry` : '',
    correctionRoute: deliveryIssue ? `/api/admin/deal-hunter/cim-requests/${encodeURIComponent(request.id)}/correct-recipient` : '',
  };
}

function safeRequestErrorSummary({ status = '', deliveryState = '' } = {}) {
  if (deliveryState === 'suppressed') return 'The recipient is suppressed.';
  if (deliveryState === 'complained') return 'The recipient reported the message.';
  if (status === 'ambiguous' || deliveryState === 'ambiguous' || deliveryState === 'unknown') return 'Delivery could not be confirmed.';
  if (status === 'failed' || status === 'delivery_issue' || status === 'follow_up_failed'
    || ['failed', 'bounced'].includes(deliveryState)) return 'Delivery failed.';
  return '';
}

function pursuedState(score = {}) {
  const reviewed = Boolean(score.reviewed_at || score.reviewedAt || score.reviewed);
  const changed = Boolean(score.changed_since_review || score.changedSinceReview)
    || Boolean(score.reviewed_fingerprint && score.score_fingerprint && score.reviewed_fingerprint !== score.score_fingerprint)
    || Boolean(score.reviewed_semantic_digest && score.semantic_digest && score.reviewed_semantic_digest !== score.semantic_digest);
  return { pursued: text(score.operator_priority || score.operatorPriority, 40).toLowerCase() === 'high' && reviewed && !changed, reviewed, changed };
}

async function optionalRead(call, fallback) {
  try {
    const value = await call();
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function boundedAuthorityRead(storage, method, fallback, ...args) {
  if (typeof storage?.[method] !== 'function') return { available: false, value: fallback };
  try {
    const value = await storage[method](...args);
    return { available: true, value: value ?? fallback };
  } catch {
    return { available: false, value: fallback };
  }
}

async function requiredAuthorityRead(storage, method, ...args) {
  if (typeof storage?.[method] !== 'function') throw new Error(`${method} is unavailable.`);
  return storage[method](...args);
}

function unavailableAuthority({ opportunityId, opportunity = null, score = null, now }) {
  return {
    opportunityId, opportunity, score, recipientOptions: [], warnings: [], existingRequest: null,
    preparationBlockers: [blocker('broker_materials_authority_unavailable', 'Broker Materials authority could not be verified.')],
    sendBlockers: [], pursued: false, authorityRevision: '', aliasResolutionFingerprint: '', requiredAuthorityExpiresAt: '',
    authorityStatus: 503, materialsAuthorityAvailable: false, communicationsAuthorityAvailable: false, now,
  };
}

function knownDealKeys(score, aliases = []) {
  return [...new Set([
    text(score?.deal_key, 1000),
    ...aliases.filter((item) => ['deal-key', 'deal_key'].includes(text(item?.alias_type, 80).toLowerCase()))
      .map((item) => text(item?.alias_value, 1000)),
  ].filter(Boolean))].slice(0, 500);
}

function unionRequests(...collections) {
  const byId = new Map();
  for (const request of collections.flat()) {
    const id = text(request?.id, 200);
    if (id && !byId.has(id)) byId.set(id, request);
  }
  return [...byId.values()];
}

function currentDisposition(records = []) {
  const candidates = (Array.isArray(records) ? records : []).slice(0, 500).flatMap((record) => {
    const state = text(record?.disposition, 80).toLowerCase();
    if (!state) return [];
    const authorityAt = firstStrictDetailAuthorityTimestamp(record, [
      ['updated_at', 'updatedAt'],
      ...(state === 'dismissed'
        ? [['dismissed_at', 'dismissedAt']]
        : state === 'restored'
          ? [['restored_at', 'restoredAt']]
          : [['dismissed_at', 'dismissedAt'], ['restored_at', 'restoredAt']]),
      ['created_at', 'createdAt'],
    ]);
    return [{
      state,
      timestamp: authorityAt.timestamp,
      fractionalNanoseconds: authorityAt.fractionalNanoseconds,
      recordId: text(record?.id, 200),
      signature: stableCanonicalJson({
        state,
        reason: text(record?.reason, 160),
        note: text(record?.note, 500),
        dismissedAt: text(record?.dismissed_at ?? record?.dismissedAt, 80),
        restoredAt: text(record?.restored_at ?? record?.restoredAt, 80),
        authorityAt: authorityAt.value,
      }),
    }];
  }).sort((left, right) => {
    if (left.timestamp !== null && right.timestamp === null) return -1;
    if (left.timestamp === null && right.timestamp !== null) return 1;
    if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
    if (left.timestamp !== null && right.timestamp !== null && left.fractionalNanoseconds !== right.fractionalNanoseconds) {
      return right.fractionalNanoseconds - left.fractionalNanoseconds;
    }
    if (left.state !== right.state) {
      if (left.state === 'dismissed') return -1;
      if (right.state === 'dismissed') return 1;
    }
    if (left.recordId || right.recordId) {
      if (!left.recordId) return 1;
      if (!right.recordId) return -1;
      const byId = left.recordId.localeCompare(right.recordId);
      if (byId !== 0) return byId;
    }
    return left.signature.localeCompare(right.signature);
  });
  return candidates[0]?.state || '';
}

export async function loadBrokerMaterialsAuthority({ opportunityId = '', storage, now = new Date(), communicationSnapshot } = {}) {
  const id = text(opportunityId, 200);
  const config = getConfig();
  const at = normalizedNow(now);
  let opportunity;
  let score;
  try {
    [opportunity, score] = await Promise.all([
      requiredAuthorityRead(storage, 'getCurrentDealHunterOpportunity', id),
      requiredAuthorityRead(storage, 'getCurrentDealHunterOpportunityScore', id),
    ]);
  } catch {
    return unavailableAuthority({ opportunityId: id, now: at });
  }
  if (!opportunity || !score) {
    return {
      opportunityId: id, opportunity, score, recipientOptions: [], warnings: [], existingRequest: null,
      preparationBlockers: [blocker('canonical_authority_unavailable', 'Current canonical opportunity authority is unavailable.')],
      sendBlockers: [], pursued: false, authorityRevision: '', aliasResolutionFingerprint: '', requiredAuthorityExpiresAt: '', now: at,
    };
  }
  let aliases;
  let facts;
  let sourceRows;
  let submission;
  let requests;
  let dispositions;
  let opportunityClaim;
  let safety;
  let identityExceptions;
  let secureDocuments;
  let latestUploadRequest;
  let communications = [];
  let materialsAuthorityAvailable = true;
  let communicationsAuthorityAvailable = true;
  try {
    [aliases, facts, sourceRows, submission, opportunityClaim, safety, identityExceptions] = await Promise.all([
      requiredAuthorityRead(storage, 'listDealHunterOpportunityAliases', { opportunityIds: [id], limit: 500 }),
      requiredAuthorityRead(storage, 'listDealHunterOpportunityFacts', id, { limit: 100 }),
      requiredAuthorityRead(storage, 'listDealHunterOpportunitySourceObservations', id, { limit: 500 }),
      opportunity.primary_submission_id ? requiredAuthorityRead(storage, 'getSubmission', opportunity.primary_submission_id) : null,
      requiredAuthorityRead(storage, 'getDealHunterCimOpportunityClaim', id),
      optionalRead(() => storage?.getDealHunterCimSafetySettings?.(), null),
      requiredAuthorityRead(storage, 'listDealHunterIdentityExceptions', { statuses: ['open'], limit: 5000 }),
    ]);
    const dealKeys = knownDealKeys(score, aliases);
    if (submission) {
      const [secureDocumentAuthority, uploadRequestAuthority] = await Promise.all([
        boundedAuthorityRead(storage, 'listSecureDocumentsForSubmission', [], submission.id),
        boundedAuthorityRead(storage, 'getLatestSecureUploadRequestForSubmission', null, submission.id),
      ]);
      secureDocuments = secureDocumentAuthority.value;
      latestUploadRequest = uploadRequestAuthority.value;
      materialsAuthorityAvailable = secureDocumentAuthority.available && uploadRequestAuthority.available;
    } else {
      secureDocuments = [];
      latestUploadRequest = null;
    }
    const [canonicalRequests, aliasRequests, knownDispositions] = await Promise.all([
      requiredAuthorityRead(storage, 'listDealHunterCimRequests', { opportunityIds: [id], detailAuthority: true, limit: 100 }),
      dealKeys.length > 0 ? requiredAuthorityRead(storage, 'listDealHunterCimRequests', { dealKeys, limit: 500 }) : [],
      dealKeys.length > 0 ? requiredAuthorityRead(storage, 'listDealHunterDispositions', { dealKeys, limit: 500 }) : [],
    ]);
    requests = unionRequests(canonicalRequests, aliasRequests);
    dispositions = knownDispositions;
    if (Array.isArray(communicationSnapshot)) {
      communications = communicationSnapshot;
    } else if (submission) {
      const communicationAuthority = await boundedAuthorityRead(
        storage,
        'listCrmCommunications',
        { rows: [] },
        { submissionId: submission.id, page: 1, pageSize: 100 },
      );
      communications = Array.isArray(communicationAuthority.value?.rows)
        ? communicationAuthority.value.rows
        : [];
      communicationsAuthorityAvailable = communicationAuthority.available;
    }
  } catch {
    return unavailableAuthority({ opportunityId: id, opportunity, score, now: at });
  }
  const trustedSourceRows = sourceRows.filter((row) => text(row?.source_id || row?.sourceId, 200) && text(row?.source_record_id || row?.sourceRecordId, 200));
  const contacts = [
    ...sourceContactCandidates(trustedSourceRows),
    ...crmContactCandidates(submission),
    ...operatorContactCandidates(facts),
  ];
  const recipientOptions = issueContactOptions({ opportunityId: id, contacts, secret: config.admin.sessionSecret });
  const state = pursuedState(score);
  const materialsState = evaluateAcquisitionMaterialsState({ submission, secureDocuments, latestUploadRequest });
  const terminalReason = materialsState.materialsReceived
    ? 'materials-received'
    : materialsState.advancedBeyondBrokerOutreach
      ? 'advanced-beyond-broker-outreach'
      : '';
  const existingRequest = projectExistingRequest(requests, {
    now: at,
    terminalReason,
    materialsAuthorityAvailable,
    communications,
  });
  const manualEligibility = evaluateDealHunterCimEligibility({
    deal: {
      opportunityId: id,
      dealKey: score.deal_key || '',
      identityStatus: identityExceptions.some((item) => (item.candidate_opportunity_ids || []).includes(id)) ? 'ambiguous' : 'resolved',
      shouldRemove: Boolean(score.should_remove),
      score: Number(score.fit_score || 0),
      annualProfit: numberOrNull(trustedSourceRows.find((row) => ['annual_profit', 'ttm_ebitda'].includes(text(row.field, 80).toLowerCase()))?.value),
    },
    recipientEmail: recipientOptions[0]?.email || '',
    policy: 'manual_stage_1',
  });
  const preparationBlockers = [];
  if (text(opportunity.status, 80).toLowerCase() !== 'active') preparationBlockers.push(blocker('canonical_authority_unavailable', 'The canonical opportunity is no longer current.'));
  if (!state.pursued) preparationBlockers.push(blocker(state.changed ? 'pursue_not_current' : 'not_pursued', state.changed ? 'The Pursue review is no longer current.' : 'Explicit current Pursue is required.'));
  if (score.should_remove) preparationBlockers.push(blocker('opportunity_not_actionable', 'The opportunity is removed or otherwise non-actionable.'));
  const currentDispositionState = currentDisposition(dispositions);
  if (currentDispositionState === 'dismissed') preparationBlockers.push(blocker('opportunity_passed', 'The opportunity is currently Passed.'));
  if (trustedSourceRows.length === 0) preparationBlockers.push(blocker('required_source_authority_unavailable', 'Required current source authority is unavailable.'));
  if (submission && text(submission.status, 80).toLowerCase() === 'archived') preparationBlockers.push(blocker('crm_owner_archived', 'The linked CRM record is archived.'));
  if (recipientOptions.length === 0) preparationBlockers.push(blocker('recipient_authority_unavailable', 'No current authoritative broker recipient is available.'));
  for (const common of manualEligibility.blockers.filter(({ code }) => !['recipient_missing', 'recipient_invalid', 'opportunity_removed'].includes(code))) {
    preparationBlockers.push(blocker(common.code, common.message));
  }
  if (existingRequest) preparationBlockers.push(blocker('existing_request', 'An existing durable CIM request already owns this opportunity.'));
  if (opportunityClaim && !existingRequest) preparationBlockers.push(blocker('existing_request_claim', 'A durable request claim already owns this opportunity.'));
  const aliasResolutionFingerprint = sha256(stableCanonicalJson(aliases.map((item) => ({
    type: text(item.alias_type, 80), key: text(item.alias_key, 1000), value: text(item.alias_value, 1000),
    confidence: text(item.confidence_state, 80), version: text(item.evidence_version, 160),
  })).sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right)))));
  const authorityRevision = sha256(stableCanonicalJson({
    opportunity: { id, status: text(opportunity.status, 80), version: text(opportunity.identity_version, 160), updatedAt: currentTimestamp(opportunity) },
    score: { fingerprint: text(score.score_fingerprint, 200), semanticDigest: text(score.semantic_digest, 200), fitScore: numberOrNull(score.fit_score), annualProfit: numberOrNull(trustedSourceRows.find((row) => ['annual_profit', 'ttm_ebitda'].includes(text(row.field, 80).toLowerCase()))?.value), priority: text(score.operator_priority, 40), reviewedAt: iso(score.reviewed_at), changed: state.changed },
    sourceAuthority: trustedSourceRows.map((row) => ({ id: text(row.id, 200), sourceId: text(row.source_id, 200), recordId: text(row.source_record_id, 200), field: text(row.field, 80), valueHash: sha256(text(row.value, 5000)), updatedAt: currentTimestamp(row) })).sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right))),
    contacts: recipientOptions.map(({ provenanceFingerprint, contactAuthorityRevision }) => ({ provenanceFingerprint, contactAuthorityRevision })).sort((left, right) => left.provenanceFingerprint.localeCompare(right.provenanceFingerprint)),
    aliasResolutionFingerprint,
    senderAuthority: {
      displayName: text(config.workflow?.defaultAssignee, 120),
      fromEmail: email(config.delivery?.resendFromEmail || config.delivery?.fallbackRecipient),
      replyTo: email(config.delivery?.resendReplyTo),
    },
    templateVersion: BROKER_MATERIALS_TEMPLATE_VERSION,
  }));
  const sourceExpiries = trustedSourceRows.map((row) => Date.parse(row.expires_at || row.expiresAt || '')).filter((value) => Number.isFinite(value) && value > at.getTime());
  return {
    opportunityId: id,
    opportunity,
    score,
    aliases,
    facts,
    sourceRows: trustedSourceRows,
    submission,
    requests,
    dispositions,
    currentDispositionState,
    communications,
    materialsState,
    materialsAuthorityAvailable,
    communicationsAuthorityAvailable,
    terminalReason,
    existingRequest,
    opportunityClaim,
    safety,
    recipientOptions,
    warnings: manualEligibility.warnings,
    preparationBlockers: uniqueBlockers(preparationBlockers),
    sendBlockers: [],
    pursued: state.pursued,
    authorityRevision,
    aliasResolutionFingerprint,
    requiredAuthorityExpiresAt: sourceExpiries.length > 0 ? new Date(Math.min(...sourceExpiries)).toISOString() : '',
    now: at,
  };
}

async function selectedSendBlockers({ authority, selectedRecipient, storage, now }) {
  const config = getConfig();
  const blockers = [];
  const pause = await getCimOutreachPauseStatus({ storage, config });
  if (pause.paused) blockers.push(blocker('cim_outreach_paused', 'Deal Hunter CIM outreach is globally paused.'));
  if (!selectedRecipient) return blockers;
  const [suppression, recipientClaim, recipientPolicy, readiness] = await Promise.all([
    optionalRead(() => storage?.getActiveEmailSuppression?.(selectedRecipient.email), null),
    optionalRead(() => storage?.getDealHunterCimRecipientClaim?.(selectedRecipient.email), null),
    optionalRead(() => evaluateCimRecipientPolicy({ recipientEmail: selectedRecipient.email, opportunityId: authority.opportunityId, storage, config, now }), { allowed: true }),
    optionalRead(() => getEmailReadiness({ storage, config }), { outboundConfigured: false, issues: ['Provider readiness is unavailable.'] }),
  ]);
  if (suppression) blockers.push(blocker('recipient_suppressed', 'The selected recipient is globally suppressed from outreach.'));
  if (!recipientPolicy.allowed && ['recipient-24-hour-cap', 'recipient-30-day-cap'].includes(recipientPolicy.reason)) {
    blockers.push(blocker('recipient_cadence', 'The selected recipient has reached the current CIM cadence cap.'));
  }
  if (recipientClaim && recipientClaim.request_id !== buildDealHunterCimRequestId(authority.opportunityId, selectedRecipient.email)
    && Date.parse(recipientClaim.expires_at || '') > normalizedNow(now).getTime()) {
    blockers.push(blocker('recipient_claim_in_progress', 'Another current transmission claim exists for this recipient.'));
  }
  if (!readiness.outboundConfigured) blockers.push(blocker('provider_not_ready', text(readiness.issues?.[0], 500) || 'The outbound provider is not production-ready.'));
  return uniqueBlockers(blockers);
}

export async function projectDealHunterBrokerMaterials({ opportunityId = '', storage, now = new Date(), communicationSnapshot } = {}) {
  const authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now, communicationSnapshot });
  const autoSelected = authority.recipientOptions.length === 1
    ? authority.recipientOptions[0]
    : authority.recipientOptions.filter((item) => item.primary).length === 1
      ? authority.recipientOptions.find((item) => item.primary)
      : null;
  const sendBlockers = autoSelected ? await selectedSendBlockers({ authority, selectedRecipient: autoSelected, storage, now }) : [];
  return {
    existingRequest: authority.existingRequest,
    pursued: authority.pursued,
    preparationBlockers: authority.preparationBlockers,
    sendBlockers,
    warnings: authority.warnings,
    recipientOptions: authority.recipientOptions.map(({ provenanceFingerprint: _fingerprint, contactAuthorityRevision: _revision, firstName: _firstName, ...option }) => option),
  };
}

function preparationError(authority, code, message, status = 409) {
  return {
    success: false,
    status,
    code,
    error: message,
    recipientOptions: authority.recipientOptions.map(({ provenanceFingerprint: _fingerprint, contactAuthorityRevision: _revision, firstName: _firstName, ...option }) => option),
    warnings: authority.warnings,
    preparationBlockers: authority.preparationBlockers,
    sendBlockers: authority.sendBlockers,
  };
}

function publicRecipientOptions(authority) {
  return authority.recipientOptions.map(({ provenanceFingerprint: _fingerprint, contactAuthorityRevision: _revision, firstName: _firstName, ...option }) => option);
}

function defaultGreeting(recipient) {
  return recipient.firstName ? `Hi ${recipient.firstName},` : 'Hello,';
}

function buildCurrentApprovedProposal({ authority, selectedRecipient, greeting, requestedBy = 'admin' } = {}) {
  const prospectiveRequestId = buildDealHunterCimRequestId(authority.opportunityId, selectedRecipient.email);
  const message = buildDealHunterCimRequestEmail({
    to: selectedRecipient.email,
    deal: {
      opportunityId: authority.opportunityId,
      dealKey: authority.score.deal_key || '',
      name: authority.opportunity.canonical_name || authority.score.name || 'the listed business',
      industry: authority.sourceRows.find((row) => text(row.field, 80).toLowerCase() === 'industry')?.value || '',
      location: authority.opportunity.canonical_location || '',
      listingUrl: authority.sourceRows.find((row) => text(row.field, 80).toLowerCase() === 'listing_url')?.value || authority.score.listing_url || '',
      brokerName: selectedRecipient.displayName,
      score: authority.score.fit_score,
    },
    requestedBy,
    cimRequestId: prospectiveRequestId,
    submissionId: authority.submission?.id || '',
    manualStage1: { greeting },
  });
  const config = getConfig();
  const sender = {
    displayName: text(config.workflow?.defaultAssignee, 120) || 'Mathew Uckele',
    email: email(config.delivery?.resendFromEmail || config.delivery?.fallbackRecipient),
    replyTo: email(message.replyTo),
  };
  const review = {
    opportunity: {
      canonicalOpportunityId: authority.opportunityId,
      displayName: text(authority.opportunity.canonical_name || authority.score.name, 500),
      sourceLabel: text(authority.sourceRows[0]?.source_name, 160),
      listingUrl: text(authority.sourceRows.find((row) => text(row.field, 80).toLowerCase() === 'listing_url')?.value || authority.score.listing_url, 2000),
      pursued: true,
      current: true,
      score: numberOrNull(authority.score.fit_score),
      automatedScoreThreshold: 75,
      annualProfit: numberOrNull(authority.sourceRows.find((row) => ['annual_profit', 'ttm_ebitda'].includes(text(row.field, 80).toLowerCase()))?.value),
    },
    recipient: {
      contactRef: selectedRecipient.recipientContactRef,
      displayName: selectedRecipient.displayName,
      email: selectedRecipient.email,
      provenance: selectedRecipient.provenance,
    },
    sender,
    message: {
      requestType: 'cim_request',
      channel: 'email',
      greeting,
      subject: message.subject,
      body: message.text,
      html: message.html,
      templateVersion: message.templateVersion,
    },
  };
  const approvalBoundPayload = {
    canonicalOpportunityId: authority.opportunityId,
    authorityRevision: authority.authorityRevision,
    aliasResolutionFingerprint: authority.aliasResolutionFingerprint,
    prospectiveRequestId,
    recipientContactRef: selectedRecipient.recipientContactRef,
    recipientEmail: selectedRecipient.email,
    recipientProvenanceFingerprint: selectedRecipient.provenanceFingerprint,
    senderEmail: sender.email,
    senderDisplayName: sender.displayName,
    replyTo: sender.replyTo,
    greeting,
    subject: message.subject,
    bodyText: message.text,
    bodyHtml: message.html,
    templateVersion: BROKER_MATERIALS_TEMPLATE_VERSION,
    warningContext: authority.warnings.map(({ code, value, automatedThreshold }) => ({ code, value, ...(automatedThreshold !== undefined ? { automatedThreshold } : {}) })),
  };
  return { prospectiveRequestId, message, sender, review, approvalBoundPayload };
}

export async function prepareDealHunterBrokerMaterials({
  opportunityId = '',
  recipientContactRef,
  greeting,
  session = {},
  storage,
  now = new Date(),
} = {}) {
  let input;
  try {
    input = parseBrokerMaterialsPreparationInput({
      ...(recipientContactRef !== undefined ? { recipientContactRef } : {}),
      ...(greeting !== undefined ? { greeting } : {}),
    });
  } catch (error) {
    return { success: false, status: 400, code: 'invalid_preparation_input', error: error.message };
  }
  const authority = await loadBrokerMaterialsAuthority({ opportunityId, storage, now });
  if (authority.preparationBlockers.length > 0) {
    const first = authority.preparationBlockers[0];
    return preparationError(authority, first.code, first.message, authority.authorityStatus || 409);
  }
  let selectedRecipient = null;
  if (session.role === 'admin' && input.recipientContactRef) {
    selectedRecipient = authority.recipientOptions.find((item) => item.recipientContactRef === input.recipientContactRef) || null;
    if (!selectedRecipient) return preparationError(authority, 'recipient_contact_stale', 'The selected recipient contact reference is stale or invalid.');
  } else if (authority.recipientOptions.length === 1) {
    selectedRecipient = authority.recipientOptions[0];
  } else {
    const primaries = authority.recipientOptions.filter((item) => item.primary);
    if (primaries.length === 1) selectedRecipient = primaries[0];
  }
  if (!selectedRecipient) {
    if (session.role === 'viewer') {
      return {
        success: true,
        previewOnly: true,
        code: 'recipient_selection_required',
        review: null,
        recipientOptions: publicRecipientOptions(authority),
        warnings: authority.warnings,
        sendBlockers: [blocker('administrator_required', 'An administrator must select the recipient and prepare a new request.')],
      };
    }
    return preparationError(authority, 'recipient_selection_required', 'Select one authoritative broker recipient before preparing the request.');
  }
  const preparedAt = normalizedNow(now);
  const selectedGreeting = session.role === 'admin' && input.greeting ? input.greeting : defaultGreeting(selectedRecipient);
  const { review, approvalBoundPayload } = buildCurrentApprovedProposal({
    authority,
    selectedRecipient,
    greeting: selectedGreeting,
    requestedBy: session.username || 'admin',
  });
  const sendBlockers = await selectedSendBlockers({ authority, selectedRecipient, storage, now: preparedAt });
  if (session.role !== 'admin') {
    return {
      success: true,
      previewOnly: true,
      review,
      recipientOptions: publicRecipientOptions(authority),
      warnings: authority.warnings,
      sendBlockers: [blocker('administrator_required', 'An administrator must prepare and approve this request.')],
    };
  }
  const config = getConfig();
  const expiry = Math.min(
    preparedAt.getTime() + preparationLifetimeMs,
    authority.requiredAuthorityExpiresAt ? Date.parse(authority.requiredAuthorityExpiresAt) : Number.POSITIVE_INFINITY,
  );
  const expiresAt = new Date(expiry).toISOString();
  const proposalDigest = sha256(stableCanonicalJson(approvalBoundPayload));
  const claims = {
    typ: preparationType,
    version: 1,
    intent: 'manual_stage_1',
    requestType: 'cim_request',
    administratorPrincipalId: text(session.principal_id, 300),
    canonicalOpportunityId: authority.opportunityId,
    approvalBoundPayload,
    proposalDigest,
    nonce: randomUUID(),
    preparedAt: preparedAt.toISOString(),
    exp: expiry,
  };
  return {
    success: true,
    previewOnly: false,
    preparationToken: signPayload(claims, config.admin.sessionSecret),
    proposalDigest,
    preparedAt: claims.preparedAt,
    expiresAt,
    review,
    recipientOptions: publicRecipientOptions(authority),
    warnings: authority.warnings,
    sendBlockers,
  };
}

function decodeAuthenticPreparationToken(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { claims: null, expired: false };
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { claims: null, expired: false };
    if (!safeCompareText(signPayload(claims, secret), String(token))) return { claims: null, expired: false };
    if (!Number.isFinite(claims.exp) || claims.exp <= Date.now()) return { claims: null, expired: true };
    return { claims: verifySignedPayload(token, secret), expired: false };
  } catch {
    return { claims: null, expired: false };
  }
}

function approvalFailure(code, error, status = 409, extras = {}) {
  return { success: false, status, code, error, ...extras };
}

function durableApprovalResult(canonicalOpportunityId, cimRequest) {
  return {
    success: true,
    canonicalOpportunityId,
    durableResult: { cimRequest: projectExistingRequest([cimRequest]) },
  };
}

export async function approveDealHunterBrokerMaterials({
  opportunityId = '',
  preparationToken,
  approvedProposalDigest,
  session = {},
  storage,
  now = new Date(),
  executeApprovedCimRequest = executeApprovedDealHunterCimRequest,
} = {}) {
  let input;
  try {
    input = parseBrokerMaterialsApprovalInput({ preparationToken, approvedProposalDigest });
  } catch (error) {
    return approvalFailure('invalid_approval_input', error.message, 400);
  }
  const config = getConfig();
  const verified = decodeAuthenticPreparationToken(input.preparationToken, config.admin.sessionSecret);
  if (verified.expired) {
    return approvalFailure('preparation_stale', 'The Broker Materials preparation expired. Prepare and review it again.', 409);
  }
  const claims = verified.claims;
  if (
    claims?.typ !== preparationType
    || claims.version !== 1
    || claims.intent !== 'manual_stage_1'
    || claims.requestType !== 'cim_request'
    || !claims.approvalBoundPayload
    || typeof claims.approvalBoundPayload !== 'object'
    || Array.isArray(claims.approvalBoundPayload)
  ) {
    return approvalFailure('invalid_preparation', 'The Broker Materials preparation is invalid.', 400);
  }
  const canonicalOpportunityId = text(opportunityId, 200);
  if (
    !safeCompareText(claims.canonicalOpportunityId, canonicalOpportunityId)
    || !safeCompareText(claims.approvalBoundPayload.canonicalOpportunityId, canonicalOpportunityId)
  ) {
    return approvalFailure('preparation_mismatch', 'The preparation does not match this canonical opportunity.', 409);
  }
  const principalId = text(session.principal_id, 300);
  if (!principalId || !safeCompareText(claims.administratorPrincipalId, principalId)) {
    return approvalFailure('preparation_mismatch', 'The preparation belongs to a different administrator.', 403);
  }
  let recomputedDigest = '';
  try {
    recomputedDigest = sha256(stableCanonicalJson(claims.approvalBoundPayload));
  } catch {
    return approvalFailure('invalid_preparation', 'The Broker Materials preparation is invalid.', 400);
  }
  if (
    !safeCompareText(claims.proposalDigest, input.approvedProposalDigest)
    || !safeCompareText(recomputedDigest, input.approvedProposalDigest)
  ) {
    return approvalFailure('proposal_digest_mismatch', 'The approved proposal digest does not match the signed preparation.', 409);
  }

  const authority = await loadBrokerMaterialsAuthority({ opportunityId: canonicalOpportunityId, storage, now });
  if (authority.existingRequest) {
    return durableApprovalResult(canonicalOpportunityId, authority.existingRequest);
  }
  if (authority.preparationBlockers.length > 0) {
    return approvalFailure('preparation_stale', 'Current opportunity authority changed after preparation. Prepare and review it again.', 409);
  }
  const signed = claims.approvalBoundPayload;
  const selectedRecipient = authority.recipientOptions.find((candidate) => (
    safeCompareText(candidate.recipientContactRef, signed.recipientContactRef)
    && safeCompareText(candidate.email, signed.recipientEmail)
    && safeCompareText(candidate.provenanceFingerprint, signed.recipientProvenanceFingerprint)
  ));
  if (!selectedRecipient) {
    return approvalFailure('preparation_stale', 'The approved broker recipient is no longer current. Prepare and review it again.', 409);
  }
  let currentProposal;
  try {
    currentProposal = buildCurrentApprovedProposal({
      authority,
      selectedRecipient,
      greeting: signed.greeting,
      requestedBy: session.username || 'admin',
    }).approvalBoundPayload;
  } catch {
    return approvalFailure('preparation_stale', 'The approved message can no longer be reproduced from current authority.', 409);
  }
  if (!safeCompareText(stableCanonicalJson(currentProposal), stableCanonicalJson(signed))) {
    return approvalFailure('preparation_stale', 'Material Broker Materials authority changed after preparation. Prepare and review it again.', 409);
  }

  const approvedProposal = {
    ...signed,
    proposalDigest: claims.proposalDigest,
    nonce: claims.nonce,
    preparedAt: claims.preparedAt,
    intent: claims.intent,
    requestType: claims.requestType,
  };
  const result = await executeApprovedCimRequest({
    approvedProposal,
    requestedBy: session.username || 'admin',
    administratorPrincipalId: principalId,
    storage,
  });
  if (result?.request?.id) return durableApprovalResult(canonicalOpportunityId, result.request);
  return approvalFailure(
    result?.code || (result?.outreachPause ? 'cim_outreach_paused' : 'approval_blocked'),
    result?.error || 'The approved CIM request could not enter durable execution.',
    result?.status || 409,
    result?.outreachPause ? { sendBlockers: [blocker('cim_outreach_paused', result.error)] } : {},
  );
}
