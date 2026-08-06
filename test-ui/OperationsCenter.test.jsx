// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import OperationsCenter from '../src/components/admin/OperationsCenter.jsx';

afterEach(cleanup);

describe('Operations Center partial failures', () => {
  test('keeps healthy panels visible while showing sanitized panel errors', () => {
    render(
      <OperationsCenter
        data={{
          scheduler: { runs: [], failures: 0, pending: 0, error: 'Scheduler history is temporarily unavailable.' },
          sources: {
            current: { healthy: true, generatedAt: '2026-07-13T18:00:00.000Z', issues: [] },
            history: [],
            currentError: '',
            historyError: 'Source-health history is temporarily unavailable.',
          },
          audit: { events: [], error: '' },
          cleanup: { failures: [], error: '' },
          storage: {
            disk: { ok: true, totalBytes: 1000, freeBytes: 700, freePercent: 70 },
            database: { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 300 },
            diskError: '',
            databaseError: '',
          },
          backup: {
            status: 'degraded',
            message: 'A valid backup is available, but one incomplete bundle requires attention.',
            bundleCounts: { valid: 1, invalid: 0, incomplete: 1 },
            latest: { createdAt: '2026-07-13T10:00:00.000Z', documentCount: 2 },
          },
          communications: { pending: 2, failed: 1, unassigned: 3, error: '' },
        }}
      />,
    );

    expect(screen.getByText('70% free')).toBeVisible();
    expect(screen.getByText('Integrity: ok')).toBeVisible();
    expect(screen.getByText('Scheduler history is temporarily unavailable.')).toBeVisible();
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.queryByText('0 failed · 0 pending')).not.toBeInTheDocument();
    expect(screen.getByText('Source-health history is temporarily unavailable.')).toBeVisible();
    expect(screen.getByText('Bundles: 1 valid · 0 invalid · 1 incomplete')).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Operations sections' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Core systems' })).toHaveAttribute('href', '#core-systems-heading');
    expect(screen.getByRole('link', { name: 'Communications' })).toHaveAttribute('href', '#communication-ingestion-heading');
    expect(screen.getByRole('heading', { name: 'Communication ingestion status' })).toBeVisible();
    expect(screen.getByText('2 pending · 1 failed · 3 unassigned')).toBeVisible();
    expect(screen.getByText('6 need attention')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Core systems at a glance' })).toBeVisible();
  });
});
