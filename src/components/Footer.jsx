import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { navigation, siteConfig } from '../content/siteContent';
import ButtonLink from './ButtonLink';
import LinkedInIcon from './LinkedInIcon';
import LogoMark from './LogoMark';

export default function Footer() {
  const contactItems = siteConfig.contactDetailItems?.length
    ? siteConfig.contactDetailItems
    : [{ kind: 'text', label: 'Contact', value: 'Use the contact form for confidential inquiries.' }];

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
              <ButtonLink className="w-full bg-white text-pine hover:bg-sand sm:w-auto" href="/contact">
                Start A Conversation
              </ButtonLink>
              <ButtonLink
                className="w-full border-white/20 bg-white/10 text-white hover:border-white/30 hover:bg-white/15 sm:w-auto"
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
              {contactItems
                .filter((item) => item.kind !== 'linkedin')
                .map((item) =>
                  item.href ? (
                    <a className="block transition hover:text-white" href={item.href} key={`${item.kind}-${item.value}`}>
                      <span className="font-medium text-white/56">{item.label}:</span> {item.value}
                    </a>
                  ) : (
                    <p key={`${item.kind}-${item.value}`}>
                      <span className="font-medium text-white/56">{item.label}:</span> {item.value}
                    </p>
                  ),
                )}
            </div>
            {contactItems.some((item) => item.kind === 'linkedin') ? (
              <div className="flex items-center gap-3">
                {contactItems
                  .filter((item) => item.kind === 'linkedin')
                  .map((item) => (
                    <a
                      aria-label="LinkedIn profile"
                      className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/18 bg-white/10 text-white transition hover:border-white/30 hover:bg-white/16"
                      href={item.href}
                      key={`${item.kind}-${item.href}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <LinkedInIcon className="h-5 w-5" />
                    </a>
                  ))}
              </div>
            ) : null}
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
