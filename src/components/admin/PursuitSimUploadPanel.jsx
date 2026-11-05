import React, { useEffect, useRef, useState } from 'react';
import {
  PursuedDealsApiError, REFRESH_COPY, SAVE_FAILED_COPY, SIM_UPLOADED_COPY, SIM_UPLOADED_STOPPED_COPY,
  UPLOAD_INTERRUPTED_COPY, createIdempotencyKeys, uploadErrorCopy, uploadPursuedSim,
} from './pursuedDealsApi.js';

// The SIM upload that Pursued deals and the Broker replies block share (spec 2026-11-04 §7.2, §8):
// the panel itself, the per-row write runner and the upload request with its network-error handling.

const buttonClass = 'inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:border-moss/35 hover:text-moss disabled:cursor-not-allowed disabled:opacity-50';

export default function SimUploadPanel({ name, busy, onChoose, onClose }) {
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

// How a failed tracker write reads to the owner: a 409 means another tab changed the deal.
export const trackerWrite = Object.freeze({
  api: (failure) => (failure.status === 409
    ? { text: REFRESH_COPY, reload: true } : { text: failure.message || SAVE_FAILED_COPY, reload: false }),
  network: () => ({ text: SAVE_FAILED_COPY, reload: false }),
});

/**
 * Runs one owner write on a deal under its idempotency key. A definite server answer releases the
 * key; a network failure keeps it, so the owner's retry replays instead of writing twice.
 * `describe` = { api(failure), network() } -> { text, tone?, reload? }. `onReload()` follows a
 * describe with `reload: true`. Returns the write's result, or null when it failed or was skipped.
 */
export function usePursuedRowWrite({ opportunityId, onReload }) {
  const keysRef = useRef(null);
  if (!keysRef.current) keysRef.current = createIdempotencyKeys();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  async function runWrite(signature, write, describe) {
    if (busy) return null;
    setBusy(true);
    setMessage(null);
    const keys = keysRef.current;
    try {
      const result = await write(keys.keyFor(opportunityId, signature));
      keys.forget(opportunityId, signature);
      return result;
    } catch (failure) {
      let outcome;
      if (failure instanceof PursuedDealsApiError) {
        keys.forget(opportunityId, signature);
        outcome = describe.api(failure);
      } else {
        outcome = await describe.network();
      }
      setMessage(outcome.text ? { tone: outcome.tone || 'error', text: outcome.text } : null);
      if (outcome.reload) onReload();
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, setMessage, keys: keysRef.current, runWrite };
}

/**
 * The upload of `file` for `row`, as arguments for `runWrite`. On a network failure no answer came
 * back, so the upload may or may not have committed: `reread()` reads the deal again (resolving to
 * rows, or null). A SIM that was not there when the owner started means it landed (`onLanded()`
 * follows, with the OK copy). If not, the interrupted copy shows every time and the key is kept, so
 * the next attempt is a safe retry that replays if it did commit.
 */
export function simUploadRequest({ row, file, keys, reread, onLanded }) {
  const acknowledgedReplyId = row.needsAction?.replyId;
  const signature = JSON.stringify(['sim', file.name, file.size, file.lastModified, acknowledgedReplyId ?? null]);
  // The server words the OK copy by whether follow-ups were stoppable before the upload.
  const couldStop = row.release?.canStop === true;
  const knownDocuments = new Set((row.simDocuments || []).map((document) => document.id));
  return {
    signature,
    write: (idempotencyKey) => uploadPursuedSim({ opportunityId: row.opportunityId, file, idempotencyKey, acknowledgedReplyId }),
    describe: {
      api: (failure) => ({ text: uploadErrorCopy(failure), reload: false }),
      network: async () => {
        const rows = await reread();
        const fresh = rows?.find((candidate) => candidate.opportunityId === row.opportunityId);
        if (fresh?.simDocuments?.some((document) => !knownDocuments.has(document.id))) {
          keys.forget(row.opportunityId, signature);
          onLanded();
          return { text: couldStop ? SIM_UPLOADED_STOPPED_COPY : SIM_UPLOADED_COPY, tone: 'ok' };
        }
        return { text: UPLOAD_INTERRUPTED_COPY };
      },
    },
  };
}

export const simUploadedMessage = (result) => ({
  tone: 'ok', text: result.stoppedFollowUps ? SIM_UPLOADED_STOPPED_COPY : SIM_UPLOADED_COPY,
});
