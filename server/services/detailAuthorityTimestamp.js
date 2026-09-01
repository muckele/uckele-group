// Strict, bounded instant parsing shared by detail authority selection and the
// SQLite pre-LIMIT CIM window. It intentionally accepts only textual RFC3339
// / extended ISO-8601 instants with a known explicit UTC offset.

const maxDetailAuthorityTimestampLength = 80;
const strictAuthorityTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const sortableEpochOffsetSeconds = 1_000_000_000_000;

function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseStrictDetailAuthorityTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxDetailAuthorityTimestampLength) return null;
  const match = strictAuthorityTimestampPattern.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));

  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || (zone !== 'Z' && (offsetHour > 23 || offsetMinute > 59 || zone === '-00:00'))
  ) return null;

  const parsedMilliseconds = Date.parse(value);
  if (!Number.isFinite(parsedMilliseconds)) return null;
  return {
    timestamp: Math.floor(parsedMilliseconds / 1000),
    fractionalNanoseconds: Number(fraction.padEnd(9, '0')),
    value,
  };
}

export function firstStrictDetailAuthorityTimestamp(record = {}, fieldGroups = []) {
  for (const fields of fieldGroups) {
    for (const field of fields) {
      const parsed = parseStrictDetailAuthorityTimestamp(record?.[field]);
      if (parsed) return parsed;
    }
  }
  return { timestamp: null, fractionalNanoseconds: 0, value: '' };
}

export function strictDetailAuthorityTimestampSortKey(timestamp) {
  if (!timestamp || timestamp.timestamp === null) return null;
  const sortableSeconds = timestamp.timestamp + sortableEpochOffsetSeconds;
  return `${String(sortableSeconds).padStart(13, '0')}.${String(timestamp.fractionalNanoseconds || 0).padStart(9, '0')}`;
}
