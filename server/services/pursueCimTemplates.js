import { createHash } from 'node:crypto';

import { signatureHasContent } from './emailSignatureHtml.js';

// Pursue CIM email copy: the owner-approved wording from
// docs/superpowers/specs/2026-11-03-gmail-send-runners-design.md section 8.2.
// Every email ends with "Best," and the owner's Gmail signature (section 8.1); there is no
// footer. Changing any template string or version, the sender name, or the stored signature
// changes the wording digest, which pauses sending until the owner approves the wording again.

export const PURSUE_CIM_INITIAL_TEMPLATE_VERSION = 'pursue-cim-initial-v4';
export const PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION = 'pursue-cim-follow-up-v3';
// The tag a prepared Pursue email carries with the wording digest it was rendered under. The
// sender sends a prepared email only while that digest is still the current one, so an email
// prepared before a signature or wording change is never sent with the old wording.
export const PURSUE_CIM_WORDING_TAG = 'cim_wording';

const GREETING_TEMPLATE = 'Hi {firstName},';
const GREETING_FALLBACK = 'Hi there,';
const INITIAL_SUBJECT_TEMPLATE = 'CIM / NDA request for {business}';
const FOLLOW_UP_SUBJECT_PREFIX = 'Re: ';

// A string is one paragraph. An array is one paragraph whose lines break, used for the owner's
// labeled sections ("Acquisition focus:" on its own line, then the section text).
const INITIAL_PARAGRAPHS = [
  "I'm reaching out regarding {business}. Based on what I've seen so far, it looks like a business I'd like to evaluate further.",
  [
    'Acquisition focus:',
    "I'm actively pursuing the acquisition of a cash-flowing service business in the $350K-$1.25M SDE/EBITDA range. I'm most interested in businesses with recurring or repeat demand, established teams, and opportunities to professionalize operations. I'm based in Southern California and open to strong opportunities nationwide.",
  ],
  [
    'Operating approach:',
    'I acquire with the intent to be an active owner. I step in initially to learn the business, stabilize operations, and build trust with the team and customers. As the business grows, I focus on strengthening systems, leadership, and accountability, with the goal of building a durable management structure over time.',
  ],
  [
    'Background:',
    "I'm the co-founder and President of Golden Behavior Connection, an ABA therapy company launched in 2023. I've built the business from the ground up, overseeing day-to-day operations, staffing, compliance, revenue cycle management, and financial performance. In parallel, my prior roles at Tripadvisor, Better Mortgage, and Wayfair sharpened my discipline around sales execution, process improvement, and operating with clear metrics.",
  ],
  [
    'Ability to close:',
    "I'm aligned with an SBA 7(a) lender, have the required equity prepared, and am positioned to submit an LOI quickly once financials are reviewed. Proof of funds and lender information are available upon request.",
  ],
  "If this sounds aligned, I'd welcome the opportunity to review the CIM and discuss next steps.",
];

const FOLLOW_UP_PARAGRAPHS = {
  A: 'Bumping this up. Still interested in {business}, and happy to sign the NDA today.',
  B: "Any update on {business}? My funding is in place, so I can give you a quick read once I see the CIM.",
  C: "If {business} is under LOI or the timing is off, just let me know and I'll stop following up.",
  D: 'If someone else handles buyer inquiries for {business}, could you point me their way?',
  Final: "Last note from me on {business}. If it comes back to market, I'd still like a look.",
};

const ROTATING_VARIANTS = ['A', 'B', 'C', 'D'];

const SIGN_OFF = 'Best,';

const SAMPLE_DEAL = Object.freeze({ name: 'Sample Plumbing Co.', brokerName: 'Jordan Lee' });

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Collapse every run of whitespace and control characters (including CR/LF) to one space.
function oneLine(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
}

// Replace {placeholders} in a template. Literal template text and values both pass through
// `escape`, so the HTML body never contains an unescaped interpolated value.
// Where the template puts a period right after {business}, one trailing period of the business
// name is dropped ("Sample Plumbing Co." + "." reads "Co." once). This is a rendering rule only:
// the template strings, and so the wording digest, do not change.
function fill(template, values, escape) {
  const parts = template.split(/(\{[A-Za-z]+\})/);
  return parts
    .map((part, index) => {
      const match = /^\{([A-Za-z]+)\}$/.exec(part);
      if (!match) return escape(part);
      let value = String(values[match[1]] ?? '');
      if (match[1] === 'business' && String(parts[index + 1] ?? '').startsWith('.') && value.endsWith('.')) {
        value = value.slice(0, -1);
      }
      return escape(value);
    })
    .join('');
}

function greetingFor(brokerName) {
  const firstName = oneLine(brokerName).split(' ')[0];
  return firstName ? { template: GREETING_TEMPLATE, values: { firstName } } : { template: GREETING_FALLBACK, values: {} };
}

function assertFollowUpNumber(followUpNumber) {
  if (!Number.isInteger(followUpNumber) || followUpNumber < 1) {
    throw new TypeError('followUpNumber must be a positive integer.');
  }
}

export function pursueCimFollowUpVariant(followUpNumber, isFinal = false) {
  assertFollowUpNumber(followUpNumber);
  if (isFinal) return 'Final';
  return ROTATING_VARIANTS[(followUpNumber - 1) % ROTATING_VARIANTS.length];
}

/** The signature's sanitized HTML and plain text, or null when there is none to show. */
function signatureBlock(signature) {
  const html = typeof signature?.html === 'string' ? signature.html : '';
  if (!signatureHasContent(html)) return null;
  return { html, text: typeof signature.text === 'string' ? signature.text.trim() : '' };
}

/**
 * True when a Pursue email can be signed: the sender name (the From display name) is set and
 * the Gmail signature snapshot has content. Title, phone and postal address are not used.
 */
export function pursueSignatureComplete(sender, signature) {
  return oneLine(sender?.name) !== '' && signatureBlock(signature) !== null;
}

/**
 * Renders one Pursue email. `signature` is the stored Gmail signature snapshot
 * (`{ html, text }`, html already sanitized by emailSignatureHtml.js). Without one the email
 * ends with "Best," alone: rendering stays deterministic for previews, and readiness
 * (signature_incomplete) and the preparation paths refuse to send such an email.
 */
export function renderPursueCimEmail({
  kind,
  followUpNumber,
  isFinal = false,
  deal = {},
  signature = null,
  initialSubject,
} = {}) {
  if (kind !== 'initial' && kind !== 'follow-up') {
    throw new TypeError('kind must be "initial" or "follow-up".');
  }
  const business = oneLine(deal?.name) || 'the listed business';
  const values = { business };
  const greeting = greetingFor(deal?.brokerName);

  let variant = 'initial';
  let templateVersion = PURSUE_CIM_INITIAL_TEMPLATE_VERSION;
  let bodyParagraphs = INITIAL_PARAGRAPHS;
  let subject = fill(INITIAL_SUBJECT_TEMPLATE, values, (value) => value);
  if (kind === 'follow-up') {
    variant = pursueCimFollowUpVariant(followUpNumber, isFinal);
    templateVersion = PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION;
    bodyParagraphs = [FOLLOW_UP_PARAGRAPHS[variant]];
    const base = oneLine(initialSubject) || subject;
    subject = base.startsWith(FOLLOW_UP_SUBJECT_PREFIX) ? base : `${FOLLOW_UP_SUBJECT_PREFIX}${base}`;
  }

  // Each block is a paragraph; a labeled block breaks between its lines.
  const blocks = [
    [greeting.template],
    ...bodyParagraphs.map((paragraph) => (Array.isArray(paragraph) ? paragraph : [paragraph])),
    [SIGN_OFF],
  ];
  const render = (escape, lineBreak) => blocks.map((lines) => lines
    .map((line) => fill(line, { ...values, ...greeting.values }, escape))
    .join(lineBreak));

  const signed = signatureBlock(signature);
  const textBlocks = render((value) => value, '\n');
  if (signed?.text) textBlocks[textBlocks.length - 1] += `\n${signed.text}`;
  const text = textBlocks.join('\n\n');
  // The signature HTML was sanitized when it was stored, so it is inserted as is; everything
  // else is escaped.
  const htmlBlocks = render(escapeHtml, '<br>').map((block) => `<p>${block}</p>`);
  if (signed) htmlBlocks.push(`<div>${signed.html}</div>`);
  const html = htmlBlocks.join('\n');
  return { subject, text, html, templateVersion, variant };
}

/**
 * The digest the owner approves: every template string and version, the sender name, and the
 * stored signature's digest. `signature` is the usable snapshot (`{ digest }`) or null.
 */
export function pursueCimWordingDigest(sender, signature = null) {
  const canonical = JSON.stringify({
    versions: {
      initial: PURSUE_CIM_INITIAL_TEMPLATE_VERSION,
      followUp: PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION,
    },
    templates: {
      greeting: GREETING_TEMPLATE,
      greetingFallback: GREETING_FALLBACK,
      initialSubject: INITIAL_SUBJECT_TEMPLATE,
      followUpSubjectPrefix: FOLLOW_UP_SUBJECT_PREFIX,
      initialParagraphs: INITIAL_PARAGRAPHS,
      followUpParagraphs: FOLLOW_UP_PARAGRAPHS,
      signOff: SIGN_OFF,
    },
    sender: { name: oneLine(sender?.name) },
    signatureDigest: typeof signature?.digest === 'string' && signature.digest ? signature.digest : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// Every template rendered for the sample deal, for the owner's approval card: the plain text
// and the HTML (which shows the Gmail signature as it will appear).
export function renderPursueCimWordingPreview(signature = null) {
  const initial = renderPursueCimEmail({ kind: 'initial', deal: SAMPLE_DEAL, signature });
  const followUps = [
    { followUpNumber: 1, isFinal: false },
    { followUpNumber: 2, isFinal: false },
    { followUpNumber: 3, isFinal: false },
    { followUpNumber: 4, isFinal: false },
    { followUpNumber: 5, isFinal: true },
  ].map((options) => renderPursueCimEmail({
    kind: 'follow-up', ...options, deal: SAMPLE_DEAL, signature, initialSubject: initial.subject,
  }));
  return [initial, ...followUps].map(({ variant, subject, text, html }) => ({ variant, subject, text, html }));
}

/** The wording digest a prepared email's tags carry, or null when it carries none. */
export function pursueCimWordingTagValue(tags) {
  const prefix = `${PURSUE_CIM_WORDING_TAG}=`;
  const values = (Array.isArray(tags) ? tags : [])
    .filter((tag) => typeof tag === 'string' && tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length));
  return values.length === 1 && /^[0-9a-f]{64}$/.test(values[0]) ? values[0] : null;
}
