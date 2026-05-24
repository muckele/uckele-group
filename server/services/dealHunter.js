import { randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { safeCompareText } from '../utils/security.js';
import { sendDealHunterDigestEmail } from './delivery.js';

const DEFAULT_CRITERIA_ID = 'default';

export const defaultDealHunterCriteria = {
  minAnnualProfit: 500000,
  maxAnnualProfit: 1500000,
  targetStates: ['NY', 'NJ', 'CT', 'PA', 'MA', 'AZ', 'NV', 'CA'],
  targetCities: [],
  targetCounties: [],
  includedIndustries: [
    'Home and Property Services',
    'Business and Professional Services',
    'Healthcare Services',
    'Commercial Services',
    'Industrial Services',
    'Facility Services',
    'Specialty Trade Services',
    'Environmental Services',
    'Testing, Inspection, and Compliance',
    'Repair and Maintenance Services',
  ],
  excludedIndustries: [
    'Food and Beverage',
    'Hospitality',
    'Restaurants',
    'Retail',
    'Ecommerce',
    'SaaS',
    'Software',
    'IT Services',
    'Online Business',
    'Fitness',
  ],
  includeKeywords: [
    'recurring revenue',
    'service contracts',
    'commercial customers',
    'b2b',
    'route-based',
    'maintenance',
    'repair',
    'compliance',
    'inspection',
    'testing',
    'remediation',
    'restoration',
    'installation',
    'field service',
    'essential service',
    'regulated',
    'licensed',
    'customer-diversified',
    'owner retiring',
    'management in place',
    'repeat customers',
    'low customer concentration',
  ],
  excludeKeywords: [
    'restaurant',
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
    'fashion',
    'luxury',
    'dropshipping',
    'amazon fba',
    'franchise',
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
    'high capex',
    'heavy inventory',
    'project-based',
    'one customer',
    'customer concentration',
    'declining revenue',
  ],
  includeRemote: false,
  minYearsInBusiness: 5,
  preferYearsInBusiness: 10,
  includeFranchises: false,
};

const recessionSignals = [
  'essential',
  'recurring',
  'service contract',
  'maintenance',
  'repair',
  'compliance',
  'inspection',
  'testing',
  'regulated',
  'healthcare',
  'medical',
  'commercial',
  'b2b',
  'route',
  'restoration',
  'remediation',
  'waste',
  'safety',
  'fire',
  'security',
];

const aiResistantSignals = [
  'field service',
  'maintenance',
  'repair',
  'installation',
  'inspection',
  'testing',
  'licensed',
  'regulated',
  'route',
  'technician',
  'commercial',
  'local',
  'hands-on',
  'physical',
  'equipment',
  'trade',
  'restoration',
  'remediation',
];

const aiExposedSignals = ['saas', 'software', 'app', 'online', 'digital marketing', 'seo', 'web design', 'content', 'agency'];

const usStateNamesByCode = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
};
const usStateCodes = Object.keys(usStateNamesByCode);
const usStateNamePattern = Object.values(usStateNamesByCode)
  .sort((left, right) => right.length - left.length)
  .map((stateName) => stateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

function normalizeText(value, maxLength = 120000) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeStateCode(value) {
  const rawValue = String(value || '').trim();
  const upperValue = rawValue.toUpperCase();

  if (usStateNamesByCode[upperValue]) {
    return upperValue;
  }

  const normalizedName = rawValue.toLowerCase();
  const stateEntry = Object.entries(usStateNamesByCode).find(([, stateName]) => stateName.toLowerCase() === normalizedName);
  return stateEntry?.[0] || '';
}

function normalizeStateList(value) {
  const states = normalizeList(value)
    .map(normalizeStateCode)
    .filter(Boolean);

  return [...new Set(states)];
}

function normalizeCriteria(input = {}) {
  const targetStates =
    input.targetStates === undefined || input.targetStates === null || input.targetStates === ''
      ? defaultDealHunterCriteria.targetStates
      : input.targetStates;

  return {
    ...defaultDealHunterCriteria,
    ...input,
    minAnnualProfit: Number(input.minAnnualProfit) || defaultDealHunterCriteria.minAnnualProfit,
    maxAnnualProfit: Number(input.maxAnnualProfit) || defaultDealHunterCriteria.maxAnnualProfit,
    targetStates: normalizeStateList(targetStates),
    targetCities: normalizeList(input.targetCities || defaultDealHunterCriteria.targetCities),
    targetCounties: normalizeList(input.targetCounties || defaultDealHunterCriteria.targetCounties),
    includedIndustries: normalizeList(input.includedIndustries || defaultDealHunterCriteria.includedIndustries),
    excludedIndustries: normalizeList(input.excludedIndustries || defaultDealHunterCriteria.excludedIndustries),
    includeKeywords: normalizeList(input.includeKeywords || defaultDealHunterCriteria.includeKeywords).map((item) => item.toLowerCase()),
    excludeKeywords: normalizeList(input.excludeKeywords || defaultDealHunterCriteria.excludeKeywords).map((item) => item.toLowerCase()),
    includeRemote: normalizeBoolean(input.includeRemote, defaultDealHunterCriteria.includeRemote),
    minYearsInBusiness: Number(input.minYearsInBusiness) || defaultDealHunterCriteria.minYearsInBusiness,
    preferYearsInBusiness: Number(input.preferYearsInBusiness) || defaultDealHunterCriteria.preferYearsInBusiness,
    includeFranchises: normalizeBoolean(input.includeFranchises, defaultDealHunterCriteria.includeFranchises),
  };
}

function parseMoney(value) {
  const match = String(value || '').match(/\$?\s*([\d,.]+)\s*([kKmM])?/);

  if (!match) {
    return null;
  }

  const base = Number(match[1].replace(/,/g, ''));

  if (!Number.isFinite(base)) {
    return null;
  }

  const suffix = String(match[2] || '').toLowerCase();

  if (suffix === 'm') {
    return Math.round(base * 1000000);
  }

  if (suffix === 'k') {
    return Math.round(base * 1000);
  }

  return Math.round(base);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const csv = String(text || '');

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const nextCharacter = csv[index + 1];

    if (character === '"') {
      if (quoted && nextCharacter === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === ',' && !quoted) {
      row.push(value.trim());
      value = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

      row.push(value.trim());
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += character;
  }

  row.push(value.trim());
  rows.push(row);

  return rows.filter((csvRow) => csvRow.some(Boolean));
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function headerMatches(header, aliases) {
  const normalizedHeader = normalizeHeader(header);
  return aliases.some((alias) => normalizedHeader.includes(alias));
}

function getRowValue(row, headers, aliases, usedIndexes) {
  const index = headers.findIndex((header) => headerMatches(header, aliases));

  if (index === -1) {
    return '';
  }

  usedIndexes.add(index);
  return row[index] || '';
}

function findCsvHeaderIndex(rows) {
  let best = { index: -1, score: 0 };

  rows.slice(0, 20).forEach((row, index) => {
    const score = row.reduce((total, cell) => {
      const header = normalizeHeader(cell);

      if (/company|business|listing|title|name/.test(header)) {
        return total + 2;
      }

      if (/location|city|state|county|market|industry|category|sector|profit|sde|cash flow|ebitda|revenue|sales|asking|price|broker|description|summary|url|link/.test(header)) {
        return total + 1;
      }

      return total;
    }, 0);

    if (score > best.score) {
      best = { index, score };
    }
  });

  return best.score >= 3 ? best.index : -1;
}

function csvRowToListingBlock(row, headers, index) {
  const usedIndexes = new Set();
  const company = getRowValue(row, headers, ['company', 'business name', 'business', 'listing title', 'title', 'name'], usedIndexes);
  const directLocation = getRowValue(row, headers, ['location', 'city state', 'market', 'county'], usedIndexes);
  const city = directLocation ? '' : getRowValue(row, headers, ['city'], usedIndexes);
  const state = directLocation ? '' : getRowValue(row, headers, ['state'], usedIndexes);
  const location = directLocation || [city, state].filter(Boolean).join(', ');
  const industry = getRowValue(row, headers, ['industry', 'category', 'sector'], usedIndexes);
  const profit = getRowValue(row, headers, ['annual profit', 'cash flow', 'sde', 'ebitda', 'profit'], usedIndexes);
  const revenue = getRowValue(row, headers, ['annual revenue', 'gross revenue', 'revenue', 'sales'], usedIndexes);
  const asking = getRowValue(row, headers, ['asking price', 'purchase price', 'asking', 'price'], usedIndexes);
  const years = getRowValue(row, headers, ['years in business', 'years', 'established', 'founded'], usedIndexes);
  const broker = getRowValue(row, headers, ['broker', 'advisor', 'listed by'], usedIndexes);
  const url = getRowValue(row, headers, ['listing url', 'source url', 'url', 'link'], usedIndexes);
  const description = getRowValue(row, headers, ['description', 'summary', 'overview', 'notes', 'memo'], usedIndexes);
  const extra = headers
    .map((header, headerIndex) => ({ header, value: row[headerIndex] || '', headerIndex }))
    .filter(({ header, value, headerIndex }) => header && value && !usedIndexes.has(headerIndex))
    .slice(0, 12)
    .map(({ header, value }) => `${header}: ${value}`);
  const lines = [
    `Company: ${company || `Sheet Listing ${index + 1}`}`,
    location ? `Location: ${location}` : '',
    industry ? `Industry: ${industry}` : '',
    profit ? `Annual Profit: ${profit}` : '',
    revenue ? `Revenue: ${revenue}` : '',
    asking ? `Asking Price: ${asking}` : '',
    years ? `Years in business: ${years}` : '',
    broker ? `Broker: ${broker}` : '',
    url ? `URL: ${url}` : '',
    description ? `Description: ${description}` : '',
    ...extra,
  ].filter(Boolean);

  return lines.join('\n');
}

function csvToListingText(csv) {
  const rows = parseCsv(csv);
  const headerIndex = findCsvHeaderIndex(rows);

  if (headerIndex === -1) {
    const fallbackBlocks = rows
      .map((row, index) => {
        const values = row.filter(Boolean);
        return values.length >= 3 ? [`Company: Sheet Listing ${index + 1}`, `Description: ${values.join(' | ')}`].join('\n') : '';
      })
      .filter((block) => block.length >= 80);

    return {
      text: fallbackBlocks.join('\n\n'),
      rowCount: fallbackBlocks.length,
      headerRowFound: false,
      headers: [],
    };
  }

  const headers = rows[headerIndex].map((header, index) => header || `Column ${index + 1}`);
  const blocks = rows
    .slice(headerIndex + 1)
    .filter((row) => row.filter(Boolean).length >= 2)
    .map((row, index) => csvRowToListingBlock(row, headers, index))
    .filter((block) => block.length >= 60)
    .slice(0, 120);

  return {
    text: blocks.join('\n\n'),
    rowCount: blocks.length,
    headerRowFound: true,
    headers,
  };
}

function extractField(block, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*:?\\s*([^\\n]+)`, 'i');
  const match = block.match(pattern);
  return match ? match[1].trim() : '';
}

function extractMoneyNear(block, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:${escaped})[^\\n$\\d]{0,40}(\\$?\\s*[\\d,.]+\\s*[kKmM]?)`, 'i');
  const match = block.match(pattern);
  return match ? parseMoney(match[1]) : null;
}

function extractYearsInBusiness(block) {
  const match = block.match(/(\d{1,3})\+?\s*(?:years|yrs)\s*(?:in business|old|operating)?/i);
  return match ? Number(match[1]) : null;
}

function extractLocation(block) {
  const explicit = extractField(block, ['Location', 'Located in', 'Market']);

  if (explicit) {
    return explicit;
  }

  const stateCodePattern = usStateCodes.join('|');
  const codeMatch = block.match(new RegExp(`\\b[A-Z][a-z]+(?:\\s[A-Z][a-z]+)*,\\s*(?:${stateCodePattern})\\b`));

  if (codeMatch) {
    return codeMatch[0];
  }

  const nameMatch = block.match(new RegExp(`\\b(${usStateNamePattern})\\b`, 'i'));
  return nameMatch ? nameMatch[0] : '';
}

function extractState(location) {
  const value = String(location || '');
  const exactState = normalizeStateCode(value);

  if (exactState) {
    return exactState;
  }

  const codeMatch = value.match(new RegExp(`,\\s*(${usStateCodes.join('|')})\\b`, 'i'));

  if (codeMatch) {
    return codeMatch[1].toUpperCase();
  }

  const nameMatch = value.match(new RegExp(`\\b(${usStateNamePattern})\\b`, 'i'));

  if (!nameMatch) {
    return '';
  }

  return normalizeStateCode(nameMatch[1]);
}

function extractCompany(block, index) {
  const explicit = extractField(block, ['Company', 'Business', 'Business Name', 'Name', 'Listing', 'Title']);

  if (explicit) {
    return explicit.replace(/^[-*\d.)\s]+/, '').trim().slice(0, 160);
  }

  const firstLine = block
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .find((line) => line && !/^https?:\/\//i.test(line));

  return (firstLine || `Deal ${index + 1}`).slice(0, 160);
}

function splitListingBlocks(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return [];
  }

  const blocks = normalized
    .split(/\n{2,}(?=(?:[-*#\d.)\s]*[A-Z0-9]|Company|Business|Listing|Title|Opportunity))/)
    .map((block) => block.trim())
    .filter((block) => block.length >= 60);

  if (blocks.length > 1) {
    return blocks.slice(0, 80);
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const grouped = [];

  for (let index = 0; index < lines.length; index += 8) {
    const block = lines.slice(index, index + 8).join('\n');

    if (block.length >= 60) {
      grouped.push(block);
    }
  }

  return grouped.slice(0, 80);
}

function keywordMatches(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
}

function addSignalScore(text, signals, pointsPerSignal, maxPoints) {
  const matches = keywordMatches(text, signals);
  return {
    matches,
    score: Math.min(maxPoints, matches.length * pointsPerSignal),
  };
}

function buildCandidateGuidance({ candidate, status, score, reasons, risks, excludedReasons, matchedKeywords }) {
  const notes = [];
  const brokerQuestions = [
    'Can you send the CIM, trailing 12-month P&L, tax returns, and add-back schedule?',
    'What percentage of revenue is recurring, contract-based, or repeat customer work?',
    'What customer concentration exists in the top 5 and top 10 accounts?',
  ];
  const ownerQuestions = [
    'What work still depends directly on the owner each week?',
    'What would break first if the owner stepped away for 30 days?',
    'Which services, customers, or jobs are least profitable today?',
  ];

  if (status === 'qualified') {
    notes.push(`Priority follow-up. Score ${score} with ${reasons.length} positive signal(s).`);
  } else if (status === 'watch') {
    notes.push('Watchlist item. Worth a quick broker screen if the missing risks can be cleared fast.');
  } else {
    notes.push('Rejected by current profile. Revisit only if the listing is misclassified or the economics are materially stronger than shown.');
  }

  if (excludedReasons.length > 0) {
    notes.push(`Hard exclusion hit: ${excludedReasons.join(' ')}`);
  }

  if (candidate.annual_profit === null) {
    notes.push('Profit was not detected, so financial fit needs manual verification.');
    brokerQuestions.unshift('What is the verified annual SDE/EBITDA and how was it calculated?');
  }

  if (risks.length > 0) {
    notes.push(`Risk checks: ${risks.slice(0, 3).join(' ')}`);
  }

  if (matchedKeywords.includes('service contracts') || matchedKeywords.includes('recurring revenue')) {
    brokerQuestions.push('Can you break revenue into recurring contracts, repeat work, and one-time projects?');
  }

  if (matchedKeywords.includes('management in place')) {
    ownerQuestions.push('Which manager would run day-to-day operations after close, and what retention plan is realistic?');
  } else {
    ownerQuestions.push('Who besides the owner can quote jobs, schedule work, manage employees, and handle customer escalations?');
  }

  if (/technician|field service|licensed|regulated|inspection|testing|repair/i.test(candidate.raw_text)) {
    brokerQuestions.push('Which licenses, certifications, or technician relationships must transfer at closing?');
    ownerQuestions.push('How hard is it to recruit, train, and retain qualified field staff?');
  }

  return {
    notes: [...new Set(notes)].slice(0, 5),
    broker_questions: [...new Set(brokerQuestions)].slice(0, 6),
    owner_questions: [...new Set(ownerQuestions)].slice(0, 6),
  };
}

function scoreCandidate(candidate, criteria) {
  const text = `${candidate.company} ${candidate.industry} ${candidate.location} ${candidate.description} ${candidate.raw_text}`.toLowerCase();
  const reasons = [];
  const risks = [];
  const excludedReasons = [];
  const matchedKeywords = keywordMatches(text, criteria.includeKeywords);
  const excludedKeywordMatches = keywordMatches(text, [...criteria.excludeKeywords, ...criteria.excludedIndustries]);

  if (excludedKeywordMatches.length > 0) {
    excludedReasons.push(`Excluded terms: ${excludedKeywordMatches.slice(0, 5).join(', ')}`);
  }

  if (!criteria.includeFranchises && /\bfranchise\b/i.test(text)) {
    excludedReasons.push('Franchise listing.');
  }

  if (!criteria.includeRemote && /\b(absentee|remote|relocatable|work from anywhere)\b/i.test(text) && !/management in place|general manager/i.test(text)) {
    risks.push('Remote or absentee language without clear management depth.');
  }

  if (candidate.annual_profit !== null) {
    if (candidate.annual_profit < criteria.minAnnualProfit) {
      risks.push(`Profit below target floor of $${criteria.minAnnualProfit.toLocaleString()}.`);
    } else if (candidate.annual_profit > criteria.maxAnnualProfit) {
      risks.push(`Profit above target ceiling of $${criteria.maxAnnualProfit.toLocaleString()}.`);
    } else {
      reasons.push('Profit is inside the target range.');
    }
  } else {
    risks.push('Profit was not detected in the listing.');
  }

  const state = extractState(candidate.location);

  if (state && criteria.targetStates.includes(state)) {
    reasons.push(`Located in target state ${state}.`);
  } else if (state) {
    risks.push(`Outside target states: ${state}.`);
  } else {
    risks.push('Location/state was not detected.');
  }

  if (matchedKeywords.length > 0) {
    reasons.push(`Matched durable-service terms: ${matchedKeywords.slice(0, 5).join(', ')}.`);
  }

  const years = candidate.years_in_business;

  if (years !== null) {
    if (years >= criteria.preferYearsInBusiness) {
      reasons.push(`${years}+ years in business.`);
    } else if (years < criteria.minYearsInBusiness) {
      risks.push(`Only ${years} years in business.`);
    }
  }

  const recessionSignalsFound = addSignalScore(text, recessionSignals, 9, 55);
  const aiSignalsFound = addSignalScore(text, aiResistantSignals, 9, 55);
  const aiExposure = addSignalScore(text, aiExposedSignals, 10, 35);

  const recession_score = Math.min(100, 35 + recessionSignalsFound.score + (matchedKeywords.length > 2 ? 10 : 0));
  const ai_resistance_score = Math.max(0, Math.min(100, 40 + aiSignalsFound.score - aiExposure.score));
  let criteria_score = 35;

  if (candidate.annual_profit !== null && candidate.annual_profit >= criteria.minAnnualProfit && candidate.annual_profit <= criteria.maxAnnualProfit) {
    criteria_score += 20;
  }

  if (state && criteria.targetStates.includes(state)) {
    criteria_score += 15;
  }

  if (matchedKeywords.length > 0) {
    criteria_score += Math.min(20, matchedKeywords.length * 4);
  }

  if (excludedReasons.length === 0) {
    criteria_score += 10;
  }

  criteria_score = Math.min(100, criteria_score);

  let score = Math.round(recession_score * 0.35 + ai_resistance_score * 0.35 + criteria_score * 0.3);

  if (excludedReasons.length > 0) {
    score = Math.min(score, 42);
  }

  if (risks.length >= 3) {
    score -= 8;
  }

  const config = getConfig();
  const status =
    excludedReasons.length > 0
      ? 'rejected'
      : score >= config.dealHunter.minimumQualifiedScore
        ? 'qualified'
        : score >= config.dealHunter.watchScore
          ? 'watch'
          : 'rejected';
  const finalScore = Math.max(0, score);
  const guidance = buildCandidateGuidance({
    candidate,
    status,
    score: finalScore,
    reasons,
    risks,
    excludedReasons,
    matchedKeywords,
  });

  return {
    ...candidate,
    score: finalScore,
    recession_score,
    ai_resistance_score,
    criteria_score,
    status,
    reasons,
    risks,
    matched_keywords: matchedKeywords,
    excluded_reasons: excludedReasons,
    notes: guidance.notes,
    broker_questions: guidance.broker_questions,
    owner_questions: guidance.owner_questions,
  };
}

function parseCandidates(text) {
  return splitListingBlocks(text).map((block, index) => {
    const urlMatch = block.match(/https?:\/\/[^\s)]+/i);
    const annual_profit = extractMoneyNear(block, ['annual profit', 'profit', 'sde', 'cash flow', 'seller discretionary earnings', 'ebitda']);

    return {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      company: extractCompany(block, index),
      location: extractLocation(block),
      industry: extractField(block, ['Industry', 'Category', 'Sector']) || '',
      description: block.replace(/\s+/g, ' ').slice(0, 700),
      asking_price: extractMoneyNear(block, ['asking price', 'price', 'purchase price', 'asking']) ?? null,
      annual_profit,
      annual_revenue: extractMoneyNear(block, ['revenue', 'sales', 'gross revenue']) ?? null,
      years_in_business: extractYearsInBusiness(block),
      source_url: urlMatch ? urlMatch[0] : '',
      broker: extractField(block, ['Broker', 'Advisor', 'Listed by']) || '',
      raw_text: block,
    };
  });
}

function buildRecommendations(candidates, criteria) {
  const recommendations = [];
  const total = candidates.length || 1;
  const qualified = candidates.filter((candidate) => candidate.status === 'qualified');
  const rejected = candidates.filter((candidate) => candidate.status === 'rejected');
  const excludedFoodOrHospitality = candidates.filter((candidate) =>
    candidate.excluded_reasons.some((reason) => /food|beverage|hospitality|restaurant|bar|hotel|lodging/i.test(reason)),
  );
  const techRejected = rejected.filter((candidate) => /saas|software|online|digital marketing|seo|web design/i.test(candidate.raw_text));
  const missingProfit = candidates.filter((candidate) => candidate.annual_profit === null);
  const outsideProfit = candidates.filter(
    (candidate) =>
      candidate.annual_profit !== null &&
      (candidate.annual_profit < criteria.minAnnualProfit || candidate.annual_profit > criteria.maxAnnualProfit),
  );

  if (candidates.length === 0) {
    recommendations.push({
      severity: 'warning',
      title: 'No listings were parsed',
      recommendation: 'Forward or paste the full SMB Deal Hunter email body, including listing titles and descriptions.',
      rationale: 'The scorer needs listing text to identify companies, industries, profit, and risk signals.',
    });
    return recommendations;
  }

  if (qualified.length === 0) {
    recommendations.push({
      severity: 'warning',
      title: 'No companies cleared the qualified score',
      recommendation: 'Keep the industry exclusions, but widen annual profit to $400,000-$1,750,000 for two weeks and remove city-level filters.',
      rationale: 'The current profile may be too narrow if every imported listing is rejected or only watchlisted.',
    });
  }

  if (excludedFoodOrHospitality.length / total > 0.2) {
    recommendations.push({
      severity: 'info',
      title: 'Too many food, beverage, or hospitality matches',
      recommendation: 'Add exact negative keywords: pizza, deli, liquor, convenience store, restaurant, cafe, salon, hotel, motel, bar, brewery, catering.',
      rationale: `${excludedFoodOrHospitality.length} listing(s) hit your hard-excluded sectors.`,
    });
  }

  if (techRejected.length / total > 0.15) {
    recommendations.push({
      severity: 'info',
      title: 'Tech and online listings are still leaking in',
      recommendation: 'Remove SaaS, IT, tech services, online business, ecommerce, digital marketing, SEO, and web design from target industries and add them as exclusions.',
      rationale: 'These categories tend to be more AI-exposed or broker-polished than your durable-service target.',
    });
  }

  if (missingProfit.length / total > 0.45) {
    recommendations.push({
      severity: 'info',
      title: 'Many listings are missing profit data',
      recommendation: 'Add include keywords: SDE, EBITDA, cash flow, annual profit, seller discretionary earnings.',
      rationale: `${missingProfit.length} listing(s) did not expose profit in a parseable way.`,
    });
  }

  if (outsideProfit.length / total > 0.5) {
    recommendations.push({
      severity: 'warning',
      title: 'Profit range is filtering too aggressively',
      recommendation: 'Test a broader $400,000-$1,750,000 annual profit range, then let the scorer prioritize the most durable service businesses.',
      rationale: `${outsideProfit.length} listing(s) were outside the current profit band.`,
    });
  }

  return recommendations;
}

async function getActiveCriteria() {
  const storage = getStorage();
  const row = await storage.getDealHunterCriteria(DEFAULT_CRITERIA_ID);
  return normalizeCriteria(row?.criteria || defaultDealHunterCriteria);
}

export async function getDealHunterOverview() {
  const storage = getStorage();
  const criteria = await getActiveCriteria();
  const runs = await storage.listDealHunterRuns({ limit: 8 });
  const latestRun = runs[0] || null;
  const candidates = latestRun ? await storage.listDealHunterCandidates({ runId: latestRun.id, limit: 24 }) : [];

  return {
    criteria,
    runs,
    latestRun,
    candidates,
  };
}

export async function updateDealHunterCriteria(input, updatedBy = '') {
  const storage = getStorage();
  const existingCriteria = await getActiveCriteria();
  const criteria = normalizeCriteria({ ...existingCriteria, ...input });
  const record = {
    id: DEFAULT_CRITERIA_ID,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
    criteria,
  };

  return storage.upsertDealHunterCriteria(record);
}

export async function reviewDealHunterEmail({ subject = '', text = '', source = 'manual-admin-import', requestedBy = '', sendDigest = true }) {
  const config = getConfig();
  const storage = getStorage();
  const criteria = await getActiveCriteria();
  const rawText = normalizeText(text);
  const scoredCandidates = parseCandidates(rawText).map((candidate) => scoreCandidate(candidate, criteria));
  const recommendations = buildRecommendations(scoredCandidates, criteria);
  const now = new Date().toISOString();
  const run = {
    id: randomUUID(),
    created_at: now,
    source,
    subject: normalizeText(subject, 240),
    raw_text: rawText,
    criteria_snapshot: criteria,
    qualified_count: scoredCandidates.filter((candidate) => candidate.status === 'qualified').length,
    watch_count: scoredCandidates.filter((candidate) => candidate.status === 'watch').length,
    rejected_count: scoredCandidates.filter((candidate) => candidate.status === 'rejected').length,
    recommendation_count: recommendations.length,
    digest_status: sendDigest ? 'pending' : 'skipped',
    digest_error: '',
    recommendations,
    requested_by: requestedBy,
  };

  await storage.insertDealHunterRun(run, scoredCandidates);

  let updatedRun = run;

  if (sendDigest) {
    const digestResult = await sendDealHunterDigestEmail({
      to: config.dealHunter.digestRecipient,
      run,
      criteria,
      candidates: scoredCandidates,
      recommendations,
    });

    updatedRun = await storage.updateDealHunterRun(run.id, {
      digest_status: digestResult.status,
      digest_error: digestResult.error,
    });
  }

  return {
    run: updatedRun,
    candidates: scoredCandidates,
    recommendations,
    criteria,
  };
}

export async function reviewDealHunterSheetCsv({
  subject = 'SMB Deal Hunter Google Sheet import',
  csv = '',
  source = 'google-sheet-import',
  requestedBy = '',
  sendDigest = true,
} = {}) {
  const converted = csvToListingText(csv);
  const result = await reviewDealHunterEmail({
    subject,
    text: converted.text,
    source,
    requestedBy,
    sendDigest,
  });

  return {
    ...result,
    sheet: {
      rowCount: converted.rowCount,
      headerRowFound: converted.headerRowFound,
      headers: converted.headers,
    },
  };
}

async function fetchDealHunterSheetCsv(sheetCsvUrl) {
  const url = normalizeText(sheetCsvUrl, 2000);

  if (!url) {
    throw new Error('Deal Hunter sheet CSV URL is not configured.');
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'text/csv,text/plain,*/*',
      'User-Agent': 'UckeleGroupDealHunter/1.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const csv = await response.text();

  if (!response.ok) {
    throw new Error(`Google Sheet import failed with ${response.status}.`);
  }

  if (/^\s*</.test(csv) || /Page Not Found|unable to open the file|requested does not exist/i.test(csv)) {
    throw new Error('Google Sheet did not return CSV. Configure DEAL_HUNTER_SHEET_CSV_URL with the exact public CSV export URL for the deal tab.');
  }

  return csv;
}

export async function reviewDealHunterSheetImport({ requestedBy = '', sendDigest = true } = {}) {
  const config = getConfig();
  const csv = await fetchDealHunterSheetCsv(config.dealHunter.sheetCsvUrl);

  return reviewDealHunterSheetCsv({
    subject: 'SMB Deal Hunter Google Sheet import',
    csv,
    source: 'google-sheet-import',
    requestedBy,
    sendDigest,
  });
}

export async function reviewDealHunterWebhook({ secret = '', subject = '', text = '', html = '' }) {
  const config = getConfig();
  const providedSecret = String(secret || '');

  if (!config.dealHunter.webhookSecret) {
    return { ok: false, status: 404, error: 'Deal Hunter inbound review is not configured.' };
  }

  if (!safeCompareText(providedSecret, config.dealHunter.webhookSecret)) {
    return { ok: false, status: 401, error: 'Unauthorized.' };
  }

  const result = await reviewDealHunterEmail({
    subject,
    text: text || html,
    source: 'inbound-email-webhook',
    requestedBy: 'deal-hunter-webhook',
    sendDigest: true,
  });

  return {
    ok: true,
    status: 200,
    result,
  };
}
