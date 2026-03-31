import { ArrowRight, Mail, Phone, ShieldCheck } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import ContactForm from '../components/ContactForm';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import SectionHeading from '../components/SectionHeading';
import Seo from '../components/Seo';
import { contactPage, seoContent } from '../content/siteContent';

const sideIcons = [ShieldCheck, Mail];

export default function ContactPage() {
  return (
    <>
      <Seo {...seoContent.contact} />

      <PageHero {...contactPage.hero} />

      <section className="section-shell mt-10">
        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <Reveal>
            <SectionHeading description={contactPage.contactIntro} eyebrow="Confidential Conversations" title="Share the basics and I’ll take it from there" />
            <div className="mt-6" id="contact-form">
              <ContactForm />
            </div>
          </Reveal>

          <div className="space-y-6">
            {contactPage.sidePanels.map((panel, index) => {
              const Icon = sideIcons[index];

              return (
                <Reveal className="panel p-7 sm:p-8" delay={index * 90} key={panel.title}>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold text-ink">{panel.title}</h2>
                  <ul className="mt-5 space-y-4 text-sm leading-7 text-ink/72">
                    {panel.items.map((item) => (
                      <li className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-3" key={item}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </Reveal>
              );
            })}

            <Reveal className="panel p-7 sm:p-8" delay={180}>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-clay/12 text-clay">
                <Phone className="h-5 w-5" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold text-ink">{contactPage.brokerNote.title}</h2>
              <p className="mt-4 text-base leading-7 text-ink/72">{contactPage.brokerNote.description}</p>
              <ButtonLink className="mt-6" href="/criteria" variant="secondary">
                Review Criteria <ArrowRight className="h-4 w-4" />
              </ButtonLink>
            </Reveal>
          </div>
        </div>
      </section>
    </>
  );
}
