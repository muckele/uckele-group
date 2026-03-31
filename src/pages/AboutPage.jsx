import { ArrowRight, BriefcaseBusiness, Cog, Handshake, UserCircle2 } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import SectionHeading from '../components/SectionHeading';
import Seo from '../components/Seo';
import { aboutPage, seoContent, siteConfig } from '../content/siteContent';

const valueIcons = [Handshake, UserCircle2, Cog, BriefcaseBusiness];

export default function AboutPage() {
  return (
    <>
      <Seo {...seoContent.about} />

      <PageHero {...aboutPage.hero} />

      <section className="section-shell mt-8">
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
          <Reveal className="panel overflow-hidden">
            <img
              alt={`${siteConfig.personName} headshot placeholder`}
              className="h-full min-h-[420px] w-full object-cover"
              src="/headshot-placeholder.svg"
            />
          </Reveal>

          <Reveal className="panel p-7 sm:p-9" delay={120}>
            <SectionHeading description={aboutPage.shortBio.body[0]} title={aboutPage.shortBio.title} />
            <div className="mt-6 space-y-5 text-base leading-8 text-ink/74">
              {aboutPage.shortBio.body.slice(1).map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/contact">Start A Conversation</ButtonLink>
              <ButtonLink href="/criteria" variant="secondary">
                View Criteria <ArrowRight className="h-4 w-4" />
              </ButtonLink>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading description={aboutPage.story.paragraphs[0]} eyebrow="Background" title={aboutPage.story.title} />
        </Reveal>
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {aboutPage.story.paragraphs.slice(1).map((paragraph, index) => (
            <Reveal className="panel p-7 sm:p-8" delay={index * 90} key={paragraph}>
              <p className="text-base leading-8 text-ink/74">{paragraph}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal>
          <SectionHeading eyebrow="Principles" title={aboutPage.values.title} />
        </Reveal>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {aboutPage.values.items.map((item, index) => {
            const Icon = valueIcons[index];

            return (
              <Reveal className="panel p-7 sm:p-8" delay={index * 90} key={item.title}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-xl font-semibold text-ink">{item.title}</h3>
                <p className="mt-3 text-base leading-7 text-ink/72">{item.description}</p>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal className="panel px-7 py-10 sm:px-10 sm:py-12">
          <SectionHeading eyebrow="Intent" title={aboutPage.whyBuy.title} />
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {aboutPage.whyBuy.paragraphs.map((paragraph) => (
              <p className="text-base leading-8 text-ink/74" key={paragraph}>
                {paragraph}
              </p>
            ))}
          </div>
        </Reveal>
      </section>
    </>
  );
}
