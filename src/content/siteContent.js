const publicSiteUrl = (import.meta.env.VITE_PUBLIC_SITE_URL || 'https://www.uckelegroup.com').replace(/\/+$/, '');
const publicEmail = String(import.meta.env.VITE_PUBLIC_CONTACT_EMAIL || 'mathew@uckelegroup.com').trim();
const publicPhone = String(import.meta.env.VITE_PUBLIC_CONTACT_PHONE || '914.361.9153').trim();
const publicLinkedin = String(import.meta.env.VITE_PUBLIC_LINKEDIN_URL || 'https://www.linkedin.com/in/mathew-uckele').trim();
const schedulingUrl = String(import.meta.env.VITE_PUBLIC_SCHEDULING_URL || '').trim();
const bookingCta = schedulingUrl
  ? { label: 'Book A 15-Minute Call', href: schedulingUrl }
  : { label: 'Request An Audit', href: '/contact' };

function toAbsoluteUrl(path) {
  if (!path) {
    return publicSiteUrl;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${publicSiteUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

const contactDetailItems = [
  publicEmail
    ? {
        kind: 'email',
        label: 'Email',
        value: publicEmail,
        href: `mailto:${publicEmail}`,
      }
    : {
        kind: 'text',
        label: 'Contact',
        value: 'Use the audit request form for a direct reply',
      },
  publicPhone
    ? {
        kind: 'phone',
        label: 'Phone',
        value: publicPhone,
        href: `tel:${publicPhone.replace(/[^\d+]/g, '')}`,
      }
    : null,
  schedulingUrl
    ? {
        kind: 'schedule',
        label: 'Book a call',
        value: 'Schedule online',
        href: schedulingUrl,
      }
    : null,
  publicLinkedin
    ? {
        kind: 'linkedin',
        label: 'LinkedIn',
        value: 'LinkedIn',
        href: publicLinkedin,
      }
    : null,
].filter(Boolean);

export const siteConfig = {
  siteName: 'Uckele Group',
  siteUrl: publicSiteUrl,
  personName: 'Mathew Uckele',
  email: publicEmail,
  phone: publicPhone,
  linkedin: publicLinkedin,
  schedulingUrl,
  bookingCta,
  contactDetailItems,
  downloadHref: '/downloads/uckele-group-online-presence-services.txt',
  socialImage: '/social-card.svg',
  socialImageUrl: toAbsoluteUrl('/social-card.svg'),
};

export const navigation = [
  { label: 'Home', path: '/' },
  { label: 'Services', path: '/services' },
  { label: 'Process', path: '/process' },
  { label: 'Why Partner', path: '/why-partner' },
  { label: 'FAQ', path: '/faq' },
  { label: 'Contact', path: '/contact' },
];

export const seoContent = {
  home: {
    title: 'Uckele Group | Online Presence Management For Local Businesses',
    description:
      'Website updates, conversion fixes, local SEO basics, contact-flow cleanup, and monthly online presence management for service businesses.',
    keywords:
      'online presence management, local business website support, website updates, local SEO, conversion optimization, small business marketing support',
  },
  about: {
    title: 'About | Uckele Group',
    description:
      'Learn how Uckele Group helps local businesses keep websites current, improve lead flow, and manage practical online presence work without agency complexity.',
    keywords:
      'about online presence manager, local business website help, small business marketing operations',
  },
  criteria: {
    title: 'Services And Packages | Uckele Group',
    description:
      'Review website management, audit, update, local SEO, and monthly support packages for local businesses.',
    keywords:
      'website management packages, local SEO packages, website update service, small business marketing packages',
  },
  whyPartner: {
    title: 'Why Partner | Uckele Group',
    description:
      'A practical website and online presence partner for local businesses that need steady updates, better contact flow, and clearer customer trust signals.',
    keywords:
      'why hire website manager, local business marketing partner, website maintenance partner',
  },
  process: {
    title: 'Process | Uckele Group',
    description:
      'A simple process for auditing, fixing, and managing a local business website and online presence.',
    keywords:
      'website audit process, online presence management process, local business website onboarding',
  },
  faq: {
    title: 'FAQ | Uckele Group',
    description:
      'Answers to common questions about website updates, local SEO basics, monthly retainers, audits, and online presence support.',
    keywords:
      'website management faq, local SEO support faq, small business website maintenance questions',
  },
  contact: {
    title: 'Request A Website Audit | Uckele Group',
    description:
      'Request a quick website audit or book a short call to discuss website updates, lead flow, and online presence management.',
    keywords:
      'request website audit, book website consultation, local business website help',
  },
  privacy: {
    title: 'Privacy Policy | Uckele Group',
    description:
      'How Uckele Group handles website audit requests, CRM information, uploaded document metadata, and business contact details.',
    keywords:
      'privacy policy, website audit privacy, CRM data privacy',
  },
  terms: {
    title: 'Terms | Uckele Group',
    description:
      'Service terms and expectations for website audits, online presence management, CRM support, invoices, and business outreach.',
    keywords:
      'service terms, website audit terms, online presence management terms',
  },
};

export const homePage = {
  hero: {
    eyebrow: 'Online Presence Management For Local Businesses',
    title: 'Keep your website current, trustworthy, and built to bring in leads',
    description:
      'I help local service businesses maintain their website, fix lead-reducing issues, improve contact flow, and keep their online presence from going stale.',
    primaryCta: { label: 'Request A Website Audit', href: '/contact' },
    secondaryCta: { label: 'View Services', href: '/services' },
    signals: [
      'Website updates and maintenance',
      'Contact forms, calls to action, and lead flow',
      'Local SEO and trust-signal cleanup',
      'Monthly support without a bloated agency process',
    ],
    founderCard: {
      title: 'A practical partner for the work owners do not have time to chase',
      body: 'Most local businesses do not need a massive marketing department. They need someone reliable to keep the website useful, make obvious fixes, and turn online interest into calls or form fills.',
      points: [
        'Clear monthly priorities and notes',
        'Fast fixes to broken pages, outdated copy, and confusing contact paths',
        'Reports written in plain English, not agency jargon',
      ],
    },
    bookingCta: schedulingUrl ? bookingCta : { label: 'View Services', href: '/services' },
  },
  quickTrust: [
    {
      title: 'Lead-flow focused',
      description: 'The goal is not just a nicer website. It is a site that makes it easy for customers to trust you and contact you.',
    },
    {
      title: 'Built for busy owners',
      description: 'You get practical updates, issue tracking, and clear recommendations without needing to manage every detail yourself.',
    },
    {
      title: 'Steady monthly support',
      description: 'Websites, Google profiles, landing pages, and customer-facing copy need care after launch. That is the monthly work.',
    },
  ],
  whyWorkWithMe: {
    eyebrow: 'What I Manage',
    title: 'The online presence basics that quietly cost local businesses leads',
    description:
      'Small issues compound: broken links, outdated services, weak calls to action, slow pages, missing trust signals, and forms that are hard to use on mobile.',
    cards: [
      {
        title: 'Website updates and fixes',
        description:
          'Update services, photos, staff, hours, pricing notes, pages, links, forms, and content so the site reflects the business today.',
      },
      {
        title: 'Conversion and contact flow',
        description:
          'Make calls, forms, booking links, and quote requests obvious on desktop and mobile so visitors know what to do next.',
      },
      {
        title: 'Local SEO basics',
        description:
          'Improve titles, descriptions, service pages, internal links, location signals, and practical content that supports local search.',
      },
      {
        title: 'Audit reports and follow-up',
        description:
          'Run recurring checks for broken links, page speed, mobile layout, visible changes, and competitor updates, then turn findings into action.',
      },
    ],
  },
  letter: {
    eyebrow: 'A Note From Mathew',
    title: 'Most local business websites need steady attention, not another one-time redesign.',
    body: [
      'I built this service for owners who know their online presence matters but do not have time to manage every website update, broken form, old service page, or missed follow-up.',
      'The goal is simple: keep your business easier to trust, easier to contact, and easier to find. I focus on practical work that supports leads, reputation, and customer confidence.',
    ],
    signature: 'Mathew Uckele',
  },
  criteriaPreview: {
    eyebrow: 'Service Packages',
    title: 'Start with the level of support your business actually needs',
    description:
      'Each package is designed around practical owner needs: a quick audit, ongoing updates, or a more complete monthly online presence partner.',
    list: [
      'Website audit with top lead-reducing issues',
      'Monthly website updates and maintenance',
      'Contact form and call-to-action improvements',
      'Local SEO basics and service-page cleanup',
      'Competitor and website change monitoring',
      'Plain-English monthly recommendations',
    ],
    industries: ['Home services', 'Medical and wellness', 'Local contractors', 'Professional services', 'Specialty retail'],
  },
  transitionApproach: {
    eyebrow: 'How It Works',
    title: 'Audit, prioritize, fix, and keep improving',
    description:
      'The work starts with a focused review of the current site and turns into a short list of improvements that can be handled in a steady monthly rhythm.',
    steps: [
      {
        title: 'Review the current online presence',
        description:
          'I check the website, contact paths, mobile experience, page titles, calls to action, trust signals, and obvious competitor movement.',
      },
      {
        title: 'Prioritize the highest-impact fixes',
        description:
          'You get a short list of issues that are easy to understand and tied directly to leads, trust, speed, or customer clarity.',
      },
      {
        title: 'Handle updates on a cadence',
        description:
          'Once priorities are clear, I can manage updates, pages, forms, content, reports, and follow-up items on a monthly basis.',
      },
    ],
  },
  individualBuyer: {
    eyebrow: 'Why This Matters',
    title: 'Your website is often the first employee customers meet',
    description:
      'If that first impression is outdated, slow, confusing, or hard to contact from, good referrals and search traffic can leak away.',
    cards: [
      {
        title: 'Trust before the first call',
        description:
          'Customers look for clear services, current information, reviews, photos, and signs that the business is active and reliable.',
      },
      {
        title: 'Less friction for customers',
        description:
          'Stronger calls to action, simpler forms, and better mobile layout make it easier for customers to take the next step.',
      },
      {
        title: 'Better follow-up discipline',
        description:
          'Tracking leads, notes, emails, calls, and next actions keeps interested prospects from being forgotten.',
      },
      {
        title: 'A site that changes with the business',
        description:
          'New services, seasonal offers, staff updates, and customer questions should make it onto the website quickly.',
      },
    ],
  },
  faqPreview: {
    eyebrow: 'Frequently Asked Questions',
    title: 'Common questions before starting',
    items: [
      {
        question: 'Do I need a full redesign?',
        answer:
          'Not always. Many businesses need practical fixes first: better contact flow, current service pages, cleaner mobile layout, stronger trust signals, and faster updates.',
      },
      {
        question: 'Can you work with my current website?',
        answer:
          'Usually, yes. The first step is reviewing the platform, access, current issues, and what updates are realistic without rebuilding everything.',
      },
      {
        question: 'What happens after the audit?',
        answer:
          'You get a short, plain-English list of recommended fixes. From there we can schedule a call, choose priorities, and decide whether monthly support makes sense.',
      },
      {
        question: 'Do you replace my marketing agency?',
        answer:
          'Not necessarily. This can complement an existing agency or fill the gap for businesses that need hands-on website and online presence operations.',
      },
    ],
  },
  references: {
    eyebrow: 'Proof To Add Over Time',
    title: 'Results and testimonials can live here as the service grows',
    description:
      'This section is reserved for future client quotes, before-and-after examples, audit wins, and measurable improvements.',
    items: [
      {
        label: 'Website Fix Placeholder',
        text: 'Add a future example of a broken form, mobile issue, or outdated service page that was corrected.',
      },
      {
        label: 'Lead Flow Placeholder',
        text: 'Add a future note about clearer calls to action, better contact paths, or improved booking flow.',
      },
      {
        label: 'Client Testimonial Placeholder',
        text: 'Add a future quote from a business owner describing the monthly support experience.',
      },
    ],
  },
  contactCta: {
    title: 'Want to know what is costing your website leads?',
    description:
      'Send the website URL and I will review the obvious issues before a short call.',
    primaryCta: bookingCta,
    secondaryCta: schedulingUrl
      ? { label: 'Request An Audit Instead', href: '/contact' }
      : { label: 'See The Process', href: '/process' },
  },
};

export const aboutPage = {
  hero: {
    eyebrow: 'About',
    title: 'A practical online presence partner for local business owners',
    description:
      'I help small businesses keep websites current, improve lead flow, and turn online presence problems into manageable monthly work.',
  },
  shortBio: {
    title: 'Short Bio',
    body: [
      'My background spans business administration, sales, operations, business development, and technical problem solving.',
      'That mix matters for local businesses because the best website work is not only design. It is understanding customers, operations, trust, and the owner’s time.',
      'I focus on practical improvements: make the website easier to use, easier to update, and more useful for generating real conversations.',
    ],
  },
  story: {
    title: 'Why This Service Exists',
    paragraphs: [
      'Many good local businesses have websites that slowly fall behind the actual business. Services change, teams change, offers change, and small issues go unnoticed until a customer cannot get through.',
      'Owners often know something needs attention, but they do not have time to chase every update or decode every technical recommendation. This service is designed to be a steady operating partner for that gap.',
      'The work is intentionally practical: find the issues that reduce trust or leads, fix them in order, and keep the online presence moving as the business changes.',
    ],
  },
  values: {
    title: 'How I Work',
    items: [
      {
        title: 'Start with the customer path',
        description:
          'Every recommendation should connect back to what a customer sees, trusts, clicks, reads, or submits.',
      },
      {
        title: 'Keep the owner informed',
        description:
          'Updates and reports should be clear enough that a busy owner can understand what changed and why it matters.',
      },
      {
        title: 'Fix practical issues first',
        description:
          'Broken links, bad forms, weak calls to action, outdated information, and mobile problems usually come before cosmetic polish.',
      },
      {
        title: 'Build a steady cadence',
        description:
          'Online presence work is strongest when it is maintained over time instead of ignored between redesigns.',
      },
    ],
  },
  whyBuy: {
    title: 'Why Partner With Me',
    paragraphs: [
      'Local businesses need someone who can understand both the business and the website. I care about how leads actually arrive, how owners follow up, and where trust breaks down online.',
      'The goal is to become a reliable partner for updates, audits, fixes, and practical growth support, not another vendor adding complexity.',
    ],
  },
};

export const criteriaPage = {
  hero: {
    eyebrow: 'Services And Packages',
    title: 'Website and online presence support that fits the stage of the business',
    description:
      'Choose a focused audit, monthly update support, or a fuller online presence management package.',
  },
  fit: {
    title: 'What the service can cover',
    items: [
      'Website updates, page edits, service changes, and seasonal announcements',
      'Contact forms, phone links, booking links, and calls to action',
      'Mobile usability review and obvious layout fixes',
      'Page titles, meta descriptions, local SEO basics, and service-page clarity',
      'Broken links, slow or unusually large pages, and outdated content checks',
      'CRM notes, follow-up reminders, audit reports, and outreach personalization',
    ],
  },
  specifics: [
    {
      label: 'Audit Sprint',
      value: 'One-time website review with top issues, screenshots or notes, and a prioritized fix list.',
    },
    {
      label: 'Monthly Care',
      value: 'Recurring website updates, broken-link checks, copy edits, contact-flow fixes, and light reporting.',
    },
    {
      label: 'Growth Partner',
      value: 'Monthly website support plus local SEO improvements, landing pages, competitor monitoring, and lead tracking.',
    },
    {
      label: 'Best fit',
      value: 'Local service businesses that rely on calls, quote requests, booking forms, referrals, and trust-building content.',
    },
  ],
  situations: {
    title: 'Good situations for a first call',
    items: [
      'Your website is outdated but a full redesign feels like too much',
      'Customers ask questions that the website should already answer',
      'Forms, phone links, or booking paths are hard to use on mobile',
      'You need regular updates but do not want to manage freelancers each time',
      'You want a short audit before deciding what to fix',
    ],
  },
  notLookingFor: {
    title: 'Not the right fit',
    items: [
      'Businesses looking for overnight ranking guarantees',
      'Projects that require fake reviews, spam outreach, or misleading claims',
      'Teams that want strategy decks but no practical implementation',
      'Large enterprise projects that need a full agency department',
      'One-time design requests with no access to make or verify changes',
    ],
  },
};

export const whyPartnerPage = {
  hero: {
    eyebrow: 'Why Partner',
    title: 'A steady partner for the website work that keeps slipping',
    description:
      'Most owners do not need more dashboards. They need someone who can find the online issues, explain them clearly, and keep the website moving.',
  },
  intro:
    'The partnership should make your business easier to trust and easier to contact while reducing the amount of website management sitting on your plate.',
  concerns: [
    {
      title: 'Clear priorities',
      description:
        'You get a short list of what matters most instead of a long technical backlog with no connection to leads.',
    },
    {
      title: 'Less owner follow-up',
      description:
        'Updates, checks, notes, and reminders live in one workflow so you are not chasing scattered website tasks.',
    },
    {
      title: 'Better customer trust',
      description:
        'Fresh services, current contact information, reviews, proof points, and useful pages all help customers feel confident.',
    },
    {
      title: 'Flexible monthly cadence',
      description:
        'Some months are maintenance-heavy. Others need campaign pages, seasonal updates, or competitor research. The work can adapt.',
    },
    {
      title: 'Secure access handling',
      description:
        'Client files, website assets, and account details should move through a safer handoff process than email threads.',
    },
    {
      title: 'Plain-English reporting',
      description:
        'Reports should tell you what changed, what was found, what is next, and why it matters for leads.',
    },
    {
      title: 'No bloated agency process',
      description:
        'This is designed for practical implementation and owner clarity, not layers of account management.',
    },
    {
      title: 'Built around leads',
      description:
        'The point is to make it easier for real customers to call, book, request a quote, or submit a form.',
    },
  ],
};

export const processPage = {
  hero: {
    eyebrow: 'Process',
    title: 'A simple path from website audit to monthly support',
    description:
      'Start with a focused review, decide what matters, and turn the highest-impact fixes into a manageable cadence.',
  },
  steps: [
    {
      step: '01',
      title: 'Submit the business website',
      description:
        'Send the website URL, business type, and what you want more of: calls, bookings, quote requests, form fills, or clearer customer trust.',
    },
    {
      step: '02',
      title: 'Run a practical lead-flow audit',
      description:
        'I check uptime, SSL, broken links, mobile layout, speed, page titles, calls to action, contact flow, and obvious trust gaps.',
    },
    {
      step: '03',
      title: 'Review the highest-impact findings',
      description:
        'You get plain-English notes focused on issues a business owner can understand and decide on quickly.',
    },
    {
      step: '04',
      title: 'Choose the right support level',
      description:
        'We decide whether you need a one-time fix sprint, monthly website care, or fuller online presence management.',
    },
    {
      step: '05',
      title: 'Make updates and track follow-up',
      description:
        'Website work, client notes, emails, calls, tasks, and invoices are kept organized so next steps do not get lost.',
    },
    {
      step: '06',
      title: 'Keep improving monthly',
      description:
        'The site gets checked, updated, and improved as services, offers, competitors, and customer needs change.',
    },
  ],
  principles: [
    'Lead flow first',
    'Clear owner communication',
    'Practical fixes before polish',
    'Mobile usability matters',
    'Monthly consistency',
  ],
};

export const faqItems = [
  {
    question: 'Do I need a full new website?',
    answer:
      'Not always. Many local businesses can get meaningful improvement from updates, contact-flow cleanup, mobile fixes, better service pages, and stronger calls to action.',
  },
  {
    question: 'Can you work with my current platform?',
    answer:
      'Usually, yes. The first review looks at your current CMS or site builder, access, hosting, forms, analytics, and what can be safely changed.',
  },
  {
    question: 'What does the audit include?',
    answer:
      'The audit checks uptime, SSL, broken links, mobile layout, title and meta basics, contact flow, missing calls to action, speed concerns, outdated visible content, and obvious trust gaps.',
  },
  {
    question: 'How do monthly packages work?',
    answer:
      'Monthly support is built around a fixed cadence of updates, checks, recommendations, and follow-up. The exact scope depends on the package and the level of activity your business needs.',
  },
  {
    question: 'Can you help with local SEO?',
    answer:
      'Yes, for practical basics: service-page clarity, title and meta improvements, internal links, location signals, Google Business Profile recommendations, and content ideas tied to customer questions.',
  },
  {
    question: 'Do you track leads and follow-up?',
    answer:
      'Yes. The CRM tracks prospects, notes, calls, emails, next actions, website audit reports, and email engagement so follow-up can be prioritized.',
  },
  {
    question: 'Can I book a short call first?',
    answer:
      'Yes. Send the form or use the scheduling link when it is enabled. A short call is the best way to decide whether the audit or monthly support makes sense.',
  },
  {
    question: 'What access do you need?',
    answer:
      'That depends on the work. Common access includes website admin, domain or DNS, analytics, Search Console, booking tools, form tools, and brand assets. Sensitive details should be shared through secure handoff.',
  },
];

export const contactPage = {
  hero: {
    eyebrow: 'Request An Audit',
    title: 'Find out what your website may be costing you in leads',
    description:
      'Send your business website and a short note. I will review the obvious online presence issues and follow up with next steps or a short call.',
  },
  contactIntro:
    'Use this form to request a website audit, ask about monthly support, or share what you want your online presence to do better.',
  sidePanels: [
    {
      title: 'What to expect',
      items: [
        'A direct reply from Mathew Uckele',
        'A short review of your website and contact flow',
        'Plain-English recommendations tied to leads, trust, and usability',
      ],
    },
    {
      title: 'Contact and scheduling',
      items: contactDetailItems,
    },
  ],
  callNote: {
    title: 'Prefer a quick call?',
    description:
      schedulingUrl
        ? 'Use the scheduling link above to book a short conversation. Bring the website URL and the main customer action you want more of.'
        : 'Send the form with your website URL and preferred times. I will follow up to schedule a short conversation.',
    primaryCta: bookingCta,
    secondaryCta: schedulingUrl
      ? { label: 'Use The Form Instead', href: '#contact-form' }
      : { label: 'View Services', href: '/services' },
  },
};
