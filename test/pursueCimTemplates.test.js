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
// with the sample deal and the test sender filled in. A business name that already ends in a
// period is not followed by the template's own period ("Co." once, never "Co..").
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
Pat Example
Founder, Uckele Group
555-0100

If you would rather I not reach out about future listings, just reply "stop".
1 Example Way, Portland, OR 97201`;

const FOLLOW_UP_FIXTURES = {
  A: 'Bumping this up. Still interested in Sample Plumbing Co., and happy to sign the NDA today.',
  B: 'Any update on Sample Plumbing Co.? My funding is in place, so I can give you a quick read once I see the CIM.',
  C: "If Sample Plumbing Co. is under LOI or the timing is off, just let me know and I'll stop following up.",
  D: 'If someone else handles buyer inquiries for Sample Plumbing Co., could you point me their way?',
  Final: "Last note from me on Sample Plumbing Co. If it comes back to market, I'd still like a look.",
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
  assert.equal(email.templateVersion, 'pursue-cim-initial-v3');
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
    assert.equal(email.templateVersion, 'pursue-cim-follow-up-v2');
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

test('a business name ending in a period keeps one period before the template period, and the digest is unchanged', () => {
  // The digest of the current wording for this sender. It changes only when the wording does.
  assert.equal(pursueCimWordingDigest(sender),
    '9a9e057ebf8aef973f69c69a06aada181a0a930f2b0e74568b3c6f57c31b0f08');
  const emails = [renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, sender }),
    ...[1, 2, 3, 4].map((followUpNumber) => renderPursueCimEmail({ kind: 'follow-up', followUpNumber,
      deal: sampleDeal, sender })),
    renderPursueCimEmail({ kind: 'follow-up', followUpNumber: 5, isFinal: true, deal: sampleDeal, sender })];
  for (const email of emails) {
    assert.doesNotMatch(email.text, /Co\.\./, email.variant);
    assert.doesNotMatch(email.html, /Co\.\./, email.variant);
    assert.match(email.text, /Sample Plumbing Co\.(?!\.)/, email.variant);
  }
  assert.equal(emails[0].subject, 'CIM / NDA request for Sample Plumbing Co.');
  for (const item of renderPursueCimWordingPreview(sender)) assert.doesNotMatch(item.text, /Co\.\./);

  // Only one period is dropped, and only before the template's period.
  const plain = renderPursueCimEmail({ kind: 'initial', deal: { name: 'Acme Plumbing', brokerName: 'Sam' }, sender });
  assert.match(plain.text, /regarding Acme Plumbing\. Based on/);
  const dots = renderPursueCimEmail({ kind: 'follow-up', followUpNumber: 5, isFinal: true,
    deal: { name: 'Acme Inc...', brokerName: 'Sam' }, sender });
  assert.match(dots.text, /on Acme Inc\.\.\. If it comes back to market/);
  assert.equal(pursueCimWordingDigest(sender),
    '9a9e057ebf8aef973f69c69a06aada181a0a930f2b0e74568b3c6f57c31b0f08');
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
  assert.equal(paragraphs.length, 9);
  assert.equal(paragraphs[0], '<p>Hi Jordan,</p>');
  // A labeled section keeps its label on its own line.
  assert.match(paragraphs[2], /^<p>Acquisition focus:<br>I&#39;m actively pursuing/);
  assert.match(paragraphs[5], /^<p>Ability to close:<br>I&#39;m aligned with an SBA 7\(a\) lender/);
  assert.equal(paragraphs[7], '<p>Best,<br>Pat Example<br>Founder, Uckele Group<br>555-0100</p>');
  assert.equal(
    paragraphs[8],
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
  assert.ok(preview[5].text.includes('Last note from me on Sample Plumbing Co. If it comes back'));
  for (const entry of preview) assert.deepEqual(Object.keys(entry).sort(), ['subject', 'text', 'variant']);
});

test('rendering with an incomplete signature renders blanks instead of throwing', () => {
  const email = renderPursueCimEmail({ kind: 'initial', deal: sampleDeal, sender: {} });
  assert.ok(email.text.includes('Best,\n\n, Uckele Group\n'));
});

test('unknown kinds are rejected', () => {
  assert.throws(() => renderPursueCimEmail({ kind: 'nope', deal: sampleDeal, sender }), /kind/);
});
