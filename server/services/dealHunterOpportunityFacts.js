import { randomUUID } from 'node:crypto';

export const opportunityFactFields = Object.freeze([
  'seller_name',
  'seller_email',
  'seller_phone',
  'broker_name',
  'broker_company',
  'broker_email',
  'broker_phone',
  'reason_for_sale',
  'real_estate_included',
  'seller_financing',
  'management_structure',
  'customer_concentration',
  'operator_contact_notes',
]);

const opportunityFactFieldSet = new Set(opportunityFactFields);

// This is intentionally broader than the operator-editable field set. It is
// the bounded structured projection emitted by the current Deal Hunter / Deal
// OS normalization model; raw source metadata never crosses this boundary.
export const opportunitySourceObservationFields = Object.freeze([
  'name',
  'business_name',
  'industry',
  'description',
  'city',
  'county',
  'state',
  'country',
  'location',
  'annual_profit',
  'annual_revenue',
  'asking_price',
  'profit_multiple',
  'net_margin',
  'years_established',
  'remote_flag',
  'franchise_flag',
  'five_years_flag',
  'broker_name',
  'broker_company',
  'broker_email',
  'broker_phone',
  'seller_name',
  'seller_email',
  'seller_phone',
  'reason_for_sale',
  'real_estate_included',
  'seller_financing',
  'management_structure',
  'customer_concentration',
  'operator_contact_notes',
  'listing_url',
  'listing_source',
  'listing_id',
  'deal_key',
  'source_identity',
  'date_added',
  'last_updated',
  'business_website',
  'prospectus_url',
  'ttm_revenue',
  'ttm_ebitda',
  'ebitda_multiple',
  'business_age',
  'sba_eligible',
  'lead_type',
]);

const opportunitySourceObservationFieldSet = new Set(opportunitySourceObservationFields);

function normalizeText(value, label, { required = true, maxLength = 4000 } = {}) {
  if (value === null || value === undefined) {
    if (!required) return null;
    throw new Error(`${label} is required.`);
  }
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${label} must be plain text, number, or boolean.`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    if (!required) return null;
    throw new Error(`${label} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

export function normalizeOpportunityFactField(field) {
  if (typeof field !== 'string') {
    throw new Error('Unsupported opportunity fact field.');
  }
  const normalized = field.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!opportunityFactFieldSet.has(normalized)) {
    throw new Error(`Unsupported opportunity fact field: ${String(field)}.`);
  }
  return normalized;
}

export function normalizeOpportunitySourceObservationField(field) {
  if (typeof field !== 'string') {
    throw new Error('Unsupported opportunity source-observation field.');
  }
  const normalized = field.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!opportunitySourceObservationFieldSet.has(normalized)) {
    throw new Error(`Unsupported opportunity source-observation field: ${String(field)}.`);
  }
  return normalized;
}

function normalizeTimestamp(value, label) {
  const normalized = normalizeText(value, label, { maxLength: 80 });
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp.`);
  return new Date(timestamp).toISOString();
}

export function normalizeOpportunitySourceObservation(observation = {}) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation) || Buffer.isBuffer(observation)) {
    throw new Error('Opportunity source observation must be an object.');
  }
  return {
    id: normalizeText(observation.id, 'Opportunity source observation id', { maxLength: 240 }),
    opportunity_id: normalizeText(observation.opportunity_id, 'Canonical opportunity id', { maxLength: 200 }),
    source_id: normalizeText(observation.source_id, 'Opportunity source id', { maxLength: 160 }),
    source_name: normalizeText(observation.source_name, 'Opportunity source name', { maxLength: 220 }),
    source_record_id: normalizeText(observation.source_record_id, 'Opportunity source record id', { maxLength: 200 }),
    field: normalizeOpportunitySourceObservationField(observation.field),
    value: normalizeText(observation.value, 'Opportunity source observation value', { maxLength: 5000 }),
    observed_at: normalizeTimestamp(observation.observed_at, 'Opportunity source observation timestamp'),
    created_at: normalizeTimestamp(observation.created_at, 'Opportunity source observation creation timestamp'),
    updated_at: normalizeTimestamp(observation.updated_at, 'Opportunity source observation update timestamp'),
  };
}

export async function setOperatorOpportunityFact({
  opportunityId,
  field,
  value,
  actor,
  verified = false,
  note = null,
  storage,
} = {}) {
  if (!storage || typeof storage.upsertDealHunterOpportunityFact !== 'function') {
    throw new Error('Opportunity fact storage is required.');
  }
  if (typeof verified !== 'boolean') {
    throw new Error('Opportunity fact verification state must be boolean.');
  }

  const now = new Date().toISOString();
  const fact = {
    id: randomUUID(),
    opportunity_id: normalizeText(opportunityId, 'Canonical opportunity id', { maxLength: 200 }),
    field: normalizeOpportunityFactField(field),
    value: normalizeText(value, 'Opportunity fact value'),
    source: 'operator',
    verified,
    actor: normalizeText(actor, 'Opportunity fact actor', { maxLength: 200 }),
    note: normalizeText(note, 'Opportunity fact note', { required: false, maxLength: 4000 }),
    created_at: now,
    updated_at: now,
  };
  return storage.upsertDealHunterOpportunityFact(fact);
}

function toFactRows(facts) {
  if (Array.isArray(facts)) return facts;
  if (!facts || typeof facts !== 'object') return [];
  if (Object.hasOwn(facts, 'field')) return [facts];
  return Object.entries(facts).map(([field, value]) => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? { field, ...value }
      : { field, value }
  ));
}

function isUsefulFact(row) {
  if (!row || typeof row !== 'object') return false;
  try {
    normalizeOpportunityFactField(row.field);
  } catch {
    return false;
  }
  return row.value !== null && row.value !== undefined && String(row.value).trim() !== '';
}

function compareOperatorFacts(left, right) {
  if (Boolean(left.verified) !== Boolean(right.verified)) return left.verified ? -1 : 1;
  const leftTime = Date.parse(left.updated_at || left.created_at || '') || 0;
  const rightTime = Date.parse(right.updated_at || right.created_at || '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right.id || '').localeCompare(String(left.id || ''));
}

function projectEffectiveFact(row, provenance) {
  return {
    value: String(row.value).trim(),
    provenance,
    verified: provenance === 'operator' ? Boolean(row.verified) : false,
    actor: provenance === 'operator' ? (row.actor || null) : null,
    note: provenance === 'operator' ? (row.note || null) : null,
  };
}

function addFirstFacts(target, rows, provenance, predicate = () => true) {
  for (const row of toFactRows(rows)) {
    if (!isUsefulFact(row) || !predicate(row)) continue;
    const field = normalizeOpportunityFactField(row.field);
    if (!Object.hasOwn(target, field)) target[field] = projectEffectiveFact(row, provenance);
  }
}

export function getEffectiveOpportunityFacts({ opportunityId, sourceFacts = [], crmFacts = [], operatorFacts = [] } = {}) {
  normalizeText(opportunityId, 'Canonical opportunity id', { maxLength: 200 });
  const effective = {};
  const groupedOperatorFacts = new Map();
  for (const fact of toFactRows(operatorFacts)) {
    if (!isUsefulFact(fact)) continue;
    const field = normalizeOpportunityFactField(fact.field);
    const existing = groupedOperatorFacts.get(field);
    if (!existing || compareOperatorFacts(fact, existing) < 0) groupedOperatorFacts.set(field, fact);
  }
  for (const [field, fact] of groupedOperatorFacts) effective[field] = projectEffectiveFact(fact, 'operator');
  addFirstFacts(effective, crmFacts, 'crm');
  addFirstFacts(effective, sourceFacts, 'structured-source', (fact) => !fact.suggestion);
  addFirstFacts(effective, sourceFacts, 'enrichment-suggestion', (fact) => Boolean(fact.suggestion));
  return effective;
}
