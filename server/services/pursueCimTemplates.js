import { createHash } from 'node:crypto';

// Pursue CIM email copy: the owner-approved wording from
// docs/superpowers/specs/2026-11-03-gmail-send-runners-design.md section 8.2.
// Changing any template string, version, or sender signature field changes the wording
// digest, which pauses sending until the owner approves the wording again.

export const PURSUE_CIM_INITIAL_TEMPLATE_VERSION = 'pursue-cim-initial-v1';
export const PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION = 'pursue-cim-follow-up-v1';

const GREETING_TEMPLATE = 'Hi {firstName},';
const GREETING_FALLBACK = 'Hi there,';
const INITIAL_SUBJECT_TEMPLATE = 'CIM / NDA request for {business}';
const FOLLOW_UP_SUBJECT_PREFIX = 'Re: ';

const INITIAL_PARAGRAPHS = [
  'I am reaching out regarding {business}. Based on the information available, it looks like the type of durable service business I would like to evaluate further.',
  'By way of background, I am an operator and small business buyer focused on acquiring a cash-flowing service business with repeat or recurring demand, a strong local reputation, and a transition path where the team and customers are protected.',
  'I am currently the co-founder and President of Golden Behavior Connection, an ABA therapy company I helped build from the ground up. My day-to-day work includes operations, staffing, compliance, revenue cycle management, sales execution, and financial performance. Earlier in my career, I held operating and sales roles at Tripadvisor, Better Mortgage, and Wayfair.',
  'I am prepared to move quickly if the opportunity is a fit. I have acquisition equity available, am working with SBA financing, and can provide proof of funds or lender context upon request.',
  'Could you please send over the CIM or teaser, or let me know the NDA process? If there is a specific process you prefer buyers to follow, I am happy to follow it. I will treat all materials confidentially.',
];

const FOLLOW_UP_PARAGRAPHS = {
  A: 'I wanted to follow up on my note below about {business}. If it is still available, I would appreciate the CIM or teaser, or the next step in your NDA process.',
  B: 'Checking in on {business}. I am an active buyer with SBA financing lined up and can review materials quickly. If an NDA is the first step, I am happy to sign it.',
  C: 'Following up on {business}. If the timing is not right, or it is already under LOI, a quick note is completely fine and I will close the loop.',
  D: 'Circling back on {business}. If there is a better contact for buyer inquiries on this listing, I would be grateful if you could point me to them.',
  Final: 'This is my last note on {business}. If it is still available, I would welcome the CIM or the NDA process. If not, no reply is needed. Thank you for your time.',
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
function fill(template, values, escape) {
  return template
    .split(/(\{[A-Za-z]+\})/)
    .map((part) => {
      const match = /^\{([A-Za-z]+)\}$/.exec(part);
      return escape(match ? (values[match[1]] ?? '') : part);
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
