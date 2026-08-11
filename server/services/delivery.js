import { getConfig } from '../config.js';
import { fetchWithTimeout } from '../utils/http.js';
import { recordEmailEvent } from './emailEvents.js';

const cimMessageKinds = new Set([
  'deal-hunter-cim-request',
  'deal-hunter-cim-follow-up',
]);

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeRecipients(to) {
  return Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
}

function hasOnlyValidEmailRecipients(to) {
  const recipients = normalizeRecipients(to).map((recipient) => String(recipient).trim());
  return recipients.length > 0 && recipients.every((recipient) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient));
}

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeResendTagToken(value = '', fallback = '') {
  const normalized = normalizeText(value, 256)
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 256)
    .replace(/^[-_]+|[-_]+$/g, '');

  return normalized || fallback;
}

export function normalizeResendTags(tags = []) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const seen = new Set();
  const normalizedTags = [];

  for (const tag of tags) {
    const rawName = typeof tag === 'string' ? tag.split('=')[0] : tag?.name || tag?.key || '';
    const rawValue = typeof tag === 'string' ? tag.split('=').slice(1).join('=') : tag?.value;
    const name = normalizeResendTagToken(rawName);
    const value = normalizeResendTagToken(rawValue);

    if (!name || !value) {
      continue;
    }

    const key = `${name}:${value}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedTags.push({ name, value });
  }

  return normalizedTags;
}

function extractEmailAddress(value = '') {
  const normalized = normalizeText(value, 320);
  return normalized.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1] || '';
}

export function buildCimReplyToAddress({ requestId = '', replyTo = '' } = {}) {
  const address = extractEmailAddress(replyTo);
  const separatorIndex = address.lastIndexOf('@');
  const domain = separatorIndex >= 0 ? address.slice(separatorIndex + 1).toLowerCase() : '';
  const requestToken = normalizeResendTagToken(requestId).toLowerCase().slice(0, 32);

  if (!domain || !requestToken) {
    return address || normalizeText(replyTo, 320);
  }

  return `cim-${requestToken}@${domain}`;
}

export function buildCimEmailIdempotencyKey({ requestId = '', followUpNumber = 0 } = {}) {
  const requestToken = normalizeResendTagToken(requestId).slice(0, 160);

  if (!requestToken) {
    return '';
  }

  const normalizedFollowUpNumber = Math.max(0, Math.trunc(Number(followUpNumber) || 0));
  const touchToken = normalizedFollowUpNumber > 0 ? `follow-up-${normalizedFollowUpNumber}` : 'initial';

  return `deal-hunter-cim-${requestToken}-${touchToken}`.slice(0, 256);
}

function normalizeUrl(value = '') {
  const normalized = normalizeText(value, 1000);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function paragraphHtml(paragraphs = []) {
  return paragraphs
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p style="margin: 0 0 16px; color: #33443B; font-size: 16px; line-height: 1.65;">${escapeHtml(paragraph)}</p>`,
    )
    .join('');
}

function detailTableHtml(rows = []) {
  const safeRows = rows.filter((row) => row?.label && row?.value);

  if (safeRows.length === 0) {
    return '';
  }

  return `
    <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; border-collapse: collapse; margin: 20px 0 0;">
      ${safeRows
        .map(
          (row) => `
            <tr>
              <td style="padding: 8px 14px 8px 0; color: #6A756F; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; vertical-align: top; width: 155px;">${escapeHtml(row.label)}</td>
              <td style="padding: 8px 0; color: #18211D; font-size: 15px; line-height: 1.55; vertical-align: top;">${escapeHtml(row.value)}</td>
            </tr>
          `,
        )
        .join('')}
    </table>
  `;
}

function ctaHtml(ctas = []) {
  const safeCtas = ctas.filter((cta) => cta?.label && normalizeUrl(cta.href));

  if (safeCtas.length === 0) {
    return '';
  }

  return `
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin: 26px 0 8px;">
      <tr>
        ${safeCtas
          .map((cta, index) => {
            const primary = index === 0;
            const background = primary ? '#284638' : '#FFFFFF';
            const color = primary ? '#FFFFFF' : '#284638';
            const border = primary ? '#284638' : '#D6CCBE';

            return `
              <td style="padding: 0 10px 10px 0;">
                <a href="${escapeHtml(normalizeUrl(cta.href))}" target="_blank" style="display: inline-block; border: 1px solid ${border}; border-radius: 999px; background: ${background}; color: ${color}; font-size: 14px; font-weight: 700; line-height: 1; padding: 14px 18px; text-decoration: none;">${escapeHtml(cta.label)}</a>
              </td>
            `;
          })
          .join('')}
      </tr>
    </table>
  `;
}

function brandedEmailHtml({
  preheader = '',
  eyebrow = '',
  title,
  showTitle = true,
  paragraphs = [],
  bodyHtml = '',
  details = [],
  ctas = [],
  footerNote = '',
}) {
  const config = getConfig();
  const websiteUrl = normalizeUrl(config.brand.websiteUrl || config.server.origin);
  const logoUrl = websiteUrl
    ? normalizeUrl(`${websiteUrl.replace(/\/+$/, '')}/email-logo.png`)
    : '';
  const mailingAddress = normalizeText(config.brand.mailingAddress, 260);
  const footerLines = [
    footerNote ? { value: footerNote, isHtml: true } : null,
    mailingAddress ? { value: `${config.brand.companyName} | ${mailingAddress}`, isHtml: false } : null,
    websiteUrl
      ? {
          value: `<a href="${escapeHtml(websiteUrl)}" style="color: #284638; text-decoration: underline;">${escapeHtml(websiteUrl)}</a>`,
          isHtml: true,
        }
      : null,
  ].filter(Boolean);

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(title)}</title>
      </head>
      <body style="margin: 0; padding: 0; background: #F8F4ED; color: #18211D; font-family: Arial, Helvetica, sans-serif;">
        ${preheader ? `<div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${escapeHtml(preheader)}</div>` : ''}
        <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; border-collapse: collapse; background: #F8F4ED;">
          <tr>
            <td style="padding: 32px 16px;">
              <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; max-width: 660px; margin: 0 auto; border-collapse: collapse;">
                <tr>
                  <td style="padding: 0 0 14px;">
                    <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="width: 48px; vertical-align: middle;">
                          ${logoUrl
                            ? `<img src="${escapeHtml(logoUrl)}" width="44" height="44" alt="" style="display: block; width: 44px; height: 44px; border: 0; border-radius: 10px; outline: none; text-decoration: none;">`
                            : '<div style="height: 40px; width: 40px; border-radius: 10px; background: #284638; color: #FFFFFF; font-size: 14px; font-weight: 800; line-height: 40px; text-align: center;">UG</div>'}
                        </td>
                        <td style="padding-left: 10px; color: #18211D; font-size: 18px; font-weight: 800; vertical-align: middle;">
                          ${escapeHtml(config.brand.companyName)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="border: 1px solid #E3D9CA; border-radius: 18px; background: #FFFFFF; padding: 34px;">
                    ${eyebrow ? `<p style="margin: 0 0 12px; color: #7A5A3B; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase;">${escapeHtml(eyebrow)}</p>` : ''}
                    ${showTitle && title ? `<h1 style="margin: 0 0 18px; color: #18211D; font-size: 28px; line-height: 1.22;">${escapeHtml(title)}</h1>` : ''}
                    ${paragraphHtml(paragraphs)}
                    ${bodyHtml}
                    ${detailTableHtml(details)}
                    ${ctaHtml(ctas)}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 18px 4px 0; color: #6A756F; font-size: 12px; line-height: 1.6;">
                    ${footerLines.map((line) => `<div style="margin: 0 0 6px;">${line.isHtml ? line.value : escapeHtml(line.value)}</div>`).join('')}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

async function sendViaConsole(message) {
  const textBytes = Buffer.byteLength(String(message.text || ''), 'utf8');
  const htmlBytes = Buffer.byteLength(String(message.html || ''), 'utf8');
  console.log(
    `[mail:${message.kind}] to=${normalizeRecipients(message.to).join(', ')} subject=${message.subject} textBytes=${textBytes} htmlBytes=${htmlBytes}`,
  );
  return { status: 'logged', error: '', providerMessageId: '' };
}

async function sendViaResend(message) {
  const config = getConfig();

  if (!config.delivery.resendApiKey || !config.delivery.resendFromEmail) {
    return { status: 'failed', error: 'Resend is selected but RESEND_API_KEY or RESEND_FROM_EMAIL is missing.' };
  }

  const tags = normalizeResendTags(message.tags);
  const response = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    timeoutMs: config.server.outboundRequestTimeoutMs,
    timeoutMessage: 'Resend delivery timed out.',
    headers: {
      Authorization: `Bearer ${config.delivery.resendApiKey}`,
      'Content-Type': 'application/json',
      ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: message.from || config.delivery.resendFromEmail,
      to: normalizeRecipients(message.to),
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.replyTo || undefined,
      headers: message.headers || undefined,
      tags: tags.length > 0 ? tags : undefined,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      status: 'failed',
      error: `Resend delivery failed with ${response.status}: ${text.slice(0, 240)}`,
    };
  }

  const data = await response.json().catch(() => ({}));

  return { status: 'sent', error: '', providerMessageId: data.id || data.email_id || '' };
}

async function sendViaEmailJs(message) {
  const config = getConfig();

  if (!config.delivery.emailjsServiceId || !config.delivery.emailjsTemplateId || !config.delivery.emailjsPublicKey) {
    return {
      status: 'failed',
      error: 'EmailJS is selected but EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, or EMAILJS_PUBLIC_KEY is missing.',
    };
  }

  const response = await fetchWithTimeout('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    timeoutMs: config.server.outboundRequestTimeoutMs,
    timeoutMessage: 'EmailJS delivery timed out.',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      service_id: config.delivery.emailjsServiceId,
      template_id: config.delivery.emailjsTemplateId,
      user_id: config.delivery.emailjsPublicKey,
      accessToken: config.delivery.emailjsPrivateKey || undefined,
      template_params: {
        to_email: normalizeRecipients(message.to).join(', '),
        subject: message.subject,
        headline: message.headline || message.subject,
        body_text: message.text,
        body_html: message.html,
        reply_to: message.replyTo || '',
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      status: 'failed',
      error: `EmailJS delivery failed with ${response.status}: ${text.slice(0, 240)}`,
    };
  }

  return { status: 'sent', error: '', providerMessageId: '' };
}

async function sendViaFormspree(message) {
  const config = getConfig();

  if (message.kind !== 'submission') {
    return {
      status: 'failed',
      error: 'The Formspree adapter only supports inbound submission routing. Use Resend or EmailJS for admin magic links and outbound upload invites.',
    };
  }

  if (!config.delivery.formspreeEndpoint) {
    return { status: 'failed', error: 'Formspree is selected but FORMSPREE_ENDPOINT is missing.' };
  }

  const response = await fetchWithTimeout(config.delivery.formspreeEndpoint, {
    method: 'POST',
    timeoutMs: config.server.outboundRequestTimeoutMs,
    timeoutMessage: 'Formspree delivery timed out.',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message.formspreePayload),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      status: 'failed',
      error: `Formspree delivery failed with ${response.status}: ${text.slice(0, 240)}`,
    };
  }

  return { status: 'sent', error: '', providerMessageId: '' };
}

async function recordTrackedEmailDelivery(message, result) {
  if (!message.tracking || !['sent', 'logged'].includes(result.status)) {
    return;
  }

  const config = getConfig();
  const recipients = normalizeRecipients(message.to);

  try {
    await Promise.all(
      recipients.map((recipient) =>
        recordEmailEvent({
          provider: config.delivery.provider,
          event_type: 'sent',
          message_id: result.providerMessageId || '',
          recipient_email: recipient,
          subject: message.subject,
          submission_id: message.tracking.submissionId || '',
          communication_id: message.tracking.communicationId || message.communicationId || '',
          source: message.kind,
          metadata: {
            deliveryStatus: result.status,
            kind: message.kind,
            tracking: message.tracking,
          },
        }),
      ),
    );
  } catch (error) {
    console.warn(`[mail:${message.kind}] email event tracking failed: ${error.message}`);
  }
}

async function sendMessage(message) {
  const config = getConfig();
  let result;

  // EmailJS returns a successful response without a provider message ID and
  // does not offer the provider-side idempotency guarantee used by CIM sends.
  // A process failure after acceptance could therefore make a retry duplicate
  // private broker outreach. Keep EmailJS available for ordinary application
  // mail, but fail closed before the network for every CIM send entry point.
  if (config.delivery.provider === 'emailjs' && cimMessageKinds.has(message.kind)) {
    return {
      status: 'failed',
      error: 'EmailJS is not eligible for CIM outreach because provider acceptance cannot be reconciled idempotently. Configure Resend, or use the console provider for development-only verification.',
      providerMessageId: '',
    };
  }

  try {
    switch (config.delivery.provider) {
      case 'resend':
        result = await sendViaResend(message);
        break;
      case 'emailjs':
        result = await sendViaEmailJs(message);
        break;
      case 'formspree':
        result = await sendViaFormspree(message);
        break;
      case 'console':
      default:
        result = await sendViaConsole(message);
        break;
    }
  } catch (error) {
    result = {
      status: 'failed',
      error: `${config.delivery.provider} delivery failed: ${error.message}`,
      providerMessageId: '',
    };
  }

  await recordTrackedEmailDelivery(message, result);
  return result;
}

// CIM workflows persist the fully-rendered message before calling this entry
// point, then pass the same immutable object here. Keeping this small public
// seam prevents template changes between persistence and transmission.
export async function sendPreparedMessage(message = {}) {
  if (!hasOnlyValidEmailRecipients(message.to)) {
    return {
      status: 'failed',
      error: 'A valid broker or contact email is required before sending this email.',
      providerMessageId: '',
    };
  }

  return sendMessage(message);
}

function buildSubmissionMessage(submission) {
  const subject = `New acquisition inquiry from ${submission.name}`;
  const text = [
    'New inbound acquisition inquiry',
    '',
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Phone: ${submission.phone || 'Not provided'}`,
    `Company: ${submission.company || 'Not provided'}`,
    `Role: ${submission.role || 'Not provided'}`,
    `Lead type: ${submission.lead_type}`,
    `Priority: ${submission.priority}`,
    `Source: ${submission.source}`,
    `Submitted: ${submission.created_at}`,
    `Next action: ${submission.next_action_at || 'Not set'}`,
    '',
    'Message:',
    submission.message,
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; color: #18211D; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">New inbound acquisition inquiry</h2>
      <table cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Name</strong></td><td>${escapeHtml(submission.name)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Email</strong></td><td>${escapeHtml(submission.email)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Phone</strong></td><td>${escapeHtml(submission.phone || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Company</strong></td><td>${escapeHtml(submission.company || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Role</strong></td><td>${escapeHtml(submission.role || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Lead type</strong></td><td>${escapeHtml(submission.lead_type)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Priority</strong></td><td>${escapeHtml(submission.priority)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Source</strong></td><td>${escapeHtml(submission.source)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Next action</strong></td><td>${escapeHtml(submission.next_action_at || 'Not set')}</td></tr>
      </table>
      <div style="margin-top: 24px; padding: 16px; border: 1px solid #D6CCBE; border-radius: 16px; background: #F8F4ED;">
        <strong>Message</strong>
        <p style="margin: 12px 0 0;">${escapeHtml(submission.message).replaceAll('\n', '<br />')}</p>
      </div>
    </div>
  `;

  return {
    kind: 'submission',
    idempotencyKey: `contact-submission:${submission.id}`,
    to: getConfig().delivery.fallbackRecipient,
    replyTo: submission.email || getConfig().delivery.resendReplyTo || '',
    subject,
    headline: 'New inbound acquisition inquiry',
    text,
    html,
    formspreePayload: {
      name: submission.name,
      email: submission.email,
      phone: submission.phone,
      company: submission.company,
      role: submission.role,
      message: submission.message,
      source: submission.source,
      lead_type: submission.lead_type,
      priority: submission.priority,
      next_action_at: submission.next_action_at,
      _subject: subject,
    },
  };
}

export async function deliverSubmission(submission) {
  return sendMessage(buildSubmissionMessage(submission));
}

function formatMoney(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value)
    : 'Not disclosed';
}

function dealHunterMetaLine(deal) {
  return [
    deal.industry,
    deal.location,
    deal.annualProfit ? `Profit ${formatMoney(deal.annualProfit)}` : '',
    deal.askingPrice ? `Ask ${formatMoney(deal.askingPrice)}` : '',
    deal.profitMultiple ? `${deal.profitMultiple}x profit` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function dealHunterDealHtml(deal, { tone = 'success', showRemoveReasons = false } = {}) {
  const border = tone === 'danger' ? '#FECACA' : tone === 'warning' ? '#FDE68A' : '#C9D8CF';
  const background = tone === 'danger' ? '#FEF2F2' : tone === 'warning' ? '#FFFBEB' : '#F4F8F5';
  const badgeColor = tone === 'danger' ? '#B91C1C' : tone === 'warning' ? '#92400E' : '#284638';
  const detailItems = showRemoveReasons ? deal.removeReasons || deal.concerns || [] : deal.strengths || [];
  const questionItems = deal.questions || [];
  const listingUrl = normalizeUrl(deal.listingUrl);

  return `
    <div style="margin: 18px 0; border: 1px solid ${border}; border-radius: 16px; background: ${background}; padding: 18px;">
      <div style="margin: 0 0 8px;">
        <span style="display: inline-block; border-radius: 999px; background: #FFFFFF; color: ${badgeColor}; font-size: 12px; font-weight: 800; padding: 6px 10px;">Score ${escapeHtml(String(deal.score ?? 0))}</span>
        <span style="display: inline-block; margin-left: 8px; color: #51615A; font-size: 12px; font-weight: 700;">${escapeHtml(deal.sourceName || 'Deal source')}</span>
      </div>
      <h3 style="margin: 0 0 8px; color: #18211D; font-size: 18px; line-height: 1.35;">${escapeHtml(deal.name || 'Unnamed business')}</h3>
      ${dealHunterMetaLine(deal) ? `<p style="margin: 0 0 12px; color: #33443B; font-size: 14px; line-height: 1.55;">${escapeHtml(dealHunterMetaLine(deal))}</p>` : ''}
      ${deal.recommendation ? `<p style="margin: 0 0 12px; color: #18211D; font-size: 14px; line-height: 1.55;"><strong>Note:</strong> ${escapeHtml(deal.recommendation)}</p>` : ''}
      ${
        detailItems.length > 0
          ? `<ul style="margin: 0 0 12px 18px; padding: 0; color: #33443B; font-size: 14px; line-height: 1.55;">${detailItems
              .slice(0, 4)
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${
        questionItems.length > 0
          ? `<p style="margin: 12px 0 6px; color: #18211D; font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;">Questions to ask</p><ul style="margin: 0 0 12px 18px; padding: 0; color: #33443B; font-size: 14px; line-height: 1.55;">${questionItems
              .slice(0, 3)
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join('')}</ul>`
          : ''
      }
      ${listingUrl ? `<a href="${escapeHtml(listingUrl)}" style="color: #284638; font-size: 14px; font-weight: 800; text-decoration: underline;">View listing</a>` : ''}
    </div>
  `;
}

function dealHunterSectionHtml(title, intro, deals, options = {}) {
  if (!Array.isArray(deals) || deals.length === 0) {
    return '';
  }

  const sectionLimit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const visibleDeals = deals.slice(0, sectionLimit);
  const omittedCount = Math.max(0, deals.length - visibleDeals.length);

  return `
    <div style="margin: 26px 0 0;">
      <p style="margin: 0 0 8px; color: #7A5A3B; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase;">${escapeHtml(title)}</p>
      ${intro ? `<p style="margin: 0 0 12px; color: #33443B; font-size: 15px; line-height: 1.6;">${escapeHtml(intro)}</p>` : ''}
      ${visibleDeals.map((deal) => dealHunterDealHtml(deal, options)).join('')}
      ${omittedCount > 0 ? `<p style="margin: 12px 0 0; color: #6C756F; font-size: 13px; line-height: 1.5;">Showing top ${visibleDeals.length} of ${deals.length}. Review the protected CRM dashboard for the full scored list.</p>` : ''}
    </div>
  `;
}

function dealHunterTextSection(title, deals = [], options = {}) {
  const safeDeals = Array.isArray(deals) ? deals : [];
  const sectionLimit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 8;
  const visibleDeals = safeDeals.slice(0, sectionLimit);
  const omittedCount = Math.max(0, safeDeals.length - visibleDeals.length);
  const lines = [
    `${title}:`,
    ...visibleDeals.flatMap((deal, index) => [
      `${index + 1}. ${deal.name} (${deal.score}/100)`,
      options.showRemoveReasons ? (deal.removeReasons || deal.concerns || []).join('; ') : dealHunterMetaLine(deal),
      options.showRemoveReasons ? '' : (deal.recommendation || ''),
      normalizeUrl(deal.listingUrl),
      '',
    ]),
  ];

  if (omittedCount > 0) {
    lines.push(`Showing top ${visibleDeals.length} of ${safeDeals.length}. Review the protected CRM dashboard for the full scored list.`, '');
  }

  return lines;
}

export function buildDailyDealHunterEmail({ to, review = {}, idempotencyKey = '' } = {}) {
  const config = getConfig();
  const generatedLabel = review.generatedAt ? new Date(review.generatedAt).toLocaleString() : new Date().toLocaleString();
  const crmSync = review.crmSync || {};
  const emailSectionLimit = 8;
  const removalSectionLimit = 12;
  const sourceSummary = (review.sources || [])
    .map((source) => `${source.name}: ${source.fetched ? `${source.rowCount || 0} rows` : `failed (${source.error || 'unknown error'})`}`)
    .join('\n');
  const coverageWarnings = Array.isArray(review.coverageWarnings) ? review.coverageWarnings.filter(Boolean) : [];
  const coverageWarningHtml = coverageWarnings.length > 0
    ? `<div style="margin: 20px 0; border: 1px solid #F0C36A; border-radius: 14px; background: #FFF8E7; padding: 16px;"><p style="margin: 0 0 8px; color: #7A5200; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase;">Limited source coverage</p><ul style="margin: 0 0 0 18px; padding: 0; color: #664A10; font-size: 14px; line-height: 1.6;">${coverageWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>`
    : '';
  const recommendations = review.criteriaRecommendations || [];
  const automation = review.cimAutomation || {};
  const automationRun = automation.run || {};
  const cimReadyDeals = [];
  const seenCimDeals = new Set();

  for (const deal of [...(review.qualified || []), ...(review.newlySeenMatches || []), ...(review.watchlist || [])]) {
    const recipient = deal?.cimRequest?.recipientEmail || deal?.brokerEmail || '';
    const key = `${deal?.dealKey || ''}|${String(recipient).toLowerCase()}`;

    if (!deal?.cimRequest?.canRequest || !recipient || seenCimDeals.has(key)) continue;
    seenCimDeals.add(key);
    cimReadyDeals.push(deal);
  }

  const adminOrigin = String(config.server.origin || '').replace(/\/$/, '');
  const scoredBusinessesUrl = `${adminOrigin}/admin/command-center`;
  const approvalUrl = `${adminOrigin}/admin/deal-hunter?view=cim-approvals`;
  const directActionButtonHtml = (label, href, { secondary = false } = {}) => `
    <table cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; border-collapse: separate; margin: 0 0 10px;">
      <tr>
        <td align="center" bgcolor="${secondary ? '#FFFFFF' : '#284638'}" style="border: 1px solid ${secondary ? '#A9BCAF' : '#284638'}; border-radius: 8px;">
          <a href="${escapeHtml(href)}" target="_blank" style="display: block; padding: 14px 18px; color: ${secondary ? '#284638' : '#FFFFFF'}; font-size: 14px; font-weight: 800; line-height: 1.25; text-align: center; text-decoration: none;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>
  `;
  const directActionLinksHtml = `
    <div style="margin: 20px 0; border: 1px solid #C9D8CF; border-radius: 14px; background: #F4F8F5; padding: 16px;">
      <p style="margin: 0 0 8px; color: #284638; font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;">Direct action links</p>
      <p style="margin: 0 0 14px; color: #33443B; font-size: 13px; line-height: 1.55;">Open the protected dashboards to review today&rsquo;s opportunities and approvals.</p>
      ${directActionButtonHtml('Review 75+ Scored Businesses', scoredBusinessesUrl)}
      ${cimReadyDeals.length > 0 ? directActionButtonHtml(`Review & Send ${cimReadyDeals.length} CIM Request${cimReadyDeals.length === 1 ? '' : 's'}`, approvalUrl, { secondary: true }) : ''}
    </div>
  `;
  const bodyHtml = `
    ${coverageWarningHtml}
    <div style="margin: 20px 0; border: 1px solid #E3D9CA; border-radius: 14px; background: #F8F4ED; padding: 16px;">
      <p style="margin: 0 0 8px; color: #7A5A3B; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase;">CIM Automation</p>
      <p style="margin: 0; color: #33443B; font-size: 14px; line-height: 1.6;">Configured Stage ${escapeHtml(automation.configuredStage || 1)}; effective Stage ${escapeHtml(automation.effectiveStage || 1)}${automation.paused ? '; emergency paused' : ''}. ${escapeHtml(automationRun.sent || 0)} initial request(s) sent automatically; ${escapeHtml(automationRun.exceptions?.length || 0)} exception(s) retained for review.</p>
    </div>
    ${directActionLinksHtml}
    ${dealHunterSectionHtml(
      'CIM Requests Ready For Approval',
      'Review the exact businesses and recipients, edit any broker address, skip weak fits, and send only the requests you approve.',
      cimReadyDeals,
      { tone: 'warning', limit: emailSectionLimit },
    )}
    ${dealHunterSectionHtml(
      'Newly Seen Fits',
      'These listings were not in the prior Deal Hunter history and deserve the first look today.',
      review.newlySeenMatches || [],
      { tone: 'success', limit: emailSectionLimit },
    )}
    ${dealHunterSectionHtml(
      'High-Fit Deals',
      'These are the strongest matches for recession-resistant, AI-resistant, long-term small business ownership.',
      review.qualified || [],
      { tone: 'success', limit: emailSectionLimit },
    )}
    ${dealHunterSectionHtml(
      'Watchlist',
      'These may fit if broker diligence confirms recurring revenue, customer diversity, management depth, and financeable terms.',
      review.watchlist || [],
      { tone: 'warning', limit: emailSectionLimit },
    )}
    ${dealHunterSectionHtml(
      'Remove From Next Update',
      'These should be excluded from tomorrow\'s source list because they conflict with the buying strategy or score too poorly.',
      review.removalCandidates || [],
      { tone: 'danger', showRemoveReasons: true, limit: removalSectionLimit },
    )}
    ${
      recommendations.length > 0
        ? `<div style="margin: 26px 0 0; border-top: 1px solid #E3D9CA; padding-top: 18px;"><p style="margin: 0 0 8px; color: #7A5A3B; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase;">Criteria Notes</p><ul style="margin: 0 0 0 18px; padding: 0; color: #33443B; font-size: 14px; line-height: 1.6;">${recommendations
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
  `;
	  const html = brandedEmailHtml({
	    preheader: `${review.totals?.newMatches || 0} new fit(s), ${review.totals?.qualified || 0} high-fit deals, and ${review.totals?.removalCandidates || 0} removals from today's deal sources.`,
    eyebrow: 'Daily Deal Hunter',
    title: 'Daily acquisition deal review',
    paragraphs: [
      `Generated ${generatedLabel}. Reviewed ${review.totals?.reviewedDeals || 0} recent deals from ${review.sources?.length || 0} source(s).`,
      coverageWarnings.length > 0 ? 'Source coverage is intentionally limited. Review the warning below before relying on today\'s totals.' : '',
      'The scoring profile favors essential B2B and field-service companies with recurring or repeat revenue, recession resistance, AI resistance, and financeable acquisition size. Management in place is preferred but not required.',
      crmSync.reviewed ? `CRM sync checked ${crmSync.reviewed} score-75-plus deal(s): ${crmSync.created || 0} created, ${crmSync.enriched || 0} enriched, ${crmSync.updated || 0} updated, ${crmSync.skipped || 0} skipped.` : '',
    ],
    bodyHtml,
	    details: [
      { label: 'CIM approvals', value: String(cimReadyDeals.length) },
      { label: 'High-fit deals', value: String(review.totals?.qualified || 0) },
      { label: 'New fit(s)', value: String(review.totals?.newMatches || 0) },
      { label: 'Watchlist', value: String(review.totals?.watchlist || 0) },
      { label: 'Remove flags', value: String(review.totals?.removalCandidates || 0) },
      crmSync.reviewed ? { label: 'CRM created', value: String(crmSync.created || 0) } : null,
      crmSync.reviewed ? { label: 'CRM enriched', value: String(crmSync.enriched || 0) } : null,
      crmSync.reviewed ? { label: 'CRM updated', value: String(crmSync.updated || 0) } : null,
      { label: 'Lookback', value: `${review.lookbackDays || 0} day(s)` },
    ].filter(Boolean),
    ctas: [],
  });
  const text = [
    'Daily acquisition deal review',
    '',
    `Generated: ${generatedLabel}`,
    `Reviewed deals: ${review.totals?.reviewedDeals || 0}`,
    coverageWarnings.length > 0 ? 'LIMITED SOURCE COVERAGE:' : '',
    ...coverageWarnings.map((warning) => `- ${warning}`),
    `CIM requests ready for approval: ${cimReadyDeals.length}`,
    `CIM automation: configured Stage ${automation.configuredStage || 1}, effective Stage ${automation.effectiveStage || 1}${automation.paused ? ', paused' : ''}; ${automationRun.sent || 0} automatically sent; ${automationRun.exceptions?.length || 0} exceptions.`,
    `Review 75+ scored businesses: ${scoredBusinessesUrl}`,
    cimReadyDeals.length > 0 ? `Review and send CIM requests: ${approvalUrl}` : '',
    crmSync.reviewed ? `CRM sync: ${crmSync.created || 0} created, ${crmSync.enriched || 0} enriched, ${crmSync.updated || 0} updated, ${crmSync.skipped || 0} skipped, ${crmSync.failed || 0} failed.` : '',
    '',
	    'Sources:',
	    sourceSummary || 'No sources configured.',
	    '',
		    ...dealHunterTextSection('CIM requests ready for approval', cimReadyDeals, { limit: emailSectionLimit }),
		    ...dealHunterTextSection('Newly seen fits', review.newlySeenMatches || [], { limit: emailSectionLimit }),
		    '',
		    ...dealHunterTextSection('High-fit deals', review.qualified || [], { limit: emailSectionLimit }),
	    ...dealHunterTextSection('Watchlist', review.watchlist || [], { limit: emailSectionLimit }),
	    ...dealHunterTextSection('Remove from next update', review.removalCandidates || [], { limit: removalSectionLimit, showRemoveReasons: true }),
    'Criteria notes:',
    ...recommendations.map((item) => `- ${item}`),
  ].join('\n');

		  return {
			    kind: 'daily-deal-hunter',
			    idempotencyKey,
		    to,
		    subject: `Daily deal review${coverageWarnings.length > 0 ? ' (limited source coverage)' : ''}: ${review.totals?.newMatches || 0} new fit, ${review.totals?.removalCandidates || 0} remove`,
    headline: 'Daily acquisition deal review',
    text,
    html,
    tags: [{ name: 'source', value: 'daily-deal-hunter' }],
    tracking: {
      source: 'daily-deal-hunter',
      generatedAt: review.generatedAt || '',
      totals: review.totals || {},
      cimReadyCount: cimReadyDeals.length,
    },
  };
}

export async function sendDailyDealHunterEmail(options) {
  return sendMessage(buildDailyDealHunterEmail(options));
}

export function buildDealHunterCimRequestEmail({
  to,
  deal = {},
  requestedBy = '',
  cimRequestId = '',
  submissionId = '',
  communicationId = '',
} = {}) {
  const config = getConfig();
  const businessName = normalizeText(deal.name || 'the listed business', 160);
  const subject = `CIM / NDA request for ${businessName}`;
  const requester = normalizeText(config.workflow?.defaultAssignee || requestedBy || 'Mathew Uckele', 120);
  const listingUrl = normalizeUrl(deal.listingUrl || '');
  const details = [
    { label: 'Business', value: businessName },
    deal.industry ? { label: 'Industry', value: deal.industry } : null,
    deal.location ? { label: 'Location', value: deal.location } : null,
    { label: 'Request', value: 'CIM, teaser, or NDA process' },
  ].filter(Boolean);
  const paragraphs = [
    `Hello${deal.brokerName ? ` ${deal.brokerName}` : ''},`,
    `I am reaching out regarding ${businessName}. Based on the information available, it looks like the type of durable service business I would like to evaluate further.`,
    'By way of background, I am an operator and small business buyer focused on acquiring a cash-flowing service business with repeat or recurring demand, a strong local reputation, and a transition path where the team and customers are protected.',
    'I am currently the co-founder and President of Golden Behavior Connection, an ABA therapy company I helped build from the ground up. My day-to-day work includes operations, staffing, compliance, revenue cycle management, sales execution, and financial performance. Earlier in my career, I held operating and sales roles at Tripadvisor, Better Mortgage, and Wayfair.',
    'I am prepared to move quickly if the opportunity is a fit. I have acquisition equity available, am working with SBA financing, and can provide proof of funds or lender context upon request.',
    'Could you please send over the CIM or teaser, or let me know the NDA process? If there is a specific process you prefer buyers to follow, I am happy to follow it.',
    'I will treat all materials confidentially.',
    'Best,',
    requester,
    'Uckele Group',
  ];
  const text = [
    `Hello${deal.brokerName ? ` ${deal.brokerName}` : ''},`,
    '',
    `I am reaching out regarding ${businessName}. Based on the information available, it looks like the type of durable service business I would like to evaluate further.`,
    '',
    'By way of background, I am an operator and small business buyer focused on acquiring a cash-flowing service business with repeat or recurring demand, a strong local reputation, and a transition path where the team and customers are protected.',
    '',
    'I am currently the co-founder and President of Golden Behavior Connection, an ABA therapy company I helped build from the ground up. My day-to-day work includes operations, staffing, compliance, revenue cycle management, sales execution, and financial performance. Earlier in my career, I held operating and sales roles at Tripadvisor, Better Mortgage, and Wayfair.',
    '',
    'I am prepared to move quickly if the opportunity is a fit. I have acquisition equity available, am working with SBA financing, and can provide proof of funds or lender context upon request.',
    '',
    'Could you please send over the CIM or teaser, or let me know the NDA process? If there is a specific process you prefer buyers to follow, I am happy to follow it.',
    '',
    'I will treat all materials confidentially.',
    '',
    'Deal details:',
    ...details.map((item) => `- ${item.label}: ${item.value}`),
    listingUrl ? `- Listing: ${listingUrl}` : '',
    '',
    'Best,',
    requester,
    'Uckele Group',
  ]
    .filter((line) => line !== '')
    .join('\n');
  const html = brandedEmailHtml({
    preheader: `Requesting the CIM or teaser for ${businessName}.`,
    title: subject,
    showTitle: false,
    paragraphs,
    details,
    ctas: listingUrl ? [{ label: 'View Listing', href: listingUrl }] : [],
  });

  return {
    communicationId,
    kind: 'deal-hunter-cim-request',
    idempotencyKey: buildCimEmailIdempotencyKey({ requestId: cimRequestId }),
    to,
    replyTo: config.delivery.resendReplyTo
      ? buildCimReplyToAddress({ requestId: cimRequestId, replyTo: config.delivery.resendReplyTo })
      : config.delivery.fallbackRecipient || '',
    subject,
    headline: subject,
    text,
    html,
    tags: [
      { name: 'source', value: 'deal-hunter-cim-request' },
      { name: 'deal_key', value: normalizeText(deal.dealKey || '', 250) },
      { name: 'cim_request_id', value: normalizeText(cimRequestId, 250) },
      { name: 'submission_id', value: normalizeText(submissionId, 250) },
      { name: 'communication_id', value: normalizeText(communicationId, 250) },
    ],
    tracking: {
      source: 'deal-hunter-cim-request',
      dealKey: deal.dealKey || '',
      dealName: businessName,
      cimRequestId,
      submissionId,
      communicationId,
      score: deal.score || 0,
      requestedBy,
    },
  };
}

export async function sendDealHunterCimRequestEmail(options) {
  if (!hasOnlyValidEmailRecipients(options?.to)) {
    return {
      status: 'failed',
      error: 'A valid broker or contact email is required before sending a CIM request.',
      providerMessageId: '',
    };
  }

  return sendMessage(buildDealHunterCimRequestEmail(options));
}

function buildCimFollowUpCopy({ businessName, followUpNumber }) {
  if (followUpNumber >= 3) {
    return {
      preheader: `Checking in on the CIM or NDA process for ${businessName}.`,
      paragraphs: [
        `I wanted to check in on ${businessName}. I remain interested in reviewing the opportunity if it is still active.`,
        'If you are able to share the CIM or teaser, or let me know the NDA process, I would appreciate it. I am prepared to review materials promptly and can provide proof of funds or lender context if helpful.',
        'If the opportunity is no longer available, under LOI, or not a fit for my buyer profile, a quick note is completely fine and I will close the loop.',
        'Thank you again for your time.',
      ],
      textLines: [
        `I wanted to check in on ${businessName}. I remain interested in reviewing the opportunity if it is still active.`,
        '',
        'If you are able to share the CIM or teaser, or let me know the NDA process, I would appreciate it. I am prepared to review materials promptly and can provide proof of funds or lender context if helpful.',
        '',
        'If the opportunity is no longer available, under LOI, or not a fit for my buyer profile, a quick note is completely fine and I will close the loop.',
        '',
        'Thank you again for your time.',
      ],
    };
  }

  if (followUpNumber === 2) {
    return {
      preheader: `Checking in on the CIM or NDA process for ${businessName}.`,
      paragraphs: [
        `I wanted to check in on ${businessName}. The business appears potentially aligned with my acquisition search, and I would like to review it if the process is still open.`,
        'I am focused on durable service businesses with repeat demand, clear transition requirements, and a path to continued growth. If the CIM or teaser is available, please send it over, or let me know the NDA process and I will review it promptly.',
        'If there is a better next step or a buyer questionnaire you would like me to complete first, please send it my way.',
      ],
      textLines: [
        `I wanted to check in on ${businessName}. The business appears potentially aligned with my acquisition search, and I would like to review it if the process is still open.`,
        '',
        'I am focused on durable service businesses with repeat demand, clear transition requirements, and a path to continued growth. If the CIM or teaser is available, please send it over, or let me know the NDA process and I will review it promptly.',
        '',
        'If there is a better next step or a buyer questionnaire you would like me to complete first, please send it my way.',
      ],
    };
  }

  return {
    preheader: `Checking in on the CIM or NDA process for ${businessName}.`,
    paragraphs: [
      `I wanted to check in on my note regarding ${businessName}. I am still interested in learning more and would appreciate the opportunity to review the CIM or teaser, or complete the NDA process.`,
      'The business appears potentially aligned with my focus on cash-flowing service companies with durable demand and a thoughtful owner transition.',
      'If the opportunity is still active, please send the materials or let me know the next step in your process. I am happy to complete an NDA first.',
    ],
    textLines: [
      `I wanted to check in on my note regarding ${businessName}. I am still interested in learning more and would appreciate the opportunity to review the CIM or teaser, or complete the NDA process.`,
      '',
      'The business appears potentially aligned with my focus on cash-flowing service companies with durable demand and a thoughtful owner transition.',
      '',
      'If the opportunity is still active, please send the materials or let me know the next step in your process. I am happy to complete an NDA first.',
    ],
  };
}

export function buildDealHunterCimFollowUpEmail({
  to,
  request = {},
  followUpNumber = 1,
  requestedBy = '',
  communicationId = '',
} = {}) {
  const config = getConfig();
  const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  const businessName = normalizeText(request.deal_name || 'the listed business', 160);
  const requester = normalizeText(config.workflow?.defaultAssignee || requestedBy || request.requested_by || 'Mathew Uckele', 120);
  const listingUrl = normalizeUrl(request.listing_url || '');
  const copy = buildCimFollowUpCopy({ businessName, followUpNumber });
  const subject = `Re: CIM / NDA request for ${businessName}`;
  const details = [
    { label: 'Business', value: businessName },
    metadata.industry ? { label: 'Industry', value: metadata.industry } : null,
    metadata.location ? { label: 'Location', value: metadata.location } : null,
  ].filter(Boolean);
  const paragraphs = [
    'Hello,',
    ...copy.paragraphs,
    'Best,',
    requester,
    'Uckele Group',
  ];
  const text = [
    'Hello,',
    '',
    ...copy.textLines,
    '',
    'Deal details:',
    ...details.map((item) => `- ${item.label}: ${item.value}`),
    listingUrl ? `- Listing: ${listingUrl}` : '',
    '',
    'Best,',
    requester,
    'Uckele Group',
  ]
    .filter((line) => line !== '')
    .join('\n');
  const html = brandedEmailHtml({
    preheader: copy.preheader,
    title: subject,
    showTitle: false,
    paragraphs,
    details,
    ctas: listingUrl ? [{ label: 'View Listing', href: listingUrl }] : [],
  });

  return {
    communicationId,
    kind: 'deal-hunter-cim-follow-up',
    idempotencyKey: buildCimEmailIdempotencyKey({ requestId: request.id, followUpNumber }),
    to,
    replyTo: config.delivery.resendReplyTo
      ? buildCimReplyToAddress({ requestId: request.id, replyTo: config.delivery.resendReplyTo })
      : config.delivery.fallbackRecipient || '',
    subject,
    headline: subject,
    text,
    html,
    tags: [
      { name: 'source', value: 'deal-hunter-cim-follow-up' },
      { name: 'deal_key', value: normalizeText(request.deal_key || '', 250) },
      { name: 'cim_request_id', value: normalizeText(request.id || '', 250) },
      { name: 'submission_id', value: normalizeText(request.submission_id || '', 250) },
      { name: 'communication_id', value: normalizeText(communicationId, 250) },
      { name: 'follow_up_number', value: String(followUpNumber) },
    ],
    tracking: {
      source: 'deal-hunter-cim-follow-up',
      dealKey: request.deal_key || '',
      dealName: businessName,
      cimRequestId: request.id || '',
      submissionId: request.submission_id || '',
      communicationId,
      followUpNumber,
      requestedBy: requester,
    },
  };
}

export async function sendDealHunterCimFollowUpEmail(options) {
  if (!hasOnlyValidEmailRecipients(options?.to)) {
    return {
      status: 'failed',
      error: 'A valid broker or contact email is required before sending a CIM follow-up.',
      providerMessageId: '',
    };
  }

  return sendMessage(buildDealHunterCimFollowUpEmail(options));
}

export function buildAdminEmailTestEmail({ to, requestedBy = '', sentAt = new Date() } = {}) {
  const config = getConfig();
  const timestamp = sentAt instanceof Date ? sentAt.toISOString() : new Date(sentAt).toISOString();
  const requester = normalizeText(requestedBy || config.workflow?.defaultAssignee || 'admin', 120);
  const subject = `[TEST] Uckele Group email delivery verification ${timestamp}`;
  const text = [
    'This is a controlled Uckele Group email delivery test.',
    '',
    `Requested by: ${requester}`,
    `Sent at: ${timestamp}`,
    `Reply-to address: ${config.delivery.resendReplyTo || 'not configured'}`,
    '',
    'To verify inbound reply tracking, reply to this message without changing the subject.',
  ].join('\n');
  const html = brandedEmailHtml({
    preheader: 'Controlled Uckele Group email delivery and reply-tracking test.',
    eyebrow: 'Email Readiness Test',
    title: 'Verify delivery and reply tracking',
    paragraphs: [
      'This is a controlled Uckele Group email delivery test.',
      `Requested by ${requester} at ${timestamp}.`,
      'To verify inbound reply tracking, reply to this message without changing the subject.',
    ],
    details: [
      { label: 'Recipient', value: to },
      { label: 'Reply-to', value: config.delivery.resendReplyTo || 'Not configured' },
    ],
  });

  return {
    kind: 'admin-email-test',
    to,
    replyTo: config.delivery.resendReplyTo || '',
    subject,
    headline: 'Email delivery verification',
    text,
    html,
    tags: [
      { name: 'source', value: 'admin-email-test' },
      { name: 'requested_by', value: requester },
    ],
    tracking: {
      source: 'admin-email-test',
      requestedBy: requester,
      sentAt: timestamp,
    },
  };
}

export async function sendAdminEmailTestEmail(options) {
  if (!hasOnlyValidEmailRecipients(options?.to)) {
    return {
      status: 'failed',
      error: 'A configured internal test recipient is required.',
      providerMessageId: '',
    };
  }

  return sendMessage(buildAdminEmailTestEmail(options));
}

export async function sendAdminMagicLinkEmail({ to, magicLinkUrl, expiresAt, role = 'admin' }) {
  const expiryLabel = new Date(expiresAt).toLocaleString();
  const isViewer = role === 'viewer';
  const accessLabel = isViewer ? 'read-only' : 'admin';
  const subject = `Your Uckele Group ${accessLabel} sign-in link`;
  const text = [
    `A ${accessLabel} sign-in link was requested for Uckele Group.`,
    '',
    `Open this link to sign in: ${magicLinkUrl}`,
    `This link expires at: ${expiryLabel}`,
    '',
    'If you did not request this email, you can ignore it.',
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #18211D; line-height: 1.6;">
      <h2>${isViewer ? 'Read-only' : 'Admin'} sign-in link</h2>
      <p>Use the button below to securely sign in to the private Uckele Group ${isViewer ? 'viewer area' : 'admin area'}.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(magicLinkUrl)}" style="display: inline-block; background: #284638; color: #FFFFFF; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-weight: 700;">Open ${isViewer ? 'viewer access' : 'admin'}</a>
      </p>
      <p>This link expires at <strong>${escapeHtml(expiryLabel)}</strong>.</p>
      <p>If you did not request this email, you can ignore it.</p>
    </div>
  `;

  return sendMessage({
    kind: 'admin-magic-link',
    to,
    subject,
    headline: `${isViewer ? 'Read-only' : 'Admin'} sign-in link`,
    text,
    html,
  });
}

export async function sendSecureUploadInviteEmail({ to, contactName, uploadUrl, expiresAt, submission, note }) {
  const expiryLabel = new Date(expiresAt).toLocaleDateString();
  const subject = 'Secure document request from Uckele Group';
  const text = [
    `Hello ${contactName || 'there'},`,
    '',
    'A secure document upload link has been prepared for your business transition conversation with Uckele Group.',
    `Upload link: ${uploadUrl}`,
    `This link expires on: ${expiryLabel}`,
    '',
    note ? `Message from the buyer:\n${note}\n` : '',
    'You can use the link to review the confidentiality acknowledgement and share documents such as a teaser, CIM, financials, or supporting files.',
    '',
    `Reference: ${submission.company || submission.name}`,
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #18211D; line-height: 1.6;">
      <h2>Secure document request</h2>
      <p>Hello ${escapeHtml(contactName || 'there')},</p>
      <p>A secure document upload link has been prepared for your conversation with Uckele Group.</p>
      ${note ? `<p><strong>Message:</strong> ${escapeHtml(note)}</p>` : ''}
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(uploadUrl)}" style="display: inline-block; background: #284638; color: #FFFFFF; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-weight: 700;">Open secure upload</a>
      </p>
      <p>This link expires on <strong>${escapeHtml(expiryLabel)}</strong>.</p>
      <p>You can use it to share files such as a teaser, CIM, financials, or supporting transition documents.</p>
    </div>
  `;

  return sendMessage({
    kind: 'secure-upload-invite',
    to,
    subject,
    headline: 'Secure document request',
    text,
    html,
    tags: [
      { name: 'source', value: 'secure-upload-invite' },
      { name: 'submission_id', value: submission.id },
    ],
    tracking: {
      submissionId: submission.id,
      recipientEmail: to,
      source: 'secure-upload-invite',
    },
  });
}

export async function sendDocumentUploadNotificationEmail({ submission, request, documents }) {
  const config = getConfig();
  const subject = `Documents uploaded for ${submission.company || submission.name}`;
  const text = [
    'New secure documents have been uploaded.',
    '',
    `Submission: ${submission.name} (${submission.email})`,
    `Company: ${submission.company || 'Not provided'}`,
    `Upload request: ${request.id}`,
    `Uploaded at: ${request.last_uploaded_at || new Date().toISOString()}`,
    '',
    'Files:',
    ...documents.map((document) => `- ${document.original_name} (${document.document_type}, ${document.size_bytes} bytes)`),
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #18211D; line-height: 1.6;">
      <h2>New secure documents uploaded</h2>
      <p><strong>${escapeHtml(submission.name)}</strong> uploaded ${documents.length} file(s).</p>
      <ul>
        ${documents
          .map(
            (document) =>
              `<li>${escapeHtml(document.original_name)} <span style="color:#51615A;">(${escapeHtml(
                document.document_type,
              )})</span></li>`,
          )
          .join('')}
      </ul>
    </div>
  `;

  return sendMessage({
    kind: 'secure-upload-notice',
    to: config.delivery.fallbackRecipient,
    subject,
    headline: 'New secure documents uploaded',
    text,
    html,
  });
}
