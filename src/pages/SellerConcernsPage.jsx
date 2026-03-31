import { ArrowRight, Building2, HandHeart, Lock, MessagesSquare, ShieldCheck, TimerReset, Users, WalletCards } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import { sellerConcernsPage, seoContent } from '../content/siteContent';

const concernIcons = [Building2, Users, HandHeart, TimerReset, Lock, WalletCards, ShieldCheck, MessagesSquare];

export default function SellerConcernsPage() {
  return (
    <>
      <Seo {...seoContent.sellerConcerns} />

      <PageHero {...sellerConcernsPage.hero} />

      <section className="section-shell mt-10">
        <Reveal className="panel px-7 py-9 sm:px-10">
          <p className="max-w-4xl text-lg leading-8 text-ink/74">{sellerConcernsPage.intro}</p>
        </Reveal>
      </section>

      <section className="section-shell mt-12">
        <div className="grid gap-6 md:grid-cols-2">
          {sellerConcernsPage.concerns.map((concern, index) => {
            const Icon = concernIcons[index];

            return (
              <Reveal className="panel p-7 sm:p-8" delay={index * 80} key={concern.title}>
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                  <Icon className="h-5 w-5" />
                </div>
                <h2 className="mt-5 text-2xl font-semibold text-ink">{concern.title}</h2>
                <p className="mt-3 text-base leading-7 text-ink/72">{concern.description}</p>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="section-shell mt-20">
        <Reveal className="panel overflow-hidden lg:grid lg:grid-cols-[0.95fr_1.05fr]">
          <div className="bg-fog px-8 py-10 sm:px-10 sm:py-12">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">What This Means In Practice</p>
            <h2 className="mt-5 font-display text-3xl leading-tight text-ink sm:text-[2.45rem]">A fair process should protect more than the numbers</h2>
          </div>
          <div className="px-8 py-10 sm:px-10 sm:py-12">
            <p className="text-base leading-8 text-ink/74">
              The strongest seller relationships are built when both sides can speak plainly about what matters most. That usually includes legacy, people, customers, timing, confidentiality, and a realistic plan for the handoff. Those concerns are legitimate, and they should be central to the process.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/contact">
                Start A Conversation <ArrowRight className="h-4 w-4" />
              </ButtonLink>
              <ButtonLink href="/process" variant="secondary">
                View The Process
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
