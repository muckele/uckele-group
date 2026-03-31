import { getConfig } from '../config.js';

export const leadTypes = ['seller', 'broker', 'referral', 'advisor', 'other'];
export const priorities = ['low', 'normal', 'medium', 'high', 'urgent'];
export const followUpStates = ['needs-response', 'scheduled', 'waiting-on-owner', 'completed'];
export const sbaEligibilityOptions = ['yes', 'no', 'unknown'];

function addHours(timestamp, hours) {
  return new Date(timestamp + hours * 60 * 60 * 1000).toISOString();
}

function buildPromptLine({ counterpart, company, status, followUpState, hasPendingUploadRequest }) {
  if (status === 'new') {
    return `Send an initial reply to the ${counterpart}, confirm confidentiality, and propose a short introductory call about ${company}.`;
  }

  if (followUpState === 'waiting-on-owner') {
    return `Send a brief check-in on ${company}, restate interest, and ask whether the ${counterpart} has any questions or timeline updates.`;
  }

  if (hasPendingUploadRequest) {
    return `Follow up on the secure document request for ${company} and ask whether the ${counterpart} needs anything from you before sharing materials.`;
  }

  if (counterpart === 'broker') {
    return `Check in with the broker on ${company}, ask about timing, and confirm whether there is a clear next step or additional information to review.`;
  }

  return `Reach back out on ${company} with a concise update, confirm continued interest, and suggest the next concrete step.`;
}

export function normalizeRoleToLeadType(role) {
  const normalized = String(role || '').trim().toLowerCase();

  if (normalized.includes('broker') || normalized.includes('intermediary')) {
    return 'broker';
  }

  if (normalized.includes('referral')) {
    return 'referral';
  }

  if (normalized.includes('advisor')) {
    return 'advisor';
  }

  if (normalized.includes('owner') || normalized.includes('seller')) {
    return 'seller';
  }

  return 'other';
}

export function normalizeLeadType(value, fallback = 'seller') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (normalized === 'owner') {
    return 'seller';
  }

  return leadTypes.includes(normalized) ? normalized : fallback;
}

export function deriveWorkflowDefaults({ role, source, submittedAt }) {
  const config = getConfig();
  const leadType = normalizeLeadType(normalizeRoleToLeadType(role));
  const sourceLabel = String(source || 'website').trim().toLowerCase().replace(/\s+/g, '-');
  const tags = ['inbound', sourceLabel];
  let priority = 'normal';

  if (leadType === 'seller') {
    priority = 'high';
    tags.push('seller');
  } else if (leadType === 'broker' || leadType === 'referral') {
    priority = 'medium';
    tags.push(leadType);
  } else if (leadType === 'advisor') {
    priority = 'medium';
  }

  return {
    leadType,
    priority,
    tags: Array.from(new Set(tags)),
    assignee: config.workflow.defaultAssignee,
    followUpState: 'needs-response',
    nextActionAt: addHours(new Date(submittedAt).getTime(), config.workflow.defaultFollowUpDelayHours),
  };
}

export function normalizePriority(value, fallback = 'normal') {
  return priorities.includes(value) ? value : fallback;
}

export function normalizeFollowUpState(value, fallback = 'needs-response') {
  return followUpStates.includes(value) ? value : fallback;
}

export function normalizeSbaEligibility(value, fallback = 'unknown') {
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }

  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (['y', 'yes', 'true', '1'].includes(normalized)) {
    return 'yes';
  }

  if (['n', 'no', 'false', '0'].includes(normalized)) {
    return 'no';
  }

  return sbaEligibilityOptions.includes(normalized) ? normalized : fallback;
}

export function buildFollowUpPrompt(submission, nowValue = new Date()) {
  const status = String(submission.status || 'new').trim().toLowerCase();
  const followUpState = normalizeFollowUpState(submission.follow_up_state);

  if (['archived', 'spam'].includes(status) || followUpState === 'completed') {
    return null;
  }

  const leadType = normalizeLeadType(submission.lead_type, 'seller');
  const company = String(
    submission.company || submission.seller_name || submission.broker_name || submission.name || 'this opportunity',
  ).trim();
  const counterpart = leadType === 'broker' ? 'broker' : leadType === 'advisor' ? 'advisor' : 'seller';
  const nextActionTimestamp = Date.parse(submission.next_action_at || '');
  const hasNextAction = Number.isFinite(nextActionTimestamp);
  const now = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  const latestUploadRequest = submission.latest_upload_request;
  const hasPendingUploadRequest = Boolean(
    latestUploadRequest && latestUploadRequest.status !== 'expired' && !latestUploadRequest.last_uploaded_at,
  );

  if (!hasNextAction) {
    return {
      severity: 'warning',
      kind: 'missing',
      dueAt: null,
      title: `Set the next follow-up for ${company}`,
      message: `There is no next action scheduled for this ${counterpart} conversation.`,
      prompt: buildPromptLine({ counterpart, company, status, followUpState, hasPendingUploadRequest }),
    };
  }

  const hoursUntilNextAction = (nextActionTimestamp - now) / (1000 * 60 * 60);
  const overdueHours = Math.abs(hoursUntilNextAction);

  if (hoursUntilNextAction <= 0) {
    const severeOverdue = overdueHours >= 48;

    return {
      severity: severeOverdue ? 'danger' : 'warning',
      kind: severeOverdue ? 'overdue' : 'due',
      dueAt: submission.next_action_at,
      title:
        status === 'new'
          ? `First response overdue for ${company}`
          : `Follow up with the ${counterpart} on ${company}`,
      message: severeOverdue
        ? `The next action is more than two days overdue.`
        : `The next action is due now.`,
      prompt: buildPromptLine({ counterpart, company, status, followUpState, hasPendingUploadRequest }),
    };
  }

  if (hoursUntilNextAction <= 24) {
    return {
      severity: 'info',
      kind: 'today',
      dueAt: submission.next_action_at,
      title: `Follow up due within 24 hours for ${company}`,
      message: `Keep this ${counterpart} conversation moving before it cools off.`,
      prompt: buildPromptLine({ counterpart, company, status, followUpState, hasPendingUploadRequest }),
    };
  }

  return null;
}
