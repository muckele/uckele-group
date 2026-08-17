export const ADMIN_ONBOARDING_STATUSES = Object.freeze(['in_progress', 'completed', 'skipped']);

const allRoles = Object.freeze(['admin', 'viewer']);
const adminOnly = Object.freeze(['admin']);

function step(id, roles = allRoles) {
  return Object.freeze({ id, roles });
}

function tour({ key, scope, roles = allRoles, automatic = false, steps }) {
  return Object.freeze({
    key,
    version: 1,
    scope,
    roles,
    automatic,
    steps: Object.freeze(steps),
  });
}

export const adminOnboardingTours = Object.freeze({
  'admin-foundations': tour({
    key: 'admin-foundations',
    scope: 'overview',
    automatic: true,
    steps: [
      step('foundations-welcome'),
      step('foundations-section-navigation'),
      step('foundations-overview-priorities'),
      step('foundations-workspace-launcher'),
      step('foundations-page-guide'),
    ],
  }),
  'crm-index': tour({
    key: 'crm-index',
    scope: 'crm-index',
    steps: [
      step('crm-index-filters'),
      step('crm-index-results'),
      step('crm-index-open-record'),
    ],
  }),
  'crm-detail': tour({
    key: 'crm-detail',
    scope: 'crm-detail',
    steps: [
      step('crm-detail-workflow'),
      step('crm-detail-next-action'),
      step('crm-detail-communications-documents'),
      step('crm-detail-record-discipline'),
    ],
  }),
  'command-center': tour({
    key: 'command-center',
    scope: 'command-center',
    steps: [
      step('command-center-action-queue'),
      step('command-center-source-health'),
      step('command-center-pipeline'),
    ],
  }),
  'deal-hunter': tour({
    key: 'deal-hunter',
    scope: 'deal-hunter',
    steps: [
      step('deal-hunter-source-state'),
      step('deal-hunter-review-buckets'),
      step('deal-hunter-cim-workflow', adminOnly),
      step('deal-hunter-history'),
    ],
  }),
  'follow-ups': tour({
    key: 'follow-ups',
    scope: 'follow-ups',
    steps: [
      step('follow-ups-priority-filters'),
      step('follow-ups-queue'),
      step('follow-ups-next-action'),
      step('follow-ups-email-controls', adminOnly),
    ],
  }),
  operations: tour({
    key: 'operations',
    scope: 'operations',
    roles: adminOnly,
    steps: [
      step('operations-readiness', adminOnly),
      step('operations-history', adminOnly),
      step('operations-storage', adminOnly),
    ],
  }),
  'new-record': tour({
    key: 'new-record',
    scope: 'new-record',
    roles: adminOnly,
    steps: [
      step('new-record-basics', adminOnly),
      step('new-record-economics', adminOnly),
      step('new-record-next-action', adminOnly),
    ],
  }),
});

export function getAdminOnboardingTour(tourKey) {
  return adminOnboardingTours[tourKey] || null;
}

export function isAdminOnboardingRoleEligible(tourKey, role) {
  const definition = getAdminOnboardingTour(tourKey);
  return Boolean(definition?.roles.includes(role));
}

export function getAdminOnboardingStepIds(tourKey, role) {
  const definition = getAdminOnboardingTour(tourKey);

  if (!definition || !definition.roles.includes(role)) {
    return [];
  }

  return definition.steps
    .filter((item) => item.roles.includes(role))
    .map((item) => item.id);
}

export function getAdminOnboardingTourKeyForScope(scope, role) {
  const match = Object.values(adminOnboardingTours)
    .find((definition) => definition.scope === scope && definition.roles.includes(role));
  return match?.key || null;
}
