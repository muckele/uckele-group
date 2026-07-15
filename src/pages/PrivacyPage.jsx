import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import { seoContent, siteConfig } from '../content/siteContent';

const sections = [
  {
    title: 'Information you choose to share',
    body: [
      'When you use the contact form, request a conversation, or communicate directly, Uckele Group receives the details you provide. Those details may include your name, email address, phone number, company, location, revenue range, reason for reaching out, and message.',
      'When a secure upload link is issued, the service also records the requested-document checklist, upload status, acceptance of any required confidentiality acknowledgment, and the files and notes you submit.',
    ],
  },
  {
    title: 'How information is used',
    body: [
      'Information is used to evaluate potential acquisition opportunities, communicate with owners and their representatives, coordinate diligence, protect the service, maintain an accurate deal record, and meet legal or operational obligations.',
      'Administrative activity, authentication sessions, email delivery events, job history, source health, and security-related failures are logged so the service can be operated and audited responsibly.',
    ],
  },
  {
    title: 'Privacy-conscious website measurement',
    body: [
      'The public website uses first-party, aggregate measurement to understand which public pages are visited, whether the contact form is started and submitted successfully, and whether the acquisition-criteria summary is downloaded. This measurement does not record the contents of form fields, confidential documents, administrator activity, raw IP addresses, full referring URLs, or device fingerprints.',
      'Referral attribution is limited to the referring website hostname and, when present, campaign source, medium, and campaign labels. The site does not use advertising pixels or cross-site behavioral profiles. Analytics records are retained for a limited period, currently up to 90 days, and are used only to improve the website and understand legitimate acquisition outreach.',
    ],
  },
  {
    title: 'Confidential documents',
    body: [
      'Secure document links are intended only for the recipient and may be revoked or closed. Uploaded files are stored outside the public website, are not exposed through predictable public paths, and are available only through authenticated administrative access.',
      'No internet service can promise absolute security. Please do not upload information that was not requested, and avoid including Social Security numbers, full payment-card data, personal medical records, or account credentials.',
    ],
  },
  {
    title: 'Service providers and disclosures',
    body: [
      'Uckele Group may use infrastructure, email-delivery, database, anti-abuse, and hosting providers to operate the service. They receive only the information needed to perform those functions under their own contractual and security obligations.',
      'Information is not sold. It may be disclosed when required by law, to protect people or the service, in connection with a potential transaction involving Uckele Group, or with your direction or consent.',
    ],
  },
  {
    title: 'Retention and deletion',
    body: [
      'Deal and correspondence records are retained for as long as reasonably necessary to evaluate an opportunity, maintain business records, resolve disputes, and satisfy legal obligations. Secure upload requests can be revoked, individual files can be deleted by an administrator, and operational backups expire under a limited retention policy.',
      'Deletion from the active system does not immediately remove data from an existing encrypted or access-controlled backup. Backup copies age out according to the configured retention schedule and are used only for recovery.',
    ],
  },
  {
    title: 'Cookies and authentication',
    body: [
      'The public website does not use advertising cookies. A temporary browser-session value may preserve coarse referral and campaign attribution while you move between public pages; it is not a cross-site identifier and is removed when that browser session ends. Authorized administrators receive a secure, HTTP-only session cookie after signing in. Sessions expire, can be revoked individually, and can be revoked across all devices.',
    ],
  },
];

export default function PrivacyPage() {
  return (
    <>
      <Seo {...seoContent.privacy} />

      <PageHero
        description="A plain-language overview of how information is collected, protected, used, retained, and deleted."
        eyebrow="Privacy"
        title="Privacy and confidentiality should be clear from the first conversation"
      />

      <section className="section-shell mt-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Reveal className="panel p-7 sm:p-9">
            <p className="text-base leading-8 text-ink/74">
              This notice applies to the Uckele Group website, contact workflow, CRM, and secure document service. It was last updated July 14, 2026.
            </p>
          </Reveal>

          {sections.map((section, index) => (
            <Reveal className="panel p-7 sm:p-9" delay={Math.min(index * 60, 240)} key={section.title}>
              <h2 className="font-display text-2xl text-ink sm:text-3xl">{section.title}</h2>
              <div className="mt-4 space-y-4 text-base leading-8 text-ink/74">
                {section.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              </div>
            </Reveal>
          ))}

          <Reveal className="panel p-7 sm:p-9">
            <h2 className="font-display text-2xl text-ink sm:text-3xl">Questions or privacy requests</h2>
            <p className="mt-4 text-base leading-8 text-ink/74">
              To ask a privacy question, request a correction, or ask that information be deleted where applicable, email{' '}
              <a className="font-semibold text-moss underline decoration-moss/30 underline-offset-4" href={`mailto:${siteConfig.email}`}>
                {siteConfig.email}
              </a>
              . A request may require identity verification before confidential records are changed or released.
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
