// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const joyrideHarness = vi.hoisted(() => ({ props: null }));

vi.mock('react-joyride', () => ({
  ACTIONS: { CLOSE: 'close', COMPLETE: 'complete', NEXT: 'next', PREV: 'prev', SKIP: 'skip' },
  EVENTS: {
    ERROR: 'error',
    STEP_AFTER: 'step:after',
    TARGET_NOT_FOUND: 'error:target_not_found',
    TOOLTIP: 'tooltip',
    TOUR_END: 'tour:end',
    TOUR_START: 'tour:start',
  },
  Joyride: (props) => {
    joyrideHarness.props = props;
    return props.run ? <div data-testid="joyride-running" /> : null;
  },
  ORIGIN: { KEYBOARD: 'keyboard' },
  STATUS: { FINISHED: 'finished', RUNNING: 'running', SKIPPED: 'skipped' },
}));

import AdminOnboarding from '../src/components/admin/AdminOnboarding.jsx';
import AdminTourTooltip from '../src/components/admin/AdminTourTooltip.jsx';
import { getAdminOnboardingClientTour } from '../src/content/adminOnboardingTours.jsx';
import { getAdminOnboardingTourKeyForScope } from '../shared/adminOnboarding.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function FoundationsTargets({ children }) {
  return (
    <div>
      <div data-admin-tour="page-guidance" />
      <div data-admin-tour="section-navigation" />
      <div data-admin-tour="overview-priorities" />
      <div data-admin-tour="workspace-launcher" />
      {children}
    </div>
  );
}

afterEach(() => {
  cleanup();
  joyrideHarness.props = null;
  vi.unstubAllGlobals();
});

describe('admin onboarding tour definitions', () => {
  test('maps every supported route scope to its page guide and excludes viewer-only forbidden routes', () => {
    expect([
      'overview',
      'crm-index',
      'crm-detail',
      'command-center',
      'deal-hunter',
      'follow-ups',
      'operations',
      'new-record',
    ].map((scope) => getAdminOnboardingTourKeyForScope(scope, 'admin'))).toEqual([
      'admin-foundations',
      'crm-index',
      'crm-detail',
      'command-center',
      'deal-hunter',
      'follow-ups',
      'operations',
      'new-record',
    ]);
    expect(getAdminOnboardingTourKeyForScope('operations', 'viewer')).toBeNull();
    expect(getAdminOnboardingTourKeyForScope('new-record', 'viewer')).toBeNull();
  });

  test('filters viewer steps and copy before calculating progress', () => {
    const adminDealHunter = getAdminOnboardingClientTour('deal-hunter', 'admin');
    const viewerDealHunter = getAdminOnboardingClientTour('deal-hunter', 'viewer');
    const viewerFollowUps = getAdminOnboardingClientTour('follow-ups', 'viewer');

    expect(adminDealHunter.steps.map((step) => step.data.stepId)).toContain('deal-hunter-cim-workflow');
    expect(viewerDealHunter.steps.map((step) => step.data.stepId)).not.toContain('deal-hunter-cim-workflow');
    expect(viewerFollowUps.steps.map((step) => step.data.stepId)).not.toContain('follow-ups-email-controls');
    expect(JSON.stringify([...viewerDealHunter.steps, ...viewerFollowUps.steps])).not.toMatch(/send|approve|import/i);
    expect(getAdminOnboardingClientTour('operations', 'viewer')).toBeNull();
    expect(getAdminOnboardingClientTour('new-record', 'viewer')).toBeNull();
  });
});

describe('AdminOnboarding controller', () => {
  test('fetches once under Strict Mode and auto-starts foundations only after progress and targets are ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, progress: [] }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <FoundationsTargets>
          <AdminOnboarding userRole="admin" scope="overview" sessionIdentity="admin:auto-new" />
        </FoundationsTargets>
      </StrictMode>,
    );

    expect(screen.getByRole('button', { name: 'Guide this page' })).toBeTruthy();
    await screen.findByTestId('joyride-running');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({ credentials: 'same-origin' }));
    expect(joyrideHarness.props.initialStepIndex).toBe(0);
    expect(joyrideHarness.props.steps).toHaveLength(5);
    expect(joyrideHarness.props.stepIndex).toBeUndefined();
  });

  test('releases the progress cache after logout so a new authenticated session refetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, progress: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <AdminOnboarding userRole="admin" scope="crm-index" sessionIdentity="admin:session-cycle" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.unmount();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    render(<AdminOnboarding userRole="admin" scope="crm-index" sessionIdentity="admin:session-cycle" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('resumes an interrupted foundations tour after the stable last completed step', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      progress: [{
        tourKey: 'admin-foundations',
        tourVersion: 1,
        status: 'in_progress',
        lastCompletedStepId: 'foundations-overview-priorities',
      }],
    })));

    render(
      <FoundationsTargets>
        <AdminOnboarding userRole="admin" scope="overview" sessionIdentity="admin:resume" />
      </FoundationsTargets>,
    );

    await screen.findByTestId('joyride-running');
    expect(joyrideHarness.props.initialStepIndex).toBe(3);
  });

  test.each(['completed', 'skipped'])('does not auto-start a %s current version', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      progress: [{ tourKey: 'admin-foundations', tourVersion: 1, status, lastCompletedStepId: null }],
    })));

    render(
      <FoundationsTargets>
        <AdminOnboarding userRole="admin" scope="overview" sessionIdentity={`admin:terminal-${status}`} />
      </FoundationsTargets>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Guide this page' }).disabled).toBe(false));
    expect(screen.queryByTestId('joyride-running')).toBeNull();
  });

  test('manual replay starts at the first step and never downgrades completed progress', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      progress: [{
        tourKey: 'admin-foundations', tourVersion: 1, status: 'completed', lastCompletedStepId: 'foundations-page-guide',
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <FoundationsTargets>
        <AdminOnboarding userRole="admin" scope="overview" sessionIdentity="admin:manual-completed" />
      </FoundationsTargets>,
    );

    const guide = await screen.findByRole('button', { name: 'Guide this page' });
    await waitFor(() => expect(guide.disabled).toBe(false));
    fireEvent.click(guide);
    await screen.findByTestId('joyride-running');
    expect(joyrideHarness.props.initialStepIndex).toBe(0);

    joyrideHarness.props.onEvent({
      action: 'start', status: 'running', type: 'tour:start', step: joyrideHarness.props.steps[0],
    }, { skip: vi.fn() });
    joyrideHarness.props.onEvent({
      action: 'next', status: 'running', type: 'step:after', step: joyrideHarness.props.steps[0],
    }, { skip: vi.fn() });
    joyrideHarness.props.onEvent({
      action: 'complete', status: 'finished', type: 'tour:end', step: joyrideHarness.props.steps.at(-1),
    }, { skip: vi.fn() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  test('refuses to layer a page guide over an existing modal dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      progress: [{ tourKey: 'crm-index', tourVersion: 1, status: 'completed', lastCompletedStepId: 'crm-index-open-record' }],
    })));
    render(
      <>
        <div aria-modal="true" role="dialog">Existing CRM dialog</div>
        <AdminOnboarding userRole="admin" scope="crm-index" sessionIdentity="admin:modal-conflict" />
      </>,
    );

    const guide = screen.getByRole('button', { name: 'Guide this page' });
    await waitFor(() => expect(guide.disabled).toBe(false));
    fireEvent.click(guide);
    expect(screen.queryByTestId('joyride-running')).toBeNull();
    expect(screen.getByText('Close the open dialog before starting this page guide.')).toBeTruthy();
  });

  test('persists only start, displayed completed steps, and the terminal result', async () => {
    const patchBodies = [];
    const fetchMock = vi.fn(async (_url, options = {}) => {
      if (options.method !== 'PATCH') return jsonResponse({ success: true, progress: [] });
      const body = JSON.parse(options.body);
      patchBodies.push(body);
      return jsonResponse({
        success: true,
        progress: {
          tourKey: 'admin-foundations',
          tourVersion: 1,
          status: body.status,
          lastCompletedStepId: body.lastCompletedStepId || null,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StrictMode>
        <FoundationsTargets>
          <AdminOnboarding userRole="admin" scope="overview" sessionIdentity="admin:event-persistence" />
        </FoundationsTargets>
      </StrictMode>,
    );

    await screen.findByTestId('joyride-running');
    const controls = { skip: vi.fn() };
    const firstStep = joyrideHarness.props.steps[0];
    const lastStep = joyrideHarness.props.steps.at(-1);
    joyrideHarness.props.onEvent({ type: 'tour:start', step: firstStep }, controls);
    joyrideHarness.props.onEvent({ type: 'tooltip', step: firstStep }, controls);
    joyrideHarness.props.onEvent({ action: 'next', type: 'step:after', step: firstStep }, controls);
    joyrideHarness.props.onEvent({ type: 'tooltip', step: lastStep }, controls);
    joyrideHarness.props.onEvent({ action: 'complete', type: 'step:after', step: lastStep }, controls);
    joyrideHarness.props.onEvent({ status: 'finished', type: 'tour:end', step: lastStep }, controls);

    await waitFor(() => expect(patchBodies).toHaveLength(4));
    expect(patchBodies).toEqual([
      { tourVersion: 1, status: 'in_progress' },
      { tourVersion: 1, status: 'in_progress', lastCompletedStepId: 'foundations-welcome' },
      { tourVersion: 1, status: 'in_progress', lastCompletedStepId: 'foundations-page-guide' },
      { tourVersion: 1, status: 'completed', lastCompletedStepId: 'foundations-page-guide' },
    ]);
  });

  test('does not regress saved progress after moving back and revisiting an earlier step', async () => {
    const patchBodies = [];
    const fetchMock = vi.fn(async (_url, options = {}) => {
      if (options.method !== 'PATCH') return jsonResponse({ success: true, progress: [] });
      const body = JSON.parse(options.body);
      patchBodies.push(body);
      return jsonResponse({
        success: true,
        progress: {
          tourKey: 'admin-foundations',
          tourVersion: 1,
          status: body.status,
          lastCompletedStepId: body.lastCompletedStepId || null,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FoundationsTargets>
        <AdminOnboarding userRole="admin" scope="overview" sessionIdentity="admin:backtracking" />
      </FoundationsTargets>,
    );

    await screen.findByTestId('joyride-running');
    const controls = { skip: vi.fn() };
    const [welcome, navigation, priorities, launcher] = joyrideHarness.props.steps;
    joyrideHarness.props.onEvent({ type: 'tour:start', step: welcome }, controls);
    for (const step of [welcome, navigation, priorities]) {
      joyrideHarness.props.onEvent({ type: 'tooltip', step }, controls);
      joyrideHarness.props.onEvent({ action: 'next', type: 'step:after', step }, controls);
    }
    await waitFor(() => expect(patchBodies).toHaveLength(4));

    joyrideHarness.props.onEvent({ action: 'prev', type: 'step:after', step: launcher }, controls);
    joyrideHarness.props.onEvent({ action: 'prev', type: 'step:after', step: priorities }, controls);
    joyrideHarness.props.onEvent({ type: 'tooltip', step: navigation }, controls);
    joyrideHarness.props.onEvent({ action: 'next', type: 'step:after', step: navigation }, controls);

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(patchBodies).toHaveLength(4);
    expect(patchBodies.at(-1).lastCompletedStepId).toBe('foundations-overview-priorities');
  });

  test('keeps the tour usable when a meaningful progress write fails', async () => {
    const fetchMock = vi.fn(async (_url, options = {}) => {
      if (options.method === 'PATCH') return jsonResponse({ success: false, error: 'Unavailable' }, { ok: false, status: 503 });
      return jsonResponse({ success: true, progress: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FoundationsTargets>
        <AdminOnboarding userRole="admin" scope="overview" sessionIdentity="admin:patch-failure" />
      </FoundationsTargets>,
    );

    await screen.findByTestId('joyride-running');
    joyrideHarness.props.onEvent({ type: 'tour:start', step: joyrideHarness.props.steps[0] }, { skip: vi.fn() });
    expect(await screen.findByText('Guide progress could not be saved. Your admin work is unaffected.')).toBeTruthy();
    expect(screen.getByTestId('joyride-running')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('GET failure keeps the guide available, suppresses automatic start, and does not refetch on route changes', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Progress unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(
      <FoundationsTargets>
        <AdminOnboarding userRole="viewer" scope="overview" sessionIdentity="viewer:get-failure" />
      </FoundationsTargets>,
    );

    expect(await screen.findByRole('button', { name: 'Guide this page' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Guide progress is unavailable. You can still start this page guide.')).toBeTruthy());
    expect(screen.queryByTestId('joyride-running')).toBeNull();

    view.rerender(
      <FoundationsTargets>
        <AdminOnboarding userRole="viewer" scope="crm-index" sessionIdentity="viewer:get-failure" />
      </FoundationsTargets>,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AdminTourTooltip', () => {
  test('preserves dialog props and supplied button behavior with predictable labels', () => {
    const handlers = { back: vi.fn(), close: vi.fn(), primary: vi.fn(), skip: vi.fn() };
    render(
      <AdminTourTooltip
        backProps={{ 'aria-label': 'Back', 'data-action': 'back', onClick: handlers.back, role: 'button', title: 'Back' }}
        closeProps={{ 'aria-label': 'Close', 'data-action': 'close', onClick: handlers.close, role: 'button', title: 'Close' }}
        continuous
        index={1}
        isLastStep={false}
        primaryProps={{ 'aria-label': 'Next (2 of 4)', 'data-action': 'primary', onClick: handlers.primary, role: 'button', title: 'Next (2 of 4)' }}
        size={4}
        skipProps={{ 'aria-label': 'Skip', 'data-action': 'skip', onClick: handlers.skip, role: 'button', title: 'Skip' }}
        step={{ title: 'Daily priorities', content: 'Start with overdue work.' }}
        tooltipProps={{ 'aria-modal': true, role: 'alertdialog' }}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 of 4)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(handlers).toEqual(expect.objectContaining({
      back: expect.any(Function), close: expect.any(Function), primary: expect.any(Function), skip: expect.any(Function),
    }));
    Object.values(handlers).forEach((handler) => expect(handler).toHaveBeenCalledTimes(1));
  });
});
