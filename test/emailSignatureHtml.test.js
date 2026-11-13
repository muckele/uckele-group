import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMAIL_SIGNATURE_MAX_CHARS,
  EMAIL_SIGNATURE_MAX_INPUT_CHARS,
  sanitizeEmailSignatureHtml,
  signatureHasContent,
  signatureHtmlToText,
  signatureIsImageOnly,
} from '../server/services/emailSignatureHtml.js';
import { GMAIL_SIGNATURE_FIXTURE_HTML, GMAIL_SIGNATURE_FIXTURE_TEXT } from './fixtures/gmailSignatureFixture.js';

const clean = (html) => sanitizeEmailSignatureHtml(html).html;

test('keeps a realistic Gmail signature: formatting, table layout, links and https images', () => {
  const { html, code } = sanitizeEmailSignatureHtml(GMAIL_SIGNATURE_FIXTURE_HTML);
  assert.equal(code, null);
  assert.ok(html.startsWith('<div dir="ltr"><table cellpadding="0" cellspacing="0" border="0" style="color:rgb(34,34,34);font-family:Arial,sans-serif"><tbody><tr>'));
  assert.ok(html.includes('<img src="https://ci3.googleusercontent.com/mail-sig/AIorK4example-logo" alt="Example Co. logo" width="96" height="96">'));
  assert.ok(html.includes('<div><b><font color="#1a1a1a" size="4">Pat Example</font></b></div>'));
  assert.ok(html.includes('<a href="mailto:pat@example.com">pat@example.com</a>'));
  assert.ok(html.includes('<a href="https://www.example.com/">www.example.com</a>'));
  assert.ok(html.includes('&nbsp;(555) 010-0000') || html.includes('\u00a0(555) 010-0000'));
  // Unknown attributes are dropped: classes, data-*, target, rel and event handlers.
  for (const dropped of ['class=', 'data-image', 'target=', 'rel=', 'onclick']) {
    assert.ok(!html.includes(dropped), dropped);
  }
  assert.ok(html.endsWith('</tr></tbody></table></div>'));
  // Sanitizing again changes nothing.
  assert.equal(clean(html), html);
});

test('drops script, style and embedded content with everything inside them', () => {
  const input = '<div>Hi<script>alert(1)</script><style>div{color:red}</style>'
    + '<iframe src="https://evil.example"><b>x</b></iframe><object data="x"><b>obj</b></object>'
    + '<svg onload="alert(1)"><g><text>svg text</text></g></svg><math><mi>m</mi></math>there</div>';
  assert.equal(clean(input), '<div>Hithere</div>');
  assert.equal(clean('<div>a<SCRIPT type="text/javascript">x = "</div>"</SCRIPT>b</div>'), '<div>ab</div>');
  // An unterminated script drops the rest of the input.
  assert.equal(clean('<div>a<script>alert(1)'), '<div>a</div>');
});

test('drops comments, doctype and processing instructions', () => {
  assert.equal(clean('<!-- hidden --><div>a<!--[if mso]><b>x</b><![endif]-->b</div><!DOCTYPE html><?xml x?>'),
    '<div>ab</div>');
  assert.equal(clean('<div>a<!-- never closed <script>alert(1)</script>'), '<div>a</div>');
});

test('drops event handlers and javascript: or data: URLs', () => {
  assert.equal(clean('<a href="javascript:alert(1)" onmouseover="x()">click</a>'), '<a>click</a>');
  assert.equal(clean('<a href="  JaVa\tScRiPt:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(clean('<a href="java&#115;cript&#58;alert(1)">x</a>'), '<a>x</a>');
  assert.equal(clean('<a href="vbscript:x">x</a>'), '<a>x</a>');
  assert.equal(clean('<a href="/relative">x</a>'), '<a>x</a>');
  assert.equal(clean('<img src="data:image/png;base64,AAAA" alt="x">'), '<img alt="x">');
  assert.equal(clean('<img src="http://insecure.example/logo.png">'), '<img>');
  assert.equal(clean('<img src="https://ok.example/logo.png" onerror="alert(1)">'),
    '<img src="https://ok.example/logo.png">');
  assert.equal(clean('<a href="tel:+15550100000">call</a>'), '<a href="tel:+15550100000">call</a>');
  assert.equal(clean('<a href="http://example.com">x</a>'), '<a href="http://example.com">x</a>');
});

test('drops dangerous style values and keeps safe ones', () => {
  for (const style of ['background:url(https://x)', 'width:expression(alert(1))', 'x:javascript:1',
    '@import "x"', 'behavior:url(x.htc)', 'color:red;</style>', 'color:\\72 ed', 'color:/*x*/red']) {
    assert.equal(clean(`<span style='${style}'>a</span>`), '<span>a</span>', style);
  }
  assert.equal(clean('<span style="color:#222;font-weight:bold">a</span>'),
    '<span style="color:#222;font-weight:bold">a</span>');
});

test('unknown tags keep their text but lose the tag; unknown block tags become line breaks', () => {
  assert.equal(clean('<section><h1>Title</h1><form action="x"><input value="v">Text</form></section>'),
    'Title<br>Text<br>');
  assert.equal(clean('<custom-tag foo="bar">kept</custom-tag>'), 'kept');
  assert.equal(clean('<h3>Pat Example</h3><h4>President</h4><center>Example LLC</center><pre>x</pre><address>1 Way</address>'),
    'Pat Example<br>President<br>Example LLC<br>x<br>1 Way<br>');
  // Idempotent.
  assert.equal(clean(clean('<h3>A</h3><h3>B</h3>')), 'A<br>B<br>');
});

test('lists and indents (Gmail editor markup) are kept, with style and dir only', () => {
  assert.equal(clean('<ul class="x" style="margin:0"><li dir="ltr" onclick="x()">Licensed in CA</li><li>Licensed in NV</li></ul>'),
    '<ul style="margin:0"><li dir="ltr">Licensed in CA</li><li>Licensed in NV</li></ul>');
  assert.equal(clean('<ol><li>One</li></ol><blockquote style="margin:0 0 0 40px" cite="x">Quoted</blockquote>'),
    '<ol><li>One</li></ol><blockquote style="margin:0 0 0 40px">Quoted</blockquote>');
  assert.equal(signatureHtmlToText('<div>Pat</div><ul><li>Licensed in CA</li><li>Licensed in NV</li></ul><blockquote>Quoted</blockquote>'),
    'Pat\n- Licensed in CA\n- Licensed in NV\nQuoted');
  assert.equal(signatureHtmlToText('<h3>Pat Example</h3><h4>President</h4>'), 'Pat Example\nPresident');
});

test('style keeps only listed CSS properties and safe values', () => {
  assert.equal(clean('<span style="position:fixed;top:0;z-index:99;color:red">a</span>'),
    '<span style="color:red">a</span>');
  for (const style of ['background-image:image-set("https://x.example/a.png" 1x)',
    'background:cross-fade(url(x), url(y))', 'width:-webkit-image-set("https://x" 1x)',
    'width:calc(100% - 1px)', 'color:var(--x)', 'margin-top:-200px', 'margin:0 -1em',
    'display:flex', 'position:absolute', 'float:left', 'background:red']) {
    assert.equal(clean(`<span style='${style}'>a</span>`), '<span>a</span>', style);
  }
  assert.equal(clean('<td style="padding-right:12px;BORDER-TOP: 1px solid rgb(0, 0, 0);display:block;font-family:\'Helvetica Neue\',Arial">a</td>'),
    '<td style="padding-right:12px;border-top:1px solid rgb(0, 0, 0);display:block;font-family:&#39;Helvetica Neue&#39;,Arial">a</td>');
});

test('lone surrogates become U+FFFD in text and attribute values', () => {
  assert.equal(clean('<b>a\ud83db</b>'), '<b>a\ufffdb</b>');
  assert.equal(clean('<img src="https://x.example/a.png" alt="x\udc00">'),
    '<img src="https://x.example/a.png" alt="x\ufffd">');
  assert.equal(clean('a&#xd83d;b'), 'a\ufffdb');
});

test('escapes attribute values and text, and closes open tags', () => {
  assert.equal(clean('<img src="https://x.example/a.png" alt="&quot;&gt;<script>alert(1)</script>">'),
    '<img src="https://x.example/a.png" alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
  assert.equal(clean('<b>Tom & Jerry <i>unclosed'), '<b>Tom &amp; Jerry <i>unclosed</i></b>');
  assert.equal(clean('</div>stray close<br/><hr/>'), 'stray close<br><hr>');
  assert.equal(clean('a < b > c'), 'a &lt; b &gt; c');
  assert.equal(clean('<div title="a>b">x</div>'), '<div>x</div>');
  // Misnested tags are closed in order.
  assert.equal(clean('<b><i>x</b>y</i>'), '<b><i>x</i></b>y');
});

test('only allows each attribute on its own elements, with constrained values', () => {
  assert.equal(clean('<td align="center" valign="top" bgcolor="#ffffff" width="50%">x</td>'),
    '<td align="center" valign="top" bgcolor="#ffffff" width="50%">x</td>');
  assert.equal(clean('<td align="evil" width="1;x">x</td>'), '<td>x</td>');
  assert.equal(clean('<div align="center" color="red" dir="rtl">x</div>'), '<div dir="rtl">x</div>');
  assert.equal(clean('<span dir="sideways">x</span>'), '<span>x</span>');
  assert.equal(clean('<font face="Arial, sans-serif" size="+1" color="red">x</font>'),
    '<font face="Arial, sans-serif" size="+1" color="red">x</font>');
});

test('caps the input size', () => {
  assert.equal(EMAIL_SIGNATURE_MAX_CHARS, 64_000);
  const big = `<div>${'a'.repeat(EMAIL_SIGNATURE_MAX_INPUT_CHARS)}</div>`;
  assert.deepEqual(sanitizeEmailSignatureHtml(big), { html: '', code: 'gmail_signature_too_large' });
  // The sanitized output is capped too: escaping can grow an input under the cap past it.
  const growing = '&'.repeat(EMAIL_SIGNATURE_MAX_CHARS - 10);
  assert.ok(growing.length <= EMAIL_SIGNATURE_MAX_CHARS);
  assert.deepEqual(sanitizeEmailSignatureHtml(growing), { html: '', code: 'gmail_signature_too_large' });
  const fits = '&'.repeat(1000);
  assert.equal(sanitizeEmailSignatureHtml(fits).html.length, 5000);
  assert.deepEqual(sanitizeEmailSignatureHtml(null), { html: '', code: null });
  assert.deepEqual(sanitizeEmailSignatureHtml(''), { html: '', code: null });
});

test('converts the Gmail signature to readable plain text', () => {
  assert.equal(signatureHtmlToText(GMAIL_SIGNATURE_FIXTURE_HTML), GMAIL_SIGNATURE_FIXTURE_TEXT);
  assert.equal(signatureHtmlToText(clean(GMAIL_SIGNATURE_FIXTURE_HTML)), GMAIL_SIGNATURE_FIXTURE_TEXT);
});

test('plain text: links, line breaks, entities and whitespace', () => {
  assert.equal(signatureHtmlToText('<a href="https://example.com/deals">Our deals</a>'),
    'Our deals <https://example.com/deals>');
  assert.equal(signatureHtmlToText('<a href="https://example.com">https://example.com</a>'), 'https://example.com');
  assert.equal(signatureHtmlToText('<a href="http://www.example.com">www.example.com</a>'), 'www.example.com');
  assert.equal(signatureHtmlToText('<a href="mailto:pat@example.com">Email me</a>'), 'Email me');
  assert.equal(signatureHtmlToText('<a href="tel:+15550100000">Call</a>'), 'Call');
  assert.equal(signatureHtmlToText('Pat&nbsp;Example<br>Tom &amp; Co &#8212; &#x2022; &lt;x&gt;'),
    'Pat Example\nTom & Co \u2014 \u2022 <x>');
  assert.equal(signatureHtmlToText('<div>  a \n  b  </div><div><br></div><div><br></div><div><br></div><p>c</p>'),
    'a b\n\nc');
  // An image becomes its alt text, unless that is only a file name.
  assert.equal(signatureHtmlToText('<div><img src="https://x.example/a.png" alt="Example Co."></div>'), 'Example Co.');
  assert.equal(signatureHtmlToText('<div><img src="https://x.example/a.png" alt="image001.png"></div>'), '');
  assert.equal(signatureHtmlToText('<div><img src="https://x.example/a.png"></div>'), '');
  assert.equal(signatureHtmlToText('<script>alert(1)</script>ok'), 'ok');
  assert.equal(signatureHtmlToText(''), '');
});

test('signatureHasContent needs text (alt text counts); an image-only signature is flagged', () => {
  assert.equal(signatureHasContent(clean(GMAIL_SIGNATURE_FIXTURE_HTML)), true);
  assert.equal(signatureHasContent('<div><img src="https://x.example/a.png" alt="Pat Example"></div>'), true);
  assert.equal(signatureHasContent('<div><img src="https://x.example/a.png"></div>'), false);
  assert.equal(signatureIsImageOnly('<div><img src="https://x.example/a.png"></div>'), true);
  assert.equal(signatureIsImageOnly(clean(GMAIL_SIGNATURE_FIXTURE_HTML)), false);
  assert.equal(signatureIsImageOnly(''), false);
  assert.equal(signatureHasContent('<div><br></div>&nbsp;'), false);
  assert.equal(signatureHasContent(''), false);
  assert.equal(signatureHasContent(null), false);
});
