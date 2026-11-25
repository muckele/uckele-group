import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION,
  PURSUE_CIM_INITIAL_TEMPLATE_VERSION,
  pursueCimFollowUpVariant,
  pursueCimWordingDigest,
  renderPursueCimEmail,
  pursueCimWordingTagValue,
  pursueSignatureComplete,
  renderPursueCimWordingPreview,
} from '../server/services/pursueCimTemplates.js';
import { sanitizeEmailSignatureHtml, signatureHtmlToText } from '../server/services/emailSignatureHtml.js';
import { sha256 } from '../server/utils/security.js';
import { GMAIL_SIGNATURE_FIXTURE_HTML, GMAIL_SIGNATURE_FIXTURE_TEXT } from './fixtures/gmailSignatureFixture.js';

const sender = { name: 'Pat Example' };
const signatureHtml = sanitizeEmailSignatureHtml(GMAIL_SIGNATURE_FIXTURE_HTML).html;
// The stored snapshot shape: sanitized HTML, its text, and its digest.
const signature = { html: signatureHtml, text: signatureHtmlToText(signatureHtml), digest: sha256(signatureHtml) };
const sampleDeal = { name: 'Sample Plumbing Co.', brokerName: 'Jordan Lee' };
const PINNED_DIGEST = 'eb51f4a8269a6b363bc29f4011285b9397f72628138b5c463af300ae202a0804';

// Copied from docs/superpowers/specs/2026-11-03-gmail-send-runners-design.md section 8.2,
// with the sample deal and the test Gmail signature filled in. A business name that already
// ends in a period is not followed by the template's own period ("Co." once, never "Co..").
// There is no footer: the email ends with "Best," and the owner's Gmail signature.
const INITIAL_FIXTURE = `Hi Jordan,

I'm reaching out regarding Sample Plumbing Co. Based on what I've seen so far, it looks like a business I'd like to evaluate further.

Acquisition focus:
I'm actively pursuing the acquisition of a cash-flowing service business in the $350K-$1.25M SDE/EBITDA range. I'm most interested in businesses with recurring or repeat demand, established teams, and opportunities to professionalize operations. I'm based in Southern California and open to strong opportunities nationwide.

Operating approach:
I acquire with the intent to be an active owner. I step in initially to learn the business, stabilize operations, and build trust with the team and customers. As the business grows, I focus on strengthening systems, leadership, and accountability, with the goal of building a durable management structure over time.

Background:
I'm the co-founder and President of Golden Behavior Connection, an ABA therapy company launched in 2023. I've built the business from the ground up, overseeing day-to-day operations, staffing, compliance, revenue cycle management, and financial performance. In parallel, my prior roles at Tripadvisor, Better Mortgage, and Wayfair sharpened my discipline around sales execution, process improvement, and operating with clear metrics.

Ability to close:
I'm aligned with an SBA 7(a) lender, have the required equity prepared, and am positioned to submit an LOI quickly once financials are reviewed. Proof of funds and lender information are available upon request.

If this sounds aligned, I'd welcome the opportunity to review the CIM and discuss next steps.

Best,
${GMAIL_SIGNATURE_FIXTURE_TEXT}`;

const FOLLOW_UP_FIXTURES = {
  A: 'Bumping this up. Still interested in Sample Plumbing Co., and happy to sign the NDA today.',
  B: 'Any update on Sample Plumbing Co.? My funding is in place, so I can give you a quick read once I see the CIM.',
  C: "If Sample Plumbing Co. is under LOI or the timing is off, just let me know and I'll stop following up.",
  D: 'If someone else handles buyer inquiries for Sample Plumbing Co., could you point me their way?',
  Final: "Last note from me on Sample Plumbing Co. If it comes back to market, I'd still like a look.",
};

const SIGN_OFF_AND_SIGNATURE = `Best,\n${GMAIL_SIGNATURE_FIXTURE_TEXT}`;

function assertNoFooter(email, label) {
  for (const body of [email.text, email.html]) {
    assert.doesNotMatch(body, /reply (?:"|&quot;)stop/i, label);
    assert.doesNotMatch(body, /reach out about future listings/, label);
    assert.doesNotMatch(body, /Example Way|Portland|97201/, label);
    assert.doesNotMatch(body, /Uckele Group/, label);
  }
}

test('initial text equals the spec draft for the sample deal', () => {
  const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, signature });
  assert.equal(email.subject, 'CIM / NDA request for Sample Plumbing Co.');
  assert.equal(email.text, INITIAL_FIXTURE);
  assert.ok(email.text.endsWith(SIGN_OFF_AND_SIGNATURE));
  assert.ok(email.html.endsWith(`<p>Best,</p>\n<div>${signatureHtml}</div>`));
  assertNoFooter(email, 'initial');
  assert.equal(email.templateVersion, 'pursue-cim-initial-v4');
  assert.equal(email.templateVersion, PURSUE_CIM_INITIAL_TEMPLATE_VERSION);
  assert.equal(email.variant, 'initial');
});

test('every follow-up variant equals the spec draft and ends with Best, and the Gmail signature', () => {
  const cases = [
    { followUpNumber: 1, isFinal: false, variant: 'A' },
    { followUpNumber: 2, isFinal: false, variant: 'B' },
    { followUpNumber: 3, isFinal: false, variant: 'C' },
    { followUpNumber: 4, isFinal: false, variant: 'D' },
    { followUpNumber: 5, isFinal: true, variant: 'Final' },
  ];
  for (const { followUpNumber, isFinal, variant } of cases) {
    const email = renderPursueCimEmail({
      kind: 'follow-up', followUpNumber, isFinal, deal: sampleDeal, signature,
    });
    assert.equal(email.text, `Hi Jordan,\n\n${FOLLOW_UP_FIXTURES[variant]}\n\n${SIGN_OFF_AND_SIGNATURE}`, variant);
    assert.equal(email.html, `<p>Hi Jordan,</p>\n<p>${FOLLOW_UP_FIXTURES[variant].replaceAll("'", '&#39;')}</p>`
      + `\n<p>Best,</p>\n<div>${signatureHtml}</div>`, variant);
    assertNoFooter(email, variant);
    assert.equal(email.variant, variant);
    assert.equal(email.templateVersion, 'pursue-cim-follow-up-v3');
    assert.equal(email.templateVersion, PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION);
  }
});

test('variants rotate A,B,C,D,A for numbers 1-5 and Final overrides', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 8, 9].map((number) => pursueCimFollowUpVariant(number, false)),
    ['A', 'B', 'C', 'D', 'A', 'B', 'D', 'A'],
  );
  assert.equal(pursueCimFollowUpVariant(1, true), 'Final');
  assert.equal(pursueCimFollowUpVariant(7, true), 'Final');
  assert.throws(() => pursueCimFollowUpVariant(0, false), /followUpNumber/);
  assert.throws(() => pursueCimFollowUpVariant(1.5, false), /followUpNumber/);
});

test('follow-up subject is Re: + initial subject', () => {
  const derived = renderPursueCimEmail({
    kind: 'follow-up', followUpNumber: 1, deal: sampleDeal, signature,
  });
  assert.equal(derived.subject, 'Re: CIM / NDA request for Sample Plumbing Co.');
  const explicit = renderPursueCimEmail({
    kind: 'follow-up', followUpNumber: 2, deal: sampleDeal, signature, initialSubject: 'CIM / NDA request for Old Name',
  });
  assert.equal(explicit.subject, 'Re: CIM / NDA request for Old Name');
  const alreadyPrefixed = renderPursueCimEmail({
    kind: 'follow-up', followUpNumber: 2, deal: sampleDeal, signature, initialSubject: 'Re: CIM / NDA request for Old Name',
  });
  assert.equal(alreadyPrefixed.subject, 'Re: CIM / NDA request for Old Name');
});

test('greeting falls back to Hi there, when brokerName is blank', () => {
  for (const brokerName of ['', '   ', undefined, null]) {
    const email = renderPursueCimEmail({ kind: 'initial', deal: { name: 'Acme', brokerName }, signature });
    assert.ok(email.text.startsWith('Hi there,\n\n'), String(brokerName));
    assert.ok(email.html.startsWith('<p>Hi there,</p>'), String(brokerName));
  }
  const spaced = renderPursueCimEmail({ kind: 'initial', deal: { name: 'Acme', brokerName: '  Jordan   Lee ' }, signature });
  assert.ok(spaced.text.startsWith('Hi Jordan,\n\n'));
});

test('digest changes with the sender name or the signature digest, and not with the deal', () => {
  const base = pursueCimWordingDigest(sender, signature);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(pursueCimWordingDigest({ ...sender }, { ...signature }), base);
  assert.notEqual(pursueCimWordingDigest({ name: 'Pat Example x' }, signature), base, 'name');
  assert.notEqual(pursueCimWordingDigest(sender, { ...signature, digest: sha256('<b>new</b>') }), base,
    'signature digest');
  assert.notEqual(pursueCimWordingDigest(sender, null), base, 'no signature');
  // Title, phone and postal address are no longer part of the wording.
  assert.equal(pursueCimWordingDigest({ ...sender, title: 'Founder', phone: '555-0100',
    postalAddress: '1 Example Way' }, signature), base);
  // Per-deal values never enter the digest, so two deals share it by construction.
  const previewA = renderPursueCimWordingPreview(signature);
  const previewB = renderPursueCimWordingPreview(signature);
  assert.deepEqual(previewA, previewB);
  assert.equal(pursueCimWordingDigest(sender, signature), base);
  // Rendering other deals does not alter it either.
  renderPursueCimEmail({ kind: 'initial', deal: { name: 'Other Co', brokerName: 'Sam' }, signature });
  assert.equal(pursueCimWordingDigest(sender, signature), base);
});

test('a business name ending in a period keeps one period before the template period, and the digest is unchanged', () => {
  // The digest of the current wording for this sender and signature. It changes only when the
  // wording does.
  assert.equal(pursueCimWordingDigest(sender, signature), PINNED_DIGEST);
  const emails = [renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, signature }),
    ...[1, 2, 3, 4].map((followUpNumber) => renderPursueCimEmail({ kind: 'follow-up', followUpNumber,
      deal: sampleDeal, signature })),
    renderPursueCimEmail({ kind: 'follow-up', followUpNumber: 5, isFinal: true, deal: sampleDeal, signature })];
  for (const email of emails) {
    assert.doesNotMatch(email.text, /Co\.\./, email.variant);
    assert.doesNotMatch(email.html, /Co\.\./, email.variant);
    assert.match(email.text, /Sample Plumbing Co\.(?!\.)/, email.variant);
  }
  assert.equal(emails[0].subject, 'CIM / NDA request for Sample Plumbing Co.');
  for (const item of renderPursueCimWordingPreview(signature)) assert.doesNotMatch(item.text, /Co\.\./);

  // Only one period is dropped, and only before the template's period.
  const plain = renderPursueCimEmail({ kind: 'initial', deal: { name: 'Acme Plumbing', brokerName: 'Sam' }, signature });
  assert.match(plain.text, /regarding Acme Plumbing\. Based on/);
  const dots = renderPursueCimEmail({ kind: 'follow-up', followUpNumber: 5, isFinal: true,
    deal: { name: 'Acme Inc...', brokerName: 'Sam' }, signature });
  assert.match(dots.text, /on Acme Inc\.\.\. If it comes back to market/);
  assert.equal(pursueCimWordingDigest(sender, signature), PINNED_DIGEST);
});

test('pursueSignatureComplete needs the sender name and a non-empty Gmail signature', () => {
  assert.equal(pursueSignatureComplete(sender, signature), true);
  for (const name of ['', '  ', undefined]) {
    assert.equal(pursueSignatureComplete({ name }, signature), false, String(name));
  }
  for (const missing of [null, undefined, {}, { html: '' }, { html: '<div><br></div>&nbsp;' }]) {
    assert.equal(pursueSignatureComplete(sender, missing), false, JSON.stringify(missing));
  }
  // The plain-text part must be signed too: an image needs alt text to count.
  assert.equal(pursueSignatureComplete(sender, { html: '<img src="https://x.example/logo.png">', text: '' }), false);
  assert.equal(pursueSignatureComplete(sender,
    { html: '<img src="https://x.example/logo.png" alt="Pat Example">', text: 'Pat Example' }), true);
  // Title, phone and postal address are not needed.
  assert.equal(pursueSignatureComplete({ name: 'Pat Example', title: '', phone: '', postalAddress: '' }, signature),
    true);
  assert.equal(pursueSignatureComplete(null, signature), false);
});

test('html escapes business names, and inserts the sanitized signature unescaped', () => {
  const email = renderPursueCimEmail({
    kind: 'initial',
    deal: { name: 'Smith & <b>Sons</b> "Plumbing"', brokerName: '<i>Jo</i>' },
    signature,
  });
  assert.ok(!email.html.includes('<b>Sons'));
  assert.ok(!email.html.includes('<i>Jo'));
  assert.ok(email.html.includes('Smith &amp; &lt;b&gt;Sons&lt;/b&gt; &quot;Plumbing&quot;'));
  assert.ok(email.html.includes('Hi &lt;i&gt;Jo&lt;/i&gt;,'));
  assert.ok(email.html.includes('<b><font color="#1a1a1a" size="4">Pat Example</font></b>'));
  assert.ok(email.html.includes('<a href="mailto:pat@example.com">pat@example.com</a>'));
  // Plain text is not escaped.
  assert.ok(email.text.includes('Smith & <b>Sons</b> "Plumbing"'));
});

test('html mirrors the text: paragraphs in <p>, Best, then the signature in a <div>', () => {
  const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, signature });
  const paragraphs = email.html.match(/<p>[\s\S]*?<\/p>/g);
  assert.equal(paragraphs.length, 8);
  assert.equal(paragraphs[0], '<p>Hi Jordan,</p>');
  // A labeled section keeps its label on its own line.
  assert.match(paragraphs[2], /^<p>Acquisition focus:<br>I&#39;m actively pursuing/);
  assert.match(paragraphs[5], /^<p>Ability to close:<br>I&#39;m aligned with an SBA 7\(a\) lender/);
  assert.equal(paragraphs[7], '<p>Best,</p>');
  assert.ok(email.html.endsWith(`<p>Best,</p>\n<div>${signatureHtml}</div>`));
});

test('subject strips line breaks so a business name cannot inject headers', () => {
  const email = renderPursueCimEmail({
    kind: 'initial', deal: { name: 'Evil\r\nBcc: x@example.com', brokerName: '' }, signature,
  });
  assert.equal(email.subject, 'CIM / NDA request for Evil Bcc: x@example.com');
  assert.ok(!/[\r\n]/.test(email.subject));
});

test('wording preview renders every variant for the sample deal, text and html', () => {
  const preview = renderPursueCimWordingPreview(signature);
  assert.deepEqual(preview.map((entry) => entry.variant), ['initial', 'A', 'B', 'C', 'D', 'Final']);
  assert.equal(preview[0].subject, 'CIM / NDA request for Sample Plumbing Co.');
  assert.equal(preview[0].text, INITIAL_FIXTURE);
  assert.equal(preview[1].subject, 'Re: CIM / NDA request for Sample Plumbing Co.');
  assert.ok(preview[5].text.includes('Last note from me on Sample Plumbing Co. If it comes back'));
  for (const entry of preview) {
    assert.deepEqual(Object.keys(entry).sort(), ['html', 'subject', 'text', 'variant']);
    assert.ok(entry.html.endsWith(`<p>Best,</p>\n<div>${signatureHtml}</div>`), entry.variant);
  }
});

test('without a signature the email ends with Best, alone (previews only; sending is refused)', () => {
  for (const missing of [null, undefined, { html: '', text: '' }]) {
    const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, signature: missing });
    assert.ok(email.text.endsWith('next steps.\n\nBest,'));
    assert.ok(email.html.endsWith('<p>Best,</p>'));
    assertNoFooter(email, 'unsigned');
  }
});

test('unknown kinds are rejected', () => {
  assert.throws(() => renderPursueCimEmail({ kind: 'nope', deal: sampleDeal, signature }), /kind/);
});

test('the wording tag value is read only from exactly one well-formed cim_wording tag', () => {
  const value = 'a'.repeat(64);
  assert.equal(pursueCimWordingTagValue(['cim_touch_id=t', `cim_wording=${value}`]), value);
  for (const tags of [
    [], undefined, null, 'cim_wording=' + value, ['cim_touch_id=t'],
    [`cim_wording=${value}`, `cim_wording=${value}`],
    [`cim_wording=${value}`, `cim_wording=${'b'.repeat(64)}`],
    [`cim_wording=${'g'.repeat(64)}`], [`cim_wording=${'A'.repeat(64)}`],
    [`cim_wording=${'a'.repeat(63)}`], [`cim_wording=${'a'.repeat(65)}`], ['cim_wording='],
    [`cim_wording_x=${value}`], [{ name: 'cim_wording', value }],
  ]) {
    assert.equal(pursueCimWordingTagValue(tags), null, JSON.stringify(tags));
  }
});
