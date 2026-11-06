// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import OperationsCenter from '../src/components/admin/OperationsCenter.jsx';
import EmailReadinessPanel from '../src/components/admin/EmailReadinessPanel.jsx';

// The Email sending card loads its own status; keep that request pending so these tests stay
// about the Operations data they pass in.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Operations Center partial failures', () => {
  test.each([
    [{ loading: true }, 'Loading operations readiness…'],
    [{ error: 'Operations are unavailable.' }, 'Operations are unavailable.'],
    [{}, 'No operations readiness data is available.'],
  ])('retains stable guide targets before operational data is available', (props, expectedText) => {
    const { container } = render(<OperationsCenter {...props} />);

    expect(screen.getByText(expectedText)).toBeVisible();
    expect(container.querySelector('[data-admin-tour="operations-readiness"]')).toBeInTheDocument();
    expect(container.querySelector('[data-admin-tour="operations-history"]')).toBeInTheDocument();
    expect(container.querySelector('[data-admin-tour="operations-storage"]')).toBeInTheDocument();
  });

  test('keeps healthy panels visible while showing sanitized panel errors', () => {
    const { container } = render(
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
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
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
    expect(container.querySelector('[data-admin-tour="operations-readiness"]')).toBeInTheDocument();
    expect(container.querySelector('[data-admin-tour="operations-history"]')).toBeInTheDocument();
    expect(container.querySelector('[data-admin-tour="operations-storage"]')).toBeInTheDocument();
  });

  test('renders the Email sending card and links to it', () => {
    render(<OperationsCenter data={{ scheduler: { runs: [] }, sources: {}, audit: {}, cleanup: {}, storage: {}, backup: {} }} />);

    expect(screen.getByRole('heading', { name: 'Email sending' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Email sending' })).toHaveAttribute('href', '#email-sending-heading');
    expect(fetch).toHaveBeenCalledWith('/api/admin/deal-hunter/email-sending', expect.objectContaining({ credentials: 'same-origin' }));
  });

  test('backup card names bundles with mismatched documents', () => {
    const { unmount } = render(<OperationsCenter data={{
      scheduler: { runs: [] }, sources: {}, audit: {}, cleanup: {}, storage: {},
      backup: { status: 'degraded', bundleCounts: { valid: 1, degraded: 2, invalid: 0, incomplete: 0 } },
    }} />);
    expect(screen.getByText('Bundles: 1 valid · 2 with mismatched documents · 0 invalid · 0 incomplete')).toBeVisible();
    expect(screen.queryByText(/ · mismatched:/)).toBeNull();
    unmount();

    const listed = render(<OperationsCenter data={{
      scheduler: { runs: [] }, sources: {}, audit: {}, cleanup: {}, storage: {},
      backup: {
        status: 'degraded',
        bundleCounts: { valid: 1, degraded: 1, invalid: 0, incomplete: 0 },
        documentsDegraded: [{ id: 'document-1', reason: 'checksum_mismatch' }, { id: 'document-2', reason: 'unreadable' }],
      },
    }} />);
    expect(screen.getByText('Bundles: 1 valid · 1 with mismatched documents · 0 invalid · 0 incomplete · mismatched: document-1, document-2')).toBeVisible();
    listed.unmount();

    render(<OperationsCenter data={{
      scheduler: { runs: [] }, sources: {}, audit: {}, cleanup: {}, storage: {},
      backup: { status: 'healthy', bundleCounts: { valid: 1, degraded: 0, invalid: 0, incomplete: 0 } },
    }} />);
    expect(screen.getByText('Bundles: 1 valid · 0 invalid · 0 incomplete')).toBeVisible();
  });

  test('backup card shows bundles whose verification is still running as a warning', () => {
    render(<OperationsCenter data={{
      scheduler: { runs: [] }, sources: {}, audit: {}, cleanup: {}, storage: {},
      backup: {
        status: 'verifying',
        message: 'Backup verification is still running for 3 bundles; refresh in a few minutes.',
        bundleCounts: { valid: 0, degraded: 0, invalid: 0, incomplete: 0, verifying: 3 },
      },
    }} />);
    expect(screen.getByText('verifying')).toHaveClass('bg-amber-50');
    expect(screen.getByText('Bundles: 0 valid · 0 invalid · 0 incomplete · 3 still verifying')).toBeVisible();
  });

  test('shows configured, evidence, effective, activation, every gate, and zero-send/live summaries without granting viewer controls', () => {
    render(<OperationsCenter readOnly data={{
      scheduler: { runs: [], failures: 0, pending: 0 },
      sources: { current: { healthy: true, issues: [] }, history: [] },
      audit: { events: [] },
      cleanup: { failures: [] },
      storage: { disk: {}, database: {} },
      backup: {},
      communications: {},
      cimIdentity: { pause: { paused: false }, storageHealthy: true },
      cimAutomation: {
        configuredStage: 2,
        evidenceStage: 1,
        effectiveStage: 1,
        activationMode: 'shadow',
        automaticTransmissionAllowed: false,
        stage2Readiness: [
          { code: 'canonical_human_reviews', passed: false, reason: '16 additional decisions are required.' },
          { code: 'stage2_storage', passed: true, reason: '' },
        ],
        metrics: { canonicalHumanReviews: 9, remainingStage2Reviews: 16, compatibleEvidence: 9 },
        latestShadowRun: { status: 'completed', considered_count: 5, eligible_count: 1, would_send_count: 1, blocked_counts: { score_below_90: 4 } },
        latestLiveRun: { mode: 'canary', status: 'blocked', attempted_count: 0, accepted_count: 0, deferred_count: 1 },
        operatingWindow: { open: false, reason: 'outside-window' },
        capacity: { used: 0, limit: 1, remaining: 1, pacificBusinessDate: '2026-08-12' },
        policy: { policyHash: 'a'.repeat(64), sourcePolicyHash: 'b'.repeat(64), rules: { version: 'rules-v2' }, window: {} },
        safeNextAction: 'Collect 16 additional canonical human decisions.',
      },
    }} />);

    expect(screen.getByText(/Configured Stage 2 · evidence Stage 1 · effective Stage 1 · activation shadow/)).toBeVisible();
    expect(screen.getByText('Automatic transmission: BLOCKED')).toBeVisible();
    expect(screen.getByText(/completed · considered 5 · eligible 1 · would send 1/)).toBeVisible();
    expect(screen.getByText(/canary · blocked · attempted 0 · accepted 0/)).toBeVisible();
    expect(screen.getByText(/BLOCK · canonical_human_reviews/)).toBeVisible();
    expect(screen.getByText(/PASS · stage2_storage/)).toBeVisible();
    expect(screen.getByText(/Collect 16 additional canonical human decisions/)).toBeVisible();
    expect(screen.getByText(/Aggregate read-only view/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /canary/i })).not.toBeInTheDocument();
  });

  test('Send Test works from the sanitized readiness the server sends to browsers', () => {
    // The browser never receives the test address (only recipientConfigured); the server picks it.
    const onSendTest = vi.fn();
    const { rerender } = render(<EmailReadinessPanel data={{ provider: 'resend', outboundConfigured: true,
      recipientConfigured: true }} onSendTest={onSendTest} />);
    const button = screen.getByRole('button', { name: 'Send Test' });
    expect(button).toBeEnabled();
    button.click();
    expect(onSendTest).toHaveBeenCalledTimes(1);

    rerender(<EmailReadinessPanel data={{ provider: 'resend', outboundConfigured: true,
      recipientConfigured: false }} onSendTest={onSendTest} />);
    expect(screen.getByRole('button', { name: 'Send Test' })).toBeDisabled();

    rerender(<EmailReadinessPanel data={{ provider: 'resend', outboundConfigured: false,
      recipientConfigured: true }} onSendTest={onSendTest} />);
    expect(screen.getByRole('button', { name: 'Send Test' })).toBeDisabled();
  });

  test('sender and reply-to show as configured without their addresses', () => {
    render(<EmailReadinessPanel data={{ provider: 'resend', outboundConfigured: true, recipientConfigured: true,
      senderConfigured: true, replyToConfigured: false }} />);
    expect(screen.getByText('From:').parentElement).toHaveTextContent('From: Configured');
    expect(screen.getByText('Reply-to:').parentElement).toHaveTextContent('Reply-to: Not configured');
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
        expectedEvalVersion: 'follow-up-eval-v2',
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

  describe('Sheet sync job history', () => {
    function renderRuns(runs) {
      return render(<OperationsCenter readOnly data={{
        scheduler: { runs, failures: 0, pending: 0 },
        sources: { current: { healthy: true, issues: [] }, history: [] },
        audit: { events: [] },
        cleanup: { failures: [] },
        storage: { disk: {}, database: {} },
        backup: {},
        communications: {},
      }} />);
    }

    test('shows per-sheet status, groups and the automatic Pursue outcome for a healthy run', () => {
      renderRuns([{
        job_key: 'deal-hunter-sheet-sync:2026-11-03', job_name: 'deal-hunter-sheet-sync', status: 'completed',
        updated_at: '2026-11-03T15:31:00.000Z', attempt_count: 1, last_error: '',
        sheetSync: {
          ok: true,
          sheets: [
            { sourceId: 'sheet-0', fetched: true, rowCount: 40, error: '' },
            { sourceId: 'sheet-1', fetched: true, rowCount: 12, error: '' },
          ],
          groupCounts: { auto: 3, review: 30, 'needs-info': 5, 'near-miss': 2 },
          autoPursue: { runKey: 'k', status: 200, mode: 'shadow', skipped: '', error: '', commands: 0,
            reason: 'warmup_not_ready', duplicateInvocation: false },
        },
      }]);
      const summary = screen.getByTestId('sheet-sync-summary');
      expect(within(summary).getByText('sheet-0: fetched 40 rows · sheet-1: fetched 12 rows')).toBeVisible();
      expect(within(summary).getByText('Automatic Pursue: shadow · 0 decisions · warmup_not_ready')).toBeVisible();
      expect(within(summary).getByText('auto 3 · review 30 · needs-info 5 · near-miss 2')).toBeVisible();
    });

    test('shows a failed sheet and a skipped automatic Pursue, and leaves other jobs plain', () => {
      renderRuns([
        {
          job_key: 'deal-hunter-sheet-sync:2026-11-04', job_name: 'deal-hunter-sheet-sync', status: 'failed',
          updated_at: '2026-11-04T15:31:00.000Z', attempt_count: 2, last_error: 'Scheduled job needs attention.',
          sheetSync: {
            ok: false,
            sheets: [{ sourceId: 'sheet-0', fetched: false, rowCount: 0, error: 'HTTP 500' }],
            groupCounts: {},
            autoPursue: { runKey: '', status: null, mode: '', skipped: 'required_source_failed', error: '' },
          },
        },
        { job_key: 'backup:2026-11-04', job_name: 'backup', status: 'completed', updated_at: '2026-11-04T11:00:00.000Z', attempt_count: 1, last_error: '' },
      ]);
      const summary = screen.getByTestId('sheet-sync-summary');
      expect(within(summary).getByText('sheet-0: failed: HTTP 500')).toBeVisible();
      expect(within(summary).getByText('Automatic Pursue: skipped: required_source_failed')).toBeVisible();
      expect(screen.getAllByTestId('sheet-sync-summary')).toHaveLength(1);
    });

    test('shows a duplicate automatic Pursue invocation with its decisions count', () => {
      renderRuns([{
        job_key: 'deal-hunter-sheet-sync:2026-11-06', job_name: 'deal-hunter-sheet-sync', status: 'completed',
        updated_at: '2026-11-06T15:31:00.000Z', attempt_count: 1, last_error: '',
        sheetSync: { ok: true, sheets: [], groupCounts: {}, autoPursue: { runKey: 'k', status: 200, mode: 'canary',
          skipped: '', error: '', commands: 1, reason: 'run_in_progress', duplicateInvocation: true } },
      }]);
      expect(screen.getByText('Automatic Pursue: canary · 1 decision · run_in_progress · duplicate invocation')).toBeVisible();
    });

    test('shows an automatic Pursue error without the raw text', () => {
      renderRuns([{
        job_key: 'deal-hunter-sheet-sync:2026-11-05', job_name: 'deal-hunter-sheet-sync', status: 'completed',
        updated_at: '2026-11-05T15:31:00.000Z', attempt_count: 1, last_error: '',
        sheetSync: { ok: true, sheets: [], groupCounts: {}, autoPursue: { error: 'runner exploded' } },
      }]);
      expect(screen.getByText('Automatic Pursue: error')).toBeVisible();
    });
  });
});
