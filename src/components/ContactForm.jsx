import { useEffect, useMemo, useRef, useState } from 'react';

function createInitialState() {
  return {
    name: '',
    email: '',
    phone: '',
    company: '',
    role: 'Business Owner',
    businessWebsite: '',
    serviceInterest: 'Website audit',
    timeline: 'This month',
    message: '',
    website: '',
    turnstileToken: '',
    startedAt: String(Date.now()),
  };
}

export default function ContactForm() {
  const [formData, setFormData] = useState(createInitialState);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitMessage, setSubmitMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const turnstileContainerRef = useRef(null);
  const turnstileWidgetIdRef = useRef(null);
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

  const isComplete = useMemo(
    () =>
      Boolean(
        formData.name &&
          formData.email &&
          formData.company &&
          formData.businessWebsite &&
          formData.message &&
          (!turnstileSiteKey || formData.turnstileToken),
      ),
    [formData.businessWebsite, formData.company, formData.email, formData.message, formData.name, formData.turnstileToken, turnstileSiteKey],
  );

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileContainerRef.current) {
      return undefined;
    }

    let intervalId;

    function renderWidget() {
      if (!window.turnstile || !turnstileContainerRef.current || turnstileWidgetIdRef.current !== null) {
        return;
      }

      turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: turnstileSiteKey,
        callback: (token) => {
          setFormData((current) => ({ ...current, turnstileToken: token }));
        },
        'expired-callback': () => {
          setFormData((current) => ({ ...current, turnstileToken: '' }));
        },
      });
    }

    if (!window.turnstile) {
      const existingScript = document.querySelector('script[data-turnstile-script="true"]');

      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.dataset.turnstileScript = 'true';
        document.head.appendChild(script);
      }

      intervalId = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(intervalId);
          renderWidget();
        }
      }, 150);
    } else {
      renderWidget();
    }

    return () => {
      if (intervalId) {
        window.clearInterval(intervalId);
      }
    };
  }, [turnstileSiteKey]);

  function handleChange(event) {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!isComplete) {
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    setSubmitMessage('');

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
          body: JSON.stringify({
            ...formData,
            source: 'website-audit-request',
          }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result?.errors?.[0] || result?.error || 'Unable to send your inquiry right now.');
      }

      setSubmitted(true);
      setSubmitMessage(result.message || 'Your message has been received.');
      setFormData(createInitialState());

      if (window.turnstile && turnstileWidgetIdRef.current !== null) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
    } catch (error) {
      setSubmitted(false);
      setSubmitError(error.message || 'Unable to send your inquiry right now.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="panel p-6 sm:p-8" onSubmit={handleSubmit}>
      <div className="grid gap-5 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Name
          <input
            required
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="name"
            onChange={handleChange}
            placeholder="Your name"
            type="text"
            value={formData.name}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Email
          <input
            required
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="email"
            onChange={handleChange}
            placeholder="you@example.com"
            type="email"
            value={formData.email}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Phone
          <input
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="phone"
            onChange={handleChange}
            placeholder="Optional"
            type="tel"
            value={formData.phone}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Business name
          <input
            required
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="company"
            onChange={handleChange}
            placeholder="Company or practice name"
            type="text"
            value={formData.company}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink md:col-span-2">
          I am reaching out as
          <select
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="role"
            onChange={handleChange}
            value={formData.role}
          >
            <option>Business Owner</option>
            <option>Marketing Manager</option>
            <option>Office Manager</option>
            <option>Referral Partner</option>
            <option>Agency / Consultant</option>
            <option>Other</option>
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Business website
          <input
            required
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="businessWebsite"
            onChange={handleChange}
            placeholder="yourbusiness.com"
            type="text"
            value={formData.businessWebsite}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink">
          Service interest
          <select
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="serviceInterest"
            onChange={handleChange}
            value={formData.serviceInterest}
          >
            <option>Website audit</option>
            <option>Website updates and maintenance</option>
            <option>Local SEO basics</option>
            <option>Contact form and lead-flow fixes</option>
            <option>Monthly online presence support</option>
            <option>Not sure yet</option>
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink md:col-span-2">
          Timeline
          <select
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="timeline"
            onChange={handleChange}
            value={formData.timeline}
          >
            <option>This month</option>
            <option>Next 30-60 days</option>
            <option>Planning ahead</option>
            <option>Urgent issue</option>
          </select>
        </label>

        <label className="hidden" htmlFor="website">
          Website
          <input id="website" name="website" onChange={handleChange} tabIndex="-1" type="text" value={formData.website} />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink md:col-span-2">
          What should the website do better?
          <textarea
            required
            className="min-h-[180px] rounded-3xl border border-line bg-white px-4 py-4 text-sm text-ink outline-none transition focus:border-moss"
            name="message"
            onChange={handleChange}
            placeholder="Examples: get more quote requests, update services, fix a form, improve mobile layout, clean up local SEO, add pages, or review competitors."
            value={formData.message}
          />
        </label>

        {turnstileSiteKey ? (
          <div className="md:col-span-2">
            <div className="overflow-x-auto">
              <div ref={turnstileContainerRef} />
            </div>
            <p className="mt-2 text-xs leading-6 text-ink/60">Anti-spam verification is enabled for inbound inquiries.</p>
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm leading-6 text-ink/70">
          This request routes into the private CRM so audit notes, follow-up, email activity, and next steps can be tracked in one place.
        </p>

        <button
          className="inline-flex w-full items-center justify-center rounded-full border border-moss bg-moss px-6 py-3 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          disabled={!isComplete || submitting}
          type="submit"
        >
          {submitting ? 'Sending...' : 'Request Audit'}
        </button>
      </div>

      {submitted ? (
        <p aria-live="polite" className="mt-4 rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">
          {submitMessage}
        </p>
      ) : null}

      {submitError ? (
        <p aria-live="polite" className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {submitError}
        </p>
      ) : null}
    </form>
  );
}
