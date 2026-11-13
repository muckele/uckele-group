// A strict allow-list sanitizer for the owner's Gmail signature HTML, and its plain-text form.
//
// The signature is read from Gmail (users.settings.sendAs) and ends every Pursue email, so it is
// treated as untrusted input: the HTML is tokenized and re-serialized from scratch. Only the tags
// and attributes listed here survive; every attribute value is checked, decoded and re-escaped;
// text is re-escaped; and every allowed tag that is opened is closed. Anything else (comments,
// scripts, styles, embedded content and its contents, event handlers, unknown tags) is dropped,
// keeping only the text of unknown tags. No dependency: the output never contains markup this
// module did not write itself.

export const EMAIL_SIGNATURE_MAX_INPUT_CHARS = 64 * 1024;
export const EMAIL_SIGNATURE_TOO_LARGE = 'gmail_signature_too_large';

const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'img',
  'table', 'tbody', 'thead', 'tr', 'td', 'th', 'font', 'small', 'hr']);
const VOID_TAGS = new Set(['br', 'img', 'hr']);
const TABLE_TAGS = new Set(['table', 'tbody', 'thead', 'tr', 'td', 'th']);
// Dropped together with everything inside them. Raw-text elements end at their first close tag.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed',
  'noframes', 'noscript', 'plaintext']);
const DROP_WITH_CONTENT_TAGS = new Set([...RAW_TEXT_TAGS, 'object', 'embed', 'applet', 'svg', 'math',
  'template', 'head', 'select', 'frameset', 'canvas', 'audio', 'video']);

const NUMBER_VALUE = /^[+-]?\d{1,4}(?:\.\d{1,4})?(?:%|px)?$/i;
const COLOR_VALUE = /^#?[A-Za-z0-9]{1,30}$/;
const FACE_VALUE = /^[A-Za-z0-9 ,'"_-]{1,200}$/;
const ALIGN_VALUE = /^(?:left|right|center|justify)$/i;
const VALIGN_VALUE = /^(?:top|middle|bottom|baseline)$/i;
const DIR_VALUE = /^(?:ltr|rtl|auto)$/i;
const UNSAFE_STYLE = /url\s*\(|expression|javascript:|@import|behavior|[<>\\]|\/\*/i;
const HREF_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const SRC_SCHEMES = new Set(['https']);

// One attribute rule per name: which tags may carry it and how its value is checked.
const ATTRIBUTE_RULES = {
  style: { tags: null, check: (value) => value.length <= 2000 && !UNSAFE_STYLE.test(value) },
  dir: { tags: null, check: (value) => DIR_VALUE.test(value) },
  href: { tags: new Set(['a']), url: HREF_SCHEMES },
  src: { tags: new Set(['img']), url: SRC_SCHEMES },
  alt: { tags: new Set(['img']), check: (value) => value.length <= 500 },
  width: { tags: new Set(['img', ...TABLE_TAGS]), check: (value) => NUMBER_VALUE.test(value) },
  height: { tags: new Set(['img', ...TABLE_TAGS]), check: (value) => NUMBER_VALUE.test(value) },
  color: { tags: new Set(['font']), check: (value) => COLOR_VALUE.test(value) },
  face: { tags: new Set(['font']), check: (value) => FACE_VALUE.test(value) },
  size: { tags: new Set(['font']), check: (value) => NUMBER_VALUE.test(value) },
  align: { tags: TABLE_TAGS, check: (value) => ALIGN_VALUE.test(value) },
  valign: { tags: TABLE_TAGS, check: (value) => VALIGN_VALUE.test(value) },
  cellpadding: { tags: TABLE_TAGS, check: (value) => NUMBER_VALUE.test(value) },
  cellspacing: { tags: TABLE_TAGS, check: (value) => NUMBER_VALUE.test(value) },
  border: { tags: TABLE_TAGS, check: (value) => NUMBER_VALUE.test(value) },
  bgcolor: { tags: TABLE_TAGS, check: (value) => COLOR_VALUE.test(value) },
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022',
  middot: '\u00b7', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', deg: '\u00b0', times: '\u00d7', euro: '\u20ac', pound: '\u00a3',
  cent: '\u00a2', sect: '\u00a7', para: '\u00b6', verbar: '|', vert: '|', sol: '/', colon: ':',
  lpar: '(', rpar: ')', period: '.', comma: ',', excl: '!', num: '#', percnt: '%', plus: '+',
  equals: '=', quest: '?', commat: '@', lowbar: '_', Tab: '\t', NewLine: '\n',
};

// A comment (to its end, or the end of the input), a declaration, a processing instruction,
// a quote-aware tag, a run of text, or a lone '<' that starts nothing (kept as text). A tag
// never contains a bare '<', so a failed tag match stops at the next one (no quadratic rescans).
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*(?:>|$)|<\?[^>]*(?:>|$)|<\/?[A-Za-z][^\s/<>]*(?:"[^"]*"|'[^']*'|[^'"<>])*>|[^<]+|</gy;
const TAG = /^<(\/?)([A-Za-z][^\s/>]*)([\s\S]*?)>$/;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function decodeHtmlEntities(value) {
  return String(value).replace(/&(#[xX][0-9A-Fa-f]{1,8}|#\d{1,9}|[A-Za-z][A-Za-z0-9]{0,31});?/g,
    (match, body) => {
      if (body[0] === '#') {
        const point = body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff
          || (point >= 0xd800 && point <= 0xdfff)) return '\ufffd';
        return String.fromCodePoint(point);
      }
      return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
    });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\u00a0', '&nbsp;');
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_AND_SPACE = /[\u0000- \u007f]/g;

/** A URL value with an allowed scheme, or null. Relative URLs are refused. */
function safeUrl(value, schemes) {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(cleaned.replace(CONTROL_AND_SPACE, ''))?.[1];
  if (!scheme || !schemes.has(scheme.toLowerCase())) return null;
  return cleaned.length <= 2048 ? cleaned : null;
}

function sanitizeAttributes(tag, source) {
  const kept = [];
  const seen = new Set();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    const rule = Object.hasOwn(ATTRIBUTE_RULES, name) ? ATTRIBUTE_RULES[name] : null;
    if (!rule || seen.has(name) || (rule.tags && !rule.tags.has(tag))) continue;
    const raw = match[2] ?? match[3] ?? match[4];
    if (raw === undefined) continue;
    let value = decodeHtmlEntities(raw).replace(CONTROL, '').trim();
    if (rule.url) {
      value = safeUrl(value, rule.url);
      if (value === null) continue;
    } else if (!rule.check(value)) {
      continue;
    }
    seen.add(name);
    kept.push(` ${name}="${escapeHtml(value)}"`);
  }
  return kept.join('');
}

/**
 * Walks the input's tokens. `onText(decodedText)`, `onOpen(tag, attributeSource, selfClosing)`
 * and `onClose(tag)` receive only content outside dropped elements; comments and declarations
 * never reach them.
 */
function walk(input, { onText, onOpen, onClose }) {
  const source = String(input);
  let index = 0;
  let skipping = null;
  while (index < source.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(source);
    if (!match) break;
    const token = match[0];
    index = TOKEN.lastIndex;
    if (token.startsWith('<!') || token.startsWith('<?')) continue;
    const tag = token.length > 1 ? TAG.exec(token) : null;
    if (!tag) {
      if (!skipping) onText(decodeHtmlEntities(token));
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (skipping) {
      if (name === skipping.name) skipping.depth += closing ? -1 : 1;
      if (skipping.depth === 0) skipping = null;
      continue;
    }
    if (!closing && DROP_WITH_CONTENT_TAGS.has(name)) {
      if (RAW_TEXT_TAGS.has(name)) {
        // Raw text ends at the first matching close tag; without one, the rest is dropped.
        const end = source.toLowerCase().indexOf(`</${name}`, index);
        if (end < 0) return;
        const close = source.indexOf('>', end);
        if (close < 0) return;
        index = close + 1;
      } else {
        skipping = { name, depth: 1 };
      }
      continue;
    }
    if (closing) onClose(name);
    else onOpen(name, tag[3], /\/\s*$/.test(tag[3]));
  }
}

/**
 * Returns `{ html, code }`: the sanitized HTML, and `gmail_signature_too_large` (with empty html)
 * when the input is over the size cap. Empty or non-string input sanitizes to ''.
 */
export function sanitizeEmailSignatureHtml(input) {
  if (typeof input !== 'string' || input === '') return { html: '', code: null };
  if (input.length > EMAIL_SIGNATURE_MAX_INPUT_CHARS) return { html: '', code: EMAIL_SIGNATURE_TOO_LARGE };
  const output = [];
  const open = [];
  walk(input, {
    onText(text) {
      output.push(escapeHtml(text.replace(CONTROL, '')));
    },
    onOpen(tag, attributes, selfClosing) {
      if (!ALLOWED_TAGS.has(tag)) return;
      output.push(`<${tag}${sanitizeAttributes(tag, attributes)}>`);
      if (VOID_TAGS.has(tag)) return;
      if (selfClosing) output.push(`</${tag}>`);
      else open.push(tag);
    },
    onClose(tag) {
      const position = open.lastIndexOf(tag);
      if (position < 0) return;
      while (open.length > position) output.push(`</${open.pop()}>`);
    },
  });
  while (open.length) output.push(`</${open.pop()}>`);
  return { html: output.join(''), code: null };
}

const LINE_BLOCK_TAGS = new Set(['div', 'p', 'table', 'tbody', 'thead', 'tr', 'hr']);
const CELL_TAGS = new Set(['td', 'th']);

function comparableUrl(value) {
  return String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Readable plain text for a signature: block elements and <br> become line breaks, table cells
 * are separated by a space, a link becomes its text (plus ` <href>` when the text is not the
 * URL itself and the link is not mailto:/tel:), images are dropped, entities are decoded,
 * whitespace is collapsed, and runs of blank lines become one.
 */
export function signatureHtmlToText(html) {
  const { html: safe } = sanitizeEmailSignatureHtml(html);
  const parts = [];
  const links = [];
  let lastChar = '';
  const append = (value) => {
    if (value === '') return;
    if (links.length) links[links.length - 1].text += value;
    else parts.push(value);
    lastChar = value.at(-1);
  };
  const lineBreak = () => {
    if (lastChar !== '' && lastChar !== '\n') append('\n');
  };
  walk(safe, {
    onText(text) {
      append(text.replace(/[\s\u00a0]+/g, ' '));
    },
    onOpen(tag, attributes) {
      if (tag === 'br') append('\n');
      else if (LINE_BLOCK_TAGS.has(tag)) lineBreak();
      else if (CELL_TAGS.has(tag)) append(' ');
      else if (tag === 'a') {
        const href = /\shref="([^"]*)"/.exec(attributes)?.[1];
        links.push({ href: href === undefined ? '' : decodeHtmlEntities(href), text: '' });
      }
    },
    onClose(tag) {
      if (LINE_BLOCK_TAGS.has(tag)) lineBreak();
      else if (CELL_TAGS.has(tag)) append(' ');
      else if (tag === 'a' && links.length) {
        const { href, text } = links.pop();
        const label = text.trim();
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
        const showHref = href && scheme !== 'mailto' && scheme !== 'tel'
          && comparableUrl(label) !== comparableUrl(href);
        append(showHref ? (label ? `${text} <${href}>` : href) : text);
      }
    },
  });
  while (links.length) append(links.pop().text);
  return parts.join('')
    .split('\n')
    .map((line) => line.replace(/ +/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** True when the sanitized signature shows something: visible text or an image. */
export function signatureHasContent(html) {
  if (typeof html !== 'string' || html === '') return false;
  return signatureHtmlToText(html) !== '' || /<img\b/i.test(sanitizeEmailSignatureHtml(html).html);
}
