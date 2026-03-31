import { ArrowDownToLine, ArrowRight, BriefcaseBusiness, CircleDollarSign, Compass, MapPinned } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import SectionHeading from '../components/SectionHeading';
import Seo from '../components/Seo';
import { criteriaPage, seoContent, siteConfig } from '../content/siteContent';

const detailIcons = [BriefcaseBusiness, MapPinned, CircleDollarSign, Compass];

export default function CriteriaPage() {
  return (
    <>
      <Seo {...seoContent.criteria} />

      <PageHero {...criteriaPage.hero} />

      <section className="section-shell mt-10">
        <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <Reveal className="panel p-7 sm:p-9">
            <SectionHeading title={criteriaPage.fit.title} />
            <ul className="mt-6 space-y-4">
              {criteriaPage.fit.items.map((item) => (
                <li className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-4 text-sm leading-7 text-ink/74" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>

          <div className="grid gap-6">
            {criteriaPage.specifics.map((item, index) => {
              const Icon = detailIcons[index];

              return (
                <Reveal className="panel p-6 sm:p-7" delay={index * 80} key={item.label}>
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                    <Icon className="h-5 w-5" />
                  </div>
                  <p className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-moss/80">{item.label}</p>
                  <p className="mt-3 text-base leading-7 text-ink/74">{item.value}</p>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section-shell mt-20">
        <div className="grid gap-8 lg:grid-cols-2">
          <Reveal className="panel p-7 sm:p-8">
            <SectionHeading eyebrow="Good Situations" title={criteriaPage.situations.title} />
            <ul className="mt-6 space-y-4">
              {criteriaPage.situations.items.map((item) => (
                <li className="rounded-2xl border border-line/80 bg-white/70 px-4 py-4 text-sm leading-7 text-ink/74" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal className="panel p-7 sm:p-8" delay={120}>
            <SectionHeading eyebrow="Not A Fit" title={criteriaPage.notLookingFor.title} />
            <ul className="mt-6 space-y-4">
              {criteriaPage.notLookingFor.items.map((item) => (
                <li className="rounded-2xl border border-line/80 bg-white/70 px-4 py-4 text-sm leading-7 text-ink/74" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal className="panel px-7 py-10 sm:px-10 sm:py-12">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <span className="eyebrow">Downloadable Summary</span>
              <h2 className="mt-5 font-display text-3xl leading-tight text-ink sm:text-[2.4rem]">One-page acquisition criteria summary</h2>
              <p className="mt-4 text-base leading-7 text-ink/72">
                A clean text version of the criteria is included so brokers, referral partners, or owners can download and share it easily.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <ButtonLink download href={siteConfig.downloadHref}>
                Download Criteria <ArrowDownToLine className="h-4 w-4" />
              </ButtonLink>
              <ButtonLink href="/contact" variant="secondary">
                Start A Conversation <ArrowRight className="h-4 w-4" />
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
