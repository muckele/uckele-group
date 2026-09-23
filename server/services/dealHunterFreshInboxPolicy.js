import { createHash } from 'node:crypto';

export const freshInboxAreaIds = Object.freeze([
  'action-preview', 'due-actions', 'owner-priorities', 'new-important',
  'updated', 'research', 'all-active',
]);

const ownerTimeZone = 'America/Los_Angeles';
const ownerDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ownerTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function ownerBusinessDate(value) {
  const parts = Object.fromEntries(ownerDateFormatter.formatToParts(new Date(value))
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function calendarDaysBetween(startDate, endDate) {
  if (!startDate || !endDate) return Number.POSITIVE_INFINITY;
  return (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000;
}

function rankPriority(row) {
  return row.operator_priority === 'urgent' ? 0 : row.operator_priority === 'high' ? 1 : 2;
}

function rankConfidence(row) {
  return row.confidence === 'high' ? 0 : row.confidence === 'medium' ? 1 : 2;
}

function compareId(left, right) {
  return String(left.opportunity_id).localeCompare(String(right.opportunity_id));
}

function compareDue(left, right) {
  return String(left.due_at || '').localeCompare(String(right.due_at || '')) || compareId(left, right);
}

function comparePriority(left, right) {
  return rankPriority(left) - rankPriority(right) || right.fit_score - left.fit_score || compareId(left, right);
}

function compareDiscovery(left, right) {
  return left.discovery_group - right.discovery_group
    || rankPriority(left) - rankPriority(right)
    || String(left.due_at || '\uffff').localeCompare(String(right.due_at || '\uffff'))
    || right.fit_score - left.fit_score
    || rankConfidence(left) - rankConfidence(right)
    || String(right.first_accepted_at || '').localeCompare(String(left.first_accepted_at || ''))
    || compareId(left, right);
}

function compareUpdated(left, right) {
  return String(right.last_material_change_at || '').localeCompare(String(left.last_material_change_at || ''))
    || right.fit_score - left.fit_score || compareId(left, right);
}

function compareAll(left, right) {
  return Number(Boolean(right.first_accepted_at)) - Number(Boolean(left.first_accepted_at))
    || String(right.first_accepted_at || '').localeCompare(String(left.first_accepted_at || ''))
    || right.fit_score - left.fit_score || compareId(left, right);
}

function compareHighestFit(left, right) {
  return right.fit_score - left.fit_score
    || Number(Boolean(right.first_accepted_at)) - Number(Boolean(left.first_accepted_at))
    || String(right.first_accepted_at || '').localeCompare(String(left.first_accepted_at || ''))
    || compareId(left, right);
}

export function freshInboxExplorationSort(area, sort) {
  return ['all-active', 'new-important'].includes(area)
    && ['newest-discovery', 'highest-fit'].includes(sort) ? sort : 'acquisition-priority';
}

function foldRevision(rows, areaId, filtersKey, businessDate) {
  let state = createHash('md5').update(`${areaId}\u0000${filtersKey}\u0000${businessDate}\u0000${rows.length}`).digest('hex');
  for (const row of rows) {
    const tuple = JSON.stringify([
      row.opportunity_id, row.discovery_group, row.fit_score, row.confidence,
      row.operator_priority, row.due_at, row.action_reason, row.first_accepted_at,
      row.discovery_revision, row.material_revision, row.reviewed_discovery_revision,
      row.reviewed_material_revision, row.score_fingerprint, row.semantic_digest,
      row.disposition_state, row.publication_state, row.publication_date,
      row.source_conflict_count, row.material_field, row.source_snapshot_updated_at,
    ]);
    state = createHash('md5').update(`${state}${Buffer.byteLength(tuple)}:${tuple}`).digest('hex');
  }
  return state;
}

export function classifyFreshInboxCandidate(row, asOf, currentBusinessDate = ownerBusinessDate(asOf)) {
  const businessDate = currentBusinessDate;
  const firstDate = row.first_accepted_at ? ownerBusinessDate(row.first_accepted_at) : '';
  const discoveryDays = calendarDaysBetween(firstDate, businessDate);
  const newToUs = (row.discovery_state === 'known_prospective'
    || (row.discovery_state === 'known_recovered' && !row.reviewed_at))
    && discoveryDays >= 0 && discoveryDays <= 7
    && Number(row.reviewed_discovery_revision || 0) < Number(row.discovery_revision || 0);
  const publicationDate = row.publication_date || (row.publication_instant
    ? ownerBusinessDate(row.publication_instant) : '');
  const publicationDays = calendarDaysBetween(publicationDate, businessDate);
  const recentlyListed = row.publication_state === 'valid'
    && Number(row.publication_distinct_count) === 1
    && Number(row.publication_unsupported_count || 0) === 0
    && publicationDays >= 0 && publicationDays <= 30;
  const worthwhile = Number(row.fit_score || 0) >= 75 && row.confidence !== 'low';
  const discoveryGroup = newToUs && worthwhile ? (recentlyListed ? 1 : 2) : 6;
  const updated = Number(row.material_revision || 0) > Number(row.reviewed_material_revision || 0)
    && Boolean(row.last_material_change_at);
  const due = Boolean(row.due_at);
  const ownerPriority = ['urgent', 'high'].includes(row.operator_priority);
  return {
    ...row, discovery_group: discoveryGroup, new_to_ug: newToUs,
    recently_listed: recentlyListed, updated_since_review: updated,
    due_action: due, owner_priority: ownerPriority,
    age_unknown: !recentlyListed && (!publicationDate || row.publication_state !== 'valid'
      || Number(row.publication_distinct_count) !== 1
      || Number(row.publication_unsupported_count || 0) !== 0),
  };
}

export function buildFreshInboxAreas(candidates, { area = 'inbox', cursor = null,
  limit = null, asOf = new Date().toISOString(), filters = {}, sort = 'acquisition-priority' } = {}) {
  const businessDate = ownerBusinessDate(asOf);
  const effectiveSort = freshInboxExplorationSort(area, sort);
  const filtersKey = createHash('sha256').update(JSON.stringify({ ...filters, sort: effectiveSort })).digest('hex');
  const rows = candidates.map((candidate) => classifyFreshInboxCandidate(candidate, asOf, businessDate));
  const due = rows.filter((row) => row.due_action).sort(compareDue);
  const priorities = rows.filter((row) => row.owner_priority).sort(comparePriority);
  const preview = [];
  const used = new Set();
  const take = (items, maximum) => {
    for (const item of items) {
      if (maximum <= 0) break;
      if (used.has(item.opportunity_id)) continue;
      preview.push(item); used.add(item.opportunity_id); maximum -= 1;
    }
  };
  take(due, 2);
  take(priorities, preview.length < 3 ? 1 : 0);
  take([...due, ...priorities], 3 - preview.length);
  const discovery = rows.filter((row) => row.discovery_group <= 2).sort(
    area === 'new-important' && effectiveSort === 'highest-fit'
      ? (left, right) => left.discovery_group - right.discovery_group || compareHighestFit(left, right)
      : area === 'new-important' && effectiveSort === 'newest-discovery'
        ? (left, right) => left.discovery_group - right.discovery_group
          || String(right.first_accepted_at || '').localeCompare(String(left.first_accepted_at || ''))
          || compareId(left, right)
        : compareDiscovery);
  const updated = rows.filter((row) => row.updated_since_review).sort(compareUpdated);
  const research = rows.filter((row) => row.confidence === 'low'
    || row.contradiction_count > 0 || row.source_conflict_count > 0)
    .sort(compareAll);
  const all = [...rows].sort(effectiveSort === 'highest-fit' ? compareHighestFit : compareAll);
  const sets = {
    'action-preview': preview,
    'due-actions': due,
    'owner-priorities': priorities,
    'new-important': discovery,
    updated,
    research,
    'all-active': all,
  };
  const requested = area === 'inbox' ? ['action-preview', 'new-important'] : [area];
  if (requested.some((id) => !freshInboxAreaIds.includes(id))) {
    throw new Error('Unknown Acquisition Inbox area.');
  }
  const areas = requested.map((id) => {
    const full = sets[id];
    const revision = foldRevision(full, id, filtersKey, businessDate);
    if (cursor && (cursor.area !== id || cursor.revision !== revision
      || cursor.businessDate !== businessDate || cursor.filtersKey !== filtersKey
      || !Number.isSafeInteger(cursor.lastOrdinal) || cursor.lastOrdinal < 0
      || cursor.lastOrdinal > full.length
      || (cursor.lastOrdinal > 0 && full[cursor.lastOrdinal - 1]?.opportunity_id !== cursor.lastId))) {
      const error = new Error('Inbox results changed. Refresh this area before continuing.');
      error.code = 'DEAL_HUNTER_STALE_PAGE'; error.status = 409; throw error;
    }
    const start = cursor?.lastOrdinal || 0;
    const pageLimit = id === 'action-preview' ? 3 : id === 'new-important' && area === 'inbox' ? 10
      : Math.max(1, Math.min(Number(limit) || 25, 100));
    const selected = full.slice(start, start + pageLimit);
    const end = start + selected.length;
    return {
      id, rows: selected, total: full.length, revision,
      counts: id === 'action-preview' ? {
        due: due.length, overdue: due.filter((row) => (row.action_reason || 'due_follow_up') === 'due_follow_up'
          && ownerBusinessDate(row.due_at) < businessDate).length,
        ownerPriority: priorities.length, urgent: priorities.filter((row) => row.operator_priority === 'urgent').length,
      } : {},
      nextCursor: end < full.length ? { area: id, revision, businessDate,
        filtersKey, lastOrdinal: end, lastId: selected.at(-1).opportunity_id } : null,
    };
  });
  return { asOf, businessDate, areas, counts: { due: due.length,
    ownerPriority: priorities.length, newImportant: discovery.length } };
}
