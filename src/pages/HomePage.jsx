import {
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  Compass,
  Handshake,
  ShieldCheck,
  Users,
} from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import FaqAccordion from '../components/FaqAccordion';
import Reveal from '../components/Reveal';
import SectionHeading from '../components/SectionHeading';
import Seo from '../components/Seo';
import { homePage, seoContent, siteConfig } from '../content/siteContent';

const trustIcons = [Compass, ShieldCheck, Handshake];
const whyIcons = [Users, BadgeCheck, BriefcaseBusiness, Building2];

export default function HomePage() {
  return (
    <>
      <Seo {...seoContent.home} />

      <section className="section-shell pt-10 sm:pt-16">
        <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-stretch">
          <Reveal className="panel overflow-hidden px-7 py-12 sm:px-10 sm:py-14 lg:px-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(185,137,82,0.14),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(40,70,56,0.12),transparent_34%)]" />
            <div className="surface-grid pointer-events-none absolute right-[-8%] top-0 h-full w-[45%] opacity-[0.15]" />
            <div className="relative">
            <span className="eyebrow">{homePage.hero.eyebrow}</span>
            <h1 className="mt-6 max-w-3xl font-display text-4xl leading-[0.96] tracking-[-0.04em] text-ink sm:text-5xl lg:text-[4.45rem]">
              {homePage.hero.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-ink/74">{homePage.hero.description}</p>

            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href={homePage.hero.primaryCta.href}>{homePage.hero.primaryCta.label}</ButtonLink>
              <ButtonLink href={homePage.hero.secondaryCta.href} variant="secondary">
                {homePage.hero.secondaryCta.label}
              </ButtonLink>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              {homePage.hero.signals.map((signal) => (
                <div className="flex items-start gap-3 rounded-2xl border border-white/[0.90] bg-white/[0.72] px-4 py-4 shadow-[0_16px_30px_rgba(24,33,29,0.05)]" key={signal}>
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-moss" />
                  <p className="text-sm leading-6 text-ink/74">{signal}</p>
                </div>
              ))}
            </div>
            </div>
          </Reveal>

          <Reveal className="panel relative overflow-hidden px-7 py-10 sm:px-9 sm:py-12" delay={120}>
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-clay via-moss to-pine" />
            <div className="surface-grid absolute inset-0 opacity-40" />
            <div className="relative">
              <div className="flex items-center gap-4">
                <img alt={`${siteConfig.personName} headshot placeholder`} className="h-20 w-20 rounded-3xl object-cover shadow-lg" src="/headshot-placeholder.svg" />
                <div>
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
                  <div className="rounded-2xl border border-white/[0.85] bg-white/[0.82] px-4 py-4 shadow-[0_14px_30px_rgba(24,33,29,0.05)]" key={point}>
                    <p className="text-sm font-medium leading-6 text-ink/76">{point}</p>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-[26px] border border-moss/12 bg-moss px-5 py-5 text-white">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/72">Confidential Conversations Welcome</p>
                <p className="mt-3 text-sm leading-7 text-white/84">
                  Owners, brokers, and referrals are all welcome to reach out directly. Early conversations should feel calm, private, and useful.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section-shell mt-8">
        <div className="grid gap-6 md:grid-cols-3">
          {homePage.quickTrust.map((item, index) => {
            const Icon = trustIcons[index];

            return (
              <Reveal className="panel p-6 transition duration-300 hover:-translate-y-1 hover:shadow-[0_32px_70px_rgba(24,33,29,0.12)] sm:p-7" delay={index * 80} key={item.title}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                  <Icon className="h-5 w-5" />
                </div>
                <h2 className="mt-5 text-xl font-semibold text-ink">{item.title}</h2>
                <p className="mt-3 text-base leading-7 text-ink/72">{item.description}</p>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading
            description={homePage.whyWorkWithMe.description}
            eyebrow={homePage.whyWorkWithMe.eyebrow}
            title={homePage.whyWorkWithMe.title}
          />
        </Reveal>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {homePage.whyWorkWithMe.cards.map((card, index) => {
            const Icon = whyIcons[index];

            return (
              <Reveal className="panel p-7 transition duration-300 hover:-translate-y-1 hover:shadow-[0_32px_70px_rgba(24,33,29,0.12)] sm:p-8" delay={index * 90} key={card.title}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-clay/12 text-clay">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-2xl font-semibold text-ink">{card.title}</h3>
                <p className="mt-3 text-base leading-7 text-ink/72">{card.description}</p>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="section-shell mt-20">
          <Reveal className="panel overflow-hidden lg:grid lg:grid-cols-[0.92fr_1.08fr]">
            <div className="bg-pine px-8 py-10 text-white sm:px-10 sm:py-12">
              <span className="eyebrow border-white/15 bg-white/10 text-white">{homePage.letter.eyebrow}</span>
              <h2 className="mt-6 font-display text-3xl leading-tight text-white sm:text-[2.5rem]">{homePage.letter.title}</h2>
            <p className="mt-6 max-w-md text-base leading-8 text-white/80">{homePage.letter.body[0]}</p>
            <p className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-white/66">{homePage.letter.signature}</p>
          </div>

          <div className="px-8 py-10 sm:px-10 sm:py-12">
            {homePage.letter.body.slice(1).map((paragraph) => (
              <p className="text-base leading-8 text-ink/74" key={paragraph}>
                {paragraph}
              </p>
            ))}
            <ButtonLink className="mt-8" href="/about" variant="secondary">
              Read More About Mathew <ArrowRight className="h-4 w-4" />
            </ButtonLink>
          </div>
        </Reveal>
      </section>

      <section className="section-shell mt-20">
        <div className="grid gap-8 lg:grid-cols-[1.02fr_0.98fr]">
          <Reveal className="panel p-7 sm:p-9">
            <SectionHeading
              description={homePage.criteriaPreview.description}
              eyebrow={homePage.criteriaPreview.eyebrow}
              title={homePage.criteriaPreview.title}
            />
            <ul className="mt-6 space-y-4">
              {homePage.criteriaPreview.list.map((item) => (
                <li className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-4 text-sm leading-7 text-ink/74" key={item}>
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal className="panel p-7 sm:p-9" delay={120}>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Industries Of Interest</p>
            <div className="mt-5 flex flex-wrap gap-3">
              {homePage.criteriaPreview.industries.map((industry) => (
                <span className="rounded-full border border-moss/12 bg-moss/7 px-4 py-2 text-sm font-medium text-moss" key={industry}>
                  {industry}
                </span>
              ))}
            </div>
            <div className="mt-8 rounded-[28px] border border-line/80 bg-white/72 p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Search Themes Covered</p>
              <p className="mt-3 text-base leading-7 text-ink/74">
                Small business buyer. Individual business buyer. Long-term business buyer. Search fund alternative. Preserve business legacy after sale.
              </p>
            </div>
            <div className="mt-6 rounded-[28px] border border-line/80 bg-white/72 p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Open To A Conversation If</p>
              <p className="mt-3 text-base leading-7 text-ink/74">
                You have a solid small business, care about continuity, and want to explore a fair transition without the feel of a corporate process.
              </p>
            </div>
            <ButtonLink className="mt-8" href="/criteria">
              View Full Criteria <ArrowRight className="h-4 w-4" />
            </ButtonLink>
          </Reveal>
        </div>
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
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading
            description={homePage.individualBuyer.description}
            eyebrow={homePage.individualBuyer.eyebrow}
            title={homePage.individualBuyer.title}
          />
        </Reveal>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {homePage.individualBuyer.cards.map((card, index) => (
            <Reveal className="panel p-7 sm:p-8" delay={index * 90} key={card.title}>
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                  <ArrowRight className="h-5 w-5" />
                </div>
                <h3 className="text-2xl font-semibold text-ink">{card.title}</h3>
              </div>
              <p className="mt-4 text-base leading-7 text-ink/72">{card.description}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section-shell mt-20">
        <div className="grid gap-8 lg:grid-cols-[1.02fr_0.98fr]">
          <Reveal>
            <SectionHeading
              description={homePage.faqPreview.title}
              eyebrow={homePage.faqPreview.eyebrow}
              title="Questions owners often ask before responding"
            />
            <div className="mt-6">
              <FaqAccordion items={homePage.faqPreview.items} />
            </div>
          </Reveal>

          <Reveal className="panel p-7 sm:p-8" delay={120}>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">A Better First Conversation</p>
            <h2 className="mt-4 font-display text-3xl leading-tight text-ink">Serious, calm, and built around fit</h2>
            <p className="mt-4 text-base leading-7 text-ink/72">
              If there is mutual fit, the next steps can be structured. If there is not, the conversation should still feel respectful and worthwhile. That is the standard I am aiming for.
            </p>
            <div className="mt-6 space-y-3">
              {['No aggressive sales language', 'No private equity positioning', 'No pressure to overshare too early'].map((item) => (
                <div className="flex items-start gap-3 rounded-2xl border border-line/80 bg-fog/70 px-4 py-4" key={item}>
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-moss" />
                  <p className="text-sm leading-6 text-ink/74">{item}</p>
                </div>
              ))}
            </div>
            <ButtonLink className="mt-8" href="/faq" variant="secondary">
              Read All FAQs <ArrowRight className="h-4 w-4" />
            </ButtonLink>
          </Reveal>
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading
            align="center"
            description={homePage.references.description}
            eyebrow={homePage.references.eyebrow}
            title={homePage.references.title}
          />
        </Reveal>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {homePage.references.items.map((item, index) => (
            <Reveal className="panel overflow-hidden p-7 sm:p-8" delay={index * 90} key={item.label}>
              <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 rounded-full bg-clay/8 blur-2xl" />
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-clay">{item.label}</p>
              <p className="relative mt-4 text-base leading-7 text-ink/72">{item.text}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section-shell mt-20 pb-4">
        <Reveal className="panel overflow-hidden bg-[linear-gradient(135deg,#173126_0%,#284638_58%,#305243_100%)] px-7 py-10 text-white sm:px-10 sm:py-12">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.14),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(185,137,82,0.14),transparent_34%)]" />
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative max-w-2xl">
              <span className="eyebrow border-white/15 bg-white/10 text-white">Ready When You Are</span>
              <h2 className="mt-5 font-display text-3xl leading-tight text-white sm:text-[2.5rem]">{homePage.contactCta.title}</h2>
              <p className="mt-4 text-base leading-8 text-white/80">{homePage.contactCta.description}</p>
            </div>

            <div className="relative flex flex-wrap gap-3">
              <ButtonLink className="bg-white text-pine hover:bg-sand" href={homePage.contactCta.primaryCta.href}>
                {homePage.contactCta.primaryCta.label}
              </ButtonLink>
              <ButtonLink
                className="border-white/18 bg-white/10 text-white hover:border-white/28 hover:bg-white/14"
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
