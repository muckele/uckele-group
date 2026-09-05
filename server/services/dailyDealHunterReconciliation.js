import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import {
  canonicalDailyDealHunterMailbox,
  verifyDailyDealHunterEmailEnvelope,
} from './dailyDealHunterDigest.js';

export const DAILY_DEAL_HUNTER_RECONCILIATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_RECONCILIATION_EVENTS = 100;
const MAX_PROVIDER_CANDIDATES = 20;
const acceptedEventTypes = new Set([
  'sent', 'delivered', 'delayed', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'suppressed',
]);

function boundedText(value = '', maximum = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function providerIdentity(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:@-]{1,240}$/.test(normalized) ? normalized : '';
}

function eventTags(event = {}) {
  const tags = event.metadata?.tags || event.metadata?.tracking?.tags || [];
  const result = new Map();
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string') {
        const [name, ...value] = tag.split('=');
        result.set(boundedText(name, 80), boundedText(value.join('='), 256));
      } else if (isRecord(tag)) {
        result.set(boundedText(tag.name || tag.key, 80), boundedText(tag.value, 256));
      }
    }
  } else if (isRecord(tags)) {
    for (const [name, value] of Object.entries(tags)) result.set(boundedText(name, 80), boundedText(value, 256));
  }
  return result;
}

function preparedAuthority(run) {
  const metadata = isRecord(run?.metadata) ? run.metadata : {};
  const envelope = isRecord(metadata.preparedEnvelope) ? metadata.preparedEnvelope : null;
  const verification = envelope ? verifyDailyDealHunterEmailEnvelope(envelope) : { ok: false };
  if (!verification.ok
    || metadata.payloadDigest !== envelope.payloadDigest
    || metadata.notificationType !== envelope.notificationType
    || ![metadata.businessDate, metadata.pacificDate, metadata.dateKey].filter(Boolean).every((date) => date === envelope.businessDate)
    || run.job_key !== envelope.idempotencyKey) {
    return null;
  }
  return {
    envelope,
    claimToken: boundedText(metadata.claimToken, 200),
    businessDate: envelope.businessDate,
    notificationType: envelope.notificationType,
    payloadDigest: envelope.payloadDigest,
  };
}

export function dailyDealHunterMarkerPath(markerDir, businessDate) {
  return markerDir && /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))
    ? path.join(markerDir, `${businessDate}.json`)
    : '';
}

function normalizedMarker(evidence = {}) {
  const marker = {
    version: 1,
    jobKey: boundedText(evidence.jobKey, 240),
    businessDate: boundedText(evidence.businessDate, 20),
    notificationType: boundedText(evidence.notificationType, 40),
    payloadDigest: boundedText(evidence.payloadDigest, 64),
    providerMessageId: providerIdentity(evidence.providerMessageId),
    acceptedAt: boundedText(evidence.acceptedAt, 40),
  };
  if (marker.version !== 1
    || marker.jobKey !== `daily-deal-hunter-email:${marker.businessDate}`
    || !/^\d{4}-\d{2}-\d{2}$/.test(marker.businessDate)
    || !['normal-digest', 'required-source-alert'].includes(marker.notificationType)
    || !/^[a-f0-9]{64}$/.test(marker.payloadDigest)
    || !marker.providerMessageId
    || !Number.isFinite(Date.parse(marker.acceptedAt))) {
    throw new TypeError('Daily Deal Hunter marker evidence is invalid.');
  }
  marker.acceptedAt = new Date(marker.acceptedAt).toISOString();
  return marker;
}

export async function writeDailyDealHunterMarker({ markerDir, evidence } = {}) {
  const marker = normalizedMarker(evidence);
  const destination = dailyDealHunterMarkerPath(markerDir, marker.businessDate);
  if (!destination) return { written: false, reason: 'marker-disabled', marker };
  await fs.mkdir(markerDir, { recursive: true });
  const temporary = path.join(markerDir, `.${marker.businessDate}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return { written: true, marker };
}

export async function readDailyDealHunterMarker({ markerDir, businessDate } = {}) {
  const markerPath = dailyDealHunterMarkerPath(markerDir, businessDate);
  if (!markerPath) return { status: 'missing', marker: null };
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 4096) return { status: 'invalid', marker: null };
    return { status: 'valid', marker: normalizedMarker(JSON.parse(raw)) };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { status: 'missing', marker: null }
      : { status: 'invalid', marker: null };
  }
}

function exactMarker(marker, authority) {
  return marker?.jobKey === authority.envelope.idempotencyKey
    && marker.businessDate === authority.businessDate
    && marker.notificationType === authority.notificationType
    && marker.payloadDigest === authority.payloadDigest
    && Boolean(marker.providerMessageId);
}

function exactEvent(event, authority, { signedWebhook = false } = {}) {
  const tags = eventTags(event);
  const tracking = isRecord(event.metadata?.tracking) ? event.metadata.tracking : {};
  const providerId = providerIdentity(event.message_id || event.provider_message_id || event.metadata?.resendEmailId);
  if (!providerId
    || boundedText(event.provider, 60).toLowerCase() !== 'resend'
    || !acceptedEventTypes.has(boundedText(event.event_type, 80).toLowerCase())
    || tags.get('source') !== 'daily-deal-hunter'
    || tags.get('business_date') !== authority.businessDate
    || tags.get('notification') !== authority.notificationType
    || tags.get('payload_digest') !== authority.payloadDigest
    || (tracking.jobKey && tracking.jobKey !== authority.envelope.idempotencyKey)
    || (tracking.businessDate && tracking.businessDate !== authority.businessDate)
    || (tracking.notificationType && tracking.notificationType !== authority.notificationType)
    || (tracking.payloadDigest && tracking.payloadDigest !== authority.payloadDigest)) {
    return null;
  }
  if (signedWebhook && (!event.provider_event_id || !event.metadata?.svixId)) return null;
  if (event.recipient_email && canonicalDailyDealHunterMailbox(event.recipient_email)
    !== canonicalDailyDealHunterMailbox(authority.envelope.to)) {
    return null;
  }
  if (event.subject && boundedText(event.subject, 300) !== authority.envelope.subject) return null;
  return {
    providerMessageId: providerId,
    acceptedAt: Number.isFinite(Date.parse(event.created_at))
      ? new Date(event.created_at).toISOString()
      : authority.envelope.preparedAt,
  };
}

function exactProviderCandidate(candidate, authority, now) {
  const tags = eventTags({ metadata: { tags: candidate?.tags } });
  const recipients = Array.isArray(candidate?.to) ? candidate.to : [candidate?.to];
  const recipient = canonicalDailyDealHunterMailbox(authority.envelope.to);
  const candidateTime = Date.parse(candidate?.createdAt || candidate?.created_at || '');
  const earliest = Date.parse(authority.envelope.preparedAt) - 5 * 60 * 1000;
  const latest = now.getTime() + 5 * 60 * 1000;
  if (!providerIdentity(candidate?.id)
    || !recipients.map(canonicalDailyDealHunterMailbox).includes(recipient)
    || boundedText(candidate?.subject, 300) !== authority.envelope.subject
    || !Number.isFinite(candidateTime) || candidateTime < earliest || candidateTime > latest
    || tags.get('source') !== 'daily-deal-hunter'
    || tags.get('business_date') !== authority.businessDate
    || tags.get('notification') !== authority.notificationType
    || tags.get('payload_digest') !== authority.payloadDigest) {
    return null;
  }
  return { providerMessageId: providerIdentity(candidate.id), acceptedAt: new Date(candidateTime).toISOString() };
}

async function markAmbiguous({ storage, run, authority, nowIso, errorCategory, reason }) {
  const severity = errorCategory === 'conflicting-provider-evidence' ? 'high' : 'warning';
  if (run.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      source: '',
      reason: errorCategory,
      severity,
      attentionRequired: true,
      jobRun: run,
    };
  }
  const transition = await storage.transitionScheduledJob({
    jobKey: run.job_key,
    claimToken: authority.claimToken,
    expectedStatuses: ['transmitting'],
    status: 'ambiguous',
    nowIso,
    lastError: boundedText(reason, 500),
    metadataPatch: {
      ambiguousAt: nowIso,
      reconciliation: {
        checkedAt: nowIso,
        errorCategory,
        severity,
      },
    },
  });
  return {
    status: transition.run?.status || 'ambiguous',
    source: '',
    reason: errorCategory,
    severity,
    attentionRequired: true,
    jobRun: transition.run || run,
  };
}

async function completeFromEvidence({ storage, run, authority, evidence, source, now, markerDir }) {
  const nowIso = now.toISOString();
  const transition = await storage.transitionScheduledJob({
    jobKey: run.job_key,
    claimToken: authority.claimToken,
    expectedStatuses: ['transmitting', 'ambiguous'],
    status: 'completed',
    nowIso,
    completedAt: evidence.acceptedAt || nowIso,
    providerMessageId: evidence.providerMessageId,
    lastError: '',
    metadataPatch: {
      provider: 'resend',
      acceptedAt: evidence.acceptedAt || nowIso,
      reconciledAt: nowIso,
      reconciliationSource: source,
      reconciliation: { checkedAt: nowIso, source, errorCategory: '', severity: 'none' },
    },
  });
  if (!transition.applied && transition.reason !== 'completed') {
    return { status: transition.run?.status || run.status, source: '', reason: transition.reason, jobRun: transition.run || run };
  }
  const completedRun = transition.run || run;
  await writeDailyDealHunterMarker({
    markerDir,
    evidence: {
      jobKey: run.job_key,
      businessDate: authority.businessDate,
      notificationType: authority.notificationType,
      payloadDigest: authority.payloadDigest,
      providerMessageId: evidence.providerMessageId,
      acceptedAt: evidence.acceptedAt || nowIso,
    },
  }).catch(() => {});
  return { status: 'completed', source, reason: '', jobRun: completedRun };
}

function completedEvidence(run) {
  const providerMessageId = providerIdentity(run.provider_message_id);
  const acceptedAt = run.metadata?.acceptedAt || run.completed_at || run.updated_at;
  return providerMessageId && Number.isFinite(Date.parse(acceptedAt))
    ? { providerMessageId, acceptedAt: new Date(acceptedAt).toISOString() }
    : null;
}

export async function reconcileDailyDealHunterJob({
  storage = getStorage(),
  jobKey,
  markerDir = getConfig().dealHunter.dailyEmail.markerDir,
  now = new Date(),
  providerLookup,
} = {}) {
  const run = await storage.getScheduledJob?.(jobKey);
  if (!run) return { status: 'missing', source: '', reason: 'missing', jobRun: null };
  const authority = preparedAuthority(run);
  if (!authority) return { status: run.status, source: '', reason: 'invalid-prepared-authority', jobRun: run };

  const markerResult = await readDailyDealHunterMarker({ markerDir, businessDate: authority.businessDate });
  if (run.status === 'completed') {
    const evidence = completedEvidence(run);
    if (markerResult.status === 'missing' && evidence) {
      await writeDailyDealHunterMarker({
        markerDir,
        evidence: { jobKey, businessDate: authority.businessDate, notificationType: authority.notificationType, payloadDigest: authority.payloadDigest, ...evidence },
      }).catch(() => {});
    }
    return {
      status: 'completed',
      source: 'database',
      reason: markerResult.status === 'valid' && !exactMarker(markerResult.marker, authority) ? 'marker-mismatch' : '',
      jobRun: run,
    };
  }
  if (!['transmitting', 'ambiguous'].includes(run.status)) {
    return { status: run.status, source: '', reason: '', jobRun: run };
  }

  const evidence = [];
  if (markerResult.status === 'valid' && exactMarker(markerResult.marker, authority)) {
    evidence.push({
      source: 'marker',
      providerMessageId: markerResult.marker.providerMessageId,
      acceptedAt: markerResult.marker.acceptedAt,
    });
  }

  const localEvents = await storage.listEmailEvents?.({ source: 'daily-deal-hunter', limit: MAX_RECONCILIATION_EVENTS }) || [];
  const localMatches = localEvents.map((event) => exactEvent(event, authority)).filter(Boolean);
  evidence.push(...localMatches.map((item) => ({ ...item, source: 'local-event' })));

  const webhookEvents = await storage.listEmailEvents?.({ source: 'webhook', limit: MAX_RECONCILIATION_EVENTS }) || [];
  const webhookMatches = webhookEvents.map((event) => exactEvent(event, authority, { signedWebhook: true })).filter(Boolean);
  evidence.push(...webhookMatches.map((item) => ({ ...item, source: 'signed-webhook' })));

  let providerLookupUnavailable = false;
  if (typeof providerLookup === 'function') {
    try {
      const candidates = await providerLookup({
        envelope: authority.envelope,
        jobKey,
        businessDate: authority.businessDate,
        maximumCandidates: MAX_PROVIDER_CANDIDATES,
      });
      const matches = (Array.isArray(candidates) ? candidates : [])
        .slice(0, MAX_PROVIDER_CANDIDATES)
        .map((candidate) => exactProviderCandidate(candidate, authority, now))
        .filter(Boolean);
      evidence.push(...matches.map((item) => ({ ...item, source: 'provider-lookup' })));
    } catch {
      providerLookupUnavailable = true;
    }
  }

  const providerIds = [...new Set(evidence.map((item) => item.providerMessageId))];
  if (providerIds.length > 1) {
    return markAmbiguous({
      storage,
      run,
      authority,
      nowIso: now.toISOString(),
      errorCategory: 'conflicting-provider-evidence',
      reason: 'Multiple exact provider identities require review.',
    });
  }
  if (providerIds.length === 1) {
    const accepted = evidence.find((item) => item.providerMessageId === providerIds[0]);
    return completeFromEvidence({
      storage,
      run,
      authority,
      evidence: accepted,
      source: accepted.source,
      now,
      markerDir,
    });
  }

  const boundaryAt = Date.parse(run.metadata?.providerBoundaryAt || run.updated_at || run.started_at || '');
  if (run.status === 'transmitting' && Number.isFinite(boundaryAt)
    && now.getTime() - boundaryAt >= DAILY_DEAL_HUNTER_RECONCILIATION_WINDOW_MS) {
    return markAmbiguous({
      storage,
      run,
      authority,
      nowIso: now.toISOString(),
      errorCategory: providerLookupUnavailable ? 'provider-lookup-unavailable' : 'no-provider-proof',
      reason: providerLookupUnavailable
        ? 'Provider reconciliation lookup was unavailable after the evidence window.'
        : 'No exact provider acceptance proof was found during the reconciliation window.',
    });
  }
  return {
    status: run.status,
    source: '',
    reason: providerLookupUnavailable
      ? 'provider-lookup-unavailable'
      : markerResult.status === 'valid' ? 'marker-mismatch' : 'awaiting-provider-proof',
    jobRun: run,
  };
}

export async function reconcileDailyDealHunterWebhookEvent({
  storage = getStorage(),
  event,
  markerDir = getConfig().dealHunter.dailyEmail.markerDir,
  now = new Date(),
} = {}) {
  const tags = eventTags(event);
  const businessDate = tags.get('business_date') || '';
  if (tags.get('source') !== 'daily-deal-hunter'
    || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)
    || !['normal-digest', 'required-source-alert'].includes(tags.get('notification') || '')
    || !/^[a-f0-9]{64}$/.test(tags.get('payload_digest') || '')
    || !event?.metadata?.svixId) {
    return { status: 'ignored', source: '', reason: 'not-exact-daily-digest-evidence', jobRun: null };
  }
  return reconcileDailyDealHunterJob({
    storage,
    jobKey: `daily-deal-hunter-email:${businessDate}`,
    markerDir,
    now,
  });
}
