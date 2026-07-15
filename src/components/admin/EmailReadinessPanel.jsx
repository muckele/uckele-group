import React from 'react';
import { MailCheck, Send, ShieldAlert } from 'lucide-react';

function formatDate(value) {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not observed'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function Status({ label, state, detail }) {
  const tone = state === 'ready'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : state === 'waiting'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-red-200 bg-red-50 text-red-800';
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em]">{label}</p>
      <p className="mt-2 text-sm font-semibold">{detail}</p>
    </div>
  );
}

export default function EmailReadinessPanel({ data, onSendTest, testSending = false }) {
  if (!data) return null;

  const deliveryState = data.deliveryTrackingVerified
    ? ['ready', 'Verified by webhook event']
    : data.deliveryTrackingConfigured
      ? ['waiting', 'Configured; waiting for a delivery event']
      : ['blocked', 'Signed webhook missing'];
  const replyState = data.replyTrackingVerified
    ? ['ready', 'Verified by inbound reply']
    : data.replyTrackingConfigured
      ? ['waiting', 'Configured; reply test still required']
      : ['blocked', 'Inbound receiving is not configured'];
  const followUpState = data.followUpsEnabled
    ? data.followUpsSafe
      ? ['ready', 'Enabled and reply-safe']
      : ['blocked', 'Blocked by the server safety gate']
    : ['waiting', 'Paused'];

  return (
    <section className="rounded-2xl border border-line bg-white/75 p-5" aria-labelledby="email-readiness-heading">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-moss"><MailCheck className="h-5 w-5" /><p className="text-xs font-semibold uppercase tracking-[0.16em]">Email Operations</p></div>
          <h3 className="mt-2 text-xl font-semibold text-ink" id="email-readiness-heading">Delivery and reply readiness</h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/68">
            “Sent” means Resend accepted the request. Delivery and inbound replies are independently verified below before automated broker follow-ups are allowed.
          </p>
        </div>
        {onSendTest ? (
          <button
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-moss bg-moss px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-pine disabled:cursor-not-allowed disabled:opacity-50"
            disabled={testSending || !data.outboundConfigured || !data.testRecipient}
            onClick={onSendTest}
            type="button"
          >
            <Send className="h-4 w-4" />
            {testSending ? 'Sending Test…' : `Send Test${data.testRecipient ? ` to ${data.testRecipient}` : ''}`}
          </button>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Status
          detail={data.outboundConfigured ? `Ready via ${data.provider}` : 'Provider credentials incomplete'}
          label="Outbound"
          state={data.outboundConfigured ? 'ready' : 'blocked'}
        />
        <Status detail={deliveryState[1]} label="Delivery Tracking" state={deliveryState[0]} />
        <Status detail={replyState[1]} label="Reply Tracking" state={replyState[0]} />
        <Status detail={followUpState[1]} label="CIM Follow-Ups" state={followUpState[0]} />
      </div>

      <div className="mt-5 grid gap-3 text-xs leading-6 text-ink/65 md:grid-cols-2">
        <p><strong className="text-ink">From:</strong> {data.fromAddress || 'Not configured'}</p>
        <p><strong className="text-ink">Reply-to:</strong> {data.replyToAddress || 'Not configured'}</p>
        <p><strong className="text-ink">Inbound domain:</strong> {data.inboundDomain || 'Not configured'}</p>
        <p><strong className="text-ink">Last delivery event:</strong> {formatDate(data.latestDeliveryEvent?.createdAt)}</p>
        <p><strong className="text-ink">Verified test reply:</strong> {formatDate(data.latestVerifiedReplyEvent?.createdAt)}</p>
        <p><strong className="text-ink">Last test event:</strong> {data.latestTestEvent ? `${data.latestTestEvent.eventType} · ${formatDate(data.latestTestEvent.createdAt)}` : 'Not observed'}</p>
      </div>

      {data.replyTrackingConfigured && !data.replyTrackingVerified ? (
        <p className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-800">
          After the test arrives, reply without changing its subject. The next inbound webhook will verify reply tracking and unlock the follow-up safety check.
        </p>
      ) : null}

      {data.issues?.length ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4" />Configuration checks</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">{data.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}
