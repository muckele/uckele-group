// Deterministic synthetic corpus for Deal Hunter scoring compatibility.
//
// This corpus is the regression harness for `deal-hunter-fit-v2`. It is
// generated from a fixed cross-product of the inputs the scorer actually
// branches on, so that decomposing the scorer into explainable dimensions can be
// proven not to move a single score. Every case is synthetic; no real listing,
// broker, or seller content appears here.

const narrativeByTheme = {
  none: { industry: '', description: '' },
  bare: { industry: 'Services', description: '' },
  recurring: {
    industry: 'Commercial HVAC maintenance',
    description:
      'Recurring maintenance contracts and service agreements with commercial customers on scheduled '
      + 'preventive maintenance routes. Contracted revenue from repeat customers across office and warehouse '
      + 'facilities.',
  },
  resilient: {
    industry: 'Fire safety inspection and testing',
    description:
      'Essential non-discretionary compliance inspection and testing work performed by licensed field '
      + 'technicians. Regulated compliance repair and replacement for industrial and municipal facilities.',
  },
  managed: {
    industry: 'Facility maintenance company',
    description:
      'Owner retiring with a general manager and trained staff already in place. Management in place with '
      + 'an operations manager running day to day scheduling for commercial accounts.',
  },
  ownerDependent: {
    industry: 'Specialty electrical service',
    description:
      'Owner operator performs all sales and estimating personally. The business depends on the owner '
      + 'relationships and the owner is the licensed holder for every job.',
  },
  concentrated: {
    industry: 'Industrial equipment repair',
    description:
      'One customer represents the majority of revenue. Customer concentration is significant and the '
      + 'largest account drives most of the annual volume for this single-client operation.',
  },
  capexHeavy: {
    industry: 'Environmental services fleet',
    description:
      'Asset heavy operation with an aging fleet requiring capital expenditure and deferred maintenance on '
      + 'heavy equipment. Significant capex is expected for equipment replacement.',
  },
  excluded: {
    industry: 'Restaurant and catering group',
    description: 'A restaurant and catering business serving food and beverage in a hospitality setting.',
  },
  financeable: {
    industry: 'Plumbing service contractor',
    description:
      'SBA eligible with seller financing available. Seller note considered for a qualified buyer with '
      + 'recurring maintenance contracts and commercial customers on service agreements.',
  },
};

const profitCases = [
  { key: 'missing', annualProfit: null },
  { key: 'far-below', annualProfit: 120000 },
  { key: 'below-floor', annualProfit: 250000 },
  { key: 'in-band-low', annualProfit: 320000 },
  { key: 'in-band-high', annualProfit: 720000 },
  { key: 'above-band', annualProfit: 900000 },
  { key: 'far-above-band', annualProfit: 1400000 },
];

const priceCases = [
  { key: 'no-price', askingPrice: null, profitMultiple: null },
  { key: 'cheap-multiple', askingPrice: 900000, profitMultiple: 2.5 },
  { key: 'workable-multiple', askingPrice: 1300000, profitMultiple: 3.7 },
  { key: 'rich-multiple', askingPrice: 1900000, profitMultiple: 4.6 },
  { key: 'expensive-multiple', askingPrice: 2600000, profitMultiple: 6.2 },
  { key: 'implied-only', askingPrice: 1100000, profitMultiple: null },
  { key: 'tiny-price', askingPrice: 180000, profitMultiple: null },
];

const ageCases = [
  { key: 'age-missing', yearsEstablished: null, fiveYearsFlag: '' },
  { key: 'age-flagged', yearsEstablished: null, fiveYearsFlag: 'Yes' },
  { key: 'age-young', yearsEstablished: 3, fiveYearsFlag: '' },
  { key: 'age-established', yearsEstablished: 18, fiveYearsFlag: 'Yes' },
];

const locationCases = [
  { key: 'target-state', state: 'NY', remoteFlag: '' },
  { key: 'other-state', state: 'TX', remoteFlag: '' },
  { key: 'remote', state: 'TX', remoteFlag: 'Yes' },
  { key: 'no-location', state: '', remoteFlag: '' },
];

const flagCases = [
  { key: 'plain', franchiseFlag: '' },
  { key: 'franchise', franchiseFlag: 'Yes' },
];

function buildFullText(deal) {
  return [
    deal.name,
    deal.industry,
    deal.description,
    deal.city,
    deal.county,
    deal.state,
    deal.remoteFlag,
    deal.franchiseFlag,
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function buildDeal({ id, theme, profit, price, age, location, flags, withBroker }) {
  const narrative = narrativeByTheme[theme];
  const deal = {
    id,
    dealKey: `deal-${id}`,
    name: `Synthetic Holdings ${id}`,
    industry: narrative.industry,
    description: narrative.description,
    city: location.state ? 'Springfield' : '',
    county: '',
    state: location.state,
    country: 'USA',
    location: location.state ? `Springfield, ${location.state}` : '',
    annualProfit: profit.annualProfit,
    annualRevenue: profit.annualProfit === null ? null : profit.annualProfit * 4,
    askingPrice: price.askingPrice,
    profitMultiple: price.profitMultiple,
    netMargin: profit.annualProfit === null ? null : 24,
    yearsEstablished: age.yearsEstablished,
    fiveYearsFlag: age.fiveYearsFlag,
    remoteFlag: location.remoteFlag,
    franchiseFlag: flags.franchiseFlag,
    brokerName: withBroker ? 'Synthetic Broker' : '',
    brokerEmail: withBroker ? `broker-${id}@example.invalid` : '',
    brokerCompany: withBroker ? 'Synthetic Brokerage' : '',
    brokerContact: '',
    brokerContacts: [],
    listingUrl: `https://listings.example.invalid/${id}`,
    listingSource: 'synthetic-corpus',
    sourceId: 'synthetic',
    sourceName: 'Synthetic corpus',
    sourceMode: 'fixture',
    dateAdded: '2026-01-05',
    lastUpdated: '2026-01-06',
    raw: {},
  };
  deal.fullText = buildFullText(deal);
  return deal;
}

// A fixed cross-product rather than random sampling, so the corpus is stable
// across machines and reruns and a diff shows exactly which case moved.
export function buildScoringCorpus() {
  const themes = Object.keys(narrativeByTheme);
  const deals = [];
  let index = 0;

  for (const theme of themes) {
    for (const profit of profitCases) {
      for (const price of priceCases) {
        index += 1;
        const age = ageCases[index % ageCases.length];
        const location = locationCases[index % locationCases.length];
        const flags = flagCases[index % flagCases.length];
        deals.push(buildDeal({
          id: `${theme}-${profit.key}-${price.key}`,
          theme,
          profit,
          price,
          age,
          location,
          flags,
          withBroker: index % 3 !== 0,
        }));
      }
    }
  }

  // Targeted edge cases the cross-product does not reach.
  for (const age of ageCases) {
    for (const location of locationCases) {
      index += 1;
      deals.push(buildDeal({
        id: `edge-${age.key}-${location.key}`,
        theme: 'recurring',
        profit: profitCases[3],
        price: priceCases[1],
        age,
        location,
        flags: flagCases[0],
        withBroker: index % 2 === 0,
      }));
    }
  }

  return deals;
}

export const scoringCorpusThemes = Object.keys(narrativeByTheme);
