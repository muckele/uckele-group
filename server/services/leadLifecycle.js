import { randomUUID } from 'node:crypto';
import { getStorage } from '../storage/index.js';
import { commitCrmActivityMutation } from './activity.js';

export const archiveReasons = [
  'not-a-fit',
  'unavailable',
  'duplicate',
  'broker-declined',
  'valuation',
  'geography',
  'timing',
  'financing',
  'other',
];

const restoreStatuses = new Set(['new', 'review', 'contacted']);

function compactText(value, maxLength = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeDealHunterListingUrl(value = '') {
  const normalized = compactText(value, 1000).toLowerCase();
  if (!normalized) return '';
  const withProtocol = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().toLowerCase() : '';
  } catch {
    return '';
  }
}

function listingUrlFromDealKey(dealKey = '') {
  const normalized = compactText(dealKey, 1000);
  return normalized.startsWith('url:') ? normalizeDealHunterListingUrl(normalized.slice(4)) : '';
}

function normalizeArchiveReason(value) {
  const normalized = compactText(value, 80).toLowerCase().replace(/[ _]+/g, '-');
  return archiveReasons.includes(normalized) ? normalized : '';
}

function archiveSummary(reason) {
  return `Lead archived: ${reason.replace(/-/g, ' ')}.`;
}

export async function archiveLead({
  submissionId = '',
  reason = '',
  note = '',
  communicationId = '',
  expectedUpdatedAt = '',
  actor = 'admin',
  role = 'admin',
  metadataPatch = {},
  storage = getStorage(),
} = {}) {
  const id = compactText(submissionId, 120);
  const normalizedReason = normalizeArchiveReason(reason);
  const existing = id ? await storage.getSubmission(id) : null;

  if (!existing) return { ok: false, status: 404, error: 'CRM record not found.' };
  if (!normalizedReason) return { ok: false, status: 400, error: 'A valid archive disposition reason is required.' };
  if (existing.status === 'archived') return { ok: false, status: 409, error: 'Lead is already archived.', submission: existing };

  const triggerId = compactText(communicationId, 120);
  if (triggerId) {
    const communication = await storage.getCrmCommunication?.(triggerId);
    if (!communication || communication.submission_id !== existing.id) {
      return { ok: false, status: 400, error: 'The triggering communication is not linked to this CRM record.' };
    }
  }

  const now = new Date().toISOString();
  const expectedVersion = compactText(expectedUpdatedAt, 80) || existing.updated_at;
  const existingMetadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? existing.metadata
    : {};
  const values = {
    updated_at: now,
    status: 'archived',
    status_updated_at: now,
    follow_up_state: 'completed',
    next_action_at: null,
    archived_at: now,
    archived_by: compactText(actor, 160) || 'admin',
    archive_reason: normalizedReason,
    archive_note: compactText(note, 2000) || null,
    archive_communication_id: triggerId || null,
    metadata: {
      ...existingMetadata,
      ...(metadataPatch && typeof metadataPatch === 'object' && !Array.isArray(metadataPatch) ? metadataPatch : {}),
      leadArchive: {
        previousStatus: existing.status,
        archivedAt: now,
        archivedBy: compactText(actor, 160) || 'admin',
        reason: normalizedReason,
        communicationId: triggerId,
      },
    },
  };
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'archive_submission',
    payload: { id: existing.id, expectedUpdatedAt: expectedVersion, values },
    activity: {
      submissionId: existing.id,
      eventType: 'submission.archived',
      summary: archiveSummary(normalizedReason),
      actor: compactText(actor, 160) || 'admin',
      role,
      metadata: {
        archiveReason: normalizedReason,
        communicationId: triggerId,
        previousStatus: existing.status,
      },
    },
  });

  if (!mutation.applied || !mutation.record) {
    return { ok: false, status: 409, error: 'Lead state changed before the archive could be saved.' };
  }
  return { ok: true, status: 200, submission: mutation.record };
}

export async function restoreLead({
  submissionId = '',
  status = 'review',
  expectedUpdatedAt = '',
  actor = 'admin',
  role = 'admin',
  storage = getStorage(),
} = {}) {
  const id = compactText(submissionId, 120);
  const nextStatus = compactText(status, 40).toLowerCase();
  const existing = id ? await storage.getSubmission(id) : null;

  if (!existing) return { ok: false, status: 404, error: 'CRM record not found.' };
  if (existing.status !== 'archived') return { ok: false, status: 409, error: 'Only an archived lead can be restored.' };
  if (!restoreStatuses.has(nextStatus)) return { ok: false, status: 400, error: 'Restore status must be new, review, or contacted.' };

  const now = new Date().toISOString();
  const expectedVersion = compactText(expectedUpdatedAt, 80) || existing.updated_at;
  const values = {
    updated_at: now,
    status: nextStatus,
    status_updated_at: now,
    restored_at: now,
    restored_by: compactText(actor, 160) || 'admin',
    // Restoring a record never restarts outreach. The administrator must schedule a new action explicitly.
    follow_up_state: 'completed',
    next_action_at: null,
  };
  const mutation = await commitCrmActivityMutation({
    storage,
    operation: 'update_submission',
    payload: { id: existing.id, expectedUpdatedAt: expectedVersion, values },
    activity: {
      submissionId: existing.id,
      eventType: 'submission.restored',
      summary: `Archived lead restored to ${nextStatus}. Outreach remains stopped.`,
      actor: compactText(actor, 160) || 'admin',
      role,
      metadata: { restoredStatus: nextStatus, outreachRestarted: false },
    },
  });

  if (!mutation.applied || !mutation.record) {
    return { ok: false, status: 409, error: 'Lead state changed before the restore could be saved.' };
  }
  return { ok: true, status: 200, submission: mutation.record };
}

function mapDealHunterReason(reason) {
  const normalized = compactText(reason, 80).toLowerCase().replace(/[ _]+/g, '-');
  if (archiveReasons.includes(normalized)) return normalized;
  if (['industry', 'quality', 'owner-dependence', 'profit', 'recipient'].includes(normalized)) return 'not-a-fit';
  return normalized ? 'other' : '';
}

export async function dismissDealHunterOpportunity({
  dealKey = '',
  listingUrl = '',
  dealName = '',
  reason = '',
  note = '',
  submissionId = '',
  actor = 'admin',
  storage = getStorage(),
} = {}) {
  const normalizedDealKey = compactText(dealKey, 1000);
  const normalizedReason = mapDealHunterReason(reason);
  if (!normalizedDealKey) return { ok: false, status: 400, error: 'Deal key is required.' };
  if (!normalizedReason) return { ok: false, status: 400, error: 'A disposition reason is required.' };

  const dealKeyListingUrl = listingUrlFromDealKey(normalizedDealKey);
  const suppliedListingUrl = normalizeDealHunterListingUrl(listingUrl);
  if (dealKeyListingUrl && suppliedListingUrl && suppliedListingUrl !== dealKeyListingUrl) {
    return { ok: false, status: 409, error: 'The listing URL does not match this Deal Hunter opportunity key.' };
  }

  const requestedSubmissionId = compactText(submissionId, 120);
  const importRecord = await storage.getDealHunterCrmImport?.({ dealKey: normalizedDealKey }) || null;
  const linkedCimRequests = requestedSubmissionId && storage.listDealHunterCimRequests
    ? await storage.listDealHunterCimRequests({ dealKeys: [normalizedDealKey], limit: 100 })
    : [];
  let linkedSubmission = requestedSubmissionId ? await storage.getSubmission(requestedSubmissionId) : null;

  if (requestedSubmissionId) {
    if (!linkedSubmission) {
      return { ok: false, status: 404, error: 'The supplied CRM record was not found.' };
    }

    const metadataDealKey = compactText(linkedSubmission.metadata?.dealHunter?.dealKey, 1000);
    const storedListingMatchesDealKey = Boolean(
      dealKeyListingUrl
        && normalizeDealHunterListingUrl(linkedSubmission.listing_url) === dealKeyListingUrl,
    );
    const authoritativeSubmissionIds = [
      metadataDealKey === normalizedDealKey ? linkedSubmission.id : '',
      importRecord?.submission_id || '',
      storedListingMatchesDealKey ? linkedSubmission.id : '',
      ...linkedCimRequests
        .filter((request) => request?.deal_key === normalizedDealKey)
        .map((request) => request.submission_id || ''),
    ].filter(Boolean);
    const hasConflictingMetadata = Boolean(metadataDealKey && metadataDealKey !== normalizedDealKey);
    const hasConflictingLink = authoritativeSubmissionIds.some((id) => id !== requestedSubmissionId);
    const hasAuthoritativeMatch = authoritativeSubmissionIds.includes(requestedSubmissionId);

    if (hasConflictingMetadata || hasConflictingLink || !hasAuthoritativeMatch) {
      return {
        ok: false,
        status: 409,
        error: 'The supplied CRM record is not authoritatively linked to this Deal Hunter opportunity.',
      };
    }
  } else {
    if (importRecord?.submission_id) linkedSubmission = await storage.getSubmission(importRecord.submission_id);
    if (!linkedSubmission && dealKeyListingUrl && storage.getSubmissionByListingUrl) {
      linkedSubmission = await storage.getSubmissionByListingUrl(dealKeyListingUrl);
    }
  }

  const now = new Date().toISOString();
  const normalizedActor = compactText(actor, 160) || 'admin';
  const dispositionRecord = {
    id: randomUUID(),
    deal_key: normalizedDealKey,
    listing_url: compactText(dealKeyListingUrl || listingUrl, 1000) || null,
    deal_name: compactText(dealName, 220) || null,
    submission_id: linkedSubmission?.id || null,
    disposition: 'dismissed',
    reason: normalizedReason,
    note: compactText(note, 2000) || null,
    dismissed_at: now,
    dismissed_by: normalizedActor,
    created_at: now,
    updated_at: now,
    created_by: normalizedActor,
    updated_by: normalizedActor,
    metadata: {},
  };

  if (linkedSubmission && linkedSubmission.status !== 'archived') {
    const existingMetadata = linkedSubmission.metadata && typeof linkedSubmission.metadata === 'object' && !Array.isArray(linkedSubmission.metadata)
      ? linkedSubmission.metadata
      : {};
    const values = {
      updated_at: now,
      status: 'archived',
      status_updated_at: now,
      follow_up_state: 'completed',
      next_action_at: null,
      archived_at: now,
      archived_by: normalizedActor,
      archive_reason: normalizedReason,
      archive_note: dispositionRecord.note,
      archive_communication_id: null,
      metadata: {
        ...existingMetadata,
        acquisitionCommand: {
          ...(existingMetadata.acquisitionCommand || {}),
          pipelineStage: 'passed',
          passReason: normalizedReason,
          fitFeedback: 'false-positive',
          updatedAt: now,
          updatedBy: normalizedActor,
        },
        leadArchive: {
          previousStatus: linkedSubmission.status,
          archivedAt: now,
          archivedBy: normalizedActor,
          reason: normalizedReason,
          communicationId: '',
        },
      },
    };
    const mutation = await commitCrmActivityMutation({
      storage,
      operation: 'dismiss_deal_hunter_opportunity',
      payload: {
        submissionId: linkedSubmission.id,
        expectedUpdatedAt: linkedSubmission.updated_at,
        values,
        disposition: dispositionRecord,
      },
      activity: {
        submissionId: linkedSubmission.id,
        eventType: 'submission.archived',
        summary: archiveSummary(normalizedReason),
        actor: normalizedActor,
        role: 'admin',
        metadata: {
          archiveReason: normalizedReason,
          communicationId: '',
          previousStatus: linkedSubmission.status,
          dealKey: normalizedDealKey,
          dispositionId: dispositionRecord.id,
        },
      },
    });

    if (!mutation.applied || !mutation.record?.submission || !mutation.record?.disposition) {
      return { ok: false, status: 409, error: 'Lead state changed before the dismissal could be saved.' };
    }

    return {
      ok: true,
      status: 200,
      disposition: mutation.record.disposition,
      submission: mutation.record.submission,
      archived: true,
    };
  }

  const disposition = await storage.upsertDealHunterDisposition(dispositionRecord);

  return {
    ok: true,
    status: 200,
    disposition,
    submission: linkedSubmission || null,
    archived: linkedSubmission?.status === 'archived',
  };
}

export async function restoreDealHunterOpportunity({ dealKey = '', actor = 'admin', storage = getStorage() } = {}) {
  const normalizedDealKey = compactText(dealKey, 1000);
  const existing = normalizedDealKey ? await storage.getDealHunterDisposition?.({ dealKey: normalizedDealKey }) : null;
  if (!existing) return { ok: false, status: 404, error: 'Deal Hunter disposition not found.' };
  const now = new Date().toISOString();
  const disposition = await storage.upsertDealHunterDisposition({
    ...existing,
    disposition: 'restored',
    updated_at: now,
    updated_by: compactText(actor, 160) || 'admin',
    restored_at: now,
    restored_by: compactText(actor, 160) || 'admin',
  });
  return { ok: true, status: 200, disposition };
}
