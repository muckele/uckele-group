// The Gmail reply poller (spec 2026-11-03 §6). One poll:
//   1. needs an active Gmail connection (otherwise it skips with gmail_not_connected);
//   2. first applies every recorded reply whose effect is still pending (see below);
//   3. reads the thread changes of the open Pursue conversations since the stored history
//      checkpoint. An expired or missing checkpoint comes back as every message of those threads,
//      so messages are deduplicated by Gmail id and skipped when already recorded. Drafts are
//      skipped without a record (once sent, a draft arrives as a new message id);
//   4. only then lists every transmission of those conversations, so our own sends are recognized
//      by their Message-ID (or stored Gmail id) even when the sender sent one while the history
//      was being read (transmission rows exist from preparation, before any send);
//   5. classifies each new message (pursueCimReplyClassifier.js), records it, and applies it
//      through the verified inbound path with evidence method gmail-thread: a reply or stop word
//      responds (a stop word also suppresses the recipient through the existing suppression
//      write), an owner message stops the campaign with owner_replied, a bounce sends it to
//      action-required with recipient_bounced, and an auto-reply is only logged;
//   6. only when every new message was recorded, advances the checkpoint by compare-and-set.
//
// The record is an intent log. A message with an effect is recorded pending (applied = false)
// before the effect and settled after it. A crash in between, an effect that fails, or a reply
// on a provider-ambiguous conversation (where it cannot apply yet) leaves the row pending, and
// pending rows are applied again at the start of every poll and by the sender before any send
// (applyPendingPursueCimReplies), so a broker who answered is never sent another follow-up.
// Terminal events are idempotent per Gmail message id (their id derives from it) and suppression
// is skipped when one is active, so applying again never duplicates anything.
// Message bodies are read for classification only and never stored or logged.
import { randomUUID } from 'node:crypto';

import { getConfig } from '../config.js';
import { sha256 } from '../utils/security.js';
import { cimRfcMessageId } from './cimMailProvider.js';
import { createGmailCimProvider } from './gmailCimProvider.js';
import { applyVerifiedPursueCimInbound } from './pursueCimInbound.js';
import { classifyPursueCimReply, replyFromAddress } from './pursueCimReplyClassifier.js';

export const PURSUE_CIM_REPLY_POLLER_ACTOR = 'pursue-cim-reply-poller';
export const PURSUE_CIM_REPLY_POLLER_JOB_NAME = 'pursue-cim-reply-poller';
// Follow-ups wait while reply checking has no completed run this recent (Ruling U).
export const PURSUE_REPLY_POLLER_FRESH_MS = 30 * 60 * 1000;
const RECENT_RUNS = 25;
const LOOKUP_CHUNK = 500;
const PENDING_LIMIT = 200;
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

async function recordedIds(storage, gmailMessageIds) {
  const recorded = new Set();
  for (const ids of chunks(gmailMessageIds, LOOKUP_CHUNK)) {
    for (const row of await storage.listGmailReplyMessages({ gmailMessageIds: ids })) {
      recorded.add(row.gmailMessageId);
    }
  }
  return recorded;
}

/**
 * The inbound event a recorded message becomes: its Gmail ids and, for a message read in this
 * poll, its In-Reply-To and References headers. Never the body.
 */
function inboundEvent(record, observedAt) {
  return {
    id: `gmail-message:${record.gmailMessageId}`,
    event_type: 'replied',
    provider: 'gmail',
    provider_event_id: `gmail-message:${record.gmailMessageId}`,
    created_at: observedAt,
    metadata: {
      rawType: 'email.received',
      gmailThreadId: record.gmailThreadId,
      inReplyTo: record.inReplyTo ?? '',
      references: record.references ?? '',
    },
  };
}

/** A stop word suppresses the conversation's recipient for every future listing. */
async function suppressRecipient(storage, { record, at }) {
  const conversation = await storage.getPursueCimBrokerConversation(record.conversationId);
  const address = String(conversation?.recipient_address || '').trim().toLowerCase();
  if (!address) throw new Error('Pursue CIM stop reply has no recipient to suppress');
  // An active suppression is left as it is (its first evidence stays the evidence).
  if (await storage.getActiveEmailSuppression(address)) return;
  await storage.upsertEmailSuppression({
    id: randomUUID(),
    normalized_email: address,
    reason: 'explicit-opt-out',
    source: 'gmail-reply',
    source_event_id: `gmail-message:${record.gmailMessageId}`,
    source_communication_id: null,
    created_at: at,
    created_by: PURSUE_CIM_REPLY_POLLER_ACTOR,
    metadata: { gmailMessageId: record.gmailMessageId, gmailThreadId: record.gmailThreadId,
      conversationId: record.conversationId },
  });
}

/**
 * Applies a recorded reply, stop, owner or bounce message and settles its record. Returns true
 * when settled, false when it stays pending (its conversation is provider-ambiguous).
 */
async function applyRecorded({ storage, record, now }) {
  const at = instantOf(now);
  let result;
  try {
    result = await applyVerifiedPursueCimInbound(inboundEvent(record, record.messageAt ?? at), {
      storage, now: at, outcome: INBOUND_OUTCOME[record.classification],
      actor: PURSUE_CIM_REPLY_POLLER_ACTOR });
  } finally {
    // An opt-out is honored even while the conversation cannot take the terminal yet, or the
    // terminal write keeps failing. The record settles only once both have succeeded.
    if (record.classification === 'stop') await suppressRecipient(storage, { record, at });
  }
  if (result?.deferred) return false;
  await storage.recordGmailReplyMessage({ gmailMessageId: record.gmailMessageId,
    gmailThreadId: record.gmailThreadId, conversationId: record.conversationId,
    classification: record.classification, fromFingerprint: record.fromFingerprint ?? null,
    messageAt: record.messageAt ?? null, applied: true, now: instantOf(now) });
  return true;
}

/**
 * Why follow-ups must wait for reply checking, or null when they need not: `reply_poller_off`
 * when DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED is not true, `reply_poller_stale` when the
 * reply poller's Job history has no completed run (one that finished without a run-level
 * error) in the last 30 minutes, or when that history cannot be read. Without a working reply
 * poller a broker's answer would never stop the campaign, so a follow-up is not sent.
 */
export async function readPursueReplyPollerHold({ storage, config, now } = {}) {
  if (config?.dealHunter?.replyPoller?.enabled !== true) return 'reply_poller_off';
  const at = Date.parse(instantOf(now));
  try {
    const runs = await storage.listScheduledJobs({ jobName: PURSUE_CIM_REPLY_POLLER_JOB_NAME,
      limit: RECENT_RUNS });
    const fresh = (Array.isArray(runs) ? runs : []).some((run) => {
      const completedAt = Date.parse(run?.completed_at ?? '');
      return run?.job_name === PURSUE_CIM_REPLY_POLLER_JOB_NAME && run.status === 'completed'
        && Number.isFinite(completedAt) && at - completedAt <= PURSUE_REPLY_POLLER_FRESH_MS;
    });
    return fresh ? null : 'reply_poller_stale';
  } catch {
    return 'reply_poller_stale';
  }
}

/**
 * Applies every recorded Gmail reply whose effect is still pending. The poller runs it first in
 * every poll and the sender runs it after reconciliation and before any send, so a reply held
 * while its conversation was provider-ambiguous is applied before a follow-up can go out once
 * the conversation is reopened. Returns the settled counts and the conversations that still
 * have a pending reply (the sender sends nothing to them in that run).
 */
export async function applyPendingPursueCimReplies({ storage, now } = {}) {
  const outcome = { settled: 0, pending: 0, counts: {}, pendingConversationIds: new Set() };
  if (typeof storage?.listPendingGmailReplyMessages !== 'function') return outcome;
  for (const record of await storage.listPendingGmailReplyMessages({ limit: PENDING_LIMIT })) {
    if (!INBOUND_OUTCOME[record.classification]) continue;
    let settled = false;
    try {
      settled = await applyRecorded({ storage, record, now });
    } catch {
      settled = false;
    }
    if (settled) {
      outcome.settled += 1;
      const counter = COUNTER[record.classification];
      outcome.counts[counter] = (outcome.counts[counter] || 0) + 1;
    } else {
      outcome.pending += 1;
      outcome.pendingConversationIds.add(record.conversationId);
    }
  }
  return outcome;
}

/**
 * One reply poll. `now` is an instant or a clock function. Returns counts only:
 * `{ processed, responded, ownerReplied, bounced, autoReplies, stopped, pending, failed,
 *    checkpointExpired, checkpointAdvanced }`, plus `stoppedFor: 'gmail_not_connected'` when
 * there is no active connection. `responded`, `stopped`, `ownerReplied` and `bounced` count
 * effects applied in this poll (new or previously pending); `pending` counts recorded replies
 * still waiting to apply; `failed` counts new messages that could not be recorded, which holds
 * the checkpoint. Throws only when the poll as a whole could not run.
 */
export async function runPursueCimReplyPoll({ storage, mailProvider, now, config } = {}) {
  if (!storage) throw new Error('Pursue reply poller storage is unavailable');
  const summary = { processed: 0, responded: 0, ownerReplied: 0, bounced: 0, autoReplies: 0,
    stopped: 0, pending: 0, failed: 0, checkpointExpired: false, checkpointAdvanced: false };
  const count = (classification) => {
    if (COUNTER[classification]) summary[COUNTER[classification]] += 1;
  };

  const connection = await storage.getGmailConnection();
  if (!connection) return { ...summary, stoppedFor: 'gmail_not_connected' };
  const provider = mailProvider || createGmailCimProvider({ storage, config: config || getConfig() });

  const earlier = await applyPendingPursueCimReplies({ storage, now });
  for (const [counter, value] of Object.entries(earlier.counts)) summary[counter] += value;
  summary.pending = earlier.pending;

  const conversations = (await storage.listOpenGmailConversations())
    .filter((conversation) => GMAIL_ID.test(conversation.gmailThreadId || ''));
  const byThread = new Map(conversations.map((conversation) => [conversation.gmailThreadId,
    conversation]));
  const checkpoint = connection.history_checkpoint ?? null;
  const changes = await provider.listThreadChanges({ checkpoint, threadIds: [...byThread.keys()],
    withBodyPrefix: true });
  summary.checkpointExpired = Boolean(changes?.checkpointExpired);

  const unique = new Map();
  for (const message of Array.isArray(changes?.messages) ? changes.messages : []) {
    if (typeof message?.id !== 'string' || !GMAIL_ID.test(message.id)) continue;
    if (!byThread.has(message.threadId) || unique.has(message.id)) continue;
    if (Array.isArray(message.labelIds) && message.labelIds.includes('DRAFT')) continue;
    unique.set(message.id, message);
  }
  const messages = [...unique.values()].sort((left, right) => {
    const byTime = (Date.parse(left.internalDate ?? '') || 0) - (Date.parse(right.internalDate ?? '') || 0);
    return byTime || left.id.localeCompare(right.id);
  });
  const recorded = await recordedIds(storage, messages.map(({ id }) => id));
  // After the history read: every send that can appear in it was prepared before it.
  const known = messages.some(({ id }) => !recorded.has(id))
    ? await knownIdentities(storage, conversations.map(({ conversationId }) => conversationId),
      connection.email_address)
    : { messageIds: new Set(), providerMessageIds: new Set() };

  for (const message of messages) {
    if (recorded.has(message.id)) continue;
    const classification = classifyPursueCimReply({ message,
      connectedAddress: connection.email_address, knownMessageIds: known.messageIds,
      knownProviderMessageIds: known.providerMessageIds });
    const from = replyFromAddress(message.headers?.from);
    const record = { gmailMessageId: message.id, gmailThreadId: message.threadId,
      conversationId: byThread.get(message.threadId).conversationId, classification,
      fromFingerprint: from ? sha256(from) : null, messageAt: messageInstant(message) };
    const effectful = Boolean(INBOUND_OUTCOME[classification]);
    try {
      await storage.recordGmailReplyMessage({ ...record, applied: !effectful, now: instantOf(now) });
    } catch {
      // Not recorded: the checkpoint does not advance past it, so the next poll reads it again.
      summary.failed += 1;
      continue;
    }
    recorded.add(message.id);
    summary.processed += 1;
    if (!effectful) {
      count(classification);
      continue;
    }
    let settled = false;
    try {
      settled = await applyRecorded({ storage, now, record: { ...record,
        inReplyTo: message.headers?.inReplyTo ?? '', references: message.headers?.references ?? '' } });
    } catch {
      settled = false;
    }
    if (settled) count(classification);
    else summary.pending += 1;
  }

  const next = changes?.nextCheckpoint === undefined || changes?.nextCheckpoint === null
    ? null : String(changes.nextCheckpoint);
  if (summary.failed === 0 && next && next !== checkpoint) {
    summary.checkpointAdvanced = await storage.updateGmailHistoryCheckpoint({ expected: checkpoint,
      next, now: instantOf(now) });
  }
  return summary;
}
