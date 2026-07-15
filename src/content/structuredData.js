import { faqItems } from './faqContent.js';

export const breadcrumbLabels = Object.freeze({
  '/about': 'About',
  '/criteria': 'What I’m Looking For',
  '/why-sell-to-me': 'Why Sell To Me',
  '/process': 'Process',
  '/faq': 'FAQ',
  '/contact': 'Contact',
  '/privacy': 'Privacy',
});

export function buildStructuredData({
  route,
  title,
  description,
  baseUrl = 'https://www.uckelegroup.com',
}) {
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  const pageUrl = `${normalizedBaseUrl}${route === '/' ? '' : route}`;
  const organizationId = `${normalizedBaseUrl}/#organization`;
  const personId = `${normalizedBaseUrl}/#mathew-uckele`;
  const websiteId = `${normalizedBaseUrl}/#website`;
  const pageId = `${pageUrl}#webpage`;
  const graph = [
    {
      '@type': 'Organization',
      '@id': organizationId,
      name: 'Uckele Group',
      url: normalizedBaseUrl,
      logo: `${normalizedBaseUrl}/favicon.svg`,
      founder: { '@id': personId },
    },
    {
      '@type': 'Person',
      '@id': personId,
      name: 'Mathew Uckele',
      url: `${normalizedBaseUrl}/about`,
      image: `${normalizedBaseUrl}/mathew-uckele-headshot.jpeg`,
      jobTitle: 'Long-Term Small Business Buyer and Operator',
      worksFor: { '@id': organizationId },
      sameAs: ['https://www.linkedin.com/in/mathew-uckele'],
    },
    {
      '@type': 'WebSite',
      '@id': websiteId,
      name: 'Uckele Group',
      url: normalizedBaseUrl,
      publisher: { '@id': organizationId },
    },
    {
      '@type': route === '/faq' ? 'FAQPage' : 'WebPage',
      '@id': pageId,
      name: title,
      description,
      url: pageUrl,
      isPartOf: { '@id': websiteId },
      about: { '@id': organizationId },
      ...(route === '/faq'
        ? {
            mainEntity: faqItems.map((item) => ({
              '@type': 'Question',
              name: item.question,
              acceptedAnswer: { '@type': 'Answer', text: item.answer },
            })),
          }
        : {}),
    },
  ];

  if (breadcrumbLabels[route]) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${pageUrl}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: normalizedBaseUrl },
        { '@type': 'ListItem', position: 2, name: breadcrumbLabels[route], item: pageUrl },
      ],
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}
