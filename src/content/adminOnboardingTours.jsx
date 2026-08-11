import {
  getAdminOnboardingStepIds,
  getAdminOnboardingTour,
  isAdminOnboardingRoleEligible,
} from '../../shared/adminOnboarding.js';

const tourStepPresentation = {
  'foundations-welcome': {
    target: '[data-admin-tour="page-guidance"]',
    placement: 'center',
    title: 'Welcome to the acquisition workspace',
    content: 'Use this private workspace to see what needs attention, then move into the focused page for the task at hand.',
  },
  'foundations-section-navigation': {
    target: '[data-admin-tour="section-navigation"]',
    title: 'Move between focused workspaces',
    content: 'Each section keeps one operating workflow in view. The navigation stays available as you review the day.',
  },
  'foundations-overview-priorities': {
    target: '[data-admin-tour="overview-priorities"]',
    title: 'Start with today’s priorities',
    content: 'Work overdue items and action items first. These cards open the relevant queue without changing data themselves.',
  },
  'foundations-workspace-launcher': {
    target: '[data-admin-tour="workspace-launcher"]',
    title: 'Choose the workspace for the job',
    content: 'After urgent work is clear, open the focused workspace that matches the next concrete task.',
  },
  'foundations-page-guide': {
    target: '[data-admin-tour="guide-action"]',
    placement: 'bottom-end',
    title: 'Replay guidance whenever you need it',
    content: 'Guide this page always opens the short guide for your current workspace. Other page guides never start automatically.',
  },
  'crm-index-filters': {
    target: '[data-admin-tour="crm-filters"]',
    title: 'Narrow the CRM deliberately',
    content: 'Use search, status, date, direction, and sort controls to discover the right relationships without scanning every record.',
  },
  'crm-index-results': {
    target: '[data-admin-tour="crm-results"]',
    title: 'Read the result count first',
    content: 'The count and page status confirm what the current filters returned, including loading, empty, and recoverable error states.',
  },
  'crm-index-open-record': {
    target: '[data-admin-tour="crm-results"]',
    title: 'Open a deal room for detail',
    content: 'Use the index for discovery, then open a record when you need its diligence, documents, communications, or full history.',
  },
  'crm-detail-workflow': {
    target: '[data-admin-tour="crm-detail-workflow"]',
    title: 'This is the record workspace',
    content: {
      admin: 'Keep the relationship, acquisition decision, diligence evidence, documents, and next action together in this deal room.',
      viewer: 'Inspect the relationship, acquisition decision, diligence evidence, documents, and next action together in this read-only deal room.',
    },
  },
  'crm-detail-next-action': {
    target: '[data-admin-tour="crm-detail-next-action"]',
    title: 'Keep the next action concrete',
    content: {
      admin: 'Make ownership and the next dated action clear so the opportunity returns to the right operating queue.',
      viewer: 'Check ownership and the next dated action to understand where the opportunity should appear next.',
    },
  },
  'crm-detail-communications-documents': {
    target: '[data-admin-tour="crm-detail-evidence"]',
    title: 'Use the evidence in context',
    content: 'Review communications, diligence, and secure documents together before interpreting status or deciding what comes next.',
  },
  'crm-detail-record-discipline': {
    target: '[data-admin-tour="crm-detail-actions"]',
    title: { admin: 'Save before leaving', viewer: 'Treat the record as read-only' },
    content: {
      admin: 'Save material changes before returning to the CRM index so the next queue reflects the current record.',
      viewer: 'Use this page to inspect the current record. Editing and destructive controls remain unavailable to read-only viewers.',
    },
  },
  'command-center-action-queue': {
    target: '[data-admin-tour="command-center-action-queue"]',
    title: 'Work the global action queue first',
    content: 'This queue surfaces work that needs attention across the pipeline before stage-by-stage review.',
  },
  'command-center-source-health': {
    target: '[data-admin-tour="command-center-source-health"]',
    title: 'Verify source state',
    content: 'Check source health and freshness before relying on the opportunity set for a decision.',
  },
  'command-center-pipeline': {
    target: '[data-admin-tour="command-center-pipeline"]',
    title: 'Review decisions by stage',
    content: {
      admin: 'After the action queue, review the pipeline by stage and make deliberate advance or pass decisions in the underlying interface.',
      viewer: 'After the action queue, inspect the pipeline by stage to understand current decisions and diligence readiness.',
    },
  },
  'deal-hunter-source-state': {
    target: '[data-admin-tour="deal-hunter-source-state"]',
    title: 'Check source freshness first',
    content: {
      admin: 'Confirm the review is current before acting on scoring or opportunity decisions.',
      viewer: 'Confirm when the source review was last updated before interpreting scoring or opportunity decisions.',
    },
  },
  'deal-hunter-review-buckets': {
    target: '[data-admin-tour="deal-hunter-review-buckets"]',
    title: 'Use scoring as a review aid',
    content: 'Qualified, newly seen, watchlist, and removal buckets help focus attention; the underlying evidence remains authoritative.',
  },
  'deal-hunter-cim-workflow': {
    target: '[data-admin-tour="deal-hunter-cim-workflow"]',
    title: 'Keep CIM outreach human-reviewed',
    content: 'Review recipient and opportunity context before using approval or outreach controls. The guide never activates those controls.',
  },
  'deal-hunter-history': {
    target: '[data-admin-tour="deal-hunter-history"]',
    title: 'Use history for follow-through',
    content: 'History shows request state and follow-up context so you can understand what happened before choosing the next step.',
  },
  'follow-ups-priority-filters': {
    target: '[data-admin-tour="follow-ups-filters"]',
    title: 'Put strong signals first',
    content: 'Prioritize overdue conversations and delivery problems before weaker engagement signals, then narrow the queue as needed.',
  },
  'follow-ups-queue': {
    target: '[data-admin-tour="follow-ups-queue"]',
    title: 'Work one relationship at a time',
    content: 'The queue keeps priority and timing visible. Open an item for its full context rather than acting from a score alone.',
  },
  'follow-ups-next-action': {
    target: '[data-admin-tour-next-action="true"]',
    title: 'Review the recommended next action',
    content: {
      admin: 'Use the record context and recent communication before accepting, changing, or dismissing a recommendation.',
      viewer: 'Use the record context and recent communication to understand why the next action is recommended.',
    },
  },
  'follow-ups-email-controls': {
    target: '[data-admin-tour="follow-ups-email-controls"]',
    title: 'Review every email before delivery',
    content: 'Confirm recipient, context, wording, and suppression state in the underlying composer before any delivery action.',
  },
  'operations-readiness': {
    target: '[data-admin-tour="operations-readiness"]',
    title: 'Resolve red states first',
    content: 'Red readiness signals need attention first. Amber means degraded or awaiting verification, not necessarily failed.',
  },
  'operations-history': {
    target: '[data-admin-tour="operations-history"]',
    title: 'Use history to find the failure boundary',
    content: 'Scheduler, source, cleanup, and audit history help distinguish a current failure from a recovered incident.',
  },
  'operations-storage': {
    target: '[data-admin-tour="operations-storage"]',
    title: 'Confirm storage and recovery health',
    content: 'Check database integrity, document storage, and backup readiness together before treating the system as operationally healthy.',
  },
  'new-record-basics': {
    target: '[data-admin-tour="new-record-basics"]',
    title: 'Start with a minimum viable record',
    content: 'Capture the opportunity, contact, source, and owner so the relationship can enter the operating workflow now.',
  },
  'new-record-economics': {
    target: '[data-admin-tour="new-record-economics"]',
    title: 'Economics can be completed later',
    content: 'Add known financial context, but do not delay useful intake merely because every economic field is not available yet.',
  },
  'new-record-next-action': {
    target: '[data-admin-tour="new-record-next-action"]',
    title: 'End intake with ownership and action',
    content: 'Give the record an owner and a concrete next action so it appears in the right follow-up workflow after creation.',
  },
};

function roleValue(value, role) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value[role] : value;
}

export function getAdminOnboardingClientTour(tourKey, role) {
  const contract = getAdminOnboardingTour(tourKey);
  if (!contract || !isAdminOnboardingRoleEligible(tourKey, role)) return null;

  const steps = getAdminOnboardingStepIds(tourKey, role).map((stepId) => {
    const presentation = tourStepPresentation[stepId];
    return {
      target: presentation.target,
      placement: presentation.placement || 'auto',
      title: roleValue(presentation.title, role),
      content: roleValue(presentation.content, role),
      data: { stepId },
    };
  });

  return {
    key: contract.key,
    version: contract.version,
    scope: contract.scope,
    automatic: contract.automatic,
    steps,
  };
}
