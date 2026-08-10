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

  const aiReadiness = data.aiReadiness || {};

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
  const genericFollowUpState = data.genericFollowUpsEnabled
    ? data.genericFollowUpsSafe
      ? ['ready', 'Enabled with all safety gates verified']
      : ['blocked', 'Enabled but blocked by server readiness']
    : ['waiting', 'Feature flag is off'];
  const suppressionState = data.suppressionOperational
    ? ['ready', `${data.metrics?.suppressions?.active || 0} active global suppression(s)`]
    : ['blocked', 'Suppression store check unavailable'];
  const complianceState = data.physicalPostalAddressConfigured && data.optOutConfigured
    ? ['ready', `${data.replyOptOutConfigured ? 'Reply-based' : 'External link-based'} opt-out and postal footer configured`]
    : ['blocked', 'Postal address or opt-out mechanism missing'];
  const aiFlagState = data.aiEnabled
    ? data.aiReady
      ? ['ready', 'Enabled after all readiness gates']
      : ['blocked', 'Enabled but blocked by readiness gates']
    : ['waiting', 'Feature flag is off'];
  const aiBoundsReady = aiReadiness.reasoningConfigured && aiReadiness.timeoutConfigured
    && aiReadiness.contextLimitConfigured && aiReadiness.outputLimitConfigured
    && aiReadiness.retryLimitConfigured && aiReadiness.rateLimitConfigured;
  const aiEvalState = aiReadiness.evalAccepted
    ? ['ready', `${aiReadiness.acceptedEvalVersion} accepted`]
    : ['blocked', `${aiReadiness.expectedEvalVersion || 'Current eval'} not accepted`];
  const aiSmokeState = aiReadiness.syntheticSmokeObserved
    ? ['ready', 'Controlled synthetic smoke recorded']
    : ['blocked', 'Controlled synthetic smoke not observed'];
  const metrics = data.metrics || {};
  const metricRates = metrics.rates || {};
  const outboxAttention = Number(metrics.outbox?.ambiguous || 0) + Number(metrics.outbox?.retryableFailed || 0);
  const aiOutcomeCount = Number(metrics.recommendations?.aiUsed || 0)
    + Number(metrics.recommendations?.aiFallback || 0);

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
        <Status detail={genericFollowUpState[1]} label="CRM Email Actions" state={genericFollowUpState[0]} />
        <Status detail={suppressionState[1]} label="Suppressions" state={suppressionState[0]} />
        <Status detail={complianceState[1]} label="Footer & Opt-Out" state={complianceState[0]} />
        <Status detail="Credential-free rules are authoritative and available" label="Deterministic Recommendations" state="ready" />
        <Status detail={aiFlagState[1]} label="AI Feature Flag" state={aiFlagState[0]} />
        <Status detail={data.aiModel || 'No model selected'} label="AI Model" state={aiReadiness.modelConfigured ? 'ready' : 'blocked'} />
        <Status detail={aiReadiness.apiKeyConfigured ? 'Present (value hidden)' : 'Not configured'} label="AI API Key" state={aiReadiness.apiKeyConfigured ? 'ready' : 'blocked'} />
        <Status detail={aiBoundsReady ? `${aiReadiness.reasoningEffort} reasoning · bounded` : 'One or more request bounds are invalid'} label="AI Request Bounds" state={aiBoundsReady ? 'ready' : 'blocked'} />
        <Status detail={aiReadiness.dataHandlingApproved ? 'Approval recorded' : 'Approval missing'} label="AI Data Approval" state={aiReadiness.dataHandlingApproved ? 'ready' : 'blocked'} />
        <Status detail={aiReadiness.costRateApproved ? 'Approval recorded' : 'Approval missing'} label="AI Cost & Rate" state={aiReadiness.costRateApproved ? 'ready' : 'blocked'} />
        <Status detail={aiEvalState[1]} label="AI Evaluation" state={aiEvalState[0]} />
        <Status detail={aiSmokeState[1]} label="AI Synthetic Smoke" state={aiSmokeState[0]} />
      </div>

      <div className="mt-5 grid gap-3 text-xs leading-6 text-ink/65 md:grid-cols-2">
        <p><strong className="text-ink">From:</strong> {data.fromAddress || 'Not configured'}</p>
        <p><strong className="text-ink">Reply-to:</strong> {data.replyToAddress || 'Not configured'}</p>
        <p><strong className="text-ink">Inbound domain:</strong> {data.inboundDomain || 'Not configured'}</p>
        <p><strong className="text-ink">Last delivery event:</strong> {formatDate(data.latestDeliveryEvent?.createdAt)}</p>
        <p><strong className="text-ink">Verified test reply:</strong> {formatDate(data.latestVerifiedReplyEvent?.createdAt)}</p>
        <p><strong className="text-ink">Last test event:</strong> {data.latestTestEvent ? `${data.latestTestEvent.eventType} · ${formatDate(data.latestTestEvent.createdAt)}` : 'Not observed'}</p>
        <p><strong className="text-ink">30-day metric window:</strong> {data.metricsAvailable ? `Since ${formatDate(metrics.windowStartedAt)}` : 'Unavailable'}</p>
        <p><strong className="text-ink">AI contract:</strong> {aiReadiness.promptVersion || 'Unknown prompt'} · {aiReadiness.schemaVersion || 'unknown schema'}</p>
        <p><strong className="text-ink">AI bounds:</strong> {aiReadiness.maxContextCharacters ?? 'Not configured'} input characters · {aiReadiness.maxOutputTokens ?? 'Not configured'} output tokens · {aiReadiness.timeoutMs ?? 'Not configured'} ms · {aiReadiness.maxRetries ?? 'Not configured'} retries · {aiReadiness.rateLimitPerMinute ?? 'Not configured'} requests/minute</p>
      </div>

      {data.metricsAvailable ? (
        <div className="mt-5" aria-label="CRM follow-up operational metrics">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {[
              ['24h volume', `${metrics.sentLast24Hours || 0} / ${metrics.dailyCap || 0}`],
              ['Recommendation acceptance', `${metricRates.recommendationAcceptance || 0}%`],
              ['Accepted draft edits', `${metricRates.recommendationEdit || 0}%`],
              ['Recommendation dismissal', `${metricRates.recommendationDismissal || 0}%`],
              ['Delivery', `${metricRates.delivery || 0}%`],
              ['Bounce', `${metricRates.bounce || 0}%`],
              ['Reply', `${metricRates.reply || 0}%`],
              ['AI fallback', metricRates.aiFallback === null || metricRates.aiFallback === undefined
                ? 'Not observed'
                : `${metricRates.aiFallback}%`],
            ].map(([label, value]) => (
              <div className="rounded-xl border border-line bg-fog/60 p-3" key={label}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/52">{label}</p>
                <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-ink/55">
            Durable outbox: {metrics.outbox?.queued || 0} queued · {metrics.outbox?.sending || 0} sending · {metrics.outbox?.accepted || 0} provider-accepted · {metrics.outbox?.ambiguous || 0} ambiguous · {metrics.outbox?.retryableFailed || 0} retryable · {metrics.outbox?.permanentFailed || 0} permanent failures. Counts only; Operations never returns message bodies.
          </p>
          <div className="mt-3 rounded-xl border border-line bg-fog/60 p-3 text-xs leading-5 text-ink/65">
            <p className="font-semibold text-ink">Redacted AI observations</p>
            <p className="mt-1">
              Runs: {aiOutcomeCount
                ? `${metrics.recommendations?.aiUsed || 0} enriched / ${metrics.recommendations?.aiFallback || 0} fallback`
                : 'Not observed'} · Response states: {Object.entries(metrics.ai?.responseStates || {}).length
                ? Object.entries(metrics.ai.responseStates).map(([state, total]) => `${state} ${total}`).join(' · ')
                : 'Not observed'}.
            </p>
            <p className="mt-1">
              Latency: {metrics.ai?.latencyMs?.observed
                ? `${metrics.ai.latencyMs.average} ms average (${metrics.ai.latencyMs.minimum}–${metrics.ai.latencyMs.maximum} ms)`
                : 'Not observed'} · Tokens: {metrics.ai?.tokens?.observed
                ? `${metrics.ai.tokens.inputTotal ?? 'unknown'} input / ${metrics.ai.tokens.outputTotal ?? 'unknown'} output / ${metrics.ai.tokens.cachedTotal ?? 'unknown'} cached / ${metrics.ai.tokens.reasoningTotal ?? 'unknown'} reasoning`
                : 'Not observed'}.
            </p>
            <p className="mt-1">
              Fallback reasons: {Object.entries(metrics.ai?.fallbackReasons || {}).length
                ? Object.entries(metrics.ai.fallbackReasons).map(([reason, total]) => `${reason} ${total}`).join(' · ')
                : 'Not observed'}.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-900">
        <p className="font-semibold">Sender-domain authentication requires a manual provider check.</p>
        <p className="mt-1">{data.domainAuthentication?.guidance || 'Verify SPF, DKIM, and DMARC before enabling real sends.'} <a className="font-semibold underline" href={data.domainAuthentication?.providerUrl || 'https://resend.com/domains'} rel="noreferrer" target="_blank">Open Resend Domains</a>.</p>
      </div>

      {outboxAttention > 0 ? (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800" role="alert">
          {outboxAttention} durable email command(s) need operator review. Never retry an ambiguous command until the provider result has been reconciled.
        </p>
      ) : null}

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
