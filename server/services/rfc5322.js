// Builds the RFC 5322 / MIME message that Gmail's users.messages.send takes as `raw`
// (base64url-encoded by the caller). Header safety (spec Review Focus 4):
// - addresses and message ids are validated against strict patterns, never repaired;
// - display names and the subject lose every control character (CR, LF, ...) and names also
//   lose < > " \, so no input can end a header line or open a new one;
// - anything not printable ASCII is RFC 2047 encoded (UTF-8, B encoding);
// - header lines are folded at 78 characters, bodies are base64 at 76.
// Invalid input throws an error whose message and `.code` are `invalid_message`.
import { randomBytes } from 'node:crypto';

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// <left@right>, printable ASCII without space, < or >.
export const RFC_MESSAGE_ID = /^<[!-;=?-~]+@[!-;=?-~]+>$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const MAX_LINE = 78;
const MAX_ASCII_TOKEN = 900;
// 39 UTF-8 bytes -> 52 base64 chars -> a 64-char encoded word, which fits after "Subject: ".
const ENCODED_WORD_BYTES = 39;

function invalidMessage() {
  const error = new Error('invalid_message');
  error.code = 'invalid_message';
  return error;
}

/** Replaces every control or line-separator character with a space and collapses whitespace. */
function headerText(value) {
  let text = '';
  for (const char of String(value ?? '')) {
    const point = char.codePointAt(0);
    const control = point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029;
    text += control ? ' ' : char;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function encodedWords(text) {
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (chunk && bytes + size > ENCODED_WORD_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
}

/** Plain words when printable ASCII, RFC 2047 encoded words otherwise. */
function textTokens(text) {
  const words = text.split(' ').filter(Boolean);
  if (PRINTABLE_ASCII.test(text) && words.every((word) => word.length <= MAX_ASCII_TOKEN)) return words;
  return encodedWords(text);
}

/** Joins tokens with single spaces, folding (CRLF + space) before a token that would pass 78. */
function foldHeader(name, tokens) {
  const lines = [];
  let line = `${name}:`;
  for (const token of tokens) {
    if (line.length > name.length + 1 && line.length + 1 + token.length > MAX_LINE) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function mailboxTokens(value) {
  const mailbox = typeof value === 'string' ? { address: value } : value;
  const address = typeof mailbox?.address === 'string' ? mailbox.address.trim() : '';
  if (!ADDRESS.test(address)) throw invalidMessage();
  const name = headerText(String(mailbox.name ?? '').replace(/[<>"\\]/g, ' '));
  if (!name) return [address];
  const phrase = PRINTABLE_ASCII.test(name) ? [`"${name}"`] : encodedWords(name);
  return [...phrase, `<${address}>`];
}

/** One mailbox as it appears in a From or To header, unfolded. Throws invalid_message. */
export function formatMailboxHeader(value) {
  return mailboxTokens(value).join(' ');
}

function messageId(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalidMessage();
    return null;
  }
  if (typeof value !== 'string' || !RFC_MESSAGE_ID.test(value)) throw invalidMessage();
  return value;
}

function referenceIds(value) {
  if (value === undefined || value === null) return [];
  const ids = Array.isArray(value) ? value : String(value).split(/[ \t]+/).filter(Boolean);
  return ids.map((id) => messageId(id, { required: true }));
}

function rfc5322Date(date) {
  const instant = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(instant.getTime())) throw invalidMessage();
  return instant.toUTCString().replace(/GMT$/, '+0000');
}

function base64Lines(text) {
  return Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
}

function textPart(subtype, body) {
  return [`Content-Type: text/${subtype}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '',
    base64Lines(body)].join('\r\n');
}

/**
 * @param {object} message
 * @param {string|{name?: string, address: string}} message.from
 * @param {string|{name?: string, address: string}} message.to
 * @param {string} message.subject
 * @param {string} message.text required plain-text body
 * @param {string} [message.html] adds a multipart/alternative HTML part
 * @param {string} message.messageId `<left@right>`
 * @param {string} [message.inReplyTo] `<left@right>`
 * @param {string[]|string} [message.references] ids, as an array or space-separated
 * @param {Date|string} [message.date] adds a Date header
 * @returns {string} the message with CRLF line endings, all ASCII
 */
export function buildRfc5322Message({
  from, to, subject, text, html, messageId: id, inReplyTo, references, date,
} = {}) {
  if (typeof text !== 'string' || !text) throw invalidMessage();
  if (html !== undefined && html !== null && typeof html !== 'string') throw invalidMessage();
  const headers = [
    foldHeader('From', mailboxTokens(from)),
    foldHeader('To', mailboxTokens(to)),
    foldHeader('Subject', textTokens(headerText(subject))),
  ];
  if (date !== undefined && date !== null) headers.push(`Date: ${rfc5322Date(date)}`);
  headers.push(`Message-ID: ${messageId(id, { required: true })}`);
  const parent = messageId(inReplyTo);
  if (parent) headers.push(`In-Reply-To: ${parent}`);
  const chain = referenceIds(references);
  if (chain.length) headers.push(foldHeader('References', chain));
  headers.push('MIME-Version: 1.0');

  if (!html) return [...headers, textPart('plain', text), ''].join('\r\n');
  const boundary = `=_${randomBytes(16).toString('hex')}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    textPart('plain', text),
    `--${boundary}`,
    textPart('html', html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
