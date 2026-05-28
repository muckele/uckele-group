import { getConfig } from '../config.js';
import { hasDealHunterDailyRunForDate, reviewDealHunterDailySheetImport } from './dealHunter.js';

const maxTimeoutMs = 2_147_483_647;

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function addDays(dateParts, days) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days, 12));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function parseDailyTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return { hour: 8, minute: 0 };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 8, minute: 0 };
  }

  return { hour, minute };
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const zonedParts = getZonedParts(new Date(utcGuess), timeZone);
  const zonedAsUtc = Date.UTC(
    zonedParts.year,
    zonedParts.month - 1,
    zonedParts.day,
    zonedParts.hour,
    zonedParts.minute,
    zonedParts.second,
  );
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return new Date(utcGuess + desiredAsUtc - zonedAsUtc);
}

export function getNextDealHunterImportDate(now = new Date(), config = getConfig()) {
  const { hour, minute } = parseDailyTime(config.dealHunter.dailyImportTime);
  const timeZone = config.dealHunter.dailyImportTimeZone;
  const today = getZonedParts(now, timeZone);
  let candidate = zonedDateTimeToUtc({ ...today, hour, minute, second: 0 }, timeZone);

  if (candidate.getTime() <= now.getTime() + 1000) {
    const tomorrow = addDays(today, 1);
    candidate = zonedDateTimeToUtc({ ...tomorrow, hour, minute, second: 0 }, timeZone);
  }

  return candidate;
}

function scheduledTimeHasPassedToday(now, config) {
  const { hour, minute } = parseDailyTime(config.dealHunter.dailyImportTime);
  const localNow = getZonedParts(now, config.dealHunter.dailyImportTimeZone);

  return localNow.hour > hour || (localNow.hour === hour && localNow.minute >= minute);
}

async function runDailyImport(trigger) {
  const startedAt = new Date();

  try {
    const result = await reviewDealHunterDailySheetImport({ requestedBy: trigger });

    if (result.skipped) {
      console.log(`[deal-hunter] Daily import skipped: ${result.reason}`);
      return;
    }

    console.log(
      `[deal-hunter] Daily import completed in ${Date.now() - startedAt.getTime()}ms: ` +
        `${result.run.qualified_count} qualified, ${result.run.watch_count} watch, ${result.run.rejected_count} rejected.`,
    );
  } catch (error) {
    console.error(`[deal-hunter] Daily import failed: ${error.message || error}`);
  }
}

export function startDealHunterDailyImportScheduler() {
  const config = getConfig();

  if (!config.dealHunter.dailyImportEnabled) {
    return { enabled: false, stop: () => {} };
  }

  if (!config.dealHunter.sheetCsvUrl) {
    console.warn('[deal-hunter] Daily import is enabled but DEAL_HUNTER_SHEET_CSV_URL is missing.');
    return { enabled: false, stop: () => {} };
  }

  let timer = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    const nextRunAt = getNextDealHunterImportDate(new Date(), config);
    const delayMs = Math.min(Math.max(1000, nextRunAt.getTime() - Date.now()), maxTimeoutMs);

    console.log(
      `[deal-hunter] Daily import scheduled for ${nextRunAt.toISOString()} ` +
        `(${config.dealHunter.dailyImportTime} ${config.dealHunter.dailyImportTimeZone}).`,
    );

    timer = setTimeout(async () => {
      await runDailyImport('deal-hunter-scheduler');
      scheduleNext();
    }, delayMs);
    timer.unref?.();
  };

  if (config.dealHunter.dailyImportCatchUpOnStart && scheduledTimeHasPassedToday(new Date(), config)) {
    setTimeout(async () => {
      if (stopped || (await hasDealHunterDailyRunForDate(new Date()))) {
        return;
      }

      await runDailyImport('deal-hunter-startup-catch-up');
    }, 5000).unref?.();
  }

  scheduleNext();

  return {
    enabled: true,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
