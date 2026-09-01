import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { matchDealNarrative } from './dealHunterSemanticMatcher.js';
import { getStorage } from '../storage/index.js';
import { sha256, signPayload, verifySignedPayload } from '../utils/security.js';
import { strFromU8, unzipSync } from 'fflate';
import {
  buildCimReplyToAddress,
  buildDealHunterCimFollowUpEmail,
  buildDealHunterCimRequestEmail,
  normalizeResendTagToken,
  sendDailyDealHunterEmail,
  sendDailyDealHunterSourceAlertEmail,
  sendPreparedMessage,
} from './delivery.js';
import { createManualSubmission } from './submissions.js';
import { commitCrmActivityMutation } from './activity.js';
import { getEmailReadiness } from './emailReadiness.js';
import {
  buildOutboundCommunication,
  createCommunicationWithActivity,
} from './communications.js';
import {
  assessCimStage2StaticCandidate,
  authorizeCimStage2SendBoundary,
  buildCimStage2DecisionRecord,
  cimStage2SnapshotDigest,
  evaluateCimAutomationCandidates,
  evaluateCimStage2Window,
  getCimStage2Policy,
  getCimAutomationStatus,
  hashCimStage2Recipient,
  reconcileCimStage2AmbiguousDecisions,
  sourceSnapshotDigestForDeal,
} from './cimAutomation.js';
import {
  assertCimOutreachAllowed,
  evaluateCimFollowUpWindow,
  evaluateCimRecipientPolicy,
  logicalCimTouchesForRecipient,
  recordCimSafetyMetric,
  resolveDealHunterOpportunity,
} from './cimOpportunityIdentity.js';
import {
  buildOpportunitySourceObservationSnapshot,
  getOpportunitySourceObservationRecordId,
} from './dealHunterOpportunityFacts.js';
import { reconcileVerifiedCompleteGoogleSheetSourceSnapshot } from './dealHunterSourceSnapshotAdmission.js';

const defaultTimeoutMs = 45000;
const sheetWorkbookExpandedMaxBytes = 32 * 1024 * 1024;
const sheetWorkbookEntryMaxBytes = 16 * 1024 * 1024;
const sheetRowSimilarityMaxComparisons = 250_000;
const dealOsSourceId = 'deal-os-export';
const dealOsSourceName = 'SMB Deal OS export';
const dealOsAllowedScopes = new Set(['saved-search', 'deal-radar']);
const dealOsImportFutureToleranceMs = 15 * 60 * 1000;
const dealOsImportMaxColumns = 200;
const cimRequestScoreThreshold = 75;
const highFitScoreThreshold = 75;
const watchlistScoreThreshold = 60;
const cimRequestSentStatuses = ['sent', 'logged'];
const cimRequestActiveStatuses = ['sent', 'logged', 'failed', 'ambiguous', 'follow_up_failed', 'follow_up_pending', 'follow_up_ambiguous'];
const cimRequestTerminalStatuses = ['sent', 'logged', 'responded', 'delivery_issue', 'ambiguous', 'follow_up_failed', 'follow_up_pending', 'follow_up_ambiguous'];
const replyEventTypes = new Set(['replied', 'received']);
const stopFollowUpEventTypes = new Set(['bounced', 'complained', 'failed', 'unsubscribed']);
const cimProviderAcceptedCommunicationStates = new Set([
  'accepted',
  'delivered',
  'delayed',
  'bounced',
  'failed',
  'complained',
  'suppressed',
  'replied',
]);
const cimDeliveryIssueStates = new Set(['bounced', 'failed', 'complained', 'suppressed']);
const archivedCimUnavailableReason = 'This CRM record is archived. Restore and review it before sending CIM outreach.';
const cimBulkRequestMax = 25;
const cimClaimStaleMinutes = 30;
const cimSnapshotTtlMs = 1000 * 60 * 60 * 2;
const cimRequestSendLocks = new Set();
const cimRecipientSendLocks = new Set();
const cimFollowUpLocks = new Set();
const dealHunterCrmNotesHeading = 'Deal Hunter scoring profile';
const dealHunterCrmUserNotesHeading = 'User notes';
const dealHunterCrmGeneratedStartMarker = 'Deal Hunter generated notes';
const dealHunterCrmGeneratedEndMarker = 'End Deal Hunter generated notes';
const dealHunterCrmImportPendingStaleMinutes = 30;
const dealHunterScoringRuleVersion = 'deal-hunter-fit-v2';
const dealHunterCompletenessPolicyVersion = 'deal-hunter-completeness-v1';
const dealOsParserVersion = 'deal-os-export-v2';
const dealHunterManagedFields = [
  'name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
  'annualProfit', 'annualRevenue', 'askingPrice', 'profitMultiple', 'netMargin',
  'yearsEstablished', 'remoteFlag', 'franchiseFlag', 'fiveYearsFlag', 'brokerName',
  'brokerEmail', 'brokerCompany', 'brokerContact', 'listingUrl', 'listingSource',
  'dateAdded', 'lastUpdated',
];

const profile = {
  minAnnualProfit: 300000,
  maxAnnualProfit: 750000,
  targetStates: ['NY', 'CA', 'NJ', 'AZ', 'NV', 'CT'],
  preferredKeywords: [
    'recurring revenue',
    'recurring maintenance',
    'service contracts',
    'service agreements',
    'maintenance contracts',
    'commercial contracts',
    'commercial customers',
    'b2b',
    'repeat customers',
    'customer-diversified',
    'low customer concentration',
    'essential service',
    'non-discretionary',
    'mission-critical',
    'compliance',
    'inspection',
    'testing',
    'regulated compliance',
    'repair',
    'maintenance',
    'replacement',
    'remediation',
    'restoration',
    'installation',
    'field service',
    'field technicians',
    'licensed technicians',
    'facility maintenance',
    'commercial maintenance',
    'industrial maintenance',
    'equipment repair',
    'fire safety',
    'life safety',
    'pest control',
    'hvac maintenance',
    'plumbing service',
    'electrical service',
    'environmental services',
    'owner retiring',
    'management in place',
    'general manager',
    'operations manager',
    'trained staff',
  ],
  recurringRevenueKeywords: [
    'recurring revenue',
    'recurring maintenance',
    'recurring service',
    'recurring work',
    'repeat customers',
    'repeat revenue',
    'maintenance contract',
    'maintenance contracts',
    'service contract',
    'service contracts',
    'service agreement',
    'service agreements',
    'contracted revenue',
    'contract revenue',
    'membership',
    'subscription',
    'route density',
    'scheduled maintenance',
    'preventive maintenance',
    'preventative maintenance',
    'ongoing service',
    'retainer',
  ],
  commercialCustomerKeywords: [
    'commercial customers',
    'commercial contracts',
    'commercial accounts',
    'b2b',
    'business-to-business',
    'facility',
    'facilities',
    'industrial',
    'municipal',
    'government',
    'property manager',
    'property managers',
    'hoa',
    'office',
    'warehouse',
    'manufacturing facility',
  ],
  excludedKeywords: [
    'restaurant',
    'restaurants',
    'hospitality',
    'food',
    'beverage',
    'catering',
    'cafe',
    'bar',
    'brewery',
    'winery',
    'hotel',
    'motel',
    'lodging',
    'retail',
    'ecommerce',
    'e-commerce',
    'fashion',
    'luxury',
    'dropshipping',
    'amazon fba',
    'startup',
    'saas',
    'software',
    'app',
    'digital marketing',
    'seo',
    'web design',
    'staffing',
    'recruiting',
    'real estate brokerage',
    'insurance agency',
    'fedex',
    'fed ex',
    'amazon dsp',
    'delivery route',
    'delivery routes',
    'package route',
    'package routes',
    'linehaul',
    'p&d',
    'pickup and delivery',
    'last mile',
    'courier route',
    'transportation route',
    'logistics route',
    'isp routes',
    'bread route',
    'vending route',
    'medical practice',
    'physician practice',
    'physician-owned',
    'doctor-owned',
    'must be a physician',
    'licensed physician required',
    'clinical practice',
    'primary care',
    'urgent care',
    'family medicine',
    'internal medicine',
    'dermatology',
    'dental practice',
    'dentist',
    'dds',
    'dmd',
    'optometry',
    'ophthalmology',
    'chiropractic',
    'med spa',
    'medspa',
    'veterinary practice',
  ],
  recessionProofKeywords: [
    'essential',
    'non-discretionary',
    'compliance',
    'inspection',
    'testing',
    'repair',
    'maintenance',
    'replacement',
    'pest',
    'hvac',
    'plumbing',
    'electrical',
    'fire safety',
    'life safety',
    'remediation',
    'restoration',
    'environmental',
    'industrial',
    'facility',
    'commercial',
    'municipal',
    'government',
  ],
  aiProofKeywords: [
    'field service',
    'technician',
    'technicians',
    'repair',
    'maintenance',
    'installation',
    'inspection',
    'testing',
    'remediation',
    'restoration',
    'plumbing',
    'electrical',
    'hvac',
    'pest',
    'fire safety',
    'life safety',
    'equipment',
    'route density',
    'onsite',
    'in-home',
    'commercial service',
  ],
  managementKeywords: [
    'management in place',
    'general manager',
    'operations manager',
    'manager',
    'trained staff',
    'staff in place',
    'lead technician',
    'team in place',
    'owner absentee',
    'absentee',
    'semi-absentee',
    'turnkey',
  ],
  capexKeywords: [
    'real estate only',
    'heavy equipment',
    'heavy inventory',
    'fleet',
    'trucks',
    'vehicles',
    'high capex',
    'capex',
    'manufacturing equipment',
  ],
  financeableKeywords: [
    'sba eligible',
    'sba prequalified',
    'sba pre-qualified',
    'seller financing',
    'seller finance',
    'seller note',
    'owner financing',
    'lender prequalified',
    'prequalified for financing',
  ],
  ownerDependencyRiskKeywords: [
    'owner operator',
    'owner-operated',
    'owner operated',
    'owner dependent',
    'seller works full time',
    'owner works full time',
    'requires owner involvement',
    'owner must stay',
    'hands-on owner',
    'key person risk',
  ],
  customerConcentrationRiskKeywords: [
    'customer concentration',
    'client concentration',
    'one customer',
    'single customer',
    'major customer',
    'top customer',
    'customer accounts for',
    'client accounts for',
  ],
  financialRiskKeywords: [
    'declining revenue',
    'revenue decline',
    'sales decline',
    'negative trend',
    'project-based',
    'project based',
    'one-time projects',
    'non-recurring',
    'seasonal',
    'heavy inventory',
    'working capital intensive',
    'high capex',
    'customer concentration',
    'one customer',
  ],
};

function normalizeText(value = '', maxLength = 5000) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item, maxLength)).filter(Boolean).join(', ');
  }

  if (value && typeof value === 'object') {
    if (value.url) {
      return normalizeText(value.url, maxLength);
    }

    if (value.label) {
      return normalizeText(value.label, maxLength);
    }

    return normalizeText(Object.values(value).join(' '), maxLength);
  }

  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value = '') {
  return normalizeText(value, 320).toLowerCase();
}

function formatCimSenderAddress(displayName = '', senderEmail = '') {
  const safeName = normalizeText(displayName, 120).replace(/[<>\r\n]/g, '');
  const normalizedEmail = normalizeEmail(senderEmail);
  return safeName ? `${safeName} <${normalizedEmail}>` : normalizedEmail;
}

function normalizeComparableText(value = '') {
  return normalizeText(value, 1000)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

const genericContactMailboxNames = new Set([
  'admin', 'broker', 'contact', 'deals', 'dealdesk', 'hello', 'info', 'inquiries', 'office', 'reception', 'sales', 'support',
]);

function contactHeaderMetadata(header = '') {
  const key = normalizeKey(header)
    .replace(/emailaddress(?:es)?/g, 'email')
    .replace(/emails(?=\d*$)/, 'email');
  const match = key.match(/^(broker|contact|listingagent|agent|receptionist|reception|dealdesk|seller)?(\d*)email(\d*)$/);

  if (!match) return null;

  const type = match?.[1] || 'contact';
  const index = match?.[2] || match?.[3] || '';
  const roles = {
    broker: 'Broker', listingagent: 'Listing agent', agent: 'Agent', seller: 'Seller',
    contact: 'Contact', dealdesk: 'Deal desk', receptionist: 'Reception', reception: 'Reception',
  };
  const priorities = {
    broker: 0, listingagent: 0, agent: 1, seller: 1, contact: 2, dealdesk: 3, receptionist: 4, reception: 4,
  };

  return { type, index, unqualified: !match[1], role: roles[type] || 'Contact', priority: priorities[type] ?? 2 };
}

function extractEmailAddresses(value = '') {
  return Array.from(new Set(String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map(normalizeEmail) || []));
}

function relatedContactName(rawRow, metadata, fallbackName = '') {
  const entries = new Map(Object.entries(rawRow || {}).map(([key, value]) => [normalizeKey(key), value]));
  const prefixes = metadata.type === 'listingagent' ? ['listingagent', 'agent', 'broker'] : [metadata.type];
  const candidates = prefixes.flatMap((prefix) => [
    `${prefix}${metadata.index}name`, `${prefix}name${metadata.index}`, `${prefix}name`, prefix,
  ]);

  for (const candidate of candidates) {
    const name = normalizeText(entries.get(candidate), 160);
    if (name) return name;
  }

  return normalizeText(fallbackName, 160);
}

function normalizeBrokerContacts(contacts = []) {
  const byEmail = new Map();
  const rolePriorities = { Broker: 0, 'Listing agent': 0, Agent: 1, Seller: 1, Contact: 2, 'Deal desk': 3, Reception: 4 };

  for (const candidate of contacts) {
    const email = normalizeEmail(candidate?.email);
    if (!isValidEmail(email)) continue;
    const localPart = email.split('@')[0].replace(/[^a-z0-9]/g, '');
    const contact = {
      name: normalizeText(candidate?.name, 160),
      email,
      role: normalizeText(candidate?.role || 'Contact', 80),
      sourceColumn: normalizeText(candidate?.sourceColumn, 160),
      sourceId: normalizeText(candidate?.sourceId, 200),
      sourceName: normalizeText(candidate?.sourceName, 200),
      sourceRecordId: normalizeText(candidate?.sourceRecordId, 120),
      sourceListingUrl: normalizeUrl(candidate?.sourceListingUrl),
      inherited: Boolean(candidate?.inherited),
      matchDecision: normalizeText(candidate?.matchDecision, 80),
      sources: (Array.isArray(candidate?.sources) ? candidate.sources : [])
        .map((source) => ({
          sourceId: normalizeText(source?.sourceId, 200),
          sourceName: normalizeText(source?.sourceName, 200),
          sourceRecordId: normalizeText(source?.sourceRecordId, 120),
          listingUrl: normalizeUrl(source?.listingUrl),
          inherited: Boolean(source?.inherited),
          matchDecision: normalizeText(source?.matchDecision, 80),
        }))
        .filter((source) => source.sourceId || source.sourceRecordId || source.listingUrl),
      priority: Math.max(0, Number.isFinite(Number(candidate?.priority)) ? Number(candidate.priority) : rolePriorities[candidate?.role] ?? 2)
        + (genericContactMailboxNames.has(localPart) ? 10 : 0),
      generic: genericContactMailboxNames.has(localPart),
    };
    const current = byEmail.get(email);
    if (!current) {
      byEmail.set(email, contact);
      continue;
    }

    const preferred = contact.priority < current.priority || (!current.name && contact.name) ? contact : current;
    const secondary = preferred === contact ? current : contact;
    const sources = [...(preferred.sources || []), ...(secondary.sources || [])];
    for (const item of [preferred, secondary]) {
      if (item.sourceId || item.sourceRecordId || item.sourceListingUrl) {
        sources.push({
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          sourceRecordId: item.sourceRecordId,
          listingUrl: item.sourceListingUrl,
          inherited: item.inherited,
          matchDecision: item.matchDecision,
        });
      }
    }
    const uniqueSources = new Map(sources.map((source) => [
      [source.sourceId, source.sourceRecordId, normalizeListingIdentity(source.listingUrl)].join('|'),
      source,
    ]));
    byEmail.set(email, {
      ...preferred,
      // A contact is inherited only when every sighting came from another
      // syndication. A direct sighting on the canonical row wins.
      inherited: preferred.inherited && secondary.inherited,
      sources: [...uniqueSources.values()],
    });
  }

  return [...byEmail.values()]
    .sort((left, right) => left.priority - right.priority || Number(right.name !== '') - Number(left.name !== '') || left.email.localeCompare(right.email))
    .map(({ priority: _priority, ...contact }) => contact);
}

function extractBrokerContacts(rawRow = {}, nameFallbacks = {}) {
  const contacts = [];

  for (const [header, value] of Object.entries(rawRow || {})) {
    const metadata = contactHeaderMetadata(header);
    if (!metadata) continue;
    const emails = extractEmailAddresses(value);
    const fallbackName = metadata.unqualified
      ? nameFallbacks.contact || nameFallbacks.broker || ''
      : nameFallbacks[metadata.type] || '';
    const name = relatedContactName(rawRow, metadata, fallbackName);
    emails.forEach((email, index) => contacts.push({ ...metadata, email, name: index === 0 ? name : '', sourceColumn: header }));
  }

  return normalizeBrokerContacts(contacts);
}

function normalizeKey(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeUrl(value = '') {
  const normalized = normalizeText(value, 1000);

  if (!normalized) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeListingIdentity(value = '') {
  const normalized = normalizeText(value, 1000).toLowerCase();

  if (!normalized) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`;

  try {
    const url = new URL(withProtocol);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    const params = Array.from(url.searchParams.entries())
      .filter(([key]) => !/^utm_/i.test(key) && !['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));
    const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';

    return `${url.hostname.replace(/^www\./i, '').toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}${query}`;
  } catch {
    return normalized.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/[?&]utm_[^&]*/gi, '');
  }
}

function normalizeIdentityPart(value = '', maxLength = 500) {
  return normalizeText(value, maxLength)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeStableExternalIdentity(value = '') {
  const normalized = normalizeText(value, 120);
  return normalized ? encodeURIComponent(normalized) : '';
}

function sourceExternalIdentity(sourceId = '', externalId = '', stableExternalId = false) {
  if (!sourceId || !externalId) return '';
  const normalized = stableExternalId || sourceId === dealOsSourceId
    ? normalizeStableExternalIdentity(externalId)
    : /^\d+$/.test(normalizeText(externalId, 120))
      ? ''
      : normalizeIdentityPart(externalId, 120);
  return normalized ? `${sourceId}:${normalized}` : '';
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = normalizeText(value, 100)
    .toLowerCase()
    .replace(/[$,%]/g, '')
    .replace(/,/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?\s*(billion|bn|b|million|mm|m|thousand|k)?/);

  if (!match) {
    return null;
  }

  const parsed = Number(match[0].match(/-?\d+(?:\.\d+)?/)?.[0]);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  const suffix = match[1] || '';
  const multiplier =
    suffix === 'billion' || suffix === 'bn' || suffix === 'b'
      ? 1_000_000_000
      : suffix === 'million' || suffix === 'mm' || suffix === 'm'
        ? 1_000_000
        : suffix === 'thousand' || suffix === 'k'
          ? 1_000
          : 1;

  return parsed * multiplier;
}

function parseDate(value) {
  const normalized = normalizeText(value, 100);
  const numeric = Number(normalized);

  if (/^\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(numeric) && numeric >= 20_000 && numeric < 2_958_466) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + numeric * 24 * 60 * 60 * 1000).toISOString();
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function getField(row, aliases) {
  const valuesByKey = Object.entries(row || {}).reduce((accumulator, [key, value]) => {
    accumulator.set(normalizeKey(key), value);
    return accumulator;
  }, new Map());

  for (const alias of aliases) {
    const value = valuesByKey.get(normalizeKey(alias));

    if (value !== undefined && value !== null && normalizeText(value) !== '') {
      return value;
    }
  }

  return '';
}

function containsAny(text, terms) {
  const normalized = String(text || '').toLowerCase();
  return terms.filter((term) => {
    const normalizedTerm = term.toLowerCase();

    if (/^[a-z0-9]+$/.test(normalizedTerm) && normalizedTerm.length <= 4) {
      return new RegExp(`(^|[^a-z0-9])${normalizedTerm}([^a-z0-9]|$)`, 'i').test(normalized);
    }

    return normalized.includes(normalizedTerm);
  });
}

function formatLocation({ city, county, state, country }) {
  return [city, county, state, country].map((item) => normalizeText(item, 80)).filter(Boolean).join(', ');
}

function normalizeDealRecord(rawRow = {}, source = {}) {
  const listing = getField(rawRow, ['Original Broker Listing URL', 'View Listing URL', 'Listing URL', 'Deal URL', 'URL', 'Link', 'Deal Link', 'Business URL', 'View Listing', 'Listing']);
  const listingUrl = normalizeUrl(listing?.url || listing);
  const city = normalizeText(getField(rawRow, ['City']), 80);
  const county = normalizeText(getField(rawRow, ['County']), 120);
  const state = normalizeText(getField(rawRow, ['State', 'Province']), 40).toUpperCase();
  const country = normalizeText(getField(rawRow, ['Country']), 40);
  const industry = normalizeText(getField(rawRow, ['Industry', 'Industries', 'Category', 'Business Type', 'Sector']), 500);
  const description = normalizeText(getField(rawRow, ['Description', 'Summary', 'Listing Description', 'Business Description', 'Notes']), 5000);
  const annualProfit = parseNumber(getField(rawRow, ['Annual Profit', 'Cash Flow', 'SDE', 'EBITDA', 'TTM EBITDA', 'Earnings', 'Profit']));
  const annualRevenue = parseNumber(getField(rawRow, ['Annual Revenue', 'Revenue', 'TTM Revenue', 'Sales', 'Gross Revenue']));
  const askingPrice = parseNumber(getField(rawRow, ['Asking Price', 'Price', 'Purchase Price', 'List Price']));
  const profitMultiple = parseNumber(getField(rawRow, ['Profit Multiple', 'SDE Multiple', 'EBITDA Multiple', 'Multiple']));
  const netMargin = parseNumber(getField(rawRow, ['Net Margin', 'Profit Margin', 'EBITDA Margin', 'SDE Margin', 'Margin %', 'Margin']));
  const yearsEstablished = parseNumber(getField(rawRow, ['Years Established', 'Years In Business', 'Business Age', 'Age']));
  const remoteFlag = normalizeText(getField(rawRow, ['Remote/Relocatable/Absentee-Run', 'Remote', 'Relocatable', 'Absentee', 'Absentee Run']), 100);
  const franchiseFlag = normalizeText(getField(rawRow, ['Franchise', 'Is Franchise', 'Include Franchises']), 100);
  const fiveYearsFlag = normalizeText(getField(rawRow, ['5+ Years In Business', '5+ Years', 'Five Years In Business']), 100);
  const sourceBrokerName = normalizeText(getField(rawRow, ['Broker Name', 'Broker']), 160);
  const sourceContactName = normalizeText(getField(rawRow, ['Contact Name']), 160);
  const extractedBrokerContacts = extractBrokerContacts(rawRow, { broker: sourceBrokerName, contact: sourceContactName });
  const sourceBrokerEmail = extractEmailAddresses(getField(rawRow, ['Broker Email']))[0] || '';
  const brokerCompany = normalizeText(getField(rawRow, ['Broker Company', 'Company']), 160);
  const brokerPhone = normalizeText(getField(rawRow, ['Broker Phone']), 200);
  const brokerContact = normalizeText(getField(rawRow, ['Broker Contact', 'Broker Phone', 'Phone', 'Contact Phone']), 200);
  const name = normalizeText(getField(rawRow, ['Name', 'Business Name', 'Business', 'Company', 'Title', 'Listing Title', 'Deal Name', 'Listing']), 220) || 'Unnamed business';
  const dateAdded = parseDate(getField(rawRow, ['Date Added', 'Created', 'Created At', 'Added Date', 'Posted Date', 'Date Listed', 'Listing Date']));
  const lastUpdated = parseDate(getField(rawRow, ['Last Updated', 'Updated', 'Updated At', 'Modified', 'Last Modified']));
  const explicitExternalId = normalizeText(getField(rawRow, ['Deal OS ID', 'SMB Deal OS ID', 'Listing ID', 'Deal ID', 'Opportunity ID', 'ID', 'Record ID', 'Ad ID', 'Ad#']), 120);
  const sourceRowId = normalizeText(source.rowId, 120);
  const id = explicitExternalId || sourceRowId;
  const stableExternalId = Boolean(source.stableExternalId || explicitExternalId);
  const listingSource = normalizeText(getField(rawRow, ['Listing Source', 'Original Source', 'Source', 'Marketplace', 'Platform']), 220);
  const brokerContacts = normalizeBrokerContacts(extractedBrokerContacts.map((contact) => ({
    ...contact,
    sourceId: source.id || source.name || 'unknown',
    sourceName: source.name || 'Unknown source',
    sourceRecordId: id,
    sourceListingUrl: listingUrl,
  })));
  const preferredBrokerContact = brokerContacts[0] || null;
  const brokerEmail = sourceBrokerEmail || preferredBrokerContact?.email || '';
  const brokerName = sourceBrokerName || preferredBrokerContact?.name || '';
  const fullText = normalizeText([name, industry, description, city, county, state, remoteFlag, franchiseFlag].join(' '), 9000);

  return {
    id,
    stableExternalId,
    sourceRowId,
    idFromSourceRowPosition: Boolean(
      !explicitExternalId
      && /^sheet-\d+$/.test(normalizeText(source.id, 80))
      && /^\d+$/.test(sourceRowId),
    ),
    sourceId: source.id || source.name || 'unknown',
    sourceName: source.name || 'Unknown source',
    sourceMode: source.mode || '',
    name,
    industry,
    description,
    city,
    county,
    state,
    country,
    location: formatLocation({ city, county, state, country }),
    annualProfit,
    annualRevenue,
    askingPrice,
    profitMultiple,
    netMargin,
    yearsEstablished,
    remoteFlag,
    franchiseFlag,
    fiveYearsFlag,
    brokerEmail,
    brokerName,
    brokerContacts,
    brokerCompany,
    brokerContact,
    brokerPhone,
    listingUrl,
    listingSource,
    dateAdded,
    lastUpdated,
    fullText,
    raw: rawRow,
  };
}

function isYes(value = '') {
  return /^(yes|true|y|1)$/i.test(normalizeText(value, 40));
}

function buildQuestions(deal, matches, concerns) {
  const questions = [];

  if (!deal.annualProfit) {
    questions.push('What is the trailing 12-month SDE or EBITDA, and what owner add-backs are included?');
  }

  if (!containsAny(deal.fullText, ['recurring', 'contract', 'agreement', 'repeat']).length) {
    questions.push('How much revenue is recurring, contracted, or repeat customer work versus one-time projects?');
  }

  if (!matches.management.length) {
    questions.push('What weekly operating tasks does the owner handle today, and who can run the business during a transition?');
  }

  questions.push('What customer concentration exists in the top 5 and top 10 accounts?');

  if (!matches.recession.length) {
    questions.push('Why do customers keep buying during a downturn, and which services are mandatory or compliance-driven?');
  }

  if (deal.askingPrice) {
    questions.push('Would the seller consider seller financing, an earnout, or other structure to reduce the cash down payment?');
  }

  if (concerns.some((concern) => /capex|equipment|real estate/i.test(concern))) {
    questions.push('What near-term capex, vehicle, equipment, lease, or real estate obligations would a buyer inherit?');
  }

  return [...new Set(questions)].slice(0, 5);
}

function addScoreCap(caps, cap, reason, ruleId = '') {
  caps.push({ cap, reason, ruleId, applied: false });
}

function applyScoreCaps(score, caps, concerns) {
  let cappedScore = score;

  for (const item of caps) {
    if (cappedScore > item.cap) {
      cappedScore = item.cap;
      item.applied = true;
    }

    if (item.reason) {
      concerns.push(item.reason);
    }
  }

  return cappedScore;
}

function dealFieldPresent(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
}

function dealCompleteness(deal = {}) {
  const checks = [
    ['name', 10, deal.name],
    ['listingUrl', 10, deal.listingUrl],
    ['location', 8, deal.state || deal.location],
    ['annualProfit', 16, deal.annualProfit],
    ['annualRevenue', 10, deal.annualRevenue],
    ['askingPrice', 10, deal.askingPrice],
    ['industry', 8, deal.industry],
    ['description', 12, normalizeText(deal.description, 10000).length >= 40 ? deal.description : ''],
    ['yearsEstablished', 6, deal.yearsEstablished ?? deal.fiveYearsFlag],
    ['brokerContact', 10, deal.brokerEmail || deal.brokerContact || deal.brokerName],
  ];
  const missingEvidence = checks.filter(([, , value]) => !dealFieldPresent(value)).map(([field]) => field);
  const completenessScore = checks.reduce((sum, [, weight, value]) => sum + (dealFieldPresent(value) ? weight : 0), 0);
  const narrativeEvidenceAvailable = normalizeText([deal.industry, deal.description].filter(Boolean).join(' '), 20000).length >= 40;
  const evidenceConfidence = completenessScore >= 80 ? 'high' : completenessScore >= 55 ? 'medium' : 'low';

  return {
    completenessScore,
    evidenceConfidence,
    missingEvidence,
    narrativeEvidenceAvailable,
  };
}

export function scoreDeal(deal, ledger = null) {
  const semantic = matchDealNarrative(deal.fullText, profile);
  // The ledger is an optional observer used by the scoring service to explain a
  // score. Anything that is not a ledger is ignored, so passing this function
  // directly as an array callback cannot corrupt scoring.
  const record = ledger && typeof ledger.baseline === 'function' ? ledger : null;
  const completeness = dealCompleteness(deal);
  const matches = {
    // Category gates keep raw substring matching. Suppressing a gate would
    // admit a disqualified listing, which is the expensive error; a false gate
    // is merely reviewable.
    excluded: containsAny(deal.fullText, profile.excludedKeywords),
    // Every other family is matched semantically: a term still matches wherever
    // it matched before unless a documented rule suppresses that occurrence.
    ...semantic.matches,
  };
  const strengths = [];
  const concerns = [];
  const removeReasons = [];
  const scoreCaps = [];
  let score = 28;
  record?.baseline(score);

  if (matches.excluded.length > 0) {
    removeReasons.push(`Excluded category match: ${matches.excluded.slice(0, 4).join(', ')}`);
    record?.gate('gate.excluded-category', `Excluded category match: ${matches.excluded.slice(0, 4).join(', ')}`, { field: 'fullText', terms: matches.excluded });
  }

  if (isYes(deal.franchiseFlag)) {
    removeReasons.push('Franchise listing, which is outside the current acquisition strategy.');
    record?.gate('gate.franchise', 'Franchise listing, which is outside the current acquisition strategy.', { field: 'franchiseFlag', value: deal.franchiseFlag });
  }

  if (deal.annualProfit !== null) {
    if (deal.annualProfit >= profile.minAnnualProfit && deal.annualProfit <= profile.maxAnnualProfit) {
      score += 18;
      record?.adjust('profit.in-band', 18, { field: 'annualProfit', value: deal.annualProfit });
      strengths.push('Annual profit is inside the target $300k-$750k range.');
    } else if (deal.annualProfit >= 200000 && deal.annualProfit < profile.minAnnualProfit) {
      score += 2;
      record?.adjust('profit.below-floor', 2, { field: 'annualProfit', value: deal.annualProfit });
      concerns.push('Profit is below the target floor; review only if recurring revenue and management depth are unusually strong.');
    } else if (deal.annualProfit < 200000) {
      score -= 22;
      record?.adjust('profit.well-below', -22, { field: 'annualProfit', value: deal.annualProfit });
      addScoreCap(scoreCaps, 52, 'Profit is well below the current acquisition target and should not qualify as a high-fit deal.', 'profit.well-below');
      concerns.push('Profit is well below the current acquisition target.');
    } else if (deal.annualProfit > 1000000) {
      score -= 12;
      record?.adjust('profit.far-above-band', -12, { field: 'annualProfit', value: deal.annualProfit });
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Profit is materially above the target band and likely requires a different capital structure.', 'profit.far-above-band');
      concerns.push('Profit is materially above the current target band and likely needs a larger equity check.');
    } else {
      score -= 4;
      record?.adjust('profit.above-band', -4, { field: 'annualProfit', value: deal.annualProfit });
      concerns.push('Profit is above the current target band and may require a larger equity check.');
    }
  } else {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Annual profit is missing, so the listing cannot qualify as high fit yet.', 'profit.missing');
    record?.absent('profit.missing', { field: 'annualProfit' });
    concerns.push('Annual profit is missing.');
  }

  if (deal.yearsEstablished !== null) {
    if (deal.yearsEstablished >= 5) {
      score += 6;
      record?.adjust('age.established', 6, { field: 'yearsEstablished', value: deal.yearsEstablished });
      strengths.push('Business age clears the 5+ year preference.');
    } else {
      score -= 8;
      record?.adjust('age.young', -8, { field: 'yearsEstablished', value: deal.yearsEstablished });
      concerns.push('Business appears younger than the 5+ year preference.');
    }
  } else if (isYes(deal.fiveYearsFlag)) {
    score += 5;
    record?.adjust('age.flagged', 5, { field: 'fiveYearsFlag', value: deal.fiveYearsFlag });
    strengths.push('Source marks this as 5+ years in business.');
  }

  if (deal.profitMultiple !== null) {
    if (deal.profitMultiple > 0 && deal.profitMultiple <= 3.25) {
      score += 12;
      record?.adjust('multiple.financeable', 12, { field: 'profitMultiple', value: deal.profitMultiple });
      strengths.push('Profit multiple appears financeable for a self-funded/SBA-style acquisition.');
    } else if (deal.profitMultiple > 3.25 && deal.profitMultiple <= 4) {
      score += 5;
      record?.adjust('multiple.workable', 5, { field: 'profitMultiple', value: deal.profitMultiple });
      strengths.push('Profit multiple may be workable if SBA, seller note, or investor structure checks out.');
    } else if (deal.profitMultiple > 4 && deal.profitMultiple <= 5) {
      score -= 8;
      record?.adjust('multiple.above-preferred', -8, { field: 'profitMultiple', value: deal.profitMultiple });
      addScoreCap(scoreCaps, 82, 'Profit multiple is above the preferred range; require strong financing and growth evidence.', 'multiple.above-preferred');
      concerns.push('Profit multiple is above the preferred range for the current buying strategy.');
    } else if (deal.profitMultiple > 5) {
      score -= 16;
      record?.adjust('multiple.too-high', -16, { field: 'profitMultiple', value: deal.profitMultiple });
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Profit multiple is too high for a high-fit rating without exceptional structure.', 'multiple.too-high');
      concerns.push('Profit multiple is high for the current buying strategy.');
    }
  } else if (deal.askingPrice && deal.annualProfit) {
    const impliedMultiple = deal.askingPrice / deal.annualProfit;

    if (impliedMultiple <= 3.25) {
      score += 10;
      record?.adjust('implied-multiple.financeable', 10, { field: 'impliedMultiple', value: impliedMultiple });
      strengths.push('Implied asking-price-to-profit multiple looks reasonable.');
    } else if (impliedMultiple <= 4) {
      score += 4;
      record?.adjust('implied-multiple.workable', 4, { field: 'impliedMultiple', value: impliedMultiple });
      strengths.push('Implied multiple may be workable if financing terms are favorable.');
    } else if (impliedMultiple <= 5) {
      score -= 8;
      record?.adjust('implied-multiple.above-preferred', -8, { field: 'impliedMultiple', value: impliedMultiple });
      addScoreCap(scoreCaps, 82, 'Implied multiple is above the preferred range; require stronger diligence before advancing.', 'implied-multiple.above-preferred');
      concerns.push('Implied asking-price-to-profit multiple is above the preferred range.');
    } else if (impliedMultiple > 5) {
      score -= 16;
      record?.adjust('implied-multiple.too-high', -16, { field: 'impliedMultiple', value: impliedMultiple });
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Implied multiple is too expensive for a high-fit rating.', 'implied-multiple.too-high');
      concerns.push('Implied asking-price-to-profit multiple looks expensive.');
    }
  }

  if (deal.askingPrice) {
    if (deal.askingPrice >= 500000 && deal.askingPrice <= 1500000) {
      score += 7;
      record?.adjust('asking.in-band', 7, { field: 'askingPrice', value: deal.askingPrice });
      strengths.push('Asking price is within a plausible range for ROBS cash plus SBA, seller note, or investors.');
    } else if (deal.askingPrice > 2000000) {
      score -= 14;
      record?.adjust('asking.too-large', -14, { field: 'askingPrice', value: deal.askingPrice });
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Asking price likely requires outside equity or unusually favorable seller financing.', 'asking.too-large');
      concerns.push('Asking price likely needs outside equity or unusually favorable seller financing.');
    } else if (deal.askingPrice < 250000) {
      score -= 5;
      record?.adjust('asking.too-small', -5, { field: 'askingPrice', value: deal.askingPrice });
      addScoreCap(scoreCaps, 66, 'Small asking price may indicate a smaller owner-operator opportunity.', 'asking.too-small');
      concerns.push('Small asking price may indicate a smaller owner-operator opportunity.');
    }
  }

  if (matches.preferred.length > 0) {
    score += Math.min(10, matches.preferred.length * 2);
    record?.adjust('preferred.present', Math.min(10, matches.preferred.length * 2), { field: 'fullText', terms: matches.preferred });
    strengths.push(`Matches preferred search themes: ${matches.preferred.slice(0, 5).join(', ')}.`);
  }

  if (matches.recurring.length > 0) {
    score += Math.min(14, matches.recurring.length * 3);
    record?.adjust('recurring.present', Math.min(14, matches.recurring.length * 3), { field: 'fullText', terms: matches.recurring });
    strengths.push(`Recurring or repeat revenue signals: ${matches.recurring.slice(0, 4).join(', ')}.`);
  } else if (completeness.narrativeEvidenceAvailable) {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'No explicit recurring, contracted, scheduled, or repeat revenue signal.', 'recurring.absent');
    record?.absent('recurring.absent', { field: 'fullText' });
    concerns.push('No explicit recurring, contracted, scheduled, or repeat revenue signal.');
  } else {
    record?.absent('recurring.unknown', { field: 'description' });
    concerns.push('Recurring or repeat revenue is unknown because the source did not include enough narrative evidence.');
  }

  if (matches.commercial.length > 0) {
    score += Math.min(8, matches.commercial.length * 2);
    record?.adjust('commercial.present', Math.min(8, matches.commercial.length * 2), { field: 'fullText', terms: matches.commercial });
    strengths.push(`Commercial or institutional customer signals: ${matches.commercial.slice(0, 4).join(', ')}.`);
  }

  if (matches.recession.length > 0) {
    score += Math.min(12, matches.recession.length * 3);
    record?.adjust('recession.present', Math.min(12, matches.recession.length * 3), { field: 'fullText', terms: matches.recession });
    strengths.push(`Recession-resistant indicators: ${matches.recession.slice(0, 4).join(', ')}.`);
  } else if (completeness.narrativeEvidenceAvailable) {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'No clear recession-resistant indicator in the listing text.', 'recession.absent');
    record?.absent('recession.absent', { field: 'fullText' });
    concerns.push('No clear recession-resistant indicator in the listing text.');
  } else {
    record?.absent('recession.unknown', { field: 'description' });
    concerns.push('Recession resistance is unknown because the source did not include enough narrative evidence.');
  }

  if (matches.aiProof.length > 0) {
    score += Math.min(12, matches.aiProof.length * 3);
    record?.adjust('ai-resistance.present', Math.min(12, matches.aiProof.length * 3), { field: 'fullText', terms: matches.aiProof });
    strengths.push(`AI-resistant operating work: ${matches.aiProof.slice(0, 4).join(', ')}.`);
  } else if (completeness.narrativeEvidenceAvailable) {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'No clear physical, field-service, regulated, or relationship-heavy work signal.', 'ai-resistance.absent');
    record?.absent('ai-resistance.absent', { field: 'fullText' });
    concerns.push('No clear physical, field-service, regulated, or relationship-heavy work signal.');
  } else {
    record?.absent('ai-resistance.unknown', { field: 'description' });
    concerns.push('AI resistance is unknown because the source did not include enough narrative evidence.');
  }

  if (matches.management.length > 0 || /yes/i.test(deal.remoteFlag)) {
    score += 7;
    record?.adjust('management.present', 7, { field: 'fullText', terms: matches.management.length > 0 ? matches.management : ['remote flag'] });
    strengths.push('Remote, absentee, turnkey, staff, or management signal exists.');
  } else {
    record?.absent('management.absent', { field: 'fullText' });
    concerns.push('Management in place is not shown; this is acceptable but needs diligence.');
  }

  if (matches.capex.length > 0) {
    score -= Math.min(12, matches.capex.length * 3);
    record?.adjust('capex.present', -Math.min(12, matches.capex.length * 3), { field: 'fullText', terms: matches.capex });
    addScoreCap(scoreCaps, 82, 'Capex or asset-heavy language requires extra diligence before high conviction.', 'capex.present');
    concerns.push(`Possible capex or asset-heavy concern: ${matches.capex.slice(0, 4).join(', ')}.`);
  }

  if (matches.financeable.length > 0) {
    score += Math.min(6, matches.financeable.length * 2);
    record?.adjust('financeable.signals', Math.min(6, matches.financeable.length * 2), { field: 'fullText', terms: matches.financeable });
    strengths.push(`Financing support signals: ${matches.financeable.slice(0, 3).join(', ')}.`);
  }

  if (matches.ownerDependency.length > 0) {
    score -= Math.min(12, matches.ownerDependency.length * 4);
    record?.adjust('owner-dependency.present', -Math.min(12, matches.ownerDependency.length * 4), { field: 'fullText', terms: matches.ownerDependency });
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, `Owner-dependency risk language found: ${matches.ownerDependency.slice(0, 3).join(', ')}.`, 'owner-dependency.present');
  }

  if (matches.concentrationRisk.length > 0) {
    score -= Math.min(12, matches.concentrationRisk.length * 4);
    record?.adjust('concentration.present', -Math.min(12, matches.concentrationRisk.length * 4), { field: 'fullText', terms: matches.concentrationRisk });
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, `Customer concentration risk language found: ${matches.concentrationRisk.slice(0, 3).join(', ')}.`, 'concentration.present');
  }

  const nonCapexFinancialRisks = matches.financialRisk.filter((term) => !matches.capex.includes(term) && !matches.concentrationRisk.includes(term));

  if (nonCapexFinancialRisks.length > 0) {
    score -= Math.min(10, nonCapexFinancialRisks.length * 3);
    record?.adjust('financial-risk.present', -Math.min(10, nonCapexFinancialRisks.length * 3), { field: 'fullText', terms: nonCapexFinancialRisks });
    addScoreCap(scoreCaps, 72, `Financial quality risk language found: ${nonCapexFinancialRisks.slice(0, 3).join(', ')}.`, 'financial-risk.present');
  }

  if (deal.state && profile.targetStates.includes(deal.state)) {
    score += 3;
    record?.adjust('geography.target-state', 3, { field: 'state', value: deal.state });
    strengths.push(`Located in target state ${deal.state}.`);
  } else if (/yes/i.test(deal.remoteFlag)) {
    score += 3;
    record?.adjust('geography.remote', 3, { field: 'remoteFlag', value: deal.remoteFlag });
    strengths.push('Location concern reduced because the listing is remote, relocatable, or absentee-run.');
  }

  const preFloorScore = score;

  if (removeReasons.length > 0) {
    score = Math.min(score, 34);
    if (score !== preFloorScore) record?.floor('gate.removed-floor', 34);
  } else if (deal.annualProfit === null) {
    score = Math.min(score, highFitScoreThreshold - 1);
    if (score !== preFloorScore) record?.floor('profit.missing', highFitScoreThreshold - 1);
  }

  score = applyScoreCaps(score, scoreCaps, concerns);
  score = Math.max(0, Math.min(100, Math.round(score)));
  record?.finalize({ caps: scoreCaps, score, completeness, removeReasons, semantic });
  const shouldRemove = removeReasons.length > 0 || score < 45;
  const highFit = !shouldRemove && score >= highFitScoreThreshold && deal.annualProfit !== null;
  const scoreStatus = completeness.evidenceConfidence === 'low'
    ? 'provisional'
    : highFit
      ? 'high-fit'
      : shouldRemove
        ? 'remove'
        : 'watchlist';
  const recommendation = shouldRemove
    ? 'Remove from tomorrow\'s daily update unless there is a specific strategic reason to keep it.'
    : score >= highFitScoreThreshold
      ? 'High fit. Request the CIM/NDA process and validate financial quality before advancing.'
      : 'Watchlist. Worth reviewing only if the broker confirms recurring revenue, AI/recession resistance, management depth, and clean financing terms.';

  return {
    ...deal,
    score,
    fitScore: score,
    completenessScore: completeness.completenessScore,
    evidenceConfidence: completeness.evidenceConfidence,
    scoreStatus,
    missingEvidence: completeness.missingEvidence,
    scoreReasons: [...new Set([...strengths, ...concerns])].slice(0, 12),
    scoringRuleVersion: dealHunterScoringRuleVersion,
    completenessPolicyVersion: dealHunterCompletenessPolicyVersion,
    actionEligibility: {
      highFit,
      crmSync: !shouldRemove && Boolean(deal.opportunityId || deal.dealKey),
      cimRequest: highFit && completeness.evidenceConfidence !== 'low',
      reason: highFit
        ? 'Fit score and annual-profit evidence satisfy the high-fit rule.'
        : deal.annualProfit === null
          ? 'Annual profit is required before high-fit outreach.'
          : shouldRemove
            ? 'The listing is outside the current acquisition profile.'
            : 'The listing remains a sourced/watchlist CRM record without automatic outreach.',
    },
    strengths: [...new Set(strengths)].slice(0, 6),
    concerns: [...new Set(concerns)].slice(0, 7),
    removeReasons: removeReasons.length > 0 ? removeReasons : score < 45 ? concerns.slice(0, 3) : [],
    questions: buildQuestions(deal, matches, concerns),
    recommendation,
    shouldRemove,
  };
}

function parseCsvRows(csvText = '') {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    const nextCharacter = csvText[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === ',' && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

      row.push(value);
      value = '';

      if (row.some((item) => item.trim() !== '')) {
        rows.push(row);
      }

      row = [];
    } else {
      value += character;
    }
  }

  row.push(value);

  if (row.some((item) => item.trim() !== '')) {
    rows.push(row);
  }

  if (rows.length < 2) {
    return [];
  }

  const usedHeaders = new Set();
  const duplicateCounts = new Map();
  const headers = rows[0].map((header, index) => {
    const base = normalizeText(header, 160) || `Column ${index + 1}`;
    let count = (duplicateCounts.get(base) || 0) + 1;
    let candidate = count === 1 ? base : `${base} ${count}`;

    while (usedHeaders.has(candidate)) {
      count += 1;
      candidate = `${base} ${count}`;
    }

    duplicateCounts.set(base, count);
    usedHeaders.add(candidate);
    return candidate;
  });
  return rows.slice(1).map((values) =>
    headers.reduce((record, header, index) => {
      record[header] = normalizeText(values[index] || '', 5000);
      return record;
    }, Object.create(null)),
  );
}

function normalizeDailyDealUpdateRow(row = {}) {
  if (getField(row, ['Date Added'])) {
    return row;
  }

  const entries = Object.entries(row);
  const [firstHeader, firstValue] = entries[0] || [];
  const looksLikeDailyDealUpdate = normalizeKey(firstHeader).startsWith('onmarketdealtracker')
    && entries.some(([header]) => normalizeKey(header) === 'name')
    && entries.some(([header]) => normalizeKey(header) === 'annualprofit')
    && entries.some(([header]) => normalizeKey(header) === 'brokername')
    && entries.some(([header]) => normalizeKey(header) === 'brokeremail');

  if (!looksLikeDailyDealUpdate) {
    return row;
  }

  return {
    ...row,
    'Date Added': firstValue,
  };
}

function decodeXmlCodePoint(code = '', radix = 10) {
  const value = Number.parseInt(code, radix);

  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return '\ufffd';
  }

  return String.fromCodePoint(value);
}

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => decodeXmlCodePoint(code))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => decodeXmlCodePoint(code, 16))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getXmlAttribute(attributes = '', name = '') {
  for (const match of String(attributes || '').matchAll(/([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (match[1] === name) return decodeXmlEntities(match[2] ?? match[3] ?? '');
  }

  return '';
}

function extractXmlTextRuns(xml = '') {
  return [...String(xml || '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXmlEntities(match[1]))
    .join('');
}

function parseWorksheetCells(worksheetXml = '', sharedStrings = []) {
  return [...String(worksheetXml || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((match) => {
    const attributes = match[1];
    const body = match[2] || '';
    const ref = getXmlAttribute(attributes, 'r').toUpperCase();
    const type = getXmlAttribute(attributes, 't');
    const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
    const value = type === 's'
      ? sharedStrings[Number(rawValue)] || ''
      : type === 'inlineStr'
        ? extractXmlTextRuns(body)
        : decodeXmlEntities(rawValue);
    const formula = decodeXmlEntities(body.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/)?.[1] || '');

    return { formula, ref, value };
  });
}

function extractHyperlinkFormulaTarget(formula = '') {
  const target = String(formula || '').match(/HYPERLINK\(\s*"((?:""|[^"])*)"/i)?.[1] || '';
  return target.replace(/""/g, '"');
}

function worksheetColumn(ref = '') {
  return String(ref || '').toUpperCase().match(/^[A-Z]+/)?.[0] || '';
}

function worksheetColumnIndex(ref = '') {
  return [...worksheetColumn(ref)].reduce((index, character) => index * 26 + character.charCodeAt(0) - 64, 0);
}

function parseWorksheetRelationshipTargets(relationshipsXml = '') {
  const targets = new Map();

  for (const match of String(relationshipsXml || '').matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1];
    const type = getXmlAttribute(attributes, 'Type');
    const id = getXmlAttribute(attributes, 'Id');
    const target = getXmlAttribute(attributes, 'Target');
    const targetMode = getXmlAttribute(attributes, 'TargetMode');

    if (id && target && type.endsWith('/hyperlink') && targetMode.toLowerCase() === 'external') targets.set(id, target);
  }

  return targets;
}

function extractWorksheetListingUrls(worksheetXml = '', relationshipsXml = '', sharedStrings = []) {
  const cells = parseWorksheetCells(worksheetXml, sharedStrings);
  const header = cells
    .filter((cell) => !cell.formula && normalizeComparableText(cell.value) === 'view listing')
    .sort((left, right) => Number(left.ref.match(/\d+$/)?.[0] || Infinity) - Number(right.ref.match(/\d+$/)?.[0] || Infinity))[0];

  if (!header) return null;

  const listingColumn = header.ref.match(/^[A-Z]+/)?.[0] || '';
  const headerRow = Number(header.ref.match(/\d+$/)?.[0] || 0);

  if (!listingColumn || !headerRow) return null;

  const cellsByRow = new Map();

  for (const cell of cells) {
    const row = Number(cell.ref.match(/\d+$/)?.[0] || 0);
    if (row <= headerRow) continue;
    if (!cellsByRow.has(row)) cellsByRow.set(row, []);
    cellsByRow.get(row).push(cell);
  }

  const populatedRows = [...cellsByRow.entries()]
    .filter(([, rowCells]) => rowCells.some((cell) => normalizeText(cell.value) !== ''))
    .map(([row]) => row)
    .sort((left, right) => left - right);
  const compactIndexByRow = new Map(populatedRows.map((row, index) => [row, index]));
  const listingUrlsByPhysicalRow = new Map();
  const setListingUrl = (ref, value) => {
    const normalizedRef = String(ref || '').toUpperCase();
    if (!/^[A-Z]+\d+$/.test(normalizedRef)) return;
    const column = worksheetColumn(normalizedRef);
    const row = Number(normalizedRef.match(/\d+$/)?.[0] || 0);
    const listingUrl = normalizeUrl(value);

    if (column !== listingColumn || !compactIndexByRow.has(row) || !listingUrl) return;
    if (!listingUrlsByPhysicalRow.has(row)) listingUrlsByPhysicalRow.set(row, listingUrl);
  };

  for (const cell of cells) {
    setListingUrl(cell.ref, extractHyperlinkFormulaTarget(cell.formula));
  }

  const relationshipTargets = parseWorksheetRelationshipTargets(relationshipsXml);

  for (const match of String(worksheetXml || '').matchAll(/<hyperlink\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1];
    setListingUrl(getXmlAttribute(attributes, 'ref'), relationshipTargets.get(getXmlAttribute(attributes, 'r:id')) || '');
  }

  const listingUrlsByRow = new Map(
    [...listingUrlsByPhysicalRow.entries()].map(([row, listingUrl]) => [compactIndexByRow.get(row), listingUrl]),
  );
  const headerCells = cells
    .filter((cell) => Number(cell.ref.match(/\d+$/)?.[0] || 0) === headerRow && !cell.formula)
    .sort((left, right) => worksheetColumnIndex(left.ref) - worksheetColumnIndex(right.ref));
  const headersByColumn = new Map();
  const duplicateCounts = new Map();
  const usedHeaders = new Set();

  for (const cell of headerCells) {
    const column = worksheetColumn(cell.ref);
    const base = normalizeText(cell.value, 160);
    if (!column || !base) continue;
    let count = (duplicateCounts.get(base) || 0) + 1;
    let headerName = count === 1 ? base : `${base} ${count}`;

    while (usedHeaders.has(headerName)) {
      count += 1;
      headerName = `${base} ${count}`;
    }

    duplicateCounts.set(base, count);
    usedHeaders.add(headerName);
    headersByColumn.set(column, headerName);
  }

  const rawRowsByPhysicalRow = new Map();
  const rowNamesByIndex = new Map();

  for (const [row, rowCells] of cellsByRow) {
    const dataIndex = compactIndexByRow.get(row);
    if (dataIndex === undefined) continue;
    const rawRow = rowCells.reduce((record, cell) => {
      const headerName = headersByColumn.get(worksheetColumn(cell.ref));
      if (headerName) record[headerName] = normalizeText(cell.value, 5000);
      return record;
    }, Object.create(null));
    const name = normalizeComparableText(getField(rawRow, ['Name', 'Business Name', 'Company', 'Title', 'Listing Title']));
    rawRowsByPhysicalRow.set(row, rawRow);
    if (name) rowNamesByIndex.set(dataIndex, name);
  }

  return {
    headerRow,
    listingColumn,
    listingUrlsByPhysicalRow,
    listingUrlsByRow,
    rawRowsByPhysicalRow,
    rowNamesByIndex,
  };
}

function selectWorksheetListingUrls(candidates = [], expectedRows = []) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const expectedNames = expectedRows.map((row) => normalizeComparableText(
    getField(row, ['Name', 'Business Name', 'Company', 'Title', 'Listing Title']),
  ));
  const requiredMatches = Math.min(3, expectedNames.filter(Boolean).length);
  const expectedNameCounts = expectedNames.reduce((counts, name) => {
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
    return counts;
  }, new Map());
  const scored = candidates.map((candidate) => {
    const candidateNameCounts = [...candidate.rawRowsByPhysicalRow.values()].reduce((counts, row) => {
      const name = normalizeComparableText(getField(row, ['Name', 'Business Name', 'Company', 'Title', 'Listing Title']));
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
      return counts;
    }, new Map());
    const matches = [...candidateNameCounts].reduce(
      (count, [name, occurrences]) => count + Math.min(occurrences, expectedNameCounts.get(name) || 0),
      0,
    );
    return { ...candidate, matches };
  }).sort((left, right) => right.matches - left.matches || right.listingUrlsByRow.size - left.listingUrlsByRow.size);

  if (requiredMatches > 0 && scored[0].matches >= requiredMatches && scored[0].matches > scored[1].matches) {
    return scored[0];
  }

  throw new Error('Google Sheet workbook contains multiple View Listing worksheets, but none uniquely matches the configured CSV source.');
}

function sheetRowMatchIdentity(rawRow = {}) {
  const deal = normalizeDealRecord(rawRow);
  const number = (value) => Number.isFinite(value) ? String(value) : '';
  const name = normalizeComparableText(deal.name);
  const features = {
    dateAdded: parseDate(deal.dateAdded),
    industry: normalizeComparableText(deal.industry),
    description: normalizeComparableText(deal.description),
    city: normalizeComparableText(deal.city),
    county: normalizeComparableText(deal.county),
    state: normalizeComparableText(deal.state),
    country: normalizeComparableText(deal.country),
    annualProfit: number(deal.annualProfit),
    annualRevenue: number(deal.annualRevenue),
    askingPrice: number(deal.askingPrice),
    yearsEstablished: number(deal.yearsEstablished),
    brokerName: normalizeComparableText(deal.brokerName),
    brokerEmail: normalizeEmail(deal.brokerEmail),
  };
  const strongKey = [name, ...Object.values(features)].join('\u001f');

  return { features, name, strongKey };
}

function groupSheetRows(items = [], identityKey) {
  return items.reduce((groups, item) => {
    const key = identityKey(item);
    if (key === undefined || key === null || key === '') return groups;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function sheetRowSimilarity(left = {}, right = {}) {
  const weights = {
    dateAdded: 14,
    industry: 4,
    description: 12,
    city: 4,
    county: 3,
    state: 2,
    country: 1,
    annualProfit: 6,
    annualRevenue: 4,
    askingPrice: 6,
    yearsEstablished: 2,
    brokerName: 4,
    brokerEmail: 10,
  };

  return Object.entries(weights).reduce((score, [field, weight]) => (
    left[field] && right[field] && left[field] === right[field] ? score + weight : score
  ), 0);
}

function matchSimilarSheetRows(workbookRows = [], expectedRows = [], onMatch) {
  const remainingWorkbook = new Map(workbookRows.map((item) => [item.row, item]));
  const remainingExpected = new Map(expectedRows.map((item) => [item.index, item]));

  while (remainingWorkbook.size > 0 && remainingExpected.size > 0) {
    const comparisonCount = remainingWorkbook.size * remainingExpected.size;
    if (!Number.isSafeInteger(comparisonCount) || comparisonCount > sheetRowSimilarityMaxComparisons) break;

    const bestByWorkbook = new Map();
    const bestByExpected = new Map();
    const recordBest = (best, key, pair) => {
      const current = best.get(key);
      if (!current || pair.score > current.pair.score) {
        best.set(key, { pair, tied: false });
      } else if (pair.score === current.pair.score) {
        current.tied = true;
      }
    };

    for (const workbookItem of remainingWorkbook.values()) {
      for (const expectedItem of remainingExpected.values()) {
        const pair = {
          expectedItem,
          score: sheetRowSimilarity(workbookItem.features, expectedItem.features),
          workbookItem,
        };

        if (pair.score < 6) continue;
        recordBest(bestByWorkbook, workbookItem.row, pair);
        recordBest(bestByExpected, expectedItem.index, pair);
      }
    }
    const confirmed = [...bestByWorkbook.values()]
      .filter(({ pair, tied }) => {
        const expectedBest = bestByExpected.get(pair.expectedItem.index);
        return !tied && expectedBest && !expectedBest.tied && expectedBest.pair.workbookItem.row === pair.workbookItem.row;
      })
      .map(({ pair }) => pair);

    if (confirmed.length === 0) break;

    for (const pair of confirmed) {
      onMatch(pair.workbookItem, pair.expectedItem);
      remainingWorkbook.delete(pair.workbookItem.row);
      remainingExpected.delete(pair.expectedItem.index);
    }
  }
}

function alignWorksheetListingUrls(candidate, expectedRows = []) {
  if (expectedRows.length === 0) return candidate.listingUrlsByRow;

  const expected = expectedRows.map((rawRow, index) => ({ index, ...sheetRowMatchIdentity(rawRow) }));
  const workbook = [...candidate.listingUrlsByPhysicalRow.entries()]
    .sort(([left], [right]) => left - right)
    .map(([row, listingUrl]) => ({ listingUrl, row, ...sheetRowMatchIdentity(candidate.rawRowsByPhysicalRow.get(row)) }));
  const matchedExpectedIndexes = new Set();
  const matchedWorkbookRows = new Set();
  const listingUrlsByRow = new Map();
  const expectedByStrongKey = groupSheetRows(expected, (item) => item.strongKey);
  const workbookByStrongKey = groupSheetRows(workbook, (item) => item.strongKey);

  for (const [strongKey, workbookMatches] of workbookByStrongKey) {
    const expectedMatches = expectedByStrongKey.get(strongKey) || [];
    if (expectedMatches.length === 0 || expectedMatches.length !== workbookMatches.length) continue;
    expectedMatches.forEach((expectedMatch, index) => {
      const workbookMatch = workbookMatches[index];
      listingUrlsByRow.set(expectedMatch.index, workbookMatch.listingUrl);
      matchedExpectedIndexes.add(expectedMatch.index);
      matchedWorkbookRows.add(workbookMatch.row);
    });
  }

  const unmatchedExpectedByName = groupSheetRows(
    expected.filter((item) => !matchedExpectedIndexes.has(item.index)),
    (item) => item.name,
  );
  const unmatchedWorkbookByName = groupSheetRows(
    workbook.filter((item) => !matchedWorkbookRows.has(item.row)),
    (item) => item.name,
  );

  for (const [name, workbookMatches] of unmatchedWorkbookByName) {
    const expectedMatches = unmatchedExpectedByName.get(name) || [];
    if (workbookMatches.length === 1 && expectedMatches.length === 1) {
      listingUrlsByRow.set(expectedMatches[0].index, workbookMatches[0].listingUrl);
      continue;
    }

    matchSimilarSheetRows(workbookMatches, expectedMatches, (workbookMatch, expectedMatch) => {
      listingUrlsByRow.set(expectedMatch.index, workbookMatch.listingUrl);
    });
  }

  return listingUrlsByRow;
}

export function extractGoogleSheetListingUrls(workbookBytes, expectedRows = []) {
  let expandedBytes = 0;
  const entries = unzipSync(workbookBytes, {
    filter: (file) => {
      const needed = file.name === 'xl/sharedStrings.xml'
        || /^xl\/worksheets\/sheet\d+\.xml$/i.test(file.name)
        || /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/i.test(file.name);

      if (!needed) return false;
      const originalSize = Number(file.originalSize);
      if (!Number.isSafeInteger(originalSize) || originalSize < 0) throw new Error(`Google Sheet workbook entry has an invalid size: ${file.name}`);
      if (originalSize > sheetWorkbookEntryMaxBytes) throw new Error(`Google Sheet workbook entry is too large: ${file.name}`);
      expandedBytes += originalSize;
      if (expandedBytes > sheetWorkbookExpandedMaxBytes) throw new Error('Google Sheet workbook expands beyond the safe import limit.');
      return true;
    },
  });
  const sharedStringsXml = entries['xl/sharedStrings.xml'] ? strFromU8(entries['xl/sharedStrings.xml']) : '';
  const sharedStrings = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => extractXmlTextRuns(match[1]));
  const worksheetPaths = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const candidates = [];

  for (const worksheetPath of worksheetPaths) {
    const worksheetXml = strFromU8(entries[worksheetPath]);
    const worksheetName = worksheetPath.split('/').pop();
    const relationshipsPath = `xl/worksheets/_rels/${worksheetName}.rels`;
    const relationshipsXml = entries[relationshipsPath] ? strFromU8(entries[relationshipsPath]) : '';
    const result = extractWorksheetListingUrls(worksheetXml, relationshipsXml, sharedStrings);

    if (result) candidates.push(result);
  }

  const result = selectWorksheetListingUrls(candidates, expectedRows);
  if (!result) {
    return {
      headerRow: 0,
      listingColumn: '',
      listingUrlsByRow: new Map(),
      rowNamesByIndex: new Map(),
      unmatchedListingUrlCount: 0,
    };
  }

  const listingUrlsByRow = alignWorksheetListingUrls(result, expectedRows);
  return {
    ...result,
    listingUrlsByRow,
    unmatchedListingUrlCount: result.listingUrlsByPhysicalRow.size - listingUrlsByRow.size,
  };
}

function dealOsHeaderKinds(values = []) {
  const keys = values.map(normalizeKey);
  const nameHeaders = new Set(['name', 'businessname', 'business', 'company', 'title', 'listingtitle', 'dealname']);
  const idHeaders = new Set(['dealosid', 'smbdealosid', 'listingid', 'dealid', 'opportunityid', 'id', 'recordid', 'adid', 'ad']);
  const urlHeaders = new Set(['originalbrokerlistingurl', 'viewlistingurl', 'listingurl', 'dealurl', 'url', 'link', 'deallink', 'businessurl', 'viewlisting']);
  const hasExplicitName = keys.some((key) => nameHeaders.has(key));
  const hasExplicitUrl = keys.some((key) => urlHeaders.has(key));
  const kinds = new Set();

  for (const key of keys) {
    if (nameHeaders.has(key)) kinds.add('name');
    if (idHeaders.has(key)) kinds.add('id');
    if (urlHeaders.has(key)) kinds.add('url');
    if (key === 'listing') {
      if (hasExplicitUrl || !hasExplicitName) kinds.add('name');
      if (hasExplicitName && !hasExplicitUrl) kinds.add('url');
    }
  }

  return kinds;
}

function worksheetExternalHyperlinks(worksheetXml = '', relationshipsXml = '') {
  const relationshipTargets = parseWorksheetRelationshipTargets(relationshipsXml);
  const hyperlinks = new Map();

  for (const match of String(worksheetXml || '').matchAll(/<hyperlink\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1];
    const ref = getXmlAttribute(attributes, 'ref').toUpperCase();
    const target = relationshipTargets.get(getXmlAttribute(attributes, 'r:id')) || '';
    if (/^[A-Z]+\d+$/.test(ref) && normalizeUrl(target)) hyperlinks.set(ref, normalizeUrl(target));
  }

  return hyperlinks;
}

function extractDealOsWorksheetRows(worksheetXml = '', relationshipsXml = '', sharedStrings = []) {
  const cells = parseWorksheetCells(worksheetXml, sharedStrings).filter((cell) => /^[A-Z]+\d+$/.test(cell.ref));
  const cellsByRow = new Map();

  for (const cell of cells) {
    const row = Number(cell.ref.match(/\d+$/)?.[0] || 0);
    if (!row) continue;
    if (!cellsByRow.has(row)) cellsByRow.set(row, []);
    cellsByRow.get(row).push(cell);
  }

  const headerCandidate = [...cellsByRow.entries()]
    .map(([row, rowCells]) => {
      const kinds = [...dealOsHeaderKinds(rowCells.map((cell) => cell.value))];
      return { row, rowCells, kinds };
    })
    .filter(({ kinds }) => kinds.includes('name') && (kinds.includes('id') || kinds.includes('url')))
    .sort((left, right) => left.row - right.row)[0];

  if (!headerCandidate) return null;

  const duplicateCounts = new Map();
  const usedHeaders = new Set();
  const headersByColumn = new Map();

  for (const cell of headerCandidate.rowCells.sort((left, right) => worksheetColumnIndex(left.ref) - worksheetColumnIndex(right.ref))) {
    const column = worksheetColumn(cell.ref);
    const base = normalizeText(cell.value, 160);
    if (!column || !base) continue;
    let count = (duplicateCounts.get(base) || 0) + 1;
    let header = count === 1 ? base : `${base} ${count}`;
    while (usedHeaders.has(header)) {
      count += 1;
      header = `${base} ${count}`;
    }
    duplicateCounts.set(base, count);
    usedHeaders.add(header);
    headersByColumn.set(column, header);
  }

  if (headersByColumn.size > dealOsImportMaxColumns) {
    throw new Error(`Deal OS workbook has more than ${dealOsImportMaxColumns} columns.`);
  }

  const relationshipHyperlinks = worksheetExternalHyperlinks(worksheetXml, relationshipsXml);
  const rows = [...cellsByRow.entries()]
    .filter(([row]) => row > headerCandidate.row)
    .sort(([left], [right]) => left - right)
    .map(([, rowCells]) => rowCells.reduce((record, cell) => {
      const header = headersByColumn.get(worksheetColumn(cell.ref));
      if (!header) return record;
      const formulaUrl = normalizeUrl(extractHyperlinkFormulaTarget(cell.formula));
      const relationshipUrl = relationshipHyperlinks.get(cell.ref) || '';
      record[header] = normalizeText(relationshipUrl || formulaUrl || cell.value, 5000);
      return record;
    }, Object.create(null)))
    .filter((row) => Object.values(row).some((value) => normalizeText(value) !== ''));

  return {
    headerRow: headerCandidate.row,
    headers: [...headersByColumn.values()],
    rows,
  };
}

export function parseDealOsXlsxRows(workbookBytes) {
  let expandedBytes = 0;
  const entries = unzipSync(workbookBytes, {
    filter: (file) => {
      const needed = file.name === 'xl/sharedStrings.xml'
        || /^xl\/worksheets\/sheet\d+\.xml$/i.test(file.name)
        || /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/i.test(file.name);
      if (!needed) return false;
      const originalSize = Number(file.originalSize);
      if (!Number.isSafeInteger(originalSize) || originalSize < 0) throw new Error(`Deal OS workbook entry has an invalid size: ${file.name}`);
      if (originalSize > sheetWorkbookEntryMaxBytes) throw new Error(`Deal OS workbook entry is too large: ${file.name}`);
      expandedBytes += originalSize;
      if (expandedBytes > sheetWorkbookExpandedMaxBytes) throw new Error('Deal OS workbook expands beyond the safe import limit.');
      return true;
    },
  });
  const sharedStringsXml = entries['xl/sharedStrings.xml'] ? strFromU8(entries['xl/sharedStrings.xml']) : '';
  const sharedStrings = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => extractXmlTextRuns(match[1]));
  const worksheetPaths = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const candidates = worksheetPaths.map((worksheetPath) => {
    const worksheetName = worksheetPath.split('/').pop();
    const relationshipsPath = `xl/worksheets/_rels/${worksheetName}.rels`;
    const result = extractDealOsWorksheetRows(
      strFromU8(entries[worksheetPath]),
      entries[relationshipsPath] ? strFromU8(entries[relationshipsPath]) : '',
      sharedStrings,
    );
    return result ? { ...result, worksheetPath } : null;
  }).filter(Boolean).sort((left, right) => right.rows.length - left.rows.length || left.worksheetPath.localeCompare(right.worksheetPath));

  if (candidates.length === 0) {
    return { headers: [], rows: [], worksheetPath: '' };
  }

  return candidates[0];
}

export function buildGoogleSheetWorkbookUrl(sourceUrl = '') {
  try {
    const source = new URL(sourceUrl);
    const match = source.pathname.match(/^(\/spreadsheets\/d\/[^/]+)\/gviz\/tq\/?$/i);

    if (
      source.hostname !== 'docs.google.com'
      || !match
      || source.searchParams.get('tq')
      || source.searchParams.get('range')
      || source.searchParams.get('headers')
    ) return '';

    const gid = source.searchParams.get('gid');
    source.pathname = `${match[1]}/export`;
    source.search = '';
    source.searchParams.set('format', 'xlsx');
    if (gid) source.searchParams.set('gid', gid);
    return source.toString();
  } catch {
    return '';
  }
}

function formatPayloadLimitError(byteLength, maxBytes, label = 'Remote response') {
  const sizeMb = (byteLength / (1024 * 1024)).toFixed(1);
  const limitMb = (maxBytes / (1024 * 1024)).toFixed(1);
  return new Error(`${label} is too large to import safely (${sizeMb} MB, limit ${limitMb} MB).`);
}

async function readResponseText(response, maxBytes = Infinity, formatLimitError = formatPayloadLimitError) {
  const contentLength = Number(response.headers.get('content-length') || 0);

  if (Number.isFinite(maxBytes) && contentLength > maxBytes) {
    throw formatLimitError(contentLength, maxBytes);
  }

  if (!Number.isFinite(maxBytes) || !response.body?.getReader) {
    const text = await response.text();
    const byteLength = Buffer.byteLength(text, 'utf8');

    if (Number.isFinite(maxBytes) && byteLength > maxBytes) {
      throw formatLimitError(byteLength, maxBytes);
    }

    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    byteLength += value.byteLength;

    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      throw formatLimitError(byteLength, maxBytes);
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

async function readResponseBytes(response, maxBytes = Infinity, formatLimitError = formatPayloadLimitError) {
  const contentLength = Number(response.headers.get('content-length') || 0);

  if (Number.isFinite(maxBytes) && contentLength > maxBytes) {
    throw formatLimitError(contentLength, maxBytes);
  }

  if (!Number.isFinite(maxBytes) || !response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (Number.isFinite(maxBytes) && bytes.byteLength > maxBytes) {
      throw formatLimitError(bytes.byteLength, maxBytes);
    }

    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    byteLength += value.byteLength;

    if (byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      throw formatLimitError(byteLength, maxBytes);
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function fetchText(url, {
  headers = {},
  timeoutMs = defaultTimeoutMs,
  maxBytes = Infinity,
  payloadLabel = 'Remote response',
  limitErrorFactory,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const formatLimitError = limitErrorFactory || ((byteLength, limit) => formatPayloadLimitError(byteLength, limit, payloadLabel));

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await readResponseText(response, 16 * 1024).catch(() => '');
      throw new Error(`Fetch failed with ${response.status}: ${text.slice(0, 180)}`);
    }

    return await readResponseText(response, maxBytes, formatLimitError);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBytes(url, {
  headers = {},
  timeoutMs = defaultTimeoutMs,
  maxBytes = Infinity,
  payloadLabel = 'Remote response',
  limitErrorFactory,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const formatLimitError = limitErrorFactory || ((byteLength, limit) => formatPayloadLimitError(byteLength, limit, payloadLabel));

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await readResponseText(response, 16 * 1024).catch(() => '');
      throw new Error(`Fetch failed with ${response.status}: ${text.slice(0, 180)}`);
    }

    return await readResponseBytes(response, maxBytes, formatLimitError);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSheetCsvRows(rows = [], sourceIndex = 0, listingUrlsByRow = new Map()) {
  const safeListingUrls = listingUrlsByRow instanceof Map ? listingUrlsByRow : new Map();
  return {
    source: {
      id: `sheet-${sourceIndex}`,
      name: sourceIndex === 0 ? 'SMB Deal Hunter Google Sheet' : `Google Sheet ${sourceIndex + 1}`,
      mode: 'csv',
      fetched: true,
      rowCount: rows.length,
    },
    deals: rows.map((row, index) => normalizeDealRecord(
      safeListingUrls.get(index)
        ? { ...normalizeDailyDealUpdateRow(row), 'Original Broker Listing URL': safeListingUrls.get(index) }
        : normalizeDailyDealUpdateRow(row),
      { id: `sheet-${sourceIndex}`, name: 'SMB Deal Hunter Google Sheet', mode: 'csv', rowId: String(index + 1) },
    )),
  };
}

export function parseSheetCsvDeals(csv, sourceIndex = 0, maxRecords = Infinity, listingUrlsByRow = new Map()) {
  const safeMaxRecords = Number.isFinite(maxRecords) ? Math.max(0, maxRecords) : Infinity;
  return normalizeSheetCsvRows(parseCsvRows(csv).slice(0, safeMaxRecords), sourceIndex, listingUrlsByRow);
}

async function fetchSheetCsvDeals(url, sourceIndex, config) {
  const workbookUrl = buildGoogleSheetWorkbookUrl(url);
  const [csv, workbookDownload] = await Promise.all([
    fetchText(url, {
      maxBytes: config.dealHunter.sheetCsvMaxPayloadBytes,
      payloadLabel: 'Google Sheet CSV',
    }),
    workbookUrl
      ? fetchBytes(workbookUrl, {
        maxBytes: config.dealHunter.sheetCsvMaxPayloadBytes,
        payloadLabel: 'Google Sheet workbook',
      })
        .then((workbookBytes) => ({ workbookBytes, error: '' }))
        .catch((error) => ({ workbookBytes: null, error: normalizeText(error.message, 500) }))
      : Promise.resolve({ workbookBytes: null, error: '' }),
  ]);
  const allRows = parseCsvRows(csv);
  const rows = allRows.slice(0, config.dealHunter.maxSourceRecords);
  let workbookResult = { listingUrlsByRow: new Map(), error: workbookDownload.error };

  if (workbookDownload.workbookBytes) {
    try {
      const extracted = extractGoogleSheetListingUrls(workbookDownload.workbookBytes, allRows);
      const listingUrlsByRow = new Map(
        [...extracted.listingUrlsByRow].filter(([index]) => index >= 0 && index < rows.length),
      );
      workbookResult = { ...extracted, listingUrlsByRow, error: '' };
    } catch (error) {
      workbookResult.error = normalizeText(error.message, 500);
    }
  }

  const hasUnresolvedListingLabels = rows.some((row) => {
    const listing = getField(row, ['View Listing']);
    return normalizeText(listing) !== '' && !normalizeUrl(listing);
  });

  const result = normalizeSheetCsvRows(rows, sourceIndex, workbookResult.listingUrlsByRow);
  const listingUrlHealth = rows.map((row, index) => {
    const viewListing = getField(row, ['View Listing']);
    const expected = normalizeText(viewListing) !== '' || Boolean(normalizeDealRecord(row).listingUrl);
    return { expected, resolved: Boolean(result.deals[index]?.listingUrl) };
  });
  const listingUrlExpectedCount = listingUrlHealth.filter(({ expected }) => expected).length;
  const listingUrlCount = listingUrlHealth.filter(({ expected, resolved }) => expected && resolved).length;
  const listingUrlUnresolvedCount = listingUrlHealth.filter(({ expected, resolved }) => expected && !resolved).length;

  if (workbookUrl && !workbookResult.error && hasUnresolvedListingLabels && listingUrlUnresolvedCount > 0) {
    const count = listingUrlUnresolvedCount;
    workbookResult.error = `${count} imported CSV row${count === 1 ? '' : 's'} display${count === 1 ? 's' : ''} a View Listing label, but no safe hyperlink could be recovered for ${count === 1 ? 'it' : 'them'}.`;
  }

  return {
    ...result,
    source: {
      ...result.source,
      url,
      sourceRowCount: allRows.length,
      coverageLimitReached: allRows.length > rows.length,
      listingUrlCount,
      listingUrlExpectedCount,
      listingUrlUnresolvedCount,
      unmatchedWorkbookListingUrlCount: Number(workbookResult.unmatchedListingUrlCount || 0),
      listingUrlWarning: workbookResult.error,
    },
  };
}

function dealOsImportFailure(status, error, details = {}) {
  return { ok: false, status, error, ...details };
}

function dealOsFileName(value = '') {
  return normalizeText(String(value || '').split(/[\\/]/).pop(), 180);
}

function dealOsStableId(rawRow = {}) {
  return normalizeText(getField(rawRow, [
    'Deal OS ID', 'SMB Deal OS ID', 'Listing ID', 'Deal ID', 'Opportunity ID', 'ID', 'Record ID', 'Ad ID', 'Ad#',
  ]), 120);
}

function dealOsListingValue(rawRow = {}) {
  const explicitListing = getField(rawRow, [
    'Original Broker Listing URL', 'View Listing URL', 'Listing URL', 'Deal URL', 'URL', 'Link', 'Deal Link',
    'Business URL', 'View Listing',
  ]);

  if (explicitListing) return explicitListing;

  return dealOsHeaderKinds(Object.keys(rawRow)).has('url')
    ? getField(rawRow, ['Listing'])
    : '';
}

function canonicalDealOsRecord(rawRow = {}) {
  const stableId = dealOsStableId(rawRow);
  const suppliedListing = dealOsListingValue(rawRow);
  const listingUrl = normalizeUrl(suppliedListing?.url || suppliedListing);
  const deal = normalizeDealRecord(rawRow, {
    id: dealOsSourceId,
    name: dealOsSourceName,
    mode: 'manual-export',
    rowId: stableId,
    stableExternalId: Boolean(stableId),
  });

  return {
    stableId,
    name: deal.name,
    industry: deal.industry,
    description: deal.description,
    city: deal.city,
    county: deal.county,
    state: deal.state,
    country: deal.country,
    annualProfit: deal.annualProfit,
    annualRevenue: deal.annualRevenue,
    askingPrice: deal.askingPrice,
    profitMultiple: deal.profitMultiple,
    netMargin: deal.netMargin,
    yearsEstablished: deal.yearsEstablished,
    remoteFlag: deal.remoteFlag,
    franchiseFlag: deal.franchiseFlag,
    fiveYearsFlag: deal.fiveYearsFlag,
    brokerEmail: deal.brokerEmail,
    brokerName: deal.brokerName,
    brokerContacts: normalizeBrokerContacts((deal.brokerContacts || []).map((contact) => ({
      ...contact,
      sourceListingUrl: listingUrl,
    }))),
    brokerCompany: deal.brokerCompany,
    brokerContact: deal.brokerContact,
    brokerPhone: deal.brokerPhone,
    listingUrl,
    listingSource: deal.listingSource,
    dateAdded: deal.dateAdded,
    lastUpdated: deal.lastUpdated,
  };
}

function dealOsRecordIdentity(record = {}) {
  const stableId = normalizeStableExternalIdentity(record.stableId);
  if (stableId) return `id:${stableId}`;
  const listingIdentity = normalizeListingIdentity(record.listingUrl);
  return listingIdentity ? `url:${listingIdentity}` : '';
}

function mergeCanonicalDealOsRecords(current, incoming) {
  const merged = { ...current };

  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'brokerContacts') continue;
    if ((merged[key] === '' || merged[key] === null || merged[key] === undefined) && value !== '' && value !== null && value !== undefined) {
      merged[key] = value;
    }
  }

  merged.brokerContacts = normalizeBrokerContacts([...(current.brokerContacts || []), ...(incoming.brokerContacts || [])]);
  const preferred = merged.brokerContacts[0];
  if (preferred) {
    merged.brokerEmail = preferred.email;
    merged.brokerName = preferred.name || merged.brokerName;
  }
  return merged;
}

function dealOsRawRecord(record = {}) {
  return {
    'Deal OS ID': record.stableId || '',
    'Business Name': record.name || '',
    Industry: record.industry || '',
    Description: record.description || '',
    City: record.city || '',
    County: record.county || '',
    State: record.state || '',
    Country: record.country || '',
    'Annual Profit': record.annualProfit,
    'Annual Revenue': record.annualRevenue,
    'Asking Price': record.askingPrice,
    'Profit Multiple': record.profitMultiple,
    'Net Margin': record.netMargin,
    'Years Established': record.yearsEstablished,
    Remote: record.remoteFlag || '',
    Franchise: record.franchiseFlag || '',
    '5+ Years In Business': record.fiveYearsFlag || '',
    'Broker Name': record.brokerName || '',
    'Broker Email': record.brokerEmail || '',
    'Broker Company': record.brokerCompany || '',
    'Broker Contact': record.brokerContact || '',
    'Broker Phone': record.brokerPhone || '',
    'View Listing URL': record.listingUrl || '',
    'Listing Source': record.listingSource || '',
    'Date Added': record.dateAdded || '',
    'Last Updated': record.lastUpdated || '',
  };
}

function hydrateDealOsRecord(record = {}) {
  const raw = dealOsRawRecord(record);
  const deal = normalizeDealRecord(raw, {
    id: dealOsSourceId,
    name: dealOsSourceName,
    mode: 'manual-export',
    rowId: record.stableId || '',
    stableExternalId: Boolean(record.stableId),
  });
  const brokerContacts = normalizeBrokerContacts(record.brokerContacts || deal.brokerContacts || []);
  const preferred = brokerContacts[0];

  return {
    ...deal,
    brokerContacts,
    brokerEmail: preferred?.email || deal.brokerEmail,
    brokerName: preferred?.name || deal.brokerName,
    raw,
  };
}

function publicDealOsImport(record = {}) {
  const fieldCoverage = record.metadata?.fieldCoverage || summarizeDealOsFieldCoverage(record.records || []);
  const sourceRowCount = Number(record.source_row_count ?? record.metadata?.sourceRowCount ?? record.row_count ?? 0);
  const acceptedRowCount = Number(record.accepted_row_count ?? record.metadata?.acceptedRowCount ?? sourceRowCount);
  const rejectedRowCount = Number(record.rejected_row_count ?? record.metadata?.rejectedRowCount ?? 0);
  const canonicalRecordCount = Number(record.canonical_record_count ?? record.row_count ?? 0);
  const rowAccounting = Array.isArray(record.row_accounting)
    ? record.row_accounting
    : Array.isArray(record.metadata?.rowAccounting)
      ? record.metadata.rowAccounting
      : [];

  return {
    id: record.id,
    importedAt: record.created_at,
    importedBy: record.imported_by,
    exportedAt: record.exported_at,
    fileName: record.file_name,
    fileType: record.file_type,
    fileSize: Number(record.file_size || 0),
    scope: record.scope,
    coverageLabel: record.coverage_label,
    expectedRowCount: record.expected_row_count === null || record.expected_row_count === undefined
      ? null
      : Number(record.expected_row_count),
    rowCount: Number(record.row_count || 0),
    sourceRowCount,
    acceptedRowCount,
    rejectedRowCount,
    canonicalRecordCount,
    duplicateCount: Number(record.duplicate_count || 0),
    stableIdCount: Number(record.stable_id_count || 0),
    listingUrlCount: Number(record.listing_url_count || 0),
    coverageLimitReached: Boolean(record.coverage_limit_reached),
    fieldCoverage,
    parserVersion: record.parser_version || record.metadata?.parserVersion || 'deal-os-export-v1',
    rowAccounting,
  };
}

function summarizeDealOsFieldCoverage(records = []) {
  const normalizedRecords = Array.isArray(records) ? records : [];
  const fields = [
    ['listingUrl', 'Original listing URL', (record) => record.listingUrl],
    ['dateAdded', 'Date added', (record) => record.dateAdded],
    ['state', 'State', (record) => record.state],
    ['annualProfit', 'Earnings / annual profit', (record) => record.annualProfit],
    ['annualRevenue', 'Revenue', (record) => record.annualRevenue],
    ['askingPrice', 'Asking price', (record) => record.askingPrice],
    ['profitMultiple', 'Profit multiple', (record) => record.profitMultiple],
    ['netMargin', 'Net margin', (record) => record.netMargin],
    ['yearsEstablished', 'Years in business', (record) => record.yearsEstablished],
    ['industry', 'Industry', (record) => record.industry],
    ['description', 'Description / notes', (record) => record.description],
    ['brokerEmail', 'Broker email', (record) => record.brokerEmail || record.brokerContacts?.[0]?.email],
  ].map(([key, label, select]) => {
    const present = normalizedRecords.filter((record) => {
      const value = select(record || {});
      return value !== null && value !== undefined && String(value).trim() !== '';
    }).length;
    const total = normalizedRecords.length;
    return {
      key,
      label,
      present,
      missing: Math.max(0, total - present),
      percent: total > 0 ? Math.round((present / total) * 100) : 0,
    };
  });

  return {
    totalRecords: normalizedRecords.length,
    fields,
  };
}

function dealHunterCrmSyncSummary(values = {}) {
  return {
    reviewed: Number(values.reviewed || 0),
    created: Number(values.created || 0),
    enriched: Number(values.enriched || 0),
    updated: Number(values.updated || 0),
    skipped: Number(values.skipped || 0),
    failed: Number(values.failed || 0),
    ...(values.paused ? { paused: true } : {}),
    ...(values.notRun ? { notRun: true } : {}),
    ...(values.explicitActionRequired ? { explicitActionRequired: true } : {}),
    ...(values.reason ? { reason: values.reason } : {}),
    ...(Array.isArray(values.results) ? { results: values.results } : {}),
  };
}

function buildDealHunterImportSummary(review = {}, dealOsImport = null, crmSync = null) {
  if (!dealOsImport) return null;

  const imported = dealOsImport || {};
  const normalizedCrmSync = dealHunterCrmSyncSummary(crmSync || {});
  const syncedListings = normalizedCrmSync.created + normalizedCrmSync.enriched + normalizedCrmSync.updated;

  return {
    importId: imported.id || '',
    reviewMode: review.reviewMode || 'daily',
    importedRows: Number(imported.acceptedRowCount ?? imported.sourceRowCount ?? imported.rowCount ?? 0),
    sourceRows: Number(imported.sourceRowCount ?? imported.rowCount ?? 0),
    rejectedRows: Number(imported.rejectedRowCount || 0),
    canonicalImportRecords: Number(imported.canonicalRecordCount ?? imported.rowCount ?? 0),
    withinFileDuplicates: Number(imported.duplicateCount || 0),
    combinedSourceRows: Number(review.totals?.sourceRows || 0),
    canonicalListings: Number(review.totals?.normalizedDeals || 0),
    collapsedDuplicates: Number(review.totals?.collapsedDuplicates || 0),
    scoredListings: Number(review.totals?.reviewedDeals || 0),
    highFitListings: Number(review.totals?.qualified || 0),
    crmEligibleListings: Number(review.totals?.crmEligible || 0),
    syncedListings,
    crmSync: normalizedCrmSync,
    fieldCoverage: imported.fieldCoverage || { totalRecords: 0, fields: [] },
  };
}

function parseDealOsUpload(fileName, fileBuffer) {
  const extension = fileName.toLowerCase().match(/\.(csv|xlsx)$/)?.[1] || '';

  if (!extension) {
    return dealOsImportFailure(415, 'Deal OS exports must be uploaded as .csv or .xlsx files.');
  }

  try {
    if (extension === 'csv') {
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(fileBuffer).replace(/^\ufeff/, '');
      const rows = parseCsvRows(csv);
      return { ok: true, extension, headers: Object.keys(rows[0] || {}), rows, worksheetPath: '' };
    }

    const workbook = parseDealOsXlsxRows(fileBuffer);
    return { ok: true, extension, ...workbook };
  } catch (error) {
    return dealOsImportFailure(422, `The Deal OS ${extension.toUpperCase()} file could not be parsed safely: ${normalizeText(error.message, 300)}`);
  }
}

export async function importDealOsExport({
  fileBuffer,
  fileName = '',
  mimeType = '',
  exportedAt = '',
  scope = '',
  coverageLabel = '',
  expectedRowCount = null,
  importedBy = '',
  storage = getStorage(),
  now = new Date(),
} = {}) {
  const config = getConfig();
  const safeFileName = dealOsFileName(fileName);
  const safeBuffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer || []);
  const safeScope = normalizeText(scope, 40).toLowerCase();
  const safeCoverageLabel = normalizeText(coverageLabel, 200);
  const safeImportedBy = normalizeText(importedBy || 'admin', 160);
  const exportedTimestamp = Date.parse(exportedAt || '');
  const nowTimestamp = now instanceof Date ? now.getTime() : Date.parse(now || '');
  const maximumAgeMs = config.dealHunter.dealOsExportMaxAgeHours * 60 * 60 * 1000;

  if (!safeFileName || safeBuffer.length === 0) return dealOsImportFailure(400, 'Select a non-empty Deal OS CSV or XLSX export.');
  if (safeBuffer.length > config.dealHunter.dealOsExportMaxPayloadBytes) {
    return dealOsImportFailure(413, `Deal OS export exceeds the ${config.dealHunter.dealOsExportMaxPayloadBytes} byte upload limit.`);
  }
  if (!dealOsAllowedScopes.has(safeScope)) return dealOsImportFailure(400, 'Choose whether this is a saved-search or Deal Radar export.');
  if (!safeCoverageLabel) return dealOsImportFailure(400, 'Describe the saved search or Deal Radar filters covered by this export.');
  if (!Number.isFinite(exportedTimestamp) || !Number.isFinite(nowTimestamp)) return dealOsImportFailure(400, 'Provide a valid export timestamp.');
  if (exportedTimestamp > nowTimestamp + dealOsImportFutureToleranceMs) return dealOsImportFailure(422, 'The Deal OS export timestamp is in the future.');
  if (nowTimestamp - exportedTimestamp > maximumAgeMs) {
    return dealOsImportFailure(422, `The Deal OS export is older than the ${config.dealHunter.dealOsExportMaxAgeHours}-hour freshness limit.`);
  }

  const parsed = parseDealOsUpload(safeFileName, safeBuffer);
  if (!parsed.ok) return parsed;
  if (parsed.headers.length > dealOsImportMaxColumns) return dealOsImportFailure(422, `Deal OS export has more than ${dealOsImportMaxColumns} columns.`);
  const headerKinds = dealOsHeaderKinds(parsed.headers);
  if (!headerKinds.has('name') || (!headerKinds.has('id') && !headerKinds.has('url'))) {
    return dealOsImportFailure(422, 'The export schema is incompatible. Include a business-name column and either a Deal OS listing ID or View Listing URL column.');
  }
  if (parsed.rows.length === 0) return dealOsImportFailure(422, 'The Deal OS export contains no listing rows.');
  if (parsed.rows.length > config.dealHunter.dealOsExportMaxRecords) {
    return dealOsImportFailure(422, `The export contains ${parsed.rows.length} rows; the supported maximum is ${config.dealHunter.dealOsExportMaxRecords}.`);
  }

  let normalizedExpectedRowCount = null;
  if (expectedRowCount !== null && expectedRowCount !== undefined && String(expectedRowCount).trim() !== '') {
    normalizedExpectedRowCount = Number(expectedRowCount);
    if (!Number.isSafeInteger(normalizedExpectedRowCount) || normalizedExpectedRowCount < 1 || normalizedExpectedRowCount > config.dealHunter.dealOsExportMaxRecords) {
      return dealOsImportFailure(400, `Expected listing count must be a whole number from 1 to ${config.dealHunter.dealOsExportMaxRecords}.`);
    }
    if (normalizedExpectedRowCount !== parsed.rows.length) {
      return dealOsImportFailure(422, `Deal OS showed ${normalizedExpectedRowCount} expected listings, but the file contains ${parsed.rows.length} rows.`);
    }
  }

  const invalidRows = [];
  const recordsByIdentity = new Map();
  const acceptedRows = [];
  parsed.rows.forEach((rawRow, index) => {
    const record = canonicalDealOsRecord(rawRow);
    const suppliedListing = normalizeText(dealOsListingValue(rawRow), 1000);
    if (!record.name || record.name === 'Unnamed business') invalidRows.push(`row ${index + 2}: business name is missing`);
    if (suppliedListing && !record.listingUrl) invalidRows.push(`row ${index + 2}: listing URL is not a safe HTTP(S) URL`);
    const identity = dealOsRecordIdentity(record);
    if (!identity) invalidRows.push(`row ${index + 2}: Deal OS listing ID or View Listing URL is required`);
    if (!identity || record.name === 'Unnamed business' || (suppliedListing && !record.listingUrl)) return;
    const current = recordsByIdentity.get(identity);
    recordsByIdentity.set(identity, current ? mergeCanonicalDealOsRecords(current, record) : record);
    acceptedRows.push({
      rowNumber: index + 2,
      identity,
      stableId: record.stableId || '',
      listingIdentity: normalizeListingIdentity(record.listingUrl),
    });
  });

  if (invalidRows.length > 0) {
    return dealOsImportFailure(422, `The export has ${invalidRows.length} invalid row${invalidRows.length === 1 ? '' : 's'}.`, {
      details: invalidRows.slice(0, 10),
    });
  }

  if (!storage.insertDealHunterDealOsImport) {
    throw new Error('Deal OS import storage is unavailable.');
  }

  const records = [...recordsByIdentity.values()];
  const canonicalIndexByIdentity = new Map(records.map((record, index) => [dealOsRecordIdentity(record), index]));
  const rowAccounting = acceptedRows.map((row) => ({
    rowNumber: row.rowNumber,
    status: 'accepted',
    identity: row.identity,
    stableId: row.stableId,
    listingIdentity: row.listingIdentity,
    canonicalIndex: canonicalIndexByIdentity.get(row.identity) ?? null,
  }));
  const stableIdCount = records.filter((record) => record.stableId).length;
  const listingUrlCount = records.filter((record) => record.listingUrl).length;
  const fieldCoverage = summarizeDealOsFieldCoverage(records);
  const record = {
    id: randomUUID(),
    created_at: new Date(nowTimestamp).toISOString(),
    imported_by: safeImportedBy,
    exported_at: new Date(exportedTimestamp).toISOString(),
    file_name: safeFileName,
    file_type: parsed.extension === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv',
    file_size: safeBuffer.length,
    file_sha256: sha256(safeBuffer),
    scope: safeScope,
    coverage_label: safeCoverageLabel,
    expected_row_count: normalizedExpectedRowCount,
    row_count: records.length,
    source_row_count: parsed.rows.length,
    accepted_row_count: acceptedRows.length,
    rejected_row_count: 0,
    canonical_record_count: records.length,
    parser_version: dealOsParserVersion,
    row_accounting: rowAccounting,
    duplicate_count: parsed.rows.length - records.length,
    stable_id_count: stableIdCount,
    listing_url_count: listingUrlCount,
    coverage_limit_reached: parsed.rows.length >= config.dealHunter.dealOsExportMaxRecords,
    records,
    metadata: {
      sourceRowCount: parsed.rows.length,
      worksheetPath: parsed.worksheetPath || '',
      suppliedMimeType: normalizeText(mimeType, 160),
      acceptedRowCount: acceptedRows.length,
      rejectedRowCount: 0,
      canonicalRecordCount: records.length,
      parserVersion: dealOsParserVersion,
      rowAccounting,
      fieldCoverage,
    },
  };
  const saved = await storage.insertDealHunterDealOsImport(record);
  return { ok: true, status: 201, import: publicDealOsImport(saved || record) };
}

async function loadDealOsExportSource(config, storage, importId = '') {
  if (!storage.getLatestDealHunterDealOsImport) return null;
  const normalizedImportId = normalizeText(importId, 200);
  const imported = normalizedImportId && storage.getDealHunterDealOsImport
    ? await storage.getDealHunterDealOsImport(normalizedImportId)
    : await storage.getLatestDealHunterDealOsImport();
  if (normalizedImportId && !imported) {
    return {
      source: {
        id: dealOsSourceId,
        name: dealOsSourceName,
        mode: 'manual-export',
        fetched: false,
        rowCount: 0,
        error: 'The selected Deal OS import no longer exists. Refresh imports before reconciling.',
      },
      deals: [],
    };
  }
  if (!imported) return null;
  const importedSummary = publicDealOsImport(imported);
  const ageMs = Date.now() - Date.parse(imported.exported_at || '');
  const maximumAgeMs = config.dealHunter.dealOsExportMaxAgeHours * 60 * 60 * 1000;
  const ageHours = Number.isFinite(ageMs) ? Math.max(0, ageMs / (60 * 60 * 1000)) : Infinity;
  const records = Array.isArray(imported.records) ? imported.records : [];
  const source = {
    id: dealOsSourceId,
    name: dealOsSourceName,
    mode: 'manual-export',
    fetched: records.length > 0 && ageMs >= -dealOsImportFutureToleranceMs && ageMs <= maximumAgeMs,
    rowCount: importedSummary.acceptedRowCount,
    canonicalRecordCount: records.length,
    exportedAt: imported.exported_at,
    importedAt: imported.created_at,
    importedBy: imported.imported_by,
    importAgeHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(1)) : null,
    maxAgeHours: config.dealHunter.dealOsExportMaxAgeHours,
    scope: imported.scope,
    coverageLabel: imported.coverage_label,
    expectedRowCount: imported.expected_row_count,
    duplicateCount: Number(imported.duplicate_count || 0),
    stableIdCount: Number(imported.stable_id_count || 0),
    listingUrlCount: Number(imported.listing_url_count || 0),
    coverageLimitReached: Boolean(imported.coverage_limit_reached),
    fieldCoverage: importedSummary.fieldCoverage,
    latestImport: importedSummary,
  };

  if (records.length === 0) source.error = 'The latest Deal OS import contains no normalized records. Upload a fresh export.';
  else if (!Number.isFinite(ageMs)) source.error = 'The latest Deal OS export timestamp is invalid. Upload a fresh export.';
  else if (ageMs < -dealOsImportFutureToleranceMs) source.error = 'The latest Deal OS export timestamp is in the future. Upload a corrected export.';
  else if (ageMs > maximumAgeMs) source.error = `The Deal OS export is ${ageHours.toFixed(1)} hours old and exceeds the ${config.dealHunter.dealOsExportMaxAgeHours}-hour freshness limit.`;

  return {
    source,
    deals: source.fetched ? records.map(hydrateDealOsRecord) : [],
  };
}

async function collectSources(config, storage, { dealOsImportId = '' } = {}) {
  const sourceResults = [];

  let dealOsSource = null;
  try {
    dealOsSource = await loadDealOsExportSource(config, storage, dealOsImportId);
  } catch (error) {
    dealOsSource = {
      source: {
        id: dealOsSourceId,
        name: dealOsSourceName,
        mode: 'manual-export',
        fetched: false,
        rowCount: 0,
        error: `The optional Deal OS import is unavailable: ${normalizeText(error.message, 400) || 'storage lookup failed.'}`,
      },
      deals: [],
    };
  }
  if (dealOsSource) {
    sourceResults.push({
      ...dealOsSource,
      source: {
        ...dealOsSource.source,
        required: false,
        sourceRole: 'optional-supplemental',
      },
    });
  }

  if (config.dealHunter.sheetCsvUrls.length === 0) {
    sourceResults.push({
      source: {
        id: 'sheet-0',
        name: 'SMB Deal Hunter Google Sheet',
        mode: 'csv',
        fetched: false,
        required: true,
        sourceRole: 'required-primary',
        rowCount: 0,
        error: 'The required Google Sheet source is not configured.',
      },
      deals: [],
    });
  }

  for (const [index, url] of config.dealHunter.sheetCsvUrls.entries()) {
    try {
      const sheetResult = await fetchSheetCsvDeals(url, index, config);
      sourceResults.push({
        ...sheetResult,
        source: {
          ...sheetResult.source,
          required: true,
          sourceRole: 'required-primary',
        },
      });
    } catch (error) {
      sourceResults.push({
        source: {
          id: `sheet-${index}`,
          name: index === 0 ? 'SMB Deal Hunter Google Sheet' : `Google Sheet ${index + 1}`,
          mode: 'csv',
          url,
          fetched: false,
          required: true,
          sourceRole: 'required-primary',
          rowCount: 0,
          error: error.message,
        },
        deals: [],
      });
    }
  }

  return sourceResults;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => normalizeText(value, 1000)).filter(Boolean))];
}

function tokenSet(value = '') {
  return new Set(normalizeComparableText(value).split(' ').filter((token) => token.length > 1));
}

function tokenSimilarity(left = '', right = '') {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

function tokenContainment(left = '', right = '') {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function listingMarketplaceAliases(listingUrl = '') {
  const normalized = normalizeUrl(listingUrl);
  if (!normalized) return [];

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase();
    const aliases = [];
    const numericAdId = pathname.match(/(?:\/|[-_])(\d{5,})(?:\.[a-z]+)?$/)?.[1];

    if (numericAdId && /(bizbuysell|bizquest|loopnet)\./.test(host)) aliases.push(`costar:${numericAdId}`);
    if (host.includes('dealstream.com') && pathname && pathname !== '/') aliases.push(`dealstream:${pathname}`);
    if (numericAdId && host.includes('businessbroker.net')) aliases.push(`businessbroker:${numericAdId}`);
    return aliases;
  } catch {
    return [];
  }
}

function dealIdentityAliases(deal = {}) {
  const listingIdentity = normalizeListingIdentity(deal.listingUrl);
  const sourceIdentity = sourceExternalIdentity(deal.sourceId, deal.id, deal.stableExternalId);
  const brokerReference = normalizeIdentityPart(getField(deal.raw || {}, [
    'Broker Reference', 'Broker Ref', 'Reference Number', 'Reference #', 'Listing Number', 'Ad Number',
  ]), 120);
  const brokerNamespace = normalizeIdentityPart(getField(deal.raw || {}, [
    'Broker Company', 'Brokerage', 'Broker Firm',
  ]), 120);

  return uniqueStrings([
    listingIdentity ? `url:${listingIdentity}` : '',
    ...listingMarketplaceAliases(deal.listingUrl),
    sourceIdentity ? `source:${sourceIdentity}` : '',
    brokerReference && brokerNamespace ? `broker-ref:${brokerNamespace}:${brokerReference}` : '',
    ...(deal.identityAliases || []),
  ]);
}

function contentFingerprintDealKey(deal = {}) {
  const fingerprint = [
    deal.name,
    deal.location,
    deal.industry,
    deal.askingPrice ?? '',
    deal.annualProfit ?? '',
  ]
    .map((value) => normalizeIdentityPart(value, 220))
    .filter(Boolean)
    .join('|');

  return fingerprint ? `fingerprint:${fingerprint}` : '';
}

function sourceRecord(deal = {}) {
  return {
    sourceId: deal.sourceId || '',
    sourceName: deal.sourceName || '',
    sourceMode: deal.sourceMode || '',
    externalId: deal.id || '',
    stableExternalId: Boolean(deal.stableExternalId),
    positionalRowId: Boolean(deal.idFromSourceRowPosition),
    listingUrl: deal.listingUrl || '',
    listingSource: deal.listingSource || '',
  };
}

function sourceObservationDeal(deal = {}) {
  const fields = [
    'sourceId', 'sourceName', 'sourceRowId', 'id', 'stableExternalId', 'idFromSourceRowPosition',
    'name', 'industry', 'description', 'city', 'county', 'state', 'country', 'location',
    'annualProfit', 'annualRevenue', 'askingPrice', 'profitMultiple', 'netMargin', 'yearsEstablished',
    'remoteFlag', 'franchiseFlag', 'fiveYearsFlag', 'brokerName', 'brokerCompany', 'brokerContact', 'brokerPhone',
    'brokerEmail', 'listingUrl', 'listingSource', 'dateAdded', 'lastUpdated',
  ];
  return Object.fromEntries(fields.map((field) => [field, deal[field]]));
}

function fieldProvenanceEntry(deal = {}, resolution = 'direct') {
  return {
    sourceId: deal.sourceId || '',
    sourceName: deal.sourceName || '',
    sourceRecordId: deal.id || '',
    listingUrl: deal.listingUrl || '',
    observedAt: deal.lastUpdated || deal.dateAdded || '',
    resolution,
  };
}

function initialFieldProvenance(deal = {}) {
  const existing = deal.fieldProvenance && typeof deal.fieldProvenance === 'object' && !Array.isArray(deal.fieldProvenance)
    ? deal.fieldProvenance
    : {};
  const provenance = { ...existing };
  for (const field of dealHunterManagedFields) {
    if (dealFieldPresent(deal[field]) && !provenance[field]) provenance[field] = fieldProvenanceEntry(deal);
  }
  return provenance;
}

function comparableFieldValue(value) {
  if (Number.isFinite(value)) return Number(value);
  return normalizeComparableText(value);
}

function materialFieldConflict(field, left, right) {
  if (!dealFieldPresent(left) || !dealFieldPresent(right)) return false;
  if (Number.isFinite(left) && Number.isFinite(right)) {
    const difference = relativeDifference(left, right);
    return difference !== null && difference >= (['annualProfit', 'annualRevenue', 'askingPrice'].includes(field) ? 0.05 : 0.02);
  }
  return comparableFieldValue(left) !== comparableFieldValue(right);
}

function contactWithProvenance(contact, deal, { inherited = false, matchDecision = '' } = {}) {
  return {
    ...contact,
    sourceId: contact?.sourceId || deal.sourceId || '',
    sourceName: contact?.sourceName || deal.sourceName || '',
    sourceRecordId: contact?.sourceRecordId || deal.id || '',
    sourceListingUrl: contact?.sourceListingUrl || deal.listingUrl || '',
    inherited,
    matchDecision,
  };
}

function initializeDealIdentity(deal = {}) {
  const listingAliases = uniqueStrings([deal.listingUrl, ...(deal.listingAliases || [])].map(normalizeUrl));
  const identityAliases = dealIdentityAliases({ ...deal, listingAliases });
  const dealKeyAliases = uniqueStrings([
    buildDealKey(deal),
    contentFingerprintDealKey(deal),
    ...(deal.dealKeyAliases || []),
  ]);
  const contacts = normalizeBrokerContacts((deal.brokerContacts || []).map((contact) => (
    contactWithProvenance(contact, deal)
  )));
  const preferredContact = contacts[0] || null;

  return {
    ...deal,
    _canonicalMatchRecord: deal._canonicalMatchRecord || { ...deal },
    brokerContacts: contacts,
    brokerEmail: deal.brokerEmail || preferredContact?.email || '',
    brokerName: deal.brokerName || preferredContact?.name || '',
    listingAliases,
    identityAliases,
    dealKeyAliases,
    sourceRecords: deal.sourceRecords?.length ? deal.sourceRecords : [sourceRecord(deal)],
    sourceObservationDeals: Array.isArray(deal.sourceObservationDeals) ? deal.sourceObservationDeals : [sourceObservationDeal(deal)],
    fieldProvenance: initialFieldProvenance(deal),
    fieldConflicts: Array.isArray(deal.fieldConflicts) ? deal.fieldConflicts : [],
    deduplicationMatches: deal.deduplicationMatches || [],
  };
}

function relativeDifference(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return null;
  return Math.abs(left - right) / Math.max(left, right);
}

function financialMatchEvidence(left, right) {
  const fields = ['annualProfit', 'annualRevenue', 'askingPrice'];
  const compared = fields.map((field) => ({ field, difference: relativeDifference(left[field], right[field]) }))
    .filter(({ difference }) => difference !== null);
  return {
    matches: compared.filter(({ difference }) => difference <= 0.03).map(({ field }) => field),
    conflicts: compared.filter(({ difference }) => difference >= 0.15).map(({ field }) => field),
    compared: compared.map(({ field, difference }) => ({ field, difference: Number(difference.toFixed(4)) })),
  };
}

function geographicEvidence(left, right) {
  const leftState = normalizeIdentityPart(left.state, 40);
  const rightState = normalizeIdentityPart(right.state, 40);
  const leftCountry = normalizeIdentityPart(left.country, 40);
  const rightCountry = normalizeIdentityPart(right.country, 40);
  const stateConflict = Boolean(leftState && rightState && leftState !== rightState);
  const countryConflict = Boolean(leftCountry && rightCountry && leftCountry !== rightCountry);
  const stateMatch = Boolean(leftState && rightState && leftState === rightState);
  const leftCity = normalizeIdentityPart(left.city, 80);
  const rightCity = normalizeIdentityPart(right.city, 80);
  const leftCounty = normalizeIdentityPart(left.county, 120);
  const rightCounty = normalizeIdentityPart(right.county, 120);
  const locationMatch = Boolean(
    (leftCity && rightCity && leftCity === rightCity)
    || (leftCounty && rightCounty && leftCounty === rightCounty),
  );
  return { hardConflict: stateConflict || countryConflict, stateMatch, locationMatch };
}

function stableMarketplaceConflict(leftAliases, rightAliases) {
  for (const namespace of ['costar:', 'dealstream:', 'businessbroker:']) {
    const left = leftAliases.filter((alias) => alias.startsWith(namespace));
    const right = rightAliases.filter((alias) => alias.startsWith(namespace));
    if (left.length > 0 && right.length > 0 && !left.some((alias) => right.includes(alias))) return true;
  }
  return false;
}

function stableSourceConflict(left, right) {
  if (!left.sourceId || left.sourceId !== right.sourceId) return false;
  const leftIdentity = sourceExternalIdentity(left.sourceId, left.id, left.stableExternalId);
  const rightIdentity = sourceExternalIdentity(right.sourceId, right.id, right.stableExternalId);
  return Boolean(leftIdentity && rightIdentity && leftIdentity !== rightIdentity);
}

function syndicatedMatchDecision(left, right) {
  const leftAliases = dealIdentityAliases(left);
  const rightAliases = dealIdentityAliases(right);
  const sharedAliases = leftAliases.filter((alias) => rightAliases.includes(alias));
  const geography = geographicEvidence(left, right);
  const financials = financialMatchEvidence(left, right);
  const titleSimilarity = tokenSimilarity(left.name, right.name);
  const titleContainment = tokenContainment(left.name, right.name);
  const descriptionSimilarity = tokenSimilarity(left.description, right.description);
  const descriptionLongEnough = normalizeComparableText(left.description).length >= 120
    && normalizeComparableText(right.description).length >= 120;
  const exactTitle = normalizeComparableText(left.name) !== ''
    && normalizeComparableText(left.name) === normalizeComparableText(right.name);
  const marketplaceConflict = stableMarketplaceConflict(leftAliases, rightAliases);
  const sourceConflict = stableSourceConflict(left, right);
  const hardConflict = geography.hardConflict || sourceConflict || financials.conflicts.length >= 2;
  const evidence = {
    sharedAliases,
    titleSimilarity: Number(titleSimilarity.toFixed(4)),
    titleContainment: Number(titleContainment.toFixed(4)),
    descriptionSimilarity: Number(descriptionSimilarity.toFixed(4)),
    geography,
    financials,
  };

  if (hardConflict) return { automatic: false, reason: 'hard-conflict', confidence: 0, evidence };
  if (sharedAliases.length > 0) return { automatic: true, reason: 'shared-durable-identity', confidence: 1, evidence };
  if (
    exactTitle
    && descriptionLongEnough
    && descriptionSimilarity >= 0.9
    && (geography.stateMatch || geography.locationMatch)
    && financials.matches.length >= 1
    && !marketplaceConflict
  ) {
    return { automatic: true, reason: 'title-description-location-financials', confidence: 0.98, evidence };
  }
  if (
    titleSimilarity >= 0.6
    && descriptionLongEnough
    && descriptionSimilarity >= 0.96
    && (geography.stateMatch || geography.locationMatch)
    && financials.matches.length >= 2
    && !marketplaceConflict
  ) {
    return { automatic: true, reason: 'near-title-description-location-financials', confidence: 0.97, evidence };
  }
  if (
    !descriptionLongEnough
    && exactTitle
    && (geography.stateMatch || geography.locationMatch)
    && financials.matches.length >= 2
  ) {
    return { automatic: true, reason: 'exact-title-location-financials', confidence: 0.995, evidence };
  }
  if (marketplaceConflict) return { automatic: false, reason: 'hard-conflict', confidence: 0, evidence };
  if (
    !descriptionLongEnough
    && titleContainment >= 0.75
    && (geography.stateMatch || geography.locationMatch)
    && financials.matches.length >= 3
  ) {
    return { automatic: true, reason: 'near-title-location-financials', confidence: 0.985, evidence };
  }
  return { automatic: false, reason: 'insufficient-corroboration', confidence: 0, evidence };
}

function canonicalDealQuality(deal = {}) {
  const contacts = deal.brokerContacts || [];
  return (contacts.some((contact) => contact.name && isValidEmail(contact.email)) ? 1000 : 0)
    + (contacts.some((contact) => isValidEmail(contact.email)) ? 500 : 0)
    + (deal.listingUrl ? 100 : 0)
    + (deal.stableExternalId ? 50 : 0)
    + Math.min(normalizeComparableText(deal.description).length, 500) / 10
    + ['annualProfit', 'annualRevenue', 'askingPrice'].filter((field) => Number.isFinite(deal[field])).length * 10
    + (deal.state ? 5 : 0);
}

function financialBlockKeys(deal = {}) {
  const state = normalizeIdentityPart(deal.state, 40);
  if (!state) return [];
  const keys = [];
  for (const field of ['annualProfit', 'annualRevenue', 'askingPrice']) {
    const value = deal[field];
    if (!Number.isFinite(value) || value <= 0) continue;
    const bucket = Math.floor(Math.log(value) / Math.log(1.05));
    for (const offset of [-1, 0, 1]) keys.push(`finance:${state}:${field}:${bucket + offset}`);
  }
  return keys;
}

function candidateBlockKeys(deal = {}) {
  const title = normalizeComparableText(deal.name);
  const description = normalizeComparableText(deal.description);
  const state = normalizeIdentityPart(deal.state, 40);
  return uniqueStrings([
    ...dealIdentityAliases(deal).map((alias) => `identity:${alias}`),
    title.length >= 10 ? `title:${title}` : '',
    description.length >= 120 ? `description:${sha256(description)}` : '',
    ...financialBlockKeys(deal),
    ...(deal.brokerContacts || []).map((contact) => (
      state && isValidEmail(contact.email) ? `contact:${state}:${normalizeEmail(contact.email)}` : ''
    )),
  ]);
}

function mergeSyndicatedDeals(canonical, duplicate, decision) {
  const missingValueFields = [
    'industry', 'description', 'city', 'county', 'state', 'country', 'location', 'annualProfit', 'annualRevenue',
    'askingPrice', 'profitMultiple', 'netMargin', 'yearsEstablished', 'remoteFlag', 'franchiseFlag', 'fiveYearsFlag',
    'brokerCompany', 'brokerContact', 'listingUrl', 'listingSource', 'dateAdded', 'lastUpdated',
  ];
  const merged = { ...canonical };
  const fieldProvenance = { ...initialFieldProvenance(canonical) };
  const fieldConflicts = [...(canonical.fieldConflicts || [])];
  for (const field of missingValueFields) {
    if (!dealFieldPresent(merged[field]) && dealFieldPresent(duplicate[field])) {
      merged[field] = duplicate[field];
      fieldProvenance[field] = duplicate.fieldProvenance?.[field] || fieldProvenanceEntry(duplicate, `inherited:${decision.reason}`);
    } else if (materialFieldConflict(field, merged[field], duplicate[field])) {
      const conflict = {
        field,
        canonicalValue: merged[field],
        observedValue: duplicate[field],
        canonicalSource: fieldProvenance[field] || fieldProvenanceEntry(canonical),
        observedSource: duplicate.fieldProvenance?.[field] || fieldProvenanceEntry(duplicate),
        resolution: 'preserved-canonical',
      };
      const conflictKey = JSON.stringify([field, comparableFieldValue(merged[field]), comparableFieldValue(duplicate[field]), conflict.observedSource.sourceId]);
      if (!fieldConflicts.some((item) => JSON.stringify([item.field, comparableFieldValue(item.canonicalValue), comparableFieldValue(item.observedValue), item.observedSource?.sourceId]) === conflictKey)) {
        fieldConflicts.push(conflict);
      }
    }
  }

  const canonicalListingIdentity = normalizeListingIdentity(canonical.listingUrl);
  const contacts = normalizeBrokerContacts([
    ...(canonical.brokerContacts || []).map((contact) => contactWithProvenance(contact, canonical, {
      inherited: Boolean(contact.inherited),
      matchDecision: contact.matchDecision || '',
    })),
    ...(duplicate.brokerContacts || []).map((contact) => contactWithProvenance(contact, duplicate, {
      inherited: normalizeListingIdentity(contact.sourceListingUrl || duplicate.listingUrl) !== canonicalListingIdentity,
      matchDecision: decision.reason,
    })),
  ]);
  const preferredContact = contacts[0] || null;

  return {
    ...merged,
    brokerContacts: contacts,
    brokerEmail: canonical.brokerEmail || duplicate.brokerEmail || preferredContact?.email || '',
    brokerName: canonical.brokerName || duplicate.brokerName || preferredContact?.name || '',
    fieldProvenance,
    fieldConflicts: fieldConflicts.slice(0, 100),
    raw: { ...(duplicate.raw || {}), ...(canonical.raw || {}) },
    listingAliases: uniqueStrings([
      ...(canonical.listingAliases || []), canonical.listingUrl,
      ...(duplicate.listingAliases || []), duplicate.listingUrl,
    ].map(normalizeUrl)),
    identityAliases: uniqueStrings([
      ...(canonical.identityAliases || []), ...dealIdentityAliases(canonical),
      ...(duplicate.identityAliases || []), ...dealIdentityAliases(duplicate),
    ]),
    dealKeyAliases: uniqueStrings([
      ...(canonical.dealKeyAliases || []), buildDealKey(canonical), contentFingerprintDealKey(canonical),
      ...(duplicate.dealKeyAliases || []), buildDealKey(duplicate), contentFingerprintDealKey(duplicate),
    ]),
    sourceRecords: [...(canonical.sourceRecords || [sourceRecord(canonical)]), ...(duplicate.sourceRecords || [sourceRecord(duplicate)])],
    sourceObservationDeals: [
      ...(canonical.sourceObservationDeals || [sourceObservationDeal(canonical)]),
      ...(duplicate.sourceObservationDeals || [sourceObservationDeal(duplicate)]),
    ],
    deduplicationMatches: [
      ...(canonical.deduplicationMatches || []),
      {
        decision: 'automatic',
        reason: decision.reason,
        confidence: decision.confidence,
        matchedSourceId: duplicate.sourceId || '',
        matchedExternalId: duplicate.id || '',
        matchedListingUrl: duplicate.listingUrl || '',
        evidence: decision.evidence,
      },
    ],
  };
}

export function dedupeDeals(deals) {
  const ranked = deals
    .map((deal, inputIndex) => ({ deal: initializeDealIdentity(deal), inputIndex }))
    .filter(({ deal }) => buildDealKey(deal))
    .sort((left, right) => canonicalDealQuality(right.deal) - canonicalDealQuality(left.deal) || left.inputIndex - right.inputIndex);
  const deduped = [];
  const indicesByBlock = new Map();
  const maximumBlockSize = 200;
  const maximumCandidateComparisons = 500;

  const indexDeal = (deal, index) => {
    for (const key of candidateBlockKeys(deal)) {
      const indices = indicesByBlock.get(key);
      if (indices === null) continue;
      if (!indices) {
        indicesByBlock.set(key, [index]);
      } else if (indices.length >= maximumBlockSize) {
        indicesByBlock.set(key, null);
      } else if (!indices.includes(index)) {
        indices.push(index);
      }
    }
  };

  for (const { deal } of ranked) {
    const candidateIndices = new Set();
    for (const key of candidateBlockKeys(deal)) {
      for (const index of indicesByBlock.get(key) || []) {
        candidateIndices.add(index);
        if (candidateIndices.size >= maximumCandidateComparisons) break;
      }
      if (candidateIndices.size >= maximumCandidateComparisons) break;
    }
    const matches = [...candidateIndices]
      .map((index) => ({
        index,
        decision: syndicatedMatchDecision(deduped[index]._canonicalMatchRecord || deduped[index], deal),
      }))
      .filter(({ decision }) => decision.automatic)
      .sort((left, right) => right.decision.confidence - left.decision.confidence || left.index - right.index);

    if (matches.length === 0) {
      const index = deduped.length;
      deduped.push(deal);
      indexDeal(deal, index);
      continue;
    }

    const { index, decision } = matches[0];
    // The canonical representative never changes. Every new member must match
    // it directly, which prevents weak A-B/B-C links from collapsing A and C.
    deduped[index] = mergeSyndicatedDeals(deduped[index], deal, decision);
    indexDeal(deduped[index], index);
  }

  return deduped.map(({ _canonicalMatchRecord: _canonical, ...deal }) => deal);
}

function buildDealKey(deal) {
  const stableExternalId = normalizeStableExternalIdentity(deal.id);

  if (deal.stableExternalId && deal.sourceId && stableExternalId) {
    return `source:${deal.sourceId}:${stableExternalId}`;
  }

  const listingUrl = normalizeUrl(deal.listingUrl).toLowerCase();

  if (listingUrl) {
    return `url:${listingUrl}`;
  }

  const externalId = normalizeIdentityPart(deal.id, 120);

  if (deal.sourceId && externalId && !/^\d+$/.test(externalId)) {
    return `source:${deal.sourceId}:${externalId}`;
  }

  return contentFingerprintDealKey(deal);
}

function isRecentDeal(deal, lookbackDays) {
  const dates = [deal.dateAdded, deal.lastUpdated].map((value) => Date.parse(value)).filter(Number.isFinite);

  if (dates.length === 0) {
    return true;
  }

  const newest = Math.max(...dates);
  return newest >= Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
}

function sortBestDeals(left, right) {
  const scoreDifference = right.score - left.score;

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  return (Date.parse(right.dateAdded || right.lastUpdated || '') || 0) - (Date.parse(left.dateAdded || left.lastUpdated || '') || 0);
}

function sortNewThenBest(left, right) {
  if (left.isNew !== right.isNew) {
    return left.isNew ? -1 : 1;
  }

  return sortBestDeals(left, right);
}

function summarizeCriteria(scoredDeals) {
  const excludedCounts = new Map();

  for (const deal of scoredDeals) {
    for (const reason of deal.removeReasons || []) {
      if (!reason.startsWith('Excluded category match:') && !reason.startsWith('Franchise listing')) {
        continue;
      }

      const category = reason.replace(/^Excluded category match: /, '').split(',')[0] || 'franchise';
      excludedCounts.set(category, (excludedCounts.get(category) || 0) + 1);
    }
  }

  const mostCommonExclusions = [...excludedCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([label, count]) => `${label} (${count})`);
  const recommendations = [];
  const highFitCount = scoredDeals.filter((deal) => !deal.shouldRemove && deal.score >= highFitScoreThreshold).length;

  if (mostCommonExclusions.length > 0) {
    recommendations.push(`Keep excluding these recurring non-fit categories: ${mostCommonExclusions.join(', ')}.`);
  }

  if (highFitCount < 3 && scoredDeals.length > 25) {
    recommendations.push('Tighten include keywords toward field service, compliance, inspection, maintenance, repair, commercial contracts, and essential B2B services.');
  }

  if (highFitCount > 20) {
    recommendations.push('The source is producing many plausible fits; raise the score threshold or require recurring/commercial revenue language to reduce noise.');
  }

  recommendations.push('Do not require management in place, but ask directly about owner duties, key employees, and whether a transition manager can be retained.');

  return recommendations.slice(0, 4);
}

function publicDeal(deal) {
  return {
    id: deal.id,
    opportunityId: deal.opportunityId || '',
    identityStatus: deal.identityStatus || '',
    identityResolution: deal.identityResolution || '',
    identityExceptionId: deal.identityExceptionId || '',
    dealKey: deal.dealKey,
    sourceId: deal.sourceId,
    sourceName: deal.sourceName,
    sourceMode: deal.sourceMode,
    listingSource: deal.listingSource,
    name: deal.name,
    isNew: Boolean(deal.isNew),
    firstSeenAt: deal.firstSeenAt,
    lastSeenAt: deal.lastSeenAt,
    score: deal.score,
    fitScore: deal.fitScore ?? deal.score,
    completenessScore: deal.completenessScore ?? 0,
    evidenceConfidence: deal.evidenceConfidence || 'low',
    scoreStatus: deal.scoreStatus || 'provisional',
    missingEvidence: deal.missingEvidence || [],
    scoreReasons: deal.scoreReasons || [],
    scoringRuleVersion: deal.scoringRuleVersion || dealHunterScoringRuleVersion,
    completenessPolicyVersion: deal.completenessPolicyVersion || dealHunterCompletenessPolicyVersion,
    actionEligibility: deal.actionEligibility || {},
    industry: deal.industry,
    location: deal.location,
    annualProfit: deal.annualProfit,
    annualRevenue: deal.annualRevenue,
    askingPrice: deal.askingPrice,
    profitMultiple: deal.profitMultiple,
    netMargin: deal.netMargin,
    yearsEstablished: deal.yearsEstablished,
    remoteFlag: deal.remoteFlag,
    franchiseFlag: deal.franchiseFlag,
    brokerName: deal.brokerName,
    brokerCompany: deal.brokerCompany,
    brokerContact: deal.brokerContact,
    brokerEmail: deal.brokerEmail,
    brokerContacts: deal.brokerContacts || [],
    listingUrl: deal.listingUrl,
    listingAliases: deal.listingAliases || [],
    identityAliases: deal.identityAliases || [],
    dealKeyAliases: deal.dealKeyAliases || [],
    sourceRecords: deal.sourceRecords || [],
    fieldProvenance: deal.fieldProvenance || {},
    fieldConflicts: deal.fieldConflicts || [],
    deduplicationMatches: deal.deduplicationMatches || [],
    dateAdded: deal.dateAdded,
    lastUpdated: deal.lastUpdated,
    strengths: deal.strengths,
    concerns: deal.concerns,
    removeReasons: deal.removeReasons,
    questions: deal.questions,
    recommendation: deal.recommendation,
    shouldRemove: deal.shouldRemove,
    cimRequest: deal.cimRequest || null,
  };
}

function normalizeTextArray(value = [], maxItems = 12, maxLength = 500) {
  const source = Array.isArray(value) ? value : [value];

  return source
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeCimSourceRecords(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 50).map((record) => ({
    sourceId: normalizeText(record?.sourceId || record?.source_id, 200),
    sourceName: normalizeText(record?.sourceName || record?.source_name, 200),
    sourceMode: normalizeText(record?.sourceMode || record?.source_mode, 100),
    externalId: normalizeText(record?.externalId || record?.external_id, 120),
    stableExternalId: Boolean(record?.stableExternalId || record?.stable_external_id),
    positionalRowId: Boolean(record?.positionalRowId || record?.positional_row_id),
    listingUrl: normalizeUrl(record?.listingUrl || record?.listing_url),
    listingSource: normalizeText(record?.listingSource || record?.listing_source, 220),
  }));
}

function normalizeCimDeduplicationMatches(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 50).map((match) => ({
    decision: normalizeText(match?.decision, 40),
    reason: normalizeText(match?.reason, 100),
    confidence: Math.max(0, Math.min(1, Number(match?.confidence) || 0)),
    matchedSourceId: normalizeText(match?.matchedSourceId || match?.matched_source_id, 200),
    matchedExternalId: normalizeText(match?.matchedExternalId || match?.matched_external_id, 120),
    matchedListingUrl: normalizeUrl(match?.matchedListingUrl || match?.matched_listing_url),
  }));
}

function normalizeCimDealSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const cimRequest = snapshot.cimRequest && typeof snapshot.cimRequest === 'object' ? snapshot.cimRequest : {};
  const dealKey = normalizeText(snapshot.dealKey || snapshot.deal_key, 1000);
  const brokerContacts = normalizeBrokerContacts(snapshot.brokerContacts || snapshot.broker_contacts || []);
  const brokerEmail = normalizeEmail(
    snapshot.confirmedRecipientEmail ||
      snapshot.confirmed_recipient_email ||
      cimRequest.recipientEmail ||
      cimRequest.recipient_email ||
      snapshot.brokerEmail ||
      snapshot.broker_email,
  );

  if (!dealKey) {
    return null;
  }

  return {
    id: normalizeText(snapshot.id || dealKey, 1000),
    opportunityId: normalizeText(snapshot.opportunityId || snapshot.opportunity_id, 160),
    identityStatus: normalizeText(snapshot.identityStatus || snapshot.identity_status, 80),
    dealKey,
    sourceId: normalizeText(snapshot.sourceId || snapshot.source_id, 200),
    sourceName: normalizeText(snapshot.sourceName || snapshot.source_name, 200),
    sourceMode: normalizeText(snapshot.sourceMode || snapshot.source_mode, 100),
    listingSource: normalizeText(snapshot.listingSource || snapshot.listing_source, 220),
    name: normalizeText(snapshot.name || snapshot.businessName || snapshot.business_name || 'Unnamed deal', 300),
    isNew: Boolean(snapshot.isNew || snapshot.is_new),
    firstSeenAt: normalizeText(snapshot.firstSeenAt || snapshot.first_seen_at, 100),
    lastSeenAt: normalizeText(snapshot.lastSeenAt || snapshot.last_seen_at, 100),
    score: Math.round(parseNumber(snapshot.score) || 0),
    industry: normalizeText(snapshot.industry, 220),
    location: normalizeText(snapshot.location, 220),
    annualProfit: parseNumber(snapshot.annualProfit ?? snapshot.annual_profit),
    annualRevenue: parseNumber(snapshot.annualRevenue ?? snapshot.annual_revenue),
    askingPrice: parseNumber(snapshot.askingPrice ?? snapshot.asking_price),
    profitMultiple: parseNumber(snapshot.profitMultiple ?? snapshot.profit_multiple),
    yearsEstablished: parseNumber(snapshot.yearsEstablished ?? snapshot.years_established),
    remoteFlag: normalizeText(snapshot.remoteFlag || snapshot.remote_flag, 100),
    franchiseFlag: normalizeText(snapshot.franchiseFlag || snapshot.franchise_flag, 100),
    brokerName: normalizeText(snapshot.brokerName || snapshot.broker_name, 220),
    brokerCompany: normalizeText(snapshot.brokerCompany || snapshot.broker_company, 220),
    brokerContact: normalizeText(snapshot.brokerContact || snapshot.broker_contact, 500),
    brokerEmail,
    brokerContacts,
    listingUrl: normalizeUrl(snapshot.listingUrl || snapshot.listing_url),
    listingAliases: uniqueStrings(
      normalizeTextArray(snapshot.listingAliases || snapshot.listing_aliases, 50, 1000).map(normalizeUrl),
    ),
    identityAliases: normalizeTextArray(snapshot.identityAliases || snapshot.identity_aliases, 50, 1000),
    dealKeyAliases: normalizeTextArray(snapshot.dealKeyAliases || snapshot.deal_key_aliases, 50, 1000),
    sourceRecords: normalizeCimSourceRecords(snapshot.sourceRecords || snapshot.source_records),
    deduplicationMatches: normalizeCimDeduplicationMatches(
      snapshot.deduplicationMatches || snapshot.deduplication_matches,
    ),
    dateAdded: normalizeText(snapshot.dateAdded || snapshot.date_added, 100),
    lastUpdated: normalizeText(snapshot.lastUpdated || snapshot.last_updated, 100),
    strengths: normalizeTextArray(snapshot.strengths),
    concerns: normalizeTextArray(snapshot.concerns),
    removeReasons: normalizeTextArray(snapshot.removeReasons || snapshot.remove_reasons),
    questions: normalizeTextArray(snapshot.questions),
    recommendation: normalizeText(snapshot.recommendation, 1000),
    shouldRemove: Boolean(snapshot.shouldRemove || snapshot.should_remove),
  };
}

function getCimSnapshotSecret() {
  const config = getConfig();
  return config.admin.sessionSecret || config.secureDocuments.tokenSecret;
}

function signCimDealSnapshot(deal = null) {
  const snapshot = normalizeCimDealSnapshot(deal);
  const secret = getCimSnapshotSecret();

  if (!snapshot || !secret) {
    return '';
  }

  return signPayload(
    {
      typ: 'deal-hunter-cim-snapshot',
      version: 1,
      exp: Date.now() + cimSnapshotTtlMs,
      deal: snapshot,
    },
    secret,
  );
}

function verifyCimDealSnapshotToken(token = '') {
  const payload = verifySignedPayload(String(token || ''), getCimSnapshotSecret());

  if (payload?.typ !== 'deal-hunter-cim-snapshot' || payload.version !== 1) {
    return null;
  }

  return normalizeCimDealSnapshot(payload.deal);
}

function isCimAutomationActor(value = '') {
  return /^automation-stage-(2|3)$/.test(normalizeText(value, 160).toLowerCase());
}

function buildCimAutomationApproval(deal = null) {
  const snapshotToken = signCimDealSnapshot(deal);
  const approvedDeal = verifyCimDealSnapshotToken(snapshotToken);

  if (
    !approvedDeal ||
    approvedDeal.dealKey !== deal?.dealKey ||
    normalizeEmail(approvedDeal.brokerEmail) !== normalizeEmail(deal?.brokerEmail)
  ) {
    return null;
  }

  return {
    approvedDeal,
    snapshotToken,
  };
}

function historyMetadata(seen = {}) {
  if (seen.metadata && typeof seen.metadata === 'object') return seen.metadata;
  try {
    const parsed = JSON.parse(seen.metadata || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function historyArray(metadata = {}, key) {
  return Array.isArray(metadata[key]) ? metadata[key].slice(0, 100) : [];
}

function isConsistentSeenDeal(seen = {}) {
  const dealKey = normalizeText(seen.id, 1000);
  if (!dealKey) return false;

  if (dealKey.startsWith('url:')) {
    const keyIdentity = normalizeListingIdentity(dealKey.slice(4));
    const listingIdentity = normalizeListingIdentity(seen.listing_url);
    return Boolean(keyIdentity && listingIdentity && keyIdentity === listingIdentity);
  }

  if (dealKey.startsWith('fingerprint:')) {
    return dealKey === contentFingerprintDealKey({
      name: seen.name,
      location: seen.location,
      industry: seen.industry,
      askingPrice: seen.asking_price,
      annualProfit: seen.annual_profit,
    });
  }

  if (dealKey.startsWith('source:')) {
    const metadata = historyMetadata(seen);
    const metadataAliases = historyArray(metadata, 'identityAliases');
    const inferredIdentity = sourceExternalIdentity(
      seen.source_id,
      seen.external_id,
      seen.source_id === dealOsSourceId,
    );
    return metadataAliases.includes(dealKey)
      || (inferredIdentity && dealKey === `source:${inferredIdentity}`);
  }

  return true;
}

function addHistoryIndex(index, key, seen) {
  if (!key) return;
  const current = index.get(key) || [];
  current.push(seen);
  index.set(key, current);
}

function earliestFirstSeen(seenDeals = [], fallback = '') {
  return seenDeals
    .map((seen) => seen.first_seen_at)
    .filter((value) => value && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || fallback;
}

function selectHistoricalCanonicalMatch(seenDeals = [], derivedDealKey = '') {
  return [...seenDeals].sort((left, right) => {
    const quality = (seen) => {
      const metadata = historyMetadata(seen);
      const dealKeyAliases = historyArray(metadata, 'dealKeyAliases');
      return (seen.id !== derivedDealKey && dealKeyAliases.includes(derivedDealKey) ? 1000 : 0)
        + (seen.id === derivedDealKey ? 100 : 0)
        + historyArray(metadata, 'listingAliases').length * 10
        + historyArray(metadata, 'identityAliases').length;
    };
    return quality(right) - quality(left)
      || (Date.parse(left.first_seen_at || '') || Number.MAX_SAFE_INTEGER)
        - (Date.parse(right.first_seen_at || '') || Number.MAX_SAFE_INTEGER)
      || String(left.id).localeCompare(String(right.id));
  })[0] || null;
}

function attachHistory(scoredDeals, seenDeals = [], generatedAt) {
  const validSeenDeals = seenDeals.filter(isConsistentSeenDeal);
  const seenById = new Map();
  const seenByListingIdentity = new Map();
  const seenByIdentityAlias = new Map();

  for (const seen of validSeenDeals) {
    const metadata = historyMetadata(seen);
    addHistoryIndex(seenById, seen.id, seen);
    for (const dealKeyAlias of historyArray(metadata, 'dealKeyAliases')) addHistoryIndex(seenById, dealKeyAlias, seen);
    for (const listingUrl of [seen.listing_url, ...historyArray(metadata, 'listingAliases')]) {
      addHistoryIndex(seenByListingIdentity, normalizeListingIdentity(listingUrl), seen);
    }
    const inferredIdentity = sourceExternalIdentity(
      seen.source_id,
      seen.external_id,
      seen.source_id === dealOsSourceId,
    );
    for (const identityAlias of [inferredIdentity ? `source:${inferredIdentity}` : '', ...historyArray(metadata, 'identityAliases')]) {
      addHistoryIndex(seenByIdentityAlias, identityAlias, seen);
    }
  }

  return scoredDeals.map((deal) => {
    const derivedDealKey = buildDealKey(deal);
    const listingAliases = uniqueStrings([deal.listingUrl, ...(deal.listingAliases || [])].map(normalizeUrl));
    const identityAliases = uniqueStrings([...(deal.identityAliases || []), ...dealIdentityAliases(deal)]);
    const currentDealKeyAliases = uniqueStrings([
      derivedDealKey,
      contentFingerprintDealKey(deal),
      ...(deal.dealKeyAliases || []),
    ]);
    const directMatches = seenById.get(derivedDealKey) || [];
    const primaryListingMatches = seenByListingIdentity.get(normalizeListingIdentity(deal.listingUrl)) || [];
    const aliasListingMatches = listingAliases.flatMap((listingUrl) => (
      seenByListingIdentity.get(normalizeListingIdentity(listingUrl)) || []
    ));
    const identityMatches = identityAliases.flatMap((identity) => seenByIdentityAlias.get(identity) || []);
    const keyAliasMatches = currentDealKeyAliases.flatMap((dealKey) => seenById.get(dealKey) || []);
    const matchedSeenDeals = [...new Map([
      ...directMatches,
      ...primaryListingMatches,
      ...aliasListingMatches,
      ...identityMatches,
      ...keyAliasMatches,
    ].map((seen) => [seen.id, seen])).values()];
    const seen = selectHistoricalCanonicalMatch(matchedSeenDeals, derivedDealKey);
    const dealKey = seen?.id || derivedDealKey;
    const historicalDealKeyAliases = matchedSeenDeals.flatMap((item) => {
      const metadata = historyMetadata(item);
      return [item.id, ...historyArray(metadata, 'dealKeyAliases')];
    });
    const historicalListingAliases = matchedSeenDeals.flatMap((item) => {
      const metadata = historyMetadata(item);
      return [item.listing_url, ...historyArray(metadata, 'listingAliases')];
    });
    const historicalIdentityAliases = matchedSeenDeals.flatMap((item) => (
      historyArray(historyMetadata(item), 'identityAliases')
    ));

    return {
      ...deal,
      dealKey,
      listingAliases: uniqueStrings([...listingAliases, ...historicalListingAliases].map(normalizeUrl)),
      identityAliases: uniqueStrings([...identityAliases, ...historicalIdentityAliases]),
      dealKeyAliases: uniqueStrings([dealKey, ...currentDealKeyAliases, ...historicalDealKeyAliases])
        .filter((alias) => alias !== dealKey),
      isNew: !seen,
      firstSeenAt: earliestFirstSeen(matchedSeenDeals, generatedAt),
      lastSeenAt: generatedAt,
    };
  });
}

function buildSeenRecord(deal) {
  return {
    id: deal.dealKey,
    first_seen_at: deal.firstSeenAt,
    last_seen_at: deal.lastSeenAt,
    source_id: deal.sourceId || '',
    source_name: deal.sourceName || '',
    source_mode: deal.sourceMode || '',
    external_id: deal.id || '',
    listing_url: deal.listingUrl || '',
    name: deal.name || 'Unnamed business',
    industry: deal.industry || '',
    location: deal.location || '',
    annual_profit: deal.annualProfit,
    annual_revenue: deal.annualRevenue,
    asking_price: deal.askingPrice,
    score: deal.score,
    should_remove: deal.shouldRemove,
    metadata: {
      recommendation: deal.recommendation,
      strengths: deal.strengths,
      concerns: deal.concerns,
      removeReasons: deal.removeReasons,
      listingAliases: deal.listingAliases || [],
      identityAliases: deal.identityAliases || [],
      dealKeyAliases: deal.dealKeyAliases || [],
      sourceRecords: deal.sourceRecords || [],
      deduplicationMatches: deal.deduplicationMatches || [],
    },
  };
}

async function loadDealHunterHistory(storage) {
  if (!storage.listDealHunterSeenDeals) {
    return [];
  }

  return storage.listDealHunterSeenDeals({ limit: 100000 });
}

async function persistDealHunterHistory(storage, scoredDeals) {
  if (!storage.upsertDealHunterSeenDeals) {
    return;
  }

  const records = scoredDeals.filter((deal) => deal.dealKey).map(buildSeenRecord);
  await storage.upsertDealHunterSeenDeals(records);
}

function formatCurrencyForCrm(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value)
    : '';
}

function formatMultipleForCrm(value) {
  return Number.isFinite(value) && value > 0 ? `${Number(value.toFixed(2))}x` : '';
}

function formatPercentForCrm(value) {
  return Number.isFinite(value) ? `${Number(value.toFixed(2))}%` : '';
}

function formatYearsForCrm(value) {
  return Number.isFinite(value) && value > 0 ? `${Number(value.toFixed(1))} years` : '';
}

function listLines(label, values = []) {
  const safeValues = values.map((value) => normalizeText(value, 500)).filter(Boolean);

  if (safeValues.length === 0) {
    return [];
  }

  return [label, ...safeValues.map((value) => `- ${value}`)];
}

function dealHunterSourceBrokerFields(deal = {}) {
  const raw = deal.raw || {};
  const sourceEmail = extractEmailAddresses(getField(raw, ['Broker Email']))[0] || '';

  return {
    name: normalizeText(getField(raw, ['Broker Name', 'Broker']), 160) || deal.brokerName || '',
    company: normalizeText(getField(raw, ['Broker Company']), 160) || deal.brokerCompany || '',
    contact: normalizeText(getField(raw, ['Broker Contact']), 200) || deal.brokerContact || '',
    email: sourceEmail || deal.brokerEmail || '',
  };
}

function dealHunterCrmNotes(deal) {
  const broker = dealHunterSourceBrokerFields(deal);
  const lines = [
    dealHunterCrmNotesHeading,
    `Deal key: ${deal.dealKey || 'Not set'}`,
    `Score: ${deal.score}/100`,
    `Source: ${deal.sourceName || 'Deal Hunter'}${deal.sourceMode ? ` (${deal.sourceMode})` : ''}`,
    deal.firstSeenAt ? `First seen: ${deal.firstSeenAt}` : '',
    deal.lastSeenAt ? `Last seen: ${deal.lastSeenAt}` : '',
    deal.recommendation ? `Recommendation: ${deal.recommendation}` : '',
    '',
    'Listing details',
    deal.name ? `Business: ${deal.name}` : '',
    deal.industry ? `Industry: ${deal.industry}` : '',
    deal.location ? `Location: ${deal.location}` : '',
    deal.annualProfit ? `Annual profit / SDE: ${formatCurrencyForCrm(deal.annualProfit)}` : '',
    deal.annualRevenue ? `Annual revenue: ${formatCurrencyForCrm(deal.annualRevenue)}` : '',
    deal.askingPrice ? `Asking price: ${formatCurrencyForCrm(deal.askingPrice)}` : '',
    deal.profitMultiple ? `Profit multiple: ${formatMultipleForCrm(deal.profitMultiple)}` : '',
    Number.isFinite(deal.netMargin) ? `Net margin: ${formatPercentForCrm(deal.netMargin)}` : '',
    deal.yearsEstablished ? `Years established: ${formatYearsForCrm(deal.yearsEstablished)}` : '',
    deal.remoteFlag ? `Remote / absentee / relocatable: ${deal.remoteFlag}` : '',
    deal.listingUrl ? `Listing URL: ${deal.listingUrl}` : '',
    ...(deal.listingAliases?.filter((listingUrl) => listingUrl !== deal.listingUrl).length
      ? ['Syndicated listing URLs', ...deal.listingAliases
          .filter((listingUrl) => listingUrl !== deal.listingUrl)
          .map((listingUrl) => `- ${listingUrl}`)]
      : []),
    '',
    'Broker / contact',
    broker.name ? `Broker name: ${broker.name}` : '',
    broker.company ? `Broker company: ${broker.company}` : '',
    broker.email ? `Broker email: ${broker.email}` : '',
    ...(deal.brokerContacts?.length > 1
      ? ['Available contacts', ...deal.brokerContacts.map((contact) => `- ${[contact.name, contact.role, contact.email, contact.sourceColumn].filter(Boolean).join(' | ')}`)]
      : []),
    broker.contact ? `Broker phone/contact: ${broker.contact}` : '',
    '',
    ...listLines('Strengths', deal.strengths || []),
    '',
    ...listLines('Concerns / diligence points', deal.concerns || []),
    '',
    ...listLines('Questions to ask broker or seller', deal.questions || []),
  ];

  return lines.filter((line, index, list) => line || list[index - 1]).join('\n').trim();
}

function wrapDealHunterCrmGeneratedNotes(notes = '') {
  const generatedNotes = String(notes || '').trim();

  if (
    generatedNotes.includes(dealHunterCrmGeneratedStartMarker) &&
    generatedNotes.includes(dealHunterCrmGeneratedEndMarker)
  ) {
    return generatedNotes;
  }

  return [
    dealHunterCrmGeneratedStartMarker,
    generatedNotes,
    dealHunterCrmGeneratedEndMarker,
  ].filter(Boolean).join('\n').trim();
}

function ensureDealHunterUserNotesSection(notes = '') {
  const currentNotes = String(notes || '').trim();
  const userNotesMarker = `\n\n${dealHunterCrmUserNotesHeading}\n`;

  return currentNotes.includes(userNotesMarker)
    ? currentNotes
    : `${currentNotes}${userNotesMarker}`.trimEnd();
}

function mergeDealHunterCrmNotes(existingNotes = '', freshNotes = '') {
  const currentNotes = String(existingNotes || '').trim();
  const nextNotes = wrapDealHunterCrmGeneratedNotes(freshNotes);

  if (!currentNotes || currentNotes === nextNotes) {
    return ensureDealHunterUserNotesSection(nextNotes);
  }

  const userNotesMarker = `\n\n${dealHunterCrmUserNotesHeading}\n`;
  const startIndex = currentNotes.indexOf(dealHunterCrmGeneratedStartMarker);
  const endIndex = currentNotes.indexOf(dealHunterCrmGeneratedEndMarker);

  if (startIndex >= 0 && endIndex > startIndex) {
    const afterGeneratedIndex = endIndex + dealHunterCrmGeneratedEndMarker.length;
    const beforeGenerated = currentNotes.slice(0, startIndex).trim();
    const afterGenerated = currentNotes.slice(afterGeneratedIndex).trim();
    return ensureDealHunterUserNotesSection([beforeGenerated, nextNotes, afterGenerated].filter(Boolean).join('\n\n'));
  }

  if (currentNotes.includes(userNotesMarker)) {
    return `${nextNotes}${userNotesMarker}${currentNotes.split(userNotesMarker).slice(1).join(userNotesMarker).trim()}`;
  }

  if (currentNotes.startsWith(dealHunterCrmNotesHeading)) {
    return `${nextNotes}${userNotesMarker}${currentNotes}`;
  }

  return `${nextNotes}${userNotesMarker}${currentNotes}`;
}

function dealHunterCrmMetadata(deal, options = {}) {
  const managed = options.managed !== false;
  const generatedNotes = dealHunterCrmNotes(deal);
  const broker = dealHunterSourceBrokerFields(deal);

  return {
    dealHunter: {
      managed,
      linkedToExistingCrmRecord: Boolean(options.linkedToExistingCrmRecord),
      actionable: options.actionable !== false,
      opportunityId: deal.opportunityId || '',
      dealKey: deal.dealKey || '',
      score: deal.score,
      fitScore: deal.fitScore ?? deal.score,
      completenessScore: deal.completenessScore ?? 0,
      evidenceConfidence: deal.evidenceConfidence || 'low',
      scoreStatus: deal.scoreStatus || 'provisional',
      missingEvidence: deal.missingEvidence || [],
      scoreReasons: deal.scoreReasons || [],
      scoringRuleVersion: deal.scoringRuleVersion || dealHunterScoringRuleVersion,
      completenessPolicyVersion: deal.completenessPolicyVersion || dealHunterCompletenessPolicyVersion,
      actionEligibility: deal.actionEligibility || {},
      sourceName: deal.sourceName || '',
      sourceMode: deal.sourceMode || '',
      sourceId: deal.sourceId || '',
      listingSource: deal.listingSource || '',
      externalId: deal.id || '',
      firstSeenAt: deal.firstSeenAt || '',
      lastSeenAt: deal.lastSeenAt || '',
      dateAdded: deal.dateAdded || '',
      lastUpdated: deal.lastUpdated || '',
      isNew: Boolean(deal.isNew),
      shouldRemove: Boolean(deal.shouldRemove),
      recommendation: deal.recommendation || '',
      strengths: deal.strengths || [],
      concerns: deal.concerns || [],
      removeReasons: deal.removeReasons || [],
      questions: deal.questions || [],
      brokerName: broker.name,
      brokerCompany: broker.company,
      brokerContact: broker.contact,
      brokerEmail: broker.email,
      brokerContacts: deal.brokerContacts || [],
      listingAliases: deal.listingAliases || [],
      identityAliases: deal.identityAliases || [],
      dealKeyAliases: deal.dealKeyAliases || [],
      sourceRecords: deal.sourceRecords || [],
      fieldProvenance: deal.fieldProvenance || {},
      fieldConflicts: deal.fieldConflicts || [],
      deduplicationMatches: deal.deduplicationMatches || [],
      generatedNotes,
      raw: deal.raw || {},
    },
  };
}

function dealHunterCrmPayload(deal, options = {}) {
  const actionable = options.actionable !== false;
  const broker = dealHunterSourceBrokerFields(deal);
  const hasBrokerContact = Boolean(broker.name || broker.company || broker.email || broker.contact);
  const sourceTag = normalizeComparableText(deal.sourceName || 'deal-hunter').replace(/\s+/g, '-').slice(0, 40);
  const generatedNotes = dealHunterCrmNotes(deal);

  return {
    company: deal.name || 'Unnamed Deal Hunter business',
    role: hasBrokerContact ? 'Broker' : 'Prospect',
    listing_url: deal.listingUrl || '',
    asking_price: formatCurrencyForCrm(deal.askingPrice),
    ttm_revenue: formatCurrencyForCrm(deal.annualRevenue),
    ttm_ebitda: formatCurrencyForCrm(deal.annualProfit),
    ebitda_multiple: formatMultipleForCrm(deal.profitMultiple),
    net_margin: formatPercentForCrm(deal.netMargin),
    business_age: formatYearsForCrm(deal.yearsEstablished),
    broker_name: broker.name || broker.company,
    broker_email: broker.email,
    broker_phone: broker.contact,
    lead_type: hasBrokerContact ? 'broker' : 'prospect',
    status: actionable ? 'review' : 'sourced',
    priority: actionable ? (deal.score >= 85 ? 'urgent' : 'high') : 'normal',
    follow_up_state: actionable ? 'needs-response' : 'completed',
    next_action_at: null,
    source: 'deal-hunter-daily-review',
    tags: ['deal-hunter', actionable ? 'score-75-plus' : 'sourced', actionable ? 'high-fit' : '', sourceTag].filter(Boolean),
    notes: mergeDealHunterCrmNotes('', generatedNotes),
    message: actionable
      ? `High-fit Deal Hunter listing imported into the CRM with score ${deal.score}/100.`
      : `Deal Hunter listing synchronized as a non-actionable sourced record with score ${deal.score}/100.`,
    deal_hunter_opportunity_id: deal.opportunityId || null,
    metadata: dealHunterCrmMetadata(deal, { ...options, actionable }),
  };
}

export async function findExistingDealHunterSubmission(storage, deal) {
  if (deal.opportunityId && storage.getCurrentDealHunterOpportunity && storage.getSubmission) {
    const opportunity = await storage.getCurrentDealHunterOpportunity(deal.opportunityId);
    if (opportunity?.primary_submission_id) {
      const primary = await storage.getSubmission(opportunity.primary_submission_id);
      if (primary) return primary;
    }
  }
  const listingAliases = uniqueStrings([
    deal.listingUrl,
    ...(Array.isArray(deal.listingAliases) ? deal.listingAliases : []),
  ].map(normalizeUrl)).slice(0, 50);
  const dealKeyAliases = uniqueStrings([
    deal.dealKey,
    ...(Array.isArray(deal.dealKeyAliases) ? deal.dealKeyAliases : []),
  ]).slice(0, 50);
  const listingIdentities = new Set(listingAliases.map(normalizeListingIdentity).filter(Boolean));
  const identityAliases = new Set(uniqueStrings([
    ...(Array.isArray(deal.identityAliases) ? deal.identityAliases : []),
    ...listingAliases.flatMap((listingUrl) => [
      `url:${normalizeListingIdentity(listingUrl)}`,
      ...listingMarketplaceAliases(listingUrl),
    ]),
  ]));
  const candidates = new Map();
  const addCandidate = (submission) => {
    if (submission?.id) candidates.set(submission.id, submission);
  };

  if (storage.getSubmissionByListingUrl) {
    for (const listingUrl of listingAliases) {
      const existingByListingUrl = await storage.getSubmissionByListingUrl(listingUrl);
      addCandidate(existingByListingUrl);
    }
  }

  if (storage.listSubmissions) {
    for (const search of uniqueStrings([...dealKeyAliases, ...listingAliases, deal.name])) {
      const result = await storage.listSubmissions({ limit: 25, page: 1, search, status: 'all' });
      const rows = result?.rows || [];
      for (const row of rows) {
        const metadata = row?.metadata?.dealHunter || {};
        const storedKeys = uniqueStrings([
          metadata.dealKey,
          ...(Array.isArray(metadata.dealKeyAliases) ? metadata.dealKeyAliases : []),
        ]);
        const storedListings = uniqueStrings([
          row.listing_url,
          ...(Array.isArray(metadata.listingAliases) ? metadata.listingAliases : []),
        ].map(normalizeUrl));
        const storedIdentityAliases = uniqueStrings([
          ...(Array.isArray(metadata.identityAliases) ? metadata.identityAliases : []),
          ...storedListings.flatMap((listingUrl) => [
            `url:${normalizeListingIdentity(listingUrl)}`,
            ...listingMarketplaceAliases(listingUrl),
          ]),
        ]);
        const keyMatch = storedKeys.some((dealKey) => dealKeyAliases.includes(dealKey));
        const listingMatch = storedListings.some((listingUrl) => listingIdentities.has(normalizeListingIdentity(listingUrl)));
        const identityMatch = storedIdentityAliases.some((identity) => identityAliases.has(identity));
        const legacyNotesMatch = dealKeyAliases.some((dealKey) => String(row?.notes || '').includes(dealKey));
        const raw = metadata.raw && typeof metadata.raw === 'object' && !Array.isArray(metadata.raw) ? metadata.raw : {};
        const sourceRecord = (Array.isArray(metadata.sourceRecords) ? metadata.sourceRecords : [])
          .find((record) => record?.externalId === metadata.externalId) || {};
        const storedDeal = {
          ...normalizeDealRecord(raw, {
            id: metadata.sourceId || 'crm',
            name: metadata.sourceName || 'CRM',
            mode: metadata.sourceMode || 'crm',
            rowId: metadata.externalId || '',
            stableExternalId: Boolean(sourceRecord.stableExternalId),
          }),
          id: metadata.externalId || '',
          stableExternalId: Boolean(sourceRecord.stableExternalId),
          sourceId: metadata.sourceId || 'crm',
          name: normalizeText(row.company || row.name || getField(raw, ['Business Name', 'Name', 'Listing']), 220),
          listingUrl: normalizeUrl(row.listing_url) || normalizeUrl(getField(raw, ['Original Broker Listing URL', 'View Listing URL', 'Listing URL'])),
          annualProfit: parseNumber(row.ttm_ebitda) ?? parseNumber(getField(raw, ['Annual Profit', 'Earnings', 'SDE', 'EBITDA'])),
          annualRevenue: parseNumber(row.ttm_revenue) ?? parseNumber(getField(raw, ['Annual Revenue', 'Revenue'])),
          askingPrice: parseNumber(row.asking_price) ?? parseNumber(getField(raw, ['Asking Price'])),
          identityAliases: storedIdentityAliases,
        };
        const corroboratedMatch = syndicatedMatchDecision(storedDeal, deal).automatic;
        if (keyMatch || listingMatch || identityMatch || legacyNotesMatch || corroboratedMatch) addCandidate(row);
      }
    }
  }

  const primaryListingIdentity = normalizeListingIdentity(deal.listingUrl);
  return [...candidates.values()].sort((left, right) => {
    const quality = (submission) => {
      const metadata = submission?.metadata?.dealHunter || {};
      return (submission?.status !== 'archived' ? 1000 : 0)
        + (metadata.dealKey === deal.dealKey ? 500 : 0)
        + (normalizeListingIdentity(submission?.listing_url) === primaryListingIdentity ? 100 : 0)
        + (isValidEmail(submission?.broker_email) ? 20 : 0);
    };
    return quality(right) - quality(left)
      || (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0)
      || String(left.id).localeCompare(String(right.id));
  })[0] || null;
}

async function linkDealHunterOpportunitySubmission(storage, deal, submissionId) {
  if (!deal.opportunityId || !submissionId) return null;
  if (typeof storage.linkDealHunterCrmSubmission !== 'function') {
    throw new Error('Atomic canonical CRM linkage is unavailable for the configured storage provider.');
  }
  return storage.linkDealHunterCrmSubmission({
    opportunityId: deal.opportunityId,
    submissionId,
    updatedAt: new Date().toISOString(),
  });
}

async function ensureDealHunterSubmissionForCim(storage, deal, requestedBy = '') {
  const existing = await findExistingDealHunterSubmission(storage, deal);

  if (existing) {
    await linkDealHunterOpportunitySubmission(storage, deal, existing.id);
    return existing;
  }

  const proposedImport = buildDealHunterCrmImportRecord(deal);
  let importRecord = proposedImport;

  if (storage.claimDealHunterCrmImport) {
    const pendingCutoff = new Date(Date.now() - dealHunterCrmImportPendingStaleMinutes * 60 * 1000).toISOString();
    const claim = await storage.claimDealHunterCrmImport(proposedImport, { pendingCutoff });
    importRecord = claim?.importRecord || proposedImport;

    if (claim && !claim.claimed) {
      const claimedSubmission = importRecord?.submission_id && storage.getSubmission
        ? await storage.getSubmission(importRecord.submission_id)
        : null;
      const concurrentlyCreated = claimedSubmission || await findExistingDealHunterSubmission(storage, deal);

      if (concurrentlyCreated) {
        await linkDealHunterOpportunitySubmission(storage, deal, concurrentlyCreated.id);
        return concurrentlyCreated;
      }

      throw new Error('CRM record creation for this opportunity is already in progress. Retry after it completes.');
    }
  }

  // Recheck after taking the durable import claim in case a prior review created
  // the CRM record between the initial lookup and the claim.
  const afterClaim = await findExistingDealHunterSubmission(storage, deal);

  if (afterClaim) {
    await updateDealHunterCrmImport(storage, importRecord, {
      submission_id: afterClaim.id,
      status: 'linked',
    });
    await linkDealHunterOpportunitySubmission(storage, deal, afterClaim.id);
    return afterClaim;
  }

  const created = await createManualSubmission(
    dealHunterCrmPayload(deal),
    normalizeText(requestedBy, 160) || 'deal-hunter-cim-request',
    { storage },
  );

  if (!created.ok || !created.submission?.id) {
    await updateDealHunterCrmImport(storage, importRecord, {
      status: 'failed',
      metadata: {
        ...(importRecord?.metadata || {}),
        error: 'CRM record creation failed before CIM transmission.',
      },
    });
    throw new Error((created.errors || []).join(' ') || 'CRM record could not be created before sending the CIM request.');
  }

  await updateDealHunterCrmImport(storage, importRecord, {
    submission_id: created.submission.id,
    opportunity_id: deal.opportunityId || null,
    status: 'created',
  });
  await linkDealHunterOpportunitySubmission(storage, deal, created.submission.id);
  return created.submission;
}

async function upsertCimRequestWithActivity(storage, request, { eventType, summary, actor, metadata = {} } = {}) {
  const submission = request.submission_id && storage.getSubmission
    ? await storage.getSubmission(request.submission_id)
    : await findExistingDealHunterSubmission(storage, {
        dealKey: request.dealKey || request.deal_key,
        listingUrl: request.listingUrl || request.listing_url,
      });

  if (!submission) {
    return storage.upsertDealHunterCimRequest(request);
  }

  const linkedRequest = request.submission_id === submission.id
    ? request
    : { ...request, submission_id: submission.id };

  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'upsert_deal_hunter_cim_request',
    payload: { request: linkedRequest },
    activity: {
      submissionId: submission.id,
      opportunityId: linkedRequest.opportunity_id,
      eventType,
      summary,
      actor: actor || 'deal-hunter',
      role: 'admin',
      metadata: { cimRequestId: linkedRequest.id, ...metadata },
    },
  });

  if (!mutation.applied || !mutation.record) {
    throw new Error('CIM request state changed before its activity could be saved.');
  }

  return mutation.record;
}

async function finalizeCimRequestClaimWithActivity(
  storage,
  request,
  claim,
  {
    expectedStatuses = [],
    eventType,
    summary,
    actor,
    metadata = {},
  } = {},
) {
  // Legacy/test storage doubles do not expose the durable claim-renewal
  // capability. Production adapters do, and must finalize through the CAS
  // mutation so a delayed provider result cannot overwrite an archive/retry.
  if (!storage.renewDealHunterCimRequestClaim) {
    return upsertCimRequestWithActivity(storage, request, {
      eventType,
      summary,
      actor,
      metadata,
    });
  }

  const submissionId = request.submission_id || claim?.submission_id || '';
  const expectedUpdatedAt = claim?.updated_at || '';
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'finalize_deal_hunter_cim_request_claim',
    payload: {
      request: { ...request, submission_id: submissionId },
      expectedUpdatedAt,
      expectedStatuses,
    },
    activity: {
      submissionId,
      opportunityId: request.opportunity_id || claim?.opportunity_id || '',
      eventType,
      summary,
      actor: actor || 'deal-hunter',
      role: 'admin',
      metadata: { cimRequestId: request.id, ...metadata },
    },
  });

  if (!mutation.applied || !mutation.record) {
    const error = new Error('CIM request claim is no longer eligible for transmission or finalization.');
    error.status = 409;
    error.code = 'CIM_CLAIM_INELIGIBLE';
    error.reason = mutation.reason || 'claim-ineligible';
    error.request = mutation.record || null;
    throw error;
  }

  return mutation.record;
}

async function renewCimRequestClaim(storage, request, expectedStatus) {
  if (!storage.renewDealHunterCimRequestClaim) {
    return { renewed: true, request };
  }

  return storage.renewDealHunterCimRequestClaim({
    id: request.id,
    expectedUpdatedAt: request.updated_at,
    expectedStatus,
    nowIso: new Date().toISOString(),
  });
}

function isDealHunterManagedSubmission(existing = {}) {
  return existing.source === 'deal-hunter-daily-review' || existing.metadata?.dealHunter?.managed === true;
}

function chooseDealHunterCrmValue(existing, payload, field, preserveExistingFields) {
  return preserveExistingFields
    ? existing[field] || payload[field] || ''
    : payload[field] || existing[field] || '';
}

// Tags Deal Hunter assigns itself, so a demotion from high fit to sourced can
// drop them. Every other tag on the record belongs to an operator and is kept.
const dealHunterOwnedCrmTags = new Set(['deal-hunter', 'high-fit', 'score-75-plus', 'sourced']);
const dealHunterOwnedCrmStatuses = new Set(['sourced', 'review']);

function mergeDealHunterCrmTags(existingTags = [], payloadTags = [], { preserveExistingFields = false } = {}) {
  const retained = preserveExistingFields
    ? existingTags
    : existingTags.filter((tag) => !dealHunterOwnedCrmTags.has(normalizeText(tag, 80).toLowerCase()));
  return Array.from(new Set([...retained, ...payloadTags]));
}

function dealHunterCrmUpdate(existing, deal, options = {}) {
  const preserveExistingFields = Boolean(options.preserveExistingFields);
  const managed = !preserveExistingFields;
  const actionable = options.actionable !== false;
  const payload = dealHunterCrmPayload(deal, {
    managed,
    linkedToExistingCrmRecord: preserveExistingFields,
    actionable,
  });
  const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
  const existingPriority = normalizeText(existing.priority, 80);
  // Deal Hunter only owns the workflow it assigns itself. Once an operator has
  // advanced the record past that baseline, a later sync reports the refreshed
  // listing facts without reverting their work.
  const operatorAdvancedWorkflow = !dealHunterOwnedCrmStatuses.has(normalizeText(existing.status, 40));
  const preserveWorkflow = preserveExistingFields || operatorAdvancedWorkflow;

  return {
    updated_at: new Date().toISOString(),
    company: chooseDealHunterCrmValue(existing, payload, 'company', preserveExistingFields),
    listing_url: chooseDealHunterCrmValue(existing, payload, 'listing_url', preserveExistingFields),
    asking_price: chooseDealHunterCrmValue(existing, payload, 'asking_price', preserveExistingFields),
    ttm_revenue: chooseDealHunterCrmValue(existing, payload, 'ttm_revenue', preserveExistingFields),
    ttm_ebitda: chooseDealHunterCrmValue(existing, payload, 'ttm_ebitda', preserveExistingFields),
    ebitda_multiple: chooseDealHunterCrmValue(existing, payload, 'ebitda_multiple', preserveExistingFields),
    net_margin: chooseDealHunterCrmValue(existing, payload, 'net_margin', preserveExistingFields),
    business_age: chooseDealHunterCrmValue(existing, payload, 'business_age', preserveExistingFields),
    broker_name: chooseDealHunterCrmValue(existing, payload, 'broker_name', preserveExistingFields),
    broker_email: chooseDealHunterCrmValue(existing, payload, 'broker_email', preserveExistingFields),
    broker_phone: chooseDealHunterCrmValue(existing, payload, 'broker_phone', preserveExistingFields),
    role: chooseDealHunterCrmValue(existing, payload, 'role', preserveExistingFields),
    lead_type: chooseDealHunterCrmValue(existing, payload, 'lead_type', preserveExistingFields),
    status: preserveWorkflow ? existing.status : payload.status,
    priority: preserveExistingFields && existingPriority && existingPriority !== 'normal' ? existingPriority : payload.priority,
    follow_up_state: preserveWorkflow || actionable ? existing.follow_up_state || payload.follow_up_state : payload.follow_up_state,
    next_action_at: preserveWorkflow || actionable ? existing.next_action_at ?? null : payload.next_action_at,
    tags: mergeDealHunterCrmTags(existingTags, payload.tags, { preserveExistingFields }),
    notes: mergeDealHunterCrmNotes(existing.notes, payload.notes),
    metadata: {
      ...(existing.metadata || {}),
      ...payload.metadata,
    },
  };
}

async function updateDealHunterCrmSubmission(storage, existing, deal, {
  preserveExistingFields = false,
  actionable = true,
  actor = 'deal-hunter',
  summary = '',
  activityMetadata = {},
} = {}) {
  let currentSubmission = existing;
  if (deal.opportunityId) {
    await linkDealHunterOpportunitySubmission(storage, deal, existing.id);
    if (typeof storage.getSubmission !== 'function') {
      throw new Error('CRM submission reload is unavailable after canonical linkage.');
    }
    currentSubmission = await storage.getSubmission(existing.id);
    if (!currentSubmission || currentSubmission.deal_hunter_opportunity_id !== deal.opportunityId) {
      throw new Error('Atomic canonical CRM linkage did not persist the requested current ownership.');
    }
  }
  const values = dealHunterCrmUpdate(currentSubmission, deal, { preserveExistingFields, actionable });
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'update_submission',
    payload: {
      id: currentSubmission.id,
      expectedUpdatedAt: currentSubmission.updated_at || '',
      values,
    },
    activity: {
      submissionId: currentSubmission.id,
      opportunityId: deal.opportunityId || '',
      eventType: 'submission.deal-hunter-synced',
      summary: summary || (preserveExistingFields
        ? 'Existing CRM record enriched from Deal Hunter.'
        : 'Deal Hunter CRM record refreshed from its listing.'),
      actor,
      role: 'system',
      metadata: {
        dealKey: deal.dealKey || '',
        listingUrl: deal.listingUrl || '',
        changedFields: Object.keys(values).filter((field) => field !== 'updated_at'),
        ...(activityMetadata && typeof activityMetadata === 'object' && !Array.isArray(activityMetadata)
          ? activityMetadata
          : {}),
      },
    },
  });

  if (!mutation.applied || !mutation.record) {
    throw new Error('Deal Hunter CRM record changed before its activity could be saved.');
  }

  return mutation.record;
}

function dealHunterSourceKeys(deal = {}) {
  const primary = buildDealKey(deal);
  return uniqueStrings([
    primary,
    contentFingerprintDealKey(deal),
    deal.dealKey,
    ...(Array.isArray(deal.dealKeyAliases) ? deal.dealKeyAliases : []),
  ]);
}

function dealHunterSourceListings(deal = {}) {
  return uniqueStrings([
    deal.listingUrl,
    ...(Array.isArray(deal.listingAliases) ? deal.listingAliases : []),
  ].map(normalizeListingIdentity));
}

function dealHunterSubmissionSourceMatch(existing = {}, deal = {}) {
  const metadata = existing.metadata?.dealHunter || {};
  if (
    !normalizeComparableText(existing.company)
    || normalizeComparableText(existing.company) !== normalizeComparableText(deal.name)
  ) {
    return null;
  }

  const primaryListing = normalizeListingIdentity(existing.listing_url);
  const existingListings = uniqueStrings([
    primaryListing,
    ...(Array.isArray(metadata.listingAliases) ? metadata.listingAliases : []).map(normalizeListingIdentity),
  ]);
  const sourceListings = dealHunterSourceListings(deal);
  const listingMatches = existingListings.filter((listing) => sourceListings.includes(listing));
  const existingKeys = uniqueStrings([
    metadata.dealKey,
    ...(Array.isArray(metadata.dealKeyAliases) ? metadata.dealKeyAliases : []),
  ]);
  const sourceKeys = dealHunterSourceKeys(deal);
  const dealKeyMatches = existingKeys.filter((key) => sourceKeys.includes(key));

  if (primaryListing && !sourceListings.includes(primaryListing)) {
    return null;
  }
  if (listingMatches.length === 0 && (!primaryListing && dealKeyMatches.length === 0)) {
    return null;
  }

  return { listingMatches, dealKeyMatches };
}

function currentDealHunterSourceDeals(sourceResults = []) {
  return dedupeDeals(sourceResults.flatMap((result) => result.deals || [])).map((deal) => {
    const dealKey = buildDealKey(deal);
    return scoreDeal({
      ...deal,
      dealKey,
      dealKeyAliases: uniqueStrings([
        ...(deal.dealKeyAliases || []),
        contentFingerprintDealKey(deal),
      ]).filter((key) => key !== dealKey),
    });
  });
}

export async function repairDealHunterCrmSourceFields({
  submissionId = '',
  apply = false,
  actor = '',
  backupVerified = false,
  backupReference = '',
  storage = getStorage(),
  sourceResults = null,
} = {}) {
  const normalizedSubmissionId = normalizeText(submissionId, 100);
  const normalizedActor = normalizeText(actor, 160);
  const normalizedBackupReference = normalizeText(backupReference, 1000);
  if (!normalizedSubmissionId) {
    throw new Error('A CRM submission ID is required.');
  }
  if (apply && !normalizedActor) {
    throw new Error('An accountable actor is required to apply a CRM source-field repair.');
  }
  if (apply && backupVerified !== true) {
    throw new Error('A verified backup is required to apply a CRM source-field repair.');
  }
  if (apply && !normalizedBackupReference) {
    throw new Error('A verified backup reference is required to apply a CRM source-field repair.');
  }

  const existing = await storage.getSubmission?.(normalizedSubmissionId);
  if (!existing) {
    throw new Error('The requested CRM submission was not found.');
  }
  if (!isDealHunterManagedSubmission(existing)) {
    throw new Error('Only Deal Hunter-managed CRM records can be repaired from the current source.');
  }

  const resolvedSourceResults = sourceResults || await collectSources(getConfig(), storage);
  const failedSources = resolvedSourceResults
    .map((result) => result.source)
    .filter((source) => source?.fetched === false || source?.error);
  if (failedSources.length > 0) {
    throw new Error(`CRM source-field repair stopped because ${failedSources.length} source${failedSources.length === 1 ? '' : 's'} failed.`);
  }

  const matches = currentDealHunterSourceDeals(resolvedSourceResults)
    .map((deal) => ({ deal, evidence: dealHunterSubmissionSourceMatch(existing, deal) }))
    .filter((match) => match.evidence);
  if (matches.length === 0) {
    throw new Error('No current Deal Hunter source record safely matches this CRM submission.');
  }
  if (matches.length > 1) {
    throw new Error('Multiple current Deal Hunter source records match this CRM submission; repair requires manual identity review.');
  }

  const { deal, evidence } = matches[0];
  const previousMetadata = existing.metadata?.dealHunter || {};
  const repairDeal = {
    ...deal,
    opportunityId: previousMetadata.opportunityId || '',
    firstSeenAt: previousMetadata.firstSeenAt || existing.created_at || '',
    lastSeenAt: new Date().toISOString(),
    isNew: false,
  };
  const broker = dealHunterSourceBrokerFields(repairDeal);
  const preview = {
    submissionId: existing.id,
    company: repairDeal.name,
    dealKey: repairDeal.dealKey,
    listingUrl: repairDeal.listingUrl,
    matchedListingIdentities: evidence.listingMatches,
    matchedDealKeys: evidence.dealKeyMatches,
    dateAdded: repairDeal.dateAdded || '',
    brokerName: broker.name,
    brokerCompany: broker.company,
    brokerContact: broker.contact,
    brokerEmail: broker.email,
  };

  if (!apply) {
    return { ok: true, applied: false, preview };
  }

  const updated = await updateDealHunterCrmSubmission(storage, existing, repairDeal, {
    preserveExistingFields: false,
    actor: normalizedActor,
    summary: 'Deal Hunter CRM source fields repaired from the current listing data.',
    activityMetadata: {
      repairType: 'deal-hunter-crm-source-fields',
      backupReference: normalizedBackupReference,
    },
  });
  return {
    ok: true,
    applied: true,
    preview,
    updatedAt: updated?.updated_at || '',
  };
}

function buildDealHunterCrmImportRecord(deal, submissionId = '', status = 'pending') {
  const listingIdentity = normalizeListingIdentity(deal.listingUrl);
  const importIdentity = deal.opportunityId || deal.dealKey || listingIdentity || normalizeIdentityPart([deal.sourceName, deal.name, deal.location].join('|'), 1000);
  const now = new Date().toISOString();

  return {
    id: sha256(`deal-hunter-crm-import:${importIdentity}`),
    created_at: now,
    updated_at: now,
    opportunity_id: deal.opportunityId || null,
    deal_key: deal.dealKey || importIdentity,
    listing_identity: listingIdentity,
    listing_url: deal.listingUrl || '',
    submission_id: submissionId || '',
    status,
    source_name: deal.sourceName || '',
    metadata: {
      score: deal.score,
      name: deal.name || '',
      sourceMode: deal.sourceMode || '',
      sourceId: deal.sourceId || '',
      opportunityId: deal.opportunityId || '',
    },
  };
}

async function updateDealHunterCrmImport(storage, importRecord, values = {}) {
  if (!storage.updateDealHunterCrmImport || !importRecord?.id) {
    return null;
  }

  try {
    return await storage.updateDealHunterCrmImport(importRecord.id, {
      updated_at: new Date().toISOString(),
      ...values,
    });
  } catch (error) {
    console.warn(`[deal-hunter] CRM import bookkeeping update failed: ${error.message}`);
    return null;
  }
}

function dealHunterCrmCandidates(scoredDeals = []) {
  return scoredDeals.filter(
    (deal) => !deal.dismissed && (
      deal.actionEligibility?.highFit === true
      || (!deal.shouldRemove && deal.score >= cimRequestScoreThreshold && deal.annualProfit !== null)
    ),
  );
}

async function performHighFitDealsCrmSync(scoredDeals = [], storage = getStorage()) {
  const candidates = dealHunterCrmCandidates(scoredDeals);
  const summary = {
    reviewed: candidates.length,
    created: 0,
    enriched: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const deal of candidates) {
    let importRecord = null;

    try {
      const pendingCutoff = new Date(Date.now() - dealHunterCrmImportPendingStaleMinutes * 60 * 1000).toISOString();
      const proposedImportRecord = buildDealHunterCrmImportRecord(deal);

      let claim = null;

      try {
        claim = await storage.claimDealHunterCrmImport(proposedImportRecord, { pendingCutoff });
      } catch (error) {
        console.warn(`[deal-hunter] CRM import claim failed; CRM write blocked: ${error.message}`);
        throw new Error('The durable CRM import claim failed, so no CRM write was attempted for this listing.');
      }

      if (!claim || typeof claim.claimed !== 'boolean' || !claim.importRecord?.id) {
        throw new Error('The durable CRM import claim returned an invalid result, so no CRM write was attempted for this listing.');
      }

      importRecord = claim.importRecord;

      if (!claim.claimed) {
        const claimedSubmission = importRecord?.submission_id && storage.getSubmission
          ? await storage.getSubmission(importRecord.submission_id)
          : null;

        if (claimedSubmission && storage.updateSubmission) {
          const preserveExistingFields = !isDealHunterManagedSubmission(claimedSubmission);
          const updated = await updateDealHunterCrmSubmission(storage, claimedSubmission, deal, { preserveExistingFields });
          const status = preserveExistingFields ? 'enriched' : 'updated';
          summary[status] += 1;
          summary.results.push({ dealKey: deal.dealKey, status, submissionId: updated?.id || claimedSubmission.id });
          await linkDealHunterOpportunitySubmission(storage, deal, updated?.id || claimedSubmission.id);
        } else {
          summary.skipped += 1;
          summary.results.push({ dealKey: deal.dealKey, status: 'duplicate-in-progress', submissionId: importRecord?.submission_id || '' });
        }

        continue;
      }

      const existing = await findExistingDealHunterSubmission(storage, deal);

      if (existing) {
        if (storage.updateSubmission) {
          const preserveExistingFields = !isDealHunterManagedSubmission(existing);
          const updated = await updateDealHunterCrmSubmission(storage, existing, deal, { preserveExistingFields });
          const status = preserveExistingFields ? 'enriched' : 'updated';
          summary[status] += 1;
          summary.results.push({ dealKey: deal.dealKey, status, submissionId: updated?.id || existing.id });
          await updateDealHunterCrmImport(storage, importRecord, {
            submission_id: updated?.id || existing.id,
            status,
          });
          await linkDealHunterOpportunitySubmission(storage, deal, updated?.id || existing.id);
        } else {
          summary.skipped += 1;
          summary.results.push({ dealKey: deal.dealKey, status: 'duplicate-no-update', submissionId: existing.id });
          await linkDealHunterOpportunitySubmission(storage, deal, existing.id);
        }

        continue;
      }

      const created = await createManualSubmission(
        dealHunterCrmPayload(deal),
        'deal-hunter-daily-review',
        { storage },
      );

      if (!created.ok) {
        summary.failed += 1;
        summary.results.push({ dealKey: deal.dealKey, status: 'failed', error: (created.errors || []).join(' ') || 'CRM record was not created.' });
        await updateDealHunterCrmImport(storage, importRecord, {
          status: 'failed',
          metadata: {
            ...(importRecord?.metadata || {}),
            error: (created.errors || []).join(' ') || 'CRM record was not created.',
          },
        });
        continue;
      }

      summary.created += 1;
      summary.results.push({ dealKey: deal.dealKey, status: 'created', submissionId: created.submission?.id || '' });
      await updateDealHunterCrmImport(storage, importRecord, {
        submission_id: created.submission?.id || '',
        status: 'created',
      });
      await linkDealHunterOpportunitySubmission(storage, deal, created.submission?.id || '');
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ dealKey: deal.dealKey, status: 'failed', error: error.message });
      await updateDealHunterCrmImport(storage, importRecord, {
        status: 'failed',
        metadata: {
          ...(importRecord?.metadata || {}),
          error: error.message,
        },
      });
    }
  }

  return summary;
}

export function buildDealHunterCimRequestId(opportunityId, recipientEmail) {
  return sha256(`deal-hunter-cim-request:${opportunityId}:${normalizeEmail(recipientEmail)}`);
}

function isCompletedCimStatus(status = '') {
  return cimRequestTerminalStatuses.includes(status);
}

function normalizeEventType(value = '') {
  return normalizeText(value, 80).toLowerCase().replace(/^email[._-]/, '').replace(/[._-]/g, '_');
}

function isRecentPendingCimRequest(request) {
  if (request?.status !== 'pending') {
    return false;
  }

  const updatedAt = Date.parse(request.updated_at || '');
  return Number.isFinite(updatedAt) && updatedAt > Date.now() - 10 * 60 * 1000;
}

function getCimFollowUpSettings() {
  const config = getConfig();
  return config.dealHunter?.cimFollowUp || {
    enabled: false,
    firstDelayHours: 48,
    intervalHours: 72,
    maxCount: 3,
    delaySequenceHours: [48, 72, 96],
    weekdaysOnly: true,
    timezone: 'America/Los_Angeles',
    sendWindowStart: '08:00',
    sendWindowEnd: '17:00',
  };
}

export function isCimFollowUpSendDay({ now = new Date(), settings = getCimFollowUpSettings() } = {}) {
  if (!settings.weekdaysOnly) {
    return true;
  }

  const date = now instanceof Date ? now : new Date(now);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone || 'America/Los_Angeles',
    weekday: 'short',
  }).format(date);

  return weekday !== 'Sat' && weekday !== 'Sun';
}

function acquireLock(lockSet, key) {
  if (!key || lockSet.has(key)) {
    return false;
  }

  lockSet.add(key);
  return true;
}

function releaseLock(lockSet, key) {
  if (key) {
    lockSet.delete(key);
  }
}

function buildCimRequestLockKey(dealKey, recipientEmail) {
  return `${normalizeText(dealKey, 1000)}|${normalizeEmail(recipientEmail)}`;
}

function buildCimDealSendLockKey(dealKey) {
  return `first-contact:${normalizeText(dealKey, 1000)}`;
}

function addHoursIso(value, hours) {
  const baseMs = Date.parse(value || '');

  if (!Number.isFinite(baseMs)) {
    return '';
  }

  return new Date(baseMs + Math.max(0, Number(hours) || 0) * 60 * 60 * 1000).toISOString();
}

function subtractMinutesIso(value, minutes) {
  const baseMs = Date.parse(value || '');

  if (!Number.isFinite(baseMs)) {
    return '';
  }

  return new Date(baseMs - Math.max(1, Number(minutes) || 1) * 60 * 1000).toISOString();
}

export function nextCimFollowUpAt({
  status = '',
  followUpCount = 0,
  lastTouchAt = '',
  settings = getCimFollowUpSettings(),
} = {}) {
  const safeCount = Number(followUpCount || 0);

  if (!cimRequestSentStatuses.includes(status) || settings.maxCount <= 0 || safeCount >= settings.maxCount) {
    return null;
  }

  const delaySequence = Array.isArray(settings.delaySequenceHours) && settings.delaySequenceHours.length > 0
    ? settings.delaySequenceHours
    : [settings.firstDelayHours, settings.intervalHours];
  const delayHours = delaySequence[safeCount] || settings.intervalHours;
  return addHoursIso(lastTouchAt, delayHours) || null;
}

function getCimRequestProviderMessageIds(request = {}) {
  const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  return Array.from(
    new Set(
      [
        request.provider_message_id,
        ...(Array.isArray(metadata.providerMessageIds) ? metadata.providerMessageIds : []),
        ...(Array.isArray(metadata.followUps) ? metadata.followUps.map((item) => item.providerMessageId) : []),
      ]
        .map((value) => normalizeText(value, 240))
        .filter(Boolean),
    ),
  );
}

function getEmailEventTagValue(event, key) {
  const tags = event?.metadata?.tags;

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string') {
        const [tagKey, ...rest] = tag.split('=');

        if (normalizeText(tagKey, 80) === key) {
          return normalizeText(rest.join('='), 240);
        }
      } else if (tag && typeof tag === 'object' && normalizeText(tag.name || tag.key, 80) === key) {
        return normalizeText(tag.value, 240);
      }
    }
  }

  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    return normalizeText(tags[key], 240);
  }

  return '';
}

function getEmailEventContactEmail(event) {
  return getEmailAddress(
    event?.metadata?.fromEmail,
    event?.metadata?.senderEmail,
    event?.metadata?.from,
    event?.from_email,
    event?.recipient_email,
  );
}

function getEmailAddress(...inputs) {
  const values = inputs.flatMap((value) => (Array.isArray(value) ? value : [value]));

  for (const item of values) {
    const match = normalizeText(item, 500).match(/<?([^<>\s]+@[^<>\s]+)>?/);

    if (match?.[1]) {
      return normalizeEmail(match[1]);
    }
  }

  return '';
}

function getEmailEventInboundRecipient(event) {
  return getEmailAddress(
    event?.metadata?.toEmail,
    event?.metadata?.to,
    event?.to_email,
  );
}

function getCimRequestReplyToAddress(request) {
  const storedAddress = getEmailAddress(request?.metadata?.replyToAddress || '');

  if (storedAddress) {
    return storedAddress;
  }

  return getEmailAddress(
    buildCimReplyToAddress({
      requestId: request?.id || '',
      replyTo: getConfig().delivery.resendReplyTo || '',
    }),
  );
}

function emailEventOccurredAfterRequest(event, request) {
  const eventTime = Date.parse(event?.created_at || '');
  const requestTime = Date.parse(request?.created_at || '');

  return Number.isFinite(eventTime) && Number.isFinite(requestTime) && eventTime >= requestTime;
}

function emailEventTagMatchesValue(eventValue, expectedValue) {
  const normalizedEventValue = normalizeText(eventValue, 260);
  const normalizedExpectedValue = normalizeText(expectedValue, 260);

  return Boolean(
    normalizedEventValue &&
      normalizedExpectedValue &&
      (normalizedEventValue === normalizedExpectedValue ||
        normalizedEventValue === normalizeResendTagToken(normalizedExpectedValue)),
  );
}

export function eventMatchesCimRequest(event, request) {
  const eventMessageId = normalizeText(event?.message_id, 240);
  const messageIds = getCimRequestProviderMessageIds(request);

  if (eventMessageId && messageIds.includes(eventMessageId)) {
    return true;
  }

  const eventRecipient = normalizeEmail(event?.recipient_email || '');
  const requestRecipient = normalizeEmail(request?.recipient_email || '');
  const eventType = normalizeEventType(event?.event_type);

  if (
    replyEventTypes.has(eventType) &&
    requestRecipient &&
    getEmailEventContactEmail(event) === requestRecipient &&
    emailEventOccurredAfterRequest(event, request)
  ) {
    const inboundRecipient = getEmailEventInboundRecipient(event);
    const requestReplyTo = getCimRequestReplyToAddress(request);

    if (inboundRecipient && requestReplyTo && inboundRecipient === requestReplyTo) {
      return true;
    }
  }

  const eventDealKey = event?.metadata?.tracking?.dealKey || event?.metadata?.dealKey || getEmailEventTagValue(event, 'deal_key');
  const eventRequestId = event?.metadata?.tracking?.cimRequestId || event?.metadata?.cimRequestId || getEmailEventTagValue(event, 'cim_request_id');

  return Boolean(
    eventRecipient &&
      eventRecipient === requestRecipient &&
      ((eventDealKey && emailEventTagMatchesValue(eventDealKey, request.deal_key)) ||
        (eventRequestId && emailEventTagMatchesValue(eventRequestId, request.id))),
  );
}

function findCimReplyEvent(request, events = []) {
  return events
    .filter((event) => replyEventTypes.has(normalizeEventType(event.event_type)) && eventMatchesCimRequest(event, request))
    .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))[0] || null;
}

function findCimStopEvent(request, events = []) {
  return events
    .filter((event) => stopFollowUpEventTypes.has(normalizeEventType(event.event_type)) && eventMatchesCimRequest(event, request))
    .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))[0] || null;
}

export function evaluateDealHunterCimEligibility({ deal = {}, recipientEmail = '', policy = 'automated' } = {}) {
  const manualStage1 = policy === 'manual_stage_1';
  const blockers = [];
  const warnings = [];
  const addBlocker = (code, message) => blockers.push({ code, message });

  if (deal?.identityStatus === 'ambiguous') {
    addBlocker('canonical_identity_ambiguous', 'Opportunity identity is ambiguous. An administrator must resolve it before outreach.');
  }
  if (!deal?.opportunityId) {
    addBlocker('canonical_identity_unavailable', 'Canonical opportunity identity is unavailable. Outreach is blocked until identity storage is healthy.');
  }
  if (!manualStage1 && !deal?.dealKey) addBlocker('deal_key_missing', 'Deal tracking key is missing.');
  if (deal.shouldRemove) addBlocker('opportunity_removed', 'Deal is marked for removal and should not receive outreach.');
  if (deal.score < cimRequestScoreThreshold) {
    if (manualStage1) {
      warnings.push({
        code: 'below_automated_cim_score_threshold',
        message: `Score is below the automated CIM threshold of ${cimRequestScoreThreshold}; manual review is required.`,
        value: Number.isFinite(Number(deal.score)) ? Number(deal.score) : null,
        automatedThreshold: cimRequestScoreThreshold,
      });
    } else {
      addBlocker('below_cim_score_threshold', `Score must be ${cimRequestScoreThreshold}+ before requesting a CIM.`);
    }
  }
  if (deal.annualProfit === null) {
    if (manualStage1) {
      warnings.push({
        code: 'annual_profit_incomplete',
        message: 'Annual profit is incomplete; confirm trailing SDE or EBITDA during manual review.',
        value: null,
      });
    } else {
      addBlocker('annual_profit_incomplete', 'Annual profit is missing; confirm trailing SDE or EBITDA before requesting a CIM.');
    }
  }
  if (!recipientEmail) addBlocker('recipient_missing', 'No broker or contact email is available for this listing.');
  else if (!isValidEmail(recipientEmail)) addBlocker('recipient_invalid', 'Broker or contact email is not valid.');

  return { eligible: blockers.length === 0, blockers, warnings };
}

function getCimRequestUnavailableReason(deal, recipientEmail) {
  return evaluateDealHunterCimEligibility({ deal, recipientEmail }).blockers[0]?.message || '';
}

function mapCimRequestsByDealRecipient(requests = []) {
  return requests.reduce((accumulator, request) => {
    const dealKey = request?.deal_key || '';
    const recipientEmail = normalizeEmail(request?.recipient_email || '');

    if (dealKey && recipientEmail) {
      accumulator.set(`${dealKey}|${recipientEmail}`, request);
    }

    return accumulator;
  }, new Map());
}

function mapCimRequestsByDeal(requests = []) {
  return requests.reduce((accumulator, request) => {
    const dealKey = request?.deal_key || '';
    if (!dealKey) return accumulator;
    const current = accumulator.get(dealKey) || [];
    current.push(request);
    current.sort((left, right) => Date.parse(right.updated_at || '') - Date.parse(left.updated_at || ''));
    accumulator.set(dealKey, current);
    return accumulator;
  }, new Map());
}

function mapCimRequestsByOpportunity(requests = []) {
  return requests.reduce((accumulator, request) => {
    const opportunityId = request?.opportunity_id || '';
    if (!opportunityId) return accumulator;
    const current = accumulator.get(opportunityId) || [];
    current.push(request);
    current.sort((left, right) => Date.parse(right.updated_at || '') - Date.parse(left.updated_at || ''));
    accumulator.set(opportunityId, current);
    return accumulator;
  }, new Map());
}

function findBlockingCimRequest(requests = []) {
  return requests.find((request) => isCompletedCimStatus(request?.status) || isRecentPendingCimRequest(request)) || null;
}

function attachCimRequestStatus(scoredDeals, requests = []) {
  const requestsByDealRecipient = mapCimRequestsByDealRecipient(requests);
  const requestsByDeal = mapCimRequestsByDeal(requests);
  const requestsByOpportunity = mapCimRequestsByOpportunity(requests);

  return scoredDeals.map((deal) => {
    const recipientEmail = normalizeEmail(deal.brokerEmail);
    const lookupDealKeys = uniqueStrings([deal.dealKey, ...(deal.dealKeyAliases || [])]);
    const brokerContacts = normalizeBrokerContacts(deal.brokerContacts?.length
      ? deal.brokerContacts
      : recipientEmail ? [{ name: deal.brokerName, email: recipientEmail, role: 'Broker', sourceColumn: 'Broker Email' }] : []);
    const exactRequest = lookupDealKeys
      .map((dealKey) => requestsByDealRecipient.get(`${dealKey}|${recipientEmail}`))
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.updated_at || '') - Date.parse(left.updated_at || ''))[0];
    const requestsForAliases = [
      ...(deal.opportunityId ? requestsByOpportunity.get(deal.opportunityId) || [] : []),
      ...lookupDealKeys.flatMap((dealKey) => requestsByDeal.get(dealKey) || []),
    ]
      .filter((request, index, all) => all.findIndex((candidate) => candidate.id === request.id) === index)
      .sort((left, right) => Date.parse(right.updated_at || '') - Date.parse(left.updated_at || ''));
    const existingRequest = findBlockingCimRequest(requestsForAliases) || exactRequest;
    const reason = getCimRequestUnavailableReason(deal, recipientEmail);
    const eligible = reason === '';
    const completed = isCompletedCimStatus(existingRequest?.status);
    const statusReason = reason
      || (completed
        ? 'This canonical opportunity was already contacted; its CIM sequence is retained in history.'
        : isRecentPendingCimRequest(existingRequest)
          ? 'A CIM request for this canonical opportunity is already in progress.'
          : '');
    const preview = eligible ? buildDealHunterCimRequestEmail({ to: recipientEmail, deal }) : null;
    const contactPreviews = eligible ? brokerContacts.map((contact) => {
      const contactPreview = buildDealHunterCimRequestEmail({
        to: contact.email,
        deal: { ...deal, brokerEmail: contact.email, brokerName: contact.name || '' },
      });
      return { email: contact.email, name: contact.name || '', subject: contactPreview.subject, text: contactPreview.text };
    }) : [];

    return {
      ...deal,
      brokerContacts,
      cimRequest: {
        id: existingRequest?.id || '',
        submissionId: existingRequest?.submission_id || '',
        eligible,
        canRequest: eligible && !completed && !isRecentPendingCimRequest(existingRequest),
        status: existingRequest?.status || (eligible ? 'ready' : 'unavailable'),
        requestState: existingRequest?.request_state || (eligible ? 'ready' : 'not_requested'),
        deliveryState: existingRequest?.delivery_state || 'not-attempted',
        followUpState: existingRequest?.follow_up_state || (existingRequest?.next_follow_up_at ? 'scheduled' : 'not-scheduled'),
        reason: statusReason,
        recipientEmail: normalizeEmail(existingRequest?.recipient_email || recipientEmail),
        snapshotToken: eligible ? signCimDealSnapshot(deal) : '',
        requestedAt: existingRequest?.first_requested_at || existingRequest?.created_at || '',
        firstProviderAcceptedAt: existingRequest?.first_provider_accepted_at || '',
        deliveredAt: existingRequest?.delivered_at || '',
        lastAttemptAt: existingRequest?.last_attempt_at || '',
        lastActivityAt: existingRequest?.last_activity_at || existingRequest?.updated_at || '',
        requestedBy: existingRequest?.requested_by || '',
        deliveryError: existingRequest?.delivery_error || '',
        providerMessageId: existingRequest?.provider_message_id || '',
        subject: existingRequest?.subject || '',
        preview: preview ? { subject: preview.subject, text: preview.text } : null,
        contactPreviews,
        followUpCount: Number(existingRequest?.follow_up_count || 0),
        lastFollowUpAt: existingRequest?.last_follow_up_at || '',
        nextFollowUpAt: existingRequest?.next_follow_up_at || '',
        respondedAt: existingRequest?.responded_at || '',
      },
    };
  });
}

export function batchDealHunterStorageKeys(dealKeys = [], provider = '') {
  const uniqueKeys = [...new Set(dealKeys.filter(Boolean))];
  const maxBatchSize = provider === 'sqlite' ? 800 : provider === 'supabase' ? 75 : 250;
  const maxEncodedCharacters = provider === 'supabase' ? 6000 : Infinity;
  const batches = [];
  let batch = [];
  let encodedCharacters = 0;

  for (const dealKey of uniqueKeys) {
    const keyCharacters = encodeURIComponent(dealKey).length + 1;
    if (batch.length > 0 && (
      batch.length >= maxBatchSize
      || encodedCharacters + keyCharacters > maxEncodedCharacters
    )) {
      batches.push(batch);
      batch = [];
      encodedCharacters = 0;
    }
    batch.push(dealKey);
    encodedCharacters += keyCharacters;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function loadDealHunterStorageBatches(batches, loader) {
  const records = [];
  const concurrency = 4;
  for (let index = 0; index < batches.length; index += concurrency) {
    const batchRecords = await Promise.all(batches.slice(index, index + concurrency).map(loader));
    records.push(...batchRecords.flat());
  }
  return records;
}

async function loadDealHunterCimRequests(storage, dealKeys, opportunityIds = []) {
  if (!storage.listDealHunterCimRequests || (dealKeys.length === 0 && opportunityIds.length === 0)) {
    return [];
  }

  try {
    const dealBatches = batchDealHunterStorageKeys(dealKeys, storage.provider);
    const opportunityBatches = batchDealHunterStorageKeys(opportunityIds, storage.provider);
    const records = await Promise.all([
      loadDealHunterStorageBatches(dealBatches, (batch) => (
      storage.listDealHunterCimRequests({ dealKeys: batch, limit: 5000 })
      )),
      loadDealHunterStorageBatches(opportunityBatches, (batch) => (
        storage.listDealHunterCimRequests({ opportunityIds: batch, limit: 5000 })
      )),
    ]);
    return [...new Map(records.flat().map((request) => [request.id, request])).values()];
  } catch (error) {
    console.warn(`[deal-hunter] CIM request history lookup failed: ${error.message}`);
    // Missing request history could make previously contacted deals appear ready
    // for outreach. Keep reviews and automation fail-closed instead.
    throw new Error('Deal Hunter CIM request history could not be loaded safely.');
  }
}

function sourceObservationDealsForDeal(deal = {}) {
  return Array.isArray(deal.sourceObservationDeals) && deal.sourceObservationDeals.length > 0
    ? deal.sourceObservationDeals
    : [sourceObservationDeal(deal)];
}

// Full Sheet reconciliation is allowed only when the collector can prove that
// its normalized raw rows are every row it received from that authoritative
// Sheet. This deliberately happens before dedupe/candidate selection: a
// dropped candidate may never authorize deletion of a still-current source
// observation. Daily and supplemental imports do not create these scopes.
function buildCompleteSheetObservationScopes(sourceResults = [], reviewMode = 'daily') {
  const scopes = new Map();
  if (reviewMode !== 'full-backfill') return scopes;

  for (const result of sourceResults) {
    const source = result?.source || {};
    if (source.required !== true && source.sourceRole !== 'required-primary') continue;
    const sourceId = String(source.id || '').trim();
    if (!sourceId) continue;

    const scope = {
      sourceId,
      sourceName: '',
      sourceResult: result,
      expectedRecordIds: new Set(),
      representedRecordIds: new Set(),
      recordsByOpportunity: new Map(),
      complete: true,
      identityComplete: true,
    };
    if (scopes.has(sourceId)) {
      const priorScope = scopes.get(sourceId);
      priorScope.complete = false;
      priorScope.identityComplete = false;
      scope.complete = false;
      scope.identityComplete = false;
    }
    scopes.set(sourceId, scope);
    const markIdentityIncomplete = () => {
      scope.complete = false;
      scope.identityComplete = false;
    };

    const collectedDeals = Array.isArray(result?.deals) ? result.deals : [];
    const sourceRowCount = Number(source.sourceRowCount);
    const rowCount = Number(source.rowCount);
    if (
      !source.fetched
      || source.error
      || source.coverageLimitReached
      || !Number.isInteger(sourceRowCount)
      || !Number.isInteger(rowCount)
      || sourceRowCount <= 0
      || sourceRowCount !== rowCount
      || collectedDeals.length !== sourceRowCount
    ) {
      scope.complete = false;
    }

    for (const deal of collectedDeals) {
      if (String(deal?.sourceId || '').trim() !== sourceId) {
        markIdentityIncomplete();
        continue;
      }
      let sourceRecordId = '';
      try {
        sourceRecordId = getOpportunitySourceObservationRecordId(deal);
      } catch {
        markIdentityIncomplete();
        continue;
      }
      const sourceName = String(deal?.sourceName || '').trim();
      if (!sourceRecordId || !sourceName || scope.expectedRecordIds.has(sourceRecordId)) {
        markIdentityIncomplete();
        continue;
      }
      if (scope.sourceName && scope.sourceName !== sourceName) {
        markIdentityIncomplete();
        continue;
      }
      scope.sourceName = sourceName;
      scope.expectedRecordIds.add(sourceRecordId);
    }
    if (scope.expectedRecordIds.size !== sourceRowCount) scope.complete = false;
  }

  return scopes;
}

function mergeSourceObservationRecordSnapshot(target, snapshot) {
  const fields = new Set(target.observations.map((observation) => observation.field));
  target.observations.push(...snapshot.observations.filter((observation) => !fields.has(observation.field)));
}

async function attachCanonicalOpportunityIdentities(storage, deals = [], completeSheetObservationScopes = new Map()) {
  if (!storage.listCurrentDealHunterOpportunities) {
    return deals.map((deal) => ({ ...deal, identityStatus: 'unavailable', opportunityId: '' }));
  }
  const candidates = await storage.listCurrentDealHunterOpportunities({ limit: 100000 });
  const resolvedDeals = [];
  const deferredSourceScopes = completeSheetObservationScopes instanceof Map
    ? completeSheetObservationScopes
    : new Map();
  const perRecordSnapshots = new Map();
  for (const deal of deals) {
    const resolution = await resolveDealHunterOpportunity({
      deal,
      storage,
      actor: 'deal-hunter-review',
      candidateOpportunities: candidates,
    });
    if (resolution.opportunity) {
      const candidateIndex = candidates.findIndex((item) => item.opportunity_id === resolution.opportunity.opportunity_id);
      if (candidateIndex >= 0) candidates[candidateIndex] = resolution.opportunity;
      else candidates.push(resolution.opportunity);
    }
    const sourceDeals = sourceObservationDealsForDeal(deal);
    if (!resolution.ok || !resolution.opportunityId) {
      for (const sourceDeal of sourceDeals) {
        const scope = deferredSourceScopes.get(String(sourceDeal?.sourceId || '').trim());
        if (scope) scope.complete = false;
      }
    } else {
      const now = new Date().toISOString();
      for (const sourceDeal of sourceDeals) {
        const snapshot = buildOpportunitySourceObservationSnapshot({ opportunityId: resolution.opportunityId, deal: sourceDeal, now });
        const completeScope = deferredSourceScopes.get(String(sourceDeal?.sourceId || '').trim());
        if (!snapshot) {
          if (completeScope) completeScope.complete = false;
          continue;
        }
        if (completeScope) {
          if (
            !completeScope.expectedRecordIds.has(snapshot.source_record_id)
            || completeScope.representedRecordIds.has(snapshot.source_record_id)
            || snapshot.source_name !== completeScope.sourceName
          ) {
            completeScope.complete = false;
            continue;
          }
          completeScope.representedRecordIds.add(snapshot.source_record_id);
          const records = completeScope.recordsByOpportunity.get(snapshot.opportunity_id) || [];
          records.push(snapshot);
          completeScope.recordsByOpportunity.set(snapshot.opportunity_id, records);
          continue;
        }
        const key = [snapshot.opportunity_id, snapshot.source_id, snapshot.source_record_id].join('\u0000');
        const current = perRecordSnapshots.get(key);
        if (current) {
          mergeSourceObservationRecordSnapshot(current, snapshot);
        } else {
          perRecordSnapshots.set(key, snapshot);
        }
      }
    }
    const { sourceObservationDeals: _sourceObservationDeals, ...resolvedDeal } = deal;
    resolvedDeals.push({
      ...resolvedDeal,
      opportunityId: resolution.opportunityId || '',
      identityStatus: resolution.ok ? 'resolved' : resolution.status || 'unavailable',
      identityResolution: resolution.resolution || '',
      identityExceptionId: resolution.identityException?.id || '',
    });
  }

  if (typeof storage.replaceDealHunterOpportunitySourceObservationSnapshot === 'function') {
    for (const snapshot of perRecordSnapshots.values()) {
      await storage.replaceDealHunterOpportunitySourceObservationSnapshot(snapshot);
    }
  }
  if (typeof storage.replaceAdmittedCompleteGoogleSheetSourceSnapshot === 'function') {
    for (const scope of deferredSourceScopes.values()) {
      if (
        !scope.complete
        || scope.expectedRecordIds.size === 0
        || scope.representedRecordIds.size !== scope.expectedRecordIds.size
      ) {
        continue;
      }
      const everyExpectedRecordIsRepresented = [...scope.expectedRecordIds]
        .every((sourceRecordId) => scope.representedRecordIds.has(sourceRecordId));
      if (!everyExpectedRecordIsRepresented) continue;
      const records = [...scope.recordsByOpportunity.values()].flat();
      if (records.length !== scope.expectedRecordIds.size) continue;
      const snapshot = {
        source_id: scope.sourceId,
        source_name: scope.sourceName,
        records,
      };
      await reconcileVerifiedCompleteGoogleSheetSourceSnapshot({
        storage,
        reviewMode: 'full-backfill',
        sourceResult: scope.sourceResult,
        records: snapshot.records,
      });
    }
  }

  const opportunityIds = uniqueStrings(resolvedDeals.map((deal) => deal.opportunityId));
  const aliases = opportunityIds.length > 0 && storage.listDealHunterOpportunityAliases
    ? await storage.listDealHunterOpportunityAliases({ opportunityIds, limit: 100000 })
    : [];
  const aliasesByOpportunity = aliases.reduce((map, item) => {
    const current = map.get(item.opportunity_id) || [];
    current.push(item);
    map.set(item.opportunity_id, current);
    return map;
  }, new Map());
  const enrichedDeals = resolvedDeals.map((deal) => {
    const durableAliases = aliasesByOpportunity.get(deal.opportunityId) || [];
    return {
      ...deal,
      dealKeyAliases: uniqueStrings([
        ...(deal.dealKeyAliases || []),
        ...durableAliases.filter((item) => item.alias_type === 'deal-key').map((item) => item.alias_value),
      ]).filter((value) => value !== deal.dealKey),
      listingAliases: uniqueStrings([
        ...(deal.listingAliases || []),
        ...durableAliases.filter((item) => item.alias_type === 'listing-url').map((item) => item.alias_value),
      ]),
      identityAliases: uniqueStrings([
        ...(deal.identityAliases || []),
        ...durableAliases
          .filter((item) => ['listing-id', 'source-identity'].includes(item.alias_type))
          .map((item) => item.alias_value),
      ]),
    };
  });
  const collapsed = [];
  const indexByOpportunity = new Map();
  for (const deal of enrichedDeals) {
    if (!deal.opportunityId || deal.identityStatus !== 'resolved') {
      collapsed.push(deal);
      continue;
    }
    const existingIndex = indexByOpportunity.get(deal.opportunityId);
    if (existingIndex === undefined) {
      indexByOpportunity.set(deal.opportunityId, collapsed.length);
      collapsed.push(deal);
      continue;
    }
    collapsed[existingIndex] = mergeSyndicatedDeals(collapsed[existingIndex], deal, {
      reason: 'canonical-opportunity-alias',
      confidence: 1,
      evidence: { opportunityId: deal.opportunityId, evidenceVersion: 'cim-opportunity-v1' },
    });
  }
  return collapsed;
}

async function loadDealHunterDispositions(storage, dealKeys) {
  if (!storage.listDealHunterDispositions || dealKeys.length === 0) {
    return [];
  }

  try {
    const batches = batchDealHunterStorageKeys(dealKeys, storage.provider);
    return await loadDealHunterStorageBatches(batches, (batch) => (
      storage.listDealHunterDispositions({
        dealKeys: batch,
        activeOnly: true,
        limit: Math.max(100, batch.length),
      })
    ));
  } catch {
    // A disposition lookup failure must fail closed for automation. Surface the
    // review as source-incomplete instead of silently reintroducing dismissed deals.
    throw new Error('Deal Hunter dispositions could not be loaded safely.');
  }
}

function attachDealHunterDispositions(deals, dispositions = []) {
  const byDealKey = new Map(dispositions.map((item) => [item.deal_key, item]));
  return deals.map((deal) => {
    const disposition = uniqueStrings([deal.dealKey, ...(deal.dealKeyAliases || [])])
      .map((dealKey) => byDealKey.get(dealKey))
      .find(Boolean) || null;
    return {
      ...deal,
      disposition,
      dismissed: Boolean(disposition),
    };
  });
}

function buildCimRequestRecord({
  deal,
  recipientEmail,
  requestedBy = '',
  emailResult = {},
  existingRequest = null,
  submissionId = '',
  requestId = '',
  retryOfRequestId = '',
  correctedRecipient = null,
  communicationId = '',
  manualApprovalAudit = null,
} = {}) {
  const now = new Date().toISOString();
  const businessName = normalizeText(deal.name || 'Unnamed business', 220);
  const status = emailResult.status || 'pending';
  const isPendingClaim = status === 'pending';
  const providerAccepted = status === 'sent';
  const developmentOnly = status === 'logged';
  const failed = status === 'failed';
  const ambiguous = status === 'ambiguous';
  const followUpCount = Number(existingRequest?.follow_up_count || 0);
  const providerMessageIds = Array.from(
    new Set(
      [
        ...getCimRequestProviderMessageIds(existingRequest || {}),
        emailResult.providerMessageId,
      ]
        .map((value) => normalizeText(value, 240))
        .filter(Boolean),
    ),
  );
  const existingMetadata = existingRequest?.metadata && typeof existingRequest.metadata === 'object' ? existingRequest.metadata : {};
  const inheritedManualApproval = existingMetadata.manualApproval && typeof existingMetadata.manualApproval === 'object'
    ? existingMetadata.manualApproval
    : null;
  const manualApprovalMarker = manualApprovalAudit || inheritedManualApproval;
  const noFollowUp = manualApprovalMarker?.intent === 'manual_stage_1'
    && manualApprovalMarker?.followUpPolicy === 'none';
  const resolvedRequestId = requestId || existingRequest?.id || buildDealHunterCimRequestId(deal.opportunityId, recipientEmail);
  const replyToAddress = buildCimReplyToAddress({
    requestId: resolvedRequestId,
    replyTo: getConfig().delivery.resendReplyTo || '',
  });
  const nextFollowUpAt = noFollowUp ? null : nextCimFollowUpAt({
    status,
    followUpCount,
    lastTouchAt: now,
  });

  return {
    id: resolvedRequestId,
    created_at: existingRequest?.created_at || now,
    updated_at: now,
    submission_id: submissionId || existingRequest?.submission_id || null,
    opportunity_id: deal.opportunityId || existingRequest?.opportunity_id || null,
    retry_of_request_id: retryOfRequestId || existingRequest?.retry_of_request_id || null,
    deal_key: deal.dealKey,
    recipient_email: normalizeEmail(recipientEmail),
    requested_by: normalizeText(requestedBy, 160),
    status,
    request_state: providerAccepted
      ? 'provider_accepted'
      : developmentOnly
        ? 'development_only'
        : ambiguous
          ? 'provider_ambiguous'
        : failed
          ? 'ready'
        : existingRequest?.request_state === 'responded'
          ? 'responded'
          : 'pending',
    delivery_state: providerAccepted
      ? 'accepted'
      : developmentOnly
        ? 'development-only'
        : ambiguous
          ? 'ambiguous'
        : failed
          ? 'failed'
          : existingRequest?.delivery_state || 'not-attempted',
    follow_up_state: noFollowUp ? 'not-scheduled' : ambiguous ? 'stopped' : nextFollowUpAt ? 'scheduled' : (failed ? 'stopped' : existingRequest?.follow_up_state || 'not-scheduled'),
    delivery_error: emailResult.error || '',
    provider_message_id: emailResult.providerMessageId || '',
    subject: `CIM / NDA request for ${businessName}`,
    deal_name: businessName,
    source_name: deal.sourceName || '',
    listing_url: deal.listingUrl || '',
    score: deal.score,
    follow_up_count: followUpCount,
    attempt_count: isPendingClaim && existingRequest?.status !== 'pending'
      ? Number(existingRequest?.attempt_count || 0) + 1
      : Number(existingRequest?.attempt_count || 0) || 1,
    first_requested_at: existingRequest?.first_requested_at || existingRequest?.created_at || now,
    first_provider_accepted_at: existingRequest?.first_provider_accepted_at || (providerAccepted ? now : null),
    delivered_at: existingRequest?.delivered_at || null,
    last_attempt_at: isPendingClaim ? now : existingRequest?.last_attempt_at || now,
    last_delivery_event_at: existingRequest?.last_delivery_event_at || null,
    last_activity_at: now,
    delivery_state_at: providerAccepted || developmentOnly || failed || ambiguous ? now : existingRequest?.delivery_state_at || null,
    reply_to_address: existingRequest?.reply_to_address || replyToAddress || null,
    last_follow_up_at: existingRequest?.last_follow_up_at || null,
    next_follow_up_at: nextFollowUpAt,
    responded_at: existingRequest?.responded_at || null,
    metadata: {
      ...existingMetadata,
      industry: deal.industry || '',
      description: deal.description || '',
      location: deal.location || '',
      city: deal.city || '',
      county: deal.county || '',
      state: deal.state || '',
      country: deal.country || '',
      sourceId: deal.sourceId || '',
      identityAliases: deal.identityAliases || [],
      stableExternalId: Boolean(deal.stableExternalId),
      annualProfit: deal.annualProfit,
      annualRevenue: deal.annualRevenue,
      askingPrice: deal.askingPrice,
      profitMultiple: deal.profitMultiple,
      brokerName: deal.brokerName || '',
      brokerContacts: deal.brokerContacts || [],
      brokerCompany: deal.brokerCompany || '',
      brokerContact: deal.brokerContact || '',
      recommendation: deal.recommendation || '',
      strengths: deal.strengths || [],
      concerns: deal.concerns || [],
      questions: deal.questions || [],
      replyToAddress: existingMetadata.replyToAddress || replyToAddress,
      providerMessageIds,
      opportunityId: deal.opportunityId || existingRequest?.opportunity_id || '',
      initialCommunicationId: existingMetadata.initialCommunicationId || communicationId || '',
      ...(manualApprovalMarker ? { manualApproval: manualApprovalMarker } : {}),
      ...(correctedRecipient ? { correctedRecipient } : {}),
    },
  };
}

function preparedMessageFromCommunication(communication, templateMessage) {
  return {
    ...templateMessage,
    communicationId: communication.id,
    kind: communication.kind || templateMessage.kind,
    idempotencyKey: communication.idempotency_key || templateMessage.idempotencyKey,
    to: communication.to_addresses,
    replyTo: communication.reply_to_address || templateMessage.replyTo,
    subject: communication.subject || '',
    headline: communication.subject || '',
    text: communication.body_text || '',
    html: communication.body_html_sanitized || '',
  };
}

async function persistPreparedCimCommunication({
  storage,
  request,
  submissionId,
  message,
  actor,
  summary,
} = {}) {
  const existing = await storage.getCrmCommunication?.(message.communicationId);

  if (existing) {
    if (existing.submission_id !== submissionId || existing.cim_request_id !== request.id) {
      throw new Error('The persisted CIM communication does not match this CRM request.');
    }
    return existing;
  }

  const communication = buildOutboundCommunication({
    message,
    request,
    submissionId,
    createdBy: actor || 'deal-hunter',
  });
  if (message.manualApprovalAudit) {
    communication.metadata = {
      ...(communication.metadata || {}),
      templateVersion: message.templateVersion || '',
      manualApproval: message.manualApprovalAudit,
    };
  }
  return createCommunicationWithActivity({
    communication,
    actor: actor || 'deal-hunter',
    role: 'admin',
    summary,
  }, storage);
}

async function updateCimCommunicationAfterSend(storage, communication, emailResult, actor = 'deal-hunter') {
  const now = new Date().toISOString();
  const deliveryState = emailResult.status === 'sent'
    ? 'accepted'
    : emailResult.status === 'logged'
      ? 'development-only'
      : emailResult.status === 'ambiguous'
        ? 'ambiguous'
        : 'failed';
  return storage.updateCrmCommunication(communication.id, {
    provider_message_id: emailResult.providerMessageId || communication.provider_message_id || null,
    delivery_state: deliveryState,
    delivery_state_at: now,
    occurred_at: communication.occurred_at || now,
    updated_at: now,
    updated_by: actor || 'deal-hunter',
  });
}

function acceptedCimCommunicationProof(communication) {
  if (!communication || communication.direction !== 'outbound') return null;

  const deliveryState = normalizeText(communication.delivery_state, 80).toLowerCase().replaceAll('_', '-');
  const provider = normalizeText(communication.provider, 60).toLowerCase();
  const providerMessageId = normalizeText(communication.provider_message_id, 240);
  const developmentOnly = provider === 'console' && deliveryState === 'development-only';
  const legacyEmailJsAccepted = provider === 'emailjs'
    && deliveryState !== 'failed'
    && cimProviderAcceptedCommunicationStates.has(deliveryState);

  if (
    !developmentOnly &&
    (
      !cimProviderAcceptedCommunicationStates.has(deliveryState) ||
      (!providerMessageId && !legacyEmailJsAccepted)
    )
  ) {
    return null;
  }

  return {
    deliveryState,
    developmentOnly,
    occurredAt:
      communication.delivery_state_at ||
      communication.updated_at ||
      communication.occurred_at ||
      communication.created_at ||
      new Date().toISOString(),
    emailResult: {
      status: developmentOnly ? 'logged' : 'sent',
      error: '',
      providerMessageId,
    },
  };
}

function applyAcceptedCommunicationProof(request, communication, proof) {
  const deliveryIssue = cimDeliveryIssueStates.has(proof.deliveryState);
  const responded = request.request_state === 'responded' || proof.deliveryState === 'replied';
  const status = responded
    ? 'responded'
    : deliveryIssue
      ? 'delivery_issue'
      : proof.developmentOnly
        ? 'logged'
        : 'sent';
  const requestState = responded
    ? 'responded'
    : proof.developmentOnly
      ? 'development_only'
      : 'provider_accepted';

  return {
    ...request,
    status,
    request_state: requestState,
    delivery_state: proof.deliveryState,
    delivery_state_at: proof.occurredAt,
    delivery_error: deliveryIssue
      ? request.delivery_error || `Email ${proof.deliveryState}. Verify or correct the recipient before retrying.`
      : '',
    provider_message_id: proof.emailResult.providerMessageId || request.provider_message_id || '',
    first_provider_accepted_at: proof.developmentOnly
      ? request.first_provider_accepted_at || null
      : request.first_provider_accepted_at || proof.occurredAt,
    delivered_at: proof.deliveryState === 'delivered'
      ? request.delivered_at || proof.occurredAt
      : request.delivered_at || null,
    last_delivery_event_at: proof.developmentOnly
      ? request.last_delivery_event_at || null
      : proof.occurredAt,
    responded_at: responded ? request.responded_at || proof.occurredAt : request.responded_at || null,
    follow_up_state: responded || deliveryIssue ? 'stopped' : request.follow_up_state,
    next_follow_up_at: responded || deliveryIssue ? null : request.next_follow_up_at,
    last_activity_at: proof.occurredAt,
    updated_at: new Date().toISOString(),
    metadata: {
      ...(request.metadata || {}),
      providerMessageIds: Array.from(new Set([
        ...getCimRequestProviderMessageIds(request),
        proof.emailResult.providerMessageId,
      ].filter(Boolean))),
      reconciledCommunicationId: communication.id,
      reconciledAt: new Date().toISOString(),
    },
  };
}

function cimRequestHasNoFollowUpPolicy(request = {}) {
  const marker = request?.metadata?.manualApproval;
  return marker?.intent === 'manual_stage_1' && marker?.followUpPolicy === 'none';
}

async function reconcileAcceptedInitialCimCommunication({
  storage,
  request,
  communication,
  actor = 'deal-hunter',
  deal = null,
} = {}) {
  const proof = acceptedCimCommunicationProof(communication);
  if (!proof || !request) return null;

  const requestDeal = deal || dealFromCimRequest(request);
  const baseRecord = buildCimRequestRecord({
    deal: requestDeal,
    recipientEmail: request.recipient_email,
    requestedBy: actor || request.requested_by,
    emailResult: proof.emailResult,
    existingRequest: request,
    submissionId: request.submission_id || communication.submission_id,
    requestId: request.id,
    retryOfRequestId: request.retry_of_request_id || '',
  });
  const nextFollowUpAt = cimRequestHasNoFollowUpPolicy(request) ? null : nextCimFollowUpAt({
    status: proof.emailResult.status,
    followUpCount: Number(request.follow_up_count || 0),
    lastTouchAt: proof.occurredAt,
  });
  const reconciledRecord = applyAcceptedCommunicationProof({
    ...baseRecord,
    next_follow_up_at: nextFollowUpAt,
    follow_up_state: nextFollowUpAt ? 'scheduled' : cimRequestHasNoFollowUpPolicy(request) ? 'not-scheduled' : baseRecord.follow_up_state,
  }, communication, proof);
  const savedRequest = await finalizeCimRequestClaimWithActivity(storage, reconciledRecord, request, {
    expectedStatuses: ['pending', 'failed'],
    eventType: 'cim.request-reconciled',
    summary: proof.developmentOnly
      ? 'Existing development-only CIM communication reconciled without retransmission.'
      : 'Existing provider-accepted CIM communication reconciled without retransmission.',
    actor,
    metadata: {
      communicationId: communication.id,
      providerMessageId: proof.emailResult.providerMessageId,
      deliveryState: proof.deliveryState,
      retransmitted: false,
    },
  });

  return { request: savedRequest, communication, emailResult: proof.emailResult, reconciled: true };
}

async function reconcileAcceptedCimFollowUp({
  storage,
  request,
  communication,
  followUpNumber,
  actor = 'deal-hunter',
} = {}) {
  const proof = acceptedCimCommunicationProof(communication);
  if (!proof || !request) return null;

  const reconciledRecord = applyAcceptedCommunicationProof(
    buildCimFollowUpUpdate(request, proof.emailResult, followUpNumber, proof.occurredAt),
    communication,
    proof,
  );
  const savedRequest = await finalizeCimRequestClaimWithActivity(storage, reconciledRecord, request, {
    expectedStatuses: ['follow_up_pending'],
    eventType: 'cim.follow-up-reconciled',
    summary: `Existing provider-accepted CIM follow-up ${followUpNumber} reconciled without retransmission.`,
    actor,
    metadata: {
      communicationId: communication.id,
      providerMessageId: proof.emailResult.providerMessageId,
      deliveryState: proof.deliveryState,
      followUpNumber,
      retransmitted: false,
    },
  });

  return {
    status: reconciledRecord.status === 'delivery_issue'
      ? 'stopped'
      : reconciledRecord.status === 'responded'
        ? 'responded'
        : 'sent',
    request: savedRequest,
    communication,
    emailResult: proof.emailResult,
    reconciled: true,
  };
}

function postProviderPersistenceError(kind, { communicationStatePersisted = false } = {}) {
  const error = new Error(
    `${kind} was accepted by the provider, but ${communicationStatePersisted
      ? 'its request state and audit activity could not be finalized'
      : 'its communication and request state could not be finalized'}. ${communicationStatePersisted
      ? 'Retrying will reconcile the saved communication without retransmitting it.'
      : 'Do not retransmit it until provider delivery is reconciled.'}`,
  );
  error.status = 503;
  error.providerAcceptedAmbiguous = true;
  return error;
}

function publicDealWithUnavailableCim(deal, reason, requests = []) {
  const attached = attachCimRequestStatus([deal], requests)[0];
  return publicDeal({
    ...attached,
    cimRequest: {
      ...(attached?.cimRequest || {}),
      eligible: false,
      canRequest: false,
      status: 'unavailable',
      reason,
      snapshotToken: '',
    },
  });
}

function dedupeEmailEvents(events = []) {
  const seen = new Set();

  return events.filter((event) => {
    const key = event.id || event.event_key || `${event.message_id || ''}:${event.event_type || ''}:${event.created_at || ''}:${event.recipient_email || ''}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function loadCimRequestEvents(storage, request) {
  const queries = [];
  const messageIds = getCimRequestProviderMessageIds(request);

  if (messageIds.length > 0 && storage.listEmailEventsByMessageIds) {
    queries.push(storage.listEmailEventsByMessageIds(messageIds, 1000));
  }

  if (request.recipient_email && storage.listEmailEvents) {
    queries.push(storage.listEmailEvents({ recipientEmail: request.recipient_email, limit: 500 }));
  }

  if (queries.length === 0) {
    return [];
  }

  const results = await Promise.all(queries);
  return dedupeEmailEvents(results.flat());
}

function buildCimRequestStorageUpdate(request, updates = {}) {
  return {
    ...request,
    ...updates,
    updated_at: updates.updated_at || new Date().toISOString(),
    metadata: {
      ...(request.metadata || {}),
      ...(updates.metadata || {}),
    },
  };
}

async function markCimRequestResponded(storage, request, replyEvent) {
  const respondedAt = replyEvent.created_at || new Date().toISOString();
  const updatedRequest = buildCimRequestStorageUpdate(request, {
      status: 'responded',
      request_state: 'responded',
      follow_up_state: 'stopped',
      responded_at: respondedAt,
      next_follow_up_at: null,
      last_activity_at: respondedAt,
      metadata: {
        responseEventId: replyEvent.id || '',
        responseMessageId: replyEvent.message_id || '',
        responseSubject: replyEvent.subject || '',
      },
    });
  return upsertCimRequestWithActivity(storage, updatedRequest, {
    eventType: 'cim.response-received',
    summary: 'Broker response received for the CIM request.',
    actor: replyEvent.recipient_email || request.recipient_email || 'broker',
    metadata: { emailEventId: replyEvent.id || '', messageId: replyEvent.message_id || '' },
  });
}

async function markCimRequestDeliveryIssue(storage, request, stopEvent) {
  const eventType = normalizeEventType(stopEvent.event_type);
  const updatedRequest = buildCimRequestStorageUpdate(request, {
      status: 'delivery_issue',
      request_state: request.request_state === 'responded' ? 'responded' : 'provider_accepted',
      delivery_state: eventType === 'unsubscribed' ? 'suppressed' : eventType,
      delivery_state_at: stopEvent.created_at || new Date().toISOString(),
      last_delivery_event_at: stopEvent.created_at || new Date().toISOString(),
      follow_up_state: 'stopped',
      delivery_error: `Follow-ups stopped because the email event was ${eventType}.`,
      next_follow_up_at: null,
      last_activity_at: stopEvent.created_at || new Date().toISOString(),
      metadata: {
        deliveryIssueEventId: stopEvent.id || '',
        deliveryIssueMessageId: stopEvent.message_id || '',
        deliveryIssueType: eventType,
      },
    });
  return upsertCimRequestWithActivity(storage, updatedRequest, {
    eventType: 'cim.delivery-issue',
    summary: `CIM follow-ups stopped after an email ${eventType} event.`,
    metadata: { emailEventId: stopEvent.id || '', messageId: stopEvent.message_id || '', deliveryIssueType: eventType },
  });
}

function buildCimFollowUpUpdate(request, emailResult, followUpNumber, sentAt, communicationId = '') {
  const settings = getCimFollowUpSettings();
  const sent = ['sent', 'logged'].includes(emailResult.status);
  const ambiguous = emailResult.status === 'ambiguous';
  const existingMetadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  const existingFollowUps = Array.isArray(existingMetadata.followUps) ? existingMetadata.followUps : [];
  const followUpCount = sent ? Number(request.follow_up_count || 0) + 1 : Number(request.follow_up_count || 0);
  const status = ambiguous
    ? 'follow_up_ambiguous'
    : sent
      ? (cimRequestSentStatuses.includes(request.status) ? request.status : emailResult.status)
      : 'follow_up_failed';
  const nextFollowUpAt = sent
    ? nextCimFollowUpAt({ status, followUpCount, lastTouchAt: sentAt })
    : addHoursIso(sentAt, settings.intervalHours) || null;
  const providerMessageIds = Array.from(
    new Set(
      [
        ...getCimRequestProviderMessageIds(request),
        emailResult.providerMessageId,
      ]
        .map((value) => normalizeText(value, 240))
        .filter(Boolean),
    ),
  );
  const replyToAddress = buildCimReplyToAddress({
    requestId: request.id,
    replyTo: getConfig().delivery.resendReplyTo || '',
  });

  return buildCimRequestStorageUpdate(request, {
    status,
    request_state: sent && request.request_state !== 'responded'
      ? (emailResult.status === 'logged' ? 'development_only' : 'provider_accepted')
      : request.request_state,
    delivery_state: emailResult.status === 'sent'
      ? 'accepted'
      : emailResult.status === 'logged'
        ? 'development-only'
        : ambiguous
          ? 'ambiguous'
          : 'failed',
    delivery_state_at: sentAt,
    delivery_error: emailResult.error || '',
    provider_message_id: emailResult.providerMessageId || request.provider_message_id || '',
    follow_up_count: followUpCount,
    last_follow_up_at: sent ? sentAt : request.last_follow_up_at || null,
    next_follow_up_at: ambiguous ? null : nextFollowUpAt,
    follow_up_state: sent
      ? (nextFollowUpAt ? 'scheduled' : 'completed')
      : ambiguous
        ? 'stopped'
        : 'failed',
    first_provider_accepted_at: request.first_provider_accepted_at || (emailResult.status === 'sent' ? sentAt : null),
    last_attempt_at: sentAt,
    last_activity_at: sentAt,
    metadata: {
      providerMessageIds,
      replyToAddress: existingMetadata.replyToAddress || replyToAddress,
      followUps: [
        ...existingFollowUps,
        {
          number: followUpNumber,
          attemptedAt: sentAt,
          acceptedAt: sent ? sentAt : '',
          status: emailResult.status,
          communicationId,
          providerMessageId: emailResult.providerMessageId || '',
          error: emailResult.error || '',
        },
      ],
    },
  });
}

function dealFromCimRequest(request = {}) {
  const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  return {
    opportunityId: request.opportunity_id || metadata.opportunityId || '',
    identityStatus: request.opportunity_id ? 'resolved' : 'unavailable',
    dealKey: request.deal_key || '',
    name: request.deal_name || 'Unnamed business',
    listingUrl: request.listing_url || '',
    sourceName: request.source_name || 'Deal Hunter',
    score: Number(request.score || 0),
    annualProfit: metadata.annualProfit ?? null,
    annualRevenue: metadata.annualRevenue ?? null,
    askingPrice: metadata.askingPrice ?? null,
    profitMultiple: metadata.profitMultiple ?? null,
    brokerName: metadata.brokerName || '',
    brokerEmail: request.recipient_email || '',
    brokerCompany: metadata.brokerCompany || '',
    brokerContact: metadata.brokerContact || '',
    brokerContacts: Array.isArray(metadata.brokerContacts) ? metadata.brokerContacts : [],
    industry: metadata.industry || '',
    location: metadata.location || '',
    recommendation: metadata.recommendation || '',
    strengths: Array.isArray(metadata.strengths) ? metadata.strengths : [],
    concerns: Array.isArray(metadata.concerns) ? metadata.concerns : [],
    questions: Array.isArray(metadata.questions) ? metadata.questions : [],
  };
}

async function processCimFollowUpRequest(storage, request, nowIso) {
  const lockKey = request?.id || buildCimRequestLockKey(request?.deal_key, request?.recipient_email);
  let durableRecipientClaimId = '';

  if (!acquireLock(cimFollowUpLocks, lockKey)) {
    return { status: 'locked', request };
  }

  try {
    const outreachGate = await assertCimOutreachAllowed({ storage });
    if (!outreachGate.allowed) return { status: 'deferred', reason: 'outreach-paused', request };

    // Global suppressions are recipient-wide and can be enforced safely even
    // while a legacy request is still awaiting canonical identity backfill.
    const activeSuppression = await storage.getActiveEmailSuppression?.(request.recipient_email);
    if (activeSuppression) {
      const stoppedRequest = await upsertCimRequestWithActivity(
        storage,
        buildCimRequestStorageUpdate(request, {
          request_state: 'stopped',
          follow_up_state: 'stopped',
          next_follow_up_at: null,
          last_activity_at: nowIso,
          metadata: {
            ...(request.metadata || {}),
            suppressionReason: activeSuppression.reason,
            suppressionId: activeSuppression.id,
          },
        }),
        {
          eventType: 'cim.outreach-suppressed',
          summary: 'CIM outreach stopped by the global email suppression policy.',
          actor: 'email-suppression-policy',
          metadata: { suppressionId: activeSuppression.id, reason: activeSuppression.reason },
        },
      );
      return { status: 'stopped', request: stoppedRequest };
    }

    const identity = await resolveDealHunterOpportunity({
      deal: dealFromCimRequest(request),
      storage,
      actor: 'deal-hunter-follow-up-boundary',
    });
    if (!identity.ok) {
      const stoppedRequest = await upsertCimRequestWithActivity(storage, {
        ...request,
        request_state: 'stopped',
        follow_up_state: 'stopped',
        next_follow_up_at: null,
        updated_at: nowIso,
        last_activity_at: nowIso,
        metadata: { ...(request.metadata || {}), identityExceptionId: identity.identityException?.id || '' },
      }, {
        eventType: 'cim.identity-blocked',
        summary: 'CIM follow-up stopped because canonical opportunity identity requires review.',
        actor: 'deal-hunter-identity-policy',
      });
      return { status: 'stopped', reason: 'identity-ambiguous', request: stoppedRequest };
    }
    if (request.opportunity_id !== identity.opportunityId) {
      request = await upsertCimRequestWithActivity(storage, {
        ...request,
        opportunity_id: identity.opportunityId,
        updated_at: nowIso,
        last_activity_at: nowIso,
      }, {
        eventType: 'cim.identity-linked',
        summary: 'CIM request linked to its canonical opportunity before follow-up.',
        actor: 'deal-hunter-identity-policy',
        metadata: { opportunityId: identity.opportunityId, resolution: identity.resolution },
      });
    }

    const siblingRequests = await storage.listDealHunterCimRequests({
      opportunityIds: [identity.opportunityId],
      limit: 500,
    });
    const terminalSibling = siblingRequests.find((candidate) => candidate.id !== request.id && (
      candidate.responded_at
      || candidate.request_state === 'responded'
      || ['complained', 'suppressed'].includes(candidate.delivery_state)
    ));
    if (terminalSibling) {
      const stoppedRequest = await upsertCimRequestWithActivity(storage, {
        ...request,
        request_state: terminalSibling.request_state === 'responded' ? 'responded' : 'stopped',
        follow_up_state: 'stopped',
        next_follow_up_at: null,
        updated_at: nowIso,
        last_activity_at: nowIso,
        metadata: { ...(request.metadata || {}), stoppedByCanonicalRequestId: terminalSibling.id },
      }, {
        eventType: 'cim.canonical-sequence-stopped',
        summary: 'Duplicate CIM sequence stopped by canonical opportunity state.',
        actor: 'deal-hunter-identity-policy',
        metadata: { opportunityId: identity.opportunityId, controllingRequestId: terminalSibling.id },
      });
      return { status: terminalSibling.request_state === 'responded' ? 'responded' : 'stopped', request: stoppedRequest };
    }
    const activeSiblings = siblingRequests.filter((candidate) => candidate.next_follow_up_at || candidate.status === 'follow_up_pending')
      .sort((left, right) => Date.parse(left.first_requested_at || left.created_at || '') - Date.parse(right.first_requested_at || right.created_at || '') || left.id.localeCompare(right.id));
    if (activeSiblings.length > 1 && activeSiblings[0].id !== request.id) {
      const stoppedRequest = await upsertCimRequestWithActivity(storage, {
        ...request,
        request_state: 'stopped',
        follow_up_state: 'stopped',
        next_follow_up_at: null,
        updated_at: nowIso,
        last_activity_at: nowIso,
        metadata: { ...(request.metadata || {}), canonicalSequenceOwnerId: activeSiblings[0].id },
      }, {
        eventType: 'cim.duplicate-sequence-quarantined',
        summary: 'Duplicate active CIM sequence quarantined without deleting history.',
        actor: 'deal-hunter-identity-policy',
        metadata: { opportunityId: identity.opportunityId, sequenceOwnerId: activeSiblings[0].id },
      });
      return { status: 'stopped', reason: 'duplicate-active-sequence', request: stoppedRequest };
    }

    const recipientPolicy = await evaluateCimRecipientPolicy({
      recipientEmail: request.recipient_email,
      opportunityId: identity.opportunityId,
      storage,
      now: new Date(nowIso),
    });
    if (!recipientPolicy.allowed) {
      await recordCimSafetyMetric({ metric: 'recipientCapDeferrals', storage, now: new Date(nowIso) }).catch(() => null);
      return { status: 'deferred', reason: recipientPolicy.reason, recipientPolicy, request };
    }

    if (!request.submission_id) {
      const submission = await ensureDealHunterSubmissionForCim(
        storage,
        dealFromCimRequest(request),
        request.requested_by || 'deal-hunter-follow-up',
      );

      if (submission.status === 'archived') {
        return { status: 'stopped', request };
      }

      request = await upsertCimRequestWithActivity(storage, {
        ...request,
        submission_id: submission.id,
        updated_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
      }, {
        eventType: 'cim.crm-linked',
        summary: 'CIM request linked to CRM before follow-up.',
        actor: request.requested_by || 'deal-hunter',
      });
    } else if (storage.getSubmission) {
      const linkedSubmission = await storage.getSubmission(request.submission_id);
      if (!linkedSubmission || linkedSubmission.status === 'archived') {
        return { status: 'stopped', request };
      }
    }

    const events = await loadCimRequestEvents(storage, request);
    const replyEvent = findCimReplyEvent(request, events);

    if (replyEvent) {
      const updatedRequest = await markCimRequestResponded(storage, request, replyEvent);
      return { status: 'responded', request: updatedRequest };
    }

    const stopEvent = findCimStopEvent(request, events);

    if (stopEvent) {
      const updatedRequest = await markCimRequestDeliveryIssue(storage, request, stopEvent);
      return { status: 'stopped', request: updatedRequest };
    }

    const settings = getCimFollowUpSettings();
    const followUpCount = Number(request.follow_up_count || 0);

    if (followUpCount >= settings.maxCount) {
      const updatedRequest = await upsertCimRequestWithActivity(
        storage,
        buildCimRequestStorageUpdate(request, {
          next_follow_up_at: null,
          follow_up_state: 'completed',
          last_activity_at: nowIso,
        }),
        {
          eventType: 'cim.follow-ups-completed',
          summary: 'CIM follow-up sequence completed without a response.',
          actor: request.requested_by || 'deal-hunter',
          metadata: { followUpCount },
        },
      );
      return { status: 'maxed', request: updatedRequest };
    }

    let claimedRequest = request;

    if (storage.claimDealHunterCimFollowUpRequest) {
      const claimResult = await storage.claimDealHunterCimFollowUpRequest({
        id: request.id,
        dueBefore: nowIso,
        staleBefore: subtractMinutesIso(nowIso, cimClaimStaleMinutes),
        nowIso,
      });

      if (!claimResult?.claimed) {
        return {
          status: ['submission-archived', 'submission-missing'].includes(claimResult?.reason) ? 'stopped' : 'locked',
          request: claimResult?.request || request,
        };
      }

      claimedRequest = claimResult.request || request;
    }

    const followUpNumber = followUpCount + 1;
    const communicationId = sha256(`crm-communication:${claimedRequest.id}:follow-up:${followUpNumber}`);
    if (!storage.claimDealHunterCimRecipient) {
      return { status: 'failed', reason: 'recipient-claim-storage-unavailable', request: claimedRequest };
    }
    durableRecipientClaimId = `${claimedRequest.id}:follow-up:${followUpNumber}`;
    const recipientClaim = await storage.claimDealHunterCimRecipient({
      recipientEmail: claimedRequest.recipient_email,
      requestId: durableRecipientClaimId,
      opportunityId: claimedRequest.opportunity_id,
      nowIso,
      expiresAt: new Date(Date.parse(nowIso) + 10 * 60 * 1000).toISOString(),
      metadata: { kind: 'cim-follow-up', followUpNumber },
    });
    if (!recipientClaim?.claimed) {
      const deferredRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestStorageUpdate(claimedRequest, {
          status: cimRequestSentStatuses.includes(request.status) ? request.status : 'follow_up_failed',
          follow_up_state: 'scheduled',
          next_follow_up_at: request.next_follow_up_at || nowIso,
          updated_at: nowIso,
          last_activity_at: nowIso,
          delivery_error: 'Another CIM transmission to this recipient is in progress.',
        }),
        claimedRequest,
        {
          expectedStatuses: ['follow_up_pending'],
          eventType: 'cim.follow-up-deferred',
          summary: 'CIM follow-up deferred because another recipient transmission is in progress.',
          actor: 'deal-hunter-recipient-policy',
        },
      );
      durableRecipientClaimId = '';
      return { status: 'deferred', reason: 'recipient-send-in-progress', request: deferredRequest };
    }
    const renderedMessage = buildDealHunterCimFollowUpEmail({
      to: claimedRequest.recipient_email,
      request: claimedRequest,
      followUpNumber,
      requestedBy: claimedRequest.requested_by || '',
      communicationId,
    });
    let communication;
    let emailResult;

    try {
      communication = await persistPreparedCimCommunication({
        storage,
        request: claimedRequest,
        submissionId: claimedRequest.submission_id,
        message: renderedMessage,
        actor: claimedRequest.requested_by || 'deal-hunter',
        summary: `Exact CIM follow-up ${followUpNumber} saved before transmission.`,
      });
    } catch {
      emailResult = {
        status: 'failed',
        error: 'The exact follow-up communication could not be persisted before transmission.',
        providerMessageId: '',
      };
    }

    if (communication) {
      const reconciliation = await reconcileAcceptedCimFollowUp({
        storage,
        request: claimedRequest,
        communication,
        followUpNumber,
        actor: claimedRequest.requested_by || 'deal-hunter',
      });
      if (reconciliation) return reconciliation;

      const renewal = await renewCimRequestClaim(storage, claimedRequest, 'follow_up_pending');
      if (!renewal?.renewed) {
        return {
          status: ['submission-archived', 'submission-missing'].includes(renewal?.reason) ? 'stopped' : 'locked',
          request: renewal?.request || claimedRequest,
        };
      }
      claimedRequest = renewal.request || claimedRequest;

      const finalOutreachGate = await assertCimOutreachAllowed({ storage });
      const finalRecipientPolicy = finalOutreachGate.allowed
        ? await evaluateCimRecipientPolicy({
            recipientEmail: claimedRequest.recipient_email,
            opportunityId: claimedRequest.opportunity_id,
            storage,
            now: new Date(nowIso),
          })
        : null;
      if (!finalOutreachGate.allowed || !finalRecipientPolicy?.allowed) {
        const deferredRequest = await finalizeCimRequestClaimWithActivity(
          storage,
          buildCimRequestStorageUpdate(claimedRequest, {
            status: cimRequestSentStatuses.includes(request.status) ? request.status : 'follow_up_failed',
            follow_up_state: 'scheduled',
            next_follow_up_at: request.next_follow_up_at || nowIso,
            updated_at: nowIso,
            last_activity_at: nowIso,
            delivery_error: finalOutreachGate.allowed ? 'Recipient cadence deferred this follow-up.' : finalOutreachGate.error,
          }),
          claimedRequest,
          {
            expectedStatuses: ['follow_up_pending'],
            eventType: 'cim.follow-up-deferred',
            summary: finalOutreachGate.allowed
              ? 'CIM follow-up deferred by recipient cadence policy.'
              : 'CIM follow-up deferred because outreach is globally paused.',
            actor: 'deal-hunter-safety-policy',
            metadata: { recipientPolicy: finalRecipientPolicy, outreachPause: finalOutreachGate.status },
          },
        );
        return { status: 'deferred', request: deferredRequest, recipientPolicy: finalRecipientPolicy };
      }
      if (finalRecipientPolicy.override?.id && storage.consumeDealHunterCimRecipientOverride) {
        await storage.consumeDealHunterCimRecipientOverride(finalRecipientPolicy.override.id, nowIso);
      }

      try {
        emailResult = await sendPreparedMessage(preparedMessageFromCommunication(communication, renderedMessage));
      } catch (error) {
        emailResult = {
          status: 'failed',
          error: error.message || 'The follow-up provider attempt failed.',
          providerMessageId: '',
        };
      }
    }

    let communicationStateError = null;
    if (communication && emailResult) {
      try {
      await updateCimCommunicationAfterSend(
        storage,
        communication,
        emailResult,
        claimedRequest.requested_by || 'deal-hunter',
      );
      } catch (error) {
        communicationStateError = error;
      }
    }

    let updatedRequest;
    try {
      updatedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimFollowUpUpdate(claimedRequest, emailResult, followUpNumber, nowIso, communication?.id || communicationId),
        claimedRequest,
        {
          expectedStatuses: ['follow_up_pending'],
          eventType: emailResult.status === 'ambiguous'
            ? 'cim.follow-up-ambiguous'
            : emailResult.status === 'failed'
              ? 'cim.follow-up-failed'
              : 'cim.follow-up-sent',
          summary: emailResult.status === 'ambiguous'
            ? `CIM follow-up ${followUpNumber} provider outcome is ambiguous; reconciliation is required before any retry.`
            : emailResult.status === 'failed'
              ? `CIM follow-up ${followUpNumber} provider attempt failed.`
              : emailResult.status === 'logged'
                ? `CIM follow-up ${followUpNumber} logged by the development-only console provider.`
                : `CIM follow-up ${followUpNumber} accepted by the email provider; delivery is awaiting confirmation.`,
          actor: claimedRequest.requested_by || 'deal-hunter',
          metadata: {
            followUpNumber,
            deliveryStatus: emailResult.status,
            providerMessageId: emailResult.providerMessageId || '',
            communicationId: communication?.id || '',
            communicationStatePersisted: !communicationStateError,
          },
        },
      );
    } catch (error) {
      if (['sent', 'logged'].includes(emailResult.status)) {
        throw postProviderPersistenceError(`CIM follow-up ${followUpNumber}`, {
          communicationStatePersisted: !communicationStateError,
        });
      }
      throw error;
    }

    return {
      status: emailResult.status === 'ambiguous' ? 'ambiguous' : emailResult.status === 'failed' ? 'failed' : 'sent',
      request: updatedRequest,
      emailResult,
      providerOutcomeAmbiguous: emailResult.status === 'ambiguous',
      warning: communicationStateError
        ? ['sent', 'logged'].includes(emailResult.status)
          ? 'The provider accepted the follow-up, but its communication delivery state awaits reconciliation.'
          : 'The provider attempt failed, and its communication delivery state could not be saved.'
        : '',
    };
  } finally {
    if (durableRecipientClaimId && storage.releaseDealHunterCimRecipientClaim) {
      await storage.releaseDealHunterCimRecipientClaim({ recipientEmail: request.recipient_email, requestId: durableRecipientClaimId });
    }
    releaseLock(cimFollowUpLocks, lockKey);
  }
}

function buildDealHunterCoverage(config, sourceResults = []) {
  const dealOsSource = sourceResults.find((result) => result.source.id === dealOsSourceId)?.source || null;
  const warnings = [];
  const optionalSourceWarnings = [];
  const stage2Warnings = [];
  const disabledSources = [{
    id: 'airtable-disabled',
    name: 'Legacy Airtable Biz List',
    mode: 'retired',
    disabled: true,
    retired: true,
    required: false,
    sourceRole: 'retired',
    fetched: false,
    rowCount: 0,
    reason: 'Airtable is retired and excluded from source collection and health.',
  }];

  if (!dealOsSource) {
    optionalSourceWarnings.push("OPTIONAL DEAL OS IMPORT ABSENT: No Deal OS CSV/XLSX import is active. Today's digest and eligible manual workflows use only the required Google Sheet; Deal OS reconciliation requires a fresh selected import.");
  } else if (!dealOsSource.fetched || dealOsSource.error) {
    const condition = /\bstale\b|hours? old|freshness limit/i.test(String(dealOsSource.error || ''))
      ? 'STALE'
      : 'UNAVAILABLE';
    optionalSourceWarnings.push(`OPTIONAL DEAL OS IMPORT ${condition} — NOT USED: ${dealOsSource.error || 'The latest import is unavailable.'} Today's digest and eligible manual workflows use only current Google Sheet rows; Deal OS reconciliation requires a fresh selected import.`);
  }

  warnings.push(...optionalSourceWarnings);

  if (dealOsSource?.coverageLimitReached) {
    const warning = `The Deal OS export reached the ${config.dealHunter.dealOsExportMaxRecords}-listing import ceiling. Listings beyond the export cap may be absent.`;
    warnings.push(warning);
    stage2Warnings.push(warning);
  }

  return {
    warnings,
    optionalSourceWarnings,
    stage2Warnings,
    disabledSources,
    dealOsImportPolicy: {
      acceptedExtensions: ['.csv', '.xlsx'],
      maxPayloadBytes: config.dealHunter.dealOsExportMaxPayloadBytes,
      maxRecords: config.dealHunter.dealOsExportMaxRecords,
      maxAgeHours: config.dealHunter.dealOsExportMaxAgeHours,
    },
  };
}

function normalizeDealHunterReviewMode(value = '') {
  return value === 'full-backfill' ? 'full-backfill' : 'daily';
}

async function buildDailyDealReview({ reviewMode = 'daily', dealOsImportId = '', storage = getStorage() } = {}) {
  const config = getConfig();
  const normalizedReviewMode = normalizeDealHunterReviewMode(reviewMode);
  const generatedAt = new Date().toISOString();
  const sourceResults = await collectSources(config, storage, { dealOsImportId });
  const coverage = buildDealHunterCoverage(config, sourceResults);
  const sourceOnlyReview = {
    generatedAt,
    reviewMode: normalizedReviewMode,
    lookbackDays: config.dealHunter.lookbackDays,
    selection: {
      strategy: normalizedReviewMode === 'full-backfill' ? 'all-canonical-listings' : 'recent-listings',
      recentListings: 0,
      usedDailyFallback: false,
    },
    profile: {
      minAnnualProfit: profile.minAnnualProfit,
      maxAnnualProfit: profile.maxAnnualProfit,
      targetStates: profile.targetStates,
      managementRequired: false,
      managementPreferred: true,
      buyerCashContext: 'ROBS plus savings can support an acquisition when paired with SBA financing, seller note, or investors.',
    },
    sources: sourceResults.map((result) => result.source),
    disabledSources: coverage.disabledSources,
    coverageWarnings: coverage.warnings,
    optionalSourceWarnings: coverage.optionalSourceWarnings,
    stage2CoverageWarnings: coverage.stage2Warnings,
    scoringDeferred: true,
    scoringDeferredReason: 'Scoring and scored-opportunity actions are deferred until every required Google Sheet is healthy.',
    cimOutreachPause: { paused: true, reason: 'The required Google Sheet source is unavailable.' },
    dealOsImportPolicy: coverage.dealOsImportPolicy,
    crmSyncPreview: { count: 0, dealKeys: [] },
    totals: {
      sourceRows: 0,
      normalizedDeals: 0,
      collapsedDuplicates: 0,
      recentDeals: 0,
      reviewedDeals: 0,
      newDeals: 0,
      newMatches: 0,
      qualified: 0,
      watchlist: 0,
      removalCandidates: 0,
      dismissed: 0,
      cimReady: 0,
      crmEligible: 0,
    },
    criteriaRecommendations: [],
    newlySeenMatches: [],
    qualified: [],
    watchlist: [],
    removalCandidates: [],
    identityExceptions: [],
  };

  // Required-source health is an invariant of the canonical review builder,
  // not an option individual callers can forget. This return happens before
  // deduplication, identity attachment, scoring, history writes, or any scored
  // opportunity output can be produced from supplemental rows alone.
  if (reviewHasRequiredSourceFailures(sourceOnlyReview)) {
    const latestDealOsImport = sourceResults.find((result) => result.source.id === dealOsSourceId)?.source?.latestImport || null;
    sourceOnlyReview.importSummary = buildDealHunterImportSummary(sourceOnlyReview, latestDealOsImport);
    return { review: sourceOnlyReview, scoredDeals: [], storage };
  }

  const allDeals = dedupeDeals(sourceResults.flatMap((result) => result.deals));
  const recentDeals = allDeals.filter((deal) => isRecentDeal(deal, config.dealHunter.lookbackDays));
  const usedDailyFallback = normalizedReviewMode === 'daily' && recentDeals.length === 0 && allDeals.length > 0;
  const candidateDeals = normalizedReviewMode === 'full-backfill'
    ? allDeals
    : recentDeals.length > 0
      ? recentDeals
      : allDeals;
  const completeSheetObservationScopes = buildCompleteSheetObservationScopes(sourceResults, normalizedReviewMode);
  // Called explicitly rather than as a bare map callback: `scoreDeal` takes an
  // optional ledger as its second argument, which a callback would fill with the
  // array index.
  const scoredDealsWithIdentity = await attachCanonicalOpportunityIdentities(
    storage,
    candidateDeals.map((candidateDeal) => scoreDeal(candidateDeal)),
    completeSheetObservationScopes,
  );
  // A cap or an incremental review is intentionally merely ineligible for
  // source-wide replacement. Ambiguous raw source-record identities are more
  // serious: a full backfill cannot safely claim a complete canonical set, so
  // defer scoring without touching the last-good Sheet observations.
  const ambiguousCompleteSheetIdentitySourceIds = [...completeSheetObservationScopes.values()]
    .filter((scope) => scope.identityComplete === false)
    .map((scope) => scope.sourceId)
    .sort();
  const seenDeals = await loadDealHunterHistory(storage);
  const scoredDealsWithHistory = attachHistory(scoredDealsWithIdentity, seenDeals, generatedAt);
  const dealKeys = uniqueStrings(scoredDealsWithHistory.flatMap((deal) => [
    deal.dealKey,
    ...(deal.dealKeyAliases || []),
  ]));
  const opportunityIds = uniqueStrings(scoredDealsWithHistory.map((deal) => deal.opportunityId));
  const [cimRequests, dispositions, allCimRequests, outreachGate, identityExceptions] = await Promise.all([
    loadDealHunterCimRequests(storage, dealKeys, opportunityIds),
    loadDealHunterDispositions(storage, dealKeys),
    storage.listDealHunterCimRequests?.({ limit: 100000 }) || [],
    assertCimOutreachAllowed({ storage }),
    storage.listDealHunterIdentityExceptions?.({ statuses: ['open'], limit: 100 }) || [],
  ]);
  const baseScoredDeals = attachCimRequestStatus(
    attachDealHunterDispositions(scoredDealsWithHistory, dispositions),
    cimRequests,
  ).map((deal) => deal.dismissed
    ? {
        ...deal,
        cimRequest: {
          ...deal.cimRequest,
          canRequest: false,
          reason: 'This opportunity was dismissed and is no longer actionable.',
        },
      }
    : deal);
  const generatedAtMs = Date.parse(generatedAt);
  const scoredDeals = baseScoredDeals.map((deal) => {
    const touches = logicalCimTouchesForRecipient(allCimRequests, deal.brokerEmail);
    const touches24Hours = touches.filter((touch) => Date.parse(touch.occurredAt) >= generatedAtMs - 24 * 60 * 60 * 1000).length;
    const touches30Days = touches.filter((touch) => Date.parse(touch.occurredAt) >= generatedAtMs - 30 * 24 * 60 * 60 * 1000).length;
    const cap24Hours = Number(config.dealHunter.cimOutreach.recipientCap24Hours);
    const cap30Days = Number(config.dealHunter.cimOutreach.recipientCap30Days);
    const recipientBlocked = touches24Hours >= cap24Hours || touches30Days >= cap30Days;
    const policyReason = !outreachGate.allowed
      ? outreachGate.error
      : recipientBlocked
        ? touches24Hours >= cap24Hours
          ? 'This recipient has reached the rolling 24-hour CIM touch cap.'
          : 'This recipient has reached the rolling 30-day CIM touch cap.'
        : '';
    return {
      ...deal,
      cimRequest: {
        ...deal.cimRequest,
        canRequest: deal.cimRequest.canRequest && !policyReason,
        reason: deal.cimRequest.reason || policyReason,
        recipientPolicy: { touches24Hours, touches30Days, cap24Hours, cap30Days, blocked: recipientBlocked },
        outreachPaused: !outreachGate.allowed,
      },
    };
  });
  const newlySeenMatches = scoredDeals
    .filter((deal) => !deal.dismissed && deal.isNew && !deal.shouldRemove && deal.score >= watchlistScoreThreshold)
    .sort(sortBestDeals)
    .map(publicDeal);
  const qualified = scoredDeals
    .filter((deal) => !deal.dismissed && !deal.shouldRemove && deal.score >= highFitScoreThreshold)
    .sort(sortNewThenBest)
    .map(publicDeal);
  const watchlist = scoredDeals
    .filter((deal) => !deal.dismissed && !deal.shouldRemove && deal.score >= watchlistScoreThreshold && deal.score < highFitScoreThreshold)
    .sort(sortNewThenBest)
    .map(publicDeal);
  const removalCandidates = scoredDeals
    .filter((deal) => !deal.dismissed && deal.shouldRemove)
    .sort((left, right) => {
      const dateDifference = (Date.parse(right.dateAdded || right.lastUpdated || '') || 0) - (Date.parse(left.dateAdded || left.lastUpdated || '') || 0);
      return dateDifference || left.score - right.score;
    })
    .map(publicDeal);
  const crmEligibleDeals = dealHunterCrmCandidates(scoredDeals);
  const includedSourceRows = sourceResults
    .filter((result) => result.source.fetched && !result.source.error)
    .reduce((sum, result) => sum + (result.source.rowCount || 0), 0);

  const review = {
    generatedAt,
    reviewMode: normalizedReviewMode,
    lookbackDays: config.dealHunter.lookbackDays,
    selection: {
      strategy: normalizedReviewMode === 'full-backfill' ? 'all-canonical-listings' : 'recent-listings',
      recentListings: recentDeals.length,
      usedDailyFallback,
    },
    profile: {
      minAnnualProfit: profile.minAnnualProfit,
      maxAnnualProfit: profile.maxAnnualProfit,
      targetStates: profile.targetStates,
      managementRequired: false,
      managementPreferred: true,
      buyerCashContext: 'ROBS plus savings can support an acquisition when paired with SBA financing, seller note, or investors.',
    },
    sources: sourceResults.map((result) => result.source),
    disabledSources: coverage.disabledSources,
    coverageWarnings: coverage.warnings,
    optionalSourceWarnings: coverage.optionalSourceWarnings,
    stage2CoverageWarnings: coverage.stage2Warnings,
    scoringDeferred: ambiguousCompleteSheetIdentitySourceIds.length > 0,
    scoringDeferredReason: ambiguousCompleteSheetIdentitySourceIds.length > 0
      ? 'Scoring and scored-opportunity actions are deferred until every required Google Sheet has a complete, uniquely identified source snapshot.'
      : '',
    sourceSnapshotAdmissionDeferredSources: ambiguousCompleteSheetIdentitySourceIds,
    cimOutreachPause: outreachGate.status,
    dealOsImportPolicy: coverage.dealOsImportPolicy,
    crmSyncPreview: {
      count: crmEligibleDeals.length,
      dealKeys: crmEligibleDeals.map((deal) => deal.dealKey).sort(),
    },
    totals: {
      sourceRows: includedSourceRows,
      normalizedDeals: allDeals.length,
      collapsedDuplicates: Math.max(0, includedSourceRows - allDeals.length),
      recentDeals: recentDeals.length,
      reviewedDeals: candidateDeals.length,
      newDeals: scoredDeals.filter((deal) => deal.isNew).length,
      newMatches: newlySeenMatches.length,
      qualified: qualified.length,
      watchlist: watchlist.length,
      removalCandidates: removalCandidates.length,
      dismissed: scoredDeals.filter((deal) => deal.dismissed).length,
      cimReady: scoredDeals.filter((deal) => deal.cimRequest?.canRequest).length,
      crmEligible: crmEligibleDeals.length,
    },
    criteriaRecommendations: summarizeCriteria(scoredDeals),
    newlySeenMatches,
    qualified,
    watchlist,
    removalCandidates,
    identityExceptions: identityExceptions.map((item) => ({
      id: item.id,
      createdAt: item.created_at,
      observedDealKey: item.observed_deal_key,
      observedName: item.observed_name,
      observedRecipient: item.observed_recipient,
      candidateOpportunityIds: item.candidate_opportunity_ids || [],
      reason: item.reason,
      evidenceVersion: item.evidence_version,
      comparisons: item.metadata?.comparisons || [],
    })),
  };

  const latestDealOsImport = sourceResults.find((result) => result.source.id === dealOsSourceId)?.source?.latestImport || null;
  review.importSummary = buildDealHunterImportSummary(review, latestDealOsImport);

  return { review, scoredDeals, storage };
}

export async function reviewDailyDeals({
  markSeen = false,
  reviewMode = 'daily',
  // Opt in to receive the scored listings alongside the review so a caller that
  // needs both does not have to build the review a second time. Callers that
  // omit it keep the existing return shape.
  withScoredDeals = false,
  storage = getStorage(),
} = {}) {
  const result = await buildDailyDealReview({ reviewMode, storage });
  const automationStatus = await getCimAutomationStatus({ storage, config: getConfig() });
  const [requests, events] = await Promise.all([
    storage.listDealHunterCimRequests?.({ limit: 100000 }) || [],
    storage.listEmailEvents?.({ limit: 100000 }) || [],
  ]);
  const evaluated = evaluateCimAutomationCandidates({
    review: result.review,
    scoredDeals: result.scoredDeals,
    status: automationStatus,
    requests,
    events,
  });
  result.review.cimAutomation = {
    ...automationStatus,
    run: {
      mode: 'preview-only',
      ...evaluated,
      sent: 0,
      failed: 0,
      providerCalls: 0,
      results: [],
    },
  };

  if (markSeen) {
    await persistDealHunterHistory(result.storage, result.scoredDeals);
  }

  return withScoredDeals ? { review: result.review, scoredDeals: result.scoredDeals } : result.review;
}

/**
 * Canonical scored listings with their resolved opportunity identity.
 *
 * The daily review returns only its presentation shape; opportunity scoring
 * needs the scored listings themselves. This is a thin accessor over the same
 * review build rather than a second scoring path.
 */
export async function collectScoredOpportunities({ reviewMode = 'full-backfill', dealOsImportId = '', storage = getStorage() } = {}) {
  const result = await buildDailyDealReview({ reviewMode, dealOsImportId, storage });
  return { scoredDeals: result.scoredDeals, review: result.review };
}

function historyFilterValues(value, { format = 'preserve', aliases = {} } = {}) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : String(value || '').split(','))
      .map((item) => {
        const normalized = normalizeText(item, 80).toLowerCase();
        const formatted = format === 'underscore'
          ? normalized.replace(/-/g, '_')
          : format === 'hyphen'
            ? normalized.replace(/_/g, '-')
            : normalized;
        return aliases[formatted] || formatted;
      })
      .filter((item) => item && item !== 'all'),
  ));
}

export async function listDealHunterCimRequestHistory({
  page = 1,
  pageSize = 25,
  search = '',
  requestState = '',
  deliveryState = '',
  replyState = '',
  followUpState = '',
  sort = 'first_requested_at',
  direction = 'desc',
  storage = getStorage(),
} = {}) {
  if (!storage.listDealHunterCimRequestHistory) {
    return { rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1, counts: {} };
  }

  const normalizedReplyState = normalizeText(replyState, 40).toLowerCase();
  const parsedPage = Number(page);
  const parsedPageSize = Number(pageSize);
  const safePage = Number.isFinite(parsedPage)
    ? Math.max(1, Math.min(Math.trunc(parsedPage), 10_000))
    : 1;
  const requestedPageSize = Number.isFinite(parsedPageSize) ? Math.trunc(parsedPageSize) : 25;
  const sortKey = {
    first_requested_at: 'first-request',
    last_activity_at: 'last-activity',
    failure: 'failure',
  }[normalizeText(sort, 80).toLowerCase()] || 'first-request';
  const result = await storage.listDealHunterCimRequestHistory({
    page: safePage,
    pageSize: Math.max(1, Math.min(requestedPageSize || 25, 100)),
    search: normalizeText(search, 500),
    requestStates: historyFilterValues(requestState, { format: 'underscore' }),
    deliveryStates: historyFilterValues(deliveryState, {
      format: 'hyphen',
      aliases: { 'awaiting-delivery': 'accepted' },
    }),
    replyState: normalizedReplyState === 'unreplied' ? 'awaiting' : normalizedReplyState,
    followUpState: normalizeText(followUpState, 40).toLowerCase().replace(/_/g, '-'),
    sort: sortKey,
    direction: String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc',
  });
  const safePageSize = Math.max(1, Number(result.pageSize) || 25);
  const rows = await Promise.all((result.rows || []).map(async (request) => {
    const communicationResult = storage.listCrmCommunications
      ? await storage.listCrmCommunications({ cimRequestId: request.id, page: 1, pageSize: 100 })
      : { rows: [] };
    const communications = (communicationResult.rows || [])
      .filter((communication) => communication.direction === 'outbound')
      .sort((left, right) => Date.parse(left.occurred_at || '') - Date.parse(right.occurred_at || ''))
      .map((communication) => ({
        id: communication.id,
        direction: communication.direction,
        channel: communication.channel,
        kind: communication.kind,
        provider: communication.provider,
        from_address: communication.from_address,
        to_addresses: Array.isArray(communication.to_addresses) ? communication.to_addresses : [],
        cc_addresses: Array.isArray(communication.cc_addresses) ? communication.cc_addresses : [],
        bcc_addresses: Array.isArray(communication.bcc_addresses) ? communication.bcc_addresses : [],
        reply_to_address: communication.reply_to_address,
        subject: communication.subject,
        body_text: communication.body_text,
        occurred_at: communication.occurred_at,
        delivery_state: communication.delivery_state,
      }));
    return {
      ...request,
      communications,
      can_retry_corrected_recipient: request.status === 'delivery_issue'
        && ['bounced', 'failed', 'complained', 'suppressed'].includes(request.delivery_state),
    };
  }));
  return {
    ...result,
    rows,
    counts: { ready: 0, ...(result.counts || {}) },
    totalPages: Math.max(1, Math.ceil(Number(result.total || 0) / safePageSize)),
  };
}

export async function sendDailyDealHunterReview({
  idempotencyKey = '',
  storage = getStorage(),
  sendDigestEmail = sendDailyDealHunterEmail,
  sendSourceAlertEmail = sendDailyDealHunterSourceAlertEmail,
} = {}) {
  const result = await buildDailyDealReview({ reviewMode: 'daily', storage });
  const { review, scoredDeals } = result;
  const config = getConfig();

  if (reviewHasRequiredSourceFailures(review)) {
    if (storage.listEmailEvents) {
      try {
        const deliveryEvents = await storage.listEmailEvents({ source: 'daily-deal-hunter', limit: 50 });
        const latestNormalDelivery = (Array.isArray(deliveryEvents) ? deliveryEvents : [])
          .filter((event) => event?.event_type === 'sent'
            && event?.metadata?.tracking?.notificationType !== 'required-source-alert'
            && !/action required/i.test(String(event?.subject || '')))
          .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))[0];
        if (latestNormalDelivery) {
          review.latestSuccessfulDelivery = {
            createdAt: latestNormalDelivery.created_at || '',
            subject: latestNormalDelivery.subject || '',
          };
        }
      } catch (error) {
        console.warn(`[deal-hunter] prior daily delivery lookup failed: ${normalizeText(error.message, 300)}`);
      }
    }
    const emailResult = await sendSourceAlertEmail({
      to: config.dealHunter.recipient || config.delivery.fallbackRecipient,
      review,
      idempotencyKey,
    });
    return {
      review,
      emailResult,
      notificationType: 'required-source-alert',
      crmSync: dealHunterCrmSyncSummary({
        paused: true,
        reason: 'CRM sync is unavailable while the required Google Sheet source is unavailable.',
      }),
    };
  }

  const crmSync = dealHunterCrmSyncSummary({
    notRun: true,
    explicitActionRequired: true,
    reason: 'The internal daily summary does not write to CRM. Use the explicit high-fit CRM sync action after reviewing the scored listings.',
  });
  review.crmSync = crmSync;
  review.importSummary = buildDealHunterImportSummary(
    review,
    review.sources.find((source) => source.id === dealOsSourceId)?.latestImport || null,
    crmSync,
  );
  const automationStatus = await getCimAutomationStatus({ storage, config });
  const [existingRequests, emailEvents] = await Promise.all([
    storage.listDealHunterCimRequests?.({ limit: 100000 }) || [],
    storage.listEmailEvents?.({ limit: 100000 }) || [],
  ]);
  const evaluated = evaluateCimAutomationCandidates({
    review,
    scoredDeals,
    status: automationStatus,
    requests: existingRequests,
    events: emailEvents,
  });
  review.cimAutomation = {
    ...automationStatus,
    run: {
      mode: 'internal-summary-preview',
      ...evaluated,
      sent: 0,
      failed: 0,
      providerCalls: 0,
      results: [],
    },
    remainingDailyCapacity: automationStatus.capacity?.remaining ?? 0,
  };

  const emailResult = await sendDigestEmail({
    to: config.dealHunter.recipient || config.delivery.fallbackRecipient,
    review,
    idempotencyKey,
  });

  if (emailResult.status !== 'failed') {
    await persistDealHunterHistory(storage, scoredDeals);
  }

  return {
    review,
    emailResult,
    notificationType: 'normal-digest',
    crmSync,
  };
}

export const dealHunterCrmSyncConfirmation = 'SYNC HIGH FITS';

const dealHunterCrmReconciliationPlanTtlMs = 30 * 60 * 1000;

function dealOsImportRecordKeys(record = {}) {
  return new Set(uniqueStrings([
    record.stableId ? `id:${normalizeStableExternalIdentity(record.stableId)}` : '',
    record.listingUrl ? `url:${normalizeListingIdentity(record.listingUrl)}` : '',
  ]));
}

function dealOsSourceRecordKeys(deal = {}) {
  const keys = [];
  for (const source of deal.sourceRecords || []) {
    if (source.sourceId !== dealOsSourceId) continue;
    if (source.externalId) keys.push(`id:${normalizeStableExternalIdentity(source.externalId)}`);
    if (source.listingUrl) keys.push(`url:${normalizeListingIdentity(source.listingUrl)}`);
  }
  return new Set(uniqueStrings(keys));
}

// Observation bookkeeping, not listing facts: these move on their own between
// review runs, so comparing them would classify every already-synced record as
// an update and make `unchanged` unreachable. The write still refreshes them.
const reconciliationVolatileDealHunterFields = ['firstSeenAt', 'lastSeenAt', 'isNew', 'generatedNotes'];

function reconciliationComparableDealHunterMetadata(metadata = {}) {
  const comparable = { ...metadata };
  for (const field of reconciliationVolatileDealHunterFields) delete comparable[field];
  return comparable;
}

function reconciliationComparablePayload(payload = {}) {
  return {
    company: payload.company || '',
    listing_url: payload.listing_url || '',
    asking_price: payload.asking_price || '',
    ttm_revenue: payload.ttm_revenue || '',
    ttm_ebitda: payload.ttm_ebitda || '',
    ebitda_multiple: payload.ebitda_multiple || '',
    net_margin: payload.net_margin || '',
    business_age: payload.business_age || '',
    broker_name: payload.broker_name || '',
    broker_email: payload.broker_email || '',
    broker_phone: payload.broker_phone || '',
    role: payload.role || '',
    lead_type: payload.lead_type || '',
    status: payload.status || '',
    priority: payload.priority || '',
    follow_up_state: payload.follow_up_state || '',
    next_action_at: payload.next_action_at || null,
    tags: [...(payload.tags || [])].sort(),
    deal_hunter_opportunity_id: payload.deal_hunter_opportunity_id || '',
    dealHunter: reconciliationComparableDealHunterMetadata(payload.metadata?.dealHunter || {}),
  };
}

function reconciliationChangedFields(existing = {}, values = {}) {
  const before = reconciliationComparablePayload(existing);
  const after = reconciliationComparablePayload({ ...existing, ...values });
  return Object.keys(after).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

function reconciliationPlanDigest(importId, items = []) {
  return sha256(JSON.stringify({
    importId,
    scoringRuleVersion: dealHunterScoringRuleVersion,
    completenessPolicyVersion: dealHunterCompletenessPolicyVersion,
    items: items.map((item) => ({
      opportunityId: item.opportunityId,
      dealKey: item.dealKey,
      action: item.action,
      submissionId: item.submissionId,
      actionable: item.actionable,
      sourceRowNumbers: item.sourceRowNumbers,
      changedFields: item.changedFields,
      fitScore: item.fitScore,
      completenessScore: item.completenessScore,
      scoreStatus: item.scoreStatus,
    })).sort((left, right) => left.opportunityId.localeCompare(right.opportunityId) || left.dealKey.localeCompare(right.dealKey)),
  }));
}

function countReconciliationActions(items = []) {
  const counts = {
    total: items.length,
    create: 0,
    update: 0,
    unchanged: 0,
    tombstoned: 0,
    ambiguous: 0,
    actionable: 0,
    sourced: 0,
    conflicts: 0,
  };
  for (const item of items) {
    if (Object.hasOwn(counts, item.action)) counts[item.action] += 1;
    if (item.actionable) counts.actionable += 1;
    else counts.sourced += 1;
    counts.conflicts += Number(item.fieldConflictCount || 0);
  }
  counts.mutable = counts.create + counts.update;
  return counts;
}

export async function previewDealOsCrmReconciliation({
  importId = '',
  requestedBy = '',
  storage = getStorage(),
} = {}) {
  const normalizedImportId = normalizeText(importId, 200);
  if (!normalizedImportId) return { ok: false, status: 400, error: 'Select a Deal OS import to reconcile.' };
  if (!storage.getDealHunterDealOsImport) return { ok: false, status: 503, error: 'Exact Deal OS import lookup is unavailable.' };
  const importedRecord = await storage.getDealHunterDealOsImport(normalizedImportId);
  if (!importedRecord) return { ok: false, status: 404, error: 'The selected Deal OS import was not found.' };
  const ownershipHealth = storage.getDealHunterCanonicalCrmOwnershipHealth
    ? await storage.getDealHunterCanonicalCrmOwnershipHealth()
    : { healthy: false, collisions: [] };
  if (!ownershipHealth.healthy) {
    return {
      ok: false,
      status: 409,
      error: 'Canonical CRM ownership is not unique. Resolve the integrity-audit collisions before reconciliation.',
      ownershipHealth,
    };
  }

  const result = await buildDailyDealReview({ reviewMode: 'full-backfill', dealOsImportId: normalizedImportId, storage });
  if (reviewHasSourceFailures(result.review)) {
    return { ok: false, status: 503, error: 'Reconciliation preview is blocked while a configured source is unavailable.', review: result.review };
  }
  const integrityAudit = await auditDealHunterCrmIntegrity({ storage });
  if (!integrityAudit.safeToReconcile) {
    return {
      ok: false,
      status: 409,
      error: 'CRM integrity findings must be resolved before reconciliation can plan any writes.',
      integrityAudit,
    };
  }
  const imported = publicDealOsImport(importedRecord);
  const records = Array.isArray(importedRecord.records) ? importedRecord.records : [];
  const rowAccounting = imported.rowAccounting || [];
  const rowNumbersByCanonicalIndex = rowAccounting.reduce((map, row) => {
    if (!Number.isInteger(row.canonicalIndex)) return map;
    const rows = map.get(row.canonicalIndex) || [];
    rows.push(Number(row.rowNumber));
    map.set(row.canonicalIndex, rows);
    return map;
  }, new Map());
  // Index the import records once instead of rebuilding their identity keys for
  // every scored deal, which is quadratic on a large export.
  const canonicalIndicesByImportKey = new Map();
  records.forEach((record, index) => {
    for (const key of dealOsImportRecordKeys(record)) {
      const indices = canonicalIndicesByImportKey.get(key) || new Set();
      indices.add(index);
      canonicalIndicesByImportKey.set(key, indices);
    }
  });
  const rowsByDeal = new Map();
  for (const deal of result.scoredDeals) {
    const sourceKeys = dealOsSourceRecordKeys(deal);
    if (sourceKeys.size === 0) continue;
    const indices = new Set();
    for (const key of sourceKeys) {
      for (const index of canonicalIndicesByImportKey.get(key) || []) indices.add(index);
    }
    if (indices.size === 0) continue;
    const rowNumbers = new Set();
    for (const index of indices) {
      for (const rowNumber of rowNumbersByCanonicalIndex.get(index) || []) rowNumbers.add(Number(rowNumber));
    }
    rowsByDeal.set(deal, [...rowNumbers].sort((left, right) => left - right));
  }

  const items = [];
  for (const [deal, sourceRowNumbers] of rowsByDeal.entries()) {
    const actionable = deal.actionEligibility?.highFit === true;
    let action = 'create';
    let submissionId = '';
    let changedFields = [];
    if (!deal.opportunityId || deal.identityStatus !== 'resolved') {
      action = 'ambiguous';
    } else {
      const [importRecord, existing] = await Promise.all([
        storage.getDealHunterCrmImport?.({ opportunityId: deal.opportunityId }) || null,
        findExistingDealHunterSubmission(storage, deal),
      ]);
      submissionId = existing?.id || importRecord?.submission_id || '';
      if (!existing && importRecord?.status === 'crm-deleted') {
        action = 'tombstoned';
      } else if (existing) {
        const declaredOpportunityId = existing.deal_hunter_opportunity_id
          || existing.metadata?.dealHunter?.opportunityId
          || '';
        if (declaredOpportunityId && declaredOpportunityId !== deal.opportunityId) {
          action = 'ambiguous';
          changedFields = ['deal_hunter_opportunity_id'];
        } else {
          const preserveExistingFields = !isDealHunterManagedSubmission(existing);
          const values = dealHunterCrmUpdate(existing, deal, { preserveExistingFields, actionable });
          changedFields = reconciliationChangedFields(existing, values);
          action = changedFields.length > 0 ? 'update' : 'unchanged';
        }
      }
    }
    items.push({
      opportunityId: deal.opportunityId || `unresolved:${deal.dealKey}`,
      dealKey: deal.dealKey || '',
      name: deal.name || '',
      action,
      submissionId,
      actionable,
      fitScore: deal.fitScore ?? deal.score,
      completenessScore: deal.completenessScore ?? 0,
      evidenceConfidence: deal.evidenceConfidence || 'low',
      scoreStatus: deal.scoreStatus || 'provisional',
      scoringRuleVersion: deal.scoringRuleVersion || dealHunterScoringRuleVersion,
      missingEvidence: deal.missingEvidence || [],
      fieldConflictCount: deal.fieldConflicts?.length || 0,
      changedFields,
      sourceRowNumbers,
    });
  }
  items.sort((left, right) => left.opportunityId.localeCompare(right.opportunityId));
  const mappedSourceRows = new Set(items.flatMap((item) => item.sourceRowNumbers));
  const unmappedSourceRows = rowAccounting
    .filter((row) => row.status === 'accepted' && !mappedSourceRows.has(Number(row.rowNumber)))
    .map((row) => Number(row.rowNumber));
  const counts = countReconciliationActions(items);
  const planDigest = reconciliationPlanDigest(normalizedImportId, items);
  const generatedAt = new Date().toISOString();
  // Carried so execution applies exactly the canonical listings this plan was
  // digested from, instead of rebuilding the same full review a second time.
  const dealsByOpportunity = new Map(result.scoredDeals
    .filter((deal) => deal.opportunityId)
    .map((deal) => [deal.opportunityId, deal]));
  return {
    ok: true,
    status: 200,
    preview: true,
    import: imported,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + dealHunterCrmReconciliationPlanTtlMs).toISOString(),
    requestedBy: normalizeText(requestedBy || 'admin', 160),
    integrityAudit,
    planDigest,
    confirmationRequired: `RECONCILE ${counts.mutable} CANONICAL`,
    expectedOpportunityIds: items.map((item) => item.opportunityId).sort(),
    counts: {
      sourceRows: imported.sourceRowCount,
      acceptedRows: imported.acceptedRowCount,
      rejectedRows: imported.rejectedRowCount,
      withinFileDuplicates: imported.duplicateCount,
      canonicalImportRecords: imported.canonicalRecordCount,
      canonicalMatched: items.length,
      mappedSourceRows: mappedSourceRows.size,
      unmappedSourceRows: unmappedSourceRows.length,
      ...counts,
    },
    // The plan is returned whole: counts, the digest, and the confirmation
    // string are derived from every item, so truncating here would execute a
    // different set than the operator confirmed. Transport bounds the response.
    items,
    dealsByOpportunity,
    unmappedSourceRowNumbers: unmappedSourceRows.slice(0, 100),
  };
}

async function applyDealOsCrmReconciliationItem({ deal, item, storage, requestedBy }) {
  const pendingCutoff = new Date(Date.now() - dealHunterCrmImportPendingStaleMinutes * 60 * 1000).toISOString();
  const proposedImport = buildDealHunterCrmImportRecord(deal);
  const claim = await storage.claimDealHunterCrmImport(proposedImport, { pendingCutoff });
  if (!claim?.importRecord) throw new Error('The durable CRM ownership claim returned no record.');
  const importRecord = claim.importRecord;
  if (!claim.claimed && importRecord.status === 'crm-deleted') return { status: 'tombstoned', submissionId: '' };
  let existing = importRecord.submission_id && storage.getSubmission
    ? await storage.getSubmission(importRecord.submission_id)
    : null;
  existing ||= await findExistingDealHunterSubmission(storage, deal);
  if (existing) {
    const preserveExistingFields = !isDealHunterManagedSubmission(existing);
    const updated = await updateDealHunterCrmSubmission(storage, existing, deal, {
      preserveExistingFields,
      actionable: item.actionable,
      actor: requestedBy,
      summary: item.actionable
        ? 'Deal OS reconciliation refreshed an actionable Deal Hunter CRM record.'
        : 'Deal OS reconciliation refreshed a sourced Deal Hunter CRM record.',
      activityMetadata: { reconciliation: true, planAction: item.action },
    });
    await updateDealHunterCrmImport(storage, importRecord, {
      opportunity_id: deal.opportunityId,
      submission_id: updated?.id || existing.id,
      status: preserveExistingFields ? 'enriched' : 'updated',
    });
    await linkDealHunterOpportunitySubmission(storage, deal, updated?.id || existing.id);
    return { status: preserveExistingFields ? 'enriched' : 'updated', submissionId: updated?.id || existing.id };
  }
  if (!claim.claimed) throw new Error('CRM ownership is already claimed without a linked submission. Retry after the pending claim expires.');
  const created = await createManualSubmission(
    dealHunterCrmPayload(deal, { actionable: item.actionable }),
    requestedBy,
    { storage },
  );
  if (!created.ok || !created.submission?.id) throw new Error((created.errors || []).join(' ') || 'CRM record creation failed.');
  await updateDealHunterCrmImport(storage, importRecord, {
    opportunity_id: deal.opportunityId,
    submission_id: created.submission.id,
    status: 'created',
  });
  await linkDealHunterOpportunitySubmission(storage, deal, created.submission.id);
  return { status: 'created', submissionId: created.submission.id };
}

export async function executeDealOsCrmReconciliation({
  importId = '',
  planDigest = '',
  previewGeneratedAt = '',
  expectedOpportunityIds = [],
  confirmation = '',
  requestedBy = '',
  storage = getStorage(),
} = {}) {
  const requestedImportId = normalizeText(importId, 200);
  const requestedPlanDigest = normalizeText(planDigest, 200);
  if (requestedImportId && requestedPlanDigest && storage.getDealHunterCrmReconciliationRun) {
    const previousRun = await storage.getDealHunterCrmReconciliationRun({
      idempotencyKey: `deal-os-crm-reconciliation:${requestedImportId}:${requestedPlanDigest}`,
    });
    // Only a fully successful run is terminal. A run that ended with failures
    // is resumed below so its failed items can be retried, which is exactly
    // what its last_error tells the operator to do.
    if (previousRun && previousRun.status === 'completed') {
      return { ok: true, status: 200, idempotent: true, run: previousRun };
    }
  }
  const previewGeneratedAtMs = Date.parse(previewGeneratedAt);
  const previewAgeMs = Date.now() - previewGeneratedAtMs;
  if (!Number.isFinite(previewGeneratedAtMs)
    || previewAgeMs < -60 * 1000
    || previewAgeMs > dealHunterCrmReconciliationPlanTtlMs) {
    return {
      ok: false,
      status: 409,
      error: 'The reconciliation preview is missing or expired. Build a fresh preview before executing.',
    };
  }
  const previewResult = await previewDealOsCrmReconciliation({ importId, requestedBy, storage });
  if (!previewResult.ok) return previewResult;
  if (previewResult.counts.unmappedSourceRows > 0) {
    return {
      ok: false,
      status: 409,
      error: 'One or more accepted CSV rows could not be mapped to a canonical opportunity. Resolve those rows before CRM execution.',
      preview: previewResult,
    };
  }
  if (previewResult.counts.ambiguous > 0) {
    return {
      ok: false,
      status: 409,
      error: 'One or more imported listings have ambiguous canonical identities. Resolve them before CRM execution.',
      preview: previewResult,
    };
  }
  const expectedIds = uniqueStrings(expectedOpportunityIds).sort();
  if (normalizeText(planDigest, 200) !== previewResult.planDigest
    || JSON.stringify(expectedIds) !== JSON.stringify(previewResult.expectedOpportunityIds)) {
    return { ok: false, status: 409, error: 'The reconciliation plan changed. Refresh the preview before executing.', preview: previewResult };
  }
  if (normalizeText(confirmation, 120) !== previewResult.confirmationRequired) {
    return { ok: false, status: 400, error: `Type ${previewResult.confirmationRequired} to execute this exact canonical set.`, preview: previewResult };
  }
  const requiredMethods = [
    'claimDealHunterCrmImport', 'startDealHunterCrmReconciliationRun',
    'listDealHunterCrmReconciliationItems',
    'updateDealHunterCrmReconciliationItem', 'updateDealHunterCrmReconciliationRun',
  ];
  if (requiredMethods.some((method) => typeof storage[method] !== 'function')) {
    return { ok: false, status: 503, error: 'Durable CRM reconciliation storage is unavailable.' };
  }
  const idempotencyKey = `deal-os-crm-reconciliation:${previewResult.import.id}:${previewResult.planDigest}`;
  const now = new Date().toISOString();
  const runId = sha256(idempotencyKey);
  const durableItems = previewResult.items.map((item) => ({
    id: sha256(`${runId}:${item.opportunityId}`),
    run_id: runId,
    opportunity_id: item.opportunityId,
    deal_key: item.dealKey,
    action: item.action,
    status: ['create', 'update'].includes(item.action) ? 'pending' : item.action,
    submission_id: item.submissionId || null,
    source_row_numbers: item.sourceRowNumbers,
    planned_changes: { changedFields: item.changedFields, actionable: item.actionable },
    error: null,
    created_at: now,
    updated_at: now,
    metadata: { fitScore: item.fitScore, completenessScore: item.completenessScore, scoreStatus: item.scoreStatus },
  }));
  let run = await storage.startDealHunterCrmReconciliationRun({
    id: runId,
    created_at: now,
    updated_at: now,
    completed_at: null,
    import_id: previewResult.import.id,
    mode: 'exact-import',
    plan_digest: previewResult.planDigest,
    idempotency_key: idempotencyKey,
    status: 'running',
    requested_by: normalizeText(requestedBy || 'admin', 160),
    counts: previewResult.counts,
    plan: { confirmationRequired: previewResult.confirmationRequired, expectedOpportunityIds: previewResult.expectedOpportunityIds },
    results: {},
    last_error: null,
    metadata: { scoringRuleVersion: dealHunterScoringRuleVersion, completenessPolicyVersion: dealHunterCompletenessPolicyVersion },
  }, durableItems);
  if (run.status === 'completed') {
    return { ok: true, status: 200, idempotent: true, run, preview: previewResult };
  }
  if (run.status === 'completed-with-errors') {
    run = await storage.updateDealHunterCrmReconciliationRun(runId, {
      updated_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      last_error: null,
    }) || run;
  }

  const dealsByOpportunity = previewResult.dealsByOpportunity instanceof Map
    ? previewResult.dealsByOpportunity
    : new Map();
  const plannedItemsByOpportunity = new Map(previewResult.items.map((item) => [item.opportunityId, item]));
  const resultCounts = { created: 0, updated: 0, enriched: 0, tombstoned: 0, unchanged: 0, ambiguous: 0, failed: 0 };
  const results = [];
  const storedItems = await storage.listDealHunterCrmReconciliationItems(runId, { limit: 100000 });
  for (const storedItem of storedItems) {
    // `failed` is retryable: applying an item is idempotent through the durable
    // ownership claim, so a resumed run re-attempts only what did not land.
    if (!['pending', 'failed'].includes(storedItem.status)) {
      if (Object.hasOwn(resultCounts, storedItem.status)) resultCounts[storedItem.status] += 1;
      continue;
    }
    const item = plannedItemsByOpportunity.get(storedItem.opportunity_id);
    const deal = dealsByOpportunity.get(storedItem.opportunity_id);
    try {
      if (!deal || !item) throw new Error('The canonical listing disappeared after preview.');
      const applied = await applyDealOsCrmReconciliationItem({ deal, item, storage, requestedBy: run.requested_by || 'admin' });
      resultCounts[applied.status] = Number(resultCounts[applied.status] || 0) + 1;
      results.push({ opportunityId: storedItem.opportunity_id, ...applied });
      await storage.updateDealHunterCrmReconciliationItem(storedItem.id, {
        status: applied.status,
        submission_id: applied.submissionId || null,
        error: null,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      resultCounts.failed += 1;
      results.push({ opportunityId: storedItem.opportunity_id, status: 'failed', error: normalizeText(error.message, 500) });
      await storage.updateDealHunterCrmReconciliationItem(storedItem.id, {
        status: 'failed',
        error: normalizeText(error.message, 1000),
        updated_at: new Date().toISOString(),
      });
    }
  }
  const completedAt = new Date().toISOString();
  run = await storage.updateDealHunterCrmReconciliationRun(runId, {
    updated_at: completedAt,
    completed_at: completedAt,
    status: resultCounts.failed > 0 ? 'completed-with-errors' : 'completed',
    counts: { ...previewResult.counts, results: resultCounts },
    results: { items: results.slice(0, 1000) },
    last_error: resultCounts.failed > 0 ? `${resultCounts.failed} item(s) failed; inspect durable item errors before retrying.` : null,
  });
  return { ok: resultCounts.failed === 0, status: resultCounts.failed > 0 ? 207 : 200, run, resultCounts, preview: previewResult };
}

async function listAllSubmissionsForDealHunterAudit(storage) {
  if (typeof storage.listSubmissions !== 'function') return [];
  const limit = 5000;
  const submissions = [];
  for (let page = 1; ; page += 1) {
    const result = await storage.listSubmissions({ limit, page, status: 'all' });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    submissions.push(...rows);
    const total = Number(result?.total || submissions.length);
    if (rows.length === 0 || submissions.length >= total) break;
  }
  return submissions;
}

// The audit only reasons about records that carry a Deal Hunter link or that an
// import or opportunity claims, so it reads exactly that set rather than the
// whole CRM. Anything an import or opportunity points at is fetched by id even
// when the record itself carries no link, which is precisely the broken state
// the tombstone and missing-link checks exist to catch. Providers without the
// narrow lookups fall back to the exhaustive read, so coverage never shrinks.
async function listDealHunterAuditSubmissions(storage, { imports = [], opportunities = [] } = {}) {
  if (typeof storage.listDealHunterLinkedSubmissions !== 'function'
    || typeof storage.listSubmissionsByIds !== 'function') {
    return listAllSubmissionsForDealHunterAudit(storage);
  }

  const submissionsById = new Map();
  for (const submission of await storage.listDealHunterLinkedSubmissions({ limit: 100000 })) {
    submissionsById.set(submission.id, submission);
  }
  const claimedIds = uniqueStrings([
    ...imports.map((record) => record.submission_id),
    ...opportunities.map((record) => record.primary_submission_id),
  ]).filter((id) => !submissionsById.has(id));
  for (const submission of await storage.listSubmissionsByIds(claimedIds, { limit: 100000 })) {
    submissionsById.set(submission.id, submission);
  }
  return [...submissionsById.values()];
}

export async function auditDealHunterCrmIntegrity({ storage = getStorage() } = {}) {
  const [imports, opportunities, ownershipHealth] = await Promise.all([
    storage.listDealHunterCrmImports?.({ limit: 100000 }) || [],
    storage.listDealHunterOpportunities?.({ limit: 100000 }) || [],
    storage.getDealHunterCanonicalCrmOwnershipHealth?.() || { healthy: false, collisions: [] },
  ]);
  const submissions = await listDealHunterAuditSubmissions(storage, { imports, opportunities });
  const claimsByOpportunity = new Map();
  const addClaim = (opportunityId, kind, id) => {
    if (!opportunityId) return;
    const claims = claimsByOpportunity.get(opportunityId) || [];
    claims.push({ kind, id });
    claimsByOpportunity.set(opportunityId, claims);
  };
  imports.forEach((record) => addClaim(record.opportunity_id, 'import', record.id));
  submissions.forEach((record) => addClaim(record.deal_hunter_opportunity_id || record.metadata?.dealHunter?.opportunityId, 'submission', record.id));
  opportunities.forEach((record) => addClaim(record.opportunity_id, 'primary', record.primary_submission_id));
  const duplicatePrimaries = [];
  const identityMismatches = [];
  const nameMismatches = [];
  const tombstoneActive = [];
  for (const [opportunityId, claims] of claimsByOpportunity.entries()) {
    const submissionIds = uniqueStrings(claims.filter((claim) => claim.kind !== 'import').map((claim) => claim.id)).sort();
    if (submissionIds.length > 1) duplicatePrimaries.push({ opportunityId, submissionIds });
  }
  const importsBySubmissionId = new Map(imports
    .filter((record) => record.submission_id)
    .map((record) => [record.submission_id, record]));
  const submissionsById = new Map(submissions.map((record) => [record.id, record]));
  for (const submission of submissions) {
    const metadata = submission.metadata?.dealHunter || {};
    const directOpportunityId = submission.deal_hunter_opportunity_id || '';
    const metadataOpportunityId = metadata.opportunityId || '';
    if (directOpportunityId && metadataOpportunityId && directOpportunityId !== metadataOpportunityId) {
      identityMismatches.push({
        submissionId: submission.id,
        directOpportunityId,
        metadataOpportunityId,
      });
    }
    const sourceName = metadata.raw?.['Business Name'] || metadata.raw?.Name || metadata.raw?.Listing || metadata.name || '';
    if (metadata.managed && sourceName && normalizeComparableText(submission.company) !== normalizeComparableText(sourceName)) {
      nameMismatches.push({ submissionId: submission.id, opportunityId: submission.deal_hunter_opportunity_id || metadata.opportunityId || '', company: submission.company || '' });
    }
    const linkedImport = importsBySubmissionId.get(submission.id);
    if (linkedImport?.status === 'crm-deleted' && submission.status !== 'archived') {
      tombstoneActive.push({ submissionId: submission.id, importId: linkedImport.id, opportunityId: linkedImport.opportunity_id || '' });
    }
  }
  const missingLinks = opportunities.filter((opportunity) => {
    if (!opportunity.primary_submission_id) return false;
    const submission = submissionsById.get(opportunity.primary_submission_id);
    const declaredOpportunityId = submission?.deal_hunter_opportunity_id
      || submission?.metadata?.dealHunter?.opportunityId
      || '';
    return !submission || declaredOpportunityId !== opportunity.opportunity_id;
  }).map((opportunity) => ({ opportunityId: opportunity.opportunity_id, submissionId: opportunity.primary_submission_id }));
  // Findings are ordered by their own identifiers rather than by however storage
  // happened to return the rows, so two audits over the same data produce byte
  // identical reports and can be diffed across runs.
  const orderFindings = (findings, ...keys) => findings.sort((left, right) => {
    for (const key of keys) {
      const comparison = String(left[key] || '').localeCompare(String(right[key] || ''));
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
  orderFindings(duplicatePrimaries, 'opportunityId');
  orderFindings(identityMismatches, 'submissionId');
  orderFindings(nameMismatches, 'submissionId');
  orderFindings(tombstoneActive, 'submissionId');
  orderFindings(missingLinks, 'opportunityId', 'submissionId');
  const safeToReconcile = ownershipHealth.healthy
    && duplicatePrimaries.length === 0
    && identityMismatches.length === 0
    && tombstoneActive.length === 0
    && missingLinks.length === 0;
  return {
    ok: safeToReconcile && nameMismatches.length === 0,
    safeToReconcile,
    generatedAt: new Date().toISOString(),
    counts: {
      imports: imports.length,
      opportunities: opportunities.length,
      // Deal Hunter-linked and claimed records examined, not the CRM total.
      auditedSubmissions: submissions.length,
      ownershipCollisions: ownershipHealth.collisions?.length || 0,
      duplicatePrimaries: duplicatePrimaries.length,
      identityMismatches: identityMismatches.length,
      nameMismatches: nameMismatches.length,
      tombstoneActive: tombstoneActive.length,
      missingLinks: missingLinks.length,
    },
    ownershipHealth,
    findings: { duplicatePrimaries, identityMismatches, nameMismatches, tombstoneActive, missingLinks },
  };
}

export async function syncDealHunterHighFitsToCrm({
  confirmation = '',
  expectedDealKeys = [],
  requestedBy = '',
  reviewMode = 'daily',
  storage = getStorage(),
} = {}) {
  if (normalizeText(confirmation, 80) !== dealHunterCrmSyncConfirmation) {
    return {
      ok: false,
      status: 400,
      error: `Type ${dealHunterCrmSyncConfirmation} to confirm the explicit CRM write.`,
    };
  }

  const normalizedExpectedDealKeys = uniqueStrings(
    Array.isArray(expectedDealKeys) ? expectedDealKeys.map((key) => normalizeText(key, 1000)) : [],
  ).sort();
  if (normalizedExpectedDealKeys.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'Refresh the Deal Hunter review and select its current high-fit set before syncing CRM.',
    };
  }

  if (typeof storage.claimDealHunterCrmImport !== 'function') {
    return {
      ok: false,
      status: 503,
      error: 'Durable CRM import claims are unavailable, so no CRM write was attempted.',
    };
  }

  const result = await buildDailyDealReview({ reviewMode, storage });
  const { review, scoredDeals } = result;

  if (reviewHasRequiredSourceFailures(review)) {
    const crmSync = dealHunterCrmSyncSummary({
      paused: true,
      reason: 'CRM sync was not run because a required Google Sheet is unavailable.',
    });
    review.crmSync = crmSync;
    review.importSummary = buildDealHunterImportSummary(
      review,
      review.sources.find((source) => source.id === dealOsSourceId)?.latestImport || null,
      crmSync,
    );
    return {
      ok: false,
      status: 503,
      error: crmSync.reason,
      requestedBy: normalizeText(requestedBy || 'admin', 160),
      review,
      crmSync,
      summary: review.importSummary,
    };
  }

  const currentDealKeys = uniqueStrings(dealHunterCrmCandidates(scoredDeals).map((deal) => deal.dealKey)).sort();
  if (
    currentDealKeys.length !== normalizedExpectedDealKeys.length
    || currentDealKeys.some((dealKey, index) => dealKey !== normalizedExpectedDealKeys[index])
  ) {
    const crmSync = dealHunterCrmSyncSummary({
      paused: true,
      reason: 'The current high-fit set changed after it was reviewed. Refresh the review and confirm the updated set before syncing CRM.',
    });
    review.crmSync = crmSync;
    review.importSummary = buildDealHunterImportSummary(
      review,
      review.sources.find((source) => source.id === dealOsSourceId)?.latestImport || null,
      crmSync,
    );
    return {
      ok: false,
      status: 409,
      error: crmSync.reason,
      review,
      crmSync,
      summary: review.importSummary,
    };
  }

  const crmSync = dealHunterCrmSyncSummary(await performHighFitDealsCrmSync(scoredDeals, storage));
  review.crmSync = crmSync;
  review.importSummary = buildDealHunterImportSummary(
    review,
    review.sources.find((source) => source.id === dealOsSourceId)?.latestImport || null,
    crmSync,
  );

  const successfulWrites = crmSync.created + crmSync.enriched + crmSync.updated;
  const syncFailed = crmSync.failed > 0;
  return {
    ok: !syncFailed,
    status: !syncFailed ? 200 : successfulWrites > 0 ? 207 : 503,
    ...(syncFailed ? { error: `CRM sync failed for ${crmSync.failed} of ${crmSync.reviewed} reviewed high-fit listing${crmSync.reviewed === 1 ? '' : 's'}. No failed listing was written without a durable idempotency claim.` } : {}),
    requestedBy: normalizeText(requestedBy || 'admin', 160),
    reviewMode: review.reviewMode,
    review,
    crmSync,
    summary: review.importSummary,
  };
}

function stage2RunSummary(run = null) {
  if (!run) return null;
  return {
    id: run.id,
    runKey: run.run_key,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    pacificBusinessDate: run.pacific_business_date,
    mode: run.mode,
    status: run.status,
    policyHash: run.policy_hash,
    considered: Number(run.considered_count || 0),
    eligible: Number(run.eligible_count || 0),
    wouldSend: Number(run.would_send_count || 0),
    attempted: Number(run.attempted_count || 0),
    accepted: Number(run.accepted_count || 0),
    failed: Number(run.failed_count || 0),
    ambiguous: Number(run.ambiguous_count || 0),
    deferred: Number(run.deferred_count || 0),
    blockedCounts: run.blocked_counts || {},
    lastError: run.last_error || '',
  };
}

function countStage2Blockers(exceptions = []) {
  const counts = {};
  for (const exception of exceptions) {
    for (const code of exception.reasonCodes || []) counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

export function cimStage2DailyLimit(mode, policy) {
  return mode === 'active'
    ? policy.caps.activeDailyInitials
    : policy.caps.canaryDailyInitials;
}

export async function runCimStage2Automation({
  mode = 'shadow', triggeredBy = 'admin', now = new Date(), storage = getStorage(),
} = {}) {
  const normalizedMode = normalizeText(mode, 20).toLowerCase();
  if (!['shadow', 'canary', 'active'].includes(normalizedMode)) {
    return { ok: false, status: 400, error: 'Stage 2 run mode must be shadow, canary, or active.' };
  }
  const config = getConfig();
  const policy = getCimStage2Policy(config);
  const window = evaluateCimStage2Window(now, policy);
  if (!storage.claimCimStage2Run || !storage.insertCimStage2Decisions || !storage.updateCimStage2Run) {
    return { ok: false, status: 503, error: 'Required Stage 2 run/decision storage is unavailable.' };
  }
  if (['canary', 'active'].includes(normalizedMode)) {
    try {
      await reconcileCimStage2AmbiguousDecisions({ storage, now });
    } catch {
      return {
        ok: false,
        status: 503,
        error: 'Ambiguous provider-state reconciliation is unavailable. No automatic provider work was attempted.',
        providerCalls: 0,
      };
    }
  }
  const runKey = `deal-hunter-cim-stage2:${window.dateKey}:${normalizedMode}:${policy.policyHash}`;
  const runId = randomUUID();
  const statusBeforeRun = await getCimAutomationStatus({ storage, config, now });
  const activationId = ['canary', 'active'].includes(normalizedMode) ? statusBeforeRun.activation?.id || '' : '';
  const claim = await storage.claimCimStage2Run({
    id: runId,
    run_key: runKey,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    pacific_business_date: window.dateKey,
    mode: normalizedMode,
    status: 'running',
    triggered_by: normalizeText(triggeredBy, 200) || 'admin',
    policy_hash: policy.policyHash,
    rule_version: policy.rules.version,
    source_policy_hash: policy.sourcePolicyHash,
    activation_id: activationId || null,
    metadata: { windowOpenAtStart: window.open, providerCalls: 0 },
  });
  if (!claim.claimed) {
    return {
      ok: true,
      status: 200,
      duplicateInvocation: true,
      providerCalls: 0,
      run: stage2RunSummary(claim.run),
    };
  }
  let run = claim.run;
  try {
    const result = await buildDailyDealReview({ storage });
    const { review, scoredDeals } = result;
    const [requests, events] = await Promise.all([
      storage.listDealHunterCimRequests?.({ limit: 100000 }) || [],
      storage.listEmailEvents?.({ limit: 100000 }) || [],
    ]);
    const consideredDeals = scoredDeals
      .filter((deal) => deal.cimRequest?.eligible && deal.opportunityId)
      .slice(0, 500);
    const [suppressions, opportunityClaims] = await Promise.all([
      Promise.all(consideredDeals.map((deal) => storage.getActiveEmailSuppression?.(deal.brokerEmail) || null)),
      Promise.all(consideredDeals.map((deal) => storage.getDealHunterCimOpportunityClaim?.(deal.opportunityId) || null)),
    ]);
    const evaluated = evaluateCimAutomationCandidates({
      review,
      scoredDeals: consideredDeals,
      status: statusBeforeRun,
      requests,
      events,
      suppressions: suppressions.filter(Boolean),
      opportunityClaims: opportunityClaims.filter(Boolean),
      now,
    });
    const exceptionByOpportunity = new Map(evaluated.exceptions.map((item) => [item.opportunityId, item]));
    const decisions = consideredDeals.map((deal) => buildCimStage2DecisionRecord({
      run,
      deal,
      evaluation: exceptionByOpportunity.get(deal.opportunityId) || { reasonCodes: [] },
      activationId,
      policy,
      createdAt: now.toISOString(),
    }));
    await storage.insertCimStage2Decisions(decisions);
    // Shadow is the canary rehearsal: its would-send count must model the
    // accepted one-per-Pacific-business-day canary, never the larger active cap.
    const dailyLimit = cimStage2DailyLimit(normalizedMode, policy);
    const wouldSend = Math.min(evaluated.eligible.length, dailyLimit);
    const blockedCounts = countStage2Blockers(evaluated.exceptions);
    const sourcePolicyHealthy = Boolean(evaluated.sourceReview?.healthy);
    const coverageComplete = Boolean(evaluated.sourceReview
      && evaluated.sourceReview.missingCount === 0
      && evaluated.sourceReview.unexpectedCount === 0
      && evaluated.sourceReview.failedCount === 0
      && evaluated.sourceReview.emptyCount === 0
      && evaluated.sourceReview.duplicateSourceCount === 0
      && evaluated.sourceReview.warningCount === 0);
    run = await storage.updateCimStage2Run(run.id, {
      updated_at: new Date().toISOString(),
      considered_count: decisions.length,
      eligible_count: evaluated.eligible.length,
      would_send_count: wouldSend,
      blocked_counts: blockedCounts,
      metadata: {
        ...(run.metadata || {}),
        sourcePolicyHealthy,
        coverageComplete,
        sourceReview: {
          configuredIds: evaluated.sourceReview?.configuredIds || [],
          unexpectedCount: evaluated.sourceReview?.unexpectedCount || 0,
          missingCount: evaluated.sourceReview?.missingCount || 0,
          failedCount: evaluated.sourceReview?.failedCount || 0,
          emptyCount: evaluated.sourceReview?.emptyCount || 0,
          duplicateSourceCount: evaluated.sourceReview?.duplicateSourceCount || 0,
          warningCount: evaluated.sourceReview?.warningCount || 0,
        },
        readinessBlockerCodes: statusBeforeRun.blockerCodes,
        providerCalls: 0,
      },
    });

    if (normalizedMode === 'shadow') {
      run = await storage.updateCimStage2Run(run.id, {
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        status: sourcePolicyHealthy && coverageComplete ? 'completed' : 'blocked',
        metadata: { ...(run.metadata || {}), providerCalls: 0, shadowOnly: true },
      });
      return {
        ok: true,
        status: 200,
        providerCalls: 0,
        run: stage2RunSummary(run),
        sourceReview: evaluated.sourceReview,
      };
    }

    if (statusBeforeRun.activationMode !== normalizedMode || !statusBeforeRun.automaticTransmissionAllowed) {
      run = await storage.updateCimStage2Run(run.id, {
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        status: 'blocked',
        deferred_count: evaluated.eligible.length,
        last_error: 'Live Stage 2 authorization/readiness gates did not pass. No provider work was attempted.',
        metadata: { ...(run.metadata || {}), providerCalls: 0 },
      });
      return {
        ok: false,
        status: 409,
        error: run.last_error,
        blockerCodes: statusBeforeRun.blockerCodes,
        providerCalls: 0,
        run: stage2RunSummary(run),
      };
    }

    const storedDecisions = await storage.listCimStage2Decisions({ runId: run.id, limit: 500 });
    const decisionByOpportunity = new Map(storedDecisions.map((decision) => [decision.opportunity_id, decision]));
    let attempted = 0;
    let accepted = 0;
    let failed = 0;
    let ambiguous = 0;
    let deferred = 0;
    let providerCalls = 0;
    const liveCandidates = evaluated.eligible.slice(0, dailyLimit);

    for (const deal of liveCandidates) {
      const decision = decisionByOpportunity.get(deal.opportunityId);
      const capacityUsed = await storage.countCimStage2Capacity({ pacificBusinessDate: window.dateKey });
      if (!decision || capacityUsed >= dailyLimit) {
        deferred += 1;
        if (decision) await storage.transitionCimStage2Decision({
          id: decision.id,
          expectedStates: ['eligible'],
          state: 'deferred',
          updates: { reasons: ['daily_capacity_exhausted'], consumed_at: new Date().toISOString() },
        });
        continue;
      }
      const claimToken = randomUUID();
      const claimedAt = new Date().toISOString();
      const decisionClaim = await storage.claimCimStage2Decision({
        id: decision.id,
        claimToken,
        claimedAt,
        activationId,
      });
      if (!decisionClaim.claimed) {
        deferred += 1;
        continue;
      }
      const attempting = await storage.transitionCimStage2Decision({
        id: decision.id,
        expectedStates: ['claimed'],
        state: 'attempting',
        updates: { updated_at: new Date().toISOString() },
      });
      if (!attempting.applied) {
        deferred += 1;
        continue;
      }
      const approval = buildCimAutomationApproval(deal);
      if (!approval) {
        failed += 1;
        await storage.transitionCimStage2Decision({
          id: decision.id,
          expectedStates: ['attempting'],
          state: 'failed',
          updates: { consumed_at: new Date().toISOString(), last_error: 'Signed snapshot preparation failed.' },
        });
        continue;
      }
      attempted += 1;
      try {
        const boundary = await authorizeCimStage2SendBoundary({
          decisionId: decision.id,
          runId: run.id,
          activationId,
          claimToken,
          deal,
          snapshotDigest: cimStage2SnapshotDigest(deal),
          storage,
          config,
          now: new Date(),
        });
        if (!boundary.ok) {
          failed += 1;
          await storage.transitionCimStage2Decision({
            id: decision.id,
            expectedStates: ['attempting'],
            state: 'failed',
            updates: { consumed_at: new Date().toISOString(), last_error: boundary.error, reasons: [boundary.code] },
          });
          continue;
        }
        const sendResult = await sendCimRequestForScoredDeal({
          deal,
          approvedDeal: approval.approvedDeal,
          approvalSnapshotToken: approval.snapshotToken,
          requestedBy: 'automation-stage-2',
          automationAuthorization: {
            decisionId: decision.id,
            runId: run.id,
            activationId,
            claimToken,
            snapshotDigest: cimStage2SnapshotDigest(deal),
          },
          storage,
        });
        if (sendResult.providerAttempted) providerCalls += 1;
        const completedAt = new Date().toISOString();
        if (sendResult.providerOutcomeAmbiguous) {
          ambiguous += 1;
          await storage.transitionCimStage2Decision({
            id: decision.id,
            expectedStates: ['attempting'],
            state: 'ambiguous',
            updates: {
              cim_request_id: sendResult.request?.id || null,
              communication_id: sendResult.request?.metadata?.initialCommunicationId || null,
              provider_state: 'ambiguous',
              last_error: 'Provider acceptance is ambiguous and requires reconciliation; automatic retry is forbidden.',
            },
          });
        } else if (sendResult.ok && !sendResult.alreadySent) {
          accepted += 1;
          await storage.transitionCimStage2Decision({
            id: decision.id,
            expectedStates: ['attempting'],
            state: 'accepted',
            updates: {
              consumed_at: completedAt,
              cim_request_id: sendResult.request?.id || null,
              communication_id: sendResult.request?.metadata?.initialCommunicationId || null,
              provider_state: sendResult.emailResult?.status || sendResult.request?.delivery_state || 'accepted',
            },
          });
        } else {
          failed += 1;
          await storage.transitionCimStage2Decision({
            id: decision.id,
            expectedStates: ['attempting'],
            state: 'failed',
            updates: {
              consumed_at: completedAt,
              cim_request_id: sendResult.request?.id || null,
              communication_id: sendResult.request?.metadata?.initialCommunicationId || null,
              provider_state: sendResult.alreadySent ? 'already-sent' : sendResult.emailResult?.status || 'failed',
              last_error: sendResult.error || (sendResult.alreadySent ? 'An existing sequence already owns this opportunity.' : 'Provider attempt failed.'),
            },
          });
        }
      } catch (error) {
        if (error?.providerAcceptedAmbiguous) {
          providerCalls += 1;
          ambiguous += 1;
          await storage.transitionCimStage2Decision({
            id: decision.id,
            expectedStates: ['attempting'],
            state: 'ambiguous',
            updates: { provider_state: 'ambiguous', last_error: 'Provider acceptance requires reconciliation; automatic retry is forbidden.' },
          });
        } else {
          failed += 1;
          await storage.transitionCimStage2Decision({
            id: decision.id,
            expectedStates: ['attempting'],
            state: 'failed',
            updates: { consumed_at: new Date().toISOString(), provider_state: 'failed', last_error: normalizeText(error?.message, 500) },
          });
        }
      }
    }
    deferred += Math.max(0, evaluated.eligible.length - liveCandidates.length);
    run = await storage.updateCimStage2Run(run.id, {
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: ambiguous > 0 ? 'blocked' : 'completed',
      attempted_count: attempted,
      accepted_count: accepted,
      failed_count: failed,
      ambiguous_count: ambiguous,
      deferred_count: deferred,
      metadata: { ...(run.metadata || {}), providerCalls },
      last_error: ambiguous > 0 ? 'One or more provider outcomes are ambiguous and require reconciliation.' : null,
    });
    return { ok: ambiguous === 0, status: ambiguous > 0 ? 503 : 200, providerCalls, run: stage2RunSummary(run) };
  } catch (error) {
    run = await storage.updateCimStage2Run(run.id, {
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: 'failed',
      last_error: normalizeText(error?.message || 'Stage 2 run failed.', 500),
      metadata: { ...(run.metadata || {}), providerCalls: Number(run.metadata?.providerCalls || 0) },
    }).catch(() => run);
    return { ok: false, status: 503, error: 'Stage 2 automation run failed closed. No automatic retry was scheduled.', providerCalls: Number(run.metadata?.providerCalls || 0), run: stage2RunSummary(run) };
  }
}

async function sendCimRequestForScoredDeal({
  deal,
  approvedDeal = null,
  approvalSnapshotToken = '',
  requestedBy = '',
  storage = getStorage(),
  retryOfRequest = null,
  correctedRecipient = null,
  automationAuthorization = null,
  manualApproval = null,
} = {}) {
  if (normalizeText(requestedBy, 160).toLowerCase() === 'automation-stage-3') {
    return { ok: false, status: 409, error: 'Stage 3 automatic transmission is not implemented or authorized in this release.' };
  }
  if (
    !storage.getDealHunterCimRequest ||
    !storage.listDealHunterCimRequests ||
    !storage.upsertDealHunterCimRequest ||
    !storage.insertCrmCommunication ||
    !storage.updateCrmCommunication
  ) {
    return { ok: false, status: 500, error: 'CIM request tracking storage is not configured.' };
  }

  const manualSend = Boolean(manualApproval);
  if (manualSend && (
    manualApproval.intent !== 'manual_stage_1'
    || manualApproval.requestType !== 'cim_request'
    || manualApproval.followUpPolicy !== 'none'
    || !normalizeText(manualApproval.administratorPrincipalId, 300)
    || !/^[a-f0-9]{64}$/i.test(normalizeText(manualApproval.proposalDigest, 64))
  )) {
    return { ok: false, status: 400, error: 'The trusted manual Stage 1 approval is invalid.' };
  }
  const inheritedManualMarker = retryOfRequest?.metadata?.manualApproval;
  const manualApprovalAudit = manualSend
    ? {
        intent: 'manual_stage_1',
        followUpPolicy: 'none',
        administratorPrincipalId: normalizeText(manualApproval.administratorPrincipalId, 300),
        proposalDigest: normalizeText(manualApproval.proposalDigest, 64),
        nonce: normalizeText(manualApproval.nonce, 200),
        preparedAt: normalizeText(manualApproval.preparedAt, 80),
        templateVersion: normalizeText(manualApproval.templateVersion, 160),
      }
    : inheritedManualMarker?.intent === 'manual_stage_1' && inheritedManualMarker?.followUpPolicy === 'none'
      ? { ...inheritedManualMarker }
      : null;

  const outreachGate = await assertCimOutreachAllowed({ storage });
  if (!outreachGate.allowed) {
    return { ok: false, status: 409, error: outreachGate.error, outreachPause: outreachGate.status };
  }

  const identity = await resolveDealHunterOpportunity({
    deal,
    storage,
    actor: requestedBy || 'deal-hunter-send-boundary',
  });
  if (!identity.ok) {
    return {
      ok: false,
      status: 409,
      error: identity.error || 'Canonical opportunity identity could not be resolved. No broker email was transmitted.',
      identityException: identity.identityException || null,
    };
  }
  deal = {
    ...deal,
    opportunityId: identity.opportunityId,
    identityStatus: 'resolved',
    identityResolution: identity.resolution,
    dealKeyAliases: uniqueStrings([
      ...(deal.dealKeyAliases || []),
      ...identity.aliases.filter((item) => item.alias_type === 'deal-key').map((item) => item.alias_value),
    ]).filter((key) => key !== deal.dealKey),
  };

  // Revalidate eligibility and build/link the CRM record from the latest healthy
  // source deal, while keeping the signed approval snapshot as the immutable
  // input for request metadata and the exact outbound copy. Automated actors
  // must provide a token verified again at this private-send boundary; they are
  // never allowed to fall back to an unsigned live deal object.
  const automaticSend = isCimAutomationActor(requestedBy);
  const verifiedAutomationDeal = automaticSend
    ? verifyCimDealSnapshotToken(approvalSnapshotToken)
    : null;

  if (
    automaticSend &&
    (
      !verifiedAutomationDeal ||
      verifiedAutomationDeal.dealKey !== deal?.dealKey ||
      (verifiedAutomationDeal.opportunityId && verifiedAutomationDeal.opportunityId !== deal?.opportunityId) ||
      normalizeEmail(verifiedAutomationDeal.brokerEmail) !== normalizeEmail(deal?.brokerEmail)
    )
  ) {
    return {
      ok: false,
      status: 409,
      error: 'The automatic CIM request does not match a verified server-signed approval snapshot. No broker email was transmitted.',
      deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
    };
  }

  const approvedMessageDeal = {
    ...(automaticSend
    ? verifiedAutomationDeal
    : approvedDeal?.dealKey === deal?.dealKey
      ? approvedDeal
      : deal),
    opportunityId: deal.opportunityId,
    identityStatus: 'resolved',
  };
  if (automaticSend) {
    const authorization = await authorizeCimStage2SendBoundary({
      decisionId: automationAuthorization?.decisionId || '',
      runId: automationAuthorization?.runId || '',
      activationId: automationAuthorization?.activationId || '',
      claimToken: automationAuthorization?.claimToken || '',
      deal: approvedMessageDeal,
      snapshotDigest: automationAuthorization?.snapshotDigest || '',
      storage,
      config: getConfig(),
      now: new Date(),
    });
    if (!authorization.ok) {
      return {
        ok: false,
        status: 409,
        error: authorization.error,
        automationBlockerCode: authorization.code,
        deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
      };
    }
  }
  const recipientEmail = normalizeEmail(approvedMessageDeal?.brokerEmail);
  const eligibility = evaluateDealHunterCimEligibility({
    deal,
    recipientEmail,
    policy: manualSend ? 'manual_stage_1' : 'automated',
  });
  const unavailableReason = eligibility.blockers[0]?.message || '';

  if (unavailableReason) {
    return {
      ok: false,
      status: 400,
      error: unavailableReason,
      deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
    };
  }

  if (manualSend) {
    const currentScore = await storage.getCurrentDealHunterOpportunityScore?.(deal.opportunityId);
    const reviewChanged = Boolean(currentScore?.changed_since_review)
      || Boolean(currentScore?.reviewed_fingerprint && currentScore?.score_fingerprint
        && currentScore.reviewed_fingerprint !== currentScore.score_fingerprint)
      || Boolean(currentScore?.reviewed_semantic_digest && currentScore?.semantic_digest
        && currentScore.reviewed_semantic_digest !== currentScore.semantic_digest);
    const pursued = normalizeText(currentScore?.operator_priority, 40).toLowerCase() === 'high'
      && Boolean(currentScore?.reviewed_at)
      && !reviewChanged
      && !currentScore?.should_remove;
    if (!pursued) {
      return { ok: false, status: 409, code: 'preparation_stale', error: 'Current explicit Pursue authority is required before manual Stage 1 execution.' };
    }
    const readiness = await getEmailReadiness({ storage });
    if (!readiness.outboundConfigured) {
      return { ok: false, status: 409, code: 'provider_not_ready', error: readiness.issues?.[0] || 'The outbound email provider is not ready.' };
    }
    const prospectiveRequestId = buildDealHunterCimRequestId(deal.opportunityId, recipientEmail);
    const expectedCommunicationId = sha256(`crm-communication:${prospectiveRequestId}:initial`);
    const currentEnvelope = buildDealHunterCimRequestEmail({
      to: recipientEmail,
      deal: approvedMessageDeal,
      requestedBy,
      cimRequestId: prospectiveRequestId,
      communicationId: expectedCommunicationId,
      manualStage1: { greeting: manualApproval.greeting },
    });
    const config = getConfig();
    const exactMatch = manualApproval.canonicalOpportunityId === deal.opportunityId
      && normalizeEmail(manualApproval.recipientEmail) === recipientEmail
      && manualApproval.prospectiveRequestId === prospectiveRequestId
      && normalizeEmail(manualApproval.senderEmail) === normalizeEmail(config.delivery.resendFromEmail || config.delivery.fallbackRecipient)
      && manualApproval.senderDisplayName === (normalizeText(config.workflow?.defaultAssignee, 120) || 'Mathew Uckele')
      && normalizeEmail(manualApproval.replyTo) === normalizeEmail(currentEnvelope.replyTo)
      && manualApproval.templateVersion === currentEnvelope.templateVersion
      && manualApproval.subject === currentEnvelope.subject
      && manualApproval.bodyText === currentEnvelope.text
      && manualApproval.bodyHtml === currentEnvelope.html;
    if (!exactMatch) {
      return { ok: false, status: 409, code: 'preparation_stale', error: 'The approved exact message no longer matches the durable CIM executor.' };
    }
  }

  const lockKey = buildCimDealSendLockKey(deal.opportunityId);
  const recipientLockKey = normalizeEmail(recipientEmail);

  if (!acquireLock(cimRequestSendLocks, lockKey) || !acquireLock(cimRecipientSendLocks, recipientLockKey)) {
    releaseLock(cimRequestSendLocks, lockKey);
    return {
      ok: false,
      status: 409,
      error: 'A CIM request for this deal is already in progress. Please wait a few minutes before retrying.',
      deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
    };
  }

  let durableRecipientClaimRequestId = '';

  try {
    let submission;

    try {
      submission = retryOfRequest?.submission_id && storage.getSubmission
        ? await storage.getSubmission(retryOfRequest.submission_id)
        : null;
      submission ||= await ensureDealHunterSubmissionForCim(storage, deal, requestedBy);
    } catch (error) {
      return {
        ok: false,
        status: 500,
        error: error.message || 'A CRM record could not be linked before sending the CIM request.',
        deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
      };
    }

    if (submission.status === 'archived') {
      return {
        ok: false,
        status: 409,
        error: archivedCimUnavailableReason,
        deal: publicDealWithUnavailableCim(deal, archivedCimUnavailableReason, retryOfRequest ? [retryOfRequest] : []),
      };
    }

    const activeSuppression = await storage.getActiveEmailSuppression?.(recipientEmail);
    if (activeSuppression) {
      return {
        ok: false,
        status: 422,
        error: 'This recipient is globally suppressed from outreach. No CIM email was transmitted.',
        suppression: { reason: activeSuppression.reason, createdAt: activeSuppression.created_at },
        deal: publicDeal(attachCimRequestStatus([deal], retryOfRequest ? [retryOfRequest] : [])[0]),
      };
    }

    const dealRequests = await loadDealHunterCimRequests(
      storage,
      uniqueStrings([deal.dealKey, ...(deal.dealKeyAliases || [])]),
      [deal.opportunityId],
    );
    const blockingRequest = findBlockingCimRequest(
      retryOfRequest
        ? dealRequests.filter((request) => request.id !== retryOfRequest.id)
        : dealRequests,
    );
    const existingRequest = dealRequests.find((request) => normalizeEmail(request?.recipient_email) === recipientEmail)
      || await storage.getDealHunterCimRequest({ dealKey: deal.dealKey, recipientEmail });

    if (blockingRequest && ['ambiguous', 'follow_up_ambiguous'].includes(blockingRequest.status)) {
      return {
        ok: false,
        status: 409,
        error: 'The prior provider outcome is ambiguous. Reconcile the persisted communication before any retry; no email was transmitted.',
        providerOutcomeAmbiguous: true,
        request: blockingRequest,
        deal: publicDeal(attachCimRequestStatus([deal], dealRequests)[0]),
      };
    }

    if (blockingRequest && isCompletedCimStatus(blockingRequest.status)) {
      const linkedBlockingRequest = blockingRequest.submission_id && blockingRequest.opportunity_id === deal.opportunityId
        ? blockingRequest
        : await upsertCimRequestWithActivity(storage, {
            ...blockingRequest,
            submission_id: submission.id,
            opportunity_id: deal.opportunityId,
            updated_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
          }, {
            eventType: 'cim.crm-linked',
            summary: 'Existing CIM request linked to this CRM record.',
            actor: requestedBy,
          });
      return {
        ok: true,
        status: 200,
        alreadySent: true,
        request: linkedBlockingRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [linkedBlockingRequest, ...dealRequests.filter((item) => item.id !== linkedBlockingRequest.id)])[0]),
        emailResult: {
          status: linkedBlockingRequest.status,
          error: '',
          providerMessageId: linkedBlockingRequest.provider_message_id || '',
        },
      };
    }

    const reconciliationCandidates = Array.from(
      new Map(
        [blockingRequest, existingRequest]
          .filter(Boolean)
          .map((request) => [request.id, request]),
      ).values(),
    );
    for (const candidateRequest of reconciliationCandidates) {
      const existingCommunication = await storage.getCrmCommunication?.(
        sha256(`crm-communication:${candidateRequest.id}:initial`),
      );
      if (
        !existingCommunication ||
        existingCommunication.submission_id !== submission.id ||
        existingCommunication.cim_request_id !== candidateRequest.id
      ) {
        continue;
      }
      const reconciliation = await reconcileAcceptedInitialCimCommunication({
        storage,
        request: candidateRequest,
        communication: existingCommunication,
        actor: requestedBy,
        deal: dealFromCimRequest(candidateRequest),
      });
      if (reconciliation) {
        return {
          ok: true,
          status: 200,
          alreadySent: true,
          reconciled: true,
          request: reconciliation.request,
          deal: publicDeal(attachCimRequestStatus([
            deal,
          ], [reconciliation.request, ...dealRequests.filter((item) => item.id !== reconciliation.request.id)])[0]),
          emailResult: reconciliation.emailResult,
        };
      }
    }

    if (blockingRequest && isRecentPendingCimRequest(blockingRequest)) {
      return {
        ok: false,
        status: 409,
        error: 'A CIM request for this deal is already in progress. Please wait a few minutes before retrying.',
        request: blockingRequest,
        deal: publicDeal(attachCimRequestStatus([deal], dealRequests)[0]),
      };
    }

    const recipientPolicy = await evaluateCimRecipientPolicy({
      recipientEmail,
      opportunityId: deal.opportunityId,
      storage,
      includePendingInitial: false,
    });
    if (!recipientPolicy.allowed) {
      await recordCimSafetyMetric({ metric: 'recipientCapDeferrals', storage }).catch(() => null);
      return {
        ok: false,
        status: 409,
        error: recipientPolicy.reason === 'recipient-24-hour-cap'
          ? 'This recipient has reached the rolling 24-hour CIM touch cap. No email was transmitted.'
          : 'This recipient has reached the rolling 30-day CIM touch cap. No email was transmitted.',
        recipientPolicy,
        deal: publicDeal(attachCimRequestStatus([deal], dealRequests)[0]),
      };
    }

    const unsignedPendingRecord = buildCimRequestRecord({
      deal: approvedMessageDeal,
      recipientEmail,
      requestedBy,
      emailResult: { status: 'pending', error: '', providerMessageId: '' },
      existingRequest,
      submissionId: submission.id,
      retryOfRequestId: retryOfRequest?.id || '',
      correctedRecipient,
      manualApprovalAudit,
    });
    const pendingRecord = automaticSend
      ? {
          ...unsignedPendingRecord,
          metadata: {
            ...(unsignedPendingRecord.metadata || {}),
            automationApproval: {
              mode: 'durable-stage2-decision',
              snapshotDigest: cimStage2SnapshotDigest(approvedMessageDeal),
              sourceSnapshotDigest: sourceSnapshotDigestForDeal(approvedMessageDeal),
              recipientHash: hashCimStage2Recipient(recipientEmail),
              verified: true,
              stage: 2,
              runId: automationAuthorization?.runId || '',
              decisionId: automationAuthorization?.decisionId || '',
              activationId: automationAuthorization?.activationId || '',
              verifiedAt: new Date().toISOString(),
            },
          },
        }
      : unsignedPendingRecord;
    if (!storage.claimDealHunterCimRecipient) {
      return { ok: false, status: 500, error: 'Recipient cadence claim storage is not configured. No email was transmitted.' };
    }
    const durableRecipientClaim = await storage.claimDealHunterCimRecipient({
      recipientEmail,
      requestId: pendingRecord.id,
      opportunityId: deal.opportunityId,
      nowIso: pendingRecord.updated_at,
      expiresAt: new Date(Date.parse(pendingRecord.updated_at) + 10 * 60 * 1000).toISOString(),
      metadata: { kind: 'initial-cim-request' },
    });
    if (!durableRecipientClaim?.claimed) {
      return {
        ok: false,
        status: 409,
        error: 'Another CIM transmission to this recipient is already in progress. No email was transmitted.',
        recipientClaim: durableRecipientClaim?.claim || null,
      };
    }
    durableRecipientClaimRequestId = pendingRecord.id;
    if (!storage.claimDealHunterCimOpportunity) {
      return { ok: false, status: 500, error: 'Canonical opportunity claim storage is not configured. No email was transmitted.' };
    }
    const canonicalClaim = await storage.claimDealHunterCimOpportunity({
      opportunityId: deal.opportunityId,
      requestId: pendingRecord.id,
      recipientEmail,
      allowedRequestIds: retryOfRequest ? [retryOfRequest.id] : [],
      nowIso: pendingRecord.updated_at,
      metadata: { dealKey: deal.dealKey, requestedBy: normalizeText(requestedBy, 160) },
    });
    if (!canonicalClaim?.claimed) {
      const owner = canonicalClaim?.claim?.request_id
        ? await storage.getDealHunterCimRequestById?.(canonicalClaim.claim.request_id)
        : null;
      return {
        ok: Boolean(owner && isCompletedCimStatus(owner.status)),
        alreadySent: Boolean(owner && isCompletedCimStatus(owner.status)),
        status: owner && isCompletedCimStatus(owner.status) ? 200 : 409,
        error: owner && isCompletedCimStatus(owner.status)
          ? ''
          : 'Another CIM sequence already owns this canonical opportunity. No email was transmitted.',
        request: owner,
        deal: publicDeal(attachCimRequestStatus([deal], owner ? [owner] : dealRequests)[0]),
      };
    }
    const claimResult = storage.claimDealHunterCimRequest
      ? await storage.claimDealHunterCimRequest(pendingRecord, {
          pendingCutoff: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        })
      : null;
    const pendingRequest = claimResult
      ? claimResult.request
      : await storage.upsertDealHunterCimRequest(pendingRecord);

    if (claimResult && !claimResult.claimed) {
      const currentRequest = pendingRequest || existingRequest;

      if (isCompletedCimStatus(currentRequest?.status)) {
        return {
          ok: true,
          status: 200,
          alreadySent: true,
          request: currentRequest,
          deal: publicDeal(attachCimRequestStatus([deal], [currentRequest])[0]),
          emailResult: {
            status: currentRequest.status,
            error: '',
            providerMessageId: currentRequest.provider_message_id || '',
          },
        };
      }

      if (['submission-archived', 'submission-missing'].includes(claimResult.reason)) {
        return {
          ok: false,
          status: 409,
          error: archivedCimUnavailableReason,
          request: currentRequest,
          deal: publicDealWithUnavailableCim(deal, archivedCimUnavailableReason, currentRequest ? [currentRequest] : []),
        };
      }

      return {
        ok: false,
        status: 409,
        error: 'A CIM request for this deal is already in progress. Please wait a few minutes before retrying.',
        request: currentRequest,
        deal: publicDeal(attachCimRequestStatus([deal], currentRequest ? [currentRequest] : [])[0]),
      };
    }

    const communicationId = sha256(`crm-communication:${pendingRequest?.id || pendingRecord.id}:initial`);
    const generatedMessage = buildDealHunterCimRequestEmail({
      to: recipientEmail,
      deal: approvedMessageDeal,
      requestedBy,
      cimRequestId: pendingRequest?.id || pendingRecord.id,
      submissionId: submission.id,
      communicationId,
      ...(manualSend ? { manualStage1: { greeting: manualApproval.greeting } } : {}),
    });
    const renderedMessage = manualSend
      ? {
          ...generatedMessage,
          from: formatCimSenderAddress(manualApproval.senderDisplayName, manualApproval.senderEmail),
          to: recipientEmail,
          replyTo: manualApproval.replyTo,
          subject: manualApproval.subject,
          headline: manualApproval.subject,
          text: manualApproval.bodyText,
          html: manualApproval.bodyHtml,
          templateVersion: manualApproval.templateVersion,
          manualApprovalAudit,
        }
      : generatedMessage;
    let communication;

    try {
      communication = await persistPreparedCimCommunication({
        storage,
        request: pendingRequest || pendingRecord,
        submissionId: submission.id,
        message: renderedMessage,
        actor: requestedBy,
        summary: 'Exact outbound CIM request saved before transmission.',
      });
    } catch {
      const failedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestRecord({
          deal: approvedMessageDeal,
          recipientEmail,
          requestedBy,
          emailResult: { status: 'failed', error: 'The exact outbound communication could not be persisted.', providerMessageId: '' },
          existingRequest: pendingRequest,
          submissionId: submission.id,
          retryOfRequestId: retryOfRequest?.id || '',
          correctedRecipient,
        }),
        pendingRequest || pendingRecord,
        {
          expectedStatuses: ['pending'],
          eventType: 'cim.request-failed',
          summary: 'CIM request stopped before transmission because its exact communication could not be saved.',
          actor: requestedBy,
        },
      );
      return {
        ok: false,
        status: 500,
        error: 'The exact CIM email could not be saved, so no email was transmitted.',
        request: failedRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [failedRequest])[0]),
      };
    }

    const persistedReconciliation = await reconcileAcceptedInitialCimCommunication({
      storage,
      request: pendingRequest || pendingRecord,
      communication,
      actor: requestedBy,
      deal: approvedMessageDeal,
    });
    if (persistedReconciliation) {
      return {
        ok: true,
        status: 200,
        alreadySent: true,
        reconciled: true,
        request: persistedReconciliation.request,
        deal: publicDeal(attachCimRequestStatus([deal], [persistedReconciliation.request])[0]),
        emailResult: persistedReconciliation.emailResult,
      };
    }

    const renewal = await renewCimRequestClaim(storage, pendingRequest || pendingRecord, 'pending');
    if (!renewal?.renewed) {
      const currentRequest = renewal?.request || pendingRequest || pendingRecord;
      return {
        ok: false,
        status: 409,
        error: ['submission-archived', 'submission-missing'].includes(renewal?.reason)
          ? archivedCimUnavailableReason
          : 'The CIM request claim changed before transmission. Review the latest request state before retrying.',
        request: currentRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [currentRequest])[0]),
      };
    }
    const activeRequest = renewal.request || pendingRequest || pendingRecord;
    let finalDisposition = null;
    let dispositionCheckFailed = false;
    const requiresFailClosedFinalDisposition = automaticSend || manualSend;
    if (storage.getDealHunterDisposition) {
      try {
        finalDisposition = await storage.getDealHunterDisposition({ dealKey: deal.dealKey });
      } catch {
        dispositionCheckFailed = requiresFailClosedFinalDisposition;
      }
    } else if (requiresFailClosedFinalDisposition) {
      dispositionCheckFailed = true;
    }
    if (dispositionCheckFailed || finalDisposition?.disposition === 'dismissed') {
      const dispositionError = dispositionCheckFailed
        ? automaticSend
          ? 'The final dismissal check is unavailable. No automatic email was transmitted.'
          : 'The final dismissal check is unavailable. No email was transmitted.'
        : 'This Deal Hunter opportunity was dismissed before provider work. No email was transmitted.';
      const blockedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestRecord({
          deal: approvedMessageDeal,
          recipientEmail,
          requestedBy,
          emailResult: { status: 'failed', error: dispositionError, providerMessageId: '' },
          existingRequest: activeRequest,
          submissionId: submission.id,
          retryOfRequestId: retryOfRequest?.id || '',
          correctedRecipient,
          communicationId: communication.id,
        }),
        activeRequest,
        {
          expectedStatuses: ['pending'],
          eventType: 'cim.dismissal-blocked',
          summary: dispositionError,
          actor: requestedBy,
          metadata: { dispositionId: finalDisposition?.id || '', dispositionCheckFailed },
        },
      );
      return {
        ok: false,
        status: 409,
        error: dispositionError,
        request: blockedRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [blockedRequest])[0]),
      };
    }
    const finalManualReadiness = manualSend ? await getEmailReadiness({ storage }) : null;
    if (manualSend && !finalManualReadiness.outboundConfigured) {
      const readinessError = finalManualReadiness.issues?.[0] || 'The outbound email provider is not ready. No email was transmitted.';
      const blockedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestRecord({
          deal: approvedMessageDeal,
          recipientEmail,
          requestedBy,
          emailResult: { status: 'failed', error: readinessError, providerMessageId: '' },
          existingRequest: activeRequest,
          submissionId: submission.id,
          retryOfRequestId: retryOfRequest?.id || '',
          correctedRecipient,
          communicationId: communication.id,
          manualApprovalAudit,
        }),
        activeRequest,
        {
          expectedStatuses: ['pending'],
          eventType: 'cim.readiness-blocked',
          summary: readinessError,
          actor: requestedBy,
          metadata: { communicationId: communication.id, provider: finalManualReadiness.provider || '' },
        },
      );
      return {
        ok: false,
        status: 409,
        code: 'provider_not_ready',
        error: readinessError,
        request: blockedRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [blockedRequest])[0]),
      };
    }
    const finalOutreachGate = await assertCimOutreachAllowed({ storage });
    const finalRecipientPolicy = finalOutreachGate.allowed
      ? await evaluateCimRecipientPolicy({
          recipientEmail,
          opportunityId: deal.opportunityId,
          storage,
          includePendingInitial: false,
        })
      : null;
    if (!finalOutreachGate.allowed || !finalRecipientPolicy?.allowed) {
      const policyError = finalOutreachGate.allowed
        ? 'The recipient cadence changed before transmission. No email was transmitted.'
        : finalOutreachGate.error;
      const blockedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestRecord({
          deal: approvedMessageDeal,
          recipientEmail,
          requestedBy,
          emailResult: { status: 'failed', error: policyError, providerMessageId: '' },
          existingRequest: activeRequest,
          submissionId: submission.id,
          retryOfRequestId: retryOfRequest?.id || '',
          correctedRecipient,
          communicationId: communication.id,
        }),
        activeRequest,
        {
          expectedStatuses: ['pending'],
          eventType: 'cim.outreach-deferred',
          summary: policyError,
          actor: requestedBy,
          metadata: { recipientPolicy: finalRecipientPolicy, outreachPause: finalOutreachGate.status },
        },
      );
      return {
        ok: false,
        status: 409,
        error: policyError,
        request: blockedRequest,
        recipientPolicy: finalRecipientPolicy,
        outreachPause: finalOutreachGate.status,
        deal: publicDeal(attachCimRequestStatus([deal], [blockedRequest])[0]),
      };
    }
    const finalSuppression = automaticSend || manualSend
      ? await storage.getActiveEmailSuppression?.(recipientEmail)
      : null;
    if ((automaticSend || manualSend) && finalSuppression) {
      const suppressionError = automaticSend
        ? 'The recipient became suppressed before Stage 2 provider work. No email was transmitted.'
        : 'The recipient became suppressed before provider work. No email was transmitted.';
      const blockedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestRecord({
          deal: approvedMessageDeal,
          recipientEmail,
          requestedBy,
          emailResult: { status: 'failed', error: suppressionError, providerMessageId: '' },
          existingRequest: activeRequest,
          submissionId: submission.id,
          retryOfRequestId: retryOfRequest?.id || '',
          correctedRecipient,
          communicationId: communication.id,
        }),
        activeRequest,
        {
          expectedStatuses: ['pending'],
          eventType: automaticSend ? 'cim.stage2-suppression-blocked' : 'cim.suppression-blocked',
          summary: suppressionError,
          actor: requestedBy,
          metadata: { suppressionReason: finalSuppression.reason || 'active-suppression' },
        },
      );
      return {
        ok: false,
        status: 409,
        error: suppressionError,
        ...(automaticSend ? { automationBlockerCode: 'recipient_suppressed' } : { code: 'recipient_suppressed' }),
        request: blockedRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [blockedRequest])[0]),
      };
    }
    if (automaticSend) {
      const finalAutomationAuthorization = await authorizeCimStage2SendBoundary({
        decisionId: automationAuthorization?.decisionId || '',
        runId: automationAuthorization?.runId || '',
        activationId: automationAuthorization?.activationId || '',
        claimToken: automationAuthorization?.claimToken || '',
        deal: approvedMessageDeal,
        snapshotDigest: automationAuthorization?.snapshotDigest || '',
        storage,
        config: getConfig(),
        now: new Date(),
      });
      if (!finalAutomationAuthorization.ok) {
        const authorizationError = finalAutomationAuthorization.error;
        const blockedRequest = await finalizeCimRequestClaimWithActivity(
          storage,
          buildCimRequestRecord({
            deal: approvedMessageDeal,
            recipientEmail,
            requestedBy,
            emailResult: { status: 'failed', error: authorizationError, providerMessageId: '' },
            existingRequest: activeRequest,
            submissionId: submission.id,
            retryOfRequestId: retryOfRequest?.id || '',
            correctedRecipient,
            communicationId: communication.id,
          }),
          activeRequest,
          {
            expectedStatuses: ['pending'],
            eventType: 'cim.stage2-authorization-blocked',
            summary: 'Stage 2 durable authorization changed before provider work; no email was transmitted.',
            actor: requestedBy,
            metadata: { blockerCode: finalAutomationAuthorization.code, communicationId: communication.id },
          },
        );
        return {
          ok: false,
          status: 409,
          error: authorizationError,
          automationBlockerCode: finalAutomationAuthorization.code,
          request: blockedRequest,
          deal: publicDeal(attachCimRequestStatus([deal], [blockedRequest])[0]),
        };
      }
    }
    if (finalRecipientPolicy.override?.id && storage.consumeDealHunterCimRecipientOverride) {
      await storage.consumeDealHunterCimRecipientOverride(finalRecipientPolicy.override.id, new Date().toISOString());
    }
    const preparedMessage = preparedMessageFromCommunication(communication, renderedMessage);
    const emailResult = await sendPreparedMessage(preparedMessage);
    let communicationStateError = null;
    try {
      communication = await updateCimCommunicationAfterSend(storage, communication, emailResult, requestedBy);
    } catch (error) {
      communicationStateError = error;
    }

    let savedRequest;
    try {
      savedRequest = await finalizeCimRequestClaimWithActivity(
        storage,
        buildCimRequestRecord({
          deal: approvedMessageDeal,
          recipientEmail,
          requestedBy,
          emailResult,
          existingRequest: activeRequest,
          submissionId: submission.id,
          retryOfRequestId: retryOfRequest?.id || '',
          correctedRecipient,
          communicationId: communication.id,
        }),
        activeRequest,
        {
          expectedStatuses: ['pending'],
          eventType: emailResult.status === 'ambiguous'
            ? 'cim.request-ambiguous'
            : emailResult.status === 'failed'
              ? 'cim.request-failed'
              : 'cim.request-sent',
          summary: emailResult.status === 'ambiguous'
            ? 'CIM request provider outcome is ambiguous; reconciliation is required before any retry.'
            : emailResult.status === 'failed'
              ? 'CIM request provider attempt failed.'
              : emailResult.status === 'logged'
                ? 'CIM request logged by the development-only console provider.'
                : 'CIM request accepted by the email provider; delivery is awaiting confirmation.',
          actor: requestedBy,
          metadata: {
            recipientEmail,
            deliveryStatus: emailResult.status,
            providerMessageId: emailResult.providerMessageId || '',
            communicationId: communication.id,
            communicationStatePersisted: !communicationStateError,
            ...(correctedRecipient ? { correctedRecipient } : {}),
          },
        },
      );
    } catch (error) {
      if (['sent', 'logged'].includes(emailResult.status)) {
        throw postProviderPersistenceError('CIM request', {
          communicationStatePersisted: !communicationStateError,
        });
      }
      throw error;
    }
    const publicUpdatedDeal = publicDeal(attachCimRequestStatus([deal], [savedRequest])[0]);

    return {
      ok: !['failed', 'ambiguous'].includes(emailResult.status),
      status: emailResult.status === 'ambiguous' ? 503 : emailResult.status === 'failed' ? 502 : 201,
      alreadySent: false,
      request: savedRequest,
      deal: publicUpdatedDeal,
      emailResult,
      providerAttempted: true,
      providerOutcomeAmbiguous: emailResult.status === 'ambiguous',
      error: ['failed', 'ambiguous'].includes(emailResult.status) ? emailResult.error || 'CIM request email failed.' : '',
      warning: communicationStateError
        ? ['sent', 'logged'].includes(emailResult.status)
          ? 'The provider accepted the CIM request, but its communication delivery state awaits reconciliation.'
          : 'The provider attempt failed, and its communication delivery state could not be saved.'
        : '',
    };
  } finally {
    if (durableRecipientClaimRequestId && storage.releaseDealHunterCimRecipientClaim) {
      await storage.releaseDealHunterCimRecipientClaim({ recipientEmail, requestId: durableRecipientClaimRequestId });
    }
    releaseLock(cimRequestSendLocks, lockKey);
    releaseLock(cimRecipientSendLocks, recipientLockKey);
  }
}

export async function executeApprovedDealHunterCimRequest({
  approvedProposal,
  requestedBy = '',
  administratorPrincipalId = '',
  storage = getStorage(),
} = {}) {
  const proposal = approvedProposal && typeof approvedProposal === 'object' && !Array.isArray(approvedProposal)
    ? approvedProposal
    : null;
  const opportunityId = normalizeText(proposal?.canonicalOpportunityId, 200);
  const recipientEmail = normalizeEmail(proposal?.recipientEmail);
  if (
    !proposal
    || proposal.intent !== 'manual_stage_1'
    || proposal.requestType !== 'cim_request'
    || !opportunityId
    || !isValidEmail(recipientEmail)
    || !normalizeText(administratorPrincipalId, 300)
    || proposal.prospectiveRequestId !== buildDealHunterCimRequestId(opportunityId, recipientEmail)
  ) {
    return { ok: false, status: 400, error: 'The trusted approved Broker Materials proposal is invalid.' };
  }

  const [opportunity, score, aliases, sourceRows] = await Promise.all([
    storage.getCurrentDealHunterOpportunity?.(opportunityId),
    storage.getCurrentDealHunterOpportunityScore?.(opportunityId),
    storage.listDealHunterOpportunityAliases?.({ opportunityIds: [opportunityId], limit: 500 }),
    storage.listDealHunterOpportunitySourceObservations?.(opportunityId, { limit: 500 }),
  ]);
  if (!opportunity || !score || !Array.isArray(aliases) || !Array.isArray(sourceRows)) {
    return { ok: false, status: 409, code: 'preparation_stale', error: 'Current canonical authority is unavailable for the approved request.' };
  }
  const fieldValue = (...fields) => sourceRows.find((row) => fields.includes(normalizeText(row?.field, 80).toLowerCase()))?.value || '';
  const dealKeyAliases = aliases
    .filter((alias) => ['deal-key', 'deal_key'].includes(normalizeText(alias?.alias_type, 80).toLowerCase()))
    .map((alias) => normalizeText(alias.alias_value, 1200))
    .filter(Boolean);
  const identityAliases = aliases
    .filter((alias) => ['listing-id', 'source-identity'].includes(normalizeText(alias?.alias_type, 80).toLowerCase()))
    .map((alias) => normalizeText(alias.alias_value, 1200))
    .filter(Boolean);
  const listingUrl = normalizeText(fieldValue('listing_url') || score.listing_url, 2000);
  const sourceRow = sourceRows.find((row) => row?.source_id && row?.source_record_id) || {};
  const annualProfitValue = fieldValue('annual_profit', 'ttm_ebitda');
  const deal = {
    id: normalizeText(sourceRow.source_record_id, 240),
    opportunityId,
    identityStatus: 'resolved',
    dealKey: normalizeText(score.deal_key, 1200),
    dealKeyAliases,
    identityAliases,
    sourceId: normalizeText(sourceRow.source_id, 200),
    sourceName: normalizeText(sourceRow.source_name, 200),
    stableExternalId: Boolean(sourceRow.source_record_id),
    name: normalizeText(opportunity.canonical_name || score.name || 'the listed business', 300),
    description: normalizeText(fieldValue('description'), 4000),
    industry: normalizeText(fieldValue('industry'), 220),
    location: normalizeText(opportunity.canonical_location, 220),
    listingUrl,
    brokerName: normalizeText(fieldValue('broker_name'), 220),
    brokerEmail: recipientEmail,
    score: Number(score.fit_score || 0),
    annualProfit: annualProfitValue === '' ? null : parseNumber(annualProfitValue),
    shouldRemove: Boolean(score.should_remove),
  };
  const sendApprovedRequest = () => sendCimRequestForScoredDeal({
    deal,
    requestedBy,
    storage,
    manualApproval: {
      ...proposal,
      administratorPrincipalId: normalizeText(administratorPrincipalId, 300),
      followUpPolicy: 'none',
    },
  });
  try {
    return await sendApprovedRequest();
  } catch (error) {
    if (!error?.providerAcceptedAmbiguous) throw error;
    let recoveryError = error;
    try {
      const recovered = await sendApprovedRequest();
      if (recovered?.request?.id) return recovered;
    } catch (candidateError) {
      recoveryError = candidateError;
    }
    const durableRequest = await storage.getDealHunterCimRequestById?.(proposal.prospectiveRequestId);
    if (!durableRequest?.id) throw recoveryError;
    return {
      ok: false,
      status: 503,
      alreadySent: true,
      providerOutcomeAmbiguous: true,
      request: durableRequest,
      error: error.message,
    };
  }
}

export async function sendDealHunterCimRequest({ dealKey = '', snapshotToken = '', requestedBy = '', storage = getStorage() } = {}) {
  const normalizedDealKey = normalizeText(dealKey, 1000);
  const snapshotDeal = verifyCimDealSnapshotToken(snapshotToken);

  if (!normalizedDealKey) {
    return { ok: false, status: 400, error: 'Deal key is required.' };
  }

  if (!snapshotDeal || snapshotDeal.dealKey !== normalizedDealKey) {
    return { ok: false, status: 400, error: 'The CIM request does not match the signed approval queue.' };
  }

  let result = null;

  try {
    result = await buildDailyDealReview({ storage });
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'Deal Hunter sources could not be reviewed. Review sources again before sending this CIM request.',
    };
  }

  if (reviewHasRequiredSourceFailures(result.review)) {
    return {
      ok: false,
      status: 503,
      error: 'Deal Hunter required-source review is incomplete. Restore every required Google Sheet and review again before sending this CIM request.',
    };
  }

  const deal = result.scoredDeals.find((candidate) => candidate.dealKey === normalizedDealKey);

  if (!deal) {
    return { ok: false, status: 404, error: 'Deal was not found in the latest Deal Hunter review.' };
  }

  if (normalizeEmail(deal.brokerEmail) !== normalizeEmail(snapshotDeal.brokerEmail)) {
    return { ok: false, status: 409, error: 'The broker recipient changed after approval. Review the opportunity again before sending.' };
  }

  return sendCimRequestForScoredDeal({
    deal,
    approvedDeal: snapshotDeal,
    requestedBy,
    storage,
  });
}

export async function retryDealHunterCimRequestWithCorrectedRecipient({
  requestId = '',
  newRecipientEmail = '',
  confirmed = false,
  overrideReason = '',
  requestedBy = '',
  storage = getStorage(),
} = {}) {
  const id = normalizeText(requestId, 160);
  const correctedEmail = normalizeEmail(newRecipientEmail);
  const reason = normalizeText(overrideReason, 500);
  const original = await storage.getDealHunterCimRequestById?.(id);

  if (!original) {
    return { ok: false, status: 404, error: 'CIM request not found.' };
  }

  const deliveryIssueStates = new Set(['bounced', 'failed', 'complained', 'suppressed']);
  if (original.status !== 'delivery_issue' || !deliveryIssueStates.has(original.delivery_state)) {
    return {
      ok: false,
      status: 409,
      error: 'Corrected-recipient retry is only available after a bounced or delivery-issue event.',
    };
  }

  if (!isValidEmail(correctedEmail)) {
    return { ok: false, status: 400, error: 'Enter a valid corrected recipient email.' };
  }
  if (correctedEmail === normalizeEmail(original.recipient_email)) {
    return { ok: false, status: 400, error: 'The corrected recipient must be different from the failed address.' };
  }

  const metadata = original.metadata && typeof original.metadata === 'object' ? original.metadata : {};
  const signedContacts = normalizeBrokerContacts(metadata.brokerContacts || []);
  const selectedContact = signedContacts.find((contact) => normalizeEmail(contact.email) === correctedEmail);
  const selectedFromSnapshot = Boolean(selectedContact);

  if (!selectedFromSnapshot && (!confirmed || reason.length < 5)) {
    return {
      ok: false,
      status: 400,
      error: 'A manually entered corrected address requires explicit confirmation and an override reason.',
    };
  }

  const requests = await loadDealHunterCimRequests(
    storage,
    [original.deal_key],
    original.opportunity_id ? [original.opportunity_id] : [],
  );
  const acceptedElsewhere = requests.find((request) => {
    if (request.id === original.id) return false;
    return (
      ['provider_accepted', 'responded'].includes(request.request_state) ||
      ['accepted', 'delivered', 'delayed', 'replied', 'development-only'].includes(request.delivery_state) ||
      ['sent', 'logged', 'responded'].includes(request.status)
    );
  });

  if (acceptedElsewhere) {
    return {
      ok: false,
      status: 409,
      error: 'Another accepted CIM request already exists for this deal. Duplicate first contact remains blocked.',
      request: acceptedElsewhere,
    };
  }

  const correctedRecipient = {
    originalRecipientEmail: normalizeEmail(original.recipient_email),
    correctedRecipientEmail: correctedEmail,
    selectedFromSignedSnapshot: selectedFromSnapshot,
    confirmed: selectedFromSnapshot ? false : Boolean(confirmed),
    overrideReason: selectedFromSnapshot ? '' : reason,
    correctedBy: normalizeText(requestedBy, 160) || 'admin',
    correctedAt: new Date().toISOString(),
  };
  const deal = {
    ...dealFromCimRequest(original),
    brokerEmail: correctedEmail,
    brokerName: selectedContact?.name || metadata.brokerName || '',
    annualProfit: metadata.annualProfit ?? 0,
    score: Number(original.score || cimRequestScoreThreshold),
    shouldRemove: false,
  };
  const result = await sendCimRequestForScoredDeal({
    deal,
    requestedBy,
    storage,
    retryOfRequest: original,
    correctedRecipient,
  });

  if (result.request?.id) {
    await upsertCimRequestWithActivity(storage, {
      ...original,
      request_state: 'stopped',
      follow_up_state: 'stopped',
      next_follow_up_at: null,
      updated_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      metadata: {
        ...metadata,
        correctedRetryRequestId: result.request.id,
        correctedRecipient,
      },
    }, {
      eventType: 'cim.corrected-recipient-retry',
      summary: result.ok
        ? 'CIM request retried with a corrected recipient.'
        : 'Corrected-recipient CIM retry attempted but was not accepted.',
      actor: requestedBy,
      metadata: {
        retryRequestId: result.request.id,
        correctedRecipientEmail: correctedEmail,
        selectedFromSignedSnapshot: selectedFromSnapshot,
        overrideReason: selectedFromSnapshot ? '' : reason,
      },
    });
  }

  return result;
}

function normalizeCimRequestSelections(selections = []) {
  if (!Array.isArray(selections)) {
    return { valid: false, selections: [], error: 'CIM request selections must be an array.' };
  }

  if (selections.length === 0) {
    return { valid: false, selections: [], error: 'At least one signed CIM request selection is required.' };
  }

  const seen = new Set();
  const seenRecipients = new Set();
  const normalizedSelections = [];

  for (const selection of selections) {
    const dealKey = normalizeText(selection?.dealKey || selection?.deal_key, 1000);
    const recipientEmail = normalizeEmail(selection?.recipientEmail || selection?.recipient_email);
    const snapshotToken = selection?.snapshotToken || selection?.snapshot_token || selection?.deal?.cimRequest?.snapshotToken || '';
    const deal = verifyCimDealSnapshotToken(snapshotToken);
    const selectedContact = deal?.brokerContacts?.find((contact) => contact.email === recipientEmail);
    const recipientName = normalizeText(selectedContact?.name || selection?.recipientName || selection?.recipient_name, 160);
    const key = `${dealKey}|${recipientEmail}`;

    if (!deal || !dealKey || deal.dealKey !== dealKey || !isValidEmail(recipientEmail) || seen.has(key)) {
      return {
        valid: false,
        selections: [],
        error: 'One or more CIM request selections do not match the signed approval queue.',
      };
    }

    if (seenRecipients.has(recipientEmail)) {
      return {
        valid: false,
        selections: [],
        error: 'A bulk CIM operation may include only one initial email per recipient. Review the other opportunity separately.',
      };
    }

    seen.add(key);
    seenRecipients.add(recipientEmail);
    normalizedSelections.push({ dealKey, recipientEmail, recipientName, deal });
  }

  return { valid: true, selections: normalizedSelections.slice(0, cimBulkRequestMax), error: '' };
}

export function validateCimReviewDecisions(decisions = []) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { valid: false, decisions: [], error: 'At least one CIM review decision is required.' };
  }

  const validated = [];
  const seen = new Set();
  const stage2Policy = getCimStage2Policy(getConfig());

  for (const decision of decisions.slice(0, cimBulkRequestMax)) {
    const snapshotToken = decision?.snapshotToken || decision?.snapshot_token || '';
    const snapshot = verifyCimDealSnapshotToken(snapshotToken);
    const dealKey = normalizeText(decision?.dealKey || decision?.deal_key, 1000);
    const result = decision?.decision === 'approved' ? 'approved' : decision?.decision === 'rejected' ? 'rejected' : '';

    if (!snapshot || !snapshot.opportunityId || snapshot.identityStatus !== 'resolved' || !dealKey || snapshot.dealKey !== dealKey || seen.has(dealKey) || !result) {
      return { valid: false, decisions: [], error: 'One or more CIM review decisions do not match the signed approval queue.' };
    }

    const originalRecipientEmail = normalizeEmail(snapshot.brokerEmail);
    const finalRecipientEmail = result === 'approved'
      ? normalizeEmail(decision?.finalRecipientEmail || decision?.final_recipient_email || originalRecipientEmail)
      : originalRecipientEmail;
    const selectedContact = snapshot.brokerContacts?.find((contact) => contact.email === finalRecipientEmail);
    const finalRecipientName = result === 'approved'
      ? normalizeText(selectedContact?.name || decision?.finalRecipientName || decision?.final_recipient_name, 160)
      : '';

    if (!originalRecipientEmail || (result === 'approved' && !isValidEmail(finalRecipientEmail))) {
      return { valid: false, decisions: [], error: 'One or more CIM review recipients are invalid.' };
    }

    seen.add(dealKey);
    validated.push({
      dealKey,
      opportunityId: snapshot.opportunityId,
      dealName: snapshot.name,
      score: snapshot.score,
      decision: result,
      passReason: decision?.passReason || decision?.pass_reason || '',
      originalRecipientEmail,
      finalRecipientEmail,
      finalRecipientName,
      snapshotDigest: cimStage2SnapshotDigest(snapshot),
      evidenceVersion: 'cim-stage2-human-evidence-v2',
      ruleVersion: stage2Policy.rules.version,
      sourcePolicyVersion: stage2Policy.sourcePolicy.version,
      sourcePolicyHash: stage2Policy.sourcePolicyHash,
      sourceIds: [...new Set([
        snapshot.sourceId,
        ...(snapshot.sourceRecords || []).map((record) => record.sourceId),
      ].filter(Boolean))],
      stage2CohortEligible: assessCimStage2StaticCandidate(snapshot, { policy: stage2Policy }).eligible,
    });
  }

  return { valid: true, decisions: validated, error: '' };
}

function buildSelectionFailure(selection, error) {
  return {
    ok: false,
    alreadySent: false,
    status: 409,
    dealKey: selection.dealKey,
    dealName: '',
    recipientEmail: selection.recipientEmail,
    error,
    deal: null,
  };
}

function reviewHasSourceFailures(review = null) {
  return reviewHasRequiredSourceFailures(review)
    || (review?.sources || []).some((source) => source?.fetched === false || source?.error);
}

function reviewHasRequiredSourceFailures(review = null) {
  const requiredSources = (review?.sources || []).filter((source) => (
    source?.required === true
    || source?.sourceRole === 'required-primary'
    || String(source?.id || '').startsWith('sheet-')
  ));

  return requiredSources.length === 0
    || requiredSources.some((source) => source?.fetched === false || source?.error || Number(source?.rowCount || 0) <= 0);
}

export async function sendDealHunterReadyCimRequests({ requestedBy = '', limit = cimBulkRequestMax, selections = [], storage = getStorage() } = {}) {
  if (!storage.getDealHunterCimRequest || !storage.upsertDealHunterCimRequest) {
    return { ok: false, status: 500, error: 'CIM request tracking storage is not configured.' };
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || cimBulkRequestMax, cimBulkRequestMax));
  const selectionValidation = normalizeCimRequestSelections(selections);
  if (!selectionValidation.valid) {
    return {
      ok: false,
      status: 400,
      error: selectionValidation.error,
      review: null,
      results: [],
      sent: 0,
      alreadySent: 0,
      failed: 0,
      totalReady: 0,
      totalRequested: Array.isArray(selections) ? selections.length : 0,
    };
  }
  const selectedRecipients = selectionValidation.selections;
  const approvedDealsBySelection = new Map();
  let result = null;
  let allReadyDeals = [];
  let readyDeals = [];

  try {
    result = await buildDailyDealReview({ storage });
    allReadyDeals = result.scoredDeals
      .filter((deal) => deal.cimRequest?.canRequest)
      .sort(sortNewThenBest);
    readyDeals = allReadyDeals.slice(0, safeLimit);
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'Deal Hunter sources could not be reviewed. Review sources again before sending bulk CIM requests.',
      review: null,
      results: [],
      sent: 0,
      alreadySent: 0,
      failed: 0,
      totalReady: 0,
      totalRequested: selectedRecipients.length,
    };
  }

  if (reviewHasRequiredSourceFailures(result.review)) {
    return {
      ok: false,
      status: 503,
      error: 'Deal Hunter required-source review is incomplete. Restore every required Google Sheet and review again before sending bulk CIM requests.',
      review: result.review,
      results: [],
      sent: 0,
      alreadySent: 0,
      failed: 0,
      totalReady: 0,
      totalRequested: selectedRecipients.length,
      limited: false,
      limit: safeLimit,
    };
  }

  if (selectedRecipients.length > 0) {
    const readyByDealRecipient = new Map(
      allReadyDeals.map((deal) => [`${deal.dealKey}|${normalizeEmail(deal.brokerEmail)}`, deal]),
    );
    const readyByDealKey = new Map(allReadyDeals.map((deal) => [deal.dealKey, deal]));
    const validationFailures = [];

    readyDeals = selectedRecipients.map((selection) => {
      const exactDeal = readyByDealRecipient.get(`${selection.dealKey}|${selection.recipientEmail}`);
      const latestDeal = readyByDealKey.get(selection.dealKey);
      const snapshotMatches = selection.deal?.dealKey === selection.dealKey;
      const matchedDeal = exactDeal || (latestDeal && snapshotMatches
        ? { ...latestDeal, brokerEmail: selection.recipientEmail, brokerName: selection.recipientName || '' }
        : null);
      const deal = matchedDeal
        ? { ...matchedDeal, brokerEmail: selection.recipientEmail, brokerName: selection.recipientName || matchedDeal.brokerName || '' }
        : null;

      if (!deal) {
        validationFailures.push(
          buildSelectionFailure(
            selection,
            latestDeal
              ? 'The confirmed deal snapshot or broker recipient is no longer valid. Review sources again before sending.'
              : 'This deal was not available in the latest source review. Review sources again before sending.',
          ),
        );
        return null;
      }

      const unavailableReason = getCimRequestUnavailableReason(deal, selection.recipientEmail);
      if (unavailableReason) {
        validationFailures.push(buildSelectionFailure(selection, unavailableReason));
        return null;
      }

      approvedDealsBySelection.set(`${selection.dealKey}|${selection.recipientEmail}`, {
        ...selection.deal,
        brokerEmail: selection.recipientEmail,
        brokerName: selection.recipientName || (
          normalizeEmail(selection.deal?.brokerEmail) === selection.recipientEmail
            ? selection.deal?.brokerName || ''
            : ''
        ),
      });

      return deal;
    }).filter(Boolean);

    if (validationFailures.length > 0) {
      return {
        ok: false,
        status: 409,
        error: 'The CIM-ready list changed after the preview. Review sources again before sending broker emails.',
        review: result?.review || null,
        results: validationFailures,
        sent: 0,
        alreadySent: 0,
        failed: validationFailures.length,
        totalReady: allReadyDeals.length,
        totalRequested: selectedRecipients.length,
        limited: false,
        limit: safeLimit,
      };
    }
  }

  if (readyDeals.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'No CIM-ready 75+ deals are available. Review sources and confirm each deal has annual profit and a valid broker email.',
      review: result?.review || null,
      results: [],
      sent: 0,
      alreadySent: 0,
      failed: 0,
      totalReady: allReadyDeals.length,
      totalRequested: selectedRecipients.length,
    };
  }

  const results = [];

  for (const deal of readyDeals) {
    const approvedDeal = approvedDealsBySelection.get(`${deal.dealKey}|${normalizeEmail(deal.brokerEmail)}`) || null;
    const sendResult = await sendCimRequestForScoredDeal({ deal, approvedDeal, requestedBy, storage });
    results.push({
      ok: Boolean(sendResult.ok),
      alreadySent: Boolean(sendResult.alreadySent),
      status: sendResult.status || (sendResult.ok ? 200 : 400),
      dealKey: deal.dealKey,
      dealName: deal.name,
      recipientEmail: normalizeEmail(deal.brokerEmail),
      error: sendResult.error || sendResult.emailResult?.error || '',
      deal: sendResult.deal || null,
    });
  }

  const sent = results.filter((item) => item.ok && !item.alreadySent).length;
  const alreadySent = results.filter((item) => item.ok && item.alreadySent).length;
  const failed = results.filter((item) => !item.ok).length;
  const hasSuccessfulOutcome = sent + alreadySent > 0;
  const allFailed = failed > 0 && !hasSuccessfulOutcome;

  return {
    ok: !allFailed,
    status: allFailed ? 502 : 200,
    error: allFailed ? 'No CIM request emails were sent. Review the failed results before retrying.' : '',
    review: result?.review || null,
    results,
    sent,
    alreadySent,
    failed,
    totalReady: readyDeals.length,
    totalRequested: selectedRecipients.length,
    limited: selectedRecipients.length === 0 && (result?.review?.totals?.cimReady || 0) > readyDeals.length,
    limit: safeLimit,
  };
}

export async function runDealHunterCimFollowUps({
  storage = getStorage(),
  limit = 50,
  now = new Date(),
  settings = getCimFollowUpSettings(),
} = {}) {
  if (!storage.listDealHunterCimRequests || !storage.upsertDealHunterCimRequest) {
    return {
      ok: false,
      status: 500,
      error: 'CIM request tracking storage is not configured.',
    };
  }

  if (!settings.enabled) {
    return {
      ok: false,
      status: 409,
      error: 'CIM follow-ups are disabled. Set DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED=true before running live follow-ups.',
      reviewed: 0,
      sent: 0,
      responded: 0,
      stopped: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };
  }

  const outreachGate = await assertCimOutreachAllowed({ storage });
  if (!outreachGate.allowed) {
    return {
      ok: false,
      status: 409,
      error: outreachGate.error,
      reviewed: 0,
      sent: 0,
      responded: 0,
      stopped: 0,
      failed: 0,
      skipped: 0,
      results: [],
      outreachPause: outreachGate.status,
    };
  }

  if (getConfig().isProduction) {
    const emailReadiness = await getEmailReadiness({ storage });

    if (!emailReadiness.followUpsSafe) {
      return {
        ok: false,
        status: 409,
        error: 'CIM follow-ups are blocked until signed delivery webhooks and an end-to-end inbound reply test are verified.',
        reviewed: 0,
        sent: 0,
        responded: 0,
        stopped: 0,
        failed: 0,
        skipped: 0,
        results: [],
        emailReadiness,
      };
    }
  }

  if (settings.maxCount <= 0) {
    return {
      ok: true,
      status: 200,
      reviewed: 0,
      sent: 0,
      responded: 0,
      stopped: 0,
      failed: 0,
      skipped: 0,
      message: 'CIM follow-ups are disabled because max follow-up count is 0.',
      results: [],
    };
  }

  const sendWindow = evaluateCimFollowUpWindow({ now, settings });
  if (!sendWindow.allowed) {
    await recordCimSafetyMetric({ metric: 'outOfWindowDeferrals', storage, now }).catch(() => null);
    return {
      ok: true,
      status: 200,
      reviewed: 0,
      sent: 0,
      responded: 0,
      stopped: 0,
      failed: 0,
      skipped: 0,
      deferred: true,
      deferralReason: sendWindow.reason,
      message: sendWindow.reason === 'weekend'
        ? `CIM follow-ups are deferred until the next weekday in ${settings.timezone || 'America/Los_Angeles'}.`
        : `CIM follow-ups are deferred until the ${settings.sendWindowStart}-${settings.sendWindowEnd} business-hours window in ${settings.timezone || 'America/Los_Angeles'}.`,
      results: [],
    };
  }

  const nowIso = now.toISOString();
  const requests = await storage.listDealHunterCimRequests({
    statuses: cimRequestActiveStatuses,
    dueBefore: nowIso,
    limit,
  });
  const summary = {
    ok: true,
    status: 200,
    reviewed: requests.length,
    sent: 0,
    responded: 0,
    stopped: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  for (const request of requests) {
    try {
      const result = await processCimFollowUpRequest(storage, request, nowIso);
      summary.results.push({
        id: result.request?.id || request.id,
        dealKey: request.deal_key,
        dealName: request.deal_name,
        recipientEmail: request.recipient_email,
        status: result.status,
        followUpCount: result.request?.follow_up_count ?? request.follow_up_count,
        nextFollowUpAt: result.request?.next_follow_up_at || '',
        emailResult: result.emailResult || null,
      });

      if (result.status === 'sent') {
        summary.sent += 1;
      } else if (result.status === 'responded') {
        summary.responded += 1;
      } else if (result.status === 'stopped') {
        summary.stopped += 1;
      } else if (result.status === 'failed') {
        summary.failed += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        id: request.id,
        dealKey: request.deal_key,
        dealName: request.deal_name,
        recipientEmail: request.recipient_email,
        status: 'failed',
        error: error.message,
      });
    }
  }

  return summary;
}
