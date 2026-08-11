import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { ACTIONS, EVENTS, Joyride, ORIGIN, STATUS } from 'react-joyride';
import { getAdminOnboardingTourKeyForScope } from '../../../shared/adminOnboarding.js';
import { getAdminOnboardingClientTour } from '../../content/adminOnboardingTours.jsx';
import AdminTourTooltip from './AdminTourTooltip.jsx';

const progressRequestCache = new Map();
const foundationsAutoAttempts = new Set();
const targetReadyTimeoutMs = 4000;

function readJson(response) {
  return response.json().catch(() => ({}));
}

function acquireProgressRequest(sessionIdentity) {
  let entry = progressRequestCache.get(sessionIdentity);
  if (!entry) {
    const promise = fetch('/api/admin/onboarding', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }).then(async (response) => {
      const result = await readJson(response);
      if (!response.ok || !result.success || !Array.isArray(result.progress)) {
        throw new Error(result.error || 'Unable to load guide progress.');
      }
      return result.progress;
    });
    entry = { consumers: 0, deleteTimer: null, promise };
    progressRequestCache.set(sessionIdentity, entry);
  }

  entry.consumers += 1;
  if (entry.deleteTimer !== null) {
    window.clearTimeout(entry.deleteTimer);
    entry.deleteTimer = null;
  }
  return entry.promise;
}

function releaseProgressRequest(sessionIdentity) {
  const entry = progressRequestCache.get(sessionIdentity);
  if (!entry) return;
  entry.consumers = Math.max(0, entry.consumers - 1);
  if (entry.consumers > 0 || entry.deleteTimer !== null) return;
  entry.deleteTimer = window.setTimeout(() => {
    if (entry.consumers === 0) progressRequestCache.delete(sessionIdentity);
  }, 0);
}

function progressMap(rows) {
  return Object.fromEntries((rows || []).map((row) => [row.tourKey, row]));
}

function targetsAreReady(steps) {
  return steps.length > 0 && steps.every((step) => (
    typeof step.target === 'string' && Boolean(document.querySelector(step.target))
  ));
}

function hasBlockingDialog() {
  const dialogs = document.querySelectorAll(
    'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
  );
  return Array.from(dialogs).some((dialog) => !dialog.closest('#react-joyride-portal'));
}

function initialStepForProgress(progress, steps) {
  if (progress?.status !== 'in_progress' || !progress.lastCompletedStepId) return 0;
  const completedIndex = steps.findIndex((step) => step.data?.stepId === progress.lastCompletedStepId);
  return completedIndex < 0 ? 0 : Math.min(completedIndex + 1, Math.max(steps.length - 1, 0));
}

function stepIndex(steps, stepId) {
  return stepId ? steps.findIndex((step) => step.data?.stepId === stepId) : -1;
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export default function AdminOnboarding({ userRole, scope, sessionIdentity }) {
  const [progressState, setProgressState] = useState({ status: 'loading', rows: {} });
  const [activeRun, setActiveRun] = useState(null);
  const [guideMessage, setGuideMessage] = useState('');
  const [reduceMotion, setReduceMotion] = useState(prefersReducedMotion);
  const mountedRef = useRef(true);
  const guideButtonRef = useRef(null);
  const returnFocusRef = useRef(null);
  const runCounterRef = useRef(0);
  const lifecycleRef = useRef(null);
  const writeQueueRef = useRef(Promise.resolve());
  const writeControllersRef = useRef(new Set());
  const currentSessionRef = useRef(sessionIdentity);
  const tourKey = getAdminOnboardingTourKeyForScope(scope, userRole);
  const currentTour = useMemo(
    () => (tourKey ? getAdminOnboardingClientTour(tourKey, userRole) : null),
    [tourKey, userRole],
  );

  useEffect(() => {
    const writeControllers = writeControllersRef.current;
    mountedRef.current = true;
    currentSessionRef.current = sessionIdentity;
    return () => {
      mountedRef.current = false;
      for (const controller of writeControllers) controller.abort();
      writeControllers.clear();
    };
  }, [sessionIdentity]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return undefined;
    const update = () => setReduceMotion(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    let acceptResponse = true;
    setProgressState({ status: 'loading', rows: {} });
    setGuideMessage('');

    acquireProgressRequest(sessionIdentity)
      .then((rows) => {
        if (!acceptResponse || currentSessionRef.current !== sessionIdentity) return;
        setProgressState({ status: 'loaded', rows: progressMap(rows) });
      })
      .catch(() => {
        if (!acceptResponse || currentSessionRef.current !== sessionIdentity) return;
        foundationsAutoAttempts.add(sessionIdentity);
        setProgressState({ status: 'error', rows: {} });
        setGuideMessage('Guide progress is unavailable. You can still start this page guide.');
      });

    return () => {
      acceptResponse = false;
      releaseProgressRequest(sessionIdentity);
    };
  }, [sessionIdentity]);

  const startRun = useCallback((mode, tour, savedProgress = null) => {
    if (!tour) return false;
    if (hasBlockingDialog()) {
      setGuideMessage('Close the open dialog before starting this page guide.');
      return false;
    }

    runCounterRef.current += 1;
    const run = {
      id: runCounterRef.current,
      mode,
      scope: tour.scope,
      tour,
      initialStepIndex: mode === 'manual' ? 0 : initialStepForProgress(savedProgress, tour.steps),
      savedStatusAtStart: savedProgress?.status || 'not_started',
    };
    lifecycleRef.current = {
      id: run.id,
      displayedStepIds: new Set(),
      lastCompletedStepId: savedProgress?.lastCompletedStepId || null,
    };
    returnFocusRef.current = mode === 'manual' ? guideButtonRef.current : null;
    setGuideMessage('');
    setActiveRun(run);
    return true;
  }, []);

  useEffect(() => {
    if (
      progressState.status !== 'loaded'
      || scope !== 'overview'
      || !currentTour?.automatic
      || foundationsAutoAttempts.has(sessionIdentity)
    ) {
      return undefined;
    }

    const savedProgress = progressState.rows[currentTour.key];
    if (['completed', 'skipped'].includes(savedProgress?.status)) return undefined;

    let finished = false;
    let observer = null;
    let timeout = null;
    const stopWaiting = () => {
      observer?.disconnect();
      if (timeout !== null) window.clearTimeout(timeout);
    };
    const tryStart = () => {
      if (finished || hasBlockingDialog() || !targetsAreReady(currentTour.steps)) return false;
      foundationsAutoAttempts.add(sessionIdentity);
      finished = startRun('automatic', currentTour, savedProgress);
      if (finished) stopWaiting();
      return finished;
    };
    if (tryStart()) return undefined;

    observer = new MutationObserver(tryStart);
    observer.observe(document.body, {
      attributeFilter: ['aria-modal', 'open'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    timeout = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      foundationsAutoAttempts.add(sessionIdentity);
      stopWaiting();
      setGuideMessage('The automatic guide could not find every required page target. You can retry it manually.');
    }, targetReadyTimeoutMs);

    return () => {
      finished = true;
      stopWaiting();
    };
  }, [currentTour, progressState, scope, sessionIdentity, startRun]);

  useEffect(() => {
    if (activeRun && activeRun.scope !== scope) {
      lifecycleRef.current = null;
      returnFocusRef.current = null;
      setActiveRun(null);
    }
  }, [activeRun, scope]);

  const persistProgress = useCallback((run, status, lastCompletedStepId) => {
    if (!run) return;
    const body = {
      tourVersion: run.tour.version,
      status,
      ...(lastCompletedStepId ? { lastCompletedStepId } : {}),
    };

    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!mountedRef.current || currentSessionRef.current !== sessionIdentity) return;
        const controller = new AbortController();
        writeControllersRef.current.add(controller);
        try {
          const response = await fetch(`/api/admin/onboarding/${encodeURIComponent(run.tour.key)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          const result = await readJson(response);
          if (!response.ok || !result.success || !result.progress) {
            throw new Error(result.error || 'Unable to save guide progress.');
          }
          if (mountedRef.current && currentSessionRef.current === sessionIdentity) {
            setProgressState((current) => ({
              ...current,
              rows: { ...current.rows, [result.progress.tourKey]: result.progress },
            }));
          }
        } catch (error) {
          if (error.name !== 'AbortError' && mountedRef.current) {
            setGuideMessage('Guide progress could not be saved. Your admin work is unaffected.');
          }
        } finally {
          writeControllersRef.current.delete(controller);
        }
      });
  }, [sessionIdentity]);

  const handleEvent = useCallback((event, controls) => {
    const run = activeRun;
    const lifecycle = lifecycleRef.current;
    if (!run || !lifecycle || lifecycle.id !== run.id) return;
    const stepId = event.step?.data?.stepId || null;
    const beganTerminal = ['completed', 'skipped'].includes(run.savedStatusAtStart);

    if (event.type === EVENTS.TOOLTIP && stepId) {
      lifecycle.displayedStepIds.add(stepId);
    }

    if (event.type === EVENTS.TOUR_START && run.savedStatusAtStart === 'not_started') {
      persistProgress(run, 'in_progress', null);
    }

    if (
      event.type === EVENTS.STEP_AFTER
      && event.action === ACTIONS.CLOSE
      && event.origin === ORIGIN.KEYBOARD
    ) {
      controls.skip();
      return;
    }

    if (
      event.type === EVENTS.STEP_AFTER
      && [ACTIONS.NEXT, ACTIONS.COMPLETE].includes(event.action)
      && stepId
      && lifecycle.displayedStepIds.has(stepId)
    ) {
      const completedIndex = stepIndex(run.tour.steps, stepId);
      const savedIndex = stepIndex(run.tour.steps, lifecycle.lastCompletedStepId);
      if (completedIndex > savedIndex) {
        lifecycle.lastCompletedStepId = stepId;
        if (!beganTerminal) persistProgress(run, 'in_progress', stepId);
      }
    }

    if (event.type === EVENTS.TARGET_NOT_FOUND) {
      if (import.meta.env.DEV) {
        console.warn(`[admin-onboarding] Missing static tour target for step: ${stepId || 'unknown'}`);
      }
    }
    if (event.type === EVENTS.ERROR) {
      setGuideMessage('This page guide stopped safely because a step could not be displayed.');
    }

    if (event.type === EVENTS.TOUR_END) {
      const returnFocusTarget = returnFocusRef.current;
      const displayedCount = lifecycle.displayedStepIds.size;
      if (event.status === STATUS.FINISHED && displayedCount > 0) {
        if (run.savedStatusAtStart !== 'completed') {
          persistProgress(run, 'completed', lifecycle.lastCompletedStepId || stepId);
        }
      } else if (event.status === STATUS.SKIPPED && !beganTerminal) {
        persistProgress(run, 'skipped', lifecycle.lastCompletedStepId);
      } else if (event.status === STATUS.FINISHED && displayedCount === 0) {
        setGuideMessage('This page guide ended without finding a usable target. Your admin work is unaffected.');
      }
      lifecycleRef.current = null;
      returnFocusRef.current = null;
      setActiveRun(null);
      if (returnFocusTarget) {
        window.setTimeout(() => {
          if (returnFocusTarget.isConnected) returnFocusTarget.focus();
        }, 0);
      }
    }
  }, [activeRun, persistProgress]);

  const handleManualStart = () => {
    if (!currentTour) return;
    startRun('manual', currentTour, progressState.rows[currentTour.key] || null);
  };

  const joyrideOptions = useMemo(() => ({
    backgroundColor: '#f8f4ed',
    blockTargetInteraction: true,
    buttons: ['back', 'close', 'primary', 'skip'],
    closeButtonAction: 'skip',
    dismissKeyAction: 'close',
    overlayClickAction: false,
    overlayColor: 'rgba(24, 33, 29, 0.58)',
    primaryColor: '#284638',
    scrollDuration: reduceMotion ? 0 : 240,
    scrollOffset: 88,
    showProgress: true,
    skipBeacon: true,
    spotlightPadding: 8,
    spotlightRadius: 12,
    targetWaitTimeout: 1800,
    textColor: '#18211d',
    width: 'min(22rem, calc(100vw - 2rem))',
    zIndex: 90,
  }), [reduceMotion]);

  return (
    <div className="admin-guide-control">
      <button
        className="admin-guide-button"
        data-admin-tour="guide-action"
        disabled={!currentTour || Boolean(activeRun) || progressState.status === 'loading'}
        onClick={handleManualStart}
        ref={guideButtonRef}
        type="button"
      >
        <CircleHelp aria-hidden="true" className="h-4 w-4" />
        Guide this page
      </button>
      {guideMessage ? <span className="admin-guide-message" role="status">{guideMessage}</span> : null}

      {activeRun ? (
        <Joyride
          continuous
          initialStepIndex={activeRun.initialStepIndex}
          key={`${activeRun.tour.key}:${activeRun.id}`}
          locale={{
            back: 'Back',
            close: 'Close',
            last: 'Done',
            next: 'Next',
            nextWithProgress: 'Next ({current} of {total})',
            open: 'Open page guide',
            skip: 'Skip tour',
          }}
          onEvent={handleEvent}
          options={joyrideOptions}
          run
          scrollToFirstStep
          steps={activeRun.tour.steps}
          tooltipComponent={AdminTourTooltip}
        />
      ) : null}
    </div>
  );
}
