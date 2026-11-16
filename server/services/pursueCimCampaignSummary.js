// The latest Pursue campaign generation for a listing, as queue rows, the detail view and
// owner-command responses show it. Any campaign, running or finished, means Request SIM has
// nothing to start, so the client hides it whenever this summary is present.

export const TERMINAL_CAMPAIGN_STATES = Object.freeze(new Set([
  'responded', 'materials-received', 'stopped', 'expired',
]));

// Owner choices that stop a campaign. Only a campaign stopped by one of these, before any of
// its email reached Google, may be followed by a new generation (autopilot spec 7.2.4).
export const OWNER_STOP_REASONS = Object.freeze(new Set(['campaign_stopped', 'watch-selected',
  'pass-selected']));

const knownStates = new Set([
  'queued', 'waiting-on-eligibility', 'initial-pending', 'active-follow-up',
  'action-required', 'provider-ambiguous', ...TERMINAL_CAMPAIGN_STATES,
]);

function bounded(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

/**
 * `{ state, reasonCode }` for one campaign row, or null when there is none. A campaign whose
 * day-28 window has elapsed reads as expired before the sender's sweep records it, the same
 * projection the release report makes.
 */
export function publicCampaignSummary({ state, reasonCode = '', localExpiryAt = '' } = {},
  now = new Date()) {
  const stored = bounded(state, 80);
  if (!knownStates.has(stored)) return null;
  const expiry = Date.parse(localExpiryAt ?? '');
  const projectedExpired = ['initial-pending', 'active-follow-up'].includes(stored)
    && Number.isFinite(expiry) && expiry <= new Date(now).getTime();
  return {
    state: projectedExpired ? 'expired' : stored,
    reasonCode: projectedExpired ? 'campaign_window_elapsed' : bounded(reasonCode, 160),
  };
}

/** The summary for a raw campaign row as storage returns it. */
export function campaignSummaryFromRow(campaign, now = new Date()) {
  if (!campaign) return null;
  return publicCampaignSummary({ state: campaign.state, reasonCode: campaign.reason_code,
    localExpiryAt: campaign.local_expiry_at }, now);
}

export function campaignFinished(summary) {
  return Boolean(summary && TERMINAL_CAMPAIGN_STATES.has(summary.state));
}
