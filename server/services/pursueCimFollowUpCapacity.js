import { resolveLocalInstant } from './cimCampaignPolicy.js';

const CAPACITY_ZONE = 'America/Los_Angeles';
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CAPACITY_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function cimFollowUpCapacityWindow(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid capacity instant');
  const parts = Object.fromEntries(formatter.formatToParts(instant)
    .filter(({ type }) => type !== 'literal').map(({ type, value: part }) => [type, Number(part)]));
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const nextMidnight = resolveLocalInstant({
    year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(),
    hour: 0, minute: 0, second: 0, millisecond: 0,
  }, CAPACITY_ZONE).instant;
  return {
    capacityDate: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    nextMidnight,
    recipientWindowExpiresAt: new Date(instant.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
