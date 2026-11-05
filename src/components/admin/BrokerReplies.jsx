import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PursuitReplyTypeControl from './PursuitReplyTypeControl.jsx';
import SimUploadPanel, { simUploadRequest, simUploadedMessage, trackerWrite, usePursuedRowWrite } from './PursuitSimUploadPanel.jsx';
import { acknowledgeReply, loadPursuedDeals } from './pursuedDealsApi.js';

// The "Broker replies" block of Needs Your Action (spec 2026-11-04 §7.3): the pursued deals whose
// broker wrote back or bounced, read from the tracker rather than from the inbox queue.

const PURSUED_TAB = '/admin/deal-hunter?view=pursued';
const NO_REPLIES = Object.freeze({ rows: [], pinned: [] });

const buttonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';

function formatDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
}

/**
 * Reads the deals that need action whenever `refreshKey` changes. A failed read leaves no block at
 * all, so the area renders as it did before. Rows without `needsAction` are ignored. A row the owner
 * has just answered stays listed (pinned) until the next read, so its "Recorded: … Undo" stays put.
 */
export function useBrokerReplies(enabled, refreshKey) {
  const [state, setState] = useState(NO_REPLIES);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState(NO_REPLIES);
      return undefined;
    }
    let live = true;
    (async () => {
      try {
        const result = await loadPursuedDeals('needs-action');
        if (live) setState({ rows: (result.rows || []).filter((row) => row?.needsAction), pinned: [] });
      } catch {
        if (live) setState(NO_REPLIES);
      }
    })();
    return () => { live = false; };
  }, [enabled, refreshKey, reloads]);

  const replaceRow = useCallback((next) => {
    setState((current) => ({ ...current,
      rows: current.rows.map((row) => (row.opportunityId === next.opportunityId ? next : row)) }));
  }, []);
  const setPinned = useCallback((opportunityId, pinned) => {
    setState((current) => ({ ...current,
      pinned: pinned ? [...new Set([...current.pinned, opportunityId])] : current.pinned.filter((id) => id !== opportunityId) }));
  }, []);
  const reload = useCallback(() => setReloads((count) => count + 1), []);

  const items = state.rows.filter((row) => row.needsAction || state.pinned.includes(row.opportunityId));
  return { items, pinned: state.pinned, replaceRow, setPinned, reload };
}

function BrokerReplyItem({ row, pinned, readOnly, onRowChange, onPin, onReload }) {
  const { busy, message, setMessage, keys, runWrite } = usePursuedRowWrite({ opportunityId: row.opportunityId, onReload });
  const [uploadOpen, setUploadOpen] = useState(false);
  const attention = row.needsAction;
  const bounced = attention?.reason === 'bounce';

  async function markHandled() {
    const result = await runWrite(JSON.stringify(['acknowledge', attention.replyId]),
      (idempotencyKey) => acknowledgeReply({ opportunityId: row.opportunityId, acknowledgedReplyId: attention.replyId,
        idempotencyKey }), trackerWrite);
    if (result) onRowChange(result.row);
  }

  // After a network failure the deal is read again, to tell whether the SIM landed. Only this deal
  // is looked for, and a fresh copy of it replaces the row so a landed SIM shows up.
  async function rereadDeal() {
    try {
      const result = await loadPursuedDeals('all');
      const fresh = result.rows?.find((candidate) => candidate.opportunityId === row.opportunityId);
      if (fresh) onRowChange(fresh);
      return result.rows || [];
    } catch {
      return null;
    }
  }

  async function upload(file) {
    const request = simUploadRequest({ row, file, keys, reread: rereadDeal, onLanded: () => setUploadOpen(false) });
    const result = await runWrite(request.signature, request.write, request.describe);
    if (!result) return;
    if (result.row) onRowChange(result.row);
    setUploadOpen(false);
    setMessage(simUploadedMessage(result));
  }

  function handleRecorded({ kind, replyType, row: nextRow }) {
    onRowChange(nextRow);
    onPin(kind !== 'undone');
    setUploadOpen(kind !== 'undone' && replyType === 'sim-received');
  }

  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink">
        <div>
          <span className="font-semibold">{row.name}</span>
          <span className="ml-2 text-xs text-ink/58">
            {bounced ? 'Bounced' : 'Replied'} {formatDate(attention?.at ?? row.lastReplyAt)}
          </span>
        </div>
        {!readOnly ? (row.gmailThreadUrl
          ? <a className={buttonClass} href={row.gmailThreadUrl} rel="noopener noreferrer" target="_blank">Open in Gmail</a>
          : <span className="text-xs text-ink/58">Gmail thread not available yet.</span>) : null}
      </div>
      {!readOnly && bounced && attention.replyId
        ? <button className={buttonClass} disabled={busy} onClick={markHandled} type="button">Mark handled</button> : null}
      {!readOnly && (attention?.reason === 'reply' || pinned)
        ? <PursuitReplyTypeControl name={row.name} onConflict={onReload} onRecorded={handleRecorded} row={row} /> : null}
      {!readOnly && uploadOpen
        ? <SimUploadPanel busy={busy} name={row.name} onChoose={upload} onClose={() => setUploadOpen(false)} /> : null}
      {message ? <p className={`text-sm font-semibold ${message.tone === 'error' ? 'text-red-800' : 'text-ink'}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
    </li>
  );
}

/** `replies` is what `useBrokerReplies` returned; the block renders only while it has items. */
export default function BrokerRepliesBlock({ replies, readOnly = false }) {
  if (!replies.items.length) return null;
  return (
    <div className="border-b border-line/80 px-4 py-3">
      <p className="text-xs font-semibold text-ink/70">Broker replies</p>
      <ul aria-label="Broker replies" className="mt-2 divide-y divide-line/70">
        {replies.items.map((row) => (
          <BrokerReplyItem key={row.opportunityId} onPin={(pinned) => replies.setPinned(row.opportunityId, pinned)}
            onReload={replies.reload} onRowChange={replies.replaceRow} pinned={replies.pinned.includes(row.opportunityId)}
            readOnly={readOnly} row={row} />
        ))}
      </ul>
      <p className="mt-2 text-sm"><Link className="font-semibold text-moss hover:underline" to={PURSUED_TAB}>All pursued deals →</Link></p>
    </div>
  );
}
