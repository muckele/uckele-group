import { getConfig } from '../config.js';
import { recordEmailEvent } from './emailEvents.js';

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

function normalizeText(value = '', maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
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
                <a href="${escapeHtml(normalizeUrl(cta.href))}" style="display: inline-block; border: 1px solid ${border}; border-radius: 999px; background: ${background}; color: ${color}; font-size: 14px; font-weight: 700; line-height: 1; padding: 14px 18px; text-decoration: none;">${escapeHtml(cta.label)}</a>
              </td>
            `;
          })
          .join('')}
      </tr>
    </table>
  `;
}

function brandedEmailHtml({ preheader = '', eyebrow = '', title, paragraphs = [], bodyHtml = '', details = [], ctas = [], footerNote = '' }) {
  const config = getConfig();
  const websiteUrl = normalizeUrl(config.brand.websiteUrl || config.server.origin);
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
                        <td>
                          <div style="display: inline-block; height: 40px; width: 40px; border-radius: 10px; background: #284638; color: #FFFFFF; font-size: 14px; font-weight: 800; line-height: 40px; text-align: center;">UG</div>
                          <span style="display: inline-block; margin-left: 10px; color: #18211D; font-size: 18px; font-weight: 800; vertical-align: middle;">${escapeHtml(config.brand.companyName)}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="border: 1px solid #E3D9CA; border-radius: 18px; background: #FFFFFF; padding: 34px;">
                    ${eyebrow ? `<p style="margin: 0 0 12px; color: #7A5A3B; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase;">${escapeHtml(eyebrow)}</p>` : ''}
                    <h1 style="margin: 0 0 18px; color: #18211D; font-size: 28px; line-height: 1.22;">${escapeHtml(title)}</h1>
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
  console.log(`[mail:${message.kind}] to=${normalizeRecipients(message.to).join(', ')} subject=${message.subject}`);
  console.log(message.text);
  return { status: 'logged', error: '', providerMessageId: '' };
}

async function sendViaResend(message) {
  const config = getConfig();

  if (!config.delivery.resendApiKey || !config.delivery.resendFromEmail) {
    return { status: 'failed', error: 'Resend is selected but RESEND_API_KEY or RESEND_FROM_EMAIL is missing.' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.delivery.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.delivery.resendFromEmail,
      to: normalizeRecipients(message.to),
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.replyTo || undefined,
      headers: message.headers || undefined,
      tags: Array.isArray(message.tags) && message.tags.length > 0 ? message.tags : undefined,
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

  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
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

  const response = await fetch(config.delivery.formspreeEndpoint, {
    method: 'POST',
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

export async function sendMessage(message) {
  const config = getConfig();
  let result;

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

function buildSubmissionMessage(submission) {
  const serviceInterest = submission.prospectus_url || submission.metadata?.serviceInterest || 'Not provided';
  const timeline = submission.metadata?.timeline || 'Not provided';
  const subject = `New website audit request from ${submission.name}`;
  const text = [
    'New inbound website audit request',
    '',
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Phone: ${submission.phone || 'Not provided'}`,
    `Company: ${submission.company || 'Not provided'}`,
    `Website: ${submission.business_website || 'Not provided'}`,
    `Role: ${submission.role || 'Not provided'}`,
    `Service interest: ${serviceInterest}`,
    `Timeline: ${timeline}`,
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
      <h2 style="margin-bottom: 16px;">New inbound website audit request</h2>
      <table cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Name</strong></td><td>${escapeHtml(submission.name)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Email</strong></td><td>${escapeHtml(submission.email)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Phone</strong></td><td>${escapeHtml(submission.phone || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Company</strong></td><td>${escapeHtml(submission.company || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Website</strong></td><td>${escapeHtml(submission.business_website || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Role</strong></td><td>${escapeHtml(submission.role || 'Not provided')}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Service interest</strong></td><td>${escapeHtml(serviceInterest)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0;"><strong>Timeline</strong></td><td>${escapeHtml(timeline)}</td></tr>
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
    to: getConfig().delivery.fallbackRecipient,
    replyTo: submission.email || getConfig().delivery.resendReplyTo || '',
    subject,
    headline: 'New inbound website audit request',
    text,
    html,
    formspreePayload: {
      name: submission.name,
      email: submission.email,
      phone: submission.phone,
      company: submission.company,
      business_website: submission.business_website,
      role: submission.role,
      service_interest: serviceInterest,
      timeline,
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

export async function sendAdminMagicLinkEmail({ to, magicLinkUrl, expiresAt }) {
  const expiryLabel = new Date(expiresAt).toLocaleString();
  const subject = 'Your Uckele Group admin sign-in link';
  const text = [
    'An admin sign-in link was requested for Uckele Group.',
    '',
    `Open this link to sign in: ${magicLinkUrl}`,
    `This link expires at: ${expiryLabel}`,
    '',
    'If you did not request this email, you can ignore it.',
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #18211D; line-height: 1.6;">
      <h2>Admin sign-in link</h2>
      <p>Use the button below to securely sign in to the private Uckele Group admin area.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(magicLinkUrl)}" style="display: inline-block; background: #284638; color: #FFFFFF; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-weight: 700;">Open admin</a>
      </p>
      <p>This link expires at <strong>${escapeHtml(expiryLabel)}</strong>.</p>
      <p>If you did not request this email, you can ignore it.</p>
    </div>
  `;

  return sendMessage({
    kind: 'admin-magic-link',
    to,
    subject,
    headline: 'Admin sign-in link',
    text,
    html,
  });
}

export async function sendSecureUploadInviteEmail({ to, contactName, uploadUrl, expiresAt, submission, note }) {
  const expiryLabel = new Date(expiresAt).toLocaleDateString();
  const subject = 'Secure onboarding upload request from Uckele Group';
  const text = [
    `Hello ${contactName || 'there'},`,
    '',
    'A secure upload link has been prepared for your website support or onboarding conversation with Uckele Group.',
    `Upload link: ${uploadUrl}`,
    `This link expires on: ${expiryLabel}`,
    '',
    note ? `Message from Mathew:\n${note}\n` : '',
    'You can use the link to review the confidentiality acknowledgement and share files such as website assets, brand files, service lists, analytics exports, or platform notes.',
    '',
    `Reference: ${submission.company || submission.name}`,
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; color: #18211D; line-height: 1.6;">
      <h2>Secure onboarding upload request</h2>
      <p>Hello ${escapeHtml(contactName || 'there')},</p>
      <p>A secure upload link has been prepared for your website support or onboarding conversation with Uckele Group.</p>
      ${note ? `<p><strong>Message:</strong> ${escapeHtml(note)}</p>` : ''}
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(uploadUrl)}" style="display: inline-block; background: #284638; color: #FFFFFF; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-weight: 700;">Open secure upload</a>
      </p>
      <p>This link expires on <strong>${escapeHtml(expiryLabel)}</strong>.</p>
      <p>You can use it to share website assets, brand files, service lists, analytics exports, platform notes, or other onboarding materials.</p>
    </div>
  `;

  return sendMessage({
    kind: 'secure-upload-invite',
    to,
    subject,
    headline: 'Secure onboarding upload request',
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
