const incidentDescription = [
  'Established commercial field services business with recurring maintenance agreements.',
  'Experienced technicians provide inspection installation repair and emergency response.',
  'Diversified customers and documented operating procedures support predictable operations.',
].join(' ');

const shared = {
  name: 'Commercial Services Company',
  annualRevenue: 5_600_000,
  brokerName: 'Synthetic Incident Broker',
  brokerEmail: 'incident-broker@example.test',
  sourceName: 'Synthetic Daily Deal Hunter',
  stableExternalId: false,
  identityAliases: [],
  country: 'US',
};

export const augustNoUrlListing = Object.freeze({
  ...shared,
  dealKey: 'fingerprint:synthetic-august-original',
  sourceId: 'sheet-0',
  id: 'synthetic-row-17',
  description: incidentDescription,
  location: 'Springfield, MO',
  city: 'Springfield',
  state: 'MO',
  annualProfit: 800_000,
  askingPrice: 6_500_000,
  listingUrl: '',
  sourceRecords: [{ sourceId: 'sheet-0' }],
});
export const augustLaterUrlListing = Object.freeze({
  ...augustNoUrlListing,
  dealKey: 'url:https://www.bizbuysell.com/business-opportunity/synthetic-commercial-services/1234567/',
  listingUrl: 'https://www.bizbuysell.com/business-opportunity/synthetic-commercial-services/1234567/',
  sourceRecords: [{ sourceId: 'sheet-0' }, { sourceId: 'deal-os' }],
});

export const augustMateriallyDistinctLookalike = Object.freeze({
  ...shared,
  dealKey: 'url:https://www.bizbuysell.com/business-opportunity/synthetic-commercial-services/7654321/',
  sourceId: 'deal-os',
  id: 'synthetic-lookalike-41',
  description: 'Consumer entertainment venue with arcade games parties concessions memberships and weekend events.',
  location: 'Albany, NY',
  city: 'Albany',
  state: 'NY',
  annualProfit: 210_000,
  askingPrice: 2_300_000,
  listingUrl: 'https://www.bizbuysell.com/business-opportunity/synthetic-commercial-services/7654321/',
  sourceRecords: [{ sourceId: 'deal-os' }],
});
