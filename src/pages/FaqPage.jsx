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
        description="The goal here is to answer the questions sellers most often have before deciding whether to engage in a conversation."
        eyebrow="FAQ"
        title="Straightforward answers to common seller questions"
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
              <h2 className="mt-5 font-display text-3xl leading-tight text-ink sm:text-[2.4rem]">Every business and transition is different</h2>
              <p className="mt-4 text-base leading-7 text-ink/72">
                If you want to talk through your specific situation, the next step is simply a confidential conversation. No pressure, no pitch deck, no games.
              </p>
            </div>

            <ButtonLink href="/contact">
              Start A Conversation <ArrowRight className="h-4 w-4" />
            </ButtonLink>
          </div>
        </Reveal>
      </section>
    </>
  );
}
