import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDealHunterCimFollowUpEmail,
  buildDealHunterCimRequestEmail,
} from '../server/services/delivery.js';

const sensitiveBrokerDetails = [
  'Internal Fit Score',
  'internal fit score',
  '92/100',
  'Score 92',
  '$450,000',
  '$1,600,000',
  'Profit',
  'Asking Price',
];

const sampleDeal = {
  dealKey: 'commercial-hvac-maintenance-co',
  name: 'Commercial HVAC Maintenance Co',
  brokerName: 'Test Broker',
  industry: 'Commercial HVAC maintenance',
  location: 'San Diego, CA',
  annualProfit: 450000,
  askingPrice: 1600000,
  score: 92,
  listingUrl: 'https://uckelegroup.com/admin',
};

function brokerVisibleContent(message) {
  return [message.subject, message.text, message.html].join('\n');
}

function assertBrokerEmailHidesInternalDetails(message) {
  const visibleContent = brokerVisibleContent(message);

  for (const sensitiveDetail of sensitiveBrokerDetails) {
    assert.equal(
      visibleContent.includes(sensitiveDetail),
      false,
      `Broker email should not expose "${sensitiveDetail}"`,
    );
  }
}

test('CIM request email keeps internal score and deal economics out of broker-visible content', () => {
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: sampleDeal,
    requestedBy: 'Mathew Uckele',
  });

  assert.equal(message.kind, 'deal-hunter-cim-request');
  assert.match(message.subject, /CIM \/ NDA request/);
  assert.match(message.text, /Could you please send over the CIM, teaser, NDA, or available financial package\?/);
  assert.match(message.html, /View Listing/);
  assertBrokerEmailHidesInternalDetails(message);
});

test('CIM follow-up emails keep internal score and deal economics out of broker-visible content', () => {
  for (const followUpNumber of [1, 2, 3]) {
    const message = buildDealHunterCimFollowUpEmail({
      to: 'broker@example.com',
      followUpNumber,
      requestedBy: 'Mathew Uckele',
      request: {
        id: 'request-1',
        deal_key: sampleDeal.dealKey,
        deal_name: sampleDeal.name,
        listing_url: sampleDeal.listingUrl,
        score: sampleDeal.score,
        metadata: {
          industry: sampleDeal.industry,
          location: sampleDeal.location,
          annualProfit: sampleDeal.annualProfit,
          askingPrice: sampleDeal.askingPrice,
        },
      },
    });

    assert.equal(message.kind, 'deal-hunter-cim-follow-up');
    assert.match(message.subject, /CIM \/ NDA request/);
    assert.match(message.text, new RegExp(`Follow-Up: #${followUpNumber}`));
    assertBrokerEmailHidesInternalDetails(message);
  }
});
