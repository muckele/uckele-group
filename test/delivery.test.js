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

const visibleFollowUpSequenceLabels = [
  'Follow-Up',
  'follow-up',
  'Following up',
  'following up',
  'Second follow-up',
  'Final follow-up',
  'final follow-up',
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

function assertBrokerEmailHidesFollowUpSequenceLabels(message) {
  const visibleContent = brokerVisibleContent(message);

  for (const label of visibleFollowUpSequenceLabels) {
    assert.equal(
      visibleContent.includes(label),
      false,
      `Broker email should not expose follow-up sequence label "${label}"`,
    );
  }
}

function assertBrokerEmailOmitsBodyHeadline(message) {
  assert.equal(
    message.html.includes('<h1'),
    false,
    'Broker email body should not render a repeated subject headline',
  );
  assert.equal(
    message.html.includes('CIM Request</p>'),
    false,
    'Broker email body should not render a campaign-style CIM Request eyebrow',
  );
}

test('CIM request email keeps internal score and deal economics out of broker-visible content', () => {
  const message = buildDealHunterCimRequestEmail({
    to: 'broker@example.com',
    deal: sampleDeal,
    requestedBy: 'Mathew Uckele',
  });

  assert.equal(message.kind, 'deal-hunter-cim-request');
  assert.match(message.subject, /CIM \/ NDA request/);
  assert.match(message.text, /Could you please send over the CIM or teaser, or let me know the NDA process\?/);
  assert.match(message.html, /View Listing/);
  assertBrokerEmailOmitsBodyHeadline(message);
  assertBrokerEmailHidesFollowUpSequenceLabels(message);
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
    assert.match(message.subject, /^Re: CIM \/ NDA request/);
    assert.equal(message.tracking.followUpNumber, followUpNumber);
    assert.equal(message.tags.some((tag) => tag.name === 'follow_up_number' && tag.value === String(followUpNumber)), true);
    assertBrokerEmailOmitsBodyHeadline(message);
    assertBrokerEmailHidesFollowUpSequenceLabels(message);
    assert.equal(message.text.includes(`#${followUpNumber}`), false);
    assert.equal(message.html.includes('>Follow-Up</td>'), false);
    assert.equal(message.html.includes(`>#${followUpNumber}</td>`), false);
    assertBrokerEmailHidesInternalDetails(message);
  }
});
