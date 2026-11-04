// One email system per deal: the legacy CIM system must not email an
// opportunity that the Pursue → CIM campaign system owns. A Pursue claim is a
// latest owner decision of `pursue`, any current enrollment, or a campaign in
// any state (ended campaigns included). An unreadable projection fails closed.

export const PURSUE_OWNS_OPPORTUNITY = 'pursue_owns_opportunity';
export const PURSUE_AUTHORITY_UNAVAILABLE = 'pursue_authority_unavailable';
export const PURSUE_OWNERSHIP_REFUSAL_CODES = new Set([PURSUE_OWNS_OPPORTUNITY, PURSUE_AUTHORITY_UNAVAILABLE]);
export const PURSUE_OWNERSHIP_REFUSAL_MESSAGE = 'This deal is in a SIM request campaign — manage it from the drawer.';

export async function readPursueOwnership({ storage, opportunityId } = {}) {
  let projection;
  try {
    projection = await storage.readPursueCimProjection({ opportunityId });
  } catch {
    return { owned: true, reason: PURSUE_AUTHORITY_UNAVAILABLE };
  }
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    return { owned: true, reason: PURSUE_AUTHORITY_UNAVAILABLE };
  }
  const owned = projection.decision?.action === 'pursue'
    || (projection.enrollment !== null && projection.enrollment !== undefined)
    || (projection.campaign !== null && projection.campaign !== undefined);
  return owned ? { owned: true, reason: PURSUE_OWNS_OPPORTUNITY } : { owned: false, reason: null };
}

export function isPursueOwnershipRefusalCode(code) {
  return PURSUE_OWNERSHIP_REFUSAL_CODES.has(code);
}

export function pursueOwnershipRefusal(reason, extras = {}) {
  return { ok: false, status: 409, code: reason, error: PURSUE_OWNERSHIP_REFUSAL_MESSAGE, ...extras };
}
