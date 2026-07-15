export const seoContent = Object.freeze({
  home: Object.freeze({
    path: '/',
    title: 'Uckele Group | Long-Term Small Business Buyer',
    description:
      'Mathew Uckele is an individual buyer seeking to acquire and operate a strong small business for the long term with continuity, care, and respect for seller legacy.',
    keywords:
      'small business buyer, individual business buyer, long-term business buyer, acquire my business, sell my small business, business succession buyer, operator buyer, search fund alternative, not private equity business buyer',
  }),
  about: Object.freeze({
    path: '/about',
    title: 'About Mathew Uckele | Uckele Group',
    description:
      'Learn about Mathew Uckele, his background in business administration, sales, operations, and technical problem solving, and why he wants to buy and operate one great small business.',
    keywords:
      'about mathew uckele, small business buyer background, operator buyer, individual acquisition entrepreneur',
  }),
  criteria: Object.freeze({
    path: '/criteria',
    title: 'What I’m Looking For | Uckele Group',
    description:
      'Review the types of small businesses Mathew Uckele is looking to acquire, including stable profitable companies with recurring customer relationships and strong reputations.',
    keywords:
      'what business am I looking for, acquisition criteria, small business acquisition criteria, business succession buyer criteria',
  }),
  sellerConcerns: Object.freeze({
    path: '/why-sell-to-me',
    title: 'Why Sell To Me | Uckele Group',
    description:
      'A thoughtful alternative to private equity for business owners who care about legacy, employees, customer relationships, and a fair transition process.',
    keywords:
      'sell to an individual buyer, not private equity business buyer, preserve business legacy after sale, business transition buyer',
  }),
  process: Object.freeze({
    path: '/process',
    title: 'Acquisition Process | Uckele Group',
    description:
      'See the respectful, straightforward acquisition process Mathew Uckele uses for confidential small business purchase conversations and smooth ownership transitions.',
    keywords:
      'small business acquisition process, sell my business process, confidential business sale discussion',
  }),
  faq: Object.freeze({
    path: '/faq',
    title: 'FAQ | Uckele Group',
    description:
      'Answers to common questions business owners ask about selling to Mathew Uckele, including confidentiality, employees, timing, brokers, and deal structure.',
    keywords:
      'small business buyer faq, sell my business faq, individual buyer questions, operator buyer faq',
  }),
  contact: Object.freeze({
    path: '/contact',
    title: 'Contact | Uckele Group',
    description:
      'Start a confidential conversation with Mathew Uckele about selling your business, succession planning, or a referral opportunity.',
    keywords:
      'contact small business buyer, confidential business sale conversation, broker referral small business buyer',
  }),
  privacy: Object.freeze({
    path: '/privacy',
    title: 'Privacy | Uckele Group',
    description:
      'Learn how Uckele Group handles contact information, confidential deal materials, administrative sessions, retention, and privacy requests.',
    keywords:
      'uckele group privacy, confidential business information, secure document privacy, business buyer privacy',
  }),
  thankYou: Object.freeze({
    path: '/thank-you',
    title: 'Thank You | Uckele Group',
    description: 'Your confidential inquiry has been received by Uckele Group.',
    keywords: '',
    noindex: true,
  }),
});

export const allSeoPages = Object.freeze(Object.values(seoContent));
export const publicSeoPages = Object.freeze(allSeoPages.filter((page) => !page.noindex));
