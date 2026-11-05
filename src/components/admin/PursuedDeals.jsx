import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PursuitReplyTypeControl from './PursuitReplyTypeControl.jsx';
import {
  PursuedDealsApiError, REFRESH_COPY, SAVE_FAILED_COPY, UPLOAD_INTERRUPTED_COPY, acknowledgeReply, createIdempotencyKeys,
  loadPursuedDeals, moveStage, stopSimRequests, uploadErrorCopy, uploadPursuedSim,
} from './pursuedDealsApi.js';

// Stage ids and labels, in pipeline order (spec 2026-11-04 §4.1). The UI says "SIM"; the code keeps CIM.
const STAGES = Object.freeze([
  ['cim-requested', 'SIM requested'], ['broker-replied', 'Broker replied'], ['nda-sent', 'NDA'],
  ['cim-received', 'SIM received'], ['financial-review', 'Reviewing'], ['loi-candidate', 'LOI candidate'], ['passed', 'Passed'],
]);
const NEEDS_ACTION = 'needs-action';
const ALL = 'all';

const buttonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';
const chipClass = (active) => `shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${active ? 'border-moss bg-moss/10 text-moss' : 'border-line bg-white text-ink/62'}`;

function formatLabel(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The chip counts follow a row the owner has just changed, without re-reading the page.
function adjustCounts(counts, before, after) {
  const byStage = { ...counts.byStage };
  if (before.stage !== after.stage) {
    byStage[before.stage] = Math.max(0, (byStage[before.stage] || 0) - 1);
    byStage[after.stage] = (byStage[after.stage] || 0) + 1;
  }
  let { needsAction } = counts;
  if (before.needsAction && !after.needsAction) needsAction = Math.max(0, needsAction - 1);
  if (!before.needsAction && after.needsAction) needsAction += 1;
  return { needsAction, byStage };
}

function DealHunterNav() {
  return (
    <nav aria-label="Deal Hunter views" className="flex rounded-full border border-line bg-fog/70 p-1">
      <Link className="rounded-full px-4 py-2 text-sm font-semibold text-ink/68 hover:text-moss" to="/admin/deal-hunter">Inbox</Link>
      <Link aria-current="page" className="rounded-full bg-moss px-4 py-2 text-sm font-semibold text-white" to="/admin/deal-hunter?view=pursued">Pursued deals</Link>
      <Link className="rounded-full px-4 py-2 text-sm font-semibold text-ink/68 hover:text-moss" to="/admin/deal-hunter?view=operations">Operations</Link>
    </nav>
  );
}

function SimUploadPanel({ name, busy, onChoose, onClose }) {
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-fog/60 p-3">
      <input accept="application/pdf,.pdf" aria-label={`SIM file for ${name}`} className="text-sm" disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          onChoose(file);
          try { event.target.value = ''; } catch { /* Some browsers refuse; the owner can pick again. */ }
        }}
        ref={inputRef} type="file" />
      <button className={buttonClass} disabled={busy} onClick={onClose} type="button">Upload later</button>
    </div>
  );
}

function PursuedRow({ row, readOnly, onRowChange, onReload }) {
  const keysRef = useRef(null);
  if (!keysRef.current) keysRef.current = createIdempotencyKeys();
  const uploadButtonRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [bandPinned, setBandPinned] = useState(false);

  const canWrite = !readOnly && row.opportunityActive && !row.passedInDealHunter;
  const attention = row.needsAction;
  const release = row.release;
  const gmailAvailable = !readOnly;

  // Runs one owner write under its idempotency key. A definite server answer releases the key; a
  // network failure keeps it, so the owner's retry replays instead of writing twice.
  async function runWrite(signature, write, describe) {
    if (busy) return null;
    setBusy(true);
    setMessage(null);
    const keys = keysRef.current;
    try {
      const result = await write(keys.keyFor(row.opportunityId, signature));
      keys.forget(row.opportunityId, signature);
      return result;
    } catch (failure) {
      let outcome;
      if (failure instanceof PursuedDealsApiError) {
        keys.forget(row.opportunityId, signature);
        outcome = describe.api(failure);
      } else {
        outcome = describe.network(describe.retried);
      }
      if (outcome.text) setMessage({ tone: 'error', text: outcome.text });
      if (outcome.reload) onReload();
      return null;
    } finally {
      setBusy(false);
    }
  }

  const trackerWrite = {
    api: (failure) => (failure.status === 409
      ? { text: REFRESH_COPY, reload: true } : { text: failure.message || SAVE_FAILED_COPY, reload: false }),
    network: () => ({ text: SAVE_FAILED_COPY, reload: false }),
  };

  async function move(stage) {
    if (!stage || stage === row.stage) return;
    const acknowledgedReplyId = attention?.reason === 'reply' ? attention.replyId : undefined;
    const result = await runWrite(JSON.stringify(['stage', stage, row.latestEventId, acknowledgedReplyId ?? null]),
      (idempotencyKey) => moveStage({ opportunityId: row.opportunityId, stage, expectedLatestEventId: row.latestEventId,
        acknowledgedReplyId, idempotencyKey }), trackerWrite);
    if (result) onRowChange(result.row);
  }

  async function markHandled() {
    const result = await runWrite(JSON.stringify(['acknowledge', attention.replyId]),
      (idempotencyKey) => acknowledgeReply({ opportunityId: row.opportunityId, acknowledgedReplyId: attention.replyId,
        idempotencyKey }), trackerWrite);
    if (result) onRowChange(result.row);
  }

  async function stop() {
    const campaign = release.campaign;
    const result = await runWrite(JSON.stringify(['stop', campaign.id, campaign.rowVersion, campaign.terminalRevision]),
      (idempotencyKey) => stopSimRequests({ opportunityId: row.opportunityId, campaign, idempotencyKey }), {
        api: (failure) => (failure.status === 409
          ? { text: REFRESH_COPY, reload: true } : { text: failure.message || SAVE_FAILED_COPY, reload: false }),
        network: () => ({ text: SAVE_FAILED_COPY, reload: false }),
      });
    // The campaign is stopped; reading the page again shows the row's new release status.
    if (result) onReload();
  }

  async function upload(file) {
    const acknowledgedReplyId = attention?.replyId;
    const signature = JSON.stringify(['sim', file.name, file.size, file.lastModified, acknowledgedReplyId ?? null]);
    const result = await runWrite(signature,
      (idempotencyKey) => uploadPursuedSim({ opportunityId: row.opportunityId, file, idempotencyKey, acknowledgedReplyId }), {
        api: (failure) => ({ text: uploadErrorCopy(failure), reload: false }),
        // A retry of an upload that may already have committed: the server can answer a replay and
        // reset the connection, so look at the row instead of reporting a failure.
        network: (retried) => (retried ? { text: '', reload: true } : { text: UPLOAD_INTERRUPTED_COPY, reload: false }),
        retried: keysRef.current.has(row.opportunityId, signature),
      });
    if (!result) return;
    if (result.row) onRowChange(result.row);
    setUploadOpen(false);
    setMessage({ tone: 'ok', text: result.stoppedFollowUps ? 'SIM uploaded. Follow-ups for this deal have stopped.' : 'SIM uploaded.' });
  }

  function handleRecorded({ kind, replyType, row: nextRow }) {
    onRowChange(nextRow);
    if (kind === 'undone') {
      setBandPinned(false);
      return;
    }
    setBandPinned(true);
    if (replyType === 'sim-received') setUploadOpen(true);
  }

  function closeUpload() {
    setUploadOpen(false);
    uploadButtonRef.current?.focus();
  }

  const bandText = attention?.reason === 'bounce'
    ? `SIM request bounced ${formatDate(attention.at)}.`
    : `Broker replied ${formatDate(attention?.at)} — what did they say?`;

  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {row.crmSubmissionId
              ? <Link className="text-base font-semibold text-ink hover:text-moss" to={`/admin/crm/${encodeURIComponent(row.crmSubmissionId)}`}>{row.name}</Link>
              : <span className="text-base font-semibold text-ink">{row.name}</span>}
            <span className="rounded-full bg-moss/10 px-2 py-1 text-xs font-semibold text-moss">{row.stageLabel}</span>
            <span className="text-xs text-ink/58">since {formatDate(row.stageSince)}</span>
          </div>
          <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-ink/62">
            <span>{row.releaseUnavailable || !release?.status ? 'Status unavailable' : formatLabel(release.status.code)}</span>
            {row.lastReplyAt ? <span>Replied {formatDate(row.lastReplyAt)}</span> : null}
          </p>
          {row.passedInDealHunter ? <p className="mt-1 text-xs font-semibold text-ink/70">Passed in Deal Hunter</p> : null}
          {!row.opportunityActive ? <p className="mt-1 text-xs font-semibold text-ink/70">Merged into another listing</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {gmailAvailable ? (row.gmailThreadUrl
            ? <a className={buttonClass} href={row.gmailThreadUrl} rel="noopener noreferrer" target="_blank">Open in Gmail</a>
            : <span className="text-xs text-ink/58">Gmail thread not available yet.</span>) : null}
          {canWrite ? (
            <select aria-label={`Move to… (${row.name})`} className="form-control min-h-9 py-1 text-sm" disabled={busy}
              onChange={(event) => move(event.target.value)} value="">
              <option value="">Move to…</option>
              {STAGES.filter(([id]) => id !== row.stage).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          ) : null}
          {canWrite ? <button className={buttonClass} disabled={busy} onClick={() => (uploadOpen ? closeUpload() : setUploadOpen(true))} ref={uploadButtonRef} type="button">Upload SIM</button> : null}
          {canWrite && release?.canStop && release.campaign
            ? <button className={`${buttonClass} text-red-700`} disabled={busy} onClick={stop} type="button">Stop SIM requests</button> : null}
        </div>
      </div>

      {attention || bandPinned ? (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          {attention ? <p className="text-sm font-semibold text-amber-950">{bandText}</p> : null}
          {attention?.classification === 'stop' ? <p className="text-sm text-amber-950">They asked not to be emailed again.</p> : null}
          {canWrite && attention?.reason === 'bounce' && attention.replyId
            ? <button className={buttonClass} disabled={busy} onClick={markHandled} type="button">Mark handled</button> : null}
          {canWrite && (attention?.reason === 'reply' || bandPinned)
            ? <PursuitReplyTypeControl name={row.name} onConflict={onReload} onRecorded={handleRecorded} row={row} /> : null}
        </div>
      ) : null}

      {uploadOpen && canWrite ? <SimUploadPanel busy={busy} name={row.name} onChoose={upload} onClose={closeUpload} /> : null}

      {row.simDocuments?.length ? (
        <ul aria-label={`SIMs for ${row.name}`} className="space-y-1 text-sm">
          {row.simDocuments.map((document) => (
            <li key={document.id}>
              <a className="font-semibold text-moss hover:underline" href={`/api/admin/secure-documents/${encodeURIComponent(document.id)}/download`}>{document.name}</a>
              <span className="text-xs text-ink/58"> · {formatSize(document.sizeBytes)} · uploaded {formatDate(document.uploadedAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? <p className={`text-sm font-semibold ${message.tone === 'error' ? 'text-red-800' : 'text-ink'}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
    </li>
  );
}

export default function PursuedDeals({ readOnly = false }) {
  const [filter, setFilter] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const generationRef = useRef(0);
  const filterRef = useRef(null);

  // `requested` null is the first look: Needs your action if anything needs it, else All.
  const load = useCallback(async (requested) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setLoading(true);
    setLoadFailed(false);
    if (requested) setFilter(requested);
    try {
      let stage = requested || NEEDS_ACTION;
      let result = await loadPursuedDeals(stage);
      if (!requested && !result.counts?.needsAction) {
        stage = ALL;
        result = await loadPursuedDeals(ALL);
      }
      if (generation !== generationRef.current) return;
      filterRef.current = stage;
      setFilter(stage);
      setData({ rows: result.rows || [], counts: result.counts, truncated: Boolean(result.truncated) });
    } catch {
      if (generation === generationRef.current) setLoadFailed(true);
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(null); }, [load]);

  const reload = useCallback(() => load(filterRef.current), [load]);

  const replaceRow = useCallback((next) => {
    setData((current) => {
      const before = current?.rows.find((candidate) => candidate.opportunityId === next.opportunityId);
      if (!before) return current;
      return { ...current,
        rows: current.rows.map((candidate) => (candidate.opportunityId === next.opportunityId ? next : candidate)),
        counts: adjustCounts(current.counts, before, next) };
    });
  }, []);

  const counts = data?.counts;
  const totalDeals = counts ? Object.values(counts.byStage).reduce((sum, value) => sum + value, 0) : 0;
  const chips = counts ? [
    [NEEDS_ACTION, `Needs your action (${counts.needsAction})`],
    [ALL, `All (${totalDeals})`],
    ...STAGES.map(([id, label]) => [id, `${label} (${counts.byStage[id] || 0})`]),
  ] : [];

  return (
    <section aria-label="Pursued deals" className="section-shell mt-8 pb-8">
      <div className="panel overflow-hidden">
        <header className="flex flex-col gap-5 border-b border-line/80 p-5 sm:p-7 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-moss">Deal Hunter</p>
            <h2 className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">Pursued deals</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68">Every deal you&apos;ve asked a broker for a SIM on, and where it stands.</p>
          </div>
          <DealHunterNav />
        </header>

        <div className="p-4 sm:p-5">
          {readOnly ? <p className="mb-4 text-sm font-semibold text-ink/62">Read-only access: stage changes and uploads are unavailable.</p> : null}
          {chips.length ? (
            <div aria-label="Filter by stage" className="mb-4 flex gap-2 overflow-x-auto" role="group">
              {chips.map(([id, label]) => (
                <button aria-pressed={filter === id} className={chipClass(filter === id)} key={id} onClick={() => load(id)} type="button">{label}</button>
              ))}
            </div>
          ) : null}

          {loadFailed ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              Pursued deals couldn&apos;t load.
              <button className={`${buttonClass} ml-3`} onClick={() => load(filterRef.current)} type="button">Retry</button>
            </div>
          ) : null}
          {loading && !data ? <p className="text-sm text-ink/62">Loading pursued deals…</p> : null}

          {data ? (
            <>
              {data.rows.length === 0 && !loading ? (
                <p className="rounded-xl border border-line bg-fog/60 p-4 text-sm text-ink/68">
                  {totalDeals === 0
                    ? 'No pursued deals yet. Deals you Pursue — or that are pursued automatically at 90+ — show up here.'
                    : 'No deals at this stage.'}
                </p>
              ) : (
                <ul aria-busy={loading} aria-label="Pursued deals list" className="divide-y divide-line/70 overflow-hidden rounded-2xl border border-line">
                  {data.rows.map((row) => (
                    <PursuedRow key={row.opportunityId} onReload={reload} onRowChange={replaceRow} readOnly={readOnly} row={row} />
                  ))}
                </ul>
              )}
              {data.truncated ? <p className="mt-3 text-sm text-ink/68">Showing the first 200. Use a stage filter to see the rest.</p> : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
