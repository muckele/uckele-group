// How a listing's Pursue campaign reads to the owner. Any campaign, running or finished,
// means Request SIM has nothing to start, so it is hidden wherever this applies.

function label(value) {
  return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * The campaign the listing shows: the release report when it has loaded (it carries the
 * expiry projection), else the summary the queue row or detail carried.
 */
export function listingCampaign({ cimRelease = null, opportunity = null } = {}) {
  if (cimRelease?.campaign) {
    return { state: cimRelease.status?.code === 'expired' ? 'expired' : cimRelease.campaign.state,
      reasonCode: cimRelease.campaign.reasonCode || '' };
  }
  return opportunity?.campaign || null;
}

export function campaignWorkflowLabel(campaign) {
  return `Campaign ${label(campaign.state)}`;
}

const ownerStopReasons = new Set(['campaign_stopped', 'watch-selected', 'pass-selected']);
const notYetSentTouchStates = new Set(['scheduled', 'claimed', 'cancelled-before-provider']);

/** The next-action card for a stopped campaign: why it stopped and what the owner can do. */
export function stoppedCampaignPresentation(cimRelease) {
  const reason = cimRelease?.campaign?.reasonCode || cimRelease?.status?.reason || '';
  const touchState = cimRelease?.initialTouch?.state || '';
  if (ownerStopReasons.has(reason)) {
    if (!touchState || notYetSentTouchStates.has(touchState)) {
      return { kind: 'Campaign stopped', title: 'Stopped before any email went out',
        detail: 'The broker was never emailed about this listing. Request SIM does not restart a stopped campaign.' };
    }
    if (touchState === 'accepted') {
      return { kind: 'Campaign stopped', title: 'Stopped after the first email',
        detail: 'The broker already has the first email, and follow-ups will not resume. Continue in Gmail if you want to follow up.' };
    }
    return { kind: 'Campaign stopped', title: 'Stopped before the first email was confirmed',
      detail: 'Check Gmail Sent before contacting the broker again; the first email may have gone out.' };
  }
  if (reason === 'owner_replied') {
    return { kind: 'Campaign stopped', title: 'You replied in the Gmail thread',
      detail: 'The campaign stopped because you took over the conversation. Continue in Gmail.' };
  }
  if (reason === 'recipient_suppressed') {
    return { kind: 'Campaign stopped', title: 'The broker address is suppressed',
      detail: 'No more email goes to this address from here.' };
  }
  if (reason === 'advanced_beyond_broker_outreach') {
    return { kind: 'Campaign stopped', title: 'The deal moved past broker outreach',
      detail: 'The campaign stopped because the deal is already in later diligence. Continue from the linked CRM record.' };
  }
  if (reason === 'materials_received') {
    return { kind: 'Campaign stopped', title: 'Materials arrived before the first email',
      detail: 'The campaign stopped because materials are already on file. Review them in the linked CRM record.' };
  }
  if (reason === 'unsafe_delivery') {
    return { kind: 'Campaign stopped', title: 'Delivery to this address was unsafe',
      detail: 'A bounce or delivery problem stopped the campaign. Check the CRM record before contacting the broker another way.' };
  }
  if (reason === 'crm_archived' || reason === 'crm_superseded') {
    return { kind: 'Campaign stopped', title: 'The CRM record was archived or replaced',
      detail: 'The campaign stopped with it. No more email goes out about this listing from here.' };
  }
  return { kind: 'Campaign stopped', title: 'The campaign was stopped',
    detail: `Reason: ${label(reason) || 'not recorded'}. No more email goes out about this listing from here.` };
}
