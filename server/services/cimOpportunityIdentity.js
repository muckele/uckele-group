import { createHash, randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';

export const CIM_IDENTITY_EVIDENCE_VERSION = 'cim-opportunity-v1';

const acceptedRequestStates = new Set(['provider_accepted', 'development_only', 'responded']);
const acceptedDeliveryStates = new Set([
  'accepted', 'delivered', 'delayed', 'replied', 'development-only', 'bounced', 'complained', 'suppressed',
]);
const acceptedStatuses = new Set(['sent', 'logged', 'responded', 'delivery_issue', 'follow_up_pending', 'follow_up_failed']);
const trackingQueryParameters = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term',
]);

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function normalizeCimRecipient(value = '') {
  return normalizeText(value, 320).toLowerCase();
}

function normalizeComparable(value = '') {
  return normalizeText(value, 1000)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function descriptionTokens(value = '') {
  return new Set(
    normalizeComparable(value)
      .split(' ')
      .filter((token) => token.length >= 3),
  );
}

function descriptionSimilarity(left = '', right = '') {
  const leftTokens = descriptionTokens(left);
  const rightTokens = descriptionTokens(right);
  if (leftTokens.size < 12 || rightTokens.size < 12) return null;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function finiteNumber(value) {
  const normalized = typeof value === 'number' ? value : String(value ?? '').replace(/[^\d.-]/g, '');
  if (normalized === '' || normalized === '-' || normalized === '.') return null;
  const numeric = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function relativeDifference(left, right) {
  const a = finiteNumber(left);
  const b = finiteNumber(right);
  if (a === null || b === null || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b);
}

export function normalizeCimListingUrl(value = '') {
  const raw = normalizeText(value, 2000);
  if (!raw) return '';
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (trackingQueryParameters.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function listingIdentityFromUrl(value = '') {
  const normalized = normalizeCimListingUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname;
  const path = decodeURIComponent(url.pathname).toLowerCase();
  let provider = host;
  let pathIdAllowed = false;
  if (/(^|\.)bizbuysell\.com$/.test(host) || /(^|\.)bizquest\.com$/.test(host) || /(^|\.)loopnet\.com$/.test(host)) {
    provider = 'costar';
    pathIdAllowed = true;
  } else if (/(^|\.)businessbroker\.net$/.test(host)) {
    provider = 'businessbroker';
    pathIdAllowed = true;
  } else if (/(^|\.)dealstream\.com$/.test(host)) {
    provider = 'dealstream';
  }
  const explicitQueryId = normalizeText(url.searchParams.get('id') || url.searchParams.get('listing') || '', 120);
  const stableId = explicitQueryId || (pathIdAllowed ? path.match(/(?:^|\/)(\d{5,})(?:\/|$)/)?.[1] || '' : '');
  return {
    url: normalized,
    provider,
    stableId,
    listingId: stableId ? `${provider}:${stableId}` : '',
  };
}

function identitySnapshot(deal = {}) {
  const listing = listingIdentityFromUrl(deal.listingUrl || deal.listing_url);
  const sourceRecords = Array.isArray(deal.sourceRecords) ? deal.sourceRecords : [];
  const sourceIds = [deal.sourceId, deal.source_id, ...sourceRecords.map((item) => item?.sourceId)]
    .map((value) => normalizeComparable(value))
    .filter(Boolean);
  const listingIds = [listing?.listingId, ...(deal.identityAliases || []).filter((value) => /^(costar|dealstream|businessbroker):/i.test(value))]
    .map((value) => normalizeText(value, 300).toLowerCase())
    .filter(Boolean);
  return {
    name: normalizeComparable(deal.name || deal.deal_name),
    description: normalizeComparable(deal.description || deal.metadata?.description),
    recipient: normalizeCimRecipient(deal.brokerEmail || deal.recipient_email),
    location: normalizeComparable(deal.location || deal.metadata?.location),
    city: normalizeComparable(deal.city),
    county: normalizeComparable(deal.county),
    state: normalizeComparable(deal.state),
    country: normalizeComparable(deal.country),
    askingPrice: finiteNumber(deal.askingPrice ?? deal.asking_price ?? deal.metadata?.askingPrice),
    revenue: finiteNumber(deal.annualRevenue ?? deal.annual_revenue ?? deal.metadata?.annualRevenue),
    profit: finiteNumber(deal.annualProfit ?? deal.annual_profit ?? deal.metadata?.annualProfit),
    sourceIds: [...new Set(sourceIds)],
    listingIds: [...new Set(listingIds)],
    listingUrl: listing?.url || '',
  };
}

function mergeIdentitySnapshots(previous = {}, current = {}) {
  return {
    ...previous,
    ...current,
    name: current.name || previous.name || '',
    description: current.description || previous.description || '',
    recipient: current.recipient || previous.recipient || '',
    location: current.location || previous.location || '',
    city: current.city || previous.city || '',
    county: current.county || previous.county || '',
    state: current.state || previous.state || '',
    country: current.country || previous.country || '',
    askingPrice: current.askingPrice ?? previous.askingPrice ?? null,
    revenue: current.revenue ?? previous.revenue ?? null,
    profit: current.profit ?? previous.profit ?? null,
    sourceIds: [...new Set([...(previous.sourceIds || []), ...(current.sourceIds || [])])],
    listingIds: [...new Set([...(previous.listingIds || []), ...(current.listingIds || [])])],
    listingUrl: current.listingUrl || previous.listingUrl || '',
  };
}

function alias(aliasType, aliasValue, source = '') {
  const type = normalizeText(aliasType, 80).toLowerCase();
  const value = normalizeText(aliasValue, 1600);
  if (!type || !value) return null;
  return {
    alias_type: type,
    alias_value: value,
    alias_key: `${type}:${value}`,
    source: normalizeText(source, 200),
  };
}

export function buildCimOpportunityAliases(deal = {}) {
  const snapshot = identitySnapshot(deal);
  const aliases = [];
  const add = (candidate) => {
    if (candidate && !aliases.some((item) => item.alias_key === candidate.alias_key)) aliases.push(candidate);
  };
  const listing = listingIdentityFromUrl(deal.listingUrl || deal.listing_url);
  const dealKeys = [deal.dealKey, deal.deal_key, ...(Array.isArray(deal.dealKeyAliases) ? deal.dealKeyAliases : [])];
  for (const dealKey of dealKeys) {
    const value = normalizeText(dealKey, 1200);
    if (/^(?:url|source):/i.test(value)) add(alias('deal-key', value, deal.sourceName || deal.source_name));
  }
  if (listing?.url) add(alias('listing-url', listing.url, deal.sourceName || deal.source_name));
  if (listing?.listingId) add(alias('listing-id', listing.listingId, deal.sourceName || deal.source_name));
  for (const identity of Array.isArray(deal.identityAliases) ? deal.identityAliases : []) {
    const value = normalizeText(identity, 1200).toLowerCase();
    if (/^(costar|dealstream|businessbroker):/.test(value)) add(alias('listing-id', value, deal.sourceName || deal.source_name));
    else add(alias('source-identity', value, deal.sourceName || deal.source_name));
  }
  const stableExternal = Boolean(deal.stableExternalId || deal.stable_external_id);
  const sourceId = normalizeComparable(deal.sourceId || deal.source_id);
  const externalId = normalizeText(deal.id || deal.external_id, 240);
  if (sourceId && externalId && (stableExternal || !/^\d+$/.test(externalId))) {
    add(alias('source-id', `${sourceId}:${externalId}`, deal.sourceName || deal.source_name));
  }
  const fingerprintFields = [
    snapshot.name, snapshot.description, snapshot.recipient,
    snapshot.location || [snapshot.city, snapshot.county, snapshot.state].filter(Boolean).join(' '),
    snapshot.askingPrice ?? '', snapshot.revenue ?? '', snapshot.profit ?? '', snapshot.sourceIds.join('|'),
  ];
  const locationEvidence = snapshot.location || snapshot.city || snapshot.county || snapshot.state || snapshot.country;
  const financialEvidenceCount = [snapshot.askingPrice, snapshot.revenue, snapshot.profit]
    .filter((value) => value !== null).length;
  if (
    snapshot.name
    && snapshot.description.length >= 120
    && snapshot.recipient
    && locationEvidence
    && snapshot.sourceIds.length > 0
    && financialEvidenceCount >= 2
  ) {
    add(alias('fingerprint-v1', sha256(fingerprintFields.join('|')), deal.sourceName || deal.source_name));
  }
  return aliases;
}

function opportunitySnapshot(opportunity = {}) {
  const metadata = opportunity.metadata && typeof opportunity.metadata === 'object' ? opportunity.metadata : {};
  return metadata.identitySnapshot || {
    name: normalizeComparable(opportunity.canonical_name),
    description: '',
    recipient: normalizeCimRecipient(opportunity.canonical_recipient),
    location: normalizeComparable(opportunity.canonical_location),
    sourceIds: [],
    listingIds: [],
  };
}

export function compareCimOpportunityEvidence(leftDeal = {}, rightOpportunity = {}) {
  const left = identitySnapshot(leftDeal);
  const right = opportunitySnapshot(rightOpportunity);
  const listingNamespace = (value) => normalizeText(value, 300).split(':')[0];
  const listingConflict = left.listingIds.some((leftId) => right.listingIds?.some(
    (rightId) => listingNamespace(leftId) === listingNamespace(rightId) && leftId !== rightId,
  ));
  const geographyValues = ['state', 'country'].map((field) => ({ field, left: left[field], right: right[field] }));
  const geographyConflict = geographyValues.some(({ left: a, right: b }) => a && b && a !== b);
  const locationMatch = Boolean(left.location && right.location && left.location === right.location)
    || Boolean(left.state && right.state && left.state === right.state && left.city && right.city && left.city === right.city);
  const financials = [
    ['askingPrice', left.askingPrice, right.askingPrice],
    ['revenue', left.revenue, right.revenue],
    ['profit', left.profit, right.profit],
  ].map(([field, a, b]) => ({ field, difference: relativeDifference(a, b) }))
    .filter(({ difference }) => difference !== null);
  const financialMatches = financials.filter(({ difference }) => difference <= 0.03).map(({ field }) => field);
  const financialConflicts = financials.filter(({ difference }) => difference >= 0.15).map(({ field }) => field);
  const sourceMatch = Boolean(left.sourceIds?.some((source) => right.sourceIds?.includes(source)));
  const nameMatch = Boolean(left.name && right.name && left.name === right.name);
  const recipientMatch = Boolean(left.recipient && right.recipient && left.recipient === right.recipient);
  const descriptionScore = descriptionSimilarity(left.description, right.description);
  const descriptionMatch = descriptionScore !== null && descriptionScore >= 0.9;
  const descriptionConflict = descriptionScore !== null && descriptionScore < 0.35;
  const materiallyDistinct = listingConflict || geographyConflict || descriptionConflict || financialConflicts.length >= 2;
  const automatic = !materiallyDistinct
    && nameMatch
    && recipientMatch
    && descriptionMatch
    && locationMatch
    && sourceMatch
    && financialMatches.length >= 2;
  const stronglyCorroboratedWithoutRecipient = nameMatch
    && descriptionMatch
    && locationMatch
    && financialMatches.length >= 2;
  const ambiguous = !automatic
    && !materiallyDistinct
    && ((nameMatch && recipientMatch) || stronglyCorroboratedWithoutRecipient);
  return {
    automatic,
    ambiguous,
    materiallyDistinct,
    confidence: automatic ? 0.99 : 0,
    evidence: {
      version: CIM_IDENTITY_EVIDENCE_VERSION,
      nameMatch,
      recipientMatch,
      descriptionSimilarity: descriptionScore,
      descriptionMatch,
      descriptionConflict,
      locationMatch,
      sourceMatch,
      listingConflict,
      geographyConflict,
      financialMatches,
      financialConflicts,
    },
  };
}

function opportunityRecord(deal, opportunityId, now, existing = null) {
  const snapshot = identitySnapshot(deal);
  const metadata = existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
  const accumulatedSnapshot = mergeIdentitySnapshots(metadata.identitySnapshot || {}, snapshot);
  return {
    opportunity_id: opportunityId,
    created_at: existing?.created_at || now,
    updated_at: now,
    canonical_name: normalizeText(deal.name || deal.deal_name, 300) || existing?.canonical_name || 'Unresolved opportunity',
    canonical_recipient: snapshot.recipient || existing?.canonical_recipient || null,
    canonical_location: normalizeText(deal.location || deal.metadata?.location, 300) || existing?.canonical_location || null,
    primary_submission_id: existing?.primary_submission_id || null,
    identity_version: CIM_IDENTITY_EVIDENCE_VERSION,
    status: existing?.status || 'active',
    metadata: {
      ...metadata,
      identitySnapshot: accumulatedSnapshot,
      lastObservedDealKey: normalizeText(deal.dealKey || deal.deal_key, 1200) || metadata.lastObservedDealKey || '',
      lastObservedListingUrl: snapshot.listingUrl || metadata.lastObservedListingUrl || '',
    },
  };
}

export function buildCimOpportunityRecord(deal, opportunityId, now = new Date().toISOString(), existing = null) {
  return opportunityRecord(deal, opportunityId, now, existing);
}

function aliasRecordsForOpportunity(opportunity, aliases, {
  actor = 'system',
  method = 'observed',
  confidence = 'exact',
} = {}) {
  const priority = new Map([
    ['listing-id', 0],
    ['listing-url', 1],
    ['fingerprint-v1', 2],
    ['source-identity', 3],
    ['source-id', 4],
    ['deal-key', 5],
  ]);
  const orderedAliases = [...aliases].sort((left, right) => (
    (priority.get(left.alias_type) ?? 99) - (priority.get(right.alias_type) ?? 99)
    || left.alias_key.localeCompare(right.alias_key)
  ));
  return orderedAliases.map((item) => ({
      id: sha256(`cim-opportunity-alias:${item.alias_key}`),
      opportunity_id: opportunity.opportunity_id,
      alias_type: item.alias_type,
      alias_value: item.alias_value,
      alias_key: item.alias_key,
      source: item.source || null,
      first_observed_at: opportunity.created_at,
      last_observed_at: opportunity.updated_at,
      evidence_version: CIM_IDENTITY_EVIDENCE_VERSION,
      resolution_method: method,
      confidence_state: confidence,
      resolved_by: normalizeText(actor, 200) || 'system',
      metadata: {},
    }));
}

async function linkAliases(storage, opportunity, aliases, options = {}) {
  const aliasRecords = aliasRecordsForOpportunity(opportunity, aliases, options);
  if (storage.linkDealHunterOpportunityAliases) {
    return storage.linkDealHunterOpportunityAliases(aliasRecords);
  }
  for (const record of aliasRecords) {
    const stored = await storage.upsertDealHunterOpportunityAlias(record);
    if (stored?.opportunity_id && stored.opportunity_id !== opportunity.opportunity_id) {
      return { conflict: stored };
    }
  }
  return { conflict: null };
}

function identityStorageAvailable(storage) {
  return Boolean(
    storage?.findCurrentDealHunterOpportunityByAliases
    && storage?.getCurrentDealHunterOpportunity
    && storage?.listCurrentDealHunterOpportunities
    && storage?.upsertDealHunterOpportunity
    && storage?.upsertDealHunterOpportunityAlias
    && storage?.upsertDealHunterIdentityException,
  );
}

function identitySafetyStorageAvailable(storage) {
  return Boolean(
    identityStorageAvailable(storage)
    && storage?.listDealHunterOpportunityAliases
    && storage?.claimDealHunterCimOpportunity
    && storage?.claimDealHunterCimRecipient
    && storage?.releaseDealHunterCimRecipientClaim
    && storage?.getDealHunterCimSafetySettings
    && storage?.upsertDealHunterCimSafetySettings,
  );
}

export async function resolveDealHunterOpportunity({
  deal,
  storage = getStorage(),
  actor = 'system',
  allowCreate = true,
  candidateOpportunities = null,
} = {}) {
  if (!deal || !identityStorageAvailable(storage)) {
    return { ok: false, status: 'unavailable', error: 'Canonical Deal Hunter identity storage is unavailable.' };
  }
  const aliases = buildCimOpportunityAliases(deal);
  if (aliases.length === 0) return { ok: false, status: 'ambiguous', error: 'The opportunity has no durable identity evidence.' };
  const now = new Date().toISOString();
  const storeIdentityException = async ({ reason, candidates = [], comparisons = [] }) => {
    const exceptionId = sha256(`cim-identity-exception:${aliases.map((item) => item.alias_key).sort().join('|')}`);
    const identityException = await storage.upsertDealHunterIdentityException({
      id: exceptionId,
      created_at: now,
      updated_at: now,
      status: 'open',
      observed_deal_key: normalizeText(deal.dealKey || deal.deal_key, 1200),
      observed_name: normalizeText(deal.name || deal.deal_name, 300),
      observed_recipient: normalizeCimRecipient(deal.brokerEmail || deal.recipient_email),
      candidate_opportunity_ids: candidates,
      reason,
      evidence_version: CIM_IDENTITY_EVIDENCE_VERSION,
      resolved_at: null,
      resolved_by: null,
      resolution_reason: null,
      metadata: {
        aliases: aliases.map((item) => item.alias_key),
        comparisons,
      },
    });
    return {
      ok: false,
      status: 'ambiguous',
      error: 'Opportunity identity is ambiguous and requires administrator resolution before outreach.',
      identityException,
      aliases,
    };
  };
  let exact;
  try {
    exact = await storage.findCurrentDealHunterOpportunityByAliases(aliases.map((item) => item.alias_key));
  } catch (error) {
    return storeIdentityException({
      reason: error?.code === 'DEAL_HUNTER_OPPORTUNITY_NOT_CURRENT'
        ? 'non-current-canonical-alias'
        : 'conflicting-canonical-aliases',
      candidates: error?.opportunityId ? [error.opportunityId] : [],
    });
  }
  if (exact) {
    const opportunity = await storage.upsertDealHunterOpportunity(opportunityRecord(deal, exact.opportunity_id, now, exact));
    if (opportunity?.status !== 'active') {
      return storeIdentityException({
        reason: 'non-current-canonical-alias',
        candidates: [exact.opportunity_id],
      });
    }
    const linked = await linkAliases(storage, opportunity, aliases, { actor, method: 'exact-alias', confidence: 'exact' });
    if (linked.conflict) {
      return storeIdentityException({
        reason: 'conflicting-canonical-aliases',
        candidates: [opportunity.opportunity_id, linked.conflict.opportunity_id],
      });
    }
    return { ok: true, status: 'resolved', opportunity, opportunityId: opportunity.opportunity_id, aliases, resolution: 'exact-alias' };
  }

  const opportunities = (Array.isArray(candidateOpportunities)
    ? candidateOpportunities
    : await storage.listCurrentDealHunterOpportunities({ limit: 100000 }))
    .filter((opportunity) => opportunity?.status === 'active');
  const comparisons = opportunities.map((opportunity) => ({ opportunity, ...compareCimOpportunityEvidence(deal, opportunity) }));
  const automatic = comparisons.filter((item) => item.automatic);
  const ambiguous = comparisons.filter((item) => item.ambiguous);
  if (automatic.length === 1) {
    const existing = automatic[0].opportunity;
    const opportunity = await storage.upsertDealHunterOpportunity(opportunityRecord(deal, existing.opportunity_id, now, existing));
    if (opportunity?.status !== 'active') {
      return storeIdentityException({
        reason: 'non-current-canonical-alias',
        candidates: [existing.opportunity_id],
        comparisons: [{ opportunityId: existing.opportunity_id, evidence: automatic[0].evidence }],
      });
    }
    const linked = await linkAliases(storage, opportunity, aliases, { actor, method: 'high-confidence-transition', confidence: 'high' });
    if (linked.conflict) {
      return storeIdentityException({
        reason: 'concurrent-canonical-alias-conflict',
        candidates: [opportunity.opportunity_id, linked.conflict.opportunity_id],
        comparisons: [{ opportunityId: opportunity.opportunity_id, evidence: automatic[0].evidence }],
      });
    }
    return {
      ok: true,
      status: 'resolved',
      opportunity,
      opportunityId: opportunity.opportunity_id,
      aliases,
      resolution: 'high-confidence-transition',
      evidence: automatic[0].evidence,
    };
  }
  if (automatic.length > 1 || ambiguous.length > 0) {
    const candidates = [...automatic, ...ambiguous].slice(0, 10);
    return storeIdentityException({
      reason: automatic.length > 1 ? 'multiple-high-confidence-candidates' : 'ambiguous-similarity',
      candidates: candidates.map((item) => item.opportunity.opportunity_id),
      comparisons: candidates.map((item) => ({
        opportunityId: item.opportunity.opportunity_id,
        evidence: item.evidence,
      })),
    });
  }
  if (!allowCreate) return { ok: false, status: 'unresolved', error: 'No canonical opportunity could be resolved.' };
  if (!storage.createDealHunterOpportunityWithAliases) {
    return { ok: false, status: 'unavailable', error: 'Atomic canonical opportunity creation is unavailable.' };
  }

  const opportunityId = `opp_${randomUUID()}`;
  const proposedOpportunity = opportunityRecord(deal, opportunityId, now);
  const aliasRecords = aliasRecordsForOpportunity(proposedOpportunity, aliases, {
    actor,
    method: 'new-opportunity',
    confidence: 'exact',
  });
  const acquired = await storage.createDealHunterOpportunityWithAliases({
    opportunity: proposedOpportunity,
    aliases: aliasRecords,
    existingOwnerMode: 'return-current',
  });
  if (acquired.conflict || !acquired.opportunity) {
    return storeIdentityException({
      reason: acquired.conflict?.reason === 'alias-owner-not-current'
        ? 'non-current-canonical-alias'
        : 'conflicting-canonical-aliases',
      candidates: [
        acquired.conflict?.opportunity_id,
        ...(acquired.conflict?.opportunity_ids || []),
      ].filter(Boolean),
    });
  }
  let opportunity = acquired.opportunity;
  if (!acquired.created) {
    opportunity = await storage.upsertDealHunterOpportunity(
      opportunityRecord(deal, opportunity.opportunity_id, now, opportunity),
    );
    if (opportunity?.status !== 'active') {
      return storeIdentityException({
        reason: 'non-current-canonical-alias',
        candidates: [acquired.opportunity.opportunity_id],
      });
    }
  }
  return {
    ok: true,
    status: acquired.created ? 'created' : 'resolved',
    opportunity,
    opportunityId: opportunity.opportunity_id,
    aliases,
    resolution: acquired.created ? 'new-opportunity' : 'concurrent-alias-reconciliation',
  };
}

export function isAcceptedCimRequest(request = {}) {
  return acceptedRequestStates.has(request.request_state)
    || acceptedDeliveryStates.has(request.delivery_state)
    || acceptedStatuses.has(request.status)
    || Boolean(request.first_provider_accepted_at || request.provider_message_id);
}

export function logicalCimTouchesForRecipient(requests = [], recipientEmail = '') {
  const recipient = normalizeCimRecipient(recipientEmail);
  const touches = new Map();
  for (const request of requests) {
    if (normalizeCimRecipient(request.recipient_email) !== recipient) continue;
    if (isAcceptedCimRequest(request)) {
      const key = request.metadata?.initialCommunicationId || request.provider_message_id || `${request.id}:initial`;
      touches.set(key, {
        id: key,
        requestId: request.id,
        opportunityId: request.opportunity_id || '',
        occurredAt: request.first_provider_accepted_at || request.first_requested_at || request.created_at,
        kind: 'initial',
      });
    }
    for (const followUp of Array.isArray(request.metadata?.followUps) ? request.metadata.followUps : []) {
      if (!['sent', 'logged'].includes(followUp?.status)) continue;
      const number = Math.max(1, Number(followUp.number || 0));
      const key = followUp.communicationId || followUp.providerMessageId || `${request.id}:follow-up:${number}`;
      touches.set(key, {
        id: key,
        requestId: request.id,
        opportunityId: request.opportunity_id || '',
        occurredAt: followUp.acceptedAt || followUp.attemptedAt,
        kind: 'follow-up',
      });
    }
  }
  return [...touches.values()].filter((touch) => Number.isFinite(Date.parse(touch.occurredAt || '')));
}

export async function evaluateCimRecipientPolicy({
  recipientEmail,
  opportunityId = '',
  storage = getStorage(),
  config = getConfig(),
  now = new Date(),
  includePendingInitial = false,
} = {}) {
  const recipient = normalizeCimRecipient(recipientEmail);
  if (!recipient) return { allowed: false, reason: 'invalid-recipient', touches24Hours: 0, touches30Days: 0 };
  const settings = config.dealHunter?.cimOutreach || {};
  const requests = await storage.listDealHunterCimRequests({ recipientEmails: [recipient], limit: 5000 });
  const touches = logicalCimTouchesForRecipient(requests, recipient);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const countSince = (duration) => touches.filter((touch) => Date.parse(touch.occurredAt) >= nowMs - duration).length;
  const touches24Hours = countSince(24 * 60 * 60 * 1000);
  const touches30Days = countSince(30 * 24 * 60 * 60 * 1000);
  const cap24Hours = Number(settings.recipientCap24Hours);
  const cap30Days = Number(settings.recipientCap30Days);
  const pendingInitial = includePendingInitial && requests.some((request) => request.status === 'pending');
  const override = opportunityId && storage.getActiveDealHunterCimRecipientOverride
    ? await storage.getActiveDealHunterCimRecipientOverride({ opportunityId, recipientEmail: recipient, nowIso: new Date(nowMs).toISOString() })
    : null;
  if (pendingInitial) return { allowed: false, reason: 'recipient-send-in-progress', touches24Hours, touches30Days, cap24Hours, cap30Days, override: null };
  if (touches24Hours >= cap24Hours || touches30Days >= cap30Days) {
    return override
      ? { allowed: true, reason: 'administrator-override', touches24Hours, touches30Days, cap24Hours, cap30Days, override }
      : { allowed: false, reason: touches24Hours >= cap24Hours ? 'recipient-24-hour-cap' : 'recipient-30-day-cap', touches24Hours, touches30Days, cap24Hours, cap30Days, override: null };
  }
  return { allowed: true, reason: '', touches24Hours, touches30Days, cap24Hours, cap30Days, override: null };
}

export async function getCimOutreachPauseStatus({ storage = getStorage(), config = getConfig() } = {}) {
  const persisted = await storage.getDealHunterCimSafetySettings?.() || null;
  const configurationPaused = Boolean(config.dealHunter?.cimOutreach?.paused);
  const persistedPaused = Boolean(persisted?.outreach_paused);
  return {
    paused: configurationPaused || persistedPaused,
    source: persistedPaused ? 'operations-control' : configurationPaused ? 'configuration' : '',
    configurationPaused,
    persistedPaused,
    updatedAt: persisted?.updated_at || '',
    updatedBy: persisted?.updated_by || '',
  };
}

export async function assertCimOutreachAllowed(options = {}) {
  const status = await getCimOutreachPauseStatus(options);
  return status.paused
    ? { allowed: false, status, error: 'Deal Hunter CIM outreach is globally paused. No email was transmitted.' }
    : { allowed: true, status, error: '' };
}

function localTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function minutesFromTime(value) {
  const match = normalizeText(value, 10).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export function evaluateCimFollowUpWindow({ now = new Date(), settings = {} } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const start = minutesFromTime(settings.sendWindowStart || '08:00');
  const end = minutesFromTime(settings.sendWindowEnd || '17:00');
  if (Number.isNaN(date.getTime()) || start === null || end === null || start >= end) {
    return { allowed: false, reason: 'invalid-window', localMinute: null };
  }
  const parts = localTimeParts(date, settings.timezone || 'America/Los_Angeles');
  const localMinute = Number(parts.hour) % 24 * 60 + Number(parts.minute);
  if (settings.weekdaysOnly && ['Sat', 'Sun'].includes(parts.weekday)) {
    return { allowed: false, reason: 'weekend', localMinute, weekday: parts.weekday };
  }
  if (localMinute < start || localMinute >= end) {
    return { allowed: false, reason: 'outside-send-window', localMinute, weekday: parts.weekday };
  }
  return { allowed: true, reason: '', localMinute, weekday: parts.weekday };
}

async function listBoundedCimCommunications(storage, limit = 5000) {
  if (storage.listCimStage2MetricCommunications) {
    return storage.listCimStage2MetricCommunications({ limit });
  }
  if (!storage.listCrmCommunications) return [];
  const pageSize = 100;
  const first = await storage.listCrmCommunications({ page: 1, pageSize });
  const rows = [...(first.rows || [])];
  const pageCount = Math.min(Math.ceil(Number(first.total || rows.length) / pageSize), Math.ceil(limit / pageSize));
  if (pageCount > 1) {
    const remaining = await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => (
      storage.listCrmCommunications({ page: index + 2, pageSize })
    )));
    for (const page of remaining) rows.push(...(page.rows || []));
  }
  return rows.slice(0, limit);
}

async function listBoundedCimEmailEvents(storage, recipients, limit = 10000) {
  if (!storage.listEmailEventsForRecipients || recipients.length === 0) return [];
  const batches = [];
  for (let index = 0; index < recipients.length; index += 100) batches.push(recipients.slice(index, index + 100));
  const results = await Promise.all(batches.map((recipientBatch) => (
    storage.listEmailEventsForRecipients(recipientBatch, limit)
  )));
  return results.flat().slice(0, limit);
}

export async function getCimIdentityOperationsStatus({ storage = getStorage(), config = getConfig(), privacySafe = false } = {}) {
  const [pause, opportunities, exceptions, requests, safety, repairManifests] = await Promise.all([
    getCimOutreachPauseStatus({ storage, config }),
    privacySafe && storage.listCimStage2IdentityOpportunities
      ? storage.listCimStage2IdentityOpportunities({ limit: 5000 })
      : storage.listCurrentDealHunterOpportunities?.({ limit: 5000 }) || [],
    privacySafe && storage.listCimStage2IdentityExceptions
      ? storage.listCimStage2IdentityExceptions({ statuses: ['open'], limit: 5000 })
      : storage.listDealHunterIdentityExceptions?.({ statuses: ['open'], limit: 5000 }) || [],
    privacySafe && storage.listCimStage2MetricRequests
      ? storage.listCimStage2MetricRequests({ limit: 5000 })
      : storage.listDealHunterCimRequests?.({ limit: 5000 }) || [],
    storage.getDealHunterCimSafetySettings?.() || null,
    storage.listDealHunterCimRepairManifests?.({ limit: 1 }) || [],
  ]);
  const activeByOpportunity = new Map();
  const requestsByRecipient = new Map();
  for (const request of requests) {
    if (!request.opportunity_id || !request.next_follow_up_at) continue;
    activeByOpportunity.set(request.opportunity_id, (activeByOpportunity.get(request.opportunity_id) || 0) + 1);
  }
  for (const request of requests) {
    const recipient = normalizeCimRecipient(request.recipient_email);
    if (recipient) requestsByRecipient.set(recipient, [...(requestsByRecipient.get(recipient) || []), request]);
  }
  const nowMs = Date.now();
  const cap24Hours = Number(config.dealHunter?.cimOutreach?.recipientCap24Hours);
  const cap30Days = Number(config.dealHunter?.cimOutreach?.recipientCap30Days);
  const recipientsAtCap = [...requestsByRecipient.entries()].filter(([recipient, recipientRequests]) => {
    const touches = logicalCimTouchesForRecipient(recipientRequests, recipient);
    const touches24Hours = touches.filter((touch) => Date.parse(touch.occurredAt) >= nowMs - 24 * 60 * 60 * 1000).length;
    const touches30Days = touches.filter((touch) => Date.parse(touch.occurredAt) >= nowMs - 30 * 24 * 60 * 60 * 1000).length;
    return touches24Hours >= cap24Hours || touches30Days >= cap30Days;
  }).length;
  const communications = await listBoundedCimCommunications(storage);
  const communicationById = new Map(communications.map((communication) => [communication.id, communication]));
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const opportunityById = new Map(opportunities.map((opportunity) => [opportunity.opportunity_id, opportunity]));
  const missingOpportunityLinks = requests.filter((request) => !request.opportunity_id).length;
  const cimCommunicationIds = new Set(communications
    .filter((communication) => requestById.has(communication.cim_request_id))
    .map((communication) => communication.id));
  const cimProviderMessageIds = new Set(communications
    .filter((communication) => cimCommunicationIds.has(communication.id))
    .map((communication) => communication.provider_message_id)
    .filter(Boolean));
  let linkageMismatches = missingOpportunityLinks;
  for (const communication of communications) {
    const request = requestById.get(communication.cim_request_id);
    if (!request) continue;
    const primarySubmissionId = opportunityById.get(request.opportunity_id)?.primary_submission_id || request.submission_id || '';
    if ((request.opportunity_id && communication.opportunity_id !== request.opportunity_id)
      || (primarySubmissionId && communication.submission_id !== primarySubmissionId)) linkageMismatches += 1;
  }
  const recipientEvents = privacySafe && storage.listCimStage2MetricEmailEvents
    ? await storage.listCimStage2MetricEmailEvents({ limit: 10000 })
    : await listBoundedCimEmailEvents(storage, [...requestsByRecipient.keys()]);
  const events = recipientEvents.filter((event) => (
    cimCommunicationIds.has(event.communication_id)
    || cimProviderMessageIds.has(event.message_id)
  ));
  const logicalMessages = new Set();
  for (const event of events) {
    const communication = communicationById.get(event.communication_id);
    if (communication && ((communication.opportunity_id && event.opportunity_id !== communication.opportunity_id)
      || (communication.submission_id && event.submission_id !== communication.submission_id))) linkageMismatches += 1;
    logicalMessages.add(event.communication_id
      ? `communication:${event.communication_id}`
      : event.provider && event.message_id
        ? `provider:${event.provider}:${event.message_id}`
        : `event:${event.id}`);
  }
  const duplicateActiveSequences = [...activeByOpportunity.values()].filter((count) => count > 1).length;
  return {
    pause,
    followUpWindow: {
      start: config.dealHunter?.cimFollowUp?.sendWindowStart || '08:00',
      end: config.dealHunter?.cimFollowUp?.sendWindowEnd || '17:00',
      timezone: config.dealHunter?.cimFollowUp?.timezone || 'America/Los_Angeles',
      weekdaysOnly: Boolean(config.dealHunter?.cimFollowUp?.weekdaysOnly),
    },
    recipientPolicy: { cap24Hours, cap30Days },
    storageHealthy: identitySafetyStorageAvailable(storage),
    canonicalOpportunities: opportunities.length,
    unresolvedIdentityExceptions: exceptions.length,
    duplicateActiveSequences,
    recipientsAtCap,
    recipientCapDeferrals: safety?.metadata?.recipientCapDeferrals ?? recipientsAtCap,
    outOfWindowDeferrals: safety?.metadata?.outOfWindowDeferrals ?? null,
    missingOpportunityLinks,
    linkageMismatches,
    rawLifecycleEvents: events.length,
    logicalMessages: logicalMessages.size,
    lastAudit: safety?.metadata?.lastAudit || {
      mode: 'live-read-only-summary',
      generatedAt: new Date(nowMs).toISOString(),
      counts: {
        canonicalOpportunities: opportunities.length,
        unresolvedIdentityExceptions: exceptions.length,
        duplicateActiveSequences,
        recipientsAtCap,
        missingOpportunityLinks,
        linkageMismatches,
        rawLifecycleEvents: events.length,
        logicalMessages: logicalMessages.size,
      },
    },
    lastRepair: repairManifests[0]
      ? {
          id: repairManifests[0].id,
          status: repairManifests[0].status,
          createdAt: repairManifests[0].created_at,
          checksum: repairManifests[0].checksum,
        }
      : safety?.metadata?.lastRepair || null,
  };
}

export async function setCimOutreachPaused({ paused, actor = '', reason = '', storage = getStorage() } = {}) {
  if (typeof paused !== 'boolean' || !storage.upsertDealHunterCimSafetySettings) {
    throw new Error('CIM outreach safety settings are unavailable.');
  }
  const current = await storage.getDealHunterCimSafetySettings?.() || {};
  return storage.upsertDealHunterCimSafetySettings({
    updated_at: new Date().toISOString(),
    outreach_paused: paused,
    updated_by: normalizeText(actor, 200) || 'admin',
    metadata: {
      ...(current.metadata || {}),
      pauseReason: normalizeText(reason, 500) || (paused ? 'Paused by an administrator.' : 'Unpaused by an administrator.'),
    },
  });
}

export async function recordCimSafetyMetric({ metric, storage = getStorage(), now = new Date() } = {}) {
  const field = normalizeText(metric, 80);
  if (!['recipientCapDeferrals', 'outOfWindowDeferrals', 'linkageMismatches'].includes(field)
    || !storage.getDealHunterCimSafetySettings
    || !storage.upsertDealHunterCimSafetySettings) return null;
  const current = await storage.getDealHunterCimSafetySettings() || {};
  return storage.upsertDealHunterCimSafetySettings({
    ...current,
    updated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    updated_by: 'cim-safety-policy',
    metadata: {
      ...(current.metadata || {}),
      [field]: Number(current.metadata?.[field] || 0) + 1,
    },
  });
}

export async function createCimRecipientOverride({
  opportunityId = '',
  recipientEmail = '',
  confirmed = false,
  reason = '',
  actor = '',
  expiresInHours = 1,
  storage = getStorage(),
  config = getConfig(),
} = {}) {
  const normalizedOpportunityId = normalizeText(opportunityId, 160);
  const recipient = normalizeCimRecipient(recipientEmail);
  const normalizedReason = normalizeText(reason, 500);
  const requestedHours = Number(expiresInHours);
  const maximumHours = Number(config.dealHunter?.cimOutreach?.overrideMaxHours || 24);
  if (!confirmed || normalizedReason.length < 10 || !normalizedOpportunityId || !recipient) {
    return { ok: false, status: 400, error: 'A confirmed opportunity, recipient, and specific override reason are required.' };
  }
  if (!Number.isFinite(requestedHours) || requestedHours <= 0 || requestedHours > maximumHours) {
    return { ok: false, status: 400, error: `Override duration must be between 1 and ${maximumHours} hours.` };
  }
  if (!storage.getCurrentDealHunterOpportunity) {
    return { ok: false, status: 503, error: 'Current canonical opportunity lookup is unavailable.' };
  }
  const opportunity = await storage.getCurrentDealHunterOpportunity(normalizedOpportunityId);
  if (!opportunity) {
    const historical = await storage.getDealHunterOpportunity?.(normalizedOpportunityId);
    if (historical) {
      return { ok: false, status: 409, error: 'The selected canonical opportunity is superseded or otherwise not current. No recipient override was created.' };
    }
  }
  if (!opportunity || !storage.upsertDealHunterCimRecipientOverride) {
    return { ok: false, status: 404, error: 'Canonical opportunity or override storage was not found.' };
  }
  const createdAt = new Date().toISOString();
  const override = await storage.upsertDealHunterCimRecipientOverride({
    id: `override_${randomUUID()}`,
    opportunity_id: normalizedOpportunityId,
    recipient_email: recipient,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + requestedHours * 60 * 60 * 1000).toISOString(),
    consumed_at: null,
    created_by: normalizeText(actor, 200) || 'admin',
    reason: normalizedReason,
    metadata: { confirmed: true, scope: 'one-initial-touch', replayable: false },
  });
  return { ok: true, status: 201, override };
}

export async function resolveCimIdentityException({
  exceptionId = '',
  opportunityId = '',
  action = 'link',
  confirmed = false,
  reason = '',
  actor = '',
  storage = getStorage(),
} = {}) {
  const normalizedReason = normalizeText(reason, 500);
  if (!confirmed || normalizedReason.length < 10) {
    return { ok: false, status: 400, error: 'Identity resolution requires confirmation and a specific reason.' };
  }
  const exceptions = await storage.listDealHunterIdentityExceptions?.({ limit: 5000 }) || [];
  const identityException = exceptions.find((item) => item.id === exceptionId);
  if (!identityException || identityException.status !== 'open') {
    return { ok: false, status: 404, error: 'Open identity exception not found.' };
  }
  let targetOpportunity = null;
  if (opportunityId) {
    if (!storage.getCurrentDealHunterOpportunity || !storage.getDealHunterOpportunity) {
      return { ok: false, status: 503, error: 'Current canonical opportunity lookup is unavailable.' };
    }
    const historicalTarget = await storage.getDealHunterOpportunity(opportunityId);
    targetOpportunity = await storage.getCurrentDealHunterOpportunity(opportunityId);
    if (historicalTarget && !targetOpportunity) {
      const mergedInto = normalizeText(
        historicalTarget.metadata?.canonicalOpportunityMerge?.mergedInto,
        160,
      );
      const activeSuccessor = mergedInto
        ? await storage.getCurrentDealHunterOpportunity(mergedInto)
        : null;
      return {
        ok: false,
        status: 409,
        error: 'The selected canonical opportunity is superseded or otherwise not current. Select an active opportunity explicitly; no identity mutation was applied.',
        successorOpportunityId: activeSuccessor?.opportunity_id || '',
      };
    }
  }
  const aliasKeys = (identityException.metadata?.aliases || []).filter(Boolean);
  const existingAliases = aliasKeys.length > 0 && storage.listDealHunterOpportunityAliases
    ? await storage.listDealHunterOpportunityAliases({ aliasKeys, limit: Math.max(100, aliasKeys.length) })
    : [];
  if (action === 'keep-distinct') {
    if (existingAliases.length > 0) {
      return { ok: false, status: 409, error: 'One or more aliases already belong to a canonical opportunity. Resolve that ownership conflict before keeping this observation distinct.' };
    }
    if (!storage.createDealHunterOpportunityWithAliases) {
      return { ok: false, status: 503, error: 'Atomic canonical opportunity creation is unavailable.' };
    }
    const now = new Date().toISOString();
    targetOpportunity = {
      opportunity_id: `opp_${randomUUID()}`,
      created_at: now,
      updated_at: now,
      canonical_name: identityException.observed_name || 'Unresolved opportunity',
      canonical_recipient: identityException.observed_recipient || null,
      canonical_location: null,
      primary_submission_id: null,
      identity_version: CIM_IDENTITY_EVIDENCE_VERSION,
      status: 'active',
      metadata: { createdFromIdentityException: identityException.id },
    };
  }
  if (!targetOpportunity || !['link', 'keep-distinct'].includes(action)) {
    return { ok: false, status: 400, error: 'Select a valid canonical opportunity or keep the listing distinct.' };
  }
  const conflictingAlias = existingAliases.find((item) => item.opportunity_id !== targetOpportunity.opportunity_id);
  if (conflictingAlias) {
    return { ok: false, status: 409, error: 'An alias already belongs to another canonical opportunity. No partial identity resolution was applied.' };
  }
  const now = new Date().toISOString();
  const aliasRecords = [];
  for (const aliasKey of aliasKeys) {
    const separator = String(aliasKey).indexOf(':');
    if (separator <= 0) continue;
    const aliasType = String(aliasKey).slice(0, separator);
    const aliasValue = String(aliasKey).slice(separator + 1);
    aliasRecords.push({
      id: sha256(`cim-opportunity-alias:${aliasKey}`),
      opportunity_id: targetOpportunity.opportunity_id,
      alias_type: aliasType,
      alias_value: aliasValue,
      alias_key: aliasKey,
      source: 'manual-identity-resolution',
      first_observed_at: identityException.created_at,
      last_observed_at: now,
      evidence_version: CIM_IDENTITY_EVIDENCE_VERSION,
      resolution_method: action === 'link' ? 'manual-link' : 'manual-keep-distinct',
      confidence_state: 'manual',
      resolved_by: normalizeText(actor, 200) || 'admin',
      metadata: { exceptionId: identityException.id, reason: normalizedReason },
    });
  }
  if (action === 'keep-distinct' && aliasRecords.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'Keeping an observation distinct requires at least one stable canonical alias. No identity mutation was applied.',
    };
  }
  if (aliasRecords.length > 0) {
    if (action === 'keep-distinct') {
      const resolvedRecord = {
        ...identityException,
        updated_at: now,
        status: 'resolved',
        resolved_at: now,
        resolved_by: normalizeText(actor, 200) || 'admin',
        resolution_reason: normalizedReason,
        metadata: {
          ...(identityException.metadata || {}),
          action,
          resolvedOpportunityId: targetOpportunity.opportunity_id,
        },
      };
      const acquired = await storage.createDealHunterOpportunityWithAliases({
        opportunity: targetOpportunity,
        aliases: aliasRecords,
        existingOwnerMode: 'conflict',
        identityException: resolvedRecord,
      });
      if (acquired.conflict || !acquired.opportunity || !acquired.identityException) {
        return {
          ok: false,
          status: 409,
          error: acquired.conflict?.reason === 'identity-exception-not-open'
            ? 'The identity exception was concurrently resolved. No partial identity resolution was applied.'
            : 'An alias was concurrently assigned to another opportunity. No partial identity resolution was applied.',
        };
      }
      return {
        ok: true,
        status: 200,
        identityException: acquired.identityException,
        opportunity: acquired.opportunity,
      };
    }
    const linked = storage.linkDealHunterOpportunityAliases
      ? await storage.linkDealHunterOpportunityAliases(aliasRecords)
      : await linkAliases(storage, targetOpportunity, aliasRecords.map((record) => ({
          alias_type: record.alias_type,
          alias_value: record.alias_value,
          alias_key: record.alias_key,
          source: record.source,
        })), { actor, method: action === 'link' ? 'manual-link' : 'manual-keep-distinct', confidence: 'manual' });
    if (linked.conflict) {
      return { ok: false, status: 409, error: 'An alias was concurrently assigned to another opportunity. No partial identity resolution was applied.' };
    }
  }
  const resolved = await storage.upsertDealHunterIdentityException({
    ...identityException,
    updated_at: now,
    status: 'resolved',
    resolved_at: now,
    resolved_by: normalizeText(actor, 200) || 'admin',
    resolution_reason: normalizedReason,
    metadata: { ...(identityException.metadata || {}), action, resolvedOpportunityId: targetOpportunity.opportunity_id },
  });
  return { ok: true, status: 200, identityException: resolved, opportunity: targetOpportunity };
}
