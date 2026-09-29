import { validateIanaTimezone } from './opportunityTimezone.js';

export const CIM_CAMPAIGN_POLICY_VERSION = 'deal-hunter-cim-autopilot-v1';
const HOUR_MS = 3_600_000;
const formatters = new Map();

function formatter(zone) {
  const valid = validateIanaTimezone(zone);
  if (!valid) throw new Error('Valid IANA timezone is required.');
  if (!formatters.has(valid)) formatters.set(valid, new Intl.DateTimeFormat('en-US', {
    timeZone: valid, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit',
  }));
  return formatters.get(valid);
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new Error('An explicit ISO instant is required.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid instant.');
  return parsed;
}

function parts(at, zone) {
  const entries = Object.fromEntries(formatter(zone).formatToParts(at)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: entries.year, month: entries.month, day: entries.day,
    hour: entries.hour, minute: entries.minute, second: entries.second,
    millisecond: at.getUTCMilliseconds() };
}

function epoch(wall) {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour || 0,
    wall.minute || 0, wall.second || 0, wall.millisecond || 0);
}

function isoLocal(wall) {
  return `${String(wall.year).padStart(4, '0')}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}T${String(wall.hour || 0).padStart(2, '0')}:${String(wall.minute || 0).padStart(2, '0')}:${String(wall.second || 0).padStart(2, '0')}`;
}

function possibleOffsets(target, zone) {
  const offsets = new Set();
  for (let step = -8; step <= 8; step += 1) {
    const sample = new Date(target + step * 6 * HOUR_MS);
    offsets.add(epoch(parts(sample, zone)) - sample.getTime());
  }
  return offsets;
}

function possibleInstants(wall, zone, knownOffsets) {
  const target = epoch(wall);
  const offsets = knownOffsets || possibleOffsets(target, zone);
  return [...offsets].map((offset) => target - offset)
    .filter((candidate) => isoLocal(parts(new Date(candidate), zone)) === isoLocal(wall)
      && new Date(candidate).getUTCMilliseconds() === (wall.millisecond || 0))
    .sort((a, b) => a - b);
}

export function resolveLocalInstant(wall, zone) {
  formatter(zone);
  const requested = epoch(wall);
  if (!Number.isFinite(requested) || isoLocal(parts(new Date(requested), 'Etc/UTC')) !== isoLocal(wall)) {
    throw new Error('Invalid local wall-clock time.');
  }
  const candidates = possibleInstants(wall, zone);
  if (candidates.length) return { instant: new Date(candidates[0]).toISOString(),
    disambiguation: candidates.length > 1 ? 'earlier-repeat' : 'exact' };
  const offsets = possibleOffsets(requested, zone);
  for (let cursor = Math.floor(requested / 60_000) * 60_000 + 60_000;
    cursor <= requested + 48 * HOUR_MS; cursor += 60_000) {
    const shifted = new Date(cursor);
    const later = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(), millisecond: shifted.getUTCMilliseconds() };
    const valid = possibleInstants(later, zone, offsets);
    if (valid.length) return { instant: new Date(valid[0]).toISOString(), disambiguation: 'gap-forward' };
  }
  throw new Error('Local time is unresolved beyond the supported IANA gap.');
}

function nextDay(wall) {
  const value = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function weekday(wall) {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

export function rollToEligibleWindow(rawDueAt, timezone) {
  const due = instant(rawDueAt);
  const local = parts(due, timezone);
  if (weekday(local) > 0 && weekday(local) < 6 && local.hour >= 8 && local.hour < 17) {
    return { dueAt: due.toISOString(), dueLocal: isoLocal(local), disambiguation: 'exact' };
  }
  let date = { year: local.year, month: local.month, day: local.day };
  if (weekday(local) === 0 || weekday(local) === 6 || local.hour >= 17) date = nextDay(date);
  while (weekday(date) === 0 || weekday(date) === 6) date = nextDay(date);
  const wall = { ...date, hour: 8, minute: 0, second: 0 };
  const resolved = resolveLocalInstant(wall, timezone);
  return { dueAt: resolved.instant, dueLocal: isoLocal(wall), disambiguation: resolved.disambiguation };
}

export function calculateCampaignExpiry(initialAcceptedAt, timezone) {
  const accepted = instant(initialAcceptedAt);
  const localAccepted = parts(accepted, timezone);
  const target = new Date(Date.UTC(localAccepted.year, localAccepted.month - 1,
    localAccepted.day + 21, localAccepted.hour, localAccepted.minute,
    localAccepted.second, localAccepted.millisecond));
  const localExpiry = { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1,
    day: target.getUTCDate(), hour: target.getUTCHours(), minute: target.getUTCMinutes(),
    second: target.getUTCSeconds(), millisecond: target.getUTCMilliseconds() };
  const resolved = resolveLocalInstant(localExpiry, timezone);
  return { sourceAcceptedAt: accepted.toISOString(), timezone, localAccepted: isoLocal(localAccepted),
    localExpiry: isoLocal(localExpiry), disambiguation: resolved.disambiguation,
    expiresAt: resolved.instant, policyVersion: CIM_CAMPAIGN_POLICY_VERSION,
    resolverVersion: 'intl-iana-v1' };
}

export function calculateNextCimSlot({ policyVersion, timezone, kind, readyAt,
  priorAcceptedAt, priorOutcome = 'accepted', expiryAt, sendTime = '08:00' } = {}) {
  if (policyVersion !== CIM_CAMPAIGN_POLICY_VERSION) throw new Error('Unknown CIM cadence policy.');
  formatter(timezone);
  if (kind !== 'initial' && !expiryAt) throw new Error('Campaign expiry is required for follow-ups.');
  const expiry = expiryAt ? instant(expiryAt).getTime() : Infinity;
  let raw;
  if (kind === 'initial') raw = instant(readyAt);
  else {
    if (priorOutcome !== 'accepted' || !priorAcceptedAt) return null;
    const accepted = instant(priorAcceptedAt);
    const hours = { 'follow-up-1': 48, 'follow-up-2': 72, 'follow-up-3': 96 }[kind];
    if (hours) raw = new Date(accepted.getTime() + hours * HOUR_MS);
    else if (kind === 'weekday-follow-up') {
      if (!/^\d\d:\d\d$/.test(sendTime)) throw new Error('Invalid campaign send time.');
      const [hour, minute] = sendTime.split(':').map(Number);
      if (hour < 8 || hour >= 17 || minute > 59) throw new Error('Send time is outside eligible window.');
      let date = nextDay(parts(accepted, timezone));
      while (weekday(date) === 0 || weekday(date) === 6) date = nextDay(date);
      raw = instant(resolveLocalInstant({ ...date, hour, minute }, timezone).instant);
    } else throw new Error('Unknown CIM logical slot kind.');
  }
  const rolled = rollToEligibleWindow(raw.toISOString(), timezone);
  if (new Date(rolled.dueAt).getTime() >= expiry) return null;
  return { kind, slotKey: kind === 'weekday-follow-up' ? `weekday:${rolled.dueLocal.slice(0, 10)}` : kind,
    rawDueAt: raw.toISOString(), ...rolled, timezone, policyVersion };
}
