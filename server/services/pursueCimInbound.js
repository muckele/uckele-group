import { sha256, stableCanonicalJson } from '../utils/security.js';

const terminalConversationStates = new Set(['responded', 'stopped', 'closed']);
const ambiguityContainedConversationStates = new Set([
  ...terminalConversationStates, 'reply-review-required', 'provider-ambiguous',
]);

function text(value, maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function email(value) {
  const candidate = text(value, 500);
  const match = candidate.match(/<([^<>@\s]+@[^<>\s]+)>/)
    || candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return text(match?.[1] || match?.[0] || candidate, 320).toLowerCase();
}

function values(input) {
  const items = Array.isArray(input) ? input : [input];
  return items.flatMap((item) => {
    if (Array.isArray(item)) return values(item);
    if (item && typeof item === 'object') return values(item.email || item.address || item.value || item.to);
    return String(item || '').split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  });
}

function unique(items, maximum = 20) {
  return Array.from(new Set(items.filter(Boolean))).slice(0, maximum);
}

function tagValue(tags, name) {
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string') {
        const [key, ...rest] = tag.split('=');
        if (text(key, 80) === name) return text(rest.join('='));
      } else if (tag && typeof tag === 'object'
        && text(tag.name || tag.key, 80) === name) return text(tag.value);
    }
  } else if (tags && typeof tags === 'object') {
    return text(tags[name]);
  }
  return '';
}

function tagValues(tags, names) {
  return unique(names.map((name) => tagValue(tags, name)));
}

function references(value) {
  return unique(values(value).flatMap((item) => item.match(/<[^<>]+>|[^\s]+/g) || []), 50)
    .map((item) => text(item, 500));
}

function canonicalDigest(value) {
  return sha256(stableCanonicalJson(value));
}

function resolutionCommand(event, profileBinding) {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const tags = metadata.tags;
  const rawType = text(metadata.rawType, 80).toLowerCase().replace(/_/g, '.');
  const taggedTouchIds = tagValues(tags, ['cim_touch_id', 'cimTouchId', 'touch_id']);
  return {
    replyToAddresses: unique(values(metadata.to || metadata.toEmail).map(email)),
    provider: text(event.provider, 80) || 'resend',
    providerMessageIds: profileBinding?.requireExactReplyAlias ? [] : unique([
      text(metadata.parentProviderMessageId),
      text(metadata.inReplyToProviderMessageId),
      ...(rawType === 'email.received' ? [] : [text(event.message_id)]),
    ]),
    rfcMessageIds: profileBinding?.requireExactReplyAlias ? [] : unique([
      ...references(metadata.inReplyTo),
      ...references(metadata.references),
    ], 50),
    taggedConversationId: profileBinding?.requireExactReplyAlias ? '' : tagValues(tags,
      ['cim_conversation_id', 'cimConversationId', 'conversation_id'])[0] || '',
    taggedTransmissionId: profileBinding?.requireExactReplyAlias ? '' : tagValues(tags,
      ['cim_transmission_id', 'cimTransmissionId', 'transmission_id'])[0] || '',
    taggedTouchIds: profileBinding?.requireExactReplyAlias ? [] : taggedTouchIds,
  };
}

function resolvedConversation(resolution, conversationId) {
  if (resolution?.conversation?.id === conversationId) return resolution.conversation;
  return (resolution?.candidateConversations || [])
    .find((conversation) => conversation?.id === conversationId) || null;
}

function terminalEvidenceId(event) {
  return text(event?.provider_event_id) || text(event?.id);
}

function inboundTerminalCommand({
  event,
  conversation,
  nextState,
  reasonCode,
  evidenceType,
  evidence,
  now,
}) {
  const observedAt = new Date(event.created_at).toISOString();
  const committedAt = new Date(now ?? Date.now()).toISOString();
  const evidenceId = terminalEvidenceId(event);
  return {
    eventId: canonicalDigest({
      type: 'pursue-cim-inbound-terminal-v1', evidenceId,
      conversationId: conversation.id, nextState,
    }),
    scope: 'conversation',
    scopeId: conversation.id,
    expectedRevision: Number(conversation.terminal_revision),
    expectedRowVersion: Number(conversation.row_version),
    nextState,
    reasonCode,
    evidenceType: text(evidenceType, 120),
    evidenceId,
    observedAt,
    actor: 'signed-email-webhook',
    source: 'pursue-cim-inbound',
    metadataDigest: canonicalDigest(evidence),
    now: committedAt,
  };
}

async function appendInboundTerminal({
  storage,
  command,
  event,
  conversation,
  nextState,
  reasonCode,
  evidenceType,
  evidence,
  now,
  durableStates,
}) {
  const terminalCommand = inboundTerminalCommand({ event, conversation, nextState,
    reasonCode, evidenceType, evidence, now });
  const result = await storage.appendCimTerminalEvent(terminalCommand);
  if (!result.conflict) return { result, conflict: false };

  const durable = await storage.resolvePursueCimInboundEvidence(command);
  const durableConversation = resolvedConversation(durable, conversation.id);
  if (!durableConversation || !durableStates.has(durableConversation.state)) {
    throw new Error('Pursue CIM inbound terminalization conflict did not resolve durably');
  }
  return { result: { ...result, cancelledTouchIds: [] }, conflict: true, durable };
}

export async function applyVerifiedPursueCimInbound(event, { storage, now, profileBinding } = {}) {
  if (event?.event_type !== 'replied') return { handled: false };
  if (!storage?.resolvePursueCimInboundEvidence || !storage?.appendCimTerminalEvent) {
    throw new Error('Pursue CIM inbound storage transitions unavailable');
  }
  const command = resolutionCommand(event, profileBinding);
  if (profileBinding?.requireExactReplyAlias) {
    const expectedDomain = text(profileBinding.replyDomain, 255).toLowerCase();
    if (!expectedDomain || command.replyToAddresses.length < 1
      || command.replyToAddresses.some((address) => address.split('@')[1] !== expectedDomain)) {
      throw new Error('Controlled mailbox inbound reply domain mismatch');
    }
  }
  const resolution = await storage.resolvePursueCimInboundEvidence(command);
  if (resolution?.ambiguous) {
    const candidates = Array.from(new Map((resolution.candidateConversations || [])
      .filter((conversation) => conversation?.id)
      .map((conversation) => [conversation.id, conversation])).values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 50);
    const containedConversationIds = [];
    const containmentCommands = [];
    for (const conversation of candidates) {
      if (ambiguityContainedConversationStates.has(conversation.state)) {
        continue;
      }
      if (conversation.state !== 'open') {
        throw new Error('Pursue CIM conflicting evidence candidate is not safely contained');
      }
      const evidence = {
        providerEventId: terminalEvidenceId(event),
        provider: text(event.provider, 80),
        method: text(resolution.method, 120),
        conversationId: conversation.id,
        ...(profileBinding?.providerProfile
          ? { providerProfile: text(profileBinding.providerProfile, 120) } : {}),
      };
      containmentCommands.push(inboundTerminalCommand({
        event, conversation,
        nextState: 'reply-review-required',
        reasonCode: 'ambiguous_reply_evidence',
        evidenceType: `signed-inbound-${evidence.method}`,
        evidence,
        now,
      }));
    }
    let batch = { applied: false, replay: false, conflict: false, cancelledTouchIds: [] };
    if (containmentCommands.length > 0) {
      if (!storage.appendCimAmbiguousReplyReview) {
        throw new Error('Atomic Pursue CIM ambiguous reply containment unavailable');
      }
      batch = await storage.appendCimAmbiguousReplyReview(containmentCommands);
      if (batch.conflict) {
        const durable = await storage.resolvePursueCimInboundEvidence(command);
        const unresolved = candidates.filter((candidate) => {
          const conversation = resolvedConversation(durable, candidate.id);
          return !conversation || !ambiguityContainedConversationStates.has(conversation.state);
        });
        if (unresolved.length > 0) {
          throw new Error('Atomic Pursue CIM ambiguous reply conflict did not resolve durably');
        }
      }
    }
    containedConversationIds.push(...candidates.map(({ id }) => id));
    return {
      handled: true,
      exact: false,
      ambiguous: true,
      reviewRequired: true,
      terminalized: Boolean(batch.applied || batch.replay),
      conflict: Boolean(batch.conflict),
      containedConversationIds,
      cancelledTouchIds: batch.cancelledTouchIds || [],
      method: text(resolution.method, 120) || 'conflicting-exact-evidence',
    };
  }
  if (!resolution?.exact || !resolution.conversation) {
    return {
      handled: true,
      exact: false,
      ambiguous: Boolean(resolution?.ambiguous),
      reviewRequired: true,
      terminalized: false,
      method: text(resolution?.method, 120) || 'none',
    };
  }
  if (profileBinding?.requireExactReplyAlias) {
    const durableReplyAlias = email(resolution.transmission?.reply_to_address);
    if (!durableReplyAlias || !command.replyToAddresses.includes(durableReplyAlias)) {
      throw new Error('Controlled mailbox inbound is not bound to the durable reply alias');
    }
  }
  if (terminalConversationStates.has(resolution.conversation.state)) {
    return {
      handled: true,
      exact: true,
      ambiguous: false,
      reviewRequired: false,
      terminalized: false,
      alreadyTerminal: true,
      conversationId: resolution.conversation.id,
      transmissionId: text(resolution.transmission?.id),
      campaignIds: unique(resolution.campaignIds || [], 50).sort(),
      touchIds: unique(resolution.touchIds || [], 50).sort(),
      method: resolution.method,
      cancelledTouchIds: [],
    };
  }
  if (!['open', 'reply-review-required'].includes(resolution.conversation.state)) {
    return {
      handled: true,
      exact: true,
      ambiguous: false,
      reviewRequired: true,
      terminalized: false,
      alreadyTerminal: false,
      conversationId: resolution.conversation.id,
      transmissionId: text(resolution.transmission?.id),
      campaignIds: unique(resolution.campaignIds || [], 50).sort(),
      touchIds: unique(resolution.touchIds || [], 50).sort(),
      method: resolution.method,
      cancelledTouchIds: [],
    };
  }
  const evidence = {
    providerEventId: terminalEvidenceId(event),
    provider: text(event.provider, 80),
    method: text(resolution.method, 120),
    conversationId: resolution.conversation.id,
    transmissionId: text(resolution.transmission?.id),
    campaignIds: unique(resolution.campaignIds || [], 50).sort(),
    touchIds: unique(resolution.touchIds || [], 50).sort(),
    ...(profileBinding?.providerProfile
      ? { providerProfile: text(profileBinding.providerProfile, 120) } : {}),
  };
  const appended = await appendInboundTerminal({
    storage, command, event, conversation: resolution.conversation,
    nextState: 'responded',
    reasonCode: 'reply_received',
    evidenceType: `signed-inbound-${evidence.method}`,
    evidence,
    now,
    durableStates: terminalConversationStates,
  });
  const { result } = appended;
  if (appended.conflict) {
    const durable = appended.durable;
    return {
      handled: true,
      exact: true,
      ambiguous: false,
      reviewRequired: false,
      terminalized: false,
      alreadyTerminal: true,
      conflict: true,
      conversationId: durable.conversation.id,
      transmissionId: text(durable.transmission?.id),
      campaignIds: unique(durable.campaignIds || [], 50).sort(),
      touchIds: unique(durable.touchIds || [], 50).sort(),
      method: durable.method,
      cancelledTouchIds: [],
    };
  }
  return {
    handled: true,
    exact: true,
    ambiguous: false,
    reviewRequired: false,
    terminalized: Boolean(result.applied || result.replay),
    alreadyTerminal: Boolean(result.replay),
    conflict: Boolean(result.conflict),
    conversationId: resolution.conversation.id,
    transmissionId: evidence.transmissionId,
    campaignIds: evidence.campaignIds,
    touchIds: evidence.touchIds,
    method: resolution.method,
    cancelledTouchIds: result.cancelledTouchIds || [],
  };
}
