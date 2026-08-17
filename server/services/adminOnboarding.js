import {
  ADMIN_ONBOARDING_STATUSES,
  adminOnboardingTours,
  getAdminOnboardingStepIds,
  getAdminOnboardingTour,
  isAdminOnboardingRoleEligible,
} from '../../shared/adminOnboarding.js';
import { getStorage } from '../storage/index.js';

const allowedUpdateFields = new Set(['tourVersion', 'status', 'lastCompletedStepId']);

export class AdminOnboardingRequestError extends Error {
  constructor(message, { status = 400, code = 'invalid_request' } = {}) {
    super(message);
    this.name = 'AdminOnboardingRequestError';
    this.status = status;
    this.code = code;
  }
}

function requestError(message, code, status = 400) {
  return new AdminOnboardingRequestError(message, { code, status });
}

function assertSession(session) {
  if (
    !session
    || typeof session.principal_id !== 'string'
    || !session.principal_id.trim()
    || !['admin', 'viewer'].includes(session.role)
  ) {
    throw requestError('Unauthorized.', 'unauthenticated', 401);
  }
}

function toPublicProgress(row) {
  return {
    tourKey: row.tour_key,
    tourVersion: Number(row.tour_version),
    status: row.status,
    lastCompletedStepId: row.last_completed_step_id || null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    skippedAt: row.skipped_at || null,
  };
}

function isCurrentBoundedProgress(row, role) {
  const definition = getAdminOnboardingTour(row?.tour_key);
  if (!definition || definition.version !== Number(row.tour_version)) return false;
  if (!definition.roles.includes(role) || !ADMIN_ONBOARDING_STATUSES.includes(row.status)) return false;
  if (!row.last_completed_step_id) return true;
  return getAdminOnboardingStepIds(definition.key, role).includes(row.last_completed_step_id);
}

export async function listAdminOnboardingProgressForSession(
  session,
  { storage = getStorage() } = {},
) {
  assertSession(session);
  const rows = await storage.listAdminOnboardingProgress(session.principal_id);

  return rows
    .filter((row) => isCurrentBoundedProgress(row, session.role))
    .map(toPublicProgress);
}

export async function updateAdminOnboardingProgressForSession(
  session,
  tourKey,
  body,
  { storage = getStorage(), now = () => new Date() } = {},
) {
  assertSession(session);
  const definition = getAdminOnboardingTour(tourKey);

  if (!definition) {
    throw requestError('Unknown onboarding tour.', 'unknown_tour');
  }
  if (!isAdminOnboardingRoleEligible(tourKey, session.role)) {
    throw requestError('This onboarding tour is not available for the current role.', 'role_ineligible', 403);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('The onboarding update body must be an object.', 'invalid_body');
  }
  if (Object.keys(body).some((field) => !allowedUpdateFields.has(field))) {
    throw requestError('The onboarding update contains unsupported fields.', 'invalid_body');
  }
  if (!Number.isSafeInteger(body.tourVersion) || body.tourVersion !== definition.version) {
    throw requestError('The onboarding tour version is unsupported.', 'unsupported_version');
  }
  if (!ADMIN_ONBOARDING_STATUSES.includes(body.status)) {
    throw requestError('The onboarding status is invalid.', 'invalid_status');
  }

  const validStepIds = getAdminOnboardingStepIds(tourKey, session.role);
  if (
    Object.hasOwn(body, 'lastCompletedStepId')
    && body.lastCompletedStepId !== null
    && (typeof body.lastCompletedStepId !== 'string' || !validStepIds.includes(body.lastCompletedStepId))
  ) {
    throw requestError('The onboarding step is invalid for this tour and role.', 'invalid_step');
  }

  const existingRows = await storage.listAdminOnboardingProgress(session.principal_id);
  const existing = existingRows.find((row) => (
    row.tour_key === tourKey && Number(row.tour_version) === definition.version
  ));
  const timestamp = now().toISOString();
  const lastCompletedStepId = Object.hasOwn(body, 'lastCompletedStepId')
    ? body.lastCompletedStepId
    : existing?.last_completed_step_id || null;
  if (lastCompletedStepId && !validStepIds.includes(lastCompletedStepId)) {
    throw requestError('The onboarding step is invalid for this tour and role.', 'invalid_step');
  }
  if (body.status === 'completed' && !lastCompletedStepId) {
    throw requestError('A completed onboarding tour requires a completed step.', 'invalid_step');
  }
  const saved = await storage.upsertAdminOnboardingProgress({
    principal_id: session.principal_id,
    tour_key: definition.key,
    tour_version: definition.version,
    status: body.status,
    last_completed_step_id: lastCompletedStepId,
    started_at: existing?.started_at || timestamp,
    updated_at: timestamp,
    completed_at: body.status === 'completed' ? timestamp : null,
    skipped_at: body.status === 'skipped' ? timestamp : null,
    valid_step_ids: validStepIds,
  });

  return toPublicProgress(saved);
}

export function listAvailableAdminOnboardingTours(role) {
  return Object.values(adminOnboardingTours)
    .filter((definition) => definition.roles.includes(role))
    .map((definition) => ({
      tourKey: definition.key,
      tourVersion: definition.version,
      scope: definition.scope,
      stepIds: getAdminOnboardingStepIds(definition.key, role),
    }));
}
