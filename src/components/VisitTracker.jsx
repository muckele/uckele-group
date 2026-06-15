import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

function getOrCreateSessionId() {
  const key = 'ug_visit_session_id';
  const existing = window.localStorage.getItem(key);

  if (existing) {
    return existing;
  }

  const nextId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  window.localStorage.setItem(key, nextId);
  return nextId;
}

function getTrackedSubmissionId(searchParams) {
  const explicitId = searchParams.get('submission_id') || searchParams.get('submissionId') || searchParams.get('sid');

  if (explicitId) {
    window.localStorage.setItem('ug_tracked_submission_id', explicitId);
    return explicitId;
  }

  return window.localStorage.getItem('ug_tracked_submission_id') || '';
}

export default function VisitTracker() {
  const location = useLocation();

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const submissionId = getTrackedSubmissionId(searchParams);

    if (!submissionId) {
      return;
    }

    const payload = {
      submission_id: submissionId,
      session_id: getOrCreateSessionId(),
      page_path: `${location.pathname}${location.search}`,
      full_url: window.location.href,
      referrer: document.referrer || '',
      utm_source: searchParams.get('utm_source') || '',
      utm_medium: searchParams.get('utm_medium') || '',
      utm_campaign: searchParams.get('utm_campaign') || '',
    };
    const body = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track/visit', new Blob([body], { type: 'application/json' }));
      return;
    }

    fetch('/api/track/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }, [location.pathname, location.search]);

  return null;
}
