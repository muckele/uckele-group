import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import { seoContent, siteConfig } from '../content/siteContent';

const sections = [
  {
    title: 'Information collected',
    items: [
      'Contact details you submit, including name, email, phone number, business name, website URL, role, service interest, timeline, and message details.',
      'CRM activity needed to manage follow-up, including notes, status, tags, calls, emails, uploaded document metadata, and invoice records when enabled.',
      'Basic technical information such as IP-derived rate-limit data, browser user agent, spam signals, and email engagement events from configured providers.',
    ],
  },
  {
    title: 'How information is used',
    items: [
      'To respond to website audit requests, schedule calls, prepare recommendations, and provide online presence management services.',
      'To operate the private CRM, track follow-up, send requested upload links, create invoices, and maintain client records.',
      'To protect the site from spam, abuse, duplicate submissions, and unauthorized admin access.',
    ],
  },
  {
    title: 'Sharing and service providers',
    items: [
      'Information may be processed by hosting, email delivery, analytics, scheduling, payment, CRM, or storage providers used to run the business.',
      'Information is not sold. It is shared only as needed to operate the site, communicate with prospects or clients, comply with law, or protect the service.',
    ],
  },
  {
    title: 'Your choices',
    items: [
      `You can ask to update or delete contact information by emailing ${siteConfig.email}.`,
      'Marketing emails should include a clear way to opt out. You can also reply directly and ask not to be contacted again.',
      'Sensitive website assets or account details should be shared through the secure upload flow when available, not through ordinary email.',
    ],
  },
];

export default function PrivacyPage() {
  return (
    <>
      <Seo {...seoContent.privacy} />

      <PageHero
        eyebrow="Privacy"
        title="How website audit and CRM information is handled"
        description="This page explains what information Uckele Group collects, how it is used, and how business owners can request changes."
      />

      <section className="section-shell mt-10">
        <Reveal className="panel px-7 py-9 sm:px-10">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Last updated June 15, 2026</p>
          <p className="mt-5 max-w-4xl text-base leading-8 text-ink/74">
            Uckele Group uses submitted information to review websites, manage prospect and client follow-up, and provide online presence support.
            This policy is a practical summary and should be reviewed before launch if your service terms, providers, or data handling change.
          </p>
        </Reveal>
      </section>

      <section className="section-shell mt-12">
        <div className="grid gap-6 md:grid-cols-2">
          {sections.map((section, index) => (
            <Reveal className="panel p-7 sm:p-8" delay={index * 70} key={section.title}>
              <h2 className="text-2xl font-semibold text-ink">{section.title}</h2>
              <ul className="mt-5 space-y-3 text-sm leading-7 text-ink/74">
                {section.items.map((item) => (
                  <li className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-3" key={item}>
                    {item}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
