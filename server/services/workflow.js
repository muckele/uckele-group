import { getConfig } from '../config.js';

export const leadTypes = ['prospect', 'client', 'referral', 'partner', 'other'];
export const priorities = ['low', 'normal', 'medium', 'high', 'urgent'];
export const followUpStates = ['needs-response', 'scheduled', 'waiting-on-owner', 'completed'];
export const sbaEligibilityOptions = ['yes', 'no', 'unknown'];

function addHours(timestamp, hours) {
  return new Date(timestamp + hours * 60 * 60 * 1000).toISOString();
}

function buildPromptLine({ counterpart, company, status, followUpState, hasPendingUploadRequest }) {
  if (status === 'new') {
    return `Send an initial reply to the ${counterpart}, reference their website, and propose a short audit review call about ${company}.`;
  }

  if (followUpState === 'waiting-on-owner') {
    return `Send a brief check-in on ${company}, restate the recommended next step, and ask whether the ${counterpart} has any questions or timeline updates.`;
  }

  if (hasPendingUploadRequest) {
    return `Follow up on the secure onboarding request for ${company} and ask whether the ${counterpart} needs help sharing website assets or account details.`;
  }

  if (counterpart === 'partner') {
    return `Check in with the partner on ${company}, ask about timing, and confirm whether there is a clear next step or additional information to review.`;
  }

  return `Reach back out on ${company} with a concise audit or support update, confirm continued interest, and suggest the next concrete step.`;
}

export function normalizeRoleToLeadType(role) {
  const normalized = String(role || '').trim().toLowerCase();

  if (normalized.includes('client') || normalized.includes('customer')) {
    return 'client';
  }

  if (normalized.includes('agency') || normalized.includes('consultant') || normalized.includes('partner')) {
    return 'partner';
  }

  if (normalized.includes('referral')) {
    return 'referral';
  }

  if (normalized.includes('owner') || normalized.includes('manager') || normalized.includes('prospect')) {
    return 'prospect';
  }

  return 'other';
}

export function normalizeLeadType(value, fallback = 'prospect') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (['owner', 'business-owner', 'seller', 'broker', 'advisor'].includes(normalized)) {
    return normalized === 'broker' || normalized === 'advisor' ? 'partner' : 'prospect';
  }

  return leadTypes.includes(normalized) ? normalized : fallback;
}

export function deriveWorkflowDefaults({ role, source, submittedAt }) {
  const config = getConfig();
  const leadType = normalizeLeadType(normalizeRoleToLeadType(role));
  const sourceLabel = String(source || 'website').trim().toLowerCase().replace(/\s+/g, '-');
  const tags = ['inbound', sourceLabel];
  let priority = 'normal';

  if (leadType === 'prospect') {
    priority = 'high';
    tags.push('prospect');
  } else if (leadType === 'client') {
    priority = 'urgent';
    tags.push('client');
  } else if (leadType === 'partner' || leadType === 'referral') {
    priority = 'medium';
    tags.push(leadType);
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

  const leadType = normalizeLeadType(submission.lead_type, 'prospect');
  const company = String(
    submission.company || submission.seller_name || submission.broker_name || submission.name || 'this opportunity',
  ).trim();
  const counterpart = leadType === 'partner' ? 'partner' : leadType === 'client' ? 'client' : 'prospect';
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
