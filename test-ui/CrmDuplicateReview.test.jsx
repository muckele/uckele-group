// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import CrmDuplicateReview from '../src/components/admin/CrmDuplicateReview.jsx';

afterEach(cleanup);

const categories = [
  'resolved/superseded',
  'confirmed-duplicate',
  'strong-candidate',
  'uncertain',
  'keep-distinct',
];

function row(category, suffix, overrides = {}) {
  return {
    pairKey: `${suffix}-a::${suffix}-b`,
    lowerSubmissionId: `${suffix}-a`,
    higherSubmissionId: `${suffix}-b`,
    category,
    corroboratingEvidence: [{ category: 'stable-listing-identity', hash: 'a'.repeat(64) }],
    conflictingEvidence: [],
    currentRelationship: { opportunityId: `opp-${suffix}`, primarySubmissionId: null },
    activeSupersession: null,
    ownerDecision: null,
    blockers: [],
    ...overrides,
  };
}

describe('CRM duplicate review', () => {
  test('renders all five pairwise categories, privacy-safe evidence, and navigation-only CRM links', () => {
    const report = {
      version: 'crm-duplicate-review-v1',
      complete: true,
      code: null,
      reason: null,
      limits: { submissions: 5000, candidatePairs: 10000 },
      counts: { submissions: 10, candidatePairs: 5 },
      categories,
      rows: [
        row('resolved/superseded', 'resolved', {
          activeSupersession: {
            relationId: 'relation-safe',
            survivorSubmissionId: 'survivor-resolved',
            supersededSubmissionId: 'resolved-a',
            opportunityId: 'opp-resolved',
          },
        }),
        row('confirmed-duplicate', 'confirmed'),
        row('strong-candidate', 'strong'),
        row('uncertain', 'uncertain', { blockers: ['canonical-opportunity-conflict'] }),
        row('keep-distinct', 'distinct', { blockers: ['owner-reviewed-distinct-canonical-opportunities'] }),
      ],
    };
    render(<CrmDuplicateReview report={report} />);

    expect(screen.getByRole('heading', { name: 'CRM duplicate review' })).toBeVisible();
    for (const category of categories) {
      expect(screen.getByRole('heading', { name: category })).toBeVisible();
    }
    expect(screen.getAllByText('stable-listing-identity').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/aaaaaaaaaaaa/).length).toBeGreaterThan(0);
    const survivorLink = screen.getByRole('link', { name: /surviving CRM record/i });
    expect(survivorLink).toHaveAttribute('href', '/admin/crm/survivor-resolved');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/merge|reverse|apply|bulk/i)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^\/admin\/crm\/[A-Za-z0-9._%-]+$/);
    }
  });

  test('shows a fail-closed incomplete state without presenting prefix results', () => {
    render(<CrmDuplicateReview report={{
      version: 'crm-duplicate-review-v1',
      complete: false,
      code: 'CRM_DUPLICATE_REVIEW_INCOMPLETE',
      reason: 'authority-snapshot-incomplete',
      limits: { submissions: 5000, candidatePairs: 10000 },
      counts: { submissions: 5001, candidatePairs: null },
      categories,
      rows: [],
    }} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/could not prove a complete bounded snapshot/i)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/prefix/i)).not.toBeInTheDocument();
  });
});
