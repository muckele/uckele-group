// The owner's Gmail signature at the end of every Pursue email (spec 2026-11-03 §8.1).
//
// The app keeps a snapshot of it: the sanitized HTML, its plain text, the sha256 digest of the
// HTML, the send-as address and when it was fetched. The snapshot is refreshed from Gmail when
// the owner asks (Email sending card), when Gmail is connected, and at the start of every Pursue
// sender slot. The wording digest includes the snapshot's digest, so a changed signature pauses
// sending (wording_not_approved) until the owner approves the wording again. A failed refresh
// keeps the stored snapshot and records only an error code.
import { sha256 } from '../utils/security.js';
import {
  sanitizeEmailSignatureHtml,
  signatureHasContent,
  signatureHtmlToText,
  signatureIsImageOnly,
} from './emailSignatureHtml.js';
import { createGmailCimProvider } from './gmailCimProvider.js';

const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const READ_FAILED = 'gmail_signature_read_failed';
const STORE_FAILED = 'gmail_signature_store_failed';

function codeOr(value, fallback) {
  return typeof value === 'string' && CODE.test(value) ? value : fallback;
}

function isoInstant(value) {
  const at = new Date(value ?? Date.now());
  return Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString();
}

function configuredSender(config) {
  return String(config?.dealHunter?.gmail?.senderAddress ?? '').trim().toLowerCase();
}

/** The stored snapshot, or null when there is none or it cannot be read. */
export async function readPursueEmailSignature(storage) {
  try {
    return (await storage?.getGmailSignature?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The snapshot Pursue emails may end with: loaded, read for the configured sender address, and
 * with text after sanitizing (an image's alt text counts). Returns `{ html, text, digest }` or
 * null.
 */
export function usablePursueSignature(snapshot, config) {
  const sender = configuredSender(config);
  if (!snapshot?.loaded || !sender) return null;
  if (String(snapshot.sendAsEmail ?? '').trim().toLowerCase() !== sender) return null;
  const { html } = sanitizeEmailSignatureHtml(snapshot.html);
  if (!signatureHasContent(html)) return null;
  return { html, text: signatureHtmlToText(html), digest: snapshot.digest };
}

/** Reads the stored snapshot and returns the usable signature (see usablePursueSignature). */
export async function readUsablePursueSignature({ storage, config }) {
  return usablePursueSignature(await readPursueEmailSignature(storage), config);
}

/**
 * What the Email sending card shows about the signature: whether a snapshot for the configured
 * address is loaded, whether it is empty, when it was fetched, and the last refresh error code.
 * Never the HTML (the wording preview shows the signature as it will appear).
 */
export function pursueSignatureView(snapshot, config) {
  const sender = configuredSender(config);
  const forSender = Boolean(snapshot?.loaded && sender
    && String(snapshot.sendAsEmail ?? '').trim().toLowerCase() === sender);
  return {
    loaded: forSender,
    empty: forSender && usablePursueSignature(snapshot, config) === null,
    imageOnly: forSender && signatureIsImageOnly(snapshot.html),
    fetchedAt: forSender ? snapshot.fetchedAt ?? null : null,
    sendAsEmail: forSender ? snapshot.sendAsEmail : null,
    lastAttemptAt: snapshot?.lastAttemptAt ?? null,
    lastErrorCode: codeOr(snapshot?.lastErrorCode, null),
  };
}

/**
 * Reads the signature from Gmail and stores the snapshot. Never throws. Returns
 * `{ ok: true, code, changed, signature }` (code is null, or `gmail_signature_too_large` when the
 * signature was stored empty) or `{ ok: false, code, signature }`, where `signature` is the
 * stored snapshot afterwards. A failure keeps the stored snapshot, records the code and logs one
 * line (codes only, never a token or a Google response) when the code differs from the stored
 * last error code, so a mailbox that keeps failing the same way does not fill the logs.
 */
export async function refreshPursueEmailSignature({ storage, config, now = new Date(), mailProvider,
  fetcher, logger = console, source = 'unknown' } = {}) {
  const at = isoInstant(now);
  const previous = await readPursueEmailSignature(storage);
  const fail = async (code) => {
    try {
      await storage.recordGmailSignatureRefresh({ ok: false, errorCode: code, now: at });
    } catch {
      // The failure is still logged and returned; the stored snapshot is unchanged either way.
    }
    if (previous?.lastErrorCode !== code) {
      logger?.warn?.('[pursue-signature] Gmail signature refresh failed', { code, source });
    }
    return { ok: false, code, signature: await readPursueEmailSignature(storage) };
  };

  let result;
  try {
    const provider = mailProvider || createGmailCimProvider({ storage, config, now: at,
      ...(fetcher ? { fetcher } : {}) });
    result = typeof provider.readSignature === 'function'
      ? await provider.readSignature() : { ok: false, code: READ_FAILED };
  } catch {
    result = { ok: false, code: READ_FAILED };
  }
  if (result?.ok !== true || typeof result.html !== 'string' || typeof result.sendAsEmail !== 'string') {
    return fail(codeOr(result?.code, READ_FAILED));
  }

  const { html, code } = sanitizeEmailSignatureHtml(result.html);
  const digest = sha256(html);
  let stored;
  try {
    stored = await storage.recordGmailSignatureRefresh({ ok: true, sendAsEmail: result.sendAsEmail.trim(),
      html, text: signatureHtmlToText(html), digest, errorCode: code, now: at });
  } catch {
    return fail(STORE_FAILED);
  }
  if (code && previous?.lastErrorCode !== code) {
    logger?.warn?.('[pursue-signature] Gmail signature stored empty', { code, source });
  }
  return { ok: true, code, changed: previous?.digest !== digest, signature: stored };
}
