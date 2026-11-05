// The Pursued deals tracker's read side (spec 2026-11-04 §6.1): every pursued deal folded to a
// stage, filtered, sorted and capped, each row carrying the campaign's release status. Reads
// only; nothing here sends or writes.
import { PURSUIT_STAGES } from '../storage/pursuitTrackerStorageContract.js';
import { getPursueCimReleaseReport } from './pursueCimRelease.js';
import { buildGmailThreadUrl, foldPursuitStage, STAGE_LABELS } from './pursuitTracker.js';

export const PURSUED_DEALS_ROW_CAP = 200;
/** Postgres release reports are several reads each, so they run this many at a time. */
export const RELEASE_REPORT_CONCURRENCY = 8;

const NEEDS_ACTION = 'needs-action';
const STAGE_FILTERS = Object.freeze(['all', NEEDS_ACTION, ...PURSUIT_STAGES]);
const stageIndex = (stage) => PURSUIT_STAGES.indexOf(stage);
const time = (instant) => Date.parse(instant);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `fn` over `items`, at most `limit` at a time; results keep the order of `items`. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The three inputs the stop route needs, from a release report.
function releaseOf(report) {
  return {
    status: report.status,
    canStop: report.actions.canStop,
    campaign: report.campaign ? { id: report.campaign.id, state: report.campaign.state,
      rowVersion: report.campaign.rowVersion, terminalRevision: report.campaign.terminalRevision } : null,
  };
}

/**
 * One tracker row. `release` is `{ status, canStop, campaign }`, or null when its report could
 * not be read. Only an admin gets `gmailThreadUrl` and `needsAction.replyId`.
 */
export function buildPursuedDealRow({ bundle, projection, release, role, gmailAddress }) {
  const isAdmin = role === 'admin';
  const { needsAction } = projection;
  const row = {
    opportunityId: bundle.opportunityId,
    name: bundle.name,
    crmSubmissionId: bundle.campaign?.crmSubmissionId ?? null,
    stage: projection.stage,
    stageLabel: STAGE_LABELS[projection.stage],
    stageSince: projection.stageSince,
    stageSource: projection.stageSource,
    lastReplyAt: projection.lastReplyAt,
    needsAction: needsAction && {
      reason: needsAction.reason,
      at: needsAction.at,
      classification: needsAction.classification,
      ...(isAdmin ? { replyId: needsAction.replyId } : {}),
    },
    simDocuments: [...bundle.documents]
      .sort((a, b) => (time(b.createdAt) - time(a.createdAt)) || compareText(a.id, b.id))
      .map((document) => ({ id: document.id, name: document.originalName, sizeBytes: document.sizeBytes,
        uploadedAt: document.createdAt })),
    latestEventId: projection.latestEventId,
    release,
    passedInDealHunter: projection.passedInDealHunter,
    opportunityActive: bundle.opportunityStatus === 'active',
  };
  if (release === null) row.releaseUnavailable = true;
  if (isAdmin) {
    row.gmailThreadUrl = buildGmailThreadUrl({ threadId: bundle.campaign?.gmailThreadId, address: gmailAddress });
  }
  return row;
}

// Needs-action rows first, oldest first; the rest by stage order, then newest stage change first.
function compareMembers(a, b) {
  const aAttention = a.projection.needsAction;
  const bAttention = b.projection.needsAction;
  if (aAttention && bAttention) {
    const order = (time(aAttention.at) - time(bAttention.at)) || compareText(aAttention.replyId, bAttention.replyId);
    if (order) return order;
  } else if (aAttention || bAttention) {
    return aAttention ? -1 : 1;
  }
  return (stageIndex(a.projection.stage) - stageIndex(b.projection.stage))
    || (time(b.projection.stageSince) - time(a.projection.stageSince))
    || compareText(a.bundle.opportunityId, b.bundle.opportunityId);
}

// The owner's mailbox for Gmail links: the active connection, else the configured sender (§7.4).
async function gmailAddressFor({ storage, config }) {
  const connection = await storage.getGmailConnection();
  return connection?.email_address || config?.dealHunter?.gmail?.senderAddress || '';
}

async function releaseFor({ storage, opportunityId, now }) {
  try {
    return releaseOf(await getPursueCimReleaseReport({ storage, opportunityId, now }));
  } catch (error) {
    // Ids and an error name only: a report can hold addresses and copy.
    console.warn('[pursued-deals] release status unavailable', { opportunityId,
      cause: String(error?.code || error?.name || 'Error').slice(0, 100) });
    return null;
  }
}

/**
 * The tracker page: `stage` is `all`, `needs-action` or a stage id. Counts cover every member,
 * whatever the filter; at most 200 rows come back, and `truncated` says more matched.
 */
export async function listPursuedDeals({ storage, config, stage = 'all', role, now = new Date() } = {}) {
  if (!STAGE_FILTERS.includes(stage)) return { ok: false, status: 400, code: 'invalid_stage' };
  const asOf = new Date(now).toISOString();
  const members = (await storage.listPursuitBundles())
    .map((bundle) => ({ bundle, projection: foldPursuitStage(bundle) }))
    .filter((member) => member.projection.member);

  const byStage = Object.fromEntries(PURSUIT_STAGES.map((id) => [id, 0]));
  let needsAction = 0;
  for (const { projection } of members) {
    byStage[projection.stage] += 1;
    if (projection.needsAction) needsAction += 1;
  }

  const matching = members
    .filter(({ projection }) => stage === 'all' || (stage === NEEDS_ACTION ? projection.needsAction !== null
      : projection.stage === stage))
    .sort(compareMembers);
  const page = matching.slice(0, PURSUED_DEALS_ROW_CAP);
  const gmailAddress = await gmailAddressFor({ storage, config });
  const rows = await mapWithConcurrency(page, RELEASE_REPORT_CONCURRENCY, async ({ bundle, projection }) =>
    buildPursuedDealRow({ bundle, projection, role, gmailAddress,
      release: await releaseFor({ storage, opportunityId: bundle.opportunityId, now: asOf }) }));
  return { ok: true, status: 200, asOf, counts: { needsAction, byStage }, rows,
    truncated: matching.length > PURSUED_DEALS_ROW_CAP };
}

/** One opportunity's row, or null when it is not a tracker member. */
export async function getPursuedDealRow({ storage, config, opportunityId, role, now = new Date() } = {}) {
  const [bundle] = await storage.listPursuitBundles({ opportunityIds: [opportunityId] });
  if (!bundle) return null;
  const projection = foldPursuitStage(bundle);
  if (!projection.member) return null;
  return buildPursuedDealRow({ bundle, projection, role,
    gmailAddress: await gmailAddressFor({ storage, config }),
    release: await releaseFor({ storage, opportunityId, now: new Date(now).toISOString() }) });
}
