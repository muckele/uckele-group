import { useEffect, useMemo, useRef, useState } from 'react';

function createInitialState() {
  return {
    name: '',
    email: '',
    phone: '',
    company: '',
    role: 'Business Owner',
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
    () => Boolean(formData.name && formData.email && formData.message && (!turnstileSiteKey || formData.turnstileToken)),
    [formData.email, formData.message, formData.name, formData.turnstileToken, turnstileSiteKey],
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
          source: 'website-contact-form',
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
    <form className="panel p-7 sm:p-8" onSubmit={handleSubmit}>
      <div className="grid gap-5 sm:grid-cols-2">
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
          Business / Firm
          <input
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="company"
            onChange={handleChange}
            placeholder="Company name"
            type="text"
            value={formData.company}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink sm:col-span-2">
          I am reaching out as
          <select
            className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="role"
            onChange={handleChange}
            value={formData.role}
          >
            <option>Business Owner</option>
            <option>Broker / Intermediary</option>
            <option>Referral Partner</option>
            <option>Advisor</option>
            <option>Other</option>
          </select>
        </label>

        <label className="hidden" htmlFor="website">
          Website
          <input id="website" name="website" onChange={handleChange} tabIndex="-1" type="text" value={formData.website} />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink sm:col-span-2">
          Message
          <textarea
            required
            className="min-h-[180px] rounded-3xl border border-line bg-white px-4 py-4 text-sm text-ink outline-none transition focus:border-moss"
            name="message"
            onChange={handleChange}
            placeholder="Share a bit about the business, your timing, or the opportunity."
            value={formData.message}
          />
        </label>

        {turnstileSiteKey ? (
          <div className="sm:col-span-2">
            <div ref={turnstileContainerRef} />
            <p className="mt-2 text-xs leading-6 text-ink/60">Anti-spam verification is enabled for inbound inquiries.</p>
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm leading-6 text-ink/70">
          Confidential conversations are welcome. This form now submits through the backend pipeline, where inquiries can be routed to email providers, a CRM webhook, and the private admin CRM.
        </p>

        <button
          className="inline-flex items-center justify-center rounded-full border border-moss bg-moss px-6 py-3 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isComplete || submitting}
          type="submit"
        >
          {submitting ? 'Sending...' : 'Send Inquiry'}
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
