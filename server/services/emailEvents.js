import { createHmac, randomUUID } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import { safeCompareText } from '../utils/security.js';
import { commitCrmActivityMutation } from './activity.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const eventAliases = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.delivery.delayed': 'delayed',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.received': 'replied',
  'email.replied': 'replied',
  'email.unsubscribed': 'unsubscribed',
  open: 'opened',
  opened: 'opened',
  click: 'clicked',
  clicked: 'clicked',
  bounce: 'bounced',
  bounced: 'bounced',
  complaint: 'complained',
  complained: 'complained',
  delivered: 'delivered',
  'delivery.delayed': 'delayed',
  sent: 'sent',
  failed: 'failed',
  received: 'replied',
  reply: 'replied',
  replied: 'replied',
  unsubscribe: 'unsubscribed',
  unsubscribed: 'unsubscribed',
};

function normalizeText(value, maxLength = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return normalizeText(value, 200).toLowerCase();
}

function headerValue(value) {
  return Array.isArray(value) ? normalizeText(value[0], 500) : normalizeText(value, 500);
}

export function normalizeEmailEventType(value) {
  const normalized = normalizeText(value, 80).toLowerCase().replace(/_/g, '.');

  if (!normalized) {
    return 'unknown';
  }

  if (eventAliases[normalized]) {
    return eventAliases[normalized];
  }

  const withoutPrefix = normalized.replace(/^email\./, '');
  return eventAliases[withoutPrefix] || withoutPrefix || 'unknown';
}

function normalizeEventDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function firstEmail(value) {
  if (Array.isArray(value)) {
    return value.map(firstEmail).find(Boolean) || '';
  }

  if (value && typeof value === 'object') {
    return firstEmail(value.email || value.address || value.value || value.to);
  }

  const firstValue = normalizeText(String(value || '').split(',')[0], 500);
  const angleAddress = firstValue.match(/<([^<>@\s]+@[^<>\s]+)>/);
  const plainAddress = firstValue.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return normalizeEmail(angleAddress?.[1] || plainAddress?.[0] || firstValue);
}

function extractWebhookSecret(request) {
  const authorization = headerValue(request.headers.authorization);

  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return headerValue(request.headers['x-webhook-secret']) || headerValue(request.headers['x-resend-webhook-secret']);
}

function getSvixSigningKey(secret) {
  const normalized = normalizeText(secret, 500);
  const encodedSecret = normalized.startsWith('whsec_') ? normalized.slice(6) : normalized;

  try {
    const key = Buffer.from(encodedSecret, 'base64');
    return key.length > 0 ? key : Buffer.from(normalized);
  } catch {
    return Buffer.from(normalized);
  }
}

function parseSvixSignatures(value) {
  return headerValue(value)
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [version, signature] = item.split(',');
      return { version, signature };
    })
    .filter((item) => item.version === 'v1' && item.signature);
}

function verifySvixSignature(request, secret) {
  const svixId = headerValue(request.headers['svix-id']);
  const svixTimestamp = headerValue(request.headers['svix-timestamp']);
  const signatures = parseSvixSignatures(request.headers['svix-signature']);
  const timestampSeconds = Number(svixTimestamp);

  if (!svixId || !svixTimestamp || signatures.length === 0 || !Number.isFinite(timestampSeconds)) {
    return false;
  }

  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 60 * 5) {
    return false;
  }

  const rawBody = request.rawBody || JSON.stringify(request.body || {});
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const digest = createHmac('sha256', getSvixSigningKey(secret)).update(signedContent).digest('base64');

  return signatures.some((item) => safeCompareText(item.signature, digest));
}

function authorizeWebhook(request) {
  const config = getConfig();
  const expectedSecret = config.delivery.emailWebhookSecret;

  if (!expectedSecret) {
    return {
      ok: !config.isProduction,
      error: 'Email webhook events require EMAIL_WEBHOOK_SECRET or RESEND_WEBHOOK_SECRET in production.',
    };
  }

  if (request.headers['svix-id'] || request.headers['svix-signature'] || request.headers['svix-timestamp']) {
    return {
      ok: verifySvixSignature(request, expectedSecret),
      error: 'Invalid email webhook signature.',
    };
  }

  const providedSecret = extractWebhookSecret(request);
  return {
    ok: Boolean(providedSecret) && safeCompareText(providedSecret, expectedSecret),
    error: 'Invalid email webhook secret.',
  };
}

function extractTags(payload, data) {
  return data?.tags || payload?.tags || payload?.metadata?.tags || [];
}

function getTagValue(tags, key) {
  if (!tags) {
    return '';
  }

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string') {
        const [tagKey, ...rest] = tag.split('=');

        if (normalizeText(tagKey, 80) === key) {
          return normalizeText(rest.join('='), 240);
        }
      } else if (tag && typeof tag === 'object' && normalizeText(tag.name || tag.key, 80) === key) {
        return normalizeText(tag.value, 240);
      }
    }

    return '';
  }

  if (typeof tags === 'object') {
    return normalizeText(tags[key], 240);
  }

  return '';
}

function extractSubmissionId(payload, data, tags) {
  return (
    normalizeText(payload?.submission_id || payload?.submissionId, 80) ||
    normalizeText(data?.submission_id || data?.submissionId, 80) ||
    normalizeText(data?.metadata?.submission_id || data?.metadata?.submissionId, 80) ||
    getTagValue(tags, 'submission_id') ||
    getTagValue(tags, 'submissionId')
  );
}

async function resolveSubmissionId(storage, { submissionId, recipientEmail }) {
  if (submissionId && uuidPattern.test(submissionId)) {
    const submission = await storage.getSubmission(submissionId);

    if (submission) {
      return submission.id;
    }
  }

  if (!recipientEmail || !storage.getSubmissionByContactEmail) {
    return null;
  }

  const matchedSubmission = await storage.getSubmissionByContactEmail(recipientEmail);
  return matchedSubmission?.id || null;
}

function buildEventInputFromWebhook(payload) {
  const data = payload?.data || payload || {};
  const tags = extractTags(payload, data);
  const rawType = normalizeText(payload?.type || data?.type || payload?.event || data?.event || payload?.event_type || data?.event_type, 80);
  const eventType = normalizeEmailEventType(rawType);
  const outboundRecipientEmail = firstEmail(
    data.to || data.recipient || data.recipient_email || data.email || payload?.recipient || payload?.email,
  );
  const inboundSenderEmail = firstEmail(data.from || data.sender || data.reply_to || data.replyTo || payload?.from);
  const recipientEmail = rawType === 'email.received' || eventType === 'replied'
    ? inboundSenderEmail || outboundRecipientEmail
    : outboundRecipientEmail;
  const clickUrl = normalizeText(data.url || data.link?.url || data.link || data.click_url || data.clicked_url, 1000);

  return {
    created_at: data.created_at || data.createdAt || payload?.created_at || payload?.createdAt,
    provider: normalizeText(payload?.provider || data.provider || 'resend', 60),
    event_type: eventType,
    message_id: normalizeText(
      data.email_id || data.emailId || data.email?.id || data.message_id || data.messageId || payload?.email_id,
      240,
    ),
    provider_event_id: normalizeText(payload?.id || data.event_id || data.eventId || data.webhook_id || data.webhookId, 240),
    recipient_email: recipientEmail,
    subject: normalizeText(data.subject || payload?.subject, 300),
    submission_id: extractSubmissionId(payload, data, tags),
    source: 'webhook',
    metadata: {
      rawType,
      providerEventId: normalizeText(payload?.id, 240),
      tags,
      clickUrl,
      from: normalizeText(data.from || payload?.from, 500),
      fromEmail: inboundSenderEmail,
      to: data.to || payload?.to || '',
      toEmail: outboundRecipientEmail,
      replyTo: normalizeText(data.reply_to || data.replyTo || payload?.reply_to || payload?.replyTo, 500),
      inboundMessageId: normalizeText(data.message_id || data.messageId, 240),
      resendEmailId: normalizeText(data.email_id || data.emailId || data.email?.id, 240),
      userAgent: normalizeText(data.user_agent || data.userAgent, 300),
    },
  };
}

function buildEventKey(event) {
  if (event.provider_event_id) {
    return `${event.provider}:event:${event.provider_event_id}`;
  }

  if (event.source === 'webhook' && event.message_id && event.event_type && event.recipient_email && event.created_at) {
    return [
      event.provider,
      'message',
      event.message_id,
      event.event_type,
      event.recipient_email,
      event.created_at,
      event.metadata?.clickUrl || '',
    ].join(':');
  }

  return null;
}

export async function recordEmailEvent(input) {
  const storage = getStorage();
  const recipientEmail = normalizeEmail(input.recipient_email || input.recipientEmail);
  const eventType = normalizeEmailEventType(input.event_type || input.eventType);
  const explicitSubmissionId = normalizeText(input.submission_id || input.submissionId, 80);
  const submissionId = await resolveSubmissionId(storage, {
    submissionId: explicitSubmissionId,
    recipientEmail,
  });
  const provider = normalizeText(input.provider, 60) || 'unknown';
  const createdAt = normalizeEventDate(input.created_at || input.createdAt);
  const providerEventId = normalizeText(input.provider_event_id || input.providerEventId || input.metadata?.providerEventId, 240);
  const event = {
    id: input.id || randomUUID(),
    created_at: createdAt,
    provider,
    event_type: eventType,
    message_id: normalizeText(input.message_id || input.messageId, 240) || null,
    provider_event_id: providerEventId || null,
    recipient_email: recipientEmail || null,
    subject: normalizeText(input.subject, 300) || null,
    submission_id: submissionId,
    source: normalizeText(input.source, 100) || 'manual',
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };

  event.event_key = normalizeText(input.event_key || input.eventKey, 700) || buildEventKey(event);

  let storedEvent;

  if (event.submission_id) {
    const mutation = await commitCrmActivityMutation({
      storage,
      operation: 'insert_email_event',
      payload: { event },
      activity: {
        submissionId: event.submission_id,
        eventType: `email.${event.event_type}`,
        summary: `Email ${event.event_type}${event.subject ? `: ${event.subject}` : '.'}`,
        actor: event.recipient_email || event.provider,
        role: event.event_type === 'replied' ? 'contact' : 'email-provider',
        createdAt: event.created_at,
        metadata: {
          emailEventId: event.id,
          provider: event.provider,
          messageId: event.message_id,
          subject: event.subject,
        },
      },
    });
    storedEvent = mutation.record;
  } else {
    storedEvent = await storage.insertEmailEvent(event);
  }

  return storedEvent;
}

export async function recordEmailEventsFromWebhook(request) {
  const authorization = authorizeWebhook(request);

  if (!authorization.ok) {
    return {
      ok: false,
      status: 401,
      error: authorization.error,
    };
  }

  const payloads = Array.isArray(request.body) ? request.body : [request.body].filter(Boolean);

  if (payloads.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'Webhook payload is empty.',
    };
  }

  const events = [];

  for (const payload of payloads) {
    const event = await recordEmailEvent(buildEventInputFromWebhook(payload));
    events.push(event);
  }

  return {
    ok: true,
    status: 201,
    events,
  };
}

export function summarizeEmailEngagement(events = []) {
  const sortedEvents = [...events].sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''));
  const counts = sortedEvents.reduce(
    (accumulator, event) => {
      const eventType = normalizeEmailEventType(event.event_type);
      accumulator[eventType] = (accumulator[eventType] || 0) + 1;
      return accumulator;
    },
    {
      sent: 0,
      delivered: 0,
      delayed: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      unsubscribed: 0,
    },
  );
  const latestEvent = sortedEvents[0] || null;
  const suppressionEvent = counts.bounced || counts.complained || counts.failed || counts.unsubscribed;
  const rawScore =
    counts.delivered * 2 +
    counts.opened * 10 +
    counts.clicked * 30 +
    counts.replied * 50 -
    counts.delayed * 5 -
    counts.bounced * 75 -
    counts.complained * 100 -
    counts.failed * 40 -
    counts.unsubscribed * 100;
  const score = Math.max(0, Math.min(100, rawScore));
  const actionable = !suppressionEvent && (counts.replied > 0 || counts.clicked > 0 || counts.opened >= 2);
  const hot = actionable && score >= 30;

  let action = '';
  let tone = 'default';

  if (suppressionEvent) {
    tone = 'danger';
    action = 'Do not keep emailing until the contact details are verified.';
  } else if (counts.replied > 0) {
    tone = 'success';
    action = 'They replied. Update the record and move the conversation forward.';
  } else if (counts.clicked > 0) {
    tone = 'success';
    action = 'They clicked a link. Call or send a direct follow-up today.';
  } else if (counts.opened >= 2) {
    tone = 'warning';
    action = 'They opened more than once. Follow up while the request is fresh.';
  } else if (counts.opened === 1) {
    tone = 'info';
    action = 'They opened once. Send a short follow-up if they do not respond.';
  } else if (counts.sent || counts.delivered) {
    action = 'Email sent. Wait for engagement or follow the normal reminder date.';
  }

  return {
    total: sortedEvents.length,
    score,
    sent: counts.sent,
    delivered: counts.delivered,
    delayed: counts.delayed,
    opened: counts.opened,
    clicked: counts.clicked,
    replied: counts.replied,
    bounced: counts.bounced,
    complained: counts.complained,
    failed: counts.failed,
    unsubscribed: counts.unsubscribed,
    last_event_at: latestEvent?.created_at || '',
    latest_event_type: latestEvent ? normalizeEmailEventType(latestEvent.event_type) : '',
    latest_subject: latestEvent?.subject || '',
    actionable,
    hot,
    tone,
    action,
  };
}
