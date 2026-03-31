import { ArrowRight, Clock3, FileText, Handshake, SearchCheck, ShieldCheck, Trophy } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import SectionHeading from '../components/SectionHeading';
import Seo from '../components/Seo';
import { processPage, seoContent } from '../content/siteContent';

const stepIcons = [Handshake, SearchCheck, ShieldCheck, FileText, Clock3, Trophy];

export default function ProcessPage() {
  return (
    <>
      <Seo {...seoContent.process} />

      <PageHero {...processPage.hero} />

      <section className="section-shell mt-10">
        <div className="grid gap-6">
          {processPage.steps.map((step, index) => {
            const Icon = stepIcons[index];

            return (
              <Reveal className="panel p-7 sm:p-8" delay={index * 60} key={step.title}>
                <div className="grid gap-6 lg:grid-cols-[0.16fr_0.16fr_1fr] lg:items-start">
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-moss">{step.step}</p>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-semibold text-ink">{step.title}</h2>
                    <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">{step.description}</p>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal className="panel px-7 py-10 sm:px-10 sm:py-12">
          <SectionHeading eyebrow="What Stays Consistent" title="Principles behind the process" />
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {processPage.principles.map((principle, index) => (
              <div className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-4 text-sm leading-6 text-ink/74" key={`${principle}-${index}`}>
                {principle}
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/contact">
              Start A Conversation <ArrowRight className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink href="/why-sell-to-me" variant="secondary">
              Why Sell To Me
            </ButtonLink>
          </div>
        </Reveal>
      </section>
    </>
  );
}
