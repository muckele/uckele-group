import { getConfig } from '../config.js';
import { containsTrustedIndustryTerm, trustedIndustryTerms, trustedTargetStates } from './cimAutomation.js';

export const DEAL_CRITERIA_PROFILE_VERSION = 'uckele-criteria-v1';

const MINIMUM_ANNUAL_PROFIT = 300000;
const MAXIMUM_ANNUAL_PROFIT = 750000;
const MAXIMUM_PROFIT_MULTIPLE = 4.0;
const REVIEW_FLOOR = 75;
const AUTOMATIC_FLOOR_MINIMUM = 90;

const stateNameCodes = Object.freeze({
  'NEW YORK': 'NY',
  CALIFORNIA: 'CA',
  'NEW JERSEY': 'NJ',
  ARIZONA: 'AZ',
  NEVADA: 'NV',
  CONNECTICUT: 'CT',
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function getDealCriteriaProfile(config = getConfig()) {
  const configured = finiteNumber(config?.dealHunter?.criteria?.automaticFloor);
  return Object.freeze({
    version: DEAL_CRITERIA_PROFILE_VERSION,
    minimumAnnualProfit: MINIMUM_ANNUAL_PROFIT,
    maximumAnnualProfit: MAXIMUM_ANNUAL_PROFIT,
    maximumProfitMultiple: MAXIMUM_PROFIT_MULTIPLE,
    targetStates: trustedTargetStates,
    trustedIndustryTerms,
    reviewFloor: REVIEW_FLOOR,
    automaticFloor: Math.max(AUTOMATIC_FLOOR_MINIMUM, configured ?? AUTOMATIC_FLOOR_MINIMUM),
  });
}

function evaluateProfit(deal, profile) {
  const observed = finiteNumber(deal.annualProfit);
  if (observed === null) return { id: 'profit', outcome: 'unknown', observed: null };
  const pass = observed >= profile.minimumAnnualProfit && observed <= profile.maximumAnnualProfit;
  return { id: 'profit', outcome: pass ? 'pass' : 'fail', observed };
}

function evaluateMultiple(deal, profile) {
  let observed = finiteNumber(deal.profitMultiple);
  if (observed === null) {
    const askingPrice = finiteNumber(deal.askingPrice);
    const annualProfit = finiteNumber(deal.annualProfit);
    if (askingPrice !== null && annualProfit !== null && askingPrice > 0 && annualProfit > 0) {
      observed = askingPrice / annualProfit;
    }
  }
  if (observed === null) return { id: 'multiple', outcome: 'unknown', observed: null };
  const pass = observed > 0 && observed <= profile.maximumProfitMultiple;
  return { id: 'multiple', outcome: pass ? 'pass' : 'fail', observed };
}

function evaluateGeography(deal, profile) {
  const observed = String(deal.location || '').trim() || String(deal.state || '').trim();
  if (!observed) return { id: 'geography', outcome: 'unknown', observed: null };
  let text = observed.toUpperCase();
  for (const [name, code] of Object.entries(stateNameCodes)) {
    text = text.replace(new RegExp(`(^|[^A-Z])${name}(?=[^A-Z]|$)`, 'g'), `$1${code}`);
  }
  const pass = profile.targetStates.some((state) => new RegExp(`(^|[^A-Z])${state}([^A-Z]|$)`).test(text));
  return { id: 'geography', outcome: pass ? 'pass' : 'fail', observed };
}

function evaluateIndustry(deal, profile) {
  const observed = `${deal.name || ''} ${deal.industry || ''}`.replace(/\s+/g, ' ').trim();
  if (!observed) return { id: 'industry', outcome: 'unknown', observed: null };
  const pass = profile.trustedIndustryTerms.some((term) => containsTrustedIndustryTerm(observed.toLowerCase(), term));
  return { id: 'industry', outcome: pass ? 'pass' : 'fail', observed };
}

function evaluateGates(deal) {
  const gates = Array.isArray(deal.gates) ? deal.gates : [];
  return { id: 'gates', outcome: gates.length > 0 ? 'fail' : 'pass', observed: gates.length };
}

export function evaluateDealCriteria(deal = {}, { profile = getDealCriteriaProfile() } = {}) {
  const mustHaves = [
    evaluateProfit(deal, profile),
    evaluateMultiple(deal, profile),
    evaluateGeography(deal, profile),
    evaluateIndustry(deal, profile),
    evaluateGates(deal),
  ];
  const failed = mustHaves.filter((entry) => entry.outcome === 'fail').map((entry) => entry.id);
  const unknown = mustHaves.filter((entry) => entry.outcome === 'unknown').map((entry) => entry.id);
  const score = finiteNumber(deal.fitScore) ?? finiteNumber(deal.score) ?? 0;

  let group;
  if (score < profile.reviewFloor) group = 'below-review';
  else if (failed.length > 0) group = 'near-miss';
  else if (unknown.length > 0) group = 'needs-info';
  else if (score >= profile.automaticFloor) group = 'auto';
  else group = 'review';

  return { profileVersion: profile.version, group, mustHaves, failed, unknown };
}
