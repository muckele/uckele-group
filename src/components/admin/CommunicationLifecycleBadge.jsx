import React from 'react';

const requestPresentations = {
  'not-requested': { label: 'Not requested', tone: 'default' },
  ready: { label: 'Ready for approval', tone: 'info' },
  pending: { label: 'Sending in progress', tone: 'warning' },
  sending: { label: 'Sending in progress', tone: 'warning' },
  accepted: { label: 'Provider accepted', tone: 'info' },
  'provider-accepted': { label: 'Provider accepted', tone: 'info' },
  responded: { label: 'Replied', tone: 'success' },
  replied: { label: 'Replied', tone: 'success' },
  stopped: { label: 'Outreach stopped', tone: 'default' },
  failed: { label: 'Request failed', tone: 'danger' },
};

const deliveryPresentations = {
  'not-attempted': { label: 'Not attempted', tone: 'default' },
  accepted: { label: 'Awaiting delivery', tone: 'warning' },
  'awaiting-delivery': { label: 'Awaiting delivery', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  delayed: { label: 'Delayed', tone: 'warning' },
  bounced: { label: 'Bounced', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  complained: { label: 'Complained', tone: 'danger' },
  suppressed: { label: 'Suppressed', tone: 'danger' },
  replied: { label: 'Replied', tone: 'success' },
  'delivery-issue': { label: 'Delivery issue', tone: 'danger' },
  'development-only': { label: 'Development only', tone: 'warning' },
};

const toneClasses = {
  default: 'border-ink/10 bg-white text-ink/65',
  success: 'border-moss/20 bg-moss/10 text-moss',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-700',
  info: 'border-sky-200 bg-sky-50 text-sky-700',
};

function normalizeState(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function fallbackPresentation(value, prefix) {
  const normalized = normalizeState(value);
  if (!normalized) return null;
  const label = normalized.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  return { label: prefix ? `${prefix}: ${label}` : label, tone: 'default' };
}

export function getCommunicationLifecyclePresentation({
  requestState = '',
  deliveryState = '',
  replied = false,
  developmentOnly = false,
} = {}) {
  const normalizedRequestState = normalizeState(requestState);
  const normalizedDeliveryState = normalizeState(deliveryState);
  const badges = [];
  const developmentAcceptance = developmentOnly
    && ['accepted', 'provider-accepted', 'pending', 'sending'].includes(normalizedRequestState);

  if (normalizedRequestState && !developmentAcceptance) {
    badges.push({
      id: 'request',
      state: normalizedRequestState,
      ...(requestPresentations[normalizedRequestState] || fallbackPresentation(normalizedRequestState, 'Request')),
    });
  }

  if (normalizedDeliveryState && !developmentOnly) {
    badges.push({
      id: 'delivery',
      state: normalizedDeliveryState,
      ...(deliveryPresentations[normalizedDeliveryState] || fallbackPresentation(normalizedDeliveryState, 'Delivery')),
    });
  }

  if (developmentOnly) {
    badges.push({ id: 'development', state: 'development-only', ...deliveryPresentations['development-only'] });
  }

  if (
    replied
    && !['replied', 'responded'].includes(normalizedRequestState)
    && !['replied', 'responded'].includes(normalizedDeliveryState)
  ) {
    badges.push({ id: 'reply', state: 'replied', label: 'Replied', tone: 'success' });
  }

  return badges;
}

export default function CommunicationLifecycleBadge({
  requestState = '',
  deliveryState = '',
  replied = false,
  developmentOnly = false,
  className = '',
  label = 'Communication lifecycle',
}) {
  const badges = getCommunicationLifecyclePresentation({ requestState, deliveryState, replied, developmentOnly });

  if (badges.length === 0) return null;

  return (
    <span aria-label={label} className={`inline-flex flex-wrap items-center gap-2 ${className}`.trim()}>
      {badges.map((badge) => (
        <span
          className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] ${toneClasses[badge.tone] || toneClasses.default}`}
          data-lifecycle-kind={badge.id}
          data-lifecycle-state={badge.state}
          key={`${badge.id}-${badge.state}`}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}
