import React, { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  BellRing,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Copy,
  Download,
  Gauge,
  Inbox,
  Link2,
  LogOut,
  MailCheck,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Target,
  Trash2,
  XCircle,
} from 'lucide-react';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';
import CrmNavigation from '../components/admin/CrmNavigation';
import DealActivityTimeline from '../components/admin/DealActivityTimeline';
import OperationsCenter from '../components/admin/OperationsCenter';
import DealHunterWorkspace from '../components/admin/DealHunterWorkspace';

const statuses = ['new', 'review', 'contacted', 'archived', 'spam'];
const priorities = ['low', 'normal', 'medium', 'high', 'urgent'];
const followUpStates = ['needs-response', 'scheduled', 'waiting-on-owner', 'completed'];
const leadTypes = ['prospect', 'seller', 'broker', 'referral', 'advisor', 'other'];
const sbaOptions = ['unknown', 'yes', 'no'];
const diligenceStages = [
  'not-started',
  'cim-requested',
  'nda-sent',
  'cim-received',
  'financial-review',
  'lender-review',
  'loi-candidate',
  'passed',
];
const diligenceDecisions = ['undecided', 'advance', 'pause', 'pass'];
const acquisitionPipelineStages = [
  'new-fit',
  'cim-requested',
  'broker-replied',
  'docs-received',
  'diligence',
  'loi-candidate',
  'passed',
];
const acquisitionPassReasons = [
  'fedex-route',
  'physician-owner-required',
  'too-small',
  'too-expensive',
  'customer-concentration',
  'weak-recurring-revenue',
  'poor-management-transition',
  'food-or-hospitality',
  'high-capex',
  'low-ai-recession-resistance',
  'seller-financing-gap',
  'other',
];
const diligenceChecklistItems = [
  { id: 'cim', label: 'CIM / teaser' },
  { id: 'nda', label: 'NDA' },
  { id: 'p_and_l', label: 'P&L' },
  { id: 'tax_returns', label: 'Tax returns' },
  { id: 'balance_sheet', label: 'Balance sheet' },
  { id: 'customer_concentration', label: 'Customer concentration' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'lease', label: 'Lease' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'owner_role', label: 'Owner role' },
  { id: 'management_depth', label: 'Management depth' },
  { id: 'sba_fit', label: 'SBA fit' },
];
const dailyDealUpdateUrl =
  'https://docs.google.com/spreadsheets/d/1d2mC6oKDY7DFQiaNQnF947Ro5CBwjIcAw_fwya7bpBc/edit?usp=sharing';
const adminSections = [
  { id: 'overview', label: 'Overview', href: '/admin', icon: Activity },
  { id: 'crm', label: 'CRM Records', href: '/admin/crm', icon: Inbox },
  { id: 'command-center', label: 'Command Center', href: '/admin/command-center', icon: Target },
  { id: 'deal-hunter', label: 'Deal Hunter', href: '/admin/deal-hunter', icon: ClipboardList },
  { id: 'follow-ups', label: 'Follow-Ups', href: '/admin/follow-ups', icon: BellRing },
  { id: 'operations', label: 'Operations', href: '/admin/operations', icon: Gauge },
  { id: 'new-record', label: 'New Record', href: '/admin/new-record', icon: Plus },
];
const primaryActionButtonClass =
  'inline-flex min-h-[46px] w-full min-w-0 items-center justify-center gap-2 rounded-full border border-moss bg-moss px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:opacity-50 sm:w-auto sm:px-5 sm:py-3';
const secondaryActionButtonClass =
  'inline-flex min-h-[46px] w-full min-w-0 items-center justify-center gap-2 rounded-full border border-ink/10 bg-white px-4 py-2.5 text-center text-sm font-semibold text-ink transition hover:border-moss/25 hover:text-moss disabled:opacity-50 sm:w-auto sm:px-5 sm:py-3';

const defaultCrmFilters = {
  search: '',
  status: 'all',
  created: 'all',
  page: 1,
  pageSize: 25,
  sort: 'created_at',
  direction: 'desc',
};

export function crmFiltersFromSearch(search = '') {
  const params = new URLSearchParams(search);
  const pageSize = Number(params.get('pageSize'));
  const page = Number(params.get('page'));
  const sort = params.get('sort') || defaultCrmFilters.sort;
  const direction = params.get('direction') === 'asc' ? 'asc' : 'desc';

  return {
    search: params.get('search') || '',
    status: statuses.includes(params.get('status')) ? params.get('status') : 'all',
    created: params.get('created') === 'last-7-days' ? 'last-7-days' : 'all',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: [10, 25, 50, 100].includes(pageSize) ? pageSize : defaultCrmFilters.pageSize,
    sort: ['created_at', 'updated_at', 'company', 'next_action_at', 'priority', 'status', 'deal_score', 'listing_date'].includes(sort)
      ? sort
      : defaultCrmFilters.sort,
    direction,
  };
}

export function crmSearchFromFilters(filters) {
  const params = new URLSearchParams();

  if (filters.search) params.set('search', filters.search);
  if (filters.status !== defaultCrmFilters.status) params.set('status', filters.status);
  if (filters.created && filters.created !== defaultCrmFilters.created) params.set('created', filters.created);
  if (filters.page !== defaultCrmFilters.page) params.set('page', String(filters.page));
  if (filters.pageSize !== defaultCrmFilters.pageSize) params.set('pageSize', String(filters.pageSize));
  if (filters.sort !== defaultCrmFilters.sort) params.set('sort', filters.sort);
  if (filters.direction !== defaultCrmFilters.direction) params.set('direction', filters.direction);

  return params.toString();
}

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

function formatPipelineStage(value) {
  const labels = {
    'new-fit': 'New fit',
    'cim-requested': 'CIM requested',
    'broker-replied': 'Broker replied',
    'docs-received': 'Docs received',
    diligence: 'Diligence',
    'loi-candidate': 'LOI candidate',
    passed: 'Passed',
  };

  return labels[value] || formatLabel(value || 'new-fit');
}

function formatPassReason(value) {
  const labels = {
    'fedex-route': 'FedEx route',
    'physician-owner-required': 'Physician-owner required',
    'too-small': 'Too small',
    'too-expensive': 'Too expensive',
    'customer-concentration': 'Customer concentration',
    'weak-recurring-revenue': 'Weak recurring revenue',
    'poor-management-transition': 'Poor management transition',
    'food-or-hospitality': 'Food or hospitality',
    'high-capex': 'High capex',
    'low-ai-recession-resistance': 'Low AI/recession resistance',
    'seller-financing-gap': 'Seller financing gap',
    other: 'Other',
  };

  return labels[value] || formatLabel(value || '');
}

function formatDateTime(value) {
  if (!value) {
    return 'Not set';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not set' : date.toLocaleString();
}

function submissionDealScore(submission = {}) {
  const rawScore = submission.metadata?.dealHunter?.score;

  if (rawScore === null || rawScore === undefined || rawScore === '') {
    return null;
  }

  const score = Number(rawScore);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function submissionListingDate(submission = {}) {
  return submission.metadata?.dealHunter?.dateAdded || submission.metadata?.dealHunter?.firstSeenAt || '';
}

function pluralize(count, label) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
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

function safeExternalHref(value) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return '';
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:/i.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
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

function commandCenterTone(value) {
  if (value === 'danger') {
    return 'danger';
  }

  if (value === 'warning') {
    return 'warning';
  }

  if (value === 'success') {
    return 'success';
  }

  if (value === 'info') {
    return 'info';
  }

  return 'default';
}

function diligenceReadinessTone(score = 0) {
  if (score >= 80) {
    return 'success';
  }

  if (score >= 50) {
    return 'warning';
  }

  return 'danger';
}

function defaultDiligence() {
  return {
    stage: 'not-started',
    decision: 'undecided',
    checklist: diligenceChecklistItems.reduce((accumulator, item) => {
      accumulator[item.id] = false;
      return accumulator;
    }, {}),
    financing: {
      estimated_down_payment: '',
      seller_note: '',
      investor_gap: '',
      sba_lender_status: '',
    },
    questions: '',
    memo: '',
    updated_at: '',
  };
}

function normalizeDiligence(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = defaultDiligence();
  const checklist = source.checklist && typeof source.checklist === 'object' && !Array.isArray(source.checklist) ? source.checklist : {};
  const financing = source.financing && typeof source.financing === 'object' && !Array.isArray(source.financing) ? source.financing : {};
  const stage = diligenceStages.includes(source.stage) ? source.stage : defaults.stage;
  const decision = diligenceDecisions.includes(source.decision) ? source.decision : defaults.decision;

  return {
    ...defaults,
    stage,
    decision,
    checklist: diligenceChecklistItems.reduce((accumulator, item) => {
      accumulator[item.id] = Boolean(checklist[item.id]);
      return accumulator;
    }, {}),
    financing: {
      estimated_down_payment: financing.estimated_down_payment || '',
      seller_note: financing.seller_note || '',
      investor_gap: financing.investor_gap || '',
      sba_lender_status: financing.sba_lender_status || '',
    },
    questions: source.questions || '',
    memo: source.memo || '',
    updated_at: source.updated_at || '',
  };
}

function diligenceChecklistProgress(diligence) {
  const normalized = normalizeDiligence(diligence);
  const complete = diligenceChecklistItems.filter((item) => normalized.checklist[item.id]).length;

  return {
    complete,
    total: diligenceChecklistItems.length,
  };
}

function comparableDiligence(value) {
  const normalized = normalizeDiligence(value);
  const { updated_at: _updatedAt, ...comparable } = normalized;
  return comparable;
}

function diligenceHasContent(value) {
  const diligence = normalizeDiligence(value);

  return (
    diligence.stage !== 'not-started' ||
    diligence.decision !== 'undecided' ||
    diligenceChecklistItems.some((item) => diligence.checklist[item.id]) ||
    Object.values(diligence.financing).some(Boolean) ||
    Boolean(diligence.questions.trim()) ||
    Boolean(diligence.memo.trim())
  );
}

function shouldSubmitDiligence(draftDiligence, existingDiligence) {
  const hasExisting = Boolean(existingDiligence && typeof existingDiligence === 'object' && !Array.isArray(existingDiligence));

  if (!hasExisting && !diligenceHasContent(draftDiligence)) {
    return false;
  }

  return JSON.stringify(comparableDiligence(draftDiligence)) !== JSON.stringify(comparableDiligence(existingDiligence));
}

export function buildSubmissionPayload(draft, existingSubmission = null) {
  const payload = {
    ...draft,
    expected_updated_at: draft?._expected_updated_at || existingSubmission?.updated_at || '',
    next_action_at: fromDateTimeLocal(draft.next_action_at),
    tags: draft.tags,
  };
  delete payload._expected_updated_at;

  if (!shouldSubmitDiligence(draft.diligence, existingSubmission?.metadata?.diligence)) {
    delete payload.diligence;
  }

  return payload;
}

export function buildDraft(submission) {
  return {
    _expected_updated_at: submission.updated_at || '',
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
    diligence: normalizeDiligence(submission.metadata?.diligence),
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
    diligence: defaultDiligence(),
  };
}

function StatCard({ icon: Icon, label, onClick, value, tone = 'default', to = '' }) {
  const tones = {
    default: 'bg-moss/8 text-moss',
    success: 'bg-moss/10 text-moss',
    warning: 'bg-amber-100 text-amber-700',
    danger: 'bg-red-100 text-red-700',
    info: 'bg-sky-100 text-sky-700',
  };

  const content = (
    <div className="admin-stat-card-inner">
      <div className="admin-stat-card-topline">
        <div className={`admin-stat-icon ${tones[tone]}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <p className="admin-stat-value">{value}</p>
      </div>
      <p className="admin-stat-label">{label}</p>
    </div>
  );

  if (to) {
    return (
      <NavLink
        aria-label={`View ${label}: ${value}`}
        className="admin-stat-card panel block p-4 transition duration-200 hover:-translate-y-0.5 hover:border-moss/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss focus-visible:ring-offset-2"
        onClick={onClick}
        to={to}
      >
        {content}
      </NavLink>
    );
  }

  return (
    <div className="admin-stat-card panel p-4">
      {content}
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

  return <span className={`inline-flex max-w-full min-w-0 whitespace-normal break-words rounded-full border px-3 py-1 text-center text-xs font-semibold uppercase leading-5 tracking-[0.1em] sm:tracking-[0.14em] ${tones[tone]}`}>{children}</span>;
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
  return <p className="text-xs font-semibold uppercase leading-5 tracking-[0.14em] text-moss sm:text-sm sm:tracking-[0.18em]">{children}</p>;
}

function getCimReadyDealsFromReview(review, limit = 25) {
  const seen = new Set();
  const readyDeals = [];
  const sections = [
    ...(review?.qualified || []),
    ...(review?.newlySeenMatches || []),
    ...(review?.watchlist || []),
  ];

  for (const deal of sections) {
    const recipientEmail = deal?.cimRequest?.recipientEmail || deal?.brokerEmail || '';
    const key = `${deal?.dealKey || ''}|${recipientEmail.toLowerCase()}`;

    if (!deal?.dealKey || !deal?.cimRequest?.canRequest || !recipientEmail || seen.has(key)) {
      continue;
    }

    seen.add(key);
    readyDeals.push({ ...deal, confirmedRecipientEmail: recipientEmail });

    if (readyDeals.length >= limit) {
      break;
    }
  }

  return readyDeals;
}

function getCimSnapshotToken(deal = {}) {
  return deal.cimRequest?.snapshotToken || '';
}

function AdminSectionNav({ activeSection, isReadOnly }) {
  const visibleSections = adminSections.filter((section) => !isReadOnly || !['new-record', 'operations'].includes(section.id));

  return (
    <aside className="admin-section-nav">
      <nav className="admin-section-nav-card">
        <div className="hidden px-2 pb-2 pt-1 md:block">
          <p className="text-[11px] font-semibold uppercase tracking-normal text-moss/75">Admin</p>
        </div>
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1 md:max-h-[calc(100vh-8rem)] md:flex-col md:overflow-y-auto md:pb-0">
          {visibleSections.map((section) => {
            const Icon = section.icon;
            const isActive = section.id === activeSection;

            return (
              <NavLink
                className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold transition md:w-full md:justify-start md:rounded-xl ${
                  isActive
                    ? 'bg-moss text-white shadow-sm'
                    : 'border border-transparent text-ink/72 hover:border-moss/20 hover:bg-moss/8 hover:text-moss'
                }`}
                end={section.id === 'overview'}
                key={section.id}
                to={section.href}
              >
                <Icon className="h-4 w-4" />
                {section.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-2 text-sm font-medium text-ink">
      {label}
      {children}
    </label>
  );
}

function InputField({ label, value, onChange, placeholder = '', type = 'text' }) {
  return (
    <Field label={label}>
      <input
        className="form-control"
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
        className="form-control"
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
        className="form-control min-h-[132px] py-4"
        onChange={onChange}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}

function LinksRow({ submission }) {
  const listingHref = safeExternalHref(submission.listing_url);
  const websiteHref = safeExternalHref(submission.business_website);
  const prospectusHref = safeExternalHref(submission.prospectus_url);
  const links = [
    listingHref ? { href: listingHref, label: 'Listing URL' } : null,
    websiteHref ? { href: websiteHref, label: 'Website' } : null,
    prospectusHref ? { href: prospectusHref, label: 'Prospectus / CIM' } : null,
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

function CommandCenterActionItem({ action }) {
  const record = action.record;

  return (
    <div className={`min-w-0 rounded-2xl border p-4 ${notificationToneClasses(action.priority)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={commandCenterTone(action.priority)}>{formatLabel(action.type)}</Pill>
        {record?.score ? <Pill tone={dealScoreTone(record.score)}>Score {record.score}</Pill> : null}
      </div>
      <p className="mt-3 text-sm font-semibold uppercase tracking-[0.14em]">{action.title}</p>
      <p className="mt-2 text-sm leading-6">{action.message}</p>
      {record ? (
        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em]">
          {record.company} | {formatPipelineStage(record.pipelineStage)}
        </p>
      ) : null}
    </div>
  );
}

function CommandCenterRecordCard({ record, updating, onUpdate, readOnly = false }) {
  const missingReadiness = record.readiness?.missing || [];
  const contactEmail = record.brokerEmail || record.sellerEmail || '';
  const isPassed = record.pipelineStage === 'passed';
  const feedbackTone = record.fitFeedback === 'good-fit' ? 'success' : record.fitFeedback === 'false-positive' ? 'danger' : 'default';
  const listingHref = safeExternalHref(record.listingUrl);
  const prospectusHref = safeExternalHref(record.prospectusUrl);

  return (
    <div className="min-w-0 rounded-2xl border border-line/80 bg-white/80 p-4 text-sm leading-6 text-ink/74 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={dealScoreTone(record.score)}>Score {record.score}</Pill>
        <Pill tone={commandCenterTone(record.pipelineTone)}>{formatPipelineStage(record.pipelineStage)}</Pill>
        <Pill tone={diligenceReadinessTone(record.readiness?.score || 0)}>Ready {record.readiness?.score || 0}%</Pill>
        <Pill tone={feedbackTone}>{record.fitFeedback === 'neutral' ? 'No feedback' : formatLabel(record.fitFeedback)}</Pill>
      </div>

      <h3 className="mt-3 text-lg font-semibold leading-snug text-ink">{record.company}</h3>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <p><strong>Contact:</strong> {contactEmail || 'No broker/seller email'}</p>
        <p><strong>Next action:</strong> {formatDateTime(record.nextActionAt)}</p>
        <p><strong>Ask:</strong> {record.askingPrice || 'Not disclosed'}</p>
        <p><strong>TTM EBITDA:</strong> {record.ttmEbitda || 'Not disclosed'}</p>
      </div>

      {record.recommendation ? (
        <p className="mt-4 rounded-2xl border border-line/80 bg-fog/70 px-4 py-3">{record.recommendation}</p>
      ) : null}

      {record.concerns?.length > 0 ? (
        <div className="mt-4">
          <p className="font-semibold uppercase tracking-[0.14em] text-moss">Watch items</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {record.concerns.slice(0, 3).map((concern) => (
              <li key={`${record.id}-${concern}`}>{concern}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {missingReadiness.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
          <p className="font-semibold uppercase tracking-[0.14em]">Diligence gaps</p>
          <p className="mt-2">{missingReadiness.slice(0, 3).map((item) => item.label).join(', ')}</p>
        </div>
      ) : null}

      {record.passReason ? (
        <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 font-medium text-red-700">
          Passed: {formatPassReason(record.passReason)}
        </p>
      ) : null}

      {!readOnly ? (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border border-moss/20 bg-moss/10 px-3 py-2 text-center text-xs font-semibold uppercase tracking-[0.1em] text-moss transition hover:border-moss disabled:opacity-50 sm:flex-none sm:px-4"
              disabled={updating}
              onClick={() => onUpdate(record, { fitFeedback: 'good-fit' })}
              type="button"
            >
              <CheckCircle2 className="h-4 w-4" />
              Good Fit
            </button>
            <button
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-2 text-center text-xs font-semibold uppercase tracking-[0.1em] text-red-700 transition hover:border-red-300 disabled:opacity-50 sm:flex-none sm:px-4"
              disabled={updating}
              onClick={() => onUpdate(record, { fitFeedback: 'false-positive' })}
              type="button"
            >
              <XCircle className="h-4 w-4" />
              False Positive
            </button>
            {!isPassed ? (
              <>
                <button
                  className="inline-flex min-h-10 flex-1 items-center justify-center rounded-full border border-ink/10 bg-white px-3 py-2 text-center text-xs font-semibold uppercase tracking-[0.1em] text-ink transition hover:border-moss/25 hover:text-moss disabled:opacity-50 sm:flex-none sm:px-4"
                  disabled={updating}
                  onClick={() => onUpdate(record, { pipelineStage: 'diligence' })}
                  type="button"
                >
                  Move To Diligence
                </button>
                <button
                  className="inline-flex min-h-10 flex-1 items-center justify-center rounded-full border border-ink/10 bg-white px-3 py-2 text-center text-xs font-semibold uppercase tracking-[0.1em] text-ink transition hover:border-moss/25 hover:text-moss disabled:opacity-50 sm:flex-none sm:px-4"
                  disabled={updating}
                  onClick={() => onUpdate(record, { pipelineStage: 'loi-candidate', fitFeedback: 'good-fit' })}
                  type="button"
                >
                  LOI Candidate
                </button>
              </>
            ) : null}
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss">Quick pass</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {acquisitionPassReasons.map((reason) => (
                <button
                  className="inline-flex min-h-10 flex-1 items-center justify-center rounded-full border border-red-200 bg-white px-3 py-2 text-center text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50 sm:flex-none"
                  disabled={updating}
                  key={`${record.id}-${reason}`}
                  onClick={() => onUpdate(record, { pipelineStage: 'passed', passReason: reason, fitFeedback: 'false-positive' })}
                  type="button"
                >
                  {formatPassReason(reason)}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        {listingHref ? (
          <a className="inline-flex items-center gap-2 text-sm font-semibold text-moss underline" href={listingHref} rel="noreferrer" target="_blank">
            <Link2 className="h-4 w-4" />
            Listing
          </a>
        ) : null}
        {prospectusHref ? (
          <a className="inline-flex items-center gap-2 text-sm font-semibold text-moss underline" href={prospectusHref} rel="noreferrer" target="_blank">
            <ClipboardList className="h-4 w-4" />
            Documents
          </a>
        ) : null}
      </div>
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
  const { section = 'overview', submissionId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const validSectionIds = useMemo(() => new Set(adminSections.map((item) => item.id)), []);
  const isCrmDetailView = Boolean(submissionId);
  const activeSection = isCrmDetailView ? 'crm' : validSectionIds.has(section) ? section : 'overview';
  const [authState, setAuthState] = useState({
    checked: false,
    authenticated: false,
    username: '',
    role: '',
    authMode: 'hybrid',
    magicLinkEnabled: false,
    passwordEnabled: false,
    adminEmailHint: '',
    viewerAccessEnabled: false,
  });
  const [magicLinkForm, setMagicLinkForm] = useState({ email: '' });
  const [magicLinkFeedback, setMagicLinkFeedback] = useState({ error: '', message: '', previewUrl: '' });
  const [magicLinkPending, setMagicLinkPending] = useState(false);
  const [authBootstrapError, setAuthBootstrapError] = useState('');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [filters, setFilters] = useState(() => crmFiltersFromSearch(window.location.search));
  const [dashboardData, setDashboardData] = useState({
    summary: null,
    submissions: [],
    notifications: [],
    emailTriage: [],
    total: 0,
    page: 1,
    pageSize: defaultCrmFilters.pageSize,
    totalPages: 1,
  });
  const [followUpData, setFollowUpData] = useState({ summary: null, notifications: [], emailTriage: [], total: 0 });
  const [followUpError, setFollowUpError] = useState('');
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [dealActivity, setDealActivity] = useState({ events: [], loading: false, error: '' });
  const [savingSubmissionId, setSavingSubmissionId] = useState('');
  const [creatingUploadForId, setCreatingUploadForId] = useState('');
  const [deletingSubmissionId, setDeletingSubmissionId] = useState('');
  const [createDraft, setCreateDraft] = useState(blankRecordDraft());
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState('');
  const [dealHunterReview, setDealHunterReview] = useState(null);
  const [dealHunterLoading, setDealHunterLoading] = useState(false);
  const [dealHunterSending, setDealHunterSending] = useState(false);
  const [dealHunterBulkCimSending, setDealHunterBulkCimSending] = useState(false);
  const [dealHunterFollowUpRunning, setDealHunterFollowUpRunning] = useState(false);
  const [emailTestSending, setEmailTestSending] = useState(false);
  const [requestingCimDealKey, setRequestingCimDealKey] = useState('');
  const [dealHunterFeedback, setDealHunterFeedback] = useState({ error: '', message: '' });
  const [commandCenter, setCommandCenter] = useState(null);
  const [commandCenterLoading, setCommandCenterLoading] = useState(false);
  const [commandCenterUpdatingId, setCommandCenterUpdatingId] = useState('');
  const [commandCenterFeedback, setCommandCenterFeedback] = useState({ error: '', message: '' });
  const [operations, setOperations] = useState(null);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState('');
  const dashboardRequestRef = useRef({ controller: null, id: 0 });
  const followUpRequestRef = useRef({ controller: null, id: 0 });
  const deferredSearch = useDeferredValue(filters.search);
  const isReadOnly = authState.role === 'viewer';
  const requestedFollowUpView = new URLSearchParams(location.search).get('view');
  const followUpView = ['action-items', 'overdue', 'due-soon', 'warm-leads'].includes(requestedFollowUpView)
    ? requestedFollowUpView
    : 'all';
  const crmListSearch = crmSearchFromFilters(filters);
  const crmListHref = `/admin/crm${crmListSearch ? `?${crmListSearch}` : ''}`;

  async function checkSession() {
    setAuthBootstrapError('');

    try {
      const response = await fetch('/api/admin/session', { credentials: 'same-origin' });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Unable to check the admin session.');
      }

      setAuthState({
        checked: true,
        authenticated: Boolean(result.authenticated),
        username: result.username || '',
        role: result.role || '',
        authMode: result.authMode || 'hybrid',
        magicLinkEnabled: Boolean(result.magicLinkEnabled),
        passwordEnabled: Boolean(result.passwordEnabled),
        adminEmailHint: result.adminEmailHint || '',
        viewerAccessEnabled: Boolean(result.viewerAccessEnabled),
      });
      return true;
    } catch (error) {
      setAuthState((current) => ({
        ...current,
        checked: true,
        authenticated: false,
        username: '',
        role: '',
      }));
      setAuthBootstrapError(error.message || 'Unable to reach the admin service. Check your connection and try again.');
      return false;
    }
  }

  async function verifyMagicLink(token) {
    try {
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
        throw new Error(result.error || 'That sign-in link is invalid or has expired.');
      }
    } catch (error) {
      setMagicLinkFeedback({
        error: error.message || 'That sign-in link is invalid or has expired.',
        message: '',
        previewUrl: '',
      });
    }

    await checkSession();
  }

  async function loadDashboard(status, search, options = {}) {
    const requestId = dashboardRequestRef.current.id + 1;
    const controller = new AbortController();

    dashboardRequestRef.current.controller?.abort();
    dashboardRequestRef.current = { controller, id: requestId };
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

      if (filters.created !== 'all') {
        query.set('created', filters.created);
      }

      query.set('page', String(filters.page));
      query.set('pageSize', String(filters.pageSize));
      query.set('sort', filters.sort);
      query.set('direction', filters.direction);

      const response = await fetch(`/api/admin/submissions?${query.toString()}`, {
        credentials: 'same-origin',
        signal: controller.signal,
      });

      if (dashboardRequestRef.current.id !== requestId) {
        return;
      }

      if (response.status === 401) {
        setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '', role: '' }));
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
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      });
      if (result.page !== filters.page) {
        setFilters((current) => ({ ...current, page: result.page }));
      }
      setDrafts(
        result.submissions.reduce((accumulator, submission) => {
          accumulator[submission.id] = buildDraft(submission);
          return accumulator;
        }, {}),
      );
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }

      if (options.throwOnError) {
        throw error;
      }

      setActionError(error.message || 'Unable to load submissions.');
    } finally {
      if (dashboardRequestRef.current.id === requestId) {
        setLoading(false);
      }
    }
  }

  async function loadSubmissionDetail(id, options = {}) {
    const requestId = dashboardRequestRef.current.id + 1;
    const controller = new AbortController();

    dashboardRequestRef.current.controller?.abort();
    dashboardRequestRef.current = { controller, id: requestId };
    setLoading(true);
    setDealActivity((current) => ({ ...current, loading: true, error: '' }));
    setActionError('');

    try {
      const [response, activityResponse] = await Promise.all([
        fetch(`/api/admin/submissions/${id}`, {
          credentials: 'same-origin',
          signal: controller.signal,
        }),
        fetch(`/api/admin/submissions/${id}/activity`, {
          credentials: 'same-origin',
          signal: controller.signal,
        }),
      ]);

      if (dashboardRequestRef.current.id !== requestId) {
        return;
      }

      if (response.status === 401) {
        setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '', role: '' }));
        return;
      }

      const result = await response.json();
      const activityResult = await activityResponse.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to load this CRM record.');
      }

      setDashboardData((current) => ({
        ...current,
        submissions: [result.submission],
        notifications: result.submission.follow_up_prompt ? [result.submission] : [],
        emailTriage: result.submission.email_engagement?.actionable ? [result.submission] : [],
        total: 1,
      }));
      setDrafts({
        [result.submission.id]: buildDraft(result.submission),
      });
      setDealActivity({
        events: activityResponse.ok && activityResult.success ? activityResult.events || [] : [],
        loading: false,
        error: activityResponse.ok && activityResult.success ? '' : activityResult.error || 'Unable to load deal activity.',
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }

      if (options.throwOnError) {
        throw error;
      }

      setActionError(error.message || 'Unable to load this CRM record.');
      setDealActivity((current) => ({ ...current, loading: false, error: 'Unable to load deal activity.' }));
    } finally {
      if (dashboardRequestRef.current.id === requestId) {
        setLoading(false);
      }
    }
  }

  function refreshCurrentCrmView(options = {}) {
    return isCrmDetailView
      ? loadSubmissionDetail(submissionId, options)
      : loadDashboard(filters.status, deferredSearch.trim(), options);
  }

  async function loadFollowUps(options = {}) {
    const requestId = followUpRequestRef.current.id + 1;
    const controller = new AbortController();

    followUpRequestRef.current.controller?.abort();
    followUpRequestRef.current = { controller, id: requestId };
    setFollowUpLoading(true);
    setFollowUpError('');

    try {
      const response = await fetch('/api/admin/follow-ups', {
        credentials: 'same-origin',
        signal: controller.signal,
      });

      if (followUpRequestRef.current.id !== requestId) {
        return;
      }

      if (response.status === 401) {
        setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '', role: '' }));
        return;
      }

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to load follow-ups.');
      }

      setFollowUpData({
        summary: result.summary,
        notifications: result.notifications || [],
        emailTriage: result.emailTriage || [],
        total: result.total,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }

      if (options.throwOnError) {
        throw error;
      }

      setFollowUpError(error.message || 'Unable to load follow-ups.');
    } finally {
      if (followUpRequestRef.current.id === requestId) {
        setFollowUpLoading(false);
      }
    }
  }

  async function loadCommandCenter(options = {}) {
    setCommandCenterLoading(true);
    setCommandCenterFeedback((current) => ({ ...current, error: '' }));

    try {
      const response = await fetch('/api/admin/acquisition-command-center', {
        credentials: 'same-origin',
      });

      if (response.status === 401) {
        setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '', role: '' }));
        return;
      }

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to load the acquisition command center.');
      }

      setCommandCenter(result.commandCenter);
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }

      setCommandCenterFeedback({ error: error.message || 'Unable to load the acquisition command center.', message: '' });
    } finally {
      setCommandCenterLoading(false);
    }
  }

  async function loadOperations() {
    setOperationsLoading(true);
    setOperationsError('');
    try {
      const response = await fetch('/api/admin/operations', { credentials: 'same-origin' });
      const result = await response.json();
      if (response.status === 401) {
        throw new Error(result.error || 'Administrator access is required.');
      }
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load operations status.');
      setOperations(result.operations);
    } catch (error) {
      setOperationsError(error.message || 'Unable to load operations status.');
    } finally {
      setOperationsLoading(false);
    }
  }

  async function handleSendEmailTest() {
    if (isReadOnly) {
      setDealHunterFeedback({ error: 'Read-only users cannot send email tests.', message: '' });
      return;
    }

    const readiness = dealHunterReview?.emailReadiness || operations?.email;
    const recipient = readiness?.testRecipient || '';
    if (!recipient) {
      setDealHunterFeedback({ error: 'No configured internal email-test recipient is available.', message: '' });
      setOperationsError('No configured internal email-test recipient is available.');
      return;
    }

    if (!window.confirm(`Send a controlled email delivery test to ${recipient}?`)) return;

    setEmailTestSending(true);
    setDealHunterFeedback({ error: '', message: '' });
    setOperationsError('');

    try {
      const response = await fetch('/api/admin/email/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient }),
      });
      const result = await response.json();

      if (result.readiness) {
        setOperations((current) => current ? { ...current, email: result.readiness } : current);
        setDealHunterReview((current) => current ? { ...current, emailReadiness: result.readiness } : current);
      }

      if (!response.ok || !result.success) {
        throw new Error(result.emailResult?.error || result.error || 'Unable to send the controlled email test.');
      }

      setDealHunterFeedback({
        error: '',
        message: `Test email accepted for ${recipient}. Reply to it without changing the subject to verify inbound reply tracking.`,
      });
    } catch (error) {
      const message = error.message || 'Unable to send the controlled email test.';
      setDealHunterFeedback({ error: message, message: '' });
      setOperationsError(message);
    } finally {
      setEmailTestSending(false);
    }
  }

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('admin_token');

    if (token) {
      const url = new URL(window.location.href);
      url.searchParams.delete('admin_token');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      verifyMagicLink(token);
      return;
    }

    checkSession();
  // Authentication bootstrap is intentionally performed once; subsequent session checks are explicit actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!authState.authenticated) {
      return;
    }

    if (isCrmDetailView) {
      loadSubmissionDetail(submissionId);
      return;
    }

    if (activeSection === 'overview' || activeSection === 'crm') {
      loadDashboard(filters.status, deferredSearch.trim());
      return;
    }

    dashboardRequestRef.current.controller?.abort();
    setLoading(false);
  // Loaders are intentionally recreated with the active query state; primitive query fields below are the reload boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSection,
    authState.authenticated,
    deferredSearch,
    filters.direction,
    filters.created,
    filters.page,
    filters.pageSize,
    filters.sort,
    filters.status,
    isCrmDetailView,
    submissionId,
  ]);

  useEffect(() => {
    if (isCrmDetailView || activeSection !== 'crm') {
      return;
    }

    const query = crmSearchFromFilters(filters);
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;

    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [activeSection, filters, isCrmDetailView]);

  useEffect(() => {
    if (!authState.authenticated) {
      return;
    }

    if (activeSection === 'overview' || activeSection === 'command-center') {
      loadCommandCenter();
    }

    if (activeSection === 'overview' || activeSection === 'follow-ups') {
      loadFollowUps();
    } else {
      followUpRequestRef.current.controller?.abort();
      setFollowUpLoading(false);
    }
  }, [activeSection, authState.authenticated]);

  useEffect(() => {
    if (authState.authenticated && !isReadOnly && activeSection === 'operations') loadOperations();
  }, [activeSection, authState.authenticated, isReadOnly]);

  useEffect(() => () => {
    dashboardRequestRef.current.controller?.abort();
    followUpRequestRef.current.controller?.abort();
  }, []);

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

    setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '', role: '' }));
  }

  async function handleLogoutEverywhere() {
    if (!window.confirm('Sign out every active session for this account?')) return;
    const response = await fetch('/api/admin/sessions/revoke-all', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      setActionError(result.error || 'Unable to revoke active sessions.');
      return;
    }
    setAuthState((current) => ({ ...current, checked: true, authenticated: false, username: '', role: '' }));
  }

  async function handleSave(submissionId) {
    if (isReadOnly) {
      setActionError('Read-only users can view CRM records but cannot save changes.');
      return;
    }

    setSavingSubmissionId(submissionId);
    setActionError('');

    try {
      const draft = drafts[submissionId];
      const existingSubmission = dashboardData.submissions.find((submission) => submission.id === submissionId);
      const response = await fetch(`/api/admin/submissions/${submissionId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildSubmissionPayload(draft, existingSubmission)),
      });

      const result = await response.json();

      if (response.status === 409 && result.submission) {
        setDashboardData((current) => ({
          ...current,
          submissions: current.submissions.map((submission) =>
            submission.id === submissionId ? result.submission : submission,
          ),
        }));
        throw new Error('This CRM record changed after you opened it. Your unsaved edits were kept; reload the record to discard them or review the latest values before saving again.');
      }

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
      await Promise.all([
        refreshCurrentCrmView(),
        loadCommandCenter(),
      ]);
    } catch (error) {
      setActionError(error.message || 'Unable to update submission.');
    } finally {
      setSavingSubmissionId('');
    }
  }

  async function handleDeleteSubmission(submission) {
    if (isReadOnly) {
      setActionError('Read-only users can view CRM records but cannot delete records.');
      return;
    }

    if (!submission?.id) {
      return;
    }

    const label = submission.company || submission.name || 'this CRM record';
    const confirmed = window.confirm(
      `Delete ${label}? This permanently removes the CRM record, related upload requests, documents, and email events. Use Archive instead if you want to keep it for history.`,
    );

    if (!confirmed) {
      return;
    }

    setDeletingSubmissionId(submission.id);
    setActionError('');

    try {
      const response = await fetch(`/api/admin/submissions/${submission.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to delete CRM record.');
      }

      setDashboardData((current) => ({
        ...current,
        submissions: current.submissions.filter((item) => item.id !== submission.id),
        notifications: current.notifications.filter((item) => item.id !== submission.id),
        emailTriage: current.emailTriage.filter((item) => item.id !== submission.id),
        total: Math.max(0, Number(current.total || 0) - 1),
      }));
      setDrafts((current) => {
        const next = { ...current };
        delete next[submission.id];
        return next;
      });
      const cleanupNotice = result.cleanupPending
        ? 'CRM record deleted. Secure document purge is queued and will be retried automatically; the files remain isolated in the protected trash directory until cleanup completes.'
        : '';

      if (isCrmDetailView) {
        if (cleanupNotice) {
          setActionError(cleanupNotice);
        }
        navigate('/admin/crm', { replace: true });
        return;
      }

      const refreshResults = await Promise.allSettled([
        refreshCurrentCrmView({ throwOnError: true }),
        loadCommandCenter({ throwOnError: true }),
        loadFollowUps({ throwOnError: true }),
      ]);
      const refreshFailed = refreshResults.some((result) => result.status === 'rejected');

      if (cleanupNotice) {
        setActionError(cleanupNotice);
      } else if (refreshFailed) {
        setActionError('CRM record deleted, but one admin section did not refresh. Reload the admin page if anything looks stale.');
      }
    } catch (error) {
      setActionError(error.message || 'Unable to delete CRM record.');
    } finally {
      setDeletingSubmissionId('');
    }
  }

  async function handleCommandCenterUpdate(record, payload) {
    if (isReadOnly) {
      setCommandCenterFeedback({ error: 'Read-only users can view the command center but cannot update records.', message: '' });
      return;
    }

    if (!record?.id) {
      return;
    }

    setCommandCenterUpdatingId(record.id);
    setCommandCenterFeedback({ error: '', message: '' });

    try {
      const response = await fetch(`/api/admin/acquisition-command-center/${record.id}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to update the command center record.');
      }

      setCommandCenterFeedback({ error: '', message: `${record.company} updated.` });
      await Promise.all([
        loadCommandCenter(),
        loadDashboard(filters.status, deferredSearch.trim()),
      ]);
    } catch (error) {
      setCommandCenterFeedback({ error: error.message || 'Unable to update the command center record.', message: '' });
    } finally {
      setCommandCenterUpdatingId('');
    }
  }

  async function handleCreateSubmission(event) {
    event.preventDefault();

    if (isReadOnly) {
      setCreateError('Read-only users cannot create CRM records.');
      return;
    }

    setCreatePending(true);
    setCreateError('');

    try {
      const response = await fetch('/api/admin/submissions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildSubmissionPayload(createDraft)),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.errors?.join(' ') || result.error || 'Unable to create the CRM record.');
      }

      setCreateDraft(blankRecordDraft());
      await Promise.all([
        loadDashboard(filters.status, deferredSearch.trim()),
        loadCommandCenter(),
      ]);
    } catch (error) {
      setCreateError(error.message || 'Unable to create the CRM record.');
    } finally {
      setCreatePending(false);
    }
  }

  async function handleCreateUploadRequest(submissionId) {
    if (isReadOnly) {
      setActionError('Read-only users cannot create secure upload requests.');
      return;
    }

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
          requestedDocuments: diligenceChecklistItems
            .filter((item) => !normalizeDiligence(drafts[submissionId]?.diligence).checklist[item.id])
            .map((item) => ({ category: item.id, label: item.label, required: true })),
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

  async function handleRevokeUploadRequest(requestRecord) {
    if (!window.confirm('Revoke this secure upload link immediately?')) return;
    const response = await fetch(`/api/admin/secure-upload-requests/${encodeURIComponent(requestRecord.id)}/revoke`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      setActionError(result.error || 'Unable to revoke the secure upload link.');
      return;
    }
    await refreshCurrentCrmView();
  }

  async function handleDeleteSecureDocument(document) {
    if (!window.confirm(`Permanently delete ${document.original_name} from the active secure vault?`)) return;
    const response = await fetch(`/api/admin/secure-documents/${encodeURIComponent(document.id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      setActionError(result.error || 'Unable to delete the secure document.');
      return;
    }
    await refreshCurrentCrmView();
  }

  function updateDiligenceDraft(submissionId, fallbackDraft, updater) {
    setDrafts((current) => {
      const currentDraft = current[submissionId] || fallbackDraft;
      const currentDiligence = normalizeDiligence(currentDraft.diligence);
      const nextDiligence = typeof updater === 'function' ? updater(currentDiligence) : updater;

      return {
        ...current,
        [submissionId]: {
          ...currentDraft,
          diligence: normalizeDiligence(nextDiligence),
        },
      };
    });
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

      if (result.review) {
        setDealHunterReview(result.review);
      }
      setDealHunterFeedback({ error: '', message: `Reviewed ${result.review?.totals?.reviewedDeals || 0} recent deals.` });
      await loadCommandCenter();
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to review daily deals.', message: '' });
    } finally {
      setDealHunterLoading(false);
    }
  }

  async function handleSendDealHunterEmail() {
    if (isReadOnly) {
      setDealHunterFeedback({ error: 'Read-only users cannot send daily deal emails.', message: '' });
      return;
    }

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
      setDealHunterFeedback({
        error: '',
        message: result.alreadySent ? 'The daily deal email was already sent for today.' : `Daily deal email sent.${crmMessage}`,
      });
      await Promise.all([
        loadCommandCenter(),
        loadDashboard(filters.status, deferredSearch.trim()),
      ]);
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
    if (isReadOnly) {
      setDealHunterFeedback({ error: 'Read-only users cannot send CIM requests.', message: '' });
      return;
    }

    if (!deal?.dealKey) {
      setDealHunterFeedback({ error: 'Deal key is missing for this listing.', message: '' });
      return;
    }

    const recipient = deal.cimRequest?.recipientEmail || deal.brokerEmail || '';
    const retrying = deal.cimRequest?.status === 'failed';
    const confirmed = window.confirm(
      `${retrying ? 'Retry' : 'Send'} the CIM request for ${deal.name || 'this business'}${recipient ? ` to ${recipient}` : ''}?\n\nThis sends an email to the broker immediately.`,
    );
    if (!confirmed) return;

    setRequestingCimDealKey(deal.dealKey);
    setDealHunterFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/deal-hunter/cim-request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dealKey: deal.dealKey,
          snapshotToken: getCimSnapshotToken(deal),
        }),
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
      await Promise.all([
        loadCommandCenter(),
        loadDashboard(filters.status, deferredSearch.trim()),
      ]);
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to send the CIM request.', message: '' });
    } finally {
      setRequestingCimDealKey('');
    }
  }

  async function handleSendReadyCimRequests() {
    if (isReadOnly) {
      setDealHunterFeedback({ error: 'Read-only users cannot send CIM requests.', message: '' });
      return;
    }

    if (!dealHunterReview) {
      setDealHunterFeedback({
        error: 'Review sources first, then send CIM requests from the confirmed preview list.',
        message: '',
      });
      return;
    }

    const readyDeals = getCimReadyDealsFromReview(dealHunterReview);

    if (readyDeals.length === 0) {
      setDealHunterFeedback({
        error: 'No CIM-ready 75+ deals are available in the loaded review. Confirm each deal has annual profit and a valid broker email.',
        message: '',
      });
      return;
    }

    const previewLines = readyDeals
      .slice(0, 10)
      .map((deal) => `- ${deal.name || 'Unnamed deal'} -> ${deal.confirmedRecipientEmail}`)
      .join('\n');
    const additionalCount = readyDeals.length > 10 ? `\n...and ${readyDeals.length - 10} more.` : '';
    const confirmed = window.confirm(
      `Send CIM request emails to these ${readyDeals.length} confirmed broker recipient${readyDeals.length === 1 ? '' : 's'}?\n\n${previewLines}${additionalCount}\n\nThis will email brokers directly.`,
    );

    if (!confirmed) {
      return;
    }

    setDealHunterBulkCimSending(true);
    setDealHunterFeedback({ error: '', message: '' });

    try {
      const response = await fetch('/api/admin/deal-hunter/cim-requests/send-ready', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: readyDeals.length,
          selections: readyDeals.map((deal) => ({
            dealKey: deal.dealKey,
            recipientEmail: deal.confirmedRecipientEmail,
            snapshotToken: getCimSnapshotToken(deal),
          })),
        }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        setDealHunterReview(result.review || dealHunterReview);
        throw new Error(result.error || 'Unable to send CIM requests.');
      }

      (result.results || []).forEach((item) => {
        if (item.deal) {
          replaceDealHunterDeal(item.deal);
        }
      });

      await handleLoadDealHunterReview();
      await Promise.all([
        loadCommandCenter(),
        loadDashboard(filters.status, deferredSearch.trim()),
      ]);

      const limitedMessage = result.limited ? ` Limited to ${result.limit || 25} sends this run.` : '';
      const failedMessage = result.failed ? ` ${result.failed} failed and should be reviewed.` : '';
      setDealHunterFeedback({
        error: result.failed ? failedMessage.trim() : '',
        message: `CIM request run complete: ${result.sent || 0} sent, ${result.alreadySent || 0} already sent, ${result.failed || 0} failed.${limitedMessage}`,
      });
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to send CIM requests.', message: '' });
    } finally {
      setDealHunterBulkCimSending(false);
    }
  }

  async function handleRunCimFollowUps() {
    if (isReadOnly) {
      setDealHunterFeedback({ error: 'Read-only users cannot run CIM follow-ups.', message: '' });
      return;
    }

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
      await Promise.all([
        loadCommandCenter(),
        loadDashboard(filters.status, deferredSearch.trim()),
      ]);
      setDealHunterFeedback({ error: '', message });
    } catch (error) {
      setDealHunterFeedback({ error: error.message || 'Unable to run CIM follow-ups.', message: '' });
    } finally {
      setDealHunterFollowUpRunning(false);
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
  const followUpSummary = followUpData.summary || {};
  const notifications = useMemo(() => followUpData.notifications || [], [followUpData.notifications]);
  const emailTriage = useMemo(() => followUpData.emailTriage || [], [followUpData.emailTriage]);
  const visibleNotifications = useMemo(() => {
    if (followUpView === 'warm-leads') {
      return [];
    }

    if (followUpView === 'overdue') {
      return notifications.filter((submission) => submission.follow_up_prompt?.kind === 'overdue');
    }

    if (followUpView === 'due-soon') {
      return notifications.filter((submission) => ['due', 'today'].includes(submission.follow_up_prompt?.kind));
    }

    return notifications;
  }, [followUpView, notifications]);
  const visibleEmailTriage = useMemo(
    () => (followUpView === 'all' || followUpView === 'warm-leads' ? emailTriage : []),
    [emailTriage, followUpView],
  );
  const displayedNotifications = followUpView === 'all' ? visibleNotifications.slice(0, 6) : visibleNotifications;
  const displayedEmailTriage = followUpView === 'all' ? visibleEmailTriage.slice(0, 6) : visibleEmailTriage;
  const adminSummary = {
    ...summary,
    actionItems: followUpSummary.actionItems ?? summary.actionItems,
    overdue: followUpSummary.overdue ?? summary.overdue,
    dueSoon: followUpSummary.dueSoon ?? summary.dueSoon,
    missingNextAction: followUpSummary.missingNextAction ?? summary.missingNextAction,
    emailEngaged: followUpSummary.emailEngaged ?? summary.emailEngaged,
    hotLeads: followUpSummary.hotLeads ?? summary.hotLeads,
  };
  const commandSummary = commandCenter?.summary || {
    totalRecords: 0,
    score75Plus: 0,
    activeConversations: 0,
    actionItems: 0,
    sourceIssues: 0,
    lowReadiness: 0,
  };
  const commandPipeline = commandCenter?.pipeline || acquisitionPipelineStages.map((stage) => ({ id: stage, count: 0, records: [] }));
  const commandSourceHealth = commandCenter?.sourceHealth || { healthy: true, issues: [], sources: [], totals: {} };
  const commandFeedback = commandCenter?.feedback || { goodFit: 0, falsePositive: 0, falsePositiveReasons: {}, recommendations: [] };

  if (!validSectionIds.has(section)) {
    return <Navigate replace to="/admin" />;
  }

  if (authState.authenticated && isReadOnly && ['new-record', 'operations'].includes(activeSection)) {
    return <Navigate replace to="/admin/crm" />;
  }

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
          {authBootstrapError ? (
            <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
              <span>{authBootstrapError}</span>
              <button className="font-semibold underline underline-offset-4" onClick={checkSession} type="button">
                Retry session check
              </button>
            </div>
          ) : null}
          <div className="grid gap-8 lg:grid-cols-2">
            <Reveal className="panel p-5 sm:p-9">
              <form className="space-y-5" onSubmit={handleMagicLinkRequest}>
                <div>
                  <SectionLabel>Magic-Link Sign In</SectionLabel>
                  <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Secure access without a shared password</h2>
                  <p className="mt-3 text-base leading-7 text-ink/72">
                    Use an approved admin or read-only viewer email address to request a time-limited sign-in link{authState.adminEmailHint ? ` (${authState.adminEmailHint})` : ''}.
                  </p>
                </div>

                <InputField
                  label="Email"
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

            <Reveal className="panel p-5 sm:p-9" delay={120}>
              <form className="space-y-5" onSubmit={handlePasswordLogin}>
                <div>
                  <SectionLabel>Fallback Access</SectionLabel>
                  <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Password sign-in</h2>
                  <p className="mt-3 text-base leading-7 text-ink/72">
                    Admin credentials have full access. Viewer credentials can inspect the CRM and deal data but cannot make changes.
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

      <section className="admin-page-header">
        <Reveal className="admin-page-header-card">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-normal text-moss">Private Admin</p>
              <h1 className="mt-2 text-3xl font-semibold leading-tight text-ink sm:text-4xl">Admin workspace</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68 sm:text-base">
                CRM records, Deal Hunter scoring, and follow-up work are split into focused views so daily admin work stays readable.
              </p>
            </div>

            <div className="admin-session-panel">
              <p className="text-xs font-semibold uppercase tracking-normal text-moss/75">Signed in</p>
              <p className="mt-1 text-sm font-semibold text-ink">
                {authState.username}{isReadOnly ? ' · Read-only viewer' : ''}
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-4 border-t border-line/80 pt-4 lg:flex-row lg:items-center lg:justify-between">
            {isReadOnly ? (
              <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium leading-6 text-sky-800">
                Read-only access is enabled. You can view CRM records, scoring, source health, and conversations, but write actions are disabled.
              </p>
            ) : (
              <p className="text-sm leading-6 text-ink/68">
                Use the navigation to move between focused admin workspaces.
              </p>
            )}

            <div className="admin-action-row">
              {!isReadOnly ? (
                <>
                  <NavLink
                    className={`${primaryActionButtonClass} admin-action-button`}
                    to="/admin/new-record"
                  >
                    <Plus className="h-4 w-4" />
                    New CRM Record
                  </NavLink>
                  <a
                    className={`${secondaryActionButtonClass} admin-action-button`}
                    href="/api/admin/submissions/export"
                  >
                    <Download className="h-4 w-4" />
                    Export CSV
                  </a>
                </>
              ) : null}
              <a
                className={`${secondaryActionButtonClass} admin-action-button`}
                href={dailyDealUpdateUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ClipboardList className="h-4 w-4" />
                Daily Deal Update
              </a>
              <button
                className={`${secondaryActionButtonClass} admin-action-button`}
                onClick={handleLogout}
                type="button"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
              <button
                className={`${secondaryActionButtonClass} admin-action-button`}
                onClick={handleLogoutEverywhere}
                type="button"
              >
                <ShieldAlert className="h-4 w-4" />
                Sign Out Everywhere
              </button>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="admin-workspace-shell mt-5 pb-8">
        <div className="admin-workspace-grid">
          <AdminSectionNav activeSection={activeSection} isReadOnly={isReadOnly} />

          <div className="admin-content-with-side-nav">
      {activeSection === 'overview' ? (
      <>
      <section className="section-shell mt-8">
        <div className="admin-stat-grid">
          <StatCard icon={Inbox} label="Total Records" onClick={() => setFilters({ ...defaultCrmFilters })} to="/admin/crm" value={summary.total} />
          <StatCard icon={BellRing} label="Action Items" to="/admin/follow-ups?view=action-items" value={adminSummary.actionItems} tone={adminSummary.actionItems > 0 ? 'warning' : 'default'} />
          <StatCard icon={CalendarClock} label="Overdue" to="/admin/follow-ups?view=overdue" value={adminSummary.overdue} tone={adminSummary.overdue > 0 ? 'danger' : 'default'} />
          <StatCard icon={ClipboardList} label="Due Soon" to="/admin/follow-ups?view=due-soon" value={adminSummary.dueSoon} tone={adminSummary.dueSoon > 0 ? 'warning' : 'default'} />
          <StatCard icon={MailCheck} label="Warm Leads" to="/admin/follow-ups?view=warm-leads" value={adminSummary.emailEngaged} tone={adminSummary.emailEngaged > 0 ? 'warning' : 'default'} />
          <StatCard icon={MailCheck} label="Last 7 Days" onClick={() => setFilters({ ...defaultCrmFilters, created: 'last-7-days' })} to="/admin/crm?created=last-7-days" value={summary.lastSevenDays} />
          <StatCard icon={ShieldAlert} label="Spam" onClick={() => setFilters({ ...defaultCrmFilters, status: 'spam' })} to="/admin/crm?status=spam" value={summary.spam} />
        </div>
      </section>
      <section className="section-shell mt-5">
        <Reveal className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <SectionLabel>Admin Areas</SectionLabel>
              <h2 className="mt-2 text-xl font-semibold text-ink sm:text-2xl">Choose a focused workspace</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68">
                Each admin workflow now has its own page so daily review, CRM editing, and follow-up work stay separated.
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {adminSections
              .filter((item) => item.id !== 'overview' && (!isReadOnly || !['new-record', 'operations'].includes(item.id)))
              .map((item) => {
                const Icon = item.icon;
                const descriptions = {
                  crm: 'Search, edit, diligence-check, and manage broker or seller CRM records.',
                  'command-center': 'Review the 75+ pipeline, source health, action queue, and pass decisions.',
                  'deal-hunter': 'Run source scoring, send daily deal emails, and manage CIM follow-ups.',
                  'follow-ups': 'Work the generated follow-up prompts and email engagement triage queue.',
                  operations: 'Inspect jobs, source history, audits, cleanup failures, storage, and backups.',
                  'new-record': 'Create a manual broker, seller, referral, or prospect record.',
                };

                return (
                  <NavLink
                    className="admin-workspace-link"
                    key={item.id}
                    to={item.href}
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-moss/10 text-moss">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-3 text-base font-semibold text-ink">{item.label}</h3>
                    <p className="mt-1.5 text-sm leading-6 text-ink/68">{descriptions[item.id]}</p>
                  </NavLink>
                );
              })}
          </div>
        </Reveal>
      </section>
      </>
      ) : null}

      {activeSection === 'operations' ? (
      <section className="section-shell mt-8 pb-8">
        <div className="mb-6">
          <SectionLabel>Operations Center</SectionLabel>
          <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">System health, history, and recovery readiness</h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-ink/68">Admin-only operational visibility for scheduler runs, source checks, security cleanup, audit history, disk usage, database integrity, and backups.</p>
        </div>
        <OperationsCenter
          data={operations}
          emailTestSending={emailTestSending}
          error={operationsError}
          loading={operationsLoading}
          onSendEmailTest={handleSendEmailTest}
        />
      </section>
      ) : null}

      {activeSection === 'command-center' ? (
      <section className="section-shell mt-8">
        <Reveal className="panel p-5 sm:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <SectionLabel>Acquisition Command Center</SectionLabel>
              <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">75+ deal pipeline and active broker conversations</h2>
              <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                Focused view for high-fit opportunities, CIM conversations, pass decisions, diligence readiness, and source health across the full CRM.
              </p>
            </div>

            <button
              className={secondaryActionButtonClass}
              disabled={commandCenterLoading}
              onClick={loadCommandCenter}
              type="button"
            >
              <RefreshCw className={`h-4 w-4 ${commandCenterLoading ? 'animate-spin' : ''}`} />
              {commandCenterLoading ? 'Refreshing...' : 'Refresh Command Center'}
            </button>
          </div>

          {commandCenterFeedback.error ? (
            <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{commandCenterFeedback.error}</p>
          ) : null}
          {commandCenterFeedback.message ? (
            <p className="mt-5 rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">{commandCenterFeedback.message}</p>
          ) : null}

          <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <StatCard icon={Target} label="75+ Deals" value={commandSummary.score75Plus} tone={commandSummary.score75Plus > 0 ? 'success' : 'default'} />
            <StatCard icon={MailCheck} label="Active Talks" value={commandSummary.activeConversations} tone={commandSummary.activeConversations > 0 ? 'warning' : 'default'} />
            <StatCard icon={BellRing} label="Queue" value={commandSummary.actionItems} tone={commandSummary.actionItems > 0 ? 'warning' : 'default'} />
            <StatCard icon={Activity} label="Source Issues" value={commandSummary.sourceIssues} tone={commandSummary.sourceIssues > 0 ? 'danger' : 'success'} />
            <StatCard icon={Gauge} label="Low Readiness" value={commandSummary.lowReadiness} tone={commandSummary.lowReadiness > 0 ? 'warning' : 'default'} />
            <StatCard icon={CheckCircle2} label="Good Fits" value={commandFeedback.goodFit || 0} tone="success" />
          </div>

          <div className="mt-7 grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
            <div className="rounded-2xl border border-line/80 bg-fog/70 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel>Source Health</SectionLabel>
                <Pill tone={commandSourceHealth.healthy ? 'success' : 'warning'}>
                  {commandSourceHealth.cached ? 'Cached' : commandSourceHealth.healthy ? 'Healthy' : 'Needs review'}
                </Pill>
              </div>
              <p className="mt-3 text-sm leading-6 text-ink/68">
                {commandSourceHealth.cached ? 'Last source review' : 'Last checked'}: {formatDateTime(commandSourceHealth.generatedAt)}
              </p>
              <div className="mt-4 space-y-3">
                {(commandSourceHealth.sources || []).map((source) => (
                  <div className="rounded-2xl border border-line/80 bg-white/75 px-4 py-3 text-sm leading-6 text-ink/74" key={source.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-ink">{source.name || source.id}</p>
                      <Pill tone={commandCenterTone(source.tone)}>
                        {source.fetched ? `${source.rowCount || 0} rows` : source.requiresConfiguration ? 'setup needed' : 'failed'}
                      </Pill>
                      {source.configurationKey ? <Pill tone="warning">{source.configurationKey}</Pill> : null}
                      {source.previousRowCount ? (
                        <Pill tone={source.rowDelta < 0 ? 'warning' : 'default'}>
                          {source.rowDelta >= 0 ? '+' : ''}{source.rowDelta}
                        </Pill>
                      ) : null}
                    </div>
                    {source.error ? <p className="mt-2 text-red-700">{source.error}</p> : null}
                  </div>
                ))}
                {commandSourceHealth.sources?.length === 0 ? (
                  <p className="text-sm leading-7 text-ink/68">No cached source health data loaded yet. Use Deal Hunter &gt; Review Sources to refresh source status.</p>
                ) : null}
              </div>
              {commandSourceHealth.issues?.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {commandSourceHealth.issues.map((issue) => (
                    <p className={`rounded-2xl border px-4 py-3 text-sm font-medium ${notificationToneClasses(issue.tone)}`} key={`${issue.sourceId}-${issue.message}`}>
                      {issue.title}: {issue.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-line/80 bg-white/70 p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel>Global Action Queue</SectionLabel>
                <Pill tone={commandSummary.actionItems > 0 ? 'warning' : 'success'}>{commandSummary.actionItems}</Pill>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {(commandCenter?.actionQueue || []).map((action) => (
                  <CommandCenterActionItem action={action} key={action.id} />
                ))}
                {commandCenter?.actionQueue?.length === 0 ? (
                  <p className="text-sm leading-7 text-ink/68">No command-center action items right now.</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-7 rounded-2xl border border-line/80 bg-fog/70 p-4 sm:p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <SectionLabel>Score Feedback Loop</SectionLabel>
                <p className="mt-3 text-sm leading-7 text-ink/72">
                  Good-fit and false-positive decisions feed the criteria recommendations below so the source profile can learn from actual pass/advance decisions.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Pill tone="success">{commandFeedback.goodFit || 0} good fits</Pill>
                <Pill tone={(commandFeedback.falsePositive || 0) > 0 ? 'danger' : 'default'}>{commandFeedback.falsePositive || 0} false positives</Pill>
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div className="rounded-2xl border border-line/80 bg-white/75 p-4">
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-moss">Recommended criteria changes</p>
                {commandFeedback.recommendations?.length > 0 ? (
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-7 text-ink/74">
                    {commandFeedback.recommendations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm leading-7 text-ink/68">No criteria changes recommended from your decisions yet.</p>
                )}
              </div>
              <div className="rounded-2xl border border-line/80 bg-white/75 p-4">
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-moss">False-positive reasons</p>
                {Object.entries(commandFeedback.falsePositiveReasons || {}).length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {Object.entries(commandFeedback.falsePositiveReasons || {}).map(([reason, count]) => (
                      <Pill key={reason} tone="danger">{formatPassReason(reason)}: {count}</Pill>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm leading-7 text-ink/68">No false positives marked yet.</p>
                )}
              </div>
            </div>
          </div>

          <div className="mt-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel>Pipeline Stages</SectionLabel>
              <Pill>{commandSummary.totalRecords} command records</Pill>
            </div>
            <div className="mt-4 grid gap-5 xl:grid-cols-3">
              {commandPipeline.map((stage) => (
                <div className="rounded-2xl border border-line/80 bg-white/70 p-4 sm:p-5" key={stage.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-ink">{formatPipelineStage(stage.id)}</h3>
                    <Pill tone={stage.id === 'passed' ? 'danger' : stage.count > 0 ? 'info' : 'default'}>{stage.count}</Pill>
                  </div>
                  <div className="mt-4 space-y-4">
                    {(stage.records || []).slice(0, 3).map((record) => (
                      <CommandCenterRecordCard
                        key={record.id}
                        onUpdate={handleCommandCenterUpdate}
                        readOnly={isReadOnly}
                        record={record}
                        updating={commandCenterUpdatingId === record.id}
                      />
                    ))}
                    {stage.records?.length === 0 ? (
                      <p className="rounded-2xl border border-line/80 bg-fog/70 px-4 py-3 text-sm leading-7 text-ink/68">
                        No records in this stage.
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </section>
      ) : null}

      {activeSection === 'deal-hunter' ? (
        <DealHunterWorkspace
          bulkSending={dealHunterBulkCimSending}
          feedback={dealHunterFeedback}
          followUpRunning={dealHunterFollowUpRunning}
          emailTestSending={emailTestSending}
          loading={dealHunterLoading}
          onReview={handleLoadDealHunterReview}
          onRunFollowUps={handleRunCimFollowUps}
          onSendCimRequest={handleSendCimRequest}
          onSendEmail={handleSendDealHunterEmail}
          onSendEmailTest={handleSendEmailTest}
          onSendReady={handleSendReadyCimRequests}
          readOnly={isReadOnly}
          requestingCimDealKey={requestingCimDealKey}
          review={dealHunterReview}
          sending={dealHunterSending}
        />
      ) : null}

      {activeSection === 'follow-ups' && followUpError ? (
        <section className="section-shell mt-8">
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{followUpError}</div>
        </section>
      ) : null}

      {activeSection === 'follow-ups' && followUpLoading ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-7 text-sm leading-7 text-ink/70">
            Loading follow-up prompts and email triage...
          </Reveal>
        </section>
      ) : null}

      {activeSection === 'follow-ups' && followUpView !== 'all' ? (
        <section className="section-shell mt-8">
          <Reveal className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div>
              <SectionLabel>Filtered View</SectionLabel>
              <p className="mt-2 text-lg font-semibold text-ink">
                {followUpView === 'action-items' ? 'All action items' : null}
                {followUpView === 'overdue' ? 'Overdue follow-ups' : null}
                {followUpView === 'due-soon' ? 'Due now or within 24 hours' : null}
                {followUpView === 'warm-leads' ? 'Warm leads with email activity' : null}
              </p>
            </div>
            <NavLink className={secondaryActionButtonClass} to="/admin/follow-ups">Show All Follow-Ups</NavLink>
          </Reveal>
        </section>
      ) : null}

      {activeSection === 'follow-ups' && !followUpLoading && visibleNotifications.length > 0 ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-5 sm:p-8">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <SectionLabel>Follow-Up Notifications</SectionLabel>
                <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Who needs a follow-up next</h2>
                <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                  These prompts are generated from status, lead type, reminder dates, and document activity so you can keep seller and broker conversations moving without guessing.
                </p>
              </div>
              <Pill tone={visibleNotifications.some((submission) => submission.follow_up_prompt?.kind === 'overdue') ? 'danger' : 'warning'}>{visibleNotifications.length} active prompts</Pill>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {displayedNotifications.map((submission) => (
                <div
                  className={`rounded-2xl border p-4 sm:p-5 ${notificationToneClasses(submission.follow_up_prompt?.severity)}`}
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

      {activeSection === 'follow-ups' && !followUpLoading && visibleEmailTriage.length > 0 ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-5 sm:p-8">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <SectionLabel>Email Follow-Up Triage</SectionLabel>
                <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">Leads showing email engagement</h2>
                <p className="mt-3 max-w-3xl text-base leading-7 text-ink/72">
                  These records have opens, clicks, replies, or delivery issues that should change the follow-up plan.
                </p>
              </div>
              <Pill tone={visibleEmailTriage.some((submission) => submission.email_engagement?.hot) ? 'success' : 'warning'}>{visibleEmailTriage.filter((submission) => submission.email_engagement?.hot).length} hot lead(s)</Pill>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {displayedEmailTriage.map((submission) => {
                const engagement = submission.email_engagement;

                return (
                  <div
                    className={`rounded-2xl border p-4 sm:p-5 ${notificationToneClasses(engagement?.tone === 'danger' ? 'danger' : engagement?.tone === 'warning' ? 'warning' : 'info')}`}
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

      {activeSection === 'follow-ups' && !followUpLoading && !followUpError && visibleNotifications.length === 0 && visibleEmailTriage.length === 0 ? (
        <section className="section-shell mt-8">
          <Reveal className="panel p-7 text-sm leading-7 text-ink/70">
            {followUpView === 'all'
              ? 'No follow-up prompts or email engagement triage items need attention right now.'
              : 'No records match this overview-card filter right now.'}
          </Reveal>
        </section>
      ) : null}

      {activeSection === 'new-record' && !isReadOnly ? (
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
                    className="form-control"
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

      {activeSection === 'crm' && !isCrmDetailView ? (
      <section className="section-shell mt-8">
        <Reveal className="panel p-6 sm:p-7">
          <CrmNavigation
            disabled={loading}
            filters={filters}
            onChange={(updates) => {
              startTransition(() => {
                setFilters((current) => ({ ...current, ...updates }));
              });
            }}
            total={dashboardData.total}
            totalPages={dashboardData.totalPages}
          />
        </Reveal>
      </section>
      ) : null}

      {activeSection === 'crm' && isCrmDetailView ? (
      <section className="section-shell mt-8">
        <Reveal className="panel p-5 sm:p-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <SectionLabel>Diligence Deal Room</SectionLabel>
              <h2 className="mt-2 text-2xl font-semibold text-ink">CRM record detail</h2>
            </div>
            <NavLink className={secondaryActionButtonClass} to={crmListHref}>
              Back To CRM
            </NavLink>
          </div>
        </Reveal>
      </section>
      ) : null}

      {activeSection === 'crm' && actionError ? (
        <section className="section-shell mt-6">
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{actionError}</div>
        </section>
      ) : null}

      {activeSection === 'crm' ? (
      <section className="section-shell mt-8 pb-8">
        <div className="space-y-6">
          {submissions.map((submission, index) => {
            const draft = drafts[submission.id] || buildDraft(submission);
            const latestUploadRequest = submission.latest_upload_request;
            const documents = submission.secure_documents || [];
            const requestedDocumentChecklist = (latestUploadRequest?.requested_documents || []).map((item) => ({
              ...item,
              received: documents.some((document) => document.request_id === latestUploadRequest.id && document.document_type === item.category),
            }));
            const isSaving = savingSubmissionId === submission.id;
            const isCreatingUpload = creatingUploadForId === submission.id;
            const isDeleting = deletingSubmissionId === submission.id;
            const followUpPrompt = submission.follow_up_prompt;
            const diligence = normalizeDiligence(draft.diligence);
            const diligenceProgress = diligenceChecklistProgress(diligence);
            const diligenceProgressTone = diligenceProgress.complete === diligenceProgress.total ? 'success' : diligenceProgress.complete > 0 ? 'info' : 'default';
            const dealScore = submissionDealScore(submission);
            const listingDate = submissionListingDate(submission);
            const listingDateLabel = submission.metadata?.dealHunter?.dateAdded ? 'Date listed' : listingDate ? 'First seen' : 'Date listed';

            return (
              <Reveal
                className={`panel p-5 sm:p-8 ${isCrmDetailView ? '' : 'admin-crm-record-card'}`}
                delay={isCrmDetailView ? 0 : Math.min(index * 35, 210)}
                key={submission.id}
              >
                <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="text-xl font-semibold text-ink sm:text-2xl">{submission.company || submission.name}</h2>
                      <Pill tone={submission.status === 'spam' ? 'danger' : submission.status === 'contacted' ? 'success' : 'status'}>
                        {submission.status}
                      </Pill>
                      <Pill tone={submission.priority === 'urgent' || submission.priority === 'high' ? 'warning' : 'default'}>
                        {submission.priority}
                      </Pill>
                      <Pill>{submission.lead_type}</Pill>
                      {dealScore !== null ? <Pill tone={dealScoreTone(dealScore)}>Deal score {dealScore}</Pill> : null}
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
                      {!isCrmDetailView ? (
                        <NavLink
                          className="inline-flex min-h-[38px] items-center justify-center gap-2 rounded-full border border-ink/10 bg-white px-4 py-2 text-xs font-semibold text-ink transition hover:border-moss/25 hover:text-moss"
                          to={`/admin/crm/${encodeURIComponent(submission.id)}${crmListSearch ? `?${crmListSearch}` : ''}`}
                        >
                          <Target className="h-3.5 w-3.5" />
                          Open Deal Room
                        </NavLink>
                      ) : null}
                    </div>

                    <div className="mt-4 grid gap-3 text-sm leading-7 text-ink/74 sm:grid-cols-2 xl:grid-cols-5">
                      <p><strong>Date added:</strong> {formatDateTime(submission.created_at)}</p>
                      <p><strong>{listingDateLabel}:</strong> {listingDate ? formatDateTime(listingDate) : 'Not provided'}</p>
                      <p><strong>Last status edit:</strong> {formatDateTime(submission.status_updated_at || submission.updated_at)}</p>
                      <p><strong>Days ago:</strong> {submission.days_since_added ?? '0'}</p>
                      <p><strong>Next action:</strong> {formatDateTime(submission.next_action_at)}</p>
                    </div>

                    <LinksRow submission={submission} />

                    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      <div className="rounded-2xl border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">Asking Price</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.asking_price || 'Not set'}</p>
                      </div>
                      <div className="rounded-2xl border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">TTM Revenue</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.ttm_revenue || 'Not set'}</p>
                      </div>
                      <div className="rounded-2xl border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">TTM EBITDA</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.ttm_ebitda || 'Not set'}</p>
                      </div>
                      <div className="rounded-2xl border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">EBITDA Multiple</p>
                        <p className="mt-3 text-base font-semibold text-ink">{submission.ebitda_multiple || 'Not set'}</p>
                      </div>
                      <div className="rounded-2xl border border-line/80 bg-fog/70 p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-moss/80">SBA Eligible?</p>
                        <p className="mt-3 text-base font-semibold text-ink">{formatLabel(submission.sba_eligible || 'unknown')}</p>
                      </div>
                    </div>

                    {followUpPrompt ? (
                      <div className={`mt-6 rounded-2xl border p-4 sm:p-5 ${notificationToneClasses(followUpPrompt.severity)}`}>
                        <p className="text-sm font-semibold uppercase tracking-[0.18em]">Follow-up prompt</p>
                        <h3 className="mt-3 text-xl font-semibold">{followUpPrompt.title}</h3>
                        <p className="mt-3 text-sm leading-7">{followUpPrompt.message}</p>
                        <p className="mt-4 rounded-2xl border border-current/15 bg-white/60 px-4 py-3 text-sm leading-7">{followUpPrompt.prompt}</p>
                      </div>
                    ) : null}

                    {submission.message ? (
                      <div className="mt-6 rounded-2xl border border-line/80 bg-white/70 p-4 sm:p-5">
                        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Original message</p>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink/76">{submission.message}</p>
                      </div>
                    ) : null}

                  </div>

                  <div className="w-full min-w-0 xl:w-[22rem] xl:shrink-0">
                    <div className="rounded-2xl border border-line/80 bg-fog/70 p-4 sm:p-5">
                      <SectionLabel>Routing</SectionLabel>
                      <div className="mt-4 space-y-2 text-sm leading-6 text-ink/72">
                        <p>Email delivery: {submission.delivery_status}</p>
                        <p>CRM: {submission.crm_status}</p>
                        <p>Assignee: {submission.assigned_to || 'Unassigned'}</p>
                        <p>Follow-up state: {formatLabel(submission.follow_up_state)}</p>
                      </div>
                    </div>

                    <div className="mt-5 rounded-2xl border border-line/80 bg-white/70 p-4 sm:p-5">
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

                    <div className="mt-5 rounded-2xl border border-line/80 bg-fog/70 p-4 sm:p-5">
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

                <fieldset className={isReadOnly ? 'opacity-75' : ''} disabled={isReadOnly}>
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
                      className="form-control"
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

                <div className="mt-5 rounded-2xl border border-line/80 bg-white/75 p-4 sm:p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <SectionLabel>Diligence & Decisioning</SectionLabel>
                      {diligence.updated_at ? (
                        <p className="mt-2 text-sm leading-7 text-ink/64">Updated {formatDateTime(diligence.updated_at)}</p>
                      ) : null}
                    </div>
                    <Pill tone={diligenceProgressTone}>
                      {diligenceProgress.complete}/{diligenceProgress.total} complete
                    </Pill>
                  </div>

                  <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                    <SelectField
                      label="Diligence stage"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          stage: event.target.value,
                        }))
                      }
                      options={diligenceStages}
                      value={diligence.stage}
                    />
                    <SelectField
                      label="Internal decision"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          decision: event.target.value,
                        }))
                      }
                      options={diligenceDecisions}
                      value={diligence.decision}
                    />
                    <InputField
                      label="Estimated down payment"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          financing: {
                            ...current.financing,
                            estimated_down_payment: event.target.value,
                          },
                        }))
                      }
                      placeholder="$100K-$110K available"
                      value={diligence.financing.estimated_down_payment}
                    />
                    <InputField
                      label="Seller note target"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          financing: {
                            ...current.financing,
                            seller_note: event.target.value,
                          },
                        }))
                      }
                      placeholder="10%-20% if available"
                      value={diligence.financing.seller_note}
                    />
                  </div>

                  <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                    <InputField
                      label="Investor gap"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          financing: {
                            ...current.financing,
                            investor_gap: event.target.value,
                          },
                        }))
                      }
                      placeholder="Amount or status"
                      value={diligence.financing.investor_gap}
                    />
                    <InputField
                      label="SBA lender status"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          financing: {
                            ...current.financing,
                            sba_lender_status: event.target.value,
                          },
                        }))
                      }
                      placeholder="Not reviewed, pre-screened, approved"
                      value={diligence.financing.sba_lender_status}
                    />
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {diligenceChecklistItems.map((item) => (
                      <label
                        className="flex min-h-12 items-center gap-3 rounded-2xl border border-line/80 bg-fog/60 px-4 py-3 text-sm font-medium text-ink"
                        key={item.id}
                      >
                        <input
                          checked={Boolean(diligence.checklist[item.id])}
                          className="h-4 w-4 accent-moss"
                          onChange={(event) =>
                            updateDiligenceDraft(submission.id, draft, (current) => ({
                              ...current,
                              checklist: {
                                ...current.checklist,
                                [item.id]: event.target.checked,
                              },
                            }))
                          }
                          type="checkbox"
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="mt-5 grid gap-5 lg:grid-cols-2">
                    <TextAreaField
                      label="Broker / seller questions"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          questions: event.target.value,
                        }))
                      }
                      value={diligence.questions}
                    />
                    <TextAreaField
                      label="Go / no-go memo"
                      onChange={(event) =>
                        updateDiligenceDraft(submission.id, draft, (current) => ({
                          ...current,
                          memo: event.target.value,
                        }))
                      }
                      value={diligence.memo}
                    />
                  </div>
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
                    <div className="rounded-2xl border border-line/80 bg-fog/70 p-4 sm:p-5">
                      <SectionLabel>Secure upload request</SectionLabel>
                      {latestUploadRequest ? (
                        <div className="mt-4 space-y-2 text-sm leading-7 text-ink/72">
                          <p>Status: {latestUploadRequest.status}</p>
                          <p>Expires: {formatDateTime(latestUploadRequest.expires_at)}</p>
                          <p>NDA accepted: {latestUploadRequest.nda_accepted_at ? 'Yes' : 'Pending'}</p>
                          <p>Last upload: {latestUploadRequest.last_uploaded_at ? formatDateTime(latestUploadRequest.last_uploaded_at) : 'No files yet'}</p>
                          <p>Upload batches: {latestUploadRequest.upload_batch_count || 0}</p>
                        </div>
                      ) : (
                        <p className="mt-4 text-sm leading-7 text-ink/68">No secure upload request has been issued yet.</p>
                      )}
                      {requestedDocumentChecklist.length > 0 ? (
                        <ul className="mt-4 space-y-2">
                          {requestedDocumentChecklist.map((item) => (
                            <li className="flex items-center justify-between gap-3 rounded-xl border border-line/80 bg-white/70 px-3 py-2 text-xs" key={item.category}>
                              <span>{item.label}</span><span className={item.received ? 'text-emerald-700' : 'text-amber-700'}>{item.received ? 'Received' : 'Requested'}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {!isReadOnly && latestUploadRequest && !['revoked', 'completed', 'documents-received'].includes(latestUploadRequest.status) ? (
                        <button className="mt-4 inline-flex rounded-full border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" onClick={() => handleRevokeUploadRequest(latestUploadRequest)} type="button">Revoke Link</button>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-line/80 bg-white/70 p-4 sm:p-5">
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
                                <div className="flex flex-wrap items-center gap-2">
                                  {!isReadOnly ? (
                                    <a
                                      className="inline-flex items-center gap-2 rounded-full border border-moss/20 bg-white px-3 py-2 text-xs font-semibold text-moss transition hover:border-moss hover:bg-moss hover:text-white"
                                      href={`/api/admin/secure-documents/${encodeURIComponent(document.id)}/download`}
                                    >
                                      <Download className="h-3.5 w-3.5" />
                                      Download
                                    </a>
                                  ) : null}
                                  {!isReadOnly ? (
                                    <button
                                      className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100"
                                      onClick={() => handleDeleteSecureDocument(document)}
                                      type="button"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                      Delete
                                    </button>
                                  ) : null}
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
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-4 text-sm leading-7 text-ink/68">No files uploaded yet.</p>
                      )}
                      </div>
                    </div>
                  </div>
                </fieldset>

                {isCrmDetailView ? (
                  <DealActivityTimeline
                    error={dealActivity.error}
                    events={dealActivity.events}
                    loading={dealActivity.loading}
                  />
                ) : null}

                {!isReadOnly ? (
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

                    <button
                      className="inline-flex min-h-[46px] w-full min-w-0 items-center justify-center gap-2 rounded-full border border-red-200 bg-red-50 px-4 py-2.5 text-center text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:opacity-50 sm:w-auto sm:px-5 sm:py-3"
                      disabled={isDeleting}
                      onClick={() => handleDeleteSubmission(submission)}
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                      {isDeleting ? 'Deleting...' : 'Delete Record'}
                    </button>
                  </div>
                ) : null}
              </Reveal>
            );
          })}

          {!loading && submissions.length === 0 ? (
            <Reveal className="panel p-7 text-sm leading-7 text-ink/70">No CRM records match the current filter.</Reveal>
          ) : null}

          {loading ? <Reveal className="panel p-7 text-sm leading-7 text-ink/70">Loading CRM records...</Reveal> : null}

          {!isCrmDetailView && dashboardData.total > 0 ? (
            <Reveal className="panel p-4 sm:p-5">
              <CrmNavigation
                disabled={loading}
                filters={filters}
                onChange={(updates) => setFilters((current) => ({ ...current, ...updates }))}
                total={dashboardData.total}
                totalPages={dashboardData.totalPages}
              />
            </Reveal>
          ) : null}
        </div>
      </section>
      ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
