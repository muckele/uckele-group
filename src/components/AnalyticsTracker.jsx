import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackAnalyticsEvent } from '../utils/analytics';

export default function AnalyticsTracker() {
  const location = useLocation();

  useEffect(() => {
    trackAnalyticsEvent('page_view', { path: location.pathname });
  }, [location.pathname]);

  return null;
}
