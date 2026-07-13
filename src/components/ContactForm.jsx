import { useEffect, useMemo, useRef, useState } from 'react';

const turnstileScriptLoadTimeoutMs = 10000;

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
  const lastRenderedSiteKeyRef = useRef('');
  const buildTurnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
  const [turnstileConfigLoaded, setTurnstileConfigLoaded] = useState(false);
  const [turnstileLoadError, setTurnstileLoadError] = useState('');
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const turnstileRequired = turnstileConfigLoaded && Boolean(turnstileSiteKey);

  const isComplete = useMemo(
    () => Boolean(formData.name && formData.email && formData.message && turnstileConfigLoaded && (!turnstileRequired || formData.turnstileToken)),
    [formData.email, formData.message, formData.name, formData.turnstileToken, turnstileConfigLoaded, turnstileRequired],
  );

  function clearTurnstileToken() {
    setFormData((current) => ({ ...current, turnstileToken: '' }));
  }

  function resetTurnstileWidget() {
    clearTurnstileToken();

    if (window.turnstile && turnstileWidgetIdRef.current !== null) {
      try {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      } catch {
        turnstileWidgetIdRef.current = null;
      }
    }
  }

  function removeTurnstileWidget() {
    clearTurnstileToken();

    if (window.turnstile && turnstileWidgetIdRef.current !== null) {
      try {
        window.turnstile.remove(turnstileWidgetIdRef.current);
      } catch {
        // Cloudflare can throw if the widget was already removed during navigation.
      }
    }

    turnstileWidgetIdRef.current = null;
    lastRenderedSiteKeyRef.current = '';

    if (turnstileContainerRef.current) {
      turnstileContainerRef.current.innerHTML = '';
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadPublicConfig() {
      try {
        const response = await fetch('/api/public-config');
        const result = await response.json();

        if (!cancelled) {
          const runtimeSiteKey = response.ok && result.success && result.turnstileEnabled
            ? String(result.turnstileSiteKey || buildTurnstileSiteKey)
            : '';
          setTurnstileSiteKey(runtimeSiteKey);
          setTurnstileConfigLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setTurnstileSiteKey(buildTurnstileSiteKey);
          setTurnstileConfigLoaded(true);
        }
      }
    }

    loadPublicConfig();

    return () => {
      cancelled = true;
    };
  }, [buildTurnstileSiteKey]);

  useEffect(() => {
    if (!turnstileConfigLoaded || !turnstileContainerRef.current) {
      return undefined;
    }

    if (!turnstileSiteKey) {
      removeTurnstileWidget();
      setTurnstileLoadError('');
      return undefined;
    }

    let intervalId;
    let timeoutId;

    if (lastRenderedSiteKeyRef.current && lastRenderedSiteKeyRef.current !== turnstileSiteKey) {
      removeTurnstileWidget();
    }

    function renderWidget() {
      if (!window.turnstile || !turnstileContainerRef.current || lastRenderedSiteKeyRef.current === turnstileSiteKey) {
        return;
      }

      turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: turnstileSiteKey,
        callback: (token) => {
          setTurnstileLoadError('');
          setFormData((current) => ({ ...current, turnstileToken: token }));
        },
        'expired-callback': () => {
          clearTurnstileToken();
        },
        'error-callback': () => {
          clearTurnstileToken();
          setTurnstileLoadError('Anti-spam verification could not be completed. Please try the checkbox again.');
        },
        'timeout-callback': () => {
          clearTurnstileToken();
          setTurnstileLoadError('Anti-spam verification timed out. Please try the checkbox again.');
        },
      });
      lastRenderedSiteKeyRef.current = turnstileSiteKey;
      setTurnstileLoadError('');
    }

    if (!window.turnstile) {
      const existingScript = document.querySelector('script[data-turnstile-script="true"]');

      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.dataset.turnstileScript = 'true';
        script.onerror = () => {
          setTurnstileLoadError('Anti-spam verification could not load. Please refresh the page or contact me directly by email.');
        };
        document.head.appendChild(script);
      }

      intervalId = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(intervalId);
          window.clearTimeout(timeoutId);
          renderWidget();
        }
      }, 150);
      timeoutId = window.setTimeout(() => {
        if (!window.turnstile) {
          window.clearInterval(intervalId);
          setTurnstileLoadError('Anti-spam verification could not load. Please refresh the page or contact me directly by email.');
        }
      }, turnstileScriptLoadTimeoutMs);
    } else {
      renderWidget();
    }

    return () => {
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  // Widget helpers operate only on stable refs; config changes are the intended rerender boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnstileConfigLoaded, turnstileSiteKey]);

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
      resetTurnstileWidget();
    } catch (error) {
      setSubmitted(false);
      setSubmitError(error.message || 'Unable to send your inquiry right now.');
      resetTurnstileWidget();
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
            className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
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
            className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
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
            className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
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
            className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
            name="company"
            onChange={handleChange}
            placeholder="Company name"
            type="text"
            value={formData.company}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-ink md:col-span-2">
          I am reaching out as
          <select
            className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
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

        <label className="flex flex-col gap-2 text-sm font-medium text-ink md:col-span-2">
          Message
          <textarea
            required
            className="min-h-[180px] rounded-2xl border border-line bg-white px-4 py-4 text-sm text-ink outline-none transition focus:border-moss"
            name="message"
            onChange={handleChange}
            placeholder="Share a bit about the business, your timing, or the opportunity."
            value={formData.message}
          />
        </label>

        {turnstileRequired ? (
          <div className="md:col-span-2">
            <div className="max-w-full overflow-x-auto">
              <div ref={turnstileContainerRef} />
            </div>
            <p className="mt-2 text-xs leading-6 text-ink/60">Anti-spam verification is enabled for inbound inquiries.</p>
            {turnstileLoadError ? (
              <p aria-live="polite" className="mt-2 text-xs font-medium leading-6 text-red-700">
                {turnstileLoadError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm leading-6 text-ink/70">
          Confidential conversations are welcome. This form submits through a private backend pipeline for email notification and the private admin CRM.
        </p>

        <button
          className="inline-flex w-full items-center justify-center rounded-full border border-moss bg-moss px-6 py-3 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
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
