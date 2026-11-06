import { createHash } from 'node:crypto';

// Pursue CIM email copy: the owner-approved wording from
// docs/superpowers/specs/2026-11-03-gmail-send-runners-design.md section 8.2.
// Changing any template string, version, or sender signature field changes the wording
// digest, which pauses sending until the owner approves the wording again.

export const PURSUE_CIM_INITIAL_TEMPLATE_VERSION = 'pursue-cim-initial-v2';
export const PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION = 'pursue-cim-follow-up-v2';

const GREETING_TEMPLATE = 'Hi {firstName},';
const GREETING_FALLBACK = 'Hi there,';
const INITIAL_SUBJECT_TEMPLATE = 'CIM / NDA request for {business}';
const FOLLOW_UP_SUBJECT_PREFIX = 'Re: ';

const INITIAL_PARAGRAPHS = [
  "I'd like to evaluate {business}. Happy to sign your NDA. Could you send it over along with the CIM?",
  "What I'm buying: cash-flowing service businesses with $600K-$2M in SDE/EBITDA, recurring or repeat demand, and an established team. I'm based in Southern California and open to strong opportunities nationwide.",
  "How I operate: as an active owner. I step in to learn the business and earn the trust of the team and customers, then build the systems and leadership so it runs well for the long term.",
  "Background: I co-founded and run Golden Behavior Connection, an ABA therapy company I've built since 2023, overseeing operations, staffing, compliance, revenue cycle, and financial performance. Before that I worked at Tripadvisor, Better Mortgage, and Wayfair.",
  "Ability to close: I'm aligned with an SBA 7(a) lender, have my equity ready, and can submit an LOI quickly once I've reviewed the financials. Proof of funds is available on request.",
];

const FOLLOW_UP_PARAGRAPHS = {
  A: 'Bumping this up. Still interested in {business}, and happy to sign the NDA today.',
  B: "Any update on {business}? My funding is in place, so I can give you a quick read once I see the CIM.",
  C: "If {business} is under LOI or the timing is off, just let me know and I'll stop following up.",
  D: 'If someone else handles buyer inquiries for {business}, could you point me their way?',
  Final: "Last note from me on {business}. If it comes back to market, I'd still like a look.",
};

const ROTATING_VARIANTS = ['A', 'B', 'C', 'D'];

const SIGNATURE_LINES = ['Best,', '{name}', '{title}, Uckele Group', '{phone}'];
const FOOTER_LINES = ['If you would rather I not reach out about future listings, just reply "stop".', '{postal}'];

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

export function senderSignatureComplete(sender) {
  return ['name', 'title', 'phone', 'postalAddress']
    .every((field) => oneLine(sender?.[field]) !== '');
}

function signatureValues(sender) {
  return {
    name: oneLine(sender?.name),
    title: oneLine(sender?.title),
    phone: oneLine(sender?.phone),
    postal: oneLine(sender?.postalAddress),
  };
}

export function renderPursueCimEmail({
  kind,
  followUpNumber,
  isFinal = false,
  deal = {},
  sender = {},
  initialSubject,
} = {}) {
  if (kind !== 'initial' && kind !== 'follow-up') {
    throw new TypeError('kind must be "initial" or "follow-up".');
  }
  const business = oneLine(deal?.name) || 'the listed business';
  const values = { business, ...signatureValues(sender) };
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

  // Each block is a paragraph; a block with several lines (signature, footer) breaks between lines.
  const blocks = [
    [greeting.template],
    ...bodyParagraphs.map((paragraph) => [paragraph]),
    SIGNATURE_LINES,
    FOOTER_LINES,
  ];
  const render = (escape, lineBreak) => blocks.map((lines) => lines
    .map((line) => fill(line, { ...values, ...greeting.values }, escape))
    .join(lineBreak));

  const text = render((value) => value, '\n').join('\n\n');
  const html = render(escapeHtml, '<br>').map((block) => `<p>${block}</p>`).join('\n');
  return { subject, text, html, templateVersion, variant };
}

export function pursueCimWordingDigest(sender) {
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
      signatureLines: SIGNATURE_LINES,
      footerLines: FOOTER_LINES,
    },
    sender: {
      name: oneLine(sender?.name),
      title: oneLine(sender?.title),
      phone: oneLine(sender?.phone),
      postalAddress: oneLine(sender?.postalAddress),
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// Every template rendered for the sample deal, for the owner's approval card.
export function renderPursueCimWordingPreview(sender) {
  const initial = renderPursueCimEmail({ kind: 'initial', deal: SAMPLE_DEAL, sender });
  const followUps = [
    { followUpNumber: 1, isFinal: false },
    { followUpNumber: 2, isFinal: false },
    { followUpNumber: 3, isFinal: false },
    { followUpNumber: 4, isFinal: false },
    { followUpNumber: 5, isFinal: true },
  ].map((options) => renderPursueCimEmail({
    kind: 'follow-up', ...options, deal: SAMPLE_DEAL, sender, initialSubject: initial.subject,
  }));
  return [initial, ...followUps].map(({ variant, subject, text }) => ({ variant, subject, text }));
}
