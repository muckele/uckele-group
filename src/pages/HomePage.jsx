import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Cog,
  Landmark,
  MapPinned,
  Repeat2,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import FaqAccordion from '../components/FaqAccordion';
import Reveal from '../components/Reveal';
import SectionHeading from '../components/SectionHeading';
import Seo from '../components/Seo';
import { homePage, seoContent, siteConfig } from '../content/siteContent';

const operatorIcons = [BriefcaseBusiness, Cog, Building2];
const criteriaIcons = [Building2, CircleDollarSign, MapPinned, Repeat2];
const readinessIcons = [UserRoundCheck, BadgeCheck, Landmark];
const credibilityIcons = [BriefcaseBusiness, Building2, ShieldCheck];

export default function HomePage() {
  return (
    <>
      <Seo {...seoContent.home} />

      <section className="section-shell pt-7 sm:pt-14">
        <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-stretch">
          <Reveal className="panel overflow-hidden px-5 py-9 sm:px-10 sm:py-14 lg:px-12">
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(185,137,82,0.12),transparent_34%),linear-gradient(315deg,rgba(40,70,56,0.10),transparent_38%)]" />
            <div className="surface-grid pointer-events-none absolute right-0 top-0 hidden h-full w-[45%] opacity-[0.15] sm:block" />
            <div className="relative">
              <span className="eyebrow">{homePage.hero.eyebrow}</span>
              <h1 className="mt-5 max-w-3xl font-display text-[2.55rem] leading-[1.03] tracking-normal text-ink sm:mt-6 sm:text-5xl lg:text-[4.1rem]">
                {homePage.hero.title}
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-ink/74 sm:mt-6 sm:text-lg sm:leading-8">
                {homePage.hero.description}
              </p>

              <div className="mt-8 grid gap-3 sm:flex sm:flex-wrap">
                <ButtonLink className="w-full sm:w-auto" href={homePage.hero.primaryCta.href}>
                  {homePage.hero.primaryCta.label}
                </ButtonLink>
                <ButtonLink className="w-full sm:w-auto" href={homePage.hero.secondaryCta.href} variant="secondary">
                  {homePage.hero.secondaryCta.label}
                </ButtonLink>
              </div>

              <div className="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-2">
                {homePage.hero.signals.map((signal) => (
                  <div
                    className="flex items-start gap-3 rounded-2xl border border-white/[0.90] bg-white/[0.72] px-4 py-4 shadow-[0_16px_30px_rgba(24,33,29,0.05)]"
                    key={signal}
                  >
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-moss" />
                    <p className="text-sm leading-6 text-ink/74">{signal}</p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          <Reveal className="panel relative overflow-hidden px-5 py-9 sm:px-9 sm:py-12" delay={120}>
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-clay via-moss to-pine" />
            <div className="surface-grid absolute inset-0 opacity-40" />
            <div className="relative">
              <div className="flex items-center gap-4">
                <img
                  alt={`${siteConfig.personName} headshot`}
                  className="h-16 w-16 shrink-0 rounded-2xl object-cover shadow-lg sm:h-20 sm:w-20 sm:rounded-3xl"
                  src="/mathew-uckele-headshot.jpeg"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">{siteConfig.personName}</p>
                  <p className="mt-2 max-w-xs text-sm leading-6 text-ink/70">
                    Business-minded operator seeking a durable small business to own and grow with care.
                  </p>
                </div>
              </div>

              <h2 className="mt-10 text-3xl font-semibold leading-tight text-ink">{homePage.hero.founderCard.title}</h2>
              <p className="mt-4 text-base leading-8 text-ink/74">{homePage.hero.founderCard.body}</p>

              <div className="mt-8 space-y-4">
                {homePage.hero.founderCard.points.map((point) => (
                  <div
                    className="rounded-2xl border border-white/[0.85] bg-white/[0.82] px-4 py-4 shadow-[0_14px_30px_rgba(24,33,29,0.05)]"
                    key={point}
                  >
                    <p className="text-sm font-medium leading-6 text-ink/76">{point}</p>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-2xl border border-moss/12 bg-moss px-5 py-5 text-white">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/72">Confidential Conversations Welcome</p>
                <p className="mt-3 text-sm leading-7 text-white/84">
                  Owners, brokers, and referrals are all welcome to reach out directly. Early conversations should feel calm, private, and useful.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section-shell mt-16 sm:mt-20">
        <Reveal>
          <SectionHeading
            description={homePage.operatorExperience.description}
            eyebrow={homePage.operatorExperience.eyebrow}
            title={homePage.operatorExperience.title}
          />
        </Reveal>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {homePage.operatorExperience.items.map((item, index) => {
            const Icon = operatorIcons[index];

            return (
              <Reveal className="panel p-7 sm:p-8" delay={index * 80} key={item.title}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-clay/12 text-clay">
                  <Icon className="h-5 w-5" />
                </div>
                <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-moss/80">{item.label}</p>
                <h3 className="mt-3 text-2xl font-semibold text-ink">{item.title}</h3>
                <p className="mt-3 text-base leading-7 text-ink/72">{item.description}</p>
              </Reveal>
            );
          })}
        </div>

        <Reveal className="mt-6">
          <ButtonLink href="/about" variant="secondary">
            More About Mathew <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </Reveal>
      </section>

      <section className="section-shell mt-20">
        <div className="grid gap-8 lg:grid-cols-[0.82fr_1.18fr]">
          <Reveal className="panel p-7 sm:p-9">
            <SectionHeading
              description={homePage.criteriaAtAGlance.description}
              eyebrow={homePage.criteriaAtAGlance.eyebrow}
              title={homePage.criteriaAtAGlance.title}
            />

            <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-moss/80">Industries of interest</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {homePage.criteriaAtAGlance.industries.map((industry) => (
                <span className="rounded-full border border-moss/12 bg-moss/7 px-4 py-2 text-sm font-medium text-moss" key={industry}>
                  {industry}
                </span>
              ))}
            </div>

            <div className="mt-8 grid gap-3 sm:flex sm:flex-wrap">
              <ButtonLink className="w-full sm:w-auto" href="/criteria">
                View Full Criteria <ArrowRight className="h-4 w-4" />
              </ButtonLink>
              <ButtonLink className="w-full sm:w-auto" download href={siteConfig.downloadHref} variant="secondary">
                Download Summary <ArrowDownToLine className="h-4 w-4" />
              </ButtonLink>
            </div>
          </Reveal>

          <div className="grid gap-6 sm:grid-cols-2">
            {homePage.criteriaAtAGlance.details.map((detail, index) => {
              const Icon = criteriaIcons[index];

              return (
                <Reveal className="panel p-6 sm:p-7" delay={index * 70} key={detail.label}>
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                    <Icon className="h-5 w-5" />
                  </div>
                  <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-moss/80">{detail.label}</p>
                  <h3 className="mt-3 font-display text-3xl leading-tight text-ink">{detail.value}</h3>
                  <p className="mt-3 text-sm leading-7 text-ink/68">{detail.note}</p>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal className="panel overflow-hidden lg:grid lg:grid-cols-[0.88fr_1.12fr]">
          <div className="bg-pine px-7 py-10 text-white sm:px-10 sm:py-12">
            <span className="eyebrow border-white/15 bg-white/10 text-white">{homePage.readiness.eyebrow}</span>
            <h2 className="mt-6 font-display text-3xl leading-tight text-white sm:text-[2.5rem]">{homePage.readiness.title}</h2>
            <p className="mt-5 text-base leading-8 text-white/78">{homePage.readiness.description}</p>

            <div className="mt-8 space-y-3">
              {homePage.readiness.expectations.map((item) => (
                <div className="flex items-start gap-3 rounded-2xl border border-white/12 bg-white/8 px-4 py-4" key={item}>
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-sand" />
                  <p className="text-sm leading-6 text-white/82">{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-5 px-7 py-10 sm:px-10 sm:py-12">
            {homePage.readiness.commitments.map((item, index) => {
              const Icon = readinessIcons[index];

              return (
                <div className="rounded-2xl border border-line/80 bg-white/72 p-5 sm:p-6" key={item.title}>
                  <div className="flex items-start gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-clay/12 text-clay">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold text-ink">{item.title}</h3>
                      <p className="mt-2 text-sm leading-7 text-ink/70">{item.description}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Reveal>
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading
            description={homePage.transitionApproach.description}
            eyebrow={homePage.transitionApproach.eyebrow}
            title={homePage.transitionApproach.title}
          />
        </Reveal>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {homePage.transitionApproach.steps.map((step, index) => (
            <Reveal className="panel p-7 sm:p-8" delay={index * 80} key={step.title}>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Step {index + 1}</p>
              <h3 className="mt-4 text-2xl font-semibold text-ink">{step.title}</h3>
              <p className="mt-3 text-base leading-7 text-ink/72">{step.description}</p>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-6">
          <ButtonLink href="/process" variant="secondary">
            See The Full Process <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </Reveal>
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading
            description={homePage.professionalCredibility.description}
            eyebrow={homePage.professionalCredibility.eyebrow}
            title={homePage.professionalCredibility.title}
          />
        </Reveal>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {homePage.professionalCredibility.items.map((item, index) => {
            const Icon = credibilityIcons[index];

            return (
              <Reveal className="panel p-7 sm:p-8" delay={index * 80} key={item.title}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                  <Icon className="h-5 w-5" />
                </div>
                <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-moss/80">{item.label}</p>
                <h3 className="mt-3 text-2xl font-semibold text-ink">{item.title}</h3>
                <p className="mt-3 text-base leading-7 text-ink/72">{item.description}</p>
              </Reveal>
            );
          })}
        </div>

        {siteConfig.linkedin ? (
          <Reveal className="mt-6">
            <ButtonLink href={siteConfig.linkedin} rel="noreferrer" target="_blank" variant="secondary">
              View Mathew’s LinkedIn <ArrowUpRight className="h-4 w-4" />
            </ButtonLink>
          </Reveal>
        ) : null}
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading
            align="center"
            description={homePage.essentialFaqs.description}
            eyebrow={homePage.essentialFaqs.eyebrow}
            title={homePage.essentialFaqs.title}
          />
        </Reveal>

        <Reveal className="mx-auto mt-8 max-w-4xl">
          <FaqAccordion items={homePage.essentialFaqs.items} />
        </Reveal>

        <Reveal className="mt-6 text-center">
          <ButtonLink href="/faq" variant="secondary">
            Read All FAQs <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </Reveal>
      </section>

      <section className="section-shell mt-20 pb-4">
        <Reveal className="panel overflow-hidden bg-[linear-gradient(135deg,#173126_0%,#284638_58%,#305243_100%)] px-5 py-9 text-white sm:px-10 sm:py-12">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.10),transparent_36%),linear-gradient(315deg,rgba(185,137,82,0.12),transparent_40%)]" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <span className="eyebrow border-white/15 bg-white/10 text-white">Ready When You Are</span>
              <h2 className="mt-5 font-display text-3xl leading-tight text-white sm:text-[2.5rem]">{homePage.contactCta.title}</h2>
              <p className="mt-4 text-base leading-8 text-white/80">{homePage.contactCta.description}</p>
            </div>

            <div className="grid gap-3 sm:flex sm:flex-wrap">
              <ButtonLink className="w-full bg-white text-pine hover:bg-sand sm:w-auto" href={homePage.contactCta.primaryCta.href}>
                {homePage.contactCta.primaryCta.label}
              </ButtonLink>
              <ButtonLink
                className="w-full border-white/18 bg-white/10 text-white hover:border-white/28 hover:bg-white/14 sm:w-auto"
                href={homePage.contactCta.secondaryCta.href}
              >
                {homePage.contactCta.secondaryCta.label}
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
