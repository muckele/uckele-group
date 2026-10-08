function formatDateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not supplied';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function brokerMaterialsLifecyclePresentation(request) {
  if (request?.respondedAt || request?.status === 'responded' || request?.requestState === 'responded') {
    return { badge: 'Replied', sentence: 'The broker replied to this request.', action: 'View Broker Reply' };
  }
  if (request?.status === 'ambiguous' || request?.requestState === 'provider_ambiguous' || request?.deliveryState === 'ambiguous') {
    return { badge: 'Ambiguous', sentence: 'Delivery could not be confirmed. Do not send another request.', action: 'Review Ambiguous Result' };
  }
  if (request?.status === 'delivery_issue' || request?.status === 'failed' || request?.requestState === 'failed' || ['bounced', 'failed', 'rejected', 'suppressed', 'complained'].includes(request?.deliveryState)) {
    return {
      badge: 'Delivery Issue', sentence: request.errorSummary || 'The request has a delivery issue.',
      action: 'Review Delivery Issue',
    };
  }
  if (request?.status === 'logged' || request?.requestState === 'logged') {
    return { badge: 'Sent', sentence: 'The broker materials request is logged.', action: 'View Logged Request' };
  }
  if (request?.status === 'delivered' || request?.deliveryState === 'delivered') {
    return { badge: 'Sent', sentence: `Delivered to ${request.recipient?.email || request.recipient?.displayName || 'the broker'}.`, action: 'View Request Status' };
  }
  if (request?.status === 'sent' || ['accepted', 'delivered'].includes(request?.deliveryState) || request?.providerAcceptedAt) {
    const timestamp = formatDateTime(request.providerAcceptedAt || request.requestedAt || request.updatedAt);
    return { badge: 'Sent', sentence: `Sent to ${request.recipient?.email || request.recipient?.displayName || 'the broker'} · ${timestamp}.`, action: 'View Sent Request' };
  }
  return { badge: 'Sending / Pending', sentence: 'A broker materials request is pending.', action: 'View Request Status' };
}

export function pursueNextActionPresentation({ brokerMaterials = {}, cimRelease = null,
  linkedCrmId = '', opportunity = {}, pursueCimReleaseAvailable = false }) {
  const inbound = brokerMaterials.attachmentStatus?.inbound || {};
  const vault = brokerMaterials.attachmentStatus?.vault || {};
  const existingRequest = brokerMaterials.existingRequest;
  const lifecycle = existingRequest ? brokerMaterialsLifecyclePresentation(existingRequest) : null;

  if (opportunity.dismissed) {
    return { kind: 'Waiting reason', title: 'Restore this opportunity for review',
      detail: 'The current Pass disposition blocks a materials handoff.' };
  }
  if (lifecycle?.badge === 'Ambiguous') {
    return { kind: 'Waiting reason', title: 'Review the ambiguous delivery result',
      detail: 'Do not send another request until authoritative status is available.' };
  }
  if (lifecycle?.badge === 'Delivery Issue') {
    return { kind: 'Next action', title: 'Resolve the delivery issue',
      detail: existingRequest.errorSummary || 'Review the durable request status before taking another action.' };
  }
  if (existingRequest && lifecycle?.badge !== 'Replied') {
    return { kind: 'Waiting reason', title: 'Wait for the broker response',
      detail: 'An existing durable request owns this opportunity; do not create a duplicate request.' };
  }
  if (cimRelease?.campaign && ['provider_pending', 'provider_ambiguous'].includes(cimRelease.status?.code)) {
    const ambiguous = cimRelease.status.code === 'provider_ambiguous';
    return { kind: 'Next action', title: `Reconcile the ${ambiguous ? 'ambiguous' : 'pending'} provider outcome`,
      detail: 'Use persisted provider evidence only; do not resend or create a duplicate manual request.' };
  }
  if (cimRelease?.campaign && cimRelease.status?.actionRequired) {
    return { kind: 'Next action', title: 'Review the durable CIM campaign status',
      detail: 'The campaign owns this opportunity. Use its persisted status and stop controls; do not start a duplicate manual request.' };
  }
  if (inbound.status === 'error') {
    return { kind: 'Waiting reason', title: 'Resolve the attachment retrieval failure',
      detail: 'Inbound attachment retrieval failed; no materials-readiness claim is made.' };
  }
  if (inbound.status === 'pending') {
    return { kind: 'Waiting reason', title: 'Wait for attachment retrieval',
      detail: 'Inbound content retrieval is still pending.' };
  }
  if (inbound.status === 'metadata_observed') {
    return { kind: 'Next action', title: 'Confirm attachment retrieval and scanning',
      detail: 'Attachment metadata exists, but retrieval, scanning, and secure availability are not established.' };
  }
  if (vault.status === 'available' && Number(vault.count) > 0) {
    return { kind: 'Next action', title: 'Confirm document scan and owner-review status',
      detail: 'A secure vault document exists, but this view does not infer that it is safe or reviewed.' };
  }
  if (lifecycle?.badge === 'Replied') {
    return { kind: 'Next action', title: 'Review the broker reply',
      detail: 'Use the retained conversation and materials status before deciding what follows.' };
  }
  if (cimRelease?.campaign) {
    if (cimRelease.status?.code === 'responded') {
      return { kind: 'Next action', title: 'Review the broker reply',
        detail: 'Use the persisted campaign conversation before deciding what follows.' };
    }
    if (cimRelease.status?.code === 'materials_received') {
      return { kind: 'Next action', title: 'Review received broker materials',
        detail: 'Materials were reported received; confirm retrieval, scanning, and owner review before relying on them.' };
    }
    if (cimRelease.status?.code === 'expired') {
      return { kind: 'Next action', title: 'Review the unanswered opportunity',
        detail: 'The bounded four-week email campaign expired without a reply or CIM. Decide whether a phone call is appropriate; no further email is scheduled.' };
    }
    return { kind: 'Waiting reason',
      title: 'Review the durable CIM campaign status',
      detail: 'The campaign owns this opportunity. Use its persisted status and stop controls; do not start a duplicate manual request.' };
  }
  if (!cimRelease && pursueCimReleaseAvailable) {
    return { kind: 'Waiting reason', title: 'Wait for durable CIM status',
      detail: 'Durable release state is still loading; no campaign ownership claim is made.' };
  }
  if (!brokerMaterials.pursued) {
    return { kind: 'Next action', title: 'Record Pursue to begin the materials handoff',
      detail: 'Pursue establishes current owner intent before request preparation.' };
  }
  if (!linkedCrmId) {
    return { kind: 'Waiting reason', title: 'Create or link the CRM record',
      detail: 'The existing CRM workflow must own the opportunity before broker outreach.' };
  }
  const preparationBlocker = brokerMaterials.preparationBlockers?.[0];
  if (preparationBlocker) {
    return { kind: 'Waiting reason', title: 'Resolve the current prerequisite',
      detail: preparationBlocker.message || 'Broker materials preparation is currently blocked.' };
  }
  if ((brokerMaterials.recipientOptions?.length || 0) > 1) {
    return { kind: 'Next action', title: 'Select the authoritative broker recipient',
      detail: 'Choose one current server-authoritative contact before preparing the request.' };
  }
  const sendBlocker = brokerMaterials.sendBlockers?.[0];
  const sendBlockerDetail = sendBlocker?.message || sendBlocker?.code || 'Current send authority is unavailable';
  return { kind: 'Next action', title: 'Review the bounded campaign authorization',
    detail: sendBlocker
      ? `Sending remains unavailable: ${sendBlockerDetail}${/[.!?]$/.test(sendBlockerDetail) ? '' : '.'}`
      : 'Approve the verified recipient and campaign policy once. Every touch still requires current safety authority; live sending remains separately gated.' };
}
