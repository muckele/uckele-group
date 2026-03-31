import { Helmet } from 'react-helmet-async';
import { useLocation } from 'react-router-dom';
import { siteConfig } from '../content/siteContent';

export default function Seo({ title, description, keywords, noindex = false }) {
  const location = useLocation();
  const canonicalUrl = `${siteConfig.siteUrl}${location.pathname}`;

  return (
    <Helmet>
      <title>{title}</title>
      <meta content={description} name="description" />
      <meta content={keywords} name="keywords" />
      <link href={canonicalUrl} rel="canonical" />
      {noindex ? <meta content="noindex, nofollow" name="robots" /> : null}
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonicalUrl} property="og:url" />
      <meta content={siteConfig.socialImageUrl} property="og:image" />
      <meta content={siteConfig.siteName} property="og:site_name" />
      <meta content="website" property="og:type" />
      <meta content={title} name="twitter:title" />
      <meta content={description} name="twitter:description" />
      <meta content={siteConfig.socialImageUrl} name="twitter:image" />
      <meta content="summary_large_image" name="twitter:card" />
    </Helmet>
  );
}
