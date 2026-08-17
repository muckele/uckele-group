import { randomUUID } from 'node:crypto';
import { getStorage } from '../storage/index.js';

const validEventTypePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function normalizeText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function buildCrmActivityEvent({
  submissionId,
  opportunityId = '',
  eventType,
  summary,
  actor = 'system',
  role = 'system',
  metadata = {},
  createdAt = new Date().toISOString(),
} = {}) {
  const normalizedSubmissionId = normalizeText(submissionId, 100);
  const normalizedEventType = normalizeText(eventType, 100).toLowerCase();
  const normalizedSummary = normalizeText(summary, 1000);

  if (!normalizedSubmissionId || !validEventTypePattern.test(normalizedEventType) || !normalizedSummary) {
    return null;
  }

  return {
    id: randomUUID(),
    submission_id: normalizedSubmissionId,
    opportunity_id: normalizeText(opportunityId, 160) || null,
    created_at: createdAt,
    actor: normalizeText(actor, 200) || 'system',
    role: normalizeText(role, 80) || 'system',
    event_type: normalizedEventType,
    summary: normalizedSummary,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
  };
}

export async function recordCrmActivity(options = {}) {
  const storage = options.storage || getStorage();
  const event = buildCrmActivityEvent(options);

  if (!event || !storage.insertCrmActivityEvent) {
    return null;
  }

  return storage.insertCrmActivityEvent(event);
}

export async function commitCrmActivityMutation({ storage = getStorage(), operation, payload = {}, activity } = {}) {
  const event = activity?.id && activity?.submission_id
    ? activity
    : buildCrmActivityEvent(activity);

  if (!event) {
    throw new Error(`CRM activity is required for the ${operation || 'unknown'} mutation.`);
  }

  if (!storage.mutateWithCrmActivity) {
    throw new Error('The configured storage provider does not support atomic CRM activity mutations.');
  }

  return storage.mutateWithCrmActivity({ operation, payload, activity: event });
}

export async function listCrmActivity({ submissionId, eventTypes = [], limit = 200, before = '', storage = getStorage() } = {}) {
  if (!storage.listCrmActivityEvents) {
    return [];
  }

  return storage.listCrmActivityEvents({
    submissionId: normalizeText(submissionId, 100),
    eventTypes: Array.isArray(eventTypes) ? eventTypes : [],
    limit,
    before,
  });
}

const emailLifecyclePrecedence = new Map([
  ['complained', 100],
  ['suppressed', 95],
  ['unsubscribed', 94],
  ['bounced', 90],
  ['failed', 85],
  ['replied', 80],
  ['delivered', 70],
  ['delayed', 60],
  ['sent', 50],
  ['accepted', 45],
  ['queued', 10],
]);

function activityEmailState(event = {}) {
  return String(event.event_type || '').replace(/^email[._-]/, '').replaceAll('_', '-').toLowerCase();
}

function logicalEmailKey(event = {}) {
  if (!String(event.event_type || '').startsWith('email.')) return '';
  const communicationId = normalizeText(event.metadata?.communicationId || event.metadata?.communication_id, 160);
  if (communicationId) return `communication:${communicationId}`;
  const provider = normalizeText(event.metadata?.provider, 80).toLowerCase();
  const messageId = normalizeText(event.metadata?.messageId || event.metadata?.message_id, 300);
  return provider && messageId ? `provider:${provider}:${messageId}` : '';
}

export function projectCrmActivityTimeline(events = []) {
  const groups = new Map();
  const projected = [];
  for (const event of events) {
    const key = logicalEmailKey(event);
    if (!key) {
      projected.push(event);
      continue;
    }
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }
  for (const [key, auditEvents] of groups) {
    const ordered = [...auditEvents].sort((left, right) => Date.parse(left.created_at || '') - Date.parse(right.created_at || ''));
    const current = [...ordered].sort((left, right) => (
      (emailLifecyclePrecedence.get(activityEmailState(right)) || 0) - (emailLifecyclePrecedence.get(activityEmailState(left)) || 0)
      || Date.parse(right.created_at || '') - Date.parse(left.created_at || '')
    ))[0];
    const firstLifecycleAt = ordered[0]?.created_at || current.created_at;
    const latestAt = ordered.at(-1)?.created_at || current.created_at;
    const followUpNumber = Number(ordered.map((event) => event.metadata?.followUpNumber || event.metadata?.tracking?.followUpNumber).find(Boolean) || 0);
    const kind = ordered.map((event) => event.metadata?.kind || event.metadata?.tracking?.kind).find(Boolean)
      || (followUpNumber > 0 ? 'cim-follow-up' : String(current.summary || '').toLowerCase().includes('cim') ? 'cim-request' : 'email');
    const state = activityEmailState(current);
    const subject = ordered.map((event) => event.metadata?.subject).find(Boolean)
      || String(current.summary || '').replace(/^Email\s+[^:]+:\s*/i, '');
    projected.push({
      ...current,
      id: `logical-email:${key}`,
      event_type: `email.${state}`,
      created_at: firstLifecycleAt,
      summary: `${followUpNumber > 0 ? `CIM follow-up ${followUpNumber}` : kind === 'cim-request' ? 'CIM request' : 'Email'} ${state}${subject ? `: ${subject}` : '.'}`,
      metadata: {
        ...(current.metadata || {}),
        logicalMessage: true,
        logicalKey: key,
        lifecycleState: state,
        firstLifecycleAt,
        latestLifecycleAt: latestAt,
        rawEventCount: ordered.length,
        auditEvents: ordered.map((event) => ({
          id: event.id,
          eventType: event.event_type,
          createdAt: event.created_at,
          actor: event.actor,
          role: event.role,
          provider: event.metadata?.provider || '',
          messageId: event.metadata?.messageId || '',
          communicationId: event.metadata?.communicationId || '',
        })),
      },
    });
  }
  projected.sort((left, right) => Date.parse(right.metadata?.latestLifecycleAt || right.created_at || '') - Date.parse(left.metadata?.latestLifecycleAt || left.created_at || ''));
  const rawEmailEvents = events.filter((event) => String(event.event_type || '').startsWith('email.')).length;
  const logicalEmails = projected.filter((event) => event.metadata?.logicalMessage).length;
  return {
    events: projected,
    counts: { logicalEmails, rawEmailEvents, totalLogicalItems: projected.length, totalRawEvents: events.length },
  };
}

export function summarizeSubmissionChanges(before = {}, updates = {}) {
  const ignored = new Set(['updated_at', 'expected_updated_at']);
  const changes = Object.entries(updates)
    .filter(([field, value]) => !ignored.has(field) && JSON.stringify(before?.[field] ?? null) !== JSON.stringify(value ?? null))
    .map(([field, value]) => ({
      field,
      before: before?.[field] ?? null,
      after: value ?? null,
    }));

  return changes;
}
