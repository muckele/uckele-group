import { getStorage } from '../storage/index.js';

export function normalizeCurrentUnlinkedRestore(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'actor,at,expectedCampaignAuthorityRevision,opportunityId,passId,passUpdatedAt'
    || typeof input.passId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.passId)
    || !Number.isSafeInteger(input.expectedCampaignAuthorityRevision) || input.expectedCampaignAuthorityRevision < 1
    || ['opportunityId', 'passId', 'actor'].some((key) => typeof input[key] !== 'string' || !input[key].trim()
      || input[key] !== input[key].trim() || input[key].length > 200)
    || ['passUpdatedAt', 'at'].some((key) => typeof input[key] !== 'string' || input[key].length > 80 || !Number.isFinite(Date.parse(input[key])))) {
    throw new Error('Current opportunity and exact Pass revision are required.');
  }
  return input;
}

export async function restoreCurrentUnlinkedOpportunity({ opportunityId, expectedCampaignAuthorityRevision,
  passId, passUpdatedAt, actor, storage = getStorage() }) {
  let input;
  try { input = normalizeCurrentUnlinkedRestore({ opportunityId, expectedCampaignAuthorityRevision, passId,
    passUpdatedAt, actor, at: new Date().toISOString() }); }
  catch (error) { return { ok: false, status: 400, error: error.message }; }
  if (!storage.restoreCurrentUnlinkedOpportunity) return { ok: false, status: 503, error: 'Current Restore storage is unavailable.' };
  const result = await storage.restoreCurrentUnlinkedOpportunity(input);
  return result.applied ? { ok: true, status: 200, ...result }
    : { ok: false, status: 409, error: 'Restore authority changed. Reload and review the current Pass before trying again.' };
}
