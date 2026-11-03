// Daily Google Sheet sync, then automatic Pursue (spec 2026-11-02 MVP send readiness, section 5).
//
// Sheets used to be fetched only as a side effect of the 08:00 digest, and nothing recorded how
// each sheet fared. This job calls the same score refresh the digest relies on, records one entry
// per sheet, and only then lets automatic Pursue run with the fingerprints that refresh produced.
// Every uncertainty resolves toward not running Pursue.
import { getStorage } from '../storage/index.js';
import { runAutoPursue } from './autoPursue.js';
import { refreshOpportunityScores } from './dealHunterScoreStore.js';

const sheetErrorMaxLength = 300;

function boundedError(value) {
  const text = String(value?.message ?? value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, sheetErrorMaxLength) : null;
}

function sourceId(source) {
  return String(source?.sourceId ?? source?.id ?? '');
}

function isSheetSource(source) {
  return sourceId(source).startsWith('sheet-');
}

// The same rule the score store applies when it proves a complete authoritative set. An optional
// sheet that fails is reported in `sheets` but must not block automatic Pursue.
function isRequiredSource(source) {
  return source?.required === true && source?.sourceRole === 'required-primary';
}

// The same test the existing review code applies: not fetched, errored or empty is unhealthy.
function sourceIsHealthy(source) {
  return source?.fetched !== false && !source?.error && Number(source?.rowCount || 0) > 0;
}

function projectSheet(source) {
  const sheet = {
    sourceId: sourceId(source),
    fetched: source?.fetched !== false,
    rowCount: Math.max(0, Math.trunc(Number(source?.rowCount) || 0)),
    error: boundedError(source?.error),
  };
  // Sources carry no timing today; the sync is timed as a whole. Pass one through if it appears.
  if (Number.isFinite(Number(source?.durationMs))) sheet.durationMs = Number(source.durationMs);
  return sheet;
}

async function countCriteriaGroups(storage, currentFingerprints) {
  const ids = Object.keys(currentFingerprints || {});
  if (ids.length === 0 || typeof storage?.listDealHunterOpportunityScoreFingerprints !== 'function') return {};
  try {
    const counts = {};
    for (const row of await storage.listDealHunterOpportunityScoreFingerprints(ids)) {
      const group = row?.criteria_group ? String(row.criteria_group) : 'unknown';
      counts[group] = (counts[group] || 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

function failedRefresh(refreshResult) {
  return refreshResult?.scoringDeferred !== true
    && refreshResult?.ok === false
    && Number(refreshResult?.status) !== 207;
}

/**
 * Sync the configured sheets through the score refresh, then run automatic Pursue.
 *
 * Resolves with `ok: false` when a required sheet is unhealthy, scoring was deferred or the
 * refresh failed or threw. Automatic Pursue is attempted only when `ok` is true, and a throw from
 * it is recorded without failing the sync. `durationMs` times the whole refresh, not each sheet.
 */
export async function runDealHunterSheetSync({
  storage = getStorage(),
  now = new Date(),
  triggeredBy = 'scheduler',
  refresh = refreshOpportunityScores,
  autoPursue = runAutoPursue,
  clock = () => Date.now(),
} = {}) {
  const startedAt = clock();
  let refreshResult;
  try {
    refreshResult = await refresh({ storage, reviewMode: 'full-backfill' });
  } catch (error) {
    return {
      ok: false,
      sheets: [],
      scoredCount: 0,
      groupCounts: {},
      requiredSourcesHealthy: false,
      autoPursue: { skipped: 'refresh_failed' },
      error: boundedError(error) || 'The score refresh threw.',
      triggeredBy,
      durationMs: Math.max(0, clock() - startedAt),
    };
  }
  const durationMs = Math.max(0, clock() - startedAt);

  const sources = Array.isArray(refreshResult?.review?.sources) ? refreshResult.review.sources : [];
  const sheets = sources.filter(isSheetSource).map(projectSheet);
  const required = sources.filter(isRequiredSource);
  const requiredSourcesHealthy = required.length > 0 && required.every(sourceIsHealthy);
  const scoringDeferred = refreshResult?.scoringDeferred === true;
  const refreshFailed = failedRefresh(refreshResult);
  const currentFingerprints = refreshResult?.currentFingerprints && typeof refreshResult.currentFingerprints === 'object'
    ? refreshResult.currentFingerprints
    : {};
  const ok = requiredSourcesHealthy && !scoringDeferred && !refreshFailed;

  const result = {
    ok,
    sheets,
    scoredCount: Object.keys(currentFingerprints).length,
    groupCounts: await countCriteriaGroups(storage, currentFingerprints),
    requiredSourcesHealthy,
    autoPursue: null,
    error: ok ? null : boundedError(
      scoringDeferred ? 'Scoring was deferred because required sources are unhealthy.'
        : refreshFailed ? refreshResult?.error || 'The score refresh failed.'
          : 'A required sheet is unhealthy.',
    ),
    triggeredBy,
    durationMs,
  };

  if (!ok) {
    result.autoPursue = {
      skipped: !requiredSourcesHealthy ? 'required_source_failed' : scoringDeferred ? 'scoring_deferred' : 'refresh_failed',
    };
    return result;
  }

  try {
    const pursue = await autoPursue({ storage, now, triggeredBy: 'sheet-sync', currentFingerprints });
    result.autoPursue = {
      runKey: pursue?.runKey ?? null,
      status: pursue?.status ?? null,
      mode: pursue?.mode ?? null,
      commands: Math.max(0, Math.trunc(Number(pursue?.commands) || 0)),
      ...(pursue?.reason ? { reason: String(pursue.reason).slice(0, 120) } : {}),
      ...(pursue?.duplicateInvocation === true ? { duplicateInvocation: true } : {}),
    };
  } catch (error) {
    result.autoPursue = { error: boundedError(error) || 'Automatic Pursue threw.' };
  }
  return result;
}
