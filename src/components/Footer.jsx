import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { navigation, siteConfig } from '../content/siteContent';
import ButtonLink from './ButtonLink';
import LogoMark from './LogoMark';

export default function Footer() {
  const contactLines = siteConfig.contactDetailItems?.length
    ? siteConfig.contactDetailItems
    : ['Use the contact form for confidential inquiries.'];

  return (
    <footer className="mt-24 border-t border-ink/8 bg-[#173126] text-white">
      <div className="section-shell py-16">
        <div className="grid gap-12 lg:grid-cols-[1.2fr_0.9fr_0.9fr]">
          <div className="space-y-5">
            <LogoMark light />
            <p className="max-w-md text-sm leading-7 text-white/78">
              {siteConfig.personName} is seeking one strong small business to own and operate for the long term with continuity, care, and respect for what the seller built.
            </p>
            <div className="flex flex-wrap gap-3">
              <ButtonLink className="bg-white text-pine hover:bg-sand" href="/contact">
                Start A Conversation
              </ButtonLink>
              <ButtonLink
                className="border-white/20 bg-white/10 text-white hover:border-white/30 hover:bg-white/15"
                download
                href={siteConfig.downloadHref}
              >
                Download Criteria
              </ButtonLink>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/55">Explore</p>
            <div className="mt-5 grid gap-3">
              {navigation.map((item) => (
                <Link
                  key={item.path}
                  className="group inline-flex items-center gap-2 text-sm text-white/80 transition hover:text-white"
                  to={item.path}
                >
                  <span>{item.label}</span>
                  <ArrowRight className="h-4 w-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                </Link>
              ))}
            </div>
          </div>

          <div className="space-y-5">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/55">Contact</p>
            <div className="space-y-3 text-sm text-white/78">
              {contactLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <p className="text-sm leading-7 text-white/62">
              Owners, brokers, and referral partners are welcome. Early conversations should be confidential, direct, and low-pressure.
            </p>
          </div>
        </div>

        <div className="mt-12 border-t border-white/12 pt-6 text-sm text-white/52">
          <p>
            © {new Date().getFullYear()} {siteConfig.siteName}. Built for thoughtful business succession conversations.
          </p>
        </div>
      </div>
    </footer>
  );
}
