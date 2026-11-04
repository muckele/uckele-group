// The Gmail reply poller (spec 2026-11-03 §6). One poll:
//   1. needs an active Gmail connection (otherwise it skips with gmail_not_connected);
//   2. lists the open Pursue conversations that have a Gmail thread, and every transmission of
//      them, so our own sends are recognized by their Message-ID (or stored Gmail id);
//   3. reads the thread changes since the stored history checkpoint. An expired or missing
//      checkpoint comes back as every message of those threads, so messages are deduplicated by
//      Gmail id and skipped when already processed;
//   4. classifies each new message (pursueCimReplyClassifier.js) and applies it through the
//      verified inbound path with evidence method gmail-thread: a reply or stop word responds
//      (a stop word also suppresses the recipient through the existing suppression write), an
//      owner message stops the campaign with owner_replied, a bounce sends it to action-required
//      with recipient_bounced, and an auto-reply is only logged;
//   5. records each applied message once (classification, Gmail ids, From fingerprint, time);
//   6. only when every message was applied, advances the checkpoint by compare-and-set.
// A crash anywhere means the next poll re-reads from the old checkpoint; terminal events are
// idempotent per Gmail message id (their id derives from it), so nothing is applied twice.
// Message bodies are read for classification only and never stored or logged.
import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import { sha256 } from '../utils/security.js';
import { cimRfcMessageId } from './cimMailProvider.js';
import { createGmailCimProvider } from './gmailCimProvider.js';
import { applyVerifiedPursueCimInbound } from './pursueCimInbound.js';
import { classifyPursueCimReply, replyFromAddress } from './pursueCimReplyClassifier.js';

export const PURSUE_CIM_REPLY_POLLER_ACTOR = 'pursue-cim-reply-poller';
const LOOKUP_CHUNK = 500;
const GMAIL_ID = /^[A-Za-z0-9_-]{1,240}$/;

const INBOUND_OUTCOME = Object.freeze({ reply: 'reply', stop: 'reply', owner: 'owner_replied',
  bounce: 'recipient_bounced' });
const COUNTER = Object.freeze({ reply: 'responded', stop: 'stopped', owner: 'ownerReplied',
  bounce: 'bounced', 'auto-reply': 'autoReplies' });

function instantOf(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid reply poller instant');
  return at.toISOString();
}

function messageInstant(message) {
  const at = Date.parse(message?.internalDate ?? '');
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** Our own Message-IDs and Gmail ids for the polled conversations. */
async function knownIdentities(storage, conversationIds, connectedAddress) {
  const messageIds = new Set();
  const providerMessageIds = new Set();
  for (const ids of chunks(conversationIds, LOOKUP_CHUNK)) {
    for (const identity of await storage.listGmailConversationSentIdentities({ conversationIds: ids })) {
      for (const candidate of [cimRfcMessageId(identity.transmissionId, identity.fromAddress),
        cimRfcMessageId(identity.transmissionId, connectedAddress), identity.rfcMessageId]) {
        if (candidate) messageIds.add(candidate);
      }
      if (identity.providerMessageId) providerMessageIds.add(identity.providerMessageId);
    }
  }
  return { messageIds, providerMessageIds };
}

async function processedIds(storage, gmailMessageIds) {
  const processed = new Set();
  for (const ids of chunks(gmailMessageIds, LOOKUP_CHUNK)) {
    for (const row of await storage.listGmailReplyMessages({ gmailMessageIds: ids })) {
      processed.add(row.gmailMessageId);
    }
  }
  return processed;
}

/** The inbound event a classified thread message becomes; headers only, never the body. */
function inboundEvent(message, observedAt) {
  return {
    id: `gmail-message:${message.id}`,
    event_type: 'replied',
    provider: 'gmail',
    provider_event_id: `gmail-message:${message.id}`,
    created_at: observedAt,
    metadata: {
      rawType: 'email.received',
      gmailThreadId: message.threadId,
      inReplyTo: message.headers?.inReplyTo ?? '',
      references: message.headers?.references ?? '',
    },
  };
}

/** A stop word suppresses the conversation's recipient for every future listing. */
async function suppressRecipient(storage, { conversationId, message, at }) {
  const conversation = await storage.getPursueCimBrokerConversation(conversationId);
  const address = String(conversation?.recipient_address || '').trim().toLowerCase();
  if (!address) throw new Error('Pursue CIM stop reply has no recipient to suppress');
  // An active suppression is left as it is (its first evidence stays the evidence).
  if (await storage.getActiveEmailSuppression(address)) return;
  await storage.upsertEmailSuppression({
    id: randomUUID(),
    normalized_email: address,
    reason: 'explicit-opt-out',
    source: 'gmail-reply',
    source_event_id: `gmail-message:${message.id}`,
    source_communication_id: null,
    created_at: at,
    created_by: PURSUE_CIM_REPLY_POLLER_ACTOR,
    metadata: { gmailMessageId: message.id, gmailThreadId: message.threadId, conversationId },
  });
}

async function applyMessage({ storage, message, conversation, classification, now }) {
  const at = instantOf(now);
  const outcome = INBOUND_OUTCOME[classification];
  if (outcome) {
    await applyVerifiedPursueCimInbound(inboundEvent(message, messageInstant(message) ?? at), {
      storage, now: at, outcome, actor: PURSUE_CIM_REPLY_POLLER_ACTOR });
  }
  if (classification === 'stop') {
    await suppressRecipient(storage, { conversationId: conversation.conversationId, message, at });
  }
  const from = replyFromAddress(message.headers?.from);
  await storage.recordGmailReplyMessage({
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    conversationId: conversation.conversationId,
    classification,
    fromFingerprint: from ? sha256(from) : null,
    messageAt: messageInstant(message),
    now: instantOf(now),
  });
}

/**
 * One reply poll. `now` is an instant or a clock function. Returns counts only:
 * `{ processed, responded, ownerReplied, bounced, autoReplies, stopped, failed,
 *    checkpointExpired, checkpointAdvanced }`, plus `stoppedFor: 'gmail_not_connected'` when
 * there is no active connection. Throws only when the poll as a whole could not run (for
 * example Gmail's history read or the checkpoint save failed); one message that cannot be
 * applied is counted in `failed` and holds the checkpoint so the next poll retries it.
 */
export async function runPursueCimReplyPoll({ storage, mailProvider, now, config } = {}) {
  if (!storage) throw new Error('Pursue reply poller storage is unavailable');
  const summary = { processed: 0, responded: 0, ownerReplied: 0, bounced: 0, autoReplies: 0,
    stopped: 0, failed: 0, checkpointExpired: false, checkpointAdvanced: false };

  const connection = await storage.getGmailConnection();
  if (!connection) return { ...summary, stoppedFor: 'gmail_not_connected' };
  const provider = mailProvider || createGmailCimProvider({ storage, config: config || getConfig() });

  const conversations = (await storage.listOpenGmailConversations())
    .filter((conversation) => GMAIL_ID.test(conversation.gmailThreadId || ''));
  const byThread = new Map(conversations.map((conversation) => [conversation.gmailThreadId,
    conversation]));
  const known = await knownIdentities(storage,
    conversations.map(({ conversationId }) => conversationId), connection.email_address);

  const checkpoint = connection.history_checkpoint ?? null;
  const changes = await provider.listThreadChanges({ checkpoint, threadIds: [...byThread.keys()],
    withBodyPrefix: true });
  summary.checkpointExpired = Boolean(changes?.checkpointExpired);

  const unique = new Map();
  for (const message of Array.isArray(changes?.messages) ? changes.messages : []) {
    if (typeof message?.id !== 'string' || !GMAIL_ID.test(message.id)) continue;
    if (!byThread.has(message.threadId) || unique.has(message.id)) continue;
    unique.set(message.id, message);
  }
  const messages = [...unique.values()].sort((left, right) => {
    const byTime = (Date.parse(left.internalDate ?? '') || 0) - (Date.parse(right.internalDate ?? '') || 0);
    return byTime || left.id.localeCompare(right.id);
  });
  const processed = await processedIds(storage, messages.map(({ id }) => id));

  for (const message of messages) {
    if (processed.has(message.id)) continue;
    const classification = classifyPursueCimReply({ message,
      connectedAddress: connection.email_address, knownMessageIds: known.messageIds,
      knownProviderMessageIds: known.providerMessageIds });
    try {
      await applyMessage({ storage, message, conversation: byThread.get(message.threadId),
        classification, now });
      processed.add(message.id);
      summary.processed += 1;
      if (COUNTER[classification]) summary[COUNTER[classification]] += 1;
    } catch {
      // Held for the next poll: the checkpoint does not advance past an unapplied message.
      summary.failed += 1;
    }
  }

  const next = changes?.nextCheckpoint === undefined || changes?.nextCheckpoint === null
    ? null : String(changes.nextCheckpoint);
  if (summary.failed === 0 && next && next !== checkpoint) {
    summary.checkpointAdvanced = await storage.updateGmailHistoryCheckpoint({ expected: checkpoint,
      next, now: instantOf(now) });
  }
  return summary;
}
