import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import { seoContent, siteConfig } from '../content/siteContent';

const terms = [
  {
    title: 'Website and audit requests',
    description:
      'Submitting a form or booking a call does not create a client relationship by itself. A project begins only after scope, pricing, access, and payment terms are agreed in writing.',
  },
  {
    title: 'Recommendations',
    description:
      'Audit findings and recommendations are based on visible website, search, contact-flow, CRM, and marketing information available at the time of review. Search rankings, lead volume, revenue, and third-party platform outcomes are not guaranteed.',
  },
  {
    title: 'Client access and assets',
    description:
      'Clients are responsible for providing accurate business information, approvals, platform access, brand assets, and any required licenses or permissions before implementation work can be completed.',
  },
  {
    title: 'Payments and invoices',
    description:
      'Invoices, retainers, package terms, and renewal dates should be documented before work begins. Late, paused, or cancelled payments may delay website updates, reporting, or managed support.',
  },
  {
    title: 'Email outreach',
    description:
      `Uckele Group may send business-to-business outreach related to website audits or online presence support. Recipients can opt out by replying to the email or contacting ${siteConfig.email}.`,
  },
  {
    title: 'No prohibited use',
    description:
      'The service is not intended for misleading claims, fake reviews, spam campaigns, unlawful scraping, credential sharing outside approved channels, or work that violates third-party platform rules.',
  },
];

export default function TermsPage() {
  return (
    <>
      <Seo {...seoContent.terms} />

      <PageHero
        eyebrow="Terms"
        title="Service terms and expectations"
        description="These terms outline how website audits, online presence support, CRM work, invoicing, and outreach are handled."
      />

      <section className="section-shell mt-10">
        <Reveal className="panel px-7 py-9 sm:px-10">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Last updated June 15, 2026</p>
          <p className="mt-5 max-w-4xl text-base leading-8 text-ink/74">
            These terms are a plain-English operating baseline for Uckele Group. Final project scope, pricing, ownership, access, and payment
            details should be confirmed in a written agreement or invoice before client work begins.
          </p>
        </Reveal>
      </section>

      <section className="section-shell mt-12">
        <div className="grid gap-6 md:grid-cols-2">
          {terms.map((term, index) => (
            <Reveal className="panel p-7 sm:p-8" delay={index * 70} key={term.title}>
              <h2 className="text-2xl font-semibold text-ink">{term.title}</h2>
              <p className="mt-4 text-sm leading-7 text-ink/74">{term.description}</p>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
