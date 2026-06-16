import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diligenceReviewsEqual, normalizeDiligenceReview } from '../server/services/submissions.js';

test('diligence review normalizer whitelists fields and preserves existing partial state', () => {
  const normalized = normalizeDiligenceReview(
    {
      stage: 'not-a-stage',
      decision: 'pass',
      checklist: {
        cim: true,
        unknown_item: true,
      },
      financing: {
        estimated_down_payment: '$100K-$110K available',
      },
      memo: 'No operator coverage.',
      extra: 'ignore me',
    },
    {
      stage: 'cim-received',
      decision: 'advance',
      checklist: {
        nda: true,
        p_and_l: true,
      },
      financing: {
        seller_note: '15% target',
        investor_gap: '$250K',
      },
      questions: 'Ask for customer concentration.',
      memo: 'Prior memo.',
      updated_at: '2026-06-01T12:00:00.000Z',
    },
    { now: '2026-06-15T12:00:00.000Z' },
  );

  assert.equal(normalized.stage, 'cim-received');
  assert.equal(normalized.decision, 'pass');
  assert.equal(normalized.checklist.cim, true);
  assert.equal(normalized.checklist.nda, true);
  assert.equal(normalized.checklist.p_and_l, true);
  assert.equal(Object.hasOwn(normalized.checklist, 'unknown_item'), false);
  assert.equal(normalized.financing.estimated_down_payment, '$100K-$110K available');
  assert.equal(normalized.financing.seller_note, '15% target');
  assert.equal(normalized.financing.investor_gap, '$250K');
  assert.equal(normalized.questions, 'Ask for customer concentration.');
  assert.equal(normalized.memo, 'No operator coverage.');
  assert.equal(normalized.updated_at, '2026-06-15T12:00:00.000Z');
  assert.equal(Object.hasOwn(normalized, 'extra'), false);
});

test('diligence comparison ignores timestamp-only differences', () => {
  const existing = {
    stage: 'cim-received',
    decision: 'advance',
    checklist: {
      cim: true,
    },
    financing: {
      estimated_down_payment: '$100K-$110K available',
      seller_note: '15% target',
      investor_gap: '',
      sba_lender_status: 'Pre-screened',
    },
    questions: 'Ask for customer concentration.',
    memo: 'Good if owner role is transitionable.',
    updated_at: '2026-06-01T12:00:00.000Z',
  };
  const submitted = {
    ...existing,
    updated_at: '2026-06-15T12:00:00.000Z',
  };

  assert.equal(diligenceReviewsEqual(submitted, existing), true);
  assert.equal(diligenceReviewsEqual({ ...submitted, decision: 'pause' }, existing), false);
  assert.equal(diligenceReviewsEqual({}, undefined), true);
});
