export { seoContent } from './seoMetadata.js';
export { faqItems } from './faqContent.js';

const publicSiteUrl = (import.meta.env.VITE_PUBLIC_SITE_URL || 'https://www.uckelegroup.com').replace(/\/+$/, '');
const publicEmail = String(import.meta.env.VITE_PUBLIC_CONTACT_EMAIL || 'mathew@uckelegroup.com').trim();
const publicPhone = String(import.meta.env.VITE_PUBLIC_CONTACT_PHONE || '914.361.9153').trim();
const rawPublicLinkedin = String(import.meta.env.VITE_PUBLIC_LINKEDIN_URL || 'https://www.linkedin.com/in/mathew-uckele').trim();

function toExternalUrl(url) {
  if (!url) {
    return '';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `https://${url.replace(/^\/+/, '')}`;
}

const publicLinkedin = toExternalUrl(rawPublicLinkedin);

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
        value: 'Use the contact form for a confidential reply',
      },
  publicPhone
    ? {
        kind: 'phone',
        label: 'Phone',
        value: publicPhone,
        href: `tel:${publicPhone.replace(/[^\d+]/g, '')}`,
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
  contactDetailItems,
  downloadHref: '/downloads/uckele-group-acquisition-criteria.pdf',
  socialImage: '/og.png',
  socialImageUrl: toAbsoluteUrl('/og.png'),
};

export const navigation = [
  { label: 'Home', path: '/' },
  { label: 'About', path: '/about' },
  { label: 'What I’m Looking For', path: '/criteria' },
  { label: 'Why Sell To Me', path: '/why-sell-to-me' },
  { label: 'Process', path: '/process' },
  { label: 'FAQ', path: '/faq' },
  { label: 'Contact', path: '/contact' },
];

export const homePage = {
  hero: {
    eyebrow: 'Long-Term Small Business Buyer',
    title: 'A thoughtful long-term home for a great small business',
    description:
      'Uckele Group is the acquisition platform of Mathew Uckele. I am looking to acquire and operate a strong small business for the long term with continuity, care, and respect for the people who built it.',
    primaryCta: { label: 'Start a Conversation', href: '/contact' },
    secondaryCta: { label: 'What I’m Looking For', href: '/criteria' },
    signals: [
      'Direct conversation with the future owner',
      'Long-term mindset, not a flip',
      'Confidential and respectful outreach',
      'Flexible transition approach',
    ],
    founderCard: {
      title: 'What owners can expect',
      body: 'If you are considering succession, retirement, or simply the next chapter, this should feel like a serious but human conversation. The goal is a practical transition that protects what is already working.',
      points: [
        'Continuity for employees and customers',
        'A calm process without games or pressure',
        'A buyer who values relationships and reputation',
      ],
    },
  },
  operatorExperience: {
    eyebrow: 'Operating Experience',
    title: 'Experience grounded in real operating responsibility',
    description:
      'My background combines hands-on leadership in a growing healthcare services business with earlier operating and commercial roles inside scaled organizations.',
    items: [
      {
        label: 'Current operating role',
        title: 'Co-founder and President',
        description:
          'At Golden Behavior Connection, I work directly across operations, staffing, compliance, revenue cycle management, sales execution, and financial performance.',
      },
      {
        label: 'Hands-on scope',
        title: 'Execution across the business',
        description:
          'My experience spans team leadership, process implementation, customer growth, operating discipline, and the practical systems that keep a service business healthy.',
      },
      {
        label: 'Earlier experience',
        title: 'Scaled company perspective',
        description:
          'Prior roles at Tripadvisor, Better Mortgage, and Wayfair developed my approach to growth, training, process improvement, and leading through change.',
      },
    ],
  },
  criteriaAtAGlance: {
    eyebrow: 'Acquisition Criteria',
    title: 'A clear fit, at a glance',
    description:
      'I am looking for a durable service business with healthy fundamentals, loyal customers, and an operating model that can be understood and supported for the long term.',
    details: [
      {
        label: 'Revenue',
        value: '$1M–$5M',
        note: 'Primary target range, with flexibility for an exceptional fit.',
      },
      {
        label: 'SDE / EBITDA',
        value: '$250K–$750K+',
        note: 'Open to select larger opportunities with durable cash flow.',
      },
      {
        label: 'Geography',
        value: 'Southern California',
        note: 'Preferred, with nationwide flexibility for the right business and transition plan.',
      },
      {
        label: 'Business profile',
        value: 'Established services',
        note: 'Stable, profitable, understandable, and built around repeat customer relationships.',
      },
    ],
    industries: [
      'Professional services',
      'Healthcare services',
      'Home services',
      'Environmental and waste services',
      'Pet care and veterinary-related services',
    ],
  },
  readiness: {
    eyebrow: 'Acquisition Readiness',
    title: 'Prepared for a serious process and a long-term operating commitment',
    description:
      'The right transaction begins with mutual fit. From there, sellers and their advisors should receive direct communication, realistic expectations, and a practical path through financing, diligence, and transition planning.',
    commitments: [
      {
        title: 'Direct ownership and accountability',
        description:
          'Uckele Group is my acquisition platform. I am the principal decision-maker and the person intending to take responsibility for the company after closing.',
      },
      {
        title: 'One-company operating focus',
        description:
          'I am seeking one strong business where I can commit to long-term ownership, work closely with the existing team, and build on what is already successful.',
      },
      {
        title: 'Practical financing conversations',
        description:
          'Transaction structure depends on the business. Once mutual fit is established, the financing approach, timing, and relevant readiness information can be discussed directly with the owner and advisors.',
      },
    ],
    expectations: [
      'A direct conversation with the intended future owner',
      'Mutual fit before detailed information is requested',
      'Clear communication with brokers, lenders, attorneys, and other advisors',
      'A transition plan shaped around the company, team, and seller timeline',
    ],
  },
  transitionApproach: {
    eyebrow: 'Transition Process',
    title: 'Protect the core of what made the business worth buying',
    description:
      'A transition works best when it is planned around continuity, communication, and the specific realities of the business.',
    steps: [
      {
        title: 'Listen before changing anything',
        description:
          'The first priority is understanding how the company actually works, what customers value, and what the team relies on day to day.',
      },
      {
        title: 'Preserve the parts that create trust',
        description:
          'That usually means protecting the reputation, customer relationships, service standards, and employee stability that have already been earned.',
      },
      {
        title: 'Build a transition plan that fits your timeline',
        description:
          'Some owners want a quick handoff. Others want a measured transition or a continued advisory role. I am open to practical arrangements that support continuity.',
      },
    ],
  },
  professionalCredibility: {
    eyebrow: 'Professional Credibility',
    title: 'A background sellers and advisors can evaluate directly',
    description:
      'Trust should work in both directions. My operating history, professional profile, and approach to a transaction should be open to the same thoughtful evaluation I bring to a business.',
    items: [
      {
        label: 'Operating leadership',
        title: 'Golden Behavior Connection',
        description:
          'Current co-founder and President of an ABA healthcare services practice, with direct exposure to the operational and financial responsibilities of company leadership.',
      },
      {
        label: 'Professional background',
        title: 'Tripadvisor · Better Mortgage · Wayfair',
        description:
          'Earlier roles across operating, commercial, growth, and process-focused environments provide perspective from businesses at different stages and scales.',
      },
      {
        label: 'Transparent evaluation',
        title: 'Trust works both ways',
        description:
          'As a conversation becomes serious, owners and their advisors should have enough context to evaluate my background, readiness, and fit as a future steward.',
      },
    ],
  },
  essentialFaqs: {
    eyebrow: 'Essential Questions',
    title: 'What owners usually want to know first',
    description:
      'Straightforward answers about who is buying, what fits, how the process works, and what happens after a first conversation.',
    items: [
      {
        question: 'Are you a private equity firm?',
        answer:
          'No. Uckele Group is centered on Mathew Uckele as an individual buyer and future operator. The goal is long-term ownership of one strong business, not a roll-up strategy.',
      },
      {
        question: 'Will you personally operate the business?',
        answer:
          'The intention is active, long-term ownership rather than a passive investment. I want to work closely with the existing team, learn the operation in depth, and take direct responsibility for the company’s next chapter.',
      },
      {
        question: 'How do you expect to finance an acquisition?',
        answer:
          'The right financing structure depends on the company, its cash flow, and the seller’s goals. Once there is mutual fit, I am prepared to discuss the proposed capital structure, financing path, timing, and relevant readiness information directly with the owner and advisors.',
      },
      {
        question: 'What size businesses are you looking for?',
        answer:
          'My primary target is approximately $1M to $5M in revenue and $250K to $750K+ in SDE or EBITDA, with flexibility for select larger opportunities that have durable cash flow and a clear operating fit.',
      },
      {
        question: 'Will our conversations be confidential?',
        answer:
          'Yes. Early conversations are handled discreetly, and sensitive information should only be shared when there is mutual interest and an appropriate process in place.',
      },
    ],
  },
  contactCta: {
    title: 'Confidential conversations welcome',
    description:
      'If you own a business and are considering a future transition, or if you represent an opportunity that may be a fit, I would welcome the conversation.',
    primaryCta: { label: 'Contact Mathew', href: '/contact' },
    secondaryCta: { label: 'See The Full Process', href: '/process' },
  },
};

export const aboutPage = {
  hero: {
    eyebrow: 'About',
    title: 'A grounded buyer who wants to own and operate a real business for the long term',
    description:
      'My name is Mathew Uckele. I am a Los Angeles-based operator and acquisition entrepreneur focused on acquiring and growing an established service business for the long term.',
  },
  shortBio: {
    title: 'Short Bio',
    body: [
      'I am the co-founder and President of Golden Behavior Connection, an ABA healthcare services practice. That work has given me direct experience with operations, staffing, compliance, revenue cycle management, sales execution, and financial performance.',
      'Earlier in my career, I held senior operating and commercial roles at Tripadvisor, Better Mortgage, and Wayfair, where I worked on scaling teams, improving processes, training, and growth initiatives.',
      'I launched Uckele Group as my acquisition platform to buy and operate a durable, cash-flowing service business where I can bring disciplined management, operational support, and long-term ownership.',
    ],
  },
  story: {
    title: 'My Story',
    paragraphs: [
      'I have always been drawn to businesses that are quietly strong: companies with dependable customers, solid operations, and owners who built something valuable through consistency rather than hype. Those are often the businesses that matter most in their communities and industries, even if they do not draw a lot of attention.',
      'My background combines healthcare services operations, sales and growth leadership, software and process implementation, and team-building experience. That combination has shaped how I think: practical systems, clear communication, steady follow-through, and respect for the details that keep a business healthy.',
      'Buying and operating a small business is appealing to me because it combines responsibility with long-term stewardship. I want to carry forward something real, support the team and customer relationships already in place, and create durable value over time rather than chase quick financial outcomes.',
    ],
  },
  values: {
    title: 'Values And Principles',
    items: [
      {
        title: 'Respect what already works',
        description:
          'Strong businesses usually have good reasons for the way they operate. The first job is to understand the strengths before trying to improve anything.',
      },
      {
        title: 'Take people seriously',
        description:
          'Employees, customers, vendors, and long-standing relationships should never be treated as secondary to the transaction itself.',
      },
      {
        title: 'Solve problems practically',
        description:
          'I value clear thinking, operational follow-through, and decisions grounded in the reality of how the business runs.',
      },
      {
        title: 'Think in years, not quarters',
        description:
          'The objective is to be a stable long-term owner who helps the company remain strong for employees, customers, and the next chapter of growth.',
      },
    ],
  },
  whyBuy: {
    title: 'Why I Want To Buy A Business',
    paragraphs: [
      'I want the responsibility of ownership. Not ownership in the abstract, but the real responsibility that comes with leading a company, protecting relationships, and making careful decisions over time.',
      'I am especially interested in acquiring from an owner who cares deeply about continuity. If you have spent years building a reputation, taking care of customers, and creating opportunity for employees, I understand why choosing the next owner matters. My goal is to be the kind of buyer who deserves that trust.',
    ],
  },
};

export const criteriaPage = {
  hero: {
    eyebrow: 'Acquisition Criteria',
    title: 'What I’m Looking For',
    description:
      'I am focused on stable, understandable small businesses with a strong reputation, repeat customer relationships, and a clear path to long-term ownership.',
  },
  fit: {
    title: 'A strong fit typically looks like this',
    items: [
      'Stable and profitable with healthy fundamentals',
      'Recurring revenue or repeat customer relationships preferred',
      'Simple, understandable operating model',
      'Strong reputation, loyal customers, and quality service',
      'Solid team, dependable processes, or institutional knowledge worth preserving',
      'Owner exploring retirement, transition, succession, or reduced day-to-day involvement',
    ],
  },
  specifics: [
    {
      label: 'Industries of interest',
      value: 'Professional services, healthcare services, tech-enabled operations, home services, environmental or waste services, pet care, and veterinary-related services',
    },
    {
      label: 'Location preference',
      value: 'Southern California preferred. Open nationwide for a strong business with the right fundamentals, team, and transition plan.',
    },
    {
      label: 'SDE / EBITDA range',
      value: '$250K to $750K+, with flexibility up to roughly $2M for the right opportunity',
    },
    {
      label: 'Revenue range',
      value: 'Approximately $1M to $5M',
    },
  ],
  situations: {
    title: 'Seller situations that often make sense',
    items: [
      'Retirement or succession planning',
      'Owner wants to step back from daily operations',
      'Business has momentum but needs a new long-term owner',
      'Seller wants continuity for employees and customers',
      'Transition can benefit from flexible timing or ongoing seller involvement',
    ],
  },
  notLookingFor: {
    title: 'What I Am Not Looking For',
    items: [
      'Highly speculative startups or venture-style bets',
      'Businesses dependent on one unstable customer or one fragile relationship',
      'Distressed situations that require turnaround capital or emergency restructuring',
      'Businesses with major unresolved legal, regulatory, or compliance issues',
      'Business models I cannot understand well enough to operate responsibly',
    ],
  },
};

export const sellerConcernsPage = {
  hero: {
    eyebrow: 'Why Sell To Me',
    title: 'A buyer who understands the real concerns behind a sale',
    description:
      'Selling a business is rarely just about price. It is also about legacy, employees, customers, confidentiality, and the confidence that the next owner will be a good steward.',
  },
  intro:
    'Those are exactly the issues I think about. My approach is built around preserving what matters, communicating clearly, and avoiding the kind of pressure that makes owners distrust the process.',
  concerns: [
    {
      title: 'Protecting your legacy',
      description:
        'The value of your business is not only in the financial statements. It is also in the reputation, relationships, and standards you built over time. I want to preserve that foundation.',
    },
    {
      title: 'Taking care of employees',
      description:
        'Employees often carry the experience, customer trust, and operational knowledge that make a business work. Continuity for the team is an important part of any transition.',
    },
    {
      title: 'Maintaining customer relationships',
      description:
        'Customers stay because they trust the business. That trust should be handled carefully during ownership changes, not treated like an afterthought.',
    },
    {
      title: 'Flexible transition timelines',
      description:
        'Some sellers want a fast process. Others want time to hand off relationships or remain involved temporarily. I am open to practical structures that support a smooth transition.',
    },
    {
      title: 'Confidentiality and professionalism',
      description:
        'Discretion matters, especially early. Conversations should be respectful, limited to the right people, and paced appropriately for the sensitivity of the situation.',
    },
    {
      title: 'Fair and thoughtful process',
      description:
        'A good process should be clear, professional, and grounded in the realities of the business. It should not feel performative, chaotic, or overly aggressive.',
    },
    {
      title: 'No private equity playbook',
      description:
        'This is not about buying a company to fold it into a portfolio or force a short-term formula onto it. The goal is long-term ownership and careful stewardship.',
    },
    {
      title: 'No rush, pressure, or games',
      description:
        'Owners deserve time to evaluate fit, ask questions, and think through the right outcome. I prefer calm, honest conversations over artificial urgency.',
    },
  ],
};

export const processPage = {
  hero: {
    eyebrow: 'Process',
    title: 'A clear, respectful acquisition process',
    description:
      'Good transactions do not need drama. The goal is straightforward communication, appropriate discretion, and a pace that fits the business and the owner.',
  },
  steps: [
    {
      step: '01',
      title: 'Introductory conversation',
      description:
        'A brief initial discussion to understand your goals, timing, and the business at a high level. This should feel simple and pressure-free.',
    },
    {
      step: '02',
      title: 'High-level fit review',
      description:
        'If there is mutual interest, I will evaluate whether the company fits my criteria and whether a deeper conversation makes sense.',
    },
    {
      step: '03',
      title: 'Confidential information review',
      description:
        'With the right protections in place, I review key business information carefully and work to understand the operation, not just the numbers. When appropriate, sensitive materials can move through a secure document request and upload flow.',
    },
    {
      step: '04',
      title: 'Letter of intent or offer',
      description:
        'If the business is a fit, I move toward a clear indication of interest or letter of intent with practical terms and thoughtful communication.',
    },
    {
      step: '05',
      title: 'Diligence and transition planning',
      description:
        'This stage is about confirming details, aligning on expectations, and planning how to protect employees, customers, and continuity after closing.',
    },
    {
      step: '06',
      title: 'Closing and handoff',
      description:
        'Once the work is done and both sides are comfortable, the transaction closes and the ownership transition is carried out carefully and professionally.',
    },
  ],
  principles: [
    'Confidentiality where it matters',
    'Transparent communication',
    'Respect for your advisors and team',
    'No artificial deadlines or pressure tactics',
    'A practical focus on continuity after closing',
  ],
};

export const contactPage = {
  hero: {
    eyebrow: 'Contact',
    title: 'Start a confidential conversation',
    description:
      'If you are an owner considering succession, a broker with a relevant opportunity, or a referral partner who knows a strong business, I would welcome the conversation.',
  },
  contactIntro:
    'This form is designed for early, respectful conversations. Share as much or as little detail as is appropriate at this stage.',
  sidePanels: [
    {
      title: 'What to expect',
      items: [
        'A direct reply from Mathew Uckele',
        'A confidential, no-pressure introduction',
        'A practical discussion about fit and next steps',
      ],
    },
    {
      title: 'Contact details',
      items: contactDetailItems,
    },
  ],
  brokerNote: {
    title: 'Brokers and referral partners',
    description:
      'Relevant introductions are welcome. If you represent a durable small business or know an owner exploring a future transition, feel free to reach out directly through the same form.',
  },
};
