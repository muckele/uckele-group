// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import OperationsCenter from '../src/components/admin/OperationsCenter.jsx';
import EmailReadinessPanel from '../src/components/admin/EmailReadinessPanel.jsx';

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

  test('shows generic email gates and body-free operational metrics without overstating delivery', () => {
    render(<EmailReadinessPanel data={{
      provider: 'resend',
      outboundConfigured: true,
      deliveryTrackingConfigured: true,
      deliveryTrackingVerified: true,
      replyTrackingConfigured: true,
      replyTrackingVerified: true,
      followUpsEnabled: false,
      genericFollowUpsEnabled: true,
      genericFollowUpsSafe: true,
      suppressionOperational: true,
      physicalPostalAddressConfigured: true,
      optOutConfigured: true,
      replyOptOutConfigured: true,
      aiEnabled: false,
      aiReady: false,
      aiReadiness: {
        modelConfigured: false,
        apiKeyConfigured: false,
        reasoningConfigured: true,
        reasoningEffort: 'low',
        timeoutConfigured: true,
        contextLimitConfigured: true,
        outputLimitConfigured: true,
        retryLimitConfigured: true,
        rateLimitConfigured: true,
        dataHandlingApproved: false,
        costRateApproved: false,
        evalAccepted: false,
        acceptedEvalVersion: '',
        expectedEvalVersion: 'follow-up-eval-v1',
        syntheticSmokeObserved: false,
        promptVersion: 'follow-up-ai-prompt-v2',
        schemaVersion: 'follow-up-ai-schema-v2',
        maxContextCharacters: 30000,
        maxOutputTokens: 1600,
        timeoutMs: 12000,
        maxRetries: 0,
        rateLimitPerMinute: 10,
      },
      metricsAvailable: true,
      metrics: {
        windowStartedAt: '2026-07-10T20:00:00.000Z',
        sentLast24Hours: 3,
        dailyCap: 25,
        suppressions: { active: 4 },
        outbox: { queued: 1, sending: 0, accepted: 8, ambiguous: 1, retryableFailed: 1, permanentFailed: 0 },
        rates: {
          recommendationAcceptance: 75,
          recommendationEdit: 25,
          recommendationDismissal: 25,
          delivery: 80,
          bounce: 10,
          reply: 25,
          aiFallback: null,
        },
        ai: {
          fallbackReasons: {},
          responseStates: {},
          latencyMs: { observed: 0, average: null, minimum: null, maximum: null },
          tokens: {
            observed: 0,
            inputTotal: null,
            outputTotal: null,
            cachedTotal: null,
            reasoningTotal: null,
          },
        },
      },
      domainAuthentication: {
        guidance: 'Verify SPF, DKIM, and DMARC manually.',
        providerUrl: 'https://resend.com/domains',
      },
      issues: [],
    }} />);

    expect(screen.getByText('Enabled with all safety gates verified')).toBeVisible();
    expect(screen.getByText('4 active global suppression(s)')).toBeVisible();
    expect(screen.getByText('3 / 25')).toBeVisible();
    expect(screen.getByText(/8 provider-accepted/)).toBeVisible();
    expect(screen.getByText(/Never retry an ambiguous command/)).toBeVisible();
    expect(screen.getByText('Deterministic Recommendations')).toBeVisible();
    expect(screen.getByText('AI Feature Flag')).toBeVisible();
    expect(screen.getByText('AI Model')).toBeVisible();
    expect(screen.getByText('AI API Key')).toBeVisible();
    expect(screen.getByText('AI Request Bounds')).toBeVisible();
    expect(screen.getByText('AI Data Approval')).toBeVisible();
    expect(screen.getByText('AI Cost & Rate')).toBeVisible();
    expect(screen.getByText('AI Evaluation')).toBeVisible();
    expect(screen.getByText('AI Synthetic Smoke')).toBeVisible();
    expect(screen.getByText('Controlled synthetic smoke not observed')).toBeVisible();
    expect(screen.getAllByText('Not observed').length).toBeGreaterThan(0);
    const aiFallbackCard = screen.getByText('AI fallback').closest('div');
    expect(within(aiFallbackCard).getByText('Not observed')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Resend Domains' })).toHaveAttribute('href', 'https://resend.com/domains');
  });
});
