import { randomUUID } from 'node:crypto';
import { getStorage } from '../storage/index.js';

const validEventTypePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function normalizeText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function buildCrmActivityEvent({
  submissionId,
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
