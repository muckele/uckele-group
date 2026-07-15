import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { sha256, signPayload, verifySignedPayload } from '../utils/security.js';
import {
  buildCimReplyToAddress,
  normalizeResendTagToken,
  sendDailyDealHunterEmail,
  sendDealHunterCimFollowUpEmail,
  sendDealHunterCimRequestEmail,
} from './delivery.js';
import { createManualSubmission } from './submissions.js';
import { commitCrmActivityMutation } from './activity.js';
import { getEmailReadiness } from './emailReadiness.js';

const defaultTimeoutMs = 45000;
const cimRequestScoreThreshold = 75;
const highFitScoreThreshold = 75;
const watchlistScoreThreshold = 60;
const cimRequestSentStatuses = ['sent', 'logged'];
const cimRequestActiveStatuses = ['sent', 'logged', 'failed', 'follow_up_failed', 'follow_up_pending'];
const cimRequestTerminalStatuses = ['sent', 'logged', 'responded', 'delivery_issue', 'follow_up_failed', 'follow_up_pending'];
const replyEventTypes = new Set(['replied', 'received']);
const stopFollowUpEventTypes = new Set(['bounced', 'complained', 'failed', 'unsubscribed']);
const cimBulkRequestMax = 25;
const cimClaimStaleMinutes = 30;
const cimSnapshotTtlMs = 1000 * 60 * 60 * 2;
const cimRequestSendLocks = new Set();
const cimFollowUpLocks = new Set();
const dealHunterCrmNotesHeading = 'Deal Hunter scoring profile';
const dealHunterCrmUserNotesHeading = 'User notes';
const dealHunterCrmGeneratedStartMarker = 'Deal Hunter generated notes';
const dealHunterCrmGeneratedEndMarker = 'End Deal Hunter generated notes';
const dealHunterCrmImportPendingStaleMinutes = 30;

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

function normalizeComparableText(value = '') {
  return normalizeText(value, 1000)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
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
  const timestamp = Date.parse(value || '');
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
  const listing = getField(rawRow, ['Listing', 'Listing URL', 'URL', 'Link', 'Deal Link', 'Business URL']);
  const listingUrl = normalizeUrl(listing?.url || listing);
  const city = normalizeText(getField(rawRow, ['City']), 80);
  const county = normalizeText(getField(rawRow, ['County']), 120);
  const state = normalizeText(getField(rawRow, ['State', 'Province']), 40).toUpperCase();
  const country = normalizeText(getField(rawRow, ['Country']), 40);
  const industry = normalizeText(getField(rawRow, ['Industry', 'Industries', 'Category', 'Business Type']), 500);
  const description = normalizeText(getField(rawRow, ['Description', 'Summary', 'Listing Description', 'Business Description', 'Notes']), 5000);
  const annualProfit = parseNumber(getField(rawRow, ['Annual Profit', 'Cash Flow', 'SDE', 'EBITDA', 'TTM EBITDA', 'Profit']));
  const annualRevenue = parseNumber(getField(rawRow, ['Annual Revenue', 'Revenue', 'TTM Revenue', 'Sales', 'Gross Revenue']));
  const askingPrice = parseNumber(getField(rawRow, ['Asking Price', 'Price', 'Purchase Price', 'List Price']));
  const profitMultiple = parseNumber(getField(rawRow, ['Profit Multiple', 'SDE Multiple', 'EBITDA Multiple', 'Multiple']));
  const yearsEstablished = parseNumber(getField(rawRow, ['Years Established', 'Years In Business', 'Business Age', 'Age']));
  const remoteFlag = normalizeText(getField(rawRow, ['Remote/Relocatable/Absentee-Run', 'Remote', 'Relocatable', 'Absentee', 'Absentee Run']), 100);
  const franchiseFlag = normalizeText(getField(rawRow, ['Franchise', 'Is Franchise', 'Include Franchises']), 100);
  const fiveYearsFlag = normalizeText(getField(rawRow, ['5+ Years In Business', '5+ Years', 'Five Years In Business']), 100);
  const brokerEmail = normalizeText(getField(rawRow, ['Broker Email', 'Contact Email', 'Email']), 200).toLowerCase();
  const brokerName = normalizeText(getField(rawRow, ['Broker Name', 'Contact Name', 'Broker']), 160);
  const brokerCompany = normalizeText(getField(rawRow, ['Broker Company', 'Company']), 160);
  const brokerContact = normalizeText(getField(rawRow, ['Broker Contact', 'Broker Phone', 'Phone', 'Contact Phone']), 200);
  const name = normalizeText(getField(rawRow, ['Name', 'Business Name', 'Company', 'Title', 'Listing Title']), 220) || 'Unnamed business';
  const dateAdded = parseDate(getField(rawRow, ['Date Added', 'Created', 'Added Date', 'Posted Date']));
  const lastUpdated = parseDate(getField(rawRow, ['Last Updated', 'Updated', 'Modified', 'Last Modified']));
  const id = normalizeText(getField(rawRow, ['ID', 'Record ID', 'Ad ID', 'Ad#']), 100) || source.rowId || '';
  const fullText = normalizeText([name, industry, description, city, county, state, remoteFlag, franchiseFlag].join(' '), 9000);

  return {
    id,
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
    yearsEstablished,
    remoteFlag,
    franchiseFlag,
    fiveYearsFlag,
    brokerEmail,
    brokerName,
    brokerCompany,
    brokerContact,
    listingUrl,
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

function addScoreCap(caps, cap, reason) {
  caps.push({ cap, reason });
}

function applyScoreCaps(score, caps, concerns) {
  let cappedScore = score;

  for (const item of caps) {
    if (cappedScore > item.cap) {
      cappedScore = item.cap;
    }

    if (item.reason) {
      concerns.push(item.reason);
    }
  }

  return cappedScore;
}

export function scoreDeal(deal) {
  const matches = {
    excluded: containsAny(deal.fullText, profile.excludedKeywords),
    preferred: containsAny(deal.fullText, profile.preferredKeywords),
    recurring: containsAny(deal.fullText, profile.recurringRevenueKeywords),
    commercial: containsAny(deal.fullText, profile.commercialCustomerKeywords),
    recession: containsAny(deal.fullText, profile.recessionProofKeywords),
    aiProof: containsAny(deal.fullText, profile.aiProofKeywords),
    management: containsAny(deal.fullText, profile.managementKeywords),
    capex: containsAny(deal.fullText, profile.capexKeywords),
    financeable: containsAny(deal.fullText, profile.financeableKeywords),
    ownerDependency: containsAny(deal.fullText, profile.ownerDependencyRiskKeywords),
    concentrationRisk: containsAny(deal.fullText, profile.customerConcentrationRiskKeywords),
    financialRisk: containsAny(deal.fullText, profile.financialRiskKeywords),
  };
  const strengths = [];
  const concerns = [];
  const removeReasons = [];
  const scoreCaps = [];
  let score = 28;

  if (matches.excluded.length > 0) {
    removeReasons.push(`Excluded category match: ${matches.excluded.slice(0, 4).join(', ')}`);
  }

  if (isYes(deal.franchiseFlag)) {
    removeReasons.push('Franchise listing, which is outside the current acquisition strategy.');
  }

  if (deal.annualProfit !== null) {
    if (deal.annualProfit >= profile.minAnnualProfit && deal.annualProfit <= profile.maxAnnualProfit) {
      score += 18;
      strengths.push('Annual profit is inside the target $300k-$750k range.');
    } else if (deal.annualProfit >= 200000 && deal.annualProfit < profile.minAnnualProfit) {
      score += 2;
      concerns.push('Profit is below the target floor; review only if recurring revenue and management depth are unusually strong.');
    } else if (deal.annualProfit < 200000) {
      score -= 22;
      addScoreCap(scoreCaps, 52, 'Profit is well below the current acquisition target and should not qualify as a high-fit deal.');
      concerns.push('Profit is well below the current acquisition target.');
    } else if (deal.annualProfit > 1000000) {
      score -= 12;
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Profit is materially above the target band and likely requires a different capital structure.');
      concerns.push('Profit is materially above the current target band and likely needs a larger equity check.');
    } else {
      score -= 4;
      concerns.push('Profit is above the current target band and may require a larger equity check.');
    }
  } else {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Annual profit is missing, so the listing cannot qualify as high fit yet.');
    concerns.push('Annual profit is missing.');
  }

  if (deal.yearsEstablished !== null) {
    if (deal.yearsEstablished >= 5) {
      score += 6;
      strengths.push('Business age clears the 5+ year preference.');
    } else {
      score -= 8;
      concerns.push('Business appears younger than the 5+ year preference.');
    }
  } else if (isYes(deal.fiveYearsFlag)) {
    score += 5;
    strengths.push('Source marks this as 5+ years in business.');
  }

  if (deal.profitMultiple !== null) {
    if (deal.profitMultiple > 0 && deal.profitMultiple <= 3.25) {
      score += 12;
      strengths.push('Profit multiple appears financeable for a self-funded/SBA-style acquisition.');
    } else if (deal.profitMultiple > 3.25 && deal.profitMultiple <= 4) {
      score += 5;
      strengths.push('Profit multiple may be workable if SBA, seller note, or investor structure checks out.');
    } else if (deal.profitMultiple > 4 && deal.profitMultiple <= 5) {
      score -= 8;
      addScoreCap(scoreCaps, 82, 'Profit multiple is above the preferred range; require strong financing and growth evidence.');
      concerns.push('Profit multiple is above the preferred range for the current buying strategy.');
    } else if (deal.profitMultiple > 5) {
      score -= 16;
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Profit multiple is too high for a high-fit rating without exceptional structure.');
      concerns.push('Profit multiple is high for the current buying strategy.');
    }
  } else if (deal.askingPrice && deal.annualProfit) {
    const impliedMultiple = deal.askingPrice / deal.annualProfit;

    if (impliedMultiple <= 3.25) {
      score += 10;
      strengths.push('Implied asking-price-to-profit multiple looks reasonable.');
    } else if (impliedMultiple <= 4) {
      score += 4;
      strengths.push('Implied multiple may be workable if financing terms are favorable.');
    } else if (impliedMultiple <= 5) {
      score -= 8;
      addScoreCap(scoreCaps, 82, 'Implied multiple is above the preferred range; require stronger diligence before advancing.');
      concerns.push('Implied asking-price-to-profit multiple is above the preferred range.');
    } else if (impliedMultiple > 5) {
      score -= 16;
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Implied multiple is too expensive for a high-fit rating.');
      concerns.push('Implied asking-price-to-profit multiple looks expensive.');
    }
  }

  if (deal.askingPrice) {
    if (deal.askingPrice >= 500000 && deal.askingPrice <= 1500000) {
      score += 7;
      strengths.push('Asking price is within a plausible range for ROBS cash plus SBA, seller note, or investors.');
    } else if (deal.askingPrice > 2000000) {
      score -= 14;
      addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'Asking price likely requires outside equity or unusually favorable seller financing.');
      concerns.push('Asking price likely needs outside equity or unusually favorable seller financing.');
    } else if (deal.askingPrice < 250000) {
      score -= 5;
      addScoreCap(scoreCaps, 66, 'Small asking price may indicate a smaller owner-operator opportunity.');
      concerns.push('Small asking price may indicate a smaller owner-operator opportunity.');
    }
  }

  if (matches.preferred.length > 0) {
    score += Math.min(10, matches.preferred.length * 2);
    strengths.push(`Matches preferred search themes: ${matches.preferred.slice(0, 5).join(', ')}.`);
  }

  if (matches.recurring.length > 0) {
    score += Math.min(14, matches.recurring.length * 3);
    strengths.push(`Recurring or repeat revenue signals: ${matches.recurring.slice(0, 4).join(', ')}.`);
  } else {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'No explicit recurring, contracted, scheduled, or repeat revenue signal.');
    concerns.push('No explicit recurring, contracted, scheduled, or repeat revenue signal.');
  }

  if (matches.commercial.length > 0) {
    score += Math.min(8, matches.commercial.length * 2);
    strengths.push(`Commercial or institutional customer signals: ${matches.commercial.slice(0, 4).join(', ')}.`);
  }

  if (matches.recession.length > 0) {
    score += Math.min(12, matches.recession.length * 3);
    strengths.push(`Recession-resistant indicators: ${matches.recession.slice(0, 4).join(', ')}.`);
  } else {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'No clear recession-resistant indicator in the listing text.');
    concerns.push('No clear recession-resistant indicator in the listing text.');
  }

  if (matches.aiProof.length > 0) {
    score += Math.min(12, matches.aiProof.length * 3);
    strengths.push(`AI-resistant operating work: ${matches.aiProof.slice(0, 4).join(', ')}.`);
  } else {
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, 'No clear physical, field-service, regulated, or relationship-heavy work signal.');
    concerns.push('No clear physical, field-service, regulated, or relationship-heavy work signal.');
  }

  if (matches.management.length > 0 || /yes/i.test(deal.remoteFlag)) {
    score += 7;
    strengths.push('Remote, absentee, turnkey, staff, or management signal exists.');
  } else {
    concerns.push('Management in place is not shown; this is acceptable but needs diligence.');
  }

  if (matches.capex.length > 0) {
    score -= Math.min(12, matches.capex.length * 3);
    addScoreCap(scoreCaps, 82, 'Capex or asset-heavy language requires extra diligence before high conviction.');
    concerns.push(`Possible capex or asset-heavy concern: ${matches.capex.slice(0, 4).join(', ')}.`);
  }

  if (matches.financeable.length > 0) {
    score += Math.min(6, matches.financeable.length * 2);
    strengths.push(`Financing support signals: ${matches.financeable.slice(0, 3).join(', ')}.`);
  }

  if (matches.ownerDependency.length > 0) {
    score -= Math.min(12, matches.ownerDependency.length * 4);
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, `Owner-dependency risk language found: ${matches.ownerDependency.slice(0, 3).join(', ')}.`);
  }

  if (matches.concentrationRisk.length > 0) {
    score -= Math.min(12, matches.concentrationRisk.length * 4);
    addScoreCap(scoreCaps, highFitScoreThreshold - 1, `Customer concentration risk language found: ${matches.concentrationRisk.slice(0, 3).join(', ')}.`);
  }

  const nonCapexFinancialRisks = matches.financialRisk.filter((term) => !matches.capex.includes(term) && !matches.concentrationRisk.includes(term));

  if (nonCapexFinancialRisks.length > 0) {
    score -= Math.min(10, nonCapexFinancialRisks.length * 3);
    addScoreCap(scoreCaps, 72, `Financial quality risk language found: ${nonCapexFinancialRisks.slice(0, 3).join(', ')}.`);
  }

  if (deal.state && profile.targetStates.includes(deal.state)) {
    score += 3;
    strengths.push(`Located in target state ${deal.state}.`);
  } else if (/yes/i.test(deal.remoteFlag)) {
    score += 3;
    strengths.push('Location concern reduced because the listing is remote, relocatable, or absentee-run.');
  }

  if (removeReasons.length > 0) {
    score = Math.min(score, 34);
  } else if (deal.annualProfit === null) {
    score = Math.min(score, highFitScoreThreshold - 1);
  }

  score = applyScoreCaps(score, scoreCaps, concerns);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const shouldRemove = removeReasons.length > 0 || score < 45;
  const recommendation = shouldRemove
    ? 'Remove from tomorrow\'s daily update unless there is a specific strategic reason to keep it.'
    : score >= highFitScoreThreshold
      ? 'High fit. Request the CIM/NDA process and validate financial quality before advancing.'
      : 'Watchlist. Worth reviewing only if the broker confirms recurring revenue, AI/recession resistance, management depth, and clean financing terms.';

  return {
    ...deal,
    score,
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

  const headers = rows[0].map((header) => normalizeText(header, 160));
  return rows.slice(1).map((values) =>
    headers.reduce((record, header, index) => {
      record[header || `Column ${index + 1}`] = normalizeText(values[index] || '', 5000);
      return record;
    }, {}),
  );
}

function formatPayloadLimitError(byteLength, maxBytes) {
  const sizeMb = (byteLength / (1024 * 1024)).toFixed(1);
  const limitMb = (maxBytes / (1024 * 1024)).toFixed(1);
  const error = new Error(
    `Airtable shared view is too large to import safely (${sizeMb} MB, limit ${limitMb} MB). Set DEAL_HUNTER_AIRTABLE_TOKEN so the app can use Airtable's paged API instead of the oversized shared view.`,
  );

  error.code = 'AIRTABLE_SHARED_VIEW_PAYLOAD_LIMIT';
  error.requiresConfiguration = true;
  error.configurationKey = 'DEAL_HUNTER_AIRTABLE_TOKEN';

  return error;
}

async function readResponseText(response, maxBytes = Infinity) {
  const contentLength = Number(response.headers.get('content-length') || 0);

  if (Number.isFinite(maxBytes) && contentLength > maxBytes) {
    throw formatPayloadLimitError(contentLength, maxBytes);
  }

  if (!Number.isFinite(maxBytes) || !response.body?.getReader) {
    const text = await response.text();
    const byteLength = Buffer.byteLength(text, 'utf8');

    if (Number.isFinite(maxBytes) && byteLength > maxBytes) {
      throw formatPayloadLimitError(byteLength, maxBytes);
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
      throw formatPayloadLimitError(byteLength, maxBytes);
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

async function fetchText(url, { headers = {}, timeoutMs = defaultTimeoutMs, maxBytes = Infinity } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await readResponseText(response, 16 * 1024).catch(() => '');
      throw new Error(`Fetch failed with ${response.status}: ${text.slice(0, 180)}`);
    }

    return await readResponseText(response, maxBytes);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, { headers = {}, timeoutMs = defaultTimeoutMs, maxBytes = Infinity } = {}) {
  const text = await fetchText(url, { headers, timeoutMs, maxBytes });
  return JSON.parse(text);
}

export function parseSheetCsvDeals(csv, sourceIndex = 0, maxRecords = Infinity) {
  const safeMaxRecords = Number.isFinite(maxRecords) ? Math.max(0, maxRecords) : Infinity;
  const rows = parseCsvRows(csv).slice(0, safeMaxRecords);

  return {
    source: {
      id: `sheet-${sourceIndex}`,
      name: sourceIndex === 0 ? 'SMB Deal Hunter Google Sheet' : `Google Sheet ${sourceIndex + 1}`,
      mode: 'csv',
      fetched: true,
      rowCount: rows.length,
    },
    deals: rows.map((row, index) => normalizeDealRecord(row, { id: `sheet-${sourceIndex}`, name: 'SMB Deal Hunter Google Sheet', mode: 'csv', rowId: String(index + 1) })),
  };
}

async function fetchSheetCsvDeals(url, sourceIndex, config) {
  const csv = await fetchText(url, {
    maxBytes: config.dealHunter.sheetCsvMaxPayloadBytes,
  });
  const result = parseSheetCsvDeals(csv, sourceIndex, config.dealHunter.maxSourceRecords);

  return {
    ...result,
    source: {
      ...result.source,
      url,
    },
  };
}

function buildAirtableEmbedUrl(sharedViewUrl) {
  const url = new URL(sharedViewUrl);

  if (url.pathname.startsWith('/embed/')) {
    return url.toString();
  }

  const baseId = url.pathname.match(/app[A-Za-z0-9]+/)?.[0];
  const shareId = url.pathname.match(/shr[A-Za-z0-9]+/)?.[0];

  if (!baseId || !shareId) {
    throw new Error('Airtable shared view URL must include both app... and shr... ids.');
  }

  return `https://airtable.com/embed/${baseId}/${shareId}?viewControls=on`;
}

function decodeAirtableEmbeddedPath(value = '') {
  return value
    .replaceAll('\\u002F', '/')
    .replaceAll('\\u0026', '&')
    .replaceAll('&amp;', '&');
}

function extractAirtableSharedDataPath(html = '') {
  const urlWithParamsMatch = html.match(/urlWithParams:\s*"([^"]+readSharedViewData[^"]+)"/);

  if (urlWithParamsMatch) {
    return decodeAirtableEmbeddedPath(urlWithParamsMatch[1]);
  }

  const fetchMatch = html.match(/fetch\("([^"]+readSharedViewData[^"]+)"/);
  return fetchMatch ? decodeAirtableEmbeddedPath(fetchMatch[1]) : '';
}

function normalizeAirtableCell(column, value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAirtableCell(column, item)).filter((item) => normalizeText(item) !== '');
  }

  if (value && typeof value === 'object') {
    if (value.url) {
      return {
        label: normalizeText(value.label || 'View Listing', 100),
        url: normalizeUrl(value.url),
      };
    }

    return normalizeText(Object.values(value).join(' '), 1000);
  }

  if (column?.typeOptions?.choices?.[value]) {
    return column.typeOptions.choices[value].name;
  }

  return value;
}

function mapAirtableSharedPayload(payload, source, maxRecords = Infinity) {
  const table = payload?.data?.table || {};
  const columnsById = Object.fromEntries((table.columns || []).map((column) => [column.id, column]));
  const rows = (Array.isArray(table.rows) ? table.rows : []).slice(0, maxRecords);

  return rows.map((row) => {
    const namedRow = Object.entries(row.cellValuesByColumnId || {}).reduce((record, [columnId, value]) => {
      const column = columnsById[columnId];
      record[column?.name || columnId] = normalizeAirtableCell(column, value);
      return record;
    }, {});

    return normalizeDealRecord(namedRow, {
      ...source,
      rowId: row.id,
    });
  });
}

async function fetchAirtableSharedDeals(url, maxRecords, maxPayloadBytes) {
  const embedUrl = buildAirtableEmbedUrl(url);
  const html = await fetchText(embedUrl);
  const dataPath = extractAirtableSharedDataPath(html);
  const applicationId = html.match(/"x-airtable-application-id":"([^"]+)"/)?.[1] || html.match(/"singleApplicationId":"([^"]+)"/)?.[1] || '';

  if (!dataPath) {
    throw new Error('Airtable shared view did not expose a readable shared-view data endpoint.');
  }

  const payload = await fetchJson(
    new URL(dataPath, 'https://airtable.com').toString(),
    {
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        'x-user-locale': 'en',
        'x-time-zone': 'America/Los_Angeles',
        ...(applicationId ? { 'x-airtable-application-id': applicationId } : {}),
      },
      maxBytes: maxPayloadBytes,
    },
  );
  const source = {
    id: 'airtable-shared',
    name: payload?.data?.sharedModelName || 'Airtable Biz List',
    mode: 'shared-view',
    url,
    fetched: true,
  };
  const deals = mapAirtableSharedPayload(payload, source, maxRecords);

  return {
    source: {
      ...source,
      rowCount: deals.length,
    },
    deals,
  };
}

async function fetchAirtableApiDeals(config) {
  const records = [];
  let offset = '';
  const baseUrl = `https://api.airtable.com/v0/${encodeURIComponent(config.dealHunter.airtableBaseId)}/${encodeURIComponent(config.dealHunter.airtableTableId)}`;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set('pageSize', '100');

    if (config.dealHunter.airtableViewId) {
      url.searchParams.set('view', config.dealHunter.airtableViewId);
    }

    if (offset) {
      url.searchParams.set('offset', offset);
    }

    const payload = await fetchJson(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.dealHunter.airtableToken}`,
      },
    });

    records.push(...(payload.records || []));
    offset = payload.offset || '';
  } while (offset && records.length < config.dealHunter.maxSourceRecords);

  return {
    source: {
      id: 'airtable-api',
      name: 'Airtable Biz List',
      mode: 'api',
      url: config.dealHunter.airtableSharedViewUrl,
      fetched: true,
      rowCount: records.length,
    },
    deals: records
      .slice(0, config.dealHunter.maxSourceRecords)
      .map((record) => normalizeDealRecord(record.fields || {}, { id: 'airtable-api', name: 'Airtable Biz List', mode: 'api', rowId: record.id })),
  };
}

async function collectSources(config) {
  const sourceResults = [];

  for (const [index, url] of config.dealHunter.sheetCsvUrls.entries()) {
    try {
      sourceResults.push(await fetchSheetCsvDeals(url, index, config));
    } catch (error) {
      sourceResults.push({
        source: {
          id: `sheet-${index}`,
          name: index === 0 ? 'SMB Deal Hunter Google Sheet' : `Google Sheet ${index + 1}`,
          mode: 'csv',
          url,
          fetched: false,
          rowCount: 0,
          error: error.message,
        },
        deals: [],
      });
    }
  }

  if (config.dealHunter.airtableToken && config.dealHunter.airtableBaseId && config.dealHunter.airtableTableId) {
    try {
      sourceResults.push(await fetchAirtableApiDeals(config));
    } catch (error) {
      sourceResults.push({
        source: {
          id: 'airtable-api',
          name: 'Airtable Biz List',
          mode: 'api',
          url: config.dealHunter.airtableSharedViewUrl,
          fetched: false,
          rowCount: 0,
          error: error.message,
        },
        deals: [],
      });
    }
  } else if (config.dealHunter.airtableSharedViewUrl) {
    try {
      sourceResults.push(
        await fetchAirtableSharedDeals(
          config.dealHunter.airtableSharedViewUrl,
          config.dealHunter.maxSourceRecords,
          config.dealHunter.airtableSharedMaxPayloadBytes,
        ),
      );
    } catch (error) {
      sourceResults.push({
        source: {
          id: 'airtable-shared',
          name: 'Airtable Biz List',
          mode: 'shared-view',
          url: config.dealHunter.airtableSharedViewUrl,
          fetched: false,
          rowCount: 0,
          error: error.message,
          requiresConfiguration: Boolean(error.requiresConfiguration),
          configurationKey: error.configurationKey || '',
        },
        deals: [],
      });
    }
  }

  return sourceResults;
}

function dedupeDeals(deals) {
  const seen = new Set();
  const deduped = [];

  for (const deal of deals) {
    const key = buildDealKey(deal);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(deal);
  }

  return deduped;
}

function buildDealKey(deal) {
  const listingUrl = normalizeUrl(deal.listingUrl).toLowerCase();

  if (listingUrl) {
    return `url:${listingUrl}`;
  }

  const externalId = normalizeIdentityPart(deal.id, 120);

  if (deal.sourceId && externalId && !/^\d+$/.test(externalId)) {
    return `source:${deal.sourceId}:${externalId}`;
  }

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
    dealKey: deal.dealKey,
    sourceId: deal.sourceId,
    sourceName: deal.sourceName,
    sourceMode: deal.sourceMode,
    name: deal.name,
    isNew: Boolean(deal.isNew),
    firstSeenAt: deal.firstSeenAt,
    lastSeenAt: deal.lastSeenAt,
    score: deal.score,
    industry: deal.industry,
    location: deal.location,
    annualProfit: deal.annualProfit,
    annualRevenue: deal.annualRevenue,
    askingPrice: deal.askingPrice,
    profitMultiple: deal.profitMultiple,
    yearsEstablished: deal.yearsEstablished,
    remoteFlag: deal.remoteFlag,
    franchiseFlag: deal.franchiseFlag,
    brokerName: deal.brokerName,
    brokerCompany: deal.brokerCompany,
    brokerContact: deal.brokerContact,
    brokerEmail: deal.brokerEmail,
    listingUrl: deal.listingUrl,
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

function normalizeCimDealSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const cimRequest = snapshot.cimRequest && typeof snapshot.cimRequest === 'object' ? snapshot.cimRequest : {};
  const dealKey = normalizeText(snapshot.dealKey || snapshot.deal_key, 1000);
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
    dealKey,
    sourceId: normalizeText(snapshot.sourceId || snapshot.source_id, 200),
    sourceName: normalizeText(snapshot.sourceName || snapshot.source_name, 200),
    sourceMode: normalizeText(snapshot.sourceMode || snapshot.source_mode, 100),
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
    listingUrl: normalizeUrl(snapshot.listingUrl || snapshot.listing_url),
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

function attachHistory(scoredDeals, seenDeals = [], generatedAt) {
  const seenById = new Map(seenDeals.map((deal) => [deal.id, deal]));

  return scoredDeals.map((deal) => {
    const dealKey = buildDealKey(deal);
    const seen = seenById.get(dealKey);

    return {
      ...deal,
      dealKey,
      isNew: !seen,
      firstSeenAt: seen?.first_seen_at || generatedAt,
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

function dealHunterCrmNotes(deal) {
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
    deal.yearsEstablished ? `Years established: ${formatYearsForCrm(deal.yearsEstablished)}` : '',
    deal.remoteFlag ? `Remote / absentee / relocatable: ${deal.remoteFlag}` : '',
    deal.listingUrl ? `Listing URL: ${deal.listingUrl}` : '',
    '',
    'Broker / contact',
    deal.brokerName ? `Broker name: ${deal.brokerName}` : '',
    deal.brokerCompany ? `Broker company: ${deal.brokerCompany}` : '',
    deal.brokerEmail ? `Broker email: ${deal.brokerEmail}` : '',
    deal.brokerContact ? `Broker phone/contact: ${deal.brokerContact}` : '',
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

  return {
    dealHunter: {
      managed,
      linkedToExistingCrmRecord: Boolean(options.linkedToExistingCrmRecord),
      dealKey: deal.dealKey || '',
      score: deal.score,
      sourceName: deal.sourceName || '',
      sourceMode: deal.sourceMode || '',
      sourceId: deal.sourceId || '',
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
      generatedNotes,
      raw: deal.raw || {},
    },
  };
}

function dealHunterCrmPayload(deal, options = {}) {
  const hasBrokerContact = Boolean(deal.brokerName || deal.brokerEmail || deal.brokerContact);
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
    business_age: formatYearsForCrm(deal.yearsEstablished),
    broker_name: deal.brokerName || deal.brokerCompany || '',
    broker_email: deal.brokerEmail || '',
    broker_phone: deal.brokerContact || '',
    lead_type: hasBrokerContact ? 'broker' : 'prospect',
    status: 'review',
    priority: deal.score >= 85 ? 'urgent' : 'high',
    follow_up_state: 'needs-response',
    source: 'deal-hunter-daily-review',
    tags: ['deal-hunter', 'score-75-plus', 'high-fit', sourceTag].filter(Boolean),
    notes: mergeDealHunterCrmNotes('', generatedNotes),
    message: `High-fit Deal Hunter listing imported into the CRM with score ${deal.score}/100.`,
    metadata: dealHunterCrmMetadata(deal, options),
  };
}

async function findExistingDealHunterSubmission(storage, deal) {
  if (deal.listingUrl && storage.getSubmissionByListingUrl) {
    const existingByListingUrl = await storage.getSubmissionByListingUrl(deal.listingUrl);

    if (existingByListingUrl) {
      return existingByListingUrl;
    }
  }

  if (deal.dealKey && storage.listSubmissions) {
    const result = await storage.listSubmissions({ limit: 10, page: 1, search: deal.dealKey, status: 'all' });
    const rows = result?.rows || [];
    return rows.find((row) => row?.metadata?.dealHunter?.dealKey === deal.dealKey || String(row?.notes || '').includes(deal.dealKey)) || null;
  }

  return null;
}

async function upsertCimRequestWithActivity(storage, request, { eventType, summary, actor, metadata = {} } = {}) {
  const submission = await findExistingDealHunterSubmission(storage, {
    dealKey: request.dealKey || request.deal_key,
    listingUrl: request.listingUrl || request.listing_url,
  });

  if (!submission) {
    return storage.upsertDealHunterCimRequest(request);
  }

  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'upsert_deal_hunter_cim_request',
    payload: { request },
    activity: {
      submissionId: submission.id,
      eventType,
      summary,
      actor: actor || 'deal-hunter',
      role: 'admin',
      metadata: { cimRequestId: request.id, ...metadata },
    },
  });

  if (!mutation.applied || !mutation.record) {
    throw new Error('CIM request state changed before its activity could be saved.');
  }

  return mutation.record;
}

function isDealHunterManagedSubmission(existing = {}) {
  return existing.source === 'deal-hunter-daily-review' || existing.metadata?.dealHunter?.managed === true;
}

function chooseDealHunterCrmValue(existing, payload, field, preserveExistingFields) {
  return preserveExistingFields
    ? existing[field] || payload[field] || ''
    : payload[field] || existing[field] || '';
}

function dealHunterCrmUpdate(existing, deal, options = {}) {
  const preserveExistingFields = Boolean(options.preserveExistingFields);
  const managed = !preserveExistingFields;
  const payload = dealHunterCrmPayload(deal, {
    managed,
    linkedToExistingCrmRecord: preserveExistingFields,
  });
  const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
  const existingPriority = normalizeText(existing.priority, 80);

  return {
    updated_at: new Date().toISOString(),
    listing_url: chooseDealHunterCrmValue(existing, payload, 'listing_url', preserveExistingFields),
    asking_price: chooseDealHunterCrmValue(existing, payload, 'asking_price', preserveExistingFields),
    ttm_revenue: chooseDealHunterCrmValue(existing, payload, 'ttm_revenue', preserveExistingFields),
    ttm_ebitda: chooseDealHunterCrmValue(existing, payload, 'ttm_ebitda', preserveExistingFields),
    ebitda_multiple: chooseDealHunterCrmValue(existing, payload, 'ebitda_multiple', preserveExistingFields),
    business_age: chooseDealHunterCrmValue(existing, payload, 'business_age', preserveExistingFields),
    broker_name: chooseDealHunterCrmValue(existing, payload, 'broker_name', preserveExistingFields),
    broker_email: chooseDealHunterCrmValue(existing, payload, 'broker_email', preserveExistingFields),
    broker_phone: chooseDealHunterCrmValue(existing, payload, 'broker_phone', preserveExistingFields),
    priority: preserveExistingFields && existingPriority && existingPriority !== 'normal' ? existingPriority : payload.priority,
    tags: Array.from(new Set([...existingTags, ...payload.tags])),
    notes: mergeDealHunterCrmNotes(existing.notes, payload.notes),
    metadata: {
      ...(existing.metadata || {}),
      ...payload.metadata,
    },
  };
}

async function updateDealHunterCrmSubmission(storage, existing, deal, { preserveExistingFields = false } = {}) {
  const values = dealHunterCrmUpdate(existing, deal, { preserveExistingFields });
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'update_submission',
    payload: { id: existing.id, values },
    activity: {
      submissionId: existing.id,
      eventType: 'submission.deal-hunter-synced',
      summary: preserveExistingFields
        ? 'Existing CRM record enriched from Deal Hunter.'
        : 'Deal Hunter CRM record refreshed from its listing.',
      actor: 'deal-hunter',
      role: 'system',
      metadata: {
        dealKey: deal.dealKey || '',
        listingUrl: deal.listingUrl || '',
        changedFields: Object.keys(values).filter((field) => field !== 'updated_at'),
      },
    },
  });

  if (!mutation.applied || !mutation.record) {
    throw new Error('Deal Hunter CRM record changed before its activity could be saved.');
  }

  return mutation.record;
}

function buildDealHunterCrmImportRecord(deal, submissionId = '', status = 'pending') {
  const listingIdentity = normalizeListingIdentity(deal.listingUrl);
  const importIdentity = listingIdentity || deal.dealKey || normalizeIdentityPart([deal.sourceName, deal.name, deal.location].join('|'), 1000);
  const now = new Date().toISOString();

  return {
    id: sha256(`deal-hunter-crm-import:${importIdentity}`),
    created_at: now,
    updated_at: now,
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

async function syncHighFitDealsToCrm(scoredDeals = [], storage = getStorage()) {
  const candidates = scoredDeals.filter(
    (deal) => !deal.shouldRemove && deal.score >= cimRequestScoreThreshold && deal.annualProfit !== null,
  );
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

      if (storage.claimDealHunterCrmImport) {
        let claim = null;

        try {
          claim = await storage.claimDealHunterCrmImport(proposedImportRecord, { pendingCutoff });
        } catch (error) {
          console.warn(`[deal-hunter] CRM import claim failed; continuing without duplicate claim: ${error.message}`);
        }

        importRecord = claim?.importRecord || proposedImportRecord;

        if (claim && !claim.claimed) {
          const claimedSubmission = importRecord?.submission_id && storage.getSubmission
            ? await storage.getSubmission(importRecord.submission_id)
            : null;

          if (claimedSubmission && storage.updateSubmission) {
            const preserveExistingFields = !isDealHunterManagedSubmission(claimedSubmission);
            const updated = await updateDealHunterCrmSubmission(storage, claimedSubmission, deal, { preserveExistingFields });
            const status = preserveExistingFields ? 'enriched' : 'updated';
            summary[status] += 1;
            summary.results.push({ dealKey: deal.dealKey, status, submissionId: updated?.id || claimedSubmission.id });
          } else {
            summary.skipped += 1;
            summary.results.push({ dealKey: deal.dealKey, status: 'duplicate-in-progress', submissionId: importRecord?.submission_id || '' });
          }

          continue;
        }
      } else {
        importRecord = proposedImportRecord;
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
        } else {
          summary.skipped += 1;
          summary.results.push({ dealKey: deal.dealKey, status: 'duplicate-no-update', submissionId: existing.id });
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

function buildCimRequestId(dealKey, recipientEmail) {
  return sha256(`deal-hunter-cim-request:${dealKey}:${normalizeEmail(recipientEmail)}`);
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

function emailSubjectLooksLikeCimReply(event, request) {
  const subject = normalizeComparableText(event?.subject || '');

  if (!subject) {
    return false;
  }

  const dealName = normalizeComparableText(normalizeText(request?.deal_name || '', 160));

  return Boolean(dealName && subject.includes(dealName));
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

    if (emailSubjectLooksLikeCimReply(event, request)) {
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

function getCimRequestUnavailableReason(deal, recipientEmail) {
  if (!deal?.dealKey) {
    return 'Deal tracking key is missing.';
  }

  if (deal.shouldRemove) {
    return 'Deal is marked for removal and should not receive outreach.';
  }

  if (deal.score < cimRequestScoreThreshold) {
    return `Score must be ${cimRequestScoreThreshold}+ before requesting a CIM.`;
  }

  if (deal.annualProfit === null) {
    return 'Annual profit is missing; confirm trailing SDE or EBITDA before requesting a CIM.';
  }

  if (!recipientEmail) {
    return 'No broker or contact email is available for this listing.';
  }

  if (!isValidEmail(recipientEmail)) {
    return 'Broker or contact email is not valid.';
  }

  return '';
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

function attachCimRequestStatus(scoredDeals, requests = []) {
  const requestsByDealRecipient = mapCimRequestsByDealRecipient(requests);

  return scoredDeals.map((deal) => {
    const recipientEmail = normalizeEmail(deal.brokerEmail);
    const existingRequest = requestsByDealRecipient.get(`${deal.dealKey}|${recipientEmail}`);
    const reason = getCimRequestUnavailableReason(deal, recipientEmail);
    const eligible = reason === '';
    const completed = isCompletedCimStatus(existingRequest?.status);

    return {
      ...deal,
      cimRequest: {
        eligible,
        canRequest: eligible && !completed && !isRecentPendingCimRequest(existingRequest),
        status: existingRequest?.status || (eligible ? 'ready' : 'unavailable'),
        reason,
        recipientEmail,
        snapshotToken: eligible ? signCimDealSnapshot(deal) : '',
        requestedAt: existingRequest?.updated_at || '',
        requestedBy: existingRequest?.requested_by || '',
        deliveryError: existingRequest?.delivery_error || '',
        providerMessageId: existingRequest?.provider_message_id || '',
        subject: existingRequest?.subject || '',
        followUpCount: Number(existingRequest?.follow_up_count || 0),
        lastFollowUpAt: existingRequest?.last_follow_up_at || '',
        nextFollowUpAt: existingRequest?.next_follow_up_at || '',
        respondedAt: existingRequest?.responded_at || '',
      },
    };
  });
}

async function loadDealHunterCimRequests(storage, dealKeys) {
  if (!storage.listDealHunterCimRequests) {
    return [];
  }

  try {
    return await storage.listDealHunterCimRequests({ dealKeys, limit: 5000 });
  } catch (error) {
    console.warn(`[deal-hunter] CIM request history lookup failed: ${error.message}`);
    return [];
  }
}

function buildCimRequestRecord({ deal, recipientEmail, requestedBy = '', emailResult = {}, existingRequest = null }) {
  const now = new Date().toISOString();
  const businessName = normalizeText(deal.name || 'Unnamed business', 220);
  const status = emailResult.status || 'pending';
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
  const requestId = buildCimRequestId(deal.dealKey, recipientEmail);
  const replyToAddress = buildCimReplyToAddress({
    requestId,
    replyTo: getConfig().delivery.resendReplyTo || '',
  });
  const nextFollowUpAt = nextCimFollowUpAt({
    status,
    followUpCount,
    lastTouchAt: now,
  });

  return {
    id: requestId,
    created_at: existingRequest?.created_at || now,
    updated_at: now,
    deal_key: deal.dealKey,
    recipient_email: normalizeEmail(recipientEmail),
    requested_by: normalizeText(requestedBy, 160),
    status,
    delivery_error: emailResult.error || '',
    provider_message_id: emailResult.providerMessageId || '',
    subject: `CIM / NDA request for ${businessName}`,
    deal_name: businessName,
    source_name: deal.sourceName || '',
    listing_url: deal.listingUrl || '',
    score: deal.score,
    follow_up_count: followUpCount,
    last_follow_up_at: existingRequest?.last_follow_up_at || null,
    next_follow_up_at: nextFollowUpAt,
    responded_at: existingRequest?.responded_at || null,
    metadata: {
      ...existingMetadata,
      industry: deal.industry || '',
      location: deal.location || '',
      annualProfit: deal.annualProfit,
      annualRevenue: deal.annualRevenue,
      askingPrice: deal.askingPrice,
      profitMultiple: deal.profitMultiple,
      brokerName: deal.brokerName || '',
      brokerCompany: deal.brokerCompany || '',
      brokerContact: deal.brokerContact || '',
      recommendation: deal.recommendation || '',
      strengths: deal.strengths || [],
      concerns: deal.concerns || [],
      questions: deal.questions || [],
      replyToAddress: existingMetadata.replyToAddress || replyToAddress,
      providerMessageIds,
    },
  };
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
      delivery_error: '',
      responded_at: respondedAt,
      next_follow_up_at: null,
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
      delivery_error: `Follow-ups stopped because the email event was ${eventType}.`,
      next_follow_up_at: null,
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

function buildCimFollowUpUpdate(request, emailResult, followUpNumber, sentAt) {
  const settings = getCimFollowUpSettings();
  const sent = ['sent', 'logged'].includes(emailResult.status);
  const existingMetadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  const existingFollowUps = Array.isArray(existingMetadata.followUps) ? existingMetadata.followUps : [];
  const followUpCount = sent ? Number(request.follow_up_count || 0) + 1 : Number(request.follow_up_count || 0);
  const status = sent ? (cimRequestSentStatuses.includes(request.status) ? request.status : emailResult.status) : 'follow_up_failed';
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
    delivery_error: emailResult.error || '',
    provider_message_id: emailResult.providerMessageId || request.provider_message_id || '',
    follow_up_count: followUpCount,
    last_follow_up_at: sent ? sentAt : request.last_follow_up_at || null,
    next_follow_up_at: nextFollowUpAt,
    metadata: {
      providerMessageIds,
      replyToAddress: existingMetadata.replyToAddress || replyToAddress,
      followUps: [
        ...existingFollowUps,
        {
          number: followUpNumber,
          attemptedAt: sentAt,
          status: emailResult.status,
          providerMessageId: emailResult.providerMessageId || '',
          error: emailResult.error || '',
        },
      ],
    },
  });
}

async function processCimFollowUpRequest(storage, request, nowIso) {
  const lockKey = request?.id || buildCimRequestLockKey(request?.deal_key, request?.recipient_email);

  if (!acquireLock(cimFollowUpLocks, lockKey)) {
    return { status: 'locked', request };
  }

  try {
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
        return { status: 'locked', request: claimResult?.request || request };
      }

      claimedRequest = claimResult.request || request;
    }

    const followUpNumber = followUpCount + 1;
    const emailResult = await sendDealHunterCimFollowUpEmail({
      to: claimedRequest.recipient_email,
      request: claimedRequest,
      followUpNumber,
      requestedBy: claimedRequest.requested_by || '',
    });
    const updatedRequest = await upsertCimRequestWithActivity(
      storage,
      buildCimFollowUpUpdate(claimedRequest, emailResult, followUpNumber, nowIso),
      {
        eventType: emailResult.status === 'failed' ? 'cim.follow-up-failed' : 'cim.follow-up-sent',
        summary: emailResult.status === 'failed'
          ? `CIM follow-up ${followUpNumber} delivery failed.`
          : `CIM follow-up ${followUpNumber} sent.`,
        actor: claimedRequest.requested_by || 'deal-hunter',
        metadata: {
          followUpNumber,
          deliveryStatus: emailResult.status,
          providerMessageId: emailResult.providerMessageId || '',
        },
      },
    );

    return {
      status: emailResult.status === 'failed' ? 'failed' : 'sent',
      request: updatedRequest,
      emailResult,
    };
  } finally {
    releaseLock(cimFollowUpLocks, lockKey);
  }
}

async function buildDailyDealReview({ storage = getStorage() } = {}) {
  const config = getConfig();
  const generatedAt = new Date().toISOString();
  const sourceResults = await collectSources(config);
  const allDeals = dedupeDeals(sourceResults.flatMap((result) => result.deals));
  const recentDeals = allDeals.filter((deal) => isRecentDeal(deal, config.dealHunter.lookbackDays));
  const candidateDeals = recentDeals.length > 0 ? recentDeals : allDeals;
  const seenDeals = await loadDealHunterHistory(storage);
  const scoredDealsWithHistory = attachHistory(candidateDeals.map(scoreDeal), seenDeals, generatedAt);
  const cimRequests = await loadDealHunterCimRequests(
    storage,
    scoredDealsWithHistory.map((deal) => deal.dealKey).filter(Boolean),
  );
  const scoredDeals = attachCimRequestStatus(scoredDealsWithHistory, cimRequests);
  const newlySeenMatches = scoredDeals
    .filter((deal) => deal.isNew && !deal.shouldRemove && deal.score >= watchlistScoreThreshold)
    .sort(sortBestDeals)
    .map(publicDeal);
  const qualified = scoredDeals
    .filter((deal) => !deal.shouldRemove && deal.score >= highFitScoreThreshold)
    .sort(sortNewThenBest)
    .map(publicDeal);
  const watchlist = scoredDeals
    .filter((deal) => !deal.shouldRemove && deal.score >= watchlistScoreThreshold && deal.score < highFitScoreThreshold)
    .sort(sortNewThenBest)
    .map(publicDeal);
  const removalCandidates = scoredDeals
    .filter((deal) => deal.shouldRemove)
    .sort((left, right) => {
      const dateDifference = (Date.parse(right.dateAdded || right.lastUpdated || '') || 0) - (Date.parse(left.dateAdded || left.lastUpdated || '') || 0);
      return dateDifference || left.score - right.score;
    })
    .map(publicDeal);

  const review = {
    generatedAt,
    lookbackDays: config.dealHunter.lookbackDays,
    profile: {
      minAnnualProfit: profile.minAnnualProfit,
      maxAnnualProfit: profile.maxAnnualProfit,
      targetStates: profile.targetStates,
      managementRequired: false,
      managementPreferred: true,
      buyerCashContext: 'ROBS plus savings can support an acquisition when paired with SBA financing, seller note, or investors.',
    },
    sources: sourceResults.map((result) => result.source),
    totals: {
      sourceRows: sourceResults.reduce((sum, result) => sum + (result.source.rowCount || 0), 0),
      normalizedDeals: allDeals.length,
      reviewedDeals: candidateDeals.length,
      newDeals: scoredDeals.filter((deal) => deal.isNew).length,
      newMatches: newlySeenMatches.length,
      qualified: qualified.length,
      watchlist: watchlist.length,
      removalCandidates: removalCandidates.length,
      cimReady: scoredDeals.filter((deal) => deal.cimRequest?.canRequest).length,
    },
    criteriaRecommendations: summarizeCriteria(scoredDeals),
    newlySeenMatches,
    qualified,
    watchlist,
    removalCandidates,
  };

  return { review, scoredDeals, storage };
}

export async function reviewDailyDeals({ markSeen = false, storage = getStorage() } = {}) {
  const result = await buildDailyDealReview({ storage });

  if (markSeen) {
    await persistDealHunterHistory(result.storage, result.scoredDeals);
  }

  return result.review;
}

export async function sendDailyDealHunterReview({ idempotencyKey = '' } = {}) {
  const result = await buildDailyDealReview();
  const { review, scoredDeals, storage } = result;
  const config = getConfig();
  const crmSync = await syncHighFitDealsToCrm(scoredDeals, storage);

  review.crmSync = crmSync;

  const emailResult = await sendDailyDealHunterEmail({
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
    crmSync,
  };
}

async function sendCimRequestForScoredDeal({ deal, requestedBy = '', storage = getStorage() } = {}) {
  if (!storage.getDealHunterCimRequest || !storage.upsertDealHunterCimRequest) {
    return { ok: false, status: 500, error: 'CIM request tracking storage is not configured.' };
  }

  const recipientEmail = normalizeEmail(deal.brokerEmail);
  const unavailableReason = getCimRequestUnavailableReason(deal, recipientEmail);

  if (unavailableReason) {
    return {
      ok: false,
      status: 400,
      error: unavailableReason,
      deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
    };
  }

  const lockKey = buildCimRequestLockKey(deal.dealKey, recipientEmail);

  if (!acquireLock(cimRequestSendLocks, lockKey)) {
    return {
      ok: false,
      status: 409,
      error: 'A CIM request for this deal is already in progress. Please wait a few minutes before retrying.',
      deal: publicDeal(attachCimRequestStatus([deal], [])[0]),
    };
  }

  try {
    const existingRequest = await storage.getDealHunterCimRequest({
      dealKey: deal.dealKey,
      recipientEmail,
    });

    if (isCompletedCimStatus(existingRequest?.status)) {
      return {
        ok: true,
        status: 200,
        alreadySent: true,
        request: existingRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [existingRequest])[0]),
        emailResult: {
          status: existingRequest.status,
          error: '',
          providerMessageId: existingRequest.provider_message_id || '',
        },
      };
    }

    if (isRecentPendingCimRequest(existingRequest)) {
      return {
        ok: false,
        status: 409,
        error: 'A CIM request for this deal is already in progress. Please wait a few minutes before retrying.',
        request: existingRequest,
        deal: publicDeal(attachCimRequestStatus([deal], [existingRequest])[0]),
      };
    }

    const pendingRecord = buildCimRequestRecord({
      deal,
      recipientEmail,
      requestedBy,
      emailResult: { status: 'pending', error: '', providerMessageId: '' },
      existingRequest,
    });
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

      return {
        ok: false,
        status: 409,
        error: 'A CIM request for this deal is already in progress. Please wait a few minutes before retrying.',
        request: currentRequest,
        deal: publicDeal(attachCimRequestStatus([deal], currentRequest ? [currentRequest] : [])[0]),
      };
    }

    const emailResult = await sendDealHunterCimRequestEmail({
      to: recipientEmail,
      deal,
      requestedBy,
      cimRequestId: pendingRequest?.id || pendingRecord.id,
    });
    const savedRequest = await upsertCimRequestWithActivity(
      storage,
      buildCimRequestRecord({
        deal,
        recipientEmail,
        requestedBy,
        emailResult,
        existingRequest: pendingRequest,
      }),
      {
        eventType: emailResult.status === 'failed' ? 'cim.request-failed' : 'cim.request-sent',
        summary: emailResult.status === 'failed' ? 'CIM request delivery failed.' : 'CIM and NDA request sent to the broker.',
        actor: requestedBy,
        metadata: {
          recipientEmail,
          deliveryStatus: emailResult.status,
          providerMessageId: emailResult.providerMessageId || '',
        },
      },
    );
    const publicUpdatedDeal = publicDeal(attachCimRequestStatus([deal], [savedRequest])[0]);

    return {
      ok: emailResult.status !== 'failed',
      status: emailResult.status === 'failed' ? 502 : 201,
      alreadySent: false,
      request: savedRequest,
      deal: publicUpdatedDeal,
      emailResult,
      error: emailResult.status === 'failed' ? emailResult.error || 'CIM request email failed.' : '',
    };
  } finally {
    releaseLock(cimRequestSendLocks, lockKey);
  }
}

export async function sendDealHunterCimRequest({ dealKey = '', snapshotToken = '', requestedBy = '', storage = getStorage() } = {}) {
  const normalizedDealKey = normalizeText(dealKey, 1000);

  if (!normalizedDealKey) {
    return { ok: false, status: 400, error: 'Deal key is required.' };
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

  const deal = result.scoredDeals.find((candidate) => candidate.dealKey === normalizedDealKey);

  if (!deal) {
    const snapshotDeal = verifyCimDealSnapshotToken(snapshotToken);

    if (snapshotDeal?.dealKey === normalizedDealKey && sourceFailureMatchesDeal(snapshotDeal, result.review)) {
      console.warn('[deal-hunter] using confirmed CIM snapshot because one or more review sources failed.');
      return sendCimRequestForScoredDeal({ deal: snapshotDeal, requestedBy, storage });
    }

    return { ok: false, status: 404, error: 'Deal was not found in the latest Deal Hunter review.' };
  }

  return sendCimRequestForScoredDeal({ deal, requestedBy, storage });
}

function normalizeCimRequestSelections(selections = []) {
  if (!Array.isArray(selections)) {
    return [];
  }

  const seen = new Set();
  const normalizedSelections = [];

  for (const selection of selections) {
    const dealKey = normalizeText(selection?.dealKey || selection?.deal_key, 1000);
    const recipientEmail = normalizeEmail(selection?.recipientEmail || selection?.recipient_email);
    const snapshotToken = selection?.snapshotToken || selection?.snapshot_token || selection?.deal?.cimRequest?.snapshotToken || '';
    const deal = verifyCimDealSnapshotToken(snapshotToken);
    const key = `${dealKey}|${recipientEmail}`;

    if (!dealKey || !recipientEmail || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedSelections.push({ dealKey, recipientEmail, deal });
  }

  return normalizedSelections.slice(0, cimBulkRequestMax);
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
  return (review?.sources || []).some((source) => source?.fetched === false || source?.error);
}

function sourceFailureMatchesDeal(deal = null, review = null) {
  if (!deal || !reviewHasSourceFailures(review)) {
    return false;
  }

  const dealSourceId = normalizeText(deal.sourceId || deal.source_id, 200);
  const dealSourceName = normalizeComparableText(deal.sourceName || deal.source_name || '');
  const dealSourceMode = normalizeComparableText(deal.sourceMode || deal.source_mode || '');

  return (review?.sources || []).some((source) => {
    if (source?.fetched !== false && !source?.error) {
      return false;
    }

    const sourceId = normalizeText(source.id, 200);
    const sourceName = normalizeComparableText(source.name || '');
    const sourceMode = normalizeComparableText(source.mode || '');

    if (dealSourceId && sourceId && dealSourceId === sourceId) {
      return true;
    }

    return Boolean(
      dealSourceName &&
        dealSourceName === sourceName &&
        (!dealSourceMode || !sourceMode || dealSourceMode === sourceMode),
    );
  });
}

function buildReadyDealsFromConfirmedSnapshots(selectedRecipients = []) {
  const validationFailures = [];
  const readyDeals = selectedRecipients.map((selection) => {
    const deal = selection.deal;

    if (!deal || deal.dealKey !== selection.dealKey) {
      validationFailures.push(buildSelectionFailure(selection, 'Confirmed deal details are missing. Review sources again before sending.'));
      return null;
    }

    if (normalizeEmail(deal.brokerEmail) !== selection.recipientEmail) {
      validationFailures.push(
        buildSelectionFailure(selection, 'Confirmed broker email does not match the selected deal. Review sources again before sending.'),
      );
      return null;
    }

    const unavailableReason = getCimRequestUnavailableReason(deal, selection.recipientEmail);

    if (unavailableReason) {
      validationFailures.push(buildSelectionFailure(selection, unavailableReason));
      return null;
    }

    return deal;
  }).filter(Boolean);

  return { readyDeals, validationFailures };
}

export async function sendDealHunterReadyCimRequests({ requestedBy = '', limit = cimBulkRequestMax, selections = [], storage = getStorage() } = {}) {
  if (!storage.getDealHunterCimRequest || !storage.upsertDealHunterCimRequest) {
    return { ok: false, status: 500, error: 'CIM request tracking storage is not configured.' };
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || cimBulkRequestMax, cimBulkRequestMax));
  const selectedRecipients = normalizeCimRequestSelections(selections);
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

  if (selectedRecipients.length > 0) {
    const readyByDealRecipient = new Map(
      allReadyDeals.map((deal) => [`${deal.dealKey}|${normalizeEmail(deal.brokerEmail)}`, deal]),
    );
    const readyByDealKey = new Map(allReadyDeals.map((deal) => [deal.dealKey, deal]));
    const validationFailures = [];
    const missingFromReadyList = [];

    readyDeals = selectedRecipients.map((selection) => {
      const deal = readyByDealRecipient.get(`${selection.dealKey}|${selection.recipientEmail}`);

      if (!deal) {
        const latestDeal = readyByDealKey.get(selection.dealKey);

        if (!latestDeal) {
          missingFromReadyList.push(selection);
        }

        validationFailures.push(
          buildSelectionFailure(
            selection,
            latestDeal
              ? 'This deal is no longer CIM-ready for the confirmed broker email. Review sources again before sending.'
              : 'This deal was not available in the latest source review. Review sources again before sending.',
          ),
        );
      }

      return deal;
    }).filter(Boolean);

    if (validationFailures.length > 0) {
      if (
        missingFromReadyList.length === validationFailures.length &&
        missingFromReadyList.every((selection) => sourceFailureMatchesDeal(selection.deal, result?.review))
      ) {
        const snapshotValidation = buildReadyDealsFromConfirmedSnapshots(selectedRecipients);

        if (snapshotValidation.validationFailures.length === 0) {
          console.warn('[deal-hunter] using confirmed CIM snapshots because one or more review sources failed.');
          readyDeals = snapshotValidation.readyDeals;
        } else {
          return {
            ok: false,
            status: 400,
            error: 'Deal Hunter source review was incomplete and the confirmed CIM selections were not valid enough to send.',
            review: result?.review || null,
            results: snapshotValidation.validationFailures,
            sent: 0,
            alreadySent: 0,
            failed: snapshotValidation.validationFailures.length,
            totalReady: allReadyDeals.length,
            totalRequested: selectedRecipients.length,
            limited: false,
            limit: safeLimit,
          };
        }
      } else {
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
    const sendResult = await sendCimRequestForScoredDeal({ deal, requestedBy, storage });
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

  if (!isCimFollowUpSendDay({ now, settings })) {
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
      message: `CIM follow-ups are deferred until the next weekday in ${settings.timezone || 'America/Los_Angeles'}.`,
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
