// Classifies one message of a Pursue CIM Gmail thread (spec 2026-11-03 §6, step 4). The rules
// apply in this exact order and the first match wins:
//   ours        its Message-ID is one of our transmissions (or its Gmail id is a stored send)
//   owner       From is the connected mailbox, and it is not a transmission
//   bounce      a mailer-daemon sender, or multipart/report; report-type=delivery-status
//   auto-reply  Auto-Submitted other than "no", X-Autoreply, X-Autorespond, or
//               Precedence auto_reply / bulk / junk
//   stop        a stop word as a whole word in the first 4096 characters of the text part
//   reply       anything else from someone else (the match is on the thread, not the sender)
// The body prefix is read here and nowhere else; it is never returned or stored.
import { CIM_BODY_PREFIX_CHARS } from './cimMailProvider.js';

export const PURSUE_CIM_REPLY_CLASSES = Object.freeze(['ours', 'owner', 'bounce', 'auto-reply',
  'stop', 'reply']);

const AUTO_PRECEDENCE = new Set(['auto_reply', 'bulk', 'junk']);
// Whole words: a letter, digit, underscore or hyphen on either side breaks the match, so
// "non-stop", "stopped" and "unsubscribed" are not stop words.
const STOP_WORDS = /(?<![\p{L}\p{N}_-])(?:stop|unsubscribe|remove\s+me|do\s+not\s+contact)(?![\p{L}\p{N}_-])/iu;
// Where quoted history starts: Gmail/Apple "On ... wrote:", Outlook's original-message markers.
const QUOTE_START = /^\s*(?:On\s[^\n]{0,300}wrote:|-{2,}\s*Original Message\s*-{2,}|_{10,}|From:\s.*|Sent from my\s.*)\s*$/im;
// The footer Pursue emails ended with before pursue-cim-initial-v4 / pursue-cim-follow-up-v3
// (they now end with the owner's Gmail signature). Threads already sent still quote it, and a
// reply that carries it unquoted (some clients inline the original) is not asking us to stop.
const OUR_FOOTER = /If you would rather I not reach out about future listings,\s*just reply\s*["“”]?stop["“”]?\.?/giu;

function headerText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The lowercased mailbox address in a From header, or ''. */
export function replyFromAddress(value) {
  const raw = headerText(value);
  if (!raw) return '';
  const bracketed = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const bare = bracketed ? null : raw.match(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/);
  return (bracketed?.[1] || bare?.[0] || '').toLowerCase();
}

/** `<id@domain>`, trimmed, with angle brackets added when missing; '' when empty. */
export function normalizeRfcMessageId(value) {
  const raw = headerText(value);
  if (!raw) return '';
  const inner = raw.replace(/^<\s*/, '').replace(/\s*>$/, '');
  return inner ? `<${inner}>` : '';
}

function isBounce(from, contentType) {
  if (from.split('@')[0] === 'mailer-daemon') return true;
  const type = headerText(contentType).toLowerCase();
  if (!/^multipart\/report\s*(?:;|$)/.test(type)) return false;
  const reportType = type.match(/(?:^|;)\s*report-type\s*=\s*"?([^";\s]+)"?/);
  return reportType?.[1] === 'delivery-status';
}

function isAutoReply(headers) {
  const autoSubmitted = headerText(headers.autoSubmitted).toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (headerText(headers.xAutoreply) || headerText(headers.xAutorespond)) return true;
  return AUTO_PRECEDENCE.has(headerText(headers.precedence).toLowerCase());
}

function comparableLine(line) {
  return String(line).replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
}

/**
 * The reply without our Gmail signature, removed only as a whole block: every line of the
 * signature text (whitespace-collapsed, case-insensitive, blank lines ignored) in order, as one
 * run of the reply's lines. A single line is never removed on its own, so a broker who writes a
 * line that happens to equal one signature line ("Reply STOP to opt out") still counts; a
 * signature of fewer than two lines is never removed.
 */
function withoutSignatureBlock(lines, signatureText) {
  const signature = (typeof signatureText === 'string' ? signatureText : '')
    .split(/\r?\n/).map(comparableLine).filter(Boolean);
  if (signature.length < 2) return lines;
  const nonBlank = lines.map((line, index) => ({ line: comparableLine(line), index }))
    .filter(({ line }) => line !== '');
  const removed = new Set();
  for (let start = 0; start + signature.length <= nonBlank.length; start += 1) {
    if (!signature.every((line, offset) => nonBlank[start + offset].line === line)) continue;
    const first = nonBlank[start].index;
    const last = nonBlank[start + signature.length - 1].index;
    for (let index = first; index <= last; index += 1) removed.add(index);
    start += signature.length - 1;
  }
  return lines.filter((_, index) => !removed.has(index));
}

/**
 * The reply's own words: the first 4096 chars, cut at quoted history, quote lines dropped, our
 * old footer removed, and our Gmail signature removed when it appears whole. Our emails end
 * with that signature, so a reply that inlines the original without quote markers is not asking
 * us to stop because the signature happens to say "unsubscribe" or "do not contact".
 */
function ownWords(bodyPrefix, signatureText) {
  if (typeof bodyPrefix !== 'string' || !bodyPrefix) return '';
  let text = bodyPrefix.slice(0, CIM_BODY_PREFIX_CHARS);
  const quote = QUOTE_START.exec(text);
  if (quote) text = text.slice(0, quote.index);
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*>/.test(line));
  return withoutSignatureBlock(lines, signatureText).join('\n').replace(OUR_FOOTER, ' ');
}

/**
 * @param {object} input
 * @param {import('./cimMailProvider.js').CimThreadMessage} input.message
 * @param {string} input.connectedAddress the connected Gmail mailbox
 * @param {Iterable<string>} [input.knownMessageIds] RFC Message-IDs of our transmissions
 * @param {Iterable<string>} [input.knownProviderMessageIds] Gmail ids of our accepted sends
 * @param {string} [input.signatureText] the plain text of our stored Gmail signature
 * @returns {'ours'|'owner'|'bounce'|'auto-reply'|'stop'|'reply'}
 */
export function classifyPursueCimReply({ message, connectedAddress, knownMessageIds = [],
  knownProviderMessageIds = [], signatureText = '' } = {}) {
  const headers = message?.headers && typeof message.headers === 'object' ? message.headers : {};
  const known = new Set(Array.from(knownMessageIds, normalizeRfcMessageId).filter(Boolean));
  const messageId = normalizeRfcMessageId(headers.messageId);
  if (messageId && known.has(messageId)) return 'ours';
  if (typeof message?.id === 'string' && new Set(knownProviderMessageIds).has(message.id)) return 'ours';

  const from = replyFromAddress(headers.from);
  const connected = headerText(connectedAddress).toLowerCase();
  if (from && connected && from === connected) return 'owner';
  if (isBounce(from, headers.contentType)) return 'bounce';
  if (isAutoReply(headers)) return 'auto-reply';
  if (STOP_WORDS.test(ownWords(message?.bodyPrefix, signatureText))) return 'stop';
  return 'reply';
}
