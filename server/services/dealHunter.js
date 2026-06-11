import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { sendDailyDealHunterEmail } from './delivery.js';

const defaultTimeoutMs = 45000;

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

function scoreDeal(deal) {
  const matches = {
    excluded: containsAny(deal.fullText, profile.excludedKeywords),
    preferred: containsAny(deal.fullText, profile.preferredKeywords),
    recession: containsAny(deal.fullText, profile.recessionProofKeywords),
    aiProof: containsAny(deal.fullText, profile.aiProofKeywords),
    management: containsAny(deal.fullText, profile.managementKeywords),
    capex: containsAny(deal.fullText, profile.capexKeywords),
  };
  const strengths = [];
  const concerns = [];
  const removeReasons = [];
  let score = 35;

  if (matches.excluded.length > 0) {
    removeReasons.push(`Excluded category match: ${matches.excluded.slice(0, 4).join(', ')}`);
  }

  if (isYes(deal.franchiseFlag)) {
    removeReasons.push('Franchise listing, which is outside the current acquisition strategy.');
  }

  if (deal.annualProfit !== null) {
    if (deal.annualProfit >= profile.minAnnualProfit && deal.annualProfit <= profile.maxAnnualProfit) {
      score += 20;
      strengths.push('Annual profit is inside the target $300k-$750k range.');
    } else if (deal.annualProfit >= 200000 && deal.annualProfit < profile.minAnnualProfit) {
      score += 6;
      concerns.push('Profit is below the target floor, but close enough to review if the deal quality is strong.');
    } else if (deal.annualProfit < 200000) {
      score -= 16;
      concerns.push('Profit is well below the current acquisition target.');
    } else {
      score -= 6;
      concerns.push('Profit is above the current target band and may require a larger equity check.');
    }
  } else {
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
    if (deal.profitMultiple > 0 && deal.profitMultiple <= 3.5) {
      score += 10;
      strengths.push('Profit multiple appears financeable for a self-funded/SBA-style acquisition.');
    } else if (deal.profitMultiple > 5) {
      score -= 12;
      concerns.push('Profit multiple is high for the current buying strategy.');
    }
  } else if (deal.askingPrice && deal.annualProfit) {
    const impliedMultiple = deal.askingPrice / deal.annualProfit;

    if (impliedMultiple <= 3.5) {
      score += 8;
      strengths.push('Implied asking-price-to-profit multiple looks reasonable.');
    } else if (impliedMultiple > 5) {
      score -= 10;
      concerns.push('Implied asking-price-to-profit multiple looks expensive.');
    }
  }

  if (deal.askingPrice) {
    if (deal.askingPrice >= 500000 && deal.askingPrice <= 1500000) {
      score += 7;
      strengths.push('Asking price is within a plausible range for ROBS cash plus SBA, seller note, or investors.');
    } else if (deal.askingPrice > 2000000) {
      score -= 9;
      concerns.push('Asking price likely needs outside equity or unusually favorable seller financing.');
    } else if (deal.askingPrice < 250000) {
      concerns.push('Small asking price may indicate a smaller owner-operator opportunity.');
    }
  }

  if (matches.preferred.length > 0) {
    score += Math.min(12, matches.preferred.length * 2);
    strengths.push(`Matches preferred search themes: ${matches.preferred.slice(0, 5).join(', ')}.`);
  }

  if (matches.recession.length > 0) {
    score += Math.min(10, matches.recession.length * 2);
    strengths.push(`Recession-resistant indicators: ${matches.recession.slice(0, 4).join(', ')}.`);
  } else {
    concerns.push('No clear recession-resistant indicator in the listing text.');
  }

  if (matches.aiProof.length > 0) {
    score += Math.min(10, matches.aiProof.length * 2);
    strengths.push(`AI-resistant operating work: ${matches.aiProof.slice(0, 4).join(', ')}.`);
  } else {
    concerns.push('No clear physical, field-service, regulated, or relationship-heavy work signal.');
  }

  if (matches.management.length > 0 || /yes/i.test(deal.remoteFlag)) {
    score += 7;
    strengths.push('Remote, absentee, turnkey, staff, or management signal exists.');
  } else {
    concerns.push('Management in place is not shown; this is acceptable but needs diligence.');
  }

  if (matches.capex.length > 0) {
    score -= Math.min(10, matches.capex.length * 2);
    concerns.push(`Possible capex or asset-heavy concern: ${matches.capex.slice(0, 4).join(', ')}.`);
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
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const shouldRemove = removeReasons.length > 0 || score < 45;
  const recommendation = shouldRemove
    ? 'Remove from tomorrow\'s daily update unless there is a specific strategic reason to keep it.'
    : score >= 70
      ? 'High fit. Review the listing and ask the broker diligence questions.'
      : 'Watchlist. Worth reviewing only if the broker confirms recurring revenue, management depth, and clean financing terms.';

  return {
    ...deal,
    score,
    strengths: strengths.slice(0, 5),
    concerns: concerns.slice(0, 5),
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

async function fetchText(url, { headers = {}, timeoutMs = defaultTimeoutMs } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Fetch failed with ${response.status}: ${text.slice(0, 180)}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, { headers = {}, timeoutMs = defaultTimeoutMs } = {}) {
  const text = await fetchText(url, { headers, timeoutMs });
  return JSON.parse(text);
}

async function fetchSheetCsvDeals(url, sourceIndex) {
  const csv = await fetchText(url);
  const rows = parseCsvRows(csv);

  return {
    source: {
      id: `sheet-${sourceIndex}`,
      name: sourceIndex === 0 ? 'SMB Deal Hunter Google Sheet' : `Google Sheet ${sourceIndex + 1}`,
      mode: 'csv',
      url,
      fetched: true,
      rowCount: rows.length,
    },
    deals: rows.map((row, index) => normalizeDealRecord(row, { id: `sheet-${sourceIndex}`, name: 'SMB Deal Hunter Google Sheet', mode: 'csv', rowId: String(index + 1) })),
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

async function fetchAirtableSharedDeals(url, maxRecords) {
  const embedUrl = buildAirtableEmbedUrl(url);
  const html = await fetchText(embedUrl);
  const dataPath = extractAirtableSharedDataPath(html);
  const applicationId = html.match(/"x-airtable-application-id":"([^"]+)"/)?.[1] || html.match(/"singleApplicationId":"([^"]+)"/)?.[1] || '';

  if (!dataPath) {
    throw new Error('Airtable shared view did not expose a readable shared-view data endpoint.');
  }

  const payload = await fetchJson(new URL(dataPath, 'https://airtable.com').toString(), {
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      'x-user-locale': 'en',
      'x-time-zone': 'America/Los_Angeles',
      ...(applicationId ? { 'x-airtable-application-id': applicationId } : {}),
    },
  });
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
      sourceResults.push(await fetchSheetCsvDeals(url, index));
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
      sourceResults.push(await fetchAirtableSharedDeals(config.dealHunter.airtableSharedViewUrl, config.dealHunter.maxSourceRecords));
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
  const highFitCount = scoredDeals.filter((deal) => !deal.shouldRemove && deal.score >= 70).length;

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
  };
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

async function buildDailyDealReview({ storage = getStorage() } = {}) {
  const config = getConfig();
  const generatedAt = new Date().toISOString();
  const sourceResults = await collectSources(config);
  const allDeals = dedupeDeals(sourceResults.flatMap((result) => result.deals));
  const recentDeals = allDeals.filter((deal) => isRecentDeal(deal, config.dealHunter.lookbackDays));
  const candidateDeals = recentDeals.length > 0 ? recentDeals : allDeals;
  const seenDeals = await loadDealHunterHistory(storage);
  const scoredDeals = attachHistory(candidateDeals.map(scoreDeal), seenDeals, generatedAt);
  const newlySeenMatches = scoredDeals
    .filter((deal) => deal.isNew && !deal.shouldRemove && deal.score >= 55)
    .sort(sortBestDeals)
    .slice(0, 12)
    .map(publicDeal);
  const qualified = scoredDeals
    .filter((deal) => !deal.shouldRemove && deal.score >= 70)
    .sort(sortNewThenBest)
    .slice(0, 12)
    .map(publicDeal);
  const watchlist = scoredDeals
    .filter((deal) => !deal.shouldRemove && deal.score >= 55 && deal.score < 70)
    .sort(sortNewThenBest)
    .slice(0, 10)
    .map(publicDeal);
  const removalCandidates = scoredDeals
    .filter((deal) => deal.shouldRemove)
    .sort((left, right) => {
      const dateDifference = (Date.parse(right.dateAdded || right.lastUpdated || '') || 0) - (Date.parse(left.dateAdded || left.lastUpdated || '') || 0);
      return dateDifference || left.score - right.score;
    })
    .slice(0, 12)
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

export async function sendDailyDealHunterReview() {
  const result = await buildDailyDealReview();
  const { review, scoredDeals, storage } = result;
  const config = getConfig();
  const emailResult = await sendDailyDealHunterEmail({
    to: config.dealHunter.recipient || config.delivery.fallbackRecipient,
    review,
  });

  if (emailResult.status !== 'failed') {
    await persistDealHunterHistory(storage, scoredDeals);
  }

  return {
    review,
    emailResult,
  };
}
