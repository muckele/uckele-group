import { createHash, randomUUID } from 'node:crypto';

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
  'broker_contact',
  'broker_email',
  'broker_phone',
  'company',
  'role',
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

const sourceObservationFieldMappings = Object.freeze([
  ['name', 'name'],
  ['business_name', 'name'],
  ['industry', 'industry'],
  ['description', 'description'],
  ['city', 'city'],
  ['county', 'county'],
  ['state', 'state'],
  ['country', 'country'],
  ['location', 'location'],
  ['annual_profit', 'annualProfit'],
  ['annual_revenue', 'annualRevenue'],
  ['asking_price', 'askingPrice'],
  ['profit_multiple', 'profitMultiple'],
  ['net_margin', 'netMargin'],
  ['years_established', 'yearsEstablished'],
  ['remote_flag', 'remoteFlag'],
  ['franchise_flag', 'franchiseFlag'],
  ['five_years_flag', 'fiveYearsFlag'],
  ['broker_name', 'brokerName'],
  ['broker_company', 'brokerCompany'],
  ['broker_email', 'brokerEmail'],
  ['broker_phone', 'brokerPhone'],
  ['listing_url', 'listingUrl'],
  ['listing_source', 'listingSource'],
  ['date_added', 'dateAdded'],
  ['last_updated', 'lastUpdated'],
]);

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

// The service generates these records itself, but provider methods are also a
// supported storage boundary. Keep their contract here so SQLite and Supabase
// reject the same bypass attempts before any write is attempted.
export function normalizeOperatorOpportunityFactRecord(fact = {}) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact) || Buffer.isBuffer(fact)) {
    throw new Error('Operator opportunity fact must be an object.');
  }
  if (Object.hasOwn(fact, 'metadata')) {
    throw new Error('Operator opportunity fact metadata is not supported.');
  }
  if (typeof fact.verified !== 'boolean') {
    throw new Error('Opportunity fact verification state must be boolean.');
  }
  const source = normalizeText(fact.source ?? 'operator', 'Opportunity fact source', { maxLength: 80 });
  if (source !== 'operator') {
    throw new Error('Opportunity fact source must be operator.');
  }
  return {
    id: normalizeText(fact.id, 'Opportunity fact id', { maxLength: 240 }),
    opportunity_id: normalizeText(fact.opportunity_id, 'Canonical opportunity id', { maxLength: 200 }),
    field: normalizeOpportunityFactField(fact.field),
    value: normalizeText(fact.value, 'Opportunity fact value', { maxLength: 4000 }),
    source,
    verified: fact.verified,
    actor: normalizeText(fact.actor, 'Opportunity fact actor', { maxLength: 200 }),
    note: normalizeText(fact.note, 'Opportunity fact note', { required: false, maxLength: 4000 }),
    created_at: normalizeTimestamp(fact.created_at, 'Opportunity fact creation timestamp'),
    updated_at: normalizeTimestamp(fact.updated_at, 'Opportunity fact update timestamp'),
  };
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

function sourceObservationDigest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sourceObservationRecordId(deal = {}) {
  const sourceId = String(deal.sourceId || '').trim();
  const externalId = String(deal.id || '').trim();
  if (sourceId && deal.stableExternalId && externalId) return `external:${externalId}`;
  if (sourceId && deal.idFromSourceRowPosition && deal.sourceRowId) return `sheet-row:${String(deal.sourceRowId).trim()}`;
  const listingUrl = String(deal.listingUrl || '').trim();
  if (sourceId && listingUrl) return `listing:${sourceObservationDigest(listingUrl).slice(0, 40)}`;
  return '';
}

// This is an observation identity, never a canonical company identity. The
// complete-source reconciler uses it only to prove the rows supplied by a
// complete collection are the exact records it is about to replace.
export function getOpportunitySourceObservationRecordId(deal = {}) {
  const id = sourceObservationRecordId(deal);
  return id
    ? normalizeText(id, 'Opportunity source record id', { maxLength: 200 })
    : '';
}

function observationTimestamp(deal = {}, fallback) {
  const sourceTimestamp = deal.lastUpdated || deal.dateAdded;
  return Number.isFinite(Date.parse(sourceTimestamp || '')) ? new Date(sourceTimestamp).toISOString() : fallback;
}

/**
 * Projects one normalized source record into bounded, scalar provenance rows.
 * It intentionally never reads `deal.raw`, so uploaded workbooks and arbitrary
 * source payloads cannot become durable observations.
 */
export function normalizeOpportunitySourceObservationSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Buffer.isBuffer(snapshot)) {
    throw new Error('Opportunity source-observation snapshot must be an object.');
  }
  const normalized = {
    opportunity_id: normalizeText(snapshot.opportunity_id, 'Canonical opportunity id', { maxLength: 200 }),
    source_id: normalizeText(snapshot.source_id, 'Opportunity source id', { maxLength: 160 }),
    source_name: normalizeText(snapshot.source_name, 'Opportunity source name', { maxLength: 220 }),
    source_record_id: normalizeText(snapshot.source_record_id, 'Opportunity source record id', { maxLength: 200 }),
    observations: (Array.isArray(snapshot.observations) ? snapshot.observations : []).map(normalizeOpportunitySourceObservation),
  };
  if (normalized.observations.length > opportunitySourceObservationFields.length) {
    throw new Error('Opportunity source-observation snapshot has too many fields.');
  }
  const fields = new Set();
  for (const observation of normalized.observations) {
    if (
      observation.opportunity_id !== normalized.opportunity_id
      || observation.source_id !== normalized.source_id
      || observation.source_name !== normalized.source_name
      || observation.source_record_id !== normalized.source_record_id
    ) {
      throw new Error('Opportunity source-observation snapshot rows must share one source record identity.');
    }
    if (fields.has(observation.field)) throw new Error('Opportunity source-observation snapshot fields must be unique.');
    fields.add(observation.field);
  }
  return normalized;
}

/**
 * A complete current projection for one already-resolved canonical opportunity
 * and one source. Unlike the per-source-record snapshot above, this replaces
 * every current record position for that `(opportunity_id, source_id)` scope.
 * It contains only bounded observations, never source raw payloads.
 */
export function normalizeDealHunterOpportunitySourceSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Buffer.isBuffer(snapshot)) {
    throw new Error('Complete opportunity source-observation snapshot must be an object.');
  }
  if (!Array.isArray(snapshot.records)) {
    throw new Error('Complete opportunity source-observation snapshot records must be an array.');
  }
  if (snapshot.records.length === 0) {
    throw new Error('Complete opportunity source-observation snapshot must include at least one source record.');
  }
  if (snapshot.records.length > 10_000) {
    throw new Error('Complete opportunity source-observation snapshot has too many records.');
  }
  const normalized = {
    opportunity_id: normalizeText(snapshot.opportunity_id, 'Canonical opportunity id', { maxLength: 200 }),
    source_id: normalizeText(snapshot.source_id, 'Opportunity source id', { maxLength: 160 }),
    source_name: normalizeText(snapshot.source_name, 'Opportunity source name', { maxLength: 220 }),
    records: snapshot.records.map(normalizeOpportunitySourceObservationSnapshot),
  };
  const recordIds = new Set();
  for (const record of normalized.records) {
    if (
      record.opportunity_id !== normalized.opportunity_id
      || record.source_id !== normalized.source_id
      || record.source_name !== normalized.source_name
    ) {
      throw new Error('Complete opportunity source-observation snapshot records must share one canonical opportunity and source identity.');
    }
    if (recordIds.has(record.source_record_id)) {
      throw new Error('Complete opportunity source-observation snapshot record identities must be unique.');
    }
    recordIds.add(record.source_record_id);
  }
  return normalized;
}

/**
 * A complete current projection for one authoritative source across every
 * canonical opportunity it represented. This is used only after collection
 * proves the raw source is complete and every source record has resolved. Its
 * unique source-record identities prevent a source-wide delete from being
 * authorized by a deduped or partial candidate subset.
 */
export function normalizeDealHunterSourceSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Buffer.isBuffer(snapshot)) {
    throw new Error('Complete source-observation snapshot must be an object.');
  }
  if (!Array.isArray(snapshot.records)) {
    throw new Error('Complete source-observation snapshot records must be an array.');
  }
  if (snapshot.records.length === 0) {
    throw new Error('Complete source-observation snapshot must include at least one source record.');
  }
  if (snapshot.records.length > 10_000) {
    throw new Error('Complete source-observation snapshot has too many records.');
  }
  const normalized = {
    source_id: normalizeText(snapshot.source_id, 'Opportunity source id', { maxLength: 160 }),
    source_name: normalizeText(snapshot.source_name, 'Opportunity source name', { maxLength: 220 }),
    records: snapshot.records.map(normalizeOpportunitySourceObservationSnapshot),
  };
  const recordIds = new Set();
  for (const record of normalized.records) {
    if (record.source_id !== normalized.source_id || record.source_name !== normalized.source_name) {
      throw new Error('Complete source-observation snapshot records must share one source identity.');
    }
    if (recordIds.has(record.source_record_id)) {
      throw new Error('Complete source-observation snapshot record identities must be unique within the source.');
    }
    if (record.observations.length === 0) {
      throw new Error('Complete source-observation snapshot records must include at least one observation.');
    }
    recordIds.add(record.source_record_id);
  }
  return normalized;
}

export function buildOpportunitySourceObservationSnapshot({ opportunityId, deal, now = new Date().toISOString() } = {}) {
  const canonicalOpportunityId = normalizeText(opportunityId, 'Canonical opportunity id', { maxLength: 200 });
  const sourceId = normalizeText(deal?.sourceId, 'Opportunity source id', { maxLength: 160 });
  const sourceName = normalizeText(deal?.sourceName, 'Opportunity source name', { maxLength: 220 });
  const sourceRecordId = getOpportunitySourceObservationRecordId(deal);
  if (!sourceRecordId) return null;
  const timestamp = normalizeTimestamp(now, 'Opportunity source observation timestamp');
  const observedAt = observationTimestamp(deal, timestamp);
  const observations = [];
  const add = (field, value) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    observations.push(normalizeOpportunitySourceObservation({
      id: `source-observation:${sourceObservationDigest([canonicalOpportunityId, sourceId, sourceRecordId, field].join('\u0000'))}`,
      opportunity_id: canonicalOpportunityId,
      source_id: sourceId,
      source_name: sourceName,
      source_record_id: sourceRecordId,
      field,
      value,
      observed_at: observedAt,
      created_at: timestamp,
      updated_at: timestamp,
    }));
  };

  for (const [field, property] of sourceObservationFieldMappings) add(field, deal?.[property]);
  if (
    deal?.brokerContact
    && (!deal?.brokerPhone || String(deal.brokerContact).trim() !== String(deal.brokerPhone).trim())
  ) add('broker_contact', deal.brokerContact);
  if (deal?.stableExternalId && deal?.id) add('listing_id', deal.id);
  return normalizeOpportunitySourceObservationSnapshot({
    opportunity_id: canonicalOpportunityId,
    source_id: sourceId,
    source_name: sourceName,
    source_record_id: sourceRecordId,
    observations,
  });
}

export function buildOpportunitySourceObservations(values = {}) {
  return buildOpportunitySourceObservationSnapshot(values)?.observations || [];
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

// Operator enrichment is a mutation of the canonical, current opportunity.
// Historical/superseded identities remain auditable through their existing fact
// rows, but must never receive new operator assertions.
export async function setCurrentOperatorOpportunityFact({
  opportunityId,
  field,
  value,
  actor,
  verified = false,
  note = null,
  storage,
} = {}) {
  if (!storage || typeof storage.insertCurrentDealHunterOpportunityFact !== 'function') {
    throw new Error('Atomic current opportunity fact storage is required.');
  }
  const id = normalizeText(opportunityId, 'Canonical opportunity id', { maxLength: 200 });
  const now = new Date().toISOString();
  if (typeof verified !== 'boolean') throw new Error('Opportunity fact verification state must be boolean.');
  const fact = {
    id: randomUUID(), opportunity_id: id, field: normalizeOpportunityFactField(field),
    value: normalizeText(value, 'Opportunity fact value'), source: 'operator', verified,
    actor: normalizeText(actor, 'Opportunity fact actor', { maxLength: 200 }),
    note: normalizeText(note, 'Opportunity fact note', { required: false, maxLength: 4000 }), created_at: now, updated_at: now,
  };
  const saved = await storage.insertCurrentDealHunterOpportunityFact(fact);
  if (!saved) throw new Error('The canonical opportunity is no longer current.');
  return saved;
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
  return ['string', 'number', 'boolean'].includes(typeof row.value) && String(row.value).trim() !== '';
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
    value: String(row.value).trim().slice(0, 4000),
    provenance,
    verified: provenance === 'operator' ? Boolean(row.verified) : false,
    actor: provenance === 'operator' && ['string', 'number', 'boolean'].includes(typeof row.actor) ? String(row.actor).trim().slice(0, 200) || null : null,
    note: provenance === 'operator' && ['string', 'number', 'boolean'].includes(typeof row.note) ? String(row.note).trim().slice(0, 500) || null : null,
  };
}

function addFirstFacts(target, rows, provenance, predicate = () => true) {
  for (const row of toFactRows(rows)) {
    if (!isUsefulFact(row) || !predicate(row)) continue;
    const field = normalizeOpportunityFactField(row.field);
    if (!Object.hasOwn(target, field)) target[field] = projectEffectiveFact(row, provenance);
  }
}

function isPhoneLikeLegacyBrokerContact(value) {
  if (!['string', 'number'].includes(typeof value)) return false;
  const text = String(value).trim();
  if (!text || text.length > 80) return false;
  const match = text.match(/^(\+?[\d().\s-]+)(?:\s*(?:x|ext\.?|extension)\s*\d{1,8})?$/i);
  if (!match) return false;
  const digits = match[1].replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function sourceFactsForEffectiveComposition(sourceFacts) {
  const directFacts = [];
  const legacyBrokerPhoneFallbacks = [];
  for (const fact of toFactRows(sourceFacts)) {
    const field = typeof fact?.field === 'string'
      ? fact.field.trim().toLowerCase().replace(/[\s-]+/g, '_')
      : '';
    if (field !== 'broker_contact') {
      directFacts.push(fact);
      continue;
    }
    if (isPhoneLikeLegacyBrokerContact(fact.value)) {
      legacyBrokerPhoneFallbacks.push({ ...fact, field: 'broker_phone' });
    }
  }
  // Preserve an explicitly attributed phone as the structured-source winner,
  // regardless of the provider's source-row ordering for legacy contacts.
  return [...directFacts, ...legacyBrokerPhoneFallbacks];
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
  const composableSourceFacts = sourceFactsForEffectiveComposition(sourceFacts);
  addFirstFacts(effective, composableSourceFacts, 'structured-source', (fact) => !fact.suggestion);
  addFirstFacts(effective, composableSourceFacts, 'enrichment-suggestion', (fact) => Boolean(fact.suggestion));
  return effective;
}
