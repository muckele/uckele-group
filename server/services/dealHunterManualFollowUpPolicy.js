import { createHash } from 'node:crypto';

export const MANUAL_FOLLOW_UP_VERSION = 'deal-hunter-manual-follow-up-v1';
export const MANUAL_FOLLOW_UP_MODE = 'operator-approved';
export const MANUAL_FOLLOW_UP_MAXIMUM = 5;
export const MANUAL_FOLLOW_UP_CADENCE = 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1';

const pacificTimeZone = 'America/Los_Angeles';
const pacificDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: pacificTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const pacificOffsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: pacificTimeZone,
  timeZoneName: 'longOffset',
});

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, maximum = 500) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function iso(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function dateParts(value) {
  return Object.fromEntries(
    pacificDateFormatter.formatToParts(value)
      .filter((part) => ['year', 'month', 'day'].includes(part.type))
      .map((part) => [part.type, Number(part.value)]),
  );
}

function offsetMinutes(value) {
  const offset = pacificOffsetFormatter.formatToParts(value).find((part) => part.type === 'timeZoneName')?.value || '';
  const match = offset.match(/^GMT([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function pacificDateKey(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const { year, month, day } = dateParts(parsed);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizedFollowUpCount(request = {}) {
  const hasSnakeCaseCount = Object.hasOwn(request, 'follow_up_count');
  const hasCamelCaseCount = Object.hasOwn(request, 'followUpCount');
  if (!hasSnakeCaseCount && !hasCamelCaseCount) return { count: 0, valid: true };
  const raw = hasSnakeCaseCount ? request.follow_up_count : request.followUpCount;
  if (raw === null || raw === undefined) return { count: 0, valid: true };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MANUAL_FOLLOW_UP_MAXIMUM) {
    return { count: null, valid: false };
  }
  return { count: raw, valid: true };
}

function publicBlockers(value) {
  const blockers = Array.isArray(value) ? value : [];
  const seen = new Set();
  return blockers.flatMap((item) => {
    const code = boundedText(item?.code, 120);
    const message = boundedText(item?.message, 500);
    if (!code || !message || seen.has(code)) return [];
    seen.add(code);
    return [{ code, message }];
  }).slice(0, 20);
}

function currentCommunication(communications, followUpNumber) {
  if (!Number.isInteger(followUpNumber)) return null;
  return (Array.isArray(communications) ? communications : [])
    .filter((item) => Number(item?.follow_up_number ?? item?.followUpNumber) === followUpNumber)
    .sort((left, right) => (
      (Date.parse(right?.updated_at || right?.updatedAt || right?.created_at || right?.createdAt || '') || 0)
      - (Date.parse(left?.updated_at || left?.updatedAt || left?.created_at || left?.createdAt || '') || 0)
    ))[0] || null;
}

export function buildManualFollowUpMarker({ enrolledAt, enrolledBy } = {}) {
  const timestamp = iso(enrolledAt);
  const actor = boundedText(enrolledBy, 300);
  if (!timestamp || !actor) throw new TypeError('Manual follow-up enrollment requires a valid time and actor.');
  return {
    version: MANUAL_FOLLOW_UP_VERSION,
    mode: MANUAL_FOLLOW_UP_MODE,
    maximumFollowUps: MANUAL_FOLLOW_UP_MAXIMUM,
    cadencePolicy: MANUAL_FOLLOW_UP_CADENCE,
    enrolledAt: timestamp,
    enrolledBy: actor,
  };
}

export function isOperatorApprovedFollowUpRequest(request = {}) {
  const marker = objectValue(objectValue(objectValue(request).metadata).manualFollowUp);
  return marker.version === MANUAL_FOLLOW_UP_VERSION
    && marker.mode === MANUAL_FOLLOW_UP_MODE
    && marker.maximumFollowUps === MANUAL_FOLLOW_UP_MAXIMUM
    && marker.cadencePolicy === MANUAL_FOLLOW_UP_CADENCE;
}

export function getManualFollowUpNumber(request = {}) {
  if (!isOperatorApprovedFollowUpRequest(request)) return null;
  const { count, valid } = normalizedFollowUpCount(objectValue(request));
  if (!valid || count >= MANUAL_FOLLOW_UP_MAXIMUM) return null;
  return count + 1;
}

export function nextManualFollowUpAt(acceptedAt) {
  const accepted = acceptedAt instanceof Date ? new Date(acceptedAt) : new Date(acceptedAt || '');
  if (Number.isNaN(accepted.getTime())) return '';
  const { year, month, day } = dateParts(accepted);
  const target = new Date(Date.UTC(year, month - 1, day + 2));
  if (target.getUTCDay() === 6) target.setUTCDate(target.getUTCDate() + 2);
  if (target.getUTCDay() === 0) target.setUTCDate(target.getUTCDate() + 1);
  const localNineUtcGuess = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 9);
  const offset = offsetMinutes(new Date(localNineUtcGuess));
  if (!Number.isFinite(offset)) return '';
  return new Date(localNineUtcGuess - offset * 60 * 1000).toISOString();
}

export function buildManualFollowUpCommunicationId({ requestId, followUpNumber } = {}) {
  const id = boundedText(requestId, 500);
  if (!id || !Number.isInteger(followUpNumber) || followUpNumber < 1 || followUpNumber > MANUAL_FOLLOW_UP_MAXIMUM) return '';
  return createHash('sha256').update(`crm-communication:${id}:follow-up:${followUpNumber}`).digest('hex');
}

export function projectManualFollowUpState({
  request = {},
  communications = [],
  authority = {},
  now = new Date(),
} = {}) {
  const safeRequest = objectValue(request);
  const metadata = objectValue(safeRequest.metadata);
  const marker = objectValue(metadata.manualFollowUp);
  const enrolled = isOperatorApprovedFollowUpRequest(safeRequest);
  const countAuthority = normalizedFollowUpCount(safeRequest);
  const followUpCount = countAuthority.count;
  const authorityInvalid = enrolled && !countAuthority.valid;
  const candidateFollowUpNumber = enrolled && countAuthority.valid && followUpCount < MANUAL_FOLLOW_UP_MAXIMUM
    ? followUpCount + 1
    : null;
  const nextFollowUpAt = iso(safeRequest.next_follow_up_at || safeRequest.nextFollowUpAt);
  const followUpState = boundedText(safeRequest.follow_up_state || safeRequest.followUpState, 80).toLowerCase();
  const requestState = boundedText(safeRequest.request_state || safeRequest.requestState, 80).toLowerCase();
  const requestStatus = boundedText(safeRequest.status, 80).toLowerCase();
  const deliveryState = boundedText(safeRequest.delivery_state || safeRequest.deliveryState, 80).toLowerCase();
  const hasStartAuthority = typeof authority?.startEligible === 'boolean';
  const startEligible = hasStartAuthority && !enrolled && authority.startEligible;
  const startBlockers = publicBlockers(authority?.startBlockers);
  const terminalReason = boundedText(
    authority?.terminalReason || (!enrolled && hasStartAuthority && !startEligible ? startBlockers[0]?.code : ''),
    160,
  );
  const communication = currentCommunication(communications, candidateFollowUpNumber);
  const communicationStatus = boundedText(communication?.status, 80).toLowerCase();
  const communicationDelivery = boundedText(communication?.delivery_state || communication?.deliveryState, 80).toLowerCase();
  const ambiguous = [followUpState, requestState, requestStatus, deliveryState, communicationStatus, communicationDelivery]
    .some((value) => ['ambiguous', 'unknown', 'provider_unknown', 'provider_ambiguous', 'follow_up_ambiguous'].includes(value));
  const retryEligible = !ambiguous && (
    followUpState === 'failed'
    || requestStatus === 'follow_up_failed'
    || communicationStatus === 'failed'
    || communicationDelivery === 'failed'
  );

  let state = 'not-enrolled';
  if (!enrolled && hasStartAuthority && !startEligible) {
    state = 'closed';
  } else if (enrolled) {
    if (terminalReason) state = 'closed';
    else if (authorityInvalid) state = 'closed';
    else if (followUpState === 'stopped' || marker.stoppedAt || marker.stopped_at) state = 'stopped';
    else if (followUpCount >= MANUAL_FOLLOW_UP_MAXIMUM || followUpState === 'completed') state = 'completed';
    else if (ambiguous) state = 'ambiguous';
    else if (retryEligible) state = 'retry';
    else if (nextFollowUpAt) {
      const nowDate = now instanceof Date ? new Date(now) : new Date(now || '');
      if (!Number.isNaN(nowDate.getTime()) && nowDate.getTime() >= Date.parse(nextFollowUpAt)) {
        state = pacificDateKey(nowDate) === pacificDateKey(nextFollowUpAt) ? 'due' : 'overdue';
      } else {
        state = 'scheduled';
      }
    } else {
      state = 'stopped';
    }
  }
  const terminalState = ['closed', 'completed', 'stopped'].includes(state);
  const currentFollowUpNumber = terminalState ? null : candidateFollowUpNumber;
  const publicNextFollowUpAt = terminalState ? '' : nextFollowUpAt;
  const invalidCountBlocker = authorityInvalid
    ? [{ code: 'manual-follow-up-authority-invalid', message: 'Manual follow-up count authority is invalid.' }]
    : [];

  return {
    enrolled,
    policyVersion: enrolled ? boundedText(marker.version, 120) : '',
    maximumFollowUps: MANUAL_FOLLOW_UP_MAXIMUM,
    followUpCount,
    currentFollowUpNumber,
    nextFollowUpAt: publicNextFollowUpAt,
    state,
    terminalReason,
    retryEligible: state === 'retry',
    ...(hasStartAuthority ? { startEligible, startBlockers } : {}),
    preparationBlockers: publicBlockers([...invalidCountBlocker, ...(Array.isArray(authority?.preparationBlockers) ? authority.preparationBlockers : [])]),
    sendBlockers: publicBlockers(authority?.sendBlockers),
  };
}
