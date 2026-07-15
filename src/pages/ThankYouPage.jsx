import { ArrowRight, CheckCircle2 } from 'lucide-react';
import ButtonLink from '../components/ButtonLink';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import { seoContent } from '../content/siteContent';

export default function ThankYouPage() {
  return (
    <>
      <Seo {...seoContent.thankYou} />

      <section className="section-shell pt-16 sm:pt-24">
        <Reveal className="panel mx-auto max-w-3xl p-8 text-center sm:p-12">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-moss/10 text-moss">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <span className="eyebrow mt-7">Inquiry Received</span>
          <h1 className="mt-6 font-display text-4xl leading-tight text-ink sm:text-5xl">Thank you for reaching out</h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-ink/72 sm:text-lg">
            Your message was submitted successfully. Mathew will review it personally and respond directly. Early conversations are treated with care and appropriate discretion.
          </p>
          <div className="mt-8 grid gap-3 sm:flex sm:justify-center">
            <ButtonLink href="/process">
              See The Process <ArrowRight className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink href="/" variant="secondary">Return Home</ButtonLink>
          </div>
        </Reveal>
      </section>
    </>
  );
}
