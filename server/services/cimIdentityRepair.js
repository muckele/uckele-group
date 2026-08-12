import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';
import {
  buildCimOpportunityAliases,
  buildCimOpportunityRecord,
  CIM_IDENTITY_EVIDENCE_VERSION,
  compareCimOpportunityEvidence,
  getCimOutreachPauseStatus,
  logicalCimTouchesForRecipient,
  normalizeCimRecipient,
} from './cimOpportunityIdentity.js';

const auditLimit = 10_000;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function deterministicUuid(value) {
  const hex = sha256(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function redactedRecipient(email) {
  const normalized = normalizeCimRecipient(email);
  return normalized ? `recipient-${sha256(normalized).slice(0, 12)}` : 'recipient-missing';
}

function requestDeal(request = {}) {
  const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  return {
    dealKey: request.deal_key,
    dealKeyAliases: metadata.dealKeyAliases || [],
    name: request.deal_name,
    description: metadata.description || '',
    brokerEmail: request.recipient_email,
    listingUrl: request.listing_url,
    location: metadata.location || '',
    city: metadata.city || '',
    county: metadata.county || '',
    state: metadata.state || '',
    country: metadata.country || '',
    askingPrice: metadata.askingPrice,
    annualRevenue: metadata.annualRevenue,
    annualProfit: metadata.annualProfit,
    sourceId: metadata.sourceId || request.source_name || '',
    sourceName: request.source_name || '',
    identityAliases: metadata.identityAliases || [],
    stableExternalId: Boolean(metadata.stableExternalId),
  };
}

function comparableOpportunity(deal) {
  return buildCimOpportunityRecord(deal, 'comparison', '2000-01-01T00:00:00.000Z');
}

function unionFind(length) {
  const parents = Array.from({ length }, (_, index) => index);
  const find = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  return {
    find,
    union(left, right) {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
    },
  };
}

function buildIdentityGroups(requests) {
  const deals = requests.map(requestDeal);
  const aliases = deals.map(buildCimOpportunityAliases);
  const aliasOwners = new Map();
  const opportunityOwners = new Map();
  const union = unionFind(requests.length);
  requests.forEach((request, index) => {
    if (!request.opportunity_id) return;
    const owner = opportunityOwners.get(request.opportunity_id);
    if (owner !== undefined) union.union(owner, index);
    else opportunityOwners.set(request.opportunity_id, index);
  });
  for (const [index, items] of aliases.entries()) {
    for (const item of items) {
      const owner = aliasOwners.get(item.alias_key);
      if (owner !== undefined) union.union(owner, index);
      else aliasOwners.set(item.alias_key, index);
    }
  }
  const candidateBuckets = new Map();
  for (const [index, deal] of deals.entries()) {
    const key = `${String(deal.name || '').trim().toLowerCase()}|${normalizeCimRecipient(deal.brokerEmail)}`;
    if (!key.endsWith('|')) candidateBuckets.set(key, [...(candidateBuckets.get(key) || []), index]);
  }
  const ambiguousPairs = [];
  const distinctPairs = [];
  const highConfidencePairs = [];
  for (const indexes of candidateBuckets.values()) {
    for (let leftOffset = 0; leftOffset < indexes.length; leftOffset += 1) {
      for (let rightOffset = leftOffset + 1; rightOffset < indexes.length; rightOffset += 1) {
        const left = indexes[leftOffset];
        const right = indexes[rightOffset];
        if (union.find(left) === union.find(right)) continue;
        const comparison = compareCimOpportunityEvidence(deals[left], comparableOpportunity(deals[right]));
        const pair = {
          leftRequestId: requests[left].id,
          rightRequestId: requests[right].id,
          evidence: comparison.evidence,
        };
        if (comparison.automatic) {
          const leftRoot = union.find(left);
          const rightRoot = union.find(right);
          const leftMembers = deals.map((_, index) => index).filter((index) => union.find(index) === leftRoot);
          const rightMembers = deals.map((_, index) => index).filter((index) => union.find(index) === rightRoot);
          const clustersMatchDirectly = leftMembers.every((leftMember) => rightMembers.every((rightMember) => (
            compareCimOpportunityEvidence(deals[leftMember], comparableOpportunity(deals[rightMember])).automatic
          )));
          if (clustersMatchDirectly) {
            union.union(left, right);
            highConfidencePairs.push(pair);
          } else {
            ambiguousPairs.push({ ...pair, reason: 'unsafe-transitive-cluster' });
          }
        } else if (comparison.materiallyDistinct) distinctPairs.push(pair);
        else if (comparison.ambiguous) ambiguousPairs.push(pair);
      }
    }
  }
  const grouped = new Map();
  requests.forEach((request, index) => {
    const root = union.find(index);
    grouped.set(root, [...(grouped.get(root) || []), { request, deal: deals[index], aliases: aliases[index] }]);
  });
  const requestIndexes = new Map(requests.map((request, index) => [request.id, index]));
  const finalClusterPairKey = (pair) => {
    const left = requestIndexes.get(pair.leftRequestId);
    const right = requestIndexes.get(pair.rightRequestId);
    if (left === undefined || right === undefined) return '';
    const roots = [union.find(left), union.find(right)].sort((a, b) => a - b);
    return roots[0] === roots[1] ? '' : roots.join(':');
  };
  const finalDistinctPairs = distinctPairs.filter((pair) => finalClusterPairKey(pair));
  const distinctClusterPairs = new Set(finalDistinctPairs.map(finalClusterPairKey));
  const finalAmbiguousPairs = ambiguousPairs.filter((pair) => {
    const key = finalClusterPairKey(pair);
    return key && !distinctClusterPairs.has(key);
  });
  return {
    groups: [...grouped.values()],
    ambiguousPairs: finalAmbiguousPairs,
    distinctPairs: finalDistinctPairs,
    highConfidencePairs,
  };
}

function normalizeHistoricalResolutions(resolutions = [], audit) {
  const requests = new Map(audit._data.requests.map((request) => [request.id, request]));
  const ambiguousPairs = new Set(audit.ambiguousPairs.flatMap((pair) => [
    `${pair.leftRequestId}:${pair.rightRequestId}`,
    `${pair.rightRequestId}:${pair.leftRequestId}`,
  ]));
  const persistedDecisions = new Map(audit._data.repairManifests.flatMap((record) => (
    Array.isArray(record.manifest?.historicalResolutions) ? record.manifest.historicalResolutions : []
  )).map((resolution) => [
    `${resolution.action}:${[resolution.requestId, resolution.targetRequestId].sort().join(':')}`,
    resolution,
  ]));
  const normalized = [];
  const claimedRequests = new Set();
  const claimedPairs = new Set();
  for (const value of Array.isArray(resolutions) ? resolutions : []) {
    const action = String(value?.action || '').trim();
    const requestId = String(value?.requestId || '').trim();
    const targetRequestId = String(value?.targetRequestId || '').trim();
    const reason = String(value?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const authorizedBy = String(value?.authorizedBy || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!['link', 'keep-distinct'].includes(action) || !requestId || !targetRequestId || requestId === targetRequestId) {
      throw new Error('Historical resolution refused: each decision must link or keep distinct two different audited request IDs.');
    }
    if (!requests.has(requestId) || !requests.has(targetRequestId)) {
      throw new Error('Historical resolution refused: every request ID must exist in the bounded audit dataset.');
    }
    const persistedDecision = persistedDecisions.get(`${action}:${[requestId, targetRequestId].sort().join(':')}`);
    if (!ambiguousPairs.has(`${requestId}:${targetRequestId}`) && !persistedDecision) {
      throw new Error('Historical resolution refused: the selected pair is not an ambiguous pair from this audit.');
    }
    if (!ambiguousPairs.has(`${requestId}:${targetRequestId}`) && (
      persistedDecision.reason !== reason || persistedDecision.authorizedBy !== authorizedBy
    )) {
      throw new Error('Historical resolution refused: a resolved pair may only replay its exact authorized decision.');
    }
    if (reason.length < 20 || authorizedBy.length < 2 || value?.incidentOwnerAuthorized !== true) {
      throw new Error('Historical resolution refused: incident-owner authorization, an accountable actor, and a specific reason are required.');
    }
    if (action === 'link' && claimedRequests.has(requestId)) {
      throw new Error('Historical resolution refused: a request may appear as the resolved request only once.');
    }
    const pairKey = [requestId, targetRequestId].sort().join(':');
    if (claimedPairs.has(`${action}:${pairKey}`)) {
      throw new Error('Historical resolution refused: duplicate request-pair decision.');
    }
    if (action === 'link') claimedRequests.add(requestId);
    claimedPairs.add(`${action}:${pairKey}`);
    normalized.push({
      action,
      requestId,
      targetRequestId,
      reason,
      authorizedBy,
      incidentOwnerAuthorized: true,
    });
  }
  return normalized;
}

function mergeIdentityGroups(groups, resolutions = []) {
  if (resolutions.length === 0) return groups;
  const parents = Array.from({ length: groups.length }, (_, index) => index);
  const find = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const requestGroups = new Map();
  groups.forEach((group, index) => {
    for (const entry of group) requestGroups.set(entry.request.id, index);
  });
  for (const resolution of resolutions) {
    if (resolution.action !== 'link') continue;
    const left = requestGroups.get(resolution.requestId);
    const right = requestGroups.get(resolution.targetRequestId);
    if (left === undefined || right === undefined) throw new Error('Historical resolution refused: audited request group is unavailable.');
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  }
  const merged = new Map();
  groups.forEach((group, index) => {
    const root = find(index);
    merged.set(root, [...(merged.get(root) || []), ...group]);
  });
  return [...merged.values()];
}

function unresolvedAmbiguousPairs(audit, resolutions = []) {
  if (audit.ambiguousPairs.length === 0) return [];
  const groups = audit._identityGroups;
  const parents = Array.from({ length: groups.length }, (_, index) => index);
  const find = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const requestGroups = new Map();
  groups.forEach((group, index) => {
    for (const entry of group) requestGroups.set(entry.request.id, index);
  });
  for (const resolution of resolutions) {
    if (resolution.action !== 'link') continue;
    const left = find(requestGroups.get(resolution.requestId));
    const right = find(requestGroups.get(resolution.targetRequestId));
    if (left !== right) parents[right] = left;
  }
  const pairKey = (leftRequestId, rightRequestId) => {
    const leftGroup = requestGroups.get(leftRequestId);
    const rightGroup = requestGroups.get(rightRequestId);
    if (leftGroup === undefined || rightGroup === undefined) return '';
    const roots = [find(leftGroup), find(rightGroup)].sort((a, b) => a - b);
    return roots[0] === roots[1] ? '' : roots.join(':');
  };
  const distinctClusters = new Set(audit.materiallyDistinctPairs.map((pair) => (
    pairKey(pair.leftRequestId, pair.rightRequestId)
  )).filter(Boolean));
  for (const resolution of resolutions) {
    if (resolution.action !== 'keep-distinct') continue;
    const key = pairKey(resolution.requestId, resolution.targetRequestId);
    if (!key) throw new Error('Historical resolution refused: the same requests cannot be linked and kept distinct.');
    distinctClusters.add(key);
  }
  return audit.ambiguousPairs.filter((pair) => {
    const key = pairKey(pair.leftRequestId, pair.rightRequestId);
    return key && !distinctClusters.has(key);
  });
}

function isActiveSequence(request) {
  return Boolean(request.next_follow_up_at)
    || ['scheduled', 'pending', 'sending'].includes(request.follow_up_state)
    || request.status === 'follow_up_pending';
}

function isAccepted(request) {
  return Boolean(request.first_provider_accepted_at || request.provider_message_id)
    || ['provider_accepted', 'responded'].includes(request.request_state)
    || ['sent', 'logged', 'responded'].includes(request.status);
}

function requestSort(left, right) {
  return Date.parse(left.first_provider_accepted_at || left.first_requested_at || left.created_at || '')
    - Date.parse(right.first_provider_accepted_at || right.first_requested_at || right.created_at || '')
    || String(left.id).localeCompare(String(right.id));
}

async function loadAuditData(storage) {
  const requests = await storage.listDealHunterCimRequests({ limit: auditLimit });
  const recipientEmails = [...new Set(requests.map((request) => normalizeCimRecipient(request.recipient_email)).filter(Boolean))];
  const submissionIds = [...new Set(requests.map((request) => request.submission_id).filter(Boolean))];
  const communications = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await storage.listCrmCommunications({ page, pageSize: 100 });
    communications.push(...(result.rows || []));
    if (communications.length >= Number(result.total || 0) || result.rows?.length < 100) break;
  }
  return {
    requests,
    opportunities: await storage.listDealHunterOpportunities({ limit: auditLimit }),
    aliases: await storage.listDealHunterOpportunityAliases({ limit: auditLimit }),
    repairManifests: await storage.listDealHunterCimRepairManifests?.({ limit: 1000 }) || [],
    imports: await storage.listDealHunterCrmImports?.({ limit: auditLimit }) || [],
    communications,
    emailEvents: recipientEmails.length > 0
      ? await storage.listEmailEventsForRecipients(recipientEmails, auditLimit)
      : [],
    activities: submissionIds.length > 0
      ? (await Promise.all(submissionIds.map((id) => storage.listCrmActivityEvents({ submissionId: id, limit: 500 })))).flat()
      : [],
  };
}

function existingOpportunityForGroup(group, opportunitiesById, aliasesByKey) {
  const candidates = new Set(group.map(({ request }) => request.opportunity_id).filter(Boolean));
  for (const item of group.flatMap((entry) => entry.aliases)) {
    const owner = aliasesByKey.get(item.alias_key)?.opportunity_id;
    if (owner) candidates.add(owner);
  }
  const existing = [...candidates].map((id) => opportunitiesById.get(id)).filter(Boolean)
    .sort((left, right) => Date.parse(left.created_at || '') - Date.parse(right.created_at || '') || left.opportunity_id.localeCompare(right.opportunity_id));
  return existing[0] || null;
}

function groupPlan(group, data, nowIso, actor, historicalResolutions = []) {
  const opportunitiesById = new Map(data.opportunities.map((item) => [item.opportunity_id, item]));
  const aliasesByKey = new Map(data.aliases.map((item) => [item.alias_key, item]));
  const requests = group.map((item) => item.request).sort(requestSort);
  const accepted = requests.filter(isAccepted);
  const owner = accepted[0] || requests[0];
  const existingOpportunity = existingOpportunityForGroup(group, opportunitiesById, aliasesByKey);
  const opportunityId = existingOpportunity?.opportunity_id || `opp_repair_${sha256(requests.map((item) => item.id).sort().join('|')).slice(0, 32)}`;
  const submissionIds = [...new Set(requests.map((item) => item.submission_id).filter(Boolean))];
  const primarySubmissionId = existingOpportunity?.primary_submission_id || owner?.submission_id || submissionIds[0] || '';
  const groupByRequestId = new Map(group.map((entry) => [entry.request.id, entry]));
  let accumulatedOpportunity = existingOpportunity;
  for (const request of requests) {
    accumulatedOpportunity = buildCimOpportunityRecord(
      groupByRequestId.get(request.id)?.deal || requestDeal(request),
      opportunityId,
      nowIso,
      accumulatedOpportunity,
    );
  }
  const opportunityRecord = {
    ...accumulatedOpportunity,
    primary_submission_id: primarySubmissionId || null,
    metadata: {
      ...(existingOpportunity?.metadata || {}),
      ...(accumulatedOpportunity?.metadata || {}),
      repairRequestIds: requests.map((item) => item.id),
      legacyOpportunityIds: [...new Set(requests.map((item) => item.opportunity_id).filter((id) => id && id !== opportunityId))],
      historicalResolutionDecisions: historicalResolutions.map((resolution) => ({
        action: resolution.action,
        requestId: resolution.requestId,
        targetRequestId: resolution.targetRequestId,
        reason: resolution.reason,
        authorizedBy: resolution.authorizedBy,
      })),
    },
  };
  const aliasRecords = group.flatMap((entry) => entry.aliases).map((item) => ({
    id: sha256(`cim-opportunity-alias:${item.alias_key}`),
    opportunity_id: opportunityId,
    alias_type: item.alias_type,
    alias_value: item.alias_value,
    alias_key: item.alias_key,
    source: item.source || null,
    first_observed_at: requests[0].created_at || nowIso,
    last_observed_at: nowIso,
    evidence_version: CIM_IDENTITY_EVIDENCE_VERSION,
    resolution_method: 'historical-repair',
    confidence_state: 'high',
    resolved_by: actor,
    metadata: { repair: true },
  }));
  for (const resolution of historicalResolutions) {
    const request = requests.find((item) => item.id === resolution.requestId);
    const legacyDealKey = String(request?.deal_key || '').trim();
    if (!legacyDealKey) continue;
    const aliasKey = `deal-key:${legacyDealKey}`;
    aliasRecords.push({
      id: sha256(`cim-opportunity-alias:${aliasKey}`),
      opportunity_id: opportunityId,
      alias_type: 'deal-key',
      alias_value: legacyDealKey,
      alias_key: aliasKey,
      source: request.source_name || 'manual-historical-resolution',
      first_observed_at: request.created_at || nowIso,
      last_observed_at: nowIso,
      evidence_version: CIM_IDENTITY_EVIDENCE_VERSION,
      resolution_method: 'manual-historical-link',
      confidence_state: 'manual',
      resolved_by: resolution.authorizedBy,
      metadata: {
        repair: true,
        reason: resolution.reason,
        targetRequestId: resolution.targetRequestId,
        incidentOwnerAuthorized: true,
      },
    });
  }
  const uniqueAliasRecords = aliasRecords.filter((item, index, all) => (
    all.findIndex((candidate) => candidate.alias_key === item.alias_key) === index
  ));
  const requestLinks = requests.map((request) => ({
    id: request.id,
    opportunity_id: opportunityId,
    submission_id: primarySubmissionId || null,
    expected_updated_at: request.updated_at,
    updated_at: nowIso,
  }));
  const stopRequests = requests.filter((request) => request.id !== owner.id && isActiveSequence(request)).map((request) => ({
    id: request.id,
    updated_at: nowIso,
    metadata: {
      ...(request.metadata || {}),
      canonicalRepair: {
        stoppedAt: nowIso,
        stoppedBy: actor,
        reason: 'duplicate-active-canonical-sequence',
        ownerRequestId: owner.id,
        opportunityId,
      },
    },
  }));
  return {
    opportunityId,
    opportunityRecord,
    aliasRecords: uniqueAliasRecords,
    requestLinks,
    stopRequests,
    ownerRequestId: owner.id,
    primarySubmissionId,
    duplicateSubmissionIds: submissionIds.filter((id) => id !== primarySubmissionId),
  };
}

function buildLinkPlan(groupPlans, data, nowIso, actor) {
  const requestPlan = new Map();
  for (const plan of groupPlans) {
    for (const link of plan.requestLinks) requestPlan.set(link.id, plan);
  }
  const communicationLinks = [];
  const communicationPlan = new Map();
  for (const communication of data.communications) {
    const plan = requestPlan.get(communication.cim_request_id);
    if (!plan) continue;
    const link = {
      id: communication.id,
      opportunity_id: plan.opportunityId,
      submission_id: plan.primarySubmissionId || communication.submission_id,
      expected_updated_at: communication.updated_at,
      updated_at: nowIso,
    };
    communicationLinks.push(link);
    communicationPlan.set(communication.id, plan);
    if (communication.provider_message_id) communicationPlan.set(`message:${communication.provider_message_id}`, plan);
  }
  const emailEventLinks = data.emailEvents.flatMap((event) => {
    const plan = communicationPlan.get(event.communication_id)
      || communicationPlan.get(`message:${event.message_id}`);
    return plan ? [{ id: event.id, opportunity_id: plan.opportunityId, submission_id: plan.primarySubmissionId || event.submission_id }] : [];
  });
  const activityLinks = data.activities.flatMap((event) => {
    const requestId = event.metadata?.cimRequestId || event.metadata?.cim_request_id;
    const communicationId = event.metadata?.communicationId || event.metadata?.communication_id;
    const plan = requestPlan.get(requestId) || communicationPlan.get(communicationId);
    return plan ? [{ id: event.id, opportunity_id: plan.opportunityId, submission_id: plan.primarySubmissionId || event.submission_id }] : [];
  });
  const importLinks = data.imports.flatMap((record) => {
    const plan = [...groupPlans].find((candidate) => candidate.requestLinks.some((link) => {
      const request = data.requests.find((item) => item.id === link.id);
      return request?.deal_key === record.deal_key || (record.listing_identity && request?.listing_url === record.listing_url);
    }));
    return plan ? [{
      id: record.id,
      opportunity_id: plan.opportunityId,
      submission_id: plan.primarySubmissionId || record.submission_id,
      expected_updated_at: record.updated_at,
      updated_at: nowIso,
    }] : [];
  });
  const repairActivities = groupPlans.flatMap((plan) => plan.primarySubmissionId ? [{
    id: deterministicUuid(`cim-identity-repair:${plan.opportunityId}:${plan.ownerRequestId}`),
    submission_id: plan.primarySubmissionId,
    opportunity_id: plan.opportunityId,
    created_at: nowIso,
    actor,
    role: 'admin',
    event_type: 'cim.identity-repaired',
    summary: 'Canonical CIM opportunity identity and historical relationships were reconciled.',
    metadata: {
      evidenceVersion: CIM_IDENTITY_EVIDENCE_VERSION,
      ownerRequestId: plan.ownerRequestId,
      duplicateSubmissionIds: plan.duplicateSubmissionIds,
    },
  }] : []);
  return { communicationLinks, emailEventLinks, activityLinks, importLinks, repairActivities };
}

export async function auditCimIdentity({ storage = getStorage(), now = new Date() } = {}) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const data = await loadAuditData(storage);
  const identity = buildIdentityGroups(data.requests);
  const persistedHistoricalResolutions = data.repairManifests.flatMap((record) => (
    Array.isArray(record.manifest?.historicalResolutions) ? record.manifest.historicalResolutions : []
  ));
  const manuallyDistinctKeys = new Map(persistedHistoricalResolutions
    .filter((resolution) => resolution?.action === 'keep-distinct')
    .map((resolution) => [[resolution.requestId, resolution.targetRequestId].sort().join(':'), resolution]));
  const manuallyDistinctPairs = identity.ambiguousPairs.flatMap((pair) => {
    const decision = manuallyDistinctKeys.get([pair.leftRequestId, pair.rightRequestId].sort().join(':'));
    return decision ? [{ ...pair, decision: {
      action: 'keep-distinct',
      authorizedBy: decision.authorizedBy,
      reason: decision.reason,
    } }] : [];
  });
  identity.ambiguousPairs = identity.ambiguousPairs.filter((pair) => (
    !manuallyDistinctKeys.has([pair.leftRequestId, pair.rightRequestId].sort().join(':'))
  ));
  const aliasOwners = new Map(data.aliases.map((aliasRecord) => [aliasRecord.alias_key, aliasRecord.opportunity_id]));
  const requestCanonicalLinks = data.requests.map((request) => {
    const owners = [...new Set(buildCimOpportunityAliases(requestDeal(request))
      .map((item) => aliasOwners.get(item.alias_key))
      .filter(Boolean))];
    return {
      request,
      owners,
      missing: !request.opportunity_id,
      safelyRepairable: !request.opportunity_id && owners.length === 1,
      conflicting: Boolean(request.opportunity_id && owners.length === 1 && owners[0] !== request.opportunity_id),
    };
  });
  const missingOpportunityLinks = requestCanonicalLinks.filter((item) => item.missing).length;
  const safelyRepairableRequestLinks = requestCanonicalLinks.filter((item) => item.safelyRepairable).length;
  const requestCanonicalLinkIssues = requestCanonicalLinks.filter((item) => item.safelyRepairable || item.conflicting).length;
  const groups = identity.groups.map((group) => {
    const requests = group.map((item) => item.request).sort(requestSort);
    const providerIds = new Set();
    for (const request of requests) {
      if (request.provider_message_id) providerIds.add(request.provider_message_id);
      for (const id of request.metadata?.providerMessageIds || []) if (id) providerIds.add(id);
    }
    return {
      requestIds: requests.map((item) => item.id),
      requestCount: requests.length,
      acceptedRequestCount: requests.filter(isAccepted).length,
      activeSequenceCount: requests.filter(isActiveSequence).length,
      submissionCount: new Set(requests.map((item) => item.submission_id).filter(Boolean)).size,
      providerMessageCount: providerIds.size,
      recipientRef: redactedRecipient(requests[0]?.recipient_email),
      fingerprintToUrlTransition: group.some((item) => !item.deal.listingUrl)
        && group.some((item) => Boolean(item.deal.listingUrl)),
    };
  });
  const recipientPolicies = [];
  const recipientGroups = new Map();
  for (const request of data.requests) {
    const recipient = normalizeCimRecipient(request.recipient_email);
    if (recipient) recipientGroups.set(recipient, [...(recipientGroups.get(recipient) || []), request]);
  }
  const config = getConfig();
  for (const [recipient, requests] of recipientGroups) {
    const touches = logicalCimTouchesForRecipient(requests, recipient);
    const recent30 = touches.filter((touch) => Date.parse(touch.occurredAt || '') >= Date.parse(nowIso) - 30 * 24 * 60 * 60 * 1000);
    if (recent30.length > config.dealHunter.cimOutreach.recipientCap30Days) {
      recipientPolicies.push({ recipientRef: redactedRecipient(recipient), logicalTouches30Days: recent30.length });
    }
  }
  const providerMessageIds = new Set(data.emailEvents.map((event) => event.message_id).filter(Boolean));
  const logicalMessageKeys = new Set(data.emailEvents.map((event) => {
    if (event.communication_id) return `communication:${event.communication_id}`;
    if (event.provider && event.message_id) return `provider:${event.provider}:${event.message_id}`;
    return `event:${event.id}`;
  }));
  const requestById = new Map(data.requests.map((request) => [request.id, request]));
  const communicationById = new Map(data.communications.map((communication) => [communication.id, communication]));
  const primarySubmissionByRequest = new Map();
  for (const group of identity.groups) {
    const requests = group.map((item) => item.request).sort(requestSort);
    const owner = requests.filter(isAccepted)[0] || requests[0];
    const primarySubmissionId = owner?.submission_id || requests.find((item) => item.submission_id)?.submission_id || '';
    for (const request of requests) primarySubmissionByRequest.set(request.id, primarySubmissionId);
  }
  const primarySubmissionByCommunication = new Map();
  let linkageMismatches = requestCanonicalLinkIssues;
  for (const communication of data.communications) {
    const request = requestById.get(communication.cim_request_id);
    if (!request) continue;
    const primarySubmissionId = primarySubmissionByRequest.get(request.id) || '';
    primarySubmissionByCommunication.set(communication.id, primarySubmissionId);
    if ((request.opportunity_id && communication.opportunity_id !== request.opportunity_id)
      || (primarySubmissionId && communication.submission_id !== primarySubmissionId)) linkageMismatches += 1;
  }
  for (const event of data.emailEvents) {
    const communication = communicationById.get(event.communication_id);
    if (!communication) continue;
    const primarySubmissionId = primarySubmissionByCommunication.get(communication.id) || '';
    if ((communication.opportunity_id && event.opportunity_id !== communication.opportunity_id)
      || (primarySubmissionId && event.submission_id !== primarySubmissionId)) linkageMismatches += 1;
  }
  return {
    generatedAt: nowIso,
    evidenceVersion: CIM_IDENTITY_EVIDENCE_VERSION,
    counts: {
      requests: data.requests.length,
      canonicalGroups: groups.length,
      multiRequestGroups: groups.filter((group) => group.requestCount > 1).length,
      duplicateActiveSequences: groups.filter((group) => group.activeSequenceCount > 1).length,
      duplicateCrmSubmissionGroups: groups.filter((group) => group.submissionCount > 1).length,
      fingerprintToUrlCandidates: identity.highConfidencePairs.length
        + groups.filter((group) => group.fingerprintToUrlTransition).length,
      materiallyDistinctPairs: identity.distinctPairs.length,
      manuallyDistinctPairs: manuallyDistinctPairs.length,
      ambiguousPairs: identity.ambiguousPairs.length,
      recipientCapExcesses: recipientPolicies.length,
      rawLifecycleEvents: data.emailEvents.length,
      logicalMessages: logicalMessageKeys.size,
      distinctProviderMessages: providerMessageIds.size,
      missingOpportunityLinks,
      safelyRepairableRequestLinks,
      linkageMismatches,
    },
    groups: groups.filter((group) => group.requestCount > 1).slice(0, 100),
    ambiguousPairs: identity.ambiguousPairs.slice(0, 100),
    materiallyDistinctPairs: identity.distinctPairs.slice(0, 100),
    manuallyDistinctPairs: manuallyDistinctPairs.slice(0, 100),
    recipientPolicies: recipientPolicies.slice(0, 100),
    _data: data,
    _identityGroups: identity.groups,
  };
}

function publicAudit(audit) {
  const { _data, _identityGroups, ...safe } = audit;
  return safe;
}

export async function runCimIdentityRepair({
  apply = false,
  confirmation = '',
  backupReference = '',
  backupVerified = false,
  actor = '',
  historicalResolutions = [],
  storage = getStorage(),
  now = new Date(),
} = {}) {
  const audit = await auditCimIdentity({ storage, now });
  const normalizedResolutions = normalizeHistoricalResolutions(historicalResolutions, audit);
  const remainingAmbiguousPairs = unresolvedAmbiguousPairs(audit, normalizedResolutions);
  const resolutionPreview = {
    decisions: normalizedResolutions,
    ambiguousPairsBefore: audit.ambiguousPairs.length,
    ambiguousPairsRemaining: remainingAmbiguousPairs.length,
  };
  if (!apply) {
    return { ok: true, mode: 'dry-run', applied: false, audit: publicAudit(audit), resolutionPreview };
  }
  if (confirmation !== 'APPLY-CIM-IDENTITY-REPAIR') {
    throw new Error('Apply refused: pass the exact confirmation APPLY-CIM-IDENTITY-REPAIR.');
  }
  if (!backupReference || !backupVerified) {
    throw new Error('Apply refused: a verified backup reference is required.');
  }
  if (!String(actor || '').trim()) throw new Error('Apply refused: an accountable actor is required.');
  if (!storage.applyDealHunterCimIdentityRepair) throw new Error('Atomic CIM identity repair storage is unavailable.');
  if (remainingAmbiguousPairs.length > 0) {
    throw new Error('Apply refused: unresolved ambiguous historical identity pairs require explicit incident-owner decisions.');
  }
  const health = await storage.checkHealth?.();
  if (!health?.ok) throw new Error('Apply refused: storage health check did not pass.');
  const pause = await getCimOutreachPauseStatus({ storage });
  if (!pause.paused) throw new Error('Apply refused: pause all Deal Hunter CIM outreach before changing canonical relationships.');

  const nowIso = audit.generatedAt;
  const existingAliases = new Map(audit._data.aliases.map((item) => [item.alias_key, item.opportunity_id]));
  const plannedGroups = mergeIdentityGroups(audit._identityGroups, normalizedResolutions);
  const groupPlans = plannedGroups.map((group) => {
    const groupRequestIds = new Set(group.map((entry) => entry.request.id));
    return groupPlan(
      group,
      audit._data,
      nowIso,
      actor,
      normalizedResolutions.filter((resolution) => (
        groupRequestIds.has(resolution.requestId) && groupRequestIds.has(resolution.targetRequestId)
      )),
    );
  });
  const links = buildLinkPlan(groupPlans, audit._data, nowIso, actor);
  const planSummary = {
    evidenceVersion: CIM_IDENTITY_EVIDENCE_VERSION,
    generatedAt: nowIso,
    historicalResolutions: normalizedResolutions,
    opportunityIds: groupPlans.map((plan) => plan.opportunityId).sort(),
    requestIds: groupPlans.flatMap((plan) => plan.requestLinks.map((link) => link.id)).sort(),
    duplicateRequestIds: groupPlans.flatMap((plan) => plan.requestLinks
      .filter((item) => item.id !== plan.ownerRequestId)
      .map((item) => item.id)).sort(),
    linkageCounts: Object.fromEntries(Object.entries(links).map(([key, value]) => [key, value.length])),
  };
  const stablePlanIdentity = { ...planSummary };
  delete stablePlanIdentity.generatedAt;
  const checksum = sha256(stableJson(stablePlanIdentity));
  const manifestId = `cim-repair-${checksum}`;
  const prior = (await storage.listDealHunterCimRepairManifests?.({ limit: 1000 }) || []).find((item) => item.id === manifestId);
  if (prior) return { ok: true, mode: 'apply', applied: false, alreadyApplied: true, manifest: prior, audit: publicAudit(audit) };
  const aliasRecords = groupPlans.flatMap((plan) => plan.aliasRecords);
  const aliasReassignments = aliasRecords.flatMap((alias) => {
    const before = existingAliases.get(alias.alias_key);
    return before && before !== alias.opportunity_id ? [{ alias_key: alias.alias_key, before_opportunity_id: before, opportunity_id: alias.opportunity_id }] : [];
  });
  if (aliasReassignments.length > 0) {
    throw new Error('Apply refused: existing aliases point at multiple canonical opportunities. Resolve that bounded exception manually before repair.');
  }
  const manifest = {
    id: manifestId,
    created_at: nowIso,
    updated_at: nowIso,
    mode: 'apply',
    status: 'applied',
    actor: String(actor).trim().slice(0, 160),
    backup_reference: String(backupReference).slice(0, 500),
    checksum,
    manifest: {
      ...planSummary,
      before: publicAudit(audit).counts,
      afterPlan: {
        opportunityIds: groupPlans.map((plan) => plan.opportunityId),
        requestLinks: groupPlans.flatMap((plan) => plan.requestLinks),
        communicationLinks: links.communicationLinks,
        emailEventLinks: links.emailEventLinks,
        activityLinks: links.activityLinks,
        importLinks: links.importLinks,
      },
      rollback: {
        procedure: 'Pause CIM outreach, verify the original backup, and use this manifest to apply compensating relationship updates. Do not delete provider events.',
        requestLinks: groupPlans.flatMap((plan) => plan.requestLinks.map((link) => ({
          id: link.id,
          beforeOpportunityId: audit._data.requests.find((item) => item.id === link.id)?.opportunity_id || null,
          beforeSubmissionId: audit._data.requests.find((item) => item.id === link.id)?.submission_id || null,
        }))),
        communicationLinks: links.communicationLinks.map((link) => {
          const before = audit._data.communications.find((item) => item.id === link.id);
          return { id: link.id, beforeOpportunityId: before?.opportunity_id || null, beforeSubmissionId: before?.submission_id || null };
        }),
        emailEventLinks: links.emailEventLinks.map((link) => {
          const before = audit._data.emailEvents.find((item) => item.id === link.id);
          return { id: link.id, beforeOpportunityId: before?.opportunity_id || null, beforeSubmissionId: before?.submission_id || null };
        }),
        activityLinks: links.activityLinks.map((link) => {
          const before = audit._data.activities.find((item) => item.id === link.id);
          return { id: link.id, beforeOpportunityId: before?.opportunity_id || null, beforeSubmissionId: before?.submission_id || null };
        }),
        importLinks: links.importLinks.map((link) => {
          const before = audit._data.imports.find((item) => item.id === link.id);
          return { id: link.id, beforeOpportunityId: before?.opportunity_id || null, beforeSubmissionId: before?.submission_id || null };
        }),
      },
    },
    metadata: {
      evidenceVersion: CIM_IDENTITY_EVIDENCE_VERSION,
      historicalResolutionCount: normalizedResolutions.length,
    },
  };
  const batch = {
    opportunityRecords: groupPlans.map((plan) => plan.opportunityRecord),
    aliasRecords,
    requestLinks: groupPlans.flatMap((plan) => plan.requestLinks),
    stopRequests: groupPlans.flatMap((plan) => plan.stopRequests),
    ...links,
    manifest,
  };
  const changes = await storage.applyDealHunterCimIdentityRepair(batch);
  return { ok: true, mode: 'apply', applied: true, manifest, changes, audit: publicAudit(audit) };
}
