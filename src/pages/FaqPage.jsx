import { ArrowRight } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import FaqAccordion from '../components/FaqAccordion';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import { faqItems, seoContent } from '../content/siteContent';

export default function FaqPage() {
  return (
    <>
      <Seo {...seoContent.faq} />

      <PageHero
        description="The goal here is to answer the questions local business owners often have before requesting an audit or monthly website support."
        eyebrow="FAQ"
        title="Straightforward answers about online presence support"
      />

      <section className="section-shell mt-10">
        <Reveal>
          <FaqAccordion items={faqItems} />
        </Reveal>
      </section>

      <section className="section-shell mt-20">
        <Reveal className="panel px-7 py-10 sm:px-10 sm:py-12">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <span className="eyebrow">Still Have Questions</span>
              <h2 className="mt-5 font-display text-3xl leading-tight text-ink sm:text-[2.4rem]">Every website and business situation is different</h2>
              <p className="mt-4 text-base leading-7 text-ink/72">
                If you want to talk through your current website, the next step is a short review and a practical conversation about what to fix first.
              </p>
            </div>

            <ButtonLink href="/contact">
              Request An Audit <ArrowRight className="h-4 w-4" />
            </ButtonLink>
          </div>
        </Reveal>
      </section>
    </>
  );
}
