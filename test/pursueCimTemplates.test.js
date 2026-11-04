import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PURSUE_CIM_FOLLOW_UP_TEMPLATE_VERSION,
  PURSUE_CIM_INITIAL_TEMPLATE_VERSION,
  pursueCimFollowUpVariant,
  pursueCimWordingDigest,
  renderPursueCimEmail,
  renderPursueCimWordingPreview,
  senderSignatureComplete,
} from '../server/services/pursueCimTemplates.js';

const sender = {
  name: 'Pat Example',
  title: 'Founder',
  phone: '555-0100',
  postalAddress: '1 Example Way, Portland, OR 97201',
};
const sampleDeal = { name: 'Sample Plumbing Co.', brokerName: 'Jordan Lee' };

// Copied from docs/superpowers/specs/2026-11-03-gmail-send-runners-design.md section 8.2,
// with the sample deal and the test sender filled in.
const INITIAL_FIXTURE = `Hi Jordan,

I am reaching out regarding Sample Plumbing Co.. Based on the information available, it looks like the type of durable service business I would like to evaluate further.

By way of background, I am an operator and small business buyer focused on acquiring a cash-flowing service business with repeat or recurring demand, a strong local reputation, and a transition path where the team and customers are protected.

I am currently the co-founder and President of Golden Behavior Connection, an ABA therapy company I helped build from the ground up. My day-to-day work includes operations, staffing, compliance, revenue cycle management, sales execution, and financial performance. Earlier in my career, I held operating and sales roles at Tripadvisor, Better Mortgage, and Wayfair.

I am prepared to move quickly if the opportunity is a fit. I have acquisition equity available, am working with SBA financing, and can provide proof of funds or lender context upon request.

Could you please send over the CIM or teaser, or let me know the NDA process? If there is a specific process you prefer buyers to follow, I am happy to follow it. I will treat all materials confidentially.

Best,
Pat Example
Founder, Uckele Group
555-0100

If you would rather I not reach out about future listings, just reply "stop".
1 Example Way, Portland, OR 97201`;

const FOLLOW_UP_FIXTURES = {
  A: 'I wanted to follow up on my note below about Sample Plumbing Co.. If it is still available, I would appreciate the CIM or teaser, or the next step in your NDA process.',
  B: 'Checking in on Sample Plumbing Co.. I am an active buyer with SBA financing lined up and can review materials quickly. If an NDA is the first step, I am happy to sign it.',
  C: 'Following up on Sample Plumbing Co.. If the timing is not right, or it is already under LOI, a quick note is completely fine and I will close the loop.',
  D: 'Circling back on Sample Plumbing Co.. If there is a better contact for buyer inquiries on this listing, I would be grateful if you could point me to them.',
  Final: 'This is my last note on Sample Plumbing Co.. If it is still available, I would welcome the CIM or the NDA process. If not, no reply is needed. Thank you for your time.',
};

const SIGNATURE_AND_FOOTER = `Best,
Pat Example
Founder, Uckele Group
555-0100

If you would rather I not reach out about future listings, just reply "stop".
1 Example Way, Portland, OR 97201`;

test('initial text equals the spec draft for the sample deal', () => {
  const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, sender });
  assert.equal(email.subject, 'CIM / NDA request for Sample Plumbing Co.');
  assert.equal(email.text, INITIAL_FIXTURE);
  assert.equal(email.templateVersion, 'pursue-cim-initial-v1');
  assert.equal(email.templateVersion, PURSUE_CIM_INITIAL_TEMPLATE_VERSION);
  assert.equal(email.variant, 'initial');
});

test('every follow-up variant equals the spec draft with the same signature and footer', () => {
  const cases = [
    { followUpNumber: 1, isFinal: false, variant: 'A' },
    { followUpNumber: 2, isFinal: false, variant: 'B' },
    { followUpNumber: 3, isFinal: false, variant: 'C' },
    { followUpNumber: 4, isFinal: false, variant: 'D' },
    { followUpNumber: 5, isFinal: true, variant: 'Final' },
  ];
  for (const { followUpNumber, isFinal, variant } of cases) {
    const email = renderPursueCimEmail({
      kind: 'follow-up', followUpNumber, isFinal, deal: sampleDeal, sender,
    });
    assert.equal(email.text, `Hi Jordan,\n\n${FOLLOW_UP_FIXTURES[variant]}\n\n${SIGNATURE_AND_FOOTER}`, variant);
    assert.equal(email.variant, variant);
    assert.equal(email.templateVersion, 'pursue-cim-follow-up-v1');
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
    kind: 'follow-up', followUpNumber: 1, deal: sampleDeal, sender,
  });
  assert.equal(derived.subject, 'Re: CIM / NDA request for Sample Plumbing Co.');
  const explicit = renderPursueCimEmail({
    kind: 'follow-up', followUpNumber: 2, deal: sampleDeal, sender, initialSubject: 'CIM / NDA request for Old Name',
  });
  assert.equal(explicit.subject, 'Re: CIM / NDA request for Old Name');
  const alreadyPrefixed = renderPursueCimEmail({
    kind: 'follow-up', followUpNumber: 2, deal: sampleDeal, sender, initialSubject: 'Re: CIM / NDA request for Old Name',
  });
  assert.equal(alreadyPrefixed.subject, 'Re: CIM / NDA request for Old Name');
});

test('greeting falls back to Hi there, when brokerName is blank', () => {
  for (const brokerName of ['', '   ', undefined, null]) {
    const email = renderPursueCimEmail({ kind: 'initial', deal: { name: 'Acme', brokerName }, sender });
    assert.ok(email.text.startsWith('Hi there,\n\n'), String(brokerName));
    assert.ok(email.html.startsWith('<p>Hi there,</p>'), String(brokerName));
  }
  const spaced = renderPursueCimEmail({ kind: 'initial', deal: { name: 'Acme', brokerName: '  Jordan   Lee ' }, sender });
  assert.ok(spaced.text.startsWith('Hi Jordan,\n\n'));
});

test('digest changes when any template or signature field changes and not when the deal changes', () => {
  const base = pursueCimWordingDigest(sender);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(pursueCimWordingDigest({ ...sender }), base);
  for (const field of ['name', 'title', 'phone', 'postalAddress']) {
    assert.notEqual(pursueCimWordingDigest({ ...sender, [field]: `${sender[field]} x` }), base, field);
  }
  // Per-deal values never enter the digest, so two deals share it by construction.
  const previewA = renderPursueCimWordingPreview(sender);
  const previewB = renderPursueCimWordingPreview(sender);
  assert.deepEqual(previewA, previewB);
  assert.equal(pursueCimWordingDigest(sender), base);
  // Rendering other deals does not alter it either.
  renderPursueCimEmail({ kind: 'initial', deal: { name: 'Other Co', brokerName: 'Sam' }, sender });
  assert.equal(pursueCimWordingDigest(sender), base);
});

test('senderSignatureComplete is false when name, title, phone, or postal is blank', () => {
  assert.equal(senderSignatureComplete(sender), true);
  for (const field of ['name', 'title', 'phone', 'postalAddress']) {
    assert.equal(senderSignatureComplete({ ...sender, [field]: '' }), false, field);
    assert.equal(senderSignatureComplete({ ...sender, [field]: '  ' }), false, field);
    assert.equal(senderSignatureComplete({ ...sender, [field]: undefined }), false, field);
  }
  assert.equal(senderSignatureComplete(null), false);
  assert.equal(senderSignatureComplete(undefined), false);
});

test('html escapes business names', () => {
  const email = renderPursueCimEmail({
    kind: 'initial',
    deal: { name: 'Smith & <b>Sons</b> "Plumbing"', brokerName: '<i>Jo</i>' },
    sender: { ...sender, name: 'Pat <script>' },
  });
  assert.ok(!email.html.includes('<b>'));
  assert.ok(!email.html.includes('<i>'));
  assert.ok(!email.html.includes('<script>'));
  assert.ok(email.html.includes('Smith &amp; &lt;b&gt;Sons&lt;/b&gt; &quot;Plumbing&quot;'));
  assert.ok(email.html.includes('Pat &lt;script&gt;'));
  assert.ok(email.html.includes('Hi &lt;i&gt;Jo&lt;/i&gt;,'));
  // Plain text is not escaped.
  assert.ok(email.text.includes('Smith & <b>Sons</b> "Plumbing"'));
});

test('html mirrors the text: paragraphs in <p>, signature and footer lines joined with <br>', () => {
  const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, sender });
  const paragraphs = email.html.match(/<p>[\s\S]*?<\/p>/g);
  assert.equal(paragraphs.length, 8);
  assert.equal(paragraphs[0], '<p>Hi Jordan,</p>');
  assert.equal(paragraphs[6], '<p>Best,<br>Pat Example<br>Founder, Uckele Group<br>555-0100</p>');
  assert.equal(
    paragraphs[7],
    '<p>If you would rather I not reach out about future listings, just reply &quot;stop&quot;.<br>1 Example Way, Portland, OR 97201</p>',
  );
});

test('subject strips line breaks so a business name cannot inject headers', () => {
  const email = renderPursueCimEmail({
    kind: 'initial', deal: { name: 'Evil\r\nBcc: x@example.com', brokerName: '' }, sender,
  });
  assert.equal(email.subject, 'CIM / NDA request for Evil Bcc: x@example.com');
  assert.ok(!/[\r\n]/.test(email.subject));
});

test('wording preview renders every variant for the sample deal', () => {
  const preview = renderPursueCimWordingPreview(sender);
  assert.deepEqual(preview.map((entry) => entry.variant), ['initial', 'A', 'B', 'C', 'D', 'Final']);
  assert.equal(preview[0].subject, 'CIM / NDA request for Sample Plumbing Co.');
  assert.equal(preview[0].text, INITIAL_FIXTURE);
  assert.equal(preview[1].subject, 'Re: CIM / NDA request for Sample Plumbing Co.');
  assert.ok(preview[5].text.includes('This is my last note on Sample Plumbing Co.'));
  for (const entry of preview) assert.deepEqual(Object.keys(entry).sort(), ['subject', 'text', 'variant']);
});

test('rendering with an incomplete signature renders blanks instead of throwing', () => {
  const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, sender: {} });
  assert.ok(email.text.includes('Best,\n\n, Uckele Group\n'));
});

test('unknown kinds are rejected', () => {
  assert.throws(() => renderPursueCimEmail({ kind: 'nope', deal: sampleDeal, sender }), /kind/);
});
