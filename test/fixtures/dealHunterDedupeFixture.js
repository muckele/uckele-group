// Deterministic listing fixture for dedupeDeals tests. The same seed and count
// always produce the same deals, so a golden hash taken from one version of
// dedupeDeals can be compared against another.
//
// Besides ordinary listings, it plants syndicated duplicates for every
// automatic match reason, near-misses that must stay separate, and hard
// conflicts (state, source identity, financials, marketplace ID).

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const nameAdjectives = [
  'Premier', 'Reliable', 'Coastal', 'Summit', 'Heritage', 'Golden', 'Pioneer', 'Evergreen', 'Liberty', 'Keystone',
  'Northern', 'Southern', 'Valley', 'Metro', 'Classic', 'Precision', 'Allied', 'Family', 'Elite', 'Prime',
];
const nameTrades = [
  'Plumbing', 'HVAC', 'Landscaping', 'Roofing', 'Electrical', 'Pest Control', 'Pool Service', 'Janitorial',
  'Auto Repair', 'Dental Lab', 'Machine Shop', 'Sign Company', 'Bakery', 'Daycare', 'Staffing', 'Printing',
  'Moving', 'Fencing', 'Flooring', 'Welding',
];
const nameSuffixes = ['Services', 'Company', 'Group', 'Co', 'LLC', 'Inc', 'Solutions', 'Specialists'];
const states = ['TX', 'FL', 'CA', 'OH', 'GA', 'NC', 'AZ', 'CO'];
const cities = {
  TX: ['Austin', 'Dallas', 'Houston'], FL: ['Tampa', 'Orlando', 'Miami'], CA: ['Fresno', 'San Diego', 'Oakland'],
  OH: ['Columbus', 'Dayton', 'Akron'], GA: ['Atlanta', 'Macon', 'Savannah'], NC: ['Raleigh', 'Durham', 'Charlotte'],
  AZ: ['Phoenix', 'Tucson', 'Mesa'], CO: ['Denver', 'Boulder', 'Pueblo'],
};
const descriptionWords = [
  'established', 'recurring', 'commercial', 'residential', 'customers', 'contracts', 'service', 'trained', 'staff',
  'owner', 'absentee', 'growth', 'territory', 'equipment', 'fleet', 'vehicles', 'maintenance', 'revenue', 'margins',
  'loyal', 'referrals', 'reputation', 'licensed', 'insured', 'warehouse', 'inventory', 'seasonal', 'year', 'round',
  'management', 'transition', 'training', 'financing', 'available', 'SBA', 'qualified', 'buyers', 'turnkey',
  'operation', 'systems', 'software', 'scheduling', 'dispatch', 'municipal', 'industrial', 'clients', 'repeat',
  'business', 'location', 'lease', 'favorable', 'terms', 'retiring', 'decades', 'community', 'brand', 'website',
];
// A small pool of round financial figures, as real listings tend to use, so
// listings in one state share financial blocks the way production data does.
const askingPrices = [350000, 450000, 500000, 650000, 750000, 900000, 1000000, 1200000, 1500000, 2000000];
const profits = [120000, 150000, 180000, 200000, 250000, 300000, 400000, 500000];
const revenues = [600000, 800000, 1000000, 1250000, 1500000, 2000000, 3000000];
const brokerCompanies = ['Sunbelt', 'Transworld', 'Murphy', 'VR', 'Calhoun', 'Hedgestone'];
const extraRawColumns = [
  'Category', 'Subcategory', 'Employees', 'Real Estate', 'Inventory Included', 'FF&E', 'Reason for Selling',
  'Support & Training', 'Facilities', 'Competition', 'Growth & Expansion', 'Financing', 'Home Based', 'Relocatable',
  'Listing Status', 'Notes',
];

export function generateDedupeFixture({ seed = 20261109, count = 600 } = {}) {
  const random = mulberry32(seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const chance = (probability) => random() < probability;
  let serial = 0;
  const nextId = () => {
    serial += 1;
    return serial;
  };

  const words = (length) => Array.from({ length }, () => pick(descriptionWords));
  const longDescription = () => `${words(34).join(' ')}.`;
  const shortDescription = () => `${words(6).join(' ')}.`;
  const nearby = (value, fraction) => (Number.isFinite(value) ? Math.round(value * (1 + fraction)) : value);

  const rawFor = (deal, extra = {}) => {
    const raw = {
      'Business Name': deal.name,
      Industry: deal.industry,
      State: deal.state,
      City: deal.city,
      'Asking Price': deal.askingPrice ?? '',
      'Cash Flow': deal.annualProfit ?? '',
      'Gross Revenue': deal.annualRevenue ?? '',
      'Broker Name': deal.brokerName,
      'Broker Email': deal.brokerEmail,
      'Listing URL': deal.listingUrl,
    };
    for (const column of extraRawColumns) raw[column] = chance(0.7) ? words(3).join(' ') : '';
    return { ...raw, ...extra };
  };

  const listingUrl = (kind = pick(['bizbuysell', 'bizquest', 'dealstream', 'broker'])) => {
    const id = 1000000 + nextId() * 7 + Math.floor(random() * 5);
    if (kind === 'bizbuysell') return `https://www.bizbuysell.com/business-opportunity/listing-${id}/${id}/`;
    if (kind === 'bizquest') return `https://www.bizquest.com/business-for-sale/listing/BW${id}/`;
    if (kind === 'loopnet') return `https://www.loopnet.com/biz/business-for-sale/${id}/`;
    if (kind === 'dealstream') return `https://dealstream.com/d/business-for-sale/listing-${id}`;
    return `https://www.${pick(brokerCompanies).toLowerCase()}broker.com/listings/${id}`;
  };

  const baseDeal = (overrides = {}) => {
    const state = pick(states);
    const brokerCompany = pick(brokerCompanies);
    const brokerIndex = Math.floor(random() * 4);
    const id = nextId();
    const deal = {
      sourceId: pick(['sheet-0', 'sheet-1', 'bizbuysell-feed', 'dealstream-feed']),
      sourceName: 'Fixture Source',
      id: `listing-${id}`,
      stableExternalId: chance(0.3),
      name: `${pick(nameAdjectives)} ${pick(nameTrades)} ${pick(nameSuffixes)}${chance(0.3) ? ` ${id}` : ''}`,
      industry: pick(nameTrades),
      description: chance(0.75) ? longDescription() : shortDescription(),
      city: pick(cities[state]),
      county: '',
      state,
      country: 'US',
      location: '',
      askingPrice: chance(0.9) ? pick(askingPrices) : null,
      annualProfit: chance(0.85) ? pick(profits) : null,
      annualRevenue: chance(0.7) ? pick(revenues) : null,
      brokerName: `Broker ${brokerCompany} ${brokerIndex}`,
      brokerCompany,
      brokerEmail: `agent${brokerIndex}.${state.toLowerCase()}@${brokerCompany.toLowerCase()}.example.com`,
      listingUrl: chance(0.92) ? listingUrl() : '',
      listingSource: 'fixture',
      dateAdded: `2026-10-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}T00:00:00.000Z`,
      lastUpdated: '',
      ...overrides,
    };
    deal.location = `${deal.city}, ${deal.state}`;
    deal.brokerContacts = deal.brokerEmail
      ? [{ name: deal.brokerName, email: deal.brokerEmail, role: 'Broker', sourceColumn: 'Broker Email' }]
      : [];
    deal.raw = rawFor(deal);
    return deal;
  };

  // A copy of a listing as another site or source would publish it.
  const syndicate = (base, overrides = {}, rawExtra = {}) => {
    const id = nextId();
    const deal = {
      ...base,
      sourceId: base.sourceId === 'sheet-0' ? 'sheet-1' : 'sheet-0',
      id: `syndicated-${id}`,
      stableExternalId: false,
      listingUrl: listingUrl('broker'),
      dateAdded: '2026-10-29T00:00:00.000Z',
      ...overrides,
    };
    deal.location = `${deal.city}, ${deal.state}`;
    deal.brokerContacts = deal.brokerEmail
      ? [{ name: deal.brokerName, email: deal.brokerEmail, role: 'Agent', sourceColumn: 'Agent Email' }]
      : [];
    deal.raw = rawFor(deal, rawExtra);
    return deal;
  };

  const changeOneWord = (text) => {
    const tokens = text.replace(/\.$/, '').split(' ');
    tokens[Math.floor(random() * tokens.length)] = 'zzunique';
    return `${tokens.join(' ')}.`;
  };
  const changeWords = (text, howMany) => {
    const tokens = text.replace(/\.$/, '').split(' ');
    for (let index = 0; index < howMany; index += 1) tokens[index * 3] = `zzchanged${index}`;
    return `${tokens.join(' ')}.`;
  };
  const uniqueName = () => `${pick(nameAdjectives)} ${pick(nameTrades)} ${pick(nameSuffixes)} ${nextId()}`;
  const fullFinancials = () => ({
    askingPrice: pick(askingPrices),
    annualProfit: pick(profits),
    annualRevenue: pick(revenues),
  });

  const scenarios = {
    // Same bizbuysell ad ID on two sources: shared-durable-identity.
    sharedMarketplaceId: {
      expect: 'shared-durable-identity',
      build(deals) {
        const adId = 3000000 + nextId();
        const base = baseDeal({ listingUrl: `https://www.bizbuysell.com/business-opportunity/a-${adId}/${adId}/` });
        deals.push(base, syndicate(base, {
          listingUrl: `https://www.bizbuysell.com/business-opportunity/b-${adId}/${adId}/`,
          name: uniqueName(),
          description: shortDescription(),
        }));
      },
    },
    // Same broker reference and brokerage, different URLs and names: shared-durable-identity.
    sharedBrokerReference: {
      expect: 'shared-durable-identity',
      build(deals) {
        const reference = `REF-${nextId()}`;
        const base = baseDeal();
        base.raw = { ...base.raw, 'Broker Reference': reference, 'Broker Company': base.brokerCompany };
        deals.push(base, syndicate(base, { name: uniqueName(), description: longDescription() }, {
          'Broker Ref': reference,
          Brokerage: base.brokerCompany,
        }));
      },
    },
    // Exact title, near-identical long description, same state, one financial match.
    exactTitleDescription: {
      expect: 'title-description-location-financials',
      build(deals) {
        const base = baseDeal({
          name: uniqueName(),
          description: longDescription(),
          askingPrice: pick(askingPrices),
          annualRevenue: null,
          annualProfit: null,
        });
        deals.push(base, syndicate(base, {
          description: changeOneWord(base.description),
          city: pick(cities[base.state]),
          askingPrice: nearby(base.askingPrice, 0.01),
        }));
      },
    },
    // Similar but not exact title, identical long description, two financial matches.
    nearTitleDescription: {
      expect: 'near-title-description-location-financials',
      build(deals) {
        const name = uniqueName();
        const base = baseDeal({ name, description: longDescription(), ...fullFinancials() });
        deals.push(base, syndicate(base, {
          name: `${name} Business`,
          askingPrice: nearby(base.askingPrice, 0.02),
          annualProfit: nearby(base.annualProfit, -0.01),
          annualRevenue: null,
        }));
      },
    },
    // Exact title, no usable description, same state, two financial matches.
    exactTitleShort: {
      expect: 'exact-title-location-financials',
      build(deals) {
        const base = baseDeal({ name: uniqueName(), description: shortDescription(), ...fullFinancials() });
        deals.push(base, syndicate(base, {
          description: '',
          annualProfit: nearby(base.annualProfit, 0.02),
          annualRevenue: null,
        }));
      },
    },
    // Title contained in the other, short descriptions, three financial matches.
    nearTitleShort: {
      expect: 'near-title-location-financials',
      build(deals) {
        const name = uniqueName();
        const base = baseDeal({ name, description: shortDescription(), ...fullFinancials() });
        deals.push(base, syndicate(base, {
          name: `${name} For Sale`,
          description: shortDescription(),
          askingPrice: nearby(base.askingPrice, 0.01),
          annualRevenue: nearby(base.annualRevenue, -0.02),
        }));
      },
    },
    // Exact title, long descriptions too different (similarity below 0.9).
    descriptionNearMiss: {
      expect: 'separate',
      build(deals) {
        const base = baseDeal({ name: uniqueName(), description: longDescription(), ...fullFinancials() });
        deals.push(base, syndicate(base, { description: changeWords(base.description, 5) }));
      },
    },
    // Exact title, short description, only one financial within 3%.
    financialNearMiss: {
      expect: 'separate',
      build(deals) {
        const base = baseDeal({ name: uniqueName(), description: shortDescription(), ...fullFinancials() });
        deals.push(base, syndicate(base, {
          description: '',
          annualProfit: nearby(base.annualProfit, 0.05),
          annualRevenue: nearby(base.annualRevenue, 0.06),
        }));
      },
    },
    // Same listing in a different state.
    stateConflict: {
      expect: 'separate',
      build(deals) {
        const base = baseDeal({ name: uniqueName(), ...fullFinancials() });
        const otherState = states[(states.indexOf(base.state) + 1) % states.length];
        deals.push(base, syndicate(base, { state: otherState, city: pick(cities[otherState]) }));
      },
    },
    // Same stable source, different stable IDs.
    sourceConflict: {
      expect: 'separate',
      build(deals) {
        const base = baseDeal({ name: uniqueName(), sourceId: 'deal-os-export', stableExternalId: true, ...fullFinancials() });
        deals.push(base, syndicate(base, { sourceId: 'deal-os-export', stableExternalId: true, id: `os-${nextId()}` }));
      },
    },
    // Two financials at least 15% apart.
    financialConflict: {
      expect: 'separate',
      build(deals) {
        const base = baseDeal({ name: uniqueName(), ...fullFinancials() });
        deals.push(base, syndicate(base, {
          askingPrice: nearby(base.askingPrice, 0.3),
          annualProfit: nearby(base.annualProfit, -0.25),
        }));
      },
    },
    // Near title, short descriptions, matching financials, but different
    // CoStar ad IDs: blocked by the marketplace conflict.
    marketplaceConflict: {
      expect: 'separate',
      build(deals) {
        const name = uniqueName();
        const base = baseDeal({ name, description: shortDescription(), ...fullFinancials(), listingUrl: listingUrl('bizbuysell') });
        deals.push(base, syndicate(base, {
          name: `${name} For Sale`,
          description: shortDescription(),
          listingUrl: listingUrl('loopnet'),
        }));
      },
    },
    // A three-way syndication where the third copy only matches the second.
    weakChain: {
      expect: null,
      build(deals) {
        const name = uniqueName();
        const base = baseDeal({ name, description: shortDescription(), ...fullFinancials() });
        const second = syndicate(base, { annualRevenue: nearby(base.annualRevenue, 0.02) });
        const third = syndicate(second, { name: `${name} Business`, annualRevenue: nearby(second.annualRevenue, 0.025) });
        deals.push(base, second, third);
      },
    },
  };
  const scenarioNames = Object.keys(scenarios);

  const deals = [];
  const planted = [];
  let scenarioIndex = 0;
  while (deals.length < count) {
    if (chance(0.25)) {
      const scenario = scenarioNames[scenarioIndex % scenarioNames.length];
      const firstIndex = deals.length;
      scenarios[scenario].build(deals);
      planted.push({
        scenario,
        expect: scenarios[scenario].expect,
        ids: deals.slice(firstIndex).map((deal) => deal.id),
      });
      scenarioIndex += 1;
    } else {
      deals.push(baseDeal());
    }
  }
  deals.length = count;
  const includedIds = new Set(deals.map((deal) => deal.id));

  // Shuffle so planted copies are not adjacent in the input.
  for (let index = deals.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [deals[index], deals[swap]] = [deals[swap], deals[index]];
  }
  return {
    deals,
    // Planted copies cut off by the count are left out.
    planted: planted.filter(({ ids }) => ids.every((id) => includedIds.has(id))),
  };
}
