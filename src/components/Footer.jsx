import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { navigation, siteConfig } from '../content/siteContent';
import ButtonLink from './ButtonLink';
import LinkedInIcon from './LinkedInIcon';
import LogoMark from './LogoMark';

function externalLinkProps(href) {
  return /^https?:\/\//i.test(href || '') ? { rel: 'noreferrer', target: '_blank' } : {};
}

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
              {siteConfig.personName} helps local businesses keep websites current, improve contact flow, and manage the online details that affect trust and leads.
            </p>
            <div className="flex flex-wrap gap-3">
              <ButtonLink className="w-full bg-white text-pine hover:bg-sand sm:w-auto" href={siteConfig.bookingCta.href}>
                {siteConfig.bookingCta.label}
              </ButtonLink>
              <ButtonLink
                className="w-full border-white/20 bg-white/10 text-white hover:border-white/30 hover:bg-white/15 sm:w-auto"
                href={siteConfig.schedulingUrl ? '/contact' : '/services'}
              >
                {siteConfig.schedulingUrl ? 'Request An Audit' : 'View Services'}
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
                    <a
                      className="block transition hover:text-white"
                      href={item.href}
                      key={`${item.kind}-${item.value}`}
                      {...externalLinkProps(item.href)}
                    >
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
              Share your website URL and the customer action you want more of. The first review stays practical, direct, and focused on lead flow.
            </p>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-white/12 pt-6 text-sm text-white/52 md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getFullYear()} {siteConfig.siteName}. Built for local business online presence management.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link className="transition hover:text-white" to="/privacy">
              Privacy
            </Link>
            <Link className="transition hover:text-white" to="/terms">
              Terms
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
