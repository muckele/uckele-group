import assert from 'node:assert/strict';
import test from 'node:test';

test('automatic Stage 2 copy includes purpose, reply opt-out, and postal address in text and HTML while manual Stage 1 stays unchanged', async () => {
  process.env.DEAL_HUNTER_CIM_AUTOMATION_PHYSICAL_POSTAL_ADDRESS = '100 Main Street, Los Angeles, CA 90001';
  const { buildDealHunterCimRequestEmail } = await import('../server/services/delivery.js');
  const deal = {
    dealKey: 'deal-1',
    opportunityId: 'opportunity-1',
    name: 'Commercial Safety Services',
    brokerName: 'Erin Broker',
    listingUrl: 'https://broker.example.test/listing-1',
  };
  const automatic = buildDealHunterCimRequestEmail({
    to: 'broker@example.test', deal, requestedBy: 'automation-stage-2', cimRequestId: 'automatic-request',
  });
  const manual = buildDealHunterCimRequestEmail({
    to: 'broker@example.test', deal, requestedBy: 'human-admin', cimRequestId: 'manual-request',
  });

  for (const content of [automatic.text, automatic.html]) {
    assert.match(content, /commercial acquisition-outreach message/i);
    assert.match(content, /reply with (?:“|&ldquo;|&#x201c;|&quot;)?unsubscribe/i);
    assert.match(content, /100 Main Street, Los Angeles, CA 90001/);
  }
  assert.doesNotMatch(manual.text, /commercial acquisition-outreach message/i);
  assert.doesNotMatch(manual.html, /reply with (?:“|&ldquo;|&#x201c;|&quot;)?unsubscribe/i);
  assert.doesNotMatch(manual.text, /100 Main Street, Los Angeles, CA 90001/);
});
