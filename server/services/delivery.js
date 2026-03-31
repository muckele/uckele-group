import { getConfig } from '../config.js';

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

async function sendViaConsole(message) {
  console.log(`[mail:${message.kind}] to=${normalizeRecipients(message.to).join(', ')} subject=${message.subject}`);
  console.log(message.text);
  return { status: 'logged', error: '' };
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
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      status: 'failed',
      error: `Resend delivery failed with ${response.status}: ${text.slice(0, 240)}`,
    };
  }

  return { status: 'sent', error: '' };
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

  return { status: 'sent', error: '' };
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

  return { status: 'sent', error: '' };
}

async function sendMessage(message) {
  const config = getConfig();

  switch (config.delivery.provider) {
    case 'resend':
      return sendViaResend(message);
    case 'emailjs':
      return sendViaEmailJs(message);
    case 'formspree':
      return sendViaFormspree(message);
    case 'console':
    default:
      return sendViaConsole(message);
  }
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
