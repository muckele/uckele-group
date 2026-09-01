// Operator triage over persisted Deal Hunter scores.
//
// The queue reads persisted score rows only. It never scores, so opening the
// workspace or paging through it cannot trigger a rebuild.
//
// Triage adds exactly one piece of new operator state: priority. Everything else
// it shows is derived from state that already exists -- "needs review" and
// "changed since reviewed" come from comparing the reviewed fingerprint with the
// current one, dismissal comes from the existing disposition record, and
// acquisition progress stays owned by the command center.

import { randomUUID } from 'node:crypto';
import { recordCrmActivity } from './activity.js';
import { getStorage } from '../storage/index.js';
import {
  dismissDealHunterOpportunity,
  normalizeDealHunterDispositionReason,
  restoreDealHunterOpportunity,
} from './leadLifecycle.js';
import { buildCimOpportunityAliases } from './cimOpportunityIdentity.js';
import {
  dealOperatorPriorities,
  normalizeDealOperatorPriority,
} from './dealHunterScoringPolicy.js';
import {
  getEffectiveOpportunityFacts,
  opportunityFactFields,
  opportunitySourceObservationFields,
} from './dealHunterOpportunityFacts.js';
import { firstStrictDetailAuthorityTimestamp } from './detailAuthorityTimestamp.js';
import { normalizeCanonicalCimRequestId } from './cimRequestIdPolicy.js';
import { getSourceHealth } from './acquisitionCommandCenter.js';

export const triageViews = Object.freeze([
  'needs-review',
  'high-priority',
  'watchlist',
  'low-confidence',
  'dismissed',
  'all',
]);

export const triageSorts = Object.freeze(['acquisition-priority', 'fit-score', 'confidence', 'completeness', 'scored-at', 'name', 'changed']);

const maxNoteLength = 2000;
const maxDispositionAuthorityCimRecords = 100000;

function normalizeText(value = '', maxLength = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function boundedPrimitive(value, maximum = 400) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? normalizeText(value, maximum) : '';
}

function normalizeView(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return triageViews.includes(normalized) ? normalized : 'needs-review';
}

function normalizeSort(value, fallback = 'fit-score') {
  const normalized = normalizeText(value, 40).toLowerCase();
  return triageSorts.includes(normalized) ? normalized : fallback;
}

function normalizeConfidence(value) {
  const normalized = normalizeText(value, 20).toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : '';
}

function normalizeBoundedInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), maximum));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(normalized) ? normalized : null;
}

function queueGeography(row = {}) {
  const label = normalizeText(row.location, 240);
  const state = normalizeText(row.state, 40).toUpperCase();
  const [city = ''] = label.split(',');
  return {
    city: normalizeText(city, 160),
    state,
    label: label || state,
  };
}

function publicTriageSummary(summary = {}) {
  return {
    needsReview: Number(summary.needsReview || summary.needs_review || 0),
    highPriority: Number(summary.highPriority || summary.high_priority || 0),
    watchlist: Number(summary.watchlist || 0),
    lowConfidence: Number(summary.lowConfidence || summary.low_confidence || 0),
    currentOpportunities: Number(summary.currentOpportunities || summary.current_opportunities || 0),
  };
}

// The list row an operator scans. Fit and confidence stay separate values;
// there is deliberately no blended certainty number. Detail and decision
// responses can explicitly retain the persisted operator note.
export function publicTriageRow(row = {}, { includeOperatorNote = false } = {}) {
  return {
    opportunityId: row.opportunity_id,
    dealKey: row.deal_key || '',
    name: row.name || 'Unnamed opportunity',
    state: row.state || '',
    listingUrl: row.listing_url || '',
    fitScore: Number(row.fit_score || 0),
    scoreStatus: row.score_status || 'provisional',
    confidence: row.confidence || 'low',
    completenessScore: Number(row.completeness_score || 0),
    missingEvidenceCount: Number(row.missing_evidence_count || 0),
    contradictionCount: Number(row.contradiction_count || 0),
    shouldRemove: Boolean(row.should_remove),
    highFit: Boolean(row.high_fit),
    geography: queueGeography(row),
    industry: normalizeText(row.industry, 240),
    financials: {
      annualProfit: nullableNumber(row.annual_profit),
      annualRevenue: nullableNumber(row.annual_revenue),
      askingPrice: nullableNumber(row.asking_price),
      profitMultiple: nullableNumber(row.profit_multiple),
    },
    topStrength: normalizeText(row.top_strength, 400),
    topConcern: normalizeText(row.top_concern, 400),
    workflow: {
      crmStatus: normalizeText(row.crm_status, 80) || 'not-started',
      cimStatus: normalizeText(row.cim_status, 80) || 'not-requested',
    },
    observationFreshness: row.observation_freshness || row.scored_at || '',
    operatorPriority: row.operator_priority || 'normal',
    ...(includeOperatorNote ? { operatorNote: row.operator_note || '' } : {}),
    reviewed: Boolean(row.reviewed),
    reviewedAt: row.reviewed_at || '',
    reviewedBy: row.reviewed_by || '',
    changedSinceReview: Boolean(row.changed_since_review),
    dismissed: Boolean(row.dismissed_at || row.dismissed_reason),
    dismissedReason: row.dismissed_reason || '',
    scoredAt: row.scored_at || '',
    scoreFingerprint: row.score_fingerprint || '',
    rulesVersion: row.rules_version || '',
  };
}

export async function listTriageQueue({
  view = 'needs-review',
  page = 1,
  pageSize = 25,
  search = '',
  sort = '',
  direction = 'desc',
  minScore = null,
  confidence = '',
  priority = '',
  state = '',
  storage = getStorage(),
  getCachedSourceHealth = getSourceHealth,
} = {}) {
  if (typeof storage.listDealHunterOpportunityScores !== 'function') {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }
  const normalizedView = normalizeView(view);
  const normalizedSort = normalizeSort(
    sort,
    normalizedView === 'needs-review' ? 'acquisition-priority' : 'fit-score',
  );
  const normalizedDirection = normalizedSort === 'acquisition-priority'
    ? 'desc'
    : (normalizeText(direction, 8).toLowerCase() === 'asc' ? 'asc' : 'desc');
  const result = await storage.listDealHunterOpportunityScores({
    view: normalizedView,
    page: normalizeBoundedInteger(page, 1, 10000),
    pageSize: normalizeBoundedInteger(pageSize, 25, 100),
    search: normalizeText(search, 160),
    sort: normalizedSort,
    direction: normalizedDirection,
    minScore: minScore === null || minScore === '' || !Number.isFinite(Number(minScore)) ? null : Number(minScore),
    confidence: normalizeConfidence(confidence),
    priority: priority ? normalizeDealOperatorPriority(priority, '') : '',
    state: normalizeText(state, 12),
  });
  const sourceHealth = await getCachedSourceHealth(storage, { persistSnapshot: false, refresh: false });

  return {
    ok: true,
    status: 200,
    view: normalizedView,
    sort: normalizedSort,
    direction: normalizedDirection,
    rows: (result.rows || []).map(publicTriageRow),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    summary: publicTriageSummary(result.summary),
    sourceHealth,
    views: triageViews,
    priorities: dealOperatorPriorities,
  };
}

function safeListingUrl(value) {
  // Check the original primitive before whitespace normalization: otherwise a
  // newline/tab can be transformed into a harmless-looking encoded space.
  if (typeof value !== 'string') return '';
  const rawInput = value;
  if (rawInput.length === 0 || rawInput.length > 2000) return '';
  if ([...rawInput].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return '';
  const raw = rawInput.trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && parsed.href.length <= 2000
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

function detailText(value, max = 500) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value).replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function detailNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function detailStrings(values, { limit = 50, max = 500 } = {}) {
  return (Array.isArray(values) ? values : []).map((value) => detailText(value, max)).filter(Boolean).slice(0, limit);
}

function projectOperatorFact(item = {}) {
  return {
    id: detailText(item.id, 200), field: detailText(item.field, 80), value: detailText(item.value, 4000), verified: Boolean(item.verified),
    actor: detailText(item.actor, 160), note: detailText(item.note, 500), createdAt: detailText(item.created_at, 80), updatedAt: detailText(item.updated_at, 80),
  };
}

function projectEvidence(row = {}) {
  return {
    ruleId: detailText(row.rule_id, 160), ruleLabel: detailText(row.rule_label, 160), evidenceClass: detailText(row.evidence_class, 80),
    field: detailText(row.field, 80), value: detailText(row.value, 500), observedValue: detailText(row.observed_value, 500),
    terms: detailStrings(row.terms, { limit: 20, max: 160 }), sourceId: detailText(row.source_id, 200), sourceName: detailText(row.source_name, 160),
    sourceRecordId: detailText(row.source_record_id, 200), listingUrl: safeListingUrl(row.listing_url), observedAt: detailText(row.observed_at, 80),
  };
}

function directCrmFactRows(submission = {}) {
  if (!submission || typeof submission !== 'object') return [];
  const dealHunter = submission.metadata?.dealHunter && typeof submission.metadata.dealHunter === 'object'
    ? submission.metadata.dealHunter
    : {};
  const fields = [
    ['seller_name', ['seller_name', 'sellerName']],
    ['seller_email', ['seller_email', 'sellerEmail']],
    ['seller_phone', ['seller_phone', 'sellerPhone']],
    ['broker_name', ['broker_name', 'brokerName']],
    ['broker_company', ['broker_company', 'brokerCompany']],
    ['broker_email', ['broker_email', 'brokerEmail']],
    ['broker_phone', ['broker_phone', 'brokerPhone']],
    ['reason_for_sale', ['reason_for_sale', 'reasonForSale']],
    ['real_estate_included', ['real_estate_included', 'realEstateIncluded']],
    ['seller_financing', ['seller_financing', 'sellerFinancing']],
    ['management_structure', ['management_structure', 'managementStructure']],
    ['customer_concentration', ['customer_concentration', 'customerConcentration']],
    ['operator_contact_notes', ['operator_contact_notes', 'operatorContactNotes']],
  ];
  return fields.flatMap(([field, keys]) => {
    const value = keys.map((key) => submission[key] ?? dealHunter[key])
      .find((item) => ['string', 'number', 'boolean'].includes(typeof item) && detailText(item, 4000));
    return value === undefined ? [] : [{ field, value: detailText(value, 4000) }];
  });
}

function projectSourceObservations(rows = []) {
  const all = rows.slice(0, 500).flatMap((row) => {
    const field = boundedPrimitive(row?.field, 80);
    if (!opportunitySourceObservationFields.includes(field)) return [];
    return [{ sourceId: boundedPrimitive(row?.source_id, 200), sourceName: boundedPrimitive(row?.source_name, 160), sourceRecordId: boundedPrimitive(row?.source_record_id, 200), field, value: ['listing_url', 'prospectus_url', 'business_website'].includes(field) ? safeListingUrl(row?.value) : boundedPrimitive(row?.value, 5000), observedAt: boundedPrimitive(row?.observed_at, 80), updatedAt: boundedPrimitive(row?.updated_at, 80) }];
  });
  const valuesByField = new Map();
  for (const row of all) {
    const key = row.field;
    const values = valuesByField.get(key) || [];
    values.push(row);
    valuesByField.set(key, values);
  }
  const conflicts = [...valuesByField.entries()].flatMap(([field, values]) => {
    const distinct = new Set(values.map((item) => normalizeText(item.value, 5000)));
    return distinct.size > 1 ? [{ field, values }] : [];
  });
  const groups = new Map();
  for (const row of all) {
    const key = [row.sourceId, row.sourceRecordId].join('\u0000');
    const group = groups.get(key) || {
      sourceId: row.sourceId, sourceName: row.sourceName, sourceRecordId: row.sourceRecordId,
      observedAt: row.observedAt, values: {}, conflicts: [],
    };
    group.values[row.field] = row.value;
    if (Date.parse(row.observedAt || '') > Date.parse(group.observedAt || '')) group.observedAt = row.observedAt;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.conflicts = conflicts.flatMap((conflict) => {
      const members = conflict.values.filter((item) => item.sourceId === group.sourceId && item.sourceRecordId === group.sourceRecordId);
      if (members.length === 0) return [];
      // Attribute using every bounded internal row, then cap just the display
      // payload while retaining this group's representative observation.
      const representative = members[0];
      const peers = conflict.values.filter((item) => item !== representative).slice(0, 19);
      return [{ field: conflict.field, observations: [representative, ...peers].map(({ sourceId, sourceName, sourceRecordId, value, observedAt }) => ({ sourceId, sourceName, sourceRecordId, value, observedAt })) }];
    }).slice(0, 20);
  }
  return { sourceObservations: [...groups.values()].slice(0, 100), conflicts: conflicts.map(({ field, values }) => ({ field, observations: values.slice(0, 20) })) };
}

function detailAuthoritySignature(values = []) {
  return JSON.stringify(values.map(([value, maximum]) => detailText(value, maximum)));
}

function compareDetailAuthorityCandidates(left, right, { conservativeDismissal = false } = {}) {
  if (left.timestamp !== null && right.timestamp === null) return -1;
  if (left.timestamp === null && right.timestamp !== null) return 1;
  if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
  if (left.timestamp !== null && right.timestamp !== null && left.fractionalNanoseconds !== right.fractionalNanoseconds) {
    return right.fractionalNanoseconds - left.fractionalNanoseconds;
  }
  if (conservativeDismissal && left.state !== right.state) {
    if (left.state === 'dismissed') return -1;
    if (right.state === 'dismissed') return 1;
  }
  if (left.recordId || right.recordId) {
    if (!left.recordId) return 1;
    if (!right.recordId) return -1;
    if (left.recordId < right.recordId) return -1;
    if (left.recordId > right.recordId) return 1;
  }
  if (left.signature < right.signature) return -1;
  if (left.signature > right.signature) return 1;
  return 0;
}

function currentDetailSourceRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).slice(0, 500).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const field = detailText(row.field, 80).toLowerCase();
    const canonicalUrl = field === 'listing_url' ? safeListingUrl(row.value) : '';
    const value = field === 'listing_url' ? canonicalUrl : detailText(row.value, 5000);
    if (!field || !value) return [];
    const authorityAt = firstStrictDetailAuthorityTimestamp(row, [
      ['observed_at', 'observedAt'],
      ['updated_at', 'updatedAt'],
      ['created_at', 'createdAt'],
    ]);
    return [{
      field,
      value,
      canonicalUrl,
      observedAt: authorityAt.value,
      timestamp: authorityAt.timestamp,
      fractionalNanoseconds: authorityAt.fractionalNanoseconds,
      recordId: detailText(row.id, 200),
      signature: detailAuthoritySignature([
        [field, 80], [value, 5000], [row.source_id ?? row.sourceId, 200],
        [row.source_name ?? row.sourceName, 160], [row.source_record_id ?? row.sourceRecordId, 200],
        [authorityAt.value, 80], ...(field === 'listing_url' ? [[canonicalUrl, 2000]] : []),
      ]),
    }];
  }).sort(compareDetailAuthorityCandidates);
}

function currentDetailSourceValue(rows, fields, maximum = 500) {
  const allowed = new Set(fields);
  return detailText(rows.find((row) => allowed.has(row.field))?.value, maximum);
}

function currentDetailSourceNumber(rows, fields, fallback) {
  const allowed = new Set(fields);
  for (const row of rows) {
    if (!allowed.has(row.field)) continue;
    const value = nullableNumber(row.value);
    if (value !== null) return value;
  }
  return nullableNumber(fallback);
}

function currentDetailSourceListingUrl(rows) {
  for (const row of rows) {
    if (row.field !== 'listing_url') continue;
    if (row.canonicalUrl) return row.canonicalUrl;
  }
  return '';
}

function detailLocationParts(value) {
  const parts = detailText(value, 240).split(',').map((part) => detailText(part, 160)).filter(Boolean);
  return { city: parts[0] || '', state: parts.slice(1).join(', ') };
}

function currentDetailCimStatus(records, fallback) {
  const candidates = (Array.isArray(records) ? records : []).slice(0, 100).flatMap((record) => {
    const status = detailText(record?.status, 80);
    if (!status) return [];
    const authorityAt = firstStrictDetailAuthorityTimestamp(record, [
      ['updated_at', 'updatedAt'],
      ['created_at', 'createdAt'],
    ]);
    return [{
      status,
      timestamp: authorityAt.timestamp,
      fractionalNanoseconds: authorityAt.fractionalNanoseconds,
      recordId: detailText(record?.id, 200),
      signature: detailAuthoritySignature([
        [status, 80], [authorityAt.value, 80],
        [record?.updated_at ?? record?.updatedAt, 80], [record?.created_at ?? record?.createdAt, 80],
      ]),
    }];
  }).sort(compareDetailAuthorityCandidates);
  return candidates[0]?.status || fallback;
}

function canonicalDetailCimRequests(records) {
  const canonical = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const id = normalizeCanonicalCimRequestId(record.id);
    if (!id) continue;
    canonical.push({ ...record, id });
    if (canonical.length >= 100) break;
  }
  return canonical;
}

function currentDetailDisposition(records) {
  const candidates = (Array.isArray(records) ? records : []).slice(0, 20).flatMap((record) => {
    const state = detailText(record?.disposition, 80).toLowerCase();
    if (!state) return [];
    const dismissedAt = detailText(record?.dismissed_at ?? record?.dismissedAt, 80);
    const restoredAt = detailText(record?.restored_at ?? record?.restoredAt, 80);
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
      reason: detailText(record?.reason, 160),
      note: detailText(record?.note, 500),
      dismissedAt,
      dismissedBy: detailText(record?.dismissed_by ?? record?.dismissedBy, 160),
      timestamp: authorityAt.timestamp,
      fractionalNanoseconds: authorityAt.fractionalNanoseconds,
      recordId: detailText(record?.id, 200),
      signature: detailAuthoritySignature([
        [state, 80], [record?.reason, 160], [record?.note, 500], [dismissedAt, 80], [restoredAt, 80],
        [record?.dismissed_by ?? record?.dismissedBy, 160], [record?.restored_by ?? record?.restoredBy, 160],
        [authorityAt.value, 80],
      ]),
    }];
  }).sort((left, right) => compareDetailAuthorityCandidates(left, right, { conservativeDismissal: true }));
  const current = candidates[0];
  return current
    ? { state: current.state, reason: current.reason, note: current.note, dismissedAt: current.dismissedAt, dismissedBy: current.dismissedBy }
    : { state: '', reason: '', note: '', dismissedAt: '', dismissedBy: '' };
}

function projectDetailOpportunity({ score = {}, currentOpportunity = {}, sourceRows = [], submission = null, cimRequests = [], dispositions = [] } = {}) {
  const row = publicTriageRow(score, { includeOperatorNote: true });
  const sources = currentDetailSourceRows(sourceRows);
  const sourceLocation = currentDetailSourceValue(sources, ['location'], 240);
  const sourceCity = currentDetailSourceValue(sources, ['city'], 160);
  const sourceState = currentDetailSourceValue(sources, ['state'], 40);
  const parsedLocation = detailLocationParts(sourceLocation || currentOpportunity?.canonical_location || row.geography?.label);
  const city = sourceCity || parsedLocation.city || detailText(row.geography?.city, 160);
  const state = sourceState || parsedLocation.state || detailText(row.geography?.state, 40);
  const location = sourceLocation
    || (sourceCity || sourceState ? [sourceCity, sourceState].filter(Boolean).join(', ') : '')
    || detailText(currentOpportunity?.canonical_location, 240)
    || detailText(row.geography?.label, 240)
    || state;
  const topStrength = detailStrings(score.summary?.strengths, { limit: 1, max: 400 })[0] || detailText(row.topStrength, 400);
  const topConcern = detailStrings(score.summary?.concerns, { limit: 1, max: 400 })[0] || detailText(row.topConcern, 400);
  const crmStatus = detailText(submission?.status, 80) || detailText(row.workflow?.crmStatus, 80) || 'not-started';
  const cimStatus = currentDetailCimStatus(cimRequests, detailText(row.workflow?.cimStatus, 80) || 'not-requested');
  const observationFreshness = sources.find((source) => source.observedAt)?.observedAt
    || detailText(row.observationFreshness, 80);
  const disposition = currentDetailDisposition(dispositions);
  const dismissed = disposition.state === 'dismissed';
  const listingUrl = currentDetailSourceListingUrl(sources) || safeListingUrl(row.listingUrl);
  return {
    opportunityId: detailText(row.opportunityId, 200), dealKey: detailText(row.dealKey, 200), name: detailText(currentOpportunity?.canonical_name, 500) || currentDetailSourceValue(sources, ['name', 'business_name'], 500) || detailText(row.name, 500) || 'Unnamed opportunity', state: detailText(state, 40), listingUrl,
    fitScore: detailNumber(row.fitScore), scoreStatus: detailText(row.scoreStatus, 80), confidence: detailText(row.confidence, 80), completenessScore: detailNumber(row.completenessScore), missingEvidenceCount: detailNumber(row.missingEvidenceCount), contradictionCount: detailNumber(row.contradictionCount), shouldRemove: Boolean(row.shouldRemove), highFit: Boolean(row.highFit),
    geography: { city: detailText(city, 160), state: detailText(state, 40), label: detailText(location, 240) }, industry: currentDetailSourceValue(sources, ['industry'], 240) || detailText(row.industry, 240),
    financials: { annualProfit: currentDetailSourceNumber(sources, ['annual_profit', 'ttm_ebitda'], row.financials?.annualProfit), annualRevenue: currentDetailSourceNumber(sources, ['annual_revenue', 'ttm_revenue'], row.financials?.annualRevenue), askingPrice: currentDetailSourceNumber(sources, ['asking_price'], row.financials?.askingPrice), profitMultiple: currentDetailSourceNumber(sources, ['profit_multiple', 'ebitda_multiple'], row.financials?.profitMultiple) },
    topStrength, topConcern, workflow: { crmStatus, cimStatus }, observationFreshness, operatorPriority: detailText(row.operatorPriority, 40) || 'normal', operatorNote: detailText(row.operatorNote, 2000), reviewed: Boolean(row.reviewed), reviewedAt: detailText(row.reviewedAt, 80), reviewedBy: detailText(row.reviewedBy, 160), changedSinceReview: Boolean(row.changedSinceReview), disposition, dismissed, dismissedReason: dismissed ? disposition.reason : '', scoredAt: detailText(row.scoredAt, 80), scoreFingerprint: detailText(row.scoreFingerprint, 200), rulesVersion: detailText(row.rulesVersion, 160),
  };
}

function criticalMissingFields({ effectiveFacts, sourceRows, summary, listingUrls }) {
  const sourceValues = new Map();
  for (const row of sourceRows) {
    if (normalizeText(row.value, 5000)) sourceValues.set(row.field, row.value);
  }
  const financials = summary.financials || {};
  const present = (field, alternatives = []) => {
    if (effectiveFacts[field]?.value) return true;
    if (sourceValues.get(field)) return true;
    return alternatives.some((key) => financials[key] !== null && financials[key] !== undefined && financials[key] !== '');
  };
  const fields = [
    ['seller_name'], ['seller_email'], ['seller_phone'], ['broker_name'], ['broker_email'], ['broker_phone'],
    ['annual_profit', ['annualProfit']], ['annual_revenue', ['annualRevenue']], ['asking_price', ['askingPrice']],
    ['customer_concentration'], ['management_structure'], ['reason_for_sale'], ['real_estate_included'], ['seller_financing'],
  ];
  const missing = fields.filter(([field, alternatives]) => !present(field, alternatives)).map(([field]) => field);
  if (listingUrls.length === 0) missing.push('listing_url');
  return missing;
}

function projectScore(score, byDimension, unattributed) {
  const projectRule = (item) => ({ ruleId: detailText(item?.rule_id || item?.ruleId, 160), reason: detailText(item?.reason, 500), cap: detailNumber(item?.cap), value: detailNumber(item?.value) });
  return {
    fitScore: detailNumber(score.fit_score), scoreStatus: detailText(score.score_status, 80) || 'provisional', confidence: detailText(score.confidence, 80) || 'low', completenessScore: detailNumber(score.completeness_score),
    dimensions: (Array.isArray(score.dimensions) ? score.dimensions : []).slice(0, 7).map((dimension) => ({ id: detailText(dimension?.id, 80), label: detailText(dimension?.label, 160), contribution: detailNumber(dimension?.contribution), evidence: (byDimension.get(dimension?.id) || []).slice(0, 100) })),
    unattributedEvidence: unattributed.slice(0, 100), appliedCaps: detailStrings(score.applied_caps, { limit: 50, max: 500 }).length ? detailStrings(score.applied_caps, { limit: 50, max: 500 }) : (Array.isArray(score.applied_caps) ? score.applied_caps.slice(0, 50).map(projectRule) : []),
    gates: Array.isArray(score.gates) ? score.gates.slice(0, 50).map(projectRule) : [], confidenceReasons: detailStrings(score.confidence_reasons),
    missingEvidence: detailStrings(score.missing_evidence), summary: { strengths: detailStrings(score.summary?.strengths, { limit: 20 }), concerns: detailStrings(score.summary?.concerns, { limit: 20 }) },
  };
}

function projectCrmSubmission(submission) {
  if (!submission) return null;
  return {
    id: detailText(submission.id, 200), status: detailText(submission.status, 80), company: detailText(submission.company, 500),
    sellerName: detailText(submission.seller_name || submission.sellerName, 500), sellerEmail: detailText(submission.seller_email || submission.sellerEmail, 500),
    brokerName: detailText(submission.broker_name || submission.brokerName || submission.metadata?.dealHunter?.brokerName, 500),
    brokerEmail: detailText(submission.broker_email || submission.brokerEmail || submission.metadata?.dealHunter?.brokerEmail, 500), updatedAt: detailText(submission.updated_at, 80),
  };
}

export async function getTriageOpportunityDetail({ opportunityId = '', storage = getStorage() } = {}) {
  const id = normalizeText(opportunityId, 200);
  if (!id) return { ok: false, status: 400, error: 'A canonical opportunity id is required.' };
  if (
    typeof storage.getCurrentDealHunterOpportunityScore !== 'function'
    || typeof storage.getCurrentDealHunterOpportunity !== 'function'
  ) {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }
  const [currentOpportunity, score] = await Promise.all([
    storage.getCurrentDealHunterOpportunity(id), storage.getCurrentDealHunterOpportunityScore(id),
  ]);
  if (!currentOpportunity || !score) return { ok: false, status: 404, error: 'No current score has been recorded for this opportunity.' };
  const evidence = await storage.listDealHunterScoreEvidence?.(id, { limit: 500 }) || [];

  // Evidence is grouped by dimension so an operator sees why a dimension landed
  // where it did without reading raw rows.
  const byDimension = new Map();
  const unattributed = [];
  for (const row of evidence) {
    const projected = projectEvidence(row);
    if (!row.dimension) {
      unattributed.push(projected);
      continue;
    }
    const rows = byDimension.get(row.dimension) || [];
    rows.push(projected);
    byDimension.set(row.dimension, rows);
  }

  const [operatorFacts, sourceRows, submission, cimRequests, activities, dispositions, crmCommunications] = await Promise.all([
    storage.listDealHunterOpportunityFacts?.(id, { limit: 100 }) || [],
    storage.listDealHunterOpportunitySourceObservations?.(id, { limit: 500 }) || [],
    currentOpportunity.primary_submission_id && storage.getSubmission
      ? storage.getSubmission(currentOpportunity.primary_submission_id)
      : null,
    storage.listDealHunterCimRequests?.({ opportunityIds: [id], detailAuthority: true, limit: 100 }) || [],
    currentOpportunity.primary_submission_id && storage.listCrmActivityEvents
      ? storage.listCrmActivityEvents({ submissionId: currentOpportunity.primary_submission_id, limit: 100 })
      : [],
    storage.listDealHunterDispositions?.({ dealKeys: [score.deal_key], limit: 20 }) || [],
    currentOpportunity.primary_submission_id && storage.listCrmCommunications
      ? storage.listCrmCommunications({ submissionId: currentOpportunity.primary_submission_id, page: 1, pageSize: 100 })
      : { rows: [] },
  ]);
  const sanitizedOperatorFacts = operatorFacts
    .filter((fact) => fact && typeof fact === 'object' && opportunityFactFields.includes(fact.field))
    .slice(0, 100);
  const canonicalCimRequests = canonicalDetailCimRequests(cimRequests);
  const sourceFacts = sourceRows.filter((row) => opportunityFactFields.includes(row.field) || row.field === 'broker_contact');
  const crmFacts = directCrmFactRows(submission);
  const effectiveFacts = getEffectiveOpportunityFacts({
    opportunityId: id,
    operatorFacts: sanitizedOperatorFacts,
    crmFacts,
    sourceFacts,
  });
  const { sourceObservations } = projectSourceObservations(sourceRows);
  const listingUrls = [...new Set([
    safeListingUrl(score.listing_url),
    ...sourceRows
      .filter((row) => row.field === 'listing_url')
      .map((row) => safeListingUrl(row.value)),
  ].filter(Boolean))].slice(0, 100);
  const opportunity = projectDetailOpportunity({
    score,
    currentOpportunity,
    sourceRows,
    submission,
    cimRequests: canonicalCimRequests,
    dispositions,
  });
  const projectedScore = projectScore(score, byDimension, unattributed);
  const communications = (crmCommunications?.rows || []).slice(0, 100).map((communication) => ({
    id: detailText(communication.id, 200), direction: detailText(communication.direction, 80), channel: detailText(communication.channel, 80),
    kind: detailText(communication.kind, 80), occurredAt: detailText(communication.occurred_at, 80), cimRequestId: detailText(communication.cim_request_id, 200),
  }));
  return {
    ok: true,
    status: 200,
    opportunity,
    effectiveFacts,
    operatorFacts: sanitizedOperatorFacts.map(projectOperatorFact),
    sourceObservations,
    missingCriticalFields: criticalMissingFields({ effectiveFacts, sourceRows, summary: opportunity, listingUrls }),
    listingUrls,
    score: projectedScore,
    cimSummary: {
      requests: canonicalCimRequests.map((item) => ({ id: item.id, status: detailText(item.status, 80), updatedAt: detailText(item.updated_at, 80) })),
      communications: communications.filter((communication) => communication.cimRequestId),
    },
    crmSummary: {
      submission: projectCrmSubmission(submission), communications,
      factObservations: crmFacts.slice(0, 13).map((fact) => ({ field: detailText(fact.field, 80), value: detailText(fact.value, 4000), provenance: 'crm' })),
      conflicts: crmFacts.filter((fact) => effectiveFacts[fact.field]?.provenance !== 'crm' && effectiveFacts[fact.field]?.value !== String(fact.value).trim())
        .map((fact) => ({ field: detailText(fact.field, 80), winningProvenance: detailText(effectiveFacts[fact.field]?.provenance, 80), crmValue: detailText(fact.value, 4000) })).slice(0, 13),
    },
    history: {
      activities: activities.slice(0, 100).map((item) => ({ id: detailText(item.id, 200), eventType: detailText(item.event_type, 80), summary: detailText(item.summary, 500), createdAt: detailText(item.created_at, 80), actor: detailText(item.actor, 160) })),
      dispositions: dispositions.slice(0, 20).map((item) => ({ id: detailText(item.id, 200), disposition: detailText(item.disposition, 80), reason: detailText(item.reason, 160), note: detailText(item.note, 500), dismissedAt: detailText(item.dismissed_at, 80), dismissedBy: detailText(item.dismissed_by, 160) })),
      operatorFacts: sanitizedOperatorFacts.map(projectOperatorFact),
      operatorState: { priority: detailText(opportunity.operatorPriority, 40), note: detailText(opportunity.operatorNote, 2000), reviewed: Boolean(opportunity.reviewed), reviewedAt: detailText(opportunity.reviewedAt, 80), reviewedBy: detailText(opportunity.reviewedBy, 160) },
    },
  };
}

/**
 * Record an operator decision.
 *
 * Only priority, note, and review acknowledgement are writable. There is no
 * numeric score override: the machine's judgment and the human's judgment stay
 * separately legible.
 */
export async function setTriageOperatorDecision({
  opportunityId = '',
  priority,
  note,
  markReviewed = false,
  actor = 'admin',
  storage = getStorage(),
} = {}) {
  const id = normalizeText(opportunityId, 200);
  if (!id) return { ok: false, status: 400, error: 'A canonical opportunity id is required.' };
  if (
    typeof storage.setDealHunterOpportunityOperatorDecision !== 'function'
    || typeof storage.getCurrentDealHunterOpportunityScore !== 'function'
  ) {
    return { ok: false, status: 503, error: 'Opportunity scoring storage is unavailable.' };
  }

  const current = await storage.getCurrentDealHunterOpportunityScore(id);
  if (!current) return { ok: false, status: 404, error: 'No score has been recorded for this opportunity.' };

  const decision = { opportunityId: id };
  if (priority !== undefined) {
    const normalized = normalizeDealOperatorPriority(priority, '');
    if (!normalized) {
      return { ok: false, status: 400, error: `Priority must be one of ${dealOperatorPriorities.join(', ')}.` };
    }
    decision.priority = normalized;
  }
  if (note !== undefined) decision.note = note === null ? null : normalizeText(note, maxNoteLength);
  if (markReviewed) {
    decision.reviewed = true;
    decision.reviewedBy = normalizeText(actor, 160) || 'admin';
    // Snapshotting what the operator actually saw is what makes "changed since
    // reviewed" meaningful later. The semantic digest is the one that decides
    // staleness; the fingerprint is kept for provenance and legacy rows.
    decision.reviewedFingerprint = current.score_fingerprint;
    decision.reviewedSemanticDigest = current.semantic_digest;
  }
  if (decision.priority === undefined && decision.note === undefined && !decision.reviewed) {
    return { ok: false, status: 400, error: 'No operator decision was provided.' };
  }

  let updated;
  try {
    updated = await storage.setDealHunterOpportunityOperatorDecision(decision);
  } catch (error) {
    if (error?.code === 'DEAL_HUNTER_OPPORTUNITY_DISMISSED' || /already been passed|durably dismissed/i.test(error?.message || '')) {
      return { ok: false, status: 409, error: 'This opportunity has already been passed. Restore it before recording another decision.' };
    }
    throw error;
  }
  if (!updated) return { ok: false, status: 404, error: 'No current score has been recorded for this opportunity.' };

  const opportunity = await storage.getCurrentDealHunterOpportunity?.(id);
  const submissionId = opportunity?.primary_submission_id || '';
  if (submissionId) {
    const parts = [];
    if (decision.priority) parts.push(`priority ${decision.priority}`);
    if (decision.reviewed) parts.push('marked reviewed');
    if (decision.note !== undefined) parts.push('note updated');
    await recordCrmActivity({
      storage,
      submissionId,
      opportunityId: id,
      eventType: 'opportunity.triaged',
      summary: `Operator triage: ${parts.join(', ')}.`,
      actor: normalizeText(actor, 160) || 'admin',
      role: 'admin',
      metadata: {
        priority: decision.priority || updated?.operator_priority || null,
        markedReviewed: Boolean(decision.reviewed),
        reviewedFingerprint: decision.reviewedFingerprint || null,
        fitScoreAtDecision: current.fit_score,
      },
    });
  }

  return { ok: true, status: 200, opportunity: publicTriageRow(updated, { includeOperatorNote: true }) };
}

function publicPassDisposition(disposition = {}) {
  return {
    id: detailText(disposition.id, 200),
    disposition: detailText(disposition.disposition, 40),
    reason: detailText(disposition.reason, 80),
    note: detailText(disposition.note, 2000),
    dismissedAt: detailText(disposition.dismissed_at, 80),
    dismissedBy: detailText(disposition.dismissed_by, 160),
  };
}

export async function passTriageOpportunity({
  opportunityId = '',
  reason = '',
  note = '',
  actor = 'admin',
  storage = getStorage(),
} = {}) {
  const id = normalizeText(opportunityId, 200);
  if (!id) return { ok: false, status: 400, error: 'A canonical opportunity id is required.' };
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 80) {
    return { ok: false, status: 400, error: 'A bounded disposition reason is required.' };
  }
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > maxNoteLength)) {
    return { ok: false, status: 400, error: 'Disposition note must be a bounded string.' };
  }
  if (typeof storage.passDealHunterOpportunity !== 'function') {
    return { ok: false, status: 503, error: 'Atomic opportunity Pass storage is unavailable.' };
  }

  const normalizedReason = normalizeDealHunterDispositionReason(reason);
  if (!normalizedReason) return { ok: false, status: 400, error: 'A disposition reason is required.' };
  const now = new Date().toISOString();
  const normalizedActor = normalizeText(actor, 160) || 'admin';
  const result = await storage.passDealHunterOpportunity({
    opportunityId: id,
    reason: normalizedReason,
    note: note?.trim() || '',
    actor: normalizedActor,
    occurredAt: now,
    dispositionId: randomUUID(),
    archiveActivityId: randomUUID(),
    triageActivityId: randomUUID(),
  });

  if (!result?.applied) {
    const failures = {
      'not-current': [404, 'No current score has been recorded for this opportunity.'],
      'not-actionable': [409, 'This opportunity is not actionable in Acquisition Inbox.'],
      'already-passed': [409, 'This opportunity has already been passed. Restore it before recording another decision.'],
      'linked-submission-missing': [409, 'The linked CRM record is unavailable. Refresh before passing this opportunity.'],
      'cim-send-in-progress': [409, 'A CIM transmission is in progress. Retry Pass after it finishes.'],
    };
    const [status, error] = failures[result?.reason] || [409, 'Opportunity state changed before Pass could be saved.'];
    return { ok: false, status, error };
  }

  const disposition = publicPassDisposition(result.disposition);
  const opportunity = publicTriageRow({
    ...result.score,
    dismissed_at: result.disposition?.dismissed_at,
    dismissed_reason: result.disposition?.reason,
  }, { includeOperatorNote: true });
  return {
    ok: true,
    status: 200,
    action: 'pass',
    disposition,
    opportunity,
    archived: Boolean(result.archived),
  };
}

async function resolveDealHunterDispositionAuthority({ dealKey = '', storage = getStorage() } = {}) {
  const normalizedDealKey = typeof dealKey === 'string' ? normalizeText(dealKey, 1000) : '';
  if (!normalizedDealKey) {
    return { ok: true, canonical: false, dealKey: normalizedDealKey };
  }
  const authorityMethods = [
    'findCurrentDealHunterOpportunityByAliases',
    'getCurrentDealHunterOpportunity',
    'getCurrentDealHunterOpportunityScore',
    'getCurrentDealHunterOpportunityScoreByDealKey',
    'getDealHunterCrmImport',
    'listDealHunterCimRequests',
  ];
  if (authorityMethods.some((method) => typeof storage[method] !== 'function')) {
    return { ok: false, status: 503, error: 'Canonical Acquisition Inbox authority storage is unavailable.' };
  }

  // The legacy Dashboard payload names a deal and may carry a submission ID,
  // but canonical Pass authority comes only from durable server-owned links.
  // Exact score ownership covers the primary Inbox key; aliases cover prior
  // source keys; import and CIM rows preserve authoritative historical links.
  const aliasKeys = buildCimOpportunityAliases({ dealKey: normalizedDealKey })
    .map((item) => item.alias_key);
  let aliasOwner = null;
  try {
    aliasOwner = aliasKeys.length > 0
      ? await storage.findCurrentDealHunterOpportunityByAliases(aliasKeys)
      : null;
  } catch (error) {
    if (['DEAL_HUNTER_OPPORTUNITY_ALIAS_CONFLICT', 'DEAL_HUNTER_OPPORTUNITY_NOT_CURRENT'].includes(error?.code)) {
      return { ok: false, status: 409, error: 'This Deal Hunter key does not resolve to one current canonical opportunity.' };
    }
    throw error;
  }

  let scoreOwner = null;
  try {
    scoreOwner = await storage.getCurrentDealHunterOpportunityScoreByDealKey(normalizedDealKey);
  } catch (error) {
    if (error?.code === 'DEAL_HUNTER_CURRENT_DEAL_KEY_CONFLICT') {
      return { ok: false, status: 409, error: 'This Deal Hunter key does not resolve to one current canonical opportunity.' };
    }
    throw error;
  }

  const [importRecord, cimRequests] = await Promise.all([
    storage.getDealHunterCrmImport({ dealKey: normalizedDealKey }),
    storage.listDealHunterCimRequests({
      dealKeys: [normalizedDealKey],
      limit: maxDispositionAuthorityCimRecords,
    }),
  ]);
  if ((cimRequests || []).length >= maxDispositionAuthorityCimRecords) {
    return {
      ok: false,
      status: 409,
      error: 'This Deal Hunter key has too many CIM authority records to resolve safely.',
    };
  }
  const candidateIds = [...new Set([
    aliasOwner?.opportunity_id,
    scoreOwner?.opportunity_id,
    importRecord?.opportunity_id,
    ...(cimRequests || []).map((request) => request?.opportunity_id),
  ].map((value) => normalizeText(value, 200)).filter(Boolean))];
  const resolvedCandidates = await Promise.all(candidateIds.map(async (opportunityId) => ({
    opportunityId,
    current: await storage.getCurrentDealHunterOpportunity(opportunityId),
  })));
  if (resolvedCandidates.some((candidate) => !candidate.current)) {
    return {
      ok: false,
      status: 409,
      error: 'This Deal Hunter key references a non-current canonical opportunity.',
    };
  }
  const currentCandidates = resolvedCandidates.map((candidate) => candidate.current);
  const currentIds = [...new Set(currentCandidates.map((opportunity) => opportunity.opportunity_id))];

  if (currentIds.length > 1) {
    return { ok: false, status: 409, error: 'This Deal Hunter key has conflicting current canonical links.' };
  }
  if (currentIds.length === 1) {
    const opportunityId = currentIds[0];
    const currentScore = scoreOwner?.opportunity_id === opportunityId
      ? scoreOwner
      : await storage.getCurrentDealHunterOpportunityScore(opportunityId);
    if (!currentScore) {
      return { ok: false, status: 409, error: 'This canonical opportunity has no current Acquisition Inbox score.' };
    }
    const canonicalDealKey = normalizeText(currentScore.deal_key, 1000);
    if (!canonicalDealKey) {
      return { ok: false, status: 409, error: 'This canonical opportunity has no current Acquisition Inbox deal key.' };
    }
    return {
      ok: true,
      canonical: true,
      dealKey: canonicalDealKey,
      opportunityId,
    };
  }

  // No active canonical owner and no current Inbox score means this is a true
  // pre-Inbox lifecycle record. Preserve that bounded compatibility path.
  return { ok: true, canonical: false, dealKey: normalizedDealKey };
}

export async function dismissDealHunterOpportunityWithInboxAuthority({
  dealKey = '',
  listingUrl = '',
  dealName = '',
  reason = '',
  note = '',
  submissionId = '',
  actor = 'admin',
  storage = getStorage(),
} = {}) {
  const authority = await resolveDealHunterDispositionAuthority({ dealKey, storage });
  if (!authority.ok) return authority;
  if (authority.canonical) {
    return passTriageOpportunity({ opportunityId: authority.opportunityId, reason, note, actor, storage });
  }
  return dismissDealHunterOpportunity({
    dealKey: authority.dealKey, listingUrl, dealName, reason, note, submissionId, actor, storage,
  });
}

export async function restoreDealHunterOpportunityWithInboxAuthority({
  dealKey = '',
  actor = 'admin',
  storage = getStorage(),
} = {}) {
  const authority = await resolveDealHunterDispositionAuthority({ dealKey, storage });
  if (!authority.ok) return authority;
  return restoreDealHunterOpportunity({ dealKey: authority.dealKey, actor, storage });
}
