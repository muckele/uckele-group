import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreDeal } from '../server/services/dealHunter.js';

function baseDeal(overrides = {}) {
  const fullText = [
    overrides.name,
    overrides.industry,
    overrides.description,
    overrides.state,
    overrides.remoteFlag,
  ].filter(Boolean).join(' ');

  return {
    id: 'deal-1',
    name: 'Commercial HVAC Maintenance Co',
    industry: 'Commercial HVAC maintenance',
    description: '',
    annualProfit: 450000,
    annualRevenue: 1800000,
    askingPrice: 1400000,
    profitMultiple: null,
    yearsEstablished: 12,
    remoteFlag: '',
    franchiseFlag: '',
    state: 'CA',
    fullText,
    ...overrides,
  };
}

test('scoring qualifies durable recurring field-service deals as high fit', () => {
  const deal = baseDeal({
    description:
      'Commercial HVAC recurring maintenance contracts, service agreements, scheduled maintenance, field technicians, repair, replacement, compliance work, trained staff, management in place, SBA eligible, seller financing available.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.shouldRemove, false);
  assert.ok(scored.score >= 75, `expected high-fit score, got ${scored.score}`);
  assert.equal(scored.concerns.some((concern) => /No explicit recurring/i.test(concern)), false);
});

test('scoring hard-removes excluded categories even with recurring revenue language', () => {
  const deal = baseDeal({
    name: 'Medical Practice With Recurring Patients',
    industry: 'Physician practice',
    description:
      'Recurring revenue, repeat patients, strong EBITDA, maintenance contracts, management in place, SBA eligible, but buyer must be a physician.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.shouldRemove, true);
  assert.ok(scored.score <= 34, `expected excluded score cap, got ${scored.score}`);
  assert.equal(scored.removeReasons.some((reason) => /Excluded category match/i.test(reason)), true);
});

test('scoring caps owner-dependent project work below high fit', () => {
  const deal = baseDeal({
    name: 'General Business Services Co',
    industry: 'Business services',
    description:
      'Project-based work with strong annual profit. Owner operator handles sales and production. One customer accounts for a large portion of revenue.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.shouldRemove, false);
  assert.ok(scored.score < 75, `expected capped watchlist score, got ${scored.score}`);
  assert.equal(scored.concerns.some((concern) => /Owner-dependency risk/i.test(concern)), true);
  assert.equal(scored.concerns.some((concern) => /Customer concentration risk/i.test(concern)), true);
});

test('scoring does not treat non-recurring language as recurring revenue strength', () => {
  const deal = baseDeal({
    name: 'Commercial Project Services Co',
    industry: 'Commercial facility services',
    description:
      'Commercial facility repair and maintenance services with non-recurring project-based revenue, field technicians, compliance work, and trained staff.',
  });
  const scored = scoreDeal({
    ...deal,
    fullText: [deal.name, deal.industry, deal.description, deal.state].join(' '),
  });

  assert.equal(scored.strengths.some((strength) => /Recurring or repeat revenue signals/i.test(strength)), false);
  assert.equal(scored.concerns.some((concern) => /Financial quality risk language found/i.test(concern)), true);
});
