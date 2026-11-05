import React, { useRef, useState } from 'react';
import {
  PursuedDealsApiError, REFRESH_COPY, SAVE_FAILED_COPY, createIdempotencyKeys, moveStage, recordReplyType,
} from './pursuedDealsApi.js';

export const REPLY_TYPES = Object.freeze([
  ['nda-requested', 'NDA requested'], ['sim-received', 'SIM received'], ['not-available', 'Not available'],
  ['question', 'Question'], ['other', 'Other'],
]);

const buttonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';

/**
 * One click records what the broker said (spec 2026-11-04 §7.2) and answers the reply that raised
 * the row. `row` is a tracker row. `onRecorded({ kind, replyType, row, fromStage })` follows a
 * recording (`kind: 'recorded'`) and an Undo (`kind: 'undone'`) with the server's fresh row.
 * `onConflict()` follows a 409, after the refresh copy is shown. Read-only viewers get nothing.
 */
export default function PursuitReplyTypeControl({ name, row, readOnly = false, onRecorded, onConflict }) {
  const keysRef = useRef(null);
  if (!keysRef.current) keysRef.current = createIdempotencyKeys();
  const [pending, setPending] = useState(false);
  const [recorded, setRecorded] = useState(null);
  const [error, setError] = useState('');
  if (readOnly) return null;

  // Runs one write under its idempotency key. The key is kept across a network failure, so the
  // owner's retry replays; a definite answer from the server releases it.
  async function run(signature, write) {
    if (pending) return null;
    setPending(true);
    setError('');
    const keys = keysRef.current;
    try {
      const result = await write(keys.keyFor(row.opportunityId, signature));
      keys.forget(row.opportunityId, signature);
      return result;
    } catch (failure) {
      if (failure instanceof PursuedDealsApiError) {
        keys.forget(row.opportunityId, signature);
        if (failure.status === 409) {
          setError(REFRESH_COPY);
          onConflict?.();
        } else {
          setError(failure.message || SAVE_FAILED_COPY);
        }
      } else {
        setError(SAVE_FAILED_COPY);
      }
      return null;
    } finally {
      setPending(false);
    }
  }

  async function record(replyType, label) {
    const acknowledgedReplyId = row.needsAction?.replyId;
    const fromStage = row.stage;
    const result = await run(JSON.stringify(['reply-type', replyType, row.latestEventId, acknowledgedReplyId ?? null]),
      (idempotencyKey) => recordReplyType({ opportunityId: row.opportunityId, replyType,
        expectedLatestEventId: row.latestEventId, acknowledgedReplyId, idempotencyKey }));
    if (!result) return;
    setRecorded({ label, fromStage, latestEventId: result.row.latestEventId });
    onRecorded?.({ kind: 'recorded', replyType, row: result.row, fromStage });
  }

  async function undo() {
    const { fromStage, latestEventId } = recorded;
    const result = await run(JSON.stringify(['undo', fromStage, latestEventId]),
      (idempotencyKey) => moveStage({ opportunityId: row.opportunityId, stage: fromStage,
        expectedLatestEventId: latestEventId, idempotencyKey }));
    if (!result) return;
    setRecorded(null);
    onRecorded?.({ kind: 'undone', row: result.row, fromStage });
  }

  return (
    <div className="space-y-2">
      <div aria-label={`Reply type for ${name}`} className="flex flex-wrap gap-2" role="group">
        {REPLY_TYPES.map(([replyType, label]) => (
          <button className={buttonClass} disabled={pending} key={replyType} onClick={() => record(replyType, label)} type="button">{label}</button>
        ))}
      </div>
      {recorded ? (
        <p className="text-sm font-semibold text-ink" role="status">
          Recorded: {recorded.label}.{' '}
          <button className="underline hover:text-moss disabled:opacity-50" disabled={pending} onClick={undo} type="button">Undo</button>
        </p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-red-800" role="alert">{error}</p> : null}
    </div>
  );
}
