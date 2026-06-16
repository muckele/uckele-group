import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  CalendarClock,
  ClipboardList,
  Copy,
  Download,
  Inbox,
  Link2,
  LogOut,
  MailCheck,
  MapPin,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldAlert,
} from 'lucide-react';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';

const statuses = ['new', 'review', 'contacted', 'archived', 'spam'];
const priorities = ['low', 'normal', 'medium', 'high', 'urgent'];
const followUpStates = ['needs-response', 'scheduled', 'waiting-on-owner', 'completed'];
const leadTypes = ['prospect', 'seller', 'broker', 'referral', 'advisor', 'other'];
const sbaOptions = ['unknown', 'yes', 'no'];
const dailyDealUpdateUrl =
  'https://docs.google.com/spreadsheets/d/1d2mC6oKDY7DFQiaNQnF947Ro5CBwjIcAw_fwya7bpBc/edit?usp=sharing';
const primaryActionButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-full border border-moss bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:opacity-50 sm:w-auto';
const secondaryActionButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-full border border-ink/10 bg-white px-5 py-3 text-sm font-semibold text-ink transition hover:border-moss/25 hover:text-moss disabled:opacity-50 sm:w-auto';

function toDateTimeLocal(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const timezoneOffset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, 16);
}

function fromDateTimeLocal(value) {
  return value ? new Date(value).toISOString() : '';
}

function formatLabel(value) {
  return String(value || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatLeadTier(value) {
  if (value === 'tier_a') {
    return 'Tier A';
  }

  if (value === 'tier_b') {
    return 'Tier B';
  }

  if (value === 'tier_c') {
    return 'Tier C';
  }

  if (value === 'dnp') {
    return 'DNP';
  }

  return formatLabel(value || 'unclassified');
}

function formatDateTime(value) {
  if (!value) {
    return 'Not set';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not set' : date.toLocaleString();
}

function pluralize(count, label) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function leadTierTone(value) {
  if (value === 'tier_a') {
    return 'success';
  }

  if (value === 'tier_b') {
    return 'warning';
  }

  if (value === 'tier_c') {
    return 'info';
  }

  if (value === 'dnp') {
    return 'danger';
  }

  return 'default';
}

function emailEngagementTone(engagement) {
  if (!engagement?.total) {
    return 'default';
  }

  if (engagement.tone === 'danger') {
    return 'danger';
  }

  if (engagement.tone === 'success') {
    return 'success';
  }

  if (engagement.tone === 'warning') {
    return 'warning';
  }

  if (engagement.tone === 'info') {
    return 'info';
  }

  return 'default';
}

function formatEmailEngagement(engagement) {
  if (!engagement?.total) {
    return 'No tracked email activity yet.';
  }

  const parts = [];

  if (engagement.opened) {
    parts.push(pluralize(engagement.opened, 'open'));
  }

  if (engagement.clicked) {
    parts.push(pluralize(engagement.clicked, 'click'));
  }

  if (engagement.replied) {
    parts.push(pluralize(engagement.replied, 'reply'));
  }

  if (engagement.bounced || engagement.complained || engagement.failed || engagement.unsubscribed) {
    parts.push(pluralize(engagement.bounced + engagement.complained + engagement.failed + engagement.unsubscribed, 'delivery issue'));
  }

  if (parts.length === 0) {
    parts.push(pluralize(engagement.sent + engagement.delivered, 'sent email'));
  }

  return `${parts.join(', ')}. Last event: ${formatLabel(engagement.latest_event_type)} at ${formatDateTime(engagement.last_event_at)}.`;
}

function dealScoreTone(score) {
  if (score >= 70) {
    return 'success';
  }

  if (score >= 55) {
    return 'warning';
  }

  return 'danger';
}

function formatMoney(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value)
    : 'Not disclosed';
}

function buildDraft(submission) {
  return {
    status: submission.status || 'review',
    priority: submission.priority || 'normal',
    assigned_to: submission.assigned_to || '',
    lead_type: submission.lead_type || 'seller',
    follow_up_state: submission.follow_up_state || 'needs-response',
    next_action_at: toDateTimeLocal(submission.next_action_at),
    tags: (submission.tags || []).join(', '),
    notes: submission.notes || '',
    company: submission.company || '',
    listing_url: submission.listing_url || '',
    business_website: submission.business_website || '',
    prospectus_url: submission.prospectus_url || '',
    asking_price: submission.asking_price || '',
    ttm_revenue: submission.ttm_revenue || '',
    ttm_ebitda: submission.ttm_ebitda || '',
    ebitda_multiple: submission.ebitda_multiple || '',
    net_margin: submission.net_margin || '',
    business_age: submission.business_age || '',
    sba_eligible: submission.sba_eligible || 'unknown',
    broker_name: submission.broker_name || '',
    broker_email: submission.broker_email || '',
    broker_phone: submission.broker_phone || '',
    seller_name: submission.seller_name || '',
    seller_email: submission.seller_email || '',
    seller_phone: submission.seller_phone || '',
  };
}

function blankRecordDraft() {
  return {
    company: '',
    status: 'review',
    priority: 'normal',
    assigned_to: 'Mathew Uckele',
    lead_type: 'seller',
    follow_up_state: 'needs-response',
    next_action_at: '',
    tags: 'manual',
    notes: '',
    listing_url: '',
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: '',
    broker_email: '',
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
  };
}

function StatCard({ icon: Icon, label, value, tone = 'default' }) {
  const tones = {
    default: 'bg-moss/8 text-moss',
    success: 'bg-moss/10 text-moss',
    warning: 'bg-amber-100 text-amber-700',
    danger: 'bg-red-100 text-red-700',
    info: 'bg-sky-100 text-sky-700',
  };

  return (
    <div className="panel p-5 sm:p-6">
      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${tones[tone]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <p className="mt-5 text-sm font-semibold uppercase tracking-[0.18em] text-moss/80">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">{value}</p>
    </div>
  );
}

function Pill({ children, tone = 'default' }) {
  const tones = {
    default: 'border-ink/10 bg-white text-ink/72',
    status: 'border-clay/20 bg-clay/10 text-clay',
    success: 'border-moss/20 bg-moss/10 text-moss',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
    info: 'border-sky-200 bg-sky-50 text-sky-700',
  };

  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${tones[tone]}`}>{children}</span>;
}

function notificationToneClasses(severity) {
  if (severity === 'danger') {
    return 'border-red-200 bg-red-50 text-red-800';
  }

  if (severity === 'warning') {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }

  return 'border-sky-200 bg-sky-50 text-sky-800';
}

function SectionLabel({ children }) {
  return <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">{children}</p>;
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium text-ink">
      {label}
      {children}
    </label>
  );
}

function InputField({ label, value, onChange, placeholder = '', type = 'text' }) {
  return (
    <Field label={label}>
      <input
        className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
        onChange={onChange}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </Field>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <Field label={label}>
      <select
        className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
        onChange={onChange}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {formatLabel(option)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TextAreaField({ label, value, onChange, placeholder = '' }) {
  return (
    <Field label={label}>
      <textarea
        className="min-h-[132px] rounded-3xl border border-line bg-white px-4 py-4 text-sm text-ink outline-none transition focus:border-moss"
        onChange={onChange}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}

function LinksRow({ submission }) {
  const links = [
    submission.listing_url ? { href: submission.listing_url, label: 'Listing URL' } : null,
    submission.business_website ? { href: submission.business_website, label: 'Website' } : null,
    submission.prospectus_url ? { href: submission.prospectus_url, label: 'Prospectus / CIM' } : null,
  ].filter(Boolean);

  if (links.length === 0) {
    return <p className="mt-4 text-sm leading-7 text-ink/68">No listing or company links added yet.</p>;
  }

  return (
    <div className="mt-4 flex flex-wrap gap-3">
      {links.map((link) => (
        <a
          className="inline-flex items-center justify-center rounded-full border border-ink/10 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink transition hover:border-moss/25 hover:text-moss"
          href={link.href}
          key={link.label}
          rel="noreferrer"
          target="_blank"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}

function DealHunterCard({ deal, mode = 'fit', onSendCimRequest, requestingCim = false }) {
  const detailItems = mode === 'remove' ? deal.removeReasons || deal.concerns || [] : deal.strengths || [];
  const meta = [
    deal.industry,
    deal.location,
    deal.annualProfit ? `Profit ${formatMoney(deal.annualProfit)}` : '',
    deal.askingPrice ? `Ask ${formatMoney(deal.askingPrice)}` : '',
    deal.profitMultiple ? `${deal.profitMultiple}x profit` : '',
  ].filter(Boolean);
  const cimRequest = deal.cimRequest || {};
  const showCimRequest = mode !== 'remove' && deal.score >= 75;
  const cimRequestComplete = ['sent', 'logged', 'follow_up_failed', 'delivery_issue', 'follow_up_pending'].includes(cimRequest.status);
  const cimTone =
    cimRequest.status === 'failed' || cimRequest.status === 'follow_up_failed' || cimRequest.status === 'delivery_issue'
      ? 'danger'
      : cimRequest.status === 'pending' || cimRequest.status === 'follow_up_pending'
        ? 'warning'
        : cimRequest.status === 'responded' || cimRequestComplete
          ? 'success'
          : 'info';
  const cimLabel =
    cimRequest.status === 'responded'
      ? 'Broker replied'
      : cimRequest.status === 'delivery_issue'
        ? 'Delivery issue'
        : cimRequest.status === 'follow_up_failed'
          ? 'Follow-up failed'
          : cimRequest.status === 'follow_up_pending'
            ? 'Follow-up pending'
            : cimRequest.status === 'sent'
              ? 'CIM requested'
              : cimRequest.status === 'logged'
                ? 'CIM logged'
                : cimRequest.status === 'failed'
                  ? 'CIM failed'
                  : cimRequest.status === 'pending'
                    ? 'CIM pending'
                    : cimRequest.eligible
                      ? 'CIM ready'
                      : 'CIM blocked';
  const followUpSummary =
    cimRequest.followUpCount > 0
      ? ` ${cimRequest.followUpCount} follow-up${cimRequest.followUpCount === 1 ? '' : 's'} sent.`
      : '';
  const nextFollowUpSummary = cimRequest.nextFollowUpAt ? ` Next follow-up: ${formatDateTime(cimRequest.nextFollowUpAt)}.` : '';
  const cimDescription =
    cimRequest.status === 'responded'
      ? `Reply recorded ${formatDateTime(cimRequest.respondedAt)}.`
      : cimRequest.status === 'follow_up_pending'
        ? `A CIM follow-up send is in progress for ${cimRequest.recipientEmail}.${nextFollowUpSummary}`
        : cimRequestComplete
          ? `Requested ${formatDateTime(cimRequest.requestedAt)}${cimRequest.recipientEmail ? ` to ${cimRequest.recipientEmail}` : ''}.${followUpSummary}${nextFollowUpSummary}`
          : cimRequest.eligible
            ? `Ready to request the CIM from ${cimRequest.recipientEmail}.`
            : cimRequest.reason || 'No broker or contact email is available for this listing.';

  return (
    <div className={`rounded-[24px] border p-5 ${notificationToneClasses(mode === 'remove' ? 'danger' : mode === 'watch' ? 'warning' : 'info')}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={dealScoreTone(deal.score)}>Score {deal.score}</Pill>
        {deal.isNew ? <Pill tone="success">New</Pill> : null}
        {showCimRequest ? <Pill tone={cimTone}>{cimLabel}</Pill> : null}
        <Pill>{deal.sourceName}</Pill>
      </div>
      <h3 className="mt-3 text-lg font-semibold leading-snug">{deal.name}</h3>
      {meta.length > 0 ? <p className="mt-2 text-sm leading-6">{meta.join(' | ')}</p> : null}
      {deal.recommendation ? <p className="mt-3 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-6">{deal.recommendation}</p> : null}
      {showCimRequest ? (
        <div className="mt-4 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-6">
          <p className="font-semibold uppercase tracking-[0.14em]">CIM Request</p>
          <p className="mt-2">{cimDescription}</p>
          {cimRequest.deliveryError ? <p className="mt-2 text-red-700">{cimRequest.deliveryError}</p> : null}
          {cimRequest.canRequest && onSendCimRequest ? (
            <button
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full border border-moss bg-moss px-4 py-2.5 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:opacity-50"
              disabled={requestingCim}
              onClick={() => onSendCimRequest(deal)}
              type="button"
            >
              <Send className="h-4 w-4" />
              {requestingCim ? 'Sending...' : 'Send CIM Request'}
            </button>
          ) : null}
        </div>
      ) : null}
      {detailItems.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6">
          {detailItems.slice(0, 3).map((item) => (
            <li key={`${deal.id}-${item}`}>{item}</li>
          ))}
        </ul>
      ) : null}
      {deal.questions?.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-6">
          <p className="font-semibold uppercase tracking-[0.14em]">Questions</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {deal.questions.slice(0, 2).map((question) => (
              <li key={`${deal.id}-${question}`}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {deal.listingUrl ? (
        <a className="mt-4 inline-flex text-sm font-semibold text-moss underline" href={deal.listingUrl} rel="noreferrer" target="_blank">
          View listing
        </a>
      ) : null}
    </div>
  );
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export default function DashboardPage() {
  const [authState, setAuthState] = useState({
    checked: false,
    authenticated: false,
    username: '',
    authMode: 'hybrid',
    magicLinkEnabled: false,
    passwordEnabled: false,
    adminEmailHint: '',
  });
  const [magicLinkForm, setMagicLinkForm] = useState({ email: '' });
  const [magicLinkFeedback, setMagicLinkFeedback] = useState({ error: '', message: '', previewUrl: '' });
  const [magicLinkPending, setMagicLinkPending] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [filters, setFilters] = useState({ search: '', status: 'all' });
  const [dashboardData, setDashboardData] = useState({ summary: null, submissions: [], notifications: [], emailTriage: [], total: 0 });
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [savingSubmissionId, setSavingSubmissionId] = useState('');
  const [creatingUploadForId, setCreatingUploadForId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState(blankRecordDraft());
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState('');
  const [dealHunterReview, setDealHunterReview] = useState(null);
  const [dealHunterLoading, setDealHunterLoading] = useState(false);
  const [dealHunterSending, setDealHunterSending] = useState(false);
  const [dealHunterFollowUpRunning, setDealHunterFollowUpRunning] = useState(false);
  const [requestingCimDealKey, setRequestingCimDealKey] = useState('');
  const [dealHunterFeedback, setDealHunterFeedback] = useState({ error: '', message: '' });
  const [prospectDiscovery, setProspectDiscovery] = useState({
    config: null,
    summary: null,
    runs: [],
    discoveries: [],
  });
  const [prospectDiscoveryForm, setProspectDiscoveryForm] = useState({
    query: '',
    maxResults: '10',
    autoImport: true,
  });
  const [prospectDiscoveryLoading, setProspectDiscoveryLoading] = useState(false);
  const [prospectDiscoveryRunning, setProspectDiscoveryRunning] = useState(false);
  const [prospectDiscoveryFeedback, setProspectDiscoveryFeedback] = useState({ error: '', message: '' });
  const deferredSearch = useDeferredValue(filters.search);

  async function checkSession() {
    const response = await fetch('/api/admin/session', { credentials: 'same-origin' });
    const result = await response.json();

    setAuthState({
      checked: true,
      authenticated: Boolean(result.authenticated),
      username: result.username || '',
      authMode: result.authMode || 'hybrid',
      magicLinkEnabled: Boolean(result.magicLinkEnabled),
      passwordEnabled: Boolean(result.passwordEnabled),
      adminEmailHint: result.adminEmailHint || '',
    });
  }

  async function verifyMagicLink(token) {
    const response = await fetch('/api/admin/magic-link/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      setMagicLinkFeedback({
        error: result.error || 'That sign-in link is invalid or has expired.',
        message: '',
        previewUrl: '',
      });
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.delete('admin_token');
    window.history.replaceState({}, '', url.toString());
    await checkSession();
  }

  async function loadDashboard(status, search) {
    setLoading(true);
    setActionError('');

    try {
      const query = new URLSearchParams();

      if (status && status !== 'all') {
        query.set('status', status);
      }

      if (search) {
        query.set('search', search);
      }

      const response = await fetch(`/api/admin/submissions?${query.toString()}`, {
        credentials: 'same-origin',
      });

      if (response.status === 401) {
        setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '' }));
        return;
      }

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to load submissions.');
      }

      setDashboardData({
        summary: result.summary,
        submissions: result.submissions,
        notifications: result.notifications || [],
        emailTriage: result.emailTriage || [],
        total: result.total,
      });
      setDrafts(
        result.submissions.reduce((accumulator, submission) => {
          accumulator[submission.id] = buildDraft(submission);
          return accumulator;
        }, {}),
      );
    } catch (error) {
      setActionError(error.message || 'Unable to load submissions.');
    } finally {
      setLoading(false);
    }
  }

  async function loadProspectDiscovery() {
    setProspectDiscoveryLoading(true);

    try {
      const response = await fetch('/api/admin/prospect-discovery', {
        credentials: 'same-origin',
      });

      if (response.status === 401) {
        setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '' }));
        return;
      }

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to load prospect discovery.');
      }

      setProspectDiscovery({
        config: result.config,
        summary: result.summary,
        runs: result.runs || [],
        discoveries: result.discoveries || [],
      });

      if (!prospectDiscoveryForm.query && result.config?.queries?.[0]) {
        setProspectDiscoveryForm((current) => ({
          ...current,
          query: result.config.queries[0],
          maxResults: String(result.config.maxResultsPerQuery || 10),
          autoImport: Boolean(result.config.autoImport),
        }));
      }
    } catch (error) {
      setProspectDiscoveryFeedback({ error: error.message || 'Unable to load prospect discovery.', message: '' });
    } finally {
      setProspectDiscoveryLoading(false);
    }
  }

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('admin_token');

    if (token) {
      verifyMagicLink(token);
      return;
    }

    checkSession();
  }, []);

  useEffect(() => {
    if (authState.authenticated) {
      loadDashboard(filters.status, deferredSearch.trim());
      loadProspectDiscovery();
    }
  }, [authState.authenticated, deferredSearch, filters.status]);

  async function handleMagicLinkRequest(event) {
    event.preventDefault();
    setMagicLinkPending(true);
    setMagicLinkFeedback({ error: '', message: '', previewUrl: '' });

    try {
      const response = await fetch('/api/admin/magic-link/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(magicLinkForm),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to send a sign-in link.');
      }

      setMagicLinkFeedback({
        error: '',
        message: result.message || 'A sign-in link has been sent.',
        previewUrl: result.previewUrl || '',
      });
    } catch (error) {
      setMagicLinkFeedback({
        error: error.message || 'Unable to send a sign-in link.',
        message: '',
        previewUrl: '',
      });
    } finally {
      setMagicLinkPending(false);
    }
  }

  async function handlePasswordLogin(event) {
    event.preventDefault();
    setLoginPending(true);
    setLoginError('');

    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(loginForm),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to sign in.');
      }

      await checkSession();
    } catch (error) {
      setLoginError(error.message || 'Unable to sign in.');
    } finally {
      setLoginPending(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/session', {
      method: 'DELETE',
      credentials: 'same-origin',
    });

    setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '' }));
  }

  async function handleSave(submissionId) {
    setSavingSubmissionId(submissionId);
    setActionError('');

    try {
      const draft = drafts[submissionId];
      const response = await fetch(`/api/admin/submissions/${submissionId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...draft,
          next_action_at: fromDateTimeLocal(draft.next_action_at),
          tags: draft.tags,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to update submission.');
      }

      setDashboardData((current) => ({
        ...current,
        submissions: current.submissions.map((submission) =>
          submission.id === submissionId ? result.submission : submission,
        ),
        notifications: current.notifications.map((submission) =>
          submission.id === submissionId ? result.submission : submission,
        ),
        emailTriage: current.emailTriage.map((submission) =>
          submission.id === submissionId ? result.submission : submission,
        ),
      }));
      setDrafts((current) => ({
        ...current,
        [submissionId]: buildDraft(result.submission),
      }));
      await loadDashboard(filters.status, deferredSearch.trim());
    } catch (error) {
      setActionError(error.message || 'Unable to update submission.');
    } finally {
      setSavingSubmissionId('');
    }
  }

  async function handleCreateSubmission(event) {
    event.preventDefault();
    setCreatePending(true);
    setCreateError('');

    try {
      const response = await fetch('/api/admin/submissions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...createDraft,
          next_action_at: fromDateTimeLocal(createDraft.next_action_at),
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.errors?.join(' ') || result.error || 'Unable to create the CRM record.');
      }

      setCreateDraft(blankRecordDraft());
      setCreateOpen(false);
      await loadDashboard(filters.status, deferredSearch.trim());
    } catch (error) {
      setCreateError(error.message || 'Unable to create the CRM record.');
    } finally {
      setCreatePending(false);
    }
  }

  async function handleCreateUploadRequest(submissionId) {
    setCreatingUploadForId(submissionId);
    setActionError('');

    try {
      const response = await fetch(`/api/admin/submissions/${submissionId}/upload-request`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          note: drafts[submissionId]?.notes || '',
          sendEmail: true,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to create a secure upload request.');
      }

      setDashboardData((current) => ({
        ...current,
        submissions: current.submissions.map((submission) =>
          submission.id === submissionId
            ? {
                ...submission,
                latest_upload_request: result.request,
              }
            : submission,
        ),
      }));

      await copyText(result.uploadUrl);
    } catch (error) {
      setActionError(error.message || 'Unable to create a secure upload request.');
    } finally {
      setCreatingUploadForId('');
    }
  }

  async function handleLoadDealHunterReview() {
    setDealHunterLoading(true);
    setDealHunterFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/deal-hunter/review', {
        credentials: 'same-origin',
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to review daily deals.');
      }

      setDealHunterReview(result.review);
      setDealHunterFeedback({ error: '', message: `Reviewed ${result.review?.totals?.reviewedDeals || 0} recent deals.` });
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to review daily deals.', message: '' });
    } finally {
      setDealHunterLoading(false);
    }
  }

  async function handleSendDealHunterEmail() {
    setDealHunterSending(true);
    setDealHunterFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/deal-hunter/send', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.emailResult?.error || result.error || 'Unable to send the daily deal email.');
      }

      setDealHunterReview(result.review);
      const crmSync = result.crmSync || result.review?.crmSync;
      const crmMessage = crmSync?.reviewed
        ? ` CRM sync: ${crmSync.created || 0} created, ${crmSync.enriched || 0} enriched, ${crmSync.updated || 0} updated, ${crmSync.skipped || 0} skipped.`
        : '';
      setDealHunterFeedback({ error: '', message: `Daily deal email sent.${crmMessage}` });
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to send the daily deal email.', message: '' });
    } finally {
      setDealHunterSending(false);
    }
  }

  function replaceDealHunterDeal(updatedDeal) {
    if (!updatedDeal?.dealKey) {
      return;
    }

    setDealHunterReview((current) => {
      if (!current) {
        return current;
      }

      const replaceDeals = (deals = []) =>
        deals.map((deal) => (deal.dealKey === updatedDeal.dealKey ? { ...deal, ...updatedDeal } : deal));

      return {
        ...current,
        newlySeenMatches: replaceDeals(current.newlySeenMatches),
        qualified: replaceDeals(current.qualified),
        watchlist: replaceDeals(current.watchlist),
        removalCandidates: replaceDeals(current.removalCandidates),
      };
    });
  }

  async function handleSendCimRequest(deal) {
    if (!deal?.dealKey) {
      setDealHunterFeedback({ error: 'Deal key is missing for this listing.', message: '' });
      return;
    }

    setRequestingCimDealKey(deal.dealKey);
    setDealHunterFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/deal-hunter/cim-request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dealKey: deal.dealKey }),
      });
      const result = await response.json();

      if (result.deal) {
        replaceDealHunterDeal(result.deal);
      }

      if (!response.ok || !result.success) {
        throw new Error(result.emailResult?.error || result.error || 'Unable to send the CIM request.');
      }

      const recipient = result.deal?.cimRequest?.recipientEmail || deal.brokerEmail || 'the broker';
      setDealHunterFeedback({
        error: '',
        message: result.alreadySent ? `CIM request was already sent to ${recipient}.` : `CIM request sent to ${recipient}.`,
      });
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to send the CIM request.', message: '' });
    } finally {
      setRequestingCimDealKey('');
    }
  }

  async function handleRunCimFollowUps() {
    setDealHunterFollowUpRunning(true);
    setDealHunterFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/deal-hunter/cim-follow-ups/run', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 50 }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to run CIM follow-ups.');
      }

      const message = `CIM follow-up check complete: ${result.sent || 0} sent, ${result.responded || 0} replied, ${result.stopped || 0} stopped, ${result.failed || 0} failed.`;
      await handleLoadDealHunterReview();
      setDealHunterFeedback({ error: '', message });
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to run CIM follow-ups.', message: '' });
    } finally {
      setDealHunterFollowUpRunning(false);
    }
  }

  async function handleRunProspectDiscovery(event) {
    event.preventDefault();
    setProspectDiscoveryRunning(true);
    setProspectDiscoveryFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/prospect-discovery/run', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: prospectDiscoveryForm.query,
          maxResults: Number(prospectDiscoveryForm.maxResults) || undefined,
          autoImport: prospectDiscoveryForm.autoImport,
        }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to run prospect discovery.');
      }

      const tierCounts = (result.discoveries || []).reduce(
        (accumulator, discovery) => ({
          ...accumulator,
          [discovery.lead_tier || 'unclassified']: (accumulator[discovery.lead_tier || 'unclassified'] || 0) + 1,
        }),
        { tier_a: 0, tier_b: 0, tier_c: 0, dnp: 0 },
      );

      setProspectDiscoveryFeedback({
        error: '',
        message: `Classified ${result.count || 0} businesses: ${tierCounts.tier_a || 0} Tier A, ${tierCounts.tier_b || 0} Tier B, ${tierCounts.tier_c || 0} Tier C, ${tierCounts.dnp || 0} DNP. Imported ${result.importedCount || 0} CRM record${result.importedCount === 1 ? '' : 's'}.`,
      });
      await Promise.all([
        loadProspectDiscovery(),
        loadDashboard(filters.status, deferredSearch.trim()),
      ]);
    } catch (error) {
      setProspectDiscoveryFeedback({ error: error.message || 'Unable to run prospect discovery.', message: '' });
    } finally {
      setProspectDiscoveryRunning(false);
    }
  }

  const summary = dashboardData.summary || {
    total: 0,
    lastSevenDays: 0,
    dueToday: 0,
    actionItems: 0,
    overdue: 0,
    dueSoon: 0,
    missingNextAction: 0,
    emailEngaged: 0,
    hotLeads: 0,
    new: 0,
    review: 0,
    contacted: 0,
    archived: 0,
    spam: 0,
  };

  const submissions = useMemo(() => dashboardData.submissions || [], [dashboardData.submissions]);
  const notifications = useMemo(() => dashboardData.notifications || [], [dashboardData.notifications]);
  const emailTriage = useMemo(() => dashboardData.emailTriage || [], [dashboardData.emailTriage]);

  if (!authState.checked) {
    return (
      <>
        <Seo description="Private admin CRM for Uckele Group." keywords="private admin crm" noindex title="Admin | Uckele Group" />
        <PageHero description="Checking the current admin session." eyebrow="Admin" title="Loading admin CRM" />
      </>
    );
  }

  if (!authState.authenticated) {
    return (
      <>
        <Seo description="Private admin CRM for Uckele Group." keywords="private admin crm" noindex title="Admin | Uckele Group" />

        <PageHero
          description="Secure admin access for the private acquisition CRM, follow-up workflow, and secure document requests."
          eyebrow="Private Admin"
          title="Authorized CRM access"
        />

        <section className="section-shell mt-10">
          <div className="grid gap-8 lg:grid-cols-2">
            <Reveal className="panel p-7 sm:p-9">
              <form className="space-y-5" onSubmit={handleMagicLinkRequest}>
                <div>
                  <SectionLabel>Magic-Link Sign In</SectionLabel>
                  <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Secure access without a shared password</h2>
                  <p className="mt-3 text-base leading-7 text-ink/72">
                    Use the admin email address to request a time-limited sign-in link{authState.adminEmailHint ? ` (${authState.adminEmailHint})` : ''}.
                  </p>
                </div>

                <InputField
                  label="Admin email"
                  onChange={(event) => setMagicLinkForm({ email: event.target.value })}
                  type="email"
                  value={magicLinkForm.email}
                />

                {magicLinkFeedback.message ? (
                  <div className="rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">
                    <p>{magicLinkFeedback.message}</p>
                    {magicLinkFeedback.previewUrl ? (
                      <p className="mt-2 break-all text-xs text-ink/70">Local preview link: {magicLinkFeedback.previewUrl}</p>
                    ) : null}
                  </div>
                ) : null}

                {magicLinkFeedback.error ? (
                  <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{magicLinkFeedback.error}</p>
                ) : null}

                <button
                  className={primaryActionButtonClass}
                  disabled={magicLinkPending || !authState.magicLinkEnabled}
                  type="submit"
                >
                  {magicLinkPending ? 'Sending Link...' : 'Send Sign-In Link'}
                </button>
              </form>
            </Reveal>

            <Reveal className="panel p-7 sm:p-9" delay={120}>
              <form className="space-y-5" onSubmit={handlePasswordLogin}>
                <div>
                  <SectionLabel>Fallback Access</SectionLabel>
                  <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Password sign-in</h2>
                  <p className="mt-3 text-base leading-7 text-ink/72">
                    This is primarily for local development or temporary fallback use. In production, the preferred path is the emailed magic link.
                  </p>
                </div>

                <InputField
                  label="Username"
                  onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
                  value={loginForm.username}
                />

                <InputField
                  label="Password"
                  onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                  type="password"
                  value={loginForm.password}
                />

                {loginError ? (
                  <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{loginError}</p>
                ) : null}

                <button
                  className={secondaryActionButtonClass}
                  disabled={loginPending || !authState.passwordEnabled}
                  type="submit"
                >
                  {loginPending ? 'Signing In...' : 'Sign In With Password'}
                </button>
              </form>
            </Reveal>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <Seo description="Private admin CRM for Uckele Group." keywords="private admin crm" noindex title="Admin | Uckele Group" />

      <PageHero
        description="Private admin area for tracking broker and seller opportunities, internal notes, and follow-up priorities."
        eyebrow="Admin CRM"
        title="Acquisition pipeline, notes, and follow-up prompts"
      />

      <section className="section-shell mt-10">
        <Reveal className="panel px-7 py-8 sm:px-9">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Signed in as {authState.username}</p>
              <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Broker and seller CRM</h2>
              <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                This is no longer just a submissions inbox. It now tracks sourced opportunities, broker conversations, seller follow-ups, deal notes, and secure document requests in one place.
              </p>
            </div>

            <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap">
              <button
                className={primaryActionButtonClass}
                onClick={() => setCreateOpen((current) => !current)}
                type="button"
              >
                <Plus className="h-4 w-4" />
                {createOpen ? 'Close New Record' : 'New CRM Record'}
              </button>
              <a
                className={secondaryActionButtonClass}
                href="/api/admin/submissions/export"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </a>
              <a
                className={secondaryActionButtonClass}
                href={dailyDealUpdateUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ClipboardList className="h-4 w-4" />
                Daily Deal Update
              </a>
              <button
                className={secondaryActionButtonClass}
                onClick={handleLogout}
                type="button"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="section-shell mt-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <StatCard icon={Inbox} label="Total Records" value={summary.total} />
          <StatCard icon={BellRing} label="Action Items" value={summary.actionItems} tone={summary.actionItems > 0 ? 'warning' : 'default'} />
          <StatCard icon={CalendarClock} label="Overdue" value={summary.overdue} tone={summary.overdue > 0 ? 'danger' : 'default'} />
          <StatCard icon={ClipboardList} label="Due Soon" value={summary.dueSoon} tone={summary.dueSoon > 0 ? 'warning' : 'default'} />
          <StatCard icon={MailCheck} label="Warm Leads" value={summary.emailEngaged} tone={summary.emailEngaged > 0 ? 'warning' : 'default'} />
          <StatCard icon={MailCheck} label="Last 7 Days" value={summary.lastSevenDays} />
          <StatCard icon={ShieldAlert} label="Spam" value={summary.spam} />
        </div>
      </section>

      <section className="section-shell mt-8">
        <Reveal className="panel p-7 sm:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <SectionLabel>Prospect Discovery</SectionLabel>
              <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Find and import local business prospects</h2>
              <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                Search Google Places for target business categories, score operating strength and online presence gaps, then import Tier A/B/C prospects for follow-up.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Pill tone={prospectDiscovery.config?.enabled ? 'success' : 'danger'}>
                {prospectDiscovery.config?.enabled ? 'Enabled' : 'Disabled'}
              </Pill>
              <Pill tone={prospectDiscovery.config?.hasGooglePlacesApiKey ? 'success' : 'warning'}>
                {prospectDiscovery.config?.provider || 'google-places'}
              </Pill>
              <Pill tone={prospectDiscovery.config?.autoImport ? 'warning' : 'default'}>
                {prospectDiscovery.config?.autoImport ? 'Auto Import' : 'Review Only'}
              </Pill>
              <Pill tone={prospectDiscovery.config?.websiteCheckEnabled ? 'success' : 'default'}>
                {prospectDiscovery.config?.websiteCheckEnabled ? 'Website Check' : 'Listing Signals Only'}
              </Pill>
            </div>
          </div>

          <form className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_140px_auto]" onSubmit={handleRunProspectDiscovery}>
            <InputField
              label="Search query"
              onChange={(event) => setProspectDiscoveryForm((current) => ({ ...current, query: event.target.value }))}
              placeholder="Example: plumbers near New Rochelle NY"
              value={prospectDiscoveryForm.query}
            />
            <InputField
              label="Max results"
              onChange={(event) => setProspectDiscoveryForm((current) => ({ ...current, maxResults: event.target.value }))}
              type="number"
              value={prospectDiscoveryForm.maxResults}
            />
            <div className="flex flex-col justify-end gap-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                <input
                  checked={prospectDiscoveryForm.autoImport}
                  className="h-4 w-4 rounded border-line text-moss"
                  onChange={(event) => setProspectDiscoveryForm((current) => ({ ...current, autoImport: event.target.checked }))}
                  type="checkbox"
                />
                Auto-import
              </label>
              <button
                className={primaryActionButtonClass}
                disabled={prospectDiscoveryRunning || prospectDiscoveryLoading || !prospectDiscoveryForm.query}
                type="submit"
              >
                <Search className="h-4 w-4" />
                {prospectDiscoveryRunning ? 'Discovering...' : 'Run Discovery'}
              </button>
            </div>
          </form>

          {!prospectDiscovery.config?.enabled || !prospectDiscovery.config?.hasGooglePlacesApiKey ? (
            <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              Configure `PROSPECT_DISCOVERY_ENABLED=true`, `GOOGLE_PLACES_API_KEY`, and `PROSPECT_DISCOVERY_QUERIES` before running live discovery.
            </p>
          ) : null}

          {prospectDiscoveryFeedback.error ? (
            <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{prospectDiscoveryFeedback.error}</p>
          ) : null}
          {prospectDiscoveryFeedback.message ? (
            <p className="mt-5 rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">{prospectDiscoveryFeedback.message}</p>
          ) : null}

          <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard icon={MapPin} label="Discovered" value={prospectDiscovery.summary?.total || 0} />
            <StatCard icon={Plus} label="Tier A" value={prospectDiscovery.summary?.byTier?.tier_a || 0} tone="success" />
            <StatCard icon={ClipboardList} label="Tier B" value={prospectDiscovery.summary?.byTier?.tier_b || 0} tone="warning" />
            <StatCard icon={ShieldAlert} label="Tier C" value={prospectDiscovery.summary?.byTier?.tier_c || 0} tone="info" />
            <StatCard icon={RefreshCw} label="DNP" value={prospectDiscovery.summary?.byTier?.dnp || 0} tone={(prospectDiscovery.summary?.byTier?.dnp || 0) > 0 ? 'danger' : 'default'} />
          </div>

          <div className="mt-7 grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-[24px] border border-line/80 bg-fog/70 p-5">
              <SectionLabel>Recent Prospects</SectionLabel>
              {prospectDiscovery.discoveries?.length > 0 ? (
                <div className="mt-4 space-y-3">
                  {prospectDiscovery.discoveries.slice(0, 8).map((discovery) => (
                    <div className="rounded-2xl border border-line/80 bg-white/75 px-4 py-3 text-sm leading-6 text-ink/74" key={discovery.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-ink">{discovery.business_name}</p>
                        <Pill tone={leadTierTone(discovery.lead_tier)}>
                          {formatLeadTier(discovery.lead_tier)}
                        </Pill>
                        <Pill tone={discovery.status === 'imported' ? 'success' : discovery.status === 'duplicate' ? 'warning' : discovery.status === 'not-prioritized' ? 'danger' : 'info'}>
                          {formatLabel(discovery.status)}
                        </Pill>
                        <Pill>Score {discovery.score || 0}</Pill>
                      </div>
                      <p className="mt-2">
                        {[discovery.category, discovery.address, discovery.review_count ? `${discovery.review_count} reviews` : ''].filter(Boolean).join(' | ')}
                      </p>
                      <p className="mt-2">
                        Quality {discovery.business_quality_score || 0}/100 | Presence gap {discovery.presence_gap_score || 0}/100
                      </p>
                      {discovery.recommended_action ? <p className="mt-2 font-medium text-ink">{discovery.recommended_action}</p> : null}
                      {discovery.outreach_angle ? <p className="mt-2">{discovery.outreach_angle}</p> : null}
                      <div className="mt-2 flex flex-wrap gap-3">
                        {discovery.website_url ? (
                          <a className="font-semibold text-moss underline" href={discovery.website_url} rel="noreferrer" target="_blank">Website</a>
                        ) : null}
                        {discovery.source_data?.googleMapsUri ? (
                          <a className="font-semibold text-moss underline" href={discovery.source_data.googleMapsUri} rel="noreferrer" target="_blank">Google Maps</a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-7 text-ink/68">No prospects discovered yet.</p>
              )}
            </div>

            <div className="rounded-[24px] border border-line/80 bg-white/70 p-5">
              <SectionLabel>Recent Runs</SectionLabel>
              {prospectDiscovery.runs?.length > 0 ? (
                <div className="mt-4 space-y-3">
                  {prospectDiscovery.runs.slice(0, 5).map((run) => (
                    <div className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-3 text-sm leading-6 text-ink/74" key={run.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'}>{formatLabel(run.status)}</Pill>
                        <Pill>{run.provider}</Pill>
                      </div>
                      <p className="mt-2 font-semibold text-ink">{run.query}</p>
                      <p className="mt-1">{formatDateTime(run.created_at)} | Imported {run.imported_count || 0}</p>
                      {run.error ? <p className="mt-2 text-red-700">{run.error}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-7 text-ink/68">No discovery runs yet.</p>
              )}
            </div>
          </div>
        </Reveal>
      </section>

      <section className="section-shell mt-8">
        <Reveal className="panel p-7 sm:p-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <SectionLabel>Deal Hunter Scoring</SectionLabel>
              <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Daily source review</h2>
              <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                Pulls the SMB Deal Hunter sheet and the larger Airtable business list, scores recent listings against your acquisition profile, and flags removals for tomorrow's update.
              </p>
            </div>

            <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap">
              <button
                className={secondaryActionButtonClass}
                disabled={dealHunterLoading || dealHunterSending || dealHunterFollowUpRunning}
                onClick={handleLoadDealHunterReview}
                type="button"
              >
                <RefreshCw className={`h-4 w-4 ${dealHunterLoading ? 'animate-spin' : ''}`} />
                {dealHunterLoading ? 'Reviewing...' : 'Review Sources'}
              </button>
              <button
                className={secondaryActionButtonClass}
                disabled={dealHunterLoading || dealHunterSending || dealHunterFollowUpRunning}
                onClick={handleRunCimFollowUps}
                type="button"
              >
                <MailCheck className={`h-4 w-4 ${dealHunterFollowUpRunning ? 'animate-pulse' : ''}`} />
                {dealHunterFollowUpRunning ? 'Checking...' : 'Run CIM Follow-Ups'}
              </button>
              <button
                className={primaryActionButtonClass}
                disabled={dealHunterLoading || dealHunterSending || dealHunterFollowUpRunning}
                onClick={handleSendDealHunterEmail}
                type="button"
              >
                <Send className="h-4 w-4" />
                {dealHunterSending ? 'Sending...' : 'Send Daily Email'}
              </button>
            </div>
          </div>

          {dealHunterFeedback.error ? (
            <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{dealHunterFeedback.error}</p>
          ) : null}
          {dealHunterFeedback.message ? (
            <p className="mt-5 rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">{dealHunterFeedback.message}</p>
          ) : null}

          {dealHunterReview ? (
            <div className="mt-7 space-y-7">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
                <StatCard icon={ClipboardList} label="Reviewed" value={dealHunterReview.totals?.reviewedDeals || 0} />
                <StatCard icon={BellRing} label="New Fits" value={dealHunterReview.totals?.newMatches || 0} tone={dealHunterReview.totals?.newMatches > 0 ? 'warning' : 'default'} />
                <StatCard icon={MailCheck} label="High Fit" value={dealHunterReview.totals?.qualified || 0} tone={dealHunterReview.totals?.qualified > 0 ? 'warning' : 'default'} />
                <StatCard icon={Send} label="CIM Ready" value={dealHunterReview.totals?.cimReady || 0} tone={dealHunterReview.totals?.cimReady > 0 ? 'warning' : 'default'} />
                <StatCard icon={Inbox} label="Watchlist" value={dealHunterReview.totals?.watchlist || 0} />
                <StatCard icon={ShieldAlert} label="Remove" value={dealHunterReview.totals?.removalCandidates || 0} tone={dealHunterReview.totals?.removalCandidates > 0 ? 'danger' : 'default'} />
                <StatCard icon={CalendarClock} label="Lookback" value={`${dealHunterReview.lookbackDays || 0}d`} />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-[24px] border border-line/80 bg-fog/70 p-5">
                  <SectionLabel>Sources</SectionLabel>
                  <div className="mt-4 space-y-3">
                    {(dealHunterReview.sources || []).map((source) => (
                      <div className="rounded-2xl border border-line/80 bg-white/75 px-4 py-3 text-sm leading-6 text-ink/74" key={source.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-ink">{source.name}</p>
                          <Pill tone={source.fetched ? 'success' : 'danger'}>{source.fetched ? `${source.rowCount || 0} rows` : 'failed'}</Pill>
                          <Pill>{source.mode}</Pill>
                        </div>
                        {source.error ? <p className="mt-2 text-red-700">{source.error}</p> : null}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[24px] border border-line/80 bg-white/70 p-5">
                  <SectionLabel>Criteria Notes</SectionLabel>
                  {dealHunterReview.criteriaRecommendations?.length > 0 ? (
                    <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7 text-ink/74">
                      {dealHunterReview.criteriaRecommendations.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-4 text-sm leading-7 text-ink/68">No criteria changes recommended from the latest run.</p>
                  )}
                </div>
              </div>

              {dealHunterReview.newlySeenMatches?.length > 0 ? (
                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <SectionLabel>Newly Seen Fits</SectionLabel>
                    <Pill tone="success">{dealHunterReview.newlySeenMatches.length}</Pill>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                    {dealHunterReview.newlySeenMatches.slice(0, 6).map((deal) => (
                      <DealHunterCard
                        deal={deal}
                        key={`new-${deal.sourceName}-${deal.dealKey || deal.id || deal.listingUrl}`}
                        onSendCimRequest={handleSendCimRequest}
                        requestingCim={requestingCimDealKey === deal.dealKey}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-5 xl:grid-cols-3">
                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <SectionLabel>High Fit</SectionLabel>
                    <Pill tone="success">{dealHunterReview.qualified?.length || 0}</Pill>
                  </div>
                  <div className="space-y-4">
                    {(dealHunterReview.qualified || []).slice(0, 4).map((deal) => (
                      <DealHunterCard
                        deal={deal}
                        key={`qualified-${deal.sourceName}-${deal.id || deal.listingUrl}`}
                        onSendCimRequest={handleSendCimRequest}
                        requestingCim={requestingCimDealKey === deal.dealKey}
                      />
                    ))}
                    {dealHunterReview.qualified?.length === 0 ? <p className="text-sm leading-7 text-ink/68">No high-fit recent listings found.</p> : null}
                  </div>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <SectionLabel>Watchlist</SectionLabel>
                    <Pill tone="warning">{dealHunterReview.watchlist?.length || 0}</Pill>
                  </div>
                  <div className="space-y-4">
                    {(dealHunterReview.watchlist || []).slice(0, 4).map((deal) => (
                      <DealHunterCard
                        deal={deal}
                        key={`watch-${deal.sourceName}-${deal.id || deal.listingUrl}`}
                        mode="watch"
                        onSendCimRequest={handleSendCimRequest}
                        requestingCim={requestingCimDealKey === deal.dealKey}
                      />
                    ))}
                    {dealHunterReview.watchlist?.length === 0 ? <p className="text-sm leading-7 text-ink/68">No watchlist listings found.</p> : null}
                  </div>
                </div>

                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <SectionLabel>Remove</SectionLabel>
                    <Pill tone="danger">{dealHunterReview.removalCandidates?.length || 0}</Pill>
                  </div>
                  <div className="space-y-4">
                    {(dealHunterReview.removalCandidates || []).slice(0, 4).map((deal) => (
                      <DealHunterCard deal={deal} key={`remove-${deal.sourceName}-${deal.id || deal.listingUrl}`} mode="remove" />
                    ))}
                    {dealHunterReview.removalCandidates?.length === 0 ? <p className="text-sm leading-7 text-ink/68">No removal candidates found.</p> : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-6 rounded-[24px] border border-line/80 bg-fog/70 px-5 py-4 text-sm leading-7 text-ink/70">
              No source review loaded yet.
            </p>
          )}
        </Reveal>
      </section>

      {notifications.length > 0 ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-7 sm:p-8">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <SectionLabel>Follow-Up Notifications</SectionLabel>
                <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Who needs a follow-up next</h2>
                <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                  These prompts are generated from status, lead type, reminder dates, and document activity so you can keep seller and broker conversations moving without guessing.
                </p>
              </div>
              <Pill tone={summary.overdue > 0 ? 'danger' : 'warning'}>{summary.actionItems} active prompts</Pill>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {notifications.slice(0, 6).map((submission) => (
                <div
                  className={`rounded-[24px] border p-5 ${notificationToneClasses(submission.follow_up_prompt?.severity)}`}
                  key={`notification-${submission.id}`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-lg font-semibold">{submission.company || submission.name}</p>
                    <Pill tone={submission.follow_up_prompt?.severity === 'danger' ? 'danger' : submission.follow_up_prompt?.severity === 'warning' ? 'warning' : 'info'}>
                      {submission.follow_up_prompt?.kind || 'prompt'}
                    </Pill>
                  </div>
                  <p className="mt-3 text-sm font-semibold uppercase tracking-[0.14em]">
                    {submission.follow_up_prompt?.title}
                  </p>
                  <p className="mt-3 text-sm leading-7">{submission.follow_up_prompt?.message}</p>
                  <p className="mt-3 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-7">
                    {submission.follow_up_prompt?.prompt}
                  </p>
                  <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em]">
                    Next action: {formatDateTime(submission.next_action_at)}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </section>
      ) : null}

      {emailTriage.length > 0 ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-7 sm:p-8">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <SectionLabel>Email Follow-Up Triage</SectionLabel>
                <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Leads showing email engagement</h2>
                <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                  These records have opens, clicks, replies, or delivery issues that should change the follow-up plan.
                </p>
              </div>
              <Pill tone={summary.hotLeads > 0 ? 'success' : 'warning'}>{summary.hotLeads} hot lead(s)</Pill>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {emailTriage.slice(0, 6).map((submission) => {
                const engagement = submission.email_engagement;

                return (
                  <div
                    className={`rounded-[24px] border p-5 ${notificationToneClasses(engagement?.tone === 'danger' ? 'danger' : engagement?.tone === 'warning' ? 'warning' : 'info')}`}
                    key={`email-triage-${submission.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-lg font-semibold">{submission.company || submission.name}</p>
                      <Pill tone={emailEngagementTone(engagement)}>Score {engagement?.score || 0}</Pill>
                      {engagement?.latest_event_type ? <Pill tone={emailEngagementTone(engagement)}>{engagement.latest_event_type}</Pill> : null}
                    </div>
                    <p className="mt-3 text-sm leading-7">{formatEmailEngagement(engagement)}</p>
                    {engagement?.action ? (
                      <p className="mt-3 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-7">{engagement.action}</p>
                    ) : null}
                    <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em]">
                      Next action: {formatDateTime(submission.next_action_at)}
                    </p>
                  </div>
                );
              })}
            </div>
          </Reveal>
        </section>
      ) : null}

      {createOpen ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-6 sm:p-8">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <SectionLabel>New CRM Record</SectionLabel>
                <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Add a broker or seller opportunity manually</h2>
                <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                  Use this for broker listings, direct outreach, referrals, or any deal you want in the pipeline before it comes through the website form.
                </p>
              </div>
            </div>

            <form className="mt-8 space-y-8" onSubmit={handleCreateSubmission}>
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <InputField
                  label="Company / Business"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, company: event.target.value }))}
                  value={createDraft.company}
                />
                <SelectField
                  label="Status"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, status: event.target.value }))}
                  options={statuses}
                  value={createDraft.status}
                />
                <SelectField
                  label="Lead type"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, lead_type: event.target.value }))}
                  options={leadTypes}
                  value={createDraft.lead_type}
                />
                <InputField
                  label="Assigned to"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, assigned_to: event.target.value }))}
                  value={createDraft.assigned_to}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <InputField
                  label="Listing URL"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, listing_url: event.target.value }))}
                  value={createDraft.listing_url}
                />
                <InputField
                  label="Website"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, business_website: event.target.value }))}
                  value={createDraft.business_website}
                />
                <InputField
                  label="Prospectus / CIM"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, prospectus_url: event.target.value }))}
                  value={createDraft.prospectus_url}
                />
                <InputField
                  label="Asking price"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, asking_price: event.target.value }))}
                  value={createDraft.asking_price}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-5">
                <InputField
                  label="TTM Revenue"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, ttm_revenue: event.target.value }))}
                  value={createDraft.ttm_revenue}
                />
                <InputField
                  label="TTM EBITDA"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, ttm_ebitda: event.target.value }))}
                  value={createDraft.ttm_ebitda}
                />
                <InputField
                  label="EBITDA Multiple"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, ebitda_multiple: event.target.value }))}
                  value={createDraft.ebitda_multiple}
                />
                <InputField
                  label="Net Margin"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, net_margin: event.target.value }))}
                  value={createDraft.net_margin}
                />
                <InputField
                  label="Age"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, business_age: event.target.value }))}
                  value={createDraft.business_age}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <SelectField
                  label="Priority"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, priority: event.target.value }))}
                  options={priorities}
                  value={createDraft.priority}
                />
                <SelectField
                  label="Follow-up state"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, follow_up_state: event.target.value }))}
                  options={followUpStates}
                  value={createDraft.follow_up_state}
                />
                <Field label="Next action">
                  <input
                    className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
                    onChange={(event) => setCreateDraft((current) => ({ ...current, next_action_at: event.target.value }))}
                    type="datetime-local"
                    value={createDraft.next_action_at}
                  />
                </Field>
                <SelectField
                  label="SBA Eligible?"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, sba_eligible: event.target.value }))}
                  options={sbaOptions}
                  value={createDraft.sba_eligible}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                <InputField
                  label="Broker name"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, broker_name: event.target.value }))}
                  value={createDraft.broker_name}
                />
                <InputField
                  label="Broker email"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, broker_email: event.target.value }))}
                  type="email"
                  value={createDraft.broker_email}
                />
                <InputField
                  label="Broker phone"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, broker_phone: event.target.value }))}
                  value={createDraft.broker_phone}
                />
              </div>

              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                <InputField
                  label="Seller name"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, seller_name: event.target.value }))}
                  value={createDraft.seller_name}
                />
                <InputField
                  label="Seller email"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, seller_email: event.target.value }))}
                  type="email"
                  value={createDraft.seller_email}
                />
                <InputField
                  label="Seller phone"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, seller_phone: event.target.value }))}
                  value={createDraft.seller_phone}
                />
              </div>

              <div className="grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
                <InputField
                  label="Tags"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, tags: event.target.value }))}
                  placeholder="manual, broker, inbound"
                  value={createDraft.tags}
                />
                <TextAreaField
                  label="Deal notes"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Internal notes, context, next steps, or anything from the broker or seller."
                  value={createDraft.notes}
                />
              </div>

              {createError ? (
                <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{createError}</p>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  className={primaryActionButtonClass}
                  disabled={createPending}
                  type="submit"
                >
                  <Plus className="h-4 w-4" />
                  {createPending ? 'Creating Record...' : 'Create CRM Record'}
                </button>
              </div>
            </form>
          </Reveal>
        </section>
      ) : null}

      <section className="section-shell mt-8">
        <Reveal className="panel p-6 sm:p-7">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
            <input
              className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
              onChange={(event) => {
                const value = event.target.value;
                startTransition(() => {
                  setFilters((current) => ({ ...current, search: value }));
                });
              }}
              placeholder="Search by company, seller, broker, notes, listing URL, website, or email"
              type="search"
              value={filters.search}
            />

            <select
              className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
              onChange={(event) => {
                const value = event.target.value;
                startTransition(() => {
                  setFilters((current) => ({ ...current, status: value }));
                });
              }}
              value={filters.status}
            >
              <option value="all">All statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {formatLabel(status)}
                </option>
              ))}
            </select>
          </div>
        </Reveal>
      </section>

      {actionError ? (
        <section className="section-shell mt-6">
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{actionError}</div>
        </section>
      ) : null}

      <section className="section-shell mt-8 pb-8">
        <div className="space-y-6">
          {submissions.map((submission, index) => {
            const draft = drafts[submission.id] || buildDraft(submission);
            const latestUploadRequest = submission.latest_upload_request;
            const documents = submission.secure_documents || [];
            const isSaving = savingSubmissionId === submission.id;
            const isCreatingUpload = creatingUploadForId === submission.id;
            const followUpPrompt = submission.follow_up_prompt;

            return (
              <Reveal className="panel p-5 sm:p-8" delay={index * 50} key={submission.id}>
                <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                  <div className="max-w-4xl">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="text-xl font-semibold text-ink sm:text-2xl">{submission.company || submission.name}</h2>
                      <Pill tone={submission.status === 'spam' ? 'danger' : submission.status === 'contacted' ? 'success' : 'status'}>
                        {submission.status}
                      </Pill>
                      <Pill tone={submission.priority === 'urgent' || submission.priority === 'high' ? 'warning' : 'default'}>
                        {submission.priority}
                      </Pill>
                      <Pill>{submission.lead_type}</Pill>
                      {followUpPrompt ? (
                        <Pill tone={followUpPrompt.severity === 'danger' ? 'danger' : followUpPrompt.severity === 'warning' ? 'warning' : 'info'}>
                          {followUpPrompt.kind}
                        </Pill>
                      ) : null}
                      {submission.email_engagement?.actionable ? (
                        <Pill tone={emailEngagementTone(submission.email_engagement)}>
                          Email score {submission.email_engagement.score}
                        </Pill>
                      ) : null}
                      {submission.email_engagement?.bounced ||
                      submission.email_engagement?.complained ||
                      submission.email_engagement?.failed ||
                      submission.email_engagement?.unsubscribed ? (
                        <Pill tone="danger">Email issue</Pill>
                      ) : null}
                    </div>

                    <div className="mt-4 grid gap-3 text-sm leading-7 text-ink/74 sm:grid-cols-2 xl:grid-cols-4">
                      <p><strong>Date added:</strong> {formatDateTime(submission.created_at)}</p>
                      <p><strong>Last status edit:</strong> {formatDateTime(submission.status_updated_at || submission.updated_at)}</p>
                      <p><strong>Days ago:</strong> {submission.days_since_added ?? '0'}</p>
                      <p><strong>Next action:</strong> {formatDateTime(submission.next_action_at)}</p>
                    </div>

                    <LinksRow submission={submission} />

                    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      <div className="rounded-[22px] border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">Asking Price</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.asking_price || 'Not set'}</p>
                      </div>
                      <div className="rounded-[22px] border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">TTM Revenue</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.ttm_revenue || 'Not set'}</p>
                      </div>
                      <div className="rounded-[22px] border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">TTM EBITDA</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.ttm_ebitda || 'Not set'}</p>
                      </div>
                      <div className="rounded-[22px] border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">EBITDA Multiple</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.ebitda_multiple || 'Not set'}</p>
                      </div>
                      <div className="rounded-[22px] border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">SBA Eligible?</p>
                        <p className="mt-3 text-base font-semibold text-ink">{formatLabel(submission.sba_eligible || 'unknown')}</p>
                      </div>
                    </div>

                    {followUpPrompt ? (
                      <div className={`mt-6 rounded-[24px] border p-5 ${notificationToneClasses(followUpPrompt.severity)}`}>
                        <p className="text-sm font-semibold uppercase tracking-[0.18em]">Follow-up prompt</p>
                        <h3 className="mt-3 text-xl font-semibold">{followUpPrompt.title}</h3>
                        <p className="mt-3 text-sm leading-7">{followUpPrompt.message}</p>
                        <p className="mt-4 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-7">{followUpPrompt.prompt}</p>
                      </div>
                    ) : null}

                    {submission.message ? (
                      <div className="mt-6 rounded-[24px] border border-line/80 bg-white/70 p-5">
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Original message</p>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink/76">{submission.message}</p>
                      </div>
                    ) : null}

                  </div>

                  <div className="w-full xl:w-[320px]">
                    <div className="rounded-[24px] border border-line/80 bg-fog/70 p-5">
                      <SectionLabel>Routing</SectionLabel>
                      <div className="mt-4 space-y-2 text-sm leading-6 text-ink/72">
                        <p>Email delivery: {submission.delivery_status}</p>
                        <p>CRM: {submission.crm_status}</p>
                        <p>Assignee: {submission.assigned_to || 'Unassigned'}</p>
                        <p>Follow-up state: {formatLabel(submission.follow_up_state)}</p>
                      </div>
                    </div>

                    <div className="mt-5 rounded-[24px] border border-line/80 bg-white/70 p-5">
                      <SectionLabel>Contacts</SectionLabel>
                      <div className="mt-4 space-y-5 text-sm leading-7 text-ink/74">
                        <div>
                          <p className="font-semibold text-ink">Broker</p>
                          <p>{submission.broker_name || 'Not set'}</p>
                          <p>{submission.broker_email || 'No email'}</p>
                          <p>{submission.broker_phone || 'No phone'}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-ink">Seller</p>
                          <p>{submission.seller_name || 'Not set'}</p>
                          <p>{submission.seller_email || 'No email'}</p>
                          <p>{submission.seller_phone || 'No phone'}</p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 rounded-[24px] border border-line/80 bg-fog/70 p-5">
                      <SectionLabel>Email Engagement</SectionLabel>
                      <div className="mt-4 space-y-3 text-sm leading-7 text-ink/74">
                        <p>{formatEmailEngagement(submission.email_engagement)}</p>
                        {submission.email_engagement?.action ? (
                          <p className="rounded-2xl border border-line/80 bg-white/70 px-4 py-3">{submission.email_engagement.action}</p>
                        ) : null}
                      </div>
                    </div>

                  </div>
                </div>

                <div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-6">
                  <SelectField
                    label="Status"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, status: event.target.value },
                      }))
                    }
                    options={statuses}
                    value={draft.status}
                  />

                  <SelectField
                    label="Priority"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, priority: event.target.value },
                      }))
                    }
                    options={priorities}
                    value={draft.priority}
                  />

                  <SelectField
                    label="Lead type"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, lead_type: event.target.value },
                      }))
                    }
                    options={leadTypes}
                    value={draft.lead_type}
                  />

                  <InputField
                    label="Assigned to"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, assigned_to: event.target.value },
                      }))
                    }
                    value={draft.assigned_to}
                  />

                  <SelectField
                    label="Follow-up state"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, follow_up_state: event.target.value },
                      }))
                    }
                    options={followUpStates}
                    value={draft.follow_up_state}
                  />

                  <Field label="Next action">
                    <input
                      className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [submission.id]: { ...draft, next_action_at: event.target.value },
                        }))
                      }
                      type="datetime-local"
                      value={draft.next_action_at}
                    />
                  </Field>
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  <InputField
                    label="Company / Business"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, company: event.target.value },
                      }))
                    }
                    value={draft.company}
                  />
                  <InputField
                    label="Listing URL"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, listing_url: event.target.value },
                      }))
                    }
                    value={draft.listing_url}
                  />
                  <InputField
                    label="Website"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, business_website: event.target.value },
                      }))
                    }
                    value={draft.business_website}
                  />
                  <InputField
                    label="Prospectus / CIM"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, prospectus_url: event.target.value },
                      }))
                    }
                    value={draft.prospectus_url}
                  />
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-6">
                  <InputField
                    label="Asking price"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, asking_price: event.target.value },
                      }))
                    }
                    value={draft.asking_price}
                  />
                  <InputField
                    label="TTM Revenue"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, ttm_revenue: event.target.value },
                      }))
                    }
                    value={draft.ttm_revenue}
                  />
                  <InputField
                    label="TTM EBITDA"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, ttm_ebitda: event.target.value },
                      }))
                    }
                    value={draft.ttm_ebitda}
                  />
                  <InputField
                    label="EBITDA Multiple"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, ebitda_multiple: event.target.value },
                      }))
                    }
                    value={draft.ebitda_multiple}
                  />
                  <InputField
                    label="Net Margin"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, net_margin: event.target.value },
                      }))
                    }
                    value={draft.net_margin}
                  />
                  <InputField
                    label="Age"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, business_age: event.target.value },
                      }))
                    }
                    value={draft.business_age}
                  />
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  <SelectField
                    label="SBA Eligible?"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, sba_eligible: event.target.value },
                      }))
                    }
                    options={sbaOptions}
                    value={draft.sba_eligible}
                  />
                  <InputField
                    label="Tags"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, tags: event.target.value },
                      }))
                    }
                    placeholder="seller, broker, inbound"
                    value={draft.tags}
                  />
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  <InputField
                    label="Broker name"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, broker_name: event.target.value },
                      }))
                    }
                    value={draft.broker_name}
                  />
                  <InputField
                    label="Broker email"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, broker_email: event.target.value },
                      }))
                    }
                    type="email"
                    value={draft.broker_email}
                  />
                  <InputField
                    label="Broker phone"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, broker_phone: event.target.value },
                      }))
                    }
                    value={draft.broker_phone}
                  />
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                  <InputField
                    label="Seller name"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, seller_name: event.target.value },
                      }))
                    }
                    value={draft.seller_name}
                  />
                  <InputField
                    label="Seller email"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, seller_email: event.target.value },
                      }))
                    }
                    type="email"
                    value={draft.seller_email}
                  />
                  <InputField
                    label="Seller phone"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, seller_phone: event.target.value },
                      }))
                    }
                    value={draft.seller_phone}
                  />
                </div>

                <div className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
                  <TextAreaField
                    label="Deal notes"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [submission.id]: { ...draft, notes: event.target.value },
                      }))
                    }
                    value={draft.notes}
                  />

                  <div className="space-y-5">
                    <div className="rounded-[24px] border border-line/80 bg-fog/70 p-5">
                      <SectionLabel>Secure upload request</SectionLabel>
                      {latestUploadRequest ? (
                        <div className="mt-4 space-y-2 text-sm leading-7 text-ink/72">
                          <p>Status: {latestUploadRequest.status}</p>
                          <p>Expires: {formatDateTime(latestUploadRequest.expires_at)}</p>
                          <p>NDA accepted: {latestUploadRequest.nda_accepted_at ? 'Yes' : 'Pending'}</p>
                          <p>Last upload: {latestUploadRequest.last_uploaded_at ? formatDateTime(latestUploadRequest.last_uploaded_at) : 'No files yet'}</p>
                        </div>
                      ) : (
                        <p className="mt-4 text-sm leading-7 text-ink/68">No secure upload request has been issued yet.</p>
                      )}
                    </div>

                    <div className="rounded-[24px] border border-line/80 bg-white/70 p-5">
                      <div className="flex items-center justify-between gap-4">
                        <SectionLabel>Uploaded documents</SectionLabel>
                        <Pill>{documents.length} file(s)</Pill>
                      </div>

                      {documents.length > 0 ? (
                        <div className="mt-4 space-y-3">
                          {documents.map((document) => (
                            <div className="rounded-2xl border border-line/80 bg-fog/60 px-4 py-3 text-sm text-ink/74" key={document.id}>
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                  <p className="font-semibold text-ink">{document.original_name}</p>
                                  <p className="mt-1 text-xs uppercase tracking-[0.14em] text-moss/70">{document.document_type}</p>
                                </div>
                                <button
                                  className="inline-flex items-center gap-2 rounded-full border border-ink/10 bg-white px-3 py-2 text-xs font-semibold text-ink transition hover:border-moss/25 hover:text-moss"
                                  onClick={() => copyText(document.original_name)}
                                  type="button"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                  Copy Name
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-4 text-sm leading-7 text-ink/68">No files uploaded yet.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 sm:flex sm:flex-wrap">
                  <button
                    className={primaryActionButtonClass}
                    disabled={isSaving}
                    onClick={() => handleSave(submission.id)}
                    type="button"
                  >
                    <Save className="h-4 w-4" />
                    {isSaving ? 'Saving...' : 'Save Updates'}
                  </button>

                  <button
                    className={secondaryActionButtonClass}
                    disabled={isCreatingUpload}
                    onClick={() => handleCreateUploadRequest(submission.id)}
                    type="button"
                  >
                    <Link2 className="h-4 w-4" />
                    {isCreatingUpload ? 'Creating Link...' : 'Create Secure Upload Link'}
                  </button>

                </div>
              </Reveal>
            );
          })}

          {!loading && submissions.length === 0 ? (
            <Reveal className="panel p-7 text-sm leading-7 text-ink/70">No CRM records match the current filter.</Reveal>
          ) : null}

          {loading ? <Reveal className="panel p-7 text-sm leading-7 text-ink/70">Loading CRM records...</Reveal> : null}
        </div>
      </section>
    </>
  );
}
