import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import OpportunityDrawer, { PassForm } from './OpportunityDrawer.jsx';

const emptySummary = { needsReview: 0, highPriority: 0, watchlist: 0, lowConfidence: 0, currentOpportunities: 0 };
const summaryItems = [
  ['needsReview', 'Needs Review'], ['highPriority', 'High Priority'], ['watchlist', 'Watchlist'],
  ['lowConfidence', 'Low Confidence'], ['currentOpportunities', 'Current Opportunities'],
];
const views = [
  ['needs-review', 'Needs Review'], ['high-priority', 'High Priority'], ['watchlist', 'Watchlist'],
  ['low-confidence', 'Low Confidence'], ['dismissed', 'Passed'], ['all', 'All Current'],
];
const buttonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-moss bg-moss px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-pine disabled:opacity-50';
const emptyBrokerMaterialsState = {
  preparation: null, recipientSelection: null, preparing: false, updating: false, sending: false,
  checking: false, checkingFailed: false, stale: false, error: '',
};

function withoutApprovalAuthority(preparation) {
  return preparation ? { ...preparation, preparationToken: '', proposalDigest: '' } : null;
}

function money(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value));
}

function formatLabel(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function ActionButtons({ disabled, name, onAction }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button aria-label={`Pursue ${name}`} className={primaryButtonClass} disabled={disabled} onClick={(event) => onAction('pursue', event)} type="button">Pursue</button>
      <button aria-label={`Watch ${name}`} className={buttonClass} disabled={disabled} onClick={(event) => onAction('watch', event)} type="button">Watch</button>
      <button aria-label={`Pass ${name}`} className={`${buttonClass} text-red-700`} disabled={disabled} onClick={(event) => onAction('pass', event)} type="button">Pass</button>
    </div>
  );
}

function OpportunityRow({ onAction, onOpen, pending, readOnly, row }) {
  const reviewState = row.changedSinceReview ? 'Changed Since Review' : row.reviewed ? 'Reviewed' : 'Needs Review';
  const observed = formatDate(row.observationFreshness);
  return (
    <li className="grid gap-4 rounded-2xl border border-line bg-white p-4 shadow-sm md:grid-cols-[minmax(15rem,1.35fr)_repeat(4,minmax(6.5rem,.65fr))_minmax(10rem,.8fr)] md:items-center md:rounded-none md:border-x-0 md:border-b-0 md:p-3 md:shadow-none">
      <div className="min-w-0">
        <button aria-label={`Open ${row.name}`} className="text-left text-base font-semibold text-ink underline decoration-transparent underline-offset-4 transition hover:text-moss hover:decoration-moss/30" onClick={onOpen} type="button">{row.name}</button>
        <p className="mt-1 text-xs text-ink/58">{row.geography?.label || row.state || 'Location not supplied'} · {row.industry || 'Industry not supplied'}</p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">Review: {reviewState}</span>
          <span className="rounded-full bg-moss/10 px-2 py-0.5 text-moss">Operator: {formatLabel(row.operatorPriority || 'normal')}</span>
          <span className="rounded-full bg-fog px-2 py-0.5 text-ink/68">Machine: {formatLabel(row.scoreStatus || 'provisional')}</span>
          <span className="rounded-full bg-fog px-2 py-0.5 text-ink/68">CRM: {formatLabel(row.workflow?.crmStatus || 'not-started')}</span>
          <span className="rounded-full bg-fog px-2 py-0.5 text-ink/68">CIM: {formatLabel(row.workflow?.cimStatus || 'not-requested')}</span>
          {row.dismissed ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-800">Passed: {formatLabel(row.dismissedReason || 'dismissed')}</span> : null}
        </div>
        {observed ? <p className="mt-2 text-[11px] text-ink/50">Observed {observed}</p> : null}
      </div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45 md:hidden">Fit</p><p className="text-xl font-semibold tabular-nums text-ink">{row.fitScore}</p><p className="text-[11px] font-semibold text-ink/58">{row.confidence} confidence</p></div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45">SDE / Profit</p><p className="mt-1 text-sm font-semibold tabular-nums text-ink">{money(row.financials?.annualProfit)}</p></div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45">Revenue</p><p className="mt-1 text-sm font-semibold tabular-nums text-ink">{money(row.financials?.annualRevenue)}</p></div>
      <div><p className="text-[10px] font-semibold uppercase text-ink/45">Ask / Multiple</p><p className="mt-1 text-sm font-semibold tabular-nums text-ink">{money(row.financials?.askingPrice)}</p>{row.financials?.profitMultiple !== null && row.financials?.profitMultiple !== undefined ? <p className="text-xs text-ink/58">{row.financials.profitMultiple.toFixed(2)}×</p> : null}</div>
      <div className="min-w-0">
        {row.topStrength ? <p className="text-xs leading-5 text-moss">{row.topStrength}</p> : null}
        {row.topConcern ? <p className="mt-1 text-xs leading-5 text-amber-800">{row.topConcern}</p> : null}
        {!readOnly && !row.dismissed ? <div className="mt-2"><ActionButtons disabled={pending} name={row.name} onAction={onAction} /></div> : null}
      </div>
    </li>
  );
}

function QueuePassDialog({ error, focusGuardRef, name, onCancel, onSubmit, pending }) {
  const dialogRef = useRef(null);
  const reasonRef = useRef(null);
  useLayoutEffect(() => {
    reasonRef.current?.focus();
  }, []);
  function handleKeyDown(event) {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialogRef.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  useEffect(() => {
    function handleDocumentKeyDown(event) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (!dialog.contains(document.activeElement)) {
        if (event.key === 'Tab') {
          event.preventDefault();
          reasonRef.current?.focus();
        }
        return;
      }
      handleKeyDown(event);
    }
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => document.removeEventListener('keydown', handleDocumentKeyDown);
  });
  useEffect(() => {
    function handleDocumentFocusIn(event) {
      const dialog = dialogRef.current;
      if (focusGuardRef?.current && dialog && !dialog.contains(event.target)) reasonRef.current?.focus();
    }
    document.addEventListener('focusin', handleDocumentFocusIn);
    return () => document.removeEventListener('focusin', handleDocumentFocusIn);
  }, [focusGuardRef]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4" role="presentation">
      <div aria-labelledby="queue-pass-dialog-title" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-line bg-white p-5 shadow-2xl" ref={dialogRef} role="dialog">
        <h2 className="sr-only" id="queue-pass-dialog-title">Pass {name}</h2>
        <PassForm error={error} initialFocusRef={reasonRef} name={name} onCancel={onCancel} onSubmit={onSubmit} pending={pending} />
      </div>
    </div>
  );
}

export default function AcquisitionInbox({ readOnly = false }) {
  const [view, setView] = useState('needs-review');
  const [search, setSearch] = useState('');
  const [confidence, setConfidence] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState('acquisition-priority');
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState({ rows: [], total: 0, page: 1, totalPages: 1, summary: emptySummary });
  const [loading, setLoading] = useState(true);
  const [queueError, setQueueError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [pendingId, setPendingId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState({ requestedId: '', data: null, loading: false, error: '' });
  const [brokerMaterialsState, setBrokerMaterialsState] = useState(emptyBrokerMaterialsState);
  const [passTarget, setPassTarget] = useState(null);
  const queueRequestRef = useRef({ generation: 0, controller: null });
  const queueQueryRef = useRef(null);
  const detailRequestRef = useRef({ generation: 0, controller: null });
  const brokerPrepareRequestRef = useRef({ generation: 0, controller: null });
  const brokerApprovalRequestRef = useRef({ generation: 0, controller: null });
  const brokerApprovalPendingRef = useRef(false);
  const selectionRef = useRef('');
  const mutationGenerationRef = useRef(0);
  const mutationPendingRef = useRef(false);
  const detailFocusGuardRef = useRef(false);
  const passFocusGuardRef = useRef(false);
  const detailTriggerRef = useRef(null);
  const passTriggerRef = useRef(null);
  const searchInputRef = useRef(null);
  queueQueryRef.current = { view, search, confidence, priority, sort, page };

  const loadQueue = useCallback(async () => {
    queueRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = queueRequestRef.current.generation + 1;
    queueRequestRef.current = { generation, controller };
    setLoading(true);
    setQueueError('');
    try {
      const { view: currentView, search: currentSearch, confidence: currentConfidence, priority: currentPriority, sort: currentSort, page: currentPage } = queueQueryRef.current;
      const params = new URLSearchParams({ view: currentView, page: String(currentPage), pageSize: '25', sort: currentSort, direction: 'desc' });
      if (currentSearch.trim()) params.set('search', currentSearch.trim());
      if (currentConfidence) params.set('confidence', currentConfidence);
      if (currentPriority) params.set('priority', currentPriority);
      const response = await fetch(`/api/admin/deal-hunter/triage?${params}`, { credentials: 'same-origin', signal: controller.signal });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load Acquisition Inbox.');
      if (queueRequestRef.current.generation !== generation || controller.signal.aborted) return false;
      setQueue(result);
      return true;
    } catch (loadError) {
      if (isAbortError(loadError) || queueRequestRef.current.generation !== generation || controller.signal.aborted) return false;
      setQueueError(loadError.message || 'Unable to load Acquisition Inbox.');
      return false;
    } finally {
      if (queueRequestRef.current.generation === generation) {
        queueRequestRef.current.controller = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadQueue();
    return () => {
      queueRequestRef.current.controller?.abort();
      queueRequestRef.current.generation += 1;
    };
  }, [confidence, loadQueue, page, priority, search, sort, view]);

  const loadDetail = useCallback(async (opportunityId, { preserveData = false } = {}) => {
    detailRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = detailRequestRef.current.generation + 1;
    detailRequestRef.current = { generation, controller };
    setDetail((current) => ({
      requestedId: opportunityId,
      data: preserveData && current.requestedId === opportunityId ? current.data : null,
      loading: true,
      error: '',
    }));
    try {
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}`, { credentials: 'same-origin', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load opportunity detail.');
      if (result?.opportunity?.opportunityId !== opportunityId) throw new Error('Opportunity detail did not match the selected record.');
      if (detailRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      setDetail({ requestedId: opportunityId, data: result, loading: false, error: '' });
      setBrokerMaterialsState((current) => {
        if (result.brokerMaterials?.existingRequest) return emptyBrokerMaterialsState;
        return current.preparation && Array.isArray(result.brokerMaterials?.sendBlockers)
          ? { ...current, preparation: { ...current.preparation, sendBlockers: result.brokerMaterials.sendBlockers } }
          : current;
      });
      return result;
    } catch (detailError) {
      if (isAbortError(detailError) || detailRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      setDetail((current) => ({
        requestedId: opportunityId,
        data: preserveData && current.requestedId === opportunityId ? current.data : null,
        loading: false,
        error: detailError.message || 'Unable to load opportunity detail.',
      }));
      return false;
    } finally {
      if (detailRequestRef.current.generation === generation) detailRequestRef.current.controller = null;
    }
  }, []);

  function openDetail(opportunityId, trigger) {
    brokerPrepareRequestRef.current.controller?.abort();
    brokerPrepareRequestRef.current = { generation: brokerPrepareRequestRef.current.generation + 1, controller: null };
    brokerApprovalRequestRef.current.controller?.abort();
    brokerApprovalRequestRef.current = { generation: brokerApprovalRequestRef.current.generation + 1, controller: null };
    brokerApprovalPendingRef.current = false;
    setBrokerMaterialsState(emptyBrokerMaterialsState);
    detailTriggerRef.current = trigger || null;
    detailFocusGuardRef.current = true;
    selectionRef.current = opportunityId;
    setSelectedId(opportunityId);
    loadDetail(opportunityId);
  }

  const closeDetail = useCallback((force = false) => {
    if (mutationPendingRef.current && force !== true) return;
    detailFocusGuardRef.current = false;
    selectionRef.current = '';
    detailRequestRef.current.controller?.abort();
    detailRequestRef.current = { generation: detailRequestRef.current.generation + 1, controller: null };
    setSelectedId('');
    setDetail({ requestedId: '', data: null, loading: false, error: '' });
    brokerPrepareRequestRef.current.controller?.abort();
    brokerPrepareRequestRef.current = { generation: brokerPrepareRequestRef.current.generation + 1, controller: null };
    brokerApprovalRequestRef.current.controller?.abort();
    brokerApprovalRequestRef.current = { generation: brokerApprovalRequestRef.current.generation + 1, controller: null };
    brokerApprovalPendingRef.current = false;
    setBrokerMaterialsState(emptyBrokerMaterialsState);
    setMutationError('');
    const trigger = detailTriggerRef.current;
    if (trigger?.isConnected) trigger.focus();
    else if (searchInputRef.current?.isConnected) searchInputRef.current.focus();
  }, []);

  function openQueuePass(row, trigger) {
    passTriggerRef.current = trigger || null;
    passFocusGuardRef.current = true;
    setMutationError('');
    setPassTarget(row);
  }

  function closeQueuePass(force = false) {
    if (mutationPendingRef.current && force !== true) return;
    passFocusGuardRef.current = false;
    setPassTarget(null);
    setMutationError('');
    const trigger = passTriggerRef.current;
    if (trigger?.isConnected) trigger.focus();
    else if (searchInputRef.current?.isConnected) searchInputRef.current.focus();
  }

  async function recordAction(opportunityId, action, pass = null) {
    if (action === 'pass' && (!pass?.reason?.trim() || pass.reason.trim().length > 80 || (pass.note || '').length > 2000)) return false;
    if (mutationPendingRef.current) return false;
    mutationPendingRef.current = true;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    setPendingId(opportunityId);
    setMutationError('');
    try {
      const body = action === 'pass'
        ? { action, reason: pass.reason.trim(), note: (pass.note || '').trim() }
        : { action };
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/action`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to record this decision.');
      const authoritativeOpportunity = result?.opportunity?.opportunityId === opportunityId ? result.opportunity : null;
      if (authoritativeOpportunity) {
        setQueue((current) => ({
          ...current,
          rows: current.rows.map((row) => row.opportunityId === opportunityId ? authoritativeOpportunity : row),
        }));
        setDetail((current) => current.requestedId === opportunityId && current.data
          ? { ...current, data: { ...current.data, opportunity: authoritativeOpportunity }, error: '' }
          : current);
      }
      await loadQueue();
      if (action === 'pass') {
        if (selectionRef.current === opportunityId) closeDetail(true);
        if (passTarget?.opportunityId === opportunityId) closeQueuePass(true);
      } else if (selectionRef.current === opportunityId) {
        await loadDetail(opportunityId, { preserveData: true });
      }
      return true;
    } catch (actionError) {
      if (mutationGenerationRef.current === mutationGeneration) setMutationError(actionError.message || 'Unable to record this decision.');
      return false;
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationPendingRef.current = false;
        setPendingId('');
      }
    }
  }

  async function saveFact(opportunityId, { field, value, note, verified }) {
    if (!opportunityId || selectionRef.current !== opportunityId || mutationPendingRef.current) return false;
    mutationPendingRef.current = true;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    setPendingId(opportunityId);
    setMutationError('');
    try {
      const response = await fetch(`/api/admin/deal-hunter/opportunities/${encodeURIComponent(opportunityId)}/facts/${encodeURIComponent(field)}`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, note, verified }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save the verified fact.');
      if (selectionRef.current === opportunityId) await loadDetail(opportunityId, { preserveData: true });
      return true;
    } catch (factError) {
      if (mutationGenerationRef.current === mutationGeneration) setMutationError(factError.message || 'Unable to save the verified fact.');
      return false;
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        mutationPendingRef.current = false;
        setPendingId('');
      }
    }
  }

  function invalidateBrokerMaterialsPreparation() {
    setBrokerMaterialsState((current) => ({ ...current, preparation: withoutApprovalAuthority(current.preparation), stale: false }));
  }

  async function prepareBrokerMaterials(opportunityId, requestedBody = {}) {
    if (!opportunityId || selectionRef.current !== opportunityId) return false;
    brokerPrepareRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = brokerPrepareRequestRef.current.generation + 1;
    brokerPrepareRequestRef.current = { generation, controller };
    const body = {};
    if (requestedBody.recipientContactRef) body.recipientContactRef = requestedBody.recipientContactRef;
    if (requestedBody.greeting !== undefined) body.greeting = requestedBody.greeting;
    setBrokerMaterialsState((current) => ({
      ...current,
      preparation: current.preparation ? withoutApprovalAuthority(current.preparation) : null,
      preparing: !current.preparation && !current.recipientSelection,
      updating: Boolean(current.preparation || current.recipientSelection),
      checking: false,
      checkingFailed: false,
      stale: false,
      error: '',
    }));
    try {
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/broker-materials/prepare`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      const result = await response.json();
      if (brokerPrepareRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      if (result.code === 'recipient_selection_required' && !result.review) {
        setBrokerMaterialsState({
          ...emptyBrokerMaterialsState,
          recipientSelection: {
            code: result.code,
            message: result.error || 'Select one authoritative broker recipient before preparing the request.',
            recipientOptions: Array.isArray(result.recipientOptions) ? result.recipientOptions : [],
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
            sendBlockers: Array.isArray(result.sendBlockers) ? result.sendBlockers : [],
          },
          error: response.ok && result.success ? '' : result.error || 'Unable to prepare broker materials.',
        });
        return false;
      }
      if (!response.ok || !result.success) {
        const isStale = result.code === 'preparation_stale' || result.code === 'preparation_expired';
        setBrokerMaterialsState((current) => ({
          ...current,
          preparation: result.review ? { ...result, preparationToken: '', proposalDigest: '' } : withoutApprovalAuthority(current.preparation),
          preparing: false, updating: false, stale: isStale,
          error: result.error || 'Unable to prepare broker materials.',
        }));
        return false;
      }
      setBrokerMaterialsState({ ...emptyBrokerMaterialsState, preparation: result });
      return true;
    } catch (prepareError) {
      if (isAbortError(prepareError) || brokerPrepareRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      setBrokerMaterialsState((current) => ({ ...current, preparing: false, updating: false, error: prepareError.message || 'Unable to prepare broker materials.' }));
      return false;
    } finally {
      if (brokerPrepareRequestRef.current.generation === generation) brokerPrepareRequestRef.current.controller = null;
    }
  }

  async function reconcileBrokerMaterials(opportunityId) {
    const refreshed = await loadDetail(opportunityId, { preserveData: true });
    if (!refreshed || selectionRef.current !== opportunityId) return refreshed;
    if (refreshed.brokerMaterials?.existingRequest) setBrokerMaterialsState(emptyBrokerMaterialsState);
    return refreshed;
  }

  async function approveBrokerMaterials(opportunityId, preparation) {
    if (!opportunityId || selectionRef.current !== opportunityId || readOnly || brokerApprovalPendingRef.current || !preparation?.preparationToken || !preparation?.proposalDigest) return false;
    brokerApprovalPendingRef.current = true;
    const controller = new AbortController();
    const generation = brokerApprovalRequestRef.current.generation + 1;
    brokerApprovalRequestRef.current.controller?.abort();
    brokerApprovalRequestRef.current = { generation, controller };
    setBrokerMaterialsState((current) => ({ ...current, sending: true, checking: false, checkingFailed: false, error: '' }));
    try {
      const response = await fetch(`/api/admin/deal-hunter/triage/${encodeURIComponent(opportunityId)}/broker-materials/approve`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preparationToken: preparation.preparationToken, approvedProposalDigest: preparation.proposalDigest }), signal: controller.signal,
      });
      const result = await response.json();
      if (brokerApprovalRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      const stale = result.code === 'preparation_stale' || result.code === 'preparation_expired';
      const durable = Boolean(result.durableResult || result.code === 'existing_request');
      setBrokerMaterialsState((current) => ({
        ...current,
        preparation: stale || durable ? withoutApprovalAuthority(current.preparation) : result.sendBlockers?.length ? { ...current.preparation, sendBlockers: result.sendBlockers } : current.preparation,
        sending: false, stale, error: response.ok && result.success ? '' : result.error || 'Unable to send broker materials.',
      }));
      const refreshed = await reconcileBrokerMaterials(opportunityId);
      if (brokerApprovalRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      if (durable && !refreshed?.brokerMaterials?.existingRequest) {
        setBrokerMaterialsState((current) => ({ ...current, preparation: null, sending: false, checking: true, checkingFailed: !refreshed, stale: false, error: '' }));
      } else if (!refreshed?.brokerMaterials?.existingRequest) {
        setBrokerMaterialsState((current) => ({ ...current, sending: false, stale, error: response.ok && result.success ? '' : result.error || current.error }));
      }
      return response.ok && result.success;
    } catch (approvalError) {
      if (isAbortError(approvalError) || brokerApprovalRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      setBrokerMaterialsState((current) => ({ ...current, preparation: withoutApprovalAuthority(current.preparation), sending: false, checking: true, checkingFailed: false, stale: false, error: '' }));
      const refreshed = await reconcileBrokerMaterials(opportunityId);
      if (brokerApprovalRequestRef.current.generation !== generation || controller.signal.aborted || selectionRef.current !== opportunityId) return false;
      if (!refreshed) setBrokerMaterialsState((current) => ({ ...current, preparation: null, sending: false, checking: true, checkingFailed: true, error: '' }));
      else if (!refreshed.brokerMaterials?.existingRequest) setBrokerMaterialsState((current) => ({ ...current, preparation: null, sending: false, checking: true, checkingFailed: false, error: '' }));
      return false;
    } finally {
      if (brokerApprovalRequestRef.current.generation === generation) {
        brokerApprovalRequestRef.current.controller = null;
        brokerApprovalPendingRef.current = false;
        setBrokerMaterialsState((current) => ({ ...current, sending: false }));
      }
    }
  }

  async function checkBrokerMaterialsStatus(opportunityId) {
    if (!opportunityId || selectionRef.current !== opportunityId) return false;
    setBrokerMaterialsState((current) => ({ ...current, preparation: null, checking: true, checkingFailed: false, error: '' }));
    const refreshed = await reconcileBrokerMaterials(opportunityId);
    if (selectionRef.current !== opportunityId) return false;
    if (!refreshed) setBrokerMaterialsState((current) => ({ ...current, checking: true, checkingFailed: true }));
    else if (!refreshed.brokerMaterials?.existingRequest) setBrokerMaterialsState((current) => ({ ...current, checking: true, checkingFailed: false }));
    return Boolean(refreshed);
  }

  useEffect(() => () => {
    detailFocusGuardRef.current = false;
    passFocusGuardRef.current = false;
    detailRequestRef.current.controller?.abort();
    detailRequestRef.current.generation += 1;
    brokerPrepareRequestRef.current.controller?.abort();
    brokerPrepareRequestRef.current.generation += 1;
    brokerApprovalRequestRef.current.controller?.abort();
    brokerApprovalRequestRef.current.generation += 1;
    brokerApprovalPendingRef.current = false;
    selectionRef.current = '';
  }, []);

  const loadedDetailId = detail.data?.opportunity?.opportunityId || '';
  const hasMatchingDetail = Boolean(selectedId && loadedDetailId === selectedId && detail.requestedId === selectedId);

  return (
    <section aria-label="Acquisition Inbox" className="section-shell mt-8 pb-8">
      <div className="panel overflow-hidden">
        <header className="flex flex-col gap-5 border-b border-line/80 p-5 sm:p-7 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-moss">Deal Hunter</p><h2 className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">Acquisition Inbox</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68">Review the authoritative opportunity queue, understand the evidence, and record a human decision without triggering scoring or outreach.</p></div>
          <nav aria-label="Deal Hunter views" className="flex rounded-full border border-line bg-fog/70 p-1"><NavLink className="rounded-full bg-moss px-4 py-2 text-sm font-semibold text-white" end to="/admin/deal-hunter">Inbox</NavLink><NavLink className="rounded-full px-4 py-2 text-sm font-semibold text-ink/68 hover:text-moss" to="/admin/deal-hunter?view=operations">Operations</NavLink></nav>
        </header>

        <div className="grid grid-cols-2 border-b border-line/80 sm:grid-cols-3 xl:grid-cols-5">{summaryItems.map(([key, itemLabel]) => <div className="border-b border-r border-line/70 px-4 py-4 last:border-r-0 xl:border-b-0" key={key}><p className="text-2xl font-semibold tabular-nums text-ink">{queue.summary?.[key] || 0}</p><p className="mt-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink/55">{itemLabel}</p></div>)}</div>

        <div className="border-b border-line/80 p-4 sm:p-5">
          <div aria-label="Opportunity queues" className="flex gap-2 overflow-x-auto" role="tablist">{views.map(([id, itemLabel]) => <button aria-selected={view === id} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${view === id ? 'border-moss bg-moss/10 text-moss' : 'border-line bg-white text-ink/62'}`} key={id} onClick={() => { setView(id); setPage(1); }} role="tab" type="button">{itemLabel}</button>)}</div>
          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(15rem,1fr)_repeat(3,minmax(9rem,auto))]">
            <label className="relative"><span className="sr-only">Search opportunities</span><Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-ink/40" /><input aria-label="Search opportunities" className="form-control pl-9" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Business or deal key" ref={searchInputRef} type="search" value={search} /></label>
            <label className="text-xs font-semibold text-ink/58">Confidence<select className="form-control mt-1" onChange={(event) => { setConfidence(event.target.value); setPage(1); }} value={confidence}><option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            <label className="text-xs font-semibold text-ink/58">Operator priority<select className="form-control mt-1" onChange={(event) => { setPriority(event.target.value); setPage(1); }} value={priority}><option value="">All</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="watch">Watch</option></select></label>
            <label className="text-xs font-semibold text-ink/58">Sort opportunities<select className="form-control mt-1" onChange={(event) => { setSort(event.target.value); setPage(1); }} value={sort}><option value="acquisition-priority">Acquisition priority</option><option value="fit-score">Fit score</option><option value="confidence">Confidence</option><option value="scored-at">Newest score</option><option value="name">Name</option></select></label>
          </div>
        </div>

        <div className="p-4 sm:p-5">
          {queue.sourceHealth && !queue.sourceHealth.healthy ? <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert"><p className="font-semibold">Source health is degraded. Persisted Inbox results remain available.</p>{queue.sourceHealth.issues?.map((issue, index) => <p className="mt-1" key={`${issue.sourceId || issue.title}-${index}`}>{issue.title}{issue.message ? `: ${issue.message}` : ''}</p>)}</div> : null}
          {queueError ? <p className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{queueError}</p> : null}
          {mutationError && !selectedId && !passTarget ? <p className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{mutationError}</p> : null}
          {loading && queue.rows.length === 0 ? <p className="text-sm text-ink/62">Loading current opportunities…</p> : null}
          {!loading && !queueError && queue.rows.length === 0 ? <p className="rounded-xl border border-line bg-fog/60 p-4 text-sm text-ink/68">No opportunities in this view.</p> : null}
          <ul aria-label="Opportunity queue" className="space-y-3 overflow-hidden md:space-y-0 md:rounded-2xl md:border md:border-line">{queue.rows.map((row) => <OpportunityRow key={row.opportunityId} onAction={(action, event) => action === 'pass' ? openQueuePass(row, event.currentTarget) : recordAction(row.opportunityId, action)} onOpen={(event) => openDetail(row.opportunityId, event.currentTarget)} pending={Boolean(pendingId)} readOnly={readOnly} row={row} />)}</ul>
          {queue.totalPages > 1 ? <div className="mt-4 flex items-center justify-between"><button aria-label="Previous page" className={buttonClass} disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button"><ChevronLeft className="h-4 w-4" />Previous</button><p className="text-xs font-semibold text-ink/58">Page {queue.page || page} of {queue.totalPages}</p><button aria-label="Next page" className={buttonClass} disabled={page >= queue.totalPages || loading} onClick={() => setPage((current) => current + 1)} type="button">Next<ChevronRight className="h-4 w-4" /></button></div> : null}
          {readOnly ? <p className="mt-4 text-sm font-semibold text-ink/62">Read-only access: decisions and verified-fact edits are unavailable.</p> : null}
        </div>
      </div>

      {selectedId ? <OpportunityDrawer brokerMaterialsState={brokerMaterialsState} detail={hasMatchingDetail ? detail.data : null} error={detail.requestedId === selectedId ? detail.error : ''} focusGuardRef={detailFocusGuardRef} loading={detail.requestedId === selectedId && detail.loading} mutationError={mutationError} onAction={hasMatchingDetail ? (action, payload) => recordAction(loadedDetailId, action, payload) : undefined} onBrokerMaterialsApprove={hasMatchingDetail ? (preparation) => approveBrokerMaterials(loadedDetailId, preparation) : undefined} onBrokerMaterialsCheckStatus={hasMatchingDetail ? () => checkBrokerMaterialsStatus(loadedDetailId) : undefined} onBrokerMaterialsInvalidate={invalidateBrokerMaterialsPreparation} onBrokerMaterialsPrepare={hasMatchingDetail ? (body) => prepareBrokerMaterials(loadedDetailId, body) : undefined} onClose={closeDetail} onRetry={() => loadDetail(selectedId)} onSaveFact={hasMatchingDetail ? (payload) => saveFact(loadedDetailId, payload) : undefined} pending={pendingId === loadedDetailId} readOnly={readOnly} /> : null}
      {passTarget ? <QueuePassDialog error={mutationError} focusGuardRef={passFocusGuardRef} name={passTarget.name} onCancel={closeQueuePass} onSubmit={(payload) => recordAction(passTarget.opportunityId, 'pass', payload)} pending={pendingId === passTarget.opportunityId} /> : null}
    </section>
  );
}
