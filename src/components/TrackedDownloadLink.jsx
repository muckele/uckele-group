import { trackAnalyticsEvent } from '../utils/analytics';
import ButtonLink from './ButtonLink';
import { useLocation } from 'react-router-dom';

export default function TrackedDownloadLink({ placement, onClick, ...props }) {
  const location = useLocation();

  function handleClick(event) {
    trackAnalyticsEvent('criteria_downloaded', {
      path: location.pathname,
      placement,
    });
    onClick?.(event);
  }

  return <ButtonLink {...props} download onClick={handleClick} />;
}
